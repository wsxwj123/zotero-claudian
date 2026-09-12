// m6 复核轮 — BUG-28（正文重复渲染）修复的独立场景验证（reducer 层，不复用修复者用例）。
// 被测契约（修复自述）：calibrateBlocks 只信 content 声明——text 块仅当「其 index 被声明为 text
// 且文本一致」才留存；非 text 块不动；content 无 text 声明时不清（防误删）。
// 本文件的自建场景均在 HEAD 应为绿；同文件在 52a520d（修复前）应至少 3 条转红（敏感性在复核报告里记录）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
  type TurnBlock,
} from "../../../src/chat/lib/chatModel.ts";

const T = (text: string) => ({ type: "text", text });
const TH = (thinking: string) => ({ type: "thinking", thinking });
const TOOL = (name: string, id: string) => ({
  type: "tool_use",
  name,
  id,
  input: { file: "a.ts" },
});

function feed(state: ChatState, event: unknown): ChatState {
  return reduceHostMessage(state, {
    type: "streamEvent",
    sessionId: null,
    event,
  });
}

function newStream(): ChatState {
  let s: ChatState = { ...initialChatState(), turnStatus: "streaming" };
  s = feed(s, { kind: "messageStart" });
  return s;
}

function lastBlocks(state: ChatState): TurnBlock[] {
  const last = state.messages[state.messages.length - 1];
  return last?.blocks ?? [];
}

function textBlocks(state: ChatState): string[] {
  return lastBlocks(state)
    .filter((b) => b.blockType === "text")
    .map((b) => b.text);
}

// ---------- 主形态（真机 R2b 序列：含中途 thinking 校准）----------

test("主形态: 中途 assistantMessage[thinking] + 流式正文@1 + 末次 content 只列 text@0 → 单块一遍", () => {
  let s = newStream();
  // 真机序：thinking 先被流式建块（index 0），中途 assistantMessage 携 thinking 校准
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想一下" });
  s = feed(s, { kind: "assistantMessage", content: [TH("想一下")] });
  // 正文流式建在 index 1（thinking 之后）
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "OK" });
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  s = feed(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  assert.deepEqual(textBlocks(s), ["OK"], "正文块不是恰好一块");
  // E4b 修复后（7c33220）：thinking 保留 + 正文共存（共 2 块）
  assert.equal(
    lastBlocks(s).length,
    2,
    "收尾后应为 thinking+text 共存（E4b 修复后）",
  );
});

test("主形态·变体: 流式正文@1 长于末次声明文本 → 只留声明文本（不留半截流式残留）", () => {
  let s = newStream();
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "O" });
  s = feed(s, { kind: "textDelta", index: 1, text: "K…残帧" });
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  assert.deepEqual(
    textBlocks(s),
    ["OK"],
    "错位流式残留应与声明合并为一块且取声明文本",
  );
});

// ---------- 合法多段：不得误 merge ----------

test("合法场景: text@0 + tool@1 + text@2，两段文本完全相同 → 两段都保留且顺序不变", () => {
  let s = newStream();
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
    content: [T("我看看"), TOOL("Read", "t1"), T("我看看")],
  });
  const blocks = lastBlocks(s);
  assert.deepEqual(
    blocks.map((b) => [b.blockType, b.index]),
    [
      ["text", 0],
      ["tool", 1],
      ["text", 2],
    ],
    "合法块序列被去重逻辑改动",
  );
  assert.deepEqual(textBlocks(s), ["我看看", "我看看"]);
});

// ---------- 兄弟形态（现状跟进，非本次报障）----------

test("兄弟形态: 末次 content 声明 text@0 而 index 0 是流式 thinking 块 → 两者共存（E4b 修复后）", () => {
  let s = newStream();
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "思考全过程" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "答" });
  s = feed(s, { kind: "assistantMessage", content: [T("答")] });
  const types = lastBlocks(s).map((b) => b.blockType);
  assert.deepEqual(
    lastBlocks(s).map((b) => b.blockType),
    ["thinking", "text"],
    `thinking 应与 text 共存（E4b 修复后）——实际 ${JSON.stringify(types)}`,
  );
  // 正文仍只一遍（BUG-28 修复的靶点未被这个形态破坏）
  assert.deepEqual(textBlocks(s), ["答"]);
  assert.equal(
    lastBlocks(s).some((b) => b.blockType === "thinking"),
    true,
    "thinking 块应保留（E4b 修复后：校准补建改追加，不再顶掉）",
  );
});

