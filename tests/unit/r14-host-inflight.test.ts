// 单测 — R14 宿主桥层 + 两实例联动：开轮广播（带 inFlight）、getHistory 的在途信息、负向锁
//
// 契约来源：.devflow/PLAN-R14.md §2.2（宿主桥层复现）/ §4.1（history 消息新增可选 inFlight；
// 新增下发时机：handleSend 接受一轮时广播同形的一条）；用例清单来源：§7 的 T6c/T11b/T12/T12b-e。
// 全部走 tests/unit/hostBridge*.test.ts 既有的 fake 链路（makeProbeStore + fake spawnTurn），
// 不测任何夹具副本；UI 侧断言一律把**桥真实广播出来的消息**喂给 reducer（不手搓 history 消息）。
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
import {
  fireRetry,
  initialChatState,
  reduceHostMessage,
  selectSession,
  userSend,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import {
  buildRenderItems,
  stripSummary,
} from "../../src/chat/lib/roundStrip.ts";
import { makeProbeStore } from "./helpers/probeFs.ts";

const TOKEN = "tok-r14";

async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 可控 fake turn：记录 kill、可手动放事件、可手动放行退出 */
function makeTurn() {
  let releaseExit: () => void = () => {};
  const turn = {
    killed: false,
    options: null as SpawnTurnOptions | null,
    emit: (ev: TurnEvent) => turn.options?.onEvent(ev),
    kill() {
      turn.killed = true;
    },
    exitPromise: new Promise<void>((r) => {
      releaseExit = () => r();
    }),
    releaseExit: () => releaseExit(),
  };
  return turn;
}

function makeDeps() {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeProbeStore();
  const turns: ReturnType<typeof makeTurn>[] = [];
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    store: typeof memory.store;
    fs: typeof memory.fs;
    turns: ReturnType<typeof makeTurn>[];
  } = {
    sent,
    store: memory.store,
    fs: memory.fs,
    turns,
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: () => {},
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
    lookupItem: async () => ({ libraryID: 1, title: "论文一" }),
  };
  return deps;
}

type Deps = ReturnType<typeof makeDeps>;

function register(
  deps: Deps,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
}

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

/** 该窗口收到的某类消息（按到达顺序） */
function sentTo(
  deps: Deps,
  win: object,
  type?: HostMessage["type"],
): HostMessage[] {
  return deps.sent
    .filter((s) => s.win === win && (type === undefined || s.msg.type === type))
    .map((s) => s.msg);
}

const countTurns = (s: ChatState, text: string): number =>
  s.messages.filter((t) => t.text === text).length;

const stripsOf = (s: ChatState) =>
  buildRenderItems(s.messages).filter(
    (i) => i.kind === "strip" && stripSummary(i.round!) !== null,
  );

/** 一轮「有过程块」的完整流（留 1 个思考 + 1 个工具，供条带断言） */
const TURN_EVENTS: TurnEvent[] = [
  { kind: "init", model: "opus", permissionMode: "default" } as TurnEvent,
  { kind: "messageStart" } as TurnEvent,
  {
    kind: "thinkingDelta",
    index: 0,
    text: "先看看这篇文章讲了什么",
  } as TurnEvent,
  {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "tu1",
  } as TurnEvent,
  {
    kind: "toolInputDelta",
    index: 1,
    jsonFragment: '{"file":"a.pdf"}',
  } as TurnEvent,
  { kind: "textBlockStart", index: 2 } as TurnEvent,
  { kind: "textDelta", index: 2, text: "这篇文章的核心是" } as TurnEvent,
] as TurnEvent[];

const RESULT = {
  kind: "result",
  claudeSessionId: "cli-1",
  numTurns: 1,
  costUsd: 0.01,
  durationMs: 3000,
  isError: false,
} as TurnEvent;

/** UI 侧视图：握手 → 会话列表 → 绑定到该会话（后续消息由调用方喂进去） */
function bootUi(deps: Deps, sid: string): ChatState {
  let s = apply(initialChatState(), { type: "init" });
  s = apply(s, {
    type: "sessionList",
    sessions: deps.store.list(),
  } as unknown as HostMessage);
  if (s.sessionId !== sid) {
    s = selectSession(s, sid).state;
  }
  return s;
}

/** inFlight 字段的读取（R14 §4.1；修前不存在 → 断言会因「字段不存在」失败） */
const inFlightOf = (msg: HostMessage): Record<string, unknown> | undefined =>
  (msg as unknown as { inFlight?: Record<string, unknown> }).inFlight;

