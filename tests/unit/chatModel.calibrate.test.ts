// 单测 — calibrateBlocks 的块集收敛（BUG-28：AI 正文在 UI 重复渲染两遍）。
// 缺陷形态（真机 R2b 实测）：CLI 流式的 content_block 下标与最终 assistantMessage.content[]
// 的下标可能整体错位（流式 thinking@0、正文@1；最终 content 只列 [text]@0），按 index 校准后
// 流式残留的正文块原样留着 → 两个相同 text 块 → MessageList 逐块渲染两遍。
// 修复口径：校准只信 content 声明（text 块的 index 被声明为 text 且文本一致才留存）；
// 按下标补建一律追加、不写 array 位——位 i 可能已被流式建的同 index 异类块占着（E4b：
// 按位写会把流式 thinking 块顶掉，回合收尾后「思考过程」折叠区整块消失）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
  type TurnBlock,
} from "../../src/chat/lib/chatModel.ts";

function feed(state: ChatState, event: unknown): ChatState {
  return reduceHostMessage(state, {
    type: "streamEvent",
    sessionId: null,
    event,
  });
}

/** 从 waiting 起步：reduceStreamEvent 对 idle 态一律丢弃（BUG-09 守卫） */
function streaming0(): ChatState {
  return { ...initialChatState(), turnStatus: "streaming" };
}

function blocksOf(state: ChatState): TurnBlock[] {
  const last = state.messages[state.messages.length - 1];
  return last?.blocks ?? [];
}

function textBlocksOf(state: ChatState): string[] {
  return blocksOf(state)
    .filter((b) => b.blockType === "text")
    .map((b) => b.text);
}

const T = (text: string) => ({ type: "text", text });
const TH = (thinking: string) => ({ type: "thinking", thinking });

test("BUG-28: 流式 thinking@0 + 正文@1，最终 content=[text@0] → 正文单块且 thinking 保留", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "assistantMessage", content: [TH("想一下")] });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "OK" });
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });

  assert.deepEqual(
    textBlocksOf(s),
    ["OK"],
    "错位残留的正文块未收敛 → 渲染两遍",
  );
  // E4b：收尾校准不得把流式的 thinking 块顶掉（可按位写会整块消失，用户回看不了）
  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["thinking", "text"],
    "thinking 块被收尾校准顶掉（E4b：折叠区消失）",
  );
  assert.equal(blocksOf(s)[0].text, "想一下");
});

test("E4b: 回合完全收尾（result 后）thinking 折叠区仍在且已收起，正文单份", () => {
  // 真机 E4b 序列：thinkingDelta 建 thinking@0 → 正文流式@1 → 末次 content 只列 text@0 → result
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "思考全过程" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "设鸡 c 只" });
  s = feed(s, { kind: "assistantMessage", content: [T("设鸡 c 只")] });
  s = feed(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });

  const thinking = blocksOf(s).filter((b) => b.blockType === "thinking");
  assert.equal(
    thinking.length,
    1,
    "收尾后 thinking 块消失（E4b.afterTurn 为空）",
  );
  assert.equal(thinking[0].text, "思考全过程");
  assert.equal(
    thinking[0].streaming,
    false,
    "收尾后折叠区应已收起（非流式态）",
  );
  assert.deepEqual(textBlocksOf(s), ["设鸡 c 只"], "正文应仍只一份");
});

test("BUG-28: 同 index 不同 type 共存（thinking@0 + 流式正文@0）→ 正文一块且 thinking 保留", () => {
  // appendToBlock 允许同 index 不同 type 共存；calibrate 补建若不追加而按位写会出现两个 text@0
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "OK" });
  s = feed(s, { kind: "assistantMessage", content: [T("OK")] });

  assert.deepEqual(textBlocksOf(s), ["OK"], "同 index 重复 text 块未收敛");
  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["thinking", "text"],
    "thinking 块被顶掉",
  );
});

test("E4b 对照: 无 thinking 的回复零回归（收尾后仍单块、块序不变）", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "直答" });
  s = feed(s, { kind: "assistantMessage", content: [T("直答")] });
  s = feed(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });

  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["text"],
  );
  assert.deepEqual(textBlocksOf(s), ["直答"]);
});

