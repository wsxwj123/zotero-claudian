// 单测 — R6「独立 PDF 一等身份」契约：
// 独立 PDF（无父条目的附件）的上下文条目 = 附件自身（itemKey=附件 key、title=文件名），
// 有父条目时行为必须与既有实现逐字一致（回归零容忍）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnContext,
  genericTurnContext,
  resolveContextItem,
  type ContextDeps,
  type ItemMetadata,
  type ReaderInfo,
} from "../../src/utils/contextBuilder.ts";
import { buildPrompt } from "../../src/utils/promptTemplate.ts";
import { readerContextMessage } from "../../src/modules/contextSource.ts";

function makeDeps(overrides: Partial<ContextDeps>): ContextDeps {
  return {
    getSelectedReader: async () => null,
    getAttachment: async () => null,
    getItemMetadata: async () => null,
    ...overrides,
  };
}

/** 独立 PDF：附件自身即上下文条目（真实实现 getItemMetadata(附件id) 的产物形态） */
const STANDALONE_ATT_META: ItemMetadata = {
  key: "STANDALONE1",
  displayTitle: "follow-c.pdf",
  creatorNames: [],
  date: null,
  doi: null,
  abstractNote: null,
};

const PARENT: ItemMetadata = {
  key: "ITEM1",
  displayTitle: "Attention Is All You Need",
  creatorNames: ["Ashish Vaswani", "Noam Shazeer"],
  date: "2017-06-12",
  doi: "10.1234/abc",
  abstractNote: "We propose the Transformer.",
};

const STANDALONE_READER: ReaderInfo = {
  itemID: 101,
  pageIndex: 4, // 0-based → 物理第 5 页
  pageLabel: null,
  selection: {
    text: "standalone 划选原文",
    page: 5,
    parentKey: "STANDALONE1", // 独立 PDF：划选归属 = 附件自身 key（contextItemKeyOf 新口径）
  },
};

const STANDALONE_ATTACHMENT = {
  key: "STANDALONE1",
  pdfPath: "/Users/x/papers/follow-c.pdf",
  pdfDir: "/Users/x/papers",
  parentItemID: null,
};

test("r6: 独立 PDF → readerContext itemKey=附件key、title=文件名，页码/划选照旧", () => {
  const msg = readerContextMessage(STANDALONE_READER, STANDALONE_ATT_META);
  assert.deepEqual(msg, {
    type: "readerContext",
    itemKey: "STANDALONE1",
    title: "follow-c.pdf",
    page: 5,
    selection: "standalone 划选原文",
  });
});

test("r6 回归: 有父条目 → readerContext 与既有行为逐字一致", () => {
  const reader: ReaderInfo = {
    itemID: 101,
    pageIndex: 2,
    pageLabel: "iii",
    selection: {
      text: "The Transformer architecture",
      page: 3,
      parentKey: "ITEM1",
    },
  };
  assert.deepEqual(readerContextMessage(reader, PARENT), {
    type: "readerContext",
    itemKey: "ITEM1",
    title: "Attention Is All You Need",
    page: 3,
    selection: "The Transformer architecture",
  });
});

test("r6: 父条目为 null 但附件存在 → 上下文条目回落附件自身（不退化成全 null）", () => {
  const resolved = resolveContextItem(null, STANDALONE_ATT_META);
  assert.equal(resolved?.key, "STANDALONE1");
  // 映射端同样不得回落成 null（推送闸 itemKey==null 会整条丢弃）
  const msg = readerContextMessage(STANDALONE_READER, resolved);
  assert.equal(
    msg.type === "readerContext" ? msg.itemKey : null,
    "STANDALONE1",
  );
  assert.equal(msg.type === "readerContext" ? msg.title : null, "follow-c.pdf");
  // 父条目优先：有父条目时不得被附件顶替
  assert.equal(resolveContextItem(PARENT, STANDALONE_ATT_META)?.key, "ITEM1");
  // 两者都取不到（异常）→ null（调用方走通用/空值）
  assert.equal(resolveContextItem(null, null), null);
});

