// 单测 — src/modules/permissionMcp.ts 纯逻辑核心（PLAN §4.8 契约）
// 覆盖：token 校验（403）/ 握手序列（server-discover·initialize·notifications·GET 405·tools/list）/
//       tools/call allow·deny 回包形态 / 120s 超时按 deny / closeTurn 结掉在途请求 /
//       畸形入参 fail closed / 入参摘要 / HTTP 报文字节层解析与组装。
// Gecko 传输层（nsIServerSocket）不在本文件覆盖范围（node 无该 API），由真机验证覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createConnectionHandler,
  createPermissionCore,
  formatHttpResponse,
  parseHttpRequest,
  summarizeToolInput,
  PERMISSION_DENY_MESSAGE,
  PERMISSION_TIMEOUT_MS,
  type ParsedHttpRequest,
  type PermissionRequestPayload,
} from "../../src/modules/permissionMcp.ts";

const PORT = 51234;

function makeCore(opts: { timeoutMs?: number } = {}) {
  const presented: PermissionRequestPayload[] = [];
  const logs: string[] = [];
  /** 结算通知（宿主接桥广播给全实例摘卡）——按调用顺序记录 */
  const settled: string[] = [];
  const core = createPermissionCore({
    log: (m) => logs.push(m),
    present: (req) => presented.push(req),
    timeoutMs: opts.timeoutMs ?? 1000,
    settled: (requestId) => settled.push(requestId),
  });
  return { core, presented, logs, settled };
}

function openTurn(core: ReturnType<typeof makeCore>["core"]) {
  return core.openTurn("sess-1", PORT);
}

function post(body: unknown, token: string): ParsedHttpRequest {
  return {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function toolsCallBody(
  args: unknown,
  id: unknown = 7,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "permission_check", arguments: args },
  };
}

/** 解析 tools/call 回包里的决策 JSON（§4.8：content[0].text 是 JSON 字符串） */
function decisionOf(res: { body: string }): Record<string, unknown> {
  const payload = JSON.parse(res.body);
  return JSON.parse(payload.result.content[0].text);
}

// ---- token 校验（§4.8 URL token / §7.1 防本机其他进程骚扰）----

test("permMcp: 无 token → 403", async () => {
  const { core, logs } = makeCore();
  openTurn(core);
  const res = await core.handle({
    method: "POST",
    path: "/mcp",
    query: {},
    headers: {},
    body: "{}",
  });
  assert.equal(res.status, 403);
  // 日志里不得出现 token 值（§7.1 不记录凭据）
  assert.ok(!logs.join("\n").includes("token="));
});

test("permMcp: token 不匹配 → 403", async () => {
  const { core } = makeCore();
  openTurn(core);
  const res = await core.handle(post({ jsonrpc: "2.0", id: 1 }, "not-a-token"));
  assert.equal(res.status, 403);
});

test("permMcp: token 随该轮撤销——closeTurn 后再用旧 token → 403", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  assert.equal(
    (
      await core.handle(
        post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      )
    ).status,
    200,
  );
  core.closeTurn(token);
  assert.equal(core.openTurnCount(), 0);
  assert.equal(
    (
      await core.handle(
        post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token),
      )
    ).status,
    403,
  );
});

test("permMcp: 非 /mcp 路径 → 404", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle({
    ...post({ jsonrpc: "2.0", id: 1 }, token),
    path: "/other",
  });
  assert.equal(res.status, 404);
});

// ---- 握手序列（§4.8 表，spike 实测定型）----

test("permMcp: server/discover → result 空对象", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post(
      {
        jsonrpc: "2.0",
        id: "server-discover-probe-1",
        method: "server/discover",
        params: {},
      },
      token,
    ),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    jsonrpc: "2.0",
    id: "server-discover-probe-1",
    result: {},
  });
});

