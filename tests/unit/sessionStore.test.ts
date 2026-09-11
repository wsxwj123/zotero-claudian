// 单测 — src/utils/sessionStore.ts：索引 CRUD / 旁挂历史 / 损坏恢复 / 单一 writer 队列 /
// 路径穿越边界。（契约函数 loadSessionsIndex / parseHistoryJsonl / formatHistoryRecord 的
// 逐条行为由 tests/acceptance/storage.test.mjs 锁定，此处只测存储层语义。）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadSessionsIndex,
  parseHistoryJsonl,
  type SessionRecord,
} from "../../src/utils/sessionStore.ts";
import { DATA_DIR, makeStore } from "./helpers/memoryFs.ts";

const INDEX = `${DATA_DIR}/sessions.json`;
const HISTORY = (id: string): string => `${DATA_DIR}/history/${id}.jsonl`;

function indexOf(fs: { files: Map<string, string> }): {
  version: number;
  sessions: SessionRecord[];
} {
  return JSON.parse(fs.files.get(INDEX) as string) as {
    version: number;
    sessions: SessionRecord[];
  };
}

test("store: 首次运行无索引 → 空列表，不落盘；create 后索引可解析", async () => {
  const { store, fs } = makeStore();
  await store.init();
  assert.deepEqual(store.list(), []);
  assert.equal(fs.files.has(INDEX), false); // 无状态变化不写盘
  const rec = await store.create({ title: "首条消息" });
  assert.ok(rec.id);
  assert.equal(rec.claudeSessionId, null);
  assert.equal(rec.permissionMode, "acceptEdits");
  assert.equal(rec.allowedTools.length, 0);
  const onDisk = indexOf(fs);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.sessions.length, 1);
  assert.equal(onDisk.sessions[0].id, rec.id);
  assert.equal(onDisk.sessions[0].title, "首条消息");
});

test("store: update 未知 id → null；已知 id → 合并 + updatedAt 前进 + 落盘", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  assert.equal(await store.update("nope", { title: "x" }), null);
  const before = rec.updatedAt;
  const updated = await store.update(rec.id, {
    claudeSessionId: "cli-1",
    allowedTools: ["Bash(python *)"],
    messageCount: 2,
    lastCostUsd: 0.01,
  });
  assert.equal(updated?.claudeSessionId, "cli-1");
  assert.ok((updated as SessionRecord).updatedAt > before);
  const onDisk = indexOf(fs).sessions[0];
  assert.equal(onDisk.claudeSessionId, "cli-1");
  assert.deepEqual(onDisk.allowedTools, ["Bash(python *)"]);
  assert.equal(onDisk.messageCount, 2);
  // id 不可被 patch 改写
  const hijack = await store.update(rec.id, {
    id: "evil",
  } as Partial<SessionRecord>);
  assert.equal(hijack?.id, rec.id);
  assert.equal(store.get("evil"), null);
});

test("store: rename 改标题并落盘；updatedAt 不动（列表顺序不跳）；未知 id/空标题 → null", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({ title: "旧名" });
  // 未知 id
  assert.equal(await store.rename("nope", "新名"), null);
  // 空 / 纯空白标题 → 不改动（清空输入 = 放弃改名）
  assert.equal(await store.rename(rec.id, "   "), null);
  assert.equal(store.get(rec.id)?.title, "旧名");
  // 正常改名：trim + 落盘
  const renamed = await store.rename(rec.id, "  新名  ");
  assert.equal(renamed?.title, "新名");
  assert.equal(store.get(rec.id)?.title, "新名");
  assert.equal(indexOf(fs).sessions[0].title, "新名");
  // 改名不算「活动」：updatedAt 保持，list 顺序不因改名跳动
  assert.equal(renamed?.updatedAt, rec.updatedAt);
  // 截断口径与创建时一致（40 字符）
  const long = await store.rename(rec.id, "字".repeat(60));
  assert.equal(long?.title.length, 40);
});

test("store: rename 走同一 writer 队列（与并发 update 串行落盘，互不覆盖）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  await Promise.all([
    store.rename(rec.id, "名字A"),
    store.update(rec.id, { messageCount: 3 }),
    store.rename(rec.id, "名字B"),
  ]);
  const onDisk = indexOf(fs).sessions[0];
  assert.equal(onDisk.messageCount, 3); // update 未被 rename 的全量重写吞掉
  assert.equal(onDisk.title, "名字B"); // 后写的 rename 生效
});

