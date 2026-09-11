// messageActions.ts — R7-F「消息级操作：复制 / 编辑回填 / 折叠」前端归约（纯函数，不碰 DOM；PLAN-R7 §3.8）。
// 参考实现：claude gui 的 MessageBubble（复制带「已复制」态、编辑后重发、超长折叠）。
// 折叠状态是**视图态**：不落盘、不进历史，切会话即重置（messageActionsReset）。
//
// 编辑语义（PLAN §3.8 + 头部裁决 1）：点「编辑」把该条原文回填输入框、原消息保留并在 UI 标「待重发」；
// 发送时——该条是最后一条 → 不截断；其后还有任何消息（AI 回复也算）→ 先截断视图 + 插「已编辑重发」分隔。
// CLI 侧仍是线性续接（模型记得旧分支），UI 不假装做了分支回滚（真正的按消息 fork 是 v2）。

/** 复制成功的「已复制」提示时长（连点会清旧定时器、重新计时） */
export const COPY_FEEDBACK_MS = 1500;
/** 折叠阈值（行数；**超过**才默认折叠） */
export const COLLAPSE_LINE_THRESHOLD = 12;

/** 复制按钮状态：token 每次点击递增，UI 据此丢弃旧定时器 */
export interface CopyState {
  status: "idle" | "copied";
  token: number;
}

export interface MessageActionState {
  /** 已展开的消息下标（视图态，切会话重置） */
  expanded: number[];
  /** 正在编辑重发的消息下标（null = 非编辑态） */
  editingIndex: number | null;
  /** 编辑回填的原文（UI 读它写入输入框） */
  composerText: string;
  copy: CopyState;
}

export function initialMessageActionState(): MessageActionState {
  return {
    expanded: [],
    editingIndex: null,
    composerText: "",
    copy: { status: "idle", token: 0 },
  };
}

/** 点复制 → 「已复制」（新 token：UI 清旧定时器、重新计时 1.5s） */
export function messageCopyClick(
  state: MessageActionState,
): MessageActionState {
  return {
    ...state,
    copy: { status: "copied", token: state.copy.token + 1 },
  };
}

/** 定时器到点：只有 token 匹配才回落（连点后旧定时器作废）；幂等 */
export function messageCopyRevert(
  state: MessageActionState,
  token: number,
): MessageActionState {
  if (token !== state.copy.token || state.copy.status === "idle") {
    return state;
  }
  return { ...state, copy: { status: "idle", token: state.copy.token } };
}

/** 消息形态（Turn 的子集；divider 是 editResend 插入的分隔条） */
interface TurnLike {
  role?: unknown;
  text?: unknown;
  blocks?: unknown;
}

/**
 * 复制内容（PLAN §3.8）：
 * - user → 原文（纯文本）；
 * - assistant → **Markdown 源码**（多条 text 块按序拼接；思考块/工具卡不进剪贴板）；
 * - 其余（divider/异常输入）→ 空串。
 */
export function copyTurnText(turn: unknown): string {
  const t = (turn ?? {}) as TurnLike;
  if (t.role === "user") {
    return typeof t.text === "string" ? t.text : "";
  }
  if (t.role !== "assistant") {
    return "";
  }
  const blocks = Array.isArray(t.blocks) ? t.blocks : [];
  return blocks
    .filter((block): block is { blockType: "text"; text: string } => {
      const b = block as { blockType?: unknown; text?: unknown } | null;
      return (
        !!b && b.blockType === "text" && typeof b.text === "string" && !!b.text
      );
    })
    .map((block) => block.text)
    .join("\n\n");
}

export interface ClipboardDeps {
  /** 首选通道（navigator.clipboard.writeText） */
  writeText(text: string): Promise<unknown> | unknown;
  /** 回落通道（document.execCommand("copy")），返回是否成功 */
  execCommand(text: string): unknown;
  log(message: string): void;
}

function defaultWriteText(text: string): Promise<void> {
  const nav = (
    globalThis as {
      navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
    }
  ).navigator;
  const write = nav?.clipboard?.writeText;
  if (typeof write !== "function") {
    throw new Error("navigator.clipboard 不可用");
  }
  return write.call(nav?.clipboard, text);
}

/** chrome:// 特权页的剪贴板兜底：临时 textarea + execCommand("copy") */
function defaultExecCommand(text: string): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body || typeof doc.execCommand !== "function") {
    return false;
  }
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  area.select();
  try {
    return doc.execCommand("copy");
  } finally {
    area.remove();
  }
}

