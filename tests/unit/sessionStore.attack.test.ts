// 单测 — sessionStore 攻击面直打。
// B1 并发写 / 写中途抛错；B2 原子替换 + 损坏索引恢复；B3 路径逃逸；
// B4 历史读写容错 / 并发追加；B5 契约函数边界；BUG-21/21b 读失败语义回归锁。
// （由 test-m5 的 m5-probe 探针转正；BUG-21/21b 修复后全绿，红灯即回归。）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatHistoryRecord,
  loadSessionsIndex,
  parseHistoryJsonl,
  type SessionRecord,
} from "../../src/utils/sessionStore.ts";
import {
  allOpsInsideDataDir,
  DATA_DIR,
  HISTORY,
  INDEX,
  makeProbeStore,
  onDiskIndex,
} from "./helpers/probeFs.ts";

// ---------- B1 并发写 ----------

test("B1-1: 并发 20 写（create/update/appendTurn 混合）→ 写类操作零交错、索引最终一致", async () => {
  const { store, fs } = makeProbeStore();
  fs.delayMs = 1; // 放大交错窗口：若队列被绕过，必然被 maxWriteConcurrent > 1 抓到
  const base = await store.create({ title: "base" });

  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(store.create({ title: `s${i}` }));
  }
  for (let i = 0; i < 20; i++) {
    jobs.push(store.appendTurn(base.id, `q${i}`, `a${i}`));
  }
  for (let i = 0; i < 20; i++) {
    jobs.push(store.update(base.id, { lastCostUsd: i }));
  }
  await Promise.all(jobs);
  await store.flush();

  assert.equal(
    fs.maxWriteConcurrent,
    1,
    `写类 fs 操作发生交错：峰值 ${fs.maxWriteConcurrent}`,
  );
  const onDisk = onDiskIndex(fs);
  assert.equal(onDisk.sessions.length, 21); // base + 20
  assert.equal(new Set(onDisk.sessions.map((s) => s.id)).size, 21);
  // 历史文件里 20 轮 × 2 行全部在，且顺序不乱
  const msgs = parseHistoryJsonl(fs.files.get(HISTORY(base.id)) as string);
  assert.equal(msgs.length, 40);
  assert.deepEqual(
    msgs.filter((m) => m.role === "user").map((m) => m.text),
    Array.from({ length: 20 }, (_, i) => `q${i}`),
  );
  // 落盘内容与内存列表一致（全量重写无丢失）
  assert.deepEqual(
    onDisk.sessions.map((s) => s.id).sort(),
    store
      .list()
      .map((s) => s.id)
      .sort(),
  );
});

test("B1-2: 写中途抛错（磁盘满）→ 该调用方收到失败、队列恢复、后续写仍成功", async () => {
  const { store, fs } = makeProbeStore();
  const a = await store.create({ title: "a" });

  let arm = true;
  fs.failWhen = (op, path) => arm && op === "write" && path === `${INDEX}.tmp`; // 只打第一次索引 tmp 写
  await assert.rejects(store.create({ title: "b" }), /injected write failure/);
  arm = false;

  // 队列未被毒化：后续写照常串行完成
  const c = await store.create({ title: "c" });
  await store.flush();
  assert.equal(fs.maxWriteConcurrent, 1);
  const onDisk = onDiskIndex(fs);
  assert.ok(onDisk.sessions.some((s) => s.id === a.id));
  assert.ok(onDisk.sessions.some((s) => s.id === c.id));
  // 反向：失败的 b 不得出现在盘上（调用方已收到失败）
  const inMemory = store.list().map((s) => s.id);
  const onDiskIds = onDisk.sessions.map((s) => s.id);
  assert.deepEqual(
    onDiskIds.filter((id) => !inMemory.includes(id)),
    [],
    "盘上有内存里没有的记录（幽灵会话）",
  );
});

