// 单测 — R6「按合集分工作区」：
// 目录名净化 / 合集判定优先级 / 重名冲突与索引自愈 / 单一目录模式回归零容忍。
// 纯函数 + DI（fake fs / fake CollectionDeps），不碰 Zotero 全局。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTION_DIR_MAX,
  normalizeWorkspaceMode,
  parseCollectionIndex,
  pickCollectionID,
  resolveCollectionDirName,
  resolveTurnWorkspace,
  sanitizeCollectionDirName,
  serializeCollectionIndex,
  WORKSPACE_INDEX_FILE,
  type CollectionDeps,
  type CollectionIndexEntry,
  type WorkspaceFs,
} from "../../src/utils/collectionWorkspace.ts";

const ROOT = "/ws";

// ---- 目录名净化 ----

test('R6 净化：非法字符（/ \\ : * ? " < > |）替换为空格，不出现在结果里', () => {
  const dir = sanitizeCollectionDirName('a/b\\c:d*e?f"g<h>i|j', 1);
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!dir.includes(ch), `${ch} 仍在目录名里：${dir}`);
  }
  assert.equal(dir, "a b c d e f g h i j");
});

test("R6 净化：控制字符被剔除", () => {
  // 控制字符用 fromCharCode 拼（源码里不落裸控制字节：git 会把含 NUL 的文件判成 binary）
  const raw = `科${String.fromCharCode(0)}学${String.fromCharCode(0x1f)}前${String.fromCharCode(0x7f)}言`;
  assert.equal(sanitizeCollectionDirName(raw, 7), "科学前言");
});

test("R6 净化：前后空白与首尾点被去掉（含 Windows 尾点规则）", () => {
  assert.equal(sanitizeCollectionDirName("  科学前言  ", 1), "科学前言");
  assert.equal(sanitizeCollectionDirName("...科学前言...", 1), "科学前言");
  assert.equal(sanitizeCollectionDirName("  . .  ", 1), "collection-1");
});

test("R6 净化：连续空白压缩成一个空格", () => {
  assert.equal(sanitizeCollectionDirName("科学   前言", 1), "科学 前言");
});

test("R6 净化：Windows 保留名加 -<collectionID> 后缀（大小写不敏感）", () => {
  assert.equal(sanitizeCollectionDirName("CON", 42), "CON-42");
  assert.equal(sanitizeCollectionDirName("con", 42), "con-42");
  assert.equal(sanitizeCollectionDirName("LPT9", 3), "LPT9-3");
  // 只是前缀相似 ≠ 保留名
  assert.equal(sanitizeCollectionDirName("CONCEPT", 5), "CONCEPT");
  assert.equal(sanitizeCollectionDirName("COM10", 5), "COM10");
});

test("R6 净化：超长截断到 80 字符（按码点，不切断 emoji）", () => {
  const long = "科".repeat(200);
  assert.equal(
    [...sanitizeCollectionDirName(long, 1)].length,
    COLLECTION_DIR_MAX,
  );
  const emoji = "📚".repeat(100);
  const cut = sanitizeCollectionDirName(emoji, 2);
  assert.equal([...cut].length, COLLECTION_DIR_MAX);
  assert.equal(cut, "📚".repeat(COLLECTION_DIR_MAX));
});

test("R6 净化：空名/全非法名回落 collection-<collectionID>", () => {
  assert.equal(sanitizeCollectionDirName("", 9), "collection-9");
  assert.equal(sanitizeCollectionDirName("   ", 9), "collection-9");
  assert.equal(sanitizeCollectionDirName("///", 9), "collection-9");
  assert.equal(sanitizeCollectionDirName(null, 9), "collection-9");
});

test("R6 净化：中文与 emoji 原样保留", () => {
  assert.equal(sanitizeCollectionDirName("科学前言", 1), "科学前言");
  assert.equal(sanitizeCollectionDirName("科学📚前言", 1), "科学📚前言");
});

// ---- 合集判定优先级 ----

test("R6 判定①：面板选中的合集且文献属于它 → 用它（即使不是最小 ID）", () => {
  assert.equal(pickCollectionID(30, [10, 30, 20]), 30);
});

