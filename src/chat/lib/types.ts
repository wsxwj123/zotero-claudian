// 桥消息类型定义 — 对应 INTERFACE.md §4.6 / §4.2。
// M3 供前端 bundle 使用；M4 宿主侧 hostBridge 以此为准对齐（字段拼写与 stream-map 验收契约一致）。
// M3 只实现消息流/输入/错误渲染所需分支，其余类型按 §4.6 兜底约定「已知但暂不处理 → 忽略不崩」。

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
    };

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
  | { type: "openExternal"; url: string }
  | {
      type: "setPermissionMode";
      sessionId: string;
      mode: "default" | "acceptEdits" | "plan";
    }
  | { type: "getState" };
