// contextBuilder.ts — §4.1.1 上下文块数据采集与归一（PLAN §2.6 / INTERFACE §4.1.1）。
// 纯模块不 import Zotero 全局：Zotero 侧取数经 ContextDeps 依赖注入（真实实现在
// modules/contextSource.ts），node:test 用 fake deps 跑缺省规则矩阵。
// 模板格式化在 promptTemplate.buildPrompt（M2，验收锁定），本模块只负责「取数 + 缺省归一」。

import type { PromptContext } from "./promptTemplate";

/** 划选信息（发送时刻快照，PLAN §7.2 风险 7：随消息体固化，不续取） */
export interface SelectionInfo {
  text: string;
  /** 划选所在物理页（1-based）；null = 未知 → Selected text 整行省略（BUG-06 规则） */
  page: number | null;
  /** 划选所属条目的父条目 key；≠ 会话条目时 Selected text 行省略（防上下文错拼，§4.1.1） */
  parentKey: string | null;
}

/** 当前阅读器快照（Zotero.Reader.getByTabID(Zotero_Tabs.selectedID) 的归一形态） */
export interface ReaderInfo {
  /** 正在阅读的附件条目 id；null = 取不到（非阅读态/内部形态变化） */
  itemID: number | null;
  /** 当前页 index（0-based，reader.state.pageIndex）；null = 未知 → 省 Current page 行 */
  pageIndex: number | null;
  /** pageLabel（物理页同值时模板不双写）；null = 取不到 → 只写物理页码 */
  pageLabel?: string | null;
  selection?: SelectionInfo | null;
}

/** 附件（PDF）信息 */
export interface AttachmentInfo {
  key: string;
  /** getFilePathAsync 产物（原生分隔符原样，§4.1.1 OS 差异句）；null = 无文件 → 省 PDF path 行且不带 --add-dir */
  pdfPath: string | null;
  /** PDF 所在目录（--add-dir 参数值）；null = 无文件 */
  pdfDir: string | null;
  /** 父条目 id；null = 独立附件（R6：上下文条目回落附件自身，不再退化成通用会话） */
  parentItemID: number | null;
}

/** 条目元数据（父条目，或独立 PDF 的附件自身——后者除 key/displayTitle 外皆为 null/空） */
export interface ItemMetadata {
  key: string;
  displayTitle: string | null;
  creatorNames: string[];
  date: string | null;
  doi: string | null;
  abstractNote: string | null;
}

/** Zotero 取数注入面（真实实现见 modules/contextSource.ts） */
export interface ContextDeps {
  getSelectedReader(): Promise<ReaderInfo | null>;
  getAttachment(itemID: number): Promise<AttachmentInfo | null>;
  getItemMetadata(itemID: number): Promise<ItemMetadata | null>;
}

export interface TurnContext {
  /** 会话绑定条目 key（父条目优先；独立 PDF = 附件自身 key）；null = 通用会话（上下文块整块省略） */
  itemKey: string | null;
  attachmentKey: string | null;
  promptContext: PromptContext;
  /** --add-dir 参数值；null = 不带 */
  addDir: string | null;
}

/** 通用会话上下文：无条目 → 上下文块整块省略、不带 --add-dir（§4.1.1） */
export function genericTurnContext(): TurnContext {
  return {
    itemKey: null,
    attachmentKey: null,
    promptContext: { itemKey: null },
    addDir: null,
  };
}

/**
 * 上下文条目（R6 契约）：父条目优先；无父条目（独立 PDF）或父条目查不到（被删/异常）
 * → 回落附件自身。null = 两者都取不到（异常）→ 调用方走通用会话/空值。
 * 发送轮（buildTurnContext）与推送轮（sections.buildReaderContext）共用此唯一口径。
 */
export function resolveContextItem(
  parent: ItemMetadata | null,
  attachmentItem: ItemMetadata | null,
): ItemMetadata | null {
  return parent ?? attachmentItem;
}

/**
 * 采集当前 turn 的上下文（发送瞬间快照）：
 * reader → 附件 → 上下文条目（父条目优先；独立 PDF 或父条目查不到 → 附件自身）。
 * 只有连附件条目都取不到才退化为通用会话（整块省略）。
 * reader.state.pageIndex 为 0-based，物理页码统一 +1（§4.1.1 页码统一物理页）。
 * 划选/页码缺省行的取舍交给 promptTemplate（验收锁定），此处只透传归一后的值。
 */
export async function buildTurnContext(
  deps: ContextDeps,
): Promise<TurnContext> {
  const reader = await deps.getSelectedReader();
  if (!reader || reader.itemID == null) {
    return genericTurnContext();
  }
  const attachment = await deps.getAttachment(reader.itemID);
  if (!attachment) {
    return genericTurnContext();
  }
  const parent =
    attachment.parentItemID == null
      ? null
      : await deps.getItemMetadata(attachment.parentItemID);
  const contextItem = resolveContextItem(
    parent,
    parent ? null : await deps.getItemMetadata(reader.itemID),
  );
  if (!contextItem) {
    return genericTurnContext();
  }
  const selection = reader.selection ?? null;
  const promptContext: PromptContext = {
    itemKey: contextItem.key,
    displayTitle: contextItem.displayTitle,
    creators: contextItem.creatorNames,
    date: contextItem.date,
    doi: contextItem.doi,
    abstractNote: contextItem.abstractNote,
    pdfPath: attachment.pdfPath,
    currentPage: reader.pageIndex == null ? null : reader.pageIndex + 1,
    pageLabel: reader.pageLabel ?? null,
    selection: selection?.text ?? null,
    selectionPage: selection ? selection.page : null,
    selectionItemKey: selection?.parentKey ?? null,
  };
  return {
    itemKey: contextItem.key,
    attachmentKey: attachment.key,
    promptContext,
    addDir: attachment.pdfDir,
  };
}
