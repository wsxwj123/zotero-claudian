// 单测 — R17 / P2「开轮广播减负」：handleSend 的 history 广播收紧为「只通知在途轮」
//
// 契约来源：.devflow/INTERFACE-R17.md §1.2——开轮广播（②）的 messages 恒为 []、inFlight 不变；
// 换绑定回执（①，handleGetHistory）仍是全量落盘行；宿主侧副作用：② 不再调用 sessions.readHistory。
// 夹具：长历史（30 轮、含过程块）+ 两个已注册实例；喂给 reducer 的一律是**桥真实广播出来的消息**。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  selectSession,
  type ChatState,
  type Turn,
} from "../../src/chat/lib/chatModel.ts";
import { groupRounds } from "../../src/chat/lib/roundStrip.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { TurnEvent } from "../../src/modules/cliRunner.ts";
import { inFlightOf, makeBridge, rowsOf, tick } from "./helpers/r17Bridge.ts";

const ROUNDS = 30;
const NEW_QUESTION = "第 31 问：能不能把前面三十轮的结论汇总成一段摘要？";

const question = (i: number): string =>
  `第 ${i} 问：这篇文章在方法学上的主要贡献是什么？请结合实验部分展开说明。`;
const answer = (i: number): string =>
  `第 ${i} 答：作者提出了一个两阶段框架，先用对比学习做表征预训练，` +
  `再用小样本微调对齐下游任务；实验在三个公开数据集上相对基线提升了 4.2 个点。`;

/** 一轮完整的流事件（留 1 个思考 + 1 个工具，确保落盘行带过程块） */
function turnEvents(i: number): TurnEvent[] {
  return [
    { kind: "init", model: "opus", permissionMode: "default" },
    { kind: "messageStart" },
    { kind: "thinkingDelta", index: 0, text: `先定位第 ${i} 轮要看的章节` },
    { kind: "toolBlockStart", index: 1, toolName: "Read", toolUseId: `tu${i}` },
    {
      kind: "toolInputDelta",
      index: 1,
      jsonFragment: `{"file":"paper.pdf","page":${i + 3}}`,
    },
    { kind: "textBlockStart", index: 2 },
    { kind: "textDelta", index: 2, text: answer(i) },
    {
      kind: "result",
      claudeSessionId: "cli-1",
      numTurns: 1,
      costUsd: 0.01,
      durationMs: 3000,
      isError: false,
    },
  ] as TurnEvent[];
}

interface Seeded {
  fx: ReturnType<typeof makeBridge>;
  winA: object;
  winB: object;
  sid: string;
}

/** 两个实例 + 一条跑满 30 轮（含过程块）的会话 */
async function seedLongSession(): Promise<Seeded> {
  const fx = makeBridge();
  const winA = {};
  const winB = {};
  fx.register(winA);
  fx.register(winB);
  await tick();
  fx.bridge.dispatch({
    source: winA,
    data: { type: "createSession", itemKey: "ITEM_A" },
  });
  await tick();
  const sid = fx.store.list()[0].id;

  for (let i = 0; i < ROUNDS; i++) {
    fx.bridge.dispatch({
      source: winA,
      data: { type: "send", text: question(i), sessionId: sid },
    });
    await tick(4);
    const turn = fx.turns[fx.turns.length - 1];
    for (const ev of turnEvents(i)) {
      turn.emit(ev);
    }
    await tick(4);
    turn.releaseExit();
    await tick(4);
  }

  const rows = await fx.store.readHistory(sid);
  assert.equal(rows.length, ROUNDS * 2, "夹具自检：30 轮 = 60 行落盘");
  const withBlocks = (rows as { blocks?: unknown[] }[]).filter(
    (r) => (r.blocks ?? []).length > 0,
  );
  assert.equal(
    withBlocks.length,
    ROUNDS,
    "夹具自检：每轮的 assistant 行都带过程块",
  );
  return { fx, winA, winB, sid };
}

