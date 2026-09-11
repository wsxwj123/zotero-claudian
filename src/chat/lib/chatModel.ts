// 聊天 UI 状态机（纯逻辑，无 DOM / 无 Preact / 无 Zotero）——node:test 可测。
// 职责：把桥消息（§4.6 宿主→UI）归约为可渲染状态。
// §4.6 兜底约定：未知 type / 未知 event.kind 一律原样返回 state（忽略不崩），
// 为 M5 会话列表 / M6 权限卡 / M7 笔记预留消息类型分发表。
import type {
  AttachmentPayload,
  BalanceState,
  BalanceStatus,
  HostMessage,
  SessionSummary,
  StreamEvent,
  UiMessage,
  UsageStats,
} from "./types";
import { isUsageStats } from "./usage";
import {
  attachmentChipsAdd,
  attachmentChipsClear,
  attachmentChipsSet,
  initialAttachmentChips,
  pendingAttachment,
  type AttachmentChipsState,
} from "./attachmentChips";

import {
  initialMentionPickerState,
  mentionRefsResolved,
  mentionResults,
  type MentionPickerState,
} from "./mentionPicker";
import {
  initialInstructionsEditor,
  instructionsEditorClose,
  instructionsEditorEdit,
  instructionsEditorLoad,
  instructionsEditorSaved,
  instructionsEditorSetScope,
  type InstructionsEditorState,
} from "./instructionsEditor";
import {
  commandAccept,
  commandActiveSet,
  commandPanelClose,
  commandPanelOpen,
  commandQueryChange,
  commandResults,
  initialCommandPickerState,
  type CommandPickerState,
} from "./commandPicker";
import {
  initialScopeState,
  scopeChipClear,
  scopeChipSet,
  scopePickerClose,
  scopePickerOpen,
  type ScopePickerState,
} from "./scopePicker";
import {
  initialMessageActionState,
  messageActionsReset,
  messageEditStart,
  type MessageActionState,
} from "./messageActions";
import {
  branchButtonState,
  messageBranchClick,
  snapshotTurnForEdit,
  type BranchButtonState,
} from "./branchActions";
import { filterCommands, resolveLocalCommand } from "../../utils/commands";
import type { ScopeKind } from "../../utils/scope";
import type { WorkspaceMode } from "../../utils/collectionWorkspace";
import type { InstructionScope } from "../../utils/instructions";

export type TurnStatus = "idle" | "waiting" | "streaming" | "interrupting";

/** 记录-06：SESSION_BUSY 自动重发的间隔与上限（超限退回输入框 + 横幅，即 M5 兜底口径） */
export const RETRY_DELAY_MS = 1000;
export const RETRY_MAX_ATTEMPTS = 5;

/** 权限档四档（PLAN §2 + R5：顶栏可切；§4.6 setPermissionMode 只认这四档，非法值宿主忽略） */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypass",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(v);
}

/** 顶栏档位项（顺序即 UI 顺序；bypass 的文案在确认期间会变，见 bypassOptionClick） */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  value: PermissionMode;
  label: string;
}> = [
  { value: "default", label: "默认" },
  { value: "acceptEdits", label: "接受编辑" },
  { value: "plan", label: "计划" },
  { value: "bypass", label: "放任（不再弹权限卡）" },
];

/** CLI `--permission-mode` 取值 → 内部档位 id（init 事件回显用：CLI 报的是 bypassPermissions） */
export function cliPermissionModeToId(value: string): string {
  return value === "bypassPermissions" ? "bypass" : value;
}

// ---- R5：放任档两步确认（防误触；纯状态机，node 单测）----

/** 第二次点击的窗口：5 秒无后续点击自动复原 */
export const BYPASS_CONFIRM_WINDOW_MS = 5000;

/** null = 未武装；数字 = 武装截止时间戳（ms） */
export type BypassConfirmState = number | null;

/** 是否处于「已武装且未超时」 */
export function bypassConfirmArmed(
  armed: BypassConfirmState,
  now: number,
): boolean {
  return armed !== null && now <= armed;
}

/**
 * 点顶栏「放任」项：
 * - 未武装 / 已超时 → 只武装（不换档），armed = now + 5s；
 * - 窗口内再点 → 确认生效（confirmed = true，armed 清空）。
 */
export function bypassOptionClick(
  armed: BypassConfirmState,
  now: number,
): { armed: BypassConfirmState; confirmed: boolean } {
  if (bypassConfirmArmed(armed, now)) {
    return { armed: null, confirmed: true };
  }
  return { armed: now + BYPASS_CONFIRM_WINDOW_MS, confirmed: false };
}

/** Claude Code 安装说明链接（CLI 不可用横幅的「安装说明」按钮；与宿主 cliDetect.CLAUDE_INSTALL_URL 同值） */
export const CLAUDE_INSTALL_URL =
  "https://docs.claude.com/en/docs/claude-code/setup";

export type TurnBlock =
  | { blockType: "text"; index: number; text: string; streaming: boolean }
  | { blockType: "thinking"; index: number; text: string; streaming: boolean }
  | {
      blockType: "tool";
      index: number;
      toolName: string;
      toolUseId: string;
      inputJson: string;
      result: { isError: boolean; summary: string } | null;
      streaming: boolean;
    };

export interface Turn {
  /**
   * divider（R7-F）：「已编辑重发」分隔条——编辑非末条消息后截断视图时插入，
   * 只有 text 没有 blocks；UI 画一条分隔线，不进历史、不参与复制。
   */
  role: "user" | "assistant" | "divider";
  /** user turn 的原文（divider 的分隔文案） */
  text?: string;
  /** assistant turn 的块序列（content_block index 对应） */
  blocks?: TurnBlock[];
  /**
   * R7-J：该用户轮带的附件。path 来自宿主 attachmentSaved 回执（绝对路径，**只用于展示**——
   * 编辑重发时 UI 只回传宿主下发的 token，永不回传路径，安全修）。`missing` 由发送前的
   * 标记逻辑置位后 UI 标红。
   */
  attachments?: {
    name: string;
    path?: string;
    sizeBytes: number;
    /** 宿主一次性凭据（编辑重发用；无 token 的旧消息只能重新选择文件） */
    token?: string;
    missing?: boolean;
  }[];
}

/** 待答权限卡（§4.6 permissionRequest；一张卡一个 requestId） */
export interface PendingPermission {
  requestId: string;
  tool: string;
  inputSummary: string;
  rawInput: unknown;
}

/** 目标条目下的已有笔记（§4.3 listNotes 出参） */
export interface NoteSummary {
  noteKey: string;
  title: string;
  updatedAt: number;
}

/**
 * 笔记选择器（M7，§4.3）：挂在某条 assistant turn 上——「存为笔记」点了之后
 * 选新建/追加到哪条已有笔记。notes=null 表示清单还在路上。
 * itemKey 在打开时固化：选择期间用户切文献不影响本次写入目标。
 */
export interface NotePicker {
  turnIndex: number;
  itemKey: string;
  /** 已转好的笔记 HTML（marked→DOMPurify 产物；落到宿主机再过白名单终检） */
  html: string;
  notes: NoteSummary[] | null;
  /**
   * 从哪开出来的（用户反馈：选段浮钮点完「没显示是创建还是追加」——选项得就地展开在选区旁，
   * 不能跑到消息底部的操作行）。缺省 = 消息行「存为笔记」按钮；"selection" = 选段浮钮。
   */
  origin?: "selection";
}

export interface ChatState {
  /** 桥握手是否完成（hello 已回发） */
  connected: boolean;
  /** 待答权限卡队列（并行工具调用会同时来多张，逐个作答） */
  pendingPermissions: PendingPermission[];
  messages: Turn[];
  turnStatus: TurnStatus;
  /** 状态行细节：模型、重试、耗时/费用 */
  statusDetail: string;
  errorBanner: string | null;
  readerContext: {
    itemKey: string | null;
    title: string | null;
    page: number | null;
    selection: string | null;
  } | null;
  /** 当前绑定的会话（M5：sessionList 到达时自动绑定 / 用户点选切换） */
  sessionId: string | null;
  /** 最近一次 init 事件报告的权限档（F6 顶栏控件回显用；null = 未知，换会话即回未知） */
  permissionMode: string | null;
  /** 进入 waiting 的时刻（状态行计时用），离开 waiting 即置 null */
  waitingSince: number | null;
  /** 宿主全量会话索引（§4.6 sessionList；已按 updatedAt 降序，[0] 最新） */
  sessions: SessionSummary[];
  /** 新建会话请求在途（sessionList 到达即绑定到新会话并清除） */
  creatingSession: boolean;
  /** 最近一次错误码（SESSION_GONE 时 UI 给「新建会话」按钮） */
  errorCode: string | null;
  /** SESSION_BUSY 被拒后要还给输入框的原文（记录-06 兜底；InputBox 消费后清空） */
  restoreDraft: string | null;
  /** 记录-06：被 SESSION_BUSY 拒掉、等待自动重发的原文（attempts = 已重发次数）；
   * 非 null 即「输入区显示上一轮收尾中…」的依据，被用户新发送/中断/换会话即作废 */
  pendingRetry: { text: string; attempts: number } | null;
  /**
   * 复查修-1：空绑定（sessionId=null）时发送的暂存原文——先走 createSession 建会话，
   * 绑定经 sessionList 建立后由 flushQueuedSend 恰发一次；建会话失败/换视图则还给输入框
   *（restoreDraft）。绝不带着 null sessionId 交给宿主（那会被落到「最近会话」并改绑归属）。
   */
  queuedSend: string | null;
  /** R7-B：随 queuedSend 一起暂存的引用条目 key（chips 在排队期间可能已被清掉） */
  queuedSendRefs: string[] | null;
  /** R7-D：随 queuedSend 一起暂存的范围载荷（同上） */
  queuedSendScope: SendScope | null;
  /** R7-J：随 queuedSend 一起暂存的附件载荷（chips 在排队期间会被清掉） */
  queuedSendAttachments: AttachmentPayload[] | null;
  /** M7：笔记选择器（打开的「存为笔记」弹层；null = 未打开） */
  notePicker: NotePicker | null;
  /**
   * R4-3：最近一轮的用量（usageStats 到达时置位；换视图即清，见 switchView）。
   * null = 还没有带用量的轮（整行不显示）。
   */
  turnUsage: UsageStats | null;
  /**
   * R4-3：该会话累计用量从 `sessions`（sessionList 的条目 / usageStats 就地并入）读，
   * 不在这里另存一份——避免两份数据打架。
   */
  /** R4-3：余额状态（宿主 hello 时推一次 + 手动刷新回推；null = 尚未收到） */
  balance: BalanceStatus | null;
  /** R4-3：宿主侧「显示用量/余额」开关（uiPrefs；默认开） */
  showUsage: boolean;
  /**
   * R7-A：宿主工作区模式（uiPrefs 附带）。single 模式下「当前分类」作用域没有落点，
   * UI 据此把该档禁用并说明（省一次往返才知道不可用）。
   */
  workspaceMode: WorkspaceMode;
  /** R7-B：@ 提及面板与 chips（本轮有效，发送后清空） */
  mention: MentionPickerState;
  /** R7-C：`/` 命令面板（清单在宿主侧扫描，回执落这里；关键词过滤在前端本地做） */
  commands: CommandPickerState;
  /** R7-C：命令面板选中后要插进输入框的骨架文本（InputBox 消费后清空） */
  composerInsert: string | null;
  /** R7-J：本轮附件 chips（粘贴/选择文件；发送后清空，编辑态可增删） */
  attachments: AttachmentChipsState;
  /** R7-K：置顶会话 id（本地 prefs，随 sessionList 回推；不限量、不受归档影响） */
  pinnedSessions: string[];
  /** R7-D：范围选择（chip 属于本轮，发送后清空） */
  scope: ScopePickerState;
  /** R7-F：消息级操作视图态（复制/折叠/编辑；切会话重置，不落盘） */
  actions: MessageActionState;
  /** R7-C：/help 的命令帮助弹层 */
  helpOpen: boolean;
  /**
   * R9：/diag 诊断报告弹层（null = 未打开）。
   * text=null 表示「已请求、宿主回执未到」（弹层显示采集中）；宿主回执一到就填文本。
   */
  diag: { text: string | null } | null;
  /** R7-A：指令编辑器弹层（null = 未打开） */
  instructions: InstructionsEditorState | null;
  /**
   * R7-I：分支动作在途（点「分支」/「编辑重发」后等宿主回执）——
   * `"branch"` 回执到达即切到新分支（视图从空开始）；`"edit"` 保留已截断的视图（编辑后的文本已在里面）。
   */
  branchPending: "branch" | "edit" | null;
  /**
   * 输入历史（↑/↓ 翻已发送消息）：宿主在会话桶首次加载时回推（getInputHistory → inputHistory）。
   * 这是页面侧的**载入路径**（持久化本身在宿主 <profile>/claudian/input-history.json）；
   * InputBox 拿到后并入本会话的历史桶（见 lib/inputHistory.ts 的 mergeHostEntries）。
   * null = 尚未收到。
   */
  inputHistory: { sessionId: string; entries: string[] } | null;
}

