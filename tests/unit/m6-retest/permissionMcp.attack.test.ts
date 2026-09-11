// m6-retest — permissionMcp 权限端点攻击面独立复测（只测不修，test-m6）。
// 独立性：不复用被测方 tests/unit/helpers/*（其口径由被测方维护），只经公开导出使用被测对象。
// 覆盖：HTTP 分帧（跨段/逐字节/一 chunk 两请求/多字节切分）· 报文畸形与上限（Content-Length 变体/
//       头区上限/请求行）· token 变体与重放 · 方法/路径变体 · 超时与生命周期（closeTurn 幂等、
//       resolve×closeTurn 竞争）· 并发挂起 · fail-closed（CSPRNG 抛错传播）· tools/call 入参边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionCore,
  formatHttpResponse,
  parseHttpRequest,
  type ParsedHttpRequest,
  type PermissionRequestPayload,
} from "../../../src/modules/permissionMcp.ts";

const PORT = 51999;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_HEADER = 64 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

function makeCore(opts: { timeoutMs?: number } = {}) {
  const presented: PermissionRequestPayload[] = [];
  const logs: string[] = [];
  const core = createPermissionCore({
    log: (m) => logs.push(m),
    present: (req) => {
      presented.push(req);
    },
    timeoutMs: opts.timeoutMs ?? 200,
  });
  return { core, presented, logs };
}

function postRaw(
  body: string,
  token: string,
  id: number = 1,
): ParsedHttpRequest {
  return {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: { "content-type": "application/json" },
    body,
  };
}

function toolsCallJson(args: unknown, id: unknown = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "permission_check", arguments: args },
  });
}

function decisionOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(JSON.parse(res.body).result.content[0].text);
}

