// 单测 — hostBridge.ts：握手/注册表幂等/白名单分发/广播/会话运行时 +
// M5 会话管理（索引 CRUD / getHistory 回放 / resume / SESSION_GONE / 重启模拟）。
// Gecko 全 fake：会话存储用真实 sessionStore + 内存文件系统（tests/unit/helpers/memoryFs.ts）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type {
  SpawnTurnOptions,
  TurnHandle,
  TurnEvent,
} from "../../src/modules/cliRunner.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type { SessionStore } from "../../src/utils/sessionStore.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const TOKEN = "tok-abc123";

/** 让所有挂起的 microtask/定时器跑完（store 与 sessionList 都是异步链路） */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeDeps(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage; ports?: unknown[] }[] = [];
  const launched: string[] = [];
  const spawned: SpawnTurnOptions[] = [];
  const memory = makeStore();
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    launched: string[];
    spawned: SpawnTurnOptions[];
    store: SessionStore;
    fs: typeof memory.fs;
    logs: string[];
  } = {
    sent,
    launched,
    spawned,
    store: memory.store,
    fs: memory.fs,
    logs: memory.logs,
    post: (win, msg, ports) => sent.push({ win, msg, ports }),
    createChannel: () => null,
    log: () => {},
    now: () => 1_700_000_000_000,
    launchURL: (url) => launched.push(url),
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: `[Zotero context]\n[/Zotero context]\n\n${text}`,
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
    spawnTurn: (options: SpawnTurnOptions): TurnHandle => {
      spawned.push(options);
      return {
        kill: () => {},
        exitPromise: Promise.resolve(),
      };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "一篇论文" } : null,
    ...overrides,
  };
  return deps;
}

function makeWin(): object {
  return { __fakeWindow: true };
}

function helloHandshake(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
}

/** 取最后一次某类型消息（断言用） */
function lastMsg(
  deps: ReturnType<typeof makeDeps>,
  type: HostMessage["type"],
): HostMessage | undefined {
  return deps.sent.filter((s) => s.msg.type === type).pop()?.msg;
}

/** 取当前唯一会话 id（send 自动建会话后的绑定目标） */
function onlySessionId(deps: ReturnType<typeof makeDeps>): string {
  const list = deps.store.list();
  assert.equal(list.length, 1);
  return list[0].id;
}

// ---- 握手与注册表（M4，回归）----

test("hostBridge: init→hello 三步握手 → 注册 + sessionList 回发", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  assert.ok(deps.sent.some((s) => s.msg.type === "init" && s.win === win));
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  const list = lastMsg(deps, "sessionList");
  assert.ok(list);
  assert.deepEqual(list.type === "sessionList" ? list.sessions : null, []);
});

test("BUG-16: init 携带一次性 token；hello token 不一致 → 拒绝 + log、不注册", async () => {
  const logs: string[] = [];
  const deps = makeDeps();
  deps.log = (m) => logs.push(m);
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  const init = deps.sent.find((s) => s.msg.type === "init");
  assert.equal(init?.msg.type === "init" && init.msg.token, TOKEN);
  // 错误 token / 缺 token：拒绝
  bridge.dispatch({ source: win, data: { type: "hello", token: "wrong" } });
  bridge.dispatch({ source: win, data: { type: "hello" } });
  await tick();
  assert.ok(!deps.sent.some((s) => s.msg.type === "sessionList"));
  assert.equal(logs.filter((m) => m.includes("hello REJECTED")).length, 2);
  // 拒绝后正确 token 仍可完成握手（未污染状态）
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  assert.ok(deps.sent.some((s) => s.msg.type === "sessionList"));
});

test("BUG-16: MessagePort 通道可用 → init 带转移端口，页面经端口 hello 即注册", async () => {
  const port1: {
    postMessage(msg: unknown): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
  } = {
    postMessage: () => {},
    onmessage: null,
  };
  const port2 = { __fakePort2: true };
  const deps = makeDeps();
  deps.createChannel = () => ({ port1, port2 });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  const init = deps.sent.find((s) => s.msg.type === "init");
  assert.deepEqual(init?.ports, [port2]);
  // 页面经端口回 hello（token 校验同样生效）
  port1.onmessage?.({ data: { type: "hello", token: "wrong" } });
  await tick();
  assert.ok(!deps.sent.some((s) => s.msg.type === "sessionList"));
  port1.onmessage?.({ data: { type: "hello", token: TOKEN } });
  await tick();
  assert.ok(deps.sent.some((s) => s.msg.type === "sessionList"));
  // 端口路径下后续消息正常分发
  bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: "s1" },
  });
  await tick();
  assert.ok(deps.sent.some((s) => s.msg.type === "history"));
});

