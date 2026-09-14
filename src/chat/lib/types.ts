// 桥消息类型定义 — 对应 INTERFACE.md §4.6 / §4.2。
// M3 供前端 bundle 使用；M4 宿主侧 hostBridge 以此为准对齐（字段拼写与 stream-map 验收契约一致）。
// M3 只实现消息流/输入/错误渲染所需分支，其余类型按 §4.6 兜底约定「已知但暂不处理 → 忽略不崩」。

import type { UsageStats } from "./usage";
import type { InstructionScope } from "../../utils/instructions";
import type { MentionSearchItem, ResolvedRef } from "../../utils/mentions";
import type { CommandEntry } from "../../utils/commands";
import type { ScopeKind } from "../../utils/scope";

export type { UsageStats };
export type { InstructionScope, MentionSearchItem, ResolvedRef };
export type { CommandEntry, ScopeKind };

/**
 * R4-3：DeepSeek 余额状态（宿主 → UI 的 balanceStatus 载荷）。
 * unsupported / nokey 是「不请求」的两种前置态（provider 非 deepseek / 未填 Key），
 * 只显示说明文案；loading 是 UI 本地态（手动刷新在途），宿主从不发送。
 */
export type BalanceState =
  | { state: "loading" }
  | { state: "unsupported" }
  | { state: "nokey" }
  | {
      state: "ok";
      currency: string;
      total: string;
      all: { currency: string; total: string }[];
    }
  | { state: "error"; reason: string };

/** provider 判定（PLAN-R4 §4：baseUrl 或 model 含 deepseek → deepseek） */
export type BalanceProvider = "deepseek" | "unknown";

/** 余额查询结论（宿主 → UI） */
export interface BalanceStatus {
  provider: BalanceProvider;
  balance: BalanceState;
}

/** §4.6 错误码总表 */
export type BridgeErrorCode =
  | "CLAUDE_NOT_FOUND"
  | "CLAUDE_AUTH_FAILED"
  // R15：探测超时（会自动重试）与明确不可执行——与 cliDetect.CliStatusCode 对齐
  | "CLAUDE_PROBE_TIMEOUT"
  | "CLAUDE_EXEC_FAILED"
  | "WORKSPACE_UNAVAILABLE"
  | "SPAWN_FAILED"
  | "SESSION_BUSY"
  | "ITEM_NOT_FOUND"
  | "NOTE_NOT_FOUND"
  | "EMPTY_CONTENT"
  | "SANITIZE_REJECTED"
  | "SAVE_FAILED"
  | "SESSION_GONE"
  /** R7-H/I：回滚面错误（宿主未接线 / 有回滚在跑 / 快照或项目目录对不上 / 还原失败） */
  | "BRANCH_UNAVAILABLE"
  | "REWIND_BUSY"
  | "REWIND_REFUSED"
  | "REWIND_FAILED";

