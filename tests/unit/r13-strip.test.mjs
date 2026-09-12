// 单测 — R13 过程块合并为一条条带（黑盒，红先绿后：被测模块尚不存在）
//
// 契约来源：.devflow/INTERFACE-R13.md §1/§2/§4.2/§1.5；口径来源：.devflow/BRIEF.md「追加轮次 R13」七条；
// 用例清单来源：.devflow/PLAN-R13.md §8.1。**本文件逐字照契约写，不按自己的理解改口径**。
//
// 被测面：src/chat/lib/roundStrip.ts
//   groupRounds / stripSummary / stripTailText / stripAutoOpen / buildRenderItems
//   + STRIP_LABEL / STRIP_TAIL_MAX_CHARS
// 以及 lastTurnEnd 的**迁移面**（INTERFACE §4.2）：全部经 chatModel 的公开入口断言。
//
// 防假绿（PLAN/BRIEF 点名）：lastTurnEnd 的用例**一律从真实事件序列造 state**
// （initialChatState → init → sessionList → readerContext → userSend → 流事件 → 收尾事件），
// 不存在任何「手搓 {round, end} 塞进 state 再断言」的写法——那样会绕过真正的写入路径。
// 同理：RoundGroup 一律由 groupRounds(messages) 造出，不手写 RoundGroup 字面量（避免锁内部形状、
// 也避免把「text 块不在 processBlocks 里」这类隐式前提写成假前提）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRIP_LABEL,
  STRIP_TAIL_MAX_CHARS,
  buildRenderItems,
  groupRounds,
  stripAutoOpen,
  stripSummary,
  stripTailText,
} from "../../src/chat/lib/roundStrip.ts";
import {
  RETRY_MAX_ATTEMPTS,
  clearView,
  editSessionRequest,
  fireRetry,
  followReader,
  initialChatState,
  interrupt,
  messageEditRequest,
  reduceHostMessage,
  selectSession,
  userSend,
} from "../../src/chat/lib/chatModel.ts";

// ---------- 消息与块的字面量（形状照 chatModel 的 Turn / TurnBlock） ----------

const T = (text, index = 0) => ({
  blockType: "text",
  index,
  text,
  streaming: false,
});
const TH = (text, index = 0) => ({
  blockType: "thinking",
  index,
  text,
  streaming: false,
});
const TL = (toolUseId, index = 0, toolName = "Read") => ({
  blockType: "tool",
  index,
  toolName,
  toolUseId,
  inputJson: "{}",
  result: null,
  streaming: false,
});

const u = (text) => ({ role: "user", text });
const a = (...blocks) => ({ role: "assistant", blocks });
const d = (text = "已编辑重发") => ({ role: "divider", text });

/** 该消息流的分轮结果（唯一造 RoundGroup 的方式） */
const roundsOf = (messages) => groupRounds(messages);
/** 第 i 轮 */
const R = (messages, i = 0) => groupRounds(messages)[i];
/** 渲染项 key 序列（顺序断言用） */
const keys = (messages) => buildRenderItems(messages).map((it) => it.key);

// ---------- 真实事件序列（状态机面）----------

const S1 = {
  id: "s1",
  title: "会话一",
  updatedAt: 1,
  itemKey: "K1",
  claudeSessionId: "c1",
};
const S2_OTHER_DOC = {
  id: "s2",
  title: "会话二",
  updatedAt: 2,
  itemKey: "K2",
  claudeSessionId: "c2",
};
/** 同文献的另一条会话（换绑定用例用：让唯一的写入点只剩 reduceSessionList 那一处） */
const S2_SAME_DOC = { ...S2_OTHER_DOC, itemKey: "K1" };

const host = (state, msg) => reduceHostMessage(state, msg);
/** 宿主 → UI 的流事件（sessionId 就是当前绑定，走的是真实过滤路径） */
const feed = (state, event) =>
  reduceHostMessage(state, { type: "streamEvent", sessionId: "s1", event });

/** 已握手、已绑 s1、已知当前文献的初始视图（PLAN §8.3 装置的同一序） */
function bound(sessions = [S1]) {
  let s = initialChatState();
  s = host(s, { type: "init" });
  s = host(s, { type: "sessionList", sessions });
  s = host(s, {
    type: "readerContext",
    itemKey: "K1",
    title: "文献",
    page: null,
    selection: null,
  });
  return s;
}