test("r6: buildTurnContext 独立 PDF → itemKey=附件key、pdfPath/addDir 有值、creators/date/doi 为 null", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => STANDALONE_READER,
      getAttachment: async () => STANDALONE_ATTACHMENT,
      getItemMetadata: async (id) => (id === 101 ? STANDALONE_ATT_META : null), // 无父条目：只会有附件自身的查询
    }),
  );
  assert.equal(ctx.itemKey, "STANDALONE1");
  assert.equal(ctx.attachmentKey, "STANDALONE1");
  assert.equal(ctx.addDir, "/Users/x/papers");
  assert.deepEqual(ctx.promptContext, {
    itemKey: "STANDALONE1",
    displayTitle: "follow-c.pdf",
    creators: [],
    date: null,
    doi: null,
    abstractNote: null,
    pdfPath: "/Users/x/papers/follow-c.pdf",
    currentPage: 5,
    pageLabel: null,
    selection: "standalone 划选原文",
    selectionPage: 5,
    selectionItemKey: "STANDALONE1",
  });
  // 附件没有 creators/abstract → 模板省行，不输出空字段怪文案；划选行照给
  const prompt = buildPrompt(ctx.promptContext, "这篇讲什么");
  assert.equal(
    prompt,
    [
      "[Zotero context]",
      "Title: follow-c.pdf",
      "PDF path: /Users/x/papers/follow-c.pdf",
      "Current page: 5",
      'Selected text (page 5): "standalone 划选原文"',
      "[/Zotero context]",
      "",
      "这篇讲什么",
    ].join("\n"),
  );
  assert.ok(!prompt.includes("Authors:"));
  assert.ok(!prompt.includes("Abstract:"));
  assert.ok(!prompt.includes("null"));
});

test("r6: 父条目查不到（被删/异常）→ 回落附件自身，不退化通用会话", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => ({
        ...STANDALONE_READER,
        selection: null,
      }),
      getAttachment: async () => ({
        ...STANDALONE_ATTACHMENT,
        parentItemID: 55, // 父条目 id 在，但元数据查不到
      }),
      getItemMetadata: async (id) => (id === 101 ? STANDALONE_ATT_META : null),
    }),
  );
  assert.equal(ctx.itemKey, "STANDALONE1");
  assert.equal(ctx.attachmentKey, "STANDALONE1");
  assert.equal(ctx.addDir, "/Users/x/papers");
});

test("r6 回归: 有父条目 → buildTurnContext 与既有行为一致（父条目元数据不进附件分支）", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => ({
        itemID: 101,
        pageIndex: 2,
        pageLabel: "iii",
        selection: {
          text: "The Transformer architecture",
          page: 3,
          parentKey: "ITEM1",
        },
      }),
      getAttachment: async () => ({
        ...STANDALONE_ATTACHMENT,
        parentItemID: 55,
      }),
      getItemMetadata: async (id) => (id === 55 ? PARENT : null),
    }),
  );
  assert.equal(ctx.itemKey, "ITEM1");
  assert.equal(ctx.attachmentKey, "STANDALONE1");
  assert.equal(ctx.addDir, "/Users/x/papers");
  assert.deepEqual(ctx.promptContext, {
    itemKey: "ITEM1",
    displayTitle: "Attention Is All You Need",
    creators: ["Ashish Vaswani", "Noam Shazeer"],
    date: "2017-06-12",
    doi: "10.1234/abc",
    abstractNote: "We propose the Transformer.",
    pdfPath: "/Users/x/papers/follow-c.pdf",
    currentPage: 3,
    pageLabel: "iii",
    selection: "The Transformer architecture",
    selectionPage: 3,
    selectionItemKey: "ITEM1",
  });
});

test("r6 回归: 无阅读器 → 仍是 genericTurnContext", async () => {
  for (const reader of [null, { itemID: null, pageIndex: null }]) {
    const ctx = await buildTurnContext(
      makeDeps({
        getSelectedReader: async () => reader as ReaderInfo | null,
        getAttachment: async () => STANDALONE_ATTACHMENT,
        getItemMetadata: async () => STANDALONE_ATT_META,
      }),
    );
    assert.deepEqual(ctx, genericTurnContext());
  }
});

test("r6 回归: 附件查无 → 仍是 genericTurnContext（不硬编附件自身）", async () => {
  const ctx = await buildTurnContext(
    makeDeps({
      getSelectedReader: async () => STANDALONE_READER,
      getAttachment: async () => null,
      getItemMetadata: async () => STANDALONE_ATT_META,
    }),
  );
  assert.deepEqual(ctx, genericTurnContext());
});
