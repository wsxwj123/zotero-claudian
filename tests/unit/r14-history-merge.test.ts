// 单测 — R14 页面 reducer 层：切会话/切文献后「在途轮」的恢复（history 合并 + inFlight 契约）
//
// 契约来源：.devflow/PLAN-R14.md §1（现象）/ §2.1（reducer 层复现）/ §4.1（契约变更：history 消息
// 新增可选 inFlight{userText,assistantText,busy,baseRows}）；用例清单来源：§7 用例表。
// 本文件逐字照 §7 写，不按自己的理解改口径；每条用例头注释给 T 编号 + 🔴/🔒。
//
// 防假绿：全部 state 一律由真实入口造（initialChatState → reduceHostMessage / userSend / selectSession /
// fireRetry），不手搓 messages/state 字面量；断言只用公开字段与公开纯函数（groupRounds/buildRenderItems）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fireRetry,
  initialChatState,
  interrupt,
  reduceHostMessage,
  selectSession,
  userSend,
  type ChatState,
  type Turn,
} from "../../src/chat/lib/chatModel.ts";
import { branchButtonState } from "../../src/chat/lib/branchActions.ts";
import {
  buildRenderItems,
  groupRounds,
  stripSummary,
} from "../../src/chat/lib/roundStrip.ts";
import { canEditTurn } from "../../src/chat/lib/messageActions.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

// ---------- 宿主侧数据（会话索引 / 落盘历史行） ----------

/** 同一篇文献下的两条会话（现象 1） */
const S1 = {
  id: "s1",
  title: "会话一",
  updatedAt: 200,
  createdAt: 100,
  itemKey: "ITEM_A",
  claudeSessionId: null,
};
const S2 = {
  id: "s2",
  title: "会话二",
  updatedAt: 100,
  createdAt: 100,
  itemKey: "ITEM_A",
  claudeSessionId: null,
};
/** 两篇文献各一条会话（现象 2） */
const SA = {
  id: "sA",
  title: "A 会话",
  updatedAt: 200,
  createdAt: 100,
  itemKey: "ITEM_A",
  claudeSessionId: null,
};
const SB = {
  id: "sB",
  title: "B 会话",
  updatedAt: 300,
  createdAt: 100,
  itemKey: "ITEM_B",
  claudeSessionId: null,
};

const SAME_ITEM = [S1, S2];
const TWO_ITEMS = [SA, SB];

/** 之前那一轮已落盘的两行（切回来时宿主只会回这个） */
const ROWS_QA = [
  { role: "user" as const, text: "旧问题", ts: 1 },
  { role: "assistant" as const, text: "旧回答", ts: 2 },
];

const QX = "问题X：这篇的创新点是什么？";

// ---------- 真实事件序列（唯一造 state 的方式） ----------

/** 宿主发来的 history 消息（R14 §4.1：inFlight 是可选的第四个字段） */
function historyMsg(
  sessionId: string,
  messages: unknown[],
  inFlight?: Record<string, unknown>,
): HostMessage {
  return {
    type: "history",
    sessionId,
    messages,
    ...(inFlight ? { inFlight } : {}),
  } as unknown as HostMessage;
}

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

const applyHistory = (
  state: ChatState,
  sessionId: string,
  messages: unknown[],
  inFlight?: Record<string, unknown>,
): ChatState => apply(state, historyMsg(sessionId, messages, inFlight));

const applyEvent = (
  state: ChatState,
  sessionId: string,
  event: Record<string, unknown>,
): ChatState =>
  apply(state, {
    type: "streamEvent",
    sessionId,
    event,
  } as unknown as HostMessage);

/** 握手 → 会话列表 → 文献上下文 → 绑定到指定会话 */
function boot(sessions: unknown[], itemKey: string, sid: string): ChatState {
  let s = apply(initialChatState(), { type: "init" });
  s = apply(s, { type: "sessionList", sessions } as unknown as HostMessage);
  s = apply(s, {
    type: "readerContext",
    itemKey,
    title: "论文",
    page: 1,
    selection: null,
  });
  if (s.sessionId !== sid) {
    s = selectSession(s, sid).state;
  }
  assert.equal(s.sessionId, sid, "夹具自检：视图应已绑定到目标会话");
  return s;
}

