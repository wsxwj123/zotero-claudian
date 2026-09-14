// 单测 — R14 过程块落盘与回放（现象 3）：JSONL 带 blocks、回放重建条带
//
// 契约来源：.devflow/PLAN-R14.md §4.1（HistoryRecord 新增可选 `blocks?`；旧文件照读；非法形态降级为
// 「无 blocks」且**恰好三个键**）；用例清单来源：§7 的 T8/T9/T10/T10b/T14。
// 写侧走宿主桥的既有 fake 链路（makeProbeStore + fake spawnTurn），读侧直接调契约函数
// parseHistoryJsonl / formatHistoryRecord 与 reducer —— 不测任何夹具副本。
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
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import {
  buildRenderItems,
  stripSummary,
} from "../../src/chat/lib/roundStrip.ts";
import { parseHistoryJsonl } from "../../src/utils/sessionStore.ts";
import { HISTORY, makeProbeStore } from "./helpers/probeFs.ts";

/** R14 §4.1 的约定上限（T10b 的口径：32 KB/轮 × 50 轮 ≈ 1.6 MB） */
const PER_TURN_CAP = 32 * 1024;

async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeTurn() {
  let releaseExit: () => void = () => {};
  const turn = {
    killed: false,
    options: null as SpawnTurnOptions | null,
    emit: (ev: TurnEvent) => turn.options?.onEvent(ev),
    kill() {
      turn.killed = true;
    },
    exitPromise: new Promise<void>((r) => {
      releaseExit = () => r();
    }),
    releaseExit: () => releaseExit(),
  };
  return turn;
}

function makeDeps() {
  const sent: { win: object; msg: HostMessage }[] = [];
  const memory = makeProbeStore();
  const turns: ReturnType<typeof makeTurn>[] = [];
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    store: typeof memory.store;
    fs: typeof memory.fs;
    turns: ReturnType<typeof makeTurn>[];
  } = {
    sent,
    store: memory.store,
    fs: memory.fs,
    turns,
    post: (win, msg) => sent.push({ win, msg }),
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
      const t = makeTurn();
      t.options = options;
      turns.push(t);
      return { kill: () => t.kill(), exitPromise: t.exitPromise };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async () => ({ libraryID: 1, title: "论文一" }),
  };
  return deps;
}

type Deps = ReturnType<typeof makeDeps>;

/** 起一轮并跑到底（含宿主落盘），返回会话 id 与那轮的 fake turn */
async function runTurn(
  deps: Deps,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text: string,
  events: TurnEvent[],
): Promise<{ sid: string; turn: ReturnType<typeof makeTurn> }> {
  bridge.dispatch({ source: win, data: { type: "send", text } });
  await tick();
  const sid = deps.store.list()[0].id;
  const turn = deps.turns[deps.turns.length - 1];
  for (const ev of events) {
    turn.emit(ev);
  }
  await tick();
  return { sid, turn };
}

const apply = (state: ChatState, msg: HostMessage): ChatState =>
  reduceHostMessage(state, msg);

/** UI 视图：握手 → 会话列表 → 绑定到该会话 */
function bootUi(deps: Deps, sid: string): ChatState {
  let s = apply(initialChatState(), { type: "init" });
  s = apply(s, {
    type: "sessionList",
    sessions: deps.store.list(),
  } as unknown as HostMessage);
  return {
    ...s,
    sessionId: sid,
    messages: [],
    turnStatus: "idle" as const,
  };
}

/** 把落盘行喂回 UI（宿主 getHistory 的真实载荷形态） */
const replay = (state: ChatState, sid: string, rows: unknown[]): ChatState =>
  apply(state, {
    type: "history",
    sessionId: sid,
    messages: rows,
  } as unknown as HostMessage);

const stripsOf = (s: ChatState) =>
  buildRenderItems(s.messages).filter(
    (i) => i.kind === "strip" && stripSummary(i.round!) !== null,
  );

const assistantItems = (s: ChatState) =>
  buildRenderItems(s.messages).filter(
    (i) => i.kind === "turn" && i.key.startsWith("a"),
  );

const blocksOfRow = (row: unknown): unknown[] | undefined =>
  (row as { blocks?: unknown } | undefined)?.blocks as unknown[] | undefined;

const RESULT = {
  kind: "result",
  claudeSessionId: "cli-1",
  numTurns: 1,
  costUsd: 0.01,
  durationMs: 3000,
  isError: false,
} as TurnEvent;

// ---------- T8：现象 3（过程块落盘 → 回放有条带） ----------