test("permMcp: initialize → 回显 protocolVersion + 响应头带 Mcp-Session-Id", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post(
      {
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
        jsonrpc: "2.0",
        id: 0,
      },
      token,
    ),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers["Mcp-Session-Id"]);
  const payload = JSON.parse(res.body);
  assert.equal(payload.id, 0);
  assert.equal(payload.result.protocolVersion, "2025-11-25");
  assert.deepEqual(payload.result.capabilities, { tools: {} });
});

test("permMcp: notifications/initialized → 202 空体", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post({ jsonrpc: "2.0", method: "notifications/initialized" }, token),
  );
  assert.equal(res.status, 202);
  assert.equal(res.body, "");
});

test("permMcp: GET /mcp（SSE 探测）→ 405", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle({
    method: "GET",
    path: "/mcp",
    query: { token },
    headers: {},
    body: "",
  });
  assert.equal(res.status, 405);
});

test("permMcp: tools/list → 含 permission_check，schema 为 {tool_name, input, tool_use_id}", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post({ method: "tools/list", jsonrpc: "2.0", id: 1 }, token),
  );
  const tools = JSON.parse(res.body).result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "permission_check");
  assert.deepEqual(tools[0].inputSchema.required, [
    "tool_name",
    "input",
    "tool_use_id",
  ]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), [
    "tool_name",
    "input",
    "tool_use_id",
  ]);
});

test("permMcp: 未知方法 → 空 result（前向兼容，不打断 CLI）", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post({ method: "resources/list", jsonrpc: "2.0", id: 3 }, token),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).result, {});
});

test("permMcp: 畸形 JSON 正文 → 400", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(post("{not json", token));
  assert.equal(res.status, 400);
});

// ---- tools/call：allow / deny 回包（§4.8 实测形态）----

test("permMcp: tools/call → present 收到 {tool,input,tool_use_id}；allow 回 updatedInput=原 input", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const input = { command: "python -V", description: "检查版本" };
  const pending = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input,
        tool_use_id: "call_abc123",
      }),
      token,
    ),
  );
  // present 在 handle 的同步段内即被调用（ask() 的 Promise executor 同步执行）
  assert.equal(presented.length, 1);
  const req = presented[0];
  assert.equal(req.tool, "Bash");
  assert.equal(req.sessionId, "sess-1");
  assert.equal(req.toolUseId, "call_abc123");
  assert.deepEqual(req.rawInput, input);
  assert.equal(req.inputSummary, "python -V\n\n# 检查版本");
  const resolved = core.resolve(req.requestId, true);
  assert.equal(resolved?.tool, "Bash");
  const res = await pending;
  assert.deepEqual(decisionOf(res), { behavior: "allow", updatedInput: input });
});

test("permMcp: deny 回包带 message 原文（§4.8：原样传达给 AI）", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const pending = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "rm -rf x" },
        tool_use_id: "call_deny",
      }),
      token,
    ),
  );
  core.resolve(presented[0].requestId, false);
  const res = await pending;
  assert.deepEqual(decisionOf(res), {
    behavior: "deny",
    message: PERMISSION_DENY_MESSAGE,
  });
});

test("permMcp: resolve 未知 requestId → null（§4.6 非法输入契约）", async () => {
  const { core } = makeCore();
  openTurn(core);
  assert.equal(core.resolve("no-such-id", true), null);
});

test("permMcp: 重复 resolve 同一 requestId → 第二次 null（幂等，不重复放行）", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const pending = core.handle(
    post(
      toolsCallBody({ tool_name: "Read", input: {}, tool_use_id: "c" }),
      token,
    ),
  );
  const id = presented[0].requestId;
  assert.ok(core.resolve(id, true));
  assert.equal(core.resolve(id, true), null);
  await pending;
});

// ---- 超时（§4.8：120s 未响应按 deny）----

