// m5-retest —— BUG-21 / BUG-21b 独立回归验证（重测轮自写断言，不引用被测方探针）。
// 口径（INTERFACE §4.5 / SessionStoreFs 注）：文件不存在 → null 是「首次运行」；
// 读取失败（I/O 错误）必须抛——绝不能被当成空基线，否则全量重写会整段覆盖既有数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistoryJsonl } from "../../../src/utils/sessionStore.ts";
import {
  DATA_DIR,
  HISTORY_DIR,
  INDEX,
  historyPath,
  makeStore,
} from "./fakes.ts";

const userLine = (text: string, ts = 1): string =>
  JSON.stringify({ role: "user", text, ts });
const assistantLine = (text: string, ts = 1): string =>
  JSON.stringify({ role: "assistant", text, ts });

const onDisk = (files: Map<string, string>, path: string): string => {
  const v = files.get(path);
  assert.notEqual(v, undefined, `期望文件存在：${path}`);
  return v as string;
};

/** 旁挂历史行内容断言（ts 由写入方决定，这里只锁 role/text 与行数） */
const expectLines = (
  raw: string,
  expected: [string, string][],
  label = "",
): void => {
  const records = parseHistoryJsonl(raw);
  assert.deepEqual(
    records.map((m) => [m.role, m.text]),
    expected,
    `${label} 行内容不符：${raw}`,
  );
  assert.equal(
    raw.split("\n").filter((l) => l.trim().length > 0).length,
    expected.length,
    `${label} 行数不符（粘行或丢行）：${raw}`,
  );
};

// ---------- BUG-21：历史只追加，绝不整份重写 ----------

test("21-R1: 首次追加（历史文件不存在）→ 创建文件且恰含本轮两行", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "t" });

  const written = await store.appendTurn(rec.id, "第一问", "第一答");
  assert.equal(written, 2, "user+assistant 应返回写入 2 行");

  const raw = onDisk(fs.files, historyPath(rec.id));
  assert.equal(raw.endsWith("\n"), true, "追加未以换行收尾（会粘下一轮）");
  expectLines(raw, [
    ["user", "第一问"],
    ["assistant", "第一答"],
  ]);
  const replayed = await store.readHistory(rec.id);
  assert.deepEqual(
    replayed.map((m) => [m.role, m.text]),
    [
      ["user", "第一问"],
      ["assistant", "第一答"],
    ],
  );
});

test("21-R2: 连续追加 → 既有内容逐字保留（无全量重写、无覆盖）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "t" });
  await store.appendTurn(rec.id, "问1", "答1");
  const afterFirst = onDisk(fs.files, historyPath(rec.id));

  const written2 = await store.appendTurn(rec.id, "问2", "答2");
  const afterSecond = onDisk(fs.files, historyPath(rec.id));
  assert.equal(written2, 2);
  assert.ok(
    afterSecond.startsWith(afterFirst),
    `第二轮追加改动了既有字节（不是真追加）：\n前：${afterFirst}\n后：${afterSecond}`,
  );
  expectLines(
    afterSecond.slice(afterFirst.length),
    [
      ["user", "问2"],
      ["assistant", "答2"],
    ],
    "第二轮新增段",
  );
  expectLines(afterSecond, [
    ["user", "问1"],
    ["assistant", "答1"],
    ["user", "问2"],
    ["assistant", "答2"],
  ]);
  // 反向用例：历史文件绝不能出现「整份写」调用
  assert.deepEqual(
    fs.jsonlRewrites,
    [],
    `历史文件被整份重写（writeText）：${JSON.stringify(fs.jsonlRewrites)}`,
  );
});

test("21-R3: 既有文件无尾换行（外因截断）→ 追加仍可逐行解析，不粘行", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "t" });
  fs.files.set(historyPath(rec.id), userLine("旧问")); // 无尾 \n

  await store.appendTurn(rec.id, "新问", "新答");

  const raw = onDisk(fs.files, historyPath(rec.id));
  assert.ok(
    raw.startsWith(`${userLine("旧问")}\n`),
    `新增行未以换行与旧行分隔（粘行）：${raw}`,
  );
  expectLines(raw, [
    ["user", "旧问"],
    ["user", "新问"],
    ["assistant", "新答"],
  ]);
});

