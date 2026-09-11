// 单测 — R7-I「消息分支按钮」前端归约（PLAN-R7 §3.10，纯函数不碰 DOM；黑盒：只按契约写，
// 本轮尚未开工 → 红基线即「模块不存在/未导出」）。
//
// 锁定的契约点：
//   1) 每条消息（用户 / AI）都有分支能力；分隔行等非消息行没有
//   2) 快照缺失的消息 → 按钮**禁用态 + 带原因**（§3.9：不降级成「假回滚」）
//   3) 点分支 → 只发一条 branchSession（以该消息为界分叉），**不直接发送任何 prompt**、
//      不往输入框回填（与「编辑」是两条路）
//   4) 分叉成功回执 → 自动切到新分支会话；**原会话仍在列表里**
//   5) 分支列表：父下按 branchIndex 升序、缩进一层（depth 1）；默认只展开一层，
//      层级 >1 的分支要显式展开才出现（depth 2）
//
// 主会话裁决 H3（2026-09-11）—— 两条路的目标快照口径**不同**，别混：
//   「分支」在消息 k  → 用快照 **k**（含该消息及其回答）；第 k 轮的用户消息与 AI 回答都归 k
//   「编辑」用户消息 k → 用快照 **k−1**（k=1 时 = 0.jsonl）= 该消息**之前**的状态；
//                       编辑的是"这句话"，重发后该句及之后的内容在新分支里重来，所以不含它的回答
//   本文件锁这两个口径（snapshotTurnForMessage = 分支口径 / snapshotTurnForEdit = 编辑口径）
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/chat/lib/branchActions.ts → initialBranchState() /
//     canBranchTurn(turn) / snapshotTurnForMessage(messages, index) /
//     snapshotTurnForEdit(messages, index) /
//     branchButtonState(messages, index, {snapshotTurns}) -> {visible, enabled, reason?} /
//     messageBranchClick(state, messages, index, ctx?) -> {state, message|null}
//       （ctx.snapshotTurns 缺省 = 不限制；给了就按「该轮有没有快照」拦） /
//     branchCreated(state, evt) -> state / sessionRows(sessions, {expand}) -> [{id, depth, ...}]
//   turn 沿用既有 Turn 形状：{ role:"user", text } / { role:"assistant", blocks:[...] }；
//   分隔条（R7-F 引入）形状：{ role:"divider", text:"已编辑重发" }
//   分支会话记录：既有 SessionRecord + { parentId: string|null, branchIndex: number|null }
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchButtonState,
  branchCreated,
  canBranchTurn,
  initialBranchState,
  messageBranchClick,
  sessionRows,
  snapshotTurnForEdit,
  snapshotTurnForMessage,
} from "../../src/chat/lib/branchActions.ts";

const user = (text) => ({ role: "user", text });
const ai = (text) => ({
  role: "assistant",
  blocks: [{ blockType: "text", index: 0, text, streaming: false }],
});

/** 两轮对话：user1 / ai1 / user2 / ai2 —— 消息下标 0..3，轮序号 1,1,2,2 */
const MESSAGES = [user("第一问"), ai("第一答"), user("第二问"), ai("第二答")];
const BOTH_SNAPSHOTS = { snapshotTurns: [1, 2] };

const SESSIONS = [
  { id: "s1", title: "文献A", parentId: null, branchIndex: null },
  { id: "s2", title: "文献B", parentId: null, branchIndex: null },
];

// ---- 分支能力与禁用态 ----

test("R7-I 按钮：用户与 AI 消息都能分支（每条消息都有入口）", () => {
  for (const index of [0, 1, 2, 3]) {
    const b = branchButtonState(MESSAGES, index, BOTH_SNAPSHOTS);
    assert.equal(b.visible, true, `消息 ${index} 应有分支入口`);
    assert.equal(b.enabled, true, `消息 ${index} 在有快照时应可点`);
  }
  assert.equal(canBranchTurn(MESSAGES[0]), true);
  assert.equal(canBranchTurn(MESSAGES[1]), true);
});