test("permMcp: 用户不响应 → 超时按 deny 结掉", async () => {
  const { core, presented, logs } = makeCore({ timeoutMs: 20 });
  const { token } = openTurn(core);
  const pending = core.handle(
    post(
      toolsCallBody({
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
  assert.ok(logs.some((l) => l.includes("timed out")));
  // 超时后再答 → 未知（卡已作废）
  assert.equal(core.resolve(presented[0].requestId, true), null);
});

test("permMcp: 默认超时 120s（§4.8）", () => {
  assert.equal(PERMISSION_TIMEOUT_MS, 120_000);
});

// ---- closeTurn：进程结束即结掉在途请求 ----

test("permMcp: 该轮退出（closeTurn）→ 在途请求按 deny 结掉", async () => {
  const { core } = makeCore();
  const { token } = openTurn(core);
  const pending = core.handle(
    post(
      toolsCallBody({
        tool_name: "Write",
        input: { file_path: "/x" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  assert.equal(core.pendingCount(), 1);
  core.closeTurn(token);
  const res = await pending;
  assert.equal(decisionOf(res).behavior, "deny");
  assert.equal(core.pendingCount(), 0);
});

test("permMcp: closeTurn 只结掉本会话请求（另一轮在途请求不受影响）", async () => {
  const { core } = makeCore();
  const a = core.openTurn("sess-a", PORT);
  const b = core.openTurn("sess-b", PORT);
  const pa = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "a" },
        tool_use_id: "ca",
      }),
      a.token,
    ),
  );
  const pb = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "b" },
        tool_use_id: "cb",
      }),
      b.token,
    ),
  );
  core.closeTurn(a.token);
  assert.equal(decisionOf(await pa).behavior, "deny");
  assert.equal(core.pendingCount(), 1);
  core.closeTurn(b.token);
  assert.equal(decisionOf(await pb).behavior, "deny");
});

// ---- 结算通知（§4.6 permissionResolved）：卡广播给多实例，摘卡也必须全实例一致 ----
// 用户报障原形：在文献 A 的侧栏答「允许」→ 切到文献 B，B 侧栏里那张卡还在（别的实例没收到结算）。

test("permMcp: 作答结算 → settled 通知一次（重复 resolve 不再通知）", async () => {
  const { core, presented, settled } = makeCore();
  const { token } = openTurn(core);
  const pending = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  const id = presented[0].requestId;
  assert.ok(core.resolve(id, true));
  assert.deepEqual(settled, [id]);
  // 幂等：第二次 resolve 是未知 id（null），不得再发一次结算通知
  assert.equal(core.resolve(id, false), null);
  assert.deepEqual(settled, [id]);
  await pending;
});

test("permMcp: 超时按 deny 结掉 → 同样通知 settled（卡已作废，各实例摘掉）", async () => {
  const { core, presented, settled } = makeCore({ timeoutMs: 20 });
  const { token } = openTurn(core);
  const res = await core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  assert.equal(decisionOf(res).behavior, "deny");
  assert.deepEqual(settled, [presented[0].requestId]);
});

test("permMcp: closeTurn → 本会话每个在途请求各通知一次 settled（他会话不误伤）", async () => {
  const { core, presented, settled } = makeCore();
  const a = core.openTurn("sess-a", PORT);
  const b = core.openTurn("sess-b", PORT);
  const pa = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "a" },
        tool_use_id: "ca",
      }),
      a.token,
    ),
  );
  const pb = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "b" },
        tool_use_id: "cb",
      }),
      b.token,
    ),
  );
  core.closeTurn(a.token);
  assert.equal(decisionOf(await pa).behavior, "deny");
  assert.deepEqual(settled, [presented[0].requestId]);
  core.closeTurn(b.token);
  assert.equal(decisionOf(await pb).behavior, "deny");
  assert.deepEqual(settled, [presented[0].requestId, presented[1].requestId]);
});

