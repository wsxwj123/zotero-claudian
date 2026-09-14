// R15 黑盒单测 —— 候选枚举与序（scanClaudeCandidates，纯函数）。
// 契约来源：.devflow/INTERFACE-R15.md §1.1/§1.2 与 PLAN-R15 §4/§4.1（只读契约面，不读实现）。
// exists / mtimeMs / fileSize 全部由用例注入，零真实 IO。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanClaudeCandidates,
  type CliCandidate,
} from "../../src/modules/cliDetect.ts";

const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

const WIN_NPM = "C:\\Users\\x\\AppData\\Roaming\\npm";
const WIN_CMD_SHELL = WIN_NPM + "\\claude.cmd";
// 真实 npm 布局：包内真二进制在 bin/ 段（W-A13 坐实）
const WIN_PKG_EXE =
  WIN_NPM + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

const sources = (cs: CliCandidate[]) => cs.map((c) => c.source);
const paths = (cs: CliCandidate[]) => cs.map((c) => c.path);

test("r15 scan: win32 四桶顺序 = path → registry → npm-prefix → resident", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\p"],
    registryPathDirs: ["C:\\r"],
    npmPrefixDirs: ["C:\\n"],
    residentDirs: ["C:\\s"],
    exists: existsIn(
      "C:\\p\\claude.exe",
      "C:\\r\\claude.exe",
      "C:\\n\\claude.exe",
      "C:\\s\\claude.exe",
    ),
  });
  assert.deepEqual(sources(scan.candidates), [
    "path",
    "registry",
    "npm-prefix",
    "resident",
  ]);
  assert.deepEqual(paths(scan.candidates), [
    "C:\\p\\claude.exe",
    "C:\\r\\claude.exe",
    "C:\\n\\claude.exe",
    "C:\\s\\claude.exe",
  ]);
  for (const c of scan.candidates) {
    assert.ok(c.via.length > 0, "每个候选要有诊断用的 via 短标识");
  }
});

test("r15 scan: 同目录 .exe 优先于 .cmd", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\a"],
    exists: existsIn("C:\\a\\claude.exe", "C:\\a\\claude.cmd"),
  });
  assert.equal(scan.candidates[0].path, "C:\\a\\claude.exe");
  assert.equal(scan.candidates[0].channel, "direct");
  assert.equal(scan.candidates[0].source, "path");
  const cmdIdx = scan.candidates.findIndex(
    (c) => c.path === "C:\\a\\claude.cmd",
  );
  assert.ok(cmdIdx === -1 || cmdIdx > 0, ".cmd 不得排在同目录 .exe 之前");
});

test("r15 scan: .cmd 命中且包内 exe 存在 → 候选是包内 exe（direct，不是 .cmd 壳）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.equal(scan.candidates[0].path, WIN_PKG_EXE);
  assert.equal(scan.candidates[0].channel, "direct");
  assert.equal(scan.candidates[0].source, "path");
});

test("r15 scan: override 存在 → 唯一候选（其它桶即使命中也不进列）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\p"],
    override: "C:\\opt\\claude.exe",
    exists: existsIn("C:\\opt\\claude.exe", "C:\\p\\claude.exe"),
  });
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].path, "C:\\opt\\claude.exe");
  assert.equal(scan.candidates[0].channel, "direct");
  assert.equal(scan.candidates[0].source, "override");
});

test("r15 scan: override 指向 .cmd 且包内 exe 在 → 唯一候选是包内 exe", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].path, WIN_PKG_EXE);
  assert.equal(scan.candidates[0].channel, "direct");
  assert.equal(scan.candidates[0].source, "override");
});

test("r15 scan: override 指向 .cmd 且包内 exe 缺 → 落 .cmd 壳（cmd 通道）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL),
  });
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].path, WIN_CMD_SHELL);
  assert.equal(scan.candidates[0].channel, "cmd");
  assert.equal(scan.candidates[0].source, "override");
});

