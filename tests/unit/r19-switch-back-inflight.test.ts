// 单测 — R19 §4「切走再切回：在途轮重建」+ BRIEF-R19 §3 成功标准 1 的端到端串屏复现
//
// 契约来源：.devflow/INTERFACE-R19.md §2/§4、BRIEF-R19 §3。黑盒：只按契约写，不看实现。
// 场景一句话：文献 A 的面板发了消息还没回 → 用户切到没有会话的文献 B → B 必须一片空白，
//            A 这一轮的任何消息都不许改 B；切回 A 时这一轮要原样长回来。
//
// 本文件红/绿计数（改动时同步更新）：🔴 修前必红 = 5 条；🔒 修前就绿 = 10 条。合计 15 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followReader,
  initialChatState,
  reduceHostMessage,
  userSend,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

const SA = "sA";
const ITEM_A = "ITEM_AAAA";
const ITEM_B = "ITEM_BBBB"; // 一篇还没有任何会话的文献
const QUESTION = "A 里发出的这一问：帮我把第 3 节的实验设置讲清楚";

const msg = (m: Record<string, unknown>): HostMessage =>
  m as unknown as HostMessage;

const sessionRow = (id: string, itemKey: string, updatedAt: number) => ({
  id,
  title: `会话 ${id}`,
  updatedAt,
  itemKey,
  claudeSessionId: null,
  itemTitle: null,
});

/** 文献 A 的面板：绑着 sA，刚发出一条消息，CLI 还没回（在途） */
function viewOfAInFlight(): ChatState {
  const bound = {
    ...initialChatState(),
    sessionId: SA,
    sessions: [sessionRow(SA, ITEM_A, 10)],
  } as unknown as ChatState;
  const after = userSend(bound, QUESTION).state;
  assert.equal(after.sessionId, SA, "夹具自检：仍绑在 sA");
  assert.notEqual(after.turnStatus, "idle", "夹具自检：这一轮在途");
  assert.equal(
    after.messages.filter((m) => m.role === "user").length,
    1,
    "夹具自检：乐观用户气泡已在列",
  );
  return after;
}

/** 用户把阅读器切到没有会话的文献 B ⇒ 面板变成合法的未绑定空态 */
function switchToEmptyItemB(state: ChatState): ChatState {
  const r = followReader(state, ITEM_B);
  assert.equal(r.state.sessionId, null, "夹具自检：B 没有会话 ⇒ 视图未绑定");
  return r.state;
}

