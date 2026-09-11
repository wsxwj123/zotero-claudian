// 单测 — hostBridge 会话逻辑（会话 CRUD / resume / SESSION_GONE / getHistory / 并发守卫）。
// C6 CRUD 畸形入参 / 删除在跑 turn；C7 resume 与 SESSION_GONE；C8 getHistory 与并发守卫；
// BUG-24/25/27 回归锁（由 test-m5 的 m5-probe 探针转正，修复后全绿，红灯即回归）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProcError } from "../../src/modules/cliRunner.ts";
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
import { INDEX, makeProbeStore } from "./helpers/probeFs.ts";

const TOKEN = "tok-m5";

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 可控 fake turn：记录 kill、可手动放事件、可手动放行退出 */
function makeTurn() {
  let releaseExit: () => void = () => {};
  const turn = {
    killed: false,
    emitted: [] as TurnEvent[],
    options: null as SpawnTurnOptions | null,
    emit: (ev: TurnEvent) => turn.options?.onEvent(ev),
    kill() {
      turn.killed = true;
      // 真机语义：SIGTERM → 进程退出（无 result）→ procError 由 cliRunner 发
    },
    exitPromise: new Promise<void>((r) => {
      releaseExit = () => r();
    }),
    releaseExit: () => releaseExit(),
  };
  return turn;
}

function makeDeps(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeProbeStore();
  const turns: ReturnType<typeof makeTurn>[] = [];
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    store: typeof memory.store;
    fs: typeof memory.fs;
    logs: string[];
    turns: ReturnType<typeof makeTurn>[];
  } = {
    sent,
    store: memory.store,
    fs: memory.fs,
    logs: memory.logs,
    turns,
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: (m) => memory.logs.push(m),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: `ctx\n${text}`,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 51000, token: "t" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: SpawnTurnOptions): TurnHandle => {
      const t = makeTurn();
      t.options = options;
      turns.push(t);
      return { kill: () => t.kill(), exitPromise: t.exitPromise };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "论文一" } : null,
    ...overrides,
  };
  return deps;
}

function register(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
}

function msgs(
  deps: ReturnType<typeof makeDeps>,
  type: HostMessage["type"],
): HostMessage[] {
  return deps.sent.filter((s) => s.msg.type === type).map((s) => s.msg);
}

/** 发一轮并等到底层 spawn 完成 */
async function sendTurn(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text: string,
  sessionId?: string | null,
): Promise<string> {
  bridge.dispatch({
    source: win,
    data: { type: "send", text, sessionId: sessionId ?? undefined },
  });
  await tick();
  return deps.store.list()[0]?.id ?? "";
}

// ---------- C6 CRUD 与删除在跑 turn ----------

test("C6-1: 删除在跑 turn 的会话 → 先 kill 后删索引，列表广播不含该 id", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "你好");
  assert.equal(deps.turns.length, 1);
  const turn = deps.turns[0];

  bridge.dispatch({
    source: win,
    data: { type: "deleteSession", sessionId: id },
  });
  await tick();

  assert.equal(turn.killed, true, "删除在跑会话未 kill 进程（无主进程）");
  assert.equal(deps.store.get(id), null);
  const list = msgs(deps, "sessionList").pop();
  assert.ok(list && list.type === "sessionList");
  assert.deepEqual(
    list.sessions.map((s) => s.id),
    [],
    "删除后广播的 sessionList 仍含已删会话",
  );
});

test("C6-2: 删除后被 kill 的 turn 迟到 result/procError → 不复活索引与历史（反向用例）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "你好");
  const turn = deps.turns[0];

  bridge.dispatch({
    source: win,
    data: { type: "deleteSession", sessionId: id },
  });
  await tick();

  // 进程退出后的迟到事件（真机顺序：kill → procError；也可能先 result 再退出）
  turn.emit({
    kind: "procError",
    exitCode: null,
    stderrTail: "killed",
    reason: "SIGTERM",
  });
  await tick();
  assert.equal(deps.store.get(id), null, "已删会话被迟到 procError 复活");
  assert.equal(
    [...deps.fs.files.keys()].some((p) => p.includes(id)),
    false,
    "已删会话的旁挂历史被迟到事件重建（无主文件残留）",
  );
});

test("C6-3: 删除未知 id → 忽略：无 sessionList 广播、无异常", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const before = msgs(deps, "sessionList").length;
  bridge.dispatch({
    source: win,
    data: { type: "deleteSession", sessionId: "no-such" },
  });
  await tick();
  assert.equal(msgs(deps, "sessionList").length, before);
});

test("C6-4: deleteSession 畸形入参（缺字段/非字符串/数字/null）→ 一律忽略不崩", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "你好");
  for (const bad of [undefined, 42, null, {}, [], ""]) {
    bridge.dispatch({
      source: win,
      data: { type: "deleteSession", sessionId: bad },
    });
  }
  await tick();
  assert.ok(deps.store.get(id), "畸形 sessionId 误删了会话");
});

