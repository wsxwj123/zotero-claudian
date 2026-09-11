// 单测 — contextBuilder.ts：§4.1.1 缺省规则矩阵（依赖注入，fake Zotero 形态）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnContext,
  genericTurnContext,
  type ContextDeps,
  type ReaderInfo,
} from "../../src/utils/contextBuilder.ts";
import { buildPrompt } from "../../src/utils/promptTemplate.ts";

function makeDeps(overrides: Partial<ContextDeps>): ContextDeps {
  return {
    getSelectedReader: async () => null,
    getAttachment: async () => null,
    getItemMetadata: async () => null,
    ...overrides,
  };
}

const FULL_READER: ReaderInfo = {
  itemID: 101,
  pageIndex: 2, // 0-based → 物理第 3 页
  pageLabel: "iii",
  selection: {
    text: "The Transformer architecture",
    page: 3,
    parentKey: "ITEM1",
  },
};

const FULL_ATTACHMENT = {
  key: "ATTACH1",
  pdfPath: "/Users/x/papers/attention.pdf",
  pdfDir: "/Users/x/papers",
  parentItemID: 55,
};

const FULL_PARENT = {
  key: "ITEM1",
  displayTitle: "Attention Is All You Need",
  creatorNames: ["Ashish Vaswani", "Noam Shazeer"],
  date: "2017-06-12",
  doi: "10.1234/abc",
  abstractNote: "We propose the Transformer.",
};

test("contextBuilder: 完整链路 → 全字段归一 + addDir=附件目录", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => FULL_READER,
      getAttachment: async () => FULL_ATTACHMENT,
      getItemMetadata: async () => FULL_PARENT,
    }),
  );
  assert.equal(ctx.itemKey, "ITEM1");
  assert.equal(ctx.attachmentKey, "ATTACH1");
  assert.equal(ctx.addDir, "/Users/x/papers");
  assert.deepEqual(ctx.promptContext, {
    itemKey: "ITEM1",
    displayTitle: "Attention Is All You Need",
    creators: ["Ashish Vaswani", "Noam Shazeer"],
    date: "2017-06-12",
    doi: "10.1234/abc",
    abstractNote: "We propose the Transformer.",
    pdfPath: "/Users/x/papers/attention.pdf",
    currentPage: 3, // 0-based pageIndex=2 → 物理页 3
    pageLabel: "iii",
    selection: "The Transformer architecture",
    selectionPage: 3,
    selectionItemKey: "ITEM1",
  });
});

test("contextBuilder: 无 reader / 无 itemID → 通用会话（整块省略、无 addDir）", async () => {
  for (const reader of [null, { itemID: null, pageIndex: null }]) {
    const ctx = await buildTurnContext(
      makeDeps({
        getSelectedReader: async () => reader as ReaderInfo | null,
        getAttachment: async () => FULL_ATTACHMENT,
        getItemMetadata: async () => FULL_PARENT,
      }),
    );
    assert.equal(ctx.itemKey, null);
    assert.equal(ctx.attachmentKey, null);
    assert.equal(ctx.addDir, null);
    assert.deepEqual(ctx.promptContext, { itemKey: null });
  }
});

test("contextBuilder: 附件缺失 / 无父条目 / 元数据缺失 → 通用会话", async () => {
  const base = {
    getSelectedReader: async () => FULL_READER,
  };
  // 附件查无
  const a = await buildTurnContext(
    makeDeps({ ...base, getAttachment: async () => null }),
  );
  assert.equal(a.itemKey, null);
  // 独立附件（无父条目）
  const b = await buildTurnContext(
    makeDeps({
      ...base,
      getAttachment: async () => ({ ...FULL_ATTACHMENT, parentItemID: null }),
    }),
  );
  assert.equal(b.itemKey, null);
  assert.equal(b.addDir, null);
  // 父条目元数据查无
  const c = await buildTurnContext(
    makeDeps({
      ...base,
      getAttachment: async () => FULL_ATTACHMENT,
      getItemMetadata: async () => null,
    }),
  );
  assert.equal(c.itemKey, null);
});

test("contextBuilder: 缺页码 → Current page 为 null；缺划选 → selection 透传 null", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => ({
        itemID: 101,
        pageIndex: null,
        selection: null,
      }),
      getAttachment: async () => FULL_ATTACHMENT,
      getItemMetadata: async () => FULL_PARENT,
    }),
  );
  assert.equal(ctx.promptContext.currentPage, null);
  assert.equal(ctx.promptContext.selection, null);
  assert.equal(ctx.promptContext.selectionPage, null);
});

test("contextBuilder: 划选缺页码 → selectionPage null（buildPrompt 省整行，BUG-06）", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => ({
        ...FULL_READER,
        selection: {
          text: "一段没有页码的划选",
          page: null,
          parentKey: "ITEM1",
        },
      }),
      getAttachment: async () => FULL_ATTACHMENT,
      getItemMetadata: async () => FULL_PARENT,
    }),
  );
  assert.equal(ctx.promptContext.selection, "一段没有页码的划选");
  assert.equal(ctx.promptContext.selectionPage, null);
  const prompt = buildPrompt(ctx.promptContext, "这篇讲什么");
  assert.ok(!prompt.includes("Selected text"));
  assert.ok(!prompt.includes("一段没有页码的划选")); // 整行省略，划选原文不进上下文块
  assert.ok(prompt.endsWith("\n\n这篇讲什么"));
});

test("contextBuilder: 无 PDF 文件 → pdfPath/addDir 皆 null（不带 --add-dir）", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => FULL_READER,
      getAttachment: async () => ({
        ...FULL_ATTACHMENT,
        pdfPath: null,
        pdfDir: null,
      }),
      getItemMetadata: async () => FULL_PARENT,
    }),
  );
  assert.equal(ctx.promptContext.pdfPath, null);
  assert.equal(ctx.addDir, null);
  const prompt = buildPrompt(ctx.promptContext, "问");
  assert.ok(!prompt.includes("PDF path:"));
});

test("contextBuilder: 产物喂 buildPrompt → 与 §4.1.1 模板逐字一致（seam 集成）", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => FULL_READER,
      getAttachment: async () => FULL_ATTACHMENT,
      getItemMetadata: async () => FULL_PARENT,
    }),
  );
  const prompt = buildPrompt(ctx.promptContext, "这篇的结论是什么");
  assert.equal(
    prompt,
    [
      "[Zotero context]",
      "Title: Attention Is All You Need",
      "Authors: Ashish Vaswani, Noam Shazeer",
      "Year: 2017",
      "DOI: 10.1234/abc",
      "Abstract: We propose the Transformer.",
      "PDF path: /Users/x/papers/attention.pdf",
      "Current page: 3 (label: iii)",
      // pageLabel 双值格式同样作用于 Selected text 行（promptTemplate M2 锁定行为）
      'Selected text (page 3 (label: iii)): "The Transformer architecture"',
      "[/Zotero context]",
      "",
      "这篇的结论是什么",
    ].join("\n"),
  );
});

test("contextBuilder: genericTurnContext 形态固定", () => {
  assert.deepEqual(genericTurnContext(), {
    itemKey: null,
    attachmentKey: null,
    promptContext: { itemKey: null },
    addDir: null,
  });
});
