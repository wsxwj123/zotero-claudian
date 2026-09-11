// instructionsEditor.ts — R7-A「面板内指令编辑器」前端状态归约（纯函数，不碰 DOM；PLAN-R7 §2 UI）。
// 契约（tests/unit/r7-ui.test.mjs）：加载中/未创建/已保存/保存失败四态 + 脏标记（未保存关闭二次确认）。
// 文本本身不落 prefs/本地存储：唯一真相是工作区里的 CLAUDE.md，UI 只做「读进来 → 改 → 存回去」。

import {
  normalizeInstructionScope,
  type InstructionScope,
} from "../../utils/instructions";

export interface InstructionsEditorState {
  open: boolean;
  scope: InstructionScope;
  text: string;
  /** 落盘态文本（脏标记基准：内容回到落盘态即不脏） */
  savedText: string;
  path: string | null;
  exists: boolean;
  status: "loading" | "ready" | "saved" | "error";
  /** 错误原文（读失败/保存失败都要原样上屏，不吞） */
  error: string | null;
  /** 降级说明（如 collection 作用域无分类可归属 → 本次编的是根指令；PLAN §4 要求提示） */
  notice: string | null;
}

/** 打开编辑器（初始加载中；文本等宿主回执） */
export function initialInstructionsEditor(
  scope: InstructionScope,
): InstructionsEditorState {
  return {
    open: true,
    scope,
    text: "",
    savedText: "",
    path: null,
    exists: false,
    status: "loading",
    error: null,
    notice: null,
  };
}

/** 脏标记：文本与落盘态不一致（未保存关闭时要二次确认） */
export function instructionsEditorDirty(
  state: InstructionsEditorState,
): boolean {
  return state.text !== state.savedText;
}

/**
 * 宿主 `instructions` 回执：
 * - 正常 → 文本/路径/exists 落地，非脏（刚加载的空文件也不算脏）；
 * - 带 error → 错误上屏，**不清空用户正在编辑的内容**（读失败不能把输入冲成空）。
 * 以回执里的 scope 为准（切到分类后，回执不会把作用域写回 global）。
 */
export function instructionsEditorLoad(
  state: InstructionsEditorState,
  msg: {
    scope?: unknown;
    path?: string | null;
    text?: string;
    exists?: boolean;
    error?: string;
    notice?: string;
  },
): InstructionsEditorState {
  const scope = normalizeInstructionScope(msg?.scope) ?? state.scope;
  if (msg?.error) {
    return {
      ...state,
      scope,
      path: typeof msg.path === "string" ? msg.path : state.path,
      status: "error",
      error: msg.error,
    };
  }
  const text = typeof msg?.text === "string" ? msg.text : "";
  return {
    ...state,
    scope,
    text,
    savedText: text,
    path: typeof msg?.path === "string" ? msg.path : null,
    exists: msg?.exists === true,
    status: "ready",
    error: null,
    notice: typeof msg?.notice === "string" && msg.notice ? msg.notice : null,
  };
}

/** 编辑（内容回到 savedText 即自动复归干净） */
export function instructionsEditorEdit(
  state: InstructionsEditorState,
  text: unknown,
): InstructionsEditorState {
  return { ...state, text: typeof text === "string" ? text : "" };
}

/**
 * `instructionsSaved` 回执：
 * - ok → 非脏（savedText 跟进）、路径回填、错误清空；
 * - 失败 → 错误上屏、**仍脏**、编辑器不关（防用户以为存上了）。
 */
export function instructionsEditorSaved(
  state: InstructionsEditorState,
  msg: {
    scope?: unknown;
    ok?: boolean;
    path?: string;
    error?: string;
  },
): InstructionsEditorState {
  const scope = normalizeInstructionScope(msg?.scope) ?? state.scope;
  if (msg?.ok) {
    return {
      ...state,
      scope,
      open: true,
      status: "saved",
      savedText: state.text,
      exists: true,
      path: typeof msg.path === "string" ? msg.path : state.path,
      error: null,
    };
  }
  return {
    ...state,
    scope,
    open: true,
    status: "error",
    error: typeof msg?.error === "string" && msg.error ? msg.error : "保存失败",
  };
}

/** 切作用域（不关弹层；文本留在原地，等新作用域的读回执覆盖） */
export function instructionsEditorSetScope(
  state: InstructionsEditorState,
  scope: unknown,
): InstructionsEditorState {
  const next = normalizeInstructionScope(scope);
  if (!next || next === state.scope) {
    return state;
  }
  return { ...state, scope: next, status: "loading", error: null };
}

/**
 * 请求关闭：脏态需二次确认（confirmDiscard=true 才真的关）；干净态直接关。
 * 未确认时原样返回（closed=false），内容不丢。
 */
export function instructionsEditorClose(
  state: InstructionsEditorState,
  opts?: { confirmDiscard?: boolean },
): { closed: boolean; state: InstructionsEditorState } {
  if (instructionsEditorDirty(state) && !opts?.confirmDiscard) {
    return { closed: false, state };
  }
  return { closed: true, state: { ...state, open: false } };
}
