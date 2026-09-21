// 单测 — R19 §2 会话级消息的视图归属判定表 + §3 非法/缺失输入契约
//
// 契约来源：.devflow/INTERFACE-R19.md §2（判定表）、§3（非法输入）。黑盒：只按契约写，不看实现。
// 一句话口径：带字符串 sessionId 的消息只被绑定到该会话的视图接收；未绑定的视图一条都不接收；
//            不带 sessionId（或非字符串）的消息按全局消息照常应用。
//
// 本文件红/绿计数（见文件末尾对账注释，改动时同步更新）：
//   🔴 修前必红 = 18 条；🔒 修前就绿（锁住不许变）= 41 条。合计 59 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

const SA = "sA"; // 消息所属会话（文献 A）
const SC = "sC"; // 另一条会话（文献 C）

const msg = (m: Record<string, unknown>): HostMessage =>
  m as unknown as HostMessage;

// ---- 四种视图状态（§2 的四列）----

/** 列 1/2：已绑定某会话的空闲视图 */
const boundIdle = (sid: string): ChatState =>
  ({ ...initialChatState(), sessionId: sid }) as ChatState;

/** 列 1/2 的流式变体：本视图自己的轮正在进行（流事件只在 turn 进行中被应用，BUG-09） */
const boundStreaming = (sid: string): ChatState =>
  ({
    ...initialChatState(),
    sessionId: sid,
    turnStatus: "streaming",
    messages: [{ role: "user", text: "本视图自己发的问题" }],
  }) as unknown as ChatState;

/** 列 3：未绑定且空闲（R4 之后切到「没有会话的文献」的合法常态） */
const unboundIdle = (): ChatState =>
  ({ ...initialChatState(), sessionId: null }) as ChatState;

/**
 * 列 3 的细分态 ②（§2 修订 r2-1）：未绑定，但轮已被**别的会话的开轮 history** 点亮。
 * 按 r2-1 的要求，这个中间态必须由「先投 history」真实造出来，不能手搓 turnStatus ——
 * 只有这样修前才观察得到串屏，修后（history 先被丢）该态不可达、结果同样是丢弃。
 */
const unboundStreaming = (): ChatState =>
  reduceHostMessage(
    { ...initialChatState(), sessionId: null } as ChatState,
    openRoundHistory(SA),
  );

/** 列 4：未绑定但「自己发送在途」（空绑定发送 ⇒ 只置 queuedSend / creatingSession） */
const unboundQueued = (): ChatState =>
  ({
    ...initialChatState(),
    sessionId: null,
    queuedSend: "空绑定态刚敲下回车的这句话",
    creatingSession: true,
  }) as unknown as ChatState;

/** 列 4 的细分态 ②（同 r2-1：先投 history 把它点亮，再投 streamEvent） */
const unboundQueuedStreaming = (): ChatState =>
  reduceHostMessage(unboundQueued(), openRoundHistory(SA));

// ---- 断言原语 ----

/** 丢弃 = 整个状态对象内容不变（§3 末行） */
function assertDropped(before: ChatState, m: HostMessage, why: string): void {
  const after = reduceHostMessage(before, m);
  assert.deepEqual(after, before, why);
}

/** 应用 = 状态确实被这条消息改动过 */
function assertApplied(before: ChatState, m: HostMessage): ChatState {
  const after = reduceHostMessage(before, m);
  assert.notDeepEqual(
    after,
    before,
    "这条消息归本视图，必须产生可观察的状态变化",
  );
  return after;
}

// ---- 各类消息的标准载荷 ----

const openRoundHistory = (sid: string): HostMessage =>
  msg({
    type: "history",
    sessionId: sid,
    messages: [],
    inFlight: {
      userText: "A 里刚发出、CLI 还没回的那句话",
      assistantText: "",
      busy: "running",
      baseRows: 0,
      blocks: [],
    },
  });

const rebindHistory = (sid: string): HostMessage =>
  msg({
    type: "history",
    sessionId: sid,
    messages: [
      { role: "user", text: "A 的第一问", ts: 1 },
      { role: "assistant", text: "A 的第一答", ts: 2 },
    ],
  });

