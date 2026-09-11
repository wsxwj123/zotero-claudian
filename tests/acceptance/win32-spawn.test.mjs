// 验收测试 — §4.1 win32 派发通道：绝对路径 cmd.exe + ["/C", 整行] 包装 + CRT 转义 + 8191 上限
// 被测契约：src/contract.ts 导出 buildWin32CmdInvocation(exePath, argv, cmdExePath?)：
//   仅当解析产物为 .cmd 壳时调用（.exe 走 argv 直传，与 darwin 同构，不经本函数）。
//   成功 → { ok:true, file:<绝对路径 cmd.exe>, args:['/C', commandLine] }
//     · Gecko Subprocess 要求 command 为绝对路径（裸名 "cmd.exe" 会被 isExecutableFile 拒绝）；
//     · args 传 2 元，经 Gecko 内部 unshift(command) 后 worker 数组为 [cmd.exe,'/C',line]，
//       命中 Gecko 的 cmd.exe 特例分支（对 line 原样补最外层引号，不做 CRT 二次转义）。
//   commandLine = 各参数逐个双引号包裹、空格连接；引号内应用 CRT 规则（由 .cmd shim 透传给 node 解析）：
//     '"' → '\"'；紧邻引号的反斜杠翻倍（2n 个 → 2n 个 + \"）；其余反斜杠原样。
//   失败 → { ok:false, code:'SPAWN_FAILED', reason }：
//     任一参数含换行（\n）→ reason:'ARG_HAS_NEWLINE'（prompt 不在参数内、走 stdin，故仅 argv 检查）；
//     整行（含 exe）超 8191 字符 → reason:'CMD_LINE_TOO_LONG'，limit:8191。
// 形态修订记录（2026-09-11）：原 /d /s /c 4 元 + 裸名 cmd.exe 与 Gecko 的 cmd.exe 特例不匹配（Windows 实机必挂），
//   经平台兼容审查（.devflow/WIN-COMPAT-REPORT.md 致命-1/必修-3，crt-roundtrip 15/15 验证）修订并重锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWin32CmdInvocation, buildSpawnArgs } from '../../src/contract.ts';

const EXE = 'C:\\npm\\claude.cmd';
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';

// ---- 包装形态 ----

test('wspawn: 包装形态 → 绝对路径 cmd.exe + ["/C", 整行]（Gecko 前插 command 后命中其 cmd.exe 特例）', () => {
  const r = buildWin32CmdInvocation(EXE, ['-p'], CMD_EXE);
  assert.equal(r.ok, true);
  assert.equal(r.file, CMD_EXE);
  assert.deepEqual(r.args, ['/C', '"C:\\npm\\claude.cmd" "-p"']);
});

test('wspawn: 缺省 cmdExe → 绝对路径且以 cmd.exe 结尾（Gecko 不搜 PATH）', () => {
  const r = buildWin32CmdInvocation(EXE, ['-p']);
  assert.equal(r.ok, true);
  assert.match(r.file, /^[A-Za-z]:\\/, `cmd.exe 须为绝对路径：${r.file}`);
  assert.match(r.file, /cmd\.exe$/i, `cmd.exe 路径异常：${r.file}`);
});

test('wspawn: 生产形态全行精确断言（含 mcp-config JSON 的 \" → \\\" 转义）', () => {
  const argv = buildSpawnArgs({ permissionMode: 'acceptEdits', mcpPort: 52100, mcpToken: 'tok123' });
  const r = buildWin32CmdInvocation(EXE, argv, CMD_EXE);
  assert.equal(r.ok, true);
  assert.equal(r.file, CMD_EXE);
  assert.equal(
    r.args[1],
    '"C:\\npm\\claude.cmd" "-p" "--output-format" "stream-json" "--verbose" ' +
    '"--include-partial-messages" "--permission-mode" "acceptEdits" "--mcp-config" ' +
    '"{\\"mcpServers\\":{\\"claudian-perm\\":{\\"type\\":\\"http\\",\\"url\\":\\"http://127.0.0.1:52100/mcp?token=tok123\\"}}}" ' +
    '"--permission-prompt-tool" "mcp__claudian-perm__permission_check"',
  );
});

// ---- CRT 反斜杠/引号规则逐例 ----

test('wspawn: 尾部单反斜杠 → 收引号前翻倍（C:\\dir\\ → C:\\dir\\\\）', () => {
  const r = buildWin32CmdInvocation(EXE, ['--add-dir', 'C:\\dir\\']);
  assert.ok(r.ok);
  assert.ok(r.args[1].endsWith('"--add-dir" "C:\\dir\\\\"'), r.args[1]);
});

