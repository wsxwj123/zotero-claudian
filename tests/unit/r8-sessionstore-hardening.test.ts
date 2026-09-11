// 单测 — R8 sessionStore 加固（后台复查报的两处）：
//   A. newSessionId 三档回退（弱随机 Math.random 退场；三档产出都过 id 白名单）
//   B. claudeSessionId 写侧白名单：create/update 与读盘归一（normalizeSessionRecord）同一判据，
//      畸形值不落索引、不进内存 —— 该字段下一轮就拼进 argv 的 `--resume <id>`（BUG-32）
//   C. 恶意 id 直打**每个**方法：拒绝 + 零 fs 触碰（假 fs 断言操作序列为空）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeId, newSessionId } from "../../src/utils/sessionStore.ts";
import { DATA_DIR, makeStore } from "./helpers/memoryFs.ts";
import {
  allOpsInsideDataDir,
  makeProbeStore,
  onDiskIndex,
  INDEX,
} from "./helpers/probeFs.ts";

// ---------- 工具 ----------

/** 临时替换 globalThis.crypto（configurable 的访问器，用完还原） */
function withCrypto<T>(value: unknown, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (desc) {
      Object.defineProperty(globalThis, "crypto", desc);
    } else {
      delete (globalThis as { crypto?: unknown }).crypto;
    }
  }
}

const EVIL_IDS = [
  "../x",
  "..\\x",
  "a/b",
  "",
  "-flag",
  "x".repeat(65),
  "a b",
  ".",
  "..",
];

function evilRecord(id: string): Record<string, unknown> {
  return {
    id,
    claudeSessionId: null,
    title: "evil",
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
}

// ---------- A. id 生成三档 ----------

test("A1: 有 randomUUID → 直接用它的产出（不打第二档）", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  let secondCalled = false;
  const id = withCrypto(
    {
      randomUUID: () => uuid,
      getRandomValues: () => {
        secondCalled = true;
        throw new Error("不该走第二档");
      },
    },
    () => newSessionId(),
  );
  assert.equal(id, uuid);
  assert.equal(secondCalled, false);
});

test("A1b: randomUUID 返回畸形串（环境坏了）→ 降级走第二档，不把脏 id 放出去", () => {
  const id = withCrypto(
    {
      randomUUID: () => "../../etc/passwd",
      getRandomValues: (a: Uint8Array) => a.fill(0x5a),
    },
    () => newSessionId(),
  );
  assert.equal(isSafeId(id), true);
  assert.equal(id, "5a".repeat(16));
});

test("A2: 无 randomUUID → crypto.getRandomValues 自造 16 字节 hex（过白名单）", () => {
  let gotLength = 0;
  const id = withCrypto(
    {
      // 故意不提供 randomUUID（调用即 TypeError）
      getRandomValues: (arr: Uint8Array): Uint8Array => {
        gotLength = arr.length;
        for (let i = 0; i < arr.length; i++) {
          arr[i] = (i * 7 + 3) % 256;
        }
        return arr;
      },
    },
    () => newSessionId(),
  );
  assert.equal(gotLength, 16, "应申请 16 字节随机");
  assert.match(id, /^[0-9a-f]{32}$/, `第二档应为 32 位小写 hex：${id}`);
  assert.equal(isSafeId(id), true);
});

test("A3: 连 WebCrypto 都没有 → 时间戳兜底，仍过白名单（仅测试环境的口子）", () => {
  const id = withCrypto(undefined, () => newSessionId());
  assert.match(id, /^sess-[0-9a-z]+-[0-9a-z]+$/, `第三档形态：${id}`);
  assert.equal(isSafeId(id), true);
});

