// instructions.ts — R7-A「面板内指令编辑器」宿主侧纯逻辑（PLAN-R7 §2）。
// 契约：作用域是**枚举**（UI 永不传路径）；落点恒为工作区根或其**一阶子目录**内的 CLAUDE.md，
// 归一化后越界即拒；上限 20 000 字符；读写异常一律收敛成 error 字段，不抛。
//
// 为什么（用户原话 2026-09-11）：「项目级 claude md 直接在 claudian 面板上就能新建、修改、保存是最好」。
// Claude Code 从 cwd 逐级向上加载 CLAUDE.md，故根放通用要求、合集目录放项目要求（R6 已把 cwd 分到合集目录）。
//
// ponytail: 落点用 "/" 拼接（纯函数，跨平台单测口径统一）。win32 下 IOUtils/nsIFile 接受 "/" 形态路径；
// 若 Windows 真机出现异常，改法是给 InstructionsFs 再注入一个 PathUtils.join 走原生分隔符。

import type { WorkspaceMode } from "./collectionWorkspace";

export const INSTRUCTIONS_FILE = "CLAUDE.md";

/** 文本上限（PLAN §2：防手滑粘贴整篇论文）；按 JS .length 计（与 UI 字符计数同口径） */
export const INSTRUCTIONS_MAX_CHARS = 20000;

export type InstructionScope = "global" | "collection";

const SCOPES: readonly InstructionScope[] = ["global", "collection"];

/** scope 白名单（脏值/路径形态一律 null；"GLOBAL"、"../x"、非字符串全拒） */
export function normalizeInstructionScope(
  value: unknown,
): InstructionScope | null {
  return typeof value === "string" &&
    (SCOPES as readonly string[]).includes(value)
    ? (value as InstructionScope)
    : null;
}

/** 文件系统注入面（真实实现走 IOUtils，sections.ts 接线；单测注入 fake fs） */
export interface InstructionsFs {
  exists(path: string): Promise<boolean>;
  /** createAncestors 语义（父目录一并建） */
  makeDir(path: string): Promise<void>;
  /** 不存在 → null */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}

export interface ResolveInstructionsPathInput {
  /** 工作区根（getWorkspacePath()） */
  root: string;
  scope: unknown;
  mode: WorkspaceMode;
  /** 当前合集目录名（单段；collection 模式下由宿主现算，查不到 → null） */
  collectionDir: string | null;
}

export type InstructionsPathResult =
  | {
      ok: true;
      path: string;
      /** path 的父目录（保存前建目录用） */
      dir: string;
      /** 回落/降级说明（无分类可归属时告诉用户编的是根指令） */
      notice?: string;
    }
  | { ok: false; error: string };

