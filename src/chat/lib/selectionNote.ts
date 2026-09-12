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
  getRangeAt(index: number): {
    commonAncestorContainer: unknown;
    /** 真实 Range 恒有两端；测试替身可省略（省略时只走公共祖先那条路，行为与 R13 前一致） */
    startContainer?: unknown;
    endContainer?: unknown;
  };
}

/** 选区命中的可存内容：所属 assistant 消息序号（渲染层 data-turn-index）+ 选中文本 */
export interface SelectedNote {
  turnIndex: number;
  text: string;
}

/**
 * 从节点向上找所属 assistant 消息容器（渲染层在 .msg.assistant 上打了 data-turn-index）。
 * 文本节点先取其父元素；不在消息内（含已脱离文档）返回 null。
 *
 * R13：条带（R13 把思考/工具块搬出了正文行）内的选段也要能存笔记——先按原口径找 `.msg.assistant`，
 * 未命中再兜底向上找 `.strip-block`（条带里的每个块容器都带 data-turn-index）。
 * **必须 `??` 二次调用**，不得把两个选择器拼成一个字符串：既有单测逐字断言第一次调用的选择器串。
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
  return el
    ? (el.closest(".msg.assistant") ?? el.closest(".strip-block"))
    : null;
}

/**
 * 节点归属的 assistant 行下标：不在 assistant 行内 / 缺 data-turn-index / 非法值 → null。
 * **注意不能拿元素本身当归属判据**——同一条助手行的正文气泡与条带块是两个不同元素（只是
 * data-turn-index 相同），比元素身份会把「条带块 ↔ 正文气泡」这种合法选段判成跨行。
 */
function turnIndexOf(node: unknown): number | null {
  const el = closestAssistantMessage(node);
  if (!el) {
    return null;
  }
  const raw = el.getAttribute("data-turn-index");
  if (raw === null || raw === "") {
    return null;
  }
  const turnIndex = Number(raw);
  return Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex : null;
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
  let range: ReturnType<SelectionLike["getRangeAt"]>;
  try {
    range = sel.getRangeAt(0);
  } catch {
    return null; // 选区引用的节点已从文档移除等异常情形：当无选区处理
  }
  let turnIndex = turnIndexOf(range.commonAncestorContainer);
  if (turnIndex === null) {
    // R13：思考/工具块搬进条带后，「同一轮的条带块 ↔ 正文气泡」这类跨容器选区的公共祖先落在
    // `.messages` 上，两个 closest 都不命中 → 会**静默降级成「存整轮」**（用户看不到任何提示）。
    // 兜底改看**选区两端**：两端归属同一条 assistant 行（比 data-turn-index，不比元素身份）即算
    // 命中——行内哪一层都行，条带块与正文气泡都带 data-turn-index。两端不同行 → 判 null，
    // 与 R13 前「跨消息划选」同口径，不会把别条消息的文字算进来。
    const a = turnIndexOf(range.startContainer);
    const b = turnIndexOf(range.endContainer);
    if (a !== null && a === b) {
      turnIndex = a;
    }
  }
  return turnIndex === null ? null : { turnIndex, text };
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