/** R4-3：当前绑定会话的累计用量（sessions 里带 usage 的那条）；无数据 → null */
export function currentSessionUsage(state: ChatState): UsageStats | null {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  return s && isUsageStats(s.usage) ? s.usage : null;
}

/** R4-3：余额文案（PLAN-R4 §4）：CNY → `¥42.10`，USD → `$5.00`，未知币种原样后缀（`500 JPY`） */
export function formatBalance(currency: string, total: string): string {
  switch (currency.toUpperCase()) {
    case "CNY":
      return `¥${total}`;
    case "USD":
      return `$${total}`;
    default:
      return currency ? `${total} ${currency}` : total;
  }
}

/**
 * R4-3：顶栏手动刷新余额——本地先置「查询中」（按钮点击要有反馈，远端查询 1s 级），
 * 桥消息请宿主重查（绕过 60s TTL）。宿主侧非 deepseek/无 Key 时不发请求、直接回说明态。
 */
export function startBalanceRefresh(state: ChatState): {
  state: ChatState;
  msg: UiMessage;
} {
  return {
    state: {
      ...state,
      balance: {
        provider: state.balance?.provider ?? "unknown",
        balance: { state: "loading" },
      },
    },
    msg: { type: "refreshBalance" },
  };
}

/** R4-3：balanceStatus 载荷归约（宿主构造，仍按「坏输入不崩」口径处理） */
function normalizeBalanceState(raw: unknown): BalanceState {
  if (typeof raw !== "object" || raw === null) {
    return { state: "unsupported" };
  }
  const rec = raw as Record<string, unknown>;
  switch (rec.state) {
    case "loading":
    case "unsupported":
    case "nokey":
      return { state: rec.state };
    case "ok": {
      if (typeof rec.total !== "string") {
        return { state: "error", reason: "余额响应形态异常" };
      }
      const all: { currency: string; total: string }[] = [];
      if (Array.isArray(rec.all)) {
        for (const entry of rec.all) {
          if (typeof entry !== "object" || entry === null) {
            continue;
          }
          const e = entry as Record<string, unknown>;
          if (typeof e.total === "string") {
            all.push({
              currency: typeof e.currency === "string" ? e.currency : "",
              total: e.total,
            });
          }
        }
      }
      return {
        state: "ok",
        currency: typeof rec.currency === "string" ? rec.currency : "",
        total: rec.total,
        all,
      };
    }
    case "error":
      return {
        state: "error",
        reason: typeof rec.reason === "string" ? rec.reason : "余额查询失败",
      };
    default:
      return { state: "unsupported" };
  }
}

export function initialChatState(): ChatState {
  return {
    connected: false,
    pendingPermissions: [],
    messages: [],
    turnStatus: "idle",
    statusDetail: "",
    errorBanner: null,
    readerContext: null,
    sessionId: null,
    permissionMode: null,
    waitingSince: null,
    sessions: [],
    creatingSession: false,
    errorCode: null,
    restoreDraft: null,
    pendingRetry: null,
    queuedSend: null,
    queuedSendRefs: null,
    queuedSendScope: null,
    queuedSendAttachments: null,
    notePicker: null,
    turnUsage: null,
    balance: null,
    showUsage: true,
    workspaceMode: "single",
    mention: initialMentionPickerState(),
    commands: initialCommandPickerState(),
    composerInsert: null,
    attachments: initialAttachmentChips(),
    pinnedSessions: [],
    scope: initialScopeState(),
    actions: initialMessageActionState(),
    helpOpen: false,
    diag: null,
    instructions: null,
    branchPending: null,
    inputHistory: null,
  };
}

// ---- 消息类型分发表：新增桥消息在此加分支，default 兜底忽略 ----

