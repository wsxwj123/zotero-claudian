// 验收测试 — §4.1 可执行文件解析（按 OS 参数化）+ spawn env 组装（INTERFACE.md v2 Windows 增补）
// 被测契约：src/contract.ts 导出
//   resolveClaudeCommand(env) → 命令发现：
//     darwin：PATH 逐目录 → 常驻目录兜底；win32：进程 PATH → 注册表快照 PATH → 常驻目录兜底；
//     win32 命中 .cmd 壳时优先解析到包内 claude.exe（channel='direct'），解析失败才落 .cmd 壳（channel='cmd'）；
//     cliPathOverride 非空且存在 → 直接采用；override 不存在 → 回落自动解析。
//   buildSpawnEnv(platform, input) → spawn 环境组装：
//     darwin：PATH 整体替换为登录 shell PATH（':' 连接）；win32：PATH = 进程 PATH ∪ 注册表快照 ∪ 常驻目录
//     （';' 连接、按首现去重），并保证 SystemRoot/TEMP 在环境内；其余环境变量原样透传。
// 输入全部显式注入（pathDirs/exists 等纯数据），断言为「环境输入 → 确切返回」。
// 包内 exe 探测路径（2026-09-11 修订，实测 npm 包布局）：<cmd壳目录>\node_modules\@anthropic-ai\claude-code\bin\claude.exe
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeCommand, buildSpawnEnv } from '../../src/contract.ts';

const existsIn = (...paths) => (p) => paths.includes(p);
const WIN_NPM = 'C:\\Users\\x\\AppData\\Roaming\\npm';
const WIN_CMD_SHELL = WIN_NPM + '\\claude.cmd';
const WIN_PKG_EXE = WIN_NPM + '\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

// ---- darwin 发现规则 ----

test('detect: darwin PATH 逐目录取第一个命中（前目录 miss、后目录命中）', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/usr/local/bin', '/opt/homebrew/bin'],
    residentDirs: ['/Users/x/.local/bin'],
    exists: existsIn('/opt/homebrew/bin/claude'),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: '/opt/homebrew/bin/claude', source: 'path' });
});

test('detect: darwin 多目录同时命中 → 严格按 PATH 顺序取第一个', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/a/bin', '/b/bin'],
    exists: existsIn('/a/bin/claude', '/b/bin/claude'),
  });
  assert.equal(r.path, '/a/bin/claude');
  assert.equal(r.source, 'path');
});

test('detect: darwin PATH 全 miss → 常驻目录兜底命中', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/usr/bin', '/bin'],
    residentDirs: ['/Users/x/.local/bin'],
    exists: existsIn('/Users/x/.local/bin/claude'),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: '/Users/x/.local/bin/claude', source: 'resident' });
});

test('detect: darwin PATH+常驻全 miss → 确切错误 CLAUDE_NOT_FOUND', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/usr/bin'],
    residentDirs: ['/Users/x/.local/bin'],
    exists: () => false,
  });
  assert.deepEqual(r, { status: 'not_found', error: 'CLAUDE_NOT_FOUND' });
});

test('detect: cliPathOverride 存在 → 直接采用，不查 PATH', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/usr/bin'],
    override: '/opt/claude/bin/claude',
    exists: existsIn('/opt/claude/bin/claude', '/usr/bin/claude'),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: '/opt/claude/bin/claude', source: 'override' });
});

test('detect: cliPathOverride 不存在 → 回落自动解析（§4.4 校验失败回落）', () => {
  const r = resolveClaudeCommand({
    platform: 'darwin',
    pathDirs: ['/usr/bin'],
    override: '/nonexistent/claude',
    exists: existsIn('/usr/bin/claude'),
  });
  assert.equal(r.status, 'found');
  assert.equal(r.path, '/usr/bin/claude');
  assert.equal(r.source, 'path');
});

// ---- win32 发现规则 ----

test('detect: win32 PATH 目录含 claude.exe → 直接返回 exe（direct 通道）', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\Program Files\\claude'],
    exists: existsIn('C:\\Program Files\\claude\\claude.exe'),
  });
  assert.deepEqual(r, {
    status: 'found', channel: 'direct',
    path: 'C:\\Program Files\\claude\\claude.exe', source: 'path',
  });
});

test('detect: win32 命中 npm .cmd 壳且包内 exe 存在 → 解析到包内 claude.exe（不走 cmd.exe 通道）', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: WIN_PKG_EXE, source: 'path' });
});