test("BUG-16: 端口转移被拒 → 回退纯窗口 init（无 ports）", async () => {
  const deps = makeDeps();
  deps.createChannel = () => ({
    port1: { postMessage: () => {}, onmessage: null },
    port2: {},
  });
  deps.post = (win, msg, ports) => {
    if (ports && ports.length > 0) {
      throw new Error("DataCloneError");
    }
    deps.sent.push({ win, msg, ports });
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  const inits = deps.sent.filter((s) => s.msg.type === "init");
  assert.equal(inits.length, 1);
  assert.equal(inits[0].ports, undefined);
  // 回退后窗口路径 handshake 仍可用
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  assert.ok(deps.sent.some((s) => s.msg.type === "sessionList"));
});

test("hostBridge: hello 来源不在 pending → 忽略（未收到过 init）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  assert.ok(!deps.sent.some((s) => s.msg.type === "sessionList"));
});

test("hostBridge: 重复 hello 幂等 → 只注册一次，重载场景重发 sessionList", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  // 同窗口再次 beginHandshake（reload）+ 再次 hello
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  const lists = deps.sent.filter((s) => s.msg.type === "sessionList");
  assert.equal(lists.length, 2); // 首次注册 + reload 重发，无第三次
});

test("hostBridge: 未知来源消息 / 非对象 / 缺 type → 忽略", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.dispatch({ source: win, data: { type: "send", text: "hi" } }); // 未注册
  bridge.dispatch({ source: win, data: "string" });
  bridge.dispatch({ source: win, data: { noType: 1 } });
  bridge.dispatch({ source: null, data: { type: "send", text: "hi" } });
  await tick();
  assert.equal(deps.spawned.length, 0);
  assert.ok(!deps.sent.some((s) => s.msg.type === "sessionList"));
});

// ---- send / spawn（M4 回归 + M5 索引联动）----

test("hostBridge: send → spawn 被调（参数含 mcp 恒带项），事件广播 streamEvent", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "send", sessionId: null, text: "这篇讲什么" },
  });
  await tick();
  assert.equal(deps.spawned.length, 1);
  const opts = deps.spawned[0];
  assert.equal(opts.command, "/usr/bin/claude");
  assert.equal(opts.workdir, "/workspace");
  assert.ok(opts.prompt.includes("这篇讲什么"));
  assert.ok(opts.args.includes("--permission-mode"));
  assert.ok(opts.args.includes("acceptEdits"));
  // mcp 恒带（§4.1 参数序列 6）
  assert.ok(opts.args.includes("--mcp-config"));
  assert.ok(opts.args.includes("--permission-prompt-tool"));
  // 首轮无 --resume
  assert.ok(!opts.args.includes("--resume"));
  // 自动建会话：标题取首条用户消息前 40 字符，itemKey 随上下文绑定
  const rec = deps.store.list()[0];
  assert.equal(rec.title, "这篇讲什么");
  assert.equal(rec.itemKey, "ITEM1");
  assert.equal(rec.itemLibraryID, 1);
  assert.equal(rec.attachmentKey, "ATT1");
  // sessionList 已推给 UI（UI 据此绑定新会话）
  await tick();
  const list = lastMsg(deps, "sessionList");
  assert.equal(list?.type === "sessionList" ? list.sessions.length : -1, 1);
  // 事件广播
  const turnEvents: TurnEvent[] = [
    {
      kind: "init",
      claudeSessionId: "cli-1",
      model: "m",
      permissionMode: "acceptEdits",
      tools: [],
      mcpServers: [],
    },
  ];
  for (const e of turnEvents) opts.onEvent(e);
  const streamMsgs = deps.sent.filter((s) => s.msg.type === "streamEvent");
  assert.equal(streamMsgs.length, 1);
});

test("hostBridge: 附件目录写保护——prepare 产物进 --settings，进程退出后清理该文件", async () => {
  const cleaned: string[] = [];
  let releaseExit: (() => void) | null = null;
  const deps = makeDeps();
  deps.prepareDenySettings = async (addDir) =>
    addDir ? "/data/deny-adddir-1.json" : null;
  deps.cleanupDenySettings = (path) => cleaned.push(path);
  deps.spawnTurn = (options) => {
    deps.spawned.push(options);
    return {
      kill: () => {},
      exitPromise: new Promise<void>((resolve) => {
        releaseExit = resolve;
      }),
    };
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "问" } });
  await tick();
  const args = deps.spawned[0].args;
  const i = args.indexOf("--settings");
  assert.equal(args[i + 1], "/data/deny-adddir-1.json");
  assert.ok(i > args.indexOf("--add-dir"), "--settings 跟在 --add-dir 之后");
  assert.deepEqual(cleaned, []); // 进程未退：文件还在（本轮 spawn 要读它）
  releaseExit?.();
  await tick();
  assert.deepEqual(cleaned, ["/data/deny-adddir-1.json"]);
});