test("压缩式 content（thinking 被省略）+ text + tool → 单卡、块序 thinking→text→tool（fed82ca 修复后）", () => {
  // 同族形态：流式 thinking@0 + text@1 + tool@2，末次 content 压缩成 [text@0, tool_use@1]。
  // 修复后（fed82ca）：按 index+类型取块 + 按 toolUseId 收敛 + 错位残影就地改身份
  // → thinking 保留、正文单份、工具卡单张（结果回填不丢）。
  let s = newStream();
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "我先看看" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 2,
    toolName: "Read",
    toolUseId: "t1",
  });
  s = feed(s, {
    kind: "assistantMessage",
    content: [T("我先看看"), TOOL("Read", "t1")],
  });
  const kinds = lastBlocks(s).map((b) => b.blockType);
  assert.deepEqual(
    kinds,
    ["thinking", "text", "tool"],
    `收尾后应为单卡、块序 thinking→text→tool——实际 ${JSON.stringify(kinds)}`,
  );
  assert.deepEqual(textBlocks(s), ["我先看看"], "正文仍应只有一遍");
});

// ---------- 防误删契约 ----------

test("防误删: 只声明 thinking 的 assistantMessage 早于正文收尾到达 → 流式 text 块不清", () => {
  let s = newStream();
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "先看看" });
  // 中途 assistantMessage 只列 thinking（未声明任何 text）——不得把在流的正文块清掉
  s = feed(s, { kind: "assistantMessage", content: [TH("想")] });
  assert.deepEqual(
    textBlocks(s),
    ["先看看"],
    "content 未声明 text 时不得清流式文本（防误删）",
  );
});

test("防误删: content 空数组 → 块原样（不清不建）", () => {
  let s = newStream();
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "先看看" });
  s = feed(s, { kind: "assistantMessage", content: [] });
  assert.deepEqual(textBlocks(s), ["先看看"]);
});

test("防误删: content 项畸形（text 非字符串 / 非对象项）→ 跳过且不清", () => {
  let s = newStream();
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "先看看" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [null, 42, { type: "text" }, { type: "text", text: 7 }],
  });
  assert.deepEqual(textBlocks(s), ["先看看"]);
});

// ---------- 同 index 重复（appendToBlock 允许同 index 不同 type 共存）----------

test("去重: 同 index 不同 type 共存（thinking@0 + text@0）+ 位置写入 → text 收敛且 thinking 保留", () => {
  let s = newStream();
  // 流式先建 thinking@0，随后同一 index 又建了 text@0（appendToBlock 允许同 index 不同 type）
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "OK" });
  assert.equal(lastBlocks(s).length, 2, "前置构造：应有两个同 index 块");
  // 末次 content 声明 text@0：重复 text 块必须收敛、thinking 不受清理影响（E4b 修复后）
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  assert.deepEqual(textBlocks(s), ["OK"], "同 index 重复 text 块未收敛");
  assert.equal(
    lastBlocks(s).length,
    2,
    "收尾后应为 thinking+text 共存（E4b 修复后）",
  );
});

test("幂等: 重复校准（重放同一 assistantMessage）→ 不叠块不改序", () => {
  let s = newStream();
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "OK" });
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  const once = lastBlocks(s);
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  assert.deepEqual(lastBlocks(s), once);
});

// ---------- 其它块类型与畸形兜底 ----------

test("兜底: content 非数组（null / 字符串）→ 状态原样返回", () => {
  let s = newStream();
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "OK" });
  const before = lastBlocks(s);
  s = feed(s, { kind: "assistantMessage", content: null });
  s = feed(s, { kind: "assistantMessage", content: "not-an-array" });
  assert.deepEqual(lastBlocks(s), before);
});

test("兜底: 末条不是 assistant 轮（异常序）→ 校准不动消息（不越界写）", () => {
  let s: ChatState = { ...initialChatState(), turnStatus: "streaming" };
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });
  assert.deepEqual(s.messages, []);
});
