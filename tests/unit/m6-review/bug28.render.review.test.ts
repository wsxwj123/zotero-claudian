// m6 复核轮 — BUG-28 的 DOM 层独立验证（无头渲染真实 Preact 组件 MessageList）。
// 独立点：不复用 dev-chatui 的 chatModel.calibrate.test.ts 或 test-m6 的 render-dup.retest.test.ts
// 的任何断言/夹具；事件序列按真机形态自建（LEARNINGS：流式 thinking@0 + 正文@1、最终 content 只列 text）。
// 期望：同一段正文在 DOM 里只出现一遍。
import "./domShim.ts"; // 先装 document/window 全局，再 import 组件
import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "preact";
import { MessageList } from "../../../src/chat/components/MessageList.ts";
import { setSanitizer } from "../../../src/chat/lib/markdown.ts";
import {
  initialChatState,
  reduceHostMessage,
  userSend,
  type ChatState,
} from "../../../src/chat/lib/chatModel.ts";
import {
  byClass,
  collectText,
  mountPoint,
  type ShimElement,
} from "./domShim.ts";

// 渲染安全层 fail-closed：无 sanitizer 时 renderMarkdown 抛错。本测试只关心块渲染路径，
// 注入直通替身（真机用的是 DOMPurify，不在本测试的验证范围）。
setSanitizer((html) => html);

const SESSION = "S1";

function feed(state: ChatState, event: unknown): ChatState {
  return reduceHostMessage(state, {
    type: "streamEvent",
    sessionId: SESSION,
    event,
  });
}

/** 渲染 MessageList 于无头 DOM，返回挂载点（供 collectText / byClass 读取） */
function renderList(state: ChatState): ShimElement {
  const container = mountPoint();
  render(h(MessageList, { state, onOpenExternal: () => {} }), container);
  return container;
}

/** 真机形态的事件序列：thinking 占流式 index 0、正文在 index 1，最终 content 只声明 text@0 */
function thinkingThenTextState(reply: string): {
  streamingState: ChatState;
  finalState: ChatState;
} {
  let s = initialChatState();
  s = reduceHostMessage(s, {
    type: "sessionList",
    sessions: [
      {
        id: SESSION,
        title: SESSION,
        updatedAt: 0,
        itemKey: null,
        claudeSessionId: null,
        itemTitle: null,
      },
    ],
  });
  s = userSend({ ...s, sessionId: SESSION, connected: true }, "打个招呼").state;
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想一下" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: reply });
  const streamingState = s;
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: reply }],
  });
  s = feed(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  return { streamingState, finalState: s };
}

function assistantTextOf(container: ShimElement): string {
  const msgs = byClass(container, "assistant");
  assert.equal(msgs.length, 1, `assistant 气泡数量异常：${msgs.length}`);
  return collectText(msgs[0]);
}

test("DOM/BUG-28: 流式 thinking@0 + 正文@1，最终 content 只列 text@0 —— 正文只渲染一遍", () => {
  const { finalState } = thinkingThenTextState("OK");
  const container = renderList(finalState);
  const text = assistantTextOf(container);
  const hits = text.split("OK").length - 1;
  assert.equal(
    hits,
    1,
    `正文在 DOM 里出现 ${hits} 遍（期望 1 遍）——DOM 文本：${JSON.stringify(text)}`,
  );
});

test("DOM/BUG-28 对照: 流式期间（未校准）thinking 与正文各渲染一遍", () => {
  const { streamingState } = thinkingThenTextState("OK");
  const container = renderList(streamingState);
  const text = assistantTextOf(container);
  assert.equal(
    text.split("OK").length - 1,
    1,
    `流式中正文渲染 ${text.split("OK").length - 1} 遍——DOM 文本：${JSON.stringify(text)}`,
  );
  assert.ok(text.includes("想一下"), "流式期间思考块应可见");
});

test("DOM/正常单段正文（无 thinking 错位）：校准后仍只渲染一遍", () => {
  let s = initialChatState();
  s = userSend({ ...s, sessionId: SESSION, connected: true }, "问题").state;
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "回答" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: "回答" }],
  });
  const container = renderList(s);
  const text = assistantTextOf(container);
  assert.equal(text.split("回答").length - 1, 1);
});

test("DOM/合法多段同文本: text@0 + tool@1 + text@2（两段文本相同）—— 两段都保留（不得误 merge）", () => {
  let s = initialChatState();
  s = userSend({ ...s, sessionId: SESSION, connected: true }, "看一下").state;
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "我看看" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "t1",
  });
  s = feed(s, { kind: "textBlockStart", index: 2 });
  s = feed(s, { kind: "textDelta", index: 2, text: "我看看" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [
      { type: "text", text: "我看看" },
      { type: "tool_use", name: "Read", id: "t1", input: { f: "a" } },
      { type: "text", text: "我看看" },
    ],
  });
  const container = renderList(s);
  const text = assistantTextOf(container);
  assert.equal(
    text.split("我看看").length - 1,
    2,
    `两段相同文本应各渲染一遍（共 2 处）——DOM 文本：${JSON.stringify(text)}`,
  );
  assert.ok(text.includes("Read"), "工具卡不应被去重逻辑吞掉");
});

test("DOM/契约·非 text 块不受影响：content 声明 text@0，未声明的 tool@1 保留", () => {
  let s = initialChatState();
  s = userSend({ ...s, sessionId: SESSION, connected: true }, "看文件").state;
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "看一下" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "t1",
  });
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: "看一下" }],
  });
  const container = renderList(s);
  const text = assistantTextOf(container);
  assert.equal(text.split("看一下").length - 1, 1, "正文渲染遍数异常");
  assert.ok(
    text.includes("Read"),
    `非 text 块被去重逻辑误删——DOM 文本：${JSON.stringify(text)}`,
  );
});
