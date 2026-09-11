// 单测 — protocol.ts 内部边界（验收 stream-map.test.mjs 之外的白盒覆盖）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapStreamLine,
  extractToolResultSummary,
} from "../../src/modules/protocol.ts";

test("protocol: 非 JSON 行 / 空行 → null 且调用注入的 log（debug log 契约）", () => {
  const logs: string[] = [];
  assert.equal(
    mapStreamLine("not json {{{", (m) => logs.push(m)),
    null,
  );
  assert.equal(
    mapStreamLine("", (m) => logs.push(m)),
    null,
  );
  assert.equal(
    mapStreamLine("   ", (m) => logs.push(m)),
    null,
  );
  assert.ok(logs.length >= 3, "每个被丢行都应有一条 debug log");
  assert.ok(logs[0].includes("not JSON"));
});

test("protocol: JSON 合法但非对象（数组/标量）→ null", () => {
  assert.equal(mapStreamLine("[1,2,3]"), null);
  assert.equal(mapStreamLine("42"), null);
  assert.equal(mapStreamLine('"str"'), null);
});

test("protocol: 未知 type 与未知 subtype 全部 null（前向兼容）", () => {
  assert.equal(mapStreamLine('{"type":"future_type"}'), null);
  assert.equal(
    mapStreamLine('{"type":"system","subtype":"compact_boundary"}'),
    null,
  );
  assert.equal(
    mapStreamLine('{"type":"result","subtype":"error_weird"}')!.kind,
    "resultError",
  );
});

test("protocol: stream_event 缺 event 对象 → null", () => {
  assert.equal(mapStreamLine('{"type":"stream_event"}'), null);
  assert.equal(mapStreamLine('{"type":"stream_event","event":"flat"}'), null);
});

test("protocol: content_block_start 缺 index / 未知块类型 → null", () => {
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}',
    ),
    null,
  );
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking"}}}',
    ),
    null,
  );
});

test("protocol: tool_use 块缺 name 或 id → null（未知工具名照常显示的契约不适用于残缺块）", () => {
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Bash"}}}',
    ),
    null,
  );
});

test("protocol: message_delta / message_stop / content_block_stop 不在映射表 → null", () => {
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"message_delta","delta":{}}}',
    ),
    null,
  );
  assert.equal(
    mapStreamLine('{"type":"stream_event","event":{"type":"message_stop"}}'),
    null,
  );
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
    ),
    null,
  );
});

test("protocol: thinking_delta 认真机字段 delta.thinking（M10 抓包逐字形态），text 旧名兜底", () => {
  // 真机逐字（/tmp 同参抓包，CLI v2.1.267）：delta 里只有 thinking，没有 text
  const ev = mapStreamLine(
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"鸡"}}}',
  ) as { kind: string; index: number; text: string };
  assert.deepEqual(ev, { kind: "thinkingDelta", index: 0, text: "鸡" });
  // 两名皆无 → 仍按畸形丢弃
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta"}}}',
    ),
    null,
  );
});

test("protocol: input_json_delta 非字符串 partial_json → null", () => {
  assert.equal(
    mapStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":42}}}',
    ),
    null,
  );
});

test("protocol: user 消息无 tool_result / content 非数组 → null 不抛错", () => {
  assert.equal(
    mapStreamLine(
      '{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}',
    ),
    null,
  );
  assert.equal(mapStreamLine('{"type":"user","message":{}}'), null);
  assert.equal(mapStreamLine('{"type":"user"}'), null);
});

test("protocol: user 消息多块时取 tool_result 块；多块各产出一条事件（BUG-05）", () => {
  const single = mapStreamLine(
    '{"type":"user","message":{"content":[{"type":"image","source":{}},{"type":"tool_result","tool_use_id":"tu3","is_error":false,"content":"ok"}]}}',
  );
  assert.equal(single!.kind, "toolResult");
  assert.equal((single as { toolUseId: string }).toolUseId, "tu3");

  const multi = mapStreamLine(
    '{"type":"user","message":{"content":[' +
      '{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"a"},' +
      '{"type":"text","text":"注"},' +
      '{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"b"}]}}',
  ) as Array<{ kind: string; toolUseId: string; isError: boolean }>;
  assert.ok(Array.isArray(multi), "多 tool_result 应产出事件数组");
  assert.deepEqual(
    multi.map((e) => [e.kind, e.toolUseId, e.isError]),
    [
      ["toolResult", "t1", false],
      ["toolResult", "t2", true],
    ],
  );
});

test("protocol: tool_result 缺 is_error → 默认 false；缺 tool_use_id → null（无法挂卡）", () => {
  const ev = mapStreamLine(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu8","content":"x"}]}}',
  );
  assert.equal(ev!.kind, "toolResult");
  assert.equal((ev as { isError: boolean }).isError, false);
  assert.equal(
    mapStreamLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}',
    ),
    null,
  );
});

