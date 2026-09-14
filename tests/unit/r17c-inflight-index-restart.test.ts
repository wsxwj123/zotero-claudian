// 黑盒复现 — R17c：真实 CLI 形态（一轮多条 assistant 消息，**每条消息的块编号从 0 重启**）
// 下「切走再切回」的恢复，以及切回后 live 事件的路由。
//
// 契约来源（只依据这两份）：.devflow/BRIEF-R17b.md §2 根因 2 / §3 成功标准 P7；
// .devflow/INTERFACE-R17.md §1.2.1（`history.inFlight.blocks` 含 text 块、按 event.index 有序、
// 占位块 index 与后续 live `textDelta.index` 同源；非法 blocks 才回落纯文本占位）。
//
// 事件序来源（真实形态的事实来源）：tests/unit/r14-host-inflight.test.ts 的 T11b ——
// 第二条消息用 `textDelta index:0` **重启编号**。r17b-p7 用例里「编号延续到 index 2」的形态
// 不是真实 CLI 形态（本次仍保留一条回归锁，见 T-P7R-g）。
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

const MSG1_TEXT = "第一段：先读摘要。";
const MSG2_TEXT = "第二段：正在流式输出。";
const CONTINUATION = "（续）";
const TOOL_NAME = "Read";
const TOOL_INPUT = '{"file":"a.pdf"}';
const TOOL_SUMMARY = "读到 3 页，方法在第 2 节。";

// ---------- 事件序（真实 CLI 形态） ----------

/** 消息 1：块 0 = 正文（消息定稿），块 1 = 工具调用（结果尚未到达） */
const MESSAGE_1_WITH_TOOL: TurnEvent[] = [
  { kind: "messageStart" },
  { kind: "textBlockStart", index: 0 },
  { kind: "textDelta", index: 0, text: MSG1_TEXT },
  { kind: "assistantMessage", content: [{ type: "text", text: MSG1_TEXT }] },
  { kind: "toolBlockStart", index: 1, toolName: TOOL_NAME, toolUseId: "tu-1" },
  { kind: "toolInputDelta", index: 1, jsonFragment: TOOL_INPUT },
] as TurnEvent[];

/** 消息 2 开头：块编号**从 0 重启**（T11b 同款形态） */
const MESSAGE_2_STARTS: TurnEvent[] = [
  { kind: "messageStart" },
  { kind: "textBlockStart", index: 0 },
  { kind: "textDelta", index: 0, text: MSG2_TEXT },
] as TurnEvent[];

/** 消息 2 含一次正文 + 一次工具调用：块 0 = 正文、块 1 = 工具（与消息 1 的编号再次相撞） */
const MESSAGE_2_WITH_TOOL: TurnEvent[] = [
  { kind: "messageStart" },
  { kind: "textBlockStart", index: 0 },
  { kind: "textDelta", index: 0, text: MSG2_TEXT },
  { kind: "toolBlockStart", index: 1, toolName: "Grep", toolUseId: "tu-2" },
  { kind: "toolInputDelta", index: 1, jsonFragment: '{"pattern":"methods"}' },
] as TurnEvent[];

/** 消息 1 那次工具调用先拿到结果（用户切走之前） */
const TOOL_A_RESULT: TurnEvent = {
  kind: "toolResult",
  toolUseId: "tu-1",
  isError: false,
  summary: "A 的结果",
} as TurnEvent;

// ---------- 夹具 ----------

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

interface MidRound {
  fx: ReturnType<typeof makeBridge>;
  win: object;
  sid: string;
}

/** 建会话 → 发问 → 把 events 喂进本轮；返回中途暂停点 */
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

/** 本轮里所有 assistant 轮的可见正文，按顺序拼接（= 用户在这一轮里看到的文字） */
function roundText(state: ChatState): string {
  return state.messages
    .filter((t) => t.role === "assistant")
    .map(visibleText)
    .join("");
}

interface ToolCardView {
  blockType: string;
  index?: number;
  toolName?: string;
  inputJson?: string;
  result?: { isError: boolean; summary: string } | null;
  streaming?: boolean;
}

const toolCardsOf = (state: ChatState): ToolCardView[] =>
  state.messages
    .filter((t) => t.role === "assistant")
    .flatMap((t) => (t.blocks ?? []) as unknown as ToolCardView[])
    .filter((b) => b.blockType === "tool");

const cardNamed = (cards: ToolCardView[], name: string): ToolCardView => {
  const found = cards.filter((c) => c.toolName === name);
  assert.equal(
    found.length,
    1,
    `期望恰有一张「${name}」卡，实际 ${found.length} 张（全部卡片 = ${JSON.stringify(
      cards.map((c) => c.toolName),
    )}）`,
  );
  return found[0];
};

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ---------- 1. 切回后正文不得串味、不得丢失 ----------

