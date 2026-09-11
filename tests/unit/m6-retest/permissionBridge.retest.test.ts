// m6-retest — 桥权限流转独立复测（只测不修，test-m6）。
// 独立性：假件复用 m5-retest 自写夹具（回归代理产物，非被测方 tests/unit/helpers），
// sessionStore 用真实现。覆盖 M6 关键流转的未测边角：
//   同一卡双答幂等 · 进程退出时在途卡 deny · remember 三档 · 会话已删时的 remember 跳过 ·
//   多实例广播先答者生效 · 存储写失败不崩。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
} from "../../../src/modules/hostBridge.ts";
import {
  createPermissionCore,
  PERMISSION_DENY_MESSAGE,
  type ParsedHttpRequest,
  type ResolvedPermission,
} from "../../../src/modules/permissionMcp.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
  TurnHandle,
} from "../../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../../src/chat/lib/types.ts";
import { makeStore, FakeTurn, settle } from "../m5-retest/fakes.ts";

const HELLO = "hello-token";

function makeEnv(
  opts: { core?: ReturnType<typeof createPermissionCore> } = {},
) {
  const memory = makeStore();
  const sent: { win: object; msg: HostMessage }[] = [];
  const turns: FakeTurn[] = [];
  const pending = new Map<string, ResolvedPermission>();
  const resolves: { requestId: string; allow: boolean }[] = [];
  const closedTokens: string[] = [];
  const core = opts.core ?? null;

  const deps: HostBridgeDeps = {
    post: (_win, msg) => {
      sent.push({ win: _win as object, msg });
    },
    createChannel: () => null,
    log: (m) => memory.logs.push(m),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string) => ({
      itemKey: null,
      attachmentKey: null,
      prompt: text,
      addDir: null,
    }),
    ensureWorkspace: async () => "/ws",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: (sessionId: string) =>
      core ? core.openTurn(sessionId, 51888) : { port: 51888, token: "tok-x" },
    closeMcpTurn: (token: string) => {
      closedTokens.push(token);
      core?.closeTurn(token);
    },
    resolvePermission: (requestId: string, allow: boolean) => {
      resolves.push({ requestId, allow });
      if (core) {
        return core.resolve(requestId, allow);
      }
      const p = pending.get(requestId);
      if (!p) return null;
      pending.delete(requestId);
      return p;
    },
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: SpawnTurnOptions): TurnHandle => {
      const turn = new FakeTurn(options);
      turns.push(turn);
      return turn;
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async () => null,
    helloTimeoutMs: 1000,
  };
  return {
    deps,
    sent,
    turns,
    pending,
    resolves,
    closedTokens,
    store: memory.store,
    fs: memory.fs,
    logs: memory.logs,
  };
}

function handshake(
  env: ReturnType<typeof makeEnv>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  token = HELLO,
): void {
  bridge.beginHandshake(win, token);
  bridge.dispatch({ source: win, data: { type: "hello", token } });
}

async function spawnOne(
  env: ReturnType<typeof makeEnv>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text = "跑一下 python",
): Promise<{ sessionId: string; token: string }> {
  bridge.dispatch({ source: win, data: { type: "send", text } });
  await settle();
  assert.equal(env.turns.length >= 1, true, "应 spawn 一轮");
  const args = env.turns[0].options.args;
  const mcpJson = args[args.indexOf("--mcp-config") + 1];
  const url = JSON.parse(mcpJson).mcpServers["claudian-perm"].url as string;
  const token = url.slice(url.indexOf("token=") + "token=".length);
  const rec = env.store.list()[0];
  return { sessionId: rec.id, token };
}

function toolsCallReq(
  token: string,
  tool: string,
  input: unknown,
  id: number = 42,
): ParsedHttpRequest {
  return {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "permission_check",
        arguments: { tool_name: tool, input, tool_use_id: "call_r" },
      },
    }),
  };
}

function decisionOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(JSON.parse(res.body).result.content[0].text);
}

// ---- 1. 同一张卡双答：先允许后拒绝 → 第二次必须被忽略 ----

