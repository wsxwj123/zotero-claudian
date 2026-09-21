// 单测 — R19 §5 对照组 C1–C6（防「修过头」：这些场景修前修后都必须绿）
//         + BRIEF-R19 §3 成功标准 2（A 本来没有会话、走自动建会话发出的在途轮，切走同样不许串）
//
// 契约来源：.devflow/INTERFACE-R19.md §5、BRIEF-R19 §3。黑盒：只按契约写，不看实现。
// 本文件红/绿计数（改动时同步更新）：🔴 修前必红 = 2 条；🔒 修前就绿 = 20 条。合计 22 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fireRetry,
  flushQueuedSend,
  followReader,
  initialChatState,
  needsSessionListRefresh,
  reduceHostMessage,
  sendWithAutoSession,
  userSend,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

const SA = "sA";
const SC = "sC";
const ITEM_A = "ITEM_AAAA";
const ITEM_B = "ITEM_BBBB"; // 没有任何会话的文献
const ITEM_C = "ITEM_CCCC";

const msg = (m: Record<string, unknown>): HostMessage =>
  m as unknown as HostMessage;

const row = (id: string, itemKey: string, updatedAt: number) => ({
  id,
  title: `会话 ${id}`,
  updatedAt,
  itemKey,
  claudeSessionId: null,
  itemTitle: null,
});

const reader = (itemKey: string) => ({
  itemKey,
  title: `文献 ${itemKey}`,
  page: 1,
  selection: null,
});

/** A 的六类会话级消息（都带 sessionId: sA） */
const A_MESSAGES: [string, HostMessage][] = [
  [
    "history 开轮广播",
    msg({
      type: "history",
      sessionId: SA,
      messages: [],
      inFlight: {
        userText: "A 的问题",
        assistantText: "",
        busy: "running",
        baseRows: 0,
        blocks: [],
      },
    }),
  ],
  [
    "history 换绑定回执",
    msg({
      type: "history",
      sessionId: SA,
      messages: [{ role: "user", text: "A 的问题", ts: 1 }],
    }),
  ],
  [
    "streamEvent textDelta",
    msg({
      type: "streamEvent",
      sessionId: SA,
      event: { kind: "textDelta", index: 0, text: "A 的正文" },
    }),
  ],
  [
    "streamEvent messageStart",
    msg({
      type: "streamEvent",
      sessionId: SA,
      event: { kind: "messageStart" },
    }),
  ],
  [
    "inputHistory",
    msg({ type: "inputHistory", sessionId: SA, entries: ["A 的问题"] }),
  ],
  [
    "error 带 sessionId",
    msg({
      type: "error",
      code: "SESSION_GONE",
      message: "A 没了",
      sessionId: SA,
    }),
  ],
];

// =====================================================================
// C1：在途时切到「有会话」的文献 C —— 今天已如此，锁住不许变
// =====================================================================

/** A 在途 → 切到有会话的 C，并让 C 的历史落地 */
function viewOnCWithOwnHistory(): ChatState {
  const boundA = {
    ...initialChatState(),
    sessionId: SA,
    sessions: [row(SA, ITEM_A, 10), row(SC, ITEM_C, 9)],
  } as unknown as ChatState;
  const inFlight = userSend(boundA, "A 的问题").state;
  const onC = followReader(inFlight, ITEM_C);
  assert.equal(onC.state.sessionId, SC, "夹具自检：切到 C 后绑定 sC");
  return reduceHostMessage(
    onC.state,
    msg({
      type: "history",
      sessionId: SC,
      messages: [
        { role: "user", text: "C 自己的老问题", ts: 1 },
        { role: "assistant", text: "C 自己的老答案", ts: 2 },
      ],
    }),
  );
}

test("🔒 C1：在途时切到有会话的 C → C 显示的是自己的历史，不含 A 的在途轮", () => {
  const c = viewOnCWithOwnHistory();
  assert.deepEqual(
    c.messages.map((m) => m.text),
    ["C 自己的老问题", "C 自己的老答案"],
  );
});

