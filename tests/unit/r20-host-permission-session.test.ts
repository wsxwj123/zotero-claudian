// 单测 — R20 宿主侧：卡广播带会话号（§2.1）、会话列表待审批位（§2.4 / r2-2）、
//        切回补推（§5 / r2-4）、三路结算不回归（§6 / r2-5）。
//
// 契约来源：.devflow/INTERFACE-R20.md。黑盒：只用 hostBridge 的公开句柄
// （beginHandshake / dispatch / requestPermission / permissionSettled）驱动，依赖面全假。
// 「端点结算 → bridge.permissionSettled(requestId)」这条线是宿主 app 的接线（sections.ts），
// 本文件由测试扮演端点来触发，属夹具而非被测对象。
//
// 本文件红/绿计数（改动时同步更新）：🔴 修前必红 = 10 条；🔒 修前就绿 = 7 条。合计 17 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
  TurnHandle,
} from "../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import { createPermissionCore } from "../../src/modules/permissionMcp.ts";
import type { ParsedHttpRequest } from "../../src/modules/permissionMcp.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const TOKEN = "tok-r20";
const MCP_TOKEN = "mcp-token-r20";

async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

class FakeTurn implements TurnHandle {
  killed = false;
  private resolveExit!: () => void;
  readonly exitPromise: Promise<void> = new Promise<void>((r) => {
    this.resolveExit = r;
  });
  constructor(readonly options: SpawnTurnOptions) {}
  kill(): void {
    this.killed = true;
  }
  release(): void {
    this.resolveExit();
  }
  emit(event: TurnEvent): void {
    this.options.onEvent(event);
  }
}

function makeFixture(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeStore();
  const turns: FakeTurn[] = [];
  const closedTokens: string[] = [];
  const resolves: { requestId: string; allow: boolean }[] = [];
  const deps: HostBridgeDeps = {
    post: (win: object, msg: HostMessage) => sent.push({ win, msg }),
    createChannel: () => null,
    log: (m: string) => memory.logs.push(m),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: null,
      attachmentKey: null,
      prompt: text,
      addDir: null,
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 51234, token: MCP_TOKEN }),
    closeMcpTurn: (token: string) => closedTokens.push(token),
    resolvePermission: (requestId: string, allow: boolean) => {
      resolves.push({ requestId, allow });
      return null;
    },
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: SpawnTurnOptions): TurnHandle => {
      const turn = new FakeTurn(options);
      turns.push(turn);
      return turn;
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) => ({
      libraryID: 1,
      title: `文献-${itemKey}`,
    }),
    helloTimeoutMs: 1000,
    ...overrides,
  } as HostBridgeDeps;
  const bridge = createHostBridge(deps);
  const fx = {
    bridge,
    deps,
    sent,
    turns,
    closedTokens,
    resolves,
    store: memory.store,
    logs: memory.logs,
    register(win: object): void {
      bridge.beginHandshake(win, TOKEN);
      bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
    },
    sentTo(win: object, type: HostMessage["type"]): HostMessage[] {
      return sent
        .filter((s) => s.win === win && s.msg.type === type)
        .map((s) => s.msg);
    },
    all(type: HostMessage["type"]): { win: object; msg: HostMessage }[] {
      return sent.filter((s) => s.msg.type === type);
    },
  };
  return fx;
}

type Fx = ReturnType<typeof makeFixture>;

/** 发一句话开一轮，返回该轮的会话 id */
async function openTurnFor(
  fx: Fx,
  win: object,
  text = "你好",
): Promise<string> {
  const before = new Set(fx.store.list().map((s) => s.id));
  fx.bridge.dispatch({ source: win, data: { type: "send", text } });
  await tick();
  const created = fx.store.list().find((s) => !before.has(s.id));
  assert.ok(created, "夹具自检：这一轮应该建出一条新会话");
  return created.id;
}

async function createSession(
  fx: Fx,
  win: object,
  itemKey: string,
): Promise<string> {
  const before = new Set(fx.store.list().map((s) => s.id));
  fx.bridge.dispatch({ source: win, data: { type: "createSession", itemKey } });
  await tick();
  const created = fx.store.list().find((s) => !before.has(s.id));
  assert.ok(created, `夹具自检：itemKey=${itemKey} 的会话应已建出`);
  return created.id;
}