test("store: appendTurn 写两行 jsonl、可回读；第二次追加不覆盖", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  const n = await store.appendTurn(rec.id, "第一问", "第一答");
  assert.equal(n, 2);
  assert.equal(await store.appendTurn(rec.id, "第二问", "第二答"), 2);
  const raw = fs.files.get(HISTORY(rec.id)) as string;
  assert.equal(raw.endsWith("\n"), true);
  assert.deepEqual(
    parseHistoryJsonl(raw).map((m) => m.text),
    ["第一问", "第一答", "第二问", "第二答"],
  );
  // 读路径与写路径同一份数据
  assert.deepEqual(
    (await store.readHistory(rec.id)).map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("store: assistant 空文本（纯工具轮）只写 user 一行", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  assert.equal(await store.appendTurn(rec.id, "跑个命令", ""), 1);
  const msgs = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
});

test("store: readHistory 未知 id / 无文件 → []（§4.6 getHistory 契约）", async () => {
  const { store } = makeStore();
  const rec = await store.create({});
  assert.deepEqual(await store.readHistory("unknown"), []);
  assert.deepEqual(await store.readHistory(rec.id), []);
  assert.deepEqual(await store.readHistory("../escape"), []);
});

test("store: remove 删索引记录 + 历史文件；未知 id → false", async () => {
  const { store, fs } = makeStore();
  const a = await store.create({ title: "a" });
  const b = await store.create({ title: "b" });
  await store.appendTurn(a.id, "q", "a");
  assert.equal(await store.remove("nope"), false);
  assert.equal(await store.remove(a.id), true);
  assert.equal(store.get(a.id), null);
  assert.equal(fs.files.has(HISTORY(a.id)), false);
  assert.deepEqual(
    store.list().map((s) => s.id),
    [b.id],
  );
  assert.equal(indexOf(fs).sessions.length, 1);
  // 重复删除 → false（幂等，不抛）
  assert.equal(await store.remove(a.id), false);
  // 不碰索引外的任何文件（~/.claude 侧文件本模块无从触及）
  assert.deepEqual([...fs.files.keys()].sort(), [INDEX]);
});

test("store: 损坏索引 → 改名 bak + 新建空索引 + wasReset（§4.5）", async () => {
  const { store, fs, logs } = makeStore({
    [INDEX]: '{"version":1,"sessions":[{"id"',
  });
  await store.init();
  assert.equal(store.wasReset(), true);
  assert.deepEqual(store.list(), []);
  const baks = [...fs.files.keys()].filter((p) =>
    p.includes("sessions.json.bak-"),
  );
  assert.equal(baks.length, 1);
  assert.equal(fs.files.get(baks[0]), '{"version":1,"sessions":[{"id"'); // 原样留现场
  assert.deepEqual(indexOf(fs).sessions, []); // 新空索引已落盘
  assert.ok(logs.some((m) => m.includes("corrupted")));
  assert.equal(fs.files.has(INDEX), true);
});

test("store: 空文件（0 字节）按损坏处理；合法索引正常载入不重置", async () => {
  const broken = makeStore({ [INDEX]: "" });
  await broken.store.init();
  assert.equal(broken.store.wasReset(), true);

  const good = makeStore({
    [INDEX]: JSON.stringify({
      version: 1,
      sessions: [
        {
          id: "u1",
          claudeSessionId: "c1",
          title: "旧会话",
          createdAt: 1,
          updatedAt: 5,
          itemKey: null,
          itemLibraryID: null,
          attachmentKey: null,
          permissionMode: "plan",
          allowedTools: [],
          messageCount: 2,
          lastCostUsd: 0,
        },
      ],
    }),
  });
  await good.store.init();
  assert.equal(good.store.wasReset(), false);
  assert.equal(good.store.list().length, 1);
  assert.equal(good.store.get("u1")?.claudeSessionId, "c1");
  assert.equal(good.store.get("u1")?.permissionMode, "plan");
});

test("store: 单一 writer 队列——并发 appendTurn 不互相覆盖（读改写整体在队列内）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  // 不 await 逐个发起：若读改写拆在队列外，后发起的读会拿到旧内容并覆盖前者
  await Promise.all([
    store.appendTurn(rec.id, "q1", "a1"),
    store.appendTurn(rec.id, "q2", "a2"),
    store.appendTurn(rec.id, "q3", "a3"),
  ]);
  const msgs = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.equal(msgs.length, 6);
  assert.deepEqual(
    msgs.filter((m) => m.role === "user").map((m) => m.text),
    ["q1", "q2", "q3"],
  );
});

test("store: 并发 create/update 全部落盘（写串行、无丢失）", async () => {
  const { store, fs } = makeStore();
  const created = await Promise.all([
    store.create({ title: "1" }),
    store.create({ title: "2" }),
    store.create({ title: "3" }),
  ]);
  await store.flush();
  assert.equal(indexOf(fs).sessions.length, 3);
  assert.equal(new Set(created.map((r) => r.id)).size, 3);
});