test("hostBridge: 无附件目录（addDir null）→ 不写保护文件、无 --settings、无清理调用", async () => {
  const cleaned: string[] = [];
  const prepared: (string | null)[] = [];
  const deps = makeDeps();
  deps.buildTurnPrompt = async (text) => ({
    itemKey: null,
    attachmentKey: null,
    prompt: text,
    addDir: null,
  });
  deps.prepareDenySettings = async (addDir) => {
    prepared.push(addDir);
    return null;
  };
  deps.cleanupDenySettings = (path) => cleaned.push(path);
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "问" } });
  await tick();
  assert.deepEqual(prepared, [null]); // 仍问一次（由实现决定无目录不建文件）
  assert.ok(!deps.spawned[0].args.includes("--settings"));
  await tick();
  assert.deepEqual(cleaned, []);
});

test("hostBridge: 写保护文件建不出来 → 该轮不 spawn + SPAWN_FAILED（fail-closed）", async () => {
  const deps = makeDeps();
  deps.prepareDenySettings = async () => {
    throw new Error("deny settings write failed: disk full");
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "问" } });
  await tick();
  assert.equal(deps.spawned.length, 0);
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "SPAWN_FAILED");
});

test("hostBridge: 进行中 turn 收 send → SESSION_BUSY 不排队（并发契约）", async () => {
  let releaseExit: (() => void) | null = null;
  const deps = makeDeps();
  deps.spawnTurn = (options) => {
    deps.spawned.push(options);
    return {
      kill: () => {},
      exitPromise: new Promise<void>((resolve) => {
        releaseExit = resolve;
      }),
    };
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "第一问" } });
  await tick();
  const sessionId = onlySessionId(deps);
  bridge.dispatch({ source: win, data: { type: "send", text: "第二问" } });
  await tick();
  assert.equal(deps.spawned.length, 1); // 不排队
  const busyErr = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.ok(busyErr);
  assert.equal(
    busyErr.msg.type === "error" && busyErr.msg.code,
    "SESSION_BUSY",
  );
  // 进程退出后解锁
  releaseExit?.();
  await tick();
  assert.equal(bridge.getRuntime(sessionId)?.busy, null);
  bridge.dispatch({ source: win, data: { type: "send", text: "第三问" } });
  await tick();
  assert.equal(deps.spawned.length, 2);
});

test("hostBridge: 第二轮 send 带 --resume（claudeSessionId 落索引后复用）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "第一问" } });
  await tick();
  deps.spawned[0].onEvent({
    kind: "init",
    claudeSessionId: "cli-abc",
    model: "m",
    permissionMode: "acceptEdits",
    tools: [],
    mcpServers: [],
  });
  deps.spawned[0].onEvent({
    kind: "result",
    claudeSessionId: "cli-abc",
    costUsd: 0.01,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  assert.equal(deps.store.list()[0].claudeSessionId, "cli-abc");
  bridge.dispatch({ source: win, data: { type: "send", text: "第二问" } });
  await tick();
  assert.equal(deps.spawned.length, 2);
  const args = deps.spawned[1].args;
  const resumeIdx = args.indexOf("--resume");
  assert.ok(resumeIdx >= 0);
  assert.equal(args[resumeIdx + 1], "cli-abc");
});

test("hostBridge: interrupt → busy=interrupting、kill 被调、进程退出才解锁", async () => {
  let killed = 0;
  let releaseExit: (() => void) | null = null;
  const deps = makeDeps();
  deps.spawnTurn = (options) => {
    deps.spawned.push(options);
    return {
      kill: () => {
        killed++;
      },
      exitPromise: new Promise<void>((resolve) => {
        releaseExit = resolve;
      }),
    };
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "长任务" } });
  await tick();
  const sessionId = onlySessionId(deps);
  // 真实 UI 形态（M3 chatModel）：state.sessionId 未绑定时 interrupt 带 sessionId:null
  bridge.dispatch({
    source: win,
    data: { type: "interrupt", sessionId: null },
  });
  assert.equal(killed, 1);
  assert.equal(bridge.getRuntime(sessionId)?.busy, "interrupting");
  // interrupting 期间再 interrupt → 忽略不重复 kill
  bridge.dispatch({
    source: win,
    data: { type: "interrupt", sessionId: null },
  });
  assert.equal(killed, 1);
  // 不匹配的字符串 sessionId → 忽略
  bridge.dispatch({
    source: win,
    data: { type: "interrupt", sessionId: "other-session" },
  });
  assert.equal(killed, 1);
  // interrupting 期间 send → SESSION_BUSY
  bridge.dispatch({ source: win, data: { type: "send", text: "再问" } });
  await tick();
  const busyErr = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(
    busyErr?.msg.type === "error" && busyErr.msg.code,
    "SESSION_BUSY",
  );
  // 进程退出 → 解锁
  releaseExit?.();
  await tick();
  assert.equal(bridge.getRuntime(sessionId)?.busy, null);
  // 空闲时 interrupt → 忽略（无运行中 turn）
  bridge.dispatch({
    source: win,
    data: { type: "interrupt", sessionId: null },
  });
  assert.equal(killed, 1);
});

