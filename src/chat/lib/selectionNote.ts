// 选段存笔记（用户反馈：「只能把本轮回答的所有内容追加为笔记」→ 要选段粒度）。
// 规则：选区非空、非纯空白、且落在单条 assistant 消息容器内 → 只存选中部分；
// 其余（无选区 / 选在别处 / 纯空白）→ 整轮保存（原行为，零回归）。
// 选段一律取纯文本（selection.toString()），跨块/跨元素由浏览器拼接——不做富结构提取。
// DOM 依赖经形参注入（SelectionLike），本模块不 import Zotero 全局，node:test 可测。

/** window.getSelection() 的最小表面（生产传真实 Selection，测试注入伪造对象） */
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString(): string;
  getRangeAt(index: number): { commonAncestorContainer: unknown };
}

/** 选区命中的可存内容：所属 assistant 消息序号（渲染层 data-turn-index）+ 选中文本 */
export interface SelectedNote {
  turnIndex: number;
  text: string;
}

/**
 * 从节点向上找所属 assistant 消息容器（渲染层在 .msg.assistant 上打了 data-turn-index）。
 * 文本节点先取其父元素；不在消息内（含已脱离文档）返回 null。
 */
function closestAssistantMessage(node: unknown): Element | null {
  if (node === null || node === undefined) {
    return null;
  }
  const n = node as Node;
  const el =
    n.nodeType === 1
      ? (n as unknown as Element)
      : ((n as { parentElement?: Element | null }).parentElement ?? null);
  return el ? el.closest(".msg.assistant") : null;
}

/**
 * 从当前选区解析「可存选段」：无效选区（折叠 / 无 range / 纯空白 / 不在单条 assistant
 * 消息内 / 容器缺 data-turn-index）一律 null。
 * 归属用 range.commonAncestorContainer 而非 anchorNode：跨消息划选时公共祖先落在消息容器
 * 之外 → 判 null（走整轮），不会把别条消息的文字算进 anchor 所在的那一条。
 */
export function resolveSelectedNote(
  sel: SelectionLike | null,
): SelectedNote | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }
  const text = sel.toString();
  if (text.trim() === "") {
    return null;
  }
  let root: unknown;
  try {
    root = sel.getRangeAt(0).commonAncestorContainer;
  } catch {
    return null; // 选区引用的节点已从文档移除等异常情形：当无选区处理
  }
  const el = closestAssistantMessage(root);
  if (!el) {
    return null;
  }
  const raw = el.getAttribute("data-turn-index");
  if (raw === null || raw === "") {
    return null;
  }
  const turnIndex = Number(raw);
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    return null;
  }
  return { turnIndex, text };
}

/** 「存为笔记」该存什么：选区命中本消息 → 选段文本；否则整轮原文（现状） */
export function noteSourceText(
  wholeText: string,
  selected: SelectedNote | null,
  turnIndex: number,
): string {
  return selected !== null && selected.turnIndex === turnIndex
    ? selected.text
    : wholeText;
}