test("protocol: init 的 model/permissionMode/tools/mcp_servers 缺省 → 空值兜底不抛错", () => {
  const ev = mapStreamLine(
    '{"type":"system","subtype":"init","session_id":"s1"}',
  ) as {
    model: string;
    tools: string[];
    mcpServers: string[];
  };
  assert.equal(ev.model, "");
  assert.deepEqual(ev.tools, []);
  assert.deepEqual(ev.mcpServers, []);
});

test("protocol: api_retry 认真机字段 retry_delay_ms（M10-J4 逐字形态），delay_ms 旧名兜底", () => {
  // 真机逐字抓包（CLI v2.1.267）：字段是 retry_delay_ms，旧实现只读 delay_ms → 整条被丢
  const ev = mapStreamLine(
    '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":604,"error_status":502,"error":"server_error","session_id":"855a21ca-2194-4dcf-9643-2b327d76d0e3"}',
  ) as { kind: string; attempt: number; maxRetries: number; delayMs: number };
  assert.deepEqual(ev, {
    kind: "apiRetry",
    attempt: 1,
    maxRetries: 10,
    delayMs: 604,
  });
  const legacy = mapStreamLine(
    '{"type":"system","subtype":"api_retry","attempt":2,"max_retries":3,"delay_ms":1500}',
  ) as { delayMs: number };
  assert.equal(legacy.delayMs, 1500);
  // 两名皆缺/非数值 → 仍按畸形丢弃（不产出事件）
  assert.equal(
    mapStreamLine(
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":null}',
    ),
    null,
  );
});

test("protocol: result error 子族缺 errors 字段 → 空数组；非字符串 errors 元素字符串化", () => {
  const ev = mapStreamLine(
    '{"type":"result","subtype":"error_during_execution"}',
  ) as { errors: string[] };
  assert.deepEqual(ev.errors, []);
  const ev2 = mapStreamLine(
    '{"type":"result","subtype":"error_x","errors":["a",7]}',
  ) as { errors: string[] };
  assert.deepEqual(ev2.errors, ["a", "7"]);
});

test("protocol: result success + is_error:true → resultError（M10-J4 真机形态，不再当成功完成）", () => {
  // 真机逐字（重试耗尽后）：subtype:"success" 但 is_error:true、terminal_reason:"api_error"
  const ev = mapStreamLine(
    '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"total_cost_usd":0,"duration_ms":211711,"terminal_reason":"api_error","session_id":"s","result":"API Error: 502 status code (no body)."}',
  ) as { kind: string; subtype: string; errors: string[] };
  assert.equal(ev.kind, "resultError");
  assert.equal(ev.subtype, "api_error"); // 横幅显示用 terminal_reason 透传
  assert.deepEqual(ev.errors, ["API Error: 502 status code (no body)."]);

  // is_error 但无 result 文本 → 空 errors；无 terminal_reason → 回落 CLI 原 subtype
  const bare = mapStreamLine(
    '{"type":"result","subtype":"success","is_error":true}',
  ) as { kind: string; subtype: string; errors: string[] };
  assert.equal(bare.kind, "resultError");
  assert.equal(bare.subtype, "success");
  assert.deepEqual(bare.errors, []);

  // 正常 success（含显式 is_error:false）→ 仍是 result，零回归
  const ok = mapStreamLine(
    '{"type":"result","subtype":"success","is_error":false,"session_id":"s9","total_cost_usd":0.012,"duration_ms":4200,"num_turns":3}',
  ) as { kind: string };
  assert.equal(ok.kind, "result");
});

test("protocol: result success 数值字段缺省 → 0 兜底", () => {
  const ev = mapStreamLine(
    '{"type":"result","subtype":"success","session_id":"s"}',
  ) as {
    costUsd: number;
    durationMs: number;
    numTurns: number;
  };
  assert.equal(ev.costUsd, 0);
  assert.equal(ev.durationMs, 0);
  assert.equal(ev.numTurns, 0);
});

test("extractToolResultSummary: 数组含非对象块 → 跳过；首块非对象无 type 名 → 空串占位", () => {
  assert.equal(
    extractToolResultSummary(["plain", { type: "text", text: "块" }]),
    "块",
  );
  assert.equal(extractToolResultSummary([42]), "");
  assert.equal(extractToolResultSummary([]), "");
});

test("extractToolResultSummary: 数组拼接后超 4KB → 截断（含 text 块路径）", () => {
  const out = extractToolResultSummary([
    { type: "text", text: "y".repeat(4090) },
    { type: "text", text: "z".repeat(100) },
  ]);
  assert.equal(out.length, 4096);
  assert.ok(out.endsWith("zzzzzz"), "截断点应落在第二块的 z 段内");
});
