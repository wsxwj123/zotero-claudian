// 单测 — R7-H「真回滚」（PLAN-R7 §3.9，黑盒：只按契约写，不看实现——本轮 R7-H 尚未开工，
// 红基线即「模块不存在/未导出」）。§3.9 的机制已由主会话真机实测确认，本文件把它当给定前提，
// 不质疑、不改机制，只锁「编排顺序、失败不跳过还原、崩溃幂等、拒绝路径」四件事。
//
// 锁定的契约点：
//   1) 快照落点 <数据目录>/snapshots/<插件会话id>/<轮序号>.jsonl；轮序号递增、空目录从 0 起
//   2) 快照 / 备份 / journal 一律 0600（断言 fs 调用带了 mode）
//   3) 分叉编排顺序（关键）：①写 journal → ②备份原文件 → ③用第 k 轮快照替换原文件
//      → ④`--resume <原id> --fork-session` → ⑤还原原文件 → ⑥清 journal
//   4) **任何一步失败都不许跳过还原**：fork 抛错仍要还原原文件并清 journal；
//      还原本身失败 → journal 保留（留给下次启动重试，不静默）
//   5) 崩溃恢复：启动时发现残留 journal → 按 journal 还原，幂等（第二次启动零动作、内容不坏）
//   6) 拒绝路径：项目目录不一致 / 快照缺失 → 拒绝且**一个字节都不动原文件**，不 fork
//   7) 分支记录：parentId / branchIndex（同一父内 1,2,3 递增，不覆盖既有）/ 标题 `<父标题>-分支<N>`
//
// 主会话裁决（2026-09-11）落进本文件的三条：
//   H1 第 0 轮快照：建会话/首轮开始前拍 `0.jsonl`（空内容），序号 max+1、空目录从 0 起
//   H2 index.json 每轮记 projectDir（collection 模式下 cwd 会随合集变）
//   H3 轮号映射（本文件只用到其中「目标快照号由调用方给」这一层；映射口径在 branchActions）：
//      「编辑」用户消息 k → 用快照 k−1（k=0 时用 0.jsonl）= 该消息**之前**的状态；
//      「分支」消息 k → 用快照 k（含该消息及其回答）。两种都是本文件的 rewindToTurn(turn)
//   H4 快照只增不删（全轮保留、无体积上限）；journal 必须清（备份文件清理不在契约内，不锁）
//   H5 单 journal + 宿主串行：并发第二次调用锁定为**被拒绝**（reason:"REWIND_BUSY"、零副作用），
//      跑完即放锁（不是一次性锁）。若实现改成「排队等」，请改这两条用例并同步本注释
//
// 假设的导出面（开发若改名，改 import 名即可；DI 面见下）：
//   src/utils/rewind.ts →
//     SNAPSHOT_FILE_MODE(0o600) / SNAPSHOT_DIR_NAME / REWIND_JOURNAL_FILE /
//     snapshotDir(dataDir, sessionId) / snapshotPath(dataDir, sessionId, turn) /
//     backupPath(dataDir, sessionId, turn) / journalPath(dataDir) /
//     nextSnapshotTurn(existingNames: string[]) -> number /
//     snapshotTurn(input, {fs}) -> {turn, path} / readSnapshotIndex(input, {fs}) ->
//       {claudeSessionId, snapshots:[{turn, projectDir}]} | null /
//     rewindToTurn(input, {fs, runner, log}) -> {ok:true, claudeSessionId} |
//       {ok:false, reason: "PROJECT_DIR_MISMATCH"|"SNAPSHOT_MISSING"|"REWIND_BUSY"|"FORK_FAILED"|
//                           "RESTORE_FAILED", error?} /
//     recoverPendingRewind({dataDir}, {fs, log}) -> {restored:boolean, error?} /
//     planBranch({parent:{id,title}, sessions}) -> {parentId, branchIndex, title}
//   fs 注入面 RewindFs：readText / writeText(path,data,{mode}) / listNames / makeDir / remove /
//     exists / join —— 与既有 SessionStoreFs 同形，多一个 writeText 的 mode 选项
//   runner 注入面：fork({args, cwd}) -> {newClaudeSessionId}
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REWIND_JOURNAL_FILE,
  SNAPSHOT_DIR_NAME,
  SNAPSHOT_FILE_MODE,
  backupPath,
  journalPath,
  nextSnapshotTurn,
  planBranch,
  readSnapshotIndex,
  recoverPendingRewind,
  rewindToTurn,
  snapshotDir,
  snapshotPath,
  snapshotTurn,
} from "../../src/utils/rewind.ts";

