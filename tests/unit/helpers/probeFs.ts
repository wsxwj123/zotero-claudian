// M5 会话管理测试专用注入式 fs（原 m5-probe 探针的注入面，转正进 tests/unit）。
// 记录操作序列、统计写类操作并发峰值、按操作注入失败与延迟。
// 独立于 tests/unit/helpers/memoryFs.ts（那份只服务于既有用例，无法注入磁盘满/move 失败）。
import {
  createSessionStore,
  type SessionStore,
  type SessionStoreDeps,
} from "../../../src/utils/sessionStore.ts";
import type { PermissionMode } from "../../../src/modules/cliRunner.ts";

export const DATA_DIR = "/data/claudian";

/** 写类操作（交错会损坏数据的那些）：断言并发峰值必须为 1 */
const WRITE_OPS = new Set(["write", "append", "move", "remove", "mkdir"]);

export interface ProbeFs {
  files: Map<string, string>;
  ops: string[];
  failures: string[];
  /** 写类操作同时在跑的峰值；>1 = 单一 writer 队列被绕过 */
  maxWriteConcurrent: number;
  /** 全部操作（含 read）同时在跑的峰值 */
  maxAnyConcurrent: number;
  /** 返回 true 时该次 fs 调用抛错（模拟磁盘满 / move 失败） */
  failWhen: ((op: string, path: string) => boolean) | null;
  /** 每个操作内部等待毫秒数，放大交错窗口 */
  delayMs: number;
  readText(path: string): Promise<string | null>;
  writeText(path: string, data: string): Promise<void>;
  appendText(path: string, data: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export function makeProbeFs(initial: Record<string, string> = {}): ProbeFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: string[] = [];
  const failures: string[] = [];
  let writeInFlight = 0;
  let anyInFlight = 0;

  const fs: ProbeFs = {
    files,
    ops,
    failures,
    maxWriteConcurrent: 0,
    maxAnyConcurrent: 0,
    failWhen: null,
    delayMs: 0,

    async readText(path) {
      return run("read", path, () =>
        files.has(path) ? (files.get(path) as string) : null,
      );
    },
    async writeText(path, data) {
      await run("write", path, () => {
        files.set(path, data);
      });
    },
    async appendText(path, data) {
      await run("append", path, () => {
        files.set(path, (files.get(path) ?? "") + data);
      });
    },
    async move(from, to) {
      await run("move", from, () => {
        if (!files.has(from)) {
          throw new Error(`move: missing ${from}`);
        }
        files.set(to, files.get(from) as string);
        files.delete(from);
      });
    },
    async remove(path) {
      await run("remove", path, () => {
        files.delete(path);
      });
    },
    async makeDir(path) {
      await run("mkdir", path, () => undefined);
    },
    async exists(path) {
      return run("exists", path, () => files.has(path));
    },
  };

  async function run<T>(op: string, path: string, fn: () => T): Promise<T> {
    ops.push(`${op} ${path}`);
    if (fs.failWhen?.(op, path)) {
      failures.push(`${op} ${path}`);
      throw new Error(`injected ${op} failure: ${path}`);
    }
    anyInFlight++;
    fs.maxAnyConcurrent = Math.max(fs.maxAnyConcurrent, anyInFlight);
    if (WRITE_OPS.has(op)) {
      writeInFlight++;
      fs.maxWriteConcurrent = Math.max(fs.maxWriteConcurrent, writeInFlight);
    }
    try {
      if (fs.delayMs > 0) {
        await new Promise((r) => setTimeout(r, fs.delayMs));
      }
      return fn();
    } finally {
      anyInFlight--;
      if (WRITE_OPS.has(op)) {
        writeInFlight--;
      }
    }
  }

  return fs;
}

export function makeProbeStore(
  initial: Record<string, string> = {},
  overrides: Omit<Partial<SessionStoreDeps>, "fs"> = {},
): { store: SessionStore; fs: ProbeFs; logs: string[] } {
  const fs = makeProbeFs(initial);
  const logs: string[] = [];
  let tick = 1_700_000_000_000;
  const store = createSessionStore({
    dataDir: DATA_DIR,
    platform: "darwin",
    log: (m) => logs.push(m),
    now: () => tick++,
    defaultPermissionMode: (): PermissionMode => "acceptEdits",
    ...overrides,
    fs,
  });
  return { store, fs, logs };
}

export const INDEX = `${DATA_DIR}/sessions.json`;
export const HISTORY = (id: string): string =>
  `${DATA_DIR}/history/${id}.jsonl`;

/** 全部 fs 操作路径都在数据目录内（路径逃逸的反向断言） */
export function allOpsInsideDataDir(fs: ProbeFs): boolean {
  return fs.ops.every((o) =>
    o.split(" ").slice(1).join(" ").startsWith(DATA_DIR),
  );
}

export function onDiskIndex(fs: ProbeFs): {
  version: number;
  sessions: { id: string; title: string }[];
} {
  return JSON.parse(fs.files.get(INDEX) as string) as {
    version: number;
    sessions: { id: string; title: string }[];
  };
}