/**
 * 复制到剪贴板（PLAN §3.8）：navigator.clipboard 优先，失败回落 execCommand；
 * 两条路径都有兜底；**两条都失败**才记日志并返回 false（不抛——UI 不能崩）。
 * 注：成功回落不写日志（调用序被单测逐字锁定：writeText 抛错 → 恰好一次 execCommand）。
 */
export async function copyToClipboard(
  text: unknown,
  deps?: Partial<ClipboardDeps>,
): Promise<boolean> {
  const value = typeof text === "string" ? text : String(text ?? "");
  const writeText = deps?.writeText ?? defaultWriteText;
  const exec = deps?.execCommand ?? defaultExecCommand;
  const log =
    deps?.log ??
    ((message: string): void => {
      const dbg = (globalThis as { console?: Console }).console;
      dbg?.warn?.(`[claudian] ${message}`);
    });
  let firstError: unknown = null;
  try {
    await writeText(value);
    return true;
  } catch (err) {
    firstError = err;
  }
  try {
    if (exec(value)) {
      return true;
    }
  } catch (err) {
    log(`剪贴板写入失败：execCommand 回落也抛错（${String(err)}）`);
    return false;
  }
  log(
    `剪贴板写入失败：writeText 与 execCommand 均未成功（${String(firstError)}）`,
  );
  return false;
}

/** 超长判定：行数 > 12（硬条件；短消息点「展开」也不会变成折叠态） */
export function isOverflowing(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.split("\n").length > COLLAPSE_LINE_THRESHOLD
  );
}

/** 该条当前是否处于折叠（超阈值 + 未展开） */
export function messageCollapsed(
  state: MessageActionState,
  index: number,
  text: unknown,
): boolean {
  return isOverflowing(text) && !state.expanded.includes(index);
}

/** 点「展开/收起」（各条独立） */
export function messageCollapseToggle(
  state: MessageActionState,
  index: number,
): MessageActionState {
  return state.expanded.includes(index)
    ? { ...state, expanded: state.expanded.filter((i) => i !== index) }
    : { ...state, expanded: [...state.expanded, index] };
}

/** 切会话 / 换视图 → 重置全部视图态（展开、「已复制」、编辑态） */
export function messageActionsReset(
  _state?: MessageActionState,
): MessageActionState {
  return initialMessageActionState();
}

/** 该条有没有编辑入口（只有 user 消息有；AI 回复只有复制） */
export function canEditTurn(turn: unknown): boolean {
  const t = (turn ?? {}) as TurnLike;
  return t.role === "user" && typeof t.text === "string";
}

/**
 * 点「编辑」：原文回填输入框 + 原下标标「待重发」（原消息保留）。
 * 非法（AI 消息 / 越界下标 / 空数组）→ ok:false 且状态原样（不往输入框回填）。
 */
export function messageEditStart(
  state: MessageActionState,
  messages: unknown,
  index: number,
): { state: MessageActionState; ok: boolean } {
  const list = Array.isArray(messages) ? messages : [];
  const turn =
    Number.isInteger(index) && index >= 0 && index < list.length
      ? list[index]
      : null;
  if (!canEditTurn(turn)) {
    return { state, ok: false };
  }
  return {
    state: {
      ...state,
      editingIndex: index,
      composerText: (turn as TurnLike).text as string,
    },
    ok: true,
  };
}

/**
 * 编辑重发的视图语义（头部裁决 1）：
 * - 该条是最后一条 → 不截断（原消息数组逐字返回，只是换了个数组壳）；
 * - 不是最后一条（其后还有任何消息，AI 回复也算）→ 移除其后全部消息 + 末尾插一条
 *   `{role:"divider", text:"已编辑重发"}` 分隔（被编辑那条原文保留）。
 * 纯函数：不改入参。
 */
export function editResend<T extends { role: string; text?: string }>(
  messages: readonly T[],
  index: number,
): { messages: (T | { role: "divider"; text: string })[]; truncated: boolean } {
  const list = Array.isArray(messages) ? [...messages] : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return { messages: list, truncated: false };
  }
  if (index === list.length - 1) {
    return { messages: list, truncated: false };
  }
  return {
    messages: [
      ...list.slice(0, index + 1),
      { role: "divider", text: "已编辑重发" },
    ],
    truncated: true,
  };
}