test("桥复测: 同一卡先答允许后答拒绝 → 第二次忽略（HTTP 回包保持 allow，规则只落一条）", async () => {
  let bridge: ReturnType<typeof createHostBridge> | null = null;
  const core = createPermissionCore({
    log: () => {},
    present: (req) => bridge?.requestPermission(req),
  });
  const env = makeEnv({ core });
  bridge = createHostBridge(env.deps);
  const win = {};
  handshake(env, bridge, win);
  await settle();
  const { sessionId, token } = await spawnOne(env, bridge, win);

  const call = core.handle(
    toolsCallReq(token, "Bash", { command: "python -V" }),
  );
  await settle();
  const cards = env.sent.filter((s) => s.msg.type === "permissionRequest");
  assert.equal(cards.length, 1);
  const requestId = (cards[0].msg as { requestId: string }).requestId;

  // 第一次：允许并记住
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId,
      allow: true,
      remember: true,
    },
  });
  await settle();
  const res = await call;
  assert.deepEqual(decisionOf(res), {
    behavior: "allow",
    updatedInput: { command: "python -V" },
  });
  assert.deepEqual(env.store.get(sessionId)?.allowedTools, ["Bash(python *)"]);

  // 第二次：同一 requestId 改答拒绝（迟到/重复点击）
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId,
      allow: false,
      remember: false,
    },
  });
  await settle();
  assert.ok(
    env.logs.some((l) => l.includes("unknown/expired requestId")),
    "第二次应答应走「未知/过期」忽略路径",
  );
  assert.deepEqual(env.store.get(sessionId)?.allowedTools, ["Bash(python *)"]);
  assert.equal(
    env.sent.some(
      (s) =>
        s.msg.type === "error" &&
        (s.msg as { code?: string }).code === "SESSION_BUSY",
    ),
    false,
  );
});

// ---- 2. 进程退出（turn exit）时在途卡 → deny，不吊死 ----

test("桥复测: turn 进程退出时在途卡未答 → HTTP 回包 deny + 端点 pending 清空", async () => {
  let bridge: ReturnType<typeof createHostBridge> | null = null;
  const core = createPermissionCore({
    log: () => {},
    present: (req) => bridge?.requestPermission(req),
  });
  const env = makeEnv({ core });
  bridge = createHostBridge(env.deps);
  const win = {};
  handshake(env, bridge, win);
  await settle();
  const { token } = await spawnOne(env, bridge, win);

  const call = core.handle(
    toolsCallReq(token, "Bash", { command: "sleep 999" }),
  );
  await settle();
  assert.equal(core.pendingCount(), 1);

  // 用户没来得及点卡，进程退出（interrupt / 崩溃 / 自然结束）
  env.turns[0].releaseExit();
  await settle();

  const res = await call;
  assert.deepEqual(decisionOf(res), {
    behavior: "deny",
    message: PERMISSION_DENY_MESSAGE,
  });
  assert.equal(core.pendingCount(), 0);
  assert.deepEqual(env.closedTokens, [token]);
});

// ---- 3. remember 三档：MCP 整名 / Read 整名 / Bash 空命令记整名 ----

test("桥复测: remember 规则三档——MCP 整名、Read 整名（不带路径）、Bash 无命令记整名", async () => {
  for (const [tool, input, expected] of [
    ["mcp__foo__bar", { q: 1 }, "mcp__foo__bar"],
    ["Read", { file_path: "/secret/path.pdf" }, "Read"],
    ["Bash", { command: "   " }, "Bash"],
    ["Bash", {}, "Bash"],
  ] as const) {
    const env = makeEnv();
    const bridge = createHostBridge(env.deps);
    const win = {};
    handshake(env, bridge, win);
    await settle();
    const { sessionId } = await spawnOne(env, bridge, win);
    env.pending.set("req-r", { sessionId, tool, input });
    bridge.dispatch({
      source: win,
      data: {
        type: "permissionResponse",
        requestId: "req-r",
        allow: true,
        remember: true,
      },
    });
    await settle();
    assert.deepEqual(
      env.store.get(sessionId)?.allowedTools,
      [expected],
      `${tool} 的 remember 规则应为 ${expected}`,
    );
    // 反向：绝不允许把参数内容（路径）写进规则串
    const rules = env.store.get(sessionId)?.allowedTools ?? [];
    assert.equal(
      rules.some((r) => r.includes("/secret")),
      false,
      "规则串不得携带参数路径",
    );
  }
});