test("R6 判定①负例：选中的合集不含该文献 → 忽略选中，走最小 ID", () => {
  assert.equal(pickCollectionID(99, [10, 30, 20]), 10);
});

test("R6 判定②：多合集取 collectionID 最小者（稳定序，不随返回顺序抖动）", () => {
  assert.equal(pickCollectionID(null, [30, 10, 20]), 10);
  assert.equal(pickCollectionID(null, [20, 10, 30]), 10);
  assert.equal(pickCollectionID(undefined, [5]), 5);
});

test("R6 判定③：不属于任何合集（或脏值）→ null（调用方回落根目录）", () => {
  assert.equal(pickCollectionID(7, []), null);
  assert.equal(pickCollectionID(null, []), null);
  assert.equal(pickCollectionID(null, [0, -3, 1.5, NaN]), null);
});

// ---- 重名冲突 ----

test("R6 冲突：同名不同 collectionID → 后到的加 -<collectionID> 后缀", () => {
  const index: CollectionIndexEntry[] = [{ dir: "科学前言", collectionID: 10 }];
  const r = resolveCollectionDirName({
    collectionID: 20,
    name: "科学前言",
    index,
    takenNames: [],
  });
  assert.equal(r.dir, "科学前言-20");
  assert.deepEqual(r.index, [
    { dir: "科学前言", collectionID: 10 },
    { dir: "科学前言-20", collectionID: 20 },
  ]);
});

test("R6 冲突：同名同 collectionID → 复用索引里的目录，不新建", () => {
  const index: CollectionIndexEntry[] = [
    { dir: "科学前言-20", collectionID: 20 },
  ];
  const r = resolveCollectionDirName({
    collectionID: 20,
    name: "科学前言",
    index,
    takenNames: ["科学前言-20"],
  });
  assert.equal(r.dir, "科学前言-20");
  assert.equal(r.index.length, 1); // 索引未新增
});

test("R6 冲突：大小写不同视作同名（macOS/Windows 同名即同目录）", () => {
  const r = resolveCollectionDirName({
    collectionID: 2,
    name: "physics",
    index: [{ dir: "Physics", collectionID: 1 }],
    takenNames: [],
  });
  assert.equal(r.dir, "physics-2");
});

test("R6 冲突：索引缺失但目录已存在 → 退让加后缀，绝不并进既有目录", () => {
  const r = resolveCollectionDirName({
    collectionID: 20,
    name: "科学前言",
    index: [],
    takenNames: ["科学前言", WORKSPACE_INDEX_FILE],
  });
  assert.equal(r.dir, "科学前言-20");
});

test("R6 冲突：后缀名也被占（极端历史遗留）→ 追加 -2", () => {
  const r = resolveCollectionDirName({
    collectionID: 20,
    name: "科学前言",
    index: [],
    takenNames: ["科学前言", "科学前言-20"],
  });
  assert.equal(r.dir, "科学前言-20-2");
});

test("R6 冲突：接近 80 上限时加后缀仍不超上限", () => {
  const base = "科".repeat(COLLECTION_DIR_MAX);
  const r = resolveCollectionDirName({
    collectionID: 123,
    name: base,
    index: [],
    takenNames: [base],
  });
  assert.ok([...r.dir].length <= COLLECTION_DIR_MAX, r.dir);
  assert.ok(r.dir.endsWith("-123"), r.dir);
});

// ---- 索引解析（损坏自愈）----

test("R6 索引：坏 JSON / 空 / 形状不符 → 空索引（按无归属处理）", () => {
  assert.deepEqual(parseCollectionIndex(null), []);
  assert.deepEqual(parseCollectionIndex(""), []);
  assert.deepEqual(parseCollectionIndex("{ 不是 JSON"), []);
  assert.deepEqual(parseCollectionIndex('{"entries":"x"}'), []);
  assert.deepEqual(parseCollectionIndex("[1,2,3]"), []);
});

test("R6 索引：脏条目被过滤，重复 ID/目录只留第一条", () => {
  const raw = JSON.stringify({
    version: 1,
    entries: [
      { dir: "a", collectionID: 1 },
      { dir: "a", collectionID: 2 },
      { dir: "", collectionID: 3 },
      { dir: "b", collectionID: 0 },
      { dir: "c", collectionID: 4 },
    ],
  });
  assert.deepEqual(parseCollectionIndex(raw), [
    { dir: "a", collectionID: 1 },
    { dir: "c", collectionID: 4 },
  ]);
});

