// m5-retest —— 修复验证复合场景（真宿主模块 + 真 UI reducer 同进程集成）。
// 每个用例走的是生产代码路径：UI 动作（chatModel）→ 桥消息 → hostBridge → sessionStore（假 fs）
// → 宿主回包 → UI reducer。断言只写契约行为，不写实现细节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProcError } from "../../../src/modules/cliRunner.ts";
import { DATA_DIR, INDEX, makeHarness } from "./fakes.ts";
import type { M5Harness } from "./fakes.ts";
import type { TurnEvent } from "../../../src/modules/cliRunner.ts";

const initEvent = (claudeSessionId: string): TurnEvent => ({
  kind: "init",
  claudeSessionId,
  model: "opus",
  permissionMode: "acceptEdits",
  tools: [],
  mcpServers: [],
});

const answerEvent = (text: string): TurnEvent => ({
  kind: "assistantMessage",
  content: [{ type: "text", text }],
});

const resultEvent = (claudeSessionId: string): TurnEvent => ({
  kind: "result",
  claudeSessionId,
  costUsd: 0,
  durationMs: 10,
  numTurns: 1,
});

const errorsOf = (h: M5Harness, code?: string): { code: string }[] =>
  h.posted.filter(
    (m) => m.type === "error" && (code === undefined || m.code === code),
  ) as unknown as { code: string }[];

/** 发一轮消息并跑完（result + 进程退出），返回该轮 spawn args */
async function completeTurn(
  h: M5Harness,
  text: string,
  claudeSessionId: string,
  answer: string,
): Promise<string[]> {
  const before = h.turns.length;
  h.sendText(text);
  await h.settle();
  assert.equal(h.turns.length, before + 1, `send 未 spawn 进程：${text}`);
  const turn = h.turns[h.turns.length - 1];
  turn.emit(initEvent(claudeSessionId));
  turn.emit(answerEvent(answer));
  turn.emit(resultEvent(claudeSessionId));
  turn.releaseExit();
  await h.settle();
  return turn.args();
}

// ---------- BUG-22：流式中删除当前会话（真机形态） ----------

test("22-I1: 流式中删除当前会话 → 宿主 kill + 索引移除 + 推列表；UI 立即解锁可输入", async () => {
  const h = makeHarness();
  await h.settle();

  h.sendText("第一问");
  await h.settle();
  const s1 = h.uiState().sessionId;
  assert.ok(s1, "首个 send 应自动建会话并绑定");
  assert.equal(h.store.list().length, 1);

  h.turns[0].emit(initEvent("cli-1"));
  h.turns[0].emit({ kind: "messageStart" });
  h.turns[0].emit({ kind: "textDelta", index: 0, text: "流式中…" });
  await h.settle();
  assert.equal(h.uiState().turnStatus, "streaming");
  assert.equal(h.uiState().messages.length, 2);

  // 用户在流式中点「删除 → 确认」
  h.deleteSession(s1 as string);
  await h.settle();

  assert.equal(h.turns[0].killed, true, "宿主未 kill 被删会话的进行中进程");
  assert.deepEqual(h.store.list(), [], "索引未移除已删会话");
  assert.equal(h.uiState().sessionId, null);
  assert.deepEqual(h.uiState().messages, []);
  assert.equal(
    h.uiState().turnStatus,
    "idle",
    "UI 卡在 busy（输入框禁用）——BUG-22 未修",
  );

  // 被杀进程的迟到事件（真机：SIGTERM → procError）到达
  h.turns[0].emit({ kind: "procError", exitCode: null, reason: "SIGTERM" });
  h.turns[0].releaseExit();
  await h.settle();
  assert.equal(
    h.uiState().turnStatus,
    "idle",
    "迟到 procError 把 UI 拉回忙碌态",
  );
  assert.deepEqual(h.store.list(), [], "迟到事件复活了已删会话");

  // 输入确确实实可用：再发一条（无会话 → 自动建新会话）
  h.sendText("删除之后再发");
  await h.settle();
  assert.equal(h.turns.length, 2);
  assert.equal(h.store.list().length, 1);
  assert.notEqual(h.store.list()[0].id, s1);
});