test("hostBridge: procError（kill 后无 result）→ procError streamEvent 广播", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "x" } });
  await tick();
  deps.spawned[0].onEvent({ kind: "procError", exitCode: -15, stderrTail: "" });
  const procErr = deps.sent
    .filter((s) => s.msg.type === "streamEvent")
    .map((s) => (s.msg.type === "streamEvent" ? s.msg.event : null));
  assert.ok(procErr.some((e) => e?.kind === "procError"));
});

test("hostBridge: send 空白/非字符串文本 → 忽略（不 spawn、无 error）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  for (const text of ["", "   ", 42, null]) {
    bridge.dispatch({ source: win, data: { type: "send", text } });
  }
  await tick();
  assert.equal(deps.spawned.length, 0);
  assert.ok(!deps.sent.some((s) => s.msg.type === "error"));
  assert.equal(deps.store.list().length, 0); // 空文本不建会话
});

test("hostBridge: spawn 基础缺 command → CLAUDE_NOT_FOUND error 且解锁", async () => {
  const deps = makeDeps();
  deps.getSpawnBase = async () => ({
    command: null,
    channel: "direct",
    environment: {},
    environmentAppend: true,
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "x" } });
  await tick();
  assert.equal(deps.spawned.length, 0);
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "CLAUDE_NOT_FOUND");
  // 解锁后可重试
  bridge.dispatch({ source: win, data: { type: "send", text: "x" } });
  await tick();
  assert.equal(deps.sent.filter((s) => s.msg.type === "error").length, 2);
});

test("hostBridge: ensureWorkspace 抛 WORKSPACE_UNAVAILABLE → error 且解锁", async () => {
  const deps = makeDeps();
  deps.ensureWorkspace = async () => {
    const e = new Error("mkdir failed");
    (e as { code?: string }).code = "WORKSPACE_UNAVAILABLE";
    throw e;
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "x" } });
  await tick();
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(
    err?.msg.type === "error" && err.msg.code,
    "WORKSPACE_UNAVAILABLE",
  );
  assert.equal(bridge.getRuntime(onlySessionId(deps))?.busy, null);
});

// ---- M5：会话 CRUD / getHistory / SESSION_GONE / 重启续接 ----

test("M5 createSession: 建索引记录（含 itemKey 校验）+ 推 sessionList（含条目标题）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "createSession", itemKey: "ITEM1" },
  });
  await tick();
  assert.equal(deps.store.list().length, 1);
  const rec = deps.store.list()[0];
  assert.equal(rec.itemKey, "ITEM1");
  assert.equal(rec.itemLibraryID, 1);
  assert.equal(rec.claudeSessionId, null);
  const list = lastMsg(deps, "sessionList");
  assert.deepEqual(list?.type === "sessionList" ? list.sessions[0] : null, {
    id: rec.id,
    title: "",
    updatedAt: rec.updatedAt,
    itemKey: "ITEM1",
    claudeSessionId: null,
    itemTitle: "一篇论文",
  });
  // 无 itemKey → 通用会话
  bridge.dispatch({ source: win, data: { type: "createSession" } });
  await tick();
  assert.equal(deps.store.list().length, 2);
  // itemKey 查无 → ITEM_NOT_FOUND，不建记录
  bridge.dispatch({
    source: win,
    data: { type: "createSession", itemKey: "NOPE" },
  });
  await tick();
  assert.equal(deps.store.list().length, 2);
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "ITEM_NOT_FOUND");
});

test("M5 deleteSession: 删索引 + 旁挂历史 + 推列表；未知 id 忽略；在跑 turn 先 kill", async () => {
  let killed = 0;
  const deps = makeDeps();
  deps.spawnTurn = (options) => {
    deps.spawned.push(options);
    return {
      kill: () => {
        killed++;
      },
      exitPromise: new Promise<void>(() => {}), // 永不退出：模拟进程存活
    };
  };
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "第一问" } });
  await tick();
  const sessionId = onlySessionId(deps);
  // 未知 id → 忽略
  bridge.dispatch({
    source: win,
    data: { type: "deleteSession", sessionId: "nope" },
  });
  await tick();
  assert.equal(deps.store.list().length, 1);
  assert.equal(killed, 0);
  // 真删除：kill 在跑进程 + 记录消失 + 历史文件消失
  bridge.dispatch({
    source: win,
    data: { type: "deleteSession", sessionId },
  });
  await tick();
  await tick();
  assert.equal(killed, 1);
  assert.equal(deps.store.list().length, 0);
  const histFiles = [...deps.fs.files.keys()].filter((p) =>
    p.includes(`${sessionId}.jsonl`),
  );
  assert.deepEqual(histFiles, []);
  const list = lastMsg(deps, "sessionList");
  assert.deepEqual(list?.type === "sessionList" ? list.sessions : null, []);
});

