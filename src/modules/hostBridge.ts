// hostBridge.ts — 宿主↔UI postMessage 桥（INTERFACE §4.6）+ 会话运行时（M4 起，M5 补全会话管理）。
// 纯逻辑模块：所有宿主服务（postMessage/launchURL/spawn/上下文/工作区/prefs/会话存储）依赖注入，
// node:test 全程 fake（Gecko API 零引用）；Zotero 真实接线在 sections.ts。
// 握手方向（spike 实测定型）：宿主在 browser load 先发 init，页面经 event.source 回 hello。
// M5 范围：会话索引 CRUD（createSession/deleteSession/setPermissionMode）、getHistory 回放、
// resume（session.claudeSessionId → --resume）、SESSION_GONE 判定（classifyProcError）；
// M6 范围：权限卡流转（requestPermission 广播 / permissionResponse 回写 / remember 规则串落 allowedTools /
// 该轮结束撤销 MCP token）；
// M7 范围：saveNote/listNotes 转发到 notes.ts（宿主唯一写库模块，deps.notes 注入；
// 未接线 → 回 SAVE_FAILED，UI 不悬挂等待）。

import {
  buildSpawnArgs,
  classifyProcError,
  PERMISSION_MODES,
  type PermissionMode,
  type SpawnTurnOptions,
  type TurnEvent,
  type TurnHandle,
} from "./cliRunner";
import type { CliChannel, CliStatus } from "./cliDetect";
import {
  SESSION_TITLE_MAX,
  type PersistedTurnBlock,
  type SessionRecord,
  type SessionStore,
} from "../utils/sessionStore";
import type {
  BalanceStatus,
  HostMessage,
  InFlightInfo,
  InFlightTurnBlock,
  SessionSummary,
} from "../chat/lib/types";
import { addUsage, type UsageStats } from "../chat/lib/usage";
import { SCOPE_ITEMS_MAX, SCOPE_SELECTION_LABEL } from "../utils/scope";
import { buildRememberRule, isSafeRememberRule } from "../utils/rememberRule";
import type {
  InstructionsReadResult,
  InstructionsSavedResult,
} from "../utils/instructions";
import {
  resolveMentionRefs,
  MENTION_CHIPS_MAX,
  type MentionSearchItem,
  type RawRef,
} from "../utils/mentions";
import {
  BUILTIN_COMMANDS,
  LOCAL_COMMANDS,
  type CommandEntry,
} from "../utils/commands";
import { DIAG_HEADER } from "../utils/diag";
import { createSeqGuard } from "../utils/seqGuard";
import type { ResolvedScope, ScopeKind } from "../utils/scope";
import {
  sanitizeAttachmentName,
  type AttachmentInput,
  type RejectedAttachment,
  type SaveAttachmentsResult,
} from "../utils/attachments";
import {
  planBranch,
  readSnapshotIndex,
  rewindToTurn,
  snapshotPath,
  snapshotTurn,
  type RewindFailReason,
  type RewindFs,
  type RewindResult,
  type SessionFileLookup,
} from "../utils/rewind";
import type {
  PermissionRequestPayload,
  ResolvedPermission,
} from "./permissionMcp";
// 类型只读导入（notes.ts 运行时依赖 Zotero 全局，宿主侧接线在 sections.ts 完成）
import type { NoteListResult, NoteSaveResult, SaveNoteInput } from "./notes";
// 类型只读导入（inputHistoryStore.ts 是纯逻辑模块，sections.ts 注入 IOUtils 实现）
import type { InputHistoryStore } from "./inputHistoryStore";

/** UI 实例键（真实形态为 browser.contentWindow；测试用普通对象） */
export type UiWindowKey = object;

/** 页面回发通道（MessageChannel 宿主端；按实际用到的成员收窄，与 sections.ts 同风格） */
export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close?(): void;
}

/** 该轮 prompt 与上下文（宿主组装，§4.1/§4.1.1） */
/** R7-D：本轮范围注入载荷（itemKeys 已在 handleSend 里白名单化 + 截断到 40） */
export interface ScopeInject {
  kind: ScopeKind;
  label: string;
  itemKeys: string[];
  truncated?: boolean;
}

export interface TurnPromptInput {
  itemKey: string | null;
  attachmentKey: string | null;
  prompt: string;
  addDir: string | null;
  /**
   * R7-B：本轮 --add-dir 列表（当前附件目录 ∪ 各引用条目的 PDF 目录，去重，≤20）。
   * 非空时取代 addDir 逐目录各出一参数；写保护 deny 逐目录覆盖（cliRunner）。
   */
  addDirs?: string[];
  /**
   * R7-J：本轮附件的落盘结果（saved 的 path 是绝对路径）——桥据此回 attachmentSaved 回执，
   * UI 把那几条路径存进对应用户消息（编辑态复用）。无附件/未接线 → 字段不出现。
   */
  attachmentSaved?: SaveAttachmentsResult;
}

