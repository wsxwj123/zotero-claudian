// 单测 — R12 范围选择（`+ 范围`）交互修复：纯归约 + DI harness（无 DOM、无宿主）。
// 覆盖（用户实测反馈的四条）：
//   A 打开面板**不发** resolveScope（此刻用户什么都没选，抢跑只会落废 chip）
//   B/C 回执 0 篇 → 不落 chip，面板就地提示 + 重试；>0 → 落 chip 并收起面板
//   C 重试重发同一种 kind
//   D selection 类 chip 有刷新入口、collection 类没有；刷新失败/0 篇 → 回提示态、旧 chip 清掉
//   + 回执字段映射：宿主回执是 items（ResolvedRef[]），chip 要 itemKey 串——
//     少这层映射 chip 的 count 恒为 0（用户「选了也不出 N 篇」的真因）。
// harness 影子 App 的接线（App.ts 的 onScopeXxx 逐条对应）；App 里若把 open 接成 request，
// 这里推的 r.msg 就会出现在 sent 里 —— 断言 sent 为空即守住 A。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearScope,
  initialChatState,
  openScopePanel,
  reduceHostMessage,
  refreshScope,
  requestScope,
  scopePayload,
} from "../../src/chat/lib/chatModel.ts";
import {
  SCOPE_EMPTY_HINT,
  scopeRefreshable,
  scopeReceiptInput,
} from "../../src/chat/lib/scopePicker.ts";
import { SCOPE_SELECTION_LABEL } from "../../src/utils/scope.ts";

/** 影子 App：store + bridge（只记发出的消息）——与 App.ts 的 onScope 接线一一对应 */
function makeUi() {
  let state = initialChatState();
  const sent = [];
  const ui = {
    state: () => state,
    sent,
    open: () => {
      const r = openScopePanel(state);
      state = r.state || r;
      if (r.msg) sent.push(r.msg); // App 的 onScopeOpen 不 send；这里留口子抓回归
    },
    pick: (kind) => {
      const r = requestScope(state, kind);
      state = r.state;
      sent.push(r.msg);
    },
    retry: () => {
      const notice = state.scope.notice;
      if (notice) ui.pick(notice.kind);
    },
    refresh: () => {
      const r = refreshScope(state);
      if (r) {
        state = r.state;
        sent.push(r.msg);
      }
    },
    receipt: (msg) => {
      state = reduceHostMessage(state, msg);
    },
  };
  return ui;
}

/** 宿主回执（真实形状：items 是 ResolvedRef[]） */
function scopeResolved(kind, count, label) {
  return {
    type: "scopeResolved",
    kind,
    label:
      label ?? (kind === "collection" ? "科学前言" : SCOPE_SELECTION_LABEL),
    items: Array.from({ length: count }, (_, i) => ({
      itemKey: `K${i}`,
      title: `题名 ${i}`,
    })),
    truncated: false,
  };
}

test("R12-A：点「+ 范围」只展开选项，不发 resolveScope", () => {
  const ui = makeUi();
  ui.open();
  assert.deepEqual(ui.sent, [], "展开面板不该发任何桥消息");
  assert.equal(ui.state().scope.open, true, "面板要展开");
  assert.equal(ui.state().scope.chip, null, "展开时不该有 chip");
  assert.equal(ui.state().scope.notice, null);
});

test("R12-C：回执 0 篇 → 不落 chip、面板不收起、进「提示 + 重试」态", () => {
  const ui = makeUi();
  ui.pick("selection");
  assert.deepEqual(
    ui.sent.map((m) => [m.type, m.kind]),
    [["resolveScope", "selection"]],
  );

  ui.receipt(scopeResolved("selection", 0));
  assert.equal(ui.state().scope.chip, null, "0 篇不许落一枚空 chip");
  assert.equal(ui.state().scope.open, true, "面板留着给用户重试");
  assert.equal(ui.state().scope.notice.kind, "selection");
  assert.equal(ui.state().scope.notice.text, SCOPE_EMPTY_HINT.selection);
  assert.match(ui.state().scope.notice.text, /左侧文献列表/, "提示要教怎么选");
  assert.match(ui.state().scope.notice.text, /重试/);
});

test("R12-C：0 篇后点「重试」→ 重发同一种请求；这篇选好就落 chip 并收起面板", () => {
  const ui = makeUi();
  ui.pick("selection");
  ui.receipt(scopeResolved("selection", 0));
  ui.retry();
  assert.deepEqual(
    ui.sent.map((m) => [m.type, m.kind]),
    [
      ["resolveScope", "selection"],
      ["resolveScope", "selection"],
    ],
  );
  assert.equal(ui.state().scope.notice, null, "重试中先收起旧提示");

  ui.receipt(scopeResolved("selection", 2));
  assert.equal(ui.state().scope.chip.count, 2);
  assert.equal(ui.state().scope.chip.label, SCOPE_SELECTION_LABEL);
  assert.equal(ui.state().scope.open, false, "有篇数就收起面板");
  assert.equal(ui.state().scope.notice, null);
});

