// m5-retest —— 重测轮（独立回归验证）自带的假件与集成夹具。
// 独立性原则：本目录的假 fs / 假进程 / 桥+UI 集成夹具全部自写，
// 不复用 tests/unit/helpers/*（probeFs/memoryFs 由被测方在修复中改过，
// 复用会把「假件的口径」也交给被测方，削弱回归证据的可信度）。
import { createSessionStore } from "../../../src/utils/sessionStore.ts";
import { createHostBridge } from "../../../src/modules/hostBridge.ts";
import type {
  SessionStore,
  SessionStoreFs,
} from "../../../src/utils/sessionStore.ts";
import type { HostBridgeDeps } from "../../../src/modules/hostBridge.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
} from "../../../src/modules/cliRunner.ts";
import {
  initialChatState,
  reduceHostMessage,
  userSend,
  selectSession,
  beginCreateSession,
  deleteSession,
  interrupt,
} from "../../../src/chat/lib/chatModel.ts";
import type { UiMessage } from "../../../src/chat/lib/types.ts";
import type { ChatState } from "../../../src/chat/lib/chatModel.ts";

// ---------- 假 fs（内存、可注入失败、可统计并发与整份写） ----------

export type FailWhen = (op: string, path: string) => boolean;

export class FakeFs implements SessionStoreFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  /** "op path" 顺序记录（断言「没写过某路径」用） */
  ops: string[] = [];
  failWhen: FailWhen | null = null;
  delayMs = 0;
  /** 写类操作（write/append/move/remove）并发峰值——单一 writer 队列必须压到 1 */
  maxWriteConcurrent = 0;
  /** 对 *.jsonl 的整份写调用（真追加修复后必须恒为空） */
  jsonlRewrites: string[] = [];
  private writeInFlight = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.files.set(k, v);
    }
  }

  private async run<T>(
    op: string,
    path: string,
    isWrite: boolean,
    fn: () => T,
  ): Promise<T> {
    this.ops.push(`${op} ${path}`);
    if (this.failWhen?.(op, path)) {
      throw new Error(`injected ${op} failure: ${path}`);
    }
    if (!isWrite) {
      return fn();
    }
    this.writeInFlight += 1;
    this.maxWriteConcurrent = Math.max(
      this.maxWriteConcurrent,
      this.writeInFlight,
    );
    try {
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
      return fn();
    } finally {
      this.writeInFlight -= 1;
    }
  }

  readText(path: string): Promise<string | null> {
    return this.run("read", path, false, () => this.files.get(path) ?? null);
  }

  writeText(path: string, data: string): Promise<void> {
    return this.run("write", path, true, () => {
      if (path.endsWith(".jsonl")) {
        this.jsonlRewrites.push(path);
      }
      this.files.set(path, data);
    });
  }

  appendText(path: string, data: string): Promise<void> {
    // IOUtils mode=appendOrCreate 语义：不存在则创建，既有内容原样保留
    return this.run("append", path, true, () => {
      this.files.set(path, (this.files.get(path) ?? "") + data);
    });
  }

  move(from: string, to: string): Promise<void> {
    return this.run("move", from, true, () => {
      const v = this.files.get(from);
      if (v === undefined) {
        throw new Error(`move: source missing: ${from}`);
      }
      this.files.set(to, v);
      this.files.delete(from);
    });
  }

  remove(path: string): Promise<void> {
    return this.run("remove", path, true, () => {
      this.files.delete(path);
    });
  }

  makeDir(path: string): Promise<void> {
    return this.run("mkdir", path, false, () => {
      this.dirs.add(path);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.run("exists", path, false, () => this.files.has(path));
  }
}

export const DATA_DIR = "/tmp/retest-profile/claudian";
export const INDEX = `${DATA_DIR}/sessions.json`;
export const HISTORY_DIR = `${DATA_DIR}/history`;
export const historyPath = (id: string): string => `${HISTORY_DIR}/${id}.jsonl`;

export interface StoreHarness {
  store: SessionStore;
  fs: FakeFs;
  logs: string[];
}

export function makeStore(
  initial: Record<string, string> = {},
  opts: { delayMs?: number; now?: () => number } = {},
): StoreHarness {
  const fs = new FakeFs(initial);
  if (opts.delayMs !== undefined) {
    fs.delayMs = opts.delayMs;
  }
  const logs: string[] = [];
  let clock = 1_000;
  const now = opts.now ?? (() => clock++);
  const store = createSessionStore({
    dataDir: DATA_DIR,
    platform: "darwin",
    fs,
    log: (m) => logs.push(m),
    now,
    defaultPermissionMode: () => "acceptEdits",
  });
  return { store, fs, logs };
}

/**
 * 宿主侧单调时钟：真机里 store.now 与桥 now 都是 Date.now，量级一致；
 * 假件里必须共用同一个源，否则「新建的会话 updatedAt 反而更小」会让会话排序失真。
 */
export function makeClock(): () => number {
  let t = Date.now();
  return () => t++;
}

// ---------- 假 turn（真进程由测试显式驱动事件/退出） ----------

export class FakeTurn {
  killed = false;
  released = false;
  private resolveExit!: () => void;
  readonly exitPromise: Promise<void>;

  constructor(readonly options: SpawnTurnOptions) {
    this.exitPromise = new Promise<void>((r) => {
      this.resolveExit = r;
    });
  }

  kill(): void {
    this.killed = true;
  }

  releaseExit(): void {
    this.released = true;
    this.resolveExit();
  }

  emit(event: TurnEvent): void {
    this.options.onEvent(event);
  }

  args(): string[] {
    return this.options.args;
  }
}

/** 让宿主/存储的异步链路跑完（微任务 + 若干轮宏任务） */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------- 桥 + UI 集成夹具（复刻 src/chat/main.ts 的绑定变化 → getHistory） ----------

export interface M5Harness extends StoreHarness {
  bridge: ReturnType<typeof createHostBridge>;
  win: object;
  turns: FakeTurn[];
  posted: { type: string; [k: string]: unknown }[];
  uiState(): ChatState;
  settle(rounds?: number): Promise<void>;
  /** 复刻 main.ts 的桥→UI 归约（含绑定变化拉历史） */
  feed(msg: unknown): void;
  // UI 动作（走 chatModel → 桥）
  sendText(text: string): void;
  selectSession(id: string): void;
  createSession(): void;
  deleteSession(id: string): void;
  interrupt(): void;
}

export function makeHarness(
  initialFiles: Record<string, string> = {},
  opts: { lookupThrows?: boolean } = {},
): M5Harness {
  const clock = makeClock();
  const base = makeStore(initialFiles, { now: clock });
  const { store, fs, logs } = base;
  const turns: FakeTurn[] = [];
  const posted: { type: string; [k: string]: unknown }[] = [];
  const win = {};
  const ui: { state: ChatState; feed: (msg: unknown) => void } = {
    state: initialChatState(),
    feed: (_msg: unknown): void => {},
  };

  const env: HostBridgeDeps = {
    post: (_win, msg) => {
      posted.push(msg as { type: string; [k: string]: unknown });
      ui.feed(msg);
    },
    createChannel: () => null,
    log: (m) => logs.push(m),
    now: clock,
    launchURL: () => {},
    buildTurnPrompt: async (text) => ({
      itemKey: null,
      attachmentKey: null,
      prompt: text,
      addDir: null,
    }),
    ensureWorkspace: async () => "/tmp/retest-ws",
    getSpawnBase: async () => ({
      command: "/usr/local/bin/claude",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 45678, token: "tok-mcp" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options) => {
      const t = new FakeTurn(options);
      turns.push(t);
      return t;
    },
    buildReaderContext: async () => null,
    sessions: store,
    lookupItem: async (key) => {
      if (opts.lookupThrows) {
        throw new Error("lookup boom");
      }
      return key === "ITEM1" ? { libraryID: 1, title: "条目标题" } : null;
    },
    helloTimeoutMs: 100,
  };

  const bridge = createHostBridge(env);

  const dispatch = (msg: UiMessage): void => {
    bridge.dispatch({ source: win, data: msg });
  };

  ui.feed = (msg: unknown): void => {
    const prev = ui.state;
    ui.state = reduceHostMessage(prev, msg as never);
    // main.ts 唯一 getHistory 发起点：绑定变化才拉
    if (ui.state.sessionId && ui.state.sessionId !== prev.sessionId) {
      dispatch({ type: "getHistory", sessionId: ui.state.sessionId });
    }
  };

  bridge.beginHandshake(win, "retest-token");
  bridge.dispatch({
    source: win,
    data: { type: "hello", token: "retest-token" },
  });

  return {
    store,
    fs,
    logs,
    bridge,
    win,
    turns,
    posted,
    uiState: () => ui.state,
    feed: (msg) => ui.feed(msg),
    settle: (rounds = 8) => settle(rounds),
    sendText: (text) => {
      const r = userSend(ui.state, text);
      ui.state = r.state;
      if (r.msg) {
        dispatch(r.msg);
      }
    },
    selectSession: (id) => {
      const r = selectSession(ui.state, id);
      ui.state = r.state;
      dispatch(r.msg);
    },
    createSession: () => {
      const r = beginCreateSession(ui.state);
      ui.state = r.state;
      dispatch(r.msg);
    },
    deleteSession: (id) => {
      dispatch(deleteSession(id));
    },
    interrupt: () => {
      const r = interrupt(ui.state);
      if (r.msg) {
        ui.state = r.state;
        dispatch(r.msg);
      }
    },
  };
}