test("R6 索引：序列化→解析往返一致", () => {
  const entries: CollectionIndexEntry[] = [
    { dir: "科学前言", collectionID: 10 },
    { dir: "科学前言-20", collectionID: 20 },
  ];
  assert.deepEqual(
    parseCollectionIndex(serializeCollectionIndex(entries)),
    entries,
  );
});

// ---- resolveTurnWorkspace（DI 编排）----

interface FakeFs extends WorkspaceFs {
  dirs: Set<string>;
  files: Map<string, string>;
  failMakeDir: string | null;
  failListNames: string | null;
}

function makeFs(
  initialDirs: string[] = [],
  files: Record<string, string> = {},
): FakeFs {
  const dirs = new Set(initialDirs);
  const fileMap = new Map(Object.entries(files));
  const fs: FakeFs = {
    dirs,
    files: fileMap,
    failMakeDir: null,
    failListNames: null,
    async exists(path) {
      return dirs.has(path) || fileMap.has(path);
    },
    async makeDir(path) {
      if (fs.failMakeDir === path) throw new Error(`EACCES mkdir ${path}`);
      // createAncestors：逐级登记
      const parts = path.split("/").filter(Boolean);
      let acc = path.startsWith("/") ? "" : null;
      for (const p of parts) {
        acc = acc === null ? p : `${acc}/${p}`;
        dirs.add(acc);
      }
    },
    async readText(path) {
      return fileMap.has(path) ? (fileMap.get(path) as string) : null;
    },
    async writeText(path, text) {
      fileMap.set(path, text);
      dirs.add(path.slice(0, path.lastIndexOf("/")));
    },
    async listNames(dir) {
      if (fs.failListNames === dir) throw new Error(`EACCES list ${dir}`);
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== dir)
          names.add(d.slice(prefix.length));
      }
      for (const f of fileMap.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length));
      }
      return [...names];
    },
    join: (dir, name) => `${dir}/${name}`,
  };
  return fs;
}

function makeCollections(
  overrides: Partial<CollectionDeps> = {},
): CollectionDeps {
  return {
    getSelectedCollectionID: () => null,
    getItemCollectionIDs: async () => [],
    getCollectionName: () => null,
    ...overrides,
  };
}

const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};

test("R6 编排：合集模式 → cwd = <根>/<合集目录名>，目录被创建，索引落盘", async () => {
  const fs = makeFs(["/ws"]);
  const collections = makeCollections({
    getSelectedCollectionID: () => 12,
    getItemCollectionIDs: async () => [12],
    getCollectionName: () => "科学前言",
  });
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: "ITEM1",
    collections,
    fs,
    log,
  });
  assert.equal(path, `${ROOT}/科学前言`);
  assert.ok(fs.dirs.has(`${ROOT}/科学前言`));
  assert.deepEqual(
    JSON.parse(fs.files.get(`${ROOT}/${WORKSPACE_INDEX_FILE}`) as string),
    {
      version: 1,
      entries: [{ dir: "科学前言", collectionID: 12 }],
    },
  );
});

test("R6 编排：同一合集第二轮 → 复用同一目录，索引不变", async () => {
  const fs = makeFs(["/ws"]);
  const collections = makeCollections({
    getItemCollectionIDs: async () => [12],
    getCollectionName: () => "科学前言",
  });
  const input = {
    root: ROOT,
    mode: "collection" as const,
    itemKey: "ITEM1",
    collections,
    fs,
    log,
  };
  await resolveTurnWorkspace(input);
  const indexAfterFirst = fs.files.get(`${ROOT}/${WORKSPACE_INDEX_FILE}`);
  const second = await resolveTurnWorkspace(input);
  assert.equal(second, `${ROOT}/科学前言`);
  assert.equal(
    fs.files.get(`${ROOT}/${WORKSPACE_INDEX_FILE}`),
    indexAfterFirst,
  );
});

