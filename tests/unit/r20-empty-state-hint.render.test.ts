// 单测 — R20 修订 r2-3 / r3：未绑定空面板的第三行提示（渲染层）
//
// 契约来源：.devflow/INTERFACE-R20.md 修订 r2-3（显示条件三条、文案逐字、不可点、并存不替换）
// 与修订 r3（契约等价式：空态块显示第三行 ⇔ pendingPermissionElsewhere(state) === true）。
// r3 写「tests/ 里没有能驱动空态渲染的既有测试」——实测不成立：
// tests/unit/m6-review/domShim.ts + Preact 无头渲染 MessageList 就能渲出空态块的两句既有文案，
// 故本轮把这一行提示也纳入自动化，不再只当人工检查项。
//
// 本文件红/绿计数：🔴 修前必红 = 1 条；🔒 修前就绿 = 4 条。合计 5 条。
import "./m6-review/domShim.ts"; // 先装 document/window 全局，再 import 组件
import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "preact";
import { MessageList } from "../../src/chat/components/MessageList.ts";
import { setSanitizer } from "../../src/chat/lib/markdown.ts";
import {
  initialChatState,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import { collectText, mountPoint, queryAll } from "./m6-review/domShim.ts";

// 渲染安全层 fail-closed：无 sanitizer 时 renderMarkdown 抛错（真机用 DOMPurify，不在本测试范围）。
setSanitizer((html) => html);

/** r2-3 逐字文案（不含篇数、不含会话名） */
const HINT = "其它文献的会话有操作等你确认，去会话列表里点开带标记的那条。";
/** 既有空态两句，一字不改 */
const LINE1 = "已连接。输入问题开始对话。";
const LINE2 = "这篇文献还没有会话，直接输入问题即可新建。";

const sessionRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `会话 ${id}`,
  updatedAt: 10,
  itemKey: `ITEM_${id}`,
  claudeSessionId: null,
  itemTitle: null,
  usage: null,
  ...extra,
});

const emptyState = (
  connected: boolean,
  sessions: unknown[],
  sessionId: string | null = null,
): ChatState =>
  ({
    ...initialChatState(),
    connected,
    sessionId,
    sessions,
  }) as unknown as ChatState;

/** 渲染 MessageList 于无头 DOM，返回挂载点上的全部可见文字 */
function renderText(state: ChatState): string {
  const container = mountPoint();
  render(
    h(MessageList, {
      state,
      onOpenExternal: () => {},
      canSaveNote: false,
      notePicker: null,
      onNoteSave: () => {},
      onNoteChoose: () => {},
      onNoteCancel: () => {},
      actions: (state as unknown as { actions: unknown }).actions,
      onCopy: () => {},
      onEdit: () => {},
      onCollapseToggle: () => {},
      branchStateFor: () => ({ visible: false, enabled: false }),
      onBranch: () => {},
    }) as never,
    container as never,
  );
  return collectText(container);
}

/** 渲染后把挂载点也还回来（查元素属性用） */
function renderRoot(state: ChatState) {
  const container = mountPoint();
  render(
    h(MessageList, {
      state,
      onOpenExternal: () => {},
      canSaveNote: false,
      notePicker: null,
      onNoteSave: () => {},
      onNoteChoose: () => {},
      onNoteCancel: () => {},
      actions: (state as unknown as { actions: unknown }).actions,
      onCopy: () => {},
      onEdit: () => {},
      onCollapseToggle: () => {},
      branchStateFor: () => ({ visible: false, enabled: false }),
      onBranch: () => {},
    }) as never,
    container as never,
  );
  return container;
}

test("🔴 r2-3 三条件全满足：空态块在既有两句之后追加第三行提示（文案逐字）", () => {
  const text = renderText(
    emptyState(true, [
      sessionRow("sA", { pendingPermission: true }),
      sessionRow("sC", { pendingPermission: false }),
    ]),
  );
  assert.ok(text.includes(LINE1), "既有第一句必须原样保留");
  assert.ok(text.includes(LINE2), "既有第二句必须原样保留");
  assert.ok(
    text.includes(HINT),
    `空面板应出现逐字提示「${HINT}」，实际渲染文字为：${text}`,
  );
  assert.ok(
    text.indexOf(HINT) > text.indexOf(LINE2),
    "提示是追加的第三行，必须排在既有两句之后",
  );
  assert.ok(
    !/\d/.test(HINT) && !text.includes("会话 sA"),
    "提示不得带篇数，也不得泄漏会话名/文献标题",
  );
});

test("🔒 r2-3 提示不可点：既不是按钮也不是链接，且没挂点击句柄", () => {
  const root = renderRoot(
    emptyState(true, [sessionRow("sA", { pendingPermission: true })]),
  );
  if (!collectText(root).includes(HINT)) {
    return; // 修前提示还没实现：本条是修后才吃劲的锁（正向出现由上一条 🔴 保证）
  }
  const hintEls = queryAll(root, (el) => collectText(el) === HINT);
  assert.ok(hintEls.length >= 1, "提示文字必须落在某个具体元素上");
  for (const el of hintEls) {
    assert.ok(
      !["button", "a"].includes(el.localName),
      `提示是纯文字，不得渲染成 <${el.localName}>`,
    );
    assert.equal(el.onclick, null, "提示不得挂 onclick");
  }
});

test("🔒 老宿主：条目不带 pendingPermission → 不显示提示，既有两句一字不变", () => {
  const text = renderText(
    emptyState(true, [sessionRow("sA"), sessionRow("sC")]),
  );
  assert.equal(text, LINE1 + LINE2, "老宿主下空面板文案逐字不变");
});

test("🔒 条件③不成立（全是 false / 非布尔脏数据）→ 不显示提示", () => {
  const text = renderText(
    emptyState(true, [
      sessionRow("sA", { pendingPermission: false }),
      sessionRow("sC", { pendingPermission: "true" }),
      sessionRow("sD", { pendingPermission: 1 }),
    ]),
  );
  assert.ok(!text.includes(HINT), "只有严格的 true 才算待审批");
});

test("🔒 条件②不成立（未连接）→ 不显示提示", () => {
  const text = renderText(
    emptyState(false, [sessionRow("sA", { pendingPermission: true })]),
  );
  assert.ok(!text.includes(HINT), "断线时不提示（连都没连上，点过去也没用）");
});

// ---- 文件末尾对账：🔴 1 条 / 🔒 4 条 / 合计 5 条 ----