// ---------- T12：宿主开轮广播（重要-1 主场景） ----------

test("T12 🔴 宿主在开轮时广播带 inFlight 的 history：另一个实例直接看到在途轮", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = {};
  const winB = {};
  register(deps, bridge, winA);
  register(deps, bridge, winB);
  await tick();

  bridge.dispatch({ source: winA, data: { type: "send", text: "X" } });
  await tick();
  const sid = deps.store.list()[0].id;

  const histA = sentTo(deps, winA, "history");
  const histB = sentTo(deps, winB, "history");
  assert.equal(
    histA.length,
    1,
    "对 send 恰广播 1 条 history（发送方自己那份）",
  );
  assert.equal(
    histB.length,
    1,
    "对 send 恰广播 1 条 history（另一个实例那份）",
  );

  const open = histB[0];
  assert.equal((open as { sessionId?: unknown }).sessionId, sid);
  assert.deepEqual(
    (open as { messages?: unknown }).messages,
    [],
    "广播的 messages = 当前落盘行（这一轮还没落盘）",
  );
  const inFlight = inFlightOf(open);
  assert.ok(
    inFlight,
    "开轮广播必须带 inFlight（修前这条 history 消息整条都不存在）",
  );
  assert.equal(inFlight.userText, "X");
  assert.equal(inFlight.busy, "running");
  assert.equal(inFlight.baseRows, 0, "baseRows = 开轮时的落盘行数");

  // 实例 2 应用这条广播 → 直接看到在途轮
  let s2 = apply(bootUi(deps, sid), open);
  assert.equal(countTurns(s2, "X"), 1, "实例 2 应看到对方那条提问");
  assert.equal(s2.turnStatus, "streaming", "实例 2 的输入框据此禁用");

  // 后续流事件照常落进实例 2 的视图
  const turn = deps.turns[0];
  for (const ev of TURN_EVENTS) {
    turn.emit(ev);
  }
  turn.emit(RESULT);
  await tick();
  for (const m of sentTo(deps, winB, "streamEvent")) {
    s2 = apply(s2, m);
  }
  assert.equal(s2.turnStatus, "idle", "对方那轮收尾后解锁");
  assert.equal(stripsOf(s2).length, 1, "条带恰 1 条");
  assert.equal(countTurns(s2, "X"), 1, "「X」只出现一次");
});

// ---------- T12b：致命-1 负向锁（待重发消息不得消失） ----------

test("T12b 🔒 开轮广播不得吞掉实例 2 待重发的那条消息", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = {};
  const winB = {};
  register(deps, bridge, winA);
  register(deps, bridge, winB);
  await tick();

  // 实例 1 开轮（宿主 busy）
  bridge.dispatch({ source: winA, data: { type: "send", text: "X" } });
  await tick();
  const sid = deps.store.list()[0].id;
  const openBroadcast = sentTo(deps, winB, "history"); // 修前 = []（宿主还不发这条）

  // 实例 2：本地发 Y → 被宿主 SESSION_BUSY 拒 → 进入自动重发
  let s2 = bootUi(deps, sid);
  const out = userSend(s2, "Y");
  s2 = out.state;
  assert.equal(out.msg?.type, "send");
  bridge.dispatch({ source: winB, data: out.msg });
  await tick();
  const errs = sentTo(deps, winB, "error");
  assert.equal(errs.length, 1, "该会话有在跑的轮 → 宿主回一条 SESSION_BUSY");
  assert.equal((errs[0] as { code?: unknown }).code, "SESSION_BUSY");
  s2 = apply(s2, errs[0]);
  assert.notEqual(s2.pendingRetry, null, "夹具自检：进入自动重发");
  assert.equal(s2.turnStatus, "idle");
  assert.equal(countTurns(s2, "Y"), 1);

  // 「收到开轮广播」（修前这一步是空操作——那条广播压根不存在）
  for (const m of openBroadcast) {
    s2 = apply(s2, m);
  }
  assert.equal(countTurns(s2, "Y"), 1, "广播应用后待重发的消息必须还在");
  assert.notEqual(s2.pendingRetry, null, "待重发状态不得被广播清掉");

  // 实例 1 那轮的流事件全部到达
  const turn = deps.turns[0];
  for (const ev of TURN_EVENTS) {
    turn.emit(ev);
  }
  turn.emit(RESULT);
  await tick();
  for (const m of sentTo(deps, winB, "streamEvent")) {
    s2 = apply(s2, m);
  }

  assert.equal(countTurns(s2, "Y"), 1, "最后「Y」仍在视图里");
  assert.notEqual(s2.pendingRetry, null, "「Y」仍在等自动重发");
  assert.equal(
    fireRetry(s2).msg?.text,
    "Y",
    "对方那轮结束（idle）后，重发必须发得出去",
  );
});