test("R7-I 按钮：分隔行 / 空行不是消息 → 没有分支入口", () => {
  assert.equal(canBranchTurn({ role: "divider", text: "已编辑重发" }), false);
  const b = branchButtonState(
    [{ role: "divider", text: "已编辑重发" }],
    0,
    BOTH_SNAPSHOTS,
  );
  assert.equal(b.visible, false);
});

test("R7-I 按钮：快照缺失的消息 → 禁用态且带原因（不假装能回滚）", () => {
  const b = branchButtonState(MESSAGES, 2, { snapshotTurns: [1] }); // 第 2 轮（用户消息）无快照
  assert.equal(b.visible, true, "还是要有按钮（用户得知道为什么点不了）");
  assert.equal(b.enabled, false);
  assert.ok(
    typeof b.reason === "string" && b.reason.length > 0,
    "禁用必须给原因",
  );
  assert.ok(b.reason.includes("快照"), `原因要说清是快照缺失：${b.reason}`);
});

test("R7-I 按钮：同一条消息，快照有了就变可点（状态只由快照决定）", () => {
  const missing = branchButtonState(MESSAGES, 3, { snapshotTurns: [1] });
  const ok = branchButtonState(MESSAGES, 3, { snapshotTurns: [1, 2] });
  assert.equal(missing.enabled, false);
  assert.equal(ok.enabled, true);
  assert.ok(!ok.reason, "可点时不该带禁用原因");
});

// ---- 点击 → 发出的消息 ----

test("R7-I 点击：发出 branchSession，载荷带消息下标与轮序号", () => {
  const { message } = messageBranchClick(initialBranchState(), MESSAGES, 2);
  assert.equal(message.type, "branchSession");
  assert.equal(message.messageIndex, 2);
  assert.equal(message.turn, snapshotTurnForMessage(MESSAGES, 2));
});

test("R7-I 点击：**不直接发送任何 prompt**（分叉只是建会话，不替用户说话）", () => {
  const { message, state } = messageBranchClick(
    initialBranchState(),
    MESSAGES,
    2,
  );
  const dumped = JSON.stringify(message);
  for (const forbidden of ["prompt", "text", "content", "send"]) {
    assert.ok(
      !Object.hasOwn(message, forbidden),
      `分叉消息不得带 ${forbidden} 字段`,
    );
    assert.ok(
      !dumped.includes(`"${forbidden}"`),
      `分叉消息不得夹带 ${forbidden}`,
    );
  }
  assert.equal(state.composerText, "", "不往输入框回填");
  assert.equal(state.editingIndex, null, "也不进入编辑态");
});

test("R7-I 点击：AI 消息也能点（以该回答为界，含该回答）", () => {
  const { message } = messageBranchClick(initialBranchState(), MESSAGES, 3);
  assert.equal(message.turn, 2);
  assert.equal(message.messageIndex, 3);
});

test("R7-I 点击：禁用态消息点下去 → 不发消息（message 为 null）", () => {
  const { message, state } = messageBranchClick(
    initialBranchState(),
    MESSAGES,
    2,
    {
      snapshotTurns: [1], // 第 2 轮没快照
    },
  );
  assert.equal(message, null);
  assert.deepEqual(state, initialBranchState(), "禁用态点击不得改动任何状态");
});

test("R7-I 点击：非法下标 / 空数组 → 不发消息、不抛", () => {
  for (const [msgs, idx] of [
    [MESSAGES, 99],
    [MESSAGES, -1],
    [[], 0],
  ]) {
    let out;
    assert.doesNotThrow(() => {
      out = messageBranchClick(initialBranchState(), msgs, idx);
    });
    assert.equal(out.message, null);
  }
});

// ---- 消息下标 → 目标快照（分支 k / 编辑 k−1，见文件头 H3）----

