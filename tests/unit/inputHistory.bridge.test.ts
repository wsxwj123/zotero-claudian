// 单测 — 输入历史（↑/↓ 翻已发送消息）从「面板内存」换到「宿主持久化」的接线。
// 页面侧：写经桥出去（createBridgeHistoryStorage）、载入经宿主回推（inputHistory 消息 →
// ChatState → mergeHostEntries → ↑ 能翻）；宿主侧：桥只做形态校验与转发，落盘在 inputHistoryStore。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHistoryKey,
  createBridgeHistoryStorage,
  emptyInputHistory,
  historyForSession,
  mergeHostEntries,
  recordSent,
  saveInputHistory,
  setDefaultHistoryStorage,
  type HistoryKeyEvent,
} from "../../src/chat/lib/inputHistory.ts";
import {
  initialChatState,
  reduceHostMessage,
} from "../../src/chat/lib/chatModel.ts";
import {
  createHostBridge,
  type HostBridgeDeps,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type { HostMessage, UiMessage } from "../../src/chat/lib/types.ts";
import type { InputHistoryStore } from "../../src/modules/inputHistoryStore.ts";
import type {
  SpawnTurnOptions,
  TurnHandle,
} from "../../src/modules/cliRunner.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const TOKEN = "tok-hist";

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** ↑ 键（无修饰键、非 IME、无选区；单行文本里既是首行也是末行） */
function key(k: string): HistoryKeyEvent {
  return {
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
  };
}

// ---------- 页面侧：写经桥、载入经宿主回推 ----------

test("页面侧：桥存储把发送的历史写成 saveInputHistory（键→会话 id 反解）", () => {
  const sent: UiMessage[] = [];
  const storage = createBridgeHistoryStorage((msg) => sent.push(msg));
  saveInputHistory(
    "S1",
    recordSent(emptyInputHistory(), "第一个问题"),
    storage,
  );
  saveInputHistory(
    "S2",
    recordSent(emptyInputHistory(), "第二个问题"),
    storage,
  );
  assert.deepEqual(sent, [
    { type: "saveInputHistory", sessionId: "S1", entries: ["第一个问题"] },
    { type: "saveInputHistory", sessionId: "S2", entries: ["第二个问题"] },
  ]);
  // 读回本页面已知的那份（缓存）
  assert.equal(
    storage.getItem("zotero-claudian.input-history.S1"),
    JSON.stringify(["第一个问题"]),
  );
  assert.equal(storage.getItem("zotero-claudian.input-history.S9"), null);
});

test("页面侧：未绑定会话（none 桶）/非本模块键 / 坏值 → 不发消息也不抛", () => {
  const sent: UiMessage[] = [];
  const storage = createBridgeHistoryStorage((msg) => sent.push(msg));
  assert.doesNotThrow(() => {
    saveInputHistory(null, recordSent(emptyInputHistory(), "没会话"), storage);
    storage.setItem("别人的键", "[]");
    storage.setItem("zotero-claudian.input-history.S1", "{不是 JSON");
  });
  assert.deepEqual(sent, []);
});

test("页面侧：宿主历史到达（面板重载后）→ ↑ 能翻到旧消息（主诉求）", () => {
  // 重载后的全新页面：桶是空的
  let state = initialChatState();
  state = { ...state, sessionId: "S1" };
  state = reduceHostMessage(state, {
    type: "inputHistory",
    sessionId: "S1",
    entries: ["重载前发的第一问", "重载前发的第二问"],
  });
  assert.deepEqual(state.inputHistory, {
    sessionId: "S1",
    entries: ["重载前发的第一问", "重载前发的第二问"],
  });
  // InputBox 渲染期做的事：换桶 + 并入宿主历史 → ↑ 翻出最新一条、再 ↑ 翻到更早一条
  let bucket = historyForSession(null, "S1", null);
  assert.deepEqual(bucket.h.entries, []);
  bucket = mergeHostEntries(bucket, state.inputHistory?.entries);
  const up1 = applyHistoryKey(
    key("ArrowUp"),
    "",
    { start: 0, end: 0 },
    bucket.h,
  );
  assert.ok(up1);
  assert.equal(up1.text, "重载前发的第二问");
  const up2 = applyHistoryKey(
    key("ArrowUp"),
    up1.text,
    { start: 6, end: 6 },
    up1.history,
  );
  assert.ok(up2);
  assert.equal(up2.text, "重载前发的第一问");
});

test("页面侧：并入宿主历史——本地新发的接在后面，重复并入幂等、不翻倍", () => {
  const local: { sid: string | null; h: ReturnType<typeof recordSent> } = {
    sid: "S1",
    h: recordSent(recordSent(emptyInputHistory(), "旧一"), "本页面新发的"),
  };
  const once = mergeHostEntries(local, ["旧一", "旧二"]);
  assert.deepEqual(once.h.entries, ["旧一", "旧二", "本页面新发的"]);
  const twice = mergeHostEntries(once, ["旧一", "旧二"]);
  assert.equal(twice, once, "内容不变应返回原对象（渲染期反复调用不自激）");
  // 用户在翻历史（cursor 非空）→ 不动
  const navigating = { sid: "S1", h: { ...once.h, cursor: 0, draft: "草稿" } };
  assert.equal(mergeHostEntries(navigating, ["另一份"]), navigating);
  // 宿主回空/坏数据 → 本地照旧
  assert.equal(mergeHostEntries(once, []), once);
  assert.equal(mergeHostEntries(once, "坏形态"), once);
});

test("复查修-7 页面侧：本地是旧残份 + 宿主头部被上限挤掉 → 并入不重复、最新仍在末尾", () => {
  // 本地（另一实例的旧副本）：从 a 开头，没有宿主后来才有的 d/e；
  // 宿主那份已被 50 条上限挤掉了 a。逐条前缀对齐会拼成 [b,c,d,e,a,b,c,f]（重复 + 最新排中间）
  const local = {
    sid: "S1",
    h: { entries: ["a", "b", "c", "f"], cursor: null, draft: "" },
  };
  const merged = mergeHostEntries(local, ["b", "c", "d", "e"]);
  assert.deepEqual(merged.h.entries, ["b", "c", "d", "e", "f"]);
  // 同一份宿主快照再并一次 → 内容不变，返回原对象（渲染期反复调用不自激）
  assert.equal(mergeHostEntries(merged, ["b", "c", "d", "e"]), merged);
});

test("页面侧：inputHistory 归约——只管当前绑定会话，缺 id/坏 entries 不崩", () => {
  const base = { ...initialChatState(), sessionId: "S1" };
  const other = reduceHostMessage(base, {
    type: "inputHistory",
    sessionId: "S2",
    entries: ["别人的"],
  });
  assert.equal(other, base, "他方会话的回推不落到本视图");
  const noId = reduceHostMessage(base, {
    type: "inputHistory",
    sessionId: "",
    entries: ["x"],
  });
  assert.equal(noId, base, "缺 sessionId 无处可分桶 → 忽略");
  const bad = reduceHostMessage(base, {
    type: "inputHistory",
    sessionId: "S1",
    entries: [1, "好的", null] as unknown as string[],
  });
  assert.deepEqual(bad.inputHistory, { sessionId: "S1", entries: ["好的"] });
});

test("页面侧：saveInputHistory 走注入的默认存储（App doSend 的真实路径）", () => {
  const sent: UiMessage[] = [];
  setDefaultHistoryStorage(createBridgeHistoryStorage((msg) => sent.push(msg)));
  try {
    // App 的 doSend：recordSent 后调 saveInputHistory（不传 storage → 用默认的）
    const h = recordSent(recordSent(emptyInputHistory(), "一"), "二");
    saveInputHistory("S1", h);
    assert.deepEqual(sent, [
      { type: "saveInputHistory", sessionId: "S1", entries: ["一", "二"] },
    ]);
  } finally {
    setDefaultHistoryStorage(null); // 别把默认存储泄给同进程的其它用例
  }
});

// ---------- 宿主侧：桥只做校验与转发 ----------

function makeDeps(overrides: Partial<HostBridgeDeps> = {}) {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeStore();
  const deps: HostBridgeDeps & { sent: typeof sent } = {
    sent,
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: () => {},
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
    getMcpEndpoint: () => ({ port: 51000, token: "t" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (_options: SpawnTurnOptions): TurnHandle => ({
      kill: () => {},
      exitPromise: Promise.resolve(),
    }),
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async () => null,
    ...overrides,
  };
  return deps;
}

/** 假 inputHistory store：只记调用、回预设值 */
function fakeInputHistory(initial: Record<string, string[]> = {}): {
  store: InputHistoryStore;
  saved: { sessionId: string; entries: unknown }[];
} {
  const saved: { sessionId: string; entries: unknown }[] = [];
  return {
    saved,
    store: {
      get: async (sid: string) => initial[sid] ?? [],
      save: async (sid: string, entries: unknown) => {
        saved.push({ sessionId: sid, entries });
      },
      flush: async () => {},
    },
  };
}

function register(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
}

test("宿主桥：saveInputHistory → 交给 store 落盘（条目形态原样传，归一在 store 内）", async () => {
  const fake = fakeInputHistory();
  const deps = makeDeps({ inputHistory: fake.store });
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "saveInputHistory", sessionId: "S1", entries: ["一", "二"] },
  });
  await tick();
  assert.deepEqual(fake.saved, [{ sessionId: "S1", entries: ["一", "二"] }]);
  // 缺 sessionId → 忽略（无处可归）
  bridge.dispatch({
    source: win,
    data: { type: "saveInputHistory", entries: ["x"] },
  });
  await tick();
  assert.equal(fake.saved.length, 1);
});

