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

export { appendNoteHtml } from "./utils/noteAppend";
export { sanitizeNoteHtml } from "./utils/htmlSanitize";

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
