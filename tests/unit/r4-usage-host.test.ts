// 单测 — R4-3 自补：宿主侧用量聚合与广播（PLAN-R4 §4）。
// 锁三件事：①result.usage 与 assistantMessage.usage 不重复计入（整轮汇总优先）
// ②累计随会话索引入口落盘、sessionList 带上（UI 换会话/重启即可显示）
// ③余额/用量开关的推送时机（hello 推一次、refreshBalance 强制重查）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type { SessionStore } from "../../src/utils/sessionStore.ts";
import type {
  SpawnTurnOptions,
  TurnEvent,
  TurnHandle,
} from "../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { UsageStats } from "../../src/chat/lib/usage.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const TOKEN = "tok-r4";

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

function makeTurn() {
  const turn = {
    options: null as SpawnTurnOptions | null,
    emit: (ev: TurnEvent) => turn.options?.onEvent(ev),
    kill: () => {},
    exitPromise: Promise.resolve(),
  };
  return turn;
}

function makeDeps(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeStore();
  const turns: ReturnType<typeof makeTurn>[] = [];
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    store: SessionStore;
    fs: typeof memory.fs;
    logs: string[];
    turns: ReturnType<typeof makeTurn>[];
  } = {
    sent,
    store: memory.store,
    fs: memory.fs,
    logs: memory.logs,
    turns,
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: (m) => memory.logs.push(m),
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
      const t = makeTurn();
      t.options = options;
      turns.push(t);
      return { kill: () => t.kill(), exitPromise: t.exitPromise };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async () => ({ libraryID: 1, title: "论文一" }),
    ...overrides,
  };
  return deps;
}

function msgs(
  deps: ReturnType<typeof makeDeps>,
  type: HostMessage["type"],
): HostMessage[] {
  return deps.sent.filter((s) => s.msg.type === type).map((s) => s.msg);
}

async function startTurn(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text: string,
): Promise<string> {
  bridge.dispatch({ source: win, data: { type: "send", text } });
  await tick();
  return deps.store.list()[0]?.id ?? "";
}

/** 便捷用量构造 */
const u = (p: Partial<UsageStats> = {}): UsageStats => ({
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  ...p,
});

test("R4-3 host: result.usage → 广播 usageStats{turn,total} + 索引落盘 + sessionList 带上", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  const id = await startTurn(deps, bridge, win, "问题");
  const turn = deps.turns[0];
  const usage = u({ input: 697, cacheRead: 119040, output: 340 });
  turn.emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0.02,
    durationMs: 4200,
    numTurns: 1,
    usage,
  });
  await tick();

  const stats = msgs(deps, "usageStats").pop();
  assert.ok(stats && stats.type === "usageStats");
  assert.equal(stats.sessionId, id);
  assert.deepEqual(stats.turn, usage);
  assert.deepEqual(stats.total, usage);
  // 落盘（会话索引）
  assert.deepEqual(deps.store.get(id)?.usage, usage);
  // 列表：UI 换会话/重启后据此显示累计
  const list = msgs(deps, "sessionList").pop();
  const entry = list && list.type === "sessionList" ? list.sessions[0] : null;
  assert.deepEqual(entry?.usage, usage);
});

test("R4-3 host: 多步 turn 同时来 assistantMessage.usage 与 result.usage → 只计 result（不重复）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  const id = await startTurn(deps, bridge, win, "问题");
  const turn = deps.turns[0];
  // 两步各自的 assistant 用量（单次调用粒度）
  turn.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "第一步" }],
    usage: u({ input: 100, cacheRead: 5000, output: 30 }),
  });
  turn.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "第二步" }],
    usage: u({ input: 200, cacheRead: 9000, output: 40 }),
  });
  // result 的整轮汇总（已含上面两次调用）
  const whole = u({
    input: 300,
    cacheRead: 14000,
    cacheCreation: 7,
    output: 70,
  });
  turn.emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0.01,
    durationMs: 1000,
    numTurns: 2,
    usage: whole,
  });
  await tick();

  const stats = msgs(deps, "usageStats").pop();
  assert.ok(stats && stats.type === "usageStats");
  assert.deepEqual(stats.turn, whole, "assistant 用量被重复计入了");
  assert.deepEqual(stats.total, whole);
  assert.deepEqual(deps.store.get(id)?.usage, whole);
});

test("R4-3 host: result 无 usage → 回落本轮 assistant 累加；两者皆无 → 不广播", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  // 第一轮：只有 assistant 用量（老 CLI / provider 不报 result 用量）
  const id = await startTurn(deps, bridge, win, "一");
  const t1 = deps.turns[0];
  t1.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "答" }],
    usage: u({ input: 10, cacheRead: 90, output: 5 }),
  });
  t1.emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  const first = msgs(deps, "usageStats").pop();
  assert.ok(first && first.type === "usageStats");
  assert.deepEqual(first.turn, u({ input: 10, cacheRead: 90, output: 5 }));

  // 第二轮：完全没有用量数据 → 不广播（UI 保留上一轮显示，不被 0 覆盖）
  const before = msgs(deps, "usageStats").length;
  await startTurn(deps, bridge, win, "二", id);
  const t2 = deps.turns[1];
  t2.emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  assert.equal(
    msgs(deps, "usageStats").length,
    before,
    "无用量的轮也广播了 usageStats",
  );
  // 索引里的累计保持第一轮的值（没被清零）
  assert.deepEqual(
    deps.store.get(id)?.usage,
    u({ input: 10, cacheRead: 90, output: 5 }),
  );
});