// ---------- T12c：重要-2 负向锁（条带不得从 1 变 0） ----------

test("T12c 🔒 刚跑完一轮的实例收到别人的开轮广播：本地条带不能被抹掉", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = {};
  const winB = {};
  register(deps, bridge, winA);
  register(deps, bridge, winB);
  await tick();

  // 实例 2 自己跑完一轮
  bridge.dispatch({
    source: winB,
    data: { type: "createSession", itemKey: null },
  });
  await tick();
  const sid = deps.store.list()[0].id;
  let s2 = bootUi(deps, sid);
  const out = userSend(s2, "Y");
  s2 = out.state;
  bridge.dispatch({ source: winB, data: out.msg });
  await tick();
  for (const m of sentTo(deps, winB, "history")) {
    s2 = apply(s2, m); // 修前无这条
  }
  const mine = deps.turns[0];
  for (const ev of TURN_EVENTS) {
    mine.emit(ev);
  }
  mine.emit(RESULT);
  await tick();
  for (const m of sentTo(deps, winB, "streamEvent")) {
    s2 = apply(s2, m);
  }
  assert.equal(s2.turnStatus, "idle");
  assert.equal(stripsOf(s2).length, 1, "夹具自检：视图里有 1 条条带");
  const blocksOf = (s: ChatState) =>
    (s.messages.filter((t) => t.role === "assistant").at(-1)?.blocks ?? [])
      .filter((b) => b.blockType !== "text")
      .map((b) =>
        b.blockType === "tool"
          ? `tool:${b.toolName}@${b.index}`
          : `${b.blockType}@${b.index}`,
      );
  const blocksBefore = blocksOf(s2);

  // 进程退出 → 宿主解锁；随后实例 1 在**同一个会话**里开新轮
  mine.releaseExit();
  await tick();
  assert.equal(
    bridge.getRuntime(sid)?.busy,
    null,
    "夹具自检：上一轮进程已退，宿主解锁",
  );
  const mark = deps.sent.length;
  bridge.dispatch({
    source: winA,
    data: { type: "send", text: "X2", sessionId: sid },
  });
  await tick();

  for (const s of deps.sent.slice(mark)) {
    if (s.win === winB && s.msg.type === "history") {
      s2 = apply(s2, s.msg);
    }
  }
  assert.equal(stripsOf(s2).length, 1, "广播应用后条带仍为 1（不得从 1 变 0）");
  assert.deepEqual(blocksOf(s2), blocksBefore, "本地那轮的过程块一个不少");
});

// ---------- T12d：重要-2 负向锁（中断轮不得消失） ----------

test("T12d 🔒 被 procError 收场的轮（宿主从未落盘）收到开轮广播后仍在", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = {};
  const winB = {};
  register(deps, bridge, winA);
  register(deps, bridge, winB);
  await tick();

  bridge.dispatch({
    source: winB,
    data: { type: "createSession", itemKey: null },
  });
  await tick();
  const sid = deps.store.list()[0].id;
  let s2 = bootUi(deps, sid);
  const out = userSend(s2, "Z");
  s2 = out.state;
  bridge.dispatch({ source: winB, data: out.msg });
  await tick();
  for (const m of sentTo(deps, winB, "history")) {
    s2 = apply(s2, m);
  }
  const mine = deps.turns[0];
  mine.emit(TURN_EVENTS[0]);
  mine.emit(TURN_EVENTS[1]);
  mine.emit(TURN_EVENTS[2]);
  mine.emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "boom",
  } as TurnEvent);
  await tick();
  for (const m of sentTo(deps, winB, "streamEvent")) {
    s2 = apply(s2, m);
  }
  mine.releaseExit();
  await tick();
  assert.equal(countTurns(s2, "Z"), 1, "夹具自检：被中断的那条用户轮在视图里");
  assert.equal(s2.turnStatus, "idle");
  assert.equal(
    (await deps.store.readHistory(sid)).length,
    0,
    "夹具自检：宿主从未 appendTurn（这轮不在落盘历史里）",
  );

  const mark = deps.sent.length;
  bridge.dispatch({
    source: winA,
    data: { type: "send", text: "X2", sessionId: sid },
  });
  await tick();
  for (const s of deps.sent.slice(mark)) {
    if (s.win === winB && s.msg.type === "history") {
      s2 = apply(s2, s.msg);
    }
  }

  assert.equal(countTurns(s2, "Z"), 1, "被中断的那条用户轮仍在");
  const assistant = s2.messages.filter((t) => t.role === "assistant").at(-1);
  assert.ok(
    (assistant?.blocks ?? []).length > 0,
    "半截 assistant 轮（带过程块）也在",
  );
});

