// 单测 — hostBridge.ts 权限卡流转（M6，§4.6 permissionRequest/permissionResponse + §4.8 端点契约）
// 覆盖：端点凭据开/撤（该轮 spawn 带 port+token、进程退出撤销）、卡广播字段逐字对齐契约、
//       permissionResponse 回写端点、allow+remember → allowedTools 追加 → 下一轮 --allowedTools 携带、
//       未知 requestId 忽略、端点故障 → SPAWN_FAILED 且不 spawn。
// Gecko 全 fake；sessionStore 用真实实现 + 内存文件系统（与 hostBridge.test.ts 同口径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
  TurnHandle,
} from "../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { SessionStore } from "../../src/utils/sessionStore.ts";
import { createPermissionCore } from "../../src/modules/permissionMcp.ts";
import {
  initialChatState,
  permissionRespond,
  reduceHostMessage,
  userSend,
} from "../../src/chat/lib/chatModel.ts";
import type { ParsedHttpRequest } from "../../src/modules/permissionMcp.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const TOKEN = "tok-handshake";
const MCP_TOKEN = "mcp-token-1";

function tick(rounds = 8): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p;
}

class FakeTurn implements TurnHandle {
  killed = false;
  private resolveExit!: () => void;
  readonly exitPromise: Promise<void> = new Promise<void>((r) => {
    this.resolveExit = r;
  });
  constructor(readonly options: SpawnTurnOptions) {}
  kill(): void {
    this.killed = true;
  }
  release(): void {
    this.resolveExit();
  }
  emit(event: TurnEvent): void {
    this.options.onEvent(event);
  }
}

interface PendingStub {
  sessionId: string;
  tool: string;
  input: unknown;
}

function makeDeps(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeStore();
  const turns: FakeTurn[] = [];
  const mcpCalls: { sessionId: string }[] = [];
  const closedTokens: string[] = [];
  const resolves: { requestId: string; allow: boolean }[] = [];
  /** 测试侧冒充 permissionMcp 端点的在途请求表 */
  const pending = new Map<string, PendingStub>();
  let endpointError: Error | null = null;

  const deps: HostBridgeDeps & {
    sent: typeof sent;
    turns: FakeTurn[];
    mcpCalls: typeof mcpCalls;
    closedTokens: typeof closedTokens;
    resolves: typeof resolves;
    pending: typeof pending;
    setEndpointError: (err: Error | null) => void;
    store: SessionStore;
    logs: string[];
  } = {
    sent,
    turns,
    mcpCalls,
    closedTokens,
    resolves,
    pending,
    setEndpointError: (err) => {
      endpointError = err;
    },
    store: memory.store,
    logs: memory.logs,
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: (m) => memory.logs.push(m),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: null,
      attachmentKey: null,
      prompt: text,
      addDir: null,
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: (sessionId: string) => {
      if (endpointError) {
        throw endpointError;
      }
      mcpCalls.push({ sessionId });
      return { port: 51234, token: MCP_TOKEN };
    },
    closeMcpTurn: (token: string) => closedTokens.push(token),
    resolvePermission: (requestId: string, allow: boolean) => {
      resolves.push({ requestId, allow });
      const p = pending.get(requestId);
      if (!p) {
        return null;
      }
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
    ...overrides,
  };
  return deps;
}

function makeWin(): object {
  return { __win: true };
}

function handshake(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
}

async function sendAndSpawn(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text = "你好",
): Promise<string> {
  bridge.dispatch({ source: win, data: { type: "send", text } });
  await tick();
  assert.equal(deps.turns.length >= 1, true);
  const list = deps.store.list();
  assert.equal(list.length, 1);
  return list[0].id;
}

// ---- 端点凭据生命周期（§4.8）----

test("permission: 每轮 spawn 前取端点凭据（按会话 id）；进程退出即撤销 token", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  assert.deepEqual(deps.mcpCalls, [{ sessionId }]);
  // spawn 参数里带上该轮的 mcp-config（token 在 URL 上）
  const args = deps.turns[0].options.args.join(" ");
  assert.ok(args.includes(`http://127.0.0.1:51234/mcp?token=${MCP_TOKEN}`));
  assert.ok(
    args.includes(
      "--permission-prompt-tool mcp__claudian-perm__permission_check",
    ),
  );
  // 进程未退 → token 不撤
  assert.deepEqual(deps.closedTokens, []);
  deps.turns[0].release();
  await tick();
  assert.deepEqual(deps.closedTokens, [MCP_TOKEN]);
});