/** 「一轮正在跑」的视图：有旧回放 + 乐观 user 轮 + 已经在流的块（含 1 个思考 + 1 个工具） */
function runningView(
  sessions: unknown[],
  itemKey: string,
  sid: string,
  userText: string,
): ChatState {
  let s = boot(sessions, itemKey, sid);
  s = applyHistory(s, sid, ROWS_QA);
  s = userSend(s, userText).state;
  s = applyEvent(s, sid, {
    kind: "init",
    model: "opus",
    permissionMode: "default",
  });
  s = applyEvent(s, sid, { kind: "messageStart" });
  s = applyEvent(s, sid, {
    kind: "thinkingDelta",
    index: 0,
    text: "先看看这篇文章讲了什么",
  });
  s = applyEvent(s, sid, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "tu1",
  });
  s = applyEvent(s, sid, {
    kind: "toolInputDelta",
    index: 1,
    jsonFragment: '{"file":"a.pdf"}',
  });
  s = applyEvent(s, sid, { kind: "textBlockStart", index: 2 });
  s = applyEvent(s, sid, {
    kind: "textDelta",
    index: 2,
    text: "这篇文章的核心是",
  });
  return s;
}

/** 切到别的会话再切回来的两步（宿主只回落盘行 + 一份 inFlight） */
function switchAwayAndBack(
  state: ChatState,
  awayId: string,
  backId: string,
  backMsgs: unknown[],
  inFlight?: Record<string, unknown>,
): ChatState {
  let s = selectSession(state, awayId).state;
  s = applyHistory(s, awayId, []);
  s = selectSession(s, backId).state;
  return applyHistory(s, backId, backMsgs, inFlight);
}

/** 本轮（末条 user 轮起）的渲染项 */
const lastRound = (s: ChatState) => groupRounds(s.messages).at(-1);

const countTurns = (s: ChatState, text: string): number =>
  s.messages.filter((t: Turn) => t.text === text).length;

const stripsOf = (s: ChatState) =>
  buildRenderItems(s.messages).filter(
    (i) => i.kind === "strip" && stripSummary(i.round!) !== null,
  );

// ---------- T1 / T2 / T3：现象 1（同文献内切会话） ----------

test("T1 🔴 现象1：切走再切回，在途轮的用户消息还在、turnStatus 仍在跑", () => {
  const s = switchAwayAndBack(
    runningView(SAME_ITEM, "ITEM_A", "s1", QX),
    "s2",
    "s1",
    ROWS_QA,
    {
      userText: QX,
      assistantText: "",
      busy: "running",
      baseRows: 2,
    },
  );

  assert.deepEqual(
    { role: s.messages.at(-1)?.role, text: s.messages.at(-1)?.text },
    { role: "user", text: QX },
    "切回来后 messages 末条应是那条在途的 user 轮（修前被整份回放抹掉）",
  );
  assert.equal(s.turnStatus, "streaming", "在途轮的 turnStatus 必须还在跑");
  assert.equal(s.lastTurnEnd, null, "在途轮不属于「已收尾」");
});

test("T2 🔴 现象1后半：在途轮恢复后不可能再触发 SESSION_BUSY 链路", () => {
  const s = switchAwayAndBack(
    runningView(SAME_ITEM, "ITEM_A", "s1", QX),
    "s2",
    "s1",
    ROWS_QA,
    { userText: QX, assistantText: "", busy: "running", baseRows: 2 },
  );

  assert.notEqual(
    s.turnStatus,
    "idle",
    "turnStatus 非 idle 才谈得上禁用输入框",
  );
  // App.ts:272 `busy = turnStatus !== "idle"` → 输入框禁用；userSend 自己也是同一道闸。
  assert.equal(
    userSend(s, "再问一句").msg,
    null,
    "在途轮没结束前，UI 不该把新消息发给宿主（也就撞不上 SESSION_BUSY）",
  );
});