/** 一次「思考 → 工具 → 收尾文字」往返（真实流事件序，与 PLAN §8.3 装置同形） */
function pass(
  state,
  { think = "我先摸清工作区结构和内容。", tool = "Read", id = "t1", answer = "最终答案" } = {},
) {
  let s = state;
  s = feed(s, { kind: "messageStart" });
  if (think !== null) {
    s = feed(s, { kind: "thinkingDelta", index: 0, text: think });
  }
  if (tool !== null) {
    s = feed(s, { kind: "toolBlockStart", index: 1, toolName: tool, toolUseId: id });
    s = feed(s, { kind: "toolInputDelta", index: 1, jsonFragment: '{"file":"a.md"}' });
    s = feed(s, { kind: "toolResult", toolUseId: id, isError: false, summary: "完成" });
  }
  if (answer !== null) {
    s = feed(s, { kind: "textBlockStart", index: 2 });
    s = feed(s, { kind: "textDelta", index: 2, text: answer });
  }
  return s;
}

/** userSend（真实入口）→ 一轮流事件（不含收尾） */
function midRound(state, text = "甲", opts) {
  return pass(userSend(state, text).state, opts);
}

const RESULT = {
  kind: "result",
  claudeSessionId: "c1",
  costUsd: 0.01,
  durationMs: 1200,
  numTurns: 2,
};
const RESULT_ERR = {
  kind: "resultError",
  subtype: "error_during_execution",
  errors: ["boom"],
};
const SESSION_BUSY = {
  type: "error",
  code: "SESSION_BUSY",
  message: "上一轮仍在收尾",
  sessionId: "s1",
};

/** 跑完一整轮（userSend → 流 → 收尾事件），返回真实序列造出的 state */
function fullRound(state, text, event = RESULT, opts) {
  return feed(midRound(state, text, opts), event);
}
// ================= A. groupRounds（INTERFACE §1.2 边界契约） =================

test("R13 分轮：首轮（messages[0] 是 user）→ 正常一轮，边界/计数/展平都对", () => {
  const msgs = [u("甲"), a(TH("想1"), TL("t1", 1)), a(T("答1"))];
  const g = roundsOf(msgs);
  assert.equal(g.length, 1, "一轮只该产出一个 RoundGroup");
  assert.equal(g[0].startIndex, 0, "有 user 轮时 startIndex = 该 user 轮下标");
  assert.equal(g[0].endIndex, 2, "endIndex = 该轮最后一条 Turn 的下标");
  assert.equal(g[0].hasUser, true);
  assert.equal(g[0].isLast, true, "单轮即末轮");
  assert.equal(g[0].assistantTurns, 2, "N = 该轮内 assistant Turn 条数");
  assert.equal(g[0].processSteps, 2, "M = thinking + tool 块数");
  assert.deepEqual(
    g[0].processBlocks.map((r) => [r.turnIndex, r.block.blockType]),
    [
      [1, "thinking"],
      [1, "tool"],
    ],
    "过程块按原顺序展平，turnIndex = 所属 assistant Turn 下标",
  );
});

test("R13 分轮：前导无主段（messages[0] 非 user）→ 自成一轮 hasUser:false、startIndex:0", () => {
  const msgs = [a(TH("想")), u("甲"), a(T("答"))];
  const g = roundsOf(msgs);
  assert.equal(g.length, 2);
  assert.equal(g[0].startIndex, 0);
  assert.equal(g[0].endIndex, 0);
  assert.equal(g[0].hasUser, false, "无主段没有 user 轮打头");
  assert.equal(g[0].isLast, false);
  assert.equal(g[0].assistantTurns, 1);
  assert.deepEqual([g[1].startIndex, g[1].endIndex], [1, 2]);
  assert.equal(g[1].hasUser, true);
  assert.equal(g[1].isLast, true);
});

test("R13 分轮：divider 归入前一轮，不计轮数与步数，但仍在 endIndex 内", () => {
  const msgs = [u("甲"), a(TH("想"), T("答", 1)), d()];
  const g = roundsOf(msgs);
  assert.equal(g.length, 1, "divider 不得自成一轮");
  assert.equal(g[0].endIndex, 2, "endIndex 仍为该轮最后一条 Turn 的下标（含 divider）");
  assert.equal(g[0].assistantTurns, 1, "divider 不计入 N");
  assert.equal(g[0].processSteps, 1, "divider 不计入 M");
  assert.equal(g[0].processBlocks.length, 1, "divider 不产出过程块");
});

test("R13 分轮：连续两条 user → 后者开新轮，前一轮 N=0 / M=0", () => {
  const msgs = [u("甲"), u("乙"), a(T("答"))];
  const g = roundsOf(msgs);
  assert.equal(g.length, 2, "后者必须开新轮");
  assert.deepEqual([g[0].startIndex, g[0].endIndex], [0, 0]);
  assert.equal(g[0].assistantTurns, 0);
  assert.equal(g[0].processSteps, 0);
  assert.deepEqual(g[0].processBlocks, []);
  assert.equal(g[1].startIndex, 1);
  assert.equal(g[1].isLast, true);
});

