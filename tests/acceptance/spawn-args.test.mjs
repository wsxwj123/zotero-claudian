// 验收测试 — §4.1 spawn 命令行组装 + §4.2 SESSION_GONE 判定（INTERFACE.md）
// 被测契约：src/contract.ts 导出 buildSpawnArgs(opts)、classifyProcError({exitCode, stderrTail, reason})
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnArgs, classifyProcError } from '../../src/contract.ts';

const BASE = { permissionMode: 'acceptEdits', mcpPort: 52100, mcpToken: 'tok123' };

test('spawn: 首轮最小参数 → 精确序列', () => {
  const args = buildSpawnArgs(BASE);
  const mcpJson = JSON.stringify({
    mcpServers: {
      'claudian-perm': { type: 'http', url: 'http://127.0.0.1:52100/mcp?token=tok123' },
    },
  });
  assert.deepEqual(args, [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--mcp-config', mcpJson,
    '--permission-prompt-tool', 'mcp__claudian-perm__permission_check',
  ]);
});

test('spawn: 续接 → --resume 插在基础参数之后、--permission-mode 之前', () => {
  const args = buildSpawnArgs({ ...BASE, resumeClaudeSessionId: 'abc-123' });
  assert.equal(args.indexOf('--resume'), 5);
  assert.equal(args[6], 'abc-123');
  assert.equal(args.indexOf('--permission-mode'), 7);
});

test('spawn: resumeClaudeSessionId=null（首轮）→ 不出现 --resume', () => {
  const args = buildSpawnArgs(BASE);
  assert.ok(!args.includes('--resume'));
});

test('spawn: 三种权限档逐一带入', () => {
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    const args = buildSpawnArgs({ ...BASE, permissionMode: mode });
    assert.ok(args.includes(mode), `应携带 ${mode}`);
    const i = args.indexOf('--permission-mode');
    assert.equal(args[i + 1], mode);
  }
});

test('spawn: 有 PDF → --add-dir 位于 --permission-mode 之后、--allowedTools 之前', () => {
  const args = buildSpawnArgs({ ...BASE, addDir: '/Users/x/papers' });
  const iAdd = args.indexOf('--add-dir');
  assert.ok(iAdd > args.indexOf('--permission-mode'), 'add-dir 在 permission-mode 后');
  assert.equal(args[iAdd + 1], '/Users/x/papers');
});

test('spawn: 无 PDF → 不带 --add-dir', () => {
  const args = buildSpawnArgs(BASE);
  assert.ok(!args.includes('--add-dir'));
});

test('spawn: 多个 PDF 附件也只加第一个所在目录（调用方传入单个 addDir 即单值）', () => {
  // 契约：--add-dir 后跟且仅跟一个目录参数
  const args = buildSpawnArgs({ ...BASE, addDir: '/a/b' });
  const i = args.indexOf('--add-dir');
  assert.equal(args[i + 1], '/a/b');
  assert.notEqual(args[i + 2], '--add-dir');
});

test('spawn: allowedTools 非空 → 逐条独立传参（--allowedTools 后多个值）', () => {
  const args = buildSpawnArgs({
    ...BASE,
    allowedTools: ['Bash(python *)', 'Read', 'mcp__foo__bar'],
  });
  const i = args.indexOf('--allowedTools');
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i + 1, i + 4), ['Bash(python *)', 'Read', 'mcp__foo__bar']);
  assert.equal(args[i + 4], '--mcp-config');
});

test('spawn: allowedTools 为空数组 → 不带 --allowedTools', () => {
  const args = buildSpawnArgs({ ...BASE, allowedTools: [] });
  assert.ok(!args.includes('--allowedTools'));
});

test('spawn: mcp-config JSON 结构精确（server 名/type/url 含 token）', () => {
  const args = buildSpawnArgs({ ...BASE, mcpPort: 12345, mcpToken: 'XyZ' });
  const raw = args[args.indexOf('--mcp-config') + 1];
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, {
    mcpServers: {
      'claudian-perm': { type: 'http', url: 'http://127.0.0.1:12345/mcp?token=XyZ' },
    },
  });
});

test('spawn: 恒不带 --strict-mcp-config（用户自有 MCP 配置照常生效）', () => {
  const args = buildSpawnArgs(BASE);
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('spawn: 恒不携带的参数一个都不出现', () => {
  const args = buildSpawnArgs({ ...BASE, resumeClaudeSessionId: 'abc' });
  for (const flag of ['--bare', '--model', '--append-system-prompt', '--fork-session']) {
    assert.ok(!args.includes(flag), `不得携带 ${flag}`);
  }
});

test('spawn: PDF 目录带空格 → 单一参数不被拆分', () => {
  const dir = '/Users/x/My Papers/2024 顶部会话';
  const args = buildSpawnArgs({ ...BASE, addDir: dir });
  const i = args.indexOf('--add-dir');
  assert.equal(args[i + 1], dir, '带空格路径必须是数组中的一个完整元素');
});

test('spawn: 全参数齐备时的完整顺序锁定', () => {
  const args = buildSpawnArgs({
    ...BASE,
    resumeClaudeSessionId: 'sid',
    permissionMode: 'default',
    addDir: '/d',
    allowedTools: ['Read'],
    mcpPort: 1,
    mcpToken: 't',
  });
  const order = [
    '--resume', '--permission-mode', '--add-dir', '--allowedTools', '--mcp-config', '--permission-prompt-tool',
  ].map((f) => args.indexOf(f));
  for (let k = 1; k < order.length; k++) {
    assert.ok(order[k] > order[k - 1], `参数顺序错误: ${order}`);
  }
});

// ---- classifyProcError（§4.2 procError + §4.6 错误码）----

test('classify: stderr 含 "No conversation found" → SESSION_GONE', () => {
  const r = classifyProcError({ exitCode: 1, stderrTail: 'Error: No conversation found with session ID abc' });
  assert.equal(r, 'SESSION_GONE');
});

test('classify: stderr 含 session 不存在类报错 → SESSION_GONE', () => {
  const r = classifyProcError({ exitCode: 1, stderrTail: 'session not found: dead-id' });
  assert.equal(r, 'SESSION_GONE');
});

test('classify: 其他非 0 退出 → GENERIC', () => {
  const r = classifyProcError({ exitCode: 1, stderrTail: 'ECONNREFUSED something else' });
  assert.equal(r, 'GENERIC');
});

test('classify: stderr 为空且非 0 退出 → GENERIC（不误判 SESSION_GONE）', () => {
  const r = classifyProcError({ exitCode: 1, stderrTail: '' });
  assert.equal(r, 'GENERIC');
});

test('classify: spawn ENOENT → CLAUDE_NOT_FOUND', () => {
  const r = classifyProcError({ exitCode: null, stderrTail: '', reason: 'ENOENT' });
  assert.equal(r, 'CLAUDE_NOT_FOUND');
});

test('classify: SESSION_GONE 关键字大小写不敏感（no conversation found 也算）', () => {
  const r = classifyProcError({ exitCode: 1, stderrTail: 'No Conversation Found' });
  assert.equal(r, 'SESSION_GONE');
});