// ---- 4. remember 时会话已删 → 规则不落，请求照常放行，不崩 ----

test("桥复测: remember 时会话已删 → 不落规则、请求照常放行、log 留痕", async () => {
  const env = makeEnv();
  const bridge = createHostBridge(env.deps);
  const win = {};
  handshake(env, bridge, win);
  await settle();
  const { sessionId } = await spawnOne(env, bridge, win);
  env.pending.set("req-gone", {
    sessionId,
    tool: "Bash",
    input: { command: "ls" },
  });
  await env.store.remove(sessionId);
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-gone",
      allow: true,
      remember: true,
    },
  });
  await settle();
  assert.deepEqual(env.resolves, [{ requestId: "req-gone", allow: true }]);
  assert.ok(env.logs.some((l) => l.includes("remember: session gone")));
  assert.equal(env.store.get(sessionId), null);
});

// ---- 5. 多实例广播：两窗同收卡，先答者生效、后答被忽略 ----

test("桥复测: 卡广播到两个已注册实例；任一实例先答生效，后答者被忽略", async () => {
  const env = makeEnv();
  const bridge = createHostBridge(env.deps);
  const win1 = {};
  const win2 = {};
  handshake(env, bridge, win1, "t1");
  handshake(env, bridge, win2, "t2");
  await settle();
  env.pending.set("req-dual", {
    sessionId: "s-dual",
    tool: "Bash",
    input: { command: "whoami" },
  });
  bridge.requestPermission({
    requestId: "req-dual",
    sessionId: "s-dual",
    tool: "Bash",
    inputSummary: "whoami",
    rawInput: { command: "whoami" },
    toolUseId: "c",
  });
  const cards = env.sent.filter((s) => s.msg.type === "permissionRequest");
  assert.equal(cards.length, 2, "两个实例各收一份");
  assert.deepEqual(new Set(cards.map((c) => c.win)), new Set([win1, win2]));
  // win2 先答 → 端点结算（在途条目被取走），桥记录 allow
  bridge.dispatch({
    source: win2,
    data: {
      type: "permissionResponse",
      requestId: "req-dual",
      allow: true,
      remember: false,
    },
  });
  await settle();
  assert.equal(env.pending.has("req-dual"), false, "先答者取走在途请求");
  assert.ok(
    env.logs.some((l) => l.includes("permissionResponse: Bash → allow")),
  );
  // win1 后答同 id → 端点已无此请求（返回 null）→ 桥忽略 + log，不产生任何副作用
  bridge.dispatch({
    source: win1,
    data: {
      type: "permissionResponse",
      requestId: "req-dual",
      allow: false,
      remember: false,
    },
  });
  await settle();
  assert.ok(
    env.logs.some((l) => l.includes("unknown/expired requestId")),
    "后答应走忽略路径",
  );
  assert.equal(
    env.logs.filter((l) => l.includes("permissionResponse: Bash → deny"))
      .length,
    0,
    "后答的 deny 不得被应用",
  );
});

// ---- 6. 规则串落盘失败（磁盘写错）→ 不产生未处理拒绝 ----

test("桥复测: remember 落盘失败（索引写抛）→ 不崩、不产生未处理拒绝", async () => {
  const env = makeEnv();
  const bridge = createHostBridge(env.deps);
  const win = {};
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    handshake(env, bridge, win);
    await settle();
    const { sessionId } = await spawnOne(env, bridge, win);
    env.fs.failWhen = (op) => op === "write" || op === "move";
    env.pending.set("req-fail", {
      sessionId,
      tool: "Bash",
      input: { command: "ls" },
    });
    bridge.dispatch({
      source: win,
      data: {
        type: "permissionResponse",
        requestId: "req-fail",
        allow: true,
        remember: true,
      },
    });
    await settle(12);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(unhandled, [], "不得有未处理拒绝");
    // 端点侧仍然放行（规则落不上属于次要失败）
    assert.deepEqual(env.resolves, [{ requestId: "req-fail", allow: true }]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