const streamMsg = (sid: string, event: Record<string, unknown>): HostMessage =>
  msg({ type: "streamEvent", sessionId: sid, event });

const STREAM_KINDS: Record<string, Record<string, unknown>> = {
  textDelta: { kind: "textDelta", index: 0, text: "A 的正文片段" },
  toolBlockStart: {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "tu1",
  },
  result: {
    kind: "result",
    claudeSessionId: "cli-a",
    numTurns: 1,
    costUsd: 0.01,
    durationMs: 3000,
    isError: false,
  },
};

const inputHistoryMsg = (sid: string): HostMessage =>
  msg({ type: "inputHistory", sessionId: sid, entries: ["上一句", "上上句"] });

const errorMsg = (sid: string): HostMessage =>
  msg({
    type: "error",
    code: "SESSION_BUSY",
    message: "A 的会话忙",
    sessionId: sid,
  });

// =====================================================================
// §2 判定表 —— 行：history（开轮广播）
// =====================================================================

test("🔒 history 开轮广播 / 已绑定同会话 → 应用（在途轮的用户气泡进入本视图）", () => {
  const after = assertApplied(boundIdle(SA), openRoundHistory(SA));
  assert.equal(after.messages.length, 1);
  assert.equal(after.messages[0].role, "user");
  assert.equal(after.messages[0].text, "A 里刚发出、CLI 还没回的那句话");
});

test("🔒 history 开轮广播 / 已绑定他会话 → 丢弃", () => {
  assertDropped(
    boundIdle(SC),
    openRoundHistory(SA),
    "绑着 sC 的视图不认领 sA 的开轮广播",
  );
});

test("🔴 history 开轮广播 / 未绑定且空闲 → 丢弃（切到无会话的文献，不许串用户气泡）", () => {
  assertDropped(
    unboundIdle(),
    openRoundHistory(SA),
    "未绑定视图不得出现 A 这一轮的用户气泡",
  );
});

test("🔴 history 开轮广播 / 未绑定且自己发送在途 → 丢弃", () => {
  assertDropped(
    unboundQueued(),
    openRoundHistory(SA),
    "空绑定排队中的视图也不认领他会话的开轮广播",
  );
});

// =====================================================================
// §2 判定表 —— 行：history（换绑定回执，全量落盘行）
// =====================================================================

test("🔒 history 换绑定回执 / 已绑定同会话 → 应用（历史全量重建）", () => {
  const after = assertApplied(boundIdle(SA), rebindHistory(SA));
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[0].text, "A 的第一问");
  assert.equal(after.messages[1].text, "A 的第一答");
});

test("🔒 history 换绑定回执 / 已绑定他会话 → 丢弃", () => {
  assertDropped(
    boundIdle(SC),
    rebindHistory(SA),
    "绑着 sC 的视图不认领 sA 的历史回执",
  );
});

test("🔴 history 换绑定回执 / 未绑定且空闲 → 丢弃（空态不得被别人的历史填满）", () => {
  assertDropped(unboundIdle(), rebindHistory(SA), "未绑定视图必须保持空态文案");
});

test("🔴 history 换绑定回执 / 未绑定且自己发送在途 → 丢弃", () => {
  assertDropped(
    unboundQueued(),
    rebindHistory(SA),
    "排队中的空绑定视图不认领他会话的历史",
  );
});

// =====================================================================
// §2 判定表 —— 行：streamEvent（全部 kind 同口径，取 textDelta / toolBlockStart / result 三种）
// =====================================================================

