// 单测 — utils 纯函数（paths / promptTemplate / rememberRule）+ contract 桶文件导出核对
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinPath,
  defaultWorkspacePath,
  buildPrompt,
  buildRememberRule,
  mapStreamLine,
  buildSpawnArgs,
  resolveClaudeCommand,
  buildSpawnEnv,
  buildWin32CmdInvocation,
  classifyProcError,
  extractToolResultSummary,
} from "../../src/contract.ts";

// ---- joinPath 边界 ----

test("join: 多段/尾分隔符/根段不产生双分隔符", () => {
  assert.equal(
    joinPath("darwin", "/Users", "x", "claudian"),
    "/Users/x/claudian",
  );
  assert.equal(joinPath("darwin", "/Users/", "x"), "/Users/x");
  assert.equal(joinPath("win32", "C:\\", "x"), "C:\\x");
  assert.equal(joinPath("darwin", "/", "x"), "/x", "纯根段不叠加");
  assert.equal(joinPath("win32", "\\", "x"), "\\x");
});

test("join: 空段跳过；linux 走 POSIX 分隔符（PLAN §2.3 darwin/Linux 同范式）", () => {
  assert.equal(joinPath("darwin", "", "a", "", "b"), "a/b");
  assert.equal(joinPath("linux", "/opt", "bin"), "/opt/bin");
});

test("join: 段内已带前导分隔符的后续段不叠加", () => {
  assert.equal(joinPath("darwin", "/a", "/b"), "/a/b");
  assert.equal(joinPath("win32", "C:\\a", "\\b"), "C:\\a\\b");
});

// ---- defaultWorkspacePath ----

test("workspace: documentsDir 缺省时 darwin 回落 <home>/Documents", () => {
  assert.equal(
    defaultWorkspacePath("darwin", { home: "/Users/x" }),
    "/Users/x/Documents/zotero-claudian-workspace",
  );
});

test("workspace: documentsDir 优先于 home 推导（两平台一致）", () => {
  assert.equal(
    defaultWorkspacePath("win32", {
      home: "C:\\Users\\x",
      documentsDir: "D:\\Docs",
    }),
    "D:\\Docs\\zotero-claudian-workspace",
  );
});

// ---- buildPrompt 边界（验收 prompt.test.mjs 之外）----

const CTX = {
  itemKey: "ITEM1",
  displayTitle: "T",
  creators: ["A"],
  date: "2024-01-01",
  doi: null,
  abstractNote: "",
  pdfPath: null,
  currentPage: 1,
  pageLabel: null,
  selection: null,
  selectionPage: null,
  selectionItemKey: null,
};

test("prompt: 无作者 → Authors 行省略；date 缺失 → Year 行省略", () => {
  const out = buildPrompt({ ...CTX, creators: [], date: null }, "q");
  assert.ok(!out.includes("Authors:"));
  assert.ok(!out.includes("Year:"));
  assert.ok(out.includes("Title: T"));
});

test("prompt: date 无四位年份（如「民国百年」）→ Year 行省略不猜", () => {
  const out = buildPrompt({ ...CTX, date: "民国百年" }, "q");
  assert.ok(!out.includes("Year:"));
});

test("prompt: date 中嵌年份（「Published 2018 by X」）→ 提取 2018", () => {
  const out = buildPrompt({ ...CTX, date: "Published 2018 by X" }, "q");
  assert.ok(out.includes("Year: 2018"));
});

test("prompt: 块内值含 \\r\\n 一并单行化", () => {
  const out = buildPrompt({ ...CTX, displayTitle: "a\r\nb" }, "q");
  assert.ok(out.includes("Title: a b"));
});

test("prompt: 划选所属条目为 undefined → 省略 Selected text 行（不因缺字段崩溃）", () => {
  const out = buildPrompt({ ...CTX, selection: "s" }, "q");
  assert.ok(!out.includes("Selected text"));
});

test("prompt: 划选存在且条目匹配但无页码 → 整行省略（BUG-06，不输出空括号畸形行）", () => {
  const out = buildPrompt(
    {
      ...CTX,
      selection: "关键句",
      selectionItemKey: "ITEM1",
      selectionPage: null,
    },
    "q",
  );
  assert.ok(!out.includes("Selected text"));
  assert.ok(
    !out.includes("关键句"),
    "划选文本不得离开 Selected text 行单独出现",
  );
  assert.ok(!out.includes("(page )"));
});

test("prompt: 通用会话 itemKey 为 undefined 同样整块省略", () => {
  assert.equal(buildPrompt({}, "只有这句"), "只有这句");
});

// ---- buildRememberRule 边界 ----

test("remember: input 非 record（null/数组/标量）→ Bash 记整名不抛错", () => {
  for (const bad of [null, undefined, [1], "x", 3]) {
    assert.equal(buildRememberRule("Bash", bad, "acceptEdits"), "Bash");
  }
});

test("remember: Bash 多空白分隔命令取首个词；制表符分隔同样处理", () => {
  assert.equal(
    buildRememberRule("Bash", { command: "\tgit\tstatus" }, "plan"),
    "Bash(git *)",
  );
});

test("remember: Bash 命令首词含特殊字符原样记录（规则串语法交 CLI 实测校验）", () => {
  assert.equal(
    buildRememberRule("Bash", { command: "./run.sh -x" }, "default"),
    "Bash(./run.sh *)",
  );
});

test("remember: Write + plan 档记整名（plan 无 acceptEdits 免除）", () => {
  assert.equal(buildRememberRule("Write", {}, "plan"), "Write");
});

// ---- contract 桶文件：M2 范围导出齐全且可用 ----

test("contract: M2 全部契约函数经桶文件可达", () => {
  assert.equal(typeof mapStreamLine, "function");
  assert.equal(typeof extractToolResultSummary, "function");
  assert.equal(typeof buildSpawnArgs, "function");
  assert.equal(typeof classifyProcError, "function");
  assert.equal(typeof resolveClaudeCommand, "function");
  assert.equal(typeof buildSpawnEnv, "function");
  assert.equal(typeof buildWin32CmdInvocation, "function");
  assert.equal(typeof joinPath, "function");
  assert.equal(typeof defaultWorkspacePath, "function");
  assert.equal(typeof buildPrompt, "function");
  assert.equal(typeof buildRememberRule, "function");
});