test("M5 result: 落旁挂历史两行 + 索引计数/费用；getHistory 原样回放", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "这篇讲什么" } });
  await tick();
  const sessionId = onlySessionId(deps);
  const opts = deps.spawned[0];
  opts.onEvent({
    kind: "init",
    claudeSessionId: "cli-1",
    model: "m",
    permissionMode: "acceptEdits",
    tools: [],
    mcpServers: [],
  });
  opts.onEvent({
    kind: "assistantMessage",
    content: [{ type: "text", text: "讲的是 Transformer" }],
  });
  opts.onEvent({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0.012,
    durationMs: 100,
    numTurns: 1,
  });
  await tick();
  await tick();
  const rec = deps.store.get(sessionId);
  assert.equal(rec?.messageCount, 2);
  assert.equal(rec?.lastCostUsd, 0.012);
  assert.equal(rec?.claudeSessionId, "cli-1");
  // getHistory 回放（§4.6）
  bridge.dispatch({ source: win, data: { type: "getHistory", sessionId } });
  await tick();
  const hist = lastMsg(deps, "history");
  assert.deepEqual(
    hist?.type === "history" ? hist.messages.map((m) => m.text) : null,
    ["这篇讲什么", "讲的是 Transformer"],
  );
  // 未知会话 → 空数组
  bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: "nope" },
  });
  await tick();
  const empty = lastMsg(deps, "history");
  assert.deepEqual(empty?.type === "history" ? empty.messages : null, []);
});

test("M5 result: assistantMessage 缺失时用 textDelta 累积兜底", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "问" } });
  await tick();
  const opts = deps.spawned[0];
  opts.onEvent({ kind: "messageStart" });
  opts.onEvent({ kind: "textDelta", index: 0, text: "半" });
  opts.onEvent({ kind: "textDelta", index: 0, text: "截也落盘" });
  opts.onEvent({
    kind: "result",
    claudeSessionId: "cli-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  await tick();
  await tick();
  const hist = await deps.store.readHistory(onlySessionId(deps));
  assert.deepEqual(
    hist.map((m) => m.text),
    ["问", "半截也落盘"],
  );
});

test("M5 SESSION_GONE: send 带不存在的 sessionId → error + 推列表让 UI 重绑", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "send", sessionId: "gone-session", text: "在吗" },
  });
  await tick();
  assert.equal(deps.spawned.length, 0);
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "SESSION_GONE");
  assert.equal(
    err?.msg.type === "error" ? err.msg.sessionId : null,
    "gone-session",
  );
  assert.ok(deps.sent.some((s) => s.msg.type === "sessionList"));
});

test("M5 SESSION_GONE: resume 失效的 procError → 判定为 SESSION_GONE 并回 error", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "续接旧会话" } });
  await tick();
  const sessionId = onlySessionId(deps);
  deps.spawned[0].onEvent({
    kind: "procError",
    exitCode: 1,
    stderrTail: "Error: No conversation found with session ID: abc",
  });
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "SESSION_GONE");
  assert.equal(err?.msg.type === "error" ? err.msg.sessionId : null, sessionId);
  // 通用 procError（无失效关键字）不判 SESSION_GONE：错误消息总数不变
  deps.spawned[0].onEvent({
    kind: "procError",
    exitCode: 2,
    stderrTail: "some other failure",
  });
  assert.equal(
    deps.sent.filter(
      (s) => s.msg.type === "error" && s.msg.code === "SESSION_GONE",
    ).length,
    1,
  );
});

test("M5 setPermissionMode: 合法档写索引进下轮 spawn；非法档/未知会话忽略", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "createSession" } });
  await tick();
  const sessionId = onlySessionId(deps);
  bridge.dispatch({
    source: win,
    data: { type: "setPermissionMode", sessionId, mode: "plan" },
  });
  await tick();
  assert.equal(deps.store.get(sessionId)?.permissionMode, "plan");
  bridge.dispatch({
    source: win,
    data: { type: "setPermissionMode", sessionId, mode: "yolo" },
  });
  bridge.dispatch({
    source: win,
    data: { type: "setPermissionMode", sessionId: "nope", mode: "default" },
  });
  await tick();
  assert.equal(deps.store.get(sessionId)?.permissionMode, "plan");
  // 下轮 spawn 生效
  bridge.dispatch({
    source: win,
    data: { type: "send", sessionId, text: "跑" },
  });
  await tick();
  const modeIdx = deps.spawned[0].args.indexOf("--permission-mode");
  assert.equal(deps.spawned[0].args[modeIdx + 1], "plan");
});

