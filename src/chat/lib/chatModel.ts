// 聊天 UI 状态机（纯逻辑，无 DOM / 无 Preact / 无 Zotero）——node:test 可测。
// 职责：把桥消息（§4.6 宿主→UI）归约为可渲染状态。
// §4.6 兜底约定：未知 type / 未知 event.kind 一律原样返回 state（忽略不崩），
// 为 M5 会话列表 / M6 权限卡 / M7 笔记预留消息类型分发表。
import type {
  HostMessage,
  SessionSummary,
  StreamEvent,
  UiMessage,
} from "./types";

export type TurnStatus = "idle" | "waiting" | "streaming" | "interrupting";

/** 记录-06：SESSION_BUSY 自动重发的间隔与上限（超限退回输入框 + 横幅，即 M5 兜底口径） */
export const RETRY_DELAY_MS = 1000;
export const RETRY_MAX_ATTEMPTS = 5;

/** 权限档三档（PLAN §2：顶栏可切；§4.6 setPermissionMode 只认这三档，非法值宿主忽略） */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(v);
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
  role: "user" | "assistant";
  /** user turn 的原文 */
  text?: string;
  /** assistant turn 的块序列（content_block index 对应） */
  blocks?: TurnBlock[];
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
  /** M7：笔记选择器（打开的「存为笔记」弹层；null = 未打开） */
  notePicker: NotePicker | null;
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
    notePicker: null,
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
      return reduceSessionList(state, msg.sessions);
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
    case "readerContext":
      return {
        ...state,
        readerContext: {
          itemKey: msg.itemKey ?? null,
          title: msg.title ?? null,
          page: msg.page ?? null,
          selection: msg.selection ?? null,
        },
      };
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
 * - **重绑即换视图**（BUG-22/23）：从一个会话换到另一个时，消息与 turn 状态属于旧会话——
 *   不收敛的话旧会话的 waiting 会永久禁用输入框（其进程被宿主 kill，终止事件又被
 *   sessionId 过滤），旧消息也会残留进新会话视图；
 * - 例外：null → 新会话 不回零视图——那是「无会话时 send 自动建的会话」（handleSend），
 *   turn 就属于它，乐观追加的 user 轮不能被清；
 * - 消息视图的实际内容由随后到达的 history 回放决定（main.ts 在绑定变化时拉）。
 */
function reduceSessionList(state: ChatState, raw: unknown): ChatState {
  const sessions = normalizeSessions(raw);
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
    creatingSession: state.creatingSession ? false : state.creatingSession,
  };
  if (sessionId === state.sessionId || state.sessionId === null) {
    return next;
  }
  return {
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
  };
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
    case "init":
      return {
        ...state,
        // F6：CLI 报告的档位是权威值（宿主按索引拼 --permission-mode，用户切换在下一轮生效）
        permissionMode:
          typeof event.permissionMode === "string" && event.permissionMode
            ? event.permissionMode
            : state.permissionMode,
        statusDetail: `模型 ${event.model} · 权限档 ${event.permissionMode}`,
        turnStatus: "streaming",
      };
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
  const turn: Turn = { role: "user", text };
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
    msg: { type: "send", sessionId: state.sessionId, text },
  };
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
    state: {
      ...state,
      sessionId: id,
      messages: [],
      // 卡的归属是原会话的在途 turn，换视图即作废
      pendingPermissions: [],
      turnStatus: "idle",
      waitingSince: null,
      statusDetail: "",
      errorBanner: null,
      errorCode: null,
      restoreDraft: null,
      // 记录-06：待重发的原文属于原会话，换视图即作废（否则会重发到新会话）
      pendingRetry: null,
      // M7：笔记选择器挂在原视图的 turn 上，换视图即作废
      notePicker: null,
      // F6：档位是会话级设置，换视图后未知（等新会话首轮 init 报告）
      permissionMode: null,
    },
    msg: { type: "getHistory", sessionId: id },
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
 * 切换当前会话权限档（F6：顶栏三档控件，PLAN §2）。
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
): { state: ChatState; msg: UiMessage | null } {
  const itemKey = state.readerContext?.itemKey ?? null;
  if (!itemKey || !html.trim()) {
    return { state, msg: null };
  }
  return {
    state: {
      ...state,
      notePicker: { turnIndex, itemKey, html, notes: null },
    },
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