test("C6-5: createSession 未知 itemKey → ITEM_NOT_FOUND 且不留索引记录", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "createSession", itemKey: "GHOST" },
  });
  await tick();
  const err = msgs(deps, "error").pop();
  assert.ok(err && err.type === "error");
  assert.equal(err.code, "ITEM_NOT_FOUND");
  assert.deepEqual(deps.store.list(), []);
});

test("C6-6: createSession 非字符串 itemKey（数字/空串）→ 建通用会话（itemKey=null）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "createSession", itemKey: 7 } });
  await tick();
  const rec = deps.store.list()[0];
  assert.ok(rec);
  assert.equal(rec?.itemKey, null);
  assert.equal(rec?.itemLibraryID, null);
});

test("BUG-24: createSession 落盘失败 → 宿主必须回错误或列表（防 UI 卡「新建中…」）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const before = deps.sent.length;
  deps.fs.failWhen = (op, path) => op === "write" && path === `${INDEX}.tmp`;
  bridge.dispatch({ source: win, data: { type: "createSession" } });
  await tick();
  const after = deps.sent.slice(before);
  assert.ok(
    after.some((s) => s.msg.type === "error" || s.msg.type === "sessionList"),
    `createSession 失败后宿主一条消息都没回（UI 按钮永久停在「新建中…」）：${JSON.stringify(
      deps.logs.slice(-2),
    )}`,
  );
});

test("C6-8: setPermissionMode 合法档 → 落索引且下轮 spawn 用新档；非法档/未知会话 → 不改", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "你好");
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();

  for (const bad of ["yolo", "", null, 3, "DEFAULT", ["plan"]]) {
    bridge.dispatch({
      source: win,
      data: { type: "setPermissionMode", sessionId: id, mode: bad },
    });
  }
  bridge.dispatch({
    source: win,
    data: { type: "setPermissionMode", sessionId: "no-such", mode: "plan" },
  });
  await tick();
  assert.equal(deps.store.get(id)?.permissionMode, "acceptEdits");

  bridge.dispatch({
    source: win,
    data: { type: "setPermissionMode", sessionId: id, mode: "plan" },
  });
  await tick();
  assert.equal(deps.store.get(id)?.permissionMode, "plan");
  // 下轮 spawn 带新档
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "第二轮", sessionId: id },
  });
  await tick();
  const args = deps.turns[1].options?.args ?? [];
  const i = args.indexOf("--permission-mode");
  assert.equal(i >= 0 ? args[i + 1] : null, "plan");
});

// ---------- C7 resume / SESSION_GONE ----------

test("C7-1: claudeSessionId 为 null → 不带 --resume；有值 → --resume <id> 原样透传", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "首轮");
  assert.equal(
    (deps.turns[0].options?.args ?? []).includes("--resume"),
    false,
    "首轮无 claudeSessionId 却带了 --resume",
  );
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "cli-abc",
    costUsd: 0.01,
    durationMs: 5,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();
  assert.equal(deps.store.get(id)?.claudeSessionId, "cli-abc");

  bridge.dispatch({
    source: win,
    data: { type: "send", text: "续接", sessionId: id },
  });
  await tick();
  const args = deps.turns[1].options?.args ?? [];
  const i = args.indexOf("--resume");
  assert.equal(i >= 0 ? args[i + 1] : null, "cli-abc");
});

test("C7-2: resume 失效 procError（stderr 含 No conversation found）→ SESSION_GONE error 且带 sessionId", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "首轮");
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "dead-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();
  deps.sent.length = 0;

  bridge.dispatch({
    source: win,
    data: { type: "send", text: "续接", sessionId: id },
  });
  await tick();
  deps.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "Error: No conversation found with session ID dead-1",
  });
  deps.turns[1].releaseExit();
  await tick();

  const err = msgs(deps, "error").pop();
  assert.ok(err && err.type === "error", "procError 未回 SESSION_GONE error");
  assert.equal(err.code, "SESSION_GONE");
  assert.equal(err.sessionId, id);
});

test("BUG-25: SESSION_GONE 后同会话再发不得复用死 claudeSessionId", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "首轮");
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "dead-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "续接", sessionId: id },
  });
  await tick();
  deps.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "No conversation found",
  });
  deps.turns[1].releaseExit();
  await tick();

  // 用户在同一个会话里再发一次（UI 只给了「新建会话」出口，没有「就地重开」）
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "再试一次", sessionId: id },
  });
  await tick();
  const args = deps.turns[2].options?.args ?? [];
  const i = args.indexOf("--resume");
  assert.equal(
    i >= 0 ? args[i + 1] : null,
    null,
    "SESSION_GONE 后仍 --resume 死 id（该会话永久卡在同一个错误，除非用户手动新建）",
  );
});