test("22-I2: 流式中删除当前会话（还有别的会话）→ 自动绑到剩余会话，输入可用", async () => {
  const h = makeHarness();
  await h.settle();
  // 会话 A：跑完一轮（有历史）
  await completeTurn(h, "A 的问题", "cli-a", "A 的回答");
  const a = h.uiState().sessionId as string;
  // 会话 B：新建并跑完一轮
  h.createSession();
  await h.settle();
  const b = h.uiState().sessionId as string;
  assert.notEqual(b, a, "新建未换绑到新会话");
  await completeTurn(h, "B 的问题", "cli-b", "B 的回答");

  // 切回 A，在 A 里发一条并在流式中删除 A
  h.selectSession(a);
  await h.settle();
  h.sendText("A 的在途问题");
  await h.settle();
  h.turns[h.turns.length - 1].emit({ kind: "messageStart" });
  await h.settle();
  assert.equal(h.uiState().turnStatus, "streaming");
  const inFlightTurn = h.turns[h.turns.length - 1];

  h.deleteSession(a);
  await h.settle();

  assert.equal(inFlightTurn.killed, true, "被删会话的在跑进程未 kill");
  assert.equal(h.uiState().sessionId, b, "删除后未绑到剩余会话");
  assert.equal(h.uiState().turnStatus, "idle", "输入未解锁");
  assert.deepEqual(
    h.store.list().map((s) => s.id),
    [b],
  );
  // 重绑后视图 = 剩余会话的回放（已删会话在途消息不得残留）
  assert.deepEqual(
    h.uiState().messages.map((m) => m.text),
    ["B 的问题", "B 的回答"],
    "删除后视图未切换到剩余会话的内容",
  );
});

// ---------- BUG-23：流式中新建会话 ----------

test("23-I1: 流式中新建会话 → 视图干净可发；原会话在跑的进程不受影响", async () => {
  const h = makeHarness();
  await h.settle();

  h.sendText("会话1 的问题");
  await h.settle();
  const s1 = h.uiState().sessionId as string;
  h.turns[0].emit({ kind: "messageStart" });
  h.turns[0].emit({ kind: "textDelta", index: 0, text: "会话1 回答中…" });
  await h.settle();

  h.createSession();
  assert.equal(h.uiState().creatingSession, true, "点新建后按钮未进入在途态");
  await h.settle();

  const s2 = h.uiState().sessionId as string;
  assert.notEqual(s2, s1, "新建后未绑定到新会话");
  assert.deepEqual(h.uiState().messages, [], "新会话视图残留旧会话消息");
  assert.equal(h.uiState().turnStatus, "idle");
  assert.equal(h.uiState().creatingSession, false);
  assert.equal(h.turns[0].killed, false, "新建会话把别的会话在跑的进程杀了");

  // 旧会话的迟到流事件不得串进新视图
  h.turns[0].emit({ kind: "textDelta", index: 0, text: "会话1 的迟到内容" });
  await h.settle();
  assert.deepEqual(
    h
      .uiState()
      .messages.map((m) => m.text ?? "")
      .filter((t) => t.includes("迟到")),
    [],
  );

  // 新会话可发，且首轮不带 --resume
  h.sendText("会话2 第一问");
  await h.settle();
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[1].args().includes("--resume"), false);
});

// ---------- BUG-26：切换会话回放即到 + 切换后立即发送 ----------

