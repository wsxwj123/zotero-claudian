// 验收测试 — §4.6 permissionResponse remember 规则串生成算法（INTERFACE.md）
// 被测契约：src/contract.ts 导出 buildRememberRule(tool: string, input: unknown,
//           mode: 'default'|'acceptEdits'|'plan') → 规则串字符串，或 null = 不追加
// 前置：本函数只在 allow=true 且 remember=true 时被调用（调用方保证），测试只测生成算法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRememberRule } from '../../src/contract.ts';

// ---- Bash：记首个词 + " *" ----

test('remember: Bash "python -V" → "Bash(python *)"', () => {
  assert.equal(buildRememberRule('Bash', { command: 'python -V' }, 'acceptEdits'), 'Bash(python *)');
});

test('remember: Bash "git status" → "Bash(git *)"', () => {
  assert.equal(buildRememberRule('Bash', { command: 'git status' }, 'acceptEdits'), 'Bash(git *)');
});

test('remember: Bash 命令首词带路径 "python3.12 -V" → 以首词为前缀', () => {
  assert.equal(buildRememberRule('Bash', { command: 'python3.12 -V' }, 'acceptEdits'), 'Bash(python3.12 *)');
});

test('remember: Bash 前导空格命令 "  python -V" → "Bash(python *)"', () => {
  assert.equal(buildRememberRule('Bash', { command: '  python -V' }, 'acceptEdits'), 'Bash(python *)');
});

test('remember: Bash command 为空字符串 → 记整名 "Bash"', () => {
  assert.equal(buildRememberRule('Bash', { command: '' }, 'acceptEdits'), 'Bash');
});

test('remember: Bash command 非字符串（数字）→ 记整名 "Bash"', () => {
  assert.equal(buildRememberRule('Bash', { command: 42 }, 'acceptEdits'), 'Bash');
});

test('remember: Bash 无 command 字段 → 记整名 "Bash"', () => {
  assert.equal(buildRememberRule('Bash', {}, 'acceptEdits'), 'Bash');
});

test('remember: Bash 纯空白命令 → 记整名 "Bash"', () => {
  assert.equal(buildRememberRule('Bash', { command: '   ' }, 'acceptEdits'), 'Bash');
});

// ---- Edit/Write/NotebookEdit：acceptEdits 不追加；default 记整名 ----

test('remember: Edit + acceptEdits → null（已默认放行，不追加）', () => {
  assert.equal(buildRememberRule('Edit', { file_path: '/a.md' }, 'acceptEdits'), null);
});

test('remember: Write + acceptEdits → null', () => {
  assert.equal(buildRememberRule('Write', { file_path: '/a.md' }, 'acceptEdits'), null);
});

test('remember: NotebookEdit + acceptEdits → null', () => {
  assert.equal(buildRememberRule('NotebookEdit', {}, 'acceptEdits'), null);
});

test('remember: Edit + default → "Edit"（整名）', () => {
  assert.equal(buildRememberRule('Edit', { file_path: '/a.md' }, 'default'), 'Edit');
});

test('remember: Write + default → "Write"', () => {
  assert.equal(buildRememberRule('Write', { file_path: '/a.md' }, 'default'), 'Write');
});

// ---- MCP 工具：整名 ----

test('remember: MCP 工具 → mcp__<server>__<tool> 整名（任何档位）', () => {
  assert.equal(buildRememberRule('mcp__zotero__search', {}, 'acceptEdits'), 'mcp__zotero__search');
  assert.equal(buildRememberRule('mcp__zotero__search', {}, 'default'), 'mcp__zotero__search');
});

// ---- 其余工具：记整名，不带参数前缀 ----

test('remember: Read → "Read"，不含路径参数', () => {
  assert.equal(buildRememberRule('Read', { file_path: '/Users/secret/x.pdf' }, 'acceptEdits'), 'Read');
});

test('remember: WebFetch / Glob / Grep → 整名', () => {
  assert.equal(buildRememberRule('WebFetch', { url: 'https://x' }, 'default'), 'WebFetch');
  assert.equal(buildRememberRule('Glob', { pattern: '*' }, 'default'), 'Glob');
  assert.equal(buildRememberRule('Grep', { pattern: 'x' }, 'default'), 'Grep');
});

// ---- plan 档行为与 default 一致（未免除的工具记整名）----

test('remember: Bash + plan → 仍按首词规则生成', () => {
  assert.equal(buildRememberRule('Bash', { command: 'ls -la' }, 'plan'), 'Bash(ls *)');
});

test('remember: Edit + plan → 记整名 "Edit"（plan 无 acceptEdits 免除）', () => {
  assert.equal(buildRememberRule('Edit', { file_path: '/a.md' }, 'plan'), 'Edit');
});

// ---- 生成规则串里绝不泄露文件路径（反向用例）----

test('remember: 任何工具的规则串都不包含用户文件路径', () => {
  const out = buildRememberRule('Read', { file_path: '/Users/alice/秘密/论文.pdf' }, 'default');
  assert.equal(out, 'Read');
  assert.ok(!out.includes('alice'));
});