test("permMcp: present 抛错（UI 故障）→ deny 同时通知 settled", async () => {
  const settled: string[] = [];
  const core = createPermissionCore({
    log: () => {},
    present: () => {
      throw new Error("bridge down");
    },
    timeoutMs: 5000,
    settled: (id) => settled.push(id),
  });
  const { token } = core.openTurn("s", PORT);
  const res = await core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  assert.equal(decisionOf(res).behavior, "deny");
  assert.equal(core.pendingCount(), 0);
  assert.equal(settled.length, 1);
});

test("permMcp: settled 回调抛错 → 只记日志，端点照常结算（不反噬回包）", async () => {
  const logs: string[] = [];
  const presented: PermissionRequestPayload[] = [];
  const core = createPermissionCore({
    log: (m) => logs.push(m),
    present: (req) => presented.push(req),
    timeoutMs: 1000,
    settled: () => {
      throw new Error("broadcast failed");
    },
  });
  const { token } = core.openTurn("s", PORT);
  const pending = core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  assert.equal(core.pendingCount(), 1);
  // 作答：settled 抛错不得影响 resolve 的返回值（宿主据此回写端点）
  const resolved = core.resolve(presented[0].requestId, true);
  assert.equal(resolved?.tool, "Bash");
  assert.ok(logs.some((l) => l.includes("settled() threw")));
  const res = await pending;
  assert.equal(decisionOf(res).behavior, "allow");
});

// ---- 畸形入参 fail closed ----

test("permMcp: tools/call 缺 tool_name → deny 且不推卡（绝不放行）", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post(toolsCallBody({ input: { command: "ls" }, tool_use_id: "c" }), token),
  );
  assert.equal(decisionOf(res).behavior, "deny");
  assert.equal(presented.length, 0);
});

test("permMcp: present 抛错（UI 故障）→ 该请求 deny，不吊死", async () => {
  const logs: string[] = [];
  const core = createPermissionCore({
    log: (m) => logs.push(m),
    present: () => {
      throw new Error("bridge down");
    },
    timeoutMs: 5000,
  });
  const { token } = core.openTurn("s", PORT);
  const res = await core.handle(
    post(
      toolsCallBody({
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "c",
      }),
      token,
    ),
  );
  assert.equal(decisionOf(res).behavior, "deny");
  assert.equal(core.pendingCount(), 0);
});

test("permMcp: 未知工具名 → JSON-RPC error（不当作权限请求）", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const res = await core.handle(
    post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "other_tool", arguments: {} },
      },
      token,
    ),
  );
  const payload = JSON.parse(res.body);
  assert.equal(payload.error.code, -32601);
  assert.equal(presented.length, 0);
});

// ---- 入参摘要（§4.6 inputSummary）----

test("permMcp: 摘要——Bash 命令 / Edit 路径+diff / Write 路径+预览 / Read 路径", () => {
  assert.equal(
    summarizeToolInput("Bash", { command: "git status" }),
    "git status",
  );
  const edit = summarizeToolInput("Edit", {
    file_path: "/w/a.md",
    old_string: "旧",
    new_string: "新",
  });
  assert.ok(edit.includes("/w/a.md"));
  assert.ok(edit.includes("--- 原内容\n旧\n+++ 新内容\n新"));
  const write = summarizeToolInput("Write", {
    file_path: "/w/b.txt",
    content: "hello",
  });
  assert.ok(write.includes("/w/b.txt"));
  assert.ok(write.includes("共 5 字符"));
  assert.equal(
    summarizeToolInput("Read", { file_path: "/w/c.pdf" }),
    "/w/c.pdf",
  );
});

test("permMcp: 摘要——未知工具回落 JSON；超长截断并标注", () => {
  assert.equal(
    summarizeToolInput("mcp__foo__bar", { a: 1 }),
    JSON.stringify({ a: 1 }, null, 2),
  );
  const long = summarizeToolInput("Bash", { command: "x".repeat(9000) });
  assert.ok(long.length < 9000);
  assert.ok(long.includes("已截断"));
});

