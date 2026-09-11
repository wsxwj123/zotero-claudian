// 单测 — R7-H「turn 0（第一条消息）」边界：不 fork、零 journal、零文件替换、零 resume。
//
// 现象（真机定位）：每轮快照里 `0.jsonl` 是**空文件**（会话开始之前），CLI 无法 resume 空会话
// 文件 → 分叉进程在 init 前退出 → REWIND 失败（原文已还原、无数据损失，但「编辑自己第一条
// 消息」整个用不了）。
// 口径：turn 0 前面没有任何历史，也不需要 fork —— 完全绕开回滚编排：新建一个**全新会话**
//（forkFrom = null，全新 CLI 会话），把文本作为它的首轮发出；原会话原封不动保留。
//   ① 编辑第一条用户消息（UI 发 turn 0）→ 首轮文本 = 编辑后的文本
//   ② 第一条消息上点「分支」→ 同样新建会话 + 首轮文本 = 该条原文（父会话历史里第一条用户
//      消息）。UI 载荷不变（branchSession turn = 快照 k，验收锁定）：宿主按 messageIndex 0
//      认出「这条在会话最前」→ 分叉点 = 空历史 → 重放；显式 turn 0 的分支请求同路
//   ③ turn ≥ 1 对照 → 仍走既有分叉（`--resume <父 claudeId> --fork-session`）
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
import {
  REWIND_JOURNAL_FILE,
  encodeProjectDir,
  journalPath,
  snapshotPath,
} from "../../src/utils/rewind.ts";
import {
  snapshotTurnForEdit,
  snapshotTurnForMessage,
} from "../../src/chat/lib/branchActions.ts";

const TOKEN = "tok-turn0";
const DATA = "/data/claudian";
const CWD = "/ws/科学前言";
const PARENT_CLI = "cli-parent-1";
/** 父会话第一轮结束时 CLI 会话文件的内容（= 快照 1 的内容） */
const TURN1_JSONL = '{"type":"user","text":"第一问"}\n';
/** 第二轮跑过之后的内容（turn≥1 的回滚要把文件替换掉再还原成它，逐字节） */
const TURN2_JSONL = `${TURN1_JSONL}{"type":"user","text":"第二问"}\n`;

/** CLI 自己的会话文件落点（与 sections.ts 的真实实现同形：cwd 派生项目目录） */
const cliPath = (id: string): string =>
  `/home/u/.claude/projects/${encodeProjectDir(CWD)}/${id}.jsonl`;

/** RewindFs 同形内存 fs + 操作留痕（「零 journal / 零替换」的探针） */
function makeRewindFs() {
  const files = new Map<string, string>();
  const ops: string[] = [];
  return {
    files,
    ops,
    async readText(path: string): Promise<string | null> {
      ops.push(`read ${path}`);
      return files.has(path) ? (files.get(path) as string) : null;
    },
    async writeText(path: string, data: string): Promise<void> {
      ops.push(`write ${path}`);
      files.set(path, data);
    },
    async listNames(dir: string): Promise<string[]> {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
    async makeDir(path: string): Promise<void> {
      ops.push(`mkdir ${path}`);
    },
    async remove(path: string): Promise<void> {
      ops.push(`remove ${path}`);
      files.delete(path);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
    join: (...seg: string[]): string => seg.join("/"),
  };
}

function initEvent(claudeSessionId: string): TurnEvent {
  return {
    kind: "init",
    claudeSessionId,
    model: "m",
    permissionMode: "acceptEdits",
    tools: [],
    mcpServers: [],
  };
}

function resultEvent(claudeSessionId: string): TurnEvent {
  return {
    kind: "result",
    claudeSessionId,
    costUsd: 0.01,
    durationMs: 1,
    numTurns: 1,
  };
}

/** 让挂起的整条异步链路（store 落盘队列 / 快照 / sessionList）跑完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeDeps() {
  const sent: { win: object; msg: HostMessage }[] = [];
  const spawned: SpawnTurnOptions[] = [];
  const memory = makeStore();
  const rewindFs = makeRewindFs();
  /** 每次 spawn 要回的 CLI 会话 id（模拟 CLI 的 init；空了就不发 init） */
  const initIds: string[] = [];
  /** 进程退出释放器（队列 = spawn 顺序）：不释放 = 该轮一直「在跑」 */
  const exits: (() => void)[] = [];
  const deps: HostBridgeDeps & {
    sent: typeof sent;
    spawned: SpawnTurnOptions[];
    store: SessionStore;
    rewindFs: ReturnType<typeof makeRewindFs>;
    initIds: string[];
    releaseExit(): void;
  } = {
    sent,
    spawned,
    store: memory.store,
    rewindFs,
    initIds,
    releaseExit: () => exits.shift()?.(),
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: () => {},
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string): Promise<TurnPromptInput> => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: text,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => CWD,
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
      const id = initIds.shift();
      if (id) {
        options.onEvent(initEvent(id));
      }
      return {
        kill: () => {},
        exitPromise: new Promise<void>((resolve) => exits.push(resolve)),
      };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async () => ({ libraryID: 1, title: "一篇论文" }),
    rewind: {
      dataDir: DATA,
      fs: rewindFs,
      projectDirFor: (cwd: string) => encodeProjectDir(cwd),
      claudeSessionPath: (_cwd: string, id: string) => cliPath(id),
    },
  };
  return deps;
}