/** §4.2 标准事件（protocol.ts 映射产物，经 streamEvent 包装到达 UI） */
export type StreamEvent =
  | {
      kind: "init";
      claudeSessionId: string;
      model: string;
      permissionMode: string;
      tools: string[];
      mcpServers: string[];
    }
  | { kind: "messageStart" }
  | { kind: "textBlockStart"; index: number }
  | { kind: "textDelta"; index: number; text: string }
  | { kind: "thinkingDelta"; index: number; text: string }
  | {
      kind: "toolBlockStart";
      index: number;
      toolName: string;
      toolUseId: string;
    }
  | { kind: "toolInputDelta"; index: number; jsonFragment: string }
  | { kind: "assistantMessage"; content: unknown[] }
  | { kind: "toolResult"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "apiRetry"; attempt: number; maxRetries: number; delayMs: number }
  | {
      kind: "result";
      claudeSessionId: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { kind: "resultError"; subtype: string; errors: string[] }
  | {
      kind: "procError";
      exitCode: number | null;
      stderrTail?: string;
      reason?: string;
    };

/** §4.5 会话索引记录中 UI 关心的子集 */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** 创建时刻（ms）。同一文献下多会话的区分信息（列表补时间戳）用；旧宿主/旧测试数据可能缺省 */
  createdAt?: number;
  itemKey: string | null;
  /** CLI 侧 session_id（null = 首轮未完成，续接时 UI 可据此提示不可续）；M5 续接映射用 */
  claudeSessionId: string | null;
  /** 关联条目标题（宿主运行时经 Zotero.Items 解析，§2.4 不冗余存储）；无关联/查不到 → null */
  itemTitle?: string | null;
  /** R7-H/I：分支会话的父（插件会话 id）；顶层会话 null（老宿主可能不带该键） */
  parentId?: string | null;
  /** R7-H/I：同一父下的分支序号（1 起） */
  branchIndex?: number | null;
  /** R7-K：条目所属合集名（「全部会话」抽屉按它分组；无合集/查不到 → null） */
  collectionName?: string | null;
  /**
   * R7-H：该会话已拍快照的轮序号（消息分支按钮的可用性判定只看它）。
   * 老宿主/未接线不带该键 → UI 不限制（按钮可点，失败时由宿主回 error）。
   */
  snapshotTurns?: number[];
  /** R4-3：该会话累计用量（索引落盘值）；从未跑过带用量的轮 → 字段不出现（UI 不显示该段） */
  usage?: UsageStats;
}

