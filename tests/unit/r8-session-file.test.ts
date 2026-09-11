// 单测 — R8「按会话 id 定位 CLI 会话文件」（符号链接/长路径工作区下回滚/分支不可用的修复）。
//
// 背景（主会话真机实测）：CLI 的项目目录名派生自它自己看到的**物理路径**（Node process.cwd()，
// macOS 上 /tmp → /private/tmp；Windows junction/8.3 短名同理），宿主配置里的工作区原串却是
// 符号链接路径 → encodeProjectDir 推出来的目录名跟 CLI 的落点根本不是同一个 → 快照照不到
// 源文件 → 回滚/分支静默不可用。修复口径：不复刻 slug，改成按 `<claudeSessionId>.jsonl` 找文件。
//
// 锁定的契约点：
//   1) 快路径：`<projectsRoot>/<encodeProjectDir(cwd)>/<id>.jsonl` 存在 → 直接返回（**零扫描**）
//   2) 慢路径：扫 projectsRoot **一层**，谁下面有该 <id>.jsonl 就是它（返回的 projectDir =
//      实际命中的目录名，不是 cwd 现推的那个）
//   3) 都找不到 → null（调用方 fail-safe：按钮禁用/拒绝回滚，绝不猜路径）
//   4) id 必须过 sessionStore 白名单：非法 id 直接 null 且**一个 fs 调用都不发**（防 `../` 注入）
//   5) 扫描有上限（PROJECTS_SCAN_LIMIT=500）：超限只扫前 500 个目录，仍未命中则 log + null
//   6) 命中路径原样返回（不 realpath——读写要用同一拼法）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTS_SCAN_LIMIT,
  encodeProjectDir,
  findClaudeSessionFile,
  type RewindFs,
} from "../../src/utils/rewind.ts";

const ROOT = "/home/u/.claude/projects";
const WS_LINK = "/tmp/ws"; // 符号链接路径（配置里的原串）
const WS_REAL = "/private/tmp/ws"; // CLI 实际看到的物理路径
const ID = "0f8c1a2b-3d4e-5f60-7a8b-9c0d1e2f3a4b";

/** 内存 fs：files = 存在的文件集；children = listNames 的返回；两条都记调用 */
function fakeFs(
  files: string[] = [],
  children: Record<string, string[]> = {},
  opts: { listThrows?: boolean } = {},
) {
  const fsSet = new Set(files);
  const calls = { exists: [] as string[], listNames: [] as string[] };
  const fs: RewindFs = {
    readText: async () => null,
    writeText: async () => {},
    async listNames(dir) {
      calls.listNames.push(dir);
      if (opts.listThrows) {
        throw new Error("EACCES");
      }
      return children[dir] ?? [];
    },
    async makeDir() {},
    async remove() {},
    async exists(p) {
      calls.exists.push(p);
      return fsSet.has(p);
    },
    join: (...seg) => seg.join("/"),
  };
  return { fs, calls };
}

test("R8-SESSION-FILE 快路径命中：直接返回推导目录，零扫描", async () => {
  const derived = encodeProjectDir(WS_LINK);
  const { fs, calls } = fakeFs([`${ROOT}/${derived}/${ID}.jsonl`]);
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.deepEqual(found, {
    path: `${ROOT}/${derived}/${ID}.jsonl`,
    projectDir: derived,
  });
  assert.equal(calls.listNames.length, 0, "快路径命中不许扫目录");
  assert.equal(calls.exists.length, 1, "快路径只探一次存在性");
});

test("R8-SESSION-FILE 快路径未命中 + 慢路径命中：符号链接工作区也找得到真文件", async () => {
  // CLI 实际落在物理路径的目录名（-private-tmp-ws），我们推的是 -tmp-ws
  const derived = encodeProjectDir(WS_LINK);
  const real = encodeProjectDir(WS_REAL);
  assert.notEqual(derived, real, "夹具前提：两种拼法必须推出不同目录名");
  const { fs, calls } = fakeFs([`${ROOT}/${real}/${ID}.jsonl`], {
    [ROOT]: [real, "-Users-me-other"],
  });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.deepEqual(found, {
    path: `${ROOT}/${real}/${ID}.jsonl`,
    projectDir: real,
  });
  // 只扫一层：listNames 只对本根调用一次，命中的目录不再往里扫
  assert.deepEqual(calls.listNames, [ROOT]);
});

test("R8-SESSION-FILE 长路径（cwd 原串与 CLI 真名都超 200 截断）也能命中", async () => {
  const longLink = `/tmp/${"x".repeat(220)}`;
  const longReal = `/private/tmp/${"x".repeat(220)}`;
  const real = encodeProjectDir(longReal);
  const { fs } = fakeFs([`${ROOT}/${real}/${ID}.jsonl`], {
    [ROOT]: [real],
  });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: longLink },
    { fs },
  );
  assert.equal(found?.projectDir, real);
  assert.equal(found?.path, `${ROOT}/${real}/${ID}.jsonl`);
});