// ---- 测试脚手架（内存 fs + 假 runner，二者共用一条 seq 记录调用序）----

const DATA = "/data/claudian";
const SID = "sess-1"; // 插件会话 id
const CLI = "claude-sess-1"; // CLI session_id
const PROJ = "-Users-me-ws"; // 项目目录（cwd 派生）
const SOURCE = `/home/u/.claude/projects/${PROJ}/${CLI}.jsonl`; // CLI 自己的会话文件
const OTHER_PROJ = "-Users-me-other";
const ORIGINAL =
  '{"type":"user","text":"原始第1轮"}\n{"type":"user","text":"原始第2轮"}\n';
const SNAP2 = '{"type":"user","text":"原始第1轮"}\n'; // 第 2 轮结束的快照（截到第 1 轮）

const JOURNAL = journalPath(DATA);
const BACKUP2 = backupPath(DATA, SID, 2);
const SNAP2_PATH = snapshotPath(DATA, SID, 2);
const INDEX_PATH = `${snapshotDir(DATA, SID)}/index.json`;

/** 预置快照索引：说明「第 2 轮快照是在 PROJ 目录下拍的」 */
function indexJson(projectDir = PROJ, claudeSessionId = CLI) {
  return JSON.stringify({
    claudeSessionId,
    snapshots: [
      { turn: 0, projectDir },
      { turn: 2, projectDir },
    ],
  });
}