export interface HostBridgeDeps {
  /** 向实例发消息（真实实现：contentWindow.postMessage(msg, "*", ports)，内部 try/catch 防死实例） */
  post(win: UiWindowKey, msg: HostMessage, ports?: unknown[]): void;
  /** 建握手用 MessageChannel（Gecko 侧注入；不可用返回 null → 页面回退 event.source，见 §4.6） */
  createChannel(): { port1: PortLike; port2: unknown } | null;
  log(message: string): void;
  now(): number;
  /** 打开外部链接（http/https 校验在本模块，§4.6 openExternal 行） */
  launchURL(url: string): void;
  /**
   * 组装该轮 prompt 与上下文（真实实现经 contextBuilder + promptTemplate）。
   * refs（R7-B）：本轮点名的文献 itemKey（UI 的 chips）——实现侧解析成参考条目注入
   * [Referenced items] 区块，并把各条目 PDF 目录并入 --add-dir。
   * scope（R7-D）：本轮范围注入（分类全部/书库选中）——注入 [Scope: …] 区块，目录同样并入
   * --add-dir（上限 40，deny 逐目录覆盖）。
   */
  buildTurnPrompt(
    text: string,
    refs?: string[],
    scope?: ScopeInject | null,
    /**
     * R7-J：本轮附件（已白名单化）+ 落点参数。实现侧自行经 ensureWorkspace 现算 cwd
     * （落点 = `<cwd>/attachments/<会话id>/<轮序号>`，永远在 cwd 内 → 不需要额外 --add-dir）。
     * 落盘结果经 TurnPromptInput.attachmentSaved 回给桥（UI 回执）。
     */
    attach?: {
      files: AttachmentInput[];
      sessionId: string;
      turn: number;
    } | null,
  ): Promise<TurnPromptInput>;
  /** R7-C：命令清单（只扫固定两处 .claude/commands；实现侧只读 frontmatter） */
  listCommands?: () => Promise<CommandEntry[]>;
  /** R7-D：范围解析（分类全部 / 书库选中 → 参考条目） */
  resolveScope?: (kind: "collection" | "selection") => Promise<ResolvedScope>;
  /** R7-C：打开工作区目录（/workspace；实现侧 reveal，失败抛错） */
  openWorkspacePath?: (path: string) => Promise<void>;
  /**
   * R8：面板顶栏「全页」→ 打开独立工作台标签页（实现侧 = mainTab.openMainTab）。
   * 载荷只有「打开全页」这个动作本身：UI 不传路径、不传命令名（§安全：桥只接受已注册实例的这条消息）。
   */
  openFullPage?: () => void;
  /**
   * R7-C：/export 落盘（工作区内的 Markdown 源码）。实现侧自行拼落点 + 净化文件名，
   * 越界/写失败回 ok:false + error（UI 只转发，不传路径）。
   */
  exportSession?: (input: {
    title: string;
    markdown: string;
  }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /**
   * 本轮工作区（spawn cwd）：R6 起按 itemKey 现算——single 模式 = 工作区根（既有行为），
   * collection 模式 = `<根>/<合集目录名>`。失败抛 code=WORKSPACE_UNAVAILABLE 的 Error
   *（仅根本身不可用；合集目录问题由实现侧回落根目录）（§4.1 cwd 行）。
   */
  ensureWorkspace(itemKey: string | null): Promise<string>;
  /** spawn 基础；command 为 null = claude 未解析到（→ CLAUDE_NOT_FOUND） */
  getSpawnBase(): Promise<{
    command: string | null;
    /** 派发通道（cliDetect 解析产物）：win32 .cmd 壳必须带至此，否则 spawnTurn 无从包装（§2.10 B） */
    channel: CliChannel;
    environment: Record<string, string>;
    environmentAppend: boolean;
    /** cmd 通道的 cmd.exe 绝对路径（win32 专有；Gecko 拒收裸名，§2.10 B） */
    cmdExe?: string;
  }>;
  /**
   * 权限 MCP 端点（§4.8）：该轮一次性 token + 监听端口；实现抛错 = 端点故障
   * → 该轮不 spawn，桥回 SPAWN_FAILED（无后备路径）。允许返回 Promise（真实实现需先起监听）。
   */
  getMcpEndpoint(
    sessionId: string,
  ): { port: number; token: string } | Promise<{ port: number; token: string }>;
  /** 该轮进程退出：撤销一次性 token + 结掉在途权限请求（§4.8 token 随进程作废） */
  closeMcpTurn?(token: string): void;
  /**
   * 该轮 mcp-config 文件：把 MCP 配置 JSON 写进 0600 临时文件并返回其路径（spawn 只传路径，
   * 一次性 token 不进 argv 的 ps 可见面）。返回 null = 写失败 → 调用方回落内联 JSON
   * （可用性优先，不因此拦下这一轮）。未注入（老宿主/测试）→ 同 null，走内联。
   */
  prepareMcpConfig?(port: number, token: string): Promise<string | null>;
  /** 该轮进程退出/失败：删除该轮 mcp-config 文件（清理失败只 log，不影响解锁） */
  cleanupMcpConfig?(path: string): void;
  /**
   * 该轮附件目录写保护（M10）：把 deny 规则写进临时 settings 文件并返回其路径；
   * 无附件目录（null）→ null（不带 --settings）。实现抛错 = 写保护没建成
   * → 该轮不 spawn（fail-closed：宁可缺这一轮，也不放一个未受保护的附件目录跑）。
   * R7-B：入参改收**目录集**（当前附件目录 ∪ 引用条目 PDF 目录）；实现必须对**每个**目录
   * 各生成 Write/Edit 拒绝规则——扩权不得削弱 PDF 写保护（本轮安全红线）。
   */
  prepareDenySettings?(addDirs: string[] | null): Promise<string | null>;
  /** 该轮进程退出：删除该轮 settings 文件（清理失败只 log，不影响解锁） */
  cleanupDenySettings?(path: string): void;
  /** permissionResponse 回写端点；未知/已结 requestId → null（§4.6：忽略 + log） */
  resolvePermission?(
    requestId: string,
    allow: boolean,
  ): ResolvedPermission | null;
  getDefaultPermissionMode(): PermissionMode;
  spawnTurn(options: SpawnTurnOptions): TurnHandle;
  /**
   * hello 注册完成后向实例补推 readerContext（§4.6 宿主→UI 表；返回 null 跳过）。
   * R17 P4：形参多一个可选 win——宿主按「实例所在标签页」取那一份（sections.ts 的
   * buildReaderContextFor）；不传 = 今天的全局语义（老宿主/测试的零参写法仍兼容）。
   */
  buildReaderContext(win?: UiWindowKey): Promise<HostMessage | null>;
  /** 会话索引与旁挂历史（§4.5；纯逻辑模块，宿主侧注入 IOUtils 实现） */
  sessions: SessionStore;
  /**
   * 输入历史（↑/↓ 翻已发送消息）的宿主持久化（modules/inputHistoryStore.ts，sections.ts 装配）。
   * 未注入（老宿主/测试）→ 不落盘：getInputHistory 回空、saveInputHistory 忽略，UI 退化为内存历史。
   */
  inputHistory?: InputHistoryStore;
  /** itemKey → 条目信息（createSession 校验 + sessionList 标题 + itemLibraryID 回填）；查无 → null */
  lookupItem(itemKey: string): Promise<{
    libraryID: number;
    title: string | null;
    /** R7-K：「全部会话」抽屉按合集分组（无合集/查不到 → null） */
    collectionName?: string | null;
  } | null>;
  /**
   * R7-K：置顶集合（会话 id 列表，本地 prefs 持久化）。未注入 → 置顶面不显示
   *（UI 仍可点，回执里 pinned 恒为空集）。
   */
  pinnedSessions?: {
    get(): string[];
    set(ids: string[]): void;
  };
  /** init→hello 握手超时（§4.6：30s 未 hello → log error）；测试注入小值 */
  helloTimeoutMs?: number;
  /**
   * M9 CLI 检测结论（PLAN §2.7）：实例注册完成即按需推 error 横幅；
   * null/未注入 = 不推（尚未测完时由 sections 测完后 broadcast 补推）
   */
  getCliStatus?(): CliStatus | null;
  /** R15 F6：宿主发现 spawn 侧 claude 不可用 → 丢弃解析缓存（下次 send 重解析） */
  invalidateCliResolve?(): void;
  /** R15 F10：面板打开时——上次检测失败才重查（成功不打扰），实现侧自带最小间隔 */
  reprobeCliIfFailed?(): void;
  /**
   * 笔记写入（M7，§4.3）：真实实现在 modules/notes.ts（全项目唯一写库模块，sections.ts 接线）。
   * 未注入 → saveNote 回 noteSaved{ok:false, code:SAVE_FAILED}、listNotes 回 error。
   */
  notes?: {
    saveNote(input: SaveNoteInput): Promise<NoteSaveResult>;
    listNotes(itemKey: string): Promise<NoteListResult>;
  };
  /**
   * R4-3 余额查询（真实实现：modules/balance.ts 的 createBalanceService，sections.ts 装配）。
   * 未注入 → 不推 balanceStatus（老宿主/测试环境 UI 不显示余额区）。
   * get(force=true) = 顶栏手动刷新（绕过 TTL）。
   */
  balance?: {
    get(force: boolean): Promise<BalanceStatus>;
  };
  /** R4-3：「显示用量/余额」开关（prefs）；缺省开 */
  showUsage?(): boolean;
  /**
   * R10：会话区展开态（本地 prefs 持久化；uiPrefs 推一次、setSessionsExpanded 写回）。
   * 未注入（老宿主/测试）→ 恒为收起（默认态），面板仍可展开（只是重开后不保持）。
   */
  sessionsExpanded?: {
    get(): boolean;
    set(expanded: boolean): void;
  };
  /**
   * R9：/diag —— 宿主侧只读采集本机事实并拼出报告文本（真实现 = sections.collectDiagReport，
   * 逐项兜底 + utils/diag 纯函数拼接）。未注入（老宿主/测试）→ 回一条「宿主未接线」的说明，
   * 面板不悬挂。采集不得改任何状态（不建会话/不落盘/不碰 CLI 会话文件）。
   */
  diag?: { collect(sessionId: string | null): Promise<string> };
  /** R7-A：工作区模式（uiPrefs 附带；UI 据此禁用「当前分类」作用域）；缺省 single */
  getWorkspaceMode?(): "single" | "collection";
  /**
   * R7-A：面板内指令编辑器（PLAN §2）。纯逻辑在 utils/instructions.ts，宿主注入
   * IOUtils 与工作区路径（sections.ts）。未注入 → 读/写各回一条带 error 的回执
   *（UI 显示「宿主未接线」，不悬挂）。
   */
  instructions?: {
    /** scope 为**枚举**（实现内部走白名单归一；UI 永不传路径） */
    read(scope: unknown): Promise<InstructionsReadResult>;
    save(scope: unknown, text: unknown): Promise<InstructionsSavedResult>;
  };
  /**
   * R7-B：@ 提及的宿主取数（真实实现见 modules/contextSource.ts）。未注入 →
   * searchItems 回空、resolveRefs 全标 missing（发送时被跳过，不拦这一轮）。
   */
  mentions?: {
    search(query: string): Promise<MentionSearchItem[]>;
    resolveItem(itemKey: string): Promise<RawRef | null>;
  };
  /**
   * R7-H/R7-I：真回滚面（PLAN §3.9）——数据目录 + IOUtils fs + cwd→CLI 会话文件映射。
   * 未注入（老宿主/测试）→ 不拍快照、编辑/分支回 BRANCH_UNAVAILABLE（UI 退化为不可分支）。
   */
  rewind?: {
    /** 插件数据目录（快照/journal 都落这里） */
    dataDir: string;
    fs: RewindFs;
    /**
     * R8：按会话 id 定位 CLI 会话文件（真宿主 = utils/rewind.findClaudeSessionFile：快路径用
     * cwd 推目录名，未命中扫 `<~/.claude>` 的 projects 根一层）。`found=null` = 找不到 → 调用方
     * 走 fail-safe（快照落空、回滚拒绝）；`capped` 是「没扫完」的信息位（本模块不用，与函数
     * 同形透传，免得多一份形状）。
     * 未注入（老宿主/测试）→ 退回下面两条 cwd 推导（行为逐字不变）。
     */
    findSessionFile?(
      cwd: string,
      claudeSessionId: string,
    ): Promise<SessionFileLookup>;
    /** cwd → CLI 项目目录名（老口径；仅作 findSessionFile 的回落，**不可当权威**） */
    projectDirFor(cwd: string): string;
    /** CLI 会话文件绝对路径（老口径；仅作 findSessionFile 的回落） */
    claudeSessionPath(cwd: string, claudeSessionId: string): string;
    /** 宿主平台："win32" 时 PROJECT_DIR_MISMATCH 闸门按大小写不敏感比较（见 rewind.sameProjectDir） */
    platform: string;
  };
  /**
   * 安全修：「选择文件」的宿主原生选择器（真实实现 = sections.ts 的 nsIFilePicker，
   * parent 必须是**发起消息的那个窗口**的 browsingContext）。返回用户选中的文件；
   * 取消 → 空数组。路径只在本模块内存里流转，绝不回给页面（页面只拿一次性 token）。
   * 未注入（老宿主/测试）→ pickAttachments 回空列表并记日志（UI 不悬挂）。
   */
  pickFiles?(
    win: UiWindowKey,
    opts: { multiple: boolean },
  ): Promise<PickedFile[]>;
}

/** 宿主选择器选中的文件（路径只在宿主侧流转；登记进 token 表） */
export interface PickedFile {
  path: string;
  name: string;
  sizeBytes: number;
}

/**
 * R14 修点 3：本轮流式过程块的宿主侧累加器（onTurnEvent 逐事件攒，finishTurn 成品化落盘）。
 * index 是 content_block 的 index（每个 messageStart 重新计数），归并一律「取最后一个匹中的」。
 * R17 P7：kind 多一个 "text"——正文块只活在内存（供 `inFlight.blocks`），**不落盘**
 *（finalizeTurnBlocks 显式跳过）。
 */
interface TurnBlockAcc {
  kind: "thinking" | "tool" | "text";
  /** content_block 的 index（**每条 assistant 消息重新计数** → 归并键是下面的 message + index） */
  index: number;
  /**
   * R17 P7：第几条 assistant 消息（messageStart 递增）。只有 text 块用得上它：
   * 正文块必须按 (message, index) 归并——同一个 index 在两条消息里都会出现，只按 index 归并
   * 会把跨消息的正文拼成一句（PLAN-R14 失败模式 E 杂糅句）。
   */
  message: number;
  text: string;
  toolName: string;
  toolUseId: string;
  inputJson: string;
  result: { isError: boolean; summary: string } | null;
}

/**
 * 落盘前的逐块截断上限（UTF-16 码元）与整轮预算（**UTF-8 字节**）——防历史文件被大
 * inputJson 撑爆。预算按 UTF-8 字节判（WIN-COMPAT 建议-2：按 `.length` 判时中文实际
 * 落盘可达 3 倍预算，32K 变 ~96K）。
 */
const TURN_BLOCK_TEXT_MAX = 2000;
const TURN_BLOCK_SUMMARY_MAX = 500;
const TURN_BLOCKS_BUDGET = 32 * 1024;

/** 字符串的 UTF-8 字节数（TextEncoder 在 Gecko/node 都有；取不到时回落码元数） */
function utf8Bytes(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

function clipTurnBlockText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 累加器 → 成品块：逐块截断、空思考块丢弃、超整轮预算即停止收集（后续块不落盘）。
 * `keepText=false`（落盘）：正文块跳掉——落盘行的正文在那行的 `text` 字段里，**落盘格式逐字不变**
 *（R14 T8/T9/T14 与 r14-blocks-persist 五例都锁着这一点）。
 * `keepText=true`（在途占位）：正文块保留，并带上 `message`（本轮消息序号）与 tool 的
 * `toolUseId`——前者让页面能把块按消息分组（index 每条消息从 0 重新计数），后者让占位工具卡
 * 收得到 live `toolResult`（按 id 命中）。
 */
function turnBlocksOf(
  accs: TurnBlockAcc[],
  keepText: boolean,
): InFlightTurnBlock[] {
  const out: InFlightTurnBlock[] = [];
  let used = 0;
  for (const acc of accs) {
    let item: InFlightTurnBlock;
    if (acc.kind === "text") {
      if (!keepText || !acc.text) {
        continue; // 落盘不要正文块；还没流出正文的空块也不占位
      }
      item = {
        blockType: "text",
        index: acc.index,
        message: acc.message,
        text: clipTurnBlockText(acc.text, TURN_BLOCK_TEXT_MAX),
      };
    } else if (acc.kind === "thinking") {
      const text = clipTurnBlockText(acc.text, TURN_BLOCK_TEXT_MAX);
      if (!text.trim()) {
        continue; // 本机 CLI 思考文本常为空：空思考块不落盘、也不占位
      }
      item = {
        blockType: "thinking",
        index: acc.index,
        message: acc.message,
        text,
      };
    } else {
      item = {
        blockType: "tool",
        index: acc.index,
        message: acc.message,
        toolUseId: acc.toolUseId,
        toolName: acc.toolName,
        inputJson: clipTurnBlockText(acc.inputJson, TURN_BLOCK_TEXT_MAX),
        result: acc.result
          ? {
              isError: acc.result.isError,
              summary: clipTurnBlockText(
                acc.result.summary,
                TURN_BLOCK_SUMMARY_MAX,
              ),
            }
          : null,
      };
    }
    const size = utf8Bytes(JSON.stringify(item));
    if (used + size > TURN_BLOCKS_BUDGET) {
      break;
    }
    used += size;
    out.push(item);
  }
  return out;
}

/**
 * 落盘成品（**只有过程块**）：从成品块投影出磁盘形态——`index`/`message`/`toolUseId` 是
 * 在途占位专用字段，落盘行不带（R14 逐字锁着落盘形状）。
 */
function finalizeTurnBlocks(accs: TurnBlockAcc[]): PersistedTurnBlock[] {
  const out: PersistedTurnBlock[] = [];
  for (const b of turnBlocksOf(accs, false)) {
    if (b.blockType === "thinking") {
      out.push({ blockType: "thinking", text: b.text });
    } else if (b.blockType === "tool") {
      out.push({
        blockType: "tool",
        toolName: b.toolName,
        inputJson: b.inputJson,
        result: b.result,
      });
    }
    // text 块不会出现在这里（keepText=false）
  }
  return out;
}

/**
 * 单会话运行时状态（内存侧；持久侧是 SessionStore 的 SessionRecord，两者按 id 对应）。
 * 会话记录本身不驻留内存：每次用到就向 store 取，保证「索引是唯一真相」。
 */
interface SessionRuntime {
  /** null=空闲；running=进程存活；interrupting=kill 已发、进程未退（§4.6 并发契约） */
  busy: "running" | "interrupting" | null;
  turn: TurnHandle | null;
  /** 本轮用户输入原文（result 到达时与 assistant 最终文本一起落旁挂历史，§4.5） */
  pendingUserText: string;
  /** 本轮 assistant 最终文本：assistantMessage 校准优先，textDelta 累积兜底 */
  assistantText: string;
  streamText: string;
  /**
   * R14：当前这条 assistant 消息已流出的正文（messageStart 清零 / textDelta 累加 /
   * assistantMessage 之后清零）——在途轮占位正文用它。**不能用 assistantText 或
   * streamText 代替**：前者是「上一条已完成消息」的正文（每条 assistantMessage 覆盖），
   * 后者是「整轮累加」，多消息工具轮里都会拼出杂糅句（PLAN-R14 失败模式 E）。
   */
  curText: string;
  /** R14：本轮被接受时该会话的已落盘历史行数（inFlight 幂等键，见 PLAN-R14 修点 2） */
  baseRows: number;
  /** R14 修点 3：本轮过程块累加器（落盘后回放轮才有条带）；R17 起还装 text 块（只给在途占位） */
  turnBlocks: TurnBlockAcc[];
  /** R17 P7：当前是第几条 assistant 消息（messageStart 递增；text 块的归并键之一） */
  messageSeq: number;
  /**
   * R4-3：本轮 assistantMessage 逐条累加的用量（result 无 usage 时的兜底）。
   * result 到达即清空（该轮收尾）；不参与 index 以外的任何逻辑。
   */
  turnUsage: UsageStats | null;
}

/** 会话运行时快照（测试与宿主日志用） */
export interface SessionRuntimeSnapshot {
  sessionId: string;
  busy: "running" | "interrupting" | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * R8：CLI 会话文件定位（快照与回滚的唯一来源）。
 * 真宿主给 findSessionFile（按会话 id 扫 projects 一层 → 符号链接/长路径工作区也命中；本模块
 * 只用 `.found`）；老宿主/测试只有 cwd 推导两条 → 退回它们（行为逐字不变）。定位失败（含抛错）
 * → null，调用方按既有 fail-safe 处理（不猜路径、不拿 cwd 现推去当权威）。
 */
async function locateSessionFile(
  cfg: NonNullable<HostBridgeDeps["rewind"]>,
  workspace: string,
  claudeSessionId: string,
  log: (message: string) => void,
): Promise<{ path: string; projectDir: string } | null> {
  if (cfg.findSessionFile) {
    try {
      return (await cfg.findSessionFile(workspace, claudeSessionId)).found;
    } catch (err) {
      log(`[bridge] session file lookup failed: ${String(err)}`);
      return null;
    }
  }
  return {
    path: cfg.claudeSessionPath(workspace, claudeSessionId),
    projectDir: cfg.projectDirFor(workspace),
  };
}

/** R7-H：回滚失败原因 → 桥错误码（UI 展示 message；码给按钮分支与埋点用） */
function rewindErrorCode(reason: RewindFailReason): string {
  switch (reason) {
    case "REWIND_BUSY":
      return "REWIND_BUSY";
    case "FORK_FAILED":
      return "SPAWN_FAILED";
    case "RESTORE_FAILED":
      return "REWIND_FAILED";
    default:
      return "REWIND_REFUSED";
  }
}

/**
 * R7-B：UI 传来的引用条目 key 白名单化（非字符串丢掉、去重、截到 20）。
 * key 只是查询用的不透明串（真正的取数在宿主侧 resolveItem），但仍按上限收口，
 * 免得异常 UI 让宿主对无限多个 key 查库。
 */
/**
 * R7-D：UI 传来的范围载荷白名单化（kind 枚举收口；itemKeys 同 refs 口径但上限 40；
 * label 只当显示/注入文本，长度截断防超长）。非法/缺失 → null（本轮不注入范围）。
 */
function normalizeScopeInject(raw: unknown): ScopeInject | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind: ScopeKind =
    raw.kind === "collection" ? "collection" : "selection";
  const list = Array.isArray(raw.itemKeys) ? raw.itemKeys : [];
  const itemKeys: string[] = [];
  for (const key of list) {
    if (
      typeof key === "string" &&
      key &&
      !itemKeys.includes(key) &&
      itemKeys.length < SCOPE_ITEMS_MAX
    ) {
      itemKeys.push(key);
    }
  }
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim().slice(0, 120)
      : kind === "collection"
        ? "当前分类"
        : SCOPE_SELECTION_LABEL;
  return { kind, label, itemKeys, truncated: raw.truncated === true };
}

function normalizeRefKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const keys: string[] = [];
  for (const key of list) {
    if (typeof key === "string" && key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys.slice(0, MENTION_CHIPS_MAX);
}

/** assistantMessage.content[] 的文本块拼接（落旁挂历史的最终 assistant 文本，§4.5） */
function textOfAssistantMessage(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export interface HostBridge {
  /** browser load 后调用：记 pending（含一次性 token）+ 发 init（幂等：重复调用重复 init，页面侧重发 hello 即完成二次握手） */
  beginHandshake(win: UiWindowKey, token: string): void;
  /** message 事件入口（真实宿主接 window "message"，测试直接喂 {source, data}） */
  dispatch(ev: { source: unknown; data: unknown }): void;
  /** 向全部已注册实例广播（§2.2 多实例同收） */
  broadcast(msg: HostMessage): void;
  sendTo(win: UiWindowKey, msg: HostMessage): void;
  /** 权限卡请求广播（§4.6 permissionRequest；permissionMcp 端点经宿主调此口） */
  requestPermission(req: PermissionRequestPayload): void;
  /**
   * 权限卡结算通知（§4.6 permissionResolved，permissionMcp 的 settled 回调经宿主调此口）：
   * 该卡已结算（任一实例作答 / 120s 超时 / 该轮进程退出）→ 广播给**全部**实例摘卡。
   * 缺这条通知时，卡只在作答的那个实例本地消失；后台 reader tab 的侧栏页留着残影，
   * 用户切过去（或打开该侧栏）会看到一张「早已审批完」的卡（用户报障原形）。
   */
  permissionSettled(requestId: string): void;
  /** 实例注销（section onDestroy / tab onClose）：移出 pending 与注册表 */
  unregister(win: UiWindowKey): void;
  /**
   * R17 P4：当前已注册实例的窗口列表（**拷贝**；遍历期间注册表可变）。用于按实例定向投递
   *（readerContext 每实例收自己标签页的那一份）。空 = 没有实例可投（插件停用/无面板）。
   */
  instances(): UiWindowKey[];
  /** 会话运行时快照（测试与宿主日志用）；未知会话 → null */
  getRuntime(sessionId: string): SessionRuntimeSnapshot | null;
}

/** 握手实例条目：一次性 token（BUG-16）+ 页面回发端口 */
interface InstanceEntry {
  token: string;
  timer?: ReturnType<typeof setTimeout>;
  /** MessageChannel 宿主端；null = 只能走窗口 event.source 回发路径 */
  port: PortLike | null;
}

export function createHostBridge(deps: HostBridgeDeps): HostBridge {
  const registry = new Map<UiWindowKey, InstanceEntry>();
  const pending = new Map<UiWindowKey, InstanceEntry>();
  /** 会话运行时（按会话 id；索引记录在 deps.sessions，这里只放进程/本轮文本等易失状态） */
  const runtimes = new Map<string, SessionRuntime>();

  const helloTimeoutMs = deps.helloTimeoutMs ?? 30_000;
  /** R17 P1：sessionList 推送序号（pushSessionList 是唯一出口，见该函数注释） */
  const sessionListGuard = createSeqGuard();
  /** R17 P3：宿主同步点耗时超过这个毫秒数才记一条（避免刷屏） */
  const SLOW_OP_MS = 20;

  /** 索引写失败只记日志不抛（数据安全路径：静默失败比报错更危险，但也不能掀翻桥上协议） */
  function persist(promise: Promise<unknown>): void {
    void promise.catch((err) => {
      deps.log(`[bridge] session persist failed: ${String(err)}`);
    });
  }

  /** 删除本轮临时文件（deny settings / mcp-config）；失败只 log（清理是卫生动作，不该影响解锁/后续轮） */
  function cleanupTurnFile(
    path: string | null,
    cleanup: ((p: string) => void) | undefined,
    label: string,
  ): void {
    if (!path || !cleanup) {
      return;
    }
    try {
      cleanup(path);
    } catch (err) {
      deps.log(`[bridge] ${label} cleanup failed: ${String(err)}`);
    }
  }

  /**
   * R17 P3：宿主同步点耗时埋点（**只观测**）。超阈值才记一条，避免刷屏。
   * 用 `Date.now()` 而不是 `deps.now()`：后者是注入的「业务时钟」（测试里是固定值），量不了耗时。
   */
  function logSlow(
    op: "readHistory" | "spawn" | "sessionList",
    startedAt: number,
  ): void {
    const ms = Date.now() - startedAt;
    if (ms >= SLOW_OP_MS) {
      deps.log(`[bridge] slow ${op} ${ms}ms`);
    }
  }

  /** 异步分发兜底：任务抛错既不静默吞掉，也不许变成未处理拒绝（否则 UI 侧状态可能永久卡住） */
  function guard(label: string, task: Promise<unknown>): void {
    void task.catch((err) => {
      deps.log(`[bridge] ${label} failed: ${String(err)}`);
    });
  }

  function clearPendingTimer(win: UiWindowKey): void {
    const entry = pending.get(win);
    if (entry) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      pending.delete(win);
    }
  }

  function sendTo(win: UiWindowKey, msg: HostMessage): void {
    try {
      deps.post(win, msg);
    } catch (err) {
      // 死实例（section 已销毁未注销）：摘除引用，此后不再向其发消息
      deps.log(
        `[bridge] post failed, unregistering dead instance: ${String(err)}`,
      );
      registry.get(win)?.port?.close?.();
      registry.delete(win);
      clearPendingTimer(win);
    }
  }

  function broadcast(msg: HostMessage): void {
    for (const win of [...registry.keys()]) {
      sendTo(win, msg);
    }
  }

  /**
   * 握手首条 init（BUG-16）：init 携带本实例一次性 token（页面从自己 URL 读到的同值），
   * 并转移一个 MessagePort 作为页面回发通道——chrome 作用域下 postMessage 的 origin 恒为空串、
   * event.source 不可依赖，不能作信任依据（真机实测见 §4.6 修订）。
   * 端口转移失败（DataCloneError 等）回退纯窗口通道，页面侧按 event.source 回发。
   */
  function beginHandshake(win: UiWindowKey, token: string): void {
    clearPendingTimer(win);
    const entry: InstanceEntry = { token, port: null };
    entry.timer = setTimeout(() => {
      if (pending.get(win) === entry) {
        deps.log(
          `[bridge] hello timeout (${Math.round(helloTimeoutMs / 1000)}s): page never replied, instance stays unregistered`,
        );
        entry.port?.close?.();
        pending.delete(win);
      }
    }, helloTimeoutMs);
    pending.set(win, entry);

    // 通道构造与 init 投递全程兜底：任何一步抛错都必须留下日志（真机调试埋点，故障排查的第一现场）
    let channel: { port1: PortLike; port2: unknown } | null = null;
    try {
      channel = deps.createChannel();
    } catch (err) {
      deps.log(
        `[bridge] createChannel threw, fallback to window channel: ${String(err)}`,
      );
    }
    if (channel) {
      channel.port1.onmessage = (ev) => dispatchFrom(win, ev.data, "port");
      entry.port = channel.port1;
      try {
        deps.post(win, { type: "init", token }, [channel.port2]);
        deps.log("[bridge] init sent (token set, port transferred)");
        return;
      } catch (err) {
        deps.log(
          `[bridge] init with port rejected, retry via window: ${String(err)}`,
        );
        entry.port = null;
      }
    }
    try {
      deps.post(win, { type: "init", token });
      deps.log("[bridge] init sent (token set, window channel)");
    } catch (err) {
      deps.log(`[bridge] init failed (window channel): ${String(err)}`);
    }
  }

  function runtimeFor(id: string): SessionRuntime {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        busy: null,
        turn: null,
        pendingUserText: "",
        assistantText: "",
        streamText: "",
        curText: "",
        baseRows: 0,
        turnBlocks: [],
        messageSeq: 0,
        turnUsage: null,
      };
      runtimes.set(id, rt);
    }
    return rt;
  }

  /**
   * R14：该会话当前在途轮（无 → null）。两个下发路径共用：handleGetHistory 的回执与
   * handleSend 的开轮广播。只读 runtime（不新建）；判据同时要求 busy 与 pendingUserText
   * 非空（finishTurn 里 pendingUserText 挪到落盘之后才清，见该函数——真正的挡板在 UI 侧
   * 的 baseRows 行数键，这里只是第一道闸）。
   *
   * R17 P7：多带一个 `blocks`（整轮块，含 text 块）——它是「切走再切回」时的**权威占位源**：
   * `assistantText` 只装当前这条消息已流出的正文（`messageStart` / `assistantMessage` 都会清），
   * 工具轮执行的那几秒里恒为空，页面据此不建占位 ⇒ 正文与过程条带全丢。两条路径共用本函数，
   * 任何只改一条的实现都是半修（T-P7-a2 锁）。**有 inFlight 必有 blocks**（可为空数组）。
   */
  function inFlightOf(sessionId: string): InFlightInfo | null {
    const rt = runtimes.get(sessionId);
    return rt?.busy && rt.pendingUserText
      ? {
          userText: rt.pendingUserText,
          assistantText: rt.curText,
          busy: rt.busy,
          baseRows: rt.baseRows,
          blocks: turnBlocksOf(rt.turnBlocks, true),
        }
      : null;
  }

  /** sessionList 消息：全量索引 + 条目标题解析（§4.6 宿主→UI 表） */
  async function sessionListMessage(): Promise<HostMessage> {
    const startedAt = Date.now(); // R17 P3：同步点耗时埋点（超阈值才记）
    const sessions: SessionSummary[] = [];
    /** R7-K：同一 itemKey 只查一次（列表每次推送都查一轮，条目多了很亏） */
    const itemCache = new Map<
      string,
      { title: string | null; collectionName: string | null }
    >();
    for (const rec of deps.sessions.list()) {
      let itemTitle: string | null = null;
      let collectionName: string | null = null;
      if (rec.itemKey) {
        try {
          if (!itemCache.has(rec.itemKey)) {
            const info = await deps.lookupItem(rec.itemKey);
            itemCache.set(rec.itemKey, {
              title: info?.title ?? null,
              collectionName: info?.collectionName ?? null,
            });
          }
          const info = itemCache.get(rec.itemKey);
          itemTitle = info?.title ?? null;
          collectionName = info?.collectionName ?? null;
        } catch (err) {
          deps.log(`[bridge] itemTitle lookup failed: ${String(err)}`);
        }
      }
      // R7-I：分支字段 + 可用快照轮（消息分支按钮的禁用态判定只看它；读不到 = 无快照）
      const snapshotTurns = deps.rewind
        ? (
            (
              await readSnapshotIndex(
                { dataDir: deps.rewind.dataDir, sessionId: rec.id },
                { fs: deps.rewind.fs },
              )
            )?.snapshots ?? []
          ).map((s) => s.turn)
        : [];
      sessions.push({
        id: rec.id,
        title: rec.title,
        updatedAt: rec.updatedAt,
        createdAt: rec.createdAt, // 同条目多会话的列表区分信息（UI 补时间戳）
        itemKey: rec.itemKey,
        claudeSessionId: rec.claudeSessionId,
        itemTitle,
        // R7-H/I：分支字段只在是真分支时带；快照清单只在接线了回滚面时带（老宿主形态不变）
        ...(rec.parentId ? { parentId: rec.parentId } : {}),
        ...(typeof rec.branchIndex === "number"
          ? { branchIndex: rec.branchIndex }
          : {}),
        ...(deps.rewind ? { snapshotTurns } : {}),
        // R7-K：合集名（抽屉分组用）；无合集/查不到 → 不带该键（UI 归「未分类」）
        ...(collectionName ? { collectionName } : {}),
        // R4-3：会话累计用量随列表走——UI 换会话/重启后即可显示（不必等下一轮 usageStats）。
        // 无数据（从未跑过带用量的轮）→ 不带该键
        ...(rec.usage ? { usage: rec.usage } : {}),
      });
    }
    logSlow("sessionList", startedAt);
    return {
      type: "sessionList",
      sessions,
      // R7-K：置顶集合随列表走（本地 prefs；未接线 → 不带该键，UI 当作没置顶）
      ...(deps.pinnedSessions ? { pinned: deps.pinnedSessions.get() } : {}),
    };
  }

  /** R7-K：置顶/取消置顶（集合存 prefs；回执推 sessionList 收敛）。空/未知 id → 忽略 */
  function handleSetSessionPinned(msg: Record<string, unknown>): void {
    const id = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const pinned = msg.pinned === true;
    if (!id || !deps.pinnedSessions) {
      deps.log(`[bridge] setSessionPinned ignored (${id || "empty id"})`);
      return;
    }
    const current = deps.pinnedSessions.get();
    const next = pinned
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((x) => x !== id);
    deps.pinnedSessions.set(next);
    void pushSessionList();
  }

  /**
   * R10：会话区展开/收起（纯视图偏好，落本地 prefs）。**不回执、不推列表**：
   * 面板内的展开态由 UI 本地先改（点一下就展开，不等往返），pref 只在下次重开时经 uiPrefs 还原。
   */
  function handleSetSessionsExpanded(msg: Record<string, unknown>): void {
    if (!deps.sessionsExpanded) {
      deps.log("[bridge] setSessionsExpanded ignored (not wired)");
      return;
    }
    deps.sessionsExpanded.set(msg.expanded === true);
  }

  /**
   * R17 P1：会话列表推送（**唯一出口**——`sessionListMessage()` 只在这里被消费）。
   * 序号守卫：取数是异步的（每条会话一次 lookupItem），并发是常态（≥12 个调用点），
   * 先发起的可能后完成 → 旧快照覆盖新快照 → 页面上「有会话却被解绑」。
   * 契约（INTERFACE-R17 §1.3）：**对任一实例，后发起的快照一定不被先发起的覆盖**
   *（⇒ 收到的最后一条 sessionList 就是宿主最新索引的全量快照）。
   *
   * 为什么握手也走这里而不是自己 sendTo：守卫的「丢旧留新」只有在**所有出口都是广播**时
   * 才等价于「新的覆盖旧的」。若握手直发也参与守卫，握手取数一旦超越并发中的广播，
   * 就会只单播给新实例并把那次广播判为过期丢弃 ⇒ 其余已注册实例永远收不到那次索引变更
   *（T-P1-a2 锁死「单次不被吞」、T-P1-a3 锁死「握手不饿死其他实例」）。
   * hello 分支里 `registry.set(win, pended)` 是同步的、早于本 await ⇒ 新实例必在收件人里；
   * 其余实例收到重复快照无副作用（reduceSessionList 对同一份列表幂等）。
   */
  async function pushSessionList(): Promise<void> {
    const isLatest = sessionListGuard.begin();
    try {
      const msg = await sessionListMessage();
      if (!isLatest()) {
        deps.log("[bridge] sessionList push superseded → dropped");
        return;
      }
      broadcast(msg);
    } catch (err) {
      deps.log(`[bridge] sessionList build failed: ${String(err)}`);
    }
  }

  /**
   * R4-3：余额状态推送（面板打开时一次 / 顶栏手动刷新 force=true）。
   * 未接线（老宿主/测试）→ 不推，UI 不显示余额区。查询失败不抛（balance.get 自身已收敛，
   * 这里再兜一层：余额是装饰性信息，绝不该掀翻锁或握手）。
   */
  async function pushBalance(win: UiWindowKey, force: boolean): Promise<void> {
    if (!deps.balance) {
      return;
    }
    // 复查修-6：「显示用量/余额」关掉 = 不查询也不显示（设置页文案同口径）。此前只在 UI 侧不渲染，
    // 宿主仍照发请求——开关的本意是不出网（余额查询会带 Key 访问 api.deepseek.com）
    if (deps.showUsage?.() === false) {
      return;
    }
    try {
      const status = await deps.balance.get(force);
      sendTo(win, {
        type: "balanceStatus",
        provider: status.provider,
        balance: status.balance,
      });
    } catch (err) {
      deps.log(`[bridge] balance query failed: ${String(err)}`);
    }
  }

  /** 索引更新（含 claudeSessionId / 计数 / 费用），失败只记日志 */
  function updateIndex(id: string, patch: Partial<SessionRecord>): void {
    persist(deps.sessions.update(id, patch));
  }

  /**
   * R7-H：本轮结束拍快照（原文件按 UTF-8 文本原样 → `snapshots/<会话id>/<max+1>.jsonl`；
   * 口径见 utils/rewind.ts 的 RewindFs 注：合法 UTF-8 逐字节等价，前导 BOM 会被吞）。
   * 快照面坏了只是「不能回滚」，绝不掀翻这一轮——失败只记日志。
   */
  async function snapshotAfterTurn(
    sessionId: string,
    workspace: string,
  ): Promise<void> {
    const cfg = deps.rewind;
    if (!cfg) {
      return;
    }
    const cli = deps.sessions.get(sessionId)?.claudeSessionId;
    if (!cli) {
      return; // 该轮没拿到 CLI id（异常退出）→ 没有可拍的文件
    }
    try {
      // R8：按会话 id 定位（不再拿 cwd 现推）——符号链接/长路径工作区也能照到真文件
      const found = await locateSessionFile(cfg, workspace, cli, deps.log);
      await snapshotTurn(
        {
          dataDir: cfg.dataDir,
          sessionId,
          claudeSessionId: cli,
          projectDir: found?.projectDir ?? cfg.projectDirFor(workspace),
          sourcePath: found?.path ?? null,
        },
        { fs: cfg.fs },
      );
    } catch (err) {
      deps.log(`[bridge] snapshot failed (${sessionId}): ${String(err)}`);
    }
  }

  /**
   * R4-3：本轮用量的唯一来源判定（**不重复计入**，PLAN-R4 §4）。
   * 判据：CLI 的 result 行 usage 是**整轮汇总**（含该轮全部 API 调用/全部 step，本机实测
   * `num_turns=3` 的 result 行 usage 即三次调用的合计），而 assistantMessage.usage 是
   * **单次调用**的量——两者语义重叠但粒度不同。故：result.usage 有值就用它，绝不再叠加
   * assistant 的；只有 result 没带用量（provider/老 CLI 不报）时才回落到本轮 assistant 累加值。
   * 两者皆无 → null（该轮记 0 用量，UI 不显示「本轮」段）。
   */
  function resolveTurnUsage(
    rt: SessionRuntime,
    event: Extract<TurnEvent, { kind: "result" }>,
  ): UsageStats | null {
    const fromResult = event.usage;
    const turn = fromResult ?? rt.turnUsage;
    rt.turnUsage = null;
    return turn ?? null;
  }

  /**
   * turn 收尾（result 到达）：落旁挂历史两行 + 更新索引（§4.2 result 行 / §4.5）。
   * 历史与索引都写失败也不能抛——该轮已经结束，UI 还等着 sessionList。
   */
  async function finishTurn(
    sessionId: string,
    rt: SessionRuntime,
    event: Extract<TurnEvent, { kind: "result" }>,
    /** R4-3：本轮用量（已在 onTurnEvent 里判定来源）；null = 该轮无用量数据 */
    turnUsage: UsageStats | null,
  ): Promise<void> {
    const userText = rt.pendingUserText;
    const assistantText = rt.assistantText || rt.streamText;
    // R14 修点 3：本轮过程块成品化（截断 + 预算），随后与两行正文一起落盘
    const blocks = finalizeTurnBlocks(rt.turnBlocks);
    // R14：pendingUserText 挪到 appendTurn 之后再清（把「已清内存、未落盘」的窗口收窄；
    // 正挡板在 UI 侧 R-B 的行数键）。其余字段与落盘无关，照旧先清。
    rt.assistantText = "";
    rt.streamText = "";
    rt.curText = "";
    rt.turnBlocks = [];
    try {
      const written = await deps.sessions.appendTurn(
        sessionId,
        userText,
        assistantText,
        blocks,
      );
      const rec = deps.sessions.get(sessionId);
      if (rec) {
        await deps.sessions.update(sessionId, {
          claudeSessionId: event.claudeSessionId || rec.claudeSessionId,
          messageCount: rec.messageCount + written,
          lastCostUsd: event.costUsd,
          updatedAt: deps.now(),
          // R4-3：累计用量与 lastCostUsd 同路径落盘（无用量数据的轮不写，保持「无数据 = 无键」）
          ...(turnUsage ? { usage: addUsage(rec.usage, turnUsage) } : {}),
        });
      }
    } catch (err) {
      deps.log(`[bridge] finishTurn persist failed: ${String(err)}`);
    }
    // R14：落盘（成功或失败）之后再清——inFlightOf 据此判「还有没有在途轮」
    rt.pendingUserText = "";
    await pushSessionList();
  }

  /**
   * 权限卡请求广播（§4.6 宿主→UI 表 permissionRequest）。
   * 字段与契约逐字一致：{requestId, tool, inputSummary, rawInput}——不加 sessionId，
   * 与 streamEvent/error 的会话过滤不同，卡是全局的（多实例同收，先答者生效）。
   */
  function requestPermission(req: PermissionRequestPayload): void {
    deps.log(
      `[bridge] permissionRequest: ${req.tool} (${req.requestId}) → ${registry.size} instance(s)`,
    );
    broadcast({
      type: "permissionRequest",
      requestId: req.requestId,
      tool: req.tool,
      inputSummary: req.inputSummary,
      rawInput: req.rawInput,
    });
  }

  /**
   * 权限卡结算广播（§4.6 permissionResolved）：与 permissionRequest 同为全局消息
   * （卡是广播给多实例的，摘卡也必须全实例一致）。空 id → 忽略 + log（防御非法调用）。
   */
  function permissionSettled(requestId: string): void {
    if (!requestId) {
      deps.log("[bridge] permissionSettled: empty requestId → ignored");
      return;
    }
    deps.log(
      `[bridge] permissionSettled: ${requestId} → ${registry.size} instance(s)`,
    );
    broadcast({ type: "permissionResolved", requestId });
  }

  /**
   * permissionResponse（§4.6）：回写端点（端点据此放行/拒绝 CLI）；allow+remember 时
   * 按 §4.6 确定性算法追加规则串到 session.allowedTools，下一轮 spawn 的 --allowedTools 携带。
   * 未知 requestId → 忽略 + log（过期/重复点击/他实例已答）。
   */
  function handlePermissionResponse(msg: Record<string, unknown>): void {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    if (!requestId) {
      deps.log("[bridge] permissionResponse: missing requestId → ignored");
      return;
    }
    const allow = msg.allow === true;
    const remember = msg.remember === true;
    const resolved = deps.resolvePermission?.(requestId, allow) ?? null;
    if (!resolved) {
      deps.log(
        `[bridge] permissionResponse: unknown/expired requestId → ignored`,
      );
      return;
    }
    deps.log(
      `[bridge] permissionResponse: ${resolved.tool} → ${allow ? "allow" : "deny"}${remember ? "（本会话记住）" : ""}`,
    );
    if (!allow || !remember) {
      return;
    }
    const rec = deps.sessions.get(resolved.sessionId);
    if (!rec) {
      deps.log(
        `[bridge] remember: session gone (${resolved.sessionId}) → skipped`,
      );
      return;
    }
    const rule = buildRememberRule(
      resolved.tool,
      resolved.input,
      rec.permissionMode,
    );
    if (!rule) {
      deps.log(
        `[bridge] remember: no rule for ${resolved.tool}（档位 ${rec.permissionMode} 已默认放行）`,
      );
      return;
    }
    if (rec.allowedTools.includes(rule)) {
      deps.log(`[bridge] remember: rule already present: ${rule}`);
      return;
    }
    deps.log(`[bridge] remember: appended rule ${rule}`);
    updateIndex(resolved.sessionId, {
      allowedTools: [...rec.allowedTools, rule],
    });
  }

  function onTurnEvent(targetSessionId: string, event: TurnEvent): void {
    deps.log(`[bridge] turn event: ${event.kind} (session ${targetSessionId})`);
    broadcast({ type: "streamEvent", sessionId: targetSessionId, event });
    const rt = runtimes.get(targetSessionId);
    if (!rt) return;
    switch (event.kind) {
      case "init":
        // 首轮把 claudeSessionId 落索引，供后续轮 --resume（§4.2 init 行）
        if (event.claudeSessionId) {
          updateIndex(targetSessionId, {
            claudeSessionId: event.claudeSessionId,
          });
        }
        break;
      case "messageStart":
        // R14：新的一条 assistant 消息开始——curText 只装「当前这条」已流出的正文
        rt.curText = "";
        // R17 P7：index 每条消息重新计数 → 正文块的归并键要带上消息序号
        rt.messageSeq += 1;
        break;
      case "assistantMessage":
        // content[] 为权威最终文本；工具轮（无文本块）不覆盖上一段有文本的
        rt.assistantText =
          textOfAssistantMessage(event.content) || rt.assistantText;
        // R14：本条消息已定稿（curText 是它已流出的部分，若随后被中断不再等来校准）
        rt.curText = "";
        // R4-3：逐步累加（result 没带整轮用量时的兜底，见 resolveTurnUsage）
        if (event.usage) {
          rt.turnUsage = addUsage(rt.turnUsage, event.usage);
        }
        break;
      case "textDelta": {
        // assistantMessage 缺失（丢帧）时的兜底文本
        rt.streamText += event.text;
        // R14：当前这条消息的已流出正文（在途轮占位用）
        rt.curText += event.text;
        // R17 P7：同一段正文再攒进「整轮块」——它是切走再切回时的权威占位源
        //（curText 会被 messageStart / assistantMessage 清零，工具轮里恒空）
        const acc = [...rt.turnBlocks]
          .reverse()
          .find(
            (b) =>
              b.kind === "text" &&
              b.index === event.index &&
              b.message === rt.messageSeq,
          );
        if (acc) {
          acc.text += event.text;
        } else {
          rt.turnBlocks.push({
            kind: "text",
            index: event.index,
            message: rt.messageSeq,
            text: event.text,
            toolName: "",
            toolUseId: "",
            inputJson: "",
            result: null,
          });
        }
        break;
      }
      case "thinkingDelta": {
        // R14 修点 3：思考文本攒一份（落盘 → 回放轮的条带）
        const acc = rt.turnBlocks.find(
          (b) => b.kind === "thinking" && b.index === event.index,
        );
        if (acc) {
          acc.text += event.text;
        } else {
          rt.turnBlocks.push({
            kind: "thinking",
            index: event.index,
            message: rt.messageSeq,
            text: event.text,
            toolName: "",
            toolUseId: "",
            inputJson: "",
            result: null,
          });
        }
        break;
      }
      case "toolBlockStart": {
        // R14 修点 3：工具卡三要素（名字 / 入参 / 结果摘要）落盘
        rt.turnBlocks.push({
          kind: "tool",
          index: event.index,
          message: rt.messageSeq,
          text: "",
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          inputJson: "",
          result: null,
        });
        break;
      }
      case "toolInputDelta": {
        // index 每个 messageStart 重新计数 → 归并取最后一个匹中的工具块
        const acc = [...rt.turnBlocks]
          .reverse()
          .find((b) => b.kind === "tool" && b.index === event.index);
        if (acc) {
          acc.inputJson += event.jsonFragment;
        }
        break;
      }
      case "toolResult": {
        const acc = [...rt.turnBlocks]
          .reverse()
          .find((b) => b.kind === "tool" && b.toolUseId === event.toolUseId);
        if (acc) {
          acc.result = { isError: event.isError, summary: event.summary };
        }
        break;
      }
      case "result": {
        // R4-3：先用「索引累计 + 本轮」广播（UI 立即更新），落盘走同一份数据（finishTurn）
        const turn = resolveTurnUsage(rt, event);
        if (turn) {
          const rec = deps.sessions.get(targetSessionId);
          broadcast({
            type: "usageStats",
            sessionId: targetSessionId,
            turn,
            total: addUsage(rec?.usage, turn),
          });
        }
        void finishTurn(targetSessionId, rt, event, turn);
        break;
      }
      case "resultError": {
        // 复查修-4：失败轮（重试耗尽的 API 错误等）不会再等来 result 行——本轮用量就此收尾清掉。
        // 不清的话，下一轮若 result 不带 usage（老 CLI/provider 不报），resolveTurnUsage 会把
        // 这个失败轮累加进来的用量错并进下一轮（张冠李戴）。
        rt.turnUsage = null;
        break;
      }
      case "procError": {
        // 复查修-4：同 resultError——该轮以进程错误收场，累计用量属于这一轮，不得漏给下一轮
        rt.turnUsage = null;
        // 命令组装失败（ARG_HAS_NEWLINE / ARG_HAS_PERCENT / ARG_BREAKS_QUOTING / CMD_LINE_TOO_LONG）带 reason 直落日志：
        // 用户报障时凭这条定位「CLI 进程异常退出」的真实原因（§2.10 B）
        if (event.reason) {
          deps.log(
            `[bridge] procError reason=${event.reason} session=${targetSessionId}`,
          );
        }
        // resume 失效判定（§4.2 procError 行 / §4.6 错误码表）：UI 给「新建会话」按钮
        const kind = classifyProcError({
          exitCode: event.exitCode,
          stderrTail: event.stderrTail ?? "",
          reason: event.reason,
        });
        if (kind === "CLAUDE_NOT_FOUND") {
          // R15 F6：缓存的可执行文件没了（被卸载/换包/优化软件清理）→ 丢缓存，
          // 下一轮 send 重新枚举候选（装了别的 claude 也能自动接上）
          deps.log(
            "[bridge] procError classified CLAUDE_NOT_FOUND → drop resolve cache",
          );
          deps.invalidateCliResolve?.();
        }
        if (kind === "SESSION_GONE") {
          deps.log("[bridge] procError classified SESSION_GONE");
          broadcast({
            type: "error",
            code: "SESSION_GONE",
            message:
              "续接失败：CLI 侧会话已不存在（--resume 失效），请新建会话",
            sessionId: targetSessionId,
          });
          // BUG-25：死 id 必须清出索引——否则同会话再发仍拼 --resume，永远复读同一错误。
          // 清 id 后本轮就是首轮语义（CLI 侧起新会话），不必强迫用户新建会话。
          // 用 update 的 promise 串列表广播：列表要反映清除后的 claudeSessionId。
          void deps.sessions
            .update(targetSessionId, { claudeSessionId: null })
            .catch((err: unknown) => {
              deps.log(
                `[bridge] clear stale claudeSessionId failed (${targetSessionId}): ${String(err)}`,
              );
            })
            .then(() => pushSessionList());
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 安全修：本窗口的一次性附件凭据表（**路径只活在宿主内存**）。
   * 页面拿到的是 token，永远拿不到路径；token 登记 = 宿主原生选择器选中文件时，
   * 或宿主自己落盘一个附件后（供编辑重发）。用后即弃：解析一次即删；窗口注销清空；
   * 桥实例销毁（插件停用）随闭包一起消失。
   * ponytail：就是一个 Map + 随机串；需要配额/过期再说（现在登记全是用户自己选的文件）。
   */
  const attachmentTokens = new Map<
    UiWindowKey,
    Map<string, { path: string; name: string; sizeBytes: number }>
  >();

  function tokenBucket(
    win: UiWindowKey,
  ): Map<string, { path: string; name: string; sizeBytes: number }> {
    let bucket = attachmentTokens.get(win);
    if (!bucket) {
      bucket = new Map();
      attachmentTokens.set(win, bucket);
    }
    return bucket;
  }

  /** 凭据串（CSPRNG 缺失 → null：fail-closed，宁可不选文件也不发可猜的凭据） */
  function newAttachmentToken(): string | null {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== "function") {
      return null;
    }
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** 登记一枚凭据（生成失败 → null，调用方按「这条不给」处理） */
  function registerAttachment(
    win: UiWindowKey,
    file: { path: string; name: string; sizeBytes: number },
  ): string | null {
    const token = newAttachmentToken();
    if (!token) {
      deps.log("[bridge] attachment token unavailable (no CSPRNG)");
      return null;
    }
    tokenBucket(win).set(token, file);
    return token;
  }

  /**
   * 安全修：`pickAttachments` —— 宿主在**发起消息的那个窗口**弹原生选择器。
   * 路径登记进本窗口的一次性凭据表，页面只拿 token（菜单/协议里没有路径这一项）。
   */
  async function handlePickAttachments(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.pickFiles) {
      deps.log("[bridge] pickAttachments: host picker not wired → empty");
      sendTo(win, { type: "attachmentsPicked", files: [] });
      return;
    }
    const multiple = msg.multiple !== false; // 缺省多选（选择器默认行为即可用）
    let picked: PickedFile[] = [];
    try {
      picked = await deps.pickFiles(win, { multiple });
    } catch (err) {
      deps.log(`[bridge] pickAttachments failed: ${String(err)}`);
      sendTo(win, { type: "attachmentsPicked", files: [] });
      return;
    }
    const files: { token: string; name: string; sizeBytes: number }[] = [];
    for (const file of picked) {
      const name = sanitizeAttachmentName(file.name);
      const token = registerAttachment(win, {
        path: file.path,
        name,
        sizeBytes: file.sizeBytes,
      });
      if (token) {
        files.push({ token, name, sizeBytes: file.sizeBytes });
      }
    }
    deps.log(`[bridge] pickAttachments: ${files.length} file(s) registered`);
    sendTo(win, { type: "attachmentsPicked", files });
  }

  /**
   * R7-J：附件载荷白名单化（安全修后**只认** { name, sizeBytes, base64, token }）。
   * **客户端给的任何路径字段（sourcePath 等）一律读都不读**——宿主不接受客户端路径，
   * 路径只能来自本窗口的凭据表（宿主选择器登记）。名字在这里先净化（落盘时还会再净化
   * 一次），非法项原样留着让 UI 收到人话拒绝原因。条数上限由 saveAttachments 判——这里
   * 只做一个防御性上界，免得坏 UI 塞十万条进来。
   */
  const ATTACHMENT_PAYLOAD_MAX = 50;
  type AttachmentRequest = {
    name: string;
    sizeBytes: number;
    base64?: string;
    token?: string;
  };
  function normalizeAttachments(raw: unknown): AttachmentRequest[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.slice(0, ATTACHMENT_PAYLOAD_MAX).map((item) => {
      const f = (item ?? {}) as Record<string, unknown>;
      const name =
        typeof f.name === "string" && f.name
          ? sanitizeAttachmentName(f.name)
          : "";
      const sizeBytes =
        typeof f.sizeBytes === "number" && Number.isFinite(f.sizeBytes)
          ? f.sizeBytes
          : 0;
      const base64 =
        typeof f.base64 === "string" && f.base64 ? f.base64 : undefined;
      const token =
        typeof f.token === "string" && f.token ? f.token : undefined;
      return { name, sizeBytes, base64, token };
    });
  }

  /**
   * 安全修：把载荷里的 token 换成宿主侧的路径（**唯一**的路径来源）。
   * - 命中 → 消费（用后即弃）+ 名字/体积以登记记录为准（客户端字段只作展示）；
   * - 未知/已用 → 该条按拒绝处理并记日志；
   * - 没有 token 的条目只能靠 base64 字节；两者都没有（例如客户端塞了个 sourcePath 想抄近路）
   *   → 拒绝该条并给可读原因。
   */
  function resolveAttachments(
    win: UiWindowKey,
    reqs: AttachmentRequest[],
  ): { files: AttachmentInput[]; rejected: RejectedAttachment[] } {
    const bucket = attachmentTokens.get(win);
    const files: AttachmentInput[] = [];
    const rejected: RejectedAttachment[] = [];
    for (const req of reqs) {
      if (req.token) {
        const rec = bucket?.get(req.token);
        if (!rec) {
          deps.log(
            `[bridge] attachment token rejected (unknown/used): name=${req.name || "?"}`,
          );
          rejected.push({
            name: req.name || "附件",
            reason: "附件凭据无效或已被使用，请重新点「📎 附件」选择文件",
          });
          continue;
        }
        bucket?.delete(req.token); // 一次性：换出路径即作废
        files.push({
          name: rec.name,
          sizeBytes: rec.sizeBytes,
          sourcePath: rec.path,
        });
        continue;
      }
      if (req.base64) {
        files.push({
          name: req.name,
          sizeBytes: req.sizeBytes,
          base64: req.base64,
        });
        continue;
      }
      deps.log(
        `[bridge] attachment rejected (no token & no bytes): name=${req.name || "?"}`,
      );
      rejected.push({
        name: req.name || "附件",
        reason:
          "附件缺少内容（宿主不接受客户端路径；请用「📎 附件」选择或直接粘贴）",
      });
    }
    return { files, rejected };
  }

  /** R7-J：该会话已发生的用户轮数 = 本轮附件的轮序号（落点 `<cwd>/attachments/<id>/<turn>`） */
  async function nextAttachmentTurn(sessionId: string): Promise<number> {
    try {
      const rows = await deps.sessions.readHistory(sessionId);
      return rows.filter((r) => r.role === "user").length;
    } catch (err) {
      deps.log(`[bridge] attachment turn count failed: ${String(err)}`);
      return 0;
    }
  }

  /** send 的消息目标会话：显式 id 优先，缺省取最近活动的一条 */
  function resolveSendTarget(rawId: unknown): SessionRecord | null | "gone" {
    if (typeof rawId === "string" && rawId) {
      return deps.sessions.get(rawId) ?? "gone";
    }
    return deps.sessions.mostRecent();
  }

  async function handleSend(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const text = msg.text;
    if (typeof text !== "string" || !text.trim()) {
      deps.log("[bridge] send: blank/non-string text → ignored");
      return;
    }
    let record = resolveSendTarget(msg.sessionId);
    /**
     * R17 P8：本轮是否需要重推会话列表（**只在列表内容真的变了才推**）。
     * 为什么不能每次 send 都推：`sessionListMessage()` 对**每条**会话都要一次 `readSnapshotIndex`
     * （逐条读盘）+ 每个 itemKey 一次 `lookupItem`，再整包广播给所有实例、页面整份重归约 ——
     * 每次 send 无条件推会与 P2 省下的那次整文件读直接对冲，还把 send 卡在列表构建上。
     * 置位点（写死）：created（新建会话）/ 标题首写 / itemKey·libraryID·attachmentKey 变更 /
     * 两处早退兜底（推送点见下方）。`finishTurn` 那处不参与标志（messageCount/用量每轮都变）。
     */
    let listDirty = false;
    if (record === "gone") {
      // UI 拿着一个不存在的会话（他处已删）：按 §4.6 失效语义处理，并推列表让 UI 重新绑定
      const staleId = String(msg.sessionId);
      deps.log(`[bridge] send: unknown session ${staleId} → SESSION_GONE`);
      sendTo(win, {
        type: "error",
        code: "SESSION_GONE",
        message: "会话不存在（可能已被删除），请新建会话",
        sessionId: staleId,
      });
      await pushSessionList();
      return;
    }
    if (!record) {
      // 无任何会话（首次使用）：本轮起一条（§4.6 createSession 的隐式形态）
      record = await deps.sessions.create({
        title: text.slice(0, SESSION_TITLE_MAX),
      });
      // R17 P8：这里**不再**立刻推列表——那一刻归属（itemKey）还没落定，推出去的载荷里
      // itemKey=null ⇒ 页面「未绑定 → 绑全量最新」会绑到别的文献的会话。只置脏，推送点后移到
      // 本函数里「归属落定」之后（见下方 `listDirty` 的消费点）。
      deps.log(`[bridge] session auto-created: ${record.id}`);
      listDirty = true;
    } else if (!record.title) {
      // 标题首写（会话首次有名字）→ 列表上的显示会变 → 置脏
      record =
        (await deps.sessions.update(record.id, {
          title: text.slice(0, SESSION_TITLE_MAX),
        })) ?? record;
      listDirty = true;
    }
    const sessionId = record.id;

    // 并发契约：该会话有进行中 turn → SESSION_BUSY，不排队（§4.6）
    const rt = runtimeFor(sessionId);
    if (rt.busy) {
      deps.log(`[bridge] send rejected: session busy (${rt.busy})`);
      sendTo(win, {
        type: "error",
        code: "SESSION_BUSY",
        message: "进行中的 turn 未结束",
        sessionId,
      });
      return;
    }

    rt.busy = "running";
    rt.pendingUserText = text;
    rt.assistantText = "";
    rt.streamText = "";
    rt.curText = "";
    rt.baseRows = deps.sessions.get(sessionId)?.messageCount ?? 0;
    rt.turnBlocks = [];
    rt.messageSeq = 0;
    // R14 修点 4 / R17 P2：开轮那一刻广播一次 history（带 inFlight）——同一会话绑在多个页面上时，
    // 非发送方实例 sessionId 不变、永远不拉历史，靠这条把「在途轮」送达。一轮一次（busy="running"
    // 全仓唯一写入点就是上面那行）。
    // R17 P2 收紧内容口径：`messages` **恒为 []**，不再读盘夹带历史行——能应用这条广播的实例
    // 必然 `state.sessionId === msg.sessionId`，而绑定那一刻必发 `getHistory`（main.ts），
    // 那份回执才是历史同步的唯一载体（本地视图为空的档靠它补齐）。
    // 顺带省掉每次 send 的一次整文件读 + 逐行 JSON.parse。
    // 同步只读（inFlightOf 只碰 runtimes；broadcast 逐实例自带死实例兜底），不需要 try/catch。
    const f = inFlightOf(sessionId);
    broadcast({
      type: "history",
      sessionId,
      messages: [],
      ...(f ? { inFlight: f } : {}),
    });
    /** 本轮端点凭据：spawn 失败/进程退出都要撤销（§4.8 token 随该轮作废） */
    let mcp: { port: number; token: string } | null = null;
    /** 本轮附件目录写保护文件（spawn 失败/进程退出都要清理） */
    let denySettings: string | null = null;
    /** 本轮 mcp-config 文件（同上；null = 写失败走内联 JSON，无文件可清） */
    let mcpConfigPath: string | null = null;
    try {
      // 先取本轮上下文再算工作区：collection 模式要 itemKey 才能判定合集（顺序对调，
      // 只影响两类失败同时发生时报哪个错误，二者都在同一个 catch 里）
      // R7-B：chips 的 itemKey（已在 normalizeRefKeys 里白名单化 + 截断到 20）
      const refKeys = normalizeRefKeys(msg.refs);
      // R7-D：范围注入（白名单化 + 截断到 40；null = 本轮没有范围 chip）
      const scopeInject = normalizeScopeInject(msg.scope);
      // R7-J：本轮附件（安全修：载荷里只有 token/base64，**路径一律由宿主查表**）——
      // 落盘在 buildTurnPrompt 里做（落点要 cwd，而 cwd 由 itemKey 现算：collection 模式下
      // = 合集目录，所以附件永远落在 spawn cwd 内 → CLI 天然可读，不需要额外 --add-dir）
      const attachReqs = normalizeAttachments(msg.attachments);
      const attach = resolveAttachments(win, attachReqs);
      const attachFiles = attach.files;
      const attachTurn =
        attachFiles.length > 0 ? await nextAttachmentTurn(sessionId) : 0;
      const input = await deps.buildTurnPrompt(
        text,
        refKeys,
        scopeInject,
        attachFiles.length > 0
          ? { files: attachFiles, sessionId, turn: attachTurn }
          : null,
      );
      // R17 P8：会话归属（条目绑定）**在下面任何早退之前**落定（§2.4 条目分组：随本轮上下文刷新，
      // 切文献后续接旧会话时更新为当前条目）。为什么必须提前：`latestSessionFor` / `followReader`
      // 的闸门都是「itemKey 精确匹配」，而 `itemKey` 一旦没写进去，这条会话永远跟不过去
      //（用户报的「切到 B 侧栏还是 A 的会话」）。修前它排在 `!base.command` 早退与 spawn 失败
      // 之后 ⇒ 那两条路径上的会话永久停在无归属。
      // 只在 lookupItem 返回真值时写（取不到条目不猜、不写空串，T-P8-d 锁）；写失败只记日志。
      if (
        input.itemKey &&
        (record.itemKey !== input.itemKey ||
          record.attachmentKey !== input.attachmentKey)
      ) {
        const info = await deps.lookupItem(input.itemKey);
        if (info) {
          record =
            (await deps.sessions.update(sessionId, {
              itemKey: input.itemKey,
              itemLibraryID: info.libraryID,
              attachmentKey: input.attachmentKey,
            })) ?? record;
          listDirty = true; // 归属（条目分组）变了 → 列表上的分组/标题要跟着变
        }
      }
      // 归属落定 → 只有列表真变了才推（自动建会话那条推送点就落在这里）：
      // 「包含该新会话的那条 sessionList」推送那一刻 itemKey 必须已就位
      if (listDirty) {
        await pushSessionList();
      }
      // 落盘回执（UI 据此把绝对路径存进该条消息、把被拒的标出来）——回执失败不影响这一轮。
      // 已落盘的文件**再登记一枚一次性凭据**回给 UI：编辑重发时 UI 只回传它（路径不回传）。
      const saved = (input.attachmentSaved?.saved ?? []).map((s) => {
        const token = registerAttachment(win, {
          path: s.path,
          name: s.name,
          sizeBytes: s.size,
        });
        return token ? { ...s, token } : s;
      });
      const rejected = [
        ...attach.rejected,
        ...(input.attachmentSaved?.rejected ?? []),
      ];
      if (
        attachReqs.length > 0 &&
        (input.attachmentSaved || attach.rejected.length > 0)
      ) {
        sendTo(win, {
          type: "attachmentSaved",
          sessionId,
          turn: attachTurn,
          saved,
          rejected,
        });
      }
      const workspace = await deps.ensureWorkspace(input.itemKey);
      const base = await deps.getSpawnBase();
      // R15 F6：解析不到 → 丢掉缓存（可能正是「装在了缓存生成之后」；下次 send 立刻重解析，
      // 不必重启 Zotero）
      if (!base.command) {
        deps.invalidateCliResolve?.();
      }
      if (!base.command) {
        rt.busy = null;
        sendTo(win, {
          type: "error",
          code: "CLAUDE_NOT_FOUND",
          message: "claude CLI 未找到，请安装或在设置中指定 cliPathOverride",
          sessionId,
        });
        // R17 P8：早退兜底推一次——自动建会话/标题首写这一刻还没推过（上面的推送点在本行之后），
        // 不推的话 UI 连「刚建的那条会话」都看不到（会话已建出并已落定归属，如实推）。
        await pushSessionList();
        return;
      }
      // R17 P8：会话绑定条目（§2.4 条目分组）的写入点已前移到 buildTurnPrompt 之后
      //（见上方注释：早退路径也要先落定归属，否则那些会话永远被 latestSessionFor 拒之门外）
      // 端点故障（起监听失败/端口占用）→ 抛出 → 下方 catch 回 SPAWN_FAILED，该轮不 spawn（§4.8）
      mcp = await deps.getMcpEndpoint(sessionId);
      // 一次性 token 不进 argv：写 0600 临时文件传路径；写失败 → null → 回落内联 JSON（可用性优先）
      mcpConfigPath =
        (await deps.prepareMcpConfig?.(mcp.port, mcp.token)) ?? null;
      // 附件目录写保护（acceptEdits 档 Write/Edit 免卡 → 用 settings deny 硬挡）：写失败 → 抛出
      // → 同样走 SPAWN_FAILED，不带一个未受保护的 --add-dir 跑。
      // R7-B：扩权到引用条目目录时，deny 必须同步覆盖**每一个**目录（安全红线）——
      // 故这里传目录集，实现侧逐目录生成规则（cliRunner.buildAttachmentDenySettings）。
      const denyDirs = input.addDirs?.length
        ? input.addDirs
        : input.addDir
          ? [input.addDir]
          : null;
      denySettings = (await deps.prepareDenySettings?.(denyDirs)) ?? null;
      // R7-H（H1）：会话开始前先拍 0.jsonl（空内容）——「编辑第一条消息」要靠它回到空历史。
      // 只在「从未拍过」时拍（失败重发不重复占号，否则轮号会与消息号错位）；拍不到不拦这一轮。
      if (deps.rewind && !record.claudeSessionId && !record.forkFrom) {
        const existing = await readSnapshotIndex(
          { dataDir: deps.rewind.dataDir, sessionId },
          { fs: deps.rewind.fs },
        );
        if (!existing) {
          try {
            await snapshotTurn(
              {
                dataDir: deps.rewind.dataDir,
                sessionId,
                claudeSessionId: null,
                projectDir: deps.rewind.projectDirFor(workspace),
                sourcePath: null,
              },
              { fs: deps.rewind.fs },
            );
          } catch (err) {
            deps.log(
              `[bridge] first-turn snapshot failed (${sessionId}): ${String(err)}`,
            );
          }
        }
      }

      // R7-I：分支会话的首轮 = 真回滚分叉（父会话截断 → `--resume 父 --fork-session` → 立刻还原）。
      // 本轮 prompt（编辑路径 = 编辑后的文本）就是分叉会话的第一轮，不额外烧一轮空对话。
      // turn 0 不是分叉点（空历史，见 createBranch）：新会话一律不带 forkFrom；老版本残留的
      // turn 0 记录也按普通首轮处理（不去 resume 空会话文件，不进回滚编排）
      const fork =
        record.forkFrom && record.forkFrom.turn > 0 ? record.forkFrom : null;
      const forkParent = fork ? deps.sessions.get(fork.sessionId) : null;
      const forkParentCli = forkParent?.claudeSessionId ?? null;
      const forkReady = Boolean(
        fork && deps.rewind && forkParent && forkParentCli,
      );
      if (fork && !forkReady) {
        deps.log(`[bridge] branch ${sessionId}: parent/rewind unavailable`);
        rt.busy = null;
        rt.turn = null;
        if (mcp) {
          deps.closeMcpTurn?.(mcp.token);
        }
        cleanupTurnFile(mcpConfigPath, deps.cleanupMcpConfig, "mcp config");
        cleanupTurnFile(
          denySettings,
          deps.cleanupDenySettings,
          "deny settings",
        );
        sendTo(win, {
          type: "error",
          code: "BRANCH_UNAVAILABLE",
          message: "分支会话无法启动：父会话已不可回滚（父被删或宿主未接线）",
          sessionId,
        });
        return;
      }

      // R17 P9：旧数据过滤——会话里可能存着修前记住的不安全规则（首词带 `"&…&"` 等，会在 win32
      // cmd 通道被当命令执行）。进 argv 前按**同一个**判定函数过滤（与生成器同源，不写第二份）。
      // 不回写索引：旧规则留在磁盘上保持惰性、每轮在这里被挡掉；只在确有丢弃时记一条日志。
      const safeTools = record.allowedTools.filter(isSafeRememberRule);
      if (safeTools.length !== record.allowedTools.length) {
        deps.log(
          `[bridge] allowedTools: dropped ${record.allowedTools.length - safeTools.length} unsafe rule(s) (session ${sessionId})`,
        );
      }
      const args = buildSpawnArgs({
        permissionMode: record.permissionMode,
        mcpPort: mcp.port,
        mcpToken: mcp.token,
        mcpConfigPath,
        // 分叉：resume 父会话并让 CLI 另开新 id；普通轮照旧 resume 自己的 id
        resumeClaudeSessionId: forkReady
          ? forkParentCli
          : record.claudeSessionId,
        forkSession: forkReady,
        addDir: input.addDir,
        addDirs: input.addDirs,
        settingsPath: denySettings,
        allowedTools: safeTools, // remember 规则串由 M6 写入索引（R17 P9：已过安全判定）
      });
      deps.log(
        `[bridge] spawning turn: session=${sessionId} resume=${(forkReady ? forkParentCli : record.claudeSessionId) ?? "none"} fork=${forkReady} addDir=${(denyDirs ?? ["none"]).join(",")} denySettings=${denySettings ?? "none"} mcpConfig=${mcpConfigPath ?? "inline"} cwd=${workspace}`,
      );

      // 分叉首轮的 init 等待器：init 到达 = CLI 已读过被截断的文件 → 可以还原原文件了
      let forkInit: {
        promise: Promise<{ newClaudeSessionId: string }>;
        resolve(id: string): void;
        reject(err: Error): void;
      } | null = null;
      if (forkReady) {
        let resolveFn!: (v: { newClaudeSessionId: string }) => void;
        let rejectFn!: (e: Error) => void;
        const promise = new Promise<{ newClaudeSessionId: string }>(
          (resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          },
        );
        const waiter = {
          promise,
          resolve: (id: string) => resolveFn({ newClaudeSessionId: id }),
          reject: (err: Error) => rejectFn(err),
        };
        const timer = setTimeout(() => {
          waiter.reject(new Error("分叉进程 60s 内未发出 init"));
          rt.turn?.kill();
        }, 60_000);
        void promise.catch(() => undefined).then(() => clearTimeout(timer));
        forkInit = waiter;
      }

      let sawResult = false;
      const command = base.command;
      const startTurn = (spawnArgs: string[], workdir: string): TurnHandle => {
        const spawnAt = Date.now(); // R17 P3：进程 spawn 的同步点耗时（超阈值才记）
        const handle = deps.spawnTurn({
          command,
          channel: base.channel, // win32 .cmd 壳的 cmd.exe 包装由 spawnTurn 内统一组装（§2.10 B）
          cmdExePath: base.cmdExe || undefined, // 空 = 未提供，走 resolveCmdExePath 兜底
          args: spawnArgs,
          workdir,
          environment: base.environment,
          environmentAppend: base.environmentAppend,
          prompt: input.prompt,
          onEvent: (event) => {
            if (event.kind === "result") {
              sawResult = true;
            }
            if (event.kind === "init" && event.claudeSessionId) {
              forkInit?.resolve(event.claudeSessionId);
            }
            onTurnEvent(sessionId, event);
          },
          logger: (m) => deps.log(m),
        });
        logSlow("spawn", spawnAt);
        return handle;
      };
      let turn: TurnHandle | null = null;
      // 解锁时点 = 进程退出（收到 result 也要等进程退出，§4.6 并发契约）；
      // 同刻撤销端点 token（§4.8：token 只活在「该轮 spawn 参数 + 端点内存」里）+ 拍本轮快照
      const turnToken = mcp ? mcp.token : null;
      const bindExit = (handle: TurnHandle): void => {
        rt.turn = handle;
        void handle.exitPromise.then(() => {
          if (turnToken) {
            deps.closeMcpTurn?.(turnToken);
          }
          cleanupTurnFile(mcpConfigPath, deps.cleanupMcpConfig, "mcp config");
          cleanupTurnFile(
            denySettings,
            deps.cleanupDenySettings,
            "deny settings",
          );
          forkInit?.reject(new Error("分叉进程在 init 前退出"));
          if (rt.turn === handle) {
            deps.log("[bridge] turn exit: session unlocked");
            rt.busy = null;
            rt.turn = null;
          }
          if (sawResult) {
            // R7-H：每轮（成功）结束拍快照。此刻 CLI 自己的 jsonl 已写完（进程退出）。
            // 先等索引写队列落定（init 的 claudeSessionId 可能还在队列里），否则会因
            // 「还没有 CLI id」被跳过——快照是回滚的唯一依据，不能这样漏。
            void deps.sessions
              .flush()
              .catch(() => undefined)
              .then(() => snapshotAfterTurn(sessionId, workspace));
          }
        });
      };

      if (forkReady && deps.rewind && fork && forkParentCli) {
        const cfg = deps.rewind;
        // R8：源文件与实际项目目录都由「按会话 id 定位」给（闸门比对的是*实际命中的目录*，
        // 不再拿 cwd 现推——符号链接/长路径下推出来的目录名跟 CLI 的落点根本不是同一个）
        const located = await locateSessionFile(
          cfg,
          workspace,
          forkParentCli,
          deps.log,
        );
        const result: RewindResult = located
          ? await rewindToTurn(
              {
                dataDir: cfg.dataDir,
                sessionId: fork!.sessionId,
                claudeSessionId: forkParentCli,
                turn: fork!.turn,
                projectDir: located.projectDir,
                sourcePath: located.path,
                cwd: workspace,
              },
              {
                fs: cfg.fs,
                platform: cfg.platform,
                log: (m) => deps.log(`[bridge] ${m}`),
                runner: {
                  fork: async ({ cwd }) => {
                    turn = startTurn(args, cwd || workspace);
                    bindExit(turn);
                    return await forkInit!.promise;
                  },
                },
              },
            )
          : {
              ok: false,
              reason: "SOURCE_MISSING",
              error:
                "找不到该会话的 CLI 会话文件（已按会话 id 扫 projects 目录），不可分支/编辑",
            };
        if (!result.ok) {
          deps.log(
            `[bridge] rewind refused/failed (${result.reason}): ${result.error ?? ""}`,
          );
          if (!turn) {
            // 分叉还没起来（拒绝路径）：本轮不算跑过，会话留在「待分叉」态可重试
            rt.busy = null;
            rt.turn = null;
            if (mcp) {
              deps.closeMcpTurn?.(mcp.token);
            }
            cleanupTurnFile(mcpConfigPath, deps.cleanupMcpConfig, "mcp config");
            cleanupTurnFile(
              denySettings,
              deps.cleanupDenySettings,
              "deny settings",
            );
          }
          sendTo(win, {
            type: "error",
            code: rewindErrorCode(result.reason),
            message: result.error ?? "回滚失败",
            sessionId,
          });
          return;
        }
        deps.log(
          `[bridge] branch forked: ${sessionId} ← ${fork!.sessionId}@${fork!.turn} → ${result.claudeSessionId}`,
        );
        record =
          (await deps.sessions.update(sessionId, {
            claudeSessionId: result.claudeSessionId,
            forkFrom: null,
          })) ?? record;
      } else {
        turn = startTurn(args, workspace);
        bindExit(turn);
      }
    } catch (err) {
      const code =
        (err as { code?: string } | null)?.code === "WORKSPACE_UNAVAILABLE"
          ? "WORKSPACE_UNAVAILABLE"
          : "SPAWN_FAILED";
      deps.log(`[bridge] send failed (${code}): ${String(err)}`);
      // 已开出的端点 token 一并撤销（没 spawn 出去，凭据不该留在内存里）
      if (mcp) {
        deps.closeMcpTurn?.(mcp.token);
      }
      cleanupTurnFile(mcpConfigPath, deps.cleanupMcpConfig, "mcp config");
      cleanupTurnFile(denySettings, deps.cleanupDenySettings, "deny settings");
      rt.busy = null;
      rt.turn = null;
      sendTo(win, { type: "error", code, message: String(err), sessionId });
      // R17 P8：早退也要推一次列表——极端情况下（buildTurnPrompt 抛出）归属那一推还没走到，
      // 不推的话 UI 连「刚建的那条会话」都看不到（会话本身已建出，如实推、不留悬挂）。
      await pushSessionList();
    }
  }

  /** 中断目标：显式 id 优先；缺省取当前唯一在跑的 turn（BUG-17 的 M5 形态） */
  function resolveInterruptTarget(
    rawId: unknown,
  ): { id: string; rt: SessionRuntime } | null {
    if (typeof rawId === "string" && rawId) {
      const rt = runtimes.get(rawId);
      return rt ? { id: rawId, rt } : null;
    }
    for (const [id, rt] of runtimes) {
      if (rt.busy === "running") {
        return { id, rt };
      }
    }
    return null;
  }

  function handleInterrupt(msg: Record<string, unknown>): void {
    const target = resolveInterruptTarget(msg.sessionId);
    if (!target || target.rt.busy !== "running" || !target.rt.turn) {
      deps.log("[bridge] interrupt: no running turn → ignored");
      return;
    }
    target.rt.busy = "interrupting";
    deps.log(`[bridge] interrupt: killing turn for session ${target.id}`);
    target.rt.turn.kill();
  }

  /**
   * 父会话的第一条用户消息原文（turn 0「从这条重放」的文本来源）。历史空 / 读不到 → null
   *（调用方显式报错，不拿空文本凑合发一轮）。
   */
  async function firstUserMessageText(
    sessionId: string,
  ): Promise<string | null> {
    const records = await deps.sessions.readHistory(sessionId);
    const first = (Array.isArray(records) ? records : []).find(
      (r) => r.role === "user" && typeof r.text === "string" && r.text.trim(),
    );
    return first ? first.text : null;
  }

  /**
   * 建分支会话记录（标题/编号/父指向）+ 回执 + 刷列表。forkFrom = null = 全新 CLI 会话
   *（turn 0 的重放路径），非 null = 「待分叉」（turn ≥ 1 的真回滚路径，分叉在首轮 spawn）。
   */
  async function openBranchSession(
    win: UiWindowKey,
    parent: SessionRecord,
    forkFrom: { sessionId: string; turn: number } | null,
  ): Promise<SessionRecord> {
    const plan = planBranch({
      parent: { id: parent.id, title: parent.title || "会话" },
      sessions: deps.sessions.list(),
    });
    const branch = await deps.sessions.create({
      title: plan.title,
      itemKey: parent.itemKey,
      itemLibraryID: parent.itemLibraryID,
      attachmentKey: parent.attachmentKey,
      permissionMode: parent.permissionMode,
      parentId: plan.parentId,
      branchIndex: plan.branchIndex,
      ...(forkFrom ? { forkFrom } : {}),
    });
    deps.log(
      forkFrom
        ? `[bridge] branch created: ${branch.id} ← ${parent.id}@${forkFrom.turn} (${plan.title})`
        : `[bridge] replay branch: ${branch.id} ← ${parent.id}@0（空历史，零回滚编排）`,
    );
    sendTo(win, {
      type: "branchCreated",
      sessionId: branch.id,
      parentId: plan.parentId,
      branchIndex: plan.branchIndex,
      title: plan.title,
    });
    await pushSessionList();
    return branch;
  }

  /**
   * R7-I：建一个「待分叉」的分支会话（真正分叉发生在它的首轮 spawn，见 handleSend——
   * 那时才有用户的下一条消息可当分叉首轮 prompt，不烧空对话）。
   * 目标轮没有快照 / 父没有 CLI id / 宿主未接线 → 回 error，不建会话（不降级成假回滚）。
   * editedText 非 null = 「编辑重发」：建完分支立刻把编辑后的文本发进去。
   */
  async function createBranch(
    win: UiWindowKey,
    parent: SessionRecord,
    rawTurn: unknown,
    editedText: string | null,
    /** R7-J：编辑态增删后的附件（null = 编辑路径没带附件；路径只由宿主按 token 查表换） */
    editedAttachments?: AttachmentRequest[] | null,
  ): Promise<void> {
    const cfg = deps.rewind;
    if (!cfg) {
      sendTo(win, {
        type: "error",
        code: "BRANCH_UNAVAILABLE",
        message: "宿主未接线真回滚，无法分支/编辑重发",
        sessionId: parent.id,
      });
      return;
    }
    const turn =
      typeof rawTurn === "number" && Number.isInteger(rawTurn) && rawTurn >= 0
        ? rawTurn
        : null;
    if (turn === null) {
      deps.log(`[bridge] branch: bad turn ${String(rawTurn)} → ignored`);
      return;
    }
    // turn 0 = 空历史（会话开始**之前**）：CLI 无法 resume 空会话文件（分叉进程在 init 前退出），
    // 而且这里本来就没有历史可分叉 → 完全绕开回滚编排（零 journal / 零文件替换 / 零 fork）：
    // 新建一个**全新会话**（forkFrom = null → 普通首轮 spawn），首轮文本 = 编辑后的文本
    //（编辑路径）/ 该条原文（分支路径）；原会话原封不动保留。
    if (turn === 0) {
      const text = editedText ?? (await firstUserMessageText(parent.id));
      if (text === null || !text.trim()) {
        deps.log(
          `[bridge] turn 0 replay refused: first message text of ${parent.id} unreadable`,
        );
        sendTo(win, {
          type: "error",
          code: "REWIND_REFUSED",
          message: "读不到第一条消息原文，不能从这条重放",
          sessionId: parent.id,
        });
        return;
      }
      const fresh = await openBranchSession(win, parent, null);
      // 编辑重发：首轮 prompt = 编辑后的文本；分支：首轮 prompt = 该条原文
      // R7-J：编辑态增删后的附件集合一并带上（旧附件文件不删——历史消息还引用它）
      await handleSend(win, {
        sessionId: fresh.id,
        text,
        attachments: editedAttachments ?? undefined,
      });
      return;
    }
    const cli = parent.claudeSessionId;
    const index = cli
      ? await readSnapshotIndex(
          { dataDir: cfg.dataDir, sessionId: parent.id },
          { fs: cfg.fs },
        )
      : null;
    const entry = index?.snapshots.find((s) => s.turn === turn);
    if (!cli || !entry) {
      deps.log(`[bridge] branch refused: no snapshot for turn ${turn}`);
      sendTo(win, {
        type: "error",
        code: "REWIND_REFUSED",
        message: `第 ${turn} 轮没有可用快照，不能分支/编辑（老会话或快照被清理过）`,
        sessionId: parent.id,
      });
      return;
    }
    const branch = await openBranchSession(win, parent, {
      sessionId: parent.id,
      turn,
    });
    // 分支的 0.jsonl = 父的第 turn 轮快照（分叉继承到的起点）——分支里「编辑第一条消息」
    // 靠它回到该起点；此后分支自己的快照从 1 起，H3 映射与普通会话一致
    try {
      await snapshotTurn(
        {
          dataDir: cfg.dataDir,
          sessionId: branch.id,
          claudeSessionId: null,
          projectDir: entry.projectDir,
          sourcePath: snapshotPath(cfg.dataDir, parent.id, turn, cfg.fs.join),
        },
        { fs: cfg.fs },
      );
    } catch (err) {
      deps.log(
        `[bridge] seed branch snapshot failed (${branch.id}): ${String(err)}`,
      );
    }
    if (editedText !== null) {
      // 编辑重发：分叉会话的首轮 prompt = 编辑后的文本（handleSend 里走真回滚分叉）
      // R7-J：编辑态增删后的附件集合一并带上（旧附件文件不删——历史消息还引用它）
      await handleSend(win, {
        sessionId: branch.id,
        text: editedText,
        attachments: editedAttachments ?? undefined,
      });
    }
  }

  /** 分支/编辑的目标会话：显式 id 优先，缺省取最近活动的一条（同 send 口径） */
  function resolveBranchTarget(rawId: unknown): SessionRecord | null {
    if (typeof rawId === "string" && rawId) {
      return deps.sessions.get(rawId);
    }
    return deps.sessions.mostRecent();
  }

  /** R7-I：消息分支（只建会话，不替用户说话） */
  async function handleBranchSession(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const target = resolveBranchTarget(msg.sessionId);
    if (!target) {
      deps.log("[bridge] branchSession: unknown session → ignored");
      await pushSessionList();
      return;
    }
    // 第一条消息（messageIndex 0，来路 = 该条自己的「分支」按钮）：它的起点是会话开始**之前**
    // 的空历史 —— 没有历史可 fork，CLI 也无法 resume 空会话文件。按 turn 0 处理 = 新建全新会话
    // + 该条原文首轮（等价「从这条重放」；见 createBranch）。UI 载荷不变（turn k，验收锁定），
    // 分叉点由宿主按「这条消息在会话里的位置」定。
    const turn = msg.messageIndex === 0 ? 0 : msg.turn;
    await createBranch(win, target, turn, null);
  }

  /** R7-H：编辑重发（建分支 + 立刻把编辑后的文本作为分支首轮发出） */
  async function handleEditSession(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim()) {
      deps.log("[bridge] editSession: blank text → ignored");
      return;
    }
    const target = resolveBranchTarget(msg.sessionId);
    if (!target) {
      deps.log("[bridge] editSession: unknown session → ignored");
      await pushSessionList();
      return;
    }
    // R7-J：编辑态以**新集合**为准（旧附件文件不删——历史消息还引用它）
    await createBranch(
      win,
      target,
      msg.turn,
      text,
      normalizeAttachments(msg.attachments),
    );
  }

  async function handleGetHistory(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    // 未知 id / 无文件 → 空消息数组（§4.6 getHistory 行）；读失败在 store 内降级为 []
    const readAt = Date.now(); // R17 P3：同步点耗时埋点（换绑定回执的那次整文件读）
    const messages = sessionId
      ? await deps.sessions.readHistory(sessionId)
      : [];
    logSlow("readHistory", readAt);
    // R14 修点 1：回执带上「这个会话现在在跑什么」（无在途轮则不带该键，老形态逐字不变）
    const inFlight = sessionId ? inFlightOf(sessionId) : null;
    sendTo(win, {
      type: "history",
      sessionId,
      messages,
      ...(inFlight ? { inFlight } : {}),
    });
  }

  /**
   * getInputHistory：回该会话的输入历史（↑/↓ 翻已发送消息）——页面在会话桶首次加载时请求，
   * 面板重载/重启后凭这条把历史还回去。未接线/读失败 → 空数组（store 内已收敛，永不抛）。
   */
  async function handleGetInputHistory(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const entries =
      sessionId && deps.inputHistory
        ? await deps.inputHistory.get(sessionId)
        : [];
    sendTo(win, { type: "inputHistory", sessionId, entries });
  }

  /**
   * saveInputHistory：把该会话的最新历史交给宿主落盘（条目归一与上限都在 store 内）。
   * **无回执**：写盘是后台动作（store 内 500ms 合并、失败静默），翻历史不该等它；
   * 空 sessionId / 非法 entries → 忽略 + log。
   */
  function handleSaveInputHistory(msg: Record<string, unknown>): void {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!sessionId) {
      deps.log("[bridge] saveInputHistory: missing sessionId → ignored");
      return;
    }
    if (!deps.inputHistory) {
      deps.log("[bridge] saveInputHistory: input history store not wired");
      return;
    }
    void deps.inputHistory.save(sessionId, msg.entries);
  }

  async function handleCreateSession(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // BUG-24：建会话链路（查条目 / 写索引）任何一步失败都必须回包——UI 的「新建中…」
    // 只在收到 error / sessionList 后才解除，零回包 = 按钮永久停用（只能重载页面）。
    // 索引写入失败按 §4.6 错误码表用 SAVE_FAILED（持久化失败，message 附原文）。
    try {
      const rawKey = msg.itemKey;
      const itemKey = typeof rawKey === "string" && rawKey ? rawKey : null;
      let libraryID: number | null = null;
      if (itemKey) {
        const info = await deps.lookupItem(itemKey);
        if (!info) {
          deps.log(`[bridge] createSession: item not found: ${itemKey}`);
          sendTo(win, {
            type: "error",
            code: "ITEM_NOT_FOUND",
            message: `条目不存在：${itemKey}`,
          });
          return;
        }
        libraryID = info.libraryID;
      }
      const rec = await deps.sessions.create({
        itemKey,
        itemLibraryID: libraryID,
      });
      deps.log(`[bridge] session created: ${rec.id}`);
      await pushSessionList();
    } catch (err) {
      deps.log(`[bridge] createSession failed: ${String(err)}`);
      sendTo(win, {
        type: "error",
        code: "SAVE_FAILED",
        message: `会话创建失败（索引未写入）：${String(err)}`,
      });
    }
  }

  /**
   * renameSession（§4.6 UI→宿主表）：用户改名唯一入口，改名成功推 sessionList 作回执。
   * 未知 id / 空标题（清空输入 = 不改名）→ 忽略 + log：与 deleteSession 同口径，
   * 该会话可能已在他处删除，列表随后自然收敛。
   */
  async function handleRenameSession(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const title = typeof msg.title === "string" ? msg.title : "";
    if (!sessionId || !deps.sessions.get(sessionId)) {
      deps.log(`[bridge] renameSession: unknown id → ignored: ${sessionId}`);
      return;
    }
    const rec = await deps.sessions.rename(sessionId, title);
    if (!rec) {
      deps.log(`[bridge] renameSession: empty/invalid title → ignored`);
      return;
    }
    deps.log(`[bridge] session renamed: ${rec.id}`);
    await pushSessionList();
  }

  async function handleDeleteSession(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!sessionId || !deps.sessions.get(sessionId)) {
      deps.log(`[bridge] deleteSession: unknown id → ignored`);
      return;
    }
    const rt = runtimes.get(sessionId);
    if (rt?.busy) {
      // 会话要被删掉，其进行中的进程必须收掉（否则成了无主进程）
      deps.log(`[bridge] deleteSession: killing running turn (${sessionId})`);
      rt.turn?.kill();
    }
    runtimes.delete(sessionId);
    await deps.sessions.remove(sessionId);
    deps.log(`[bridge] session deleted: ${sessionId}`);
    await pushSessionList();
  }

  function handleSetPermissionMode(msg: Record<string, unknown>): void {
    const mode = msg.mode;
    if (!(PERMISSION_MODES as readonly string[]).includes(mode as string)) {
      deps.log(
        `[bridge] setPermissionMode: invalid mode ignored: ${String(mode)}`,
      );
      return;
    }
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!deps.sessions.get(sessionId)) {
      deps.log("[bridge] setPermissionMode: unknown session ignored");
      return;
    }
    updateIndex(sessionId, { permissionMode: mode as PermissionMode });
    deps.log(`[bridge] setPermissionMode: ${sessionId} → ${String(mode)}`);
  }