test("R8-SESSION-FILE 都找不到 → null（调用方 fail-safe，不猜）", async () => {
  const { fs, calls } = fakeFs([], { [ROOT]: ["-Users-me-a", "-Users-me-b"] });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found, null);
  assert.deepEqual(calls.listNames, [ROOT]);
  // 探测的都是「本 id 在该目录下」的路径，不会拿别人的会话文件冒充
  assert.ok(calls.exists.every((p) => p.endsWith(`/${ID}.jsonl`)));
});

test("R8-SESSION-FILE 目录里只有别人的同名会话 id 不同 → null", async () => {
  const { fs } = fakeFs([`${ROOT}/-Users-me-a/OTHER-ID.jsonl`], {
    [ROOT]: ["-Users-me-a"],
  });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found, null);
});

test("R8-SESSION-FILE 非法 id → 直接 null 且一个 fs 调用都不发（防 `../` 注入）", async () => {
  const bad = [
    "",
    "..",
    ".",
    "../evil",
    "a/../../b",
    "a\\b",
    "-leading-dash",
    "x".repeat(65),
    "a b",
  ];
  for (const id of bad) {
    const { fs, calls } = fakeFs([
      `${ROOT}/${encodeProjectDir(WS_LINK)}/${id}.jsonl`,
    ]);
    const found = await findClaudeSessionFile(
      { projectsRoot: ROOT, claudeSessionId: id, cwd: WS_LINK },
      { fs },
    );
    assert.equal(found, null, `非法 id 必须拒绝：${JSON.stringify(id)}`);
    assert.equal(calls.exists.length, 0, `非法 id 不许探存在性：${id}`);
    assert.equal(calls.listNames.length, 0, `非法 id 不许扫目录：${id}`);
  }
});

test("R8-SESSION-FILE 扫描上限：超限只扫前 500 个目录，命中算命中", async () => {
  const names = Array.from(
    { length: PROJECTS_SCAN_LIMIT + 20 },
    (_, i) => `-dir-${i}`,
  );
  const target = names[3];
  const { fs, calls } = fakeFs([`${ROOT}/${target}/${ID}.jsonl`], {
    [ROOT]: names,
  });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found?.projectDir, target);
  // 快路径 1 次 + 扫描 ≤ 上限次（命中即停）
  assert.ok(
    calls.exists.length <= PROJECTS_SCAN_LIMIT + 1,
    `存在性探测次数应受上限约束：${calls.exists.length}`,
  );
});

test("R8-SESSION-FILE 扫描上限：目标在限外 → null + 留 log，且不越界多探", async () => {
  const names = Array.from(
    { length: PROJECTS_SCAN_LIMIT + 20 },
    (_, i) => `-dir-${i}`,
  );
  const target = names[names.length - 1];
  const { fs, calls } = fakeFs([`${ROOT}/${target}/${ID}.jsonl`], {
    [ROOT]: names,
  });
  const logs: string[] = [];
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs, log: (m) => logs.push(m) },
  );
  assert.equal(found, null);
  assert.equal(calls.listNames.length, 1, "只扫一层：listNames 只对根调用");
  assert.ok(
    calls.exists.length <= PROJECTS_SCAN_LIMIT + 1,
    `不许无上限扫描：${calls.exists.length}`,
  );
  assert.ok(
    logs.some((m) => m.includes(String(PROJECTS_SCAN_LIMIT))),
    `超限要留日志：${JSON.stringify(logs)}`,
  );
});

test("R8-SESSION-FILE 目录名异常（带分隔符/上跳）不参与拼接", async () => {
  const { fs, calls } = fakeFs([`${ROOT}/../outside/${ID}.jsonl`], {
    [ROOT]: ["..", "../outside", "ok-dir"],
  });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found, null, "含分隔符/上跳的目录名不参与拼接");
  assert.ok(
    !calls.exists.some((p) => p.includes("..")),
    JSON.stringify(calls.exists),
  );
});

test("R8-SESSION-FILE 扫目录抛错 → null（不把异常抛给调用方）", async () => {
  const { fs } = fakeFs([], {}, { listThrows: true });
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found, null);
});

test("R8-SESSION-FILE 快路径与慢路径都命中时用快路径（不扫、结果稳定）", async () => {
  const derived = encodeProjectDir(WS_LINK);
  const real = encodeProjectDir(WS_REAL);
  const { fs, calls } = fakeFs(
    [`${ROOT}/${derived}/${ID}.jsonl`, `${ROOT}/${real}/${ID}.jsonl`],
    { [ROOT]: [real] },
  );
  const found = await findClaudeSessionFile(
    { projectsRoot: ROOT, claudeSessionId: ID, cwd: WS_LINK },
    { fs },
  );
  assert.equal(found?.projectDir, derived);
  assert.equal(calls.listNames.length, 0);
});
