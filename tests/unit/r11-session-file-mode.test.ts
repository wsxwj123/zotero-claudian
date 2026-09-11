// R11 安全复查：会话索引/历史按 0600 写（同机其他用户不可读）
// 契约：SESSION_FILE_MODE = 0o600；索引原子写与历史追加都必须把该 mode 交给 fs。
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore, SESSION_FILE_MODE } from "../../src/utils/sessionStore.ts";

interface Call {
  op: "writeText" | "appendText";
  path: string;
  mode?: number;
}

/** 最小假 fs：记录 writeText/appendText 的 mode 参数 */
function makeFs() {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  return {
    calls,
    files,
    fs: {
      async readText(path: string) {
        return files.has(path) ? files.get(path)! : null;
      },
      async writeText(path: string, data: string, opts?: { mode?: number }) {
        calls.push({ op: "writeText", path, mode: opts?.mode });
        files.set(path, data);
      },
      async appendText(path: string, data: string, opts?: { mode?: number }) {
        calls.push({ op: "appendText", path, mode: opts?.mode });
        files.set(path, (files.get(path) ?? "") + data);
      },
      async move(from: string, to: string) {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
      async remove(path: string) {
        files.delete(path);
      },
      async exists(path: string) {
        return files.has(path);
      },
      async listNames() {
        return [] as string[];
      },
      async makeDir() {},
      join: (dir: string, name: string) => `${dir}/${name}`,
    },
  };
}

function makeStore() {
  const { calls, fs } = makeFs();
  const store = createSessionStore({
    dataDir: "/data",
    platform: "darwin",
    fs: fs as never,
    now: () => 1_700_000_000_000,
    uuid: () => "sess-test-0001",
    defaultPermissionMode: () => "acceptEdits",
    log: () => {},
  });
  return { store, calls };
}

test("R11 文件权限：SESSION_FILE_MODE 常量是 0o600", () => {
  assert.equal(SESSION_FILE_MODE, 0o600);
});

test("R11 文件权限：索引写盘带 0600", async () => {
  const { store, calls } = makeStore();
  await store.init();
  await store.create({ title: "t", itemKey: null });
  await store.flush();
  const indexWrites = calls.filter((c) => c.op === "writeText" && c.path.endsWith("sessions.json.tmp"));
  assert.ok(indexWrites.length > 0, "应至少有一次索引写盘");
  for (const c of indexWrites) {
    assert.equal(c.mode, SESSION_FILE_MODE, `索引写盘未带 0600：${JSON.stringify(c)}`);
  }
});

test("R11 文件权限：历史追加带 0600", async () => {
  const { store, calls } = makeStore();
  await store.init();
  const rec = await store.create({ title: "t", itemKey: null });
  await store.appendTurn(rec.id, [
    { role: "user", text: "hi", at: 1 },
    { role: "assistant", text: "ok", at: 2 },
  ]);
  const histAppends = calls.filter((c) => c.op === "appendText" && c.path.endsWith(".jsonl"));
  assert.ok(histAppends.length > 0, "应至少有一次历史追加");
  for (const c of histAppends) {
    assert.equal(c.mode, SESSION_FILE_MODE, `历史追加未带 0600：${JSON.stringify(c)}`);
  }
});