test("宿主桥：getInputHistory → 回 inputHistory{sessionId,entries}；未接线 → 空数组不崩", async () => {
  const fake = fakeInputHistory({ S1: ["旧一", "旧二"] });
  const deps = makeDeps({ inputHistory: fake.store });
  const bridge = createHostBridge(deps);
  const win = {};
  register(deps, bridge, win);
  await tick();
  deps.sent.length = 0;
  bridge.dispatch({
    source: win,
    data: { type: "getInputHistory", sessionId: "S1" },
  });
  await tick();
  const reply = deps.sent
    .map((s) => s.msg)
    .filter((m) => m.type === "inputHistory");
  assert.deepEqual(reply, [
    { type: "inputHistory", sessionId: "S1", entries: ["旧一", "旧二"] },
  ]);

  // 未接线（老宿主/测试环境）：回空数组，UI 退化为内存历史
  const noStore = makeDeps();
  const bridge2 = createHostBridge(noStore);
  register(noStore, bridge2, win);
  await tick();
  noStore.sent.length = 0;
  bridge2.dispatch({
    source: win,
    data: { type: "getInputHistory", sessionId: "S1" },
  });
  await tick();
  assert.deepEqual(
    noStore.sent.map((s) => s.msg).filter((m) => m.type === "inputHistory"),
    [{ type: "inputHistory", sessionId: "S1", entries: [] }],
  );
  bridge2.dispatch({
    source: win,
    data: { type: "saveInputHistory", sessionId: "S1", entries: ["x"] },
  });
  await tick(); // 不炸即可
});
