// contract.ts — 公共契约入口（INTERFACE.md 函数清单的单一 re-export 面）
// 验收测试只 import 本文件。各函数按归属实现在模块内，此处仅转发。

export { mapStreamLine, extractToolResultSummary } from "./modules/protocol";
export type { StreamEvent, StreamLogger } from "./modules/protocol";

export {
  buildSpawnArgs,
  classifyProcError,
  PERMISSION_MODES,
} from "./modules/cliRunner";
export type {
  PermissionMode,
  ProcErrorKind,
  BuildSpawnArgsOptions,
} from "./modules/cliRunner";

export {
  resolveClaudeCommand,
  buildSpawnEnv,
  buildWin32CmdInvocation,
  quoteWinArg,
  CMD_LINE_LIMIT,
} from "./modules/cliDetect";
export type {
  Platform,
  ResolveCommandResult,
  ResolveCommandEnv,
  BuildSpawnEnvInput,
  Win32CmdInvocation,
} from "./modules/cliDetect";

export { joinPath, defaultWorkspacePath } from "./utils/paths";
export type { WorkspacePathInput } from "./utils/paths";

export { buildPrompt } from "./utils/promptTemplate";
export type { PromptContext } from "./utils/promptTemplate";

export { buildTurnContext, genericTurnContext } from "./utils/contextBuilder";
export type {
  ContextDeps,
  TurnContext,
  ReaderInfo,
  SelectionInfo,
  AttachmentInfo,
  ItemMetadata,
} from "./utils/contextBuilder";

export { buildRememberRule } from "./utils/rememberRule";

// R4-3：用量 / 余额契约面（PLAN-R4 §4）
export {
  cacheHitPercent,
  formatTokens,
  addUsage,
  isUsageStats,
  EMPTY_USAGE,
} from "./chat/lib/usage";
export type { UsageStats } from "./chat/lib/usage";
export {
  parseBalance,
  detectProvider,
  fetchBalance,
  createBalanceService,
  parseClaudeEnv,
  BALANCE_URL,
  BALANCE_TIMEOUT_MS,
  BALANCE_TTL_MS,
} from "./modules/balance";
export type {
  BalanceResult,
  BalanceEntry,
  BalanceService,
  BalanceServiceDeps,
  BalanceFetchDeps,
  FetcherLike,
} from "./modules/balance";

export { appendNoteHtml } from "./utils/noteAppend";
export { sanitizeNoteHtml } from "./utils/htmlSanitize";

// R4-1/R4-2/R5：会话跟随、浮层几何、权限档映射（PLAN-R4 §2/§3）
export { followReader } from "./chat/lib/chatModel";
export {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_MAX,
  normalizeDockWidth,
  dockRect,
  dockReduce,
} from "./modules/dockPanel";
export type { DockViewport, DockRect, DockPhase, DockAction } from "./modules/dockPanel";
export { normalizePermissionMode } from "./utils/prefs";
export { PERMISSION_MODE_OPTIONS } from "./chat/lib/chatModel";

export {
  loadSessionsIndex,
  parseHistoryJsonl,
  formatHistoryRecord,
  createSessionStore,
  newSessionId,
  SESSIONS_INDEX_VERSION,
  SESSION_TITLE_MAX,
} from "./utils/sessionStore";
export type {
  SessionRecord,
  SessionRecordInput,
  HistoryRecord,
  SessionsIndexResult,
  SessionStore,
  SessionStoreDeps,
  SessionStoreFs,
} from "./utils/sessionStore";