test("R6 编排：文献不属于任何合集 → 回落工作区根", async () => {
  const fs = makeFs(["/ws"]);
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: "ITEM1",
    collections: makeCollections({ getItemCollectionIDs: async () => [] }),
    fs,
    log,
  });
  assert.equal(path, ROOT);
  assert.equal(fs.files.has(`${ROOT}/${WORKSPACE_INDEX_FILE}`), false);
});

test("R6 编排：无条目（通用会话）→ 回落工作区根", async () => {
  const fs = makeFs(["/ws"]);
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: null,
    collections: makeCollections({
      getItemCollectionIDs: async () => [1],
      getCollectionName: () => "应被忽略",
    }),
    fs,
    log,
  });
  assert.equal(path, ROOT);
});

test("R6 编排：索引损坏 → 退让新建（不并进既有目录）且索引自愈重写", async () => {
  const fs = makeFs(["/ws", `${ROOT}/科学前言`], {
    [`${ROOT}/${WORKSPACE_INDEX_FILE}`]: "{ 这不是 JSON",
  });
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: "ITEM1",
    collections: makeCollections({
      getItemCollectionIDs: async () => [20],
      getCollectionName: () => "科学前言",
    }),
    fs,
    log,
  });
  assert.equal(path, `${ROOT}/科学前言-20`);
  assert.deepEqual(
    JSON.parse(fs.files.get(`${ROOT}/${WORKSPACE_INDEX_FILE}`) as string),
    {
      version: 1,
      entries: [{ dir: "科学前言-20", collectionID: 20 }],
    },
  );
});

test("R6 编排：子目录创建失败 → 回落根目录 + 记日志（不拦这一轮）", async () => {
  const fs = makeFs(["/ws"]);
  fs.failMakeDir = `${ROOT}/科学前言`;
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: "ITEM1",
    collections: makeCollections({
      getItemCollectionIDs: async () => [12],
      getCollectionName: () => "科学前言",
    }),
    fs,
    log,
  });
  assert.equal(path, ROOT);
  assert.ok(
    logs.some((m) => m.includes("falling back to root")),
    logs.join("\n"),
  );
});

test("R6 编排：取数抛错 → 回落根目录（绝不让用户发不出消息）", async () => {
  const fs = makeFs(["/ws"]);
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "collection",
    itemKey: "ITEM1",
    collections: makeCollections({
      getItemCollectionIDs: async () => {
        throw new Error("Zotero 内部形态变化");
      },
    }),
    fs,
    log,
  });
  assert.equal(path, ROOT);
});

test("R6 编排：工作区根不可访问 → 抛 WORKSPACE_UNAVAILABLE（显式报错，不静默）", async () => {
  const fs = makeFs([]);
  fs.failMakeDir = ROOT;
  await assert.rejects(
    () =>
      resolveTurnWorkspace({
        root: ROOT,
        mode: "collection",
        itemKey: "ITEM1",
        collections: makeCollections(),
        fs,
        log,
      }),
    (err: Error & { code?: string }) => err.code === "WORKSPACE_UNAVAILABLE",
  );
});

test("R6 编排：TCC 形态（exists 为真但 listNames 被拒）→ 同样报 WORKSPACE_UNAVAILABLE", async () => {
  const fs = makeFs([ROOT]);
  fs.failListNames = ROOT;
  await assert.rejects(
    () =>
      resolveTurnWorkspace({
        root: ROOT,
        mode: "single",
        itemKey: null,
        collections: makeCollections(),
        fs,
        log,
      }),
    (err: Error & { code?: string }) => err.code === "WORKSPACE_UNAVAILABLE",
  );
});

test("R6 编排：根目录不存在 → 自动创建（既有行为）", async () => {
  const fs = makeFs([]);
  const path = await resolveTurnWorkspace({
    root: ROOT,
    mode: "single",
    itemKey: null,
    collections: makeCollections(),
    fs,
    log,
  });
  assert.equal(path, ROOT);
  assert.ok(fs.dirs.has(ROOT));
});

// ---- 单一目录模式（回归零容忍）----

