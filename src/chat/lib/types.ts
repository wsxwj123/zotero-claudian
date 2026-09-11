// 桥消息类型定义 — 对应 INTERFACE.md §4.6 / §4.2。
// M3 供前端 bundle 使用；M4 宿主侧 hostBridge 以此为准对齐（字段拼写与 stream-map 验收契约一致）。
// M3 只实现消息流/输入/错误渲染所需分支，其余类型按 §4.6 兜底约定「已知但暂不处理 → 忽略不崩」。

import type { UsageStats } from "./usage";

export type { UsageStats };

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
  | "WORKSPACE_UNAVAILABLE"
  | "SPAWN_FAILED"
  | "SESSION_BUSY"
  | "ITEM_NOT_FOUND"
  | "NOTE_NOT_FOUND"
  | "EMPTY_CONTENT"
  | "SANITIZE_REJECTED"
  | "SAVE_FAILED"
  | "SESSION_GONE";

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
  /** R4-3：该会话累计用量（索引落盘值）；从未跑过带用量的轮 → 字段不出现（UI 不显示该段） */
  usage?: UsageStats;
}

/** 宿主 → UI（INTERFACE §4.6 宿主→UI 表） */
export type HostMessage =
  /** 握手首条；token = 本实例一次性凭据（页面 URL 同值，BUG-16） */
  | { type: "init"; token?: string }
  | { type: "sessionList"; sessions: SessionSummary[] }
  | { type: "streamEvent"; sessionId?: string; event: StreamEvent }
  | {
      type: "history";
      sessionId: string;
      messages: { role: "user" | "assistant"; text: string; ts: number }[];
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
  | { type: "uiPrefs"; showUsage: boolean };

/** UI → 宿主（INTERFACE §4.6 UI→宿主表） */
export type UiMessage =
  /** 握手回执；token 回抄 init 携带的一次性凭据，宿主校验一致才注册实例（BUG-16） */
  | { type: "hello"; token?: string }
  | { type: "send"; sessionId?: string | null; text: string }
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
  | { type: "getState" };