export function reduceHostMessage(
  state: ChatState,
  msg: HostMessage,
): ChatState {
  switch (msg.type) {
    case "init":
      // init 是给 bridgeClient 的握手消息，不该流到 reducer；收到即视为连接完成
      return { ...state, connected: true };
    case "sessionList":
      return reduceSessionList(state, msg.sessions, msg.pinned);
    case "attachmentSaved":
      return reduceAttachmentSaved(state, msg);
    case "attachmentsPicked":
      return reduceAttachmentsPicked(state, msg);
    case "branchCreated":
      return reduceBranchCreated(state, msg);
    case "streamEvent":
      // BUG-12：双实例广播——仅应用当前会话的流事件；消息缺 sessionId（缺省）
      // 或本实例尚未绑定会话时不构成串屏，照常应用
      if (
        typeof msg.sessionId === "string" &&
        state.sessionId !== null &&
        msg.sessionId !== state.sessionId
      ) {
        return state;
      }
      return reduceStreamEvent(state, msg.event);
    case "history":
      // 他方会话的回放不落到本视图（与 BUG-12 同口径）；进行中 turn 的在途轮次
      // 由 reduceHistory 保住（BUG-23/26：回放照常应用，但不抹掉本地乐观轮）
      if (
        typeof msg.sessionId === "string" &&
        state.sessionId !== null &&
        msg.sessionId !== state.sessionId
      ) {
        return state;
      }
      return reduceHistory(state, msg.messages);
    case "inputHistory": {
      // 输入历史（↑/↓ 翻已发送消息）的宿主回推：与 history/usageStats 同口径——只管当前绑定会话的
      // （多实例广播，各看各的）；entries 归一（非字符串/缺字段一律丢，坏输入不崩）。
      const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
      if (!sid) {
        return state;
      }
      if (state.sessionId !== null && sid !== state.sessionId) {
        return state;
      }
      return {
        ...state,
        inputHistory: {
          sessionId: sid,
          entries: Array.isArray(msg.entries)
            ? msg.entries.filter((x): x is string => typeof x === "string")
            : [],
        },
      };
    }
    case "readerContext": {
      const itemKey = msg.itemKey ?? null;
      const next: ChatState = {
        ...state,
        readerContext: {
          itemKey,
          title: msg.title ?? null,
          page: msg.page ?? null,
          selection: msg.selection ?? null,
        },
      };
      // R4-1（PLAN-R4 §2）：只有「换了文献」（itemKey 变了）才跟随会话——翻页/划选推来的
      // readerContext 的 itemKey 不变，不触发（否则会把用户手选的同条目旧会话抢回「最新」）。
      // 一次 reduce 出结果（followReader 内部只改绑定与视图，readerContext 原样留着）。
      if (itemKey === (state.readerContext?.itemKey ?? null)) {
        return next;
      }
      return followReader(next, itemKey).state;
    }
    case "error": {
      // BUG-13：仅当前会话的错误才影响本视图（横幅/解锁 waiting）；
      // 无关会话的错误整体忽略——错误消息缺 sessionId 字段视为全局错误照常应用
      if (
        typeof msg.sessionId === "string" &&
        state.sessionId !== null &&
        msg.sessionId !== state.sessionId
      ) {
        return state;
      }
      const errored: ChatState = {
        ...state,
        errorBanner: `${msg.code}: ${msg.message}`,
        errorCode: typeof msg.code === "string" ? msg.code : null,
        // SESSION_BUSY 等错误把可能卡住的 waiting 拉回 idle
        turnStatus: state.turnStatus === "waiting" ? "idle" : state.turnStatus,
        waitingSince: null,
        // 新建在途标志一并清掉：createSession 失败（如 ITEM_NOT_FOUND）时按钮不能永久「新建中…」
        creatingSession: false,
        // 重试中的轮被别的错误打断 → 自动重发作废（否则错误后 turn 回 idle，定时器照发）
        pendingRetry: null,
        // 复查修-1：空绑定发送在途时建会话失败 → 暂存原文还给输入框（不丢、不再等绑定），
        // 错误横幅照旧走上面两条（restoreDraft 由 InputBox 消费）
        ...(state.creatingSession && state.queuedSend !== null
          ? { queuedSend: null, restoreDraft: state.queuedSend }
          : {}),
      };
      if (msg.code !== "SESSION_BUSY") {
        return errored;
      }
      // 记录-06：UI 在 result 就解锁了，宿主却要等进程退出（实测 ≥2.3s）——这段窗口里发出的
      // 消息会被拒。它压根没被接受，但重发不该让用户动手：保留该轮、不弹横幅，文案提示后由
      // App 定时器 fireRetry 重发同一条（1 秒一次，最多 RETRY_MAX_ATTEMPTS 次）。
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== "user") {
        return errored; // 末条不是自己刚发出的轮（异常序）→ 不越界处理
      }
      const attempts = state.pendingRetry?.attempts ?? 0;
      // 用尽次数、或用户已点中断（喊停后不得再自动重发）→ 退回输入框 + 横幅（M5 兜底口径）。
      // interrupt 后 turnStatus 停在 interrupting：本轮压根没被接受，不进 idle 会永久锁死输入。
      if (
        state.turnStatus === "interrupting" ||
        attempts >= RETRY_MAX_ATTEMPTS
      ) {
        return {
          ...errored,
          turnStatus: "idle",
          waitingSince: null,
          messages: state.messages.slice(0, -1),
          restoreDraft: last.text ?? "",
          statusDetail: "上一轮仍在收尾，消息未发出——已恢复输入内容，请重发",
        };
      }
      return {
        ...errored,
        errorBanner: null,
        errorCode: null,
        pendingRetry: { text: last.text ?? "", attempts },
        statusDetail: "上一轮收尾中…（1 秒后自动重发）",
      };
    }
    case "permissionRequest": {
      // §4.6 permissionRequest：卡带 requestId，重放/重复广播按 id 幂等去重
      if (typeof msg.requestId !== "string" || !msg.requestId) {
        return state;
      }
      if (state.pendingPermissions.some((p) => p.requestId === msg.requestId)) {
        return state;
      }
      return {
        ...state,
        pendingPermissions: [
          ...state.pendingPermissions,
          {
            requestId: msg.requestId,
            tool:
              typeof msg.tool === "string" && msg.tool ? msg.tool : "unknown",
            inputSummary:
              typeof msg.inputSummary === "string" ? msg.inputSummary : "",
            rawInput: msg.rawInput,
          },
        ],
      };
    }
    case "permissionResolved": {
      // §4.6 permissionResolved：卡已在别处结算（他实例作答 / 超时 / 该轮进程退出）→ 摘卡。
      // 缺这条分支时，后台实例里的卡会一直挂着（用户切过去看到一张「早已审批完」的卡）。
      if (typeof msg.requestId !== "string" || !msg.requestId) {
        return state;
      }
      if (
        !state.pendingPermissions.some((p) => p.requestId === msg.requestId)
      ) {
        return state; // 本实例没有这张卡（本地已摘/从未收到）→ 原样返回
      }
      return {
        ...state,
        pendingPermissions: state.pendingPermissions.filter(
          (p) => p.requestId !== msg.requestId,
        ),
      };
    }
    case "noteList": {
      // M7（§4.3）：选择器的已有笔记清单（最近修改在前由宿主排好）
      const picker = state.notePicker;
      if (!picker) {
        return state; // 未开选择器（清单为他处触发/迟到）→ 忽略
      }
      return {
        ...state,
        notePicker: { ...picker, notes: normalizeNoteList(msg.notes) },
      };
    }
    case "usageStats": {
      // R4-3：与 streamEvent/history 同口径——只管当前绑定会话的（多实例广播，各看各的）
      if (
        typeof msg.sessionId === "string" &&
        state.sessionId !== null &&
        msg.sessionId !== state.sessionId
      ) {
        return state;
      }
      // total 就地并入该会话的列表条目：显示口径只有一处（sessions[].usage），
      // 不另开字段，也就不会出现「累计有两个数」的分裂
      const sessions = isUsageStats(msg.total)
        ? state.sessions.map((s) =>
            s.id === msg.sessionId ? { ...s, usage: msg.total } : s,
          )
        : state.sessions;
      return {
        ...state,
        sessions,
        turnUsage: isUsageStats(msg.turn) ? msg.turn : state.turnUsage,
      };
    }
    case "balanceStatus": {
      // R4-3：宿主唯一真相（provider 判定 + 查询结果都在宿主侧）
      return {
        ...state,
        balance: {
          provider: msg.provider === "deepseek" ? "deepseek" : "unknown",
          balance: normalizeBalanceState(msg.balance),
        },
      };
    }
    case "uiPrefs": {
      return {
        ...state,
        showUsage: msg.showUsage !== false,
        workspaceMode:
          msg.workspaceMode === "collection" ? "collection" : "single",
      };
    }
    case "itemSearchResult": {
      // R7-B：@ 检索回执。query 原样回抄（同一时刻只有最后一次输入在途，
      // 过期回执不覆盖当前面板——去掉 @ 语境后是空串查询，落进 items 也无害）
      return { ...state, mention: mentionResults(state.mention, msg.items) };
    }
    case "refsResolved": {
      // R7-B：chips 解析回执（UI 按 itemKey 标红 missing 的 chip）
      return {
        ...state,
        mention: mentionRefsResolved(state.mention, msg.refs),
      };
    }
    case "diagReport": {
      // R9：/diag 回执——弹层没开就不落状态（与 commandList/instructions 同口径：
      // 避免一次过期回执在下次打开时冒充新内容）
      if (!state.diag) {
        return state;
      }
      return {
        ...state,
        diag: { text: typeof msg.text === "string" ? msg.text : "" },
      };
    }
    case "commandList": {
      // R7-C：命令清单回执——面板没开就不落状态（避免旧回执在下次打开时冒充新内容）
      if (!state.commands.open) {
        return state;
      }
      const commands = commandResults(state.commands, msg.commands);
      return {
        ...state,
        commands: {
          ...commands,
          items: filterCommands(commands.all, commands.query),
        },
      };
    }
    case "scopeResolved": {
      // R7-D：范围回执 → 一枚 chip（重选覆盖旧的；只在面板开/已选时落，避免脏回执）
      return { ...state, scope: scopeChipSet(state.scope, msg) };
    }
    case "sessionExported": {
      // R7-C：/export 回执——成功把落点写进状态行，失败横幅显示错误原文
      return msg.ok
        ? {
            ...state,
            statusDetail: `已导出：${msg.path ?? "（路径未知）"}`,
            errorBanner: null,
          }
        : {
            ...state,
            errorBanner: msg.error ?? "导出失败",
          };
    }
    case "instructions": {
      // R7-A：编辑器没开就不落状态（避免残留的旧回执在下次打开时冒充新内容）
      if (!state.instructions) {
        return state;
      }
      return {
        ...state,
        instructions: instructionsEditorLoad(state.instructions, msg),
      };
    }
    case "instructionsSaved": {
      if (!state.instructions) {
        return state;
      }
      return {
        ...state,
        instructions: instructionsEditorSaved(state.instructions, msg),
      };
    }
    case "noteSaved": {
      // M7（§4.3）：写入回执 {ok:true, noteKey} / {ok:false, code}
      if (msg.ok === true) {
        return {
          ...state,
          notePicker: null,
          statusDetail: `已存为笔记（${typeof msg.noteKey === "string" ? msg.noteKey : ""}）`,
        };
      }
      const code = typeof msg.code === "string" ? msg.code : "SAVE_FAILED";
      return {
        ...state,
        notePicker: null,
        errorBanner: `存笔记失败：${code}`,
        errorCode: code,
      };
    }
    default:
      return state;
  }
}

/**
 * 会话列表归约（§4.6 sessionList）：
 * - 归一坏条目（非对象/无 id 丢弃；缺字段补默认值）；
 * - **记录-02**：claudeSessionId / itemTitle / createdAt 原样保留（续接状态、列表标题与同条目多会话区分要用）；
 * - 绑定规则：未绑定、绑定的会话已不在列表（他处删除/索引重置）→ 绑到最新一条；
 *   「新建会话」在途（creatingSession）→ 绑定到最新一条（新建的必然最新）；
 *   **复查修-2**：算出的绑定若不属于当前文献（readerContext.itemKey）→ 再经 followReader
 *   收敛到该文献的会话（无则解绑）——上面两条取的是全量最新，可能是别文献的会话；
 * - **重绑即换视图**（BUG-22/23）：从一个会话换到另一个时，消息与 turn 状态属于旧会话——
 *   不收敛的话旧会话的 waiting 会永久禁用输入框（其进程被宿主 kill，终止事件又被
 *   sessionId 过滤），旧消息也会残留进新会话视图；
 * - 例外：null → 新会话 不回零视图——那是「无会话时 send 自动建的会话」（handleSend），
 *   turn 就属于它，乐观追加的 user 轮不能被清；
 * - 消息视图的实际内容由随后到达的 history 回放决定（main.ts 在绑定变化时拉）。
 */
function reduceSessionList(
  state: ChatState,
  raw: unknown,
  rawPinned?: unknown,
): ChatState {
  const sessions = normalizeSessions(raw);
  // R7-K：置顶集合随列表走（宿主 prefs 是唯一真相；缺省 → 保持既有值，老宿主形态不变）
  const pinnedSessions = Array.isArray(rawPinned)
    ? rawPinned.filter((id): id is string => typeof id === "string" && !!id)
    : state.pinnedSessions;
  const known =
    state.sessionId !== null && sessions.some((s) => s.id === state.sessionId);
  let sessionId = state.sessionId;
  if (state.creatingSession && sessions.length > 0) {
    sessionId = sessions[0].id;
  } else if (!known) {
    sessionId = sessions.length > 0 ? sessions[0].id : null;
  }
  const next: ChatState = {
    ...state,
    connected: true,
    sessions,
    sessionId,
    pinnedSessions,
    creatingSession: state.creatingSession ? false : state.creatingSession,
  };
  const bound: ChatState =
    sessionId === state.sessionId || state.sessionId === null
      ? next
      : {
          ...next,
          messages: [],
          pendingPermissions: [],
          turnStatus: "idle",
          waitingSince: null,
          statusDetail: "",
          // OBS-1：旧会话的错误横幅随之作废——被删会话的进程终止（「CLI 进程异常退出」）
          // 常先于 sessionList 到达，横幅留着就是换会话后也抹不掉的纯噪音
          errorBanner: null,
          errorCode: null,
          // 记录-06：待重发的原文属于旧会话，换绑定即作废（否则会重发到新会话）
          pendingRetry: null,
          // M7：笔记选择器挂在旧视图的 turn 上，换绑定即作废
          notePicker: null,
          // F6：档位是会话级设置，换绑定后未知（等新会话首轮 init 报告）
          permissionMode: null,
          // R4-3：「本轮」属于旧会话视图；累计从 sessions 条目读（下方 sessions 已换），不受影响
          turnUsage: null,
        };
  // 既有例外：无会话时 send 自动建的会话（handleSend）——在途乐观轮就属于它，不换视图
  if (state.sessionId === null && state.turnStatus !== "idle") {
    return bound;
  }
  // 复查修-2：绑定必须尊重当前文献——上面的「未绑定 → 绑最新一条」取的是**全量最新**，
  // 可能是别的文献的会话。readerContext 先到（此时 sessions 还空，followReader 无处可跟）
  // 与 sessionList 先到/刷新两种到达顺序，都在这里收敛到当前文献的会话（顺序无关，一处修两路）。
  // followReader 契约原样：同文献已绑定 → 原对象返回，不抢用户手选。
  return bound.readerContext?.itemKey
    ? followReader(bound, bound.readerContext.itemKey).state
    : bound;
}

function normalizeSessions(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== "string") {
      continue;
    }
    out.push({
      id: s.id,
      title: typeof s.title === "string" ? s.title : "",
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
      // 记录-02 同款：归一不丢字段（缺省 0 → 列表显示「--」，不崩）
      createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
      itemKey: typeof s.itemKey === "string" ? s.itemKey : null,
      claudeSessionId:
        typeof s.claudeSessionId === "string" ? s.claudeSessionId : null,
      itemTitle: typeof s.itemTitle === "string" ? s.itemTitle : null,
      // R7-K：分支字段与合集名必须归一保留——丢了它们会话列表的分支缩进与抽屉分组静默退化
      //（真机实测：分支 row 的 depth 恒为 0、抽屉里全落「未分类」）。条件展开保持旧形态不变。
      ...(typeof s.parentId === "string" && s.parentId
        ? { parentId: s.parentId }
        : {}),
      ...(typeof s.branchIndex === "number"
        ? { branchIndex: s.branchIndex }
        : {}),
      ...(typeof s.collectionName === "string" && s.collectionName
        ? { collectionName: s.collectionName }
        : {}),
      // R4-3：用量只在宿主给出合法值时带上（无该字段 = 无数据，UI 不显示该段）。
      // 条件展开而非写 undefined：键存在会打破既有形态断言（deepEqual）与「无数据」语义
      ...(isUsageStats(s.usage) ? { usage: s.usage } : {}),
    });
  }
  return out;
}