test("26-I1: 切换会话 → 回放即到；切换后立即发送 → 回放不丢、在途轮保留", async () => {
  const h = makeHarness();
  await h.settle();

  await completeTurn(h, "A1问", "cli-a", "A1答");
  const a = h.uiState().sessionId as string;
  h.createSession();
  await h.settle();
  const b = h.uiState().sessionId as string;
  await completeTurn(h, "B1问", "cli-b", "B1答");

  // 切回 A → 回放即到
  h.selectSession(a);
  assert.deepEqual(h.uiState().messages, [], "切换未先清空视图");
  await h.settle();
  assert.deepEqual(
    h.uiState().messages.map((m) => m.text),
    ["A1问", "A1答"],
    "切过去看不到该会话既有上下文（回放被丢）",
  );

  // 切到 B 后立刻发送（回放还没回来）
  h.selectSession(b);
  h.sendText("B2问");
  assert.equal(h.uiState().turnStatus, "waiting");
  await h.settle();

  assert.deepEqual(
    h.uiState().messages.map((m) => m.text),
    ["B1问", "B1答", "B2问"],
    `切换后立即发送丢了上下文或乐观轮：${JSON.stringify(
      h.uiState().messages.map((m) => m.text),
    )}`,
  );
  // B2 的进程按 B 会话续接（claudeSessionId 未丢）
  const args = h.turns[h.turns.length - 1].args();
  assert.equal(args[args.indexOf("--resume") + 1], "cli-b");
});

// ---------- 自动建会话：null → 新会话不清视图（例外形态） ----------