test("permission: 端点故障（起监听失败）→ SPAWN_FAILED 且不 spawn", async () => {
  const deps = makeDeps();
  deps.setEndpointError(new Error("bind failed: address in use"));
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "你好" } });
  await tick();
  const err = deps.sent.filter((s) => s.msg.type === "error").pop()?.msg as
    | { code: string; message: string }
    | undefined;
  assert.ok(err);
  assert.equal(err.code, "SPAWN_FAILED");
  assert.ok(err.message.includes("address in use"));
  assert.equal(deps.turns.length, 0);
  assert.deepEqual(deps.closedTokens, []);
});

// ---- 卡广播（§4.6 宿主→UI 表：字段逐字对齐）----

test("permission: requestPermission → permissionRequest 四字段原样广播（不多不少）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  bridge.requestPermission({
    requestId: "req-1",
    sessionId: "sess-x",
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
    toolUseId: "call_1",
  });
  const cards = deps.sent.filter((s) => s.msg.type === "permissionRequest");
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].msg, {
    type: "permissionRequest",
    requestId: "req-1",
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
  });
});

// ---- allow + remember → 规则串 → 下一轮 --allowedTools ----

test("permission: allow+remember → allowedTools 追加 Bash(python *) → 下一轮 spawn 携带", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(
    deps,
    bridge,
    win,
    "帮我看看 python 版本",
  );
  deps.pending.set("req-2", {
    sessionId,
    tool: "Bash",
    input: { command: "python -V" },
  });
  deps.turns[0].release();
  await tick();

  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-2",
      allow: true,
      remember: true,
    },
  });
  await tick();
  assert.deepEqual(deps.resolves, [{ requestId: "req-2", allow: true }]);
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, ["Bash(python *)"]);
  assert.ok(
    deps.logs.some((l) => l.includes("remember: appended rule Bash(python *)")),
  );

  // 下一轮：--allowedTools 逐条传参（buildSpawnArgs 契约）
  bridge.dispatch({ source: win, data: { type: "send", text: "再来一次" } });
  await tick();
  const args = deps.turns[1].options.args;
  const i = args.indexOf("--allowedTools");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "Bash(python *)");
});

test("permission: 允许但不记住 → 不追加规则串（下一轮无 --allowedTools）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  deps.pending.set("req-3", {
    sessionId,
    tool: "Bash",
    input: { command: "ls" },
  });
  deps.turns[0].release();
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-3",
      allow: true,
      remember: false,
    },
  });
  await tick();
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, []);
  bridge.dispatch({ source: win, data: { type: "send", text: "再来" } });
  await tick();
  assert.equal(deps.turns[1].options.args.includes("--allowedTools"), false);
});

test("permission: 拒绝（即使 remember=true）→ 不追加规则串（§4.6 算法只在 allow 时生成）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  deps.pending.set("req-4", {
    sessionId,
    tool: "Bash",
    input: { command: "rm -rf /" },
  });
  deps.turns[0].release();
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-4",
      allow: false,
      remember: true,
    },
  });
  await tick();
  assert.deepEqual(deps.resolves, [{ requestId: "req-4", allow: false }]);
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, []);
});

test("permission: acceptEdits 档下 Edit 记住 → 规则串为 null，不追加（已默认放行）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  deps.pending.set("req-5", {
    sessionId,
    tool: "Edit",
    input: { file_path: "/w/a.md", old_string: "a", new_string: "b" },
  });
  deps.turns[0].release();
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-5",
      allow: true,
      remember: true,
    },
  });
  await tick();
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, []);
  assert.ok(deps.logs.some((l) => l.includes("no rule for Edit")));
});

test("permission: 同一规则串重复记住 → 幂等去重（allowedTools 不重复追加）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  for (const id of ["req-6", "req-7"]) {
    deps.pending.set(id, {
      sessionId,
      tool: "Bash",
      input: { command: "git status" },
    });
    bridge.dispatch({
      source: win,
      data: {
        type: "permissionResponse",
        requestId: id,
        allow: true,
        remember: true,
      },
    });
    await tick();
  }
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, ["Bash(git *)"]);
});

// ---- 非法输入（§4.6）----