for (const [label, m] of A_MESSAGES) {
  test(`🔒 C1：绑着 C 的视图收到 A 的「${label}」→ 一个字段都不变`, () => {
    const before = viewOnCWithOwnHistory();
    assert.deepEqual(
      reduceHostMessage(before, m),
      before,
      `C 不得被 A 的「${label}」改动`,
    );
  });
}

// =====================================================================
// C2：未绑定视图自己发起的轮 —— 自动建会话 → 绑定 → 暂存原文发出 → 正常显示
// =====================================================================

/** 空绑定态（停在还没有会话的文献 B 上）敲下回车 */
function unboundJustSent(): ChatState {
  const empty = {
    ...initialChatState(),
    sessionId: null,
    readerContext: reader(ITEM_B),
  } as unknown as ChatState;
  const s = sendWithAutoSession(empty, "空绑定态发出的第一句").state;
  assert.equal(s.sessionId, null, "夹具自检：此刻还没绑上会话");
  assert.equal(s.creatingSession, true, "夹具自检：正在建会话");
  assert.equal(s.queuedSend, "空绑定态发出的第一句", "夹具自检：原文被暂存");
  return s;
}

test("🔒 C2：空绑定态发送 → 只置「建会话中 + 暂存原文」，不伪造在途轮", () => {
  const s = unboundJustSent();
  assert.equal(s.turnStatus, "idle", "会话还没建好，状态条不该提前点亮");
  assert.deepEqual(s.messages, [], "气泡要等真发出去才出现");
});

test("🔒 C2：新会话的 sessionList 到达 → 绑定该会话并清掉「建会话中」，暂存原文还在", () => {
  const bound = reduceHostMessage(
    unboundJustSent(),
    msg({ type: "sessionList", sessions: [row("sNew", ITEM_B, 99)] }),
  );
  assert.equal(bound.sessionId, "sNew");
  assert.equal(bound.creatingSession, false);
  assert.equal(
    bound.queuedSend,
    "空绑定态发出的第一句",
    "原文不许在绑定这一步被丢掉",
  );
});

test("🔒 C2：暂存原文真正发出 → 用户气泡出现、状态条进入等待", () => {
  const bound = reduceHostMessage(
    unboundJustSent(),
    msg({ type: "sessionList", sessions: [row("sNew", ITEM_B, 99)] }),
  );
  const sent = flushQueuedSend(bound).state;
  assert.deepEqual(
    sent.messages.map((m) => m.text),
    ["空绑定态发出的第一句"],
  );
  assert.equal(sent.turnStatus, "waiting");
  assert.equal(sent.queuedSend, null, "发出后暂存位要清空，避免重复发送");
});

test("🔒 C2：绑定后本会话的 history / streamEvent 正常显示，一条都不许被误丢", () => {
  const bound = reduceHostMessage(
    unboundJustSent(),
    msg({ type: "sessionList", sessions: [row("sNew", ITEM_B, 99)] }),
  );
  let view = flushQueuedSend(bound).state;
  view = reduceHostMessage(
    view,
    msg({
      type: "history",
      sessionId: "sNew",
      messages: [],
      inFlight: {
        userText: "空绑定态发出的第一句",
        assistantText: "",
        busy: "running",
        baseRows: 0,
        blocks: [],
      },
    }),
  );
  for (const event of [
    { kind: "messageStart" },
    { kind: "textBlockStart", index: 0 },
    { kind: "textDelta", index: 0, text: "这是新会话的回答。" },
  ]) {
    view = reduceHostMessage(
      view,
      msg({ type: "streamEvent", sessionId: "sNew", event }),
    );
  }
  const visible = view.messages
    .map(
      (m) =>
        m.text ??
        ((m as unknown as { blocks?: { text?: string }[] }).blocks ?? [])
          .map((b) => b.text ?? "")
          .join(""),
    )
    .join("\n");
  assert.ok(
    visible.includes("空绑定态发出的第一句"),
    `用户气泡必须在，实际：${visible}`,
  );
  assert.ok(
    visible.includes("这是新会话的回答。"),
    `流式正文必须在，实际：${visible}`,
  );
});