/** 宿主 → UI（INTERFACE §4.6 宿主→UI 表） */
export type HostMessage =
  /** 握手首条；token = 本实例一次性凭据（页面 URL 同值，BUG-16） */
  | { type: "init"; token?: string }
  | {
      type: "sessionList";
      sessions: SessionSummary[];
      /** R7-K：置顶会话 id（本地 prefs 持久化，不限量、不受归档影响） */
      pinned?: string[];
    }
  /**
   * R7-J：附件落盘回执（saved 的 path 是绝对路径，UI 存进该条用户消息供编辑态复用；
   * rejected 带人话原因，UI 在 chips 区提示）。
   * token（安全修）：宿主为**已落盘文件**再登记的一次性凭据——编辑重发时 UI 只回传它
   * （UI 永不回传路径）。老宿主不带该字段 → 编辑重发的附件由宿主按无来源拒绝。
   */
  | {
      type: "attachmentSaved";
      sessionId: string;
      turn: number;
      saved: { name: string; path: string; size: number; token?: string }[];
      rejected: { name: string; reason: string }[];
    }
  /**
   * 安全修：宿主原生选择器选完文件的一次性凭据回执（`pickAttachments` 的应答）。
   * **只有凭据没有路径**：UI 拿它展示 chip、随发送回传；路径只活在宿主内存里。
   * 用户取消/宿主未接线 → files 为空数组。
   */
  | {
      type: "attachmentsPicked";
      files: { token: string; name: string; sizeBytes: number }[];
    }
  | { type: "streamEvent"; sessionId?: string; event: StreamEvent }
  | {
      type: "history";
      sessionId: string;
      messages: {
        role: "user" | "assistant";
        text: string;
        ts: number;
        /** R14：assistant 行的过程块（旧宿主/旧文件不带，UI 行为逐字不变） */
        blocks?: (
          | { blockType: "thinking"; text: string }
          | {
              blockType: "tool";
              toolName: string;
              inputJson: string;
              result: { isError: boolean; summary: string } | null;
            }
        )[];
      }[];
      /**
       * R14：该会话当前在途轮（宿主是唯一真相）。两个下发时机：换绑定时 handleGetHistory 的
       * 回执、开轮时 handleSend 的广播。缺省 = 无在途轮（老宿主不带该键，UI 行为逐字不变）。
       */
      inFlight?: {
        userText: string;
        assistantText: string;
        busy: "running" | "interrupting";
        /** 宿主接轮时该会话已落盘的历史行数（幂等键：回放行数 <= baseRows = 这轮还没落盘） */
        baseRows: number;
      };
    }
  /**
   * 输入历史（↑/↓ 翻已发送消息）的持久化回推：宿主落盘 <profile>/claudian/input-history.json，
   * 页面在会话桶首次加载时发 getInputHistory 请求，宿主按 sessionId 回这一条。
   * 面板重载后 ↑ 还能翻到旧消息，走的就是这条（chrome:// 页面没有 localStorage）。
   */
  | { type: "inputHistory"; sessionId: string; entries: string[] }
  | {
      type: "permissionRequest";
      requestId: string;
      tool: string;
      inputSummary: string;
      rawInput: unknown;
    }
  /**
   * 卡已结算（他实例作答 / 120s 超时 / 该轮进程退出）→ 各实例摘掉该卡。
   * 卡是广播给多实例的，缺这条通知时只有作答的那个实例摘卡，其余实例留残影。
   */
  | { type: "permissionResolved"; requestId: string }
  | { type: "noteSaved"; ok: boolean; noteKey?: string; code?: string }
  | {
      type: "noteList";
      notes: { noteKey: string; title: string; updatedAt: number }[];
    }
  | {
      type: "error";
      code: BridgeErrorCode | string;
      message: string;
      sessionId?: string;
    }
  | {
      type: "readerContext";
      itemKey: string | null;
      title: string | null;
      page: number | null;
      selection: string | null;
    }
  /**
   * R4-3：turn 收尾的用量广播。turn = 本轮（无用量数据 → null），total = 该会话累计
   * （索引落盘值 + 本轮）。UI 只认当前绑定会话的（与 streamEvent 同口径）。
   */
  | {
      type: "usageStats";
      sessionId: string;
      turn: UsageStats | null;
      total: UsageStats;
    }
  /** R4-3：余额状态（面板打开时推一次；refreshBalance 后回推） */
  | ({ type: "balanceStatus" } & BalanceStatus)
  /** R4-3：宿主侧 UI 相关 prefs（hello 注册后推一次；改动在面板重开时生效） */
  | {
      type: "uiPrefs";
      showUsage: boolean;
      workspaceMode?: "single" | "collection";
      /** R10：会话区展开态（缺省/老宿主 → 收起） */
      sessionsExpanded?: boolean;
    }
  /**
   * R7-A：读指令回执（PLAN §2）。文件不存在 → exists:false + text:"" + path 照给；
   * 读失败/越界 → error 原文 + text:""（UI 不显示半截状态）。
   */
  | {
      type: "instructions";
      scope: InstructionScope;
      path: string | null;
      text: string;
      exists: boolean;
      error?: string;
      /** 回落/降级说明（如无分类可归属 → 本次编辑的是工作区根指令） */
      notice?: string;
    }
  /** R7-A：保存回执（ok:false 带 error 原文；UI 保持脏态与弹层） */
  | {
      type: "instructionsSaved";
      scope: InstructionScope;
      ok: boolean;
      path?: string;
      error?: string;
    }
  /** R7-B：@ 检索回执（query 原样回抄，UI 据此丢弃过期结果） */
  | { type: "itemSearchResult"; query: string; items: MentionSearchItem[] }
  /** R7-B：chips 解析回执（missing:true = 查不到，UI 标红、发送时跳过） */
  | { type: "refsResolved"; refs: ResolvedRef[] }
  /**
   * R7-C：命令清单回执（PLAN §3.5）。每条 {name, description, source}，name 不带前导 `/`；
   * 宿主侧只扫固定两处 `.claude/commands`，本地命令另有白名单（不进这条消息）。
   */
  | { type: "commandList"; commands: CommandEntry[] }
  /**
   * R7-D：范围解析回执（PLAN §3.6）。items 与 resolveRefs 同形；truncated = 超过 40 篇被截断。
   */
  | {
      type: "scopeResolved";
      kind: ScopeKind;
      label: string;
      items: ResolvedRef[];
      truncated: boolean;
    }
  /** R7-C：/export 落盘回执（工作区内的 Markdown 源码；失败带 error 原文） */
  | { type: "sessionExported"; ok: boolean; path?: string; error?: string }
  /**
   * R7-I：分支会话已建好（宿主回执，紧跟在 branchSession / editSession 之后）。
   * UI 据此把分支并进列表并**自动切过去**；原会话不动。
   */
  | {
      type: "branchCreated";
      sessionId: string;
      parentId: string;
      branchIndex: number;
      title: string;
    }
  /**
   * R9：/diag 诊断报告（宿主只读采集后的成品文本，逐行 `键: 值`）。
   * 脱敏在宿主侧完成（utils/diag）：报告里不含任何密钥/令牌。
   */
  | { type: "diagReport"; text: string };

