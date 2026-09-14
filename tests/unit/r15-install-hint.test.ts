// 单测 — R15 尾巴 + 验收裁判回归项：横幅「安装说明」按钮的显示判据
//
// 背景：R15 把「claude 跑不起来」的错误码从 CLAUDE_NOT_FOUND 改判成 CLAUDE_EXEC_FAILED，
// 而按钮条件当时仍只认 CLAUDE_NOT_FOUND → 这类横幅**反而没有安装出口了**（变相变严）。
// 本用例锁死：三种「CLI 不可用」码都要给安装出口；与 CLI 无关的码不给。
import { test } from "node:test";
import assert from "node:assert/strict";
import { showsInstallHint } from "../../src/chat/App.ts";

test("R15 🔴 三种 CLI 不可用码都给安装出口（含新码 EXEC_FAILED / PROBE_TIMEOUT）", () => {
  for (const code of [
    "CLAUDE_NOT_FOUND",
    "CLAUDE_EXEC_FAILED",
    "CLAUDE_PROBE_TIMEOUT",
  ]) {
    assert.equal(showsInstallHint(code), true, code);
  }
});

test("R15 🔒 与 CLI 无关的错误码不给安装出口（不滥用按钮）", () => {
  for (const code of [
    "SESSION_BUSY",
    "SPAWN_FAILED",
    "WORKSPACE_UNAVAILABLE",
    "SESSION_GONE",
    null,
  ]) {
    assert.equal(showsInstallHint(code), false, String(code));
  }
});
