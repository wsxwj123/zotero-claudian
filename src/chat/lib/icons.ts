// 手写线性图标（用户反馈：消息操作条「复制 / 编辑 / 分支 / 存笔记」用简笔画图标，
// 输入区「+ 范围 / 📎 附件」空间不够时只留图标）。
//
// 为什么手写而非图标库：本页是 CSP `default-src 'none'` 的 chrome:// 特权页，
// 不引任何外部字体/图片；图标库的 tree-shaking 与版本面都不值得为 7 个形状引入。
// 口径：24 单位 viewBox + `stroke-width = 1.5 * 24 / size`（描边在渲染尺寸上恒为 1.5px）、
// `currentColor` 跟随文字色、`aria-hidden` —— 语义由按钮的 title/aria-label 提供。
import { h } from "preact";
import type { VNode } from "preact";

export type IconName =
  "copy" | "check" | "edit" | "branch" | "note" | "plus" | "paperclip";

/** 每个图标 = 一组 path 的 d（24×24 坐标系；只描边不填充） */
const PATHS: Record<IconName, string[]> = {
  // 两张错开的卡片：复制
  copy: [
    "M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 17.5z",
    "M6 15.5A1.5 1.5 0 0 1 4.5 14V6.5A1.5 1.5 0 0 1 6 5h7.5A1.5 1.5 0 0 1 15 6.5V7",
  ],
  check: ["M20 6.5 9.8 16.5 4.5 11.4"],
  // 铅笔（编辑后重发）
  edit: [
    "M17.2 3.6a2.3 2.3 0 0 1 3.2 3.2L8.2 19 4 20.2 5.2 16z",
    "M15.2 5.6 18.6 9",
  ],
  // git 分叉：一条主线 + 一条拐出去的分支
  branch: [
    "M6.5 4.5v10",
    "M6.5 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M17.5 9.5v.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 0 6.5 19",
  ],
  // 带折角的文档 + 三条线：存为笔记
  note: [
    "M6.5 3.5h7L18.5 8v11.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z",
    "M13 3.5V8h5",
    "M9 12.5h6M9 16h4",
  ],
  plus: ["M12 5.5v13M5.5 12h13"],
  // 回形针
  paperclip: [
    "M20 11.6 11.6 20a5 5 0 0 1-7.1-7.1l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.6 1.6 0 0 1-2.3-2.3l7.9-7.9",
  ],
};

/**
 * 线性图标节点。size 默认 16；描边按 size 反算，保证任何尺寸下都是 1.5px 视觉粗细。
 */
export function icon(name: IconName, size = 16): VNode<any> {
  const strokeWidth = Math.round(((1.5 * 24) / size) * 100) / 100;
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    ...PATHS[name].map((d) => h("path", { d })),
  );
}