for (const [kind, event] of Object.entries(STREAM_KINDS)) {
  test(`🔒 streamEvent(${kind}) / 已绑定同会话 → 应用`, () => {
    assertApplied(boundStreaming(SA), streamMsg(SA, event));
  });

  test(`🔒 streamEvent(${kind}) / 已绑定他会话 → 丢弃`, () => {
    assertDropped(
      boundStreaming(SC),
      streamMsg(SA, event),
      `绑着 sC 的视图不认领 sA 的 ${kind}`,
    );
  });

  test(`🔴 streamEvent(${kind}) / 未绑定（轮在进行中）→ 丢弃`, () => {
    assertDropped(
      unboundStreaming(),
      streamMsg(SA, event),
      `未绑定视图不得被 sA 的 ${kind} 改动任何字段`,
    );
  });

  test(`🔴 streamEvent(${kind}) / 未绑定且自己发送在途 → 丢弃`, () => {
    assertDropped(
      unboundQueuedStreaming(),
      streamMsg(SA, event),
      `排队中的空绑定视图不得被 sA 的 ${kind} 改动`,
    );
  });
}

// =====================================================================
// §2 判定表 —— 行：usageStats
// =====================================================================

// =====================================================================
// §2 判定表 —— 行：inputHistory
// =====================================================================

test("🔒 inputHistory / 已绑定同会话 → 应用", () => {
  assertApplied(boundIdle(SA), inputHistoryMsg(SA));
});

test("🔒 inputHistory / 已绑定他会话 → 丢弃", () => {
  assertDropped(
    boundIdle(SC),
    inputHistoryMsg(SA),
    "绑着 sC 的视图不认领 sA 的输入历史",
  );
});

test("🔴 inputHistory / 未绑定且空闲 → 丢弃", () => {
  assertDropped(
    unboundIdle(),
    inputHistoryMsg(SA),
    "未绑定视图不得吃到别人的输入历史",
  );
});

test("🔴 inputHistory / 未绑定且自己发送在途 → 丢弃", () => {
  assertDropped(
    unboundQueued(),
    inputHistoryMsg(SA),
    "排队中的空绑定视图同样不认领",
  );
});

// =====================================================================
// §2 判定表 —— 行：error（带 sessionId）
// =====================================================================

test("🔒 error 带 sessionId / 已绑定同会话 → 应用（横幅 + 解 waiting）", () => {
  const before = {
    ...initialChatState(),
    sessionId: SA,
    turnStatus: "waiting",
  } as unknown as ChatState;
  const after = reduceHostMessage(before, errorMsg(SA));
  assert.equal(after.errorBanner, "SESSION_BUSY: A 的会话忙");
});

test("🔒 error 带 sessionId / 已绑定他会话 → 丢弃（不横幅、不解 waiting）", () => {
  const before = {
    ...initialChatState(),
    sessionId: SC,
    turnStatus: "waiting",
  } as unknown as ChatState;
  assertDropped(before, errorMsg(SA), "sA 的错误不得弹到绑着 sC 的视图上");
});

test("🔴 error 带 sessionId / 未绑定且空闲 → 丢弃（空态面板不得弹别人的错误横幅）", () => {
  assertDropped(
    unboundIdle(),
    errorMsg(SA),
    "未绑定视图不得出现 sA 的错误横幅",
  );
});

test("🔴 error 带 sessionId / 未绑定且自己发送在途 → 丢弃（不得误清 creatingSession）", () => {
  assertDropped(
    unboundQueued(),
    errorMsg(SA),
    "他会话的错误不得打断本视图正在排队的自动建会话",
  );
});

// =====================================================================
// §2 判定表 —— 行：attachmentSaved（今天已如此，本轮不变）
// =====================================================================

// =====================================================================
// §2 下半表 —— 不带 sessionId（或非字符串）的全局消息：任意视图照常应用
// =====================================================================

test("🔒 全局 error（不带 sessionId）/ 已绑定视图 → 应用（老契约保留）", () => {
  const after = reduceHostMessage(
    boundIdle(SA),
    msg({
      type: "error",
      code: "SPAWN_FAILED",
      message: "spawn 失败",
    }),
  );
  assert.equal(after.errorBanner, "SPAWN_FAILED: spawn 失败");
});

test("🔒 全局 error（不带 sessionId）/ 未绑定视图 → 应用（C4：空态面板也要看见）", () => {
  const after = reduceHostMessage(
    unboundIdle(),
    msg({
      type: "error",
      code: "SPAWN_FAILED",
      message: "spawn 失败",
    }),
  );
  assert.equal(after.errorBanner, "SPAWN_FAILED: spawn 失败");
});