function makeWin(): object {
  return { __fakeWindow: true };
}

function lastError(deps: ReturnType<typeof makeDeps>): HostMessage | undefined {
  return deps.sent.filter((s) => s.msg.type === "error").pop()?.msg;
}

/** 跑完父会话第一轮：init(父 claudeId) → result（落历史/索引）→ 进程退出（拍快照 1） */
async function runParentFirstTurn(
  deps: ReturnType<typeof makeDeps>,
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
  text: string,
): Promise<void> {
  deps.initIds.push(PARENT_CLI);
  bridge.dispatch({ source: win, data: { type: "send", text } });
  await settle();
  // 真实 CLI 在这一轮里把自己的会话文件写了盘（下一轮快照才能照到内容）
  deps.rewindFs.files.set(cliPath(PARENT_CLI), TURN1_JSONL);
  deps.spawned.at(-1)?.onEvent(resultEvent(PARENT_CLI));
  await settle();
  deps.releaseExit();
  await settle();
}

async function setup() {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await settle();
  await runParentFirstTurn(deps, bridge, win, "第一问");
  const parentId = deps.store.list()[0].id;
  assert.equal(deps.store.list().length, 1);
  assert.equal(deps.store.get(parentId)?.claudeSessionId, PARENT_CLI);
  // 0.jsonl 是**空快照**（会话开始前）—— 就是它让 fork 走不通
  assert.equal(deps.rewindFs.files.get(snapshotPath(DATA, parentId, 0)), "");
  assert.equal(
    deps.rewindFs.files.get(snapshotPath(DATA, parentId, 1)),
    TURN1_JSONL,
  );
  return { deps, bridge, win, parentId };
}

/** turn 0 两条路径的共同断言：全新会话 + 首轮文本 + 零回滚编排 + 原会话原封不动 */
function assertReplayTurn0(
  deps: ReturnType<typeof makeDeps>,
  parentId: string,
  expectedText: string,
): void {
  const fresh = deps.store.list().find((s) => s.id !== parentId);
  assert.ok(fresh, "turn 0 应新建一个会话（不是分叉）");
  assert.equal(fresh.forkFrom ?? null, null, "全新 CLI 会话：不许带 forkFrom");
  assert.equal(fresh.parentId, parentId, "会话列表里仍挂在父下（与分支同形）");
  assert.equal(fresh.branchIndex, 1);

  const opts = deps.spawned.at(-1);
  assert.ok(opts, "应 spawn 首轮");
  assert.ok(
    !opts.args.includes("--fork-session"),
    `turn 0 不许分叉：${opts.args.join(" ")}`,
  );
  assert.ok(
    !opts.args.includes("--resume"),
    `turn 0 不许 resume 空会话：${opts.args.join(" ")}`,
  );
  assert.equal(opts.prompt, expectedText, "首轮文本要原样发出去");

  assert.ok(
    !deps.rewindFs.ops.some((o) => o.includes(REWIND_JOURNAL_FILE)),
    `零 journal：${JSON.stringify(deps.rewindFs.ops)}`,
  );
  assert.ok(
    !deps.rewindFs.ops.some((o) => o.includes(`write ${cliPath(PARENT_CLI)}`)),
    `零文件替换：${JSON.stringify(deps.rewindFs.ops)}`,
  );
  assert.equal(
    deps.rewindFs.files.get(cliPath(PARENT_CLI)),
    TURN1_JSONL,
    "父的 CLI 会话文件一个字节都不许动",
  );
  // 原会话仍在、绑定没变、快照没被动过
  assert.equal(deps.store.get(parentId)?.claudeSessionId, PARENT_CLI);
  assert.equal(
    deps.rewindFs.files.get(snapshotPath(DATA, parentId, 1)),
    TURN1_JSONL,
  );
}