// =====================================================================
// C3：SESSION_BUSY 被拒 → 定时重发 → 重发带的是当前绑定的 sessionId
// =====================================================================

/** 绑着 sA 的视图发了一句，被宿主以 SESSION_BUSY 拒掉 */
function refusedBusy(): ChatState {
  const bound = {
    ...initialChatState(),
    sessionId: SA,
    sessions: [row(SA, ITEM_A, 10)],
    readerContext: reader(ITEM_A),
  } as unknown as ChatState;
  const sent = userSend(bound, "被拒的那句").state;
  const refused = reduceHostMessage(
    sent,
    msg({
      type: "error",
      code: "SESSION_BUSY",
      message: "进行中的 turn 未结束",
      sessionId: SA,
    }),
  );
  assert.notEqual(refused.pendingRetry, null, "夹具自检：被拒后置了待重发");
  assert.equal(refused.errorBanner, null, "夹具自检：SESSION_BUSY 不弹横幅");
  return refused;
}

test("🔒 C3：SESSION_BUSY 被拒 → 在途轮保留、置待重发、不弹横幅", () => {
  const r = refusedBusy();
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ["被拒的那句"],
  );
});

test("🔒 C3：定时重发带的是当前绑定的 sessionId（不是 null、不是别的会话）", () => {
  const r = fireRetry(refusedBusy()) as unknown as {
    state: ChatState;
    msg?: { type?: unknown; sessionId?: unknown; text?: unknown };
  };
  const payload = r.msg;
  assert.ok(payload, "fireRetry 必须给出要重发的 send 载荷");
  assert.equal(payload.type, "send");
  assert.equal(payload.sessionId, SA, "重发必须打在当前绑定的会话上");
  assert.equal(payload.text, "被拒的那句");
});

test("🔒 C3：重发被接受后，该会话的流事件正常显示", () => {
  let view = (fireRetry(refusedBusy()) as unknown as { state: ChatState })
    .state;
  for (const event of [
    { kind: "messageStart" },
    { kind: "textBlockStart", index: 0 },
    { kind: "textDelta", index: 0, text: "重发之后的回答。" },
  ]) {
    view = reduceHostMessage(
      view,
      msg({ type: "streamEvent", sessionId: SA, event }),
    );
  }
  const visible = view.messages
    .map(
      (m) =>
        m.text ??
        ((m as unknown as { blocks?: { text?: string }[] }).blocks ?? [])
          .map((b) => b.text ?? "")
          .join(""),
    )
    .join("\n");
  assert.ok(
    visible.includes("重发之后的回答。"),
    `重发后的正文必须显示，实际：${visible}`,
  );
});

// =====================================================================
// C4 / C5 / C6
// =====================================================================

test("🔒 C4：未绑定的空态面板收到不带 sessionId 的 SPAWN_FAILED → 横幅照常出现", () => {
  const empty = { ...initialChatState(), sessionId: null } as ChatState;
  const after = reduceHostMessage(
    empty,
    msg({ type: "error", code: "SPAWN_FAILED", message: "起不来" }),
  );
  assert.equal(after.errorBanner, "SPAWN_FAILED: 起不来");
});

test("🔒 C5：有 itemKey + 本地没有该 itemKey 的会话 + 没请求过 → 请求一次列表回填", () => {
  const s = {
    ...initialChatState(),
    sessionId: null,
    readerContext: reader(ITEM_B),
  } as unknown as ChatState;
  assert.equal(needsSessionListRefresh(s, null), ITEM_B);
});