test("🔒 全局 streamEvent（缺 sessionId 的老宿主形态）→ 应用", () => {
  assertApplied(
    boundStreaming(SA),
    msg({ type: "streamEvent", event: STREAM_KINDS.textDelta }),
  );
});

test("🔒 inputHistory 缺 sessionId → 丢弃（没有 sessionId 就没处可落，今天已如此）", () => {
  assertDropped(
    boundIdle(SA),
    msg({ type: "inputHistory", entries: ["x"] }),
    "不得写出 inputHistory 字段，也不得清空既有值",
  );
});

// =====================================================================
// §3 各入口对非法/缺失输入的契约
// =====================================================================

// —— sessionId 非字符串 ⇒ 按「全局消息」放行（用 error 的横幅做可观察量）——
const NON_STRING_SIDS: [string, Record<string, unknown>][] = [
  ["缺字段", {}],
  ["undefined", { sessionId: undefined }],
  ["null", { sessionId: null }],
  ["数字", { sessionId: 7 }],
  ["对象", { sessionId: { id: "sA" } }],
  ["数组", { sessionId: ["sA"] }],
];

for (const [label, extra] of NON_STRING_SIDS) {
  test(`🔒 error 的 sessionId ${label}（非字符串）→ 按全局消息放行，横幅照常`, () => {
    const after = reduceHostMessage(
      boundIdle(SA),
      msg({
        type: "error",
        code: "SPAWN_FAILED",
        message: "全局故障",
        ...extra,
      }),
    );
    assert.equal(after.errorBanner, "SPAWN_FAILED: 全局故障");
  });
}

test("🔒 sessionId 为空串 / 已绑定视图 → 丢弃（state.sessionId 永不为空串）", () => {
  assertDropped(
    {
      ...initialChatState(),
      sessionId: SA,
      turnStatus: "waiting",
    } as unknown as ChatState,
    errorMsg(""),
    "空串是会话级消息，任何视图都不认领",
  );
});

test("🔴 sessionId 为空串 / 未绑定视图 → 丢弃", () => {
  assertDropped(
    unboundIdle(),
    errorMsg(""),
    "空串 sessionId 在未绑定视图上同样丢弃",
  );
});

// —— inputHistory 的 sessionId 必须是非空字符串 ——
const BAD_IH_SIDS: [string, Record<string, unknown>][] = [
  ["缺失", {}],
  ["数字", { sessionId: 3 }],
  ["空串", { sessionId: "" }],
];

for (const [label, extra] of BAD_IH_SIDS) {
  test(`🔒 inputHistory 的 sessionId ${label} → 丢弃（不写出字段、不清空既有值）`, () => {
    const before = {
      ...initialChatState(),
      sessionId: SA,
      inputHistory: { sessionId: SA, entries: ["既有的一句"] },
    } as unknown as ChatState;
    assertDropped(
      before,
      msg({ type: "inputHistory", entries: ["新一句"], ...extra }),
      "既有输入历史不许被动",
    );
  });
}

test("🔒 inputHistory.entries 非数组 / 已绑定同会话 → 应用且归一为空数组（既有契约）", () => {
  const after = reduceHostMessage(
    {
      ...initialChatState(),
      sessionId: SA,
      inputHistory: { sessionId: SA, entries: ["旧"] },
    } as unknown as ChatState,
    msg({ type: "inputHistory", sessionId: SA, entries: "不是数组" }),
  ) as unknown as { inputHistory: unknown };
  assert.deepEqual(after.inputHistory, { sessionId: SA, entries: [] });
});

test("🔒 inputHistory.entries 含非字符串元素 / 已绑定同会话 → 过滤掉非字符串项", () => {
  const after = reduceHostMessage(
    boundIdle(SA),
    msg({
      type: "inputHistory",
      sessionId: SA,
      entries: ["好", 1, null, { a: 1 }, "也好"],
    }),
  ) as unknown as { inputHistory: unknown };
  assert.deepEqual(after.inputHistory, {
    sessionId: SA,
    entries: ["好", "也好"],
  });
});