test("R7-I 映射（分支）：同一轮的用户消息与 AI 回答指向同一个快照", () => {
  assert.equal(
    snapshotTurnForMessage(MESSAGES, 0),
    snapshotTurnForMessage(MESSAGES, 1),
  );
  assert.equal(
    snapshotTurnForMessage(MESSAGES, 2),
    snapshotTurnForMessage(MESSAGES, 3),
  );
});

test("R7-I 映射（分支）：第 k 轮 → 快照 k（AI 回答含在其内，不含其后内容）", () => {
  assert.equal(snapshotTurnForMessage(MESSAGES, 1), 1);
  assert.equal(snapshotTurnForMessage(MESSAGES, 3), 2);
});

test("R7-I 映射（分支）：分隔行不占轮号（不把轮序号顶走）", () => {
  const withDivider = [...MESSAGES, { role: "divider", text: "已编辑重发" }];
  assert.equal(snapshotTurnForMessage(withDivider, 3), 2);
  assert.equal(snapshotTurnForMessage(withDivider, 4), null);
});

test("R7-I 映射（分支）：隔行取不到 → null（不是 NaN/undefined 混进协议载荷）", () => {
  assert.equal(snapshotTurnForMessage(MESSAGES, 99), null);
  assert.equal(snapshotTurnForMessage([], 0), null);
});

// ---- 编辑口径（裁决 H3：用户消息 k → 快照 k−1）----

test("R7-I 映射（编辑）：第 2 轮用户消息 → 快照 1（该消息**之前**的状态）", () => {
  assert.equal(snapshotTurnForEdit(MESSAGES, 2), 1);
  assert.notEqual(
    snapshotTurnForEdit(MESSAGES, 2),
    snapshotTurnForMessage(MESSAGES, 2),
    "编辑与分支的口径必须差一档，不能共用同一个数",
  );
});

test("R7-I 映射（编辑）：第 1 轮用户消息 → 快照 0（首轮编辑 = 会话开始前的空历史）", () => {
  assert.equal(snapshotTurnForEdit(MESSAGES, 0), 0);
});

test("R7-I 映射（编辑）：AI 消息没有编辑入口 → null（编辑只对用户消息）", () => {
  assert.equal(snapshotTurnForEdit(MESSAGES, 1), null);
  assert.equal(snapshotTurnForEdit(MESSAGES, 3), null);
});

test("R7-I 映射（编辑）：分隔行 / 非法下标 / 空数组 → null，不抛", () => {
  const withDivider = [...MESSAGES, { role: "divider", text: "已编辑重发" }];
  for (const [msgs, idx] of [
    [withDivider, 4],
    [MESSAGES, 99],
    [MESSAGES, -1],
    [[], 0],
  ]) {
    let out;
    assert.doesNotThrow(() => {
      out = snapshotTurnForEdit(msgs, idx);
    });
    assert.equal(out, null);
  }
});

// ---- 分叉成功回执 ----

test("R7-I 回执：自动切到新分支会话", () => {
  const s0 = { ...initialBranchState(), sessionId: "s1", sessions: SESSIONS };
  const s1 = branchCreated(s0, {
    sessionId: "b1",
    parentId: "s1",
    branchIndex: 1,
    title: "文献A-分支1",
  });
  assert.equal(s1.sessionId, "b1", "后续消息都发在分支里");
});

test("R7-I 回执：原会话仍在列表里（分叉不是搬家）", () => {
  const s0 = { ...initialBranchState(), sessionId: "s1", sessions: SESSIONS };
  const s1 = branchCreated(s0, {
    sessionId: "b1",
    parentId: "s1",
    branchIndex: 1,
    title: "文献A-分支1",
  });
  const ids = s1.sessions.map((s) => s.id);
  assert.ok(ids.includes("s1"), "原会话不许被删/被藏");
  assert.ok(ids.includes("s2"), "别的会话不受影响");
  assert.ok(ids.includes("b1"), "新分支要出现在列表里");
  const branch = s1.sessions.find((s) => s.id === "b1");
  assert.equal(branch.parentId, "s1");
  assert.equal(branch.branchIndex, 1);
  assert.equal(branch.title, "文献A-分支1");
});