test("permMcp: 摘要——检索类工具给检索词，不给目录路径", () => {
  assert.equal(
    summarizeToolInput("Grep", { pattern: "abc", path: "/w" }),
    "abc",
  );
  assert.equal(
    summarizeToolInput("Glob", { pattern: "**/*.md", path: "/w" }),
    "**/*.md",
  );
  assert.equal(
    summarizeToolInput("WebFetch", { url: "https://x/y" }),
    "https://x/y",
  );
});

// ---- HTTP 字节层（解析/组装）----

test("parseHttpRequest: 完整 POST（中文正文）按字节计数；少一字节 → incomplete", () => {
  const body = JSON.stringify({ m: "tools/call", text: "中文命令" });
  const raw = `POST /mcp?token=abc&x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`;
  const bytes = new TextEncoder().encode(raw);
  const ok = parseHttpRequest(bytes);
  assert.equal(ok.status, "ok");
  if (ok.status !== "ok") {
    return;
  }
  assert.equal(ok.request.method, "POST");
  assert.equal(ok.request.path, "/mcp");
  assert.deepEqual(ok.request.query, { token: "abc", x: "1" });
  assert.equal(ok.request.headers["content-type"], "application/json");
  assert.equal(ok.request.body, body);
  assert.equal(ok.consumed, bytes.length);
  assert.equal(
    parseHttpRequest(bytes.subarray(0, bytes.length - 1)).status,
    "incomplete",
  );
});

test("parseHttpRequest: 只有头区 → incomplete；畸形请求行 → error；Content-Length 非法 → error", () => {
  const head = "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n";
  assert.equal(
    parseHttpRequest(new TextEncoder().encode(head)).status,
    "incomplete",
  );
  assert.equal(
    parseHttpRequest(new TextEncoder().encode("GARBAGE\r\n\r\n")).status,
    "error",
  );
  assert.equal(
    parseHttpRequest(
      new TextEncoder().encode(
        "POST /mcp HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
      ),
    ).status,
    "error",
  );
});

test("parseHttpRequest: GET（无正文）不等待 body", () => {
  const raw = "GET /mcp?token=t HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
  const r = parseHttpRequest(new TextEncoder().encode(raw));
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.request.body, "");
    assert.equal(r.request.method, "GET");
  }
});

test("formatHttpResponse: Content-Length 按 UTF-8 字节数；重复的 Content-Length 头被忽略", () => {
  const bytes = formatHttpResponse({
    status: 200,
    headers: { "Content-Type": "application/json", "Content-Length": "999" },
    body: "中文",
  });
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\r\n");
  assert.equal(lines[0], "HTTP/1.1 200 OK");
  assert.deepEqual(
    lines.filter((l) => l.toLowerCase().startsWith("content-length:")),
    ["Content-Length: 6"],
  );
  assert.equal(text.slice(text.indexOf("\r\n\r\n") + 4), "中文");
  // 6 = "中文" 的 UTF-8 字节数（不是字符数 2）
  assert.equal(bytes.length, text.indexOf("\r\n\r\n") + 4 + 6);
});

test("formatHttpResponse: 400/403/405/500 状态行正确", () => {
  for (const [status, line] of [
    [400, "HTTP/1.1 400 Bad Request"],
    [403, "HTTP/1.1 403 Forbidden"],
    [405, "HTTP/1.1 405 Method Not Allowed"],
    [500, "HTTP/1.1 500 Internal Server Error"],
  ] as const) {
    const text = new TextDecoder().decode(
      formatHttpResponse({ status, headers: {}, body: "" }),
    );
    assert.ok(text.startsWith(`${line}\r\n`));
  }
});

// ---- CSPRNG 缺失 = fail-closed（安全审查 MEDIUM：绝不回退弱随机）----

