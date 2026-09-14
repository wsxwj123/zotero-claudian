// 黑盒复现测试 — R17 P9「记住规则」的安全判定（生成侧）
//
// 契约来源：.devflow/BRIEF-R17b.md §5（症状 5 / 根因 #5）、.devflow/INTERFACE-R17.md §5.1
//   （buildRememberRule 新增 null 分支：首词/工具名含安全集以外字符即不记住，绝不退化成整名 Bash）。
// 只测 src/contract.ts 导出的 buildRememberRule；不看实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRememberRule } from "../../src/contract.ts";

// ---- 场景 1：Bash 首词含 cmd.exe 引号/元字符 → 不记住 ----

test('P9-1 🔴 Bash 首词 a"&calc&"b（cmd 注入）→ 返回 null（本次放行、不记住）', () => {
  assert.equal(
    buildRememberRule(
      "Bash",
      { command: 'a"&calc&"b rm -rf ~' },
      "acceptEdits",
    ),
    null,
  );
});

test('P9-1 🔒 恶意首词绝不退化成整名 "Bash"（那等于放行所有 Bash 命令）', () => {
  const out = buildRememberRule(
    "Bash",
    { command: 'a"&calc&"b rm -rf ~' },
    "acceptEdits",
  );
  assert.notEqual(out, "Bash");
});

// ---- 场景 2：非 Bash 工具名本身带引号/元字符 → 不记住 ----

test('P9-2 🔴 恶意工具名 mcp__x__a"&calc&"b → 返回 null（不产生规则）', () => {
  assert.equal(
    buildRememberRule('mcp__x__a"&calc&"b', {}, "acceptEdits"),
    null,
  );
});

// ---- 场景 3：首词为 * → 不记住（Bash(* *) 等于放行一切命令）----

test("P9-3 🔴 Bash 首词为 *（* x）→ 返回 null（避免 Bash(* *) 放行所有命令）", () => {
  assert.equal(
    buildRememberRule("Bash", { command: "* x" }, "acceptEdits"),
    null,
  );
});

// ---- 场景 7：正常首词照旧记住（回归锁）----

test('P9-7 🔒 Bash "git status" → "Bash(git *)"', () => {
  assert.equal(
    buildRememberRule("Bash", { command: "git status" }, "acceptEdits"),
    "Bash(git *)",
  );
});

test('P9-7 🔒 Bash "npm install" → "Bash(npm *)"', () => {
  assert.equal(
    buildRememberRule("Bash", { command: "npm install" }, "acceptEdits"),
    "Bash(npm *)",
  );
});

test('P9-7 🔒 Bash "python3.12 -V" → "Bash(python3.12 *)"（含点与数字）', () => {
  assert.equal(
    buildRememberRule("Bash", { command: "python3.12 -V" }, "acceptEdits"),
    "Bash(python3.12 *)",
  );
});

test('P9-7 🔒 Bash "./run.sh" → "Bash(./run.sh *)"（含 . 与 /）', () => {
  assert.equal(
    buildRememberRule("Bash", { command: "./run.sh" }, "acceptEdits"),
    "Bash(./run.sh *)",
  );
});