/** A 在途轮期间宿主广播出来的、带 sessionId 的六类会话级消息 */
const A_SESSION_MESSAGES: [string, HostMessage][] = [
  [
    "history 开轮广播",
    msg({
      type: "history",
      sessionId: SA,
      messages: [],
      inFlight: {
        userText: QUESTION,
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
      messages: [{ role: "user", text: QUESTION, ts: 1 }],
    }),
  ],
  [
    "streamEvent textDelta",
    msg({
      type: "streamEvent",
      sessionId: SA,
      event: { kind: "textDelta", index: 0, text: "A 的回答正文" },
    }),
  ],
  [
    "streamEvent result",
    msg({
      type: "streamEvent",
      sessionId: SA,
      event: {
        kind: "result",
        claudeSessionId: "cli-a",
        numTurns: 1,
        costUsd: 0.01,
        durationMs: 100,
        isError: false,
      },
    }),
  ],
  [
    "inputHistory",
    msg({ type: "inputHistory", sessionId: SA, entries: [QUESTION] }),
  ],
  [
    "error 带 sessionId",
    msg({
      type: "error",
      code: "SESSION_GONE",
      message: "A 的会话没了",
      sessionId: SA,
    }),
  ],
];

// =====================================================================
// 切走：B 视图必须空白，且 A 的每一类会话级消息都不改它
// =====================================================================

test("🔒 在途时切到没有会话的文献 B → 面板立刻变成未绑定空态（在途轮标记一并清掉）", () => {
  const b = switchToEmptyItemB(viewOfAInFlight());
  assert.equal(b.sessionId, null);
  assert.deepEqual(b.messages, [], "B 的面板里一条消息都不该有");
  assert.equal(b.turnStatus, "idle", "状态条回到空闲：B 没有自己的在途轮");
});

for (const [label, m] of A_SESSION_MESSAGES) {
  // 注：`streamEvent` 两条在修前就绿——刚切过来的 B 是空闲态，流事件被「turn 未进行中」守卫挡下；
  //     真正把 B 点亮的第一张多米诺骨牌是开轮广播的 history（见下面的连发用例）。故标记按实测口径给。
  test(`${label.startsWith("streamEvent") ? "🔒" : "🔴"} 切到空文献 B 后，A 的「${label}」到达 → B 视图一个字段都不变`, () => {
    const before = switchToEmptyItemB(viewOfAInFlight());
    const after = reduceHostMessage(before, m);
    assert.deepEqual(after, before, `B 的面板不得被 A 的「${label}」改动`);
  });
}

test("🔴 A 的六类消息接连到达 B → B 依然是空态（无气泡、无正文、无横幅、状态条空闲）", () => {
  const empty = switchToEmptyItemB(viewOfAInFlight());
  let b = empty;
  for (const [, m] of A_SESSION_MESSAGES) {
    b = reduceHostMessage(b, m);
  }
  assert.deepEqual(b.messages, [], "B 不得出现 A 这一轮的用户气泡或流式正文");
  assert.equal(b.turnStatus, "idle", "B 的状态条不得被 A 点亮");
  assert.equal(b.errorBanner, null, "B 不得弹出 A 的错误横幅");
  assert.deepEqual(b, empty, "整个状态对象与刚切过来时完全一致");
});

// =====================================================================
// 切回：§4 在途轮完整重建（R17 P7 不回归）
// =====================================================================

/** 宿主在换绑定时回的 history：全量落盘行 + 在途轮 */
const historyWithInFlight = (
  rows: Record<string, unknown>[],
  inFlight: Record<string, unknown>,
): HostMessage =>
  msg({ type: "history", sessionId: SA, messages: rows, inFlight });

const INFLIGHT = {
  userText: QUESTION,
  assistantText: "正在整理第 3 节的实验设置……",
  busy: "running",
  baseRows: 2,
  blocks: [],
};

/** 走完「A 在途 → 切到空文献 B → 切回 A」三步，返回重新绑定但历史还没到的视图 */
function switchedBackToA(): ChatState {
  const b = switchToEmptyItemB(viewOfAInFlight());
  const r = followReader(b, ITEM_A);
  assert.equal(r.state.sessionId, SA, "切回 A ⇒ 重新绑定 sA");
  assert.equal(r.changed, true, "changed=true ⇒ 调用方据此补发一次 getHistory");
  return r.state;
}

test("🔒 切回 A → 视图重新绑定 sA 并要求补拉历史（changed=true）", () => {
  const back = switchedBackToA();
  assert.equal(back.sessionId, SA);
});

test("🔒 切回 A 后收到带 inFlight 的 history → 用户气泡在列、状态条非 idle", () => {
  const view = reduceHostMessage(
    switchedBackToA(),
    historyWithInFlight(
      [
        { role: "user", text: "更早的一问", ts: 1 },
        { role: "assistant", text: "更早的一答", ts: 2 },
      ],
      INFLIGHT,
    ),
  );
  const users = view.messages
    .filter((m) => m.role === "user")
    .map((m) => m.text);
  assert.deepEqual(
    users,
    ["更早的一问", QUESTION],
    "落盘历史 + 在途轮的提问都在",
  );
  assert.notEqual(view.turnStatus, "idle", "在途轮的状态条必须回到「进行中」");
});

/**
 * §4 / 修订 r2-2：重建出来的 assistant 轮**没有 text 字段**，正文一律在 blocks[].text 里。
 * 断言必须读 blocks，不许读 turn.text。
 */
const assistantBlockText = (state: ChatState): string =>
  state.messages
    .filter((m) => m.role === "assistant")
    .flatMap(
      (m) => (m as unknown as { blocks?: { text?: string }[] }).blocks ?? [],
    )
    .map((b) => b.text ?? "")
    .join("");

test("🔒 切回 A 后重建：这一轮的提问就是切走前发出的那句，且只有这一轮", () => {
  const view = reduceHostMessage(
    switchedBackToA(),
    historyWithInFlight([], INFLIGHT),
  );
  assert.deepEqual(
    view.messages.filter((m) => m.role === "user").map((m) => m.text),
    [QUESTION],
  );
});

test("🔒 切回 A 后重建的在途轮带上了宿主已产出的半截正文（assistantText 不丢）", () => {
  const view = reduceHostMessage(
    switchedBackToA(),
    historyWithInFlight([], INFLIGHT),
  );
  assert.equal(
    assistantBlockText(view),
    "正在整理第 3 节的实验设置……",
    "半截正文必须落在 assistant 轮的 blocks[].text 上",
  );
  assert.equal(
    view.messages.find((m) => m.role === "assistant")?.text ?? null,
    null,
    "r2-2：重建出来的 assistant 轮没有 text 字段",
  );
});

test("🔒 切回 A 并重建后，A 的后续流事件正常续接到这一轮", () => {
  let view = reduceHostMessage(
    switchedBackToA(),
    historyWithInFlight([], INFLIGHT),
  );
  // 切回时这一轮还在跑，宿主不会重放 messageStart —— 后续增量直接续到重建出来的那个文本块上
  view = reduceHostMessage(
    view,
    msg({
      type: "streamEvent",
      sessionId: SA,
      event: { kind: "textDelta", index: 0, text: "：作者用了三个数据集。" },
    }),
  );
  assert.equal(
    assistantBlockText(view),
    "正在整理第 3 节的实验设置……：作者用了三个数据集。",
    "后续增量必须续接到重建出来的那个文本块上，不新起一轮",
  );
});

test("🔒 inFlight 带过程块时重建不崩，且用户气泡仍在列", () => {
  let view: ChatState | undefined;
  assert.doesNotThrow(() => {
    view = reduceHostMessage(
      switchedBackToA(),
      historyWithInFlight([], {
        ...INFLIGHT,
        blocks: [
          {
            kind: "tool",
            index: 1,
            toolName: "Read",
            message: "读取 paper.pdf",
          },
        ],
      }),
    );
  });
  assert.ok(
    view?.messages.some((m) => m.role === "user" && m.text === QUESTION),
    "重建后在途轮的用户气泡必须在",
  );
});

// r2-2 回落路径：blocks 为空且 assistantText 也为空 ⇒ 不建 assistant 轮
test("🔒 切回 A：inFlight 的 blocks 与 assistantText 都为空 → 只重建用户气泡，不造空的回答轮", () => {
  const view = reduceHostMessage(
    switchedBackToA(),
    historyWithInFlight([], { ...INFLIGHT, assistantText: "", blocks: [] }),
  );
  assert.deepEqual(
    view.messages.map((m) => m.role),
    ["user"],
    "没有任何正文时不该凭空多出一个 assistant 轮",
  );
});

// ⚠️ 未覆盖：「inFlight.blocks 非空 ⇒ 它是真相」这一条（r2-2 首选路径）。
//    合法 block 的字段形状被 r2-2 转指 INTERFACE-R17 §1.2.1，而该文件不在本轮输入白名单内；
//    手搓的 {blockType:"text", index, text} 不被接受（实测回落到了 assistantText 路径），
//    写出来只会是「按我猜的形状断言」，不如留空并把缺口讲清楚。见 TEST-PLAN-R19「没覆盖什么」。