function rawRequest(
  opts: {
    method?: string;
    target?: string;
    headers?: string[];
    body?: string;
  } = {},
): Uint8Array {
  const body = opts.body ?? "";
  const headers = [
    ...(opts.headers ?? [`Content-Length: ${enc.encode(body).length}`]),
  ];
  const head = [
    `${opts.method ?? "POST"} ${opts.target ?? "/mcp?token=t"} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...headers,
  ];
  return enc.encode(`${head.join("\r\n")}\r\n\r\n${body}`);
}

// ---------------- 分帧（传输层按「收到一段就整段重放」驱动解析） ----------------

test("帧: 头与体分两段到达——第一段 incomplete，拼齐后 ok", () => {
  const all = rawRequest({ body: '{"a":1}' });
  const headOnly = all.length - 7; // 只喂到 body 中间
  const first = parseHttpRequest(all.subarray(0, headOnly));
  assert.equal(first.status, "incomplete");
  const second = parseHttpRequest(all);
  assert.equal(second.status, "ok");
});

test("帧: 逐字节喂——只有最后一个字节处才 ok，之前全部 incomplete", () => {
  const all = rawRequest({ body: '{"x":"中文"}' });
  for (let i = 1; i < all.length; i++) {
    assert.equal(
      parseHttpRequest(all.subarray(0, i)).status,
      "incomplete",
      `第 ${i} 字节处不应完整`,
    );
  }
  assert.equal(parseHttpRequest(all).status, "ok");
});

test("帧: 一 chunk 含两个请求——解析第一个，consumed 指向首请求边界，多余字节不并入 body", () => {
  const first = rawRequest({ body: '{"n":1}' });
  const second = rawRequest({ body: '{"n":2}' });
  const both = new Uint8Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  const r = parseHttpRequest(both);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.consumed, first.length);
  assert.equal(r.request.body, '{"n":1}');
});

test("帧: 头区结束标志 CRLFCRLF 跨两段 → 拼齐前 incomplete", () => {
  const all = rawRequest({ body: "{}" });
  const idx = dec.decode(all).indexOf("\r\n\r\n");
  // 在 CRLFCRLF 中间切开：end 前 3 字节处
  const cut = idx + 3;
  assert.equal(parseHttpRequest(all.subarray(0, cut)).status, "incomplete");
  assert.equal(parseHttpRequest(all).status, "ok");
});

test("帧: 中文 body 在多字节字符中间被切开 → 前段 incomplete、拼齐后文本完整", () => {
  const body = JSON.stringify({ text: "第一段中文" });
  const all = rawRequest({ body });
  const headEnd = dec.decode(all).indexOf("\r\n\r\n") + 4;
  // 在 body 第 4 个字节处切（"第" 占 3 字节，切在第二个字符中间）
  const cut = headEnd + 4;
  assert.equal(parseHttpRequest(all.subarray(0, cut)).status, "incomplete");
  const r = parseHttpRequest(all);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.request.body, body);
  }
});

// ---------------- 报文畸形与上限 ----------------

test("畸形: POST 无 Content-Length → body 视为空串（不猜长度）", () => {
  const all = enc.encode("POST /mcp?token=t HTTP/1.1\r\nHost: x\r\n\r\n");
  const r = parseHttpRequest(all);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.request.body, "");
  }
});

test("畸形: Content-Length 负值/小数/非数字/夹字符 → 全部 error", () => {
  for (const v of ["-1", "5.5", "abc", "5x", "1_000", "5 5"]) {
    const all = enc.encode(
      `POST /mcp?token=t HTTP/1.1\r\nContent-Length: ${v}\r\n\r\n`,
    );
    assert.equal(
      parseHttpRequest(all).status,
      "error",
      `Content-Length: ${v} 应 error`,
    );
  }
});

test("畸形: Content-Length 恰 4MB → 不 error（等 body）；4MB+1 → error body too large", () => {
  const head = (n: number) =>
    enc.encode(`POST /mcp?token=t HTTP/1.1\r\nContent-Length: ${n}\r\n\r\n`);
  const atLimit = parseHttpRequest(head(MAX_BODY));
  assert.equal(atLimit.status, "incomplete"); // 上限内：等 body
  const over = parseHttpRequest(head(MAX_BODY + 1));
  assert.equal(over.status, "error");
  if (over.status === "error") {
    assert.match(over.message, /body too large/);
  }
});

test("畸形: 头区超过 64KB 仍未收齐 → error；头区完整到达（即便超 64KB）→ 照常 ok（护栏只拦未收齐的头）", () => {
  const junk = "X-Junk: " + "a".repeat(70 * 1024);
  const headOnly = enc.encode(`POST /mcp?token=t HTTP/1.1\r\n${junk}\r\n`);
  assert.equal(parseHttpRequest(headOnly).status, "error");
  // 完整（带 CRLFCRLF）的超长头：当前行为是接受——记录用断言，报告已注明不对称
  const complete = enc.encode(
    `POST /mcp?token=t HTTP/1.1\r\n${junk}\r\nContent-Length: 2\r\n\r\n{}`,
  );
  assert.equal(parseHttpRequest(complete).status, "ok");
});

test("畸形: 请求行不足三段 → error", () => {
  const all = enc.encode("POST /mcp\r\nHost: x\r\n\r\n");
  const r = parseHttpRequest(all);
  assert.equal(r.status, "error");
});

test("畸形: 纯 LF 行尾（无 CRLF）→ 永远 incomplete（只认 CRLF）", () => {
  const all = enc.encode(
    "POST /mcp?token=t HTTP/1.1\nHost: x\nContent-Length: 2\n\n{}",
  );
  assert.equal(parseHttpRequest(all).status, "incomplete");
});

test("走私: Content-Length 声明 5 但实际 10 字节 → body 只取前 5，多余字节留在边界外", () => {
  const all = enc.encode(
    "POST /mcp?token=t HTTP/1.1\r\nContent-Length: 5\r\n\r\n0123456789",
  );
  const r = parseHttpRequest(all);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.request.body, "01234");
    assert.equal(r.consumed, all.length - 5);
  }
});

test("走私: 携带 Transfer-Encoding: chunked → 忽略该头，仍按 Content-Length 解析", () => {
  const all = enc.encode(
    "POST /mcp?token=t HTTP/1.1\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
  );
  const r = parseHttpRequest(all);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.request.body, "{}");
  }
});

// ---------------- token 变体（§4.8 / §7.1） ----------------

test("token: 畸形 percent 编码（%ZZ）→ 原样保留、403、不推卡", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const res = await core.handle({
    method: "POST",
    path: "/mcp",
    query: { token: `%${token.slice(1)}` }, // 合法解码只会得到错误 token
    headers: {},
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.equal(presented.length, 0);
  // 直接构造畸形编码路径（decodeURIComponent 抛错 → 原样保留）
  const raw = parseHttpRequest(
    enc.encode("POST /mcp?token=%ZZ HTTP/1.1\r\n\r\n"),
  );
  assert.equal(raw.status, "ok");
  if (raw.status === "ok") {
    assert.equal(raw.request.query.token, "%ZZ");
  }
});

test("token: 重复 token 参数 → 后者覆盖前者（先对后错 → 403；先错后对 → 200）", async () => {
  const { core } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const withQuery = (query: Record<string, string>): ParsedHttpRequest => ({
    method: "POST",
    path: "/mcp",
    query,
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  // 解析层行为：重复键后者覆盖
  const parsed = parseHttpRequest(
    enc.encode(
      `POST /mcp?token=${token}&token=WRONG HTTP/1.1\r\nContent-Length: 0\r\n\r\n`,
    ),
  );
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") {
    assert.equal(parsed.request.query.token, "WRONG");
  }
  assert.equal((await core.handle(withQuery({ token: "WRONG" }))).status, 403);
  assert.equal((await core.handle(withQuery({ token }))).status, 200);
});

test("token: 大小写变异（正确 token 全大写）→ 403 不放行", async () => {
  const { core } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const res = await core.handle(
    postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      token.toUpperCase(),
    ),
  );
  assert.equal(res.status, 403);
});

test("token: 裸 /mcp（无查询串）与显式空 token → 均 403", async () => {
  const { core, presented } = makeCore();
  core.openTurn("s", PORT);
  const bare = parseHttpRequest(enc.encode("POST /mcp HTTP/1.1\r\n\r\n"));
  assert.equal(bare.status, "ok");
  if (bare.status === "ok") {
    assert.equal((await core.handle(bare.request)).status, 403);
  }
  const empty = await core.handle(postRaw("{}", ""));
  assert.equal(empty.status, 403);
  assert.equal(presented.length, 0);
});

test("token: 路径变体 /mcp/（尾斜杠）、/MCP（大写）→ 404", async () => {
  const { core } = makeCore();
  const { token } = core.openTurn("s", PORT);
  for (const path of ["/mcp/", "/MCP", "/mcp/x"]) {
    const res = await core.handle({
      method: "POST",
      path,
      query: { token },
      headers: {},
      body: "{}",
    });
    assert.equal(res.status, 404, `${path} 应 404`);
  }
});

// ---------------- 方法与路径 ----------------

test("方法: DELETE /mcp（带正确 token）→ 405 空体，不推卡", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const res = await core.handle({
    method: "DELETE",
    path: "/mcp",
    query: { token },
    headers: {},
    body: "",
  });
  assert.equal(res.status, 405);
  assert.equal(res.body, "");
  assert.equal(presented.length, 0);
});

test("方法: 优先级——无 token 的 GET 也是 403（token 校验先于方法校验）", async () => {
  const { core } = makeCore();
  core.openTurn("s", PORT);
  const res = await core.handle({
    method: "GET",
    path: "/mcp",
    query: {},
    headers: {},
    body: "",
  });
  assert.equal(res.status, 403);
});

// ---------------- 生命周期与并发 ----------------

test("生命周期: closeTurn 重复调用幂等（第二次 no-op 不抛、不重复结账）", async () => {
  const { core, logs } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const pending = core.handle(
    postRaw(
      toolsCallJson({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  core.closeTurn(token);
  const res = await pending;
  assert.equal(decisionOf(res).behavior, "deny");
  const denyCountBefore = logs.filter((l) => l.includes("turn closed")).length;
  core.closeTurn(token); // 第二次
  assert.equal(
    logs.filter((l) => l.includes("turn closed")).length,
    denyCountBefore,
  );
  assert.equal(core.pendingCount(), 0);
});

test("并发: resolve 先于 closeTurn——回包恒为 allow（closeTurn 不会二次改判）", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const pending = core.handle(
    postRaw(
      toolsCallJson({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  const resolved = core.resolve(presented[0].requestId, true);
  assert.ok(resolved);
  core.closeTurn(token);
  const res = await pending;
  assert.equal(decisionOf(res).behavior, "allow");
});

test("并发: 同一 token 三个 tools/call 同时挂起 → 三张独立卡，乱序作答各自回包正确", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const mk = (n: number) =>
    core.handle(
      postRaw(
        toolsCallJson(
          {
            tool_name: "Bash",
            input: { command: `cmd-${n}` },
            tool_use_id: `c${n}`,
          },
          n,
        ),
        token,
      ),
    );
  const [p1, p2, p3] = [mk(1), mk(2), mk(3)];
  assert.equal(presented.length, 3);
  const ids = new Set(presented.map((p) => p.requestId));
  assert.equal(ids.size, 3, "requestId 必须互异");
  // 乱序：2 allow、3 deny、1 allow
  core.resolve(presented[1].requestId, true);
  core.resolve(presented[2].requestId, false);
  core.resolve(presented[0].requestId, true);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(decisionOf(r1).behavior, "allow");
  assert.equal(decisionOf(r2).behavior, "allow");
  assert.equal(decisionOf(r3).behavior, "deny");
  // 各回包 JSON-RPC id 不串
  assert.equal(JSON.parse(r1.body).id, 1);
  assert.equal(JSON.parse(r2.body).id, 2);
  assert.equal(JSON.parse(r3.body).id, 3);
});

test("超时: 短超时注入 → 挂起请求回 deny，且该卡永久作废（迟到 resolve → null）", async () => {
  const { core, presented } = makeCore({ timeoutMs: 10 });
  const { token } = core.openTurn("s", PORT);
  const pending = core.handle(
    postRaw(
      toolsCallJson({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  const res = await pending;
  assert.equal(decisionOf(res).behavior, "deny");
  assert.equal(core.pendingCount(), 0);
  assert.equal(core.resolve(presented[0].requestId, true), null);
});

// ---------------- fail-closed（抽验真实性） ----------------

test("fail-closed: crypto.getRandomValues 抛错（存在但坏掉）→ openTurn 抛错传播，不发弱 token", () => {
  const { core } = makeCore(); // crypto 完好时构造
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: {
        getRandomValues: () => {
          throw new Error("CSPRNG broken");
        },
      },
      configurable: true,
      writable: true,
    });
    assert.throws(() => core.openTurn("s", PORT), /CSPRNG broken/);
    assert.equal(core.openTurnCount(), 0, "抛错后不得留下任何已注册 token");
  } finally {
    if (saved) {
      Object.defineProperty(globalThis, "crypto", saved);
    }
  }
});

test("fail-closed: crypto.getRandomValues 存在但非函数 → createPermissionCore 构造即抛错", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: "not-a-function" },
      configurable: true,
      writable: true,
    });
    assert.throws(
      () => createPermissionCore({ log: () => {}, present: () => {} }),
      /CSPRNG unavailable/,
    );
  } finally {
    if (saved) {
      Object.defineProperty(globalThis, "crypto", saved);
    }
  }
});

test("fail-closed: 恢复 crypto 后 token 形态为 32 位 hex（16 字节）", () => {
  const { core } = makeCore();
  const { token } = core.openTurn("s", PORT);
  assert.match(token, /^[0-9a-f]{32}$/);
});

// ---------------- tools/call 入参边界 ----------------

test("入参: params.name 缺失 → 仍按 permission_check 处理（推卡）；显式他名 → -32601 不推卡", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const noName = core.handle(
    postRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          arguments: {
            tool_name: "Bash",
            input: { command: "ls" },
            tool_use_id: "c",
          },
        },
      }),
      token,
    ),
  );
  assert.equal(presented.length, 1);
  core.resolve(presented[0].requestId, false);
  await noName;
  const other = await core.handle(
    postRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "someone_else", arguments: {} },
      }),
      token,
    ),
  );
  assert.equal(JSON.parse(other.body).error.code, -32601);
  assert.equal(presented.length, 1);
});

test("入参: 缺 input → input={}；allow 回 updatedInput={}", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const pending = core.handle(
    postRaw(toolsCallJson({ tool_name: "Read", tool_use_id: "c" }), token),
  );
  core.resolve(presented[0].requestId, true);
  const res = await pending;
  assert.deepEqual(decisionOf(res), { behavior: "allow", updatedInput: {} });
});

test("入参: input 为字符串/数组 → rawInput 原样保留、不崩，allow 回原值", async () => {
  for (const weird of ["just a string", [1, 2, 3]]) {
    const { core, presented } = makeCore();
    const { token } = core.openTurn("s", PORT);
    const pending = core.handle(
      postRaw(
        toolsCallJson({ tool_name: "Bash", input: weird, tool_use_id: "c" }),
        token,
      ),
    );
    assert.equal(presented.length, 1, "非对象 input 仍应推卡（工具名合法）");
    core.resolve(presented[0].requestId, true);
    const res = await pending;
    assert.deepEqual(decisionOf(res), {
      behavior: "allow",
      updatedInput: weird,
    });
  }
});

test("入参: 1MB 命令 → 摘要截断到 4000 字符内且带截断标注；rawInput 完整保留", async () => {
  const { core, presented } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const big = "x".repeat(1024 * 1024);
  const payload = {
    tool_name: "Bash",
    input: { command: big },
    tool_use_id: "c",
  };
  const pending = core.handle(postRaw(toolsCallJson(payload), token));
  // present 已被调（同步段）：卡上摘要必须已被截断
  assert.equal(presented.length, 1);
  assert.ok(presented[0].inputSummary.length < 4200);
  assert.ok(presented[0].inputSummary.includes("已截断"));
  assert.deepEqual(presented[0].rawInput, { command: big });
  core.resolve(presented[0].requestId, true);
  const res = await pending;
  const d = decisionOf(res);
  assert.deepEqual(d, { behavior: "allow", updatedInput: { command: big } });
});

// ---------------- 响应字节层 ----------------

test("响应: 非 initialize 响应不带 Mcp-Session-Id；403/404/405 均带 Connection: close", async () => {
  const { core } = makeCore();
  const { token } = core.openTurn("s", PORT);
  const list = await core.handle(
    postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      token,
    ),
  );
  assert.equal(list.headers["Mcp-Session-Id"], undefined);
  const initRes = await core.handle(
    postRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "x" },
      }),
      token,
    ),
  );
  assert.ok(initRes.headers["Mcp-Session-Id"]);
  for (const parts of [
    { status: 403, headers: {}, body: '{"e":1}' },
    { status: 404, headers: {}, body: "" },
    { status: 405, headers: { Allow: "POST" }, body: "" },
  ] as const) {
    const text = dec.decode(formatHttpResponse(parts));
    assert.ok(text.includes("Connection: close\r\n"));
    assert.ok(text.startsWith(`HTTP/1.1 ${parts.status} `));
  }
});