/** 把一张卡推出去（等价端点收到 tools/call 后调 present） */
function pushCard(fx: Fx, sessionId: string, requestId: string): void {
  fx.bridge.requestPermission({
    requestId,
    sessionId,
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
    toolUseId: `call-${requestId}`,
  });
}

/** 最后一条 sessionList 里该会话的 pendingPermission（缺键 ⇒ undefined） */
function flagOf(fx: Fx, win: object, sessionId: string): unknown {
  const list = fx.sentTo(win, "sessionList").at(-1);
  assert.ok(list, "夹具自检：该实例应至少收到过一条 sessionList");
  const rows = (list as unknown as { sessions: { id: string }[] }).sessions;
  const row = rows.find((r) => r.id === sessionId) as
    { pendingPermission?: unknown } | undefined;
  assert.ok(row, `夹具自检：sessionList 里应有会话 ${sessionId}`);
  return row.pendingPermission;
}

const listCount = (fx: Fx, win: object): number =>
  fx.sentTo(win, "sessionList").length;

// ================= §2.1 卡广播带会话号（会话号来自宿主自己的端点↔会话映射）=================

test("🔴 tools/call 推出的卡：广播的 permissionRequest 带 sessionId = 开轮时的会话 id（五字段不多不少）", async () => {
  let bridgeRef: ReturnType<typeof createHostBridge> | null = null;
  const core = createPermissionCore({
    log: () => {},
    present: (req) => bridgeRef?.requestPermission(req),
  });
  const fx = makeFixture({
    getMcpEndpoint: (sessionId: string) => core.openTurn(sessionId, 51999),
    closeMcpTurn: (token: string) => core.closeTurn(token),
    resolvePermission: (requestId: string, allow: boolean) =>
      core.resolve(requestId, allow),
  });
  bridgeRef = fx.bridge;
  const win = {};
  fx.register(win);
  await tick();
  const sessionId = await openTurnFor(fx, win, "帮我看看 python 版本");

  const args = fx.turns[0].options.args;
  const mcpJson = args[args.indexOf("--mcp-config") + 1];
  const url = JSON.parse(mcpJson).mcpServers["claudian-perm"].url as string;
  const token = url.slice(url.indexOf("token=") + "token=".length);

  // CLI 侧 tools/call：请求体里塞一个伪造的 sessionId / session_id，宿主一个字都不许采信
  const req: ParsedHttpRequest = {
    method: "POST",
    path: "/mcp",
    query: { token },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "permission_check",
        arguments: {
          tool_name: "Bash",
          input: { command: "python -V" },
          tool_use_id: "call_1",
          sessionId: "sFAKE-来自CLI回包",
          session_id: "sFAKE-来自CLI回包",
        },
      },
    }),
  };
  const call = core.handle(req);
  await tick();

  const cards = fx.all("permissionRequest");
  assert.equal(cards.length, 1, "恰好广播一张卡");
  const card = cards[0].msg as unknown as Record<string, unknown>;
  assert.equal(
    card.sessionId,
    sessionId,
    "会话号必须来自宿主的端点↔会话映射，不得来自 tools/call 请求体",
  );
  assert.deepEqual(Object.keys(card).sort(), [
    "inputSummary",
    "rawInput",
    "requestId",
    "sessionId",
    "tool",
    "type",
  ]);
  assert.equal(card.tool, "Bash");
  assert.equal(card.inputSummary, "python -V");
  assert.deepEqual(card.rawInput, { command: "python -V" });

  // 收尾：结掉在途请求，别把 120 秒计时器留给测试进程
  fx.turns[0].release();
  await tick();
  await call;
});

test("🔒 permissionSettled → permissionResolved 仍只有 {type,requestId} 两个键（§2.2 不许加会话号）", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  fx.bridge.permissionSettled("req-9");
  const msgs = fx.all("permissionResolved");
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].msg, {
    type: "permissionResolved",
    requestId: "req-9",
  });
});

// ================= §2.4 / r2-2：会话列表的待审批位 =================

test("🔴 卡推出后：宿主刷新会话列表，该会话 pendingPermission === true", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  const before = listCount(fx, win);
  pushCard(fx, sA, "req-1");
  await tick();
  assert.ok(listCount(fx, win) > before, "卡推出后必须刷新一次会话列表");
  assert.equal(flagOf(fx, win, sA), true);
});