// —— 判定先于归一：不归本视图 ⇒ 直接丢弃，不进归一逻辑、不崩 ——
test("🔒 history.messages 非数组 / 未绑定视图 → 直接丢弃、不抛异常", () => {
  const before = unboundIdle();
  let after: ChatState | undefined;
  assert.doesNotThrow(() => {
    after = reduceHostMessage(
      before,
      msg({ type: "history", sessionId: SA, messages: "坏数据" }),
    );
  });
  assert.deepEqual(after, before);
});

test("🔒 history.messages 非数组 / 已绑定他会话 → 直接丢弃、不抛异常", () => {
  const before = boundIdle(SC);
  let after: ChatState | undefined;
  assert.doesNotThrow(() => {
    after = reduceHostMessage(
      before,
      msg({ type: "history", sessionId: SA, messages: null }),
    );
  });
  assert.deepEqual(after, before);
});

test("🔴 history.inFlight 形状不合法 / 未绑定视图 → 直接丢弃、不崩", () => {
  const before = unboundIdle();
  let after: ChatState | undefined;
  assert.doesNotThrow(() => {
    after = reduceHostMessage(
      before,
      msg({ type: "history", sessionId: SA, messages: [], inFlight: 42 }),
    );
  });
  assert.deepEqual(after, before);
});

test("🔒 streamEvent.event 缺失 / 未绑定视图 → 判定先于分发，丢弃且不崩", () => {
  const before = unboundStreaming();
  let after: ChatState | undefined;
  assert.doesNotThrow(() => {
    after = reduceHostMessage(
      before,
      msg({ type: "streamEvent", sessionId: SA }),
    );
  });
  assert.deepEqual(after, before);
});

test("🔒 streamEvent 未知 kind / 已绑定同会话 → 不改状态、不崩（既有契约）", () => {
  const before = boundStreaming(SA);
  assert.doesNotThrow(() => {
    assertDropped(
      before,
      streamMsg(SA, { kind: "future_kind_2099", x: 1 }),
      "未知 kind 不改状态",
    );
  });
});

// =====================================================================
// §2 判定表 —— 行：usageStats（载荷形状见 INTERFACE-R19 §7.1）
// =====================================================================

/** UsageStats 四字段全必需且有限 */
const U = (input: number, output: number) => ({
  input,
  cacheRead: 0,
  cacheCreation: 0,
  output,
});
const TURN_USAGE = U(1200, 340);
const TOTAL_USAGE = U(9000, 2100);

const usageMsg = (
  sid: string,
  extra: Record<string, unknown> = {},
): HostMessage =>
  msg({
    type: "usageStats",
    sessionId: sid,
    turn: TURN_USAGE,
    total: TOTAL_USAGE,
    ...extra,
  });

const sessionRow = (id: string, itemKey: string, updatedAt: number) => ({
  id,
  title: `会话 ${id}`,
  updatedAt,
  itemKey,
  claudeSessionId: null,
  itemTitle: null,
  usage: null,
});

/** 带两条会话（sA / sC）的已绑定视图 */
const boundWithSessions = (sid: string): ChatState =>
  ({
    ...initialChatState(),
    sessionId: sid,
    sessions: [sessionRow(SA, "ITEM_A", 10), sessionRow(SC, "ITEM_C", 9)],
  }) as unknown as ChatState;

const usageOf = (state: ChatState, id: string): unknown =>
  (state.sessions as unknown as { id: string; usage?: unknown }[]).find(
    (r) => r.id === id,
  )?.usage ?? null;

test("🔒 usageStats / 已绑定同会话 → 应用：turnUsage 与 sessions[].usage 都更新", () => {
  const after = reduceHostMessage(boundWithSessions(SA), usageMsg(SA));
  assert.deepEqual(after.turnUsage, TURN_USAGE, "本轮用量写进 turnUsage");
  assert.deepEqual(
    usageOf(after, SA),
    TOTAL_USAGE,
    "累计用量写进这条会话的 usage",
  );
  assert.equal(usageOf(after, SC), null, "别的会话的 usage 不许被顺带写");
});