test("R6 回归：single 模式返回值恒等于工作区根，且不碰合集取数/不写索引", async () => {
  const fs = makeFs(["/ws"]);
  let queried = 0;
  const collections = makeCollections({
    getSelectedCollectionID: () => 12,
    getItemCollectionIDs: async () => {
      queried += 1;
      return [12];
    },
    getCollectionName: () => "科学前言",
  });
  for (const itemKey of [null, "ITEM1", "OTHER"]) {
    const path = await resolveTurnWorkspace({
      root: ROOT,
      mode: "single",
      itemKey,
      collections,
      fs,
      log,
    });
    assert.equal(path, ROOT);
  }
  assert.equal(queried, 0);
  assert.equal(fs.files.has(`${ROOT}/${WORKSPACE_INDEX_FILE}`), false);
  assert.deepEqual([...fs.dirs], [ROOT]);
});

test("R6 回归：模式脏值回落 single", () => {
  assert.equal(normalizeWorkspaceMode("collection"), "collection");
  assert.equal(normalizeWorkspaceMode("single"), "single");
  assert.equal(normalizeWorkspaceMode(""), "single");
  assert.equal(normalizeWorkspaceMode(undefined), "single");
  assert.equal(normalizeWorkspaceMode("COLLECTION"), "single");
  assert.equal(normalizeWorkspaceMode(123), "single");
});

// ---- R6 兼容审查回修（必修-1 / 建议-1 / 建议-2）：Windows 设备名族、后缀长度、索引路径穿越 ----

test("R6 净化(回修)：Windows 设备名带扩展名同样要加后缀（CON.txt / nul.md / LPT1.log）", () => {
  for (const raw of ["CON.txt", "nul.md", "LPT1.log", "com3.dat", "Aux "]) {
    const dir = sanitizeCollectionDirName(raw, 9);
    assert.ok(/-(9)/.test(dir), `未加后缀：${raw} → ${dir}`);
    // 判据：第一个 . 之前的那段不再是裸设备名
    const head = dir.split(".")[0].toLowerCase();
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(head), `仍是设备名：${dir}`);
  }
});

test("R6 净化(回修)：上标数字形态 COM¹/COM²/COM³ 也按设备名处理，普通名字不受影响", () => {
  assert.ok(/-\d/.test(sanitizeCollectionDirName("COM\u00b9", 3)));
  assert.ok(/-\d/.test(sanitizeCollectionDirName("lpt\u00b2.txt", 3)));
  assert.equal(sanitizeCollectionDirName("内容分析", 3), "内容分析");
  assert.equal(sanitizeCollectionDirName("constant", 3), "constant");
  assert.equal(sanitizeCollectionDirName("com10", 3), "com10"); // 两位数不是设备名
});

test("R6 索引(回修)：拒绝路径形态的 dir（.. / 分隔符 / 盘符 / ~ / 点开头）", () => {
  const raw = JSON.stringify({
    version: 1,
    entries: [
      { dir: "..", collectionID: 1 },
      { dir: "../..", collectionID: 2 },
      { dir: "..\\..\\x", collectionID: 3 },
      { dir: "a/b", collectionID: 4 },
      { dir: "/etc", collectionID: 5 },
      { dir: "C:\\Windows", collectionID: 6 },
      { dir: "~/.ssh", collectionID: 7 },
      { dir: ".hidden", collectionID: 8 },
      { dir: "合法目录", collectionID: 9 },
    ],
  });
  const entries = parseCollectionIndex(raw, () => {});
  assert.deepEqual(entries, [{ dir: "合法目录", collectionID: 9 }]);
});

test("R6 冲突(回修)：三次连续退让（不同合集同名）后仍不重名、且目录名不超上限", () => {
  const longName = "长".repeat(COLLECTION_DIR_MAX);
  const taken: string[] = [];
  const seen: string[] = [];
  // 用**不同 collectionID** 逼出退让（同 ID 是"复用"语义，属另一条契约）
  for (const id of [42, 43, 44]) {
    const r = resolveCollectionDirName({
      name: longName,
      collectionID: id,
      index: [],
      takenNames: taken,
    });
    assert.ok([...r.dir].length <= COLLECTION_DIR_MAX, `超长：${r.dir}`);
    const key = r.dir.toLowerCase();
    assert.ok(!seen.includes(key), `与已用名冲突：${r.dir}`);
    seen.push(key);
    taken.push(r.dir);
  }
  assert.equal(seen.length, 3);
});