test("🔴 卡推出后：只有出卡的那条会话被标记，别的会话不受牵连", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  const sB = await createSession(fx, win, "ITEM_B");
  pushCard(fx, sA, "req-1");
  await tick();
  assert.equal(flagOf(fx, win, sA), true);
  assert.notEqual(flagOf(fx, win, sB), true, "没有在途卡的会话不许被标记");
});

test("🔒 没有任何在途卡时：会话列表里该会话的 pendingPermission 不为 true", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  await tick();
  assert.notEqual(flagOf(fx, win, sA), true);
});

test("🔴 结算路径①作答：permissionResponse 后再刷新一次列表，标记回落 false", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  pushCard(fx, sA, "req-1");
  await tick();
  const afterCard = listCount(fx, win);
  fx.bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-1",
      allow: true,
      remember: false,
    },
  });
  await tick();
  assert.ok(listCount(fx, win) > afterCard, "结算后必须再刷新一次会话列表");
  assert.equal(flagOf(fx, win, sA), false);
});

test("🔴 结算路径②超时：端点按 deny 结掉并通知宿主后，标记回落 false", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  pushCard(fx, sA, "req-1");
  await tick();
  const afterCard = listCount(fx, win);
  // 120s 无人响应：端点 fail-closed 结掉 → 通知宿主（计时与默认值不在本轮改动面内）
  fx.bridge.permissionSettled("req-1");
  await tick();
  assert.ok(listCount(fx, win) > afterCard, "结算后必须再刷新一次会话列表");
  assert.equal(flagOf(fx, win, sA), false);
});

test("🔴 结算路径③该轮进程退出：撤销端点 token 并结掉在途卡后，标记回落 false", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  pushCard(fx, sA, "req-1");
  await tick();
  const afterCard = listCount(fx, win);
  fx.turns[0].release(); // 进程退出 → closeMcpTurn
  await tick();
  assert.deepEqual(fx.closedTokens, [MCP_TOKEN], "夹具自检：该轮 token 已撤销");
  fx.bridge.permissionSettled("req-1"); // 端点结掉在途请求后回头通知宿主
  await tick();
  assert.ok(listCount(fx, win) > afterCard, "结算后必须再刷新一次会话列表");
  assert.equal(flagOf(fx, win, sA), false);
});

test("🔴 同会话两张卡：摘掉一张仍为 true，两张都摘掉才回落 false", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  pushCard(fx, sA, "req-1");
  pushCard(fx, sA, "req-2");
  await tick();
  assert.equal(flagOf(fx, win, sA), true);
  fx.bridge.permissionSettled("req-1");
  await tick();
  assert.equal(
    flagOf(fx, win, sA),
    true,
    "布尔位不是计数：还有一张在途就保持 true",
  );
  fx.bridge.permissionSettled("req-2");
  await tick();
  assert.equal(flagOf(fx, win, sA), false);
});

// ================= §5 / r2-4：切回后的定向补推 =================

/** 该实例收到的 permissionRequest（按到达顺序） */
const cardsTo = (fx: Fx, win: object): Record<string, unknown>[] =>
  fx.sentTo(win, "permissionRequest") as unknown as Record<string, unknown>[];

/** 视图切到某会话：现有唯一发起点就是绑定后的那次历史拉取 */
async function switchTo(fx: Fx, win: object, sessionId: string): Promise<void> {
  const before = fx.sentTo(win, "history").length;
  fx.bridge.dispatch({ source: win, data: { type: "getHistory", sessionId } });
  await tick();
  assert.ok(
    fx.sentTo(win, "history").length > before,
    "夹具自检：getHistory 应当回一条 history（切回的驱动面）",
  );
}

test("🔴 切走再切回：在途卡以同一个 requestId 重新到达该实例，五字段逐字相同", async () => {
  const fx = makeFixture();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await openTurnFor(fx, winA);
  const sB = await createSession(fx, winA, "ITEM_B");
  pushCard(fx, sA, "req-1");
  await tick();
  const first = cardsTo(fx, winA)[0];
  assert.ok(first, "夹具自检：首推的卡已到达");

  await switchTo(fx, winA, sB); // 切到别的文献（视图清空，卡随之消失）
  const beforeBack = cardsTo(fx, winA).length;
  await switchTo(fx, winA, sA); // 切回

  const after = cardsTo(fx, winA);
  assert.equal(after.length, beforeBack + 1, "切回时应补推那张在途卡");
  assert.deepEqual(
    after.at(-1),
    first,
    "补推与首推五字段逐字相同（含同一个 requestId）",
  );
});