test("r15 scan: override 不存在 → 回落自动解析（无 override 候选）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\p"],
    override: "C:\\gone\\claude.exe",
    exists: existsIn("C:\\p\\claude.exe"),
  });
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].source, "path");
  assert.equal(scan.candidates[0].path, "C:\\p\\claude.exe");
});

test("r15 scan: darwin 只走 pathDirs → residentDirs（注册表/npm-prefix 被平台挡住）", () => {
  const scan = scanClaudeCandidates({
    platform: "darwin",
    pathDirs: ["/usr/local/bin"],
    registryPathDirs: ["C:\\reg"],
    npmPrefixDirs: ["C:\\npm-prefix"],
    residentDirs: ["/Users/x/.local/bin"],
    exists: existsIn(
      "/usr/local/bin/claude",
      "C:\\reg\\claude.exe",
      "C:\\npm-prefix\\claude.exe",
      "/Users/x/.local/bin/claude",
    ),
  });
  assert.deepEqual(sources(scan.candidates), ["path", "resident"]);
  assert.deepEqual(paths(scan.candidates), [
    "/usr/local/bin/claude",
    "/Users/x/.local/bin/claude",
  ]);
});

test("r15 scan: darwin 多目录严格按 PATH 序（不按 mtime 重排）", () => {
  const scan = scanClaudeCandidates({
    platform: "darwin",
    pathDirs: ["/a", "/b"],
    exists: existsIn("/a/claude", "/b/claude"),
    mtimeMs: (p) => (p.startsWith("/b") ? 200 : 100),
  });
  assert.deepEqual(paths(scan.candidates), ["/a/claude", "/b/claude"]);
});

test("r15 scan: win32 PATH 桶恒保 PATH 序（注入相反 mtime 也不重排）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\a", "C:\\b"],
    exists: existsIn("C:\\a\\claude.exe", "C:\\b\\claude.exe"),
    mtimeMs: (p) => (p.startsWith("C:\\b") ? 200 : 100),
  });
  assert.deepEqual(paths(scan.candidates), [
    "C:\\a\\claude.exe",
    "C:\\b\\claude.exe",
  ]);
});

test("r15 scan: resident 桶内并列候选按 mtime 新者优先", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    residentDirs: ["C:\\s1", "C:\\s2"],
    exists: existsIn("C:\\s1\\claude.exe", "C:\\s2\\claude.exe"),
    mtimeMs: (p) => (p.startsWith("C:\\s2") ? 200 : 100),
  });
  assert.deepEqual(paths(scan.candidates), [
    "C:\\s2\\claude.exe",
    "C:\\s1\\claude.exe",
  ]);
});

test("r15 scan: npm-prefix 桶内并列候选按 mtime 新者优先", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    npmPrefixDirs: ["C:\\n1", "C:\\n2"],
    exists: existsIn("C:\\n1\\claude.exe", "C:\\n2\\claude.exe"),
    mtimeMs: (p) => (p.startsWith("C:\\n2") ? 200 : 100),
  });
  assert.deepEqual(paths(scan.candidates), [
    "C:\\n2\\claude.exe",
    "C:\\n1\\claude.exe",
  ]);
});

test("r15 scan: 不注入 mtimeMs → 桶内保持原序（旧行为）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    residentDirs: ["C:\\s1", "C:\\s2"],
    exists: existsIn("C:\\s1\\claude.exe", "C:\\s2\\claude.exe"),
  });
  assert.deepEqual(paths(scan.candidates), [
    "C:\\s1\\claude.exe",
    "C:\\s2\\claude.exe",
  ]);
});

test("r15 scan: 空输入不抛，返回空候选列（错误契约：任何输入都产 CandidateScan）", () => {
  const win = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    exists: () => false,
  });
  assert.deepEqual(win.candidates, []);
  const darwin = scanClaudeCandidates({
    platform: "darwin",
    pathDirs: [],
    registryPathDirs: undefined,
    npmPrefixDirs: undefined,
    residentDirs: undefined,
    exists: () => false,
  });
  assert.deepEqual(darwin.candidates, []);
});