// 「不得丢失」这一半在当前工作区已成立（宿主半修已把两段都产出），故标 🔒：它锁住这一半，
// 后续修「index 撞车」时不得把第一段修没。真正红的在 T-P7R-b（增量被追写到两段上）。
test("T-P7R-a 🔒 切回后两段正文都在：第二条消息的块编号从 0 重启不得吞掉第一段", async () => {
  const m = await playRound([...MESSAGE_1_WITH_TOOL, ...MESSAGE_2_STARTS]);
  const view = apply(reboundEmptyView(m), await askHistory(m));

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `切走前已经显示出来的正文必须还在：期望含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  assert.ok(
    shown.includes(MSG2_TEXT),
    `切回时正在流式的那段也必须重建出来：期望含「${MSG2_TEXT}」，实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `第一段只能出现一次（不得重建出两份）：实际「${shown}」`,
  );
});

// 工具跑着的那几分钟正是用户切走/切回的高频时刻：此时本轮**没有**正在流式的正文
// （第一条消息已定稿 ⇒ assistantText 为空）。已定稿的正文与工具卡仍必须重建出来。
test("T-P7R-a2 🔒 切回时本轮只有「已定稿正文 + 在跑的工具」：正文与工具卡都要在", async () => {
  const m = await playRound(MESSAGE_1_WITH_TOOL);
  const view = apply(reboundEmptyView(m), await askHistory(m));

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `已定稿的正文必须还在（此时没有正在流式的段）：期望含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  const cards = toolCardsOf(view);
  assert.equal(
    cards.length,
    1,
    `在跑的工具卡要重建出来，实际 ${cards.length} 张`,
  );
  assert.equal(cards[0].toolName, TOOL_NAME);
  assert.equal(cards[0].inputJson, TOOL_INPUT, "入参要重建出来");
});

test("T-P7R-b 🔴 切回后到达的 live 增量只增长当前那段：第一段一个字符都不许被追写", async () => {
  const m = await playRound([...MESSAGE_1_WITH_TOOL, ...MESSAGE_2_STARTS]);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  view = apply(
    view,
    streamDelta(m, { kind: "textDelta", index: 0, text: CONTINUATION }),
  );

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG2_TEXT + CONTINUATION),
    `增量必须接在第二段尾部：期望含「${MSG2_TEXT + CONTINUATION}」，实际「${shown}」`,
  );
  assert.ok(
    !shown.includes(MSG1_TEXT + CONTINUATION),
    `增量不得被追写到第一段上（不得出现「${MSG1_TEXT + CONTINUATION}」）：实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `第一段必须保持原样、只出现一次：实际「${shown}」`,
  );
});

// ---------- 2. 占位轮里的工具必须能拿到结果 ----------

test("T-P7R-c 🔴 切回时在跑的工具卡：真实 toolResult 到达后必须显示结果，不得永久「运行中」", async () => {
  const m = await playRound([...MESSAGE_1_WITH_TOOL, ...MESSAGE_2_STARTS]);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  const before = toolCardsOf(view);
  assert.equal(
    before.length,
    1,
    `夹具自检：切回时占位里恰有一张工具卡，实际 ${before.length} 张`,
  );
  assert.equal(before[0].inputJson, TOOL_INPUT, "夹具自检：入参已重建");
  assert.ok(
    !before[0].result,
    "夹具自检：切回那一刻这张卡还没有结果（工具正在跑）",
  );

  view = apply(
    view,
    streamDelta(m, {
      kind: "toolResult",
      toolUseId: "tu-1",
      isError: false,
      summary: TOOL_SUMMARY,
    }),
  );

  const cards = toolCardsOf(view);
  assert.equal(cards.length, 1, "结果到达后仍是同一张卡（不得变成两张或零张）");
  assert.ok(
    cards[0].result,
    "工具结果必须落到这张卡上（不得永久停在「运行中」）",
  );
  assert.equal(
    cards[0].result?.summary,
    TOOL_SUMMARY,
    "卡上显示的必须是这次的结果",
  );
  assert.ok(
    !cards[0].streaming,
    "卡必须转成非流式态（streaming 不得仍为 true）",
  );
  assert.equal(cards[0].inputJson, TOOL_INPUT, "入参不被结果事件抹掉");
});

// ---------- 3. 同一轮里第二次工具调用要建新卡 ----------