test("permission: 未知/过期 requestId → 忽略 + log，不影响其它流转", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "gone",
      allow: true,
      remember: true,
    },
  });
  await tick();
  assert.ok(deps.logs.some((l) => l.includes("unknown/expired requestId")));
  assert.equal(
    deps.sent.some((s) => s.msg.type === "error"),
    false,
  );
});

test("permission: 缺 requestId / 非布尔 allow → 按最保守解释处理（不崩、不放行）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  handshake(deps, bridge, win);
  await tick();
  const sessionId = await sendAndSpawn(deps, bridge, win);
  deps.pending.set("req-8", {
    sessionId,
    tool: "Bash",
    input: { command: "ls" },
  });
  // 缺 requestId：直接忽略（不调用端点）
  bridge.dispatch({
    source: win,
    data: { type: "permissionResponse", allow: true },
  });
  await tick();
  assert.deepEqual(deps.resolves, []);
  // allow 非布尔：按 false 解释（deny 侧安全）
  bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-8",
      allow: "yes",
      remember: true,
    },
  });
  await tick();
  assert.deepEqual(deps.resolves, [{ requestId: "req-8", allow: false }]);
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, []);
});

test("permission: 未注册实例发的 permissionResponse → 丢弃（§4.6 只接受已注册来源）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  const stranger = makeWin();
  handshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: stranger,
    data: {
      type: "permissionResponse",
      requestId: "req-9",
      allow: true,
      remember: false,
    },
  });
  await tick();
  assert.deepEqual(deps.resolves, []);
});

// ---- M6 全链路（真端点核心 + 真桥 + 真 UI 归约；只有 Gecko socket 与 CLI 进程是假的）----
// 链路：用户发送 → spawn（含端点 URL）→ CLI 侧 tools/call 打到端点 → 桥广播卡 → UI 点「允许并记住」
//       → 桥回写端点 → HTTP 回包 {behavior:"allow",updatedInput} → 规则串落会话 → 下一轮携带。

test("permission 全链路：tools/call → 卡 → 允许并记住 → allow 回包 + 规则串落库", async () => {
  /** run 起来之后接桥的 present 出口（sections.ts 同构：先建 core，桥晚于 core 存在） */
  let bridge: ReturnType<typeof createHostBridge> | null = null;
  const core = createPermissionCore({
    log: () => {},
    present: (req) => bridge?.requestPermission(req),
  });
  const deps = makeDeps({
    getMcpEndpoint: (sessionId: string) => core.openTurn(sessionId, 51999),
    closeMcpTurn: (token: string) => core.closeTurn(token),
    resolvePermission: (requestId: string, allow: boolean) =>
      core.resolve(requestId, allow),
  });
  const realPost = deps.post;
  const ui = { state: initialChatState() };
  // UI 侧：宿主推来的每条消息走真归约（等价 main.ts）
  deps.post = (win, msg) => {
    realPost(win, msg);
    ui.state = reduceHostMessage(ui.state, msg);
  };
  const bridgeInstance = createHostBridge(deps);
  bridge = bridgeInstance;
  const win = makeWin();
  handshake(deps, bridgeInstance, win);
  await tick();
  assert.equal(ui.state.connected, true);

  // 1) 用户发送（UI 动作 → 桥）
  const send = userSend(ui.state, "帮我看看 python 版本");
  ui.state = send.state;
  bridgeInstance.dispatch({ source: win as never, data: send.msg });
  await tick();
  assert.equal(deps.turns.length, 1);

  // 2) 从 spawn 参数里取端点 URL 的 token（顺带验证 buildSpawnArgs ↔ 端点的 URL 形态一致）
  const args = deps.turns[0].options.args;
  const mcpJson = args[args.indexOf("--mcp-config") + 1];
  const url = JSON.parse(mcpJson).mcpServers["claudian-perm"].url as string;
  assert.ok(url.startsWith("http://127.0.0.1:51999/mcp?token="));
  const token = url.slice(url.indexOf("token=") + "token=".length);

  // 3) CLI 侧 tools/call 打到端点（真核心处理；挂起等用户）
  const req: ParsedHttpRequest = {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "permission_check",
        arguments: {
          tool_name: "Bash",
          input: { command: "python -V" },
          tool_use_id: "call_1",
        },
      },
    }),
  };
  const call = core.handle(req);
  await tick();

  // 4) UI 上出现卡（工具名 + 摘要）
  assert.equal(ui.state.pendingPermissions.length, 1);
  const card = ui.state.pendingPermissions[0];
  assert.equal(card.tool, "Bash");
  assert.equal(card.inputSummary, "python -V");
  assert.deepEqual(card.rawInput, { command: "python -V" });

  // 5) 用户点「允许并记住」→ 桥 → 端点
  const respond = permissionRespond(ui.state, card.requestId, true, true);
  ui.state = respond.state;
  assert.deepEqual(ui.state.pendingPermissions, []); // 卡即时摘掉（乐观）
  bridgeInstance.dispatch({ source: win as never, data: respond.msg });
  await tick();

  // 6) HTTP 回包：allow + updatedInput = 原 input（§4.8 实测定型形态）
  const res = await call;
  assert.equal(res.status, 200);
  const text = JSON.parse(res.body).result.content[0].text;
  assert.deepEqual(JSON.parse(text), {
    behavior: "allow",
    updatedInput: { command: "python -V" },
  });

  // 7) 规则串落会话 → 下一轮 spawn 携带
  const sessionId = deps.store.list()[0].id;
  assert.deepEqual(deps.store.get(sessionId)?.allowedTools, ["Bash(python *)"]);
  // 该轮收尾（result → UI 解锁；进程退出 → 桥解锁 + 撤 token）
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "cli-session-1",
    costUsd: 0.01,
    durationMs: 1200,
    numTurns: 1,
  });
  deps.turns[0].release();
  await tick();
  assert.equal(ui.state.turnStatus, "idle");
  const next = userSend(ui.state, "再来");
  ui.state = next.state;
  bridgeInstance.dispatch({ source: win as never, data: next.msg });
  await tick();
  const nextArgs = deps.turns[1].options.args;
  assert.equal(
    nextArgs[nextArgs.indexOf("--allowedTools") + 1],
    "Bash(python *)",
  );
});