test("BUG-28 对照: 无 thinking 占位（流式正文@0 对齐 content@0）→ 单块一遍", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "第一段" });
  s = feed(s, { kind: "assistantMessage", content: [T("第一段")] });

  assert.deepEqual(textBlocksOf(s), ["第一段"]);
});

test("BUG-28 对照: 同文本 assistantMessage 重放（多次校准）→ 幂等单块", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "甲" });
  s = feed(s, { kind: "assistantMessage", content: [T("甲")] });
  s = feed(s, { kind: "assistantMessage", content: [T("甲")] });

  assert.deepEqual(textBlocksOf(s), ["甲"]);
});

test("BUG-28 对照: 文本 + 工具 + 文本（content 全声明）→ 三块全留，不误 merge", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "先查" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Bash",
    toolUseId: "t1",
  });
  s = feed(s, { kind: "toolInputDelta", index: 1, jsonFragment: '{"a":1}' });
  s = feed(s, { kind: "textBlockStart", index: 2 });
  s = feed(s, { kind: "textDelta", index: 2, text: "查完了" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [
      T("先查"),
      { type: "tool_use", id: "t1", name: "Bash", input: { a: 1 } },
      T("查完了"),
    ],
  });

  assert.deepEqual(textBlocksOf(s), ["先查", "查完了"]);
  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["text", "tool", "text"],
  );
});

test("BUG-28 对照: 两段声明文本恰好相同 → 两条都留（声明为准，不按文本去重）", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "textBlockStart", index: 0 });
  s = feed(s, { kind: "textDelta", index: 0, text: "好" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Bash",
    toolUseId: "t1",
  });
  s = feed(s, { kind: "textBlockStart", index: 2 });
  s = feed(s, { kind: "textDelta", index: 2, text: "好" });
  s = feed(s, {
    kind: "assistantMessage",
    content: [
      T("好"),
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      T("好"),
    ],
  });

  assert.deepEqual(textBlocksOf(s), ["好", "好"]);
});

test("BUG-28 边界: content 不含 text 声明（如只含 tool_use）→ 流式文本不清理", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 0,
    toolName: "Bash",
    toolUseId: "t1",
  });
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
  });

  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["tool"],
  );
  assert.equal(blocksOf(s)[0].streaming, false);
});

// ---- 工具卡去重（与 E4b 同根因：content 压缩省略 thinking → tool_use 下标错位）----

const TOOL = (name: string, id: string, input: unknown = { file: "a.ts" }) => ({
  type: "tool_use",
  name,
  id,
  input,
});

function toolsOf(
  state: ChatState,
): Extract<TurnBlock, { blockType: "tool" }>[] {
  return blocksOf(state).filter(
    (b): b is Extract<TurnBlock, { blockType: "tool" }> =>
      b.blockType === "tool",
  );
}

test("工具卡去重: 压缩式 content（省略 thinking）+ text + tool → 单卡、结果回填完好、块序不乱", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, { kind: "textBlockStart", index: 1 });
  s = feed(s, { kind: "textDelta", index: 1, text: "我先看看" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 2,
    toolName: "Read",
    toolUseId: "t1",
  });
  s = feed(s, { kind: "toolInputDelta", index: 2, jsonFragment: '{"f":1}' });
  // 末次 content 压缩：thinking 被省略 → text@0、tool_use@1（流式是 text@1、tool@2）
  s = feed(s, {
    kind: "assistantMessage",
    content: [T("我先看看"), TOOL("Read", "t1")],
  });
  s = feed(s, {
    kind: "toolResult",
    toolUseId: "t1",
    isError: false,
    summary: "done",
  });

  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["thinking", "text", "tool"],
    "块序/块数被校准打乱（正文不得被甩到工具卡后面，工具卡不得重复）",
  );
  const tools = toolsOf(s);
  assert.equal(tools.length, 1, "同一 tool_use 渲染成两张卡");
  assert.equal(tools[0].toolUseId, "t1");
  assert.deepEqual(
    tools[0].result,
    { isError: false, summary: "done" },
    "toolResult 未回填到唯一那张卡",
  );
  assert.deepEqual(textBlocksOf(s), ["我先看看"], "正文应仍只一份");
  assert.equal(blocksOf(s)[0].text, "想", "thinking 块被顶掉（E4b 回归）");
});

