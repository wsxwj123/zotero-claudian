// 单测 — R7 前端归约（纯函数，不碰 DOM）：@ 提及的 chips / 检索面板（PLAN-R7 §3 UI）
//        + 指令编辑器的脏标记与作用域切换（PLAN-R7 §2 UI）。
// 契约来源只有 PLAN-R7.md（黑盒，不看实现——本轮开发尚未开始，红基线即「模块不存在/未导出」）。
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/chat/lib/mentionPicker.ts → initialMentionPickerState / mentionPanelOpen /
//     mentionPanelClose / mentionQueryChange / mentionResults / mentionChipAdd /
//     mentionChipRemove / mentionChipsClear
//   src/chat/lib/instructionsEditor.ts → initialInstructionsEditor / instructionsEditorLoad /
//     instructionsEditorEdit / instructionsEditorSaved / instructionsEditorSetScope /
//     instructionsEditorClose / instructionsEditorDirty
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialMentionPickerState,
  mentionChipAdd,
  mentionChipRemove,
  mentionChipsClear,
  mentionPanelClose,
  mentionPanelOpen,
  mentionQueryChange,
  mentionResults,
} from "../../src/chat/lib/mentionPicker.ts";
import {
  initialInstructionsEditor,
  instructionsEditorClose,
  instructionsEditorDirty,
  instructionsEditorEdit,
  instructionsEditorLoad,
  instructionsEditorSaved,
  instructionsEditorSetScope,
} from "../../src/chat/lib/instructionsEditor.ts";

const at = (key, title = `题名 ${key}`) => ({ itemKey: key, title });

// ---- 检索面板开合 ----

test("R7-UI 面板：初始态是关闭的、无 chip、无关键词", () => {
  const s = initialMentionPickerState();
  assert.equal(s.open, false);
  assert.deepEqual(s.chips, []);
  assert.equal(s.query, "");
});

test("R7-UI 面板：打开 → open 置真；关闭 → 置假且**已选 chips 不丢**", () => {
  const opened = mentionPanelOpen(initialMentionPickerState());
  assert.equal(opened.open, true);
  const picked = mentionChipAdd(opened, at("A1"));
  const closed = mentionPanelClose(picked);
  assert.equal(closed.open, false);
  assert.deepEqual(
    closed.chips.map((c) => c.itemKey),
    ["A1"],
    "关面板是收起候选，不是撤销已选",
  );
});

test("R7-UI 面板：输入关键词 → query 更新且面板保持开（@ 后继续打字）", () => {
  const s = mentionQueryChange(mentionPanelOpen(initialMentionPickerState()), "机器");
  assert.equal(s.query, "机器");
  assert.equal(s.open, true);
});

test("R7-UI 面板：结果到达 → 候选就位（最多 20 条）", () => {
  const items = Array.from({ length: 25 }, (_, i) => at(`K${i}`));
  const s = mentionResults(mentionPanelOpen(initialMentionPickerState()), items);
  assert.ok(s.items.length <= 20, `候选展示上限 20，实际 ${s.items.length}`);
  assert.equal(s.items[0].itemKey, "K0");
});

test("R7-UI 面板：空结果 → 状态标为「无结果」（UI 据此显示提示，不显示空白下拉）", () => {
  const s = mentionResults(mentionPanelOpen(initialMentionPickerState()), []);
  assert.deepEqual(s.items, []);
  assert.equal(s.status, "empty");
});

// ---- chips 归约 ----

test("R7-UI chips：同一文献只能有一个 chip（重复选中即忽略）", () => {
  let s = mentionChipAdd(initialMentionPickerState(), at("A1", "第一篇"));
  s = mentionChipAdd(s, at("A1", "第一篇（重复点击）"));
  assert.equal(s.chips.length, 1);
  assert.equal(s.chips[0].title, "第一篇", "重复选中不覆盖既有 chip");
});

test("R7-UI chips：上限 20 —— 第 21 个被拒并给提示", () => {
  let s = initialMentionPickerState();
  for (let i = 0; i < 20; i += 1) s = mentionChipAdd(s, at(`K${i}`));
  assert.equal(s.chips.length, 20);
  const over = mentionChipAdd(s, at("K20"));
  assert.equal(over.chips.length, 20, "超出上限不得静默加入");
  assert.ok(
    typeof over.notice === "string" && over.notice.includes("20"),
    `超限要有提示（PLAN 文案：一次最多引用 20 篇），实际 ${JSON.stringify(over.notice)}`,
  );
  // 上限内的追加不打扰用户
  assert.ok(!s.notice, "未超限时不该有提示");
});

test("R7-UI chips：删除指定 chip，其余保持原顺序", () => {
  let s = initialMentionPickerState();
  for (const k of ["A1", "A2", "A3"]) s = mentionChipAdd(s, at(k));
  const after = mentionChipRemove(s, "A2");
  assert.deepEqual(
    after.chips.map((c) => c.itemKey),
    ["A1", "A3"],
  );
});

test("R7-UI chips：删除不存在的 itemKey → chips 不变", () => {
  const s = mentionChipAdd(initialMentionPickerState(), at("A1"));
  const after = mentionChipRemove(s, "不存在");
  assert.deepEqual(
    after.chips.map((c) => c.itemKey),
    ["A1"],
  );
});

test("R7-UI chips：清空（发送后） → 空数组，下一轮从零开始", () => {
  let s = initialMentionPickerState();
  for (const k of ["A1", "A2"]) s = mentionChipAdd(s, at(k));
  const cleared = mentionChipsClear(s);
  assert.deepEqual(cleared.chips, []);
  assert.deepEqual(
    mentionChipAdd(cleared, at("A9")).chips.map((c) => c.itemKey),
    ["A9"],
  );
});