test("permission 全链路：拒绝 → deny 回包带 message；该轮退出撤销 token 后旧 token 403", async () => {
  let bridge: ReturnType<typeof createHostBridge> | null = null;
  const core = createPermissionCore({
    log: () => {},
    present: (req) => bridge?.requestPermission(req),
  });
  const deps = makeDeps({
    getMcpEndpoint: (sessionId: string) => core.openTurn(sessionId, 51999),
    closeMcpTurn: (token: string) => core.closeTurn(token),
    resolvePermission: (requestId: string, allow: boolean) =>
      core.resolve(requestId, allow),
  });
  const realPost = deps.post;
  const ui = { state: initialChatState() };
  deps.post = (win, msg) => {
    realPost(win, msg);
    ui.state = reduceHostMessage(ui.state, msg);
  };
  const bridgeInstance = createHostBridge(deps);
  bridge = bridgeInstance;
  const win = makeWin();
  handshake(deps, bridgeInstance, win);
  await tick();
  const send = userSend(ui.state, "危险操作试试");
  ui.state = send.state;
  bridgeInstance.dispatch({ source: win as never, data: send.msg });
  await tick();
  const args = deps.turns[0].options.args;
  const mcpJson = args[args.indexOf("--mcp-config") + 1];
  const url = JSON.parse(mcpJson).mcpServers["claudian-perm"].url as string;
  const token = url.slice(url.indexOf("token=") + "token=".length);

  const base: ParsedHttpRequest = {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: {},
    body: "",
  };
  const call = core.handle({
    ...base,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "permission_check",
        arguments: {
          tool_name: "Bash",
          input: { command: "rm -rf /tmp/x" },
          tool_use_id: "call_2",
        },
      },
    }),
  });
  await tick();
  const card = ui.state.pendingPermissions[0];
  const respond = permissionRespond(ui.state, card.requestId, false, false);
  ui.state = respond.state;
  bridgeInstance.dispatch({ source: win as never, data: respond.msg });
  const res = await call;
  assert.deepEqual(JSON.parse(JSON.parse(res.body).result.content[0].text), {
    behavior: "deny",
    message: "User denied this action on the permission card.",
  });

  // 该轮进程退出 → token 撤销 → 旧 token 的后续请求 403
  deps.turns[0].release();
  await tick();
  const later = await core.handle({
    ...base,
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(later.status, 403);
});
