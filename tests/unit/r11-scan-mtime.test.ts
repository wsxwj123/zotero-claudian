// R11：`~/.claude/projects` 扫描的候选顺序——**有 mtimeMs 能力时按 mtime 降序**
// （超扫描上限时，最近写过的项目目录更可能是目标）；没有该能力时回落按目录名（既有行为）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECTS_SCAN_LIMIT,
  lookupClaudeSessionFile,
} from "../../src/utils/rewind.ts";

const TARGET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** 造 N 个目录名（字母序与 mtime 序刻意相反），只有 targetDir 里有目标 jsonl */
function makeFs(opts: {
  withMtime: boolean;
  targetDir: string;
  dirs: string[];
}) {
  const stats: string[] = [];
  const fs = {
    async readText() {
      return null;
    },
    async writeText() {},
    async listNames() {
      return [...opts.dirs];
    },
    async makeDir() {},
    async remove() {},
    async exists(path: string) {
      return (
        path.endsWith(`/${TARGET_ID}.jsonl`) && path.includes(opts.targetDir)
      );
    },
    join: (...seg: string[]) => seg.join("/"),
    ...(opts.withMtime
      ? {
          async mtimeMs(path: string) {
            stats.push(path);
            // 目标目录 mtime 最新；其余按目录名逆序给值（制造 mtime 序 ≠ 名字序）
            if (path.endsWith(opts.targetDir)) {
              return 9_000_000;
            }
            const idx = opts.dirs.indexOf(path.split("/").pop() ?? "");
            return 1_000 + idx;
          },
        }
      : {}),
  };
  return { fs, stats };
}

test("R11 扫描顺序：目标目录名字靠后、但 mtime 最新 → 仍能在上限内命中", async () => {
  const dirCount = PROJECTS_SCAN_LIMIT + 40; // 超上限：名字序会把它截在窗口外
  const dirs = Array.from(
    { length: dirCount },
    (_, i) => `-dir-${String(i).padStart(4, "0")}`,
  );
  const target = dirs[dirCount - 1]; // 名字序最后一个 → 纯名字序必被截掉
  const { fs } = makeFs({ withMtime: true, targetDir: target, dirs });
  const r = await lookupClaudeSessionFile(
    {
      projectsRoot: "/root",
      claudeSessionId: TARGET_ID,
      cwd: "/nonexistent-cwd",
    },
    { fs: fs as never },
  );
  assert.ok(r.found, "有 mtime 能力时应命中（mtime 降序把目标排到最前）");
  assert.equal(r.found!.projectDir, target);
  assert.equal(r.capped, false);
});

test("R11 扫描顺序：同一个目录集，没有 mtime 能力时按名字序（既有行为，目标被上限截掉 → capped）", async () => {
  const dirCount = PROJECTS_SCAN_LIMIT + 40;
  const dirs = Array.from(
    { length: dirCount },
    (_, i) => `-dir-${String(i).padStart(4, "0")}`,
  );
  const target = dirs[dirCount - 1];
  const { fs } = makeFs({ withMtime: false, targetDir: target, dirs });
  const r = await lookupClaudeSessionFile(
    {
      projectsRoot: "/root",
      claudeSessionId: TARGET_ID,
      cwd: "/nonexistent-cwd",
    },
    { fs: fs as never },
  );
  assert.equal(r.found, null, "名字序下目标在窗口外 → 找不到");
  assert.equal(r.capped, true, "且必须如实标出被上限截断");
});

test("R11 扫描顺序：mtime 取不到（抛错/非数字）→ 该条垫底，不影响整体扫描", async () => {
  const dirs = ["-a-", "-b-", "-c-"];
  const fs = {
    async readText() {
      return null;
    },
    async writeText() {},
    async listNames() {
      return dirs;
    },
    async makeDir() {},
    async remove() {},
    async exists(path: string) {
      return path.endsWith(`/${TARGET_ID}.jsonl`) && path.includes("-c-");
    },
    join: (...seg: string[]) => seg.join("/"),
    async mtimeMs(path: string) {
      if (path.endsWith("-b-")) {
        throw new Error("stat failed");
      }
      if (path.endsWith("-a-")) {
        return Number.NaN;
      }
      return 5;
    },
  };
  const r = await lookupClaudeSessionFile(
    {
      projectsRoot: "/root",
      claudeSessionId: TARGET_ID,
      cwd: "/nonexistent-cwd",
    },
    { fs: fs as never },
  );
  assert.ok(r.found, "哪怕有坏条目也要扫完并命中");
  assert.equal(r.found!.projectDir, "-c-");
});

test("R11 扫描顺序：mtime 相同 → 回落到目录名升序（结果可复现）", async () => {
  const dirs = ["-b-", "-a-", "-c-"];
  const mk = (targetIn: string) => ({
    async readText() {
      return null;
    },
    async writeText() {},
    async listNames() {
      return dirs;
    },
    async makeDir() {},
    async remove() {},
    async exists(path: string) {
      return path.endsWith(`/${TARGET_ID}.jsonl`) && path.includes(targetIn);
    },
    join: (...seg: string[]) => seg.join("/"),
    async mtimeMs() {
      return 42;
    },
  });
  const r1 = await lookupClaudeSessionFile(
    { projectsRoot: "/root", claudeSessionId: TARGET_ID, cwd: "/x" },
    { fs: mk("-a-") as never },
  );
  const r2 = await lookupClaudeSessionFile(
    { projectsRoot: "/root", claudeSessionId: TARGET_ID, cwd: "/x" },
    { fs: mk("-a-") as never },
  );
  assert.deepEqual(r1, r2, "同输入必得同结果");
});
