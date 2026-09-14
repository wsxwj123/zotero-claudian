// R15 黑盒单测 —— resolveClaudeCommand 等价性回归锁（F1 改成薄包装后不得漂移）。
// 契约来源：INTERFACE-R15 §1.3「不注入 npmPrefixDirs/mtimeMs 时与旧实现等价」；
// 断言面与既有 tests/unit/cliDetect.test.ts 的 win32 五态一致（本文件独立复写，不复用其 helper）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeCommand } from "../../src/modules/cliDetect.ts";

const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

const WIN_NPM = "C:\\Users\\x\\AppData\\Roaming\\npm";
const WIN_CMD_SHELL = WIN_NPM + "\\claude.cmd";
const WIN_PKG_EXE =
  WIN_NPM + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

test("r15 等价: win32 同目录 .exe 优先于 .cmd（source=path，direct）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: ["C:\\bin"],
    exists: existsIn("C:\\bin\\claude.exe", "C:\\bin\\claude.cmd"),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: "C:\\bin\\claude.exe",
    source: "path",
  });
});

test("r15 等价: win32 PATH 命中 .cmd 壳 → 解析到包内 exe（source=path）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: WIN_PKG_EXE,
    source: "path",
  });
});

test("r15 等价: win32 注册表 PATH 命中 → source=registry", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    registryPathDirs: ["C:\\Tools"],
    exists: existsIn("C:\\Tools\\claude.exe"),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: "C:\\Tools\\claude.exe",
    source: "registry",
  });
});

test("r15 等价: win32 常驻目录兜底 → source=resident", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    residentDirs: ["C:\\Users\\x\\.local\\bin"],
    exists: existsIn("C:\\Users\\x\\.local\\bin\\claude.exe"),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: "C:\\Users\\x\\.local\\bin\\claude.exe",
    source: "resident",
  });
});

test("r15 等价: win32 全空 → not_found / CLAUDE_NOT_FOUND", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    exists: () => false,
  });
  assert.deepEqual(r, { status: "not_found", error: "CLAUDE_NOT_FOUND" });
});

test("r15 等价: win32 override .cmd + 包内 exe 在 → source=override（direct）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: WIN_PKG_EXE,
    source: "override",
  });
});

test("r15 等价: win32 override .cmd + 包内 exe 缺 → cmd 通道 + source=override", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "cmd",
    path: WIN_CMD_SHELL,
    source: "override",
  });
});

test("r15 等价: darwin 前目录无命中 → 顺延下一目录（PATH 序，direct + path）", () => {
  const r = resolveClaudeCommand({
    platform: "darwin",
    pathDirs: ["/opt/homebrew/bin", "/Users/x/.local/bin"],
    exists: existsIn("/Users/x/.local/bin/claude"),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: "/Users/x/.local/bin/claude",
    source: "path",
  });
});