test("T3 🔴 现象1的流事件恢复：切回后迟到的流事件照常落入视图，result 正常收尾", () => {
  let s = switchAwayAndBack(
    runningView(SAME_ITEM, "ITEM_A", "s1", QX),
    "s2",
    "s1",
    ROWS_QA,
    { userText: QX, assistantText: "", busy: "running", baseRows: 2 },
  );

  s = applyEvent(s, "s1", {
    kind: "textDelta",
    index: 2,
    text: "……继续输出的正文",
  });
  const assistant = s.messages.filter((t) => t.role === "assistant").at(-1);
  const texts = (assistant?.blocks ?? [])
    .filter((b) => b.blockType === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  assert.match(
    texts,
    /继续输出的正文/,
    "切回后的 textDelta 不得被 idle 守卫丢弃（chatModel.ts:1030）",
  );

  s = applyEvent(s, "s1", {
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0.01,
    durationMs: 9000,
    numTurns: 1,
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.lastTurnEnd?.end, "ok");
});

// ---------- T4：现象 2（被 readerContext 拽走再拽回） ----------

test("T4 🔴 现象2：别的文献的 readerContext 把自己拽走后切回，在途轮同样要回来", () => {
  let s = runningView(
    TWO_ITEMS,
    "ITEM_A",
    "sA",
    "问题Y：A 篇的方法有什么局限？",
  );
  // sections.ts 是 broadcast：A 那个侧栏也会收到 B 的 readerContext
  s = apply(s, {
    type: "readerContext",
    itemKey: "ITEM_B",
    title: "B 篇",
    page: 1,
    selection: null,
  });
  assert.equal(s.sessionId, "sB", "夹具自检：广播把视图拽到了 ITEM_B 的会话");

  s = apply(s, {
    type: "readerContext",
    itemKey: "ITEM_A",
    title: "A 篇",
    page: 1,
    selection: null,
  });
  assert.equal(s.sessionId, "sA", "夹具自检：切回 ITEM_A 后重新绑定 sA");
  s = applyHistory(s, "sA", ROWS_QA, {
    userText: "问题Y：A 篇的方法有什么局限？",
    assistantText: "",
    busy: "running",
    baseRows: 2,
  });

  assert.deepEqual(
    { role: s.messages.at(-1)?.role, text: s.messages.at(-1)?.text },
    { role: "user", text: "问题Y：A 篇的方法有什么局限？" },
  );
  assert.equal(s.turnStatus, "streaming");
  assert.equal(s.lastTurnEnd, null);
});

// ---------- T5：无 inFlight 的老行为逐字不变 ----------

test("T5 🔒 无 inFlight 的 history：回放照常应用、绑定会话、收尾标记为已完成", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(s, "s1", ROWS_QA); // 老宿主形态：没有 inFlight 字段

  assert.equal(s.turnStatus, "idle");
  assert.deepEqual(
    s.messages.map((t) => `${t.role}:${t.text}`),
    ["user:旧问题", "assistant:旧回答"],
    "回放恰好两条（不多不少）",
  );
  assert.deepEqual(s.lastTurnEnd, { round: -1, end: "ok" });
});

// ---------- T6a / T6b / T6d：竞态（本地 idle 时收到带 inFlight 的 history） ----------

test("T6a 🔴(§7 标注；实为幂等锁) 回放里已经含了这条在途轮 → 不得再补一条", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(
    s,
    "s1",
    [
      ...ROWS_QA,
      { role: "user", text: "X", ts: 3 },
      { role: "assistant", text: "这篇文章的核心是", ts: 4 },
    ],
    { userText: "X", assistantText: "", busy: "running", baseRows: 2 },
  );

  assert.equal(
    countTurns(s, "X"),
    1,
    "回放已含 X（4 行 > baseRows 2）→ 不能再补占位轮",
  );
  assert.equal(s.turnStatus, "idle", "已经在回放里了 → 不必抬成 streaming");
});

test("T6b 🔴 回放里没有这条在途轮 → 补上占位轮并进入在跑状态", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(s, "s1", ROWS_QA, {
    userText: "X",
    assistantText: "",
    busy: "running",
    baseRows: 2,
  });

  assert.equal(countTurns(s, "X"), 1);
  assert.equal(s.turnStatus, "streaming");
});