test("M5 重启模拟：新宿主 + 同一份数据文件 → 会话仍在、历史回放、续接带 --resume", async () => {
  // 第一段生命周期：建会话 → 一轮对话 → result
  const deps1 = makeDeps();
  const bridge1 = createHostBridge(deps1);
  const win1 = makeWin();
  helloHandshake(deps1, bridge1, win1);
  await tick();
  bridge1.dispatch({
    source: win1,
    data: { type: "send", text: "第一轮问题" },
  });
  await tick();
  const sessionId = onlySessionId(deps1);
  deps1.spawned[0].onEvent({
    kind: "init",
    claudeSessionId: "cli-persist-1",
    model: "m",
    permissionMode: "acceptEdits",
    tools: [],
    mcpServers: [],
  });
  deps1.spawned[0].onEvent({
    kind: "assistantMessage",
    content: [{ type: "text", text: "第一轮回答" }],
  });
  deps1.spawned[0].onEvent({
    kind: "result",
    claudeSessionId: "cli-persist-1",
    costUsd: 0.001,
    durationMs: 10,
    numTurns: 1,
  });
  await tick();
  await tick();
  await deps1.store.flush();
  const onDisk = Object.fromEntries(deps1.fs.files); // 数据目录内容 = 落盘现场

  // 第二段生命周期（等价于重启 Zotero）：全新 bridge + 全新 store，喂同一份文件
  const deps2 = makeDeps();
  const restarted = makeStore(onDisk);
  deps2.store = restarted.store;
  deps2.sessions = restarted.store;
  deps2.fs = restarted.fs;
  const bridge2 = createHostBridge(deps2);
  const win2 = makeWin();
  helloHandshake(deps2, bridge2, win2);
  await tick();
  // 会话仍在（sessionList 给 UI 重建列表 → UI 绑定该会话）
  const list = lastMsg(deps2, "sessionList");
  const sessions = list?.type === "sessionList" ? list.sessions : [];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].claudeSessionId, "cli-persist-1");
  // 历史回放（UI 重建消息列表）
  bridge2.dispatch({ source: win2, data: { type: "getHistory", sessionId } });
  await tick();
  const hist = lastMsg(deps2, "history");
  assert.deepEqual(
    hist?.type === "history" ? hist.messages.map((m) => m.text) : null,
    ["第一轮问题", "第一轮回答"],
  );
  // 续接：第二轮 spawn 带 --resume <上一轮 claudeSessionId>
  bridge2.dispatch({
    source: win2,
    data: { type: "send", sessionId, text: "第二轮问题" },
  });
  await tick();
  assert.equal(deps2.spawned.length, 1);
  const args = deps2.spawned[0].args;
  const resumeIdx = args.indexOf("--resume");
  assert.ok(resumeIdx >= 0, "--resume 缺失");
  assert.equal(args[resumeIdx + 1], "cli-persist-1");
  // 续接轮结束后历史累积为四条（两轮）
  deps2.spawned[0].onEvent({
    kind: "assistantMessage",
    content: [{ type: "text", text: "第二轮回答" }],
  });
  deps2.spawned[0].onEvent({
    kind: "result",
    claudeSessionId: "cli-persist-1",
    costUsd: 0.002,
    durationMs: 10,
    numTurns: 1,
  });
  await tick();
  await tick();
  const grown = await restarted.store.readHistory(sessionId);
  assert.deepEqual(
    grown.map((m) => m.text),
    ["第一轮问题", "第一轮回答", "第二轮问题", "第二轮回答"],
  );
  assert.equal(restarted.store.get(sessionId)?.messageCount, 4);
});

test("M5 索引损坏：hello 时告知重置 + 会话列表为空", async () => {
  const deps = makeDeps();
  const broken = makeStore({
    "/data/claudian/sessions.json": '{"version":1,"sessions":[{"id"',
  });
  deps.store = broken.store;
  deps.sessions = broken.store;
  deps.fs = broken.fs;
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  await tick();
  const err = deps.sent.filter((s) => s.msg.type === "error").pop();
  assert.equal(err?.msg.type === "error" && err.msg.code, "SESSION_GONE");
  const list = lastMsg(deps, "sessionList");
  assert.deepEqual(list?.type === "sessionList" ? list.sessions : null, []);
});

// ---- 其余消息（回归 + M6/M7 兜底）----

test("hostBridge: getHistory → 空 messages 数组（未知 id / 无文件）", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "getHistory", sessionId: "nope" },
  });
  await tick();
  const hist = lastMsg(deps, "history");
  assert.ok(hist);
  assert.deepEqual(hist.type === "history" ? hist.messages : null, []);
});