test("AUTO-I1: 无会话时发送 → 自动建会话后视图不回零，乐观轮 + 流事件 + 空回放全部保住", async () => {
  const h = makeHarness();
  await h.settle();
  assert.equal(h.uiState().sessionId, null);

  h.sendText("首问");
  assert.equal(h.uiState().sessionId, null);
  assert.equal(h.uiState().turnStatus, "waiting");
  await h.settle(); // 宿主自动建会话 + 推 sessionList + 回放（空）
  assert.ok(h.uiState().sessionId, "自动建会话未绑定到 UI");
  assert.deepEqual(
    h.uiState().messages.map((m) => m.text),
    ["首问"],
    "自动建会话后乐观 user 轮被清（视图回零）",
  );
  assert.equal(h.uiState().turnStatus, "waiting");

  // 流事件完整保留
  const s = h.uiState().sessionId as string;
  h.turns[0].emit(initEvent("cli-auto"));
  h.turns[0].emit({ kind: "messageStart" });
  h.turns[0].emit({ kind: "textDelta", index: 0, text: "自动会话回答" });
  await h.settle();
  const assistant = h.uiState().messages[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(
    assistant.blocks && "text" in assistant.blocks[0]
      ? assistant.blocks[0].text
      : null,
    "自动会话回答",
  );
  h.turns[0].emit(resultEvent("cli-auto"));
  h.turns[0].releaseExit();
  await h.settle();
  assert.equal(h.uiState().turnStatus, "idle");
  assert.ok(h.uiState().statusDetail.startsWith("完成"));
  assert.equal(h.store.get(s)?.messageCount, 2, "自动建会话的历史未落盘");
});

// ---------- BUG-24：createSession 失败必回包 ----------

test("24-I1: 索引写失败 → 回 error SAVE_FAILED；UI「新建中…」清除；故障恢复后新建成功", async () => {
  const h = makeHarness();
  await h.settle();
  h.fs.failWhen = (op, path) => op === "write" && path === `${INDEX}.tmp`;

  h.createSession();
  assert.equal(h.uiState().creatingSession, true);
  await h.settle();

  const errs = errorsOf(h, "SAVE_FAILED");
  assert.equal(
    errs.length,
    1,
    `失败时宿主回包缺失/错误：${JSON.stringify(h.posted)}`,
  );
  assert.equal(h.uiState().creatingSession, false, "UI 永久停在「新建中…」");
  assert.ok(h.uiState().errorBanner?.startsWith("SAVE_FAILED:"));
  // 磁盘上不得出现半成品索引（写失败 = 一个字节都没落）
  assert.equal(h.fs.files.has(INDEX), false, "索引写失败却落了盘");
  // OBS-3 修复后（write-then-commit）：写失败内存零残留，不再有「幽灵会话」
  assert.deepEqual(h.store.list(), [], "写失败后内存须零残留（OBS-3）");

  // 故障恢复 → 重试成功（写队列未被毒化）
  h.fs.failWhen = null;
  h.createSession();
  await h.settle();
  assert.equal(h.uiState().creatingSession, false);
  const bound = h.uiState().sessionId;
  assert.ok(bound, "重试成功后未绑定到会话");
});

test("24-I3（OBS-3 修复后）: 建会话写盘失败不留幽灵会话 → 下一次 send 走自动建全新会话", async () => {
  const h = makeHarness();
  await h.settle();
  h.fs.failWhen = (op, path) => op === "write" && path === `${INDEX}.tmp`;
  h.createSession();
  await h.settle();
  assert.deepEqual(h.store.list(), [], "前置条件：写失败后内存零残留（OBS-3）");
  h.fs.failWhen = null;

  // 用户直接发消息（UI 侧仍无绑定）→ 自动建全新会话（而非认领幽灵）
  h.sendText("直接开聊");
  await h.settle();
  assert.equal(h.turns.length, 1, "未走自动建会话路径");
  h.turns[0].emit(initEvent("cli-new"));
  h.turns[0].emit({ kind: "messageStart" });
  h.turns[0].emit({ kind: "textDelta", index: 0, text: "新会话应答" });
  await h.settle();
  h.turns[0].emit(resultEvent("cli-new"));
  h.turns[0].releaseExit();
  await h.settle();
  const bound = h.uiState().sessionId;
  assert.ok(bound, "turn 结束后 UI 未绑定会话");
  assert.equal(h.uiState().messages[0]?.text, "直接开聊");
  const assistant = h.uiState().messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(
    assistant.blocks && "text" in assistant.blocks[0]
      ? assistant.blocks[0].text
      : null,
    "新会话应答",
  );
});

test("24-I2: createSession 注入异常（lookupItem 抛错 / itemKey 查无）→ 必回包且不建会话", async () => {
  const boom = makeHarness({}, { lookupThrows: true });
  await boom.settle();
  boom.bridge.dispatch({
    source: boom.win,
    data: { type: "createSession", itemKey: "ITEM1" },
  });
  await boom.settle();
  const errs = errorsOf(boom, "SAVE_FAILED");
  assert.equal(
    errs.length,
    1,
    `lookupItem 抛错未回包：${JSON.stringify(boom.posted)}`,
  );
  assert.deepEqual(boom.store.list(), []);

  const missing = makeHarness();
  await missing.settle();
  missing.bridge.dispatch({
    source: missing.win,
    data: { type: "createSession", itemKey: "GHOST" },
  });
  await missing.settle();
  assert.equal(errorsOf(missing, "ITEM_NOT_FOUND").length, 1);
  assert.deepEqual(missing.store.list(), [], "ITEM_NOT_FOUND 后仍建了会话");
});

// ---------- BUG-25：SESSION_GONE 清死 id ----------

test("25-I1: SESSION_GONE → 索引清 claudeSessionId → 再发不带 --resume → 之后恢复正常续接", async () => {
  const h = makeHarness();
  await h.settle();

  const args1 = await completeTurn(h, "第一问", "dead-1", "第一答");
  const id = h.uiState().sessionId as string;
  assert.equal(args1.includes("--resume"), false);
  assert.equal(h.store.get(id)?.claudeSessionId, "dead-1");

  // 第二轮带 --resume dead-1 → CLI 侧已失效
  h.sendText("第二问");
  await h.settle();
  const args2 = h.turns[1].args();
  assert.equal(args2[args2.indexOf("--resume") + 1], "dead-1");
  h.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "Error: No conversation found with session ID: dead-1",
  });
  h.turns[1].releaseExit();
  await h.settle();

  const gone = errorsOf(h, "SESSION_GONE");
  assert.equal(gone.length, 1, "resume 失效未回 SESSION_GONE");
  assert.equal(
    h.store.get(id)?.claudeSessionId,
    null,
    "死 claudeSessionId 未清出索引（同会话再发必再失败）",
  );
  const listMsg = h.posted.filter((m) => m.type === "sessionList").pop() as {
    sessions: { id: string; claudeSessionId: string | null }[];
  };
  assert.equal(
    listMsg.sessions.find((s) => s.id === id)?.claudeSessionId,
    null,
    "sessionList 未反映清除后的状态",
  );
  // UI：错误横幅 + 输入解锁（可重发）
  assert.equal(h.uiState().errorCode, "SESSION_GONE");
  assert.equal(h.uiState().turnStatus, "idle");

  // 同会话重发 → 不得再带死 id
  h.sendText("第三问");
  await h.settle();
  const args3 = h.turns[2].args();
  assert.equal(
    args3.includes("--resume"),
    false,
    "SESSION_GONE 后仍复用死 claudeSessionId",
  );

  // 第三轮起全新 CLI 会话 → 恢复正常续接链
  h.turns[2].emit(initEvent("fresh-9"));
  h.turns[2].emit(answerEvent("第三答"));
  h.turns[2].emit(resultEvent("fresh-9"));
  h.turns[2].releaseExit();
  await h.settle();
  assert.equal(h.store.get(id)?.claudeSessionId, "fresh-9");

  h.sendText("第四问");
  await h.settle();
  const args4 = h.turns[3].args();
  assert.equal(
    args4[args4.indexOf("--resume") + 1],
    "fresh-9",
    "清死 id 后新会话未接上（续接链断了）",
  );
});