  /**
   * saveNote（§4.3）：HTML 消毒与写库全在 notes.ts（宿主唯一写入口），桥只做字段形态校验与回包。
   * 出参按 §4.3 错误契约：noteSaved {ok:true, noteKey} / {ok:false, code}；非法 mode → 忽略 + log。
   */
  async function handleSaveNote(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const itemKey = typeof msg.itemKey === "string" ? msg.itemKey : "";
    const html = typeof msg.html === "string" ? msg.html : "";
    if (!deps.notes) {
      deps.log("[bridge] saveNote: notes module not wired → SAVE_FAILED");
      sendTo(win, { type: "noteSaved", ok: false, code: "SAVE_FAILED" });
      return;
    }
    const mode = msg.mode;
    let result: NoteSaveResult;
    if (mode === "new") {
      result = await deps.notes.saveNote({ itemKey, mode: "new", html });
    } else if (mode === "append") {
      const noteKey = typeof msg.noteKey === "string" ? msg.noteKey : "";
      result = await deps.notes.saveNote({
        itemKey,
        mode: "append",
        noteKey,
        html,
      });
    } else {
      deps.log(`[bridge] saveNote: invalid mode ignored: ${String(mode)}`);
      return;
    }
    deps.log(
      `[bridge] saveNote: ${result.ok ? `ok (${result.noteKey})` : `failed (${result.code})`}`,
    );
    sendTo(
      win,
      result.ok
        ? { type: "noteSaved", ok: true, noteKey: result.noteKey }
        : { type: "noteSaved", ok: false, code: result.code },
    );
  }