// ---------- T12e：发起实例自收广播不自伤 ----------

test("T12e 🔒 发送方自己收到开轮广播：不重复、不把 waiting 抬成 streaming", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = {};
  register(deps, bridge, winA);
  await tick();

  // 先建出会话（用户点「新建会话」），避免 send 的隐式建会话干扰绑定
  bridge.dispatch({
    source: winA,
    data: { type: "createSession", itemKey: null },
  });
  await tick();
  const sid = deps.store.list()[0].id;

  let s1 = bootUi(deps, sid);
  const out = userSend(s1, "X");
  s1 = out.state;
  assert.equal(out.msg?.type, "send");
  assert.equal(s1.turnStatus, "waiting", "夹具自检：本地刚发出，在等宿主");
  const waitingSince = s1.waitingSince;

  const mark = deps.sent.length;
  bridge.dispatch({ source: winA, data: out.msg });
  await tick();
  for (const s of deps.sent.slice(mark)) {
    if (s.win === winA && s.msg.type === "history") {
      s1 = apply(s1, s.msg);
    }
  }
  assert.equal(countTurns(s1, "X"), 1, "「X」恰 1 次（不得回放出一条重复的）");
  assert.equal(s1.turnStatus, "waiting", "不得被抬成 streaming");
  assert.equal(s1.waitingSince, waitingSince, "等待计时不中断");
});

// ---------- T11b：多消息工具轮的 inFlight.assistantText（重要-4） ----------

test("T11b 🔴 本轮有多条 assistant 消息时，inFlight.assistantText = 当前这段正文", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();

  bridge.dispatch({ source: win, data: { type: "send", text: "X" } });
  await tick();
  const sid = deps.store.list()[0].id;
  const turn = deps.turns[0];
  turn.emit({ kind: "messageStart" } as TurnEvent);
  turn.emit({
    kind: "textDelta",
    index: 0,
    text: "让我先读一下文件",
  } as TurnEvent);
  turn.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "让我先读一下文件" }],
  } as TurnEvent);
  turn.emit({
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "tu1",
  } as TurnEvent);
  turn.emit({
    kind: "toolInputDelta",
    index: 1,
    jsonFragment: '{"file":"a.pdf"}',
  } as TurnEvent);
  turn.emit({ kind: "messageStart" } as TurnEvent);
  turn.emit({
    kind: "textDelta",
    index: 0,
    text: "这篇文章的核心是",
  } as TurnEvent);
  await tick();

  const mark = deps.sent.length;
  bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: sid },
  });
  await tick();
  const hist = deps.sent
    .slice(mark)
    .filter((s) => s.win === win && s.msg.type === "history")
    .map((s) => s.msg);
  assert.equal(hist.length, 1, "getHistory 回一条 history");
  const inFlight = inFlightOf(hist[0]);
  assert.ok(inFlight, "这一轮正在跑 → history 必须带 inFlight");
  assert.equal(inFlight.userText, "X");
  assert.equal(inFlight.busy, "running");
  assert.equal(
    inFlight.assistantText,
    "这篇文章的核心是",
    "取的是当前这段正文（不是上一段、也不是两段拼接）",
  );
});

// ---------- T6c：宿主侧第一道闸（result 已到但进程未退） ----------

test("T6c 🔒 result 已到、进程未退：getHistory 不带 inFlight（闸门生效）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();

  bridge.dispatch({ source: win, data: { type: "send", text: "X" } });
  await tick();
  const sid = deps.store.list()[0].id;
  const turn = deps.turns[0];
  for (const ev of TURN_EVENTS) {
    turn.emit(ev);
  }
  turn.emit(RESULT);
  await tick();

  assert.equal(
    bridge.getRuntime(sid)?.busy,
    "running",
    "夹具自检：进程还没退（宿主仍然锁着该会话）",
  );
  const mark = deps.sent.length;
  bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: sid },
  });
  await tick();
  const hist = deps.sent
    .slice(mark)
    .filter((s) => s.win === win && s.msg.type === "history")
    .map((s) => s.msg);
  assert.equal(hist.length, 1);
  assert.equal(
    inFlightOf(hist[0]),
    undefined,
    "这一轮已经收尾（只是进程没退）→ 不得再报成在途轮",
  );
});
