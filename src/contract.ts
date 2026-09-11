// contract.ts — 公共契约入口（INTERFACE.md 函数清单的单一 re-export 面）
// 验收测试只 import 本文件。各函数按归属实现在模块内，此处仅转发。

export { mapStreamLine, extractToolResultSummary } from "./modules/protocol";
export type { StreamEvent, StreamLogger } from "./modules/protocol";

export {
  buildSpawnArgs,
  buildAttachmentDenySettings,
  buildMcpConfigJson,
  prepareMcpConfigFile,
  classifyProcError,
  PERMISSION_MODES,
} from "./modules/cliRunner";
export type {
  PermissionMode,
  ProcErrorKind,
  BuildSpawnArgsOptions,
  McpConfigFileDeps,
  McpConfigFileFs,
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

// R6：按合集分工作区（合集判定 / 目录名净化 / 重名索引 / 本轮 cwd 编排）
export {
  normalizeWorkspaceMode,
  pickCollectionID,
  sanitizeCollectionDirName,
  parseCollectionIndex,
  serializeCollectionIndex,
  resolveCollectionDirName,
  resolveTurnWorkspace,
  WORKSPACE_MODES,
  WORKSPACE_INDEX_FILE,
  COLLECTION_DIR_MAX,
} from "./utils/collectionWorkspace";
export type {
  WorkspaceMode,
  CollectionDeps,
  CollectionIndexEntry,
  WorkspaceFs,
} from "./utils/collectionWorkspace";

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

// R7-A：面板内指令编辑器（PLAN-R7 §2）
export {
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_MAX_CHARS,
  normalizeInstructionScope,
  resolveInstructionsPath,
  readInstructions,
  saveInstructions,
} from "./utils/instructions";
export type {
  InstructionScope,
  InstructionsFs,
  InstructionsReadResult,
  InstructionsSavedResult,
} from "./utils/instructions";

// R7-B：@ 提及与跨文献范围注入（PLAN-R7 §3）
export {
  MENTION_QUERY_MAX,
  MENTION_RESULTS_MAX,
  MENTION_CHIPS_MAX,
  MENTION_ABSTRACT_MAX,
  MENTION_AUTHORS_MAX,
  searchMentionItems,
  resolveMentionRefs,
  buildReferencedItemsBlock,
  mergeAddDirs,
} from "./utils/mentions";
export type {
  MentionSearchItem,
  ResolvedRef,
  RawRef,
  MentionRefDeps,
} from "./utils/mentions";

// R7-C：`/` 命令面板（PLAN-R7 §3.5）——本地命令白名单 + 两处固定目录扫描 + 过滤
export {
  COMMANDS_DIR_USER,
  COMMANDS_DIR_PROJECT,
  COMMAND_FILE_MAX_BYTES,
  COMMANDS_MAX,
  COMMAND_FORWARD_MODE,
  LOCAL_COMMANDS,
  resolveLocalCommand,
  parseCommandFile,
  scanCommands,
  readCommandBody,
  filterCommands,
  parseCommandInvocation,
  forwardCommandText,
} from "./utils/commands";
export type {
  CommandSource,
  CommandEntry,
  LocalCommand,
  ParsedCommandFile,
  CommandScanDeps,
  CommandDirEntry,
} from "./utils/commands";

// R7-D：跨文献范围注入（PLAN-R7 §3.6）
export {
  SCOPE_ITEMS_MAX,
  SCOPE_ABSTRACT_MAX,
  resolveScope,
  buildScopeBlock,
  mergeScopeAddDirs,
} from "./utils/scope";
export type {
  ScopeKind,
  ScopeRequest,
  ScopeCandidate,
  ScopeDeps,
  ResolvedScope,
} from "./utils/scope";

// R7-F：消息级操作（PLAN-R7 §3.8）——折叠阈值是对外承诺（UI 面纯函数在 chat/lib/messageActions）
// R8：折叠口径按用户反馈收窄 —— 12 行只对用户消息；AI 回复里代码块按 20 行（CODE_COLLAPSE_LINE_THRESHOLD）
export {
  COLLAPSE_LINE_THRESHOLD,
  CODE_COLLAPSE_LINE_THRESHOLD,
  COPY_FEEDBACK_MS,
} from "./chat/lib/messageActions";

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

// R7-H：真回滚（PLAN-R7 §3.9）——快照落点 / 0600 / 分叉编排（UI 面分支归约在 chat/lib/branchActions）
export {
  SNAPSHOT_FILE_MODE,
  SNAPSHOT_DIR_NAME,
  REWIND_JOURNAL_FILE,
  PROJECT_DIR_MAX_LEN,
  PROJECTS_SCAN_LIMIT,
  encodeProjectDir,
  findClaudeSessionFile,
  sameProjectDir,
  snapshotDir,
  snapshotPath,
  backupPath,
  journalPath,
  nextSnapshotTurn,
  snapshotTurn,
  readSnapshotIndex,
  rewindToTurn,
  recoverPendingRewind,
  planBranch,
} from "./utils/rewind";
export type {
  RewindFs,
  RewindRunner,
  RewindDeps,
  FindSessionFileInput,
  FoundSessionFile,
  RewindInput,
  RewindResult,
  RewindFailReason,
  RewindJournal,
  SnapshotIndex,
  SnapshotIndexEntry,
  SnapshotInput,
  BranchPlan,
} from "./utils/rewind";

// R7-I：消息分支按钮（PLAN-R7 §3.10）——分支归约纯函数
export {
  initialBranchState,
  canBranchTurn,
  snapshotTurnForMessage,
  snapshotTurnForEdit,
  branchButtonState,
  messageBranchClick,
  branchCreated,
  sessionRows,
} from "./chat/lib/branchActions";
export type {
  BranchState,
  BranchButtonState,
  BranchSessionMessage,
  BranchSessionLike,
  SessionRow,
} from "./chat/lib/branchActions";

// R7-J：附件（PLAN-R7 §3.11）——落点在**本轮 cwd**下（collection 模式跟着合集目录走，不需要 --add-dir）
export {
  ATTACHMENT_DIR_NAME,
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_EXEC_EXTS,
  sanitizeAttachmentName,
  uniqueAttachmentName,
  isImageAttachment,
  attachmentRejectReason,
  attachmentDirPath,
  saveAttachments,
  resolveEditedAttachments,
  markMissingAttachments,
  buildAttachmentsBlock,
} from "./utils/attachments";
export type {
  Attachment,
  AttachmentInput,
  AttachmentsFs,
  RejectedAttachment,
  SavedAttachment,
  SaveAttachmentsResult,
} from "./utils/attachments";

// R7-K：会话列表重组（PLAN-R7 §3.12）——分区/分组/搜索/归档/置顶的纯投影
export {
  ARCHIVE_IDLE_DAYS,
  ARCHIVE_MAX_RECENT,
  UNFILED_LABEL,
  buildSessionList,
} from "./chat/lib/sessionList";
export type {
  SessionListItem,
  SessionListRow,
  SessionListGroup,
  SessionListModel,
  SessionListInput,
} from "./chat/lib/sessionList";

export { appendNoteHtml } from "./utils/noteAppend";
export { sanitizeNoteHtml } from "./utils/htmlSanitize";

// R4-1/R5：会话跟随、权限档映射（PLAN-R4 §2）；R8 起浮层几何/开合契约整体删除
export { followReader } from "./chat/lib/chatModel";
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

// R9：/diag 诊断报告（宿主只读采集 → 纯函数拼文本；脱敏在纯函数里）
export {
  DIAG_HEADER,
  DIAG_LABEL_WIDTH,
  DIAG_VALUE_MAX,
  DIAG_KEYS,
  ZOTERO_SUPPORT_RANGE,
  buildDiagReport,
  formatDiagLine,
  redactValue,
  isSecretKey,
} from "./utils/diag";
export type { DiagKey, DiagValue, DiagInput } from "./utils/diag";
