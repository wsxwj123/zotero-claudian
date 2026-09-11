// 单测 — contextSource.ts 的纯映射部分：§4.6 readerContext 消息组装。
// 现实路径（Zotero.Reader 取数）另由真机验证；这里锁「DI 数据 → 消息」的三字段真值。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readerContextMessage } from "../../src/modules/contextSource.ts";
import type {
  ItemMetadata,
  ReaderInfo,
} from "../../src/utils/contextBuilder.ts";

const READER: ReaderInfo = {
  itemID: 101,
  pageIndex: 2, // 0-based → 物理第 3 页
  pageLabel: "iii",
  selection: {
    text: "The Transformer architecture",
    page: 3,
    parentKey: "ITEM1",
  },
};

const PARENT: ItemMetadata = {
  key: "ITEM1",
  displayTitle: "Attention Is All You Need",
  creatorNames: ["Vaswani"],
  date: "2017",
  doi: null,
  abstractNote: null,
};

test("readerContext: 完整数据 → itemKey/title/page/selection 三字段真值", () => {
  const msg = readerContextMessage(READER, PARENT);
  assert.deepEqual(msg, {
    type: "readerContext",
    itemKey: "ITEM1",
    title: "Attention Is All You Need",
    page: 3, // 物理页码 = pageIndex + 1
    selection: "The Transformer architecture",
  });
});

test("readerContext: 无阅读器 / 无附件 id → 整条空值（UI 显示空态）", () => {
  const empty = {
    type: "readerContext",
    itemKey: null,
    title: null,
    page: null,
    selection: null,
  };
  assert.deepEqual(readerContextMessage(null, PARENT), empty);
  assert.deepEqual(
    readerContextMessage({ itemID: null, pageIndex: 1 }, PARENT),
    empty,
  );
});

test("readerContext: 父条目取不到 → title/itemKey 为 null，页码与划选照常给", () => {
  const msg = readerContextMessage(READER, null);
  assert.equal(msg.type === "readerContext" ? msg.itemKey : "x", null);
  assert.equal(msg.type === "readerContext" ? msg.title : "x", null);
  assert.equal(msg.type === "readerContext" ? msg.page : "x", 3);
  assert.equal(
    msg.type === "readerContext" ? msg.selection : "x",
    "The Transformer architecture",
  );
});

test("readerContext: pageIndex 取不到（未渲染/内部形态变化）→ page null，其余不受影响", () => {
  const msg = readerContextMessage({ ...READER, pageIndex: null }, PARENT);
  assert.equal(msg.type === "readerContext" ? msg.page : "x", null);
  assert.equal(
    msg.type === "readerContext" ? msg.title : "x",
    "Attention Is All You Need",
  );
});

test("readerContext: 无划选 → selection null（标题/页码照常）", () => {
  const msg = readerContextMessage({ ...READER, selection: null }, PARENT);
  assert.equal(msg.type === "readerContext" ? msg.selection : "x", null);
  assert.equal(msg.type === "readerContext" ? msg.page : "x", 3);
});

test("readerContext: 第 1 页（pageIndex 0）不被当成缺省掉", () => {
  const msg = readerContextMessage({ ...READER, pageIndex: 0 }, PARENT);
  assert.equal(msg.type === "readerContext" ? msg.page : "x", 1);
});