test("21-R4: 读历史失败（I/O 错误）→ 追加照常成功且旧内容一字不动", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "t" });
  await store.appendTurn(rec.id, "第一问", "第一答");
  const before = onDisk(fs.files, historyPath(rec.id));

  fs.failWhen = (op, path) => op === "read" && path === historyPath(rec.id);
  const written = await store.appendTurn(rec.id, "第二问", "第二答");
  fs.failWhen = null;

  assert.equal(written, 2, "读失败不得让本轮追加失败（也不得按空历史处理）");
  const after = onDisk(fs.files, historyPath(rec.id));
  assert.ok(after.startsWith(before), `旧对话被整段覆盖：现存 ${after}`);
  assert.deepEqual(
    parseHistoryJsonl(after).map((m) => m.text),
    ["第一问", "第一答", "第二问", "第二答"],
  );
  assert.deepEqual(fs.jsonlRewrites, [], "历史文件被整份重写（writeText）");
});

test("21-R5: 并发追加 5 轮 → 10 行全在、顺序不乱、写操作零交错", async () => {
  const { store, fs } = makeStore({}, { delayMs: 1 });
  const rec = await store.create({ title: "t" });

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      store.appendTurn(rec.id, `并发问${i}`, `并发答${i}`),
    ),
  );
  await store.flush();

  assert.equal(fs.maxWriteConcurrent, 1, "并发追加时写操作发生交错");
  const msgs = parseHistoryJsonl(onDisk(fs.files, historyPath(rec.id)));
  assert.equal(msgs.length, 10);
  assert.deepEqual(
    msgs.map((m) => m.text),
    [0, 1, 2, 3, 4].flatMap((i) => [`并发问${i}`, `并发答${i}`]),
  );
  assert.deepEqual(fs.jsonlRewrites, []);
});

test("21-R6: 未知会话 id 追加 → 返回 0 且不留任何文件（反向用例）", async () => {
  const { store, fs } = makeStore();
  const written = await store.appendTurn("no-such-session", "问", "答");
  assert.equal(written, 0);
  assert.equal(fs.files.has(historyPath("no-such-session")), false);
  assert.deepEqual(
    fs.ops.filter((o) => o.includes("no-such-session")),
    [],
    "未知会话不得产生任何 fs 访问",
  );
});

// ---------- BUG-21b：索引读失败 ≠ 首次运行，载入成功前所有写被拒 ----------

const existingIndex = (): string =>
  JSON.stringify({
    version: 1,
    sessions: [
      {
        id: "keep-me",
        claudeSessionId: "cli-keep",
        title: "既有会话",
        createdAt: 1,
        updatedAt: 1,
        itemKey: null,
        itemLibraryID: null,
        attachmentKey: null,
        permissionMode: "acceptEdits",
        allowedTools: [],
        messageCount: 2,
        lastCostUsd: 0,
      },
    ],
  });

test("21b-R1: 索引读失败 → init 不抛、list 空、不写任何东西", async () => {
  const { store, fs, logs } = makeStore({ [INDEX]: existingIndex() });
  fs.failWhen = (op, path) => op === "read" && path === INDEX;

  await store.init(); // 握手路径：失败只记日志，不许变成未处理拒绝

  assert.deepEqual(store.list(), [], "载入失败时不得把索引当空数据对外可见");
  assert.equal(store.get("keep-me"), null);
  assert.equal(store.mostRecent(), null);
  assert.deepEqual(
    fs.ops.filter((o) => o.startsWith("write") || o.startsWith("move")),
    [],
    "载入失败期间不得发生任何写",
  );
  assert.ok(
    logs.some((l) => l.includes("stay unloaded")),
    `读失败未留日志：${JSON.stringify(logs)}`,
  );
});

