// 测试辅助 — R17 黑盒用例的宿主桥驱动面。
//
// 只用 hostBridge 的公开句柄（beginHandshake / dispatch / unregister）驱动，
// 依赖面全部是 fake：可控 lookupItem（按 itemKey 挂起或抛错）、可控
// buildReaderContext（按实例返回不同载荷）、readHistory 计数、可控 turn。
// 放 helpers/ 子目录，避免被 `tests/unit/r17-*.test.ts` 的 glob 当测试文件收走。
import {
  createHostBridge,
  type HostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../../src/modules/hostBridge.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
  TurnHandle,
} from "../../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../../src/chat/lib/types.ts";
import { makeProbeStore } from "./probeFs.ts";

export const TOKEN = "tok-r17";

/** 让挂起的 promise / 微任务链跑完（不用真实定时器等待） */
export async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

export interface FakeTurn {
  options: SpawnTurnOptions | null;
  killed: boolean;
  emit(ev: TurnEvent): void;
  releaseExit(): void;
}

export interface SentMsg {
  win: object;
  msg: HostMessage;
}

type Store = ReturnType<typeof makeProbeStore>["store"];

export interface BridgeFixture {
  bridge: HostBridge;
  deps: HostBridgeDeps;
  /** 宿主投递出去的全部消息（按到达顺序） */
  sent: SentMsg[];
  /** 未被计数代理包住的 store：测试自己读历史不会污染 reads() */
  store: Store;
  turns: FakeTurn[];
  /** deps.sessions.readHistory 的累计调用次数 */
  reads(): number;
  /** lookupItem 命中这些 itemKey 时挂起，直到 releaseHung() */
  hang: Set<string>;
  /** lookupItem 命中这些 itemKey 时抛错 */
  failItem: Set<string>;
  /** 该 sessionId 的快照/历史类取数一律抛错（模拟单条记录取数失败） */
  failSession: Set<string>;
  /** 放行全部挂起的 lookupItem，返回放行条数 */
  releaseHung(): number;
  /** 每实例 readerContext 载荷；默认 null（= 不推） */
  readerContext(win: object | undefined): Promise<HostMessage | null>;
  /** post 抛错的实例（模拟窗口已死） */
  deadWindows: Set<object>;
  register(win: object): void;
  sentTo(win: object, type?: HostMessage["type"]): HostMessage[];
}

export function makeBridge(): BridgeFixture {
  const sent: SentMsg[] = [];
  const turns: FakeTurn[] = [];
  const memory = makeProbeStore();
  const hang = new Set<string>();
  const failItem = new Set<string>();
  const failSession = new Set<string>();
  const deadWindows = new Set<object>();
  const pending: (() => void)[] = [];
  let reads = 0;

  const sessions = new Proxy(
    memory.store as unknown as Record<string, unknown>,
    {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const name = String(prop);
        const call = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (name === "readHistory") {
            reads++;
          }
          if (
            /snapshot|history/i.test(name) &&
            typeof args[0] === "string" &&
            failSession.has(args[0])
          ) {
            throw new Error(`injected snapshot read failure: ${args[0]}`);
          }
          return call.apply(target, args);
        };
      },
    },
  ) as unknown as HostBridgeDeps["sessions"];

  const fixture = {
    sent,
    store: memory.store,
    turns,
    hang,
    failItem,
    failSession,
    deadWindows,
    reads: () => reads,
    releaseHung(): number {
      const n = pending.length;
      for (const release of pending.splice(0)) {
        release();
      }
      return n;
    },
    async readerContext(): Promise<HostMessage | null> {
      return null;
    },
  } as BridgeFixture;

  const deps: HostBridgeDeps = {
    post: (win, msg) => {
      if (deadWindows.has(win)) {
        throw new Error("post: window is gone");
      }
      sent.push({ win, msg });
    },
    createChannel: () => null,
    log: () => {},
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: `ctx\n${text}`,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 51000, token: "t" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: SpawnTurnOptions): TurnHandle => {
      let releaseExit: () => void = () => {};
      const turn: FakeTurn = {
        options,
        killed: false,
        emit: (ev: TurnEvent) => options.onEvent(ev),
        releaseExit: () => releaseExit(),
      };
      turns.push(turn);
      return {
        kill: () => {
          turn.killed = true;
        },
        exitPromise: new Promise<void>((r) => {
          releaseExit = () => r();
        }),
      };
    },
    buildReaderContext: ((win?: object) =>
      fixture.readerContext(win)) as HostBridgeDeps["buildReaderContext"],
    sessions,
    lookupItem: (async (itemKey: string) => {
      if (hang.has(itemKey)) {
        await new Promise<void>((r) => pending.push(r));
      }
      if (failItem.has(itemKey)) {
        throw new Error(`injected lookupItem failure: ${itemKey}`);
      }
      return { libraryID: 1, title: `文献-${itemKey}` };
    }) as HostBridgeDeps["lookupItem"],
  } as HostBridgeDeps;

  fixture.deps = deps;
  fixture.bridge = createHostBridge(deps);
  fixture.register = (win: object) => {
    fixture.bridge.beginHandshake(win, TOKEN);
    fixture.bridge.dispatch({
      source: win,
      data: { type: "hello", token: TOKEN },
    });
  };
  fixture.sentTo = (win: object, type?: HostMessage["type"]) =>
    sent
      .filter(
        (s) => s.win === win && (type === undefined || s.msg.type === type),
      )
      .map((s) => s.msg);
  return fixture;
}

/** sessionList 消息里的会话 id 列表（顺序无关，排序后比较） */
export function idsOf(msg: HostMessage | undefined): string[] {
  const list = (msg as unknown as { sessions?: { id: string }[] } | undefined)
    ?.sessions;
  return (list ?? []).map((s) => s.id).sort();
}

/** history 消息的 inFlight 字段（R14 起可选） */
export function inFlightOf(
  msg: HostMessage | undefined,
): Record<string, unknown> | undefined {
  return (msg as unknown as { inFlight?: Record<string, unknown> } | undefined)
    ?.inFlight;
}

/** history 消息的落盘行 */
export function rowsOf(msg: HostMessage | undefined): unknown[] {
  return (
    (msg as unknown as { messages?: unknown[] } | undefined)?.messages ?? []
  );
}
