// 黑盒复现 — R17d：**不撞车**形态（一轮里相邻两条消息的块「编号 + 类型」都不撞车）
// 下「切走再切回」的恢复，以及切回后 live 事件与「后一条消息定稿」的相互影响。
//
// 形态（真实 CLI：每条消息的块编号从 0 重新计数，见 r14-host-inflight.test.ts T11b 真形态）：
//   消息 1 = 思考块 0 + 正文块 1（正文「甲段」，已定稿）
//   消息 2 = 正文块 0（「乙段」，正在流式）
// 「不撞车」= 两消息里没有任何 (index, blockType) 相同的一对：
//   消息 2 的 正文@0 对上的是消息 1 的 思考@0（类型不同）；消息 1 的 正文@1 在消息 2 里没有对应块。
//
// 契约来源（只依据这两份）：.devflow/BRIEF-R17b.md §3 成功标准 P7；
// .devflow/INTERFACE-R17.md §1.2.1（`history.inFlight.blocks` 含 text 块、按 message 分组、
// 占位块 index 与后续 live `textDelta.index` 同源、`blocks` 缺失才回落纯文本占位）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantTurnContent,
  initialChatState,
  reduceHostMessage,
  selectSession,
  type ChatState,
  type Turn,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { TurnEvent } from "../../src/modules/cliRunner.ts";
import { makeBridge, tick } from "./helpers/r17Bridge.ts";

const ITEM = "ITEM_A";
const QUESTION = "帮我看看这篇论文的方法部分";

const MSG1_THINK = "先定位方法一节。";
const MSG1_TEXT = "甲段：方法用的是对比学习。";
const MSG2_TEXT = "乙段：结论部分我还在读。";
const CONTINUATION = "（续）";
/** 消息 2 定稿时它自己的完整正文 */
const MSG2_FULL = MSG2_TEXT + CONTINUATION;

// ---------- 事件序（真实 CLI 形态：每条消息编号从 0 重数） ----------

/** 消息 1：思考块 0 + 正文块 1，随后定稿（真机 E4b 形态：末次 content 只列正文） */
const MESSAGE_1_FINAL: TurnEvent[] = [
  { kind: "messageStart" },
  { kind: "thinkingDelta", index: 0, text: MSG1_THINK },
  { kind: "textBlockStart", index: 1 },
  { kind: "textDelta", index: 1, text: MSG1_TEXT },
  { kind: "assistantMessage", content: [{ type: "text", text: MSG1_TEXT }] },
] as TurnEvent[];

/** 消息 2 开头：只有正文块 0（与消息 1 的编号/类型都不撞车） */
const MESSAGE_2_STARTS: TurnEvent[] = [
  { kind: "messageStart" },
  { kind: "textBlockStart", index: 0 },
  { kind: "textDelta", index: 0, text: MSG2_TEXT },
] as TurnEvent[];

/** 消息 2 定稿：该条的最终文本事件，正文 = 它自己完整的一段 */
const MESSAGE_2_FINAL = {
  kind: "assistantMessage",
  content: [{ type: "text", text: MSG2_FULL }],
} as TurnEvent;

const CONTINUE_EVENT = {
  kind: "textDelta",
  index: 0,
  text: CONTINUATION,
} as TurnEvent;

// ---------- 夹具 ----------

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

interface MidRound {
  fx: ReturnType<typeof makeBridge>;
  win: object;
  sid: string;
}

/** 建会话 → 发问 → 把 events 喂进本轮；返回中途暂停点（用户此刻切走） */
async function playRound(events: TurnEvent[]): Promise<MidRound> {
  const fx = makeBridge();
  const win = {};
  fx.register(win);
  await tick();

  fx.bridge.dispatch({
    source: win,
    data: { type: "createSession", itemKey: ITEM },
  });
  await tick();
  const sid = fx.store.list()[0].id;

  fx.bridge.dispatch({
    source: win,
    data: { type: "send", text: QUESTION, sessionId: sid },
  });
  await tick(4);
  const turn = fx.turns[fx.turns.length - 1];
  assert.ok(turn, "夹具自检：本轮进程已 spawn");

  for (const ev of events) {
    turn.emit(ev);
  }
  await tick(4);
  return { fx, win, sid };
}