function normalizeNoteList(raw: unknown): NoteSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: NoteSummary[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const n = entry as Record<string, unknown>;
    if (typeof n.noteKey !== "string") {
      continue;
    }
    out.push({
      noteKey: n.noteKey,
      title: typeof n.title === "string" ? n.title : "",
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : 0,
    });
  }
  return out;
}

function reduceHistory(
  state: ChatState,
  messages:
    | { role: "user" | "assistant"; text: string; ts: number }[]
    | unknown,
): ChatState {
  if (!Array.isArray(messages)) {
    return state;
  }
  const turns: Turn[] = [];
  for (const m of messages) {
    if (
      typeof m !== "object" ||
      m === null ||
      ((m as { role?: unknown }).role !== "user" &&
        (m as { role?: unknown }).role !== "assistant") ||
      typeof (m as { text?: unknown }).text !== "string"
    ) {
      continue;
    }
    turns.push({ role: m.role, text: m.text });
  }
  // BUG-23/26：回放必须照常应用（否则切过去看不到该会话上下文），但进行中 turn 的在途轮次
  // 只存在于本视图（宿主 history 里还没有），整份替换会把它抹掉——接在回放之后保留。
  // 旧实现是「turn 非 idle 就整份丢回放」，切会话后立即发送会丢上下文。
  const merged =
    state.turnStatus === "idle"
      ? turns
      : [...turns, ...inFlightTurns(state.messages)];
  return { ...state, messages: merged };
}

/** 在途 turn 的轮次：末条 user 轮起（含）到结尾——userSend 乐观追加的那轮及其流式产物 */
function inFlightTurns(messages: Turn[]): Turn[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages.slice(i);
    }
  }
  return [];
}

// ---- streamEvent 归约（§4.2 映射表的 UI 侧半边）----

export function reduceStreamEvent(
  state: ChatState,
  event: StreamEvent,
): ChatState {
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.kind !== "string"
  ) {
    return state;
  }
  // BUG-09：turn 已终止（result/procError/resultError 落 idle）后的迟到流事件一律忽略，
  // 不得把 turnStatus 拉回 streaming 卡住 UI；正常流事件只会发生在 waiting/streaming/interrupting 期间
  if (state.turnStatus === "idle") {
    return state;
  }
  // 记录-06：流事件到达 = 自动重发的那条已被宿主接受（被 SESSION_BUSY 拒的轮不产生任何流事件）
  // → 停止重试。statusDetail 里的「上一轮收尾中…」随之作废，由本事件自己的文案接管。
  if (state.pendingRetry !== null) {
    state = { ...state, pendingRetry: null, statusDetail: "" };
  }
  switch (event.kind) {
    case "init": {
      // F6：CLI 报告的档位是权威值（宿主按索引拼 --permission-mode，用户切换在下一轮生效）。
      // R5：CLI 报的是 "bypassPermissions"，映射回内部 id "bypass" 顶栏才认（否则显示成未知档）
      const reported =
        typeof event.permissionMode === "string" && event.permissionMode
          ? cliPermissionModeToId(event.permissionMode)
          : state.permissionMode;
      return {
        ...state,
        permissionMode: reported,
        statusDetail: `模型 ${event.model} · 权限档 ${reported ?? ""}`,
        turnStatus: "streaming",
      };
    }
    case "messageStart": {
      const turn: Turn = { role: "assistant", blocks: [] };
      return {
        ...state,
        messages: [...state.messages, turn],
        turnStatus: "streaming",
      };
    }
    case "textBlockStart":
      return updateLastAssistant(state, (blocks) =>
        hasBlock(blocks, event.index, "text")
          ? blocks
          : [
              ...blocks,
              {
                blockType: "text",
                index: event.index,
                text: "",
                streaming: true,
              },
            ],
      );
    case "textDelta": {
      if (typeof event.text !== "string") {
        return state; // §4.2：text 非字符串 → 丢该 delta
      }
      return updateLastAssistant(state, (blocks) =>
        appendToBlock(blocks, event.index, "text", event.text),
      );
    }
    case "thinkingDelta": {
      if (typeof event.text !== "string") {
        return state;
      }
      return updateLastAssistant(state, (blocks) =>
        appendToBlock(blocks, event.index, "thinking", event.text),
      );
    }
    case "toolBlockStart":
      return updateLastAssistant(state, (blocks) =>
        hasBlock(blocks, event.index, "tool")
          ? blocks
          : [
              ...blocks,
              {
                blockType: "tool",
                index: event.index,
                toolName:
                  typeof event.toolName === "string"
                    ? event.toolName
                    : "unknown",
                toolUseId:
                  typeof event.toolUseId === "string" ? event.toolUseId : "",
                inputJson: "",
                result: null,
                streaming: true,
              },
            ],
      );
    case "toolInputDelta": {
      if (typeof event.jsonFragment !== "string") {
        return state;
      }
      return updateLastAssistant(state, (blocks) =>
        blocks.map((b) =>
          b.blockType === "tool" && b.index === event.index
            ? { ...b, inputJson: b.inputJson + event.jsonFragment }
            : b,
        ),
      );
    }
    case "toolResult": {
      if (typeof event.toolUseId !== "string") {
        return state;
      }
      // tool_use 块可能在上一个 assistant turn（tool_result 在下一消息回流），全局按 id 找
      let found = false;
      const messages = state.messages.map((t) => {
        if (!t.blocks || found) {
          return t;
        }
        if (
          t.blocks.some(
            (b) => b.blockType === "tool" && b.toolUseId === event.toolUseId,
          )
        ) {
          found = true;
          return {
            ...t,
            blocks: t.blocks.map((b) =>
              b.blockType === "tool" && b.toolUseId === event.toolUseId
                ? {
                    ...b,
                    result: {
                      isError: event.isError === true,
                      summary: String(event.summary ?? ""),
                    },
                    streaming: false,
                  }
                : b,
            ),
          };
        }
        return t;
      });
      return found ? { ...state, messages } : state;
    }
    case "assistantMessage":
      // §4.2：校准最终块状态（content[] 为权威最终文本/入参）
      return calibrateBlocks(state, event.content);
    case "apiRetry":
      return {
        ...state,
        turnStatus: "streaming",
        statusDetail: `API 重试中 (${event.attempt}/${event.maxRetries}，${event.delayMs}ms 后重试)`,
      };
    case "result": {
      // BUG-08：数值字段畸形（字符串/null/NaN）按 0 缺省，绝不抛 TypeError
      const cost = finiteNumber(event.costUsd);
      const ms = finiteNumber(event.durationMs);
      const turns = finiteNumber(event.numTurns);
      return {
        ...state,
        turnStatus: "idle",
        waitingSince: null,
        statusDetail: `完成 · ${turns} 轮 · $${cost.toFixed(4)} · ${(ms / 1000).toFixed(1)}s`,
        // turn 结束 = 宿主侧在途权限请求已被端点按 deny 结掉（closeTurn），卡留着点也没用
        pendingPermissions: [],
      };
    }
    case "resultError": {
      // BUG-08：errors 非数组 → 单值包裹或空数组；与未知 kind 忽略不崩同风格
      const errors = normalizeErrorList(event.errors);
      return {
        ...state,
        turnStatus: "idle",
        waitingSince: null,
        pendingPermissions: [],
        errorBanner: `turn 失败 (${String(event.subtype)})${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`,
      };
    }
    case "procError": {
      if (event.reason === "CLAUDE_NOT_FOUND") {
        return {
          ...state,
          turnStatus: "idle",
          waitingSince: null,
          pendingPermissions: [],
          errorBanner:
            "未找到 claude CLI（CLAUDE_NOT_FOUND）。请安装 Claude Code 并确认 PATH 可用，或设置 cliPathOverride。",
        };
      }
      const tail =
        typeof event.stderrTail === "string" && event.stderrTail
          ? `\n${event.stderrTail.slice(-500)}`
          : "";
      return {
        ...state,
        turnStatus: "idle",
        waitingSince: null,
        pendingPermissions: [],
        errorBanner: `CLI 进程异常退出 (exit ${event.exitCode ?? "?"})${tail}`,
      };
    }
    default:
      // §4.6 前向兼容：未知 kind 忽略不崩
      return state;
  }
}

type BlockUpdater = (blocks: TurnBlock[]) => TurnBlock[];

function updateLastAssistant(
  state: ChatState,
  update: BlockUpdater,
): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant" || !last.blocks) {
    // 没有进行中的 assistant turn（丢帧/重连场景）：补一个再应用
    const created: Turn = { role: "assistant", blocks: update([]) };
    return {
      ...state,
      messages: [...state.messages, created],
      turnStatus: "streaming",
    };
  }
  const blocks = update(last.blocks);
  if (blocks === last.blocks) {
    return state;
  }
  const messages = [...state.messages];
  messages[messages.length - 1] = { ...last, blocks };
  return { ...state, messages };
}

function hasBlock(
  blocks: TurnBlock[],
  index: number,
  type: "text" | "thinking" | "tool",
): boolean {
  return blocks.some((b) => b.index === index && b.blockType === type);
}

function appendToBlock(
  blocks: TurnBlock[],
  index: number,
  type: "text" | "thinking",
  text: string,
): TurnBlock[] {
  const exists = hasBlock(blocks, index, type);
  return blocks
    .map((b) => {
      if (b.index !== index) {
        return b;
      }
      if (b.blockType === type) {
        return { ...b, text: b.text + text, streaming: true };
      }
      return b;
    })
    .concat(
      // textBlockStart 丢失（丢帧）时按事件类型隐式建块
      exists
        ? []
        : [{ blockType: type, index, text, streaming: true } as TurnBlock],
    );
}

/** 类型化按下标取块：index 与类型都匹配才算同一块（index 相同但类型不同的块是另一条流式块） */
function findBlock<K extends TurnBlock["blockType"]>(
  blocks: TurnBlock[],
  index: number,
  type: K,
): Extract<TurnBlock, { blockType: K }> | undefined {
  return blocks.find(
    (b): b is Extract<TurnBlock, { blockType: K }> =>
      b.index === index && b.blockType === type,
  );
}

