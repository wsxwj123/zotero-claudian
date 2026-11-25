// 验收 — r21-procerror：CLI 异常退出横幅误报（黑盒，依据 .devflow/r21-procerror-接口.md 行为清单 1–12）
// 只经对外入口：spawnTurn / createHostBridge / chatModel 公开函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import { spawnTurn } from "../../src/modules/cliRunner.ts";
import { createHostBridge } from "../../src/modules/hostBridge.ts";
import {
  initialChatState,
  userSend,
  interrupt,
  reduceHostMessage,
} from "../../src/chat/lib/chatModel.ts";
import { makeStore } from "../unit/helpers/memoryFs.ts";

// ---------- CLI 原始行（接口文件「行为清单」原文） ----------
const INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"c1","model":"m","permissionMode":"default","tools":[],"mcp_servers":[]}';
const API_ERROR_RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"API Error: 502"}';
const EXEC_ERROR_RESULT_LINE =
  '{"type":"result","subtype":"error_during_execution","errors":["x"]}';
const SUCCESS_RESULT_LINE =
  '{"type":"result","subtype":"success","session_id":"c1","total_cost_usd":0,"duration_ms":1,"num_turns":1}';

// ---------- spawnTurn 搭台：假进程（stdout/stderr 分块到达，wait 在 finish 后 resolve） ----------
function makeFakeProc(stdoutText, stderrText = "") {
  const stdoutChunks = stdoutText.match(/[\s\S]{1,7}/g) ?? [];
  const stderrChunks = stderrText.match(/[\s\S]{1,4}/g) ?? [];
  let finished = false;
  let resolveWait = () => {};
  const waitPromise = new Promise((resolve) => {
    resolveWait = resolve;
  });
  const reader = (chunks) => async () => {
    if (chunks.length > 0) return chunks.shift();
    if (finished) return null;
    await new Promise((r) => setTimeout(r, 1));
    return chunks.length > 0 ? chunks.shift() : finished ? null : "";
  };
  const proc = {
    stdin: { write: () => {}, close: () => {} },
    stdout: { readString: reader(stdoutChunks) },
    stderr: { readString: reader(stderrChunks) },
    wait: () => waitPromise,
    kill: () => {},
  };
  const finish = (exitCode) => {
    finished = true;
    resolveWait({ exitCode });
  };
  return { proc, finish };
}

async function runTurn(lines, exitCode, stderrText = "") {
  const { proc, finish } = makeFakeProc(
    lines.map((l) => l + "\n").join(""),
    stderrText,
  );
  const events = [];
  const handle = spawnTurn(
    { call: async () => proc },
    {
      command: "/usr/bin/claude",
      args: ["-p"],
      workdir: "/tmp/ws",
      prompt: "hi",
      onEvent: (e) => events.push(e),
    },
  );
  finish(exitCode);
  await handle.exitPromise;
  return events;
}

// ---------- 宿主桥搭台 ----------
const TOKEN = "tok-r21";
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeBridgeDeps() {
  const memory = makeStore();
  const sent = [];
  const spawned = [];
  const logLines = [];
  const deps = {
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: (line) => logLines.push(line),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text) => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: text,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: { PATH: "/usr/bin" },
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 52100, token: "tok" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options) => {
      spawned.push(options);
      // 一轮持续在跑：exitPromise 不 resolve，直到测试结束
      return { kill: () => {}, exitPromise: new Promise(() => {}) };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "论文" } : null,
  };
  return { deps, sent, spawned, logLines, store: memory.store };
}

/** 握手 → 发一轮 → 返回运行中的会话 id 与观察点 */
async function startRunningTurn() {
  const ctx = makeBridgeDeps();
  const bridge = createHostBridge(ctx.deps);
  const win = { __fakeWindow: true };
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "长任务" } });
  await tick();
  await tick();
  assert.equal(ctx.spawned.length, 1, "搭台：send 后应 spawn 一轮");
  const list = ctx.store.list();
  assert.equal(list.length, 1, "搭台：send 后应恰有一个会话");
  return { ...ctx, bridge, win, sessionId: list[0].id };
}

function broadcastProcErrorEvents(sent) {
  return sent
    .filter((s) => s.msg.type === "streamEvent" && s.msg.event?.kind === "procError")
    .map((s) => s.msg.event);
}

async function interruptedScenario() {
  const ctx = await startRunningTurn();
  ctx.bridge.dispatch({
    source: ctx.win,
    data: { type: "interrupt", sessionId: ctx.sessionId },
  });
  ctx.spawned[0].onEvent({ kind: "procError", exitCode: null });
  await tick();
  return ctx;
}

async function crashScenario() {
  const ctx = await startRunningTurn();
  ctx.spawned[0].onEvent({ kind: "procError", exitCode: 1, stderrTail: "boom" });
  await tick();
  return ctx;
}

// ---------- 界面搭台 ----------
function boundState() {
  return {
    ...initialChatState(),
    connected: true,
    sessionId: "sA",
    sessions: [
      { id: "sA", title: "t", updatedAt: 1, itemKey: "A", claudeSessionId: "c" },
    ],
  };
}

function streamEvent(event) {
  return { type: "streamEvent", sessionId: "sA", event };
}

/** userSend → messageStart：返回 streaming 中的视图状态 */
function runningViewState() {
  const sent = userSend(boundState(), "问题");
  return reduceHostMessage(sent.state, streamEvent({ kind: "messageStart" }));
}

// ======================= spawnTurn =======================

test("r21-1 spawnTurn：初始化行 + 接口报错结束行，退出码 1 → 事件序列恰为 [init, resultError]，无 procError", async () => {
  const events = await runTurn([INIT_LINE, API_ERROR_RESULT_LINE], 1);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "resultError"],
  );
});