test('detect: win32 仅 .cmd 壳、包内 exe 解析失败 → 落 .cmd 壳（channel=cmd，走 cmd.exe 通道）', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL),
  });
  assert.deepEqual(r, { status: 'found', channel: 'cmd', path: WIN_CMD_SHELL, source: 'path' });
});

test('detect: win32 进程 PATH miss → 注册表快照 PATH 命中', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\bin'],
    registryPathDirs: ['C:\\Tools'],
    exists: existsIn('C:\\Tools\\claude.exe'),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: 'C:\\Tools\\claude.exe', source: 'registry' });
});

test('detect: win32 PATH+注册表全 miss → 常驻目录兜底', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\bin'],
    registryPathDirs: ['C:\\Tools'],
    residentDirs: ['C:\\Users\\x\\.local\\bin'],
    exists: existsIn('C:\\Users\\x\\.local\\bin\\claude.exe'),
  });
  assert.deepEqual(r, {
    status: 'found', channel: 'direct',
    path: 'C:\\Users\\x\\.local\\bin\\claude.exe', source: 'resident',
  });
});

test('detect: win32 全 miss → 确切错误 CLAUDE_NOT_FOUND', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\bin'],
    registryPathDirs: ['C:\\Tools'],
    residentDirs: ['C:\\Users\\x\\.local\\bin'],
    exists: () => false,
  });
  assert.deepEqual(r, { status: 'not_found', error: 'CLAUDE_NOT_FOUND' });
});

test('detect: win32 PATH 与注册表快照同名目录都命中 → 进程 PATH 优先', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\bin'],
    registryPathDirs: ['C:\\bin'],
    exists: existsIn('C:\\bin\\claude.exe'),
  });
  assert.equal(r.source, 'path');
});

test('detect: win32 同目录 .exe 与 .cmd 并存 → .exe 优先（不经 cmd.exe 通道）', () => {
  const r = resolveClaudeCommand({
    platform: 'win32',
    pathDirs: ['C:\\tools'],
    exists: existsIn('C:\\tools\\claude.exe', 'C:\\tools\\claude.cmd'),
  });
  assert.deepEqual(r, { status: 'found', channel: 'direct', path: 'C:\\tools\\claude.exe', source: 'path' });
});

// ---- buildSpawnEnv（§4.1 env 行）----

test('env: darwin → PATH 整体替换为登录 shell PATH（: 连接），其余透传', () => {
  const env = buildSpawnEnv('darwin', {
    env: { HOME: '/Users/x', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' },
    shellPathDirs: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'],
  });
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/x');
  assert.equal(env.TMPDIR, '/tmp');
});

test('env: win32 → PATH = 进程 PATH ∪ 注册表快照 ∪ 常驻目录（; 连接，此序）', () => {
  const env = buildSpawnEnv('win32', {
    env: { PATH: 'C:\\bin' },
    shellPathDirs: ['C:\\bin'],
    registryPathDirs: ['C:\\Tools'],
    residentDirs: ['C:\\Users\\x\\.local\\bin'],
  });
  assert.equal(env.PATH, 'C:\\bin;C:\\Tools;C:\\Users\\x\\.local\\bin');
});

test('env: win32 重复目录按首现去重，顺序保留', () => {
  const env = buildSpawnEnv('win32', {
    env: { PATH: 'C:\\bin;C:\\other' },
    shellPathDirs: ['C:\\bin', 'C:\\Tools'],
    registryPathDirs: ['C:\\Tools'],
  });
  assert.equal(env.PATH, 'C:\\bin;C:\\other;C:\\Tools');
});

test('env: win32 用户环境缺 SystemRoot/TEMP → 保证在环境内（防残缺环境）', () => {
  const env = buildSpawnEnv('win32', {
    env: { PATH: 'C:\\bin' },
    shellPathDirs: ['C:\\bin'],
  });
  assert.ok('SystemRoot' in env, 'SystemRoot 必须在');
  assert.ok('TEMP' in env, 'TEMP 必须在');
});

test('env: win32 用户环境已有 SystemRoot/TEMP → 原值保留不覆盖', () => {
  const env = buildSpawnEnv('win32', {
    env: { SystemRoot: 'C:\\WINDOWS', TEMP: 'C:\\MyTemp', PATH: 'C:\\bin' },
    shellPathDirs: ['C:\\bin'],
  });
  assert.equal(env.SystemRoot, 'C:\\WINDOWS');
  assert.equal(env.TEMP, 'C:\\MyTemp');
});