function calibrateBlocks(state: ChatState, content: unknown): ChatState {
  if (!Array.isArray(content)) {
    return state;
  }
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant" || !last.blocks) {
    return state;
  }
  const blocks: TurnBlock[] = last.blocks
    .filter((b) => b != null)
    .map((b) => ({ ...b, streaming: false }));
  /** content 声明为 text 的 index → 文本（BUG-28/E4b 判定依据；先整体扫一遍，错位残影识别也要用） */
  const declaredTexts = new Map<number, string>();
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (typeof item !== "object" || item === null) {
      continue;
    }
    if (
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      declaredTexts.set(i, item.text);
    }
  }
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const type = (item as { type?: unknown }).type;
    if (
      type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const text = item.text;
      // 按「index + 类型」找既有块：index 相同但类型不同的块是另一条流式块，绝不能顶掉（E4b 的 thinking）
      const own = findBlock(blocks, i, "text");
      if (own) {
        own.text = text;
      } else {
        // 错位残影：同一段流式正文只是占了别的 index（真机：thinking 占 0、正文流在 1，末次
        // content 却把正文声明在 0）。**就地改身份**（index/文本）而非另建一块——渲染顺序仍等于
        // 流式顺序（正文不会被甩到工具卡后面），下面「只信 content 声明」的过滤也不会把它当残留删。
        // 只认同样文本、且自身不是「已声明匹配」的块（防把别处合法声明块搬走）。
        const twin = blocks.find(
          (b): b is Extract<TurnBlock, { blockType: "text" }> =>
            b.blockType === "text" &&
            b.text === text &&
            declaredTexts.get(b.index) !== b.text,
        );
        if (twin) {
          twin.index = i;
        } else {
          blocks.push({ blockType: "text", index: i, text, streaming: false });
        }
      }
    } else if (
      type === "thinking" &&
      typeof (item as { thinking?: unknown }).thinking === "string"
    ) {
      const own = findBlock(blocks, i, "thinking");
      if (own) {
        own.text = item.thinking;
        own.streaming = false;
      } else {
        // 按下标补建走追加，不写 array 位 i（E4b：位 i 可能被流式块占着，按位写会把 thinking 顶掉）
        blocks.push({
          blockType: "thinking",
          index: i,
          text: item.thinking,
          streaming: false,
        });
      }
    } else if (type === "tool_use") {
      const input = (item as { input?: unknown }).input;
      const inputJson = input === undefined ? "" : safeStringify(input);
      const itemId = String((item as { id?: unknown }).id ?? "");
      const own = findBlock(blocks, i, "tool");
      // toolUseId 才是工具的身份，index 不是——下标错位（如 content 压缩掉 thinking）时，
      // 位 i 上的流式块可能压根是另一把工具：按位更新会把 A 的入参写进 B 的卡。
      // id 齐备且不等 → 走追加（同 id 重复由下面按 id 收敛）；id 缺失（畸形 event）→ 退回按位配对。
      if (
        own &&
        (own.toolUseId === "" || itemId === "" || own.toolUseId === itemId)
      ) {
        own.inputJson = inputJson;
        own.toolName = String(
          (item as { name?: unknown }).name ?? own.toolName,
        );
      } else {
        // 按下标补建走追加，不顶掉同 index 的流式块（流式那份还挂着 toolResult 回填）
        blocks.push({
          blockType: "tool",
          index: i,
          toolName: String((item as { name?: unknown }).name ?? "unknown"),
          toolUseId: itemId,
          inputJson,
          result: null,
          streaming: false,
        });
      }
    }
  }
  // BUG-28：流式 content_block 下标与最终 content[] 下标可能整体错位——实测（m6-retest R2b）：
  // 流式 thinking 占 index 0、正文在 index 1，而最终 content 只列 [text]（下标 0）。上面按 index
  // 校准后正文被重建到 index 0，流式残留的 text@1 却原样留着 → 同一段正文两个 text 块，
  // MessageList 逐块渲染即显示两遍。判定只取「content 声明的文本」：text 块仅当其 index 被声明为
  // text 且文本与声明一致才留存——不符的（错位残留）与同 index 重复的（appendToBlock 允许同
  // index 不同 type 共存，calibrate 再按位置写入时会出现两个 text@i）一律丢弃。
  // content 未声明任何 text（空消息/只含工具）时不做清理，防误删；thinking 块一概不动。
  // 工具卡另有「同一 tool_use 只留一张」的收敛（下标错位会让校准补建的卡与流式原卡共存，
  // 渲染成两张内容相同的工具卡）——身份只认 toolUseId，不认 index。
  const compact: TurnBlock[] = [];
  const seenTextIdx = new Set<number>();
  /** toolUseId → 该卡在 compact 里的位置（空 id 不参与收敛，防把畸形块误并成一卡） */
  const toolAt = new Map<string, number>();
  for (const b of blocks) {
    if (b == null) {
      continue;
    }
    if (b.blockType === "text" && declaredTexts.size > 0) {
      if (declaredTexts.get(b.index) !== b.text || seenTextIdx.has(b.index)) {
        continue;
      }
      seenTextIdx.add(b.index);
    } else if (b.blockType === "tool" && b.toolUseId !== "") {
      const at = toolAt.get(b.toolUseId);
      if (at !== undefined) {
        // 同一 tool_use 的重复块：只留一份，优先留已回填 toolResult 的那份（流式原块——
        // toolResult 事件按 toolUseId 回填，重复块会把它引到没有结果的那张卡上）
        const kept = compact[at];
        if (
          kept.blockType === "tool" &&
          kept.result === null &&
          b.result !== null
        ) {
          compact[at] = b;
        }
        continue;
      }
      toolAt.set(b.toolUseId, compact.length);
    }
    compact.push(b);
  }
  const messages = [...state.messages];
  messages[messages.length - 1] = { ...last, blocks: compact };
  return { ...state, messages };
}

function finiteNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeErrorList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x));
  }
  return v == null ? [] : [String(v)];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

// ---- UI 动作 ----

/** assistant turn 渲染内容分流：有块走块流；无块（history 回放，§4.5）走 markdown 文本（BUG-07） */
export function assistantTurnContent(
  turn: Turn,
):
  | { kind: "blocks"; blocks: TurnBlock[] }
  | { kind: "markdown"; text: string } {
  if (turn.blocks && turn.blocks.length > 0) {
    return { kind: "blocks", blocks: turn.blocks };
  }
  return { kind: "markdown", text: turn.text ?? "" };
}

/** 发送用户消息：空/纯空白文本 → 无动作（§4.6：UI 侧忽略，按钮本就禁用） */
export function userSend(
  state: ChatState,
  text: string,
  refs?: string[] | null,
  scope?: SendScope | null,
  attachments?: readonly AttachmentPayload[] | null,
): { state: ChatState; msg: UiMessage | null } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { state, msg: null };
  }
  if (state.turnStatus !== "idle") {
    return { state, msg: null }; // 并发契约：进行中不排队（§4.6），按钮此时已禁用
  }
  // 记录-06：自动重发被用户的新发送取代——被拒的那轮从未被宿主接受，退回防幽灵轮
  //（重试期间末条必为该 user 轮；只重发「自己当前这条」，不替历史消息排队）
  let messages = state.messages;
  if (state.pendingRetry !== null) {
    const last = messages[messages.length - 1];
    messages = last?.role === "user" ? messages.slice(0, -1) : messages;
  }
  // R7-J：附件随本轮发送（落盘与 prompt 注入都在宿主；这里只有名字/大小，路径等回执）
  const atts = (attachments ?? []).filter(
    (a): a is AttachmentPayload =>
      !!a && typeof a.name === "string" && !!a.name,
  );
  const turn: Turn = {
    role: "user",
    text,
    ...(atts.length > 0
      ? {
          // 安全修：消息里只留 token（宿主凭据）；绝对路径等落盘回执回来再补（reduceAttachmentSaved）
          attachments: atts.map((a) => ({
            name: a.name,
            sizeBytes: a.sizeBytes,
            ...(a.token ? { token: a.token } : {}),
          })),
        }
      : {}),
  };
  // R7-B：chips 的 key 随本轮发送（宿主解析成参考条目注入 prompt 并扩 --add-dir）；
  // 空数组不出现在消息里（旧宿主/旧测试的逐字形态不变）
  const keys = (refs ?? []).filter(
    (k): k is string => typeof k === "string" && !!k,
  );
  // R7-D：范围（chip 的 itemKeys + label + truncated）；无 chip 时字段不出现
  const scopePayload = scope && scope.itemKeys.length > 0 ? scope : null;
  return {
    state: {
      ...state,
      messages: [...messages, turn],
      turnStatus: "waiting",
      waitingSince: Date.now(),
      statusDetail: "",
      errorBanner: null,
      errorCode: null,
      restoreDraft: null,
      pendingRetry: null,
    },
    msg: {
      type: "send",
      sessionId: state.sessionId,
      text,
      ...(keys.length > 0 ? { refs: keys } : {}),
      ...(scopePayload ? { scope: scopePayload } : {}),
      ...(atts.length > 0 ? { attachments: atts } : {}),
    },
  };
}

/** send 消息上的范围载荷（与 types.ts 同形；避免各处重复写字面量） */
export type SendScope = NonNullable<
  Extract<UiMessage, { type: "send" }>["scope"]
>;

/**
 * 复查修-1：发送入口（userSend 的空绑定版本）。
 * sessionId=null（followReader 绑 null 后的常态：该文献还没有会话）时**不能**把原文交给宿主——
 * 宿主对缺省 sessionId 会落到「最近会话」（resolveSendTarget），还会因本轮 prompt 的 itemKey 不同
 * 把那条会话的归属静默改写成当前文献：消息进错会话、别人的会话被抢走，UI 无任何提示。
 * 改为走既有「新建会话」路径（同一条 createSession 消息 + creatingSession 在途语义），原文暂存
 * queuedSend，绑定经 sessionList 建立后由 flushQueuedSend 恰发一次（不丢消息、不重复发送）。
 * 已有新建在途（用户刚点过「新建会话」）→ 搭它的车，不重复建。
 */
export function sendWithAutoSession(
  state: ChatState,
  text: string,
  refs?: string[] | null,
  scope?: SendScope | null,
  attachments?: readonly AttachmentPayload[] | null,
): { state: ChatState; msg: UiMessage | null } {
  if (state.sessionId !== null) {
    return userSend(state, text, refs, scope, attachments); // 已绑定：既有路径原样
  }
  if (!text.trim() || state.turnStatus !== "idle") {
    return { state, msg: null }; // 与 userSend 同口径：空文本/进行中不排队（按钮本就禁用）
  }
  // R7-B/R7-D/R7-J：引用 key、范围、附件随暂存原文一起排队（chips 在排队期间会被清掉）
  const queued = {
    queuedSend: text,
    queuedSendRefs: refs ?? null,
    queuedSendScope: scope ?? null,
    queuedSendAttachments:
      attachments && attachments.length > 0 ? [...attachments] : null,
  };
  if (state.creatingSession) {
    return { state: { ...state, ...queued }, msg: null }; // 搭上在途的新建，等绑定
  }
  const begun = beginCreateSession(state);
  return { state: { ...begun.state, ...queued }, msg: begun.msg };
}

/** 复查修-1：绑定建立后把暂存原文发出去（恰一次）。无暂存/未绑定/进行中 → 无动作 */
export function flushQueuedSend(state: ChatState): {
  state: ChatState;
  msg: UiMessage | null;
} {
  const text = state.queuedSend;
  if (
    text === null ||
    state.sessionId === null ||
    state.turnStatus !== "idle"
  ) {
    return { state, msg: null };
  }
  return userSend(
    {
      ...state,
      queuedSend: null,
      queuedSendRefs: null,
      queuedSendScope: null,
      queuedSendAttachments: null,
    },
    text,
    state.queuedSendRefs,
    state.queuedSendScope,
    state.queuedSendAttachments,
  );
}