test("🔴 补推是定向的：只有发起绑定的实例收到，同时在线的另一实例不收", async () => {
  const fx = makeFixture();
  const winA = {};
  const winB = {};
  fx.register(winA);
  fx.register(winB);
  await tick();
  const sA = await openTurnFor(fx, winA);
  pushCard(fx, sA, "req-1");
  await tick();
  const beforeA = cardsTo(fx, winA).length;
  const beforeB = cardsTo(fx, winB).length;

  await switchTo(fx, winA, sA);

  assert.equal(
    cardsTo(fx, winA).length,
    beforeA + 1,
    "甲发起绑定 ⇒ 甲拿到补推",
  );
  assert.equal(
    cardsTo(fx, winB).length,
    beforeB,
    "乙没发起绑定 ⇒ 不得因别人切回而收到重复卡",
  );
});

test("🔴 同会话多张在途卡：切回时全部补推，次序与首推一致", async () => {
  const fx = makeFixture();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await openTurnFor(fx, winA);
  pushCard(fx, sA, "req-1");
  pushCard(fx, sA, "req-2");
  await tick();
  const beforeBack = cardsTo(fx, winA).length;

  await switchTo(fx, winA, sA);

  const resent = cardsTo(fx, winA).slice(beforeBack);
  assert.deepEqual(
    resent.map((c) => c.requestId),
    ["req-1", "req-2"],
  );
});

test("🔒 已结算的卡不补推：结算后切回该会话，一张卡都不该来", async () => {
  const fx = makeFixture();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await openTurnFor(fx, winA);
  pushCard(fx, sA, "req-1");
  await tick();
  fx.bridge.permissionSettled("req-1");
  await tick();
  const before = cardsTo(fx, winA).length;

  await switchTo(fx, winA, sA);

  assert.equal(cardsTo(fx, winA).length, before, "结算过的卡不得复活");
});

test("🔒 切到别的会话不带出这张卡：getHistory 指向 sB 时不补推 sA 的卡", async () => {
  const fx = makeFixture();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await openTurnFor(fx, winA);
  const sB = await createSession(fx, winA, "ITEM_B");
  pushCard(fx, sA, "req-1");
  await tick();
  const before = cardsTo(fx, winA).length;

  await switchTo(fx, winA, sB);

  assert.equal(
    cardsTo(fx, winA).length,
    before,
    "绑 sB 的视图不得拿到 sA 的卡",
  );
});

test("🔒 hello 不额外补推：新实例握手时不直接收到在途卡", async () => {
  const fx = makeFixture();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await openTurnFor(fx, winA);
  pushCard(fx, sA, "req-1");
  await tick();

  const winC = {};
  fx.register(winC); // 面板重载：hello → sessionList → 自绑 → 拉历史（补推走那条路径）
  await tick();
  assert.deepEqual(cardsTo(fx, winC), [], "握手本身不带卡");
});

// ================= §6 / r2-5 对照组：三路结算与应答形状不回归 =================

test("🔒 permissionResolved 广播给全部实例，含从未绑定过会话的实例", async () => {
  const fx = makeFixture();
  const winA = {};
  const winIdle = {};
  fx.register(winA);
  fx.register(winIdle);
  await tick();
  const sA = await openTurnFor(fx, winA);
  pushCard(fx, sA, "req-1");
  await tick();
  fx.bridge.permissionSettled("req-1");
  await tick();
  assert.equal(fx.sentTo(winA, "permissionResolved").length, 1);
  assert.equal(
    fx.sentTo(winIdle, "permissionResolved").length,
    1,
    "摘卡通知永远全局：未绑定实例也要收，否则留残影",
  );
});

test("🔒 permissionResponse 照旧回写端点（requestId + allow 两个入参不变）", async () => {
  const fx = makeFixture();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await openTurnFor(fx, win);
  pushCard(fx, sA, "req-1");
  await tick();
  fx.bridge.dispatch({
    source: win,
    data: {
      type: "permissionResponse",
      requestId: "req-1",
      allow: false,
      remember: false,
    },
  });
  await tick();
  assert.deepEqual(fx.resolves, [{ requestId: "req-1", allow: false }]);
});

// ---- 文件末尾对账：🔴 10 条 / 🔒 7 条 / 合计 17 条 ----
