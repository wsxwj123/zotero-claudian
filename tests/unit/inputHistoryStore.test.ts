// 单测 — 输入历史（↑/↓ 翻已发送消息）的宿主持久化（src/modules/inputHistoryStore.ts）。
// 锁四件事：①读写往返（面板重载/重启后还在）②原子写（先 .tmp 再 move）
// ③坏文件/坏条目/超限一律容错，不整份崩 ④写盘节流（500ms 合并）与失败静默降级。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInputHistoryStore,
  INPUT_HISTORY_FILE_VERSION,
  INPUT_HISTORY_LIMIT,
  normalizeHistoryEntries,
  parseInputHistoryFile,
  type InputHistoryStoreDeps,
} from "../../src/modules/inputHistoryStore.ts";
import { createMemoryFs, DATA_DIR } from "./helpers/memoryFs.ts";

/** 落盘路径（joinPath 的 darwin 形态） */
const FILE = `${DATA_DIR}/input-history.json`;

/**
 * 组装被测 store：默认合并窗口设成 10s（测试期内不会自己到点），
 * 要落盘就显式 flush()——确定性；「窗口到点自动落盘」另有一条专测。
 */
function makeStore(
  initial: Record<string, string> = {},
  overrides: Partial<Omit<InputHistoryStoreDeps, "fs">> = {},
) {
  const fs = createMemoryFs(initial);
  const logs: string[] = [];
  const store = createInputHistoryStore({
    dataDir: DATA_DIR,
    platform: "darwin",
    log: (m) => logs.push(m),
    coalesceMs: 10_000,
    ...overrides,
    fs,
  });
  return { store, fs, logs };
}

const writes = (ops: string[]): string[] =>
  ops.filter((o) => o.startsWith("write ") || o.startsWith("move "));

test("宿主 store：save → flush 落盘 {version,sessions}；新实例读回同条目（重载/重启后还在）", async () => {
  const a = makeStore();
  await a.store.save("S1", ["第一条", "第二条"]);
  await a.store.flush();
  const raw = a.fs.files.get(FILE);
  assert.ok(raw, "应已落盘");
  const parsed = JSON.parse(raw as string) as {
    version: number;
    sessions: Record<string, string[]>;
  };
  assert.equal(parsed.version, INPUT_HISTORY_FILE_VERSION);
  assert.deepEqual(parsed.sessions.S1, ["第一条", "第二条"]);

  // 模拟面板重载 / Zotero 重启：同一份文件、新的 store 实例
  const b = makeStore({ [FILE]: raw as string });
  assert.deepEqual(await b.store.get("S1"), ["第一条", "第二条"]);
  assert.deepEqual(await b.store.get("S2"), [], "别的会话读不到");
});

test("宿主 store：原子写（先 .tmp 再 move），写完不留 .tmp", async () => {
  const { store, fs } = makeStore();
  await store.save("S1", ["A"]);
  await store.flush();
  assert.deepEqual(writes(fs.ops), [
    `write ${FILE}.tmp`,
    `move ${FILE}.tmp -> ${FILE}`,
  ]);
  assert.equal(fs.files.has(`${FILE}.tmp`), false, "临时文件不该留下");
});

test("宿主 store：文件不存在 → 空历史（不落盘、不抛）", async () => {
  const { store, fs } = makeStore();
  assert.deepEqual(await store.get("S1"), []);
  assert.equal(fs.files.has(FILE), false, "只读不该创建文件");
});

test("宿主 store：坏文件（非 JSON / 结构不对）→ 空历史、不抛；随后 save 正常覆盖", async () => {
  for (const bad of ["not json {{{", "[1,2,3]", '{"version":1}', "null", ""]) {
    const { store } = makeStore({ [FILE]: bad });
    assert.deepEqual(await store.get("S1"), [], `坏文件 ${bad} 应读成空`);
  }
  const { store, fs } = makeStore({ [FILE]: "not json {{{" });
  await store.save("S1", ["重来一条"]);
  await store.flush();
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.S1, ["重来一条"]);
});

test("宿主 store：坏条目（非字符串/纯空白/相邻重复）丢弃，其余照常", async () => {
  const { store, fs } = makeStore({
    [FILE]: JSON.stringify({
      version: 1,
      sessions: { S1: ["好的", 42, null, "好的", "另一条", "  "] },
    }),
  });
  assert.deepEqual(await store.get("S1"), ["好的", "另一条"]);
  // 单个坏桶（非数组）只丢那个桶，别的桶照常
  const { store: s2 } = makeStore({
    [FILE]: JSON.stringify({ version: 1, sessions: { S1: ["A"], S2: "坏" } }),
  });
  assert.deepEqual(await s2.get("S1"), ["A"]);
  assert.deepEqual(await s2.get("S2"), []);
  // save 侧同样归一：脏数组进不去
  await store.save("S3", ["x", "x", 7, "y"]);
  await store.flush();
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.S3, ["x", "y"]);
});