/** 剥尾分隔符（两种都剥）：`/ws/` → `/ws` */
function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/** 单段目录名判定：拒一切能改变落点的形态（与 parseCollectionIndex 的拒收面同口径） */
function isSafeDirSegment(dir: unknown): dir is string {
  if (typeof dir !== "string" || !dir) {
    return false;
  }
  if (dir.startsWith(".")) {
    return false; // "." / ".." / 一切点开头（净化产物本就不会以点开头）
  }
  if (/[/\\]/.test(dir)) {
    return false; // 二级路径 / 绝对路径 / win32 反斜杠
  }
  if (/^[A-Za-z]:/.test(dir)) {
    return false; // 盘符形态（`C:foo` 在 Windows 上是「C 盘当前目录」，语义会跑偏）
  }
  if (dir.startsWith("~")) {
    return false; // ~ 展开由 shell 层负责，这里一律拒
  }
  // 控制字符（含 NUL）会让底层 API 行为不可预期——按码点判，不写控制字符正则（eslint no-control-regex）
  for (const ch of dir) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * 落点解析（PLAN §2 表格 + §4）：
 * - global → `<根>/CLAUDE.md`（两种工作区模式同样落根）；
 * - collection + collection 模式 → `<根>/<当前分类目录>/CLAUDE.md`；
 *   当前无合集 → 回落根并带 notice（用户要知道自己编的是根指令）；
 * - single 模式下的 collection 作用域 → 禁用（拒绝 + 说明）；
 * - 分类目录含逃逸形态（..、/、盘符、~、二级路径）→ 拒绝；
 * - 根带尾分隔符不产生双分隔符。
 */
export function resolveInstructionsPath(
  input: ResolveInstructionsPathInput,
): InstructionsPathResult {
  const root = stripTrailingSeparators(input.root ?? "");
  if (!root) {
    return { ok: false, error: "工作区路径为空，无法定位指令文件" };
  }
  const scope = normalizeInstructionScope(input.scope);
  if (!scope) {
    return { ok: false, error: `未知的指令作用域：${String(input.scope)}` };
  }
  if (scope === "global") {
    return { ok: true, dir: root, path: `${root}/${INSTRUCTIONS_FILE}` };
  }
  if (input.mode !== "collection") {
    return {
      ok: false,
      error:
        "当前工作区模式为「单一工作区」，没有分类目录可归属——该作用域只在「按分类分工作区」模式下可用",
    };
  }
  if (input.collectionDir == null) {
    return {
      ok: true,
      dir: root,
      path: `${root}/${INSTRUCTIONS_FILE}`,
      notice:
        "当前没有可归属的分类（未在阅读文献 / 该文献不属于任何分类）→ 本次编辑的是工作区根指令",
    };
  }
  if (!isSafeDirSegment(input.collectionDir)) {
    return {
      ok: false,
      error: `分类目录名非法（越界形态）：${String(input.collectionDir)}`,
    };
  }
  const dir = `${root}/${input.collectionDir}`;
  return { ok: true, dir, path: `${dir}/${INSTRUCTIONS_FILE}` };
}

export interface ReadInstructionsInput extends ResolveInstructionsPathInput {
  fs: InstructionsFs;
}

export interface InstructionsReadResult {
  scope: InstructionScope;
  /** 落点（越界 → null，UI 不显示可用路径） */
  path: string | null;
  text: string;
  exists: boolean;
  error?: string;
  /** 回落/降级说明（如 collection 作用域无分类可归属 → 本次编的是根指令） */
  notice?: string;
}

/** 归一错误文本（去掉 Error: 前缀，给 UI 看的是可读原文） */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error:\s*/, "");
}

/**
 * 读指令（PLAN §2）：
 * - 文件不存在 → {exists:false, text:"", path 照给}（UI 提示「尚未创建，保存即创建」）；
 * - 读失败（EACCES/EISDIR/…）→ error 原文 + text:"" + exists:false（UI 不能显示半截状态）；
 * - 越界 → 不读盘、path:null + error。
 */
export async function readInstructions(
  input: ReadInstructionsInput,
): Promise<InstructionsReadResult> {
  const resolved = resolveInstructionsPath(input);
  const scope = normalizeInstructionScope(input.scope) ?? "global";
  if (!resolved.ok) {
    return {
      scope,
      path: null,
      text: "",
      exists: false,
      error: resolved.error,
    };
  }
  try {
    const text = await input.fs.readText(resolved.path);
    if (text == null) {
      return { scope, path: resolved.path, text: "", exists: false };
    }
    return {
      scope,
      path: resolved.path,
      text,
      exists: true,
      ...(resolved.notice ? { notice: resolved.notice } : {}),
    };
  } catch (err) {
    return {
      scope,
      path: resolved.path,
      text: "",
      exists: false,
      error: errorText(err),
    };
  }
}

export interface SaveInstructionsInput extends ResolveInstructionsPathInput {
  text: string;
  fs: InstructionsFs;
}

export interface InstructionsSavedResult {
  scope: InstructionScope;
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * 写指令（PLAN §2）：超限/越界**不落盘**；父目录不存在先建（分类目录首用时）；
 * 写盘异常 → ok:false + error 原文（不抛，UI 照常显示并保持脏态）。
 */
export async function saveInstructions(
  input: SaveInstructionsInput,
): Promise<InstructionsSavedResult> {
  const scope = normalizeInstructionScope(input.scope) ?? "global";
  const resolved = resolveInstructionsPath(input);
  if (!resolved.ok) {
    return { scope, ok: false, error: resolved.error };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (text.length > INSTRUCTIONS_MAX_CHARS) {
    return {
      scope,
      ok: false,
      error: `指令超长：${text.length} 字符 > 上限 ${INSTRUCTIONS_MAX_CHARS}（未保存）`,
    };
  }
  try {
    await input.fs.makeDir(resolved.dir);
    await input.fs.writeText(resolved.path, text);
    return { scope, ok: true, path: resolved.path };
  } catch (err) {
    return { scope, ok: false, error: errorText(err) };
  }
}