/** UI → 宿主（INTERFACE §4.6 UI→宿主表） */
export type UiMessage =
  /** 握手回执；token 回抄 init 携带的一次性凭据，宿主校验一致才注册实例（BUG-16） */
  | { type: "hello"; token?: string }
  /**
   * refs（R7-B）：本轮点名的文献 itemKey（来自 chips，≤20）。宿主发送前解析成参考条目注入
   * prompt，并把各条目的 PDF 目录并入 --add-dir（deny 同步覆盖，见 cliRunner）。
   */
  | {
      type: "send";
      sessionId?: string | null;
      text: string;
      refs?: string[];
      /**
       * R7-D：本轮范围注入（PLAN §3.6）。itemKeys 是 resolveScope 回执里的条目 key
       * （宿主发送前重新取数：已删的跳过），truncated 原样回抄用于区块标注。
       */
      scope?: {
        kind: ScopeKind;
        label: string;
        itemKeys: string[];
        truncated?: boolean;
      } | null;
      /**
       * R7-J：本轮附件（粘贴/选择文件）。**载荷里没有任何客户端路径**——
       * 「选择文件」由宿主弹原生选择器、路径只活在宿主内存（UI 拿一次性 token）；
       * 粘贴只能带 base64 字节。宿主侧的 sourcePath 字段一律忽略（安全修，见 hostBridge）。
       */
      attachments?: AttachmentPayload[];
    }
  /**
   * 安全修：请宿主机在**本窗口**弹原生文件选择器（路径绝不经过页面）。
   * 宿主把选中的文件登记进本窗口的一次性凭据表，回 `attachmentsPicked`。
   */
  | { type: "pickAttachments"; multiple?: boolean }
  /** sessionId 可空：M4 无会话列表时 UI 拿不到 id，宿主按「无进行中 turn → 忽略」处理（BUG-17） */
  | { type: "interrupt"; sessionId?: string | null }
  | {
      type: "permissionResponse";
      requestId: string;
      allow: boolean;
      remember: boolean;
    }
  | { type: "saveNote"; itemKey: string; mode: "new"; html: string }
  | {
      type: "saveNote";
      itemKey: string;
      mode: "append";
      noteKey: string;
      html: string;
    }
  | { type: "listNotes"; itemKey: string }
  | { type: "createSession"; itemKey?: string | null }
  | { type: "deleteSession"; sessionId: string }
  /** 重命名（宿主改名后推 sessionList 回执）；空标题/未知 id 宿主忽略 */
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "getHistory"; sessionId: string }
  /** 输入历史（↑/↓ 翻已发送消息）的宿主持久化：页面在会话桶首次加载时拉、每次发送后存 */
  | { type: "getInputHistory"; sessionId: string }
  | { type: "saveInputHistory"; sessionId: string; entries: string[] }
  | { type: "openExternal"; url: string }
  | {
      type: "setPermissionMode";
      sessionId: string;
      mode: "default" | "acceptEdits" | "plan" | "bypass";
    }
  /** R4-3：顶栏手动刷新余额（宿主 60s TTL 缓存之外强制重查；非 deepseek/无 Key 时宿主不发请求） */
  | { type: "refreshBalance" }
  /** R7-A：读指令（scope 是枚举，UI 永不传路径） */
  | { type: "readInstructions"; scope: InstructionScope }
  /** R7-A：写指令（宿主自行拼路径 + 归一化校验；超长/越界拒绝并回 error） */
  | { type: "saveInstructions"; scope: InstructionScope; text: string }
  /** R7-B：@ 检索（标题/作者/期刊/年份/分类名，只读） */
  | { type: "searchItems"; query: string }
  /** R7-B：chips → 注入用结构（发送前解析；查不到标 missing） */
  | { type: "resolveRefs"; itemKeys: string[] }
  /** R7-C：拉命令清单（宿主只扫两处固定目录，只读） */
  | { type: "listCommands" }
  /** R7-C：打开当前工作区目录（宿主按当前会话的条目解析 cwd 后 reveal） */
  | { type: "openWorkspace" }
  /**
   * R8：打开独立工作台标签页（「全页」）。无载荷——UI 只发这个动作，
   * 不传任何路径/命令名；宿主侧只接受已注册实例的这条消息（§4.6 同款门槛）。
   */
  | { type: "openFullPage" }
  /** R7-C：/export —— 把当前会话的 Markdown 源码落到工作区内（落点由宿主拼 + 净化） */
  | { type: "exportSession"; title: string; markdown: string }
  /** R7-D：解析范围（分类全部 / 书库选中）→ scopeResolved */
  | { type: "resolveScope"; kind: ScopeKind }
  /**
   * R7-I：以某条消息为界分叉（该消息**之后**为新起点）——只建会话，不替用户说话。
   * 载荷口径由 chat/lib/branchActions 定死（messageIndex/turn）；sessionId 由 App 发送时补。
   */
  | {
      type: "branchSession";
      sessionId?: string | null;
      messageIndex: number;
      turn: number;
    }
  /**
   * R7-H：编辑重发 —— 分叉到该用户消息**之前**的状态（turn = k−1），并把编辑后的文本
   * 作为新分支的首轮 prompt 发出（真回滚：模型记忆里也没有被编辑掉的内容）。
   */
  | {
      type: "editSession";
      sessionId?: string | null;
      messageIndex: number;
      turn: number;
      text: string;
      /** R7-J：编辑态增删后的附件集合（旧附件文件不删——历史消息还引用它） */
      attachments?: AttachmentPayload[];
    }
  /** R7-K：置顶/取消置顶（集合存本地 prefs，回执推 sessionList 的 pinned） */
  | { type: "setSessionPinned"; sessionId: string; pinned: boolean }
  /**
   * R10：会话区展开/收起（纯视图偏好，落本地 prefs；不回执、不推列表——
   * 面板内的展开态由 UI 本地先改，宿主只负责下次重开时经 uiPrefs 还原）。
   */
  | { type: "setSessionsExpanded"; expanded: boolean }
  /**
   * R9：/diag —— 请宿主采集本机事实并回一份诊断报告（diagReport）。
   * 载荷只有当前绑定的会话 id（宿主据此报告会话/会话文件/快照三项；null = 未绑定）；
   * 采集是只读的：不建会话、不落盘、不碰 CLI 会话文件（唯一子进程 = `claude --version`，3s 超时）。
   */
  | { type: "diag"; sessionId?: string | null }
  | { type: "getState" };

/**
 * R7-J：待落盘附件（UI→宿主）。**不含任何客户端路径**（安全修）：
 * - `token` = 宿主原生选择器登记的一次性凭据（路径只在宿主侧，用后即弃）
 * - `base64` = 粘贴剪贴板文件时的裸字节（不带 data URL 前缀）
 * 两者都没有的条目宿主按拒绝处理并回人话原因；`sourcePath` 之类的字段一律忽略。
 */
export interface AttachmentPayload {
  name: string;
  sizeBytes: number;
  token?: string;
  base64?: string;
}
