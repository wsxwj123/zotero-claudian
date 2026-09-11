// 单测 — 「存选段为笔记」按钮就地展开三选项（用户实测反馈的修复）。
// 用户原话：「点击后，并没有显示是创建还是追加，应该是点击完之后，按钮变为
//            '创建新笔记' '追加到xx笔记' '取消'」。
// 覆盖（纯逻辑，UI 只负责画）：
//   - 选段路径开选择器：origin="selection" + 发 listNotes；消息行路径保持旧形态（零回归）
//   - 选项集合 notePickerView：永远有「创建新笔记」与「取消」；有笔记才列「追加到《…》」
//   - 无笔记/加载中的形态：追加项缺席 + 说明（不静默走默认路径）
//   - 取消：不动其它状态（无选择器时幂等返回原对象）
//   - 选中后的消息载荷：新建 / 追加（带 noteKey）+ 选择器收起
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginNoteSave,
  cancelNotePicker,
  initialChatState,
  notePickerSelect,
  notePickerView,
  reduceHostMessage,
} from "../../src/chat/lib/chatModel.ts";

const s0 = () => initialChatState();
const withContext = () => ({
  ...s0(),
  readerContext: {
    itemKey: "ITEM1",
    title: "一篇论文",
    page: 1,
    selection: null,
  },
});

// ---- 打开选择器：两条路径的形态 ----

test("笔记按钮：选段路径开选择器 = origin=selection + 发 listNotes", () => {
  const { state, msg } = beginNoteSave(withContext(), 3, "<p>选段</p>", "selection");
  assert.deepEqual(msg, { type: "listNotes", itemKey: "ITEM1" });
  assert.equal(state.notePicker.turnIndex, 3);
  assert.equal(state.notePicker.itemKey, "ITEM1");
  assert.equal(state.notePicker.html, "<p>选段</p>");
  assert.equal(state.notePicker.notes, null, "清单在路上 → 先给「读取笔记列表…」");
  assert.equal(state.notePicker.origin, "selection");
});

test("笔记按钮：消息行路径（缺省 origin）形态与 M7 一致（零回归）", () => {
  const { state } = beginNoteSave(withContext(), 0, "<p>x</p>");
  assert.deepEqual(state.notePicker, {
    turnIndex: 0,
    itemKey: "ITEM1",
    html: "<p>x</p>",
    notes: null,
  });
  assert.equal("origin" in state.notePicker, false, "缺省不写 origin 键");
});

test("笔记按钮：无绑定条目 / 空 HTML → 无动作（不发 listNotes，按钮本就禁用）", () => {
  assert.equal(beginNoteSave(s0(), 0, "<p>x</p>", "selection").msg, null);
  assert.equal(beginNoteSave(withContext(), 0, "   ", "selection").msg, null);
});

// ---- 选项集合（notePickerView）----

test("笔记选项：没开选择器 → 空集合（不渲染任何东西）", () => {
  assert.deepEqual(notePickerView(null), { options: [], hint: null });
});

test("笔记选项：清单在路上 → 只有「创建新笔记 + 取消」+ 加载说明", () => {
  const picker = beginNoteSave(withContext(), 0, "<p>x</p>", "selection").state
    .notePicker;
  const view = notePickerView(picker);
  assert.deepEqual(
    view.options.map((o) => [o.kind, o.label]),
    [
      ["new", "创建新笔记"],
      ["cancel", "取消"],
    ],
  );
  assert.equal(view.hint, "读取笔记列表…");
});

test("笔记选项：该条目暂无笔记 → 追加项隐藏 + 说明（不静默走默认路径）", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>", "selection").state;
  const listed = reduceHostMessage(picked, { type: "noteList", notes: [] });
  const view = notePickerView(listed.notePicker);
  assert.deepEqual(
    view.options.map((o) => o.label),
    ["创建新笔记", "取消"],
  );
  assert.equal(view.hint, "（该条目暂无笔记）");
});