test("R13 分轮：含 0 过程块的轮 → processSteps 0 且 processBlocks []（不得假设每轮都有过程块）", () => {
  const msgs = [u("甲"), a(T("纯正文"))];
  const g = roundsOf(msgs);
  assert.equal(g[0].assistantTurns, 1);
  assert.equal(g[0].processSteps, 0);
  assert.deepEqual(g[0].processBlocks, []);
  // 块为空的 assistant 行（messageStart 刚落）同样只进 N、不进 M
  const g2 = roundsOf([u("甲"), a()]);
  assert.equal(g2[0].assistantTurns, 1, "块为空的 assistant 行也是 1 条 Turn");
  assert.equal(g2[0].processSteps, 0);
});

test("R13 分轮：单助手轮的 N 与 M（N 数行、M 数块）", () => {
  const g = roundsOf([u("甲"), a(TH("想"), TL("t1", 1), T("答", 2))]);
  assert.equal(g.length, 1);
  assert.equal(g[0].assistantTurns, 1);
  assert.equal(g[0].processSteps, 2);
  assert.deepEqual(g[0].processBlocks.map((r) => r.block.blockType), [
    "thinking",
    "tool",
  ]);
});

test("R13 分轮：N 与 M 各自独立（无过程块的 Turn 只进 N 不进 M）", () => {
  const msgs = [
    u("甲"),
    a(TH("想1")),
    a(T("中途叙述")),
    a(TL("t1", 0)),
    a(T("答")),
  ];
  const g = roundsOf(msgs);
  assert.equal(g[0].assistantTurns, 4, "4 条助手行 = 4 轮");
  assert.equal(g[0].processSteps, 2, "只有 2 个过程块 = 2 步");
});

test("R13 分轮：跨多条助手消息展平 —— 顺序与 turnIndex 都按原始位置", () => {
  const msgs = [
    u("甲"),
    a(TH("想1"), TL("t1", 1)),
    a(TH("想2"), T("中途叙述")),
    a(TL("t2", 0)),
  ];
  const g = roundsOf(msgs);
  assert.equal(g[0].assistantTurns, 3);
  assert.equal(g[0].processSteps, 4);
  assert.deepEqual(
    g[0].processBlocks.map((r) => [r.turnIndex, r.block.blockType, r.block.index]),
    [
      [1, "thinking", 0],
      [1, "tool", 1],
      [2, "thinking", 0],
      [3, "tool", 0],
    ],
    "块序 = (turnIndex, 块在 turn 内的位置) 展平；无 text 的纯过程行也要进",
  );
  assert.deepEqual(
    g[0].processBlocks.map((r) => r.block.blockType),
    ["thinking", "tool", "thinking", "tool"],
    "text 块不得混进 processBlocks",
  );
});

test("R13 分轮：空数组 → []", () => {
  assert.deepEqual(groupRounds([]), []);
});

test("R13 分轮：非数组入参 → 返回 [] 且不抛（TurnLike 同款兜底）", () => {
  for (const junk of [null, undefined, "junk", 42, true, { role: "user" }, () => {}]) {
    assert.deepEqual(groupRounds(junk), [], `入参 ${String(junk)} 应返回 []`);
  }
});

test("R13 分轮：数组内畸形条目 → 不抛（不崩即可，条目归一不在本轮契约面）", () => {
  for (const junkEntry of [null, 7, "x", {}, { role: 123 }, { role: "assistant", blocks: "junk" }]) {
    const out = groupRounds([u("甲"), junkEntry, a(T("答"))]);
    assert.ok(Array.isArray(out), "畸形条目不得让它抛/返回非数组");
  }
});

test("R13 分轮：覆盖全部消息，无遗漏无重叠（各轮首尾相接）", () => {
  const msgs = [
    a(TH("前导")),
    u("甲"),
    a(TH("想1"), T("答1", 1)),
    a(TL("t1", 0)),
    d(),
    u("乙"),
    u("丙"),
    a(T("答丙")),
  ];
  const g = roundsOf(msgs);
  let expect = 0;
  for (const r of g) {
    assert.equal(r.startIndex, expect, "各轮必须首尾相接");
    expect = r.endIndex + 1;
  }
  assert.equal(expect, msgs.length, "必须覆盖到最后一条（无遗漏）");
  assert.equal(g[g.length - 1].isLast, true);
  assert.equal(g.filter((r) => r.isLast).length, 1, "只有最后一轮 isLast");
});

test("R13 分轮：groupRounds 顺手填好 tailText（§1.1 字段语义 = §1.3 的成品）", () => {
  const g = roundsOf([u("甲"), a(TH("我先摸清工作区结构和内容。"), T("最终答案", 1))]);
  assert.equal(
    g[0].tailText,
    "我先摸清工作区结构和内容。",
    "末块是 text → 尾段取最后一条 thinking",
  );
});
// ================= B. stripTailText + stripSummary（INTERFACE §1.3 / §2） =================

