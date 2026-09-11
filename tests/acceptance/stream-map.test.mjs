// 验收测试 — §4.2 stream-json 事件 → 标准事件映射 + toolResult summary 提取（INTERFACE.md）
// 被测契约：src/contract.ts 导出 mapStreamLine(line: string)（返回标准事件对象或 null=丢弃）、
//           extractToolResultSummary(content: unknown): string
// 输入采用 claude CLI stream-json 原始行形态（snake_case 字段），假设清单见 TEST-PLAN.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStreamLine, extractToolResultSummary } from '../../src/contract.ts';

// ---- init ----

test('stream: system/init → init 事件（session_id 映射 claudeSessionId）', () => {
  const ev = mapStreamLine('{"type":"system","subtype":"init","session_id":"s1","model":"claude-x","permissionMode":"acceptEdits","tools":["Bash"],"mcp_servers":["claudian-perm"]}');
  assert.equal(ev.kind, 'init');
  assert.equal(ev.claudeSessionId, 's1');
  assert.equal(ev.model, 'claude-x');
  assert.equal(ev.permissionMode, 'acceptEdits');
  assert.deepEqual(ev.tools, ['Bash']);
  assert.deepEqual(ev.mcpServers, ['claudian-perm']);
});

test('stream: init 缺 session_id → 丢事件（返回 null），不抛错', () => {
  const ev = mapStreamLine('{"type":"system","subtype":"init","model":"m"}');
  assert.equal(ev, null);
});

// ---- 分帧与容错 ----

test('stream: 非 JSON 行 → null（进 debug log，不抛错）', () => {
  assert.equal(mapStreamLine('not json {{{'), null);
  assert.equal(mapStreamLine(''), null);
});

test('stream: 未知 type → null（前向兼容，无 UI 影响）', () => {
  assert.equal(mapStreamLine('{"type":"future_thing","x":1}'), null);
  assert.equal(mapStreamLine('{"type":"system","subtype":"unknown_subtype"}'), null);
});

// ---- 流式文本 ----

test('stream: text_delta → textDelta {index, text}', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}}');
  assert.deepEqual(ev, { kind: 'textDelta', index: 0, text: '你好' });
});

test('stream: text_delta 的 text 非字符串 → 丢该 delta（null）', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":42}}}');
  assert.equal(ev, null);
});

test('stream: thinking_delta → thinkingDelta {index, text}', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","text":"let me think"}}}');
  assert.deepEqual(ev, { kind: 'thinkingDelta', index: 2, text: 'let me think' });
});

test('stream: thinking_delta text 非字符串 → null', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","text":null}}}');
  assert.equal(ev, null);
});

test('stream: message_start → messageStart', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"message_start"}}');
  assert.equal(ev.kind, 'messageStart');
});

// ---- 工具卡 ----

test('stream: content_block_start(tool_use) → toolBlockStart {index, toolName, toolUseId}', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Bash","id":"tu1"}}}');
  assert.deepEqual(ev, { kind: 'toolBlockStart', index: 1, toolName: 'Bash', toolUseId: 'tu1' });
});

test('stream: 未知工具名（MCP 工具）照常生成 toolBlockStart', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"mcp__whatever__odd_tool","id":"tu9"}}}');
  assert.equal(ev.kind, 'toolBlockStart');
  assert.equal(ev.toolName, 'mcp__whatever__odd_tool');
});

test('stream: content_block_start(text) → textBlockStart {index}', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}');
  assert.deepEqual(ev, { kind: 'textBlockStart', index: 0 });
});

test('stream: input_json_delta → toolInputDelta {index, jsonFragment}', () => {
  const ev = mapStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}}');
  assert.deepEqual(ev, { kind: 'toolInputDelta', index: 1, jsonFragment: '{"command":' });
});

// ---- 校准与结果 ----

test('stream: assistant 消息 → assistantMessage，content 数组原样透传', () => {
  const raw = '{"type":"assistant","message":{"content":[{"type":"text","text":"最终答案"}]}}';
  const ev = mapStreamLine(raw);
  assert.equal(ev.kind, 'assistantMessage');
  assert.deepEqual(ev.content, [{ type: 'text', text: '最终答案' }]);
});

test('stream: api_retry → apiRetry {attempt, maxRetries, delayMs}', () => {
  const ev = mapStreamLine('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":3,"delay_ms":1500}');
  assert.deepEqual(ev, { kind: 'apiRetry', attempt: 2, maxRetries: 3, delayMs: 1500 });
});

test('stream: result success → result {claudeSessionId, costUsd, durationMs, numTurns}', () => {
  const ev = mapStreamLine('{"type":"result","subtype":"success","session_id":"s9","total_cost_usd":0.012,"duration_ms":4200,"num_turns":3}');
  assert.deepEqual(ev, {
    kind: 'result',
    claudeSessionId: 's9',
    costUsd: 0.012,
    durationMs: 4200,
    numTurns: 3,
  });
});

test('stream: result error* → resultError {subtype, errors[]}', () => {
  const ev = mapStreamLine('{"type":"result","subtype":"error_max_retries","errors":["rate limited"]}');
  assert.deepEqual(ev, { kind: 'resultError', subtype: 'error_max_retries', errors: ['rate limited'] });
});

// ---- toolResult ----

test('stream: user 回流 tool_result → toolResult {toolUseId, isError, summary}', () => {
  const ev = mapStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":false,"content":"ls 输出"}]}}');
  assert.equal(ev.kind, 'toolResult');
  assert.equal(ev.toolUseId, 'tu1');
  assert.equal(ev.isError, false);
  assert.equal(ev.summary, 'ls 输出');
});

test('stream: tool_result is_error=true → isError 透传 true', () => {
  const ev = mapStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","is_error":true,"content":"boom"}]}}');
  assert.equal(ev.isError, true);
});

// ---- extractToolResultSummary 优先级（§4.2 错误契约列）----

test('summary: content 为字符串 → 原值', () => {
  assert.equal(extractToolResultSummary('plain output'), 'plain output');
});

test('summary: content 为数组 → 按序拼接 type:text 块', () => {
  const c = [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ];
  assert.equal(extractToolResultSummary(c), '第一段第二段');
});

test('summary: 数组含非 text 块 → 只拼 text 块，跳过其余', () => {
  const c = [
    { type: 'image', source: {} },
    { type: 'text', text: 'A' },
    { type: 'tool_use', id: 'x' },
    { type: 'text', text: 'B' },
  ];
  assert.equal(extractToolResultSummary(c), 'AB');
});

test('summary: 数组无任何 text 块 → "[首块type名]" 占位', () => {
  assert.equal(extractToolResultSummary([{ type: 'image', source: {} }]), '[image]');
  assert.equal(extractToolResultSummary([{ type: 'tool_use', id: 'x' }]), '[tool_use]');
});

test('summary: 超过 4KB → 截断到 4096 字符', () => {
  const long = 'x'.repeat(5000);
  const out = extractToolResultSummary(long);
  assert.equal(out.length, 4096);
});

test('summary: 恰好 4096 字符 → 原样不截断', () => {
  const exact = 'y'.repeat(4096);
  assert.equal(extractToolResultSummary(exact), exact);
});

test('summary: 中文与 emoji 原样提取（不转义不失真）', () => {
  assert.equal(extractToolResultSummary('结论 ✅：通过'), '结论 ✅：通过');
});

test('summary: content 为 null/undefined → 空字符串（不抛错）', () => {
  assert.equal(extractToolResultSummary(null), '');
  assert.equal(extractToolResultSummary(undefined), '');
});