test("B1-3: move 失败 → 索引保持旧内容（不半写），后续写恢复", async () => {
  const { store, fs } = makeProbeStore();
  const a = await store.create({ title: "a" });
  const before = fs.files.get(INDEX);

  let arm = true;
  // atomicWrite：move(<path>.tmp, <path>)，注入点按 from 匹配
  fs.failWhen = (op, path) => arm && op === "move" && path === `${INDEX}.tmp`;
  await assert.rejects(store.create({ title: "b" }));
  arm = false;
  assert.equal(fs.files.get(INDEX), before, "move 失败索引仍被改写");
  // 残留 .tmp 不参与判定，但记录事实：move 失败后 tmp 文件仍在
  assert.equal(fs.files.has(`${INDEX}.tmp`), true);

  const c = await store.create({ title: "c" });
  assert.ok(fs.files.has(INDEX));
  const ids = onDiskIndex(fs).sessions.map((s) => s.id);
  assert.ok(ids.includes(a.id) && ids.includes(c.id));
});

test("BUG-21: 读历史失败（I/O 错误）→ 追加必须保住既有历史", async () => {
  const { store, fs } = makeProbeStore();
  const rec = await store.create({ title: "t" });
  await store.appendTurn(rec.id, "第一问", "第一答");
  const before = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.equal(before.length, 2);

  let arm = true;
  fs.failWhen = (op, path) => arm && op === "read" && path === HISTORY(rec.id);
  await store.appendTurn(rec.id, "第二问", "第二答");
  arm = false;

  const after = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.deepEqual(
    after.map((m) => m.text),
    ["第一问", "第一答", "第二问", "第二答"],
    `读历史失败后追加把旧历史整段覆盖：现存 ${JSON.stringify(after.map((m) => m.text))}`,
  );
});