// ---- 指令编辑器：脏标记与作用域切换 ----

const LOADED = {
  type: "instructions",
  scope: "global",
  path: "/ws/CLAUDE.md",
  text: "# 规则\n用中文回答\n",
  exists: true,
};

test("R7-UI 指令：初始为加载中、非脏", () => {
  const s = initialInstructionsEditor("global");
  assert.equal(s.open, true);
  assert.equal(s.scope, "global");
  assert.equal(s.status, "loading");
  assert.equal(instructionsEditorDirty(s), false);
});

test("R7-UI 指令：宿主回执就位 → 文本/路径/exists 落地，非脏", () => {
  const s = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  assert.equal(s.text, LOADED.text);
  assert.equal(s.path, "/ws/CLAUDE.md");
  assert.equal(s.exists, true);
  assert.equal(instructionsEditorDirty(s), false);
});

test("R7-UI 指令：文件不存在 → exists:false + 空文本（UI 提示「尚未创建，保存即创建」）", () => {
  const s = instructionsEditorLoad(initialInstructionsEditor("global"), {
    type: "instructions",
    scope: "global",
    path: "/ws/CLAUDE.md",
    text: "",
    exists: false,
  });
  assert.equal(s.exists, false);
  assert.equal(s.text, "");
  assert.equal(instructionsEditorDirty(s), false, "刚加载的空文件不算脏");
});

test("R7-UI 指令：脏标记 —— 编辑置脏，改回原文复归干净", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const edited = instructionsEditorEdit(loaded, "# 规则\n改成英文\n");
  assert.equal(instructionsEditorDirty(edited), true);
  const reverted = instructionsEditorEdit(edited, LOADED.text);
  assert.equal(instructionsEditorDirty(reverted), false, "内容回到落盘态即不脏");
});

test("R7-UI 指令：保存成功回执 → 非脏、路径回填、错误清空", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const edited = instructionsEditorEdit(loaded, "新内容");
  const saved = instructionsEditorSaved(edited, {
    type: "instructionsSaved",
    scope: "global",
    ok: true,
    path: "/ws/CLAUDE.md",
  });
  assert.equal(saved.status, "saved");
  assert.equal(instructionsEditorDirty(saved), false, "存上了就不再脏");
  assert.equal(saved.path, "/ws/CLAUDE.md");
  assert.ok(!saved.error);
});

test("R7-UI 指令：保存失败回执 → 错误原文上屏、**仍脏**、编辑器不关（防以为存上了）", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const edited = instructionsEditorEdit(loaded, "新内容");
  const failed = instructionsEditorSaved(edited, {
    type: "instructionsSaved",
    scope: "global",
    ok: false,
    error: "EACCES: permission denied, open '/ws/CLAUDE.md'",
  });
  assert.equal(failed.open, true, "失败不得关掉编辑器");
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "EACCES: permission denied, open '/ws/CLAUDE.md'");
  assert.equal(instructionsEditorDirty(failed), true, "没存上就还是脏的");
  assert.equal(failed.text, "新内容", "失败不得吞掉用户输入");
});

test("R7-UI 指令：加载回执带 error → 错误上屏，且不清空用户正在编辑的内容", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const edited = instructionsEditorEdit(loaded, "还没保存的输入");
  const failed = instructionsEditorLoad(edited, {
    type: "instructions",
    scope: "global",
    path: null,
    text: "",
    exists: false,
    error: "EACCES: permission denied",
  });
  assert.ok(failed.error, "错误原文要在");
  assert.equal(failed.text, "还没保存的输入", "读失败不得把用户输入冲成空");
});

test("R7-UI 指令：脏态关闭需二次确认 —— 未确认不关、内容不丢", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const edited = instructionsEditorEdit(loaded, "未保存的改动");
  const refused = instructionsEditorClose(edited, { confirmDiscard: false });
  assert.equal(refused.closed, false);
  assert.equal(refused.state.open, true);
  assert.equal(refused.state.text, "未保存的改动");

  const confirmed = instructionsEditorClose(edited, { confirmDiscard: true });
  assert.equal(confirmed.closed, true);
  assert.equal(confirmed.state.open, false);
});

test("R7-UI 指令：干净态直接关闭，无需确认", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const closed = instructionsEditorClose(loaded, {});
  assert.equal(closed.closed, true);
  assert.equal(closed.state.open, false);
});

test("R7-UI 指令：切换作用域 → scope 跟随（全局 / 当前分类）", () => {
  const loaded = instructionsEditorLoad(initialInstructionsEditor("global"), LOADED);
  const switched = instructionsEditorSetScope(loaded, "collection");
  assert.equal(switched.scope, "collection");
  assert.equal(switched.open, true, "切换作用域不关弹层");
});

test("R7-UI 指令：以宿主回执的 scope 为准（切到 collection 后回执不会把作用域写回 global）", () => {
  const switched = instructionsEditorSetScope(
    instructionsEditorLoad(initialInstructionsEditor("global"), LOADED),
    "collection",
  );
  const loaded = instructionsEditorLoad(switched, {
    type: "instructions",
    scope: "collection",
    path: "/ws/科学前言/CLAUDE.md",
    text: "分类级规则",
    exists: true,
  });
  assert.equal(loaded.scope, "collection");
  assert.equal(loaded.path, "/ws/科学前言/CLAUDE.md");
  assert.equal(loaded.text, "分类级规则");
});