test("hostBridge: openExternal → http/https 调 launchURL，其余忽略", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "openExternal", url: "https://www.zotero.org" },
  });
  bridge.dispatch({
    source: win,
    data: { type: "openExternal", url: "http://example.com/a?b=1" },
  });
  bridge.dispatch({
    source: win,
    data: { type: "openExternal", url: "javascript:alert(1)" },
  });
  bridge.dispatch({
    source: win,
    data: { type: "openExternal", url: "file:///etc/passwd" },
  });
  bridge.dispatch({ source: win, data: { type: "openExternal", url: 42 } });
  assert.deepEqual(deps.launched, [
    "https://www.zotero.org",
    "http://example.com/a?b=1",
  ]);
});

test("hostBridge: broadcast 多实例同收；unregister 后不再收", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const w1 = makeWin();
  const w2 = makeWin();
  helloHandshake(deps, bridge, w1);
  helloHandshake(deps, bridge, w2);
  await tick();
  const before = deps.sent.length;
  bridge.broadcast({ type: "error", code: "SPAWN_FAILED", message: "x" });
  assert.equal(deps.sent.length - before, 2);
  assert.ok(deps.sent.slice(before).every((s) => s.win === w1 || s.win === w2));
  bridge.unregister(w1);
  const before2 = deps.sent.length;
  bridge.broadcast({ type: "error", code: "SPAWN_FAILED", message: "y" });
  assert.equal(deps.sent.length - before2, 1);
});

test("hostBridge: hello 超时 → log error、实例保持未注册", async () => {
  const logs: string[] = [];
  const deps = makeDeps({ helloTimeoutMs: 10 });
  deps.log = (m) => logs.push(m);
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(logs.some((m) => m.includes("hello timeout")));
  // 超时后 hello 不被接受
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  assert.ok(!deps.sent.some((s) => s.msg.type === "sessionList"));
});

// ---- M7 笔记（§4.3）：桥只做形态校验与回包，写库在 notes.ts ----

test("hostBridge: saveNote mode=new → 原样转发 notes.saveNote，回 noteSaved{ok,noteKey}", async () => {
  const calls: unknown[] = [];
  const deps = makeDeps({
    notes: {
      saveNote: async (input) => {
        calls.push(input);
        return { ok: true, noteKey: "NOTE1" };
      },
      listNotes: async () => ({ ok: true, notes: [] }),
    },
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "saveNote", itemKey: "ITEM1", mode: "new", html: "<p>x</p>" },
  });
  await tick();
  assert.deepEqual(calls, [
    { itemKey: "ITEM1", mode: "new", html: "<p>x</p>" },
  ]);
  const saved = lastMsg(deps, "noteSaved");
  assert.ok(saved && saved.type === "noteSaved");
  assert.equal(saved.ok, true);
  assert.equal(saved.type === "noteSaved" ? saved.noteKey : null, "NOTE1");
});

test("hostBridge: saveNote mode=append → 带 noteKey 转发；失败码原样回包", async () => {
  const calls: unknown[] = [];
  const deps = makeDeps({
    notes: {
      saveNote: async (input) => {
        calls.push(input);
        return { ok: false, code: "NOTE_NOT_FOUND", message: "无此笔记" };
      },
      listNotes: async () => ({ ok: true, notes: [] }),
    },
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "saveNote",
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N9",
      html: "<p>追加</p>",
    },
  });
  await tick();
  assert.deepEqual(calls, [
    { itemKey: "ITEM1", mode: "append", noteKey: "N9", html: "<p>追加</p>" },
  ]);
  const saved = lastMsg(deps, "noteSaved");
  assert.ok(saved && saved.type === "noteSaved" && saved.ok === false);
  assert.equal(
    saved.type === "noteSaved" ? saved.code : null,
    "NOTE_NOT_FOUND",
  );
});

test("hostBridge: saveNote 非法 mode → 忽略（不回包，不调 notes）", async () => {
  let called = 0;
  const logs: string[] = [];
  const deps = makeDeps({
    log: (m) => logs.push(m),
    notes: {
      saveNote: async () => {
        called++;
        return { ok: true, noteKey: "N" };
      },
      listNotes: async () => ({ ok: true, notes: [] }),
    },
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: {
      type: "saveNote",
      itemKey: "ITEM1",
      mode: "delete",
      html: "<p>x</p>",
    },
  });
  await tick();
  assert.equal(called, 0);
  assert.equal(lastMsg(deps, "noteSaved"), undefined);
  assert.ok(logs.some((m) => m.includes("invalid mode")));
});

test("hostBridge: saveNote/listNotes 未接线 → 明确失败回包（UI 不悬挂）", async () => {
  const deps = makeDeps(); // 无 notes 注入
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "saveNote", itemKey: "ITEM1", mode: "new", html: "<p>x</p>" },
  });
  bridge.dispatch({
    source: win,
    data: { type: "listNotes", itemKey: "ITEM1" },
  });
  await tick();
  const saved = lastMsg(deps, "noteSaved");
  assert.ok(saved && saved.type === "noteSaved" && saved.ok === false);
  const err = lastMsg(deps, "error");
  assert.ok(err && err.type === "error" && err.code === "SAVE_FAILED");
});