/** 内存 fs（RewindFs 同形）+ 调用序记录 */
function fakeFs(files = {}, seq = []) {
  const store = new Map(Object.entries(files));
  const events = [];
  return {
    store,
    events,
    seq,
    async readText(p) {
      return store.has(p) ? store.get(p) : null;
    },
    async writeText(p, data, opts = {}) {
      events.push({ op: "writeText", path: p, data, mode: opts?.mode });
      seq.push("write:" + p);
      store.set(p, data);
    },
    async listNames(dir) {
      const prefix = `${dir}/`;
      const names = new Set();
      for (const key of [...store.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
    async makeDir() {},
    async remove(p) {
      events.push({ op: "remove", path: p });
      seq.push("remove:" + p);
      store.delete(p);
    },
    async exists(p) {
      return store.has(p);
    },
    join: (...seg) => seg.join("/"),
  };
}

/** 假 runner：记录 fork 调用，可按需抛错 */
function fakeRunner(seq = [], opts = {}) {
  const calls = [];
  return {
    calls,
    async fork(input) {
      calls.push(input);
      seq.push("fork");
      if (opts.throwAt) throw new Error(opts.throwAt);
      return { newClaudeSessionId: "claude-fork-1" };
    },
  };
}

/** 基线环境：原文件 = 原文；快照索引 + 第 2 轮快照已就位 */
function baseFiles(extra = {}) {
  return {
    [SOURCE]: ORIGINAL,
    [INDEX_PATH]: indexJson(),
    [SNAP2_PATH]: SNAP2,
    ...extra,
  };
}

/** 把一条 fs 写/删事件翻译成编排步骤名（只认本文件锁定的 DI 形状） */
function stepOf(event, ctx = {}) {
  const source = ctx.source ?? SOURCE;
  const original = ctx.original ?? ORIGINAL;
  if (event.op === "remove")
    return event.path === JOURNAL ? "clear" : `rm:${event.path}`;
  if (event.path === JOURNAL) return "journal";
  if (event.path === BACKUP2) return "backup";
  if (event.path === source)
    return event.data === original ? "restore" : "truncate";
  return `write:${event.path}`;
}

function rewindInput(over = {}) {
  return {
    dataDir: DATA,
    sessionId: SID,
    claudeSessionId: CLI,
    turn: 2,
    projectDir: PROJ,
    sourcePath: SOURCE,
    ...over,
  };
}

const rewindDeps = (fs, runner) => ({ fs, runner, log: () => {} });

// ---- 落点与常量 ----

test("R7-H 落点：snapshotPath = <数据目录>/snapshots/<会话id>/<轮序号>.jsonl", () => {
  assert.equal(SNAPSHOT_DIR_NAME, "snapshots");
  assert.equal(snapshotDir(DATA, SID), `${DATA}/${SNAPSHOT_DIR_NAME}/${SID}`);
  assert.equal(
    snapshotPath(DATA, SID, 3),
    `${DATA}/${SNAPSHOT_DIR_NAME}/${SID}/3.jsonl`,
  );
  assert.equal(
    snapshotPath(DATA, SID, 0),
    `${DATA}/${SNAPSHOT_DIR_NAME}/${SID}/0.jsonl`,
  );
});

test("R7-H 落点：快照目录不进工作区、不入 git（只有注入的数据目录一个来源）", () => {
  assert.equal(
    snapshotDir(DATA, SID).startsWith(`${DATA}/`),
    true,
    "快照必须落在插件数据目录内",
  );
  assert.ok(!snapshotDir(DATA, SID).includes("workspace"), "不得落到工作区里");
});

test("R7-H 落点：备份与 journal 落在数据目录内，journal 是单个全局文件", () => {
  assert.equal(REWIND_JOURNAL_FILE, "rewind-journal.json");
  assert.equal(
    journalPath(DATA),
    `${DATA}/${SNAPSHOT_DIR_NAME}/${REWIND_JOURNAL_FILE}`,
  );
  assert.equal(
    backupPath(DATA, SID, 2),
    `${DATA}/${SNAPSHOT_DIR_NAME}/${SID}/2.backup.jsonl`,
  );
});

test("R7-H 序号：空目录从 0 起（第 0 轮 = 会话开始前）", () => {
  assert.equal(nextSnapshotTurn([]), 0);
});

test("R7-H 序号：递增取 max+1（不填洞——空出的号不复用，防覆盖）", () => {
  assert.equal(nextSnapshotTurn(["0.jsonl", "1.jsonl"]), 2);
  assert.equal(nextSnapshotTurn(["0.jsonl", "3.jsonl"]), 4);
});

test("R7-H 序号：忽略非序号文件（index.json / 备份 / 临时文件不计入轮序号）", () => {
  assert.equal(
    nextSnapshotTurn([
      "index.json",
      "2.backup.jsonl",
      "1.jsonl.tmp",
      "1.jsonl",
    ]),
    2,
  );
});

// ---- 快照落盘 ----

test("R7-H 快照：首拍（无既有快照）→ 0.jsonl；连拍两次 → 1.jsonl（递增、不覆盖）", async () => {
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  const deps = { fs };
  const first = await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    deps,
  );
  assert.equal(first.turn, 0);
  assert.equal(first.path, snapshotPath(DATA, SID, 0));
  const second = await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    deps,
  );
  assert.equal(second.turn, 1);
  assert.equal(second.path, snapshotPath(DATA, SID, 1));
  assert.equal(
    fs.store.get(snapshotPath(DATA, SID, 0)),
    ORIGINAL,
    "第 0 轮快照内容不被打乱",
  );
});

test("R7-H 快照：快照内容 = 原文件逐字节（不是摘要、不是截断）", async () => {
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    { fs },
  );
  assert.equal(fs.store.get(snapshotPath(DATA, SID, 0)), ORIGINAL);
});

test("R7-H 快照：原文件不存在（会话刚建、CLI 还没写盘）→ 快照落空文件，不抛", async () => {
  const fs = fakeFs();
  const out = await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    { fs },
  );
  assert.equal(out.turn, 0);
  assert.equal(fs.store.get(snapshotPath(DATA, SID, 0)), "");
});