/** 开一轮新的（不放流事件），返回该次广播给某实例的 history 消息 */
async function openRound(s: Seeded, win: object): Promise<HostMessage[]> {
  const mark = s.fx.sent.length;
  s.fx.bridge.dispatch({
    source: s.winA,
    data: { type: "send", text: NEW_QUESTION, sessionId: s.sid },
  });
  await tick();
  return s.fx.sent
    .slice(mark)
    .filter((x) => x.win === win && x.msg.type === "history")
    .map((x) => x.msg);
}

/** 向宿主要一次全量历史（换绑定回执），返回该条 history */
async function askHistory(s: Seeded, win: object): Promise<HostMessage> {
  const mark = s.fx.sent.length;
  s.fx.bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: s.sid },
  });
  await tick();
  const got = s.fx.sent
    .slice(mark)
    .filter((x) => x.win === win && x.msg.type === "history")
    .map((x) => x.msg);
  assert.equal(got.length, 1, "getHistory 恰回一条 history");
  return got[0];
}

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

/** 该实例刚绑定完的视图：握手 → 会话列表 → 绑定（历史尚未到达 ⇒ 视图为空） */
function boundEmptyView(s: Seeded): ChatState {
  let state = apply(initialChatState(), { type: "init" });
  state = apply(state, {
    type: "sessionList",
    sessions: s.fx.store.list(),
  } as unknown as HostMessage);
  if (state.sessionId !== s.sid) {
    state = selectSession(state, s.sid).state;
  }
  assert.equal(state.sessionId, s.sid, "夹具自检：已绑定目标会话");
  assert.equal(state.messages.length, 0, "夹具自检：本地视图为空（档 B）");
  return state;
}

const textsOf = (state: ChatState, role: Turn["role"]): string[] =>
  state.messages.filter((t) => t.role === role).map((t) => t.text);

const blockCount = (state: ChatState): number =>
  state.messages.reduce((n, t) => n + (t.blocks ?? []).length, 0);

// ---------- T-P2-a：开轮广播的内容口径 ----------

test("T-P2-a 🔴 开轮广播的 messages 恒为空数组，且必带 inFlight", async () => {
  const s = await seedLongSession();
  const toB = await openRound(s, s.winB);

  assert.equal(toB.length, 1, "开轮对每个实例恰广播 1 条 history");
  assert.deepEqual(
    rowsOf(toB[0]),
    [],
    "开轮广播不再夹带任何落盘历史行（历史同步的唯一载体是 getHistory 回执）",
  );
  const inFlight = inFlightOf(toB[0]);
  assert.ok(inFlight, "开轮广播必须带 inFlight");
  assert.equal(inFlight.userText, NEW_QUESTION);
  assert.equal(inFlight.busy, "running");
  assert.equal(inFlight.baseRows, ROUNDS * 2, "baseRows = 开轮时的落盘行数");
});

// ---------- T-P2-b：档 B（本地视图为空的已绑定实例） ----------

test("T-P2-b 🔴 视图为空的实例收开轮广播后只见在途轮，回执到达后历史一行不少", async () => {
  const s = await seedLongSession();
  let view = boundEmptyView(s);
  const broadcast = await openRound(s, s.winB);

  for (const msg of broadcast) {
    view = apply(view, msg);
  }
  assert.deepEqual(
    textsOf(view, "user"),
    [NEW_QUESTION],
    "档 B 收到开轮广播后：视图里只有在途那一轮的提问",
  );
  assert.equal(groupRounds(view.messages).length, 1, "轮数口径：只有 1 轮");

  // 该实例刚绑定必发 getHistory，回执带全量行 → 历史补齐
  view = apply(view, await askHistory(s, s.winB));

  const expected = [...Array(ROUNDS).keys()].map(question);
  assert.deepEqual(
    textsOf(view, "user"),
    [...expected, NEW_QUESTION],
    "行口径：30 条历史提问一条不少，在途提问排在最后且只出现一次",
  );
  assert.equal(
    groupRounds(view.messages).length,
    ROUNDS + 1,
    "轮数口径：30 轮历史 + 1 轮在途",
  );
});

// ---------- T-P2-c：档 A（本地已有全量历史） ----------