/**
 * 记录-06：重发被 SESSION_BUSY 拒掉的那条（App 按 RETRY_DELAY_MS 定时驱动）。
 * 置 waiting 让被接受的流事件照常应用；被接受的最早证据是流事件到达（reduceStreamEvent 清标记），
 * 再次被拒则由 error 分支记一次 attempts 并重新置位。
 */
export function fireRetry(state: ChatState): {
  state: ChatState;
  msg: UiMessage | null;
} {
  const pending = state.pendingRetry;
  if (!pending || state.turnStatus !== "idle") {
    return { state, msg: null };
  }
  return {
    state: {
      ...state,
      pendingRetry: { text: pending.text, attempts: pending.attempts + 1 },
      turnStatus: "waiting",
      waitingSince: Date.now(),
      statusDetail: "",
    },
    msg: { type: "send", sessionId: state.sessionId, text: pending.text },
  };
}

/**
 * 切换会话（点列表项）：清空本视图并请求历史回放（§4.6 getHistory），随后 history 消息重建消息列表。
 * 进行中的 turn 属于原会话：宿主侧进程照跑，其事件被 streamEvent 的 sessionId 过滤挡住，
 * 完成后仍会落进该会话的历史——切回去即能看到（视图状态归零，不等同于宿主状态归零）。
 */
export function selectSession(
  state: ChatState,
  id: string,
): { state: ChatState; msg: UiMessage } {
  return {
    state: switchView(state, id),
    msg: { type: "getHistory", sessionId: id },
  };
}

/**
 * 换视图归零（selectSession / followReader 共用，R4-1）：这些字段都是「旧会话的视图状态」，
 * 换绑定即整体作废——不收敛的话旧会话的 waiting 会永久禁用输入框、旧消息会串进新会话视图。
 */
function switchView(state: ChatState, sessionId: string | null): ChatState {
  return {
    ...state,
    sessionId,
    messages: [],
    // 卡的归属是原会话的在途 turn，换视图即作废
    pendingPermissions: [],
    turnStatus: "idle",
    waitingSince: null,
    statusDetail: "",
    errorBanner: null,
    errorCode: null,
    // 复查修-1：空绑定自动建会话在途时换视图 → 暂存原文还给输入框（不丢，也不串发到新绑定）；
    // 无暂存时与既有「清空 restoreDraft」同形（queuedSend 为 null）
    restoreDraft: state.queuedSend,
    // 记录-06：待重发的原文属于原会话，换视图即作废（否则会重发到新会话）
    pendingRetry: null,
    queuedSend: null,
    // M7：笔记选择器挂在原视图的 turn 上，换视图即作废
    notePicker: null,
    // F6：档位是会话级设置，换视图后未知（等新会话首轮 init 报告）
    permissionMode: null,
    // R4-3：「本轮」是会话级视图状态，换视图即清（累计用量从 sessions 条目读，不受影响）
    turnUsage: null,
    // R7-D：范围 chip 属于本轮（换视图清掉；新会话要重新选）
    scope: initialScopeState(),
    // R7-J：附件 chips 属于本轮（换视图清掉，免得发到别的会话去）
    attachments: initialAttachmentChips(),
    // R7-F：展开/「已复制」/编辑态是视图态，切会话即重置（不落盘、不进历史）
    actions: messageActionsReset(state.actions),
    // R7-C：命令面板收起（清单可留，重打 `/` 直接用）
    commands: commandPanelClose(state.commands),
    composerInsert: null,
    helpOpen: false,
    // R9：/diag 弹层挂的是某一次请求的回执，换视图即关（重开重采）
    diag: null,
  };
}

/** 该条目下的会话：itemKey 精确匹配（通用会话 itemKey=null 不算归属）。
 * updatedAt 缺失/非数的条目在有合法值时一律落选（脏数据不靠输入顺序赢），全无合法值取首条（不崩、不置空）。 */
function latestSessionFor(
  sessions: SessionSummary[],
  itemKey: string,
): SessionSummary | null {
  const own = sessions.filter((s) => s.itemKey === itemKey);
  if (own.length === 0) {
    return null;
  }
  let best: SessionSummary | null = null;
  for (const s of own) {
    if (typeof s.updatedAt !== "number" || !Number.isFinite(s.updatedAt)) {
      continue;
    }
    if (!best || s.updatedAt > best.updatedAt) {
      best = s;
    }
  }
  return best ?? own[0];
}

/**
 * R4 需求 1「会话跟随」（PLAN-R4 §2）：最上层 PDF 换了 → 会话跟到该条目下的最新会话（非新建）。
 * 纯函数：不建会话、不发消息。`changed` 只表示「真的切到了另一条会话」（调用方据此补发
 * getHistory）——绑到 null 只是把视图从旧会话上摘下来（清空视图，不拉历史也不新建）。
 * 当前会话已属于该条目时一律不动：用户手选的旧会话不该被「最新」抢走。
 */
export function followReader(
  state: ChatState,
  itemKey: string | null,
): { state: ChatState; changed: boolean } {
  if (itemKey === null) {
    return { state, changed: false };
  }
  const current = state.sessions.find((s) => s.id === state.sessionId);
  if (current?.itemKey === itemKey) {
    return { state, changed: false };
  }
  const sessionId = latestSessionFor(state.sessions, itemKey)?.id ?? null;
  if (sessionId === state.sessionId) {
    // 没变绑定（含本就未绑）→ 视图不必归零（空态/在途轮照旧）
    return { state, changed: false };
  }
  return {
    state: switchView(state, sessionId),
    // 裁决 A4：newSessionId !== oldSessionId && newSessionId !== null
    changed: sessionId !== state.sessionId && sessionId !== null,
  };
}

/**
 * 应答权限卡（§4.6 permissionResponse）：本地立即摘掉该卡（乐观），桥把决定回写端点。
 * allow=false 时 remember 无意义（§4.6 算法只在 allow && remember 时生成规则串）。
 */
export function permissionRespond(
  state: ChatState,
  requestId: string,
  allow: boolean,
  remember: boolean,
): { state: ChatState; msg: UiMessage } {
  return {
    state: {
      ...state,
      pendingPermissions: state.pendingPermissions.filter(
        (p) => p.requestId !== requestId,
      ),
    },
    msg: { type: "permissionResponse", requestId, allow, remember },
  };
}

/** 新建会话（§4.6 createSession）：itemKey 取当前阅读条目；结果经 sessionList 到达后绑定 */
export function beginCreateSession(state: ChatState): {
  state: ChatState;
  msg: UiMessage;
} {
  return {
    state: {
      ...state,
      creatingSession: true,
      errorBanner: null,
      errorCode: null,
    },
    msg: {
      type: "createSession",
      itemKey: state.readerContext?.itemKey ?? null,
    },
  };
}

/** 删除会话（§4.6 deleteSession）：本视图先不动，等宿主推 sessionList 后按绑定规则收敛 */
export function deleteSession(id: string): UiMessage {
  return { type: "deleteSession", sessionId: id };
}

/**
 * 重命名当前绑定的会话（§4.6 renameSession）：本视图不动，宿主的 sessionList 回执收敛视图。
 * 空标题（清空 = 放弃改名）或与现标题一致 → null（不发消息；标题截断口径在宿主侧）。
 */
export function renameSession(
  state: ChatState,
  title: string,
): UiMessage | null {
  if (state.sessionId === null) {
    return null;
  }
  const clean = title.trim();
  const current = state.sessions.find((s) => s.id === state.sessionId);
  if (!clean || clean === (current?.title ?? "")) {
    return null;
  }
  return { type: "renameSession", sessionId: state.sessionId, title: clean };
}

/**
 * 会话列表条目名（用户需求 2026-09-11：同一文献下的多个会话在列表里分不出来）。
 * 标题（自定义或首条消息自动生成）优先；无标题 → 「新会话」。以下两种情况补创建时间戳：
 *  - 该会话还没有标题（多条「新会话」彼此无法区分）；
 *  - 同一 itemKey 下不止一个会话——它们常是同一文献的同一问题（标题也一样）。
 * 时间戳只到分钟，而同条目下的同名会话可能在同一分钟内建出来（真机实测差 400ms 的两条），
 * 光靠时间仍分不开 → 再补一个按创建时间定序的序号（同一条目内同名者才加，避免噪音）。
 */
