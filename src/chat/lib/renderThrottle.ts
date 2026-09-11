// 流式 Markdown 重渲染节流（用户实测反馈「Zotero 好卡」的根因修复）。
//
// 根因：MarkdownBlock 原先对每个 delta 全量 renderMarkdown（marked 重解析 + DOMPurify 消毒）
// 再把整棵 DOM 换掉——单次成本随回答长度线性增长，一轮 200 个 delta 就是 O(n²)；
// 聊天页与 Zotero 同进程同主线程，长回答时整机发钝。
//
// 这里只放「要不要现在渲染 / 还要等多久」的纯判定（node:test 可测）；
// 合并调度（setTimeout 定时器）在组件侧，时钟经 Date.now() 注入。

/** 流式期间两次重渲染的最小间隔（毫秒）。 */
export const STREAM_RENDER_INTERVAL_MS = 150;
// 取值依据：60ms 以下人眼仍看得出「逐字长出来」，但省不下多少解析；250ms 以上会显顿。
// 150ms ≈ 6.7 帧/秒的刷新节奏——流式末尾的观感与「每 delta 一次」（本机实测 delta 间隔
// 约 20–60ms）基本无差别，而重解析次数掉到 1/5–1/10（真机 harness 前后对照见报告）。

/**
 * 现在该不该真正重渲染？
 * - 非流式（含流式刚结束的那一帧）：恒 true —— 最后一帧必须落，不许被节流吞掉。
 * - 流式：距上次真实渲染 ≥ intervalMs 才渲染（首帧 / 从未渲染过 → true）。
 */
export function shouldRender(
  now: number,
  lastRenderedAt: number,
  streaming: boolean,
  intervalMs: number = STREAM_RENDER_INTERVAL_MS,
): boolean {
  if (!streaming) {
    return true;
  }
  if (!Number.isFinite(lastRenderedAt)) {
    return true; // 从未渲染过（约定传 -Infinity）→ 先画一帧再说
  }
  return now - lastRenderedAt >= intervalMs;
}

/**
 * 距「可以渲染」还差多少毫秒（给 setTimeout 用）：未到点返回剩余量（0 < d ≤ interval），
 * 已达间隔 / 从未渲染过 → 0。时钟回拨（now < last）按差值顺延，绝不排负延迟的定时器。
 */
export function nextRenderDelay(
  now: number,
  lastRenderedAt: number,
  intervalMs: number = STREAM_RENDER_INTERVAL_MS,
): number {
  if (!Number.isFinite(lastRenderedAt)) {
    return 0;
  }
  return Math.max(0, intervalMs - (now - lastRenderedAt));
}