test("25-I2: 通用 procError（非失效）→ 不清 id、不报 SESSION_GONE（反向用例）", async () => {
  const h = makeHarness();
  await h.settle();
  await completeTurn(h, "第一问", "cli-ok", "第一答");
  const id = h.uiState().sessionId as string;

  h.sendText("第二问");
  await h.settle();
  h.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "Error: EACCES something unrelated",
  });
  h.turns[1].releaseExit();
  await h.settle();

  assert.equal(errorsOf(h, "SESSION_GONE").length, 0);
  assert.equal(
    h.store.get(id)?.claudeSessionId,
    "cli-ok",
    "通用错误把可用的 claudeSessionId 清了",
  );
});

// ---------- BUG-27：两拼写判定一致性 ----------

test("27-I1: 两拼写（ENOENT / CLAUDE_NOT_FOUND）分类一致；宿主不清 id、不报 SESSION_GONE", async () => {
  const kinds = ["ENOENT", "CLAUDE_NOT_FOUND"].map((reason) =>
    classifyProcError({ exitCode: null, stderrTail: "", reason }),
  );
  assert.deepEqual(kinds, ["CLAUDE_NOT_FOUND", "CLAUDE_NOT_FOUND"]);

  for (const reason of ["ENOENT", "CLAUDE_NOT_FOUND"]) {
    const h = makeHarness();
    await h.settle();
    await completeTurn(h, "第一问", "cli-x", "第一答");
    const id = h.uiState().sessionId as string;

    h.sendText(`第二问-${reason}`);
    await h.settle();
    h.turns[1].emit({ kind: "procError", exitCode: null, reason });
    h.turns[1].releaseExit();
    await h.settle();

    assert.equal(
      errorsOf(h, "SESSION_GONE").length,
      0,
      `${reason} 被误判成 SESSION_GONE`,
    );
    assert.equal(
      h.store.get(id)?.claudeSessionId,
      "cli-x",
      `${reason} 清掉了可用的 claudeSessionId`,
    );
  }
});

