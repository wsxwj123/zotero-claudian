// commandPicker.ts — R7-C「/ 命令面板」前端状态归约（纯函数，不碰 DOM；PLAN-R7 §3.5 UI）。
// 与 @ 提及面板（mentionPicker.ts）同一套机制：输入框打 `/` → 面板跟随 → ↑↓ 选、回车选中、Esc 收起。
// 选中语义（PLAN §3.5 + 头部裁决）：
//   - 插件本地命令 → 面板直接执行（**不往输入框插文本、不发送**；App 按 action 分发）
//   - 自定义命令/技能 → 只往输入框插 `/名字 ` 骨架，**不自动发送**（用户补参数）
// 命令清单在宿主侧扫描（只有宿主看得到文件系统）：前端只发 listCommands，收 commandList 落状态。

import {
  COMMANDS_PANEL_MAX,
  filterCommands,
  resolveLocalCommand,
  type CommandEntry,
} from "../../utils/commands";

// 面板与 App 共用同一解析入口（白名单枚举，唯一）
export { filterCommands, resolveLocalCommand };
export type { CommandEntry };

export interface CommandPickerState {
  open: boolean;
  query: string;
  /** 当前上屏的候选（= all 按关键词过滤后的结果） */
  items: CommandEntry[];
  /** 宿主回执的完整清单（关键词过滤在本地做，零往返） */
  all: CommandEntry[];
  /** 与 @ 面板同口径：idle=没查过；loading=在途；ready=有候选；empty=已回但无结果 */
  status: "idle" | "loading" | "ready" | "empty";
  /** 键盘选中的候选下标（↑↓ 移动、回车选中） */
  activeIndex: number;
}

export function initialCommandPickerState(): CommandPickerState {
  return {
    open: false,
    query: "",
    items: [],
    all: [],
    status: "idle",
    activeIndex: 0,
  };
}

/** 打 `/` → 展开面板 */
export function commandPanelOpen(
  state: CommandPickerState,
): CommandPickerState {
  return { ...state, open: true };
}

/** Esc / 离开 `/` 语境 → 收起（下次打 `/` 重新拉清单） */
export function commandPanelClose(
  state: CommandPickerState,
): CommandPickerState {
  return { ...state, open: false };
}

/** 关键词变化：面板保持开，候选等宿主回执（status=loading 时 UI 显示「加载中…」） */
export function commandQueryChange(
  state: CommandPickerState,
  query: unknown,
): CommandPickerState {
  return {
    ...state,
    query: typeof query === "string" ? query : "",
    open: true,
    status: "loading",
    activeIndex: 0,
  };
}

/** 宿主 commandList 回执 → 候选就位（本地命令排在自定义命令之前：零往返的先给） */
export function commandResults(
  state: CommandPickerState,
  items: unknown,
): CommandPickerState {
  // R12-A：上限按「本地+内置+命令+技能」的总量算（宿主全量送来），别把尾部的技能切掉
  const list = (Array.isArray(items) ? items : [])
    .filter((c): c is CommandEntry => !!c && typeof c.name === "string")
    .slice(0, COMMANDS_PANEL_MAX);
  return {
    ...state,
    all: list,
    items: list,
    status: list.length > 0 ? "ready" : "empty",
    activeIndex: 0,
  };
}

export interface CommandAcceptDeps {
  /** 把骨架文本插入输入框（自定义命令用；本地命令不插） */
  insertText(text: string): void;
  /** 契约位：本函数**从不调用它**（选中命令不得自动发送）——留着是为了调用方显式表态 */
  send?(text: string): void;
}

/**
 * 选中一条候选：
 * - 本地命令（source:"local" 或命中白名单）→ 只收起面板，返回原状态（执行在 App 按 action 分发）；
 * - 自定义命令 → 插 `/名字 `（带尾空格等用户补参数），**不发送**；
 * - 非法选中（null/空名字）→ 状态与面板原样（不关面板、不插文本）。
 */
export function commandAccept(
  state: CommandPickerState,
  cmd: unknown,
  deps?: CommandAcceptDeps,
): CommandPickerState {
  const raw = cmd as { name?: unknown; source?: unknown } | null | undefined;
  const name =
    typeof raw?.name === "string" ? raw.name.replace(/^\//, "").trim() : "";
  if (!name) {
    return state;
  }
  if (raw?.source === "local" || resolveLocalCommand(name)) {
    return { ...state, open: false, query: "", items: [] };
  }
  deps?.insertText(`/${name} `);
  return { ...state, open: false, query: "", items: [] };
}

/** ↑/↓ 移动键盘选中（循环；无候选时不动） */
export function commandActiveSet(
  state: CommandPickerState,
  index: number,
): CommandPickerState {
  const count = state.items.length;
  if (count === 0) {
    return state;
  }
  return { ...state, activeIndex: ((index % count) + count) % count };
}
