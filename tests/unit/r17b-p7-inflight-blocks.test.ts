// 黑盒复现 — R17b / P7「工具轮里切走再切回，正文与过程块消失」
//
// 契约来源（只依据这两份）：.devflow/BRIEF-R17b.md §1.2/§2 根因 2、§3 成功标准 P7；
// .devflow/INTERFACE-R17.md §1.2.1（`history.inFlight.blocks`：含 text 块、按 index 有序、
// 非法输入整条按无 blocks 回落、`assistantText` 语义不动）。
//
// 场景（桥侧真实驱动）：messageStart → textDelta("第一段") → toolBlockStart/toolInputDelta
// → assistantMessage（这一条定稿）→ messageStart → textDelta("第二段")（正在流式）。
// 这正是用户看到的「回答已经显示出来了，切走再切回就白掉」的那一刻。
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
import { groupRounds } from "../../src/chat/lib/roundStrip.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { TurnEvent } from "../../src/modules/cliRunner.ts";
import { inFlightOf, makeBridge, tick } from "./helpers/r17Bridge.ts";

const ITEM = "ITEM_A";
const QUESTION = "帮我看看这篇论文的方法部分";
const FIRST = "第一段：先读摘要。";
const SECOND = "第二段：正在流式输出。";
const TOOL = "Read";

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

/** 该条历史里 assistant 轮的可见正文（text 块拼接；无 blocks 时退回纯文本） */
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

const blockKinds = (turn: Turn): string[] =>
  (turn.blocks ?? []).map((b) => b.blockType);

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

interface MidRound {
  fx: ReturnType<typeof makeBridge>;
  win: object;
  sid: string;
}

/** 驱动一次完整的「工具轮」到「第二段正在流式」的中途暂停点 */
async function midRoundWithTool(): Promise<MidRound> {
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

  const events: TurnEvent[] = [
    { kind: "messageStart" },
    { kind: "textBlockStart", index: 0 },
    { kind: "textDelta", index: 0, text: FIRST },
    { kind: "toolBlockStart", index: 1, toolName: TOOL, toolUseId: "tu-1" },
    { kind: "toolInputDelta", index: 1, jsonFragment: '{"file":"a.pdf"}' },
    { kind: "assistantMessage", content: [{ type: "text", text: FIRST }] },
    { kind: "messageStart" },
    { kind: "textBlockStart", index: 2 },
    { kind: "textDelta", index: 2, text: SECOND },
  ] as TurnEvent[];
  for (const ev of events) {
    turn.emit(ev);
  }
  await tick(4);
  return { fx, win, sid };
}

/** 从某点起，向宿主索要一次全量历史（= 实例重新绑定时的回执） */
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

/** 重新绑定后的空视图（刚切回这个会话，历史尚未到达） */
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

// ---------- T-P7-a：换绑定回执里的在途轮块 ----------

test("T-P7-a 🔴 getHistory 回执的 inFlight.blocks 含已定稿正文段与工具块，按 index 有序", async () => {
  const m = await midRoundWithTool();
  const inFlight = inFlightOf(await askHistory(m));

  assert.ok(inFlight, "有在途轮就必须带 inFlight");
  const blocks = inFlight.blocks as unknown[] | undefined;
  assert.ok(Array.isArray(blocks), "inFlight.blocks 必须是数组");

  const shaped = blocks as {
    blockType: string;
    index?: number;
    text?: string;
    toolName?: string;
  }[];
  const texts = shaped.filter((b) => b.blockType === "text").map((b) => b.text);
  assert.ok(
    texts.includes(FIRST),
    `已定稿的那段正文必须在：期望含「${FIRST}」，实际 text 块 = ${JSON.stringify(texts)}`,
  );
  assert.ok(
    shaped.some((b) => b.blockType === "tool" && b.toolName === TOOL),
    "工具块不能丢",
  );
  assert.deepEqual(
    shaped.map((b) => b.index),
    [0, 1, 2],
    "块按 CLI 的 event.index 有序",
  );
});

// ---------- T-P7-b：开轮广播同样带 blocks（只改一条路径 = 半修） ----------

test("T-P7-b 🔴 开轮广播（send 触发）的 inFlight 同样带 blocks 数组", async () => {
  const m = await midRoundWithTool();
  const mark = m.fx.sent.length;

  m.fx.bridge.dispatch({
    source: m.win,
    data: { type: "createSession", itemKey: "ITEM_C" },
  });
  await tick();
  const sid2 = m.fx.store.list().find((s) => s.itemKey === "ITEM_C")?.id;
  assert.ok(sid2, "夹具自检：第二条会话已建");
  m.fx.bridge.dispatch({
    source: m.win,
    data: { type: "send", text: "第二个问题", sessionId: sid2 },
  });
  await tick();

  const broadcast = m.fx.sent
    .slice(mark)
    .filter((x) => x.win === m.win && x.msg.type === "history")
    .map((x) => x.msg);
  assert.ok(broadcast.length >= 1, "开轮必有一次 history 广播");
  const inFlight = inFlightOf(broadcast[broadcast.length - 1]);
  assert.ok(inFlight, "开轮广播必须带 inFlight");
  assert.ok(
    Array.isArray(inFlight.blocks),
    "开轮广播的 inFlight 也必须带 blocks（与换绑定回执同一来源，否则就是半修）",
  );
});

// ---------- T-P7-c：页面侧（真实归约器） ----------