// ---- ① 编辑第一条用户消息 ----

test("R7-H turn 0①：编辑第一条消息 → 全新会话（forkFrom=null）+ 编辑后文本首轮，零 journal / 零替换 / 零 fork", async () => {
  const { deps, bridge, win, parentId } = await setup();
  const before = deps.spawned.length;
  deps.initIds.push("cli-edited-1");
  bridge.dispatch({
    source: win,
    data: {
      type: "editSession",
      sessionId: parentId,
      messageIndex: 0,
      turn: 0,
      text: "改过的第一问",
    },
  });
  await settle();
  assert.equal(deps.spawned.length, before + 1, "只多一次 spawn（新会话首轮）");
  assertReplayTurn0(deps, parentId, "改过的第一问");
});

// ---- ② 第一条消息上点「分支」----

test("R7-H turn 0②：第一条消息上点分支 → 全新会话 + 该条原文首轮（文本从父会话历史取）", async () => {
  const { deps, bridge, win, parentId } = await setup();
  const before = deps.spawned.length;
  deps.initIds.push("cli-replay-1");
  // UI 的真实载荷（branchSession 不带任何 prompt，验收锁定 turn = 快照 k）：宿主按「这条消息
  // 在会话里的位置」判定它是最前一条 → 分叉点 = 空历史 → 重放原文；原文由宿主从历史取
  bridge.dispatch({
    source: win,
    data: {
      type: "branchSession",
      sessionId: parentId,
      messageIndex: 0,
      turn: 1,
    },
  });
  await settle();
  assert.equal(deps.spawned.length, before + 1, "只多一次 spawn（重放首轮）");
  assertReplayTurn0(deps, parentId, "第一问");
});

test("R7-H turn 0②（宿主口径）：turn 0 的分支请求（来路不限）同样走重放", async () => {
  const { deps, bridge, win, parentId } = await setup();
  const before = deps.spawned.length;
  deps.initIds.push("cli-replay-2");
  bridge.dispatch({
    source: win,
    data: { type: "branchSession", sessionId: parentId, turn: 0 },
  });
  await settle();
  assert.equal(deps.spawned.length, before + 1);
  assertReplayTurn0(deps, parentId, "第一问");
});

test("R7-H turn 0②（入口口径）：第一条用户消息——「编辑」是 turn 0（重放），「分支」仍是 turn 1（既有分叉）", () => {
  const MESSAGES = [
    { role: "user", text: "第一问" },
    {
      role: "assistant",
      blocks: [{ blockType: "text", index: 0, text: "第一答" }],
    },
    { role: "user", text: "第二问" },
    {
      role: "assistant",
      blocks: [{ blockType: "text", index: 0, text: "第二答" }],
    },
  ];
  // 编辑走 turn 0（宿主重放，见上两个用例）；分支口径不变（§3.10：第一条消息属于第 1 轮，
  // 快照 1 非空 → fork 得到），两条路口径**不同**是有意的
  assert.equal(snapshotTurnForEdit(MESSAGES, 0), 0);
  assert.equal(snapshotTurnForMessage(MESSAGES, 0), 1);
});

