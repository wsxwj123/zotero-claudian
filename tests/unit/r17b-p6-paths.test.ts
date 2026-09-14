// 黑盒复现 — R17b / P6「Windows 路径分隔符」
//
// 契约来源（只依据这两份）：.devflow/BRIEF-R17b.md §1.1/§2 根因 1、§3 成功标准 P6；
// .devflow/INTERFACE-R17.md §1.5（三个纯逻辑模块新增可选注入 `join`，缺省逐字不变）。
//
// 判据：win32 形态输入下产出的路径不得混用分隔符（`!(p.includes("\\") && p.includes("/"))`）；
// 强判据（P6 原文）＝产物里根本不含 `/`。
// 驱动面：三个模块的导出函数；注入面＝INTERFACE §1.5 约定的可选尾参 / 可选字段（HEAD 尚未存在，
// 故一律经 `call()` 以任意实参个数调用，不依赖类型声明）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveInstructionsPath,
  type ResolveInstructionsPathInput,
} from "../../src/utils/instructions.ts";
import {
  backupPath,
  journalPath,
  readSnapshotIndex,
  snapshotDir,
  snapshotPath,
  snapshotTurn,
  type RewindFs,
} from "../../src/utils/rewind.ts";
import {
  scanCommands,
  type CommandScanDeps,
} from "../../src/utils/commands.ts";

/** win32 形态输入（用户真机报障里的形状） */
const WIN_ROOT = "E:\\zhoumian";
const WIN_DATA_DIR = "C:\\Users\\z\\Zotero\\claudian";
const WIN_HOME = "C:\\Users\\z";
const COLLECTION_DIR = "论文库";

const mixed = (p: string): boolean => p.includes("\\") && p.includes("/");

type Join = (...segs: string[]) => string;

/** win32 的注入拼接（真宿主是 PathUtils.join） */
const winJoin: Join = (...segs) =>
  segs
    .map((s) => s.replace(/[\\/]+$/, ""))
    .filter((s) => s !== "")
    .join("\\");

/** posix 的注入拼接（真宿主在 darwin/linux 上的产物面） */
const posixJoin: Join = (...segs) => segs.join("/");

/** 按任意实参个数调用导出函数：注入面在 HEAD 上可能还不存在 */
const call = (fn: unknown, ...args: unknown[]): unknown =>
  (fn as (...a: unknown[]) => unknown)(...args);

const pathOf = (fn: unknown, ...args: unknown[]): string => {
  const out = call(fn, ...args);
  assert.equal(typeof out, "string", `${String(fn)} 必须返回字符串`);
  return out as string;
};

/** 不传注入 join 的输入（缺省分支） */
const plainInput = (over: Partial<ResolveInstructionsPathInput>) =>
  ({
    root: WIN_ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    ...over,
  }) as unknown as ResolveInstructionsPathInput;

// ---------- T-P6-a / b：instructions 两种落点 ----------

test("T-P6-a 🔴 win32 根目录下 global 指令落点：产出路径不含 /", () => {
  const res = call(resolveInstructionsPath, {
    ...plainInput({}),
    join: winJoin,
  }) as { ok: boolean; path?: string; dir?: string };

  assert.equal(res.ok, true, "global 落点必须可用");
  assert.equal(res.path, "E:\\zhoumian\\CLAUDE.md", "global 落点原样值");
  assert.ok(
    !mixed(res.path as string),
    `路径混用了分隔符（Gecko 会 NS_ERROR_FILE_UNRECOGNIZED_PATH）：${res.path}`,
  );
  assert.ok(
    !(res.path as string).includes("/"),
    `win32 形态下产出路径不得含 /：${res.path}`,
  );
});

test("T-P6-b 🔴 win32 根目录下 collection 指令落点：产出路径不含 /", () => {
  const res = call(resolveInstructionsPath, {
    ...plainInput({
      scope: "collection",
      mode: "collection",
      collectionDir: COLLECTION_DIR,
    }),
    join: winJoin,
  }) as { ok: boolean; path?: string; dir?: string };

  assert.equal(res.ok, true, "collection 落点必须可用");
  assert.equal(
    res.path,
    `E:\\zhoumian\\${COLLECTION_DIR}\\CLAUDE.md`,
    "collection 落点原样值",
  );
  assert.ok(
    !(res.path as string).includes("/"),
    `win32 形态下产出路径不得含 /：${res.path}`,
  );
});

// ---------- T-P6-c：rewind 四个落点函数 ----------

test("T-P6-c 🔴 rewind 四个落点函数在 win32 dataDir 下：产出路径不含 /", () => {
  const dir = pathOf(snapshotDir, WIN_DATA_DIR, "s1", winJoin);
  const snap = pathOf(snapshotPath, WIN_DATA_DIR, "s1", 0, winJoin);
  const bak = pathOf(backupPath, WIN_DATA_DIR, "s1", 0, winJoin);
  const journal = pathOf(journalPath, WIN_DATA_DIR, winJoin);

  assert.equal(
    dir,
    "C:\\Users\\z\\Zotero\\claudian\\snapshots\\s1",
    "快照目录",
  );
  assert.equal(
    snap,
    "C:\\Users\\z\\Zotero\\claudian\\snapshots\\s1\\0.jsonl",
    "快照文件",
  );
  assert.equal(
    bak,
    "C:\\Users\\z\\Zotero\\claudian\\snapshots\\s1\\0.backup.jsonl",
    "回滚备份文件",
  );
  assert.equal(
    journal,
    "C:\\Users\\z\\Zotero\\claudian\\snapshots\\rewind-journal.json",
    "回滚 journal",
  );
  for (const p of [dir, snap, bak, journal]) {
    assert.ok(!p.includes("/"), `win32 形态下产出路径不得含 /：${p}`);
  }
});