test("R13 摘要：常量逐字（STRIP_LABEL / 截断上限 40 码点）", () => {
  assert.equal(STRIP_LABEL, "思考与工具调用", "前缀逐字：不带动词与标点");
  assert.equal(STRIP_TAIL_MAX_CHARS, 40);
});

test("R13 尾段：末块是 text → 取最后一条 thinking，摘要逐字含尾段", () => {
  const msgs = [u("甲"), a(TH("我先摸清工作区结构和内容。"), TL("t1", 1), T("最终答案", 2))];
  const r = R(msgs);
  assert.equal(stripTailText(r), "我先摸清工作区结构和内容。");
  assert.equal(
    stripSummary(r),
    "思考与工具调用 · 1 轮 2 步 · 我先摸清工作区结构和内容。",
  );
});

test("R13 尾段：末块非 text（tool 收尾）→ 取最后一条 text（BRIEF 示例形态）", () => {
  const msgs = [u("甲"), a(TH("思考不取"), T("我先摸清工作区结构和内容。", 1), TL("t1", 2))];
  const r = R(msgs);
  assert.equal(stripTailText(r), "我先摸清工作区结构和内容。");
  assert.equal(
    stripSummary(r),
    "思考与工具调用 · 1 轮 2 步 · 我先摸清工作区结构和内容。",
  );
});

test("R13 尾段：多条候选取「最后一条」，不是第一条", () => {
  // 末块是 text（新正文）→ 取最后一条 thinking = 新思考
  const g1 = roundsOf([
    u("甲"),
    a(TH("旧思考"), TL("t1", 1), T("旧正文", 2)),
    a(TH("新思考"), T("新正文", 1)),
  ]);
  assert.equal(stripTailText(g1[0]), "新思考");
  // 末块是 tool → 取最后一条 text = 第二段
  const g2 = roundsOf([u("甲"), a(T("第一段", 0), TH("想", 1), T("第二段", 2), TL("t1", 3))]);
  assert.equal(stripTailText(g2[0]), "第二段");
});

test("R13 尾段：thinking 与 text 都取不到 → null，摘要省略尾段与分隔符", () => {
  const r = R([u("甲"), a(TH("想"), TL("t1", 1))]);
  assert.equal(stripTailText(r), null);
  assert.equal(stripSummary(r), "思考与工具调用 · 1 轮 2 步");
  assert.ok(!stripSummary(r).endsWith(" · "), "省略尾段时连分隔符一起省");
});

test("R13 尾段：末块是 text 但该轮没有 thinking 块 → null", () => {
  const r = R([u("甲"), a(TL("t1", 0), T("正文", 1))]);
  assert.equal(r.processSteps, 1, "该轮仍有过程块（条带照渲染）");
  assert.equal(stripTailText(r), null);
  assert.equal(stripSummary(r), "思考与工具调用 · 1 轮 1 步");
});

test("R13 尾段：末块是 thinking/tool 但该轮没有 text 块 → null", () => {
  const r = R([u("甲"), a(TH("只想不说话"))]);
  assert.equal(r.processSteps, 1);
  assert.equal(stripTailText(r), null);
  assert.equal(stripSummary(r), "思考与工具调用 · 1 轮 1 步");
});

test("R13 摘要：processSteps === 0 → 摘要为 null（调用方据此不渲染条带）", () => {
  const r = R([u("甲"), a(T("只有正文"))]);
  assert.equal(r.processSteps, 0);
  assert.equal(stripTailText(r), null);
  assert.equal(stripSummary(r), null);
});

test("R13 尾段清洗：\\s+ 折叠为单个空格 + trim", () => {
  const r = R([u("甲"), a(TH("  我先\n\n 看看\t这个 文件  "), T("答", 1))]);
  assert.equal(stripTailText(r), "我先 看看 这个 文件");
});

test("R13 尾段清洗：先清洗再截断（折叠出的空格也算进 40 码点）", () => {
  const raw = "a".repeat(30) + "\n\n" + "b".repeat(30);
  const t = stripTailText(R([u("甲"), a(TH(raw), T("答", 1))]));
  assert.equal(t, "a".repeat(30) + " " + "b".repeat(9) + "…");
  assert.equal([...t].length, 41, "40 码点 + 省略号");
});

test("R13 尾段截断：正好 40 码点不截断不加省略号，41 码点截到 40 + …", () => {
  const at = (s) => stripTailText(R([u("甲"), a(TH(s), T("答", 1))]));
  assert.equal(at("c".repeat(40)), "c".repeat(40));
  assert.equal(at("d".repeat(41)), "d".repeat(40) + "…");
});