test("T8 🔴 一轮含 1 思考 + 1 工具：落盘行带 blocks，回放后条带仍在", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, "tok-r14");
  bridge.dispatch({ source: win, data: { type: "hello", token: "tok-r14" } });
  await tick();

  const events: TurnEvent[] = [
    { kind: "init", model: "opus", permissionMode: "default" } as TurnEvent,
    { kind: "messageStart" } as TurnEvent,
    {
      kind: "thinkingDelta",
      index: 0,
      text: "先看看这篇文章讲了什么",
    } as TurnEvent,
    {
      kind: "toolBlockStart",
      index: 1,
      toolName: "Read",
      toolUseId: "tu1",
    } as TurnEvent,
    {
      kind: "toolInputDelta",
      index: 1,
      jsonFragment: '{"file":"a.pdf"}',
    } as TurnEvent,
    { kind: "textBlockStart", index: 2 } as TurnEvent,
    { kind: "textDelta", index: 2, text: "这篇文章的核心是" } as TurnEvent,
    RESULT,
  ];
  const { sid } = await runTurn(
    deps,
    bridge,
    win,
    "这篇文章的核心是什么？",
    events,
  );

  const rows = await deps.store.readHistory(sid);
  assert.equal(rows.length, 2, "一轮落两行（user / assistant）");
  const blocks = blocksOfRow(rows[1]);
  assert.ok(
    Array.isArray(blocks),
    "assistant 行必须带 blocks（修前整行只有 role/text/ts）",
  );
  assert.deepEqual(
    (blocks as { blockType?: unknown }[]).map((b) => b.blockType),
    ["thinking", "tool"],
    "过程块按流式顺序落盘",
  );

  const s = replay(bootUi(deps, sid), sid, rows);
  assert.equal(stripsOf(s).length, 1, "回放后仍有 1 条条带");
  assert.notEqual(stripSummary(stripsOf(s)[0].round!), null, "条带摘要有内容");
});

// ---------- T9：旧格式与非法 blocks 的兼容 ----------

test("T9 🔒 旧格式 / 非法 blocks：恰好三个键、不跳行、回放 0 条带", () => {
  const raw = [
    '{"role":"user","text":"旧问题","ts":1}',
    '{"role":"assistant","text":"blocks 是字符串","ts":2,"blocks":"不是数组"}',
    '{"role":"assistant","text":"blocks 是 null","ts":3,"blocks":null}',
    '{"role":"assistant","text":"全是畸形块","ts":4,"blocks":[{"foo":1},null,42,"x"]}',
  ].join("\n");

  const recs = parseHistoryJsonl(raw);
  assert.equal(
    recs.length,
    4,
    "非法 blocks 只降级为「无 blocks」，不得跳过整行",
  );
  for (const rec of recs) {
    assert.deepEqual(
      Object.keys(rec).sort(),
      ["role", "text", "ts"],
      "没有合法 blocks 的行必须恰好三个键（写 blocks: undefined 会被 storage 验收的 deepEqual 抓到）",
    );
  }
  assert.deepEqual(recs[0], { role: "user", text: "旧问题", ts: 1 });

  const s = replay(bootUi(makeDeps(), "sH"), "sH", recs);
  assert.equal(
    stripsOf(s).length,
    0,
    "无过程块的老数据回放不出来条带（= 今天的行为）",
  );
  assert.equal(s.messages.length, 4, "四行都要在，行不能被吞");
});

// ---------- T10：单行体积上限 ----------

test("T10 🔴 超长工具入参：落盘行不超上限，截断处留省略标记", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, "tok-r14");
  bridge.dispatch({ source: win, data: { type: "hello", token: "tok-r14" } });
  await tick();

  const HUGE = "x".repeat(200 * 1024);
  const { sid } = await runTurn(deps, bridge, win, "读个大文件", [
    { kind: "messageStart" } as TurnEvent,
    { kind: "thinkingDelta", index: 0, text: "先读文件" } as TurnEvent,
    {
      kind: "toolBlockStart",
      index: 1,
      toolName: "Read",
      toolUseId: "tu1",
    } as TurnEvent,
    {
      kind: "toolInputDelta",
      index: 1,
      jsonFragment: `{"file":"${HUGE}"}`,
    } as TurnEvent,
    { kind: "textDelta", index: 2, text: "看完了" } as TurnEvent,
    RESULT,
  ]);

  const rawFile = deps.fs.files.get(HISTORY(sid)) as string;
  const lines = rawFile.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 2, "两行（user / assistant）");
  const assistantLine = lines.find((l) => l.includes('"assistant"'));
  assert.ok(assistantLine, "assistant 行要在");
  assert.ok(
    assistantLine.length <= PER_TURN_CAP,
    `落盘行 ${assistantLine.length} 字节，超过约定上限 ${PER_TURN_CAP}`,
  );
  assert.ok(assistantLine.includes("…"), "超长内容被截断处要有省略标记");
  const parsed = JSON.parse(assistantLine) as { blocks?: unknown[] };
  assert.ok(Array.isArray(parsed.blocks), "assistant 行仍要带 blocks");
  const tool = (
    parsed.blocks as { blockType?: string; inputJson?: string }[]
  ).find((b) => b.blockType === "tool");
  assert.ok(tool, "工具块要在");
  assert.ok(
    (tool.inputJson ?? "").length < HUGE.length,
    "工具入参确实被截短了（不是整份落盘）",
  );
});

