// protocol.ts — stream-json 行解析 → 标准事件（PLAN §4.2）
// 纯函数，不 import Zotero 全局：node:test 直接跑，宿主侧零改动复用。
// CLI 流字段为 snake_case（claude CLI 原始形态），映射为 camelCase 标准事件。
// 前向兼容契约：未知 type/subtype 一律丢弃 + debug log，不抛错（PLAN §7.2 风险 4）。

import type { UsageStats } from "../chat/lib/usage";

/** 标准事件（INTERFACE §4.2 event.kind 各形态的联合） */
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
  /** R4-3：usage 可选——多步 turn 逐步累积用；缺失则只用 result 的（PLAN-R4 §4） */
  | { kind: "assistantMessage"; content: unknown[]; usage?: UsageStats }
  | { kind: "toolResult"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "apiRetry"; attempt: number; maxRetries: number; delayMs: number }
  | {
      kind: "result";
      claudeSessionId: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
      /** R4-3：整轮用量汇总（CLI result 行的 usage）；畸形/缺失 → 该字段不出现 */
      usage?: UsageStats;
    }
  | { kind: "resultError"; subtype: string; errors: string[] };

/** 宿主注入的 debug log（默认 no-op；Zotero 侧接 Zotero.debug） */
export type StreamLogger = (message: string) => void;

const noopLog: StreamLogger = () => {};

/** 4KB 截断上限（INTERFACE §4.2 toolResult summary） */
const SUMMARY_MAX_CHARS = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * R4-3：usage 归一（PLAN-R4 §4 缺省口径，测试锁定）。
 * 容器整体缺失 / 非对象（字符串/数字/null/数组）→ undefined，事件**不出现**该字段（前向兼容）；
 * 容器是对象但某个内层字段缺失/非数字 → 该字段按 0（半个字段不该毁掉整个用量显示）。永不抛。
 */
function mapUsage(raw: unknown): UsageStats | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const num = (v: unknown): number => asNumber(v) ?? 0;
  return {
    input: num(raw.input_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheCreation: num(raw.cache_creation_input_tokens),
    output: num(raw.output_tokens),
  };
}

/**
 * 解析一行 stream-json。返回标准事件；返回 null = 丢弃该行（坏行/未知类型/字段缺失）。
 * 一条 user 消息含多个 tool_result 块时返回事件数组（每块各一条，BUG-05，INTERFACE §4.2），
 * 其余情况恒为单事件或 null。永不抛错——JSON.parse 失败与一切畸形输入都走 log + null。
 */
export function mapStreamLine(
  line: string,
  log: StreamLogger = noopLog,
): StreamEvent | StreamEvent[] | null {
  const drop = (why: string): null => {
    log(`[protocol] drop line: ${why}`);
    return null;
  };

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return drop(`not JSON: ${line.slice(0, 120)}`);
  }
  if (!isRecord(raw)) {
    return drop("not an object");
  }

  const type = asString(raw.type);

  switch (type) {
    case "system": {
      const subtype = asString(raw.subtype);
      if (subtype === "init") {
        const sessionId = asString(raw.session_id);
        if (!sessionId) {
          return drop("init missing session_id");
        }
        return {
          kind: "init",
          claudeSessionId: sessionId,
          model: asString(raw.model) ?? "",
          permissionMode: asString(raw.permissionMode) ?? "",
          tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
          mcpServers: Array.isArray(raw.mcp_servers)
            ? (raw.mcp_servers as string[])
            : [],
        };
      }
      if (subtype === "api_retry") {
        const attempt = asNumber(raw.attempt);
        const maxRetries = asNumber(raw.max_retries);
        // M10-J4 实测（CLI v2.1.267）：退避字段名为 retry_delay_ms；契约写的 delay_ms 从未出现，
        // 只认旧名会把整条重试事件丢弃（UI 永远没有「API 重试中」状态行）→ 两名并收，新名优先
        const delayMs = asNumber(raw.retry_delay_ms) ?? asNumber(raw.delay_ms);
        if (attempt === null || maxRetries === null || delayMs === null) {
          return drop("api_retry missing numeric fields");
        }
        return { kind: "apiRetry", attempt, maxRetries, delayMs };
      }
      return drop(`unknown system subtype: ${subtype ?? "?"}`);
    }
    case "stream_event":
      return mapStreamEvent(raw, log);
    case "assistant": {
      const message = raw.message;
      if (!isRecord(message) || !Array.isArray(message.content)) {
        return drop("assistant message without content array");
      }
      const usage = mapUsage(message.usage);
      return usage
        ? { kind: "assistantMessage", content: message.content, usage }
        : { kind: "assistantMessage", content: message.content };
    }
    case "user":
      return mapUserMessage(raw, log);
    case "result": {
      const subtype = asString(raw.subtype) ?? "";
      // M10-J4/E5 实测：重试耗尽后 CLI 发 subtype:"success" + is_error:true + result:"API Error: …"
      // （terminal_reason:"api_error"）。只认 subtype 会把 API 错误当成功完成（「完成 · 1 轮」无横幅）
      // → 按 §4.2 错误契约归一到 resultError（UI 错误横幅），result 文本进 errors；
      // subtype 取 CLI 的 terminal_reason（缺省回落原 subtype，不发明取值）
      if (subtype === "success" && raw.is_error === true) {
        const text = asString(raw.result);
        return {
          kind: "resultError",
          subtype: asString(raw.terminal_reason) || subtype,
          errors: text ? [text] : [],
        };
      }
      if (subtype === "success") {
        const usage = mapUsage(raw.usage);
        return {
          kind: "result",
          claudeSessionId: asString(raw.session_id) ?? "",
          costUsd: asNumber(raw.total_cost_usd) ?? 0,
          durationMs: asNumber(raw.duration_ms) ?? 0,
          numTurns: asNumber(raw.num_turns) ?? 0,
          // 不写 `usage: undefined`：键存在会把既有 deepEqual 形态断言打红（且语义上等于「无该字段」）
          ...(usage ? { usage } : {}),
        };
      }
      if (subtype.startsWith("error")) {
        const errors = Array.isArray(raw.errors)
          ? raw.errors.map((e) => asString(e) ?? String(e))
          : [];
        return { kind: "resultError", subtype, errors };
      }
      return drop(`unknown result subtype: ${subtype || "?"}`);
    }
    default:
      return drop(`unknown type: ${type ?? "?"}`);
  }
}

