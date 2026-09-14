// R15 黑盒单测 —— 体积门（F2）与 fail-open 选择（pickClaudeCandidate）。
// 契约来源：INTERFACE-R15 §1.1/§1.2 / PLAN-R15 §5（L2 层）+ REVIEW-R15 重要-4（拿不到大小就放过）。
// 门限口径：.exe 且 fileSize 可读且 < 5MB → sizeOk=false；.cmd 恒过；拿不到（未注入/抛错/NaN）恒过。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanClaudeCandidates,
  pickClaudeCandidate,
  resolveClaudeCommand,
} from "../../src/modules/cliDetect.ts";

const MIN = 5 * 1024 * 1024;
const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

const scanOne = (fileSize?: (p: string) => number) =>
  scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\a"],
    exists: existsIn("C:\\a\\claude.exe"),
    fileSize,
  });

test("r15 size: .exe 恰好 5MB → 过门（下界含等号）", () => {
  const scan = scanOne(() => MIN);
  assert.equal(scan.candidates[0].sizeOk, true);
});

test("r15 size: .exe 1KB → 不过门，但仍保留在候选列里（不静默消失）", () => {
  const scan = scanOne(() => 1024);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].sizeOk, false);
  assert.equal(scan.candidates[0].path, "C:\\a\\claude.exe");
});

test("r15 size: 未注入 fileSize → .exe 恒过门（旧行为）", () => {
  const scan = scanOne(undefined);
  assert.equal(scan.candidates[0].sizeOk, true);
});

test("r15 size: fileSize 抛错 → 放过（fail-open，不当残缺处理）", () => {
  const scan = scanOne(() => {
    throw new Error("EACCES: 读不到大小");
  });
  assert.equal(scan.candidates[0].sizeOk, true);
});

test("r15 size: fileSize 返回 NaN → 放过（拿不到大小就放过）", () => {
  const scan = scanOne(() => Number.NaN);
  assert.equal(scan.candidates[0].sizeOk, true);
});

test("r15 size: .cmd 不受体积门约束（fileSize 报 1KB 也过门）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\a"],
    exists: existsIn("C:\\a\\claude.cmd"),
    fileSize: () => 1024,
  });
  assert.equal(scan.candidates[0].sizeOk, true);
  assert.equal(scan.candidates[0].channel, "cmd");
});

test("r15 pick: 同目录 .exe 不过门 + .cmd 过门 → 选 .cmd（不选坏 .exe）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\a"],
    exists: existsIn("C:\\a\\claude.exe", "C:\\a\\claude.cmd"),
    fileSize: () => 1024,
  });
  const picked = pickClaudeCandidate(scan);
  assert.equal(picked?.path, "C:\\a\\claude.cmd");
  assert.equal(picked?.channel, "cmd");
});

test("r15 pick: 存在过门者时取过门者，即使它不在候选列首位", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: ["C:\\small", "C:\\big"],
    exists: existsIn("C:\\small\\claude.exe", "C:\\big\\claude.exe"),
    fileSize: (p) => (p.startsWith("C:\\small") ? 1024 : MIN),
  });
  const picked = pickClaudeCandidate(scan);
  assert.equal(picked?.path, "C:\\big\\claude.exe");
});

test("r15 pick: 全部候选都不过门 → 回落第一个存在的（绝不因体积门变成 not_found）", () => {
  const env = {
    platform: "win32" as const,
    pathDirs: ["C:\\a", "C:\\b"],
    exists: existsIn("C:\\a\\claude.exe", "C:\\b\\claude.exe"),
    fileSize: () => 1024,
  };
  const scan = scanClaudeCandidates(env);
  assert.deepEqual(
    scan.candidates.map((c) => c.sizeOk),
    [false, false],
  );
  const picked = pickClaudeCandidate(scan);
  assert.equal(picked?.path, "C:\\a\\claude.exe");
  // 同一事实经 resolveClaudeCommand 出口：found，不是 not_found
  const r = resolveClaudeCommand(env);
  assert.equal(r.status, "found");
  assert.equal(r.status === "found" && r.path, "C:\\a\\claude.exe");
});

test("r15 pick: 空候选列 → null", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [],
    exists: () => false,
  });
  assert.equal(pickClaudeCandidate(scan), null);
});