test("R7-H 快照：写盘带 mode 0600（快照文件不能被同机其它用户读）", async () => {
  assert.equal(SNAPSHOT_FILE_MODE, 0o600);
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    { fs },
  );
  const w = fs.events.find((e) => e.path === snapshotPath(DATA, SID, 0));
  assert.equal(w?.mode, SNAPSHOT_FILE_MODE);
});

test("R7-H 快照：索引记录本轮快照的项目目录（拒绝路径的比对依据）", async () => {
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    { fs },
  );
  const idx = await readSnapshotIndex(
    { dataDir: DATA, sessionId: SID },
    { fs },
  );
  assert.equal(idx?.claudeSessionId, CLI);
  assert.equal(idx?.snapshots.find((s) => s.turn === 0)?.projectDir, PROJ);
});

test("R7-H 快照：索引文件同样 0600；无索引 → readSnapshotIndex 回 null 不抛", async () => {
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  await snapshotTurn(
    {
      dataDir: DATA,
      sessionId: SID,
      claudeSessionId: CLI,
      projectDir: PROJ,
      sourcePath: SOURCE,
    },
    { fs },
  );
  const w = fs.events.find((e) => e.path === INDEX_PATH);
  assert.equal(w?.mode, SNAPSHOT_FILE_MODE);
  const empty = await readSnapshotIndex(
    { dataDir: DATA, sessionId: "sess-无" },
    { fs },
  );
  assert.equal(empty, null);
});

// ---- 分叉编排顺序（关键）----

test("R7-H 编排：顺序 = journal → backup → truncate → fork → restore → clear", async () => {
  const seq = [];
  const fs = fakeFs(baseFiles(), seq);
  const runner = fakeRunner(seq);
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, runner));

  assert.equal(res.ok, true);
  // 编排五步一个不少、且不带重复（fs 自身的记账写不算步骤，故先过滤）
  const order = ["journal", "backup", "truncate", "restore", "clear"];
  const steps = fs.events
    .map((e) => stepOf(e))
    .filter((s) => order.includes(s));
  assert.deepEqual(steps, order);
  // 顺序断言：替换必须在 fork 前，还原必须在 fork 后
  const at = (needle) => seq.indexOf(needle);
  const truncateAt = at("write:" + SOURCE);
  const forkAt = at("fork");
  const restoreAt = seq.lastIndexOf("write:" + SOURCE);
  const clearAt = at("remove:" + JOURNAL);
  assert.ok(
    truncateAt > -1 && forkAt > truncateAt,
    "第 k 轮快照替换要在分叉之前（分叉读的是被截断的文件）",
  );
  assert.ok(restoreAt > forkAt, "分叉之后立刻还原原文件");
  assert.ok(clearAt > restoreAt, "还原之后才清 journal");
  assert.ok(at("write:" + JOURNAL) < truncateAt, "journal 先于任何替换");
});

test("R7-H 编排：fork 参数逐字 `--resume <原id> --fork-session`，cwd 为当前会话目录", async () => {
  const fs = fakeFs(baseFiles());
  const runner = fakeRunner();
  await rewindToTurn(
    rewindInput({ cwd: "/ws/科学前言" }),
    rewindDeps(fs, runner),
  );
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].args, ["--resume", CLI, "--fork-session"]);
  assert.equal(runner.calls[0].cwd, "/ws/科学前言");
});

test("R7-H 编排：替换用的内容 = 第 k 轮快照内容（不是第 0 轮、不是拼接）", async () => {
  const fs = fakeFs(baseFiles());
  const seq = [];
  await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner(seq)));
  const truncate = fs.events.find(
    (e) => e.op === "writeText" && e.path === SOURCE,
  );
  assert.equal(truncate?.data, SNAP2, "截断到第 2 轮 = 第 2 轮快照的内容");
});

test("R7-H 编排：分叉结果回新 claudeSessionId（UI 据此切到新分支）", async () => {
  const fs = fakeFs(baseFiles());
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  assert.equal(res.ok, true);
  assert.equal(res.claudeSessionId, "claude-fork-1");
});

