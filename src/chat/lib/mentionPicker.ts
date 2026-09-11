// mentionPicker.ts — R7-B「@ 提及」前端状态归约（纯函数，不碰 DOM；PLAN-R7 §3 UI）。
// 契约（tests/unit/r7-ui.test.mjs）：面板开合、关键词、候选、chips（去重/上限 20/可删/可清空）。
// 检索与解析都在宿主侧（Zotero 数据只有宿主看得到）：前端只发 searchItems / resolveRefs，收结果落状态。

import {
  MENTION_CHIPS_MAX,
  MENTION_RESULTS_MAX,
  type MentionSearchItem,
  type ResolvedRef,
} from "../../utils/mentions";

/** chip（输入框上方的一枚引用）；超长题名由 UI 截断，hover 显示完整 */
export interface MentionChip {
  itemKey: string;
  title: string;
  year?: string | null;
  creators?: string[];
  publication?: string | null;
}

export interface MentionPickerState {
  open: boolean;
  query: string;
  items: MentionSearchItem[];
  /** idle=没查过；loading=查询在途；ready=有候选；empty=已回但无结果 */
  status: "idle" | "loading" | "ready" | "empty";
  /** 键盘选中的候选下标（↑↓ 移动、回车选中） */
  activeIndex: number;
  chips: MentionChip[];
  /** 上限提示（超限时给一句，正常态为 null） */
  notice: string | null;
  /** 最近一次 resolveRefs 回执（UI 据此把 missing 的 chip 标红）；null = 尚未解析 */
  refs: ResolvedRef[] | null;
}

export function initialMentionPickerState(): MentionPickerState {
  return {
    open: false,
    query: "",
    items: [],
    status: "idle",
    activeIndex: 0,
    chips: [],
    notice: null,
    refs: null,
  };
}

/** 打 `@`（或从历史里回到 `@` 语境）→ 展开候选面板 */
export function mentionPanelOpen(
  state: MentionPickerState,
): MentionPickerState {
  return { ...state, open: true };
}

/** Esc / 失去 `@` 语境 → 收起面板（**已选 chips 不丢**：关面板是收起候选，不是撤销已选） */
export function mentionPanelClose(
  state: MentionPickerState,
): MentionPickerState {
  return { ...state, open: false };
}

/** 关键词变化：面板保持开（@ 后继续打字）、候选清空待回（status=loading，UI 显示「检索中…」） */
export function mentionQueryChange(
  state: MentionPickerState,
  query: unknown,
): MentionPickerState {
  return {
    ...state,
    query: typeof query === "string" ? query : "",
    open: true,
    status: "loading",
    activeIndex: 0,
  };
}

/** 宿主回执 → 候选就位（最多 20 条；空结果标 empty，UI 给「无结果」而不是空白下拉） */
export function mentionResults(
  state: MentionPickerState,
  items: unknown,
): MentionPickerState {
  const list = (Array.isArray(items) ? items : []).slice(
    0,
    MENTION_RESULTS_MAX,
  );
  return {
    ...state,
    items: list,
    status: list.length > 0 ? "ready" : "empty",
    activeIndex: 0,
  };
}

/**
 * 选中一条候选 → 变 chip。
 * 同一文献只允许一个（重复选中即忽略，不覆盖既有 chip）；上限 20（超出拒绝并提示）；
 * 上限内的追加不打扰用户（顺手清掉上一句超限提示）。
 */
export function mentionChipAdd(
  state: MentionPickerState,
  item: MentionSearchItem | MentionChip | null | undefined,
): MentionPickerState {
  const candidate = item ?? null;
  const key =
    candidate && typeof candidate.itemKey === "string" ? candidate.itemKey : "";
  if (!key || state.chips.some((chip) => chip.itemKey === key)) {
    return state;
  }
  if (state.chips.length >= MENTION_CHIPS_MAX) {
    return { ...state, notice: `一次最多引用 ${MENTION_CHIPS_MAX} 篇` };
  }
  const chip: MentionChip = {
    itemKey: key,
    title: typeof candidate?.title === "string" ? candidate.title : key,
    year: candidate?.year ?? null,
    creators: Array.isArray(candidate?.creators) ? candidate.creators : [],
    publication: candidate?.publication ?? null,
  };
  return { ...state, chips: [...state.chips, chip], notice: null };
}

/** 点 chip 上的 × → 删掉那枚，其余保持原顺序 */
export function mentionChipRemove(
  state: MentionPickerState,
  itemKey: string,
): MentionPickerState {
  return {
    ...state,
    chips: state.chips.filter((chip) => chip.itemKey !== itemKey),
  };
}

/** 发送后清空（chips 属于本轮）；refs 一并清（下一轮的标红依据重新解析） */
export function mentionChipsClear(
  state: MentionPickerState,
): MentionPickerState {
  return { ...state, chips: [], notice: null, refs: null };
}

/** ↑/↓ 移动键盘选中（循环；无候选时不动） */
export function mentionActiveSet(
  state: MentionPickerState,
  index: number,
): MentionPickerState {
  const count = state.items.length;
  if (count === 0) {
    return state;
  }
  const next = ((index % count) + count) % count;
  return { ...state, activeIndex: next };
}

/** resolveRefs 回执 → 存档（UI 按 itemKey 标红 missing 的 chip） */
export function mentionRefsResolved(
  state: MentionPickerState,
  refs: unknown,
): MentionPickerState {
  return { ...state, refs: Array.isArray(refs) ? (refs as ResolvedRef[]) : [] };
}