test("R13 尾段截断：按 Unicode 码点，代理对 / emoji 不得被切半", () => {
  const at = (s) => stripTailText(R([u("甲"), a(TH(s), T("答", 1))]));
  assert.equal(at("🙂".repeat(40)), "🙂".repeat(40), "40 个 emoji 正好不截断");
  assert.equal(at("🙂".repeat(41)), "🙂".repeat(40) + "…");
  // 第 40 个码点正好是 emoji：按 UTF-16 切片会把它劈成孤立高位代理
  const cross = "a".repeat(39) + "🙂" + "bbb";
  const t = at(cross);
  assert.equal(t, "a".repeat(39) + "🙂" + "…");
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t),
    "截断后不得留下孤立的高位代理（半个 emoji）",
  );
  assert.equal([...t].length, 41);
});

test("R13 尾段清洗：空串 / 纯空白清洗后为空 → null（摘要只剩 N 轮 M 步）", () => {
  const blank = R([u("甲"), a(TH("\n   \t "), T("答", 1))]);
  assert.equal(blank.processSteps, 1);
  assert.equal(stripTailText(blank), null);
  assert.equal(stripSummary(blank), "思考与工具调用 · 1 轮 1 步");
  const empty = R([u("甲"), a(TH(""), T("答", 1))]);
  assert.equal(stripTailText(empty), null);
});

test("R13 尾段：不做 markdown 记号剥离（# / * / 反引号原样）", () => {
  const t = stripTailText(R([u("甲"), a(TH("## 方法\n\n- 第一步 `code`"), T("答", 1))]));
  assert.equal(t, "## 方法 - 第一步 `code`", "只折叠空白，记号照原样");
  assert.ok(t.startsWith("##"), "标题记号不得被吃掉");
});
// ================= C. stripAutoOpen（INTERFACE §1.4 判据表） =================

test("R13 开合：末轮流式中 → true（判据 1，含 waiting）", () => {
  let s = bound();
  s = userSend(s, "甲").state;
  let r = roundsOf(s.messages)[0];
  assert.equal(s.turnStatus, "waiting");
  assert.equal(r.isLast, true);
  assert.equal(stripAutoOpen(s, r), true, "waiting（刚发出）就该是展开的");

  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  r = roundsOf(s.messages)[0];
  assert.equal(s.turnStatus, "streaming");
  assert.equal(stripAutoOpen(s, r), true, "流式中保持展开");
});

test("R13 开合：末轮正常完成（end:ok）→ false（判据 2/6）", () => {
  let s = bound();
  s = fullRound(s, "甲");
  const r = roundsOf(s.messages)[0];
  assert.equal(s.turnStatus, "idle");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  assert.equal(stripAutoOpen(s, r), false, "正常完成原地收成一行");
});

test("R13 开合：回答本身报错（resultError）→ 保持展开", () => {
  let s = bound();
  s = fullRound(s, "甲", RESULT_ERR);
  const r = roundsOf(s.messages)[0];
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
  assert.equal(stripAutoOpen(s, r), true, "出问题的现场不得被折起来");
});

test("R13 开合：CLI 进程异常（procError）→ 保持展开", () => {
  let s = bound();
  s = fullRound(s, "甲", { kind: "procError", exitCode: 1, stderrTail: "boom" });
  const r = roundsOf(s.messages)[0];
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
  assert.equal(stripAutoOpen(s, r), true);
});

test("R13 开合：用户手动中断后收尾（aborted）→ 保持展开", () => {
  let s = bound();
  s = midRound(s);
  s = interrupt(s).state;
  s = feed(s, RESULT);
  const r = roundsOf(s.messages)[0];
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "aborted" });
  assert.equal(stripAutoOpen(s, r), true);
});

test("R13 开合：中断期间（turnStatus:interrupting）→ true（走判据 1，与 aborted 标记无关）", () => {
  let s = bound();
  s = midRound(s);
  const r0 = roundsOf(s.messages)[0];
  assert.equal(stripAutoOpen(s, r0), true, "中断前的 streaming 也是展开");
  s = interrupt(s).state;
  assert.equal(s.turnStatus, "interrupting");
  assert.equal(stripAutoOpen(s, roundsOf(s.messages)[0]), true);
});

test("R13 开合：非末轮 + lastTurnEnd 为 null（新一轮在跑）→ false", () => {
  let s = bound();
  s = fullRound(s, "甲");
  s = feed(s, RESULT);
  s = userSend(s, "乙").state;
  s = feed(s, { kind: "messageStart" });
  assert.equal(s.lastTurnEnd, null, "userSend 清掉上一轮的收尾信息");
  const g = roundsOf(s.messages);
  assert.equal(g.length, 2);
  assert.equal(g[0].isLast, false);
  assert.equal(stripAutoOpen(s, g[0]), false, "非末轮一律收起");
  assert.equal(stripAutoOpen(s, g[1]), true, "末轮在跑 → 展开");
});