test("BUG-27: classifyProcError 必须认得生产侧产出的 reason='CLAUDE_NOT_FOUND'", () => {
  // spawnTurn 实际发的是 reason:"CLAUDE_NOT_FOUND"（cliRunner L285），classifyProcError 判的是 "ENOENT"
  assert.equal(
    classifyProcError({
      exitCode: null,
      stderrTail: "",
      reason: "CLAUDE_NOT_FOUND",
    }),
    "CLAUDE_NOT_FOUND",
    "生产侧 reason 与 classifyProcError 期望值不一致（该分支恒不命中）",
  );
  // 反向：退出码 0 不判 SESSION_GONE（BUG-04 口径保持）
  assert.equal(
    classifyProcError({ exitCode: 0, stderrTail: "No conversation found" }),
    "GENERIC",
  );
});

// ---------- C8 getHistory 与并发守卫 ----------

test("C8-1: getHistory 空会话 → 空数组；缺 sessionId 字段 → sessionId 回空串", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "你好");
  deps.sent.length = 0;
  bridge.dispatch({ source: win, data: { type: "getHistory", sessionId: id } });
  await tick();
  const h = msgs(deps, "history").pop();
  assert.ok(h && h.type === "history");
  assert.deepEqual(h.messages, []);

  bridge.dispatch({ source: win, data: { type: "getHistory" } });
  await tick();
  const h2 = msgs(deps, "history").pop();
  assert.ok(h2 && h2.type === "history");
  assert.equal(h2.sessionId, "");
  assert.deepEqual(h2.messages, []);
});

test("C8-2: 并发 turn 中拉历史 → 回已完成轮次、不干扰在跑 turn；结束后回放含本轮", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "第一问");
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "c1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();

  // 第二轮在跑，中途拉历史
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "第二问", sessionId: id },
  });
  await tick();
  deps.sent.length = 0;
  bridge.dispatch({ source: win, data: { type: "getHistory", sessionId: id } });
  await tick();
  const mid = msgs(deps, "history").pop();
  assert.ok(mid && mid.type === "history");
  assert.equal(
    mid.messages.length,
    1,
    "在跑轮次被提前写进历史（流式中不该落盘）",
  );
  assert.equal(deps.turns[1].options !== null, true, "拉历史干扰了在跑 turn");

  deps.turns[1].emit({ kind: "textDelta", index: 0, text: "第二答" });
  deps.turns[1].emit({
    kind: "result",
    claudeSessionId: "c1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[1].releaseExit();
  await tick();
  deps.sent.length = 0;
  bridge.dispatch({ source: win, data: { type: "getHistory", sessionId: id } });
  await tick();
  const after = msgs(deps, "history").pop();
  assert.ok(after && after.type === "history");
  assert.deepEqual(
    after.messages.map((m) => m.text),
    ["第一问", "第二问", "第二答"],
  );
});

test("C8-3: 同会话两路并发 send → 只 spawn 一次，另一路收 SESSION_BUSY（不排队）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "第一问");
  assert.equal(deps.turns.length, 1);

  bridge.dispatch({
    source: win,
    data: { type: "send", text: "抢跑A", sessionId: id },
  });
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "抢跑B", sessionId: id },
  });
  await tick();
  const busy = msgs(deps, "error").filter(
    (m) => m.type === "error" && m.code === "SESSION_BUSY",
  );
  assert.equal(
    deps.turns.length,
    1,
    `并发 send 起了多个进程（${deps.turns.length}）`,
  );
  assert.equal(busy.length, 2, "两路抢跑都未收到 SESSION_BUSY");
});

test("C8-4: 收到 result（进程未退）→ send 仍被拒；进程退出后才解锁（记录-06 的宿主侧半边）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "第一问");
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "c1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "抢在退出前", sessionId: id },
  });
  await tick();
  const busy = msgs(deps, "error").pop();
  assert.ok(busy && busy.type === "error" && busy.code === "SESSION_BUSY");

  deps.turns[0].releaseExit();
  await tick();
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "退出后重发", sessionId: id },
  });
  await tick();
  assert.equal(deps.turns.length, 2, "进程退出后仍未解锁 send");
});

test("C8-5: finishTurn 落盘抛错 → 不掀翻桥：UI 仍收到 sessionList、turn 正常解锁", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  const id = await sendTurn(deps, bridge, win, "第一问");
  deps.sent.length = 0;
  deps.fs.failWhen = (op) => op === "write";
  deps.turns[0].emit({ kind: "textDelta", index: 0, text: "答" });
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "c1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  deps.turns[0].releaseExit();
  await tick();
  assert.ok(
    msgs(deps, "sessionList").length > 0,
    "落盘失败后未推 sessionList（UI 列表停旧数据）",
  );
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "第二轮", sessionId: id },
  });
  await tick();
  assert.equal(deps.turns.length, 2);
});