/** 临时抽掉 globalThis.crypto（Node 上是 configurable 访问器，可安全恢复） */
function withoutCrypto<T>(fn: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    return fn();
  } finally {
    if (saved) {
      Object.defineProperty(globalThis, "crypto", saved);
    }
  }
}

test("permMcp: CSPRNG 缺失 → 拒绝创建端点（核心构造即抛错，不回退弱随机）", () => {
  assert.throws(
    () =>
      withoutCrypto(() =>
        createPermissionCore({ log: () => {}, present: () => {} }),
      ),
    /CSPRNG unavailable/,
  );
});

test("permMcp: CSPRNG 缺失 → openTurn 抛错（该轮 token 绝不弱随机）", () => {
  const { core } = makeCore();
  assert.throws(
    () => withoutCrypto(() => core.openTurn("sess-1", PORT)),
    /CSPRNG unavailable/,
  );
  // 恢复后仍可用，且 token 形态为 32 位 hex（16 字节）
  const { token } = core.openTurn("sess-1", PORT);
  assert.match(token, /^[0-9a-f]{32}$/);
});

test("permMcp: CSPRNG 缺失 → tools/call 返 500 且不推卡（fail-closed，绝不放行）", async () => {
  const { core, presented } = makeCore();
  const { token } = openTurn(core);
  const res = await withoutCrypto(() =>
    core.handle(
      post(
        toolsCallBody({
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "c",
        }),
        token,
      ),
    ),
  );
  assert.equal(res.status, 500);
  assert.equal(presented.length, 0);
});

// ---- 单连接状态机（传输层抽出的可测形态；安全审计致命项 DoS 回归锁）----
// 覆盖：正常回包一次 + linger 收尾 / 超限只回一次 400 且立即收连接、后续字节不再写不再累积不续命 /
//       respond 幂等（重放不重复回包）/ 分片拼齐才回包 / 对端关闭两条路径 / 空闲超时。