test("BUG-21b: 索引读失败（I/O 错误）→ 不得被当成首次运行而被后续写覆盖", async () => {
  const existing = JSON.stringify({
    version: 1,
    sessions: [
      {
        id: "keep-me",
        claudeSessionId: "c1",
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
  const { store, fs } = makeProbeStore({ [INDEX]: existing });
  let arm = true;
  fs.failWhen = (op, path) => arm && op === "read" && path === INDEX;
  await store.init(); // 读失败被降级为「首次运行」
  arm = false;
  await store.create({ title: "新会话" }); // 首次状态变化触发全量重写
  await store.flush();
  const ids = onDiskIndex(fs).sessions.map((s) => s.id);
  assert.deepEqual(
    ids.includes("keep-me"),
    true,
    `索引读失败后新建会话把既有索引整份覆盖：现存 ${JSON.stringify(ids)}`,
  );
});

// ---------- B2 原子替换 + 损坏恢复 ----------

test("B2-1: 损坏索引各形态 → bak 改名留现场 + 新建空索引 + wasReset", async () => {
  const cases: [string, string][] = [
    ["截断 JSON", '{"version":1,"sessions":[{"id"'],
    ["空文件", ""],
    ["空对象", "{}"],
    ["顶层数组", "[]"],
    ["顶层 null", "null"],
    ["顶层字符串", '"index"'],
    ["sessions 非数组", '{"version":1,"sessions":"x"}'],
    ["sessions 为 null", '{"version":1,"sessions":null}'],
    [
      "BOM + 合法 JSON",
      `\ufeff${JSON.stringify({ version: 1, sessions: [] })}`,
    ],
  ];
  for (const [name, raw] of cases) {
    const { store, fs } = makeProbeStore({ [INDEX]: raw });
    await store.init();
    assert.equal(store.wasReset(), true, `${name}：未判为损坏`);
    const baks = [...fs.files.keys()].filter((p) =>
      p.startsWith(`${INDEX}.bak-`),
    );
    assert.equal(baks.length, 1, `${name}：bak 数量 ${baks.length}`);
    assert.equal(fs.files.get(baks[0]), raw, `${name}：bak 内容非原样`);
    assert.deepEqual(onDiskIndex(fs).sessions, [], `${name}：未落空索引`);
  }
});

test("B2-2: bak 可回读——损坏现场未加密未改写，数组形态的会话数据仍可取回", async () => {
  // 「损坏」但内容含可救数据的场景：sessions 字段被写坏成字符串，原记录文本还在文件里
  const raw = '{"version":1,"sessions":"[{id: broken}]"}';
  const { store, fs } = makeProbeStore({ [INDEX]: raw });
  await store.init();
  const bak = [...fs.files.keys()].find((p) => p.startsWith(`${INDEX}.bak-`));
  assert.ok(bak);
  assert.equal(fs.files.get(bak as string), raw);
});

test("B2-3: bak 名含 now() 时间戳；同毫秒二次损坏 → 后一次覆盖前一次 bak（事实记录）", async () => {
  // now() 固定不变模拟同毫秒：两次损坏恢复落到同一 bak 名
  const { store, fs } = makeProbeStore(
    { [INDEX]: "broken-A" },
    { now: () => 1_700_000_000_000 },
  );
  await store.init();
  assert.ok(fs.files.has(`${INDEX}.bak-1700000000000`));
  // 第二次：内容变了但时间戳相同
  fs.files.set(INDEX, "broken-B");
  const second = makeProbeStore(
    { [INDEX]: "broken-B" },
    { now: () => 1_700_000_000_000 },
  );
  await second.store.init();
  assert.equal(second.fs.files.get(`${INDEX}.bak-1700000000000`), "broken-B");
});

test("B2-4: 损坏后写索引失败（磁盘满）不抛、留下内存空列表且 wasReset 已置位", async () => {
  const { store, fs, logs } = makeProbeStore({ [INDEX]: "{oops" });
  fs.failWhen = (op, path) => op === "write" && path === `${INDEX}.tmp`;
  await store.init();
  assert.equal(store.wasReset(), true);
  assert.deepEqual(store.list(), []);
  assert.ok(logs.some((m) => m.includes("write empty index failed")));
});

test("B2-5: 首次运行无索引 → 不落盘（不产生空 sessions.json 覆盖竞态窗口）", async () => {
  const { store, fs } = makeProbeStore();
  await store.init();
  assert.equal(fs.files.has(INDEX), false);
  await store.flush();
  assert.equal(fs.files.has(INDEX), false);
});

// ---------- B3 路径逃逸 ----------

const EVIL_IDS = [
  "../escape",
  "..\\escape",
  "../../etc/passwd",
  "/etc/passwd",
  "C:\\Windows\\evil",
  "a\u0000b",
  "sub/dir",
  "..",
  "a b",
  "",
  "%2e%2e%2fescape",
  ".",
];

test("B3-1: 索引手改塞入逃逸 id → 文件操作全拒、fs 无任何越界路径", async () => {
  for (const evil of EVIL_IDS) {
    const rec = {
      id: evil,
      claudeSessionId: null,
      title: "x",
      createdAt: 1,
      updatedAt: 1,
      itemKey: null,
      itemLibraryID: null,
      attachmentKey: null,
      permissionMode: "acceptEdits",
      allowedTools: [],
      messageCount: 0,
      lastCostUsd: 0,
    };
    const { store, fs } = makeProbeStore({
      [INDEX]: JSON.stringify({ version: 1, sessions: [rec] }),
    });
    await store.init();
    assert.equal(
      await store.appendTurn(evil, "q", "a"),
      0,
      `appendTurn 未拒绝 id=${JSON.stringify(evil)}`,
    );
    assert.deepEqual(
      await store.readHistory(evil),
      [],
      `readHistory 未拒绝 id=${JSON.stringify(evil)}`,
    );
    await store.remove(evil);
    assert.equal(
      allOpsInsideDataDir(fs),
      true,
      `id=${JSON.stringify(evil)} 触发越界路径：${fs.ops.filter((o) => !o.split(" ").slice(1).join(" ").startsWith(DATA_DIR)).join(" | ")}`,
    );
    assert.equal(
      fs.files.has(`${DATA_DIR}/history/${evil}.jsonl`),
      false,
      `id=${JSON.stringify(evil)} 写出了历史文件`,
    );
  }
});

test("B3-2: 正向对照——合法 id 照常读写（白名单不是把功能一起拒了）", async () => {
  const { store, fs } = makeProbeStore();
  const rec = await store.create({ title: "ok" });
  assert.match(rec.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(await store.appendTurn(rec.id, "问", "答"), 2);
  assert.equal((await store.readHistory(rec.id)).length, 2);
  assert.equal(allOpsInsideDataDir(fs), true);
});

test("B3-3: 删除逃逸 id → 索引记录被移除，但绝不向越界路径发 remove", async () => {
  const evil = {
    id: "../evil",
    claudeSessionId: null,
    title: "x",
    createdAt: 1,
    updatedAt: 1,
    itemKey: null,
    itemLibraryID: null,
    attachmentKey: null,
    permissionMode: "acceptEdits",
    allowedTools: [],
    messageCount: 0,
    lastCostUsd: 0,
  };
  const { store, fs } = makeProbeStore({
    [INDEX]: JSON.stringify({ version: 1, sessions: [evil] }),
  });
  await store.init();
  assert.equal(await store.remove("../evil"), true);
  assert.equal(store.get("../evil"), null);
  assert.deepEqual(onDiskIndex(fs).sessions, []);
  assert.equal(allOpsInsideDataDir(fs), true);
  assert.ok(fs.ops.some((o) => o.includes("refuse") === false)); // 仅记录事实
});

// ---------- B4 历史读写 ----------

test("B4-1: jsonl 畸形行逐类容错——坏行不牵连好行、永不抛", () => {
  const raw = [
    '{"role":"user","text":"好行1","ts":1}',
    '{"role":"user","text":"半行被截断', // 半行
    "not json at all", // 非 JSON
    '{"text":"无 role","ts":2}', // 无 role
    '{"role":"system","text":"角色非法","ts":3}', // role 非法
    '{"role":"assistant","ts":4}', // 无 text
    '{"role":"assistant","text":123,"ts":5}', // text 非字符串
    '"just a string"', // 合法 JSON 非对象
    "[1,2,3]", // 数组
    "null",
    "   ", // 纯空白
    "", // 空行
    '{"role":"assistant","text":"好行2","ts":6}',
  ].join("\n");
  assert.deepEqual(
    parseHistoryJsonl(raw).map((m) => m.text),
    ["好行1", "好行2"],
  );
});

test("B4-2: 空文件 / 无结尾换行 / CRLF / 超长行 / Unicode 与内嵌换行文本回环", () => {
  assert.deepEqual(parseHistoryJsonl(""), []);
  assert.deepEqual(parseHistoryJsonl("\n\n"), []);
  // CRLF：\r 不被 trim 掉的场景（JSON.parse 容忍尾随空白）
  assert.equal(
    parseHistoryJsonl('{"role":"user","text":"crlf","ts":1}\r\n').length,
    1,
  );
  // 无结尾换行
  assert.equal(
    parseHistoryJsonl('{"role":"user","text":"noeol","ts":1}').length,
    1,
  );
  // 超长行（200KB）
  const long = "字".repeat(100_000);
  assert.equal(
    parseHistoryJsonl(
      formatHistoryRecord({ role: "user", text: long, ts: 1 }),
    )[0].text.length,
    100_000,
  );
  // 文本内含换行/引号/emoji → 序列化仍是单行，回读逐字还原
  const tricky = '第一行\n第二行 "引号" \\ 反斜杠 😀\t tab';
  const line = formatHistoryRecord({ role: "assistant", text: tricky, ts: 9 });
  assert.equal(line.includes("\n"), false, "序列化产物含真实换行 → 会拆行");
  assert.equal(parseHistoryJsonl(`${line}\n`)[0].text, tricky);
});

test("B4-3: 历史文件缺结尾换行时追加 → 不把两行粘成一行", async () => {
  const { store, fs } = makeProbeStore();
  const rec = await store.create({ title: "t" });
  // 模拟外部写入/异常截断留下的无换行尾行
  fs.files.set(HISTORY(rec.id), '{"role":"user","text":"旧行无换行","ts":1}');
  await store.appendTurn(rec.id, "新问", "新答");
  const msgs = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.deepEqual(
    msgs.map((m) => m.text),
    ["旧行无换行", "新问", "新答"],
    "缺换行的尾行与新行粘连导致旧行丢失",
  );
});

test("B4-4: 20 路并发 appendTurn 同一会话 → 40 行全在、顺序不乱、写串行", async () => {
  const { store, fs } = makeProbeStore();
  fs.delayMs = 1;
  const rec = await store.create({ title: "t" });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.appendTurn(rec.id, `q${i}`, `a${i}`),
    ),
  );
  await store.flush();
  const msgs = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.equal(msgs.length, 40);
  assert.deepEqual(
    msgs.filter((m) => m.role === "user").map((m) => m.text),
    Array.from({ length: 20 }, (_, i) => `q${i}`),
  );
  assert.equal(fs.maxWriteConcurrent, 1);
});

test("B4-5: 未知会话 appendTurn → 0 且不创建任何文件（只写不读场景不越界）", async () => {
  const { store, fs } = makeProbeStore();
  await store.init();
  assert.equal(await store.appendTurn("nosuch", "q", "a"), 0);
  assert.deepEqual([...fs.files.keys()], []);
});

test("B4-6: 删除后 readHistory → []；并发删除与追加不产生幽灵历史文件", async () => {
  const { store, fs } = makeProbeStore();
  const rec = await store.create({ title: "t" });
  await Promise.all([
    store.appendTurn(rec.id, "q1", "a1"),
    store.remove(rec.id),
  ]);
  await store.flush();
  assert.equal(
    fs.files.has(HISTORY(rec.id)),
    false,
    `会话已删但历史文件被复活（无主历史文件残留）：${JSON.stringify([...fs.files.keys()])}`,
  );
  assert.deepEqual(await store.readHistory(rec.id), []);
});

// ---------- B5 契约函数边界 ----------

test("B5-1: loadSessionsIndex 逐条边界（非对象/缺 sessions/非数组 → corrupted）", () => {
  for (const raw of [
    "[]",
    "null",
    "1",
    '"x"',
    "true",
    "{}",
    '{"sessions":{}}',
    "",
  ]) {
    const r = loadSessionsIndex(raw);
    assert.equal(r.corrupted, true, `${raw} 未判损坏`);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.version, 1);
  }
  // 合法空索引：不判损坏（区分「空」与「坏」）
  const ok = loadSessionsIndex('{"version":7,"sessions":[]}');
  assert.equal(ok.corrupted, false);
  assert.equal(ok.version, 7);
});

test("B5-2: loadSessionsIndex 单条坏记录只丢该条，其余照常可用", () => {
  const raw = JSON.stringify({
    version: 1,
    sessions: [
      null,
      1,
      "str",
      [],
      { title: "无 id" },
      { id: "" },
      { id: 42 },
      { id: "good-1", title: "好记录" },
    ],
  });
  const r = loadSessionsIndex(raw);
  assert.equal(r.corrupted, false);
  assert.deepEqual(
    r.sessions.map((s) => s.id),
    ["good-1"],
  );
});

test("B5-3: 字段归一——allowedTools 非字符串过滤、permissionMode 非法回落、数值非有限值补缺省", () => {
  const r = loadSessionsIndex(
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: "s1",
          permissionMode: "yolo",
          allowedTools: ["Bash(python *)", 1, null, "Read"],
          itemLibraryID: "1",
          messageCount: "3",
          lastCostUsd: null,
          createdAt: 1e308 * 10, // Infinity 经 JSON 变 null
          updatedAt: -1,
        },
      ],
    }),
    "plan",
  );
  const s = r.sessions[0] as SessionRecord;
  assert.equal(s.permissionMode, "plan");
  assert.deepEqual(s.allowedTools, ["Bash(python *)", "Read"]);
  assert.equal(s.itemLibraryID, null);
  assert.equal(s.messageCount, 0);
  assert.equal(s.lastCostUsd, 0);
  assert.equal(s.createdAt, 0);
  assert.equal(s.updatedAt, -1); // 负数不修正（仅非有限值补缺省）——事实记录
});

test("B5-4: formatHistoryRecord 精确形态——键序固定、无结尾换行、单行", () => {
  const line = formatHistoryRecord({ role: "user", text: "hi", ts: 5 });
  assert.equal(line, '{"role":"user","text":"hi","ts":5}');
  assert.equal(line.endsWith("\n"), false);
  // 多余字段不进产物（形态受控）
  assert.equal(
    formatHistoryRecord({
      role: "user",
      text: "hi",
      ts: 5,
      extra: "x",
    } as never),
    '{"role":"user","text":"hi","ts":5}',
  );
});

test("B5-5: 索引 ↔ 历史 id 一致性——list() 的 id 都能读出自己的历史（无串号）", async () => {
  const { store } = makeProbeStore();
  const a = await store.create({ title: "a" });
  const b = await store.create({ title: "b" });
  await store.appendTurn(a.id, "A问", "A答");
  await store.appendTurn(b.id, "B问", "B答");
  const readA = await store.readHistory(a.id);
  const readB = await store.readHistory(b.id);
  assert.deepEqual(
    readA.map((m) => m.text),
    ["A问", "A答"],
  );
  assert.deepEqual(
    readB.map((m) => m.text),
    ["B问", "B答"],
  );
});
