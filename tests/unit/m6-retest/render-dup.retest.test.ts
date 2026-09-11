// m6-retest — 新发现缺陷的回归锁：assistant 正文在 UI 重复渲染两遍。
// 现场（R2b 真机）：宿主 history 落盘文本一遍（71 字），UI DOM 的 .msg.assistant 是两遍
//（"命令被拒绝了——…\n…\n命令被拒绝了——…"）；纯文本轮 "OK" 也渲染成 "OK\nOK"。
// 定位（探针 .scratch/m6-retest/probe-dup2.mts F1）：CLI 流式事件里 thinking 占 index 0、
// text 在 index 1；而最终 assistantMessage 的 content 下标 0 是 text（thinking 未占位）——
// calibrateBlocks 在 index 0 新建 text 块，流式的 text(1) 块原样保留 → 两个相同文本块。
// 本测试断言「期望行为」：同一段正文只应渲染一遍 —— 修复前为红（锁住缺陷，不做修复）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
} from "../../../src/chat/lib/chatModel.ts";

function feed(state: ChatState, event: unknown): ChatState {
  return reduceHostMessage(state, {
    type: "streamEvent",
    sessionId: null,
    event,
  });
}

function textBlocks(state: ChatState): string[] {
  const last = state.messages[state.messages.length - 1];
  return (last?.blocks ?? [])
    .filter((b) => b.blockType === "text")
    .map((b) => b.text);
}

test("复现锁: 流式 thinking(0)+text(1) 且最终 content 为纯 text——正文渲染不得两遍", () => {
  let s: ChatState = { ...initialChatState(), turnStatus: "streaming" };
  s = feed(s, { kind: "messageStart" });
  // CLI 的早期 assistantMessage 携 thinking 块（占 index 0）
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "thinking", thinking: "想一下" }],
  });
  // 流式正文在 index 1（thinking 之后）
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "OK" });
  // 最终校准事件：content 下标 0 是文本
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: "OK" }],
  });
  s = feed(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });

  const tb = textBlocks(s);
  assert.deepEqual(
    tb,
    ["OK"],
    `正文应只渲染一遍；实际 text 块=${JSON.stringify(tb)}（UI 上显示为 "OK\\nOK" 两遍）`,
  );
});

test("对照: 流式无 thinking 占位（text index=0）→ 单块一遍（现有行为）", () => {
  let s: ChatState = { ...initialChatState(), turnStatus: "streaming" };
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "OK" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: "OK" }],
  });
  assert.deepEqual(textBlocks(s), ["OK"]);
});