test("hostBridge: listNotes → noteList 清单；失败 → error 带错误码", async () => {
  let fail = false;
  const deps = makeDeps({
    notes: {
      saveNote: async () => ({ ok: true, noteKey: "N" }),
      listNotes: async () =>
        fail
          ? { ok: false, code: "ITEM_NOT_FOUND", message: "条目不存在：X" }
          : {
              ok: true,
              notes: [{ noteKey: "N1", title: "标题", updatedAt: 1 }],
            },
    },
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "listNotes", itemKey: "ITEM1" },
  });
  await tick();
  const list = lastMsg(deps, "noteList");
  assert.ok(list && list.type === "noteList");
  assert.deepEqual(list.type === "noteList" ? list.notes : null, [
    { noteKey: "N1", title: "标题", updatedAt: 1 },
  ]);
  fail = true;
  bridge.dispatch({ source: win, data: { type: "listNotes", itemKey: "X" } });
  await tick();
  const err = lastMsg(deps, "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.type === "error" ? err.code : null, "ITEM_NOT_FOUND");
});

test("hostBridge: 完全未知 type → 忽略 + debug log，不崩", async () => {
  const logs: string[] = [];
  const deps = makeDeps();
  deps.log = (m) => logs.push(m);
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "futureMessage" } });
  assert.ok(logs.some((m) => m.includes("futureMessage")));
});

test("hostBridge: permissionResponse 缺 requestId/未知 requestId → 忽略 + log（M6 非法输入契约）", async () => {
  const logs: string[] = [];
  const deps = makeDeps();
  deps.log = (m) => logs.push(m);
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "permissionResponse" } });
  assert.ok(logs.some((m) => m.includes("missing requestId")));
  bridge.dispatch({
    source: win,
    data: { type: "permissionResponse", requestId: "nope", allow: true },
  });
  assert.ok(logs.some((m) => m.includes("unknown/expired requestId")));
});

test("hostBridge: hello 注册后广播 readerContext（宿主→UI 表）", async () => {
  const deps = makeDeps();
  deps.buildReaderContext = async () => ({
    type: "readerContext",
    itemKey: "ITEM1",
    title: "T",
    page: 3,
    selection: "s",
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  const ctx = lastMsg(deps, "readerContext");
  assert.ok(ctx);
});

// ---- M9：CLI 检测横幅（hello 注册后按状态推 error）----

test("m9: hello 注册时 CLI 状态非 ok → 推 error 横幅（code/message 原样）", async () => {
  const deps = makeDeps({
    getCliStatus: () => ({
      ok: false,
      code: "CLAUDE_NOT_FOUND",
      message: "未找到 claude 命令。请安装 Claude Code（https://x）",
    }),
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  const err = deps.sent.find((s) => s.msg.type === "error")?.msg;
  assert.ok(err, "应推出一条 error");
  assert.equal(err.type === "error" ? err.code : null, "CLAUDE_NOT_FOUND");
  assert.ok(
    String(err.type === "error" ? err.message : "").includes("安装"),
    "横幅文案应带安装引导",
  );
  // sessionList 照常回发（横幅不替换列表）
  assert.ok(lastMsg(deps, "sessionList"));
});

test("m9: hello 注册时 CLI 状态 ok / null → 不推横幅", async () => {
  for (const status of [{ ok: true, code: null, message: "" }, null]) {
    const deps = makeDeps({ getCliStatus: () => status });
    const bridge = createHostBridge(deps);
    helloHandshake(deps, bridge, makeWin());
    await tick();
    assert.equal(
      deps.sent.filter((s) => s.msg.type === "error").length,
      0,
      `status=${JSON.stringify(status)} 不该推 error`,
    );
  }
});

test("hostBridge: spawn 基础带 channel='cmd' → 透传进 spawnTurn（win32 .cmd 包装的接线点，BUG-32）", async () => {
  const deps = makeDeps();
  deps.getSpawnBase = async () => ({
    command: "C:\\npm\\claude.cmd",
    channel: "cmd",
    environment: { PATH: "C:\\npm" },
    environmentAppend: true,
  });
  const bridge = createHostBridge(deps);
  const win = makeWin();
  helloHandshake(deps, bridge, win);
  await tick();
  bridge.dispatch({ source: win, data: { type: "send", text: "跑一轮" } });
  await tick();
  assert.equal(deps.spawned.length, 1);
  assert.equal(
    deps.spawned[0].channel,
    "cmd",
    "channel 丢失 = .cmd 直交 CreateProcess，Windows 用户只会看到「CLI 进程异常退出」",
  );
  assert.equal(deps.spawned[0].command, "C:\\npm\\claude.cmd");
});