test('wspawn: 尾部双反斜杠 → 翻倍成四个（C:\\dir\\\\ → C:\\dir\\\\\\\\）', () => {
  const r = buildWin32CmdInvocation(EXE, ['C:\\dir\\\\']);
  assert.ok(r.ok);
  assert.ok(r.args[1].endsWith('"C:\\dir\\\\\\\\"'), r.args[1]);
});

test('wspawn: 中部反斜杠不翻倍（C:\\Users\\x 原样）', () => {
  const r = buildWin32CmdInvocation(EXE, ['C:\\Users\\x']);
  assert.ok(r.ok);
  assert.ok(r.args[1].includes('"C:\\Users\\x"'));
  assert.ok(!r.args[1].includes('\\\\'));
});

test('wspawn: 参数内裸引号 → \" （he said "hi" → he said \"hi\"）', () => {
  const r = buildWin32CmdInvocation(EXE, ['he said "hi"']);
  assert.ok(r.ok);
  assert.ok(r.args[1].endsWith('"he said \\"hi\\""'), r.args[1]);
});

test('wspawn: 参数内反斜杠紧邻引号 → 反斜杠翻倍再转义引号（a\\"b → a\\\\\\\"b）', () => {
  // 参数实际内容：a\"b（一个反斜杠紧跟一个引号）
  const r = buildWin32CmdInvocation(EXE, ['a\\"b']);
  assert.ok(r.ok);
  assert.ok(r.args[1].endsWith('"a\\\\\\"b"'), r.args[1]);
});

test('wspawn: 含空格路径 → 双引号包裹为单一元素，不拆分', () => {
  const dir = 'C:\\My Papers\\a b.pdf';
  const r = buildWin32CmdInvocation(EXE, ['--add-dir', dir]);
  assert.ok(r.ok);
  assert.ok(r.args[1].includes('"--add-dir" "C:\\My Papers\\a b.pdf"'), r.args[1]);
});

test('wspawn: 含中文路径 → 原样保留不转义', () => {
  const r = buildWin32CmdInvocation(EXE, ['C:\\文献\\论文.pdf']);
  assert.ok(r.ok);
  assert.ok(r.args[1].includes('"C:\\文献\\论文.pdf"'), r.args[1]);
});

test('wspawn: 空字符串参数 → 空双引号 ""', () => {
  const r = buildWin32CmdInvocation(EXE, ['']);
  assert.ok(r.ok);
  assert.equal(r.args[1], '"C:\\npm\\claude.cmd" ""');
});

// ---- 8191 上限 ----

test('wspawn: 整行恰 8191 字符 → 通过', () => {
  // 行长 = (exe+2 引号) + 空格 + ("--pad"+2) + 空格 + (n+2 引号)，本组无转义字符
  const n = 8191 - (EXE.length + 2) - 1 - 7 - 1 - 2;
  const r = buildWin32CmdInvocation(EXE, ['--pad', 'x'.repeat(n)]);
  assert.equal(r.ok, true);
  assert.equal(r.args[1].length, 8191);
});

test('wspawn: 整行 8192 字符 → 确切报错 CMD_LINE_TOO_LONG / limit 8191 / SPAWN_FAILED', () => {
  const n = 8192 - (EXE.length + 2) - 1 - 7 - 1 - 2;
  const r = buildWin32CmdInvocation(EXE, ['--pad', 'x'.repeat(n)]);
  assert.deepEqual(r, { ok: false, code: 'SPAWN_FAILED', reason: 'CMD_LINE_TOO_LONG', limit: 8191 });
});

// ---- 换行拒绝 ----

test('wspawn: 参数含 \\n → 拒绝该轮 spawn（ARG_HAS_NEWLINE / SPAWN_FAILED）', () => {
  const r = buildWin32CmdInvocation(EXE, ['a\nb']);
  assert.deepEqual(r, { ok: false, code: 'SPAWN_FAILED', reason: 'ARG_HAS_NEWLINE' });
});

test('wspawn: 参数含 \\r\\n → 同样拒绝', () => {
  const r = buildWin32CmdInvocation(EXE, ['a\r\nb']);
  assert.deepEqual(r, { ok: false, code: 'SPAWN_FAILED', reason: 'ARG_HAS_NEWLINE' });
});

test('wspawn: 换行拒绝与长度无关——整行很短也拒绝', () => {
  const r = buildWin32CmdInvocation(EXE, ['\n']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ARG_HAS_NEWLINE');
});