test("工具卡对照: 正常无压缩（thinking@0 + tool_use@1 对齐）→ 单卡、结果回填、零回归", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "t1",
  });
  s = feed(s, { kind: "toolInputDelta", index: 1, jsonFragment: '{"f":1}' });
  s = feed(s, {
    kind: "assistantMessage",
    content: [TH("想"), TOOL("Read", "t1")],
  });
  s = feed(s, {
    kind: "toolResult",
    toolUseId: "t1",
    isError: false,
    summary: "ok",
  });

  assert.deepEqual(
    blocksOf(s).map((b) => b.blockType),
    ["thinking", "tool"],
  );
  const tools = toolsOf(s);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].result?.summary, "ok");
  assert.ok(
    tools[0].inputJson.includes('"file"'),
    "对齐场景应按声明更新入参（零回归）",
  );
  assert.ok(
    !tools[0].inputJson.includes('"f":1'),
    "对齐场景的入参没被声明值替换（零回归）",
  );
});

test("工具卡对照: 并行两把（不同 id、压缩式错位）→ 两卡都在、id 入参不串、结果各归各卡", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Read",
    toolUseId: "a",
  });
  s = feed(s, { kind: "toolInputDelta", index: 1, jsonFragment: '{"a":1}' });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 2,
    toolName: "Bash",
    toolUseId: "b",
  });
  s = feed(s, { kind: "toolInputDelta", index: 2, jsonFragment: '{"b":2}' });
  s = feed(s, {
    kind: "assistantMessage",
    content: [TOOL("Read", "a"), TOOL("Bash", "b")],
  });
  s = feed(s, {
    kind: "toolResult",
    toolUseId: "a",
    isError: false,
    summary: "A 完成",
  });
  s = feed(s, {
    kind: "toolResult",
    toolUseId: "b",
    isError: false,
    summary: "B 完成",
  });

  const tools = toolsOf(s);
  assert.deepEqual(
    tools.map((t) => t.toolUseId),
    ["a", "b"],
    "并行工具卡被误并/误删",
  );
  assert.deepEqual(
    tools.map((t) => t.result?.summary),
    ["A 完成", "B 完成"],
    "结果未按 toolUseId 归位",
  );
  assert.ok(tools[0].inputJson.includes('"a"'), "A 的入参串进了 B 的卡");
  assert.ok(tools[1].inputJson.includes('"b"'), "B 的入参串进了 A 的卡");
});

test("工具卡边界: content 项缺 id（畸形）→ 退回按位配对不误增块；空 id 块不参与 id 收敛", () => {
  let s = streaming0();
  s = feed(s, { kind: "messageStart" });
  s = feed(s, {
    kind: "toolBlockStart",
    index: 0,
    toolName: "Read",
    toolUseId: "t1",
  });
  // id 缺失 → 仍按 index 配对（不得另建一张卡）
  s = feed(s, {
    kind: "assistantMessage",
    content: [{ type: "tool_use", name: "Read", input: { y: 2 } }],
  });
  const tools = toolsOf(s);
  assert.equal(tools.length, 1, "畸形 content 项导致工具卡重复");
  assert.equal(tools[0].toolUseId, "t1", "流式已有 id 被畸形项覆盖");
  assert.ok(tools[0].inputJson.includes('"y"'), "按位配对未更新入参");

  // 两把「无 id」工具（畸形）→ 无法证明是同一把，两张都留
  let s2 = streaming0();
  s2 = feed(s2, { kind: "messageStart" });
  s2 = feed(s2, { kind: "toolBlockStart", index: 0, toolName: "Read" });
  s2 = feed(s2, { kind: "toolBlockStart", index: 1, toolName: "Bash" });
  assert.equal(toolsOf(s2).length, 2, "无 id 工具被误并成一卡");
});