test("R7-H 编排：原文件还原后逐字节等于原文（分叉不影响原会话）", async () => {
  const fs = fakeFs(baseFiles());
  await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  assert.equal(fs.store.get(SOURCE), ORIGINAL);
});

test("R7-H 编排：journal 与备份先于替换落盘，且都带 0600", async () => {
  const fs = fakeFs(baseFiles());
  await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  const journalWrite = fs.events.find((e) => e.path === JOURNAL);
  const backupWrite = fs.events.find((e) => e.path === BACKUP2);
  assert.equal(journalWrite?.mode, SNAPSHOT_FILE_MODE);
  assert.equal(backupWrite?.mode, SNAPSHOT_FILE_MODE);
  assert.equal(backupWrite?.data, ORIGINAL, "备份 = 替换前的原文");
  assert.ok(
    fs.events.indexOf(journalWrite) < fs.events.indexOf(backupWrite),
    "journal 先于备份（journal 里要有备份路径才能崩了还原）",
  );
});

test("R7-H 编排：成功收尾后 journal 不残留（不污染下次回滚）", async () => {
  const fs = fakeFs(baseFiles());
  await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  assert.equal(fs.store.has(JOURNAL), false, "journal 要清");
});

test("R7-H 编排（裁决 H4）：快照全轮保留 —— 回滚不许顺手删掉别的轮次快照", async () => {
  const fs = fakeFs(
    baseFiles({
      [snapshotPath(DATA, SID, 0)]: "",
      [snapshotPath(DATA, SID, 1)]: SNAP2,
    }),
  );
  await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  const removed = fs.events.filter((e) => e.op === "remove").map((e) => e.path);
  for (const turn of [0, 1, 2]) {
    const p = snapshotPath(DATA, SID, turn);
    assert.ok(fs.store.has(p), `快照 ${turn} 被删了（快照只增不删）`);
    assert.ok(!removed.includes(p), `不得对快照 ${turn} 调删除`);
  }
});

test("R7-H 编排（裁决 H5）：回滚进行中再发起一次 → 被拒（BUSY）、零副作用", async () => {
  const seq = [];
  const fs = fakeFs(baseFiles(), seq);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const deps = {
    fs,
    log: () => {},
    runner: {
      async fork() {
        calls.push("fork");
        seq.push("fork");
        await gate; // 卡住第一次，模拟「回滚还在跑」
        return { newClaudeSessionId: "claude-fork-1" };
      },
    },
  };

  // 兜底：若实现选了「排队等」而不是「拒绝」，2 秒后放行第一次，
  // 让测试以断言失败收场（而不是把整个测试进程挂死）
  const safety = setTimeout(() => release(), 2000);
  const first = rewindToTurn(rewindInput(), deps);
  try {
    // 等第一次真的进到 fork —— 否则测的不是「回滚进行中」
    for (let i = 0; i < 500 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(calls.length, 1, "第一次应当已经进到分叉那一步");

    const second = await rewindToTurn(rewindInput(), deps);
    assert.equal(second.ok, false, "并发第二次必须被挡住（串行锁）");
    assert.equal(second.reason, "REWIND_BUSY");
    assert.equal(
      fs.events.filter((e) => e.path === SOURCE).length,
      1,
      "第二次不得碰原文件（此刻它正处于「已截断」的中间态）",
    );
    assert.equal(
      fs.events.filter((e) => e.path === JOURNAL).length,
      1,
      "第二次不得再写一遍 journal",
    );
  } finally {
    release();
    clearTimeout(safety);
  }

  const done = await first;
  assert.equal(calls.length, 1, "第二次始终没有发起分叉");
  assert.equal(done.ok, true, "第一次照常跑完");
  assert.equal(fs.store.get(SOURCE), ORIGINAL, "原文件还原");
});

test("R7-H 编排（裁决 H5）：上一次跑完后锁要放开（不是一次性）", async () => {
  const seq = [];
  const fs = fakeFs(baseFiles(), seq);
  const deps = rewindDeps(fs, fakeRunner(seq));
  const a = await rewindToTurn(rewindInput(), deps);
  const b = await rewindToTurn(rewindInput(), deps);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "锁没放开 → 后续回滚全部失败");
});