test("T-P7-c 🔴 切回后收 history：末条是 assistant，可见正文含切走前那段，过程块不丢", async () => {
  const m = await midRoundWithTool();
  const view = apply(reboundEmptyView(m), await askHistory(m));

  const last = view.messages[view.messages.length - 1];
  assert.equal(last.role, "assistant", "末条必须是 assistant 占位轮");
  const shown = visibleText(last);
  assert.ok(
    shown.includes(FIRST),
    `切走前已显示的正文必须还在：期望含「${FIRST}」，实际「${shown}」`,
  );
  assert.ok(
    shown.includes(SECOND),
    `当前流式段也要在：期望含「${SECOND}」，实际「${shown}」`,
  );
  assert.ok(
    blockKinds(last).includes("tool"),
    `过程块（工具条带）不能丢，实际块类型 = ${JSON.stringify(blockKinds(last))}`,
  );
});

test("T-P7-d 🔴 切回后到达的 live delta 落进同一条轮，同一段正文不出两份、不留空气泡", async () => {
  const m = await midRoundWithTool();
  let view = apply(reboundEmptyView(m), await askHistory(m));

  const live: TurnEvent[] = [
    { kind: "textDelta", index: 2, text: "（续）" },
    { kind: "messageStart" },
    { kind: "textDelta", index: 3, text: "第三段：收尾。" },
  ];
  for (const event of live) {
    view = apply(view, {
      type: "streamEvent",
      sessionId: m.sid,
      event,
    } as unknown as HostMessage);
  }

  const assistants = view.messages.filter((t) => t.role === "assistant");
  const all = assistants.map(visibleText).join("\n");
  assert.ok(all.includes("第三段"), `新到达的正文必须落地：实际「${all}」`);
  assert.ok(
    all.includes(FIRST),
    `第一段不能因为 live delta 而丢：实际「${all}」`,
  );
  assert.equal(
    countOf(all, SECOND),
    1,
    `同一段正文只能出现一份（实际 ${countOf(all, SECOND)} 份）：「${all}」`,
  );
  assert.deepEqual(
    assistants.filter((t) => visibleText(t).trim() === "").length,
    0,
    "不得留空白泡泡：每个 assistant 轮都要有可见正文",
  );
  assert.equal(
    groupRounds(view.messages).length,
    1,
    "live delta 落进同一条轮，不得新开一轮",
  );
});

// ---------- T-P7-e：回归锁 —— assistantText 语义一字不动 ----------

test("T-P7-e 🔒 inFlight.assistantText 仍是「当前这条消息已流出的正文」（不跨消息拼接）", async () => {
  const m = await midRoundWithTool();
  const inFlight = inFlightOf(await askHistory(m));

  assert.ok(inFlight, "有在途轮就必须带 inFlight");
  assert.equal(
    inFlight.assistantText,
    SECOND,
    "assistantText 取当前这段正文，且不得与上一段拼成一个字符串",
  );
});

// ---------- T-P7-g：反向用例 —— 不该变的没变（落盘行格式） ----------

test("T-P7-g 🔒 既有落盘行格式不变：正文在 text、过程块在 blocks（不为修 P7 改盘面）", async () => {
  const m = await midRoundWithTool();
  const turn = m.fx.turns[m.fx.turns.length - 1];
  turn.emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0.01,
    durationMs: 1200,
    numTurns: 1,
    isError: false,
  });
  await tick(2);
  turn.releaseExit();
  await tick(4);

  const rows = (await m.fx.store.readHistory(m.sid)) as {
    role: string;
    text: string;
    blocks?: { blockType: string }[];
  }[];

  assert.equal(rows.length, 2, "一轮 = 用户行 + assistant 行");
  const row = rows[1];
  assert.equal(row.role, "assistant");
  assert.equal(
    row.text,
    FIRST,
    "落盘行的正文语义照旧（本轮只有第一条消息被 assistantMessage 定稿 ⇒ 该行的 text 就是它）",
  );
  assert.deepEqual(
    (row.blocks ?? []).map((b) => b.blockType),
    ["tool"],
    "落盘 blocks 仍只有过程块（text 块是 inFlight 独有的形状，不得写进盘面）",
  );
});

// ---------- T-P7-f：回归锁 —— 非法 blocks 回落纯文本占位 ----------

const ASSISTANT_TEXT = "只有纯文本的在途轮。";

const BAD_BLOCKS: [label: string, blocks: unknown][] = [
  ["非数组", "not-an-array"],
  ["元素非对象", [42]],
  ["未知 blockType", [{ blockType: "video", text: "x" }]],
  ["缺 text", [{ blockType: "text", index: 0 }]],
];

for (const [label, blocks] of BAD_BLOCKS) {
  test(`T-P7-f 🔒 blocks 非法（${label}）→ 回落纯文本占位，不抛`, () => {
    const msg = {
      type: "history",
      sessionId: "s-bad",
      messages: [],
      inFlight: {
        userText: "问题",
        assistantText: ASSISTANT_TEXT,
        busy: "running",
        baseRows: 0,
        blocks,
      },
    } as unknown as HostMessage;

    let bound = apply(initialChatState(), { type: "init" } as HostMessage);
    bound = apply(bound, {
      type: "sessionList",
      sessions: [{ id: "s-bad" }],
    } as unknown as HostMessage);

    const view = reduceHostMessage(bound, msg);

    const last = view.messages[view.messages.length - 1];
    assert.equal(last.role, "assistant", "仍要建出 assistant 占位轮");
    assert.equal(
      visibleText(last),
      ASSISTANT_TEXT,
      "回落成纯文本占位（不得是半截轮、不得空）",
    );
  });
}