// ---------- T10b：量化红线（1.6 MB 历史解析 < 50 ms） ----------

test("T10b 🔴 1.6 MB（32 KB × 50 轮）历史：解析 < 50 ms 且 blocks 能往返", () => {
  const ROUNDS = 50;
  const payload = "x".repeat(PER_TURN_CAP - 512);
  const lines: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    lines.push(JSON.stringify({ role: "user", text: `第 ${i} 问`, ts: i }));
    lines.push(
      JSON.stringify({
        role: "assistant",
        text: `第 ${i} 答`,
        ts: i,
        blocks: [
          { blockType: "thinking", index: 0, text: "想一下", streaming: false },
          {
            blockType: "tool",
            index: 1,
            toolName: "Read",
            toolUseId: `tu${i}`,
            inputJson: payload,
            result: null,
            streaming: false,
          },
        ],
      }),
    );
  }
  const raw = lines.join("\n") + "\n";
  const sizeMb = Buffer.byteLength(raw) / (1024 * 1024);
  assert.ok(
    sizeMb > 1.4 && sizeMb < 1.8,
    `夹具自检：文件约 1.6 MB（实际 ${sizeMb.toFixed(2)}）`,
  );

  const t0 = performance.now();
  const recs = parseHistoryJsonl(raw);
  const ms = performance.now() - t0;

  assert.equal(recs.length, ROUNDS * 2, "100 行全部解析出来");
  assert.ok(ms < 50, `1.6 MB 解析 ${ms.toFixed(1)} ms，超过 50 ms 红线`);
  // 计时断言在修前也能过（现实现本就够快）——配上「blocks 必须解析回来」才有判别力
  assert.equal(
    recs.filter((r) => Array.isArray(blocksOfRow(r))).length,
    ROUNDS,
    "每轮 assistant 行的 blocks 都要解析回来（修前被整份丢弃）",
  );
});

// ---------- T14：纯工具轮（无 assistant 文本） ----------

test("T14 🔴 纯工具轮：JSONL 有承载 blocks 的 assistant 行，回放不出空气泡", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = {};
  bridge.beginHandshake(win, "tok-r14");
  bridge.dispatch({ source: win, data: { type: "hello", token: "tok-r14" } });
  await tick();

  const { sid } = await runTurn(deps, bridge, win, "帮我读一下附件", [
    { kind: "messageStart" } as TurnEvent,
    {
      kind: "toolBlockStart",
      index: 0,
      toolName: "Read",
      toolUseId: "tu1",
    } as TurnEvent,
    {
      kind: "toolInputDelta",
      index: 0,
      jsonFragment: '{"file":"a.pdf"}',
    } as TurnEvent,
    {
      kind: "toolResult",
      toolUseId: "tu1",
      isError: false,
      summary: "读完了",
    } as TurnEvent,
    RESULT,
  ]);

  const rows = await deps.store.readHistory(sid);
  assert.equal(
    rows.length,
    2,
    "纯工具轮也要落 assistant 行（承载 blocks；修前只有 user 一行）",
  );
  const blocks = blocksOfRow(rows[1]);
  assert.ok(Array.isArray(blocks), "纯工具轮也要有承载 blocks 的 assistant 行");
  assert.equal(
    (blocks as { blockType?: unknown }[]).filter((b) => b.blockType === "tool")
      .length,
    1,
    "工具块要在",
  );

  const s = replay(bootUi(deps, sid), sid, rows);
  assert.equal(
    assistantItems(s).length,
    0,
    "无正文 → 不渲染 assistant 气泡（不出空气泡）",
  );
  assert.equal(stripsOf(s).length, 1, "过程条带恰 1 条");
});