test("store: list 按 updatedAt 降序、mostRecent 取最新", async () => {
  const { store } = makeStore();
  const a = await store.create({ title: "a" });
  const b = await store.create({ title: "b" });
  await store.update(a.id, { title: "a2" }); // a 变最新
  assert.deepEqual(
    store.list().map((s) => s.id),
    [a.id, b.id],
  );
  assert.equal(store.mostRecent()?.id, a.id);
});

// ---- BUG-21 / BUG-21b 回归锁：读失败绝不能被当成「空数据」 ----
// 根因：旧实现把「读不出来」与「文件不存在」都当空基线，随后的全量重写把既有数据整段覆盖。

/** 可注入读失败的假 fs（只包一层现有实现，不改数据行为） */
function withReadFailure(
  base: ReturnType<typeof createMemoryFs>,
): ReturnType<typeof createMemoryFs> & { failReads: boolean } {
  const wrapped = base as ReturnType<typeof createMemoryFs> & {
    failReads: boolean;
  };
  wrapped.failReads = false;
  const original = base.readText;
  base.readText = async (path: string) => {
    if (wrapped.failReads) {
      throw new Error(`injected read failure: ${path}`);
    }
    return original(path);
  };
  return wrapped;
}

test("BUG-21: 历史读失败 → 追加仍保住既有内容（真追加，不再全量重写）", async () => {
  const memory = makeStore();
  const fs = withReadFailure(memory.fs);
  const rec = await memory.store.create({ title: "t" });
  await memory.store.appendTurn(rec.id, "第一问", "第一答");
  const before = fs.files.get(HISTORY(rec.id)) as string;
  assert.deepEqual(
    parseHistoryJsonl(before).map((m) => m.text),
    ["第一问", "第一答"],
  );

  fs.failReads = true;
  const written = await memory.store.appendTurn(rec.id, "第二问", "第二答");
  fs.failReads = false;

  assert.equal(written, 2);
  const after = parseHistoryJsonl(fs.files.get(HISTORY(rec.id)) as string);
  assert.deepEqual(
    after.map((m) => m.text),
    ["第一问", "第一答", "第二问", "第二答"],
    "读失败被当成空历史 → 旧对话整段丢失",
  );
  assert.ok(
    (fs.files.get(HISTORY(rec.id)) as string).startsWith(before),
    "既有内容必须原样保留在文件开头",
  );
});

test("BUG-21b: 索引读失败 ≠ 首次运行 → 后续写不得覆盖既有索引（载入成功前写全部被拒）", async () => {
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
  const memory = makeStore({ [INDEX]: existing });
  const fs = withReadFailure(memory.fs);

  fs.failReads = true;
  await memory.store.init(); // 失败不抛（握手路径没有错误出口），但保持未载入
  // 载入成功前：写操作一律拒绝，绝不拿空基线去覆盖未知内容
  await assert.rejects(
    memory.store.create({ title: "新会话" }),
    /injected read failure/,
  );
  assert.equal(fs.files.get(INDEX), existing, "写失败路径不得改写索引");
  fs.failReads = false;

  // 读恢复后重试：既有会话仍在，新会话合并进去（不是覆盖）
  const created = await memory.store.create({ title: "新会话" });
  await memory.store.flush();
  assert.equal(memory.store.get("keep-me")?.title, "既有会话");
  assert.equal(memory.store.get(created.id)?.title, "新会话");
  assert.deepEqual(
    indexOf(fs)
      .sessions.map((s) => s.id)
      .sort(),
    [created.id, "keep-me"].sort(),
  );
});

test("OBS-3: 索引写失败 → create 不留幽灵会话（内存与磁盘口径一致）", async () => {
  const { store, fs } = makeStore();
  const a = await store.create({ title: "a" });

  const writeOk = fs.writeText;
  fs.writeText = async (path, data) => {
    if (path === `${INDEX}.tmp`) {
      throw new Error("injected disk full");
    }
    return writeOk(path, data);
  };
  await assert.rejects(store.create({ title: "幽灵" }), /injected disk full/);
  fs.writeText = writeOk;

  // 写盘没成的记录必须离开内存：否则 list()/mostRecent() 会把它当既成事实
  // （下次 send 直接认领它），而它并不在盘上，重启后又消失
  assert.deepEqual(
    store.list().map((s) => s.title),
    ["a"],
    "写失败的 create 留在内存",
  );
  assert.equal(store.mostRecent()?.id, a.id, "mostRecent 认领了幽灵会话");
  assert.deepEqual(
    indexOf(fs).sessions.map((s) => s.id),
    [a.id],
    "失败路径改写了磁盘索引",
  );
});

