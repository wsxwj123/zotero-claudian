// 测试辅助：内存文件系统 + 组装被测 sessionStore（放 helpers/ 子目录，避免被
// `tests/unit/*.ts` 的 shell glob 当测试文件收走）。
import {
  createSessionStore,
  type SessionStore,
  type SessionStoreDeps,
  type SessionStoreFs,
} from "../../../src/utils/sessionStore.ts";

export interface MemoryFs extends SessionStoreFs {
  files: Map<string, string>;
  /** 写入顺序留痕（串行性/读改写正确性断言用） */
  ops: string[];
}

export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: string[] = [];
  return {
    files,
    ops,
    async readText(path) {
      ops.push(`read ${path}`);
      return files.has(path) ? (files.get(path) as string) : null;
    },
    async writeText(path, data) {
      ops.push(`write ${path}`);
      files.set(path, data);
    },
    async appendText(path, data) {
      ops.push(`append ${path}`);
      files.set(path, (files.get(path) ?? "") + data);
    },
    async move(from, to) {
      ops.push(`move ${from} -> ${to}`);
      if (!files.has(from)) {
        throw new Error(`move: missing ${from}`);
      }
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    async remove(path) {
      ops.push(`remove ${path}`);
      files.delete(path);
    },
    async makeDir(path) {
      ops.push(`mkdir ${path}`);
    },
    async exists(path) {
      return files.has(path);
    },
  };
}

export const DATA_DIR = "/data/claudian";

/** 组装被测 store：initial 为预置文件（模拟既有索引/历史文件） */
export function makeStore(
  initial: Record<string, string> = {},
  overrides: Omit<Partial<SessionStoreDeps>, "fs"> = {},
): { store: SessionStore; fs: MemoryFs; logs: string[] } {
  const fs = createMemoryFs(initial);
  const logs: string[] = [];
  let tick = 1_700_000_000_000;
  const store = createSessionStore({
    dataDir: DATA_DIR,
    platform: "darwin",
    log: (m) => logs.push(m),
    now: () => tick++,
    defaultPermissionMode: () => "acceptEdits",
    ...overrides,
    fs,
  });
  return { store, fs, logs };
}