// ---- 失败不跳过还原 ----

test("R7-H 失败：fork 抛错 → 原文件照样还原、journal 照样清（不许把用户会话留成半截）", async () => {
  const seq = [];
  const fs = fakeFs(baseFiles(), seq);
  const runner = fakeRunner(seq, { throwAt: "spawn ENOENT" });
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, runner));

  assert.equal(res.ok, false, "分叉失败要显式报失败（不静默成功）");
  assert.ok(
    typeof res.error === "string" && res.error.includes("ENOENT"),
    "错误原文要带上",
  );
  assert.equal(fs.store.get(SOURCE), ORIGINAL, "**还原不许被跳过**");
  assert.equal(
    fs.store.has(JOURNAL),
    false,
    "还原成功了就没东西要重试，journal 清掉",
  );
  const steps = fs.events
    .map((e) => stepOf(e))
    .filter((s) =>
      ["journal", "backup", "truncate", "restore", "clear"].includes(s),
    );
  assert.ok(steps.includes("restore"), "失败路径也必须有还原这一步");
  assert.ok(steps.includes("clear"), "还原成功即清 journal");
});

test("R7-H 失败：还原本身写盘抛错 → journal 保留（留给下次启动重试）、并显式报错", async () => {
  const fs = fakeFs(baseFiles());
  const origWrite = fs.writeText.bind(fs);
  fs.writeText = async (p, data, opts) => {
    if (p === SOURCE && data === ORIGINAL) throw new Error("EACCES: 还原被拒");
    return origWrite(p, data, opts);
  };
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));

  assert.equal(res.ok, false);
  assert.ok(typeof res.error === "string" && res.error.length > 0);
  assert.equal(
    fs.store.has(JOURNAL),
    true,
    "还原失败必须留 journal 给下次启动，不能静默",
  );
});

// ---- 崩溃恢复 ----

test("R7-H 恢复：无残留 journal → 零动作（不写、不删）", async () => {
  const fs = fakeFs(baseFiles());
  const res = await recoverPendingRewind(
    { dataDir: DATA },
    { fs, log: () => {} },
  );
  assert.equal(res.restored, false);
  assert.deepEqual(fs.events, [], "没有 journal 就不该碰任何文件");
});

test("R7-H 恢复：残留 journal → 按 journal 把原文件还原成备份内容，并清 journal", async () => {
  const journal = JSON.stringify({
    sessionId: SID,
    turn: 2,
    originalPath: SOURCE,
    backupPath: BACKUP2,
    snapshotPath: SNAP2_PATH,
  });
  const fs = fakeFs(
    baseFiles({ [JOURNAL]: journal, [BACKUP2]: ORIGINAL, [SOURCE]: SNAP2 }),
  );
  const res = await recoverPendingRewind(
    { dataDir: DATA },
    { fs, log: () => {} },
  );
  assert.equal(res.restored, true);
  assert.equal(
    fs.store.get(SOURCE),
    ORIGINAL,
    "崩溃在「替换后、还原前」→ 启动要把原文件救回来",
  );
  assert.equal(fs.store.has(JOURNAL), false);
});

test("R7-H 恢复：幂等 —— 连续两次启动不重复动作、内容不损坏", async () => {
  const journal = JSON.stringify({
    sessionId: SID,
    turn: 2,
    originalPath: SOURCE,
    backupPath: BACKUP2,
    snapshotPath: SNAP2_PATH,
  });
  const fs = fakeFs(
    baseFiles({ [JOURNAL]: journal, [BACKUP2]: ORIGINAL, [SOURCE]: SNAP2 }),
  );
  await recoverPendingRewind({ dataDir: DATA }, { fs, log: () => {} });
  const afterFirst = fs.store.get(SOURCE);
  const eventsAfterFirst = fs.events.length;
  await recoverPendingRewind({ dataDir: DATA }, { fs, log: () => {} });

  assert.equal(fs.store.get(SOURCE), afterFirst, "第二次启动不得再动原文件");
  assert.equal(fs.events.length, eventsAfterFirst, "第二次启动零动作");
});