const tick0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeFakeTimers() {
  let seq = 0;
  let setCalls = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      set(fn: () => void, ms: number): unknown {
        setCalls += 1;
        const id = ++seq;
        pending.set(id, { fn, ms });
        return id;
      },
      clear(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    setCalls: () => setCalls,
    pendingCount: () => pending.size,
    fireAll(): void {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
  };
}

function makeFakeIo() {
  const writes: Uint8Array[] = [];
  const closes: string[] = [];
  const logs: string[] = [];
  return {
    io: {
      write(b: Uint8Array): void {
        writes.push(b);
      },
      close(reason: string): void {
        closes.push(reason);
      },
      log(m: string): void {
        logs.push(m);
      },
    },
    writes,
    closes,
    logs,
    text: (i: number): string => new TextDecoder().decode(writes[i]),
  };
}

function connHarness(opts: { maxBytes?: number } = {}) {
  const core = createPermissionCore({
    log: () => {},
    present: () => {},
    timeoutMs: 5000,
  });
  const { token } = core.openTurn("sess-conn", 1234);
  const clock = makeFakeTimers();
  const fake = makeFakeIo();
  const handler = createConnectionHandler({
    core,
    io: fake.io,
    timers: clock.timers,
    idleMs: 1000,
    lingerMs: 5000,
    maxBytes: opts.maxBytes ?? 4096,
  });
  return { core, token, clock, fake, handler };
}

/** HTTP 请求字节（Content-Length 按 UTF-8 字节数） */
function requestBytes(token: string, body: string): Uint8Array {
  const raw =
    `POST /mcp?token=${token} HTTP/1.1\r\n` +
    `Host: 127.0.0.1\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n` +
    body;
  return new TextEncoder().encode(raw);
}

const toolsListBytes = (token: string): Uint8Array =>
  requestBytes(
    token,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  );

test("conn: 完整请求 → 回一次 200；linger 到点才收连接", async () => {
  const h = connHarness();
  h.handler.onData(toolsListBytes(h.token));
  await tick0();
  assert.equal(h.fake.writes.length, 1);
  assert.ok(h.fake.text(0).startsWith("HTTP/1.1 200 OK"));
  assert.deepEqual(h.fake.closes, []); // 回包后不立刻断（等对端 FIN / linger）
  h.clock.fireAll();
  assert.deepEqual(h.fake.closes, ["linger elapsed"]);
});

test("conn: 分片到达——第一段不收齐不回包，拼齐后回一次", async () => {
  const h = connHarness();
  const full = toolsListBytes(h.token);
  const cut = 40;
  h.handler.onData(full.subarray(0, cut));
  await tick0();
  assert.equal(h.fake.writes.length, 0);
  h.handler.onData(full.subarray(cut));
  await tick0();
  assert.equal(h.fake.writes.length, 1);
});

test("conn: 超限 → 只回一次 400 + 立即收连接；后续字节不写、不累积、不续命（审计致命项）", async () => {
  const h = connHarness({ maxBytes: 200 });
  // 单段就超限（攻击形态：请求体灌大 / 持续发数据）
  h.handler.onData(
    requestBytes(
      h.token,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        padding: "x".repeat(5000),
      }),
    ),
  );
  await tick0();
  assert.equal(h.fake.writes.length, 1, "超限只回一次");
  assert.ok(h.fake.text(0).startsWith("HTTP/1.1 400 Bad Request"));
  assert.deepEqual(h.fake.closes, ["oversize request"], "超限后立即收连接");
  assert.equal(h.clock.pendingCount(), 0, "不留任何定时器（含 linger）");
  const setCallsAfterOversize = h.clock.setCalls();
  // 攻击形态复现：持续发数据。回包后一律丢弃 —— 不再回包、不再续命
  for (let i = 0; i < 50; i++) {
    h.handler.onData(new Uint8Array(1024).fill(65));
  }
  await tick0();
  assert.equal(h.fake.writes.length, 1, "后续数据不触发任何回包");
  assert.equal(h.fake.closes.length, 1, "连接不被反复收");
  assert.equal(
    h.clock.setCalls(),
    setCallsAfterOversize,
    "linger 定时器不被后续数据重设",
  );
  assert.equal(h.clock.pendingCount(), 0);
});

test("conn: respond 幂等——同一请求重放/二次分片不重复回包，linger 不被重置", async () => {
  const h = connHarness();
  const req = toolsListBytes(h.token);
  h.handler.onData(req);
  await tick0();
  const setCallsAfterFirst = h.clock.setCalls();
  h.handler.onData(req);
  h.handler.onData(req);
  await tick0();
  assert.equal(h.fake.writes.length, 1);
  assert.equal(h.clock.setCalls(), setCallsAfterFirst);
});

test("conn: 决策等待期间重放/追加字节 → 只派发一次（流水线重复派发修复）", async () => {
  const presented: PermissionRequestPayload[] = [];
  const core = createPermissionCore({
    log: () => {},
    present: (req) => presented.push(req),
    timeoutMs: 5000,
  });
  const { token } = core.openTurn("sess-dup", PORT);
  const clock = makeFakeTimers();
  const fake = makeFakeIo();
  const handler = createConnectionHandler({
    core,
    io: fake.io,
    timers: clock.timers,
    idleMs: 1000,
    lingerMs: 5000,
    maxBytes: 4096,
  });
  const req = requestBytes(
    token,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "permission_check",
        arguments: {
          tool_name: "Bash",
          input: { command: "x" },
          tool_use_id: "tu1",
        },
      },
    }),
  );
  handler.onData(req); // 收齐 → 派发 → 推卡（等决策，不立即回包）
  await tick0();
  assert.equal(presented.length, 1);
  assert.equal(fake.writes.length, 0);
  handler.onData(req); // 决策窗口内重放同一请求（旧实现：二次 parse → 第二张卡）
  handler.onData(new TextEncoder().encode("\r\n\r\n")); // 追加垃圾字节
  await tick0();
  assert.equal(presented.length, 1, "同连接只派发一次，不重复推卡");
  // 决策回写 → 结掉那次唯一派发，回一次包
  assert.ok(core.resolve(presented[0].requestId, true));
  await tick0();
  assert.equal(fake.writes.length, 1);
  assert.ok(fake.text(0).startsWith("HTTP/1.1 200 OK"));
  assert.equal(core.pendingCount(), 0);
});