test("T6d 🔴 连问两次同一句：文本一样也必须是两条（历史一条 + 在途一条）", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(
    s,
    "s1",
    [
      { role: "user", text: "继续", ts: 1 },
      { role: "assistant", text: "好的", ts: 2 },
    ],
    { userText: "继续", assistantText: "", busy: "running", baseRows: 2 },
  );

  assert.equal(
    countTurns(s, "继续"),
    2,
    "文本相同的两条轮次必须都在——按文本键判重会丢/多",
  );
  assert.equal(s.turnStatus, "streaming");
});

// ---------- T7：本地优先（本地正在跑同一轮） ----------

test("T7 🔴(§7 标注；实为本地优先锁) 本地已在跑同一轮：保留本地在途段（blocks 不丢）、不追加占位轮", () => {
  let s = runningView(SAME_ITEM, "ITEM_A", "s1", QX);
  const blocksBefore = (
    s.messages.filter((t) => t.role === "assistant").at(-1)?.blocks ?? []
  ).length;

  s = applyHistory(s, "s1", ROWS_QA, {
    userText: QX,
    assistantText: "",
    busy: "running",
    baseRows: 2,
  });

  assert.equal(countTurns(s, QX), 1, "本地已有那条在途轮 → 不得再追加一条");
  assert.equal(
    countTurns(s, "旧问题"),
    1,
    "本地视图里已有旧回放 → 不得再叠一份",
  );
  const blocksAfter = (
    s.messages.filter((t) => t.role === "assistant").at(-1)?.blocks ?? []
  ).length;
  assert.equal(blocksAfter, blocksBefore, "本地在途段的 blocks 一个不能少");
  assert.equal(s.turnStatus, "streaming");
});

// ---------- T11：占位轮的形态（致命-1） ----------

test("T11 🔴 占位轮形态：流事件与 assistantMessage 收进同一轮，正文块恰一个且等于全文", () => {
  const FULL = "这篇文章的核心是：它把三件事拆开了。";
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(s, "s1", ROWS_QA, {
    userText: "X",
    assistantText: "这篇文章的核心是",
    busy: "running",
    baseRows: 2,
  });
  s = applyEvent(s, "s1", {
    kind: "thinkingDelta",
    index: 0,
    text: "先看看这篇文章讲了什么",
  });
  s = applyEvent(s, "s1", {
    kind: "textDelta",
    index: 2,
    text: "：它把三件事拆开了。",
  });
  s = applyEvent(s, "s1", {
    kind: "assistantMessage",
    content: [
      { type: "thinking", thinking: "先看看这篇文章讲了什么" },
      { type: "text", text: FULL },
    ],
  });

  const round = lastRound(s);
  assert.equal(
    round?.assistantTurns,
    1,
    "本轮 assistant Turn 必须恰 1 条（占位轮不能另起一条）",
  );
  const lastAssistant = s.messages.filter((t) => t.role === "assistant").at(-1);
  const textBlocks = (lastAssistant?.blocks ?? []).filter(
    (b) => b.blockType === "text",
  );
  assert.equal(textBlocks.length, 1, "正文块恰 1 个");
  assert.equal(
    (textBlocks[0] as { text: string }).text,
    FULL,
    "正文块内容 = assistantMessage 的全文",
  );
});

// ---------- T13：BUG-09 回归锁 ----------

test("T13 🔒 BUG-09：turn 已结束后迟到的流事件一律忽略，state 逐字不变", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = applyHistory(s, "s1", ROWS_QA);
  assert.equal(s.turnStatus, "idle", "夹具自检：已结束");

  const before = JSON.stringify(s);
  s = applyEvent(s, "s1", {
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
  });
  s = applyEvent(s, "s1", {
    kind: "textDelta",
    index: 0,
    text: "迟到的正文",
  });
  assert.equal(
    JSON.stringify(s),
    before,
    "idle 守卫（chatModel.ts:1030）未被动过",
  );
});

// ---------- T15：在途轮的操作条口径（锁现状，不改行为） ----------