test("R7-I 回执：新会话 id 等于回执里的 claudeSessionId 对应记录（不自己造 id）", () => {
  const s1 = branchCreated(
    { ...initialBranchState(), sessionId: "s1", sessions: SESSIONS },
    { sessionId: "b9", parentId: "s1", branchIndex: 3, title: "文献A-分支3" },
  );
  assert.equal(s1.sessionId, "b9");
  assert.equal(s1.sessions.filter((s) => s.id === "b9").length, 1);
});

// ---- 列表排序与层级 ----

const TREE = [
  { id: "s1", title: "文献A", parentId: null, branchIndex: null },
  { id: "b2", title: "文献A-分支2", parentId: "s1", branchIndex: 2 },
  { id: "b1", title: "文献A-分支1", parentId: "s1", branchIndex: 1 },
  { id: "s2", title: "文献B", parentId: null, branchIndex: null },
];

test("R7-I 列表：父会话 depth 0，其分支缩进一层 depth 1", () => {
  const rows = sessionRows(TREE);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.s1.depth, 0);
  assert.equal(byId.b1.depth, 1);
  assert.equal(byId.s2.depth, 0);
});

test("R7-I 列表：同一父下的分支按 branchIndex 升序（1 在 2 前）", () => {
  const ids = sessionRows(TREE).map((r) => r.id);
  assert.ok(
    ids.indexOf("b1") < ids.indexOf("b2"),
    `分支顺序错：${ids.join(",")}`,
  );
});

test("R7-I 列表：分支紧跟在自己的父会话后面（不散落到列表末尾）", () => {
  const ids = sessionRows(TREE).map((r) => r.id);
  assert.deepEqual(ids, ["s1", "b1", "b2", "s2"]);
});

test("R7-I 列表：默认只展开一层 —— 分支的分支不出现", () => {
  const deep = [
    ...TREE,
    { id: "g1", title: "文献A-分支1-分支1", parentId: "b1", branchIndex: 1 },
  ];
  const rows = sessionRows(deep);
  assert.ok(!rows.some((r) => r.id === "g1"), "默认不展开第二层");
  assert.equal(rows.length, 4);
});

test("R7-I 列表：显式展开某分支 → 其子分支出现且 depth 2", () => {
  const deep = [
    ...TREE,
    { id: "g1", title: "文献A-分支1-分支1", parentId: "b1", branchIndex: 1 },
  ];
  const rows = sessionRows(deep, { expand: ["b1"] });
  const g1 = rows.find((r) => r.id === "g1");
  assert.ok(g1, "展开后子分支要出现");
  assert.equal(g1.depth, 2);
  assert.ok(
    rows.indexOf(g1) > rows.findIndex((r) => r.id === "b1"),
    "子分支排在其父之后",
  );
});

test("R7-I 列表：分支序号缺失/为 null 时不炸，按 0 排在前", () => {
  const rows = sessionRows([
    { id: "s1", title: "A", parentId: null, branchIndex: null },
    { id: "b", title: "A-分支?", parentId: "s1", branchIndex: null },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth]),
    [
      ["s1", 0],
      ["b", 1],
    ],
  );
});

test("R7-I 列表：孤儿分支（父被删）→ 当作顶层展示，不凭空消失", () => {
  const rows = sessionRows([
    { id: "s1", title: "A", parentId: null, branchIndex: null },
    {
      id: "orphan",
      title: "孤儿分支",
      parentId: "已删除的会话",
      branchIndex: 1,
    },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.some((r) => r.id === "orphan"),
    "父没了也要能看见",
  );
});