export function sessionLabel(s: SessionSummary, all: SessionSummary[]): string {
  const base = s.title || "新会话";
  const named = s.itemTitle ? `${s.itemTitle} · ${base}` : base;
  const group =
    s.itemKey === null ? [] : all.filter((x) => x.itemKey === s.itemKey);
  if (!(!s.title || group.length > 1)) {
    return named;
  }
  const label = `${named} · ${formatSessionTime(s.createdAt)}`;
  const sameName = group.filter((x) => (x.title || "新会话") === base);
  if (group.length <= 1 || sameName.length <= 1) {
    return label;
  }
  const ordered = [...sameName].sort(
    (a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
  return `${label} #${ordered.findIndex((x) => x.id === s.id) + 1}`;
}

/** 「mm-dd hh:mm」（本地时区，零填充）：会话区分用；无有效时间戳 → 「--」 */
export function formatSessionTime(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "--";
  }
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 切换当前会话权限档（F6：顶栏四档控件，PLAN §2 + R5 放任档）。
 * 宿主侧只更新索引，**下一轮 spawn 才生效**（§4.6）——UI 立即回显所选档位并把
 * 「下一轮生效」写进状态行，免得用户以为本轮中途就改了。未绑定会话时无动作
 *（宿主对未知 sessionId 只会忽略，发了也是白发）。
 */
export function setPermissionMode(
  state: ChatState,
  mode: PermissionMode,
): { state: ChatState; msg: UiMessage | null } {
  if (state.sessionId === null) {
    return { state, msg: null };
  }
  return {
    state: {
      ...state,
      permissionMode: mode,
      statusDetail: `权限档已切到 ${mode}（下一轮生效）`,
    },
    msg: { type: "setPermissionMode", sessionId: state.sessionId, mode },
  };
}

// ---- M7 笔记（§4.3）----

/**
 * 点「存为笔记」（某条 assistant turn）：打开选择器 + 拉该条目已有笔记清单（listNotes）。
 * 无绑定条目（通用会话/未打开 PDF）→ 无动作（按钮本就禁用）。
 */
export function beginNoteSave(
  state: ChatState,
  turnIndex: number,
  html: string,
  origin: "turn" | "selection" = "turn",
): { state: ChatState; msg: UiMessage | null } {
  const itemKey = state.readerContext?.itemKey ?? null;
  if (!itemKey || !html.trim()) {
    return { state, msg: null };
  }
  const picker: NotePicker = { turnIndex, itemKey, html, notes: null };
  if (origin === "selection") {
    // 缺省不写这个键：消息行路径的 picker 形态与 M7 完全一致（既有夹具判等不变）
    picker.origin = "selection";
  }
  return {
    state: { ...state, notePicker: picker },
    msg: { type: "listNotes", itemKey },
  };
}

/** 选择器里选定目标：null = 新建笔记；否则追加到该 noteKey。发出即收起选择器（回执走 noteSaved） */
export function notePickerSelect(
  state: ChatState,
  noteKey: string | null,
): { state: ChatState; msg: UiMessage | null } {
  const picker = state.notePicker;
  if (!picker) {
    return { state, msg: null };
  }
  const msg: UiMessage =
    noteKey === null
      ? {
          type: "saveNote",
          itemKey: picker.itemKey,
          mode: "new",
          html: picker.html,
        }
      : {
          type: "saveNote",
          itemKey: picker.itemKey,
          mode: "append",
          noteKey,
          html: picker.html,
        };
  return {
    state: { ...state, notePicker: null, statusDetail: "存笔记中…" },
    msg,
  };
}

/** 关掉选择器（点「取消」/再点一次按钮） */
export function cancelNotePicker(state: ChatState): ChatState {
  return state.notePicker === null ? state : { ...state, notePicker: null };
}

// ---- 选择器展开后的形态（纯逻辑：UI 只负责画，形态与文案在这里定，单测直接覆盖）----

export interface NotePickerOption {
  kind: "new" | "append" | "cancel";
  /** 按钮文案 */
  label: string;
  /** 仅 append：目标笔记 key */
  noteKey?: string;
  /** 仅 append：完整标题（长标题被截断时挂在 title 上补全） */
  title?: string;
}

export interface NotePickerView {
  /** 按展示顺序：创建新笔记 → 各条「追加到《…》」→ 取消 */
  options: NotePickerOption[];
  /** 追加项缺席时的说明（清单还在路上 / 该条目暂无笔记）；null = 有追加项或没开选择器 */
  hint: string | null;
}

/** 追加项标题截断长度（与旧 UI 一致） */
const NOTE_LABEL_TITLE_MAX = 30;

/**
 * 选择器展开后的选项集合：永远给出「创建新笔记」与「取消」两条明路（用户反馈：
 * 点完按钮必须看得见「是新建还是追加」，不许静默走默认路径）；有笔记才列追加项。
 */
export function notePickerView(picker: NotePicker | null): NotePickerView {
  if (picker === null) {
    return { options: [], hint: null };
  }
  const options: NotePickerOption[] = [{ kind: "new", label: "创建新笔记" }];
  let hint: string | null = null;
  if (picker.notes === null) {
    hint = "读取笔记列表…";
  } else {
    for (const note of picker.notes) {
      options.push({
        kind: "append",
        noteKey: note.noteKey,
        title: note.title,
        label: `追加到《${note.title ? note.title.slice(0, NOTE_LABEL_TITLE_MAX) : "(无标题)"}》`,
      });
    }
    if (picker.notes.length === 0) {
      hint = "（该条目暂无笔记）";
    }
  }
  options.push({ kind: "cancel", label: "取消" });
  return { options, hint };
}

// ---- R7-A：指令编辑器（弹层状态在 ChatState.instructions；读写经桥往返宿主）----

/** 打开指令编辑器（默认全局作用域）→ 同时发 readInstructions 拉原文 */
export function openInstructions(state: ChatState): {
  state: ChatState;
  msg: UiMessage;
} {
  // 默认「全局」：根指令对所有文献生效，是最常用的一档（分类档一键可切）
  const scope: InstructionScope = "global";
  return {
    state: {
      ...state,
      instructions: initialInstructionsEditor(scope),
    },
    msg: { type: "readInstructions", scope },
  };
}

/** 切作用域（重读该作用域的原文；不关弹层） */
export function instructionsScopeChange(
  state: ChatState,
  scope: InstructionScope,
): { state: ChatState; msg: UiMessage | null } {
  if (!state.instructions) {
    return { state, msg: null };
  }
  const next = instructionsEditorSetScope(state.instructions, scope);
  if (next === state.instructions) {
    return { state, msg: null }; // 同档/非法值 → 无动作（不发请求）
  }
  return {
    state: { ...state, instructions: next },
    msg: { type: "readInstructions", scope: next.scope },
  };
}

/** 编辑正文 */
export function instructionsEdit(state: ChatState, text: string): ChatState {
  if (!state.instructions) {
    return state;
  }
  return {
    ...state,
    instructions: instructionsEditorEdit(state.instructions, text),
  };
}

/** 保存（超限由宿主拒绝，UI 只是转发；回执到达前编辑器保持打开） */
export function instructionsSave(state: ChatState): {
  state: ChatState;
  msg: UiMessage | null;
} {
  const editor = state.instructions;
  if (!editor) {
    return { state, msg: null };
  }
  return {
    state,
    msg: {
      type: "saveInstructions",
      scope: editor.scope,
      text: editor.text,
    },
  };
}

/**
 * 请求关闭：脏态需二次确认（closed=false 时 UI 弹确认，内容不丢）。
 * 关闭成功即整块清掉弹层状态（下次打开重新读盘）。
 */
export function instructionsClose(
  state: ChatState,
  opts?: { confirmDiscard?: boolean },
): { state: ChatState; closed: boolean } {
  if (!state.instructions) {
    return { state, closed: true };
  }
  const res = instructionsEditorClose(state.instructions, opts);
  if (!res.closed) {
    return { state, closed: false };
  }
  return { state: { ...state, instructions: null }, closed: true };
}

// ---- R7-C：`/` 命令面板（清单在宿主侧扫描；本地命令面板直接执行，自定义命令只插骨架）----

/** 打 `/` → 展开面板；还没清单时顺带向宿主拉一次（拉过就本地过滤，零往返） */
export function openCommandPanel(state: ChatState): {
  state: ChatState;
  msg: UiMessage | null;
} {
  return {
    state: { ...state, commands: commandPanelOpen(state.commands) },
    msg: state.commands.all.length === 0 ? { type: "listCommands" } : null,
  };
}

/** Esc / 离开 `/` 语境 → 收起（清单留着，下次打 `/` 直接用） */
export function closeCommandPanel(state: ChatState): ChatState {
  return { ...state, commands: commandPanelClose(state.commands) };
}

/** 关键词变化：本地过滤（前缀优先见 utils/commands.filterCommands） */
export function commandQueryChanged(
  state: ChatState,
  query: string,
): ChatState {
  const asked = commandQueryChange(state.commands, query);
  const items = filterCommands(state.commands.all, asked.query);
  return {
    ...state,
    commands: {
      ...asked,
      items,
      status: items.length > 0 ? "ready" : "empty",
    },
  };
}

/** ↑/↓ 移动键盘选中 */
export function commandActiveChanged(
  state: ChatState,
  index: number,
): ChatState {
  return {
    ...state,
    commands: commandActiveSet(state.commands, index),
  };
}

/**
 * 选中一条候选（PLAN §3.5 + 头部裁决 3）：本地命令 → 面板直接执行（action 交给 App，
 * **不往输入框插文本**）；自定义命令 → 骨架 `/名字 ` 进输入框（不发送）。
 * 非法选中 → 面板原样（不关、不插）。
 */
export function selectCommand(
  state: ChatState,
  cmd: unknown,
): { state: ChatState; action: string | null; insert: string | null } {
  let insert: string | null = null;
  const commands = commandAccept(state.commands, cmd, {
    insertText: (text) => {
      insert = text;
    },
  });
  const local = resolveLocalCommand(
    (cmd as { name?: unknown } | null | undefined)?.name,
  );
  // 骨架文本由 InputBox 就地替换（它才知道 `/名字` 片段的位置）；这里只回传值，不落状态
  return {
    state: {
      ...state,
      commands,
      ...(local?.action === "showHelp" ? { helpOpen: true } : {}),
    },
    action: local ? local.action : null,
    insert,
  };
}

/** InputBox 已把骨架文本放进输入框 → 清标记（防重复写入） */
export function consumeComposerInsert(state: ChatState): ChatState {
  return state.composerInsert === null
    ? state
    : { ...state, composerInsert: null };
}

/** 本地命令：清空当前视图的消息（不删会话——历史仍在磁盘上，重载可回放） */
export function clearView(state: ChatState): ChatState {
  return state.messages.length === 0 ? state : { ...state, messages: [] };
}

/** 本地命令：/help 帮助弹层开合 */
export function setHelpOpen(state: ChatState, open: boolean): ChatState {
  return state.helpOpen === open ? state : { ...state, helpOpen: open };
}

/**
 * 本地命令 /diag：打开报告弹层并请宿主采集（零 token、不发给 CLI）。
 * 载荷只有当前绑定会话 id（宿主据此报 session/sessionFile/snapshots 三项；null = 未绑定）；
 * 弹层先显示「采集中」，diagReport 回执到达后填文本。
 */
export function openDiag(state: ChatState): {
  state: ChatState;
  msg: UiMessage;
} {
  return {
    state: { ...state, diag: { text: null } },
    msg: { type: "diag", sessionId: state.sessionId },
  };
}

/** /diag 弹层关闭（报告文本随弹层丢弃；再开＝重新采集） */
export function closeDiag(state: ChatState): ChatState {
  return state.diag === null ? state : { ...state, diag: null };
}

/** 当前会话标题（导出文件名/标题用）：关联条目名 > 会话标题 > 「会话」 */
export function currentTitle(state: ChatState): string {
  const session = state.sessions.find((s) => s.id === state.sessionId);
  return state.readerContext?.title ?? session?.title ?? "会话";
}

/**
 * 本地命令 /export：把当前视图拼成 Markdown **源码**（不经 HTML 管道）。
 * 只导出视图里已有的内容（与界面所见一致）；divider 渲染为一条分隔线说明。
 */
export function sessionMarkdown(state: ChatState): string {
  const lines = [`# ${currentTitle(state)}`, ""];
  for (const turn of state.messages) {
    if (turn.role === "divider") {
      lines.push(`---`, `<!-- ${turn.text ?? ""} -->`, "");
      continue;
    }
    if (turn.role === "user") {
      lines.push("## 我", "", turn.text ?? "", "");
      continue;
    }
    const content = assistantTurnContent(turn);
    const text =
      content.kind === "markdown"
        ? content.text
        : content.blocks
            .filter((b) => b.blockType === "text")
            .map((b) => (b as { text: string }).text)
            .join("\n\n");
    lines.push("## Claude", "", text, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ---- R7-D：范围选择（chip 属于本轮，发送后清空）----

/**
 * 点「+ 范围」/选「当前分类全部|我在书库选中的」→ 展开选择并向宿主解析
 * （kind 是枚举，UI 不传 id/路径；每次选都重新取数，清单是快照不能拿旧的充数）
 */
export function requestScope(
  state: ChatState,
  kind: ScopeKind,
): { state: ChatState; msg: UiMessage } {
  return {
    state: { ...state, scope: scopePickerOpen(state.scope) },
    msg: { type: "resolveScope", kind },
  };
}

/** 收起范围选择（已选 chip 不丢） */
export function closeScopePicker(state: ChatState): ChatState {
  return { ...state, scope: scopePickerClose(state.scope) };
}

/** 点 chip 上的 × → 撤销范围（下一轮不再注入清单、不再扩 --add-dir） */
export function clearScope(state: ChatState): ChatState {
  return { ...state, scope: scopeChipClear(state.scope) };
}

/** 范围 chip 挂到 send 消息上的载荷（itemKeys 由宿主再白名单化 + 截断） */
export function scopePayload(
  state: ChatState,
): NonNullable<Extract<UiMessage, { type: "send" }>["scope"]> | null {
  const chip = state.scope.chip;
  return chip
    ? {
        kind: chip.kind,
        label: chip.label,
        itemKeys: chip.itemKeys,
        truncated: chip.truncated,
      }
    : null;
}

// ---- R7-F：消息级操作（复制/折叠的视图态在 App 侧用 lib/messageActions 归约）----

/** 点「编辑」：原文回填输入框（composerInsert 走既有回填通道）+ 标「待重发」 */
export function messageEditRequest(state: ChatState, index: number): ChatState {
  const r = messageEditStart(state.actions, state.messages, index);
  if (!r.ok) {
    return state;
  }
  // R7-J：编辑态把该消息当初的附件回填成 chips（可增可删，重发以新集合为准）。
  // 安全修：回填的是宿主下发的一次性 token（不是路径）；旧消息没有 token 时该 chip
  // 会在发送时被宿主拒绝并回人话原因（用户重新点「📎 附件」即可）。
  const original = state.messages[index]?.attachments ?? [];
  return {
    ...state,
    actions: r.state,
    composerInsert: r.state.composerText,
    attachments: attachmentChipsSet(
      original.map((a) =>
        pendingAttachment({
          name: a.name,
          sizeBytes: a.sizeBytes,
          token: a.token,
        }),
      ),
    ),
  };
}

/** 编辑态作废（用户又直接发新消息/切会话） */
export function cancelMessageEdit(state: ChatState): ChatState {
  return state.actions.editingIndex === null
    ? state
    : {
        ...state,
        actions: { ...state.actions, editingIndex: null, composerText: "" },
        // R7-J：编辑态带着的那批 chips 作废（下次发送是普通新消息，不该挂着上一条的附件）
        attachments: attachmentChipsClear(),
      };
}

// ---- R7-H/I：真回滚（编辑重发 / 消息分支）----
// 注：编辑重发不再走 R7-F 的「视图截断 + 保留旧消息」老口径（模型仍记得旧分支）——
// 现在由 editSessionRequest 走真回滚（§3.9），messageActions.editResend 仅留给宿主未接线时的纯视图用例。

/** 当前会话已拍快照的轮序号（sessionList 携带）；undefined = 宿主未接线回滚面 → 按钮不限制 */
export function currentSnapshotTurns(state: ChatState): number[] | undefined {
  const rec = state.sessions.find((s) => s.id === state.sessionId);
  return Array.isArray(rec?.snapshotTurns) ? rec.snapshotTurns : undefined;
}

/** 消息分支按钮状态（视图只读；下标非法/分隔条 → visible:false，快照缺失 → 禁用+原因） */
export function branchButtonStateFor(
  state: ChatState,
  index: number,
): BranchButtonState {
  return branchButtonState(state.messages, index, {
    snapshotTurns: currentSnapshotTurns(state),
  });
}

/**
 * 点「分支」（R7-I）：只产出 `branchSession`（宿主建分支会话），不替用户说话、
 * 不回填输入框。禁用/非法下标 → 不发消息。
 */
export function messageBranchRequest(
  state: ChatState,
  index: number,
): { state: ChatState; msg: UiMessage | null } {
  const r = messageBranchClick(
    {
      sessionId: state.sessionId,
      sessions: state.sessions,
      composerText: state.actions.composerText,
      editingIndex: state.actions.editingIndex,
    },
    state.messages,
    index,
    { snapshotTurns: currentSnapshotTurns(state) },
  );
  if (!r.message) {
    return { state, msg: null };
  }
  return {
    state: { ...state, branchPending: "branch" },
    msg: { ...r.message, sessionId: state.sessionId },
  };
}

/**
 * R7-H：编辑重发 = 真回滚（§3.9）——视图先截到该条**之前**（被编辑那条换成编辑后的文本，去掉
 * 「已编辑重发」分隔条），再让宿主分叉到该起点并把文本作为新分支首轮发出；原会话原样保留。
 */
export function editSessionRequest(
  state: ChatState,
  text: string,
  attachments?: readonly AttachmentPayload[] | null,
): { state: ChatState; msg: UiMessage | null } {
  const index = state.actions.editingIndex;
  if (index === null || !text.trim() || state.turnStatus !== "idle") {
    return { state, msg: null };
  }
  const turn = snapshotTurnForEdit(state.messages, index);
  if (turn === null) {
    return { state, msg: null };
  }
  const prefix = state.messages.slice(0, index);
  // R7-J：编辑态附件 = 当前 chips 的集合（进入编辑态时由原消息的附件回填，可增可删）；
  // 旧附件文件不删——历史消息仍引用它（删除动作根本不在编排里）
  const atts = (attachments ?? []).filter(
    (a): a is AttachmentPayload =>
      !!a && typeof a.name === "string" && !!a.name,
  );
  return {
    state: {
      ...state,
      messages: [
        ...prefix,
        {
          role: "user",
          text,
          ...(atts.length > 0
            ? {
                // 安全修：同 userSend——只留 token，路径等落盘回执
                attachments: atts.map((a) => ({
                  name: a.name,
                  sizeBytes: a.sizeBytes,
                  ...(a.token ? { token: a.token } : {}),
                })),
              }
            : {}),
        },
      ],
      turnStatus: "waiting",
      waitingSince: Date.now(),
      statusDetail: "",
      errorBanner: null,
      errorCode: null,
      restoreDraft: null,
      pendingRetry: null,
      branchPending: "edit",
      actions: { ...state.actions, editingIndex: null, composerText: "" },
    },
    msg: {
      type: "editSession",
      sessionId: state.sessionId,
      messageIndex: index,
      turn,
      text,
      ...(atts.length > 0 ? { attachments: atts } : {}),
    },
  };
}

/**
 * R7-J：附件落盘回执 → 把绝对路径与**宿主新下发的一次性 token**写回对应的用户轮
 * （编辑重发用 token，路径只作展示）。被拒条目在 chips 区提示人话原因。
 * 回执的 sessionId 不是当前视图 → 忽略（多实例广播时别把别人的路径写进来）。
 */
export function reduceAttachmentSaved(
  state: ChatState,
  evt: Extract<HostMessage, { type: "attachmentSaved" }>,
): ChatState {
  if (typeof evt.sessionId === "string" && evt.sessionId !== state.sessionId) {
    return state;
  }
  const rejected = Array.isArray(evt.rejected) ? evt.rejected : [];
  const withNotice =
    rejected.length > 0
      ? {
          ...state,
          attachments: {
            ...state.attachments,
            notice: rejected.map((r) => `${r.name}：${r.reason}`).join("；"),
          },
        }
      : state;
  const saved = Array.isArray(evt.saved) ? evt.saved : [];
  if (saved.length === 0) {
    return withNotice;
  }
  const byName = new Map(
    saved.map((s) => [s.name, { path: s.path, token: s.token }]),
  );
  for (let i = withNotice.messages.length - 1; i >= 0; i -= 1) {
    const turn = withNotice.messages[i];
    if (turn.role !== "user" || !turn.attachments?.length) {
      continue;
    }
    const messages = [...withNotice.messages];
    messages[i] = {
      ...turn,
      attachments: turn.attachments.map((a) => {
        const hit = byName.get(a.name);
        if (!hit) {
          return a;
        }
        return {
          ...a,
          path: hit.path,
          ...(hit.token ? { token: hit.token } : {}),
        };
      }),
    };
    return { ...withNotice, messages };
  }
  return withNotice;
}

/**
 * 安全修：「📎 附件」的宿主选择器回执 → chip（只有 token + 名字 + 体积，**没有路径**）。
 * 回执不属于本视图的会话（严格说没有会话概念）→ 直接进 chips；超限/超体积由 chips 逻辑提示。
 */
export function reduceAttachmentsPicked(
  state: ChatState,
  evt: Extract<HostMessage, { type: "attachmentsPicked" }>,
): ChatState {
  const files = (Array.isArray(evt.files) ? evt.files : []).map((f) =>
    pendingAttachment({ name: f.name, sizeBytes: f.sizeBytes, token: f.token }),
  );
  if (files.length === 0) {
    return state;
  }
  return {
    ...state,
    attachments: attachmentChipsAdd(state.attachments, files),
  };
}

/**
 * 分支回执：把新分支并进列表并切过去（后续消息都发在分支里；原会话仍在列表）。
 * 「分支」按钮路径视图从空开始（分支的旁挂历史是自己的）；编辑重发路径保留已截断的视图。
 */
export function reduceBranchCreated(
  state: ChatState,
  msg: Extract<HostMessage, { type: "branchCreated" }>,
): ChatState {
  // 宿主紧随其后会推 sessionList 收敛（这里先落一条，列表立即能看到分支）
  const rec: SessionSummary = {
    id: msg.sessionId,
    title: msg.title,
    updatedAt: Date.now(),
    itemKey:
      state.sessions.find((s) => s.id === state.sessionId)?.itemKey ?? null,
    claudeSessionId: null,
    parentId: msg.parentId,
    branchIndex: msg.branchIndex,
    snapshotTurns: [],
  };
  const keepView = state.branchPending === "edit";
  return {
    ...state,
    sessionId: msg.sessionId,
    sessions: [...state.sessions.filter((s) => s.id !== msg.sessionId), rec],
    branchPending: null,
    ...(keepView
      ? {}
      : {
          messages: [],
          pendingPermissions: [],
          turnStatus: "idle" as const,
          waitingSince: null,
          statusDetail: "",
          notePicker: null,
          turnUsage: null,
          permissionMode: null,
        }),
  };
}

/** 关闭错误横幅（banner 与 errorCode 同步清，免得「新建会话」按钮留在无错误的横幅上） */
export function dismissError(state: ChatState): ChatState {
  if (state.errorBanner === null && state.errorCode === null) {
    return state;
  }
  return { ...state, errorBanner: null, errorCode: null };
}

/** InputBox 已把恢复草稿放进输入框（记录-06），清标记防重复写入 */
export function consumeDraft(state: ChatState): ChatState {
  return state.restoreDraft === null ? state : { ...state, restoreDraft: null };
}

/** 中断：进入 interrupting 态直到 result/procError 解锁（§4.6 并发契约）。
 * BUG-17：不再要求 state.sessionId 非空（M4 无会话列表，sessionId 恒 null 会让按钮恒失效）；
 * 缺 sessionId 时照发，由宿主按「无进行中 turn → 忽略」自行判定。 */
export function interrupt(state: ChatState): {
  state: ChatState;
  msg: UiMessage | null;
} {
  if (state.turnStatus === "idle" || state.turnStatus === "interrupting") {
    return { state, msg: null };
  }
  // 记录-06：中断同时取消自动重发（用户喊停；重发在途时中断按钮才可见）
  return {
    state: { ...state, turnStatus: "interrupting", pendingRetry: null },
    msg: { type: "interrupt", sessionId: state.sessionId },
  };
}