test("R4-3 host: 两轮 result.usage → total 累加（turn 是当轮值）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  const id = await startTurn(deps, bridge, win, "一");
  const a = u({ input: 100, cacheRead: 1000, cacheCreation: 10, output: 50 });
  deps.turns[0].emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    usage: a,
  });
  await tick();
  await startTurn(deps, bridge, win, "二", id);
  const b = u({ input: 7, cacheRead: 2, output: 3 });
  deps.turns[1].emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    usage: b,
  });
  await tick();

  const stats = msgs(deps, "usageStats");
  const last = stats[stats.length - 1];
  assert.ok(last && last.type === "usageStats");
  assert.deepEqual(last.turn, b);
  assert.deepEqual(
    last.total,
    u({ input: 107, cacheRead: 1002, cacheCreation: 10, output: 53 }),
  );
  assert.deepEqual(deps.store.get(id)?.usage, last.total);
});

// 复查修-4：失败轮（resultError / procError）的现场用量不得漏进下一轮
test("复查修-4: resultError 失败轮 → 本轮累计被清，下一轮 result 不带 usage 时不被并进来", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  const id = await startTurn(deps, bridge, win, "一");
  const t1 = deps.turns[0];
  // 失败轮：assistant 已累加过用量，随后以 resultError 收场（不会再有 result 行）
  t1.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "半截回答" }],
    usage: u({ input: 500, cacheRead: 1000, output: 50 }),
  });
  t1.emit({ kind: "resultError", subtype: "api_error", errors: ["API Error"] });
  await tick();

  // 下一轮：result 不带 usage（老 CLI/provider 不报）→ 不得把上一失败轮的用量算进来
  const before = msgs(deps, "usageStats").length;
  await startTurn(deps, bridge, win, "二", id);
  deps.turns[1].emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  assert.equal(
    msgs(deps, "usageStats").length,
    before,
    "失败轮的残留用量被并进了下一轮（张冠李戴）",
  );
});

test("复查修-4: procError 失败轮 → 同样清掉本轮累计（不漏进下一轮）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  const id = await startTurn(deps, bridge, win, "一");
  const t1 = deps.turns[0];
  t1.emit({
    kind: "assistantMessage",
    content: [{ type: "text", text: "半截回答" }],
    usage: u({ input: 700, cacheRead: 2000, output: 70 }),
  });
  t1.emit({ kind: "procError", exitCode: 0, stderrTail: "" });
  await tick();
  assert.equal(
    msgs(deps, "usageStats").length,
    0,
    "进程错误收场却广播了本轮用量",
  );

  const before = msgs(deps, "usageStats").length;
  await startTurn(deps, bridge, win, "二", id);
  deps.turns[1].emit({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  assert.equal(
    msgs(deps, "usageStats").length,
    before,
    "失败轮的残留用量被并进了下一轮（张冠李戴）",
  );
});

test("R4-3 host: hello 推 uiPrefs + balanceStatus；refreshBalance → force 重查", async () => {
  const calls: boolean[] = [];
  const deps = makeDeps({
    balance: {
      get: async (force: boolean) => {
        calls.push(force);
        return {
          provider: "deepseek" as const,
          balance: { state: "nokey" as const },
        };
      },
    },
  });
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  assert.deepEqual(calls, [false], "面板打开时未查询余额（一次、非强制）");
  const prefs = msgs(deps, "uiPrefs").pop();
  assert.ok(prefs && prefs.type === "uiPrefs");
  assert.equal(prefs.showUsage, true, "缺省开关应为开");
  const bal = msgs(deps, "balanceStatus").pop();
  assert.ok(bal && bal.type === "balanceStatus");
  assert.equal(bal.provider, "deepseek");
  assert.deepEqual(bal.balance, { state: "nokey" });

  bridge.dispatch({ source: win, data: { type: "refreshBalance" } });
  await tick();
  assert.deepEqual(calls, [false, true], "手动刷新未强制重查（绕过 TTL）");
});

// 复查修-6：开关关闭 = 不查询也不显示（此前关掉只影响渲染，宿主照发出网请求）
test("复查修-6: showUsage=false → hello 与 refreshBalance 都不查询余额、不推 balanceStatus", async () => {
  const calls: boolean[] = [];
  const deps = makeDeps({
    balance: {
      get: async (force: boolean) => {
        calls.push(force);
        return {
          provider: "deepseek" as const,
          balance: { state: "nokey" as const },
        };
      },
    },
    showUsage: () => false,
  });
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();

  assert.deepEqual(calls, [], "开关关闭仍在查询余额（出网）");
  assert.equal(msgs(deps, "balanceStatus").length, 0, "开关关闭仍推了余额状态");
  const prefs = msgs(deps, "uiPrefs").pop();
  assert.ok(prefs && prefs.type === "uiPrefs");
  assert.equal(prefs.showUsage, false);

  // 面板已隐藏整行（含刷新按钮），但仍可能收到陈旧页面发来的手动刷新 → 同样不出网
  bridge.dispatch({ source: win, data: { type: "refreshBalance" } });
  await tick();
  assert.deepEqual(calls, [], "开关关闭时手动刷新仍出了网");
  assert.equal(msgs(deps, "balanceStatus").length, 0);
});

test("R4-3 host: 未接线余额（老宿主/无 deps）→ 不推 balanceStatus、不崩", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  bridge.dispatch({ source: win, data: { type: "refreshBalance" } });
  await tick();
  assert.equal(msgs(deps, "balanceStatus").length, 0);
  const prefs = msgs(deps, "uiPrefs").pop();
  assert.ok(prefs && prefs.type === "uiPrefs");
  assert.equal(prefs.showUsage, true, "缺省开关应为开");
});
