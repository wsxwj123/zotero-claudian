// R12 安全复查：`--resume` 的 argv 汇点必须自校验（防 flag smuggling / 参数注入）
// 判据唯一来源 src/utils/ids.ts —— 与 sessionStore 的路径边界共用同一份。
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSpawnArgs } from "../../src/modules/cliRunner.ts";
import { isSafeSessionId, SESSION_ID_PATTERN } from "../../src/utils/ids.ts";
import { isSafeId } from "../../src/utils/sessionStore.ts";

/** 最小合法参数（permissionMode/端口/token 都要过各自的校验） */
function opts(over: Record<string, unknown> = {}) {
  return {
    permissionMode: "acceptEdits" as const,
    mcpPort: 12345,
    mcpToken: "tok-abc",
    ...over,
  } as never;
}

test("R12 argv：合法 id → 正常带 --resume <id>", () => {
  const args = buildSpawnArgs(opts({ resumeClaudeSessionId: "abc-123_DEF" }));
  const i = args.indexOf("--resume");
  assert.ok(i >= 0, "应带 --resume");
  assert.equal(args[i + 1], "abc-123_DEF");
});

test("R12 argv：`--foo` 形态的 id 必须抛错（flag smuggling）", () => {
  for (const bad of [
    "--dangerously-skip-permissions",
    "-p",
    "--resume",
    "-x",
  ]) {
    assert.throws(
      () => buildSpawnArgs(opts({ resumeClaudeSessionId: bad })),
      /invalid resumeClaudeSessionId/,
      `应拒绝：${bad}`,
    );
  }
});

test("R12 argv：空串 = 无 resume（既有 falsy 语义，不抛也不带参数）", () => {
  const args = buildSpawnArgs(opts({ resumeClaudeSessionId: "" }));
  assert.equal(args.includes("--resume"), false);
});

test("R12 argv：路径上跳/分隔符/空白/超长的 id 必须抛错", () => {
  for (const bad of [
    "../../etc/passwd",
    "a/b",
    "a\\b",
    " ",
    "a".repeat(65),
  ]) {
    assert.throws(
      () => buildSpawnArgs(opts({ resumeClaudeSessionId: bad })),
      /invalid resumeClaudeSessionId/,
      `应拒绝：${JSON.stringify(bad)}`,
    );
  }
});

test("R12 argv：不带 id 时不抛（首轮正常）", () => {
  const args = buildSpawnArgs(opts());
  assert.equal(args.includes("--resume"), false);
});

test("R12 判据唯一来源：sessionStore.isSafeId 与 utils/ids 口径一致", () => {
  const samples = [
    "abc",
    "abc-123_DEF",
    "--foo",
    "-lead",
    "a/b",
    "",
    "a".repeat(64),
    "a".repeat(65),
    "中文",
  ];
  for (const s of samples) {
    assert.equal(
      isSafeId(s),
      isSafeSessionId(s),
      `口径不一致：${JSON.stringify(s)}`,
    );
  }
  assert.equal(SESSION_ID_PATTERN.test("abc-123_DEF"), true);
});