test("R13 开合：lastTurnEnd.round 不匹配 → false（异常标记只对命中的那一轮生效）", () => {
  let s = bound();
  s = fullRound(s, "甲");
  s = feed(s, RESULT); // 轮 0 正常完成
  s = fullRound(s, "乙", RESULT_ERR); // 轮 1（首条 user 下标 2）出错
  const g = roundsOf(s.messages);
  assert.equal(g.length, 2);
  assert.deepEqual(s.lastTurnEnd, { round: 2, end: "error" });
  assert.equal(g[0].startIndex, 0);
  assert.equal(stripAutoOpen(s, g[0]), false, "end 不是 ok 但 round 不匹配 → 仍收起");
  assert.equal(stripAutoOpen(s, g[1]), true, "命中轮的异常保持展开");
});

test("R13 开合：reduceHistory 置的 {round:-1, ok} 不匹配任何轮 → 全部收起", () => {
  let s = bound();
  s = fullRound(s, "甲");
  s = host(s, {
    type: "history",
    sessionId: "s1",
    messages: [
      { role: "user", text: "甲", ts: 1 },
      { role: "assistant", text: "答", ts: 2 },
    ],
  });
  assert.deepEqual(s.lastTurnEnd, { round: -1, end: "ok" });
  const g = roundsOf(s.messages);
  assert.ok(g.length >= 1);
  for (const r of g) {
    assert.equal(stripAutoOpen(s, r), false, "回放的历史轮一律收起");
  }
});
// ================= D. lastTurnEnd 迁移全表（INTERFACE §4.2） =================
// 每行一条用例；state 一律由真实事件序列造出（见文件头「防假绿」）。

test("R13 迁移：result 正常完成 → {round:0, end:'ok'}", () => {
  let s = bound();
  s = midRound(s);
  assert.equal(s.turnStatus, "streaming");
  s = feed(s, RESULT);
  assert.equal(s.turnStatus, "idle");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
});

test("R13 迁移：已 interrupt() 的轮收到 result → 保持 aborted（不被翻成 ok）", () => {
  let s = bound();
  s = midRound(s);
  s = interrupt(s).state;
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "aborted" }, "interrupt() 进分支时立刻落标记");
  s = feed(s, RESULT);
  assert.equal(s.turnStatus, "idle");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "aborted" }, "result 只做裁决，不得把中断翻成 ok");
});

test("R13 迁移：resultError → {round:0, end:'error'}", () => {
  let s = bound();
  s = midRound(s);
  s = feed(s, RESULT_ERR);
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
});

test("R13 迁移：procError / CLAUDE_NOT_FOUND 分支 → {round:0, end:'error'}", () => {
  let s = bound();
  s = midRound(s);
  s = feed(s, { kind: "procError", reason: "CLAUDE_NOT_FOUND", exitCode: null });
  assert.equal(s.turnStatus, "idle", "事件确实落到了这个分支");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
});

test("R13 迁移：procError / 一般退出分支 → {round:0, end:'error'}", () => {
  let s = bound();
  s = midRound(s);
  s = feed(s, { kind: "procError", exitCode: 1, stderrTail: "boom" });
  assert.equal(s.turnStatus, "idle", "事件确实落到了这个分支");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
});

test("R13 迁移：error 宿主消息且收尾前非 idle → {round:0, end:'error'}", () => {
  // 真实行（PLAN §6.5「建会话失败 / 一般 error」）：收尾前 waiting
  let s = bound();
  s = userSend(s, "甲").state;
  assert.equal(s.turnStatus, "waiting");
  s = host(s, { type: "error", code: "ITEM_NOT_FOUND", message: "boom", sessionId: "s1" });
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "error" });
  // 同一判据在 streaming 下同样成立
  let s2 = bound();
  s2 = midRound(s2);
  assert.equal(s2.turnStatus, "streaming");
  s2 = host(s2, { type: "error", code: "SOME_CODE", message: "boom", sessionId: "s1" });
  assert.deepEqual(s2.lastTurnEnd, { round: 0, end: "error" });
});

test("R13 迁移（反例）：error 宿主消息但 turnStatus 已是 idle → 字段不得被改动", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = host(s, { type: "error", code: "SOME_CODE", message: "迟到的错误", sessionId: "s1" });
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" }, "已正常收尾的轮不得被翻成 error");
});

test("R13 迁移：换会话（selectSession → switchView）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = selectSession(s, "s2").state;
  assert.equal(s.sessionId, "s2");
  assert.equal(s.lastTurnEnd, null);
});

test("R13 迁移：切文献（followReader → switchView）→ null", () => {
  let s = bound([S1, S2_OTHER_DOC]);
  assert.equal(s.sessionId, "s1");
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = followReader(s, "K2").state;
  assert.equal(s.sessionId, "s2", "确实换了绑定");
  assert.equal(s.lastTurnEnd, null);
});