test("OBS-3: 索引写失败 → update/remove 同样回滚（内存态不得领先磁盘态）", async () => {
  const { store, fs } = makeStore();
  const a = await store.create({ title: "a" });
  const before = fs.files.get(INDEX);

  const writeOk = fs.writeText;
  fs.writeText = async (path, data) => {
    if (path === `${INDEX}.tmp`) {
      throw new Error("injected disk full");
    }
    return writeOk(path, data);
  };
  await assert.rejects(
    store.update(a.id, { title: "改了" }),
    /injected disk full/,
  );
  assert.equal(store.get(a.id)?.title, "a", "写失败的 update 留在内存里");
  await assert.rejects(store.remove(a.id), /injected disk full/);
  assert.ok(store.get(a.id), "写失败的 remove 把会话从内存抹掉（重启后复活）");
  fs.writeText = writeOk;

  assert.equal(fs.files.get(INDEX), before, "失败路径改写了磁盘索引");
  // 队列与 store 均未被毒化：故障恢复后照常可写
  const b = await store.create({ title: "b" });
  await store.flush();
  assert.deepEqual(
    indexOf(fs)
      .sessions.map((s) => s.id)
      .sort(),
    [a.id, b.id].sort(),
  );
});

test("store: 损坏索引备份失败 → 保持原文件不动（不写空索引二次损坏）", async () => {
  const corrupted = '{"version":1,"sessions":[{"id"';
  const { store, fs, logs } = makeStore({ [INDEX]: corrupted });
  const moveOk = fs.move;
  fs.move = async (from: string, to: string) => {
    if (from === INDEX) {
      throw new Error("injected move failure");
    }
    return moveOk(from, to);
  };
  await store.init(); // 不抛（握手路径没有错误出口）
  assert.equal(fs.files.get(INDEX), corrupted, "备份没成时不得覆盖原文件");
  assert.ok(logs.some((m) => m.includes("keep original")));
});

test("store: 手改索引塞入穿越 id → 一切文件操作拒绝（路径边界）", async () => {
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
  const { store, fs, logs } = makeStore({
    [INDEX]: JSON.stringify({ version: 1, sessions: [evil] }),
  });
  await store.init();
  // 索引载入保留该记录（形态合法），但 id 不过白名单 → 文件操作全部拒绝
  assert.equal(await store.appendTurn("../evil", "q", "a"), 0);
  assert.deepEqual(await store.readHistory("../evil"), []);
  const paths = [...fs.files.keys()];
  assert.equal(
    paths.some((p) => p.includes("..")),
    false,
  );
  assert.ok(logs.some((m) => m.includes("unsafe") || m.includes("unknown")));
});

// ---- claudeSessionId argv 卫生（BUG-32：该值拼进 `--resume <id>`，磁盘篡改不得进参数位）----

test("store: 索引里 claudeSessionId 畸形（flag 形态/空白/超长）→ 加载即丢弃为 null", () => {
  const loaded = loadSessionsIndex(
    JSON.stringify({
      version: 1,
      sessions: [
        { id: "s1", claudeSessionId: "--dangerous" },
        { id: "s2", claudeSessionId: "has space" },
        { id: "s3", claudeSessionId: "ok-id_123" },
        { id: "s4", claudeSessionId: "9f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8" },
        { id: "s5", claudeSessionId: "x".repeat(65) },
        { id: "s6", claudeSessionId: "a\nb" },
        { id: "s7", claudeSessionId: "a;b" },
        { id: "s8", claudeSessionId: "[x|y]" },
      ],
    }),
  );
  assert.equal(loaded.corrupted, false);
  const byId = new Map(loaded.sessions.map((s) => [s.id, s.claudeSessionId]));
  assert.equal(
    byId.get("s1"),
    null,
    "flag 形态 token 必须丢弃（否则拼进 argv 参数位）",
  );
  assert.equal(byId.get("s2"), null);
  assert.equal(byId.get("s3"), "ok-id_123");
  assert.equal(
    byId.get("s4"),
    "9f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8",
    "CLI 真 id（uuid）必须原样保留，否则续接断链",
  );
  assert.equal(byId.get("s5"), null, "超长（>64）丢弃");
  assert.equal(byId.get("s6"), null, "换行丢弃");
  assert.equal(byId.get("s7"), null, "分号丢弃（cmd.exe 元字符）");
  assert.equal(
    byId.get("s8"),
    null,
    "方括号丢弃（字符类写错曾把 [ ] \\ ^ ` 放进白名单）",
  );
});

test("store: 手改索引的畸形 claudeSessionId 不落进内存态（store 集成口径同 loadSessionsIndex）", async () => {
  const { store, fs } = makeStore();
  fs.files.set(
    INDEX,
    JSON.stringify({
      version: 1,
      sessions: [
        { id: "s1", claudeSessionId: "--dangerous" },
        { id: "s3", claudeSessionId: "ok-id_123" },
      ],
    }),
  );
  await store.init();
  assert.equal(store.get("s1")?.claudeSessionId, null);
  assert.equal(store.get("s3")?.claudeSessionId, "ok-id_123");
});
