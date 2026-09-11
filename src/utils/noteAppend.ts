// noteAppend.ts — 笔记追加拼接（纯函数，可 node 单测；M7，INTERFACE §4.3）。
// 追加语义：目标笔记 HTML 末尾追加 `<hr>` + 时间戳小字 + 内容段；原文一个字符都不动
//（不做规范化、不重排、不补默认值——原文残缺也照原样保留，追加不是修复）。

/**
 * 追加拼接：`existingHtml` 原样在前，接分隔与标记，再接新内容。
 * `appendedAtIso` 为追加时刻的 ISO 字符串（调用方给，便于测试与固定格式）。
 */
export function appendNoteHtml(
  existingHtml: string,
  contentHtml: string,
  appendedAtIso: string,
): string {
  return (
    existingHtml +
    `<hr><p><small>zotero-claudian 追加（${appendedAtIso}）</small></p>` +
    contentHtml
  );
}