// ---- 拒绝面：读不到原文就不建会话 ----

test("R7-H turn 0：父会话没有历史（读不到第一条消息原文）→ 不建会话、不 spawn、显式报错", async () => {
  const deps = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin();
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await settle();
  const empty = await deps.store.create({ title: "空会话" });
  bridge.dispatch({
    source: win,
    data: { type: "branchSession", sessionId: empty.id, turn: 0 },
  });
  await settle();
  assert.equal(deps.store.list().length, 1, "不建新会话");
  assert.equal(deps.spawned.length, 0, "不 spawn（不拿空文本凑合发一轮）");
  const err = lastError(deps);
  assert.equal(err?.type === "error" && err.code, "REWIND_REFUSED");
});

// ---- ③ 对照：turn ≥ 1 仍走既有分叉 ----

test("R7-H turn ≥1 对照：仍走 fork（--resume <父> --fork-session），文件替换后逐字节还原", async () => {
  const { deps, bridge, win, parentId } = await setup();
  // 父会话又跑了一轮：CLI 文件里现在多了第二问（≠ 快照 1 的内容）
  deps.rewindFs.files.set(cliPath(PARENT_CLI), TURN2_JSONL);

  const before = deps.spawned.length;
  deps.initIds.push("cli-fork-1");
  bridge.dispatch({
    source: win,
    data: {
      type: "editSession",
      sessionId: parentId,
      messageIndex: 2,
      turn: 1,
      text: "改过的第二问",
    },
  });
  await settle();

  assert.equal(deps.spawned.length, before + 1);
  const opts = deps.spawned.at(-1);
  assert.ok(opts);
  const i = opts.args.indexOf("--resume");
  assert.ok(i >= 0, `要 resume 父会话：${opts.args.join(" ")}`);
  assert.equal(opts.args[i + 1], PARENT_CLI);
  assert.ok(
    opts.args.includes("--fork-session"),
    `要有 --fork-session：${opts.args.join(" ")}`,
  );
  assert.equal(opts.prompt, "改过的第二问");

  // 真回滚编排跑过一遍：journal 收尾不残留、父的 CLI 文件还原成**当前**内容（不是快照内容）
  assert.ok(!deps.rewindFs.files.has(journalPath(DATA)), "journal 收尾不残留");
  assert.equal(
    deps.rewindFs.files.get(cliPath(PARENT_CLI)),
    TURN2_JSONL,
    "父的会话文件必须逐字节还原",
  );
  assert.equal(deps.store.get(parentId)?.claudeSessionId, PARENT_CLI);
  // 分叉出来的分支：拿到 CLI 给的新 id、forkFrom 已清（既有口径）
  const branch = deps.store.list().find((s) => s.id !== parentId);
  assert.ok(branch);
  assert.equal(branch.claudeSessionId, "cli-fork-1");
  assert.equal(branch.forkFrom ?? null, null);
  assert.deepEqual(
    deps.rewindFs.files.get(snapshotPath(DATA, branch.id, 0)),
    TURN1_JSONL,
    "分支的 0.jsonl = 父的第 1 轮快照（分叉继承到的起点）",
  );
});

// ---- 老版本残留：索引里带着 turn 0 的 forkFrom 记录 → 按普通首轮处理 ----

test("R7-H turn 0：老版本残留的 forkFrom{turn:0} 记录 → 当普通首轮 spawn（不去 resume 空文件）", async () => {
  const { deps, bridge, win, parentId } = await setup();
  const stale = await deps.store.create({
    title: "老分支",
    parentId,
    branchIndex: 1,
    forkFrom: { sessionId: parentId, turn: 0 },
  });
  deps.initIds.push("cli-stale-1");
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "接着问", sessionId: stale.id },
  });
  await settle();
  const opts = deps.spawned.at(-1);
  assert.ok(opts);
  assert.ok(!opts.args.includes("--fork-session"), "不分叉");
  assert.ok(!opts.args.includes("--resume"), "不 resume");
  assert.ok(
    !deps.rewindFs.ops.some((o) => o.includes(REWIND_JOURNAL_FILE)),
    "不进回滚编排",
  );
});