test("T-P2-c 🔒 本地已有 30 轮的实例收开轮广播：不掉行、过程块不丢", async () => {
  const s = await seedLongSession();
  let view = apply(boundEmptyView(s), await askHistory(s, s.winB));
  assert.equal(
    groupRounds(view.messages).length,
    ROUNDS,
    "夹具自检：本地已有 30 轮",
  );
  const usersBefore = textsOf(view, "user");
  const blocksBefore = blockCount(view);
  assert.ok(blocksBefore >= ROUNDS, "夹具自检：本地视图带过程块");

  const broadcast = await openRound(s, s.winB);
  for (const msg of broadcast) {
    view = apply(view, msg);
  }

  assert.deepEqual(
    textsOf(view, "user"),
    [...usersBefore, NEW_QUESTION],
    "历史提问一条不少，只多出在途那一轮",
  );
  assert.equal(blockCount(view), blocksBefore, "过程块一个不丢");
});

// ---------- T-P2-d：字节口径 ----------

test("T-P2-d 🔴 开轮广播序列化字节 / 全量字节 ≤ 0.1", async () => {
  const s = await seedLongSession();
  const broadcast = await openRound(s, s.winB);
  const full = await askHistory(s, s.winB);

  const bytes = (msg: HostMessage): number =>
    Buffer.byteLength(JSON.stringify(msg), "utf8");
  const broadcastBytes = bytes(broadcast[0]);
  const fullBytes = bytes(full);

  assert.ok(
    fullBytes > 8000,
    `夹具自检：全量历史要足够大才有比值意义（实际 ${fullBytes} 字节）`,
  );
  const ratio = broadcastBytes / fullBytes;
  assert.ok(
    ratio <= 0.1,
    `开轮广播 ${broadcastBytes} 字节 / 全量 ${fullBytes} 字节 = ${ratio.toFixed(3)}，应 ≤ 0.1`,
  );
});

// ---------- T-P2-e：开轮不再读盘 ----------

test("T-P2-e 🔴 开轮不再读会话历史文件：send 前后 readHistory 调用次数不变", async () => {
  const s = await seedLongSession();
  const before = s.fx.reads();
  s.fx.bridge.dispatch({
    source: s.winA,
    data: { type: "send", text: NEW_QUESTION, sessionId: s.sid },
  });
  await tick();

  assert.equal(
    s.fx.reads(),
    before,
    "开轮广播不得再整文件读一次历史（每次 send 少一次读盘 + 逐行 JSON.parse）",
  );
});

// ---------- T-P2-f：反向锁（回执不许跟着收紧） ----------

test("T-P2-f 🔒 换绑定回执（getHistory）的 messages 仍是全量落盘行", async () => {
  const s = await seedLongSession();
  const full = await askHistory(s, s.winB);

  const rows = rowsOf(full);
  assert.equal(
    rows.length,
    ROUNDS * 2,
    "回执必须带全部 60 行（档 B 靠它补齐）",
  );
  assert.equal(
    (rows as { text: string }[])[0].text,
    question(0),
    "第一行是最早那条提问",
  );
  assert.equal(
    (rows as { blocks?: unknown[] }[]).filter(
      (r) => (r.blocks ?? []).length > 0,
    ).length,
    ROUNDS,
    "回执里的过程块一条不少",
  );
});

// ---------- 兼容性反向用例（BRIEF §5） ----------

test("T-P2-g 🔒 老宿主形状（全量 messages、无 inFlight）的 history：新页面照常收敛", async () => {
  const s = await seedLongSession();
  const full = await askHistory(s, s.winB);
  // 老宿主 = 同样的全量行但不带 inFlight（R14 之前的形状）
  const legacy = {
    type: "history",
    sessionId: (full as unknown as { sessionId: string }).sessionId,
    messages: rowsOf(full),
  } as unknown as HostMessage;

  const view = apply(boundEmptyView(s), legacy);

  assert.equal(groupRounds(view.messages).length, ROUNDS, "30 轮全部收敛出来");
  assert.equal(view.turnStatus, "idle", "没有 inFlight → 不得进入在途态");
  assert.deepEqual(
    textsOf(view, "user"),
    [...Array(ROUNDS).keys()].map(question),
    "历史提问一条不少",
  );
});