test(`宿主 store：超过 ${INPUT_HISTORY_LIMIT} 条丢最老（写侧与读侧都裁）`, async () => {
  const many = Array.from(
    { length: INPUT_HISTORY_LIMIT + 5 },
    (_, i) => `m${i}`,
  );
  const { store, fs } = makeStore();
  await store.save("S1", many);
  await store.flush();
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.equal(parsed.sessions.S1.length, INPUT_HISTORY_LIMIT);
  assert.equal(parsed.sessions.S1[0], "m5");
  // 读侧：磁盘上被外部塞超限数据，读回也要裁
  const { store: s2 } = makeStore({
    [FILE]: JSON.stringify({ version: 1, sessions: { S1: many } }),
  });
  const back = await s2.get("S1");
  assert.equal(back.length, INPUT_HISTORY_LIMIT);
  assert.equal(back[back.length - 1], `m${INPUT_HISTORY_LIMIT + 4}`);
});

test("宿主 store：写盘失败静默（不抛、记日志），内存态照常可读", async () => {
  const { store, fs, logs } = makeStore();
  fs.writeText = async () => {
    throw new Error("ENOSPC: disk full");
  };
  await store.save("S1", ["这条只活在内存里"]);
  await assert.doesNotReject(() => store.flush());
  assert.deepEqual(await store.get("S1"), ["这条只活在内存里"]);
  assert.ok(
    logs.some((m) => m.includes("write failed")),
    "失败要留日志（静默 ≠ 无痕）",
  );
});

test("宿主 store：读失败（I/O 错误）≠ 空文件——get 回空，且 save 拒绝覆盖未知内容", async () => {
  const { store, fs, logs } = makeStore({ [FILE]: "已有内容" });
  fs.readText = async () => {
    throw new Error("EIO: read error");
  };
  assert.deepEqual(await store.get("S1"), []);
  await assert.doesNotReject(() => store.save("S1", ["新条目"]));
  await store.flush();
  assert.deepEqual(fs.files.get(FILE), "已有内容", "读不出来时绝不整份重写");
  assert.ok(logs.some((m) => m.includes("not loaded")));
});

test("宿主 store：会话桶互不串（写 A 不动 B）", async () => {
  const { store, fs } = makeStore();
  await store.save("A", ["A 的提问"]);
  await store.save("B", ["B 的提问"]);
  await store.flush();
  assert.deepEqual(await store.get("A"), ["A 的提问"]);
  assert.deepEqual(await store.get("B"), ["B 的提问"]);
  await store.save("A", ["A 的提问", "A 的追问"]);
  await store.flush();
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.B, ["B 的提问"], "B 不受 A 的写入影响");
});

test("宿主 store：save 是并入而非替换——残份/另一实例的本地副本不抹掉已存条目", async () => {
  const { store, fs } = makeStore();
  await store.save("S1", ["一", "二"]);
  await store.flush();
  // 刚重载、还没收到宿主历史的页面递来只剩一条的残份 → 旧的不该被抹掉
  await store.save("S1", ["二"]);
  assert.deepEqual(await store.get("S1"), ["一", "二"]);
  // 另一个面板实例（本地只有「一」）发了第三条 → 并入后三条都在，且不重复
  await store.save("S1", ["一", "三"]);
  await store.flush();
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.S1, ["一", "二", "三"]);
  // 前缀一致的整体递送（页面已并过宿主历史）→ 原样，不产生重复
  await store.save("S1", ["一", "二", "三", "四"]);
  await store.flush();
  const parsed2 = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed2.sessions.S1, ["一", "二", "三", "四"]);
});

test("宿主 store：合并窗口内多次 save 只落一次盘，且写的是最新状态", async () => {
  const { store, fs } = makeStore();
  await store.save("S1", ["一"]);
  await store.save("S1", ["一", "二"]);
  await store.save("S2", ["别人的"]);
  assert.equal(writes(fs.ops).length, 0, "窗口内不该落盘");
  await store.flush();
  assert.equal(writes(fs.ops).length, 2, "一次 flush 只写一次（tmp + move）");
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.S1, ["一", "二"]);
  assert.deepEqual(parsed.sessions.S2, ["别人的"]);
  await store.flush();
  assert.equal(writes(fs.ops).length, 2, "无变更的 flush 不重复写盘");
});

test("宿主 store：窗口到点自动落盘（不必等 flush）", async () => {
  const { store, fs } = makeStore({}, { coalesceMs: 5 });
  await store.save("S1", ["到点自己写"]);
  for (let i = 0; i < 50 && !fs.files.has(FILE); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(fs.files.has(FILE), "5ms 窗口到点应已落盘");
  const parsed = JSON.parse(fs.files.get(FILE) as string) as {
    sessions: Record<string, string[]>;
  };
  assert.deepEqual(parsed.sessions.S1, ["到点自己写"]);
});

test("条目归一：空/纯空白/非字符串丢弃，相邻去重，超限丢最老（与页面同口径）", () => {
  assert.deepEqual(normalizeHistoryEntries("不是数组"), []);
  assert.deepEqual(normalizeHistoryEntries(["a", "", "  ", "a", "b"]), [
    "a",
    "b",
  ]);
  assert.deepEqual(normalizeHistoryEntries(["  缩进保留  "]), ["  缩进保留  "]);
  const many = Array.from(
    { length: INPUT_HISTORY_LIMIT + 2 },
    (_, i) => `m${i}`,
  );
  assert.equal(normalizeHistoryEntries(many).length, INPUT_HISTORY_LIMIT);
  // 落盘解析：无原型对象承接（磁盘上被塞 "__proto__" 键也污染不到 Object.prototype）
  const parsed = parseInputHistoryFile(
    JSON.stringify({ version: 1, sessions: { __proto__: ["x"] } }),
  );
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});