/** 切回后的空视图（刚绑定这个会话，历史尚未到达） */
function reboundEmptyView(m: MidRound): ChatState {
  let state = apply(initialChatState(), { type: "init" } as HostMessage);
  state = apply(state, {
    type: "sessionList",
    sessions: m.fx.store.list(),
  } as unknown as HostMessage);
  if (state.sessionId !== m.sid) {
    state = selectSession(state, m.sid).state;
  }
  assert.equal(state.sessionId, m.sid, "夹具自检：已绑定目标会话");
  assert.equal(state.messages.length, 0, "夹具自检：刚切回，本地视图为空");
  return state;
}

/** 从某点起向宿主索要一次全量历史（= 实例重新绑定时收到的在途轮数据） */
async function askHistory(m: MidRound): Promise<HostMessage> {
  const mark = m.fx.sent.length;
  m.fx.bridge.dispatch({
    source: m.win,
    data: { type: "getHistory", sessionId: m.sid },
  });
  await tick();
  const got = m.fx.sent
    .slice(mark)
    .filter((x) => x.win === m.win && x.msg.type === "history")
    .map((x) => x.msg);
  assert.equal(got.length, 1, "getHistory 恰回一条 history");
  return got[0];
}

/** 页面从头到尾收到的每一份宿主消息（不切走的那条路径） */
function liveView(m: MidRound): ChatState {
  let state = apply(initialChatState(), { type: "init" } as HostMessage);
  for (const s of m.fx.sent) {
    if (s.win !== m.win) {
      continue;
    }
    state = apply(state, s.msg);
  }
  return state;
}

const streamDelta = (m: MidRound, event: TurnEvent): HostMessage =>
  ({
    type: "streamEvent",
    sessionId: m.sid,
    event,
  }) as unknown as HostMessage;

// ---------- 视图读取 ----------

