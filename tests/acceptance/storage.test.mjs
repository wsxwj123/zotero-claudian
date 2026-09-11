// 验收测试 — §4.5 会话索引损坏恢复 + 旁挂历史 jsonl 读写（INTERFACE.md）
// 被测契约：src/contract.ts 导出
//   loadSessionsIndex(raw: string) → { version, sessions } | { corrupted: true }（corrupted=true 时宿主改名 bak 并新建空索引）
//   parseHistoryJsonl(raw: string) → { role, text, ts }[]（getHistory 读路径）
//   formatHistoryRecord(rec: { role, text, ts }) → string（写路径：单行 JSON，不含结尾换行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionsIndex, parseHistoryJsonl, formatHistoryRecord } from '../../src/contract.ts';

// ---- loadSessionsIndex ----

test('index: 合法索引 → 原样解析出 sessions', () => {
  const raw = JSON.stringify({
    version: 1,
    sessions: [{
      id: 'u1', claudeSessionId: 'c1', title: '首条消息', createdAt: 1736000000000,
      updatedAt: 1736000000000, itemKey: 'ITEM1', itemLibraryID: 1, attachmentKey: 'ATT1',
      permissionMode: 'acceptEdits', allowedTools: ['Bash(python *)'], messageCount: 3, lastCostUsd: 0.012,
    }],
  });
  const idx = loadSessionsIndex(raw);
  assert.equal(idx.corrupted, false);
  assert.equal(idx.version, 1);
  assert.equal(idx.sessions.length, 1);
  assert.equal(idx.sessions[0].claudeSessionId, 'c1');
  assert.deepEqual(idx.sessions[0].allowedTools, ['Bash(python *)']);
});

test('index: 首轮未完成 claudeSessionId=null 原样保留', () => {
  const raw = JSON.stringify({ version: 1, sessions: [{ id: 'u1', claudeSessionId: null, title: 't' }] });
  const idx = loadSessionsIndex(raw);
  assert.equal(idx.sessions[0].claudeSessionId, null);
});

test('index: 空索引（sessions:[]）→ 正常返回空列表，不算损坏', () => {
  const idx = loadSessionsIndex('{"version":1,"sessions":[]}');
  assert.equal(idx.corrupted, false);
  assert.deepEqual(idx.sessions, []);
});

test('index: 完全乱码 → corrupted=true（宿主据此改名 bak 并新建空索引）', () => {
  const idx = loadSessionsIndex('not json {{{');
  assert.equal(idx.corrupted, true);
});

test('index: 合法 JSON 但结构不对（数组/缺 sessions）→ corrupted=true', () => {
  assert.equal(loadSessionsIndex('[1,2,3]').corrupted, true);
  assert.equal(loadSessionsIndex('{"version":1}').corrupted, true);
  assert.equal(loadSessionsIndex('null').corrupted, true);
});

test('index: 半截 JSON（写入中断残留）→ corrupted=true 不抛错', () => {
  const raw = '{"version":1,"sessions":[{"id":"u1"';
  assert.equal(loadSessionsIndex(raw).corrupted, true);
});

test('index: 空文件（0 字节）→ corrupted=true', () => {
  assert.equal(loadSessionsIndex('').corrupted, true);
});

// ---- parseHistoryJsonl（getHistory 读路径；无文件时宿主传空串）----

test('history: 两行合法记录 → 按序解析', () => {
  const raw = [
    '{"role":"user","text":"这篇讲什么","ts":1736000000000}',
    '{"role":"assistant","text":"讲的是 Transformer","ts":1736000001000}',
  ].join('\n');
  const msgs = parseHistoryJsonl(raw);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { role: 'user', text: '这篇讲什么', ts: 1736000000000 });
  assert.equal(msgs[1].role, 'assistant');
});

test('history: 空字符串/纯换行 → 空数组（未知会话回空消息数组的契约）', () => {
  assert.deepEqual(parseHistoryJsonl(''), []);
  assert.deepEqual(parseHistoryJsonl('\n'), []);
});

test('history: 行尾换行不产生多余记录', () => {
  const msgs = parseHistoryJsonl('{"role":"user","text":"a","ts":1}\n');
  assert.equal(msgs.length, 1);
});

test('history: 中间空行跳过，前后记录不受影响', () => {
  const raw = '{"role":"user","text":"a","ts":1}\n\n{"role":"assistant","text":"b","ts":2}\n';
  const msgs = parseHistoryJsonl(raw);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].text, 'b');
});

test('history: 非法 JSON 行跳过不抛错（其余行照常）', () => {
  const raw = 'garbage line\n{"role":"user","text":"ok","ts":1}\n{"role":broken\n';
  const msgs = parseHistoryJsonl(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'ok');
});

test('history: 非消息形态的合法 JSON 行跳过', () => {
  const raw = '{"foo":1}\n42\n"str"\n{"role":"system","text":"x","ts":1}\n{"role":"user","text":"ok","ts":2}\n';
  const msgs = parseHistoryJsonl(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
});

test('history: 文本含中文/emoji/引号原样回来', () => {
  const text = '结论 ✅ "quoted" 中文';
  const msgs = parseHistoryJsonl(JSON.stringify({ role: 'assistant', text, ts: 1 }));
  assert.equal(msgs[0].text, text);
});

// ---- formatHistoryRecord（写路径）----

test('history: format → 单行 JSON、无结尾换行、可被 parse 往返', () => {
  const rec = { role: 'user', text: '第一行\n第二行', ts: 1736000000000 };
  const line = formatHistoryRecord(rec);
  assert.ok(!line.includes('\n'), '文本内换行必须被 JSON 转义，行内不得出现裸换行');
  assert.ok(!line.endsWith('\n'));
  const back = parseHistoryJsonl(line)[0];
  assert.deepEqual(back, rec);
});

test('history: format 后的行拼上 "\\n" 即可追加进 jsonl 文件（两轮往返）', () => {
  const a = formatHistoryRecord({ role: 'user', text: 'q', ts: 1 });
  const b = formatHistoryRecord({ role: 'assistant', text: 'a', ts: 2 });
  const msgs = parseHistoryJsonl(a + '\n' + b + '\n');
  assert.deepEqual(msgs, [
    { role: 'user', text: 'q', ts: 1 },
    { role: 'assistant', text: 'a', ts: 2 },
  ]);
});