test("R12 真因：回执的 items（ResolvedRef[]）要映射成 chip 的 itemKeys", () => {
  const ui = makeUi();
  ui.pick("collection");
  ui.receipt(scopeResolved("collection", 3, "科学前言"));
  assert.equal(ui.state().scope.chip.count, 3, "count 不许恒为 0");
  assert.deepEqual(ui.state().scope.chip.itemKeys, ["K0", "K1", "K2"]);
  // 后面发送时带的就是这串 key（宿主再白名单化）
  const payload = scopePayload(ui.state());
  assert.deepEqual(payload.itemKeys, ["K0", "K1", "K2"]);
  assert.equal(payload.label, "科学前言");

  // 映射本身：missing 的不算数（与 buildScopeBlock 同口径）
  const mapped = scopeReceiptInput({
    kind: "selection",
    label: SCOPE_SELECTION_LABEL,
    items: [
      { itemKey: "A", title: "在" },
      { itemKey: "B", missing: true },
      { itemKey: "C" },
    ],
    truncated: true,
  });
  assert.deepEqual(mapped.itemKeys, ["A", "C"]);
  assert.equal(mapped.truncated, true);
});

test("R12-D：刷新入口只给 selection chip；collection chip 没有", () => {
  const ui = makeUi();
  ui.pick("selection");
  ui.receipt(scopeResolved("selection", 2));
  assert.equal(scopeRefreshable(ui.state().scope), true);

  const other = makeUi();
  other.pick("collection");
  other.receipt(scopeResolved("collection", 2, "科学前言"));
  assert.equal(other.state().scope.chip.kind, "collection");
  assert.equal(
    scopeRefreshable(other.state().scope),
    false,
    "分类 chip 不给 ↻",
  );
  assert.equal(refreshScope(other.state()), null, "分类 chip 点不出请求");
});

test("R12-D：点 ↻ → 重发 selection 请求并进入「解析中」；在途重复点击不再发", () => {
  const ui = makeUi();
  ui.pick("selection");
  ui.receipt(scopeResolved("selection", 2));
  const before = ui.sent.length;

  ui.refresh();
  assert.deepEqual(ui.sent.slice(before), [
    { type: "resolveScope", kind: "selection" },
  ]);
  assert.equal(ui.state().scope.refreshing, true, "chip 显示短暂「解析中…」");
  assert.equal(ui.state().scope.chip.count, 2, "在途时旧 chip 还在，别闪空");

  ui.refresh(); // 在途重复点击
  assert.equal(ui.sent.length, before + 1, "在途不再发第二条");

  // 改了选择：3 篇
  ui.receipt(scopeResolved("selection", 3));
  assert.equal(ui.state().scope.refreshing, false);
  assert.equal(ui.state().scope.chip.count, 3, "刷新后 chip 跟到新选择");
  assert.equal(ui.state().scope.open, false);
});

test("R12-D：刷新读到 0 篇 → 清掉旧 chip，回到提示 + 重试态", () => {
  const ui = makeUi();
  ui.pick("selection");
  ui.receipt(scopeResolved("selection", 2));
  ui.refresh();
  ui.receipt(scopeResolved("selection", 0));
  assert.equal(ui.state().scope.chip, null, "旧清单已过期，清掉别拿着发车");
  assert.equal(ui.state().scope.open, true);
  assert.equal(ui.state().scope.notice.kind, "selection");
  assert.equal(ui.state().scope.refreshing, false);
});

test("R12：过期回执（面板已收、没在刷新）不落状态；关闭面板不丢已选 chip", () => {
  const ui = makeUi();
  ui.pick("selection");
  ui.receipt(scopeResolved("selection", 2)); // 已是「面板收起 + 有 chip」态
  const snapshot = ui.state().scope;
  ui.receipt(scopeResolved("selection", 5)); // 迟到/重复回执
  assert.equal(ui.state().scope.chip.count, 2, "过期回执不许改已定的 chip");
  assert.equal(ui.state().scope, snapshot);

  // 重开面板 → 只展开，chip 照旧（关面板不是撤销范围）
  ui.open();
  assert.equal(ui.state().scope.open, true);
  assert.equal(ui.state().scope.chip?.count, 2);
  // × 撤销
  assert.equal(clearScope(ui.state()).scope.chip, null);
});

test("R12：collection 0 篇的提示指向分类（不能照抄 selection 的「选中文献」文案）", () => {
  const ui = makeUi();
  ui.pick("collection");
  ui.receipt(scopeResolved("collection", 0, "科学前言"));
  assert.equal(ui.state().scope.notice.text, SCOPE_EMPTY_HINT.collection);
  assert.match(ui.state().scope.notice.text, /分类/);
});