test("A4: 三档产出都不含路径分隔符、不以 - 开头（拼路径/参数位安全）", () => {
  const stubs: unknown[] = [
    { randomUUID: () => "abc-DEF_123" },
    { getRandomValues: (a: Uint8Array) => a.fill(0xab) },
    undefined,
  ];
  const ids = stubs.map((s) => withCrypto(s, () => newSessionId()));
  for (const id of ids) {
    assert.equal(isSafeId(id), true, `未过白名单：${id}`);
    assert.equal(/[/\\]/.test(id), false, `含路径分隔符：${id}`);
    assert.equal(id.startsWith("-"), false, `以 - 开头：${id}`);
    assert.equal(id.length <= 64, true, `超长：${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, "三档产出应互不相同");
});

// ---------- B. claudeSessionId 写侧白名单 ----------

test("B1: create 传畸形 claudeSessionId → 内存与磁盘都不落（与读盘归一同一判据）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({
    claudeSessionId: "--dangerously-skip-permissions",
  });
  assert.equal(rec.claudeSessionId, null);
  assert.equal(store.get(rec.id)?.claudeSessionId, null);
  const raw = fs.files.get(`${DATA_DIR}/sessions.json`) as string;
  assert.equal(raw.includes("dangerously"), false, "畸形值不应落盘");
  // 重启（同盘重建 store）后仍是 null：写侧与读侧口径一致
  const { store: store2 } = makeStore({ [`${DATA_DIR}/sessions.json`]: raw });
  await store2.init();
  assert.equal(store2.get(rec.id)?.claudeSessionId, null);
});

test("B2: update patch 传畸形 claudeSessionId → 清成 null（不落索引、不进 argv）", async () => {
  const { store, fs } = makeStore();
  const rec = await store.create({});
  const updated = await store.update(rec.id, {
    claudeSessionId: "--resume-escape",
  });
  assert.equal(updated?.claudeSessionId, null);
  assert.equal(store.get(rec.id)?.claudeSessionId, null);
  const raw = fs.files.get(`${DATA_DIR}/sessions.json`) as string;
  assert.equal(raw.includes("resume-escape"), false);
});

test("B3: 正向对照——合法 uuid 原样保留（白名单不是把续接一起拒了）", async () => {
  const { store } = makeStore();
  const cli = "649def34-f8be-52c8-b662-81af98ae884c";
  const rec = await store.create({ claudeSessionId: cli });
  assert.equal(rec.claudeSessionId, cli);
  const next = "11111111-2222-3333-4444-555555555555";
  const updated = await store.update(rec.id, { claudeSessionId: next });
  assert.equal(updated?.claudeSessionId, next);
  // update 不带该字段 → 保持原值（不误清）
  const kept = await store.update(rec.id, { title: "改名" });
  assert.equal(kept?.claudeSessionId, next);
  // 显式清空（BUG-25 死 id 清出索引）→ null
  const cleared = await store.update(rec.id, { claudeSessionId: null });
  assert.equal(cleared?.claudeSessionId, null);
});

// ---------- C. 恶意 id × 每个方法 ----------

test("C1: 未知的恶意 id → 每个方法都拒绝，且零 fs 操作", async () => {
  for (const evil of EVIL_IDS) {
    const { store, fs } = makeStore();
    await store.init();
    fs.ops.length = 0; // init 的 mkdir 不算
    assert.equal(store.get(evil), null, `get(${evil})`);
    assert.equal(await store.rename(evil, "新名"), null, `rename(${evil})`);
    assert.equal(await store.update(evil, { title: "x" }), null, `update`);
    assert.equal(await store.remove(evil), false, `remove(${evil})`);
    assert.equal(await store.appendTurn(evil, "q", "a"), 0, `appendTurn`);
    assert.deepEqual(await store.readHistory(evil), [], `readHistory`);
    assert.deepEqual(
      fs.ops,
      [],
      `id=${JSON.stringify(evil)} 触碰了 fs：${fs.ops.join(" | ")}`,
    );
    assert.equal(store.list().length, 0);
  }
});

test("C2: 恶意 id 已在索引里（手改索引）→ 记录可清，但绝不产生越界路径", async () => {
  // 空 id 的记录在载入时就被丢了（normalizeSessionRecord），不是本用例的对象
  for (const evil of EVIL_IDS.filter((id) => id !== "")) {
    const { store, fs } = makeProbeStore({
      [INDEX]: JSON.stringify({ version: 1, sessions: [evilRecord(evil)] }),
    });
    await store.init();
    assert.equal(await store.appendTurn(evil, "q", "a"), 0);
    assert.deepEqual(await store.readHistory(evil), []);
    fs.ops.length = 0;
    await store.remove(evil);
    assert.equal(
      allOpsInsideDataDir(fs),
      true,
      `id=${JSON.stringify(evil)} 越界：${fs.ops.join(" | ")}`,
    );
    assert.equal(store.get(evil), null);
    assert.deepEqual(onDiskIndex(fs).sessions, []);
  }
});

test("C3: 正向对照——合法 id 的 remove/appendTurn/readHistory 照常工作", async () => {
  const { store } = makeStore();
  const rec = await store.create({ title: "正常" });
  assert.equal(await store.appendTurn(rec.id, "问", "答"), 2);
  assert.equal((await store.readHistory(rec.id)).length, 2);
  assert.equal(await store.remove(rec.id), true);
  assert.deepEqual(await store.readHistory(rec.id), []);
});