function mapStreamEvent(
  raw: Record<string, unknown>,
  log: StreamLogger,
): StreamEvent | null {
  const drop = (why: string): null => {
    log(`[protocol] drop stream_event: ${why}`);
    return null;
  };
  const ev = raw.event;
  if (!isRecord(ev)) {
    return drop("missing event object");
  }
  const eventType = asString(ev.type);
  const index = asNumber(ev.index);

  switch (eventType) {
    case "message_start":
      return { kind: "messageStart" };
    case "content_block_start": {
      if (index === null) return drop("content_block_start missing index");
      const block = ev.content_block;
      if (!isRecord(block)) return drop("content_block_start missing block");
      const blockType = asString(block.type);
      if (blockType === "text") {
        return { kind: "textBlockStart", index };
      }
      if (blockType === "tool_use") {
        const name = asString(block.name);
        const id = asString(block.id);
        if (!name || !id) return drop("tool_use block missing name/id");
        return { kind: "toolBlockStart", index, toolName: name, toolUseId: id };
      }
      // thinking 等其余块起始不在映射表内 → 丢弃（未知 subtype 同待遇）
      return drop(`unknown content_block type: ${blockType ?? "?"}`);
    }
    case "content_block_delta": {
      if (index === null) return drop("content_block_delta missing index");
      const delta = ev.delta;
      if (!isRecord(delta)) return drop("content_block_delta missing delta");
      const deltaType = asString(delta.type);
      if (deltaType === "text_delta" || deltaType === "thinking_delta") {
        // M10 真机抓包：thinking_delta 的文本字段是 delta.thinking（Anthropic 原始流形态），
        // 契约写的 delta.text 在真机流里从未出现（r1c4/r2 共 9000+ 条被整条丢弃，E4 折叠区空）
        // → 两名并收，text 优先（保持既有契约语义）
        const text = asString(delta.text) ?? asString(delta.thinking);
        if (text === null) return drop(`${deltaType} text not a string`);
        return deltaType === "text_delta"
          ? { kind: "textDelta", index, text }
          : { kind: "thinkingDelta", index, text };
      }
      if (deltaType === "input_json_delta") {
        const fragment = asString(delta.partial_json);
        if (fragment === null) return drop("input_json_delta not a string");
        return { kind: "toolInputDelta", index, jsonFragment: fragment };
      }
      return drop(`unknown delta type: ${deltaType ?? "?"}`);
    }
    default:
      // message_delta / message_stop / content_block_stop 等不在映射表 → 丢弃
      return drop(`unknown stream_event type: ${eventType ?? "?"}`);
  }
}

function mapUserMessage(
  raw: Record<string, unknown>,
  log: StreamLogger,
): StreamEvent | StreamEvent[] | null {
  const message = raw.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    log("[protocol] drop user message without content array");
    return null;
  }
  // 一条 user 消息可含多个 tool_result 块（并行工具调用），每块各产出一条事件（BUG-05）
  const events: StreamEvent[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId = asString(block.tool_use_id);
    if (!toolUseId) {
      log("[protocol] drop tool_result missing tool_use_id");
      continue;
    }
    events.push({
      kind: "toolResult",
      toolUseId,
      isError: block.is_error === true,
      summary: extractToolResultSummary(block.content),
    });
  }
  if (events.length === 0) {
    log("[protocol] drop user message without valid tool_result");
    return null;
  }
  if (events.length === 1) {
    return events[0];
  }
  return events;
}

/**
 * tool_result summary 提取（INTERFACE §4.2 错误契约列，优先级写死）：
 * content 为字符串 → 原值；数组 → 按序拼接 type:"text" 块；两者皆无 → `[{首块 type 名}]` 占位。
 * 超 4KB 截断。null/undefined → 空串。
 */
export function extractToolResultSummary(content: unknown): string {
  let summary: string;
  if (typeof content === "string") {
    summary = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        texts.push(block.text);
      }
    }
    summary = texts.join("");
    if (!summary && content.length > 0 && isRecord(content[0])) {
      summary = `[${asString(content[0].type) ?? "unknown"}]`;
    }
  } else {
    summary = "";
  }
  return summary.length > SUMMARY_MAX_CHARS
    ? summary.slice(0, SUMMARY_MAX_CHARS)
    : summary;
}