test("21b-R2: 索引读失败 → create/update/remove/appendTurn 全路径被拒，索引文件零改写", async () => {
  const { store, fs } = makeStore({ [INDEX]: existingIndex() });
  const original = existingIndex();
  fs.failWhen = (op, path) => op === "read" && path === INDEX;

  await assert.rejects(
    store.create({ title: "新会话" }),
    /injected read failure/,
  );
  await assert.rejects(
    store.update("keep-me", { title: "改标题" }),
    /injected read failure/,
  );
  await assert.rejects(store.remove("keep-me"), /injected read failure/);
  await assert.rejects(
    store.appendTurn("keep-me", "问", "答"),
    /injected read failure/,
  );

  assert.equal(
    fs.files.get(INDEX),
    original,
    "索引读失败后仍被改写（既有会话被覆盖）",
  );
  assert.deepEqual(
    fs.ops.filter(
      (o) =>
        o === `write ${INDEX}` ||
        o === `write ${INDEX}.tmp` ||
        o === `move ${INDEX}.tmp`,
    ),
    [],
    "读失败期间索引写路径被触发",
  );
  assert.equal(
    fs.files.has(historyPath("keep-me")),
    false,
    "读失败期间历史文件被创建（写操作未被挡住）",
  );
});

test("21b-R3: 并发写批次在载入失败下全部被拒（没有任何一个偷偷成功）", async () => {
  const { store, fs } = makeStore({ [INDEX]: existingIndex() });
  fs.failWhen = (op, path) => op === "read" && path === INDEX;

  const results = await Promise.allSettled([
    store.create({ title: "a" }),
    store.create({ title: "b" }),
    store.update("keep-me", { lastCostUsd: 9 }),
    store.appendTurn("keep-me", "问", "答"),
    store.remove("keep-me"),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected", "rejected", "rejected", "rejected"],
  );
  assert.equal(fs.files.get(INDEX), existingIndex());
});

test("21b-R4: 故障恢复后重试成功，且既有索引内容合并保留（不覆盖）", async () => {
  const { store, fs } = makeStore({ [INDEX]: existingIndex() });
  let arm = true;
  fs.failWhen = (op, path) => arm && op === "read" && path === INDEX;

  await store.init();
  await assert.rejects(store.create({ title: "先失败" }));
  arm = false; // 磁盘故障恢复

  const rec = await store.create({ title: "新会话" });
  await store.flush();

  const ids = (
    JSON.parse(onDisk(fs.files, INDEX)) as {
      sessions: { id: string; claudeSessionId: string | null }[];
    }
  ).sessions;
  assert.deepEqual(
    ids.map((s) => s.id).sort(),
    ["keep-me", rec.id].sort(),
    `恢复后写入把既有索引覆盖：现存 ${JSON.stringify(ids)}`,
  );
  assert.equal(
    ids.find((s) => s.id === "keep-me")?.claudeSessionId,
    "cli-keep",
    "既有会话的 claudeSessionId 丢失",
  );
  assert.equal(store.get("keep-me")?.title, "既有会话");
});

test("21b-R5: 损坏索引备份失败 → 不写空索引、原文件留现场（备份失败不二次损坏）", async () => {
  const { store, fs, logs } = makeStore({ [INDEX]: "{ 坏掉的 JSON" });
  fs.failWhen = (op) => op === "move";

  await store.init();
  assert.equal(
    fs.files.get(INDEX),
    "{ 坏掉的 JSON",
    "bak 改名失败后仍写空索引（原文件被二次损坏）",
  );
  // 未载入 → 写操作被拒
  await assert.rejects(store.create({ title: "x" }), /injected move failure/);
  assert.ok(logs.some((l) => l.includes("keep original")));
});

test("21-R7: 数据目录在首次写入前建立（history 子目录随创建出现）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "t" });
  await store.appendTurn(rec.id, "问", "答");
  assert.ok(fs.dirs.has(DATA_DIR), "数据目录未创建");
  assert.ok(fs.dirs.has(HISTORY_DIR), "history 子目录未创建");
});