test("R13 迁移：换绑定（reduceSessionList）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  // 新会话与当前文献同 itemKey → 紧随其后的 followReader 收敛是空操作，
  // 于是唯一可能的写入点就是 reduceSessionList 的重绑分支（隔离干净）
  s = host(s, { type: "sessionList", sessions: [S2_SAME_DOC] });
  assert.equal(s.sessionId, "s2", "确实换了绑定");
  assert.equal(s.lastTurnEnd, null);
});

test("R13 迁移：换分支（reduceBranchCreated，非 keepView）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = host(s, {
    type: "branchCreated",
    sessionId: "b1",
    parentId: "s1",
    branchIndex: 1,
    title: "分支 1",
  });
  assert.deepEqual(s.messages, [], "该分支清空视图");
  assert.equal(s.lastTurnEnd, null);
});

test("R13 迁移：本地 /clear（clearView）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.ok(s.messages.length > 0, "清空之前视图里有消息（否则这条用例是空转）");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = clearView(s);
  assert.deepEqual(s.messages, []);
  assert.equal(s.lastTurnEnd, null);
});

test("R13 迁移：reduceHistory 且 idle → {round:-1, end:'ok'}", () => {
  let s = bound();
  s = fullRound(s, "甲");
  s = host(s, {
    type: "history",
    sessionId: "s1",
    messages: [
      { role: "user", text: "甲", ts: 1 },
      { role: "assistant", text: "答", ts: 2 },
      { role: "user", text: "乙", ts: 3 },
    ],
  });
  assert.deepEqual(s.messages.map((t) => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(s.lastTurnEnd, { round: -1, end: "ok" }, "回放轮一律视为已完成无错误");
});

test("R13 迁移：reduceHistory 且在途（非 idle）→ 不变", () => {
  let s = bound();
  s = midRound(s);
  s = interrupt(s).state;
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "aborted" });
  s = host(s, {
    type: "history",
    sessionId: "s1",
    messages: [
      { role: "user", text: "旧甲", ts: 1 },
      { role: "assistant", text: "旧答", ts: 2 },
    ],
  });
  assert.equal(s.turnStatus, "interrupting", "在途轮仍在跑");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "aborted" }, "在途轮归 turnStatus 判，回放不得动它");
});

test("R13 迁移：userSend（新轮开始）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = userSend(s, "第二问").state;
  assert.equal(s.lastTurnEnd, null, "新轮一开始就清（异常现场只覆盖最近一轮）");
  assert.equal(s.turnStatus, "waiting");
});

test("R13 迁移：editSessionRequest（新轮开始）→ null", () => {
  let s = bound();
  s = fullRound(s, "甲");
  s = messageEditRequest(s, 0);
  assert.equal(s.actions.editingIndex, 0, "先进编辑态（否则 editSessionRequest 空转）");
  const r = editSessionRequest(s, "改过的甲");
  assert.ok(r.msg, "编辑重发应产出 editSession 消息");
  s = r.state;
  assert.equal(s.lastTurnEnd, null);
  assert.equal(s.turnStatus, "waiting");
});

test("R13 迁移：fireRetry → 不变", () => {
  let s = bound();
  s = fullRound(s, "甲");
  // 回放出一段以 user 轮结尾的历史（宿主侧可能的形态），再制造 SESSION_BUSY 待重发
  s = host(s, {
    type: "history",
    sessionId: "s1",
    messages: [
      { role: "user", text: "甲", ts: 1 },
      { role: "assistant", text: "答", ts: 2 },
      { role: "user", text: "乙", ts: 3 },
    ],
  });
  assert.deepEqual(s.lastTurnEnd, { round: -1, end: "ok" });
  s = host(s, SESSION_BUSY);
  assert.ok(s.pendingRetry, "末条是 user 轮 → 进入自动重发待命");
  const before = s.lastTurnEnd;
  s = fireRetry(s).state;
  assert.equal(s.turnStatus, "waiting");
  assert.deepEqual(s.lastTurnEnd, before, "fireRetry 不动该字段（靠 turnStatus !== idle 展开）");
});