test("conn: 畸形请求 → 400 只回一次，后续数据被丢弃", async () => {
  const h = connHarness();
  h.handler.onData(new TextEncoder().encode("GARBAGE\r\n\r\n"));
  await tick0();
  assert.equal(h.fake.writes.length, 1);
  assert.ok(h.fake.text(0).startsWith("HTTP/1.1 400 Bad Request"));
  h.handler.onData(new TextEncoder().encode("more junk"));
  await tick0();
  assert.equal(h.fake.writes.length, 1);
});

test("conn: 对端在收齐前关闭 → 不回包、收连接（不计为已回包）", () => {
  const h = connHarness();
  h.handler.onData(
    new TextEncoder().encode("POST /mcp?token=x HTTP/1.1\r\nHost: h\r\n"),
  );
  h.handler.onEnd();
  assert.equal(h.fake.writes.length, 0);
  assert.deepEqual(h.fake.closes, ["peer closed before complete request"]);
});

test("conn: 对端读完即关 → 立刻收连接（不等 linger），且只关一次", async () => {
  const h = connHarness();
  h.handler.onData(toolsListBytes(h.token));
  await tick0();
  h.handler.onEnd();
  assert.deepEqual(h.fake.closes, ["peer closed after response"]);
  h.clock.fireAll(); // linger 定时器已被清理
  assert.equal(h.fake.closes.length, 1);
});

test("conn: 空闲超时（未收齐请求）→ 收连接、不发任何字节", () => {
  const h = connHarness();
  assert.equal(h.clock.pendingCount(), 1);
  h.clock.fireAll();
  assert.equal(h.fake.writes.length, 0);
  assert.deepEqual(h.fake.closes, ["idle timeout (no complete request)"]);
});

test("conn: 正常请求不受限流影响（上限内多段拼齐仍回 200）", async () => {
  const h = connHarness({ maxBytes: 4096 });
  const full = toolsListBytes(h.token);
  h.handler.onData(full.subarray(0, 10));
  h.handler.onData(full.subarray(10, 60));
  h.handler.onData(full.subarray(60));
  await tick0();
  assert.equal(h.fake.writes.length, 1);
  assert.ok(h.fake.text(0).startsWith("HTTP/1.1 200 OK"));
  assert.deepEqual(h.fake.closes, []);
});

// ---- 响应头 CRLF 注入防御（安全审查建议 3）----

test("formatHttpResponse: 头名/头值里的 CR/LF 被剔除（无法注入新响应头）", () => {
  const bytes = formatHttpResponse({
    status: 200,
    headers: {
      "X-Test": "ok\r\nX-Injected: 1",
      "X-Bad\r\nX-Name": "v",
    },
    body: "",
  });
  const text = new TextDecoder().decode(bytes);
  const headLines = text.split("\r\n\r\n")[0].split("\r\n");
  assert.ok(!headLines.includes("X-Injected: 1"), "不得出现被注入的头行");
  assert.ok(
    headLines.includes("X-Test: okX-Injected: 1"),
    "CRLF 被剔除后并入原值",
  );
  assert.ok(headLines.includes("X-BadX-Name: v"), "头名里的 CRLF 同样剔除");
  // 头区行数固定：状态行 + Content-Length + Connection + Cache-Control + 2 个自定义头
  assert.equal(headLines.length, 6);
});