test("27-I2: procError 带失效 stderr + 非零退出 → 仍判 SESSION_GONE（keyword 分支未被削弱）", () => {
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "error: No conversation found with session ID abc",
    }),
    "SESSION_GONE",
  );
  // exit 0 不判 SESSION_GONE（BUG-04 口径保持）
  assert.equal(
    classifyProcError({ exitCode: 0, stderrTail: "No conversation found" }),
    "GENERIC",
  );
  // reason 优先于 stderr：spawn 即失败时不该被 stderr 关键字带偏
  assert.equal(
    classifyProcError({
      exitCode: null,
      stderrTail: "No conversation found",
      reason: "CLAUDE_NOT_FOUND",
    }),
    "CLAUDE_NOT_FOUND",
  );
});

// ---------- 反向用例：会话隔离与失效绑定 ----------

test("REV-I1: 删除会话后旧绑定再发 → SESSION_GONE（不复活、不静默）", async () => {
  const h = makeHarness();
  await h.settle();
  h.sendText("第一问");
  await h.settle();
  const stale = h.uiState().sessionId as string;

  // 模拟「他处已删」：UI 仍拿着旧 id 发送
  h.deleteSession(stale);
  await h.settle();
  h.bridge.dispatch({
    source: h.win,
    data: { type: "send", sessionId: stale, text: "旧绑定再发" },
  });
  await h.settle();

  assert.equal(errorsOf(h, "SESSION_GONE").length, 1);
  assert.deepEqual(h.store.list(), [], "已删会话被复活");
  assert.equal(h.turns.length, 1, "失效绑定仍 spawn 了进程");
});

test("REV-I2: 进行中 turn 再收 send → SESSION_BUSY（不排队、不 spawn）", async () => {
  const h = makeHarness();
  await h.settle();
  h.sendText("第一问");
  await h.settle();
  const id = h.uiState().sessionId as string;
  h.bridge.dispatch({
    source: h.win,
    data: { type: "send", sessionId: id, text: "并发第二问" },
  });
  await h.settle();
  assert.equal(errorsOf(h, "SESSION_BUSY").length, 1);
  assert.equal(h.turns.length, 1, "SESSION_BUSY 仍 spawn 了进程");
});

test("REV-I3: 中断在跑的 turn → kill + interrupting；进程退出后解锁", async () => {
  const h = makeHarness();
  await h.settle();
  h.sendText("第一问");
  await h.settle();
  h.turns[0].emit({ kind: "messageStart" });
  await h.settle();

  h.interrupt();
  await h.settle();
  assert.equal(h.turns[0].killed, true);
  assert.equal(h.uiState().turnStatus, "interrupting");

  h.turns[0].emit({ kind: "procError", exitCode: null, reason: "SIGTERM" });
  h.turns[0].releaseExit();
  await h.settle();
  assert.equal(h.uiState().turnStatus, "idle", "中断后进程退出仍不解锁");
});

test("REV-I4: 宿主重启后（同一索引文件）会话与历史仍可回放、可续接", async () => {
  // 第一段进程：跑完一轮
  const first = makeHarness();
  await first.settle();
  await completeTurn(first, "重启前的问", "cli-persist", "重启前的答");
  const id = first.uiState().sessionId as string;
  assert.ok(
    first.fs.files.has(`${DATA_DIR}/history/${id}.jsonl`),
    "历史文件未落盘",
  );

  // 磁盘快照 → 第二段进程（模拟 Zotero 重启）
  const snapshot: Record<string, string> = {};
  for (const [k, v] of first.fs.files) {
    snapshot[k] = v;
  }
  const second = makeHarness(snapshot);
  await second.settle();

  // UI 重启后自动绑最新会话 → 拉历史 → 回放
  assert.equal(second.uiState().sessionId, id);
  await second.settle();
  assert.deepEqual(
    second.uiState().messages.map((m) => m.text),
    ["重启前的问", "重启前的答"],
    "重启后历史未回显",
  );

  // 续接：下一轮带 --resume
  second.sendText("重启后的问");
  await second.settle();
  const args = second.turns[second.turns.length - 1].args();
  assert.equal(args[args.indexOf("--resume") + 1], "cli-persist");
});
