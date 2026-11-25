// 验收 — r21-procerror 补充节：会话失效识别与日志净化（黑盒，依据 .devflow/r21-procerror-接口.md 行为清单 13–18）
// 只经对外入口：createHostBridge 的消息入口、广播消息、deps.log，以及会话存储的公开方法 get()。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import { createHostBridge } from "../../src/modules/hostBridge.ts";
import { makeStore } from "../unit/helpers/memoryFs.ts";

const TOKEN = "tok-r21-2";
const LIVE_CLAUDE_SESSION_ID = "c-live-1";

/** 让排队的微任务与异步写入落定 */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 宿主桥搭台：每次 spawn 产生一个可控的假轮次（可手动放事件、手动放行退出） */
function makeBridgeContext() {
  const memory = makeStore();
  const sent = [];
  const logLines = [];
  const turns = [];
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
      let releaseExit = () => {};
      const exitPromise = new Promise((r) => {
        releaseExit = () => r();
      });
      turns.push({ options, emit: (ev) => options.onEvent(ev), releaseExit });
      return { kill: () => {}, exitPromise };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "论文" } : null,
  };
  const bridge = createHostBridge(deps);
  const win = { __fakeWindow: true };
  return { bridge, win, sent, logLines, turns, store: memory.store };
}

async function handshake(ctx) {
  ctx.bridge.beginHandshake(ctx.win, TOKEN);
  ctx.bridge.dispatch({ source: ctx.win, data: { type: "hello", token: TOKEN } });
  await settle();
}

/** 握手 → 发一轮（未中断、持续在跑），返回会话 id */
async function startFreshRunningTurn() {
  const ctx = makeBridgeContext();
  await handshake(ctx);
  ctx.bridge.dispatch({ source: ctx.win, data: { type: "send", text: "长任务" } });
  await settle();
  assert.equal(ctx.turns.length, 1, "搭台：send 后应 spawn 一轮");
  const list = ctx.store.list();
  assert.equal(list.length, 1, "搭台：send 后应恰有一个会话");
  return { ...ctx, sessionId: list[0].id };
}

/**
 * 会话已有 CLI 会话编号，且其续接的一轮在跑：
 * 首轮以成功结束行带回 CLI 会话编号并退出 → 同会话再发一轮（不放行退出）。
 */
async function startResumedRunningTurn() {
  const ctx = await startFreshRunningTurn();
  ctx.turns[0].emit({
    kind: "result",
    claudeSessionId: LIVE_CLAUDE_SESSION_ID,
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  ctx.turns[0].releaseExit();
  await settle();
  assert.equal(
    ctx.store.get(ctx.sessionId)?.claudeSessionId,
    LIVE_CLAUDE_SESSION_ID,
    "搭台：首轮结束后会话应记下 CLI 会话编号",
  );
  ctx.sent.length = 0;
  ctx.bridge.dispatch({
    source: ctx.win,
    data: { type: "send", text: "续接", sessionId: ctx.sessionId },
  });
  await settle();
  assert.equal(ctx.turns.length, 2, "搭台：续接应 spawn 第二轮");
  return ctx;
}

function sessionGoneErrors(sent) {
  return sent
    .map((s) => s.msg)
    .filter((m) => m?.type === "error" && m.code === "SESSION_GONE");
}

function procErrorLogLines(logLines) {
  return logLines.filter(
    (l) => typeof l === "string" && l.startsWith("[bridge] procError "),
  );
}

const SESSION_GONE_RESULT_ERROR = {
  kind: "resultError",
  subtype: "error_during_execution",
  errors: ["No conversation found with session ID: abc"],
};

// ======================= 会话失效识别 =======================

test("r21-13 宿主桥：续接轮上报 resultError(No conversation found) → 广播恰一条 SESSION_GONE error，sessionId 为该会话", async () => {
  const ctx = await startResumedRunningTurn();
  ctx.turns[1].emit(SESSION_GONE_RESULT_ERROR);
  await settle();
  ctx.turns[1].releaseExit();
  await settle();
  const gone = sessionGoneErrors(ctx.sent);
  assert.equal(
    gone.length,
    1,
    `SESSION_GONE error 条数应为 1，实际广播：${JSON.stringify(ctx.sent.map((s) => s.msg))}`,
  );
  assert.equal(gone[0].sessionId, ctx.sessionId);
});

test("r21-14 宿主桥：resultError(No conversation found) 落定后，会话存储中该会话的 CLI 会话编号为 null", async () => {
  const ctx = await startResumedRunningTurn();
  ctx.turns[1].emit(SESSION_GONE_RESULT_ERROR);
  await settle();
  ctx.turns[1].releaseExit();
  await settle();
  const record = ctx.store.get(ctx.sessionId);
  assert.ok(record, "会话记录应仍存在");
  assert.equal(record.claudeSessionId, null);
});

test("r21-15 宿主桥（回归）：续接轮上报 resultError(api_error) → 无 SESSION_GONE，CLI 会话编号保持原值", async () => {
  const ctx = await startResumedRunningTurn();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "api_error",
    errors: ["API Error: 502"],
  });
  await settle();
  ctx.turns[1].releaseExit();
  await settle();
  assert.deepEqual(sessionGoneErrors(ctx.sent), []);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, LIVE_CLAUDE_SESSION_ID);
});