// ---------- T-P6-d：commands 扫描收到的目录 ----------

test("T-P6-d 🔴 scanCommands 传给 fs 的每个路径都不含 /", async () => {
  const seen: string[] = [];
  const fs: CommandScanDeps["fs"] = {
    async listDir(dir) {
      seen.push(dir);
      return [];
    },
    async readText(path) {
      seen.push(path);
      return null;
    },
    join(dir, name) {
      const out = winJoin(dir, name);
      seen.push(out);
      return out;
    },
  };

  await scanCommands({ root: WIN_ROOT, home: WIN_HOME, fs });

  assert.ok(
    seen.length >= 2,
    `project + user 两处目录都要被扫到（实际 ${seen.length}）`,
  );
  for (const p of seen) {
    assert.ok(
      !p.includes("/"),
      `scanCommands 收到含 / 的路径（Windows 上该目录直接读不到）：${p}`,
    );
  }
});

// ---------- T-P6-e：win32 往返（防「只修写侧漏读侧」） ----------

/** 模拟 Gecko 的 nsLocalFileWin：拒收混用分隔符的路径（NS_ERROR_FILE_UNRECOGNIZED_PATH） */
function makeWinRewindFs(): { fs: RewindFs; files: Map<string, string> } {
  const files = new Map<string, string>();
  const check = (p: string): void => {
    if (mixed(p)) {
      throw new Error(`NS_ERROR_FILE_UNRECOGNIZED_PATH: ${p}`);
    }
  };
  const fs: RewindFs = {
    join: winJoin,
    async readText(p) {
      check(p);
      return files.get(p) ?? null;
    },
    async writeText(p, data) {
      check(p);
      files.set(p, data);
    },
    async listNames(dir) {
      check(dir);
      return [];
    },
    async makeDir(p) {
      check(p);
    },
    async remove(p) {
      check(p);
      files.delete(p);
    },
    async exists(p) {
      check(p);
      return files.has(p);
    },
  };
  return { fs, files };
}

test("T-P6-e 🔴 win32 形态 dataDir：写快照 → 读回索引必须成功", async () => {
  const { fs, files } = makeWinRewindFs();

  await snapshotTurn(
    {
      dataDir: WIN_DATA_DIR,
      sessionId: "s1",
      claudeSessionId: "cli-1",
      projectDir: "-E-zhoumian",
      sourcePath: null,
    },
    { fs },
  );

  const index = await readSnapshotIndex(
    { dataDir: WIN_DATA_DIR, sessionId: "s1" },
    { fs },
  );

  assert.ok(
    index,
    `写侧产出的索引必须能被读侧同源找到（win32 dataDir 下已落盘文件：${[
      ...files.keys(),
    ].join(" | ")}）`,
  );
  assert.equal(index.snapshots.length, 1, "读回的快照清单恰 1 条");
  assert.equal(index.snapshots[0].turn, 0, "第 0 轮快照可回滚");
  assert.equal(index.claudeSessionId, "cli-1", "CLI 会话 id 原样读回");
});

// ---------- T-P6-f 🔒 缺省行为逐字不变（不传注入 join） ----------

test("T-P6-f 🔒 不传注入 join 时，POSIX 形态产物与今天逐字一致", () => {
  // instructions：缺省拼法（既有调用方与验收面锁定的是这个）
  const g = call(resolveInstructionsPath, {
    root: "/home/u/proj",
    scope: "global",
    mode: "single",
    collectionDir: null,
  }) as { ok: boolean; path?: string };
  assert.equal(g.path, "/home/u/proj/CLAUDE.md", "global 缺省拼法");

  const c = call(resolveInstructionsPath, {
    root: "/home/u/proj",
    scope: "collection",
    mode: "collection",
    collectionDir: "coll",
  }) as { ok: boolean; path?: string };
  assert.equal(c.path, "/home/u/proj/coll/CLAUDE.md", "collection 缺省拼法");

  // rewind：缺省拼法
  assert.equal(pathOf(snapshotDir, "/data/x", "s1"), "/data/x/snapshots/s1");
  assert.equal(
    pathOf(snapshotPath, "/data/x", "s1", 0),
    "/data/x/snapshots/s1/0.jsonl",
  );
  assert.equal(
    pathOf(backupPath, "/data/x", "s1", 0),
    "/data/x/snapshots/s1/0.backup.jsonl",
  );
  assert.equal(
    pathOf(journalPath, "/data/x"),
    "/data/x/snapshots/rewind-journal.json",
  );
});

test("T-P6-g 🔒 宿主既有 POSIX 接线下，scanCommands 扫到的目录逐字不变", async () => {
  const seen: string[] = [];
  const fs: CommandScanDeps["fs"] = {
    async listDir(dir) {
      seen.push(dir);
      return [];
    },
    async readText() {
      return null;
    },
    join: posixJoin,
  };

  await scanCommands({ root: "/w", home: "/home/u", fs });

  assert.deepEqual(
    [...seen].sort(),
    ["/home/u/.claude/commands", "/w/.claude/commands"],
    "POSIX 下 project / user 两处命令目录逐字不变",
  );
});
