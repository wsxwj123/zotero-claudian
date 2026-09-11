// scopePicker.ts — R7-D「跨文献范围」前端状态归约（纯函数，不碰 DOM；PLAN-R7 §3.6 UI）。
// 输入框上方「+ 范围」→ 选「当前分类全部 / 我在书库选中的 N 条」→ 面板向宿主 resolveScope，
// 回执落成一枚 chip（显示 `分类名 · N 篇`）。与 @ chips 共存、上限各自独立（20 / 40）；
// 同一时刻只留一个范围 chip（重选覆盖，不叠加）。

import { SCOPE_ITEMS_MAX, type ScopeKind } from "../../utils/scope";

/** 范围 chip（UI 显示 `label · count 篇`；truncated = 清单被截到 40） */
export interface ScopeChip {
  kind: ScopeKind;
  label: string;
  /** 清单篇数（截断后） */
  count: number;
  itemKeys: string[];
  truncated: boolean;
}

export interface ScopePickerState {
  open: boolean;
  /** 同一时刻只留一个范围（PLAN §3.6：重选覆盖） */
  chip: ScopeChip | null;
}

export function initialScopeState(): ScopePickerState {
  return { open: false, chip: null };
}

/** 点「+ 范围」→ 展开选择（分类全部 / 书库选中） */
export function scopePickerOpen(state: ScopePickerState): ScopePickerState {
  return { ...state, open: true };
}

/** Esc / 选完 → 收起选择（**已选 chip 不丢**：关面板是收起选择，不是撤销范围） */
export function scopePickerClose(state: ScopePickerState): ScopePickerState {
  return { ...state, open: false };
}

/** 宿主 scopeResolved 回执 → 落成一枚 chip（重选即覆盖旧的；itemKeys 按 40 截断兜底） */
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
  const label =
    typeof input?.label === "string" && input.label.trim()
      ? input.label.trim()
      : "已选范围";
  return {
    ...state,
    open: false,
    chip: {
      kind: input?.kind === "collection" ? "collection" : "selection",
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