test("R7-H 恢复：备份读不到 → 不静默、journal 保留重试", async () => {
  const journal = JSON.stringify({
    sessionId: SID,
    turn: 2,
    originalPath: SOURCE,
    backupPath: BACKUP2,
    snapshotPath: SNAP2_PATH,
  });
  const fs = fakeFs(baseFiles({ [JOURNAL]: journal, [SOURCE]: SNAP2 })); // 备份文件丢了
  const res = await recoverPendingRewind(
    { dataDir: DATA },
    { fs, log: () => {} },
  );
  assert.equal(res.restored, false);
  assert.ok(
    typeof res.error === "string" && res.error.length > 0,
    "要给出错误，不能静默",
  );
  assert.equal(fs.store.has(JOURNAL), true, "没还原成功就留着，下次再试");
  assert.equal(fs.store.get(SOURCE), SNAP2, "读不到备份时不得把原文件写成空");
});

test("R7-H 恢复：journal 是坏 JSON → 不抛、不删原文件", async () => {
  const fs = fakeFs(baseFiles({ [JOURNAL]: "{ 这不是 JSON" }));
  let res;
  await assert.doesNotReject(async () => {
    res = await recoverPendingRewind({ dataDir: DATA }, { fs, log: () => {} });
  });
  assert.equal(res.restored, false);
  assert.equal(fs.store.get(SOURCE), ORIGINAL, "坏 journal 不得让原文件受损");
});

// ---- 拒绝路径 ----

test("R7-H 拒绝：项目目录与快照记录不一致 → 拒绝、不替换、不分叉", async () => {
  const fs = fakeFs(baseFiles({ [INDEX_PATH]: indexJson(OTHER_PROJ) }));
  const runner = fakeRunner();
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, runner));

  assert.equal(res.ok, false);
  assert.equal(res.reason, "PROJECT_DIR_MISMATCH");
  assert.ok(
    typeof res.error === "string" && res.error.length > 0,
    "要给人话原因",
  );
  assert.equal(runner.calls.length, 0, "拒绝路径绝不分叉");
  assert.equal(
    fs.events.filter((e) => e.path === SOURCE).length,
    0,
    "拒绝路径一个字节都不动原文件",
  );
});

test("R7-H 拒绝：快照缺失（老会话/清理过）→ 报「不可回滚」、原文件不变、不分叉", async () => {
  const fs = fakeFs({
    [SOURCE]: ORIGINAL,
    [INDEX_PATH]: indexJson(), // 索引里有第 2 轮的记录，但 .jsonl 被清理了
  });
  const runner = fakeRunner();
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, runner));

  assert.equal(res.ok, false);
  assert.equal(res.reason, "SNAPSHOT_MISSING");
  assert.equal(runner.calls.length, 0);
  assert.equal(fs.events.filter((e) => e.path === SOURCE).length, 0);
  assert.equal(fs.store.get(SOURCE), ORIGINAL, "原文件字节数不变");
});

test("R7-H 拒绝：索引整体缺失（从未快照过）→ 同样按不可回滚拒绝", async () => {
  const fs = fakeFs({ [SOURCE]: ORIGINAL });
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "SNAPSHOT_MISSING");
  assert.equal(fs.store.get(SOURCE), ORIGINAL);
});

test("R7-H 拒绝：原文件不存在 → 拒绝且不凭空造文件", async () => {
  const fs = fakeFs({ [INDEX_PATH]: indexJson(), [SNAP2_PATH]: SNAP2 });
  const res = await rewindToTurn(rewindInput(), rewindDeps(fs, fakeRunner()));
  assert.equal(res.ok, false);
  assert.equal(fs.store.has(SOURCE), false, "不得凭空创建 CLI 会话文件");
});

// ---- 边界：第 0 轮 / 重复分支 ----