  /**
   * listNotes（§4.3）：回笔记清单；失败按 §4.6 listNotes 行「回错误码」——noteList 无错误字段，
   * 走通用 error 通道（错误码总表与函数出参共用）。
   */
  async function handleListNotes(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const itemKey = typeof msg.itemKey === "string" ? msg.itemKey : "";
    if (!deps.notes) {
      deps.log("[bridge] listNotes: notes module not wired → SAVE_FAILED");
      sendTo(win, {
        type: "error",
        code: "SAVE_FAILED",
        message: "笔记模块未接线",
      });
      return;
    }
    const result = await deps.notes.listNotes(itemKey);
    if (result.ok) {
      sendTo(win, { type: "noteList", notes: result.notes });
      return;
    }
    deps.log(`[bridge] listNotes failed (${result.code})`);
    sendTo(win, {
      type: "error",
      code: result.code,
      message: result.message,
    });
  }

  function handleOpenExternal(msg: Record<string, unknown>): void {
    const url = msg.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      deps.log(
        `[bridge] openExternal: non-http(s) url ignored: ${String(url)}`,
      );
      return;
    }
    deps.launchURL(url);
  }

  // ---- R7-A/R7-B：指令编辑器与 @ 提及（宿主侧只做接线与白名单，逻辑在 utils/）----

  /** R7-A：读指令（scope 白名单在纯函数里；UI 永不传路径，宿主自行拼接并校验落点在workspace内） */
  async function handleReadInstructions(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.instructions) {
      sendTo(win, {
        type: "instructions",
        scope: "global",
        path: null,
        text: "",
        exists: false,
        error: "指令编辑器未接线（宿主未注入）",
      });
      return;
    }
    const res = await deps.instructions.read(msg.scope);
    sendTo(win, {
      type: "instructions",
      scope: res.scope,
      path: res.path,
      text: res.text,
      exists: res.exists,
      ...(res.error ? { error: res.error } : {}),
      ...(res.notice ? { notice: res.notice } : {}),
    });
  }

  /** R7-A：写指令（超限/越界在纯函数内拒绝且不落盘，回执带 error 原文） */
  async function handleSaveInstructions(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.instructions) {
      sendTo(win, {
        type: "instructionsSaved",
        scope: "global",
        ok: false,
        error: "指令编辑器未接线（宿主未注入）",
      });
      return;
    }
    const res = await deps.instructions.save(msg.scope, msg.text);
    sendTo(win, {
      type: "instructionsSaved",
      scope: res.scope,
      ok: res.ok,
      ...(res.path ? { path: res.path } : {}),
      ...(res.error ? { error: res.error } : {}),
    });
  }

  /** R7-B：@ 检索（query 上限 64 在纯函数里；异常 → 空候选，回执照发不悬挂） */
  async function handleSearchItems(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const query = typeof msg.query === "string" ? msg.query : "";
    let items: MentionSearchItem[] = [];
    try {
      items = (await deps.mentions?.search(query)) ?? [];
    } catch (err) {
      deps.log(`[bridge] searchItems failed: ${String(err)}`);
      items = [];
    }
    sendTo(win, { type: "itemSearchResult", query, items });
  }

  /** R7-B：chips → 注入用结构（查不到标 missing；发送时由 buildTurnPrompt 再解析一次取最新） */
  async function handleResolveRefs(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const keys = normalizeRefKeys(msg.itemKeys);
    const resolveItem = deps.mentions?.resolveItem;
    const refs = resolveItem
      ? await resolveMentionRefs(keys, { resolveItem })
      : [];
    sendTo(win, { type: "refsResolved", refs });
  }

  // ---- R7-C/R7-D：命令面板、工作区/导出、范围注入（宿主侧只做接线与白名单）----

  /**
   * R7-C：拉命令清单。本地命令（白名单枚举）由宿主拼在最前——UI 只认 name/description/source，
   * 不存在「面板输入当命令执行」的路径（本地命令的执行动作在 UI 侧按 action 枚举分发）。
   * 未接线/扫描异常 → 只回本地命令，面板照常可用不悬挂。
   */
  async function handleListCommands(win: UiWindowKey): Promise<void> {
    let scanned: CommandEntry[] = [];
    try {
      scanned = (await deps.listCommands?.()) ?? [];
    } catch (err) {
      deps.log(`[bridge] listCommands failed: ${String(err)}`);
      scanned = [];
    }
    // 内置命令（R12-A 实测可用的 CLI 命令）夹在本地与扫描结果之间：本地优先、同名本地赢
    const localNames = new Set(LOCAL_COMMANDS.map((c) => c.name));
    sendTo(win, {
      type: "commandList",
      commands: [
        ...LOCAL_COMMANDS,
        ...BUILTIN_COMMANDS.filter((c) => !localNames.has(c.name)),
        ...scanned,
      ],
    });
  }

  /**
   * R8：面板顶栏「全页」——打开独立工作台标签页（无载荷：UI 只发动作，不传任何路径/命令名；
   * 未接线/实现侧抛错都只记日志，面板不悬挂）。
   */
  function handleOpenFullPage(): void {
    try {
      deps.openFullPage?.();
    } catch (err) {
      deps.log(`[bridge] openFullPage failed: ${String(err)}`);
    }
  }

  /**
   * R9：/diag —— 只读采集并回一份诊断报告（文本由实现侧拼好；这里只做「未接线/抛错」兜底，
   * 保证弹层永远拿到东西：报告生成失败也不悬挂 UI）。
   */
  async function handleDiag(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId =
      typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : null;
    let text: string;
    try {
      text = deps.diag
        ? await deps.diag.collect(sessionId)
        : `${DIAG_HEADER}\n(error: 宿主未接线)`;
    } catch (err) {
      deps.log(`[bridge] diag failed: ${String(err)}`);
      text = `${DIAG_HEADER}\n(error: 采集失败：${String(err)})`;
    }
    sendTo(win, { type: "diagReport", text });
  }

  /** R7-C：打开工作区目录（按当前绑定会话的条目解析 cwd；未绑定 → 根） */
  async function handleOpenWorkspace(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const record = sessionId ? deps.sessions.get(sessionId) : null;
    try {
      const path = await deps.ensureWorkspace(record?.itemKey ?? null);
      if (!deps.openWorkspacePath) {
        throw new Error("打开目录未接线");
      }
      await deps.openWorkspacePath(path);
      deps.log(`[bridge] workspace opened: ${path}`);
    } catch (err) {
      deps.log(`[bridge] openWorkspace failed: ${String(err)}`);
      sendTo(win, {
        type: "error",
        code: "WORKSPACE_UNAVAILABLE",
        message: `打开工作区目录失败：${String(err)}`,
      });
    }
  }

  /** R7-C：/export（UI 传 Markdown 源码；落点由实现侧拼 + 净化，UI 永不传路径） */
  async function handleExportSession(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const title = typeof msg.title === "string" ? msg.title : "";
    const markdown = typeof msg.markdown === "string" ? msg.markdown : "";
    if (!markdown.trim() || !deps.exportSession) {
      sendTo(win, {
        type: "sessionExported",
        ok: false,
        error: deps.exportSession ? "当前会话没有可导出的内容" : "导出未接线",
      });
      return;
    }
    const res = await deps.exportSession({ title, markdown });
    sendTo(win, {
      type: "sessionExported",
      ok: res.ok === true,
      ...(res.path ? { path: res.path } : {}),
      ...(res.error ? { error: res.error } : {}),
    });
  }

  /** R7-D：范围解析（kind 枚举收口；未接线 → 空清单回执，UI 就地给提示 + 重试） */
  async function handleResolveScope(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const kind: ScopeKind =
      msg.kind === "collection" ? "collection" : "selection";
    let res: ResolvedScope = {
      kind,
      label: kind === "collection" ? "当前分类" : SCOPE_SELECTION_LABEL,
      items: [],
      truncated: false,
    };
    try {
      res = (await deps.resolveScope?.(kind)) ?? res;
    } catch (err) {
      deps.log(`[bridge] resolveScope failed: ${String(err)}`);
    }
    sendTo(win, {
      type: "scopeResolved",
      kind: res.kind,
      label: res.label,
      items: res.items,
      truncated: res.truncated,
    });
  }

  function dispatchFrom(
    win: UiWindowKey,
    data: unknown,
    via: "window" | "port",
  ): void {
    if (!isRecord(data) || typeof data.type !== "string") {
      return; // 非 JSON 对象/缺 type → 忽略（§4.6）
    }
    const msg = data;
    const type = msg.type;

    if (type === "hello") {
      const pended = pending.get(win);
      const entry = pended ?? registry.get(win);
      if (!entry) {
        deps.log("[bridge] hello from unknown source → ignored");
        return;
      }
      // token 校验（BUG-16）：一次性 token 不一致 → 拒绝 + log，绝不静默放行、绝不注册
      if (msg.token !== entry.token) {
        deps.log(`[bridge] hello REJECTED: token mismatch (via ${via})`);
        return;
      }
      const isReload = !pended;
      if (pended) {
        clearPendingTimer(win);
        // 注册（重载场景以新条目覆盖：端口随之更新）
        registry.set(win, pended);
      }
      if (isReload) {
        // browser 重载的二次握手：已注册窗口重复 hello → 幂等重发 sessionList（只注册一次）
        deps.log(
          `[bridge] hello (page reload, via ${via}) → re-send sessionList`,
        );
      } else {
        deps.log(
          `[bridge] hello received (via ${via}), registered (${registry.size} instance(s))`,
        );
      }
      // 索引载入可能触发损坏重置：重置过就顺带告知（§4.5「UI 提示会话索引已重置」；
      // 桥协议无专用通知消息，按 §4.6 失效语义走 error 横幅 + 「新建会话」按钮）
      void (async () => {
        await deps.sessions.init();
        if (deps.sessions.wasReset()) {
          sendTo(win, {
            type: "error",
            code: "SESSION_GONE",
            message:
              "会话索引已损坏并重置（原文件备份为 sessions.json.bak-*），历史会话列表已清空",
          });
        }
        // M9 CLI 检测引导（PLAN §2.7）：可用性/登录态有问题 → 注册即推横幅
        const cliStatus = deps.getCliStatus?.() ?? null;
        if (cliStatus && !cliStatus.ok && cliStatus.code) {
          sendTo(win, {
            type: "error",
            code: cliStatus.code,
            message: cliStatus.message,
          });
          // R15 F10：上次结论是失败 → 面板打开顺手重查一次（20s 最小间隔在实现侧把关；
          // 装完 claude / 探测超时恢复后，用户重开面板即可看到好结果）
          deps.reprobeCliIfFailed?.();
        }
        // R17 P1：握手不再直发 sessionListMessage()（那会绕过序号守卫 → 新实例可能先收旧快照），
        // 改走唯一出口；本实例已注册（registry.set 早于本行），必在这次广播的收件人里
        await pushSessionList();
        // R4-3：余额查询时机 = 面板打开（每个实例注册时一次；60s TTL 缓存兜住多实例重复打开）
        await pushBalance(win, false);
      })();
      // R4-3：宿主侧 UI prefs（「显示用量/余额」）——注册即推，UI 据此决定是否渲染该行
      // R7-A：附带工作区模式（指令编辑器的「当前分类」作用域是否可用）
      sendTo(win, {
        type: "uiPrefs",
        showUsage: deps.showUsage?.() ?? true,
        workspaceMode: deps.getWorkspaceMode?.() ?? "single",
        // R10：会话区展开态（默认收起 = 一行高度还给消息区）
        sessionsExpanded: deps.sessionsExpanded?.get() === true,
      });
      // 阅读上下文：重载后必须补推。sections.ts 的轮询去重键（每实例一键）活在**宿主**进程里，
      // 页面重载不经过 stopReaderContextWatch，键不会失效 → 不补推的话重载后面板永远拿不到文献
      // 上下文（顶栏空白 + 会话跟随失去依据，且不会自愈）。这里直连取数，绕过去重键。
      // R17 P4：按实例取（win）——每个实例拿它所在标签页的那一份；**必须补 .catch**：
      // 取数抛错时这条链是 `void …then()`，会变成逃出 dispatch() 的未处理拒绝（既有缺陷，
      // 随手一并修）。处置同 INTERFACE §3：记一条日志、该实例本轮跳过，不推 error。
      void deps
        .buildReaderContext(win)
        .then((ctx) => {
          if (ctx) sendTo(win, ctx);
        })
        .catch((err: unknown) => {
          deps.log(`[bridge] readerContext (hello) failed: ${String(err)}`);
        });
      return;
    }

    // 其余消息只接受已注册实例（§4.6：宿主只接受已注册实例的消息）
    if (!registry.has(win)) {
      deps.log(`[bridge] drop message from unregistered source: ${type}`);
      return;
    }
    deps.log(`[bridge] msg: ${type} (via ${via})`);

    switch (type) {
      case "send":
        guard("send", handleSend(win, msg));
        break;
      case "interrupt":
        handleInterrupt(msg);
        break;
      case "getHistory":
        guard("getHistory", handleGetHistory(win, msg));
        break;
      case "getInputHistory":
        guard("getInputHistory", handleGetInputHistory(win, msg));
        break;
      case "saveInputHistory":
        handleSaveInputHistory(msg);
        break;
      case "openExternal":
        handleOpenExternal(msg);
        break;
      case "getState":
        guard("getState", pushSessionList());
        break;
      case "createSession":
        guard("createSession", handleCreateSession(win, msg));
        break;
      case "deleteSession":
        guard("deleteSession", handleDeleteSession(msg));
        break;
      case "renameSession":
        guard("renameSession", handleRenameSession(msg));
        break;
      case "setPermissionMode":
        handleSetPermissionMode(msg);
        break;
      case "refreshBalance":
        guard("refreshBalance", pushBalance(win, true));
        break;
      case "permissionResponse":
        handlePermissionResponse(msg);
        break;
      case "saveNote":
        guard("saveNote", handleSaveNote(win, msg));
        break;
      case "listNotes":
        guard("listNotes", handleListNotes(win, msg));
        break;
      case "readInstructions":
        guard("readInstructions", handleReadInstructions(win, msg));
        break;
      case "saveInstructions":
        guard("saveInstructions", handleSaveInstructions(win, msg));
        break;
      case "searchItems":
        guard("searchItems", handleSearchItems(win, msg));
        break;
      case "resolveRefs":
        guard("resolveRefs", handleResolveRefs(win, msg));
        break;
      case "listCommands":
        guard("listCommands", handleListCommands(win));
        break;
      case "resolveScope":
        guard("resolveScope", handleResolveScope(win, msg));
        break;
      case "openWorkspace":
        guard("openWorkspace", handleOpenWorkspace(win, msg));
        break;
      case "openFullPage":
        handleOpenFullPage();
        break;
      case "exportSession":
        guard("exportSession", handleExportSession(win, msg));
        break;
      case "branchSession":
        guard("branchSession", handleBranchSession(win, msg));
        break;
      case "editSession":
        guard("editSession", handleEditSession(win, msg));
        break;
      case "pickAttachments":
        guard("pickAttachments", handlePickAttachments(win, msg));
        break;
      case "setSessionPinned":
        handleSetSessionPinned(msg);
        break;
      case "setSessionsExpanded":
        handleSetSessionsExpanded(msg);
        break;
      case "diag":
        guard("diag", handleDiag(win, msg));
        break;
      default:
        deps.log(`[bridge] unknown message type ignored: ${type}`);
        break;
    }
  }

  /** message 事件入口（真实宿主接主窗口 "message"；端口路径在 beginHandshake 内直连） */
  function dispatch(ev: { source: unknown; data: unknown }): void {
    dispatchFrom(ev.source as UiWindowKey, ev.data, "window");
  }

  function unregister(win: UiWindowKey): void {
    clearPendingTimer(win);
    const entry = registry.get(win);
    entry?.port?.close?.();
    registry.delete(win);
    // 安全修：窗口关了 → 该窗口的一次性附件凭据全部作废（路径不出宿主内存）
    attachmentTokens.delete(win);
  }

  return {
    beginHandshake,
    dispatch,
    broadcast,
    sendTo,
    requestPermission,
    permissionSettled,
    unregister,
    // R17 P4：拷贝（遍历期间注册表可变——sendTo 自带死实例摘除，会在遍历中改表）
    instances: () => [...registry.keys()],
    getRuntime: (sessionId: string) => {
      const rt = runtimes.get(sessionId);
      return rt ? { sessionId, busy: rt.busy } : null;
    },
  };
}