test("r21-2 spawnTurn：初始化行 + 执行报错结束行，退出码 1 → 事件序列恰为 [init, resultError]，无 procError", async () => {
  const events = await runTurn([INIT_LINE, EXEC_ERROR_RESULT_LINE], 1);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "resultError"],
  );
});

test("r21-3 spawnTurn（回归）：只有初始化行、stderr=boom、退出码 1 → [init, procError] 且 exitCode=1、stderrTail 含 boom", async () => {
  const events = await runTurn([INIT_LINE], 1, "boom");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "procError"],
  );
  const last = events[events.length - 1];
  assert.equal(last.exitCode, 1);
  assert.equal(typeof last.stderrTail, "string");
  assert.ok(last.stderrTail.includes("boom"), `stderrTail=${JSON.stringify(last.stderrTail)}`);
});

test("r21-4 spawnTurn（回归）：初始化行 + 成功结束行、退出码 0 → 事件序列恰为 [init, result]", async () => {
  const events = await runTurn([INIT_LINE, SUCCESS_RESULT_LINE], 0);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "result"],
  );
});

// ======================= 宿主桥 =======================

test("r21-5 宿主桥：用户中断后该轮上报 procError(exit=null) → 广播事件 kind=procError 且 reason=INTERRUPTED", async () => {
  const { sent, sessionId } = await interruptedScenario();
  const procErrors = sent
    .filter((s) => s.msg.type === "streamEvent" && s.msg.sessionId === sessionId)
    .map((s) => s.msg.event)
    .filter((e) => e?.kind === "procError");
  assert.equal(procErrors.length >= 1, true, "应至少广播一条 procError streamEvent");
  const ev = procErrors[procErrors.length - 1];
  assert.equal(ev.kind, "procError");
  assert.equal(ev.reason, "INTERRUPTED");
});

test("r21-6 宿主桥（回归）：未中断时上报 procError(exit=1, boom) → 广播事件 reason 为 undefined、exitCode=1", async () => {
  const { sent } = await crashScenario();
  const procErrors = broadcastProcErrorEvents(sent);
  assert.equal(procErrors.length >= 1, true, "应至少广播一条 procError streamEvent");
  const ev = procErrors[procErrors.length - 1];
  assert.equal(ev.reason, undefined);
  assert.equal(ev.exitCode, 1);
});

test("r21-7 宿主桥：未中断 procError → deps.log 恰一行 [bridge] procError exit=1 interrupted=false …，含 stderr=boom、session、非负整数 elapsedMs", async () => {
  const { logLines, sessionId } = await crashScenario();
  const prefix = "[bridge] procError exit=1 interrupted=false ";
  const matched = logLines.filter((l) => typeof l === "string" && l.startsWith(prefix));
  assert.equal(matched.length, 1, `procError 日志行数应为 1，实际日志：${JSON.stringify(logLines)}`);
  const line = matched[0];
  assert.ok(line.includes("stderr=boom"), `缺 stderr=boom：${line}`);
  assert.ok(line.includes(`session=${sessionId}`), `缺 session=${sessionId}：${line}`);
  assert.match(line, /elapsedMs=\d+(\s|$)/);
});

test("r21-8 宿主桥：中断后 procError → deps.log 有一行以 [bridge] procError exit=null interrupted=true 开头", async () => {
  const { logLines } = await interruptedScenario();
  const prefix = "[bridge] procError exit=null interrupted=true ";
  const matched = logLines.filter((l) => typeof l === "string" && l.startsWith(prefix));
  assert.ok(matched.length >= 1, `缺 interrupted=true 的 procError 日志行，实际日志：${JSON.stringify(logLines)}`);
});

// ======================= 界面状态机 =======================

const INTERRUPTED_EVENT = { kind: "procError", exitCode: null, reason: "INTERRUPTED" };

test("r21-9 界面：userSend → messageStart → interrupt → 收 INTERRUPTED procError → idle、无横幅、无错误码、本轮 aborted", () => {
  const running = runningViewState();
  const afterInterrupt = interrupt(running).state;
  const s = reduceHostMessage(afterInterrupt, streamEvent(INTERRUPTED_EVENT));
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, null);
  assert.equal(s.errorCode, null);
  assert.equal(s.lastTurnEnd?.end, "aborted");
});

test("r21-10 界面：未调用 interrupt 的视图收 INTERRUPTED procError → idle、无横幅、本轮 aborted", () => {
  const running = runningViewState();
  const s = reduceHostMessage(running, streamEvent(INTERRUPTED_EVENT));
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, null);
  assert.equal(s.lastTurnEnd?.end, "aborted");
});

test("r21-11 界面（回归）：收 procError(exit=1, boom) → 横幅 'CLI 进程异常退出 (exit 1)\\nboom'、本轮 error、idle", () => {
  const running = runningViewState();
  const s = reduceHostMessage(
    running,
    streamEvent({ kind: "procError", exitCode: 1, stderrTail: "boom" }),
  );
  assert.equal(s.errorBanner, "CLI 进程异常退出 (exit 1)\nboom");
  assert.equal(s.lastTurnEnd?.end, "error");
  assert.equal(s.turnStatus, "idle");
});

test("r21-12 界面（回归）：收 resultError(api_error) → 横幅 'turn 失败 (api_error): API Error: 502'、idle", () => {
  const running = runningViewState();
  const s = reduceHostMessage(
    running,
    streamEvent({ kind: "resultError", subtype: "api_error", errors: ["API Error: 502"] }),
  );
  assert.equal(s.errorBanner, "turn 失败 (api_error): API Error: 502");
  assert.equal(s.turnStatus, "idle");
});
