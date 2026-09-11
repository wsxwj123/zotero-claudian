// 验收测试 — §4.1.1 prompt 模板组装（INTERFACE.md）
// 被测契约：src/contract.ts 导出 buildPrompt(ctx, userInput)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../src/contract.ts';

// 完整上下文基准（各用例在此基础上覆写字段）
const FULL_CTX = {
  itemKey: 'ITEM1',
  displayTitle: 'Attention Is All You Need',
  creators: ['Ashish Vaswani', 'Noam Shazeer'],
  date: '2017-06-12',
  doi: '10.1234/abc',
  abstractNote: 'We propose the Transformer.',
  pdfPath: '/Users/x/papers/attention.pdf',
  currentPage: 3,
  pageLabel: null,
  selection: 'The Transformer architecture',
  selectionPage: 3,
  selectionItemKey: 'ITEM1',
};
const Q = '这篇的结论是什么';

test('prompt: 完整上下文 → 精确模板', () => {
  const out = buildPrompt(FULL_CTX, Q);
  const expected = [
    '[Zotero context]',
    'Title: Attention Is All You Need',
    'Authors: Ashish Vaswani, Noam Shazeer',
    'Year: 2017',
    'DOI: 10.1234/abc',
    'Abstract: We propose the Transformer.',
    'PDF path: /Users/x/papers/attention.pdf',
    'Current page: 3',
    'Selected text (page 3): "The Transformer architecture"',
    '[/Zotero context]',
    '',
    Q,
  ].join('\n');
  assert.equal(out, expected);
});

test('prompt: 无 DOI → DOI 行省略', () => {
  const out = buildPrompt({ ...FULL_CTX, doi: null }, Q);
  assert.ok(!out.includes('DOI:'), '不应出现 DOI 行');
  assert.ok(out.includes('Year: 2017'));
  assert.ok(out.includes('Abstract:'));
});

test('prompt: 无摘要 → Abstract 行省略', () => {
  const out = buildPrompt({ ...FULL_CTX, abstractNote: '' }, Q);
  assert.ok(!out.includes('Abstract:'));
  assert.ok(out.includes('DOI: 10.1234/abc'));
});

test('prompt: 无划选 → Selected text 行省略', () => {
  const out = buildPrompt({ ...FULL_CTX, selection: null }, Q);
  assert.ok(!out.includes('Selected text'));
  assert.ok(out.includes('Current page: 3'));
});

test('prompt: 无 PDF 附件 → PDF path 行省略', () => {
  const out = buildPrompt({ ...FULL_CTX, pdfPath: null }, Q);
  assert.ok(!out.includes('PDF path:'));
});

test('prompt: 通用会话（itemKey=null）→ 整个上下文块省略，输出即用户输入', () => {
  const out = buildPrompt({ itemKey: null }, Q);
  assert.equal(out, Q);
  assert.ok(!out.includes('[Zotero context]'));
});

test('prompt: 划选条目 ≠ 会话绑定条目 → Selected text 行省略', () => {
  const out = buildPrompt({ ...FULL_CTX, selectionItemKey: 'OTHER' }, Q);
  assert.ok(!out.includes('Selected text'));
  assert.ok(out.includes('Current page: 3'), '其余块不受影响');
});

test('prompt: pageLabel 与物理页不同 → 两个页码行均为 "3 (label: 57)" 格式', () => {
  const out = buildPrompt(
    { ...FULL_CTX, currentPage: 3, pageLabel: '57', selectionPage: 3 },
    Q,
  );
  assert.ok(out.includes('Current page: 3 (label: 57)'));
  assert.ok(out.includes('Selected text (page 3 (label: 57)): '));
});

test('prompt: pageLabel 与物理页相同 → 不加 label 后缀', () => {
  const out = buildPrompt({ ...FULL_CTX, pageLabel: '3' }, Q);
  assert.ok(out.includes('Current page: 3\n'));
  assert.ok(!out.includes('(label:'));
});

test('prompt: 标题/摘要含换行 → 单行化（换行替换为空格）', () => {
  const out = buildPrompt(
    { ...FULL_CTX, displayTitle: '多行\n标题', abstractNote: '第一行\n第二行' },
    Q,
  );
  assert.ok(out.includes('Title: 多行 标题'));
  assert.ok(out.includes('Abstract: 第一行 第二行'));
  assert.ok(!out.includes('多行\n标题'));
});

test('prompt: 划选文本保留原始换行', () => {
  const out = buildPrompt({ ...FULL_CTX, selection: '第一段\n第二段' }, Q);
  assert.ok(out.includes('Selected text (page 3): "第一段\n第二段"'));
});

test('prompt: 划选超 10000 字符 → 截断到 10000', () => {
  const long = '字'.repeat(10001);
  const out = buildPrompt({ ...FULL_CTX, selection: long }, Q);
  const m = out.match(/Selected text \(page 3\): "(.*)"$/m);
  assert.ok(m, '应能匹配到划选行');
  assert.equal(m[1].length, 10000);
});

test('prompt: 划选恰好 10000 字符 → 不截断不变化', () => {
  const exactly = 'a'.repeat(10000);
  const out = buildPrompt({ ...FULL_CTX, selection: exactly }, Q);
  assert.ok(out.includes(exactly));
});

test('prompt: 用户输入原样保留在块后（含空行分隔）', () => {
  const input = '第一行\n**加粗** 和 `代码` 🎉\n  前后有空格  ';
  const out = buildPrompt(FULL_CTX, input);
  assert.ok(out.endsWith(input), '用户输入必须逐字出现在末尾');
  assert.ok(out.includes('[/Zotero context]\n\n第一行'));
});

test('prompt: date 取年份 — "2023-05-12" → 2023', () => {
  const out = buildPrompt({ ...FULL_CTX, date: '2023-05-12' }, Q);
  assert.ok(out.includes('Year: 2023\n'));
});

test('prompt: date 只有一位年份 "2019" → 2019', () => {
  const out = buildPrompt({ ...FULL_CTX, date: '2019' }, Q);
  assert.ok(out.includes('Year: 2019\n'));
});

test('prompt: 多位作者逗号连接', () => {
  const out = buildPrompt(
    { ...FULL_CTX, creators: ['张三', '李四', '王五'] },
    Q,
  );
  assert.ok(out.includes('Authors: 张三, 李四, 王五'));
});

test('prompt: 单作者无分隔符', () => {
  const out = buildPrompt({ ...FULL_CTX, creators: ['张三'] }, Q);
  assert.ok(out.includes('Authors: 张三\n'));
});

test('prompt: 中文标题 + emoji 划选原样进入块', () => {
  const out = buildPrompt(
    { ...FULL_CTX, displayTitle: '深度学习综述：从 CNN 到 Transformer 📄', selection: '关键结论 ✅' },
    Q,
  );
  assert.ok(out.includes('Title: 深度学习综述：从 CNN 到 Transformer 📄'));
  assert.ok(out.includes('"关键结论 ✅"'));
});
