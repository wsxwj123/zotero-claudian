// 验收测试 — §4.3 笔记追加拼接 + §4.7 消毒底线（INTERFACE.md）
// 被测契约：src/contract.ts 导出 appendNoteHtml(existingHtml, contentHtml, appendedAtIso)、
//           sanitizeNoteHtml(html)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendNoteHtml, sanitizeNoteHtml } from '../../src/contract.ts';

const T = '2026-09-09T10:00:00.000Z';

// ---- appendNoteHtml（追加语义：末尾加 <hr> + 时间戳小字 + 内容，不动原文）----

test('append: 已有笔记 → 原文在前，接 <hr> + 时间戳 + 新内容，精确格式', () => {
  const out = appendNoteHtml('<p>原文</p>', '<p>新内容</p>', T);
  assert.equal(out, '<p>原文</p><hr><p><small>zotero-claudian 追加（2026-09-09T10:00:00.000Z）</small></p><p>新内容</p>');
});

test('append: 原文完全不变（反向用例：不修改已有内容）', () => {
  const original = '<p>第一段</p><p>第二段</p>';
  const out = appendNoteHtml(original, '<p>x</p>', T);
  assert.ok(out.startsWith(original), '原文必须原样出现在开头');
  assert.ok(out.slice(original.length).startsWith('<hr>'));
});

test('append: 原文为空字符串 → 直接 <hr> + 时间戳 + 内容', () => {
  const out = appendNoteHtml('', '<p>内容</p>', T);
  assert.equal(out, '<hr><p><small>zotero-claudian 追加（2026-09-09T10:00:00.000Z）</small></p><p>内容</p>');
});

test('append: 新内容为多段 HTML → 全部保留在时间戳之后', () => {
  const out = appendNoteHtml('<p>旧</p>', '<h2>标题</h2><ul><li>a</li><li>b</li></ul>', T);
  assert.ok(out.endsWith('<h2>标题</h2><ul><li>a</li><li>b</li></ul>'));
});

test('append: 连续两次追加 → 两段 <hr> 依序排列，第一次内容夹在中间', () => {
  let out = appendNoteHtml('<p>旧</p>', '<p>一</p>', '2026-09-09T10:00:00.000Z');
  out = appendNoteHtml(out, '<p>二</p>', '2026-09-09T11:00:00.000Z');
  assert.ok(out.includes('<p>一</p><hr><p><small>zotero-claudian 追加（2026-09-09T11:00:00.000Z）</small></p><p>二</p>'));
  assert.equal(out.match(/<hr>/g).length, 2);
});

test('append: 中文/emoji/换行内容原样进入', () => {
  const out = appendNoteHtml('<p>旧</p>', '<p>结论 ✅\n第二行</p>', T);
  assert.ok(out.includes('<p>结论 ✅\n第二行</p>'));
});

// ---- sanitizeNoteHtml（§4.7 安全底线：AI 产出的 HTML 必经消毒）----

test('sanitize: 普通段落原样保留', () => {
  assert.equal(sanitizeNoteHtml('<p>你好</p>'), '<p>你好</p>');
});

test('sanitize: <script> 连标签带内容整体移除', () => {
  const out = sanitizeNoteHtml('<p>a</p><script>alert(1)</script><p>b</p>');
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('alert'));
  assert.ok(out.includes('<p>a</p>'));
  assert.ok(out.includes('<p>b</p>'));
});

test('sanitize: 纯 <script> 输入 → 消毒后为空（对应 SANITIZE_REJECTED 路径）', () => {
  assert.equal(sanitizeNoteHtml('<script>alert(1)</script>'), '');
});

test('sanitize: on* 事件属性全部剥离，正文保留', () => {
  const out = sanitizeNoteHtml('<p onclick="steal()">hi</p><img src="x.png" onerror="evil()">');
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('onerror'));
  assert.ok(!out.includes('steal'));
  assert.ok(out.includes('hi'));
});

test('sanitize: javascript: 伪协议 href 被剥离', () => {
  const out = sanitizeNoteHtml('<a href="javascript:alert(1)">点我</a>');
  assert.ok(!out.includes('javascript:'));
  assert.ok(out.includes('点我'));
});

test('sanitize: http/https 链接保留（openExternal 出口可用）', () => {
  const out = sanitizeNoteHtml('<a href="https://example.com/paper">原文</a>');
  assert.ok(out.includes('href="https://example.com/paper"'));
});

test('sanitize: markdown 常规标签保留', () => {
  const html = '<h1>题</h1><p><strong>粗</strong><em>斜</em><code>c</code></p><pre><code>block</code></pre><ul><li>i</li></ul><blockquote>q</blockquote><hr>';
  const out = sanitizeNoteHtml(html);
  for (const tag of ['<h1>', '<strong>', '<em>', '<code>', '<pre>', '<ul><li>', '<blockquote>', '<hr']) {
    assert.ok(out.includes(tag), `应保留 ${tag}`);
  }
});

test('sanitize: <style> 与 iframe 整体移除', () => {
  const out = sanitizeNoteHtml('<style>body{}</style><p>x</p><iframe src="https://e"></iframe>');
  assert.ok(!out.includes('style'));
  assert.ok(!out.includes('iframe'));
  assert.ok(out.includes('<p>x</p>'));
});

test('sanitize: 空输入 → 空输出（对应 EMPTY_CONTENT 路径）', () => {
  assert.equal(sanitizeNoteHtml(''), '');
});