// H3 口径下第 0 轮有两个来源：①「编辑」第一条用户消息（k=1 → 快照 k−1 = 0）；
// ②「分支」到第 0 轮（会话开始前）。两者都是 rewindToTurn(turn=0)，走同一编排。
test("R7-H 边界：第 0 轮（编辑首条消息）也能回滚 —— 快照存在即照常走同一编排", async () => {
  const seq = [];
  const fs = fakeFs({
    [SOURCE]: ORIGINAL,
    [INDEX_PATH]: indexJson(),
    [snapshotPath(DATA, SID, 0)]: "",
  });
  const runner = fakeRunner(seq);
  const res = await rewindToTurn(
    rewindInput({ turn: 0 }),
    rewindDeps(fs, runner),
  );

  assert.equal(res.ok, true);
  const truncate = fs.events.find(
    (e) => e.op === "writeText" && e.path === SOURCE,
  );
  assert.equal(truncate?.data, "", "第 0 轮 = 会话开始前 → 空历史");
  assert.equal(fs.store.get(SOURCE), ORIGINAL, "还原照旧");
  assert.equal(runner.calls.length, 1);
});

test("R7-H 边界：同一轮重复分支 → 序号继续递增，不覆盖既有分支", () => {
  const sessions = [
    { id: "b1", parentId: SID, branchIndex: 1 },
    { id: "b2", parentId: SID, branchIndex: 2 },
  ];
  const snapshot = JSON.stringify(sessions);
  const plan = planBranch({ parent: { id: SID, title: "文献A" }, sessions });
  assert.equal(plan.parentId, SID);
  assert.equal(plan.branchIndex, 3);
  assert.equal(plan.title, "文献A-分支3");
  assert.equal(JSON.stringify(sessions), snapshot, "既有分支记录不得被改写");
});

test("R7-H 边界：索引号有洞（删过分支）→ 取 max+1，不复用被删的号", () => {
  const plan = planBranch({
    parent: { id: SID, title: "文献A" },
    sessions: [
      { id: "b1", parentId: SID, branchIndex: 1 },
      { id: "b3", parentId: SID, branchIndex: 3 },
    ],
  });
  assert.equal(plan.branchIndex, 4);
});

// ---- 分支记录 ----

test("R7-H 分支：首个分支 → branchIndex 1、标题 `<父标题>-分支1`", () => {
  const plan = planBranch({
    parent: { id: SID, title: "文献A" },
    sessions: [],
  });
  assert.deepEqual(plan, {
    parentId: SID,
    branchIndex: 1,
    title: "文献A-分支1",
  });
});

test("R7-H 分支：别的父会话的分支不占号（序号按父会话各自独立）", () => {
  const plan = planBranch({
    parent: { id: SID, title: "文献A" },
    sessions: [
      { id: "x1", parentId: "别的会话", branchIndex: 7 },
      { id: "b1", parentId: SID, branchIndex: 1 },
    ],
  });
  assert.equal(plan.branchIndex, 2, "只数同一父会话下的分支");
});

test("R7-H 分支：父会话被改名后，新分支用**新名**生成标题", () => {
  const plan = planBranch({
    parent: { id: SID, title: "改了名的标题" },
    sessions: [{ id: "b1", parentId: SID, branchIndex: 1 }],
  });
  assert.equal(plan.title, "改了名的标题-分支2", "旧名不得残留");
});

test("R7-H 分支：分支可再分支 —— 父是分支时，parentId 指向该分支、序号从头数", () => {
  const plan = planBranch({
    parent: { id: "b1", title: "文献A-分支1" },
    sessions: [
      { id: "b1", parentId: SID, branchIndex: 1 },
      { id: "b2", parentId: SID, branchIndex: 2 },
    ],
  });
  assert.equal(plan.parentId, "b1");
  assert.equal(plan.branchIndex, 1, "层级不限制，但序号按自己的父数");
  assert.equal(plan.title, "文献A-分支1-分支1");
});

test("R7-H 分支：parentId 为 null 的顶层会话、branchIndex 缺失的记录都不炸", () => {
  const plan = planBranch({
    parent: { id: SID, title: "文献A" },
    sessions: [
      { id: "top", parentId: null },
      { id: "odd", parentId: SID },
    ],
  });
  assert.equal(plan.branchIndex, 1, "缺 branchIndex 的脏记录不参与编号");
});
