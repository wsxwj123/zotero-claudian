import { config } from "../../package.json";
import { defaultWorkspacePath, joinPath } from "./paths";
import {
  normalizeWorkspaceMode,
  type WorkspaceMode,
} from "./collectionWorkspace";
import type { Platform } from "../modules/cliDetect";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export { PERMISSION_MODES };

/**
 * 平台判定：win32 之外统一按 POSIX 处理（与 sections.currentPlatform 同口径精简版；
 * 设置页/默认值只需区分分隔符风格）。
 */
function hostPlatform(): Platform {
  return Zotero.isWin ? "win32" : "darwin";
}

/** 取系统目录（dirsvc）；不可用返回 null（调用方决定回落） */
function dirsvcPath(key: string): string | null {
  try {
    return Services.dirsvc.get(key, Components.interfaces.nsIFile).path;
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/**
 * 工作区默认落点（PLAN §4.4；纯函数 defaultWorkspacePath 的宿主注入版）：
 * - darwin：~/Documents/zotero-claudian-workspace（~ 展开）
 * - win32：Documents 实际落点（dirsvc "Docs"，兼容 OneDrive 重定向）下同名目录；
 *   dirsvc 不可用回落 %USERPROFILE%\Documents（win32 真机首验项，PLAN §6 实测项 9）
 * 静态默认值不落 addon/prefs.js：prefs.js 无法按 OS 分叉，空串即「自动」语义。
 */
export function getDefaultWorkspacePath(): string {
  const platform = hostPlatform();
  const home = dirsvcPath("Home") ?? "";
  let documentsDir: string | null = null;
  if (platform === "win32") {
    // dirsvc "Docs" 不可用（极少见）才回落：%USERPROFILE%\Documents，别落在 profile 根
    const userProfile = Services.env.get("USERPROFILE");
    documentsDir =
      dirsvcPath("Docs") ??
      (userProfile ? joinPath("win32", userProfile, "Documents") : null);
  }
  return defaultWorkspacePath(platform, { home, documentsDir });
}

/**
 * 工作区路径（PLAN §4.4）。设置为空 = 跟随 OS 默认（见 getDefaultWorkspacePath）。
 */
export function getWorkspacePath(): string {
  const configured = getPref("workspacePath");
  if (typeof configured === "string" && configured.trim()) {
    return configured;
  }
  return getDefaultWorkspacePath();
}

/**
 * R6 工作区模式（PLAN-R6）：`single` = 现状（所有会话共用工作区根）；
 * `collection` = 每轮 cwd 落到 `<根>/<合集目录名>`，供用户放项目级 CLAUDE.md。
 * 每轮现算，切模式对在途会话无影响。
 */
export function getWorkspaceMode(): WorkspaceMode {
  return normalizeWorkspaceMode(getPref("workspaceMode"));
}

/**
 * 档位校验（纯函数，node 单测）：合法值原样返回，其余（含历史脏值/空值）一律回落 acceptEdits。
 * R5：新增 `bypass`（放任）档，由 PERMISSION_MODES 统一收口。
 */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value)
    ? (value as PermissionMode)
    : "acceptEdits";
}

/** 新建会话的初始权限档（PLAN §4.4，默认 acceptEdits） */
export function getDefaultPermissionMode(): PermissionMode {
  return normalizePermissionMode(getPref("defaultPermissionMode"));
}

/** claude 可执行文件路径覆盖（空 = 自动解析） */
export function getCliPathOverride(): string {
  return getPref("cliPathOverride") || "";
}

/**
 * 打开文献时自动切到 Claude 面板（默认开）。
 * 缺省值判定用「非 false 即开」：打包前的老 profile 没有这条 pref，读出来是 undefined，
 * 不能把它当关闭（addon/prefs.js 的静态默认值只在 Zotero 注册过该 pref 后生效）。
 */
export function getAutoShowPane(): boolean {
  return getPref("autoShowPane") !== false;
}

/**
 * R4-3：DeepSeek API Key（opt-in，空 = 不启用余额查询）。
 * **凭证纪律**：只在本函数读出、只交给宿主侧余额查询（sections.ts），不落日志/会话文件。
 */
export function getDeepseekApiKey(): string {
  const key = getPref("deepseekApiKey");
  return typeof key === "string" ? key.trim() : "";
}

/** R4-3：「显示用量/余额」开关（缺省开：非 false 即开，与 autoShowPane 同口径） */
export function getShowUsage(): boolean {
  return getPref("showUsage") !== false;
}

/**
 * R7-K：置顶会话 id 集合（本地 prefs，JSON 数组串）。坏值/未设置 → []（不抛：
 * 置顶是视图偏好，读坏了就当没置顶，不能让设置页/列表因此崩）。
 */
export function getPinnedSessions(): string[] {
  const raw = getPref("pinnedSessions");
  if (typeof raw !== "string" || !raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && !!id)
      : [];
  } catch {
    return [];
  }
}

/**
 * R10：会话区是否展开（默认 false = 收成一行，把高度还给消息区）。
 * 判定用 `=== true`：老 profile 没这条 pref 时读出来是 undefined，不能被当成展开。
 */
export function getSessionsExpanded(): boolean {
  return getPref("sessionsExpanded") === true;
}

export function setSessionsExpanded(expanded: boolean): void {
  setPref("sessionsExpanded", expanded === true);
}

export function setPinnedSessions(ids: string[]): void {
  setPref(
    "pinnedSessions",
    JSON.stringify(
      (Array.isArray(ids) ? ids : []).filter(
        (id): id is string => typeof id === "string" && !!id,
      ),
    ),
  );
}

// ---- 设置页校验（纯函数，node 单测；设置页 prefsPane.ts 调用）----

/**
 * 绝对路径判定：win32 认盘符（`C:\` / `c:/`）与 UNC（`\\server\share`）；其余平台认 `/` 开头。
 * 相对路径不可作为 spawn cwd，设置页据此告警。
 */
export function isAbsolutePath(path: string, platform: Platform): boolean {
  if (!path) {
    return false;
  }
  if (platform === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  }
  return path.startsWith("/");
}

/**
 * 路径输入规范化（纯函数，工作区/CLI 路径共用）：去首尾空白；开头 `~/`（win32 也认 `~\`）展开为 homeDir；
 * 其余原样返回（是否绝对由 isAbsolutePath 判定）。返回空串 = 跟随默认。
 */
export function normalizePathInput(
  raw: string,
  homeDir: string,
  platform: Platform,
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^~[\\/]/.test(trimmed) && homeDir) {
    return joinPath(platform, homeDir, trimmed.slice(2));
  }
  return trimmed;
}