test("🔒 usageStats / 已绑定他会话 → 整条丢弃（sessions[].usage 也不更新）", () => {
  assertDropped(
    boundWithSessions(SC),
    usageMsg(SA),
    "绑着 sC 时 sA 的用量一个字段都不许落",
  );
});

test("🔴 usageStats / 未绑定且空闲 → 整条丢弃", () => {
  const before = {
    ...initialChatState(),
    sessionId: null,
    sessions: [sessionRow(SA, "ITEM_A", 10)],
  } as unknown as ChatState;
  assertDropped(before, usageMsg(SA), "空态面板不得显示 A 这一轮的用量");
});

test("🔴 usageStats / 未绑定但已被他会话的开轮 history 点亮 → 整条丢弃", () => {
  const lit = reduceHostMessage(
    {
      ...initialChatState(),
      sessionId: null,
      sessions: [sessionRow(SA, "ITEM_A", 10)],
    } as unknown as ChatState,
    openRoundHistory(SA),
  );
  assertDropped(lit, usageMsg(SA), "即使视图已被串亮，用量也不许再落一层");
});

test("🔒 usageStats 缺 turn（同会话）→ turnUsage 保持原值，不清零不置 null", () => {
  const before = {
    ...boundWithSessions(SA),
    turnUsage: U(5, 6),
  } as unknown as ChatState;
  const after = reduceHostMessage(
    before,
    msg({ type: "usageStats", sessionId: SA, total: TOTAL_USAGE }),
  );
  assert.deepEqual(after.turnUsage, U(5, 6), "缺 turn 时本轮用量原封不动");
  assert.deepEqual(
    usageOf(after, SA),
    TOTAL_USAGE,
    "total 合法就照写（两者互不影响）",
  );
});

test("🔒 usageStats 缺 total（同会话）→ sessions 整体不变", () => {
  const before = boundWithSessions(SA);
  const after = reduceHostMessage(
    before,
    msg({ type: "usageStats", sessionId: SA, turn: TURN_USAGE }),
  );
  assert.deepEqual(
    after.sessions,
    before.sessions,
    "缺 total 时会话列表一个字段都不动",
  );
  assert.deepEqual(after.turnUsage, TURN_USAGE, "turn 合法就照写");
});

// =====================================================================
// §2 判定表 —— 行：attachmentSaved（载荷形状见 INTERFACE-R19 §7.2；经 reduceHostMessage 分发）
// =====================================================================

const attachmentSavedMsg = (sid: string): HostMessage =>
  msg({
    type: "attachmentSaved",
    sessionId: sid,
    turn: 0,
    saved: [],
    rejected: [
      { name: "超大扫描件.pdf", reason: "超过大小上限" },
      { name: "奇怪文件.exe", reason: "类型不支持" },
    ],
  });

const noticeOf = (state: ChatState): unknown =>
  (state as unknown as { attachments: { notice?: unknown } }).attachments
    .notice;

test("🔒 attachmentSaved / 已绑定同会话 → 应用：被拒附件写进 attachments.notice", () => {
  const after = reduceHostMessage(boundIdle(SA), attachmentSavedMsg(SA));
  assert.equal(
    noticeOf(after),
    "超大扫描件.pdf：超过大小上限；奇怪文件.exe：类型不支持",
  );
});

test("🔒 attachmentSaved / 已绑定他会话 → 整条丢弃（notice 也不写）", () => {
  assertDropped(
    boundIdle(SC),
    attachmentSavedMsg(SA),
    "绑着 sC 时不认领 sA 的附件回执",
  );
});

test("🔒 attachmentSaved / 未绑定 → 整条丢弃（今天已如此，不变）", () => {
  assertDropped(
    unboundIdle(),
    attachmentSavedMsg(SA),
    "空态面板不得弹别人的附件提示",
  );
});