/** 该条 assistant 轮的可见正文（text 块拼接；无 blocks 时退回纯文本） */
function visibleText(turn: Turn): string {
  const content = assistantTurnContent(turn);
  if (content.kind === "markdown") {
    return content.text ?? "";
  }
  return content.blocks
    .filter((b) => b.blockType === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

/** 本会话所有 assistant 轮的可见正文，按顺序拼接（= 用户在这一轮里看到的文字） */
function roundText(state: ChatState): string {
  return state.messages
    .filter((t) => t.role === "assistant")
    .map(visibleText)
    .join("");
}

const assistantTurns = (state: ChatState): Turn[] =>
  state.messages.filter((t) => t.role === "assistant");

/** 空气泡 = 一条 assistant 轮既没有任何块、也没有一个字的正文 */
const isEmptyBubble = (turn: Turn): boolean => {
  const content = assistantTurnContent(turn);
  return content.kind === "markdown" && (content.text ?? "").trim() === "";
};

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ---------- 1. 切回后的重建：两段正文都得在、都得是原样 ----------

test("T-P7D-a 切回后甲段与乙段都在：不撞车形态下第一段不得丢、不得重出一份", async () => {
  const m = await playRound([...MESSAGE_1_FINAL, ...MESSAGE_2_STARTS]);
  const view = apply(reboundEmptyView(m), await askHistory(m));

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `切走前已定稿的甲段必须还在：期望含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  assert.ok(
    shown.includes(MSG2_TEXT),
    `切回时正在流式的乙段也必须重建出来：期望含「${MSG2_TEXT}」，实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `甲段只能出现一次（不得重建出两份）：实际「${shown}」`,
  );
});

// ---------- 2. 切回后到达的增量只进当前段 ----------

test("T-P7D-b 切回后到达的流式增量只增长到乙段：甲段一个字符都不许被追加", async () => {
  const m = await playRound([...MESSAGE_1_FINAL, ...MESSAGE_2_STARTS]);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  view = apply(view, streamDelta(m, CONTINUE_EVENT));

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG2_TEXT + CONTINUATION),
    `增量必须接在乙段尾部：期望含「${MSG2_TEXT + CONTINUATION}」，实际「${shown}」`,
  );
  assert.ok(
    !shown.includes(MSG1_TEXT + CONTINUATION),
    `增量不得被追写到甲段上（不得出现「${MSG1_TEXT + CONTINUATION}」）：实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `甲段必须保持原样、只出现一次：实际「${shown}」`,
  );
});

// ---------- 3. 后一条消息定稿：前一条已定稿的正文不得消失、不得被改写 ----------

test("T-P7D-c 第二条消息定稿后甲段仍在且逐字不变", async () => {
  const m = await playRound([...MESSAGE_1_FINAL, ...MESSAGE_2_STARTS]);
  let view = apply(reboundEmptyView(m), await askHistory(m));
  view = apply(view, streamDelta(m, CONTINUE_EVENT));

  view = apply(view, streamDelta(m, MESSAGE_2_FINAL));

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `第二条消息定稿不得把甲段弄没：期望仍含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  assert.ok(
    !shown.includes(MSG1_TEXT + CONTINUATION),
    `定稿不得把乙段的正文并到甲段后面：不得出现「${MSG1_TEXT + CONTINUATION}」，实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `甲段必须逐字不变、只出现一次：实际「${shown}」`,
  );
  assert.equal(
    shown,
    MSG1_TEXT + MSG2_FULL,
    `定稿后视图里应恰是两段正文、按先甲后乙排列：实际「${shown}」`,
  );
});

// ---------- 4. 反向断言：全程不得留空气泡 ----------

test("T-P7D-d 反向：切回重建 + 后续增量 + 定稿全程，不得留下空气泡", async () => {
  const m = await playRound([...MESSAGE_1_FINAL, ...MESSAGE_2_STARTS]);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  const afterRebuild = assistantTurns(view).filter(isEmptyBubble);
  assert.equal(
    afterRebuild.length,
    0,
    `切回重建不得建出空白气泡（实际 ${afterRebuild.length} 条空白）`,
  );

  view = apply(view, streamDelta(m, CONTINUE_EVENT));
  view = apply(view, streamDelta(m, MESSAGE_2_FINAL));

  const atEnd = assistantTurns(view).filter(isEmptyBubble);
  assert.equal(
    atEnd.length,
    0,
    `增量与定稿处理完也不得留下空白气泡（实际 ${atEnd.length} 条空白）`,
  );
});

// ---------- 5. 回归锁：不切走的普通流式观感不变 ----------

test("T-P7D-e 回归锁：不切走的普通流式，两段都在、增量只进当前段", async () => {
  const m = await playRound([...MESSAGE_1_FINAL, ...MESSAGE_2_STARTS]);
  let view = liveView(m);

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `已定稿的甲段照常显示：期望含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  assert.ok(
    shown.includes(MSG2_TEXT),
    `正在流式的乙段照常显示：期望含「${MSG2_TEXT}」，实际「${shown}」`,
  );

  view = apply(view, streamDelta(m, CONTINUE_EVENT));

  const after = roundText(view);
  assert.ok(
    after.includes(MSG2_TEXT + CONTINUATION),
    `增量接在当前段尾部：期望含「${MSG2_TEXT + CONTINUATION}」，实际「${after}」`,
  );
  assert.ok(
    !after.includes(MSG1_TEXT + CONTINUATION),
    `增量不得被追写到甲段上：实际「${after}」`,
  );
  assert.equal(
    countOf(after, MSG1_TEXT),
    1,
    `甲段仍是原样一份：实际「${after}」`,
  );
});
