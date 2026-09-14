// 黑盒复现测试 — R17 P9 cmd.exe 通道的引号状态注入门（buildWin32CmdInvocation）
//
// 契约来源：.devflow/INTERFACE-R17.md §5.4（Win32CmdInvocation 失败原因加 ARG_BREAKS_QUOTING；
//   判据 = 对组装后的整行模拟 cmd.exe 引号状态，遇 " 翻转，& | < > ^ 任一落在引号外即拒；
//   行尾停在引号内不算破坏；引号状态整行共享 → 跨参数攻击也要拒）与 .devflow/BRIEF-R17b.md §5。
// 只测 src/contract.ts 导出的 buildWin32CmdInvocation / buildSpawnArgs；不看实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWin32CmdInvocation, buildSpawnArgs } from "../../src/contract.ts";

const EXE = "C:\\npm\\claude.cmd";
const CMD_EXE = "C:\\Windows\\System32\\cmd.exe";

// ---- 场景 4：单个记住规则打破引号 → 拒绝启动 ----

test('P9-4 🔴 argv 含 Bash(a"&calc&"b *) → 拒绝（SPAWN_FAILED / ARG_BREAKS_QUOTING）', () => {
  const r = buildWin32CmdInvocation(
    EXE,
    ["--allowedTools", 'Bash(a"&calc&"b *)'],
    CMD_EXE,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "SPAWN_FAILED");
  assert.equal(r.reason, "ARG_BREAKS_QUOTING");
});

// ---- 场景 5：跨参数攻击——两参单看无害，合并后 & 落到引号外 ----

test('P9-5 🔴 跨参数 Bash(a"b *) + Bash(x&calc *) → 合行后拒绝（ARG_BREAKS_QUOTING）', () => {
  const r = buildWin32CmdInvocation(
    EXE,
    ['Bash(a"b *)', "Bash(x&calc *)"],
    CMD_EXE,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "SPAWN_FAILED");
  assert.equal(r.reason, "ARG_BREAKS_QUOTING");
});

test('P9-5 🔒 单参 Bash(a"b *) 独立成行 → 通过（行尾停在引号内不算破坏）', () => {
  const r = buildWin32CmdInvocation(EXE, ['Bash(a"b *)'], CMD_EXE);
  assert.equal(r.ok, true);
});

test("P9-5 🔒 单参 Bash(x&calc *) 独立成行 → 通过（& 被引号包住）", () => {
  const r = buildWin32CmdInvocation(EXE, ["Bash(x&calc *)"], CMD_EXE);
  assert.equal(r.ok, true);
});

// ---- 场景 8：合法参数不误拒（回归锁）----

test("P9-8 🔒 路径内含 & 但被引号包住（C:\\a&b\\c）→ 通过", () => {
  const r = buildWin32CmdInvocation(EXE, ["--add-dir", "C:\\a&b\\c"], CMD_EXE);
  assert.equal(r.ok, true);
});

test('P9-8 🔒 CRT 反斜杠紧邻引号 a\\"b（win32-spawn 锁定形态）→ 通过', () => {
  const r = buildWin32CmdInvocation(EXE, ['a\\"b'], CMD_EXE);
  assert.equal(r.ok, true);
});

test('P9-8 🔒 参数内成对裸引号 he said "hi" → 通过（引号偶数、无外泄元字符）', () => {
  const r = buildWin32CmdInvocation(EXE, ['he said "hi"'], CMD_EXE);
  assert.equal(r.ok, true);
});

test("P9-8 🔒 生产启动行（含内联 --mcp-config JSON 的成对转义引号）→ 通过", () => {
  const argv = buildSpawnArgs({
    permissionMode: "acceptEdits",
    mcpPort: 52100,
    mcpToken: "tok123",
  });
  const r = buildWin32CmdInvocation(EXE, argv, CMD_EXE);
  assert.equal(r.ok, true);
});