test("T15 🔒 在途轮的操作条口径：分支禁用带原因 / 可编辑 / 同会话可中断", () => {
  const s = runningView(SAME_ITEM, "ITEM_A", "s1", QX);
  const userIdx = s.messages.findLastIndex((t) => t.role === "user");
  assert.equal(groupRounds(s.messages).length, 2, "夹具自检：在途的是第 2 轮");

  // 分支（§4.6 口径：只给第 1 轮拍过快照）：在途那轮可见但禁用 + 人话原因
  const branch = branchButtonState(s.messages, userIdx, { snapshotTurns: [1] });
  assert.equal(branch.visible, true);
  assert.equal(branch.enabled, false, "没有快照的轮不能真回滚 → 按钮禁用");
  assert.equal(typeof branch.reason, "string");
  assert.notEqual(branch.reason, "");
  // 已拍过快照的第 1 轮按钮照常可用（口径未变）
  assert.equal(
    branchButtonState(s.messages, 0, { snapshotTurns: [1] }).enabled,
    true,
  );

  // 编辑：user 轮永远可编辑（「忙」只体现在输入框/发送闸上）
  assert.equal(canEditTurn(s.messages[userIdx]), true);

  // 中断：本视图还在跑时才可用（同会话可停）
  const stopped = interrupt(s);
  assert.equal(stopped.msg?.type, "interrupt");
  assert.equal(stopped.msg?.sessionId, "s1");
  assert.equal(stopped.state.turnStatus, "interrupting");
  assert.equal(
    interrupt(boot(SAME_ITEM, "ITEM_A", "s1")).msg,
    null,
    "空闲时无动作",
  );
});

// ---------- T16：BUG-23/26 回归锁（无 inFlight 的既有合并行为） ----------

test("T16 🔒 刚切完立刻发：回放上下文与自己那条乐观轮都在（BUG-23/26 不回归）", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = userSend(s, "切完立刻发").state;
  assert.equal(s.turnStatus, "waiting", "夹具自检：本地这一轮在路上");

  s = applyHistory(s, "s1", ROWS_QA); // 无 inFlight，走既有 R-D 分支

  assert.equal(countTurns(s, "旧问题"), 1, "回放上下文要在");
  assert.equal(countTurns(s, "切完立刻发"), 1, "自己那条乐观轮也要在");
});

// ---------- T17：pendingRetry 守卫收窄的正反 ----------

test("T17① 🔒 自动重发被接受：首个流事件到达即清 pendingRetry（单实例行为不变）", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = userSend(s, "Y").state;
  s = apply(s, {
    type: "error",
    sessionId: "s1",
    code: "SESSION_BUSY",
    message: "进行中的 turn 未结束",
  });
  assert.notEqual(s.pendingRetry, null, "夹具自检：被拒后进入自动重发");

  s = fireRetry(s).state;
  assert.equal(s.turnStatus, "waiting");
  s = applyEvent(s, "s1", { kind: "messageStart" });
  assert.equal(s.pendingRetry, null, "重发已被接受（流事件到了）→ 停止重试");
});

test("T17② 🔒 别人的轮在流时，不得清掉我的待重发消息", () => {
  let s = boot(SAME_ITEM, "ITEM_A", "s1");
  s = userSend(s, "Y").state;
  s = apply(s, {
    type: "error",
    sessionId: "s1",
    code: "SESSION_BUSY",
    message: "进行中的 turn 未结束",
  });
  // 实例 1 开轮（同一会话）→ 广播到达
  s = applyHistory(s, "s1", ROWS_QA, {
    userText: "X",
    assistantText: "",
    busy: "running",
    baseRows: 2,
  });
  assert.notEqual(s.pendingRetry, null, "开轮广播不得吃掉我的待重发消息");
  // 注：「Y 还在 messages 里」（致命-1 的另一半）由宿主桥侧的 T12b 走真实广播链路验，
  // 这里只锁 §7 写明的 pendingRetry 保留（手喂广播会把 T12b 的场景提前变成红的）。

  // 实例 1 那轮的流事件（不是我的轮的收尾证据）
  s = applyEvent(s, "s1", { kind: "messageStart" });
  s = applyEvent(s, "s1", {
    kind: "thinkingDelta",
    index: 0,
    text: "别人的轮",
  });
  assert.notEqual(
    s.pendingRetry,
    null,
    "别人的流事件不是我的重发被接受的证据 → pendingRetry 必须保留",
  );
  assert.equal(s.pendingRetry?.text, "Y");
});