test("R13 迁移：SESSION_BUSY 用尽、撤回刚发的轮 → round 记被撤回那一轮（不得落到 0）", () => {
  let s = bound();
  s = fullRound(s, "甲"); // 轮 0 正常收尾
  assert.deepEqual(s.lastTurnEnd, { round: 0, end: "ok" });
  s = userSend(s, "乙").state; // 轮 1：首条 user 下标 2
  assert.equal(s.messages[2].role, "user");
  s = host(s, SESSION_BUSY);
  for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
    s = fireRetry(s).state;
    s = host(s, SESSION_BUSY);
  }
  assert.deepEqual(s.messages.map((t) => t.role), ["user", "assistant"], "用尽 → 撤回刚发的 user 轮");
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.restoreDraft, "乙", "原文退回输入框（既有行为）");
  assert.equal(s.lastTurnEnd.end, "error");
  assert.equal(s.lastTurnEnd.round, 2, "记的是被撤回那一轮的首条 user 下标（撤回前算出的）");
  const g = roundsOf(s.messages);
  assert.equal(
    stripAutoOpen(s, g[0]),
    false,
    "残留的 error 不得把上一轮的旧条带撑开（round 匹配不上 = 无副作用）",
  );
});
// ================= E. buildRenderItems（INTERFACE §1.5） =================

test("R13 渲染项：无 text 块可渲染的助手行不产项（它的过程块上提到条带）", () => {
  const msgs = [u("甲"), a(TH("想"), TL("t1", 1)), a(T("答"))];
  assert.deepEqual(
    keys(msgs),
    ["u0", "s0", "a2"],
    "只有 thinking/tool 的助手行（下标 1）必须被跳过，条带插在 user 之后",
  );
  const items = buildRenderItems(msgs);
  const strip = items[1];
  assert.equal(strip.kind, "strip");
  assert.equal(strip.round.startIndex, 0, "strip 项自带它那一轮的分组结果");
});

test("R13 渲染项：回放形态的助手行 —— text 为空/缺省不产项，有 text 产项", () => {
  const msgs = [
    { role: "assistant", text: "" },
    { role: "assistant" },
    u("甲"),
    { role: "assistant", text: "回放的答" },
  ];
  assert.deepEqual(keys(msgs), ["u2", "a3"], "两个空 text 的助手行都得跳过");
});

test("R13 渲染项：条带插在该轮 user 之后、第一条被产出的助手项之前", () => {
  const msgs = [u("甲"), a(TH("想")), a(T("答"))];
  assert.deepEqual(keys(msgs), ["u0", "s0", "a2"]);
});

test("R13 渲染项：该轮无助手项时，条带仍插在 user 轮之后", () => {
  const msgs = [u("甲"), a(TH("想"))];
  assert.deepEqual(keys(msgs), ["u0", "s0"], "该助手行被跳过，条带位置不变");
});

test("R13 渲染项：仅前导无主段（hasUser:false）→ 条带插在轮起点", () => {
  const msgs = [a(TH("想")), u("甲"), a(T("答"))];
  assert.deepEqual(
    keys(msgs),
    ["s0", "u1", "a2"],
    "无主段的条带插在该轮起点（它前面没有 user 轮）",
  );
});

test("R13 渲染项：多轮交错顺序 + key 稳定 + index 恒等于 messages 下标", () => {
  const msgs = [
    u("甲"),
    a(TH("想1")),
    a(T("答1")),
    u("乙"),
    a(TH("想2"), TL("t1", 1)),
    a(T("答2")),
  ];
  const items = buildRenderItems(msgs);
  assert.deepEqual(keys(msgs), ["u0", "s0", "a2", "u3", "s3", "a5"]);
  assert.deepEqual(
    items.map((it) => it.kind),
    ["turn", "strip", "turn", "turn", "strip", "turn"],
  );
  assert.deepEqual(items.map((it) => it.index), [0, 0, 2, 3, 3, 5]);
  assert.deepEqual(
    items.filter((it) => it.kind === "strip").map((it) => it.round.startIndex),
    [0, 3],
    "strip 项的 index = 该轮 startIndex",
  );
  // key 稳定：同输入两次调用产出同一序列（消息只从尾部追加，既有下标稳定）
  assert.deepEqual(
    buildRenderItems(msgs).map((it) => it.key),
    items.map((it) => it.key),
  );
  // turn 项的 key 前缀按 role 区分，且下标与消息一一对应
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[2].role, "assistant");
  assert.equal(msgs[3].role, "user");
  assert.equal(msgs[5].role, "assistant");
});

test("R13 渲染项：divider 保序（原样产出一项，不产条带）", () => {
  const msgs = [u("甲"), a(T("答")), d("已编辑重发")];
  assert.deepEqual(keys(msgs), ["u0", "a1", "d2"]);
});

test("R13 渲染项：0 过程块的轮不产条带项", () => {
  const msgs = [u("甲"), a(T("纯正文"))];
  assert.deepEqual(keys(msgs), ["u0", "a1"]);
});

test("R13 渲染项：空消息 / 非数组入参 → [] 且不抛", () => {
  assert.deepEqual(buildRenderItems([]), []);
  for (const junk of [null, undefined, "junk", 42, {}]) {
    assert.deepEqual(buildRenderItems(junk), [], `入参 ${String(junk)} 应返回 []`);
  }
});