test("r21-16 宿主桥（回归）：续接轮上报 procError(stderr 含 No conversation found) → 广播一条 SESSION_GONE error", async () => {
  const ctx = await startResumedRunningTurn();
  ctx.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "No conversation found with session ID: abc",
  });
  await settle();
  ctx.turns[1].releaseExit();
  await settle();
  const gone = sessionGoneErrors(ctx.sent);
  assert.equal(
    gone.length,
    1,
    `SESSION_GONE error 条数应为 1，实际广播：${JSON.stringify(ctx.sent.map((s) => s.msg))}`,
  );
  assert.equal(gone[0].sessionId, ctx.sessionId);
});

// ======================= 日志净化 =======================

test("r21-17 宿主桥：procError 的 stderr 含密钥/URL 口令/token/Bearer → 日志行已打码为 ***，保留 host:8080", async () => {
  const ctx = await startFreshRunningTurn();
  ctx.turns[0].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail:
      "auth sk-ant-abc123DEF via http://user:pass@host:8080 url?token=xyz789 hdr Bearer qqq111",
  });
  await settle();
  const lines = procErrorLogLines(ctx.logLines);
  assert.equal(lines.length, 1, `procError 日志行数应为 1，实际日志：${JSON.stringify(ctx.logLines)}`);
  const line = lines[0];
  for (const secret of ["sk-ant-abc123DEF", "user:pass@", "xyz789", "qqq111"]) {
    assert.equal(line.includes(secret), false, `日志行泄露了 ${secret}：${line}`);
  }
  assert.ok(line.includes("***"), `日志行缺打码标记 ***：${line}`);
  assert.ok(line.includes("host:8080"), `日志行丢了 host:8080：${line}`);
});

test("r21-18 宿主桥：procError 的 stderr 含 ESC/U+2028/U+202E → 日志行不含这些原字符，仍含 a b c d", async () => {
  const ctx = await startFreshRunningTurn();
  ctx.turns[0].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "a\u001b[31mb c‮d",
  });
  await settle();
  const lines = procErrorLogLines(ctx.logLines);
  assert.equal(lines.length, 1, `procError 日志行数应为 1，实际日志：${JSON.stringify(ctx.logLines)}`);
  const line = lines[0];
  for (const ch of ["\u001b", " ", "‮"]) {
    assert.equal(
      line.includes(ch),
      false,
      `日志行含原字符 U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}：${JSON.stringify(line)}`,
    );
  }
  const stderrPart = line.slice(line.indexOf("stderr=") + "stderr=".length);
  for (const letter of ["a", "b", "c", "d"]) {
    assert.ok(stderrPart.includes(letter), `stderr 段缺字母 ${letter}：${JSON.stringify(line)}`);
  }
});