const TWO_TOOL_ROUND: TurnEvent[] = [
  ...MESSAGE_1_WITH_TOOL,
  TOOL_A_RESULT,
  ...MESSAGE_2_WITH_TOOL,
];

// 「两张卡都在、入参不串」当前工作区已成立（实测绿），标 🔒 锁住；红的在 T-P7R-e：
// 切回后到达的结果事件落不到占位卡上（占位卡的 toolUseId 是空串，匹配不上）。
test("T-P7R-d 🔒 一轮两次工具调用（编号重启）：切回后两张卡都在、入参不串", async () => {
  const m = await playRound(TWO_TOOL_ROUND);
  const view = apply(reboundEmptyView(m), await askHistory(m));

  const cards = toolCardsOf(view);
  assert.deepEqual(
    cards.map((c) => c.toolName).sort(),
    ["Grep", "Read"],
    `两次工具调用 = 两张卡，不得合成一张、也不得丢一张（实际 = ${JSON.stringify(
      cards.map((c) => c.toolName),
    )}）`,
  );
  assert.equal(
    cardNamed(cards, "Read").inputJson,
    TOOL_INPUT,
    "第一张卡的入参不得被第二次调用覆盖",
  );
  assert.equal(
    cardNamed(cards, "Grep").inputJson,
    '{"pattern":"methods"}',
    "第二张卡的入参是自己的",
  );
  assert.equal(
    cardNamed(cards, "Read").result?.summary,
    "A 的结果",
    "切走前已经拿到结果的那张卡，切回后要带着结果，不得退回「运行中」",
  );
});

test("T-P7R-e 🔴 第二个工具的结果只进第二张卡：第一张卡的结果不被覆盖", async () => {
  const m = await playRound(TWO_TOOL_ROUND);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  view = apply(
    view,
    streamDelta(m, {
      kind: "toolResult",
      toolUseId: "tu-2",
      isError: false,
      summary: "B 的结果",
    }),
  );

  const cards = toolCardsOf(view);
  assert.equal(cards.length, 2, "结果到达后仍是两张卡");
  assert.equal(
    cardNamed(cards, "Grep").result?.summary,
    "B 的结果",
    "第二个工具的结果必须进它自己的卡",
  );
  assert.equal(
    cardNamed(cards, "Read").result?.summary,
    "A 的结果",
    "第一张卡的结果不得被第二个结果覆盖",
  );
});

// ---------- 4. 回归锁 ----------

test("T-P7R-f 🔒 不切走的普通流式：两段正文照常显示，后续增量接在当前段", async () => {
  const m = await playRound([...MESSAGE_1_WITH_TOOL, ...MESSAGE_2_STARTS]);
  let view = liveView(m);

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG1_TEXT),
    `已定稿的正文照常显示：期望含「${MSG1_TEXT}」，实际「${shown}」`,
  );
  assert.ok(
    shown.includes(MSG2_TEXT),
    `正在流式的那段照常显示：期望含「${MSG2_TEXT}」，实际「${shown}」`,
  );

  view = apply(
    view,
    streamDelta(m, { kind: "textDelta", index: 0, text: CONTINUATION }),
  );
  const after = roundText(view);
  assert.ok(
    after.includes(MSG2_TEXT + CONTINUATION),
    `增量接在当前段尾部：期望含「${MSG2_TEXT + CONTINUATION}」，实际「${after}」`,
  );
  assert.equal(
    countOf(after, MSG1_TEXT),
    1,
    `第一段仍是原样一份：实际「${after}」`,
  );
});

test("T-P7R-g 🔒 旧约定（第二条消息编号延续到 index 2）仍按旧约定工作", async () => {
  const m = await playRound([
    ...MESSAGE_1_WITH_TOOL,
    { kind: "messageStart" },
    { kind: "textBlockStart", index: 2 } as TurnEvent,
    { kind: "textDelta", index: 2, text: MSG2_TEXT } as TurnEvent,
  ]);
  let view = apply(reboundEmptyView(m), await askHistory(m));

  assert.ok(roundText(view).includes(MSG1_TEXT), "旧形态下第一段也要在");
  view = apply(
    view,
    streamDelta(m, { kind: "textDelta", index: 2, text: CONTINUATION }),
  );

  const shown = roundText(view);
  assert.ok(
    shown.includes(MSG2_TEXT + CONTINUATION),
    `index 2 的增量仍要落到第二段：期望含「${MSG2_TEXT + CONTINUATION}」，实际「${shown}」`,
  );
  assert.equal(
    countOf(shown, MSG1_TEXT),
    1,
    `第一段仍是原样一份：实际「${shown}」`,
  );
});
