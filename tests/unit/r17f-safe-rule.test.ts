// 黑盒复现测试 — R17 P9 记住规则安全判定的「生成与过滤同源」（isSafeRememberRule）
//
// 契约来源：.devflow/INTERFACE-R17.md §5.2（isSafeRememberRule 是生成器与 spawn 前过滤共用的唯一判定：
//   Bash(<首词> *) 首词须匹配 ^[A-Za-z0-9._/-]{1,128}$；其余整名须匹配 ^[A-Za-z0-9_.-]{1,128}$；非字符串不通过）。
// 该导出在 HEAD 尚不存在 → 本文件在修前会因 isSafeRememberRule === undefined 而整体失败（预期）；
// 故独立成文件，不连累 r17f-remember-rule / r17f-win32-quoting 的用例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRememberRule } from "../../src/contract.ts";
import { isSafeRememberRule } from "../../src/utils/rememberRule.ts";

// ---- 场景 9：同源——生成器判可记住的，过滤时必留；生成器拒的形态，过滤时必弃 ----

test("P9-9 🔒 buildRememberRule 的每个非 null 产物都必须通过 isSafeRememberRule（生成⊆安全）", () => {
  const samples: [string, unknown][] = [
    ["Bash", { command: "git status" }],
    ["Bash", { command: "npm install" }],
    ["Bash", { command: "python3.12 -V" }],
    ["Bash", { command: "./run.sh" }],
    ["Bash", { command: 'a"&calc&"b rm -rf ~' }],
    ["Bash", { command: "* x" }],
    ["Read", { file_path: "/x.pdf" }],
    ["mcp__zotero__search", {}],
    ['mcp__x__a"&calc&"b', {}],
  ];
  for (const [tool, input] of samples) {
    const rule = buildRememberRule(tool, input, "acceptEdits");
    if (rule !== null) {
      assert.ok(
        isSafeRememberRule(rule),
        `生成了却过不了安全过滤：${tool} → ${JSON.stringify(rule)}`,
      );
    }
  }
});

test('P9-9 🔒 安全规则 "Bash(git *)" 通过过滤（启动前保留）', () => {
  assert.equal(isSafeRememberRule("Bash(git *)"), true);
});

test('P9-9 🔴 旧不安全规则 "Bash(a\\"&calc&\\"b *)" 不通过过滤（启动前丢弃）', () => {
  assert.equal(isSafeRememberRule('Bash(a"&calc&"b *)'), false);
});

test('P9-9 🔴 通配首词规则 "Bash(* *)" 不通过过滤', () => {
  assert.equal(isSafeRememberRule("Bash(* *)"), false);
});

test("P9-9 🔒 整名安全规则通过：Bash / Read / mcp__zotero__search", () => {
  assert.equal(isSafeRememberRule("Bash"), true);
  assert.equal(isSafeRememberRule("Read"), true);
  assert.equal(isSafeRememberRule("mcp__zotero__search"), true);
});

test('P9-9 🔴 恶意整名 "mcp__x__a\\"&calc&\\"b" 不通过过滤', () => {
  assert.equal(isSafeRememberRule('mcp__x__a"&calc&"b'), false);
});

test("P9-9 🔒 非字符串一律不通过（数字 / null / undefined / 对象）", () => {
  assert.equal(isSafeRememberRule(42), false);
  assert.equal(isSafeRememberRule(null), false);
  assert.equal(isSafeRememberRule(undefined), false);
  assert.equal(isSafeRememberRule({}), false);
});
