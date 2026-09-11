// 单测 — BUG-07：history 回放的 assistant 消息（只有 text 无 blocks）必须走 markdown 渲染路径
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantTurnContent } from "../../src/chat/lib/chatModel.ts";

test("BUG-07: history 回放 assistant turn（text 无 blocks）→ markdown 路径", () => {
  const c = assistantTurnContent({ role: "assistant", text: "# 回放标题" });
  assert.deepEqual(c, { kind: "markdown", text: "# 回放标题" });
});

test("BUG-07: 流式 assistant turn（有 blocks）→ 块流路径", () => {
  const blocks = [{ blockType: "text", index: 0, text: "x", streaming: false }];
  const c = assistantTurnContent({ role: "assistant", blocks });
  assert.deepEqual(c, { kind: "blocks", blocks });
});

test("BUG-07: 空 blocks 数组且有 text → 回落 markdown 路径", () => {
  const c = assistantTurnContent({
    role: "assistant",
    blocks: [],
    text: "正文",
  });
  assert.deepEqual(c, { kind: "markdown", text: "正文" });
});

test("BUG-07: 修复前该分支缺失（无 blocks 直接渲染块流 → 空气泡）；helper 保证 text 兜底", () => {
  const c = assistantTurnContent({ role: "assistant", text: "内容" });
  assert.equal(c.text, "内容");
});
