// R11 建议-3：`findClaudeSessionFile` 的 `capped`（「没扫完」标志）与扫描顺序确定化。
// R11 API 收敛：capped 已并入 findClaudeSessionFile 的返回形状（原 lookupClaudeSessionFile 已合并）。
// 契约：① 目录数 > PROJECTS_SCAN_LIMIT 且未命中 → capped=true（/diag 靠它区分「找不到」与「没找完」）
//      ② 目录数 ≤ 上限且未命中 → capped=false（真扫完了，确实没有）
//      ③ 命中 → capped=false（不管目录总数多少）
//      ④ 扫描顺序按目录名自然序（数字段按数值比）：同一目录集每次结果相同
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTS_SCAN_LIMIT,
  findClaudeSessionFile,
  type RewindFs,
} from "../../src/utils/rewind.ts";

const ROOT = "/home/u/.claude/projects";
const ID = "0f8c1a2b-3d4e-5f60-7a8b-9c0d1e2f3a4b";

/** 内存 fs：files = 存在的文件集；children = listNames 的返回 */
function fakeFs(files: string[], children: Record<string, string[]>) {
  const fsSet = new Set(files);
  const fs: RewindFs = {
    readText: async () => null,
    writeText: async () => {},
    async listNames(dir) {
      return children[dir] ?? [];
    },
    async makeDir() {},
    async remove() {},
    async exists(p) {
      return fsSet.has(p);
    },
    join: (...seg) => seg.join("/"),
  };
  return { fs };
}

test("R11 capped：目录数超上限且未命中 → capped=true", async () => {
  const names = Array.from(
    { length: PROJECTS_SCAN_LIMIT + 1 },
    (_, i) => `-dir-${i}`,
  );
  const { fs } = fakeFs([], { [ROOT]: names });
  const r = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: "/tmp/ws" },
    { fs },
  );
  assert.equal(r.found, null);
  assert.equal(r.capped, true, "扫满上限仍未命中必须标出来");
});

test("R11 capped：目录数未超上限且未命中 → capped=false（真扫完了）", async () => {
  const { fs } = fakeFs([], { [ROOT]: ["-dir-a", "-dir-b"] });
  const r = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: "/tmp/ws" },
    { fs },
  );
  assert.equal(r.found, null);
  assert.equal(r.capped, false);
});

test("R11 capped：命中时 capped=false（上限与命中无关）", async () => {
  const names = Array.from(
    { length: PROJECTS_SCAN_LIMIT + 5 },
    (_, i) => `-dir-${i}`,
  );
  const { fs } = fakeFs([`${ROOT}/-dir-9000/${ID}.jsonl`], {
    [ROOT]: [...names, "-dir-9000"],
  });
  const r = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: "/tmp/ws" },
    { fs },
  );
  assert.equal(
    r.found,
    null,
    "自然序下 -dir-9000 排在限外 → 找不到（顺序确定、可复现）",
  );
  assert.equal(r.capped, true);
});

test("R11 扫描顺序：自然序（数字段按数值比），命中位置可复现", async () => {
  // -dir-3 在限内（自然序第 4 个）；code-unit 序会把它排到 -dir-30 之后
  const names = Array.from(
    { length: PROJECTS_SCAN_LIMIT + 20 },
    (_, i) => `-dir-${i}`,
  );
  const { fs } = fakeFs([`${ROOT}/-dir-3/${ID}.jsonl`], { [ROOT]: names });
  const r = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: "/tmp/ws" },
    { fs },
  );
  assert.equal(r.found?.projectDir, "-dir-3");
  assert.equal(r.capped, false);
});
