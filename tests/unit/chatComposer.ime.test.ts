// 单测 — 输入框发送键判定（WIN-COMPAT-R4 建议 3 / 避免「中文输入法选词即发送」）。
// 被锁契约：`src/chat/App.ts` 导出的 isSendEnter 就是 textarea keydown 的实际判据——
// InputBox 的 onKeyDown 直接调它，删/改这一行即红。
// 层次说明：真键盘事件 + preact commit 需要 DOM（仓库无 jsdom），故锁判据本身；
// 该判据是本次改动唯一的行为分支，也是唯一会被改坏的层。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSendEnter, type SendKeyEvent } from "../../src/chat/App.ts";

/** 键盘事件最小形态（只取 isSendEnter 用到的字段） */
function ev(extra: Partial<SendKeyEvent> = {}): SendKeyEvent {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...extra,
  };
}

test("发送键：普通 Enter（无 IME）→ 发送", () => {
  assert.equal(isSendEnter(ev()), true);
});

test("发送键：Shift+Enter → 不发送（换行）", () => {
  assert.equal(isSendEnter(ev({ shiftKey: true })), false);
});

test("发送键：其他键（含 IME 态）→ 不发送", () => {
  assert.equal(isSendEnter(ev({ key: "a" })), false);
  assert.equal(
    isSendEnter(ev({ key: "a", isComposing: true, keyCode: 229 })),
    false,
  );
  assert.equal(isSendEnter(ev({ key: "Process" })), false);
});

test("发送键：IME 候选态 Enter（isComposing=true，微软拼音/搜狗上屏）→ 不发送", () => {
  // 修复前的判据（key === 'Enter' && !shiftKey）在这里返回 true → 「选词即发送」
  assert.equal(isSendEnter(ev({ isComposing: true, keyCode: 229 })), false);
});

test("发送键：isComposing=true 但 keyCode=13 → 不发送（以标准信号为准，只看 keyCode 会漏）", () => {
  assert.equal(isSendEnter(ev({ isComposing: true })), false);
});

test("发送键：keyCode=229 但 isComposing=false → 不发送（老式 IME 信号兜底，只看 isComposing 会漏）", () => {
  assert.equal(isSendEnter(ev({ keyCode: 229 })), false);
});

test("回归：修复前的老判据在 IME 事件上会发送（把「旧行为即缺陷」写死）", () => {
  const legacy = (e: SendKeyEvent): boolean => e.key === "Enter" && !e.shiftKey;
  const imeEnter = ev({ isComposing: true, keyCode: 229 });
  assert.equal(
    legacy(imeEnter),
    true,
    "老判据本应把上屏回车当发送（缺陷形态）",
  );
  assert.equal(isSendEnter(imeEnter), false, "新判据必须拦住它");
});
