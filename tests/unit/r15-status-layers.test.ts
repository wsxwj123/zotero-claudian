// R15 黑盒单测 —— 探测结论分层（F7 evaluateCliStatus）。
// 契约来源：INTERFACE-R15 §1.4（错误码 + 文案红线）与 PLAN-R15 §6（分支表）。
// 文案红线：超时 / 真失败一律不得出现「安装完整 / 重新安装 / 重装」；未找到要指向「重开本面板」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCliStatus,
  CLAUDE_INSTALL_URL,
  type CliProbeFacts,
} from "../../src/modules/cliDetect.ts";

const base = {
  resolvedPath: "C:\\Users\\me\\.local\\bin\\claude.exe",
  override: "",
  overrideExists: false,
  auth: null,
} satisfies Omit<CliProbeFacts, "version">;

const REINSTALL_WORDS = ["安装完整", "重新安装", "重装"];

test("r15 status: 探测超时 → CLAUDE_PROBE_TIMEOUT，且不劝重装", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { timedOut: true } as CliProbeFacts["version"],
  });
  assert.equal(s.ok, false);
  assert.equal(s.code, "CLAUDE_PROBE_TIMEOUT");
  assert.ok(s.message.length > 0, "失败必须带文案");
  for (const w of REINSTALL_WORDS) {
    assert.ok(!s.message.includes(w), `超时文案不得出现「${w}」`);
  }
  assert.notEqual(s.code, "CLAUDE_NOT_FOUND", "超时不是「没装」");
  assert.notEqual(s.code, "CLAUDE_EXEC_FAILED", "超时不是「执行失败」");
});

test("r15 status: 契约形态的超时（failed+timedOut+reason）同样归到 CLAUDE_PROBE_TIMEOUT", () => {
  // INTERFACE §1.4 把超时写成 { failed: true; timedOut: boolean; reason: string }
  const s = evaluateCliStatus({
    ...base,
    version: {
      failed: true,
      timedOut: true,
      reason: "probe timed out after 10000ms",
    } as unknown as CliProbeFacts["version"],
  });
  assert.equal(s.code, "CLAUDE_PROBE_TIMEOUT");
  for (const w of REINSTALL_WORDS) {
    assert.ok(!s.message.includes(w), `超时文案不得出现「${w}」`);
  }
});

test("r15 status: 真失败 → CLAUDE_EXEC_FAILED 且带 reason 原文", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { failed: true, reason: "spawn EPERM" },
  });
  assert.equal(s.ok, false);
  assert.equal(s.code, "CLAUDE_EXEC_FAILED");
  assert.ok(s.message.includes("spawn EPERM"), "带执行失败原文，便于定位");
  assert.ok(s.message.includes(base.resolvedPath), "带路径");
  for (const w of REINSTALL_WORDS) {
    assert.ok(!s.message.includes(w), `失败文案不得出现「${w}」`);
  }
});

test("r15 status: 真失败但无 reason → 仍是 CLAUDE_EXEC_FAILED，文案非空", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { failed: true } as CliProbeFacts["version"],
  });
  assert.equal(s.code, "CLAUDE_EXEC_FAILED");
  assert.ok(s.message.length > 0);
});

test("r15 status: 未找到 → CLAUDE_NOT_FOUND，文案指向「重开本面板」而非「重启 Zotero」", () => {
  const s = evaluateCliStatus({
    resolvedPath: null,
    override: "",
    overrideExists: false,
    version: null,
    auth: null,
  });
  assert.equal(s.code, "CLAUDE_NOT_FOUND");
  assert.ok(s.message.includes(CLAUDE_INSTALL_URL), "保留安装入口");
  assert.match(s.message, /(重开|重新打开)本面板/, "要告诉用户不重启也能生效");
  // 文案里可以出现「重启」字样，但必须全是否定形态（「无需重启」），
  // 不得再出现「重启 Zotero 才生效」这类误导指令
  const restarts = s.message.split("重启").length - 1;
  const negated = s.message.split("无需重启").length - 1;
  assert.equal(
    restarts,
    negated,
    `「重启」只允许出现在「无需重启」里：${s.message}`,
  );
});

test("r15 status: 旧四态逐字不回归 —— 版本过旧 → CLAUDE_VERSION_TOO_OLD", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { major: 1 },
    auth: { loggedIn: true },
  });
  assert.equal(s.code, "CLAUDE_VERSION_TOO_OLD");
  assert.ok(s.message.includes("v1"));
});

test("r15 status: 旧四态逐字不回归 —— 未登录 → CLAUDE_AUTH_FAILED", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { major: 2 },
    auth: { loggedIn: false },
  });
  assert.equal(s.code, "CLAUDE_AUTH_FAILED");
});

test("r15 status: 旧四态逐字不回归 —— override 无效 → CLI_PATH_OVERRIDE_INVALID（含回落说明）", () => {
  const s = evaluateCliStatus({
    ...base,
    override: "C:\\gone\\claude.exe",
    overrideExists: false,
    version: { major: 2 },
    auth: { loggedIn: true },
  });
  assert.equal(s.ok, false);
  assert.equal(s.code, "CLI_PATH_OVERRIDE_INVALID");
  assert.ok(s.message.includes("C:\\gone\\claude.exe"));
  assert.ok(s.message.includes(base.resolvedPath), "说明回落到了哪份");
});

test("r15 status: 旧四态逐字不回归 —— 全绿 → ok，code=null、message 空串", () => {
  const s = evaluateCliStatus({
    ...base,
    version: { major: 2 },
    auth: { loggedIn: true },
  });
  assert.deepEqual(s, { ok: true, code: null, message: "" });
});
