// scopePicker.ts — R7-D「跨文献范围」前端状态归约（纯函数，不碰 DOM；PLAN-R7 §3.6 UI）。
// 输入框上方「+ 范围」→ 只展开选项（R12：这一步**不发请求**——用户还没说要按什么取数）
// → 点「当前分类全部 / 书库中选中的文献」才向宿主 resolveScope，回执落成一枚 chip。
// 与 @ chips 共存、上限各自独立（20 / 40）；同一时刻只留一个范围 chip（重选覆盖，不叠加）。

import {
  SCOPE_ITEMS_MAX,
  SCOPE_SELECTION_LABEL,
  type ScopeKind,
} from "../../utils/scope";

/** 范围 chip（UI 显示 `label · count 篇`；truncated = 清单被截到 40） */
export interface ScopeChip {
  kind: ScopeKind;
  label: string;
  /** 清单篇数（截断后） */
  count: number;
  itemKeys: string[];
  truncated: boolean;
}

/** 0 篇回执的就地提示（R12-C：不落废 chip，给「先怎么选」+ 重试路径） */
export const SCOPE_EMPTY_HINT: Record<ScopeKind, string> = {
  selection:
    "没读到选中的文献——请先在左侧文献列表里选中文献（按住 ⌘ 多选），再点「重试」",
  collection:
    "当前分类里没读到文献——请先在左侧选中一个含文献的分类，再点「重试」",
};

export interface ScopePickerState {
  open: boolean;
  /** 同一时刻只留一个范围（PLAN §3.6：重选覆盖） */
  chip: ScopeChip | null;
  /** 0 篇提示（kind = 「重试」要重发的请求；null = 无提示） */
  notice: { kind: ScopeKind; text: string } | null;
  /** chip 正在重新解析（点 ↻ 后在途；回执落定即复位） */
  refreshing: boolean;
}

export function initialScopeState(): ScopePickerState {
  return { open: false, chip: null, notice: null, refreshing: false };
}

/** 点「+ 范围」→ 展开选择（纯展开：不发请求；重开面板丢掉上一轮的 0 篇提示） */
export function scopePickerOpen(state: ScopePickerState): ScopePickerState {
  return state.open && state.notice === null
    ? state
    : { ...state, open: true, notice: null };
}

/** Esc / 选完 → 收起选择（**已选 chip 不丢**：关面板是收起选择，不是撤销范围） */
export function scopePickerClose(state: ScopePickerState): ScopePickerState {
  return { ...state, open: false };
}

/** 选择类 chip 才有刷新（R12-D：分类由当前上下文决定，重选即可，不需要 ↻） */
export function scopeRefreshable(state: ScopePickerState): boolean {
  return state.chip?.kind === "selection";
}

/** 点 ↻ → chip 进入「解析中」（在途/已刷新的重复点击不生效；回执负责复位） */
export function scopeRefreshStart(state: ScopePickerState): ScopePickerState {
  return scopeRefreshable(state) && !state.refreshing
    ? { ...state, refreshing: true }
    : state;
}

/**
 * 宿主 scopeResolved 回执 → chip 的输入形状。
 * **回执带的是 `items`（ResolvedRef[]），chip 要的是 itemKey 串** —— 两边字段名不同，
 * 少这层映射 chip 的 count 恒为 0（用户实测「选了也不出 N 篇」的真因）。
 * 与 buildScopeBlock 同口径：missing 的条目不算数（宿主侧本就已跳过，这里是兜底）。
 */
export function scopeReceiptInput(msg: {
  kind?: unknown;
  label?: unknown;
  items?: unknown;
  itemKeys?: unknown;
  truncated?: unknown;
}): { kind: unknown; label: unknown; itemKeys: string[]; truncated: unknown } {
  const list = Array.isArray(msg?.items)
    ? msg.items
    : Array.isArray(msg?.itemKeys)
      ? msg.itemKeys
      : [];
  const itemKeys: string[] = [];
  for (const entry of list) {
    const key =
      typeof entry === "string"
        ? entry
        : entry && entry.missing !== true
          ? (entry as { itemKey?: unknown }).itemKey
          : "";
    if (typeof key === "string" && key) {
      itemKeys.push(key);
    }
  }
  return {
    kind: msg?.kind,
    label: msg?.label,
    itemKeys,
    truncated: msg?.truncated,
  };
}

/**
 * 宿主 scopeResolved 回执：
 * - 有篇数 → 落成一枚 chip 并收起面板（R12：与现在一致）；
 * - 0 篇 → **不落 chip**，面板就地给提示 + 重试（旧 chip 一并清掉，别留过期清单）。
 */
export function scopeChipSet(
  state: ScopePickerState,
  input: {
    kind?: unknown;
    label?: unknown;
    itemKeys?: unknown;
    truncated?: unknown;
  },
): ScopePickerState {
  const itemKeys = (Array.isArray(input?.itemKeys) ? input.itemKeys : [])
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .slice(0, SCOPE_ITEMS_MAX);
  const kind: ScopeKind =
    input?.kind === "collection" ? "collection" : "selection";
  if (itemKeys.length === 0) {
    return {
      ...state,
      open: true,
      chip: null,
      refreshing: false,
      notice: { kind, text: SCOPE_EMPTY_HINT[kind] },
    };
  }
  const label =
    typeof input?.label === "string" && input.label.trim()
      ? input.label.trim()
      : "已选范围";
  return {
    ...state,
    open: false,
    notice: null,
    refreshing: false,
    chip: {
      kind,
      label,
      count: itemKeys.length,
      itemKeys,
      truncated: input?.truncated === true,
    },
  };
}

/** 点 chip 上的 × → 撤销范围（下一轮不再注入清单、不再扩 --add-dir） */
export function scopeChipClear(state: ScopePickerState): ScopePickerState {
  return state.chip === null ? state : { ...state, chip: null };
}
