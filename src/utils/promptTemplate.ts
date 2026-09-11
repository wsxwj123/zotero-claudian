// promptTemplate.ts — §4.1.1 prompt 模板组装（INTERFACE.md）
// 纯函数，不 import Zotero 全局。上下文块在前、用户输入原样在后；通用会话（无条目）整块省略。

/** 划选原文长度上限（INTERFACE §4.1.1：保留换行、超长截断） */
const SELECTION_MAX_CHARS = 10000;

export interface PromptContext {
  /** 会话绑定条目 key；null = 通用会话（整个上下文块省略） */
  itemKey: string | null;
  displayTitle?: string | null;
  creators?: string[] | null;
  /** 出版日期（取年份）；无则省 Year 行 */
  date?: string | null;
  /** 无则省 DOI 行 */
  doi?: string | null;
  /** 无则省 Abstract 行 */
  abstractNote?: string | null;
  /** PDF 附件绝对路径（原生分隔符原样，不转义不改写）；无则省行且调用方不带 --add-dir */
  pdfPath?: string | null;
  /** 当前物理页码 */
  currentPage?: number | null;
  /** pageLabel 与物理页不同时写 "{物理页码} (label: {pageLabel})" */
  pageLabel?: string | null;
  /** 划选原文（保留换行）；无则省 Selected text 行 */
  selection?: string | null;
  /** 划选所在物理页码；缺失时 Selected text 整行省略（BUG-06） */
  selectionPage?: number | null;
  /** 划选所属条目 key；≠ itemKey 时省 Selected text 行（防上下文错拼） */
  selectionItemKey?: string | null;
}

/** 块内值单行化：换行（含 \r\n）替换为空格。Selected text 不经此处理（保留原文换行） */
function oneLine(value: string): string {
  return value.replace(/\r\n?|\n/g, " ");
}

/** 页码格式：物理页码，pageLabel 存在且与物理页不同 → "{页码} (label: {pageLabel})" */
function formatPage(
  page: number,
  pageLabel: string | null | undefined,
): string {
  if (pageLabel && String(pageLabel) !== String(page)) {
    return `${page} (label: ${pageLabel})`;
  }
  return String(page);
}

/**
 * 组装 prompt：[Zotero context] 块（缺省字段省行）+ 空行 + [Referenced items] 块（R7-B，可选）
 * + 空行 + 用户输入原样。通用会话（itemKey=null）输出即用户输入原样（有引用块时块在前）。
 */
export function buildPrompt(
  ctx: PromptContext,
  userInput: string,
  referencedBlock?: string | null,
): string {
  // R7-B：引用块排在当前文献上下文**之后**（PLAN §3），没有当前文献时也照给
  const refs =
    referencedBlock && referencedBlock.trim() ? referencedBlock.trim() : "";
  if (ctx.itemKey == null) {
    return refs ? `${refs}\n\n${userInput}` : userInput;
  }

  const lines: string[] = ["[Zotero context]"];

  if (ctx.displayTitle) {
    lines.push(`Title: ${oneLine(ctx.displayTitle)}`);
  }
  if (ctx.creators && ctx.creators.length > 0) {
    lines.push(`Authors: ${ctx.creators.join(", ")}`);
  }
  const year = ctx.date?.match(/\d{4}/)?.[0];
  if (year) {
    lines.push(`Year: ${year}`);
  }
  if (ctx.doi) {
    lines.push(`DOI: ${oneLine(ctx.doi)}`);
  }
  if (ctx.abstractNote) {
    lines.push(`Abstract: ${oneLine(ctx.abstractNote)}`);
  }
  if (ctx.pdfPath) {
    // PDF path 保留各 OS 原生分隔符（win32 反斜杠原样：经 stdin 不经 shell，无需转义）
    lines.push(`PDF path: ${ctx.pdfPath}`);
  }
  if (ctx.currentPage != null) {
    lines.push(`Current page: ${formatPage(ctx.currentPage, ctx.pageLabel)}`);
  }
  const hasSelection =
    !!ctx.selection &&
    !!ctx.selectionItemKey &&
    ctx.selectionItemKey === ctx.itemKey &&
    ctx.selectionPage != null; // 划选存在但拿不到页码 → 整行省略，不输出空括号畸形行（BUG-06）
  if (hasSelection) {
    let text = ctx.selection as string;
    if (text.length > SELECTION_MAX_CHARS) {
      text = text.slice(0, SELECTION_MAX_CHARS);
    }
    lines.push(
      `Selected text (page ${formatPage(ctx.selectionPage as number, ctx.pageLabel)}): "${text}"`,
    );
  }

  if (refs) {
    lines.push("[/Zotero context]", "", refs, "", userInput);
  } else {
    lines.push("[/Zotero context]", "", userInput);
  }
  return lines.join("\n");
}