test("笔记选项：多条笔记 → 逐条列出「追加到《标题》」，顺序固定为 创建→追加→取消", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>", "selection").state;
  const listed = reduceHostMessage(picked, {
    type: "noteList",
    notes: [
      { noteKey: "N1", title: "甲", updatedAt: 2 },
      { noteKey: "N2", title: "乙", updatedAt: 1 },
    ],
  });
  const view = notePickerView(listed.notePicker);
  assert.deepEqual(
    view.options.map((o) => [o.kind, o.label, o.noteKey ?? null]),
    [
      ["new", "创建新笔记", null],
      ["append", "追加到《甲》", "N1"],
      ["append", "追加到《乙》", "N2"],
      ["cancel", "取消", null],
    ],
  );
  assert.equal(view.hint, null, "有追加项就不显示说明");
  assert.equal(view.options[1].title, "甲", "完整标题留给 title 属性");
});

test("笔记选项：超长/空标题 → 截断 30 字 / 显示（无标题），不产生空按钮", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>", "selection").state;
  const listed = reduceHostMessage(picked, {
    type: "noteList",
    notes: [
      { noteKey: "N1", title: "长".repeat(50), updatedAt: 1 },
      { noteKey: "N2", title: "", updatedAt: 1 },
    ],
  });
  const view = notePickerView(listed.notePicker);
  assert.equal(view.options[1].label, `追加到《${"长".repeat(30)}》`);
  assert.equal(view.options[2].label, "追加到《(无标题)》");
});

// ---- 取消 ----

test("笔记按钮：取消 → 收起选择器且不动其它字段；无选择器时幂等", () => {
  const picked = beginNoteSave(withContext(), 2, "<p>x</p>", "selection").state;
  const cancelled = cancelNotePicker(picked);
  assert.equal(cancelled.notePicker, null);
  assert.equal(cancelled.readerContext.itemKey, "ITEM1", "取消不动绑定");
  assert.equal(cancelled.statusDetail, picked.statusDetail, "取消不写状态行");
  assert.equal(cancelled.messages, picked.messages, "取消不动消息流");
  assert.equal(picked.notePicker.origin, "selection", "原状态对象不被就地改");
  const base = s0();
  assert.equal(cancelNotePicker(base), base, "无选择器 → 返回同一个对象");
});

// ---- 选中后的消息载荷 ----

test("笔记按钮：选「创建新笔记」→ saveNote mode=new（带选段 html + 固化 itemKey）", () => {
  const picked = beginNoteSave(withContext(), 5, "<p>选段</p>", "selection").state;
  const r = notePickerSelect(picked, null);
  assert.deepEqual(r.msg, {
    type: "saveNote",
    itemKey: "ITEM1",
    mode: "new",
    html: "<p>选段</p>",
  });
  assert.equal(r.state.notePicker, null, "选中即收起面板");
  assert.equal(r.state.statusDetail, "存笔记中…");
});

test("笔记按钮：选「追加到《…》」→ saveNote mode=append + noteKey", () => {
  const picked = beginNoteSave(withContext(), 5, "<p>选段</p>", "selection").state;
  const listed = reduceHostMessage(picked, {
    type: "noteList",
    notes: [{ noteKey: "N9", title: "旧笔记", updatedAt: 1 }],
  });
  const opt = notePickerView(listed.notePicker).options.find(
    (o) => o.kind === "append",
  );
  const r = notePickerSelect(listed, opt.noteKey);
  assert.deepEqual(r.msg, {
    type: "saveNote",
    itemKey: "ITEM1",
    mode: "append",
    noteKey: "N9",
    html: "<p>选段</p>",
  });
  assert.equal(r.state.notePicker, null);
});

test("笔记按钮：选中期间换文献 → 目标 itemKey 仍是打开时固化的那条", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>", "selection").state;
  const switched = {
    ...picked,
    readerContext: { itemKey: "ITEM2", title: "另一篇", page: 1, selection: null },
  };
  assert.equal(notePickerSelect(switched, null).msg.itemKey, "ITEM1");
});