test("🔒 C5：同一个 itemKey 已经请求过 → 不再请求（每个 itemKey 最多一次）", () => {
  const s = {
    ...initialChatState(),
    sessionId: null,
    readerContext: reader(ITEM_B),
  } as unknown as ChatState;
  assert.equal(needsSessionListRefresh(s, ITEM_B), null);
  assert.equal(
    needsSessionListRefresh(s, ITEM_A),
    ITEM_B,
    "换了一篇文献仍要请求一次",
  );
});

test("🔒 C5：本地已有该 itemKey 的会话 / 压根没有 itemKey → 都不请求", () => {
  const hasLocal = {
    ...initialChatState(),
    sessionId: null,
    readerContext: reader(ITEM_B),
    sessions: [row("sB", ITEM_B, 1)],
  } as unknown as ChatState;
  assert.equal(needsSessionListRefresh(hasLocal, null), null);
  assert.equal(needsSessionListRefresh(initialChatState(), null), null);
});

test("🔒 C6：sessionList 广播到未绑定视图 → 列表照常更新并收敛绑定", () => {
  const empty = { ...initialChatState(), sessionId: null } as ChatState;
  const after = reduceHostMessage(
    empty,
    msg({
      type: "sessionList",
      sessions: [row("sNew", ITEM_B, 99), row(SA, ITEM_A, 10)],
    }),
  );
  assert.deepEqual(
    after.sessions.map((s) => s.id),
    ["sNew", SA],
  );
  assert.equal(after.sessionId, "sNew", "未绑定视图照常绑到最新一条");
});

test("🔒 C6：sessionList 广播到已绑定视图 → 当前会话仍在列表就不抢绑定", () => {
  const bound = {
    ...initialChatState(),
    sessionId: SA,
  } as unknown as ChatState;
  const after = reduceHostMessage(
    bound,
    msg({
      type: "sessionList",
      sessions: [row("sNew", ITEM_B, 99), row(SA, ITEM_A, 10)],
    }),
  );
  assert.equal(after.sessionId, SA);
});

// =====================================================================
// BRIEF §3 成功标准 2：A 本来没有会话、走自动建会话发出的在途轮，切走同样不许串
// =====================================================================

/** 空绑定发送 → 建好会话绑上 → 原文发出（此时是真在途），然后用户切到没有会话的文献 */
function autoCreatedRoundThenSwitchAway(): { before: ChatState; sid: string } {
  const bound = reduceHostMessage(
    unboundJustSent(),
    msg({ type: "sessionList", sessions: [row("sAuto", ITEM_B, 99)] }),
  );
  const sent = flushQueuedSend(bound).state;
  assert.equal(
    sent.turnStatus,
    "waiting",
    "夹具自检：自动建会话那一轮确实在途",
  );
  const away = followReader(sent, "ITEM_EMPTY");
  assert.equal(
    away.state.sessionId,
    null,
    "夹具自检：切到的文献没有会话 ⇒ 未绑定空态",
  );
  return { before: away.state, sid: "sAuto" };
}

test("🔴 成功标准 2：自动建会话的在途轮 —— 切走后它的开轮广播不许串进新视图", () => {
  const { before, sid } = autoCreatedRoundThenSwitchAway();
  const after = reduceHostMessage(
    before,
    msg({
      type: "history",
      sessionId: sid,
      messages: [],
      inFlight: {
        userText: "空绑定态发出的第一句",
        assistantText: "",
        busy: "running",
        baseRows: 0,
        blocks: [],
      },
    }),
  );
  assert.deepEqual(
    after,
    before,
    "新文献的空面板不得出现上一篇那一轮的用户气泡",
  );
});

test("🔴 成功标准 2：自动建会话的在途轮 —— 切走后它的错误横幅不许串进新视图", () => {
  const { before, sid } = autoCreatedRoundThenSwitchAway();
  const after = reduceHostMessage(
    before,
    msg({
      type: "error",
      code: "SESSION_GONE",
      message: "没了",
      sessionId: sid,
    }),
  );
  assert.deepEqual(after, before, "新文献的空面板不得弹上一篇那一轮的错误");
});
