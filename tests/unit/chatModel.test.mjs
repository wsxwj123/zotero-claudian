// 单测 — src/chat/lib/chatModel.ts（桥消息 → UI 状态归约，node:test，无框架）
// 覆盖：§4.2 事件归约、assistantMessage 校准、toolResult 跨 turn 回填、
//       未知类型兜底（§4.6）、并发/中断状态机、空文本发送忽略。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginCreateSession,
  beginNoteSave,
  cancelNotePicker,
  consumeDraft,
  deleteSession,
  dismissError,
  initialChatState,
  notePickerSelect,
  reduceHostMessage,
  reduceStreamEvent,
  selectSession,
  userSend,
  interrupt,
} from "../../src/chat/lib/chatModel.ts";
import { mapStreamLine } from "../../src/modules/protocol.ts";

const s0 = () => initialChatState();
// 流事件仅在 turn 进行中（waiting/streaming/...）被应用（BUG-09）；
// 需要真实起点的用例从 waiting（w0）/streaming（st0）起步
const w0 = () => ({ ...s0(), turnStatus: "waiting" });
const st0 = () => ({ ...s0(), turnStatus: "streaming" });

// ---- 消息分发与兜底 ----

test("未知桥消息 type → 原样返回（§4.6 兜底，不崩）", () => {
  const before = s0();
  const after = reduceHostMessage(before, { type: "futureMessage", x: 1 });
  assert.equal(after, before);
  const after2 = reduceHostMessage(before, { type: "totally_unknown_thing" });
  assert.equal(after2, before);
});

test("M7 noteSaved/noteList 未开选择器 → 选择器类消息不越界改状态", () => {
  const before = s0();
  // 未点「存为笔记」时收到清单/回执：清单忽略；回执只有一个状态行/横幅的差别，不得崩
  assert.equal(
    reduceHostMessage(before, { type: "noteList", notes: [] }),
    before,
  );
  const saved = reduceHostMessage(before, {
    type: "noteSaved",
    ok: true,
    noteKey: "N1",
  });
  assert.equal(saved.notePicker, null);
  assert.ok(saved.statusDetail.includes("N1"));
});

test("未知 streamEvent kind → 原样返回（§4.2 前向兼容）", () => {
  const before = s0();
  const after = reduceStreamEvent(before, { kind: "future_event", x: 1 });
  assert.equal(after, before);
  assert.equal(reduceStreamEvent(before, null), before);
  assert.equal(reduceStreamEvent(before, {}), before);
});

test("sessionList → 记录会话并置 connected", () => {
  const s = reduceHostMessage(s0(), {
    type: "sessionList",
    sessions: [{ id: "a1", title: "t", updatedAt: 1, itemKey: null }],
  });
  assert.equal(s.connected, true);
  assert.equal(s.sessions[0].id, "a1");
});

test("sessionList 非数组/坏条目 → 防御性归一", () => {
  const s = reduceHostMessage(s0(), { type: "sessionList", sessions: "junk" });
  assert.deepEqual(s.sessions, []);
  const s2 = reduceHostMessage(s0(), {
    type: "sessionList",
    sessions: [null, { title: "no-id" }, { id: "ok" }],
  });
  assert.equal(s2.sessions.length, 1);
  assert.equal(s2.sessions[0].title, "");
});

// ---- 流式文本 ----

test("messageStart → 新建 assistant turn，进入 streaming", () => {
  const s = reduceStreamEvent(w0(), { kind: "messageStart" });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "assistant");
  assert.equal(s.turnStatus, "streaming");
});

test("textBlockStart/textDelta → 文本增量累积", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, { kind: "textBlockStart", index: 0 });
  s = reduceStreamEvent(s, { kind: "textDelta", index: 0, text: "你好" });
  s = reduceStreamEvent(s, { kind: "textDelta", index: 0, text: "世界" });
  const block = s.messages[0].blocks.find((b) => b.index === 0);
  assert.equal(block.text, "你好世界");
});

test("textDelta 的 text 非字符串 → 丢该 delta（§4.2 契约）", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, { kind: "textBlockStart", index: 0 });
  const before = JSON.stringify(s);
  s = reduceStreamEvent(s, { kind: "textDelta", index: 0, text: 42 });
  assert.equal(JSON.stringify(s), before);
});

test("thinkingDelta → thinking 块累积（与 text 块按 index 区分）", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, { kind: "thinkingDelta", index: 0, text: "想" });
  s = reduceStreamEvent(s, { kind: "textDelta", index: 1, text: "答" });
  const blocks = s.messages[0].blocks;
  assert.equal(blocks[0].blockType, "thinking");
  assert.equal(blocks[0].text, "想");
  assert.equal(blocks[1].blockType, "text");
  assert.equal(blocks[1].text, "答");
});

test("无 messageStart（丢帧）→ 隐式补 assistant turn", () => {
  const s = reduceStreamEvent(w0(), { kind: "textDelta", index: 0, text: "x" });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].blocks[0].text, "x");
});

// ---- 工具卡 ----

test("toolBlockStart/toolInputDelta → 工具卡参数流式累积", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Bash",
    toolUseId: "tu1",
  });
  s = reduceStreamEvent(s, {
    kind: "toolInputDelta",
    index: 1,
    jsonFragment: '{"comm',
  });
  s = reduceStreamEvent(s, {
    kind: "toolInputDelta",
    index: 1,
    jsonFragment: 'and":"ls"}',
  });
  const block = s.messages[0].blocks.find((b) => b.index === 1);
  assert.equal(block.blockType, "tool");
  assert.equal(block.toolName, "Bash");
  assert.equal(block.inputJson, '{"command":"ls"}');
});

test("toolResult 按 toolUseId 跨 turn 回填（tool_use 在上一 assistant turn）", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "toolBlockStart",
    index: 0,
    toolName: "Bash",
    toolUseId: "tu1",
  });
  s = reduceStreamEvent(s, { kind: "messageStart" }); // 新 assistant 消息
  s = reduceStreamEvent(s, {
    kind: "toolResult",
    toolUseId: "tu1",
    isError: false,
    summary: "ls 输出",
  });
  const toolBlocks = s.messages
    .flatMap((t) => t.blocks || [])
    .filter((b) => b.blockType === "tool");
  assert.equal(toolBlocks.length, 1);
  assert.deepEqual(toolBlocks[0].result, {
    isError: false,
    summary: "ls 输出",
  });
});

test("toolResult 未知 toolUseId → 忽略", () => {
  const before = st0();
  assert.equal(
    reduceStreamEvent(before, {
      kind: "toolResult",
      toolUseId: "nope",
      isError: false,
      summary: "x",
    }),
    before,
  );
  // before 应为进行中状态，确保测的是「未知 id 忽略」而非「idle 迟到忽略」（BUG-09）
  assert.equal(before.turnStatus, "streaming");
});

// ---- assistantMessage 校准（§4.2：content[] 为权威）----

test("assistantMessage → 校准最终文本与工具入参", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, { kind: "textBlockStart", index: 0 });
  s = reduceStreamEvent(s, {
    kind: "textDelta",
    index: 0,
    text: "流式中的半截",
  });
  s = reduceStreamEvent(s, {
    kind: "toolBlockStart",
    index: 1,
    toolName: "Bash",
    toolUseId: "tu1",
  });
  s = reduceStreamEvent(s, {
    kind: "assistantMessage",
    content: [
      { type: "text", text: "最终答案" },
      {
        type: "tool_use",
        id: "tu1",
        name: "Bash",
        input: { command: "ls -la" },
      },
    ],
  });
  const blocks = s.messages[0].blocks;
  assert.equal(blocks[0].text, "最终答案");
  assert.equal(blocks[0].streaming, false);
  assert.equal(blocks[1].inputJson, '{\n  "command": "ls -la"\n}');
  assert.equal(blocks[1].streaming, false);
});

test("assistantMessage 含 thinking 块 → 校准 thinking 文本且不覆盖 text/tool", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "thinkingDelta",
    index: 0,
    text: "半截思考",
  });
  s = reduceStreamEvent(s, { kind: "textBlockStart", index: 1 });
  s = reduceStreamEvent(s, { kind: "textDelta", index: 1, text: "答" });
  s = reduceStreamEvent(s, {
    kind: "assistantMessage",
    content: [
      { type: "thinking", thinking: "完整思考" },
      { type: "text", text: "完整回答" },
    ],
  });
  const blocks = s.messages[0].blocks;
  assert.equal(blocks[0].blockType, "thinking");
  assert.equal(blocks[0].text, "完整思考");
  assert.equal(blocks[0].streaming, false);
  assert.equal(blocks[1].blockType, "text");
  assert.equal(blocks[1].text, "完整回答");
});

test("assistantMessage 补齐流中缺失的块（丢帧兜底）", () => {
  let s = reduceStreamEvent(w0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "assistantMessage",
    content: [{ type: "text", text: "完整内容" }],
  });
  assert.equal(s.messages[0].blocks[0].text, "完整内容");
});

// ---- 状态机：init/retry/result/错误 ----

test("init 事件 → streaming + 状态行显示模型", () => {
  const s = reduceStreamEvent(w0(), {
    kind: "init",
    claudeSessionId: "c1",
    model: "claude-x",
    permissionMode: "acceptEdits",
    tools: [],
    mcpServers: [],
  });
  assert.equal(s.turnStatus, "streaming");
  assert.ok(s.statusDetail.includes("claude-x"));
});

test("apiRetry → 状态行重试提示", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "apiRetry",
    attempt: 2,
    maxRetries: 3,
    delayMs: 1500,
  });
  assert.ok(s.statusDetail.includes("2/3"));
});

test("result → idle + 费用耗时", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "result",
    claudeSessionId: "c1",
    costUsd: 0.012,
    durationMs: 4200,
    numTurns: 3,
  });
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.statusDetail.includes("$0.0120"));
});

test("resultError → 错误横幅 + 解锁", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "resultError",
    subtype: "error_max_retries",
    errors: ["rate limited"],
  });
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.errorBanner.includes("rate limited"));
});

test("M10-J4 链路：真机逐字 payload → 重试状态行 → 错误横幅（不再显示「完成」）", () => {
  // 逐字取自 M10 抓包（CLI v2.1.267）：protocol 解析 + UI 归约的整条映射链
  const retry = mapStreamLine(
    '{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":2034,"error_status":502,"error":"server_error"}',
  );
  const during = reduceStreamEvent(st0(), retry);
  assert.equal(during.turnStatus, "streaming");
  assert.ok(
    during.statusDetail.includes("API 重试中 (3/10"),
    during.statusDetail,
  );

  const result = mapStreamLine(
    '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"total_cost_usd":0,"duration_ms":211711,"terminal_reason":"api_error","result":"API Error: 502 status code (no body)."}',
  );
  const after = reduceStreamEvent(during, result);
  assert.equal(after.turnStatus, "idle"); // 输入框恢复可用
  assert.ok(after.errorBanner.includes("API Error: 502"), after.errorBanner);
  assert.ok(!after.statusDetail.includes("完成"), after.statusDetail);

  // 真机同序：该轮映射为 resultError 后 cliRunner 不再见 result（sawResult 只认 result），
  // 进程退出会补发一条 procError(exit 0)——它在 resultError 之后到达，必须被 idle 闸忽略，
  // 不得覆盖错误横幅为「CLI 进程异常退出」
  const backstop = reduceStreamEvent(after, {
    kind: "procError",
    exitCode: 0,
    stderrTail: "",
  });
  assert.equal(backstop, after);
});

test("procError CLAUDE_NOT_FOUND → 安装引导横幅", () => {
  const s = reduceStreamEvent(w0(), {
    kind: "procError",
    exitCode: null,
    reason: "CLAUDE_NOT_FOUND",
  });
  assert.ok(s.errorBanner.includes("CLAUDE_NOT_FOUND"));
});

test("procError 通用 → stderr 尾部进横幅", () => {
  const s = reduceStreamEvent(w0(), {
    kind: "procError",
    exitCode: 1,
    stderrTail: "boom",
  });
  assert.ok(s.errorBanner.includes("exit 1"));
  assert.ok(s.errorBanner.includes("boom"));
});

// ---- 发送/中断（§4.6 并发契约）----

test("userSend 正常 → 追加 user turn + waiting + send 消息", () => {
  const { state, msg } = userSend(s0(), "  这是个问题  ");
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.messages[0].text, "  这是个问题  ");
  assert.equal(state.turnStatus, "waiting");
  assert.deepEqual(msg, {
    type: "send",
    sessionId: null,
    text: "  这是个问题  ",
  });
});

test("userSend 空白文本 → 忽略（§4.6：UI 侧忽略）", () => {
  const before = s0();
  const { state, msg } = userSend(before, "   ");
  assert.equal(msg, null);
  assert.equal(state, before);
});

test("userSend 进行中 → 拒绝（不排队）", () => {
  let s = s0();
  s = { ...s, turnStatus: "streaming" };
  const { msg } = userSend(s, "x");
  assert.equal(msg, null);
});

test("userSend 先清错误横幅", () => {
  let s = { ...s0(), errorBanner: "old" };
  const { state } = userSend(s, "q");
  assert.equal(state.errorBanner, null);
});

test("interrupt 进行中 → interrupting 态 + 消息；重复 interrupt 忽略", () => {
  let s = { ...s0(), sessionId: "s1", turnStatus: "streaming" };
  let r = interrupt(s);
  assert.equal(r.state.turnStatus, "interrupting");
  assert.deepEqual(r.msg, { type: "interrupt", sessionId: "s1" });
  r = interrupt(r.state);
  assert.equal(r.msg, null);
});

test("interrupt idle → 忽略", () => {
  const { msg } = interrupt({ ...s0(), sessionId: "s1" });
  assert.equal(msg, null);
});

test("BUG-17: sessionId 为 null（M4 无会话列表）时 interrupt 照发", () => {
  const s = { ...s0(), sessionId: null, turnStatus: "waiting" };
  const r = interrupt(s);
  assert.equal(r.state.turnStatus, "interrupting");
  assert.deepEqual(r.msg, { type: "interrupt", sessionId: null });
});

test("BUG-17: streaming 且 sessionId null → 同样进入 interrupting", () => {
  const s = { ...s0(), sessionId: null, turnStatus: "streaming" };
  const { state, msg } = interrupt(s);
  assert.equal(state.turnStatus, "interrupting");
  assert.deepEqual(msg, { type: "interrupt", sessionId: null });
});

test("error 桥消息 → 横幅，waiting 拉回 idle（如 SESSION_BUSY）", () => {
  let s = { ...s0(), turnStatus: "waiting" };
  s = reduceHostMessage(s, {
    type: "error",
    code: "SESSION_BUSY",
    message: "busy",
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, "SESSION_BUSY: busy");
});

// ---- history 回放 ----

test("history → 重建消息列表（坏行跳过）", () => {
  const s = reduceHostMessage(s0(), {
    type: "history",
    sessionId: "s1",
    messages: [
      { role: "user", text: "问题", ts: 1 },
      { role: "junk", text: "x", ts: 2 },
      { role: "assistant", text: "回答", ts: 3 },
      null,
    ],
  });
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0].text, "问题");
  assert.equal(s.messages[1].text, "回答");
});

// ---- readerContext ----

test("readerContext → 顶栏数据", () => {
  const s = reduceHostMessage(s0(), {
    type: "readerContext",
    itemKey: "AB12CD34",
    title: "一篇论文",
    page: 3,
    selection: "划选句",
  });
  assert.equal(s.readerContext.title, "一篇论文");
  assert.equal(s.readerContext.page, 3);
});

// ---- BUG-08：result/resultError 数值字段畸形防御 ----

test("BUG-08: result costUsd/durationMs/numTurns 非数值 → 按 0 缺省，不抛 TypeError", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "result",
    claudeSessionId: "c",
    costUsd: "贵",
    durationMs: null,
    numTurns: undefined,
  });
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.statusDetail.includes("$0.0000"), s.statusDetail);
  assert.ok(s.statusDetail.includes("0 轮"), s.statusDetail);
  assert.ok(s.statusDetail.includes("0.0s"), s.statusDetail);
});

test("BUG-08: result costUsd NaN → 按 0 缺省", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "result",
    claudeSessionId: "c",
    costUsd: NaN,
    durationMs: 1000,
    numTurns: 1,
  });
  assert.ok(s.statusDetail.includes("$0.0000"), s.statusDetail);
});

test("BUG-08: result 正常数値不受防御影响", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0.012,
    durationMs: 4200,
    numTurns: 3,
  });
  assert.ok(s.statusDetail.includes("$0.0120"), s.statusDetail);
  assert.ok(s.statusDetail.includes("4.2s"), s.statusDetail);
});

test("BUG-08: resultError errors 为字符串 → 单值包裹，不抛 TypeError", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "resultError",
    subtype: "error_x",
    errors: "rate limited",
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, "turn 失败 (error_x): rate limited");
});

test("BUG-08: resultError errors 为非数组非字符串（数字）→ 包裹", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "resultError",
    subtype: "error_y",
    errors: 42,
  });
  assert.equal(s.errorBanner, "turn 失败 (error_y): 42");
});

test("BUG-08: resultError errors 缺省 → 空数组，横幅无冒号尾巴", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "resultError",
    subtype: "error_z",
  });
  assert.equal(s.errorBanner, "turn 失败 (error_z)");
});

// ---- BUG-09：turn 终止后的迟到流事件一律忽略 ----

test("BUG-09: result 后迟到流事件（messageStart/textDelta/blockStart/toolUse/toolResult/init）→ 忽略不回 streaming", () => {
  let s = reduceStreamEvent(st0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  assert.equal(s.turnStatus, "idle");
  const msgCount = s.messages.length;
  assert.equal(reduceStreamEvent(s, { kind: "messageStart" }), s);
  assert.equal(
    reduceStreamEvent(s, { kind: "textDelta", index: 0, text: "迟到" }),
    s,
  );
  assert.equal(reduceStreamEvent(s, { kind: "textBlockStart", index: 0 }), s);
  assert.equal(
    reduceStreamEvent(s, {
      kind: "toolBlockStart",
      index: 0,
      toolName: "Bash",
      toolUseId: "t",
    }),
    s,
  );
  assert.equal(
    reduceStreamEvent(s, {
      kind: "toolResult",
      toolUseId: "t",
      isError: false,
      summary: "x",
    }),
    s,
  );
  assert.equal(
    reduceStreamEvent(s, {
      kind: "init",
      claudeSessionId: "c",
      model: "m",
      permissionMode: "acceptEdits",
      tools: [],
      mcpServers: [],
    }),
    s,
  );
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.messages.length, msgCount);
});

test("BUG-09: resultError 终止后迟到事件忽略", () => {
  const s = reduceStreamEvent(st0(), {
    kind: "resultError",
    subtype: "error_x",
    errors: [],
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(reduceStreamEvent(s, { kind: "messageStart" }), s);
  assert.equal(
    reduceStreamEvent(s, { kind: "textDelta", index: 0, text: "x" }),
    s,
  );
});

test("BUG-09: procError 终止后迟到事件忽略", () => {
  const s = reduceStreamEvent(w0(), {
    kind: "procError",
    exitCode: 1,
    stderrTail: "boom",
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(reduceStreamEvent(s, { kind: "messageStart" }), s);
});

test("BUG-09: 终止后再次发送 → 新 turn 的流事件正常应用", () => {
  let s = reduceStreamEvent(st0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  const r = userSend(s, "再来一轮");
  s = r.state;
  assert.equal(s.turnStatus, "waiting");
  s = reduceStreamEvent(s, { kind: "messageStart" });
  assert.equal(s.turnStatus, "streaming");
  assert.equal(s.messages.length, 3); // 旧 user + 旧 assistant + 新 user（新 assistant 由 messageStart 建）
});

// ---- BUG-12：streamEvent 按 sessionId 过滤（双实例广播不串屏）----

test("BUG-12: streamEvent sessionId 与当前会话不一致 → 整体忽略", () => {
  const before = { ...st0(), sessionId: "s1" };
  const after = reduceHostMessage(before, {
    type: "streamEvent",
    sessionId: "other-session",
    event: { kind: "messageStart" },
  });
  assert.equal(after, before);
  assert.equal(after.turnStatus, "streaming");
});

test("BUG-12: sessionId 与当前会话一致 → 正常应用", () => {
  const bound = { ...st0(), sessionId: "s1" };
  const s = reduceHostMessage(bound, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "messageStart" },
  });
  assert.equal(s.messages.length, 1);
});

test("BUG-12: 消息缺 sessionId（缺省）→ 照常应用", () => {
  const bound = { ...st0(), sessionId: "s1" };
  const s = reduceHostMessage(bound, {
    type: "streamEvent",
    event: { kind: "messageStart" },
  });
  assert.equal(s.messages.length, 1);
});

test("BUG-12: 本实例未绑定会话（sessionId null）→ 不构成串屏，照常应用", () => {
  const s = reduceHostMessage(st0(), {
    type: "streamEvent",
    sessionId: "s9",
    event: { kind: "messageStart" },
  });
  assert.equal(s.messages.length, 1);
});

test("BUG-12: 无关会话的流事件不绕过 BUG-09 守卫（先终止再收到他方事件）", () => {
  let s = reduceStreamEvent(st0(), { kind: "messageStart" });
  s = reduceStreamEvent(s, {
    kind: "result",
    claudeSessionId: "c",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  s = { ...s, sessionId: "s1" };
  const after = reduceHostMessage(s, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "messageStart" },
  });
  assert.equal(after.turnStatus, "idle");
});

// ---- BUG-13：error 解锁条件按 sessionId 收紧 ----

test("BUG-13: error 带无关 sessionId → 整体忽略（不横幅、不解锁 waiting）", () => {
  const before = { ...w0(), sessionId: "s1" };
  const after = reduceHostMessage(before, {
    type: "error",
    code: "SESSION_BUSY",
    message: "他方会话忙",
    sessionId: "other-session",
  });
  assert.equal(after, before);
  assert.equal(after.turnStatus, "waiting");
  assert.equal(after.errorBanner, null);
});

test("BUG-13: error sessionId 与当前会话匹配 → 横幅 + 解锁", () => {
  const s = reduceHostMessage(
    { ...w0(), sessionId: "s1" },
    { type: "error", code: "SESSION_BUSY", message: "busy", sessionId: "s1" },
  );
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, "SESSION_BUSY: busy");
  assert.equal(s.waitingSince, null);
});

test("BUG-13: error 缺 sessionId 字段 → 视为全局错误，横幅 + 解锁", () => {
  const s = reduceHostMessage(
    { ...w0(), sessionId: "s1" },
    { type: "error", code: "SPAWN_FAILED", message: "spawn 失败" },
  );
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, "SPAWN_FAILED: spawn 失败");
});

test("BUG-13: 本实例未绑定会话时，带 sessionId 的错误照常应用", () => {
  const s = reduceHostMessage(w0(), {
    type: "error",
    code: "E",
    message: "m",
    sessionId: "s9",
  });
  assert.equal(s.turnStatus, "idle");
  assert.equal(s.errorBanner, "E: m");
});

// ---- M5：会话列表绑定（§4.6 sessionList + 记录-02）----

const S = (id, extra = {}) => ({
  id,
  title: `会话 ${id}`,
  updatedAt: 1,
  itemKey: null,
  claudeSessionId: null,
  itemTitle: null,
  ...extra,
});

test("记录-02: sessionList 归一保留 claudeSessionId / itemTitle（续接与列表展示要用）", () => {
  const s = reduceHostMessage(s0(), {
    type: "sessionList",
    sessions: [
      S("a", { claudeSessionId: "cli-a", itemTitle: "一篇论文" }),
      S("b"),
    ],
  });
  assert.equal(s.sessions[0].claudeSessionId, "cli-a");
  assert.equal(s.sessions[0].itemTitle, "一篇论文");
  assert.equal(s.sessions[1].claudeSessionId, null);
  assert.equal(s.sessions[1].itemTitle, null);
});

test("M5 sessionList: 未绑定 → 自动绑定最新一条（[0]，宿主按 updatedAt 降序）", () => {
  const s = reduceHostMessage(s0(), {
    type: "sessionList",
    sessions: [S("new"), S("old")],
  });
  assert.equal(s.sessionId, "new");
});

test("M5 sessionList: 当前会话仍在列表 → 不重绑（用户视图不被列表刷新打断）", () => {
  const bound = { ...s0(), sessionId: "old" };
  const s = reduceHostMessage(bound, {
    type: "sessionList",
    sessions: [S("new"), S("old")],
  });
  assert.equal(s.sessionId, "old");
});

test("M5 sessionList: 当前会话已不在列表（他处删除/索引重置）→ 重绑最新；空列表 → null", () => {
  const bound = { ...s0(), sessionId: "gone" };
  const s = reduceHostMessage(bound, {
    type: "sessionList",
    sessions: [S("new")],
  });
  assert.equal(s.sessionId, "new");
  const empty = reduceHostMessage(bound, { type: "sessionList", sessions: [] });
  assert.equal(empty.sessionId, null);
});

test("M5 sessionList: 新建会话在途 → 绑定到最新一条并清除标记", () => {
  const bound = { ...s0(), sessionId: "old", creatingSession: true };
  const s = reduceHostMessage(bound, {
    type: "sessionList",
    sessions: [S("fresh"), S("old")],
  });
  assert.equal(s.sessionId, "fresh");
  assert.equal(s.creatingSession, false);
});

test("M5 selectSession: 清空视图 + 请求历史回放", () => {
  const before = {
    ...s0(),
    sessionId: "a",
    messages: [{ role: "user", text: "旧内容" }],
    errorBanner: "旧错误",
    errorCode: "SPAWN_FAILED",
  };
  const r = selectSession(before, "b");
  assert.equal(r.state.sessionId, "b");
  assert.deepEqual(r.state.messages, []);
  assert.equal(r.state.turnStatus, "idle");
  assert.equal(r.state.errorBanner, null);
  assert.equal(r.state.errorCode, null);
  assert.deepEqual(r.msg, { type: "getHistory", sessionId: "b" });
});

test("M5 beginCreateSession: 置在途标记 + createSession 带当前条目 key", () => {
  const st = {
    ...s0(),
    readerContext: { itemKey: "ITEM1", title: "t", page: 1, selection: null },
  };
  const r = beginCreateSession(st);
  assert.equal(r.state.creatingSession, true);
  assert.deepEqual(r.msg, { type: "createSession", itemKey: "ITEM1" });
  // 无阅读上下文 → itemKey null（通用会话）
  assert.deepEqual(beginCreateSession(s0()).msg, {
    type: "createSession",
    itemKey: null,
  });
});

test("M5 deleteSession / dismissError / consumeDraft 纯动作", () => {
  assert.deepEqual(deleteSession("x"), {
    type: "deleteSession",
    sessionId: "x",
  });
  const errored = { ...s0(), errorBanner: "b", errorCode: "SESSION_GONE" };
  const cleared = dismissError(errored);
  assert.equal(cleared.errorBanner, null);
  assert.equal(cleared.errorCode, null);
  const clean = s0();
  assert.equal(dismissError(clean), clean); // 无错误时原样返回（同一对象）
  const withDraft = { ...clean, restoreDraft: "草稿" };
  assert.equal(consumeDraft(withDraft).restoreDraft, null);
  assert.equal(consumeDraft(clean), clean);
});

// ---- M5：history 回放守卫 ----

test("M5: createSession 失败（error 到达）→ 清掉新建在途标志，按钮不永久「新建中…」", () => {
  const creating = { ...s0(), creatingSession: true };
  const s = reduceHostMessage(creating, {
    type: "error",
    code: "ITEM_NOT_FOUND",
    message: "条目不存在",
  });
  assert.equal(s.creatingSession, false);
  assert.equal(s.errorBanner, "ITEM_NOT_FOUND: 条目不存在");
});

test("M5 history: 他方会话的回放不落到本视图", () => {
  const bound = { ...s0(), sessionId: "a" };
  const s = reduceHostMessage(bound, {
    type: "history",
    sessionId: "b",
    messages: [{ role: "user", text: "他方", ts: 1 }],
  });
  assert.equal(s, bound);
});

test("M5 history: turn 进行中（waiting/streaming）不被回放覆盖（乐观轮不被抹掉）", () => {
  const inFlight = {
    ...w0(),
    sessionId: "a",
    messages: [{ role: "user", text: "刚发出的问题" }],
  };
  const s = reduceHostMessage(inFlight, {
    type: "history",
    sessionId: "a",
    messages: [],
  });
  assert.equal(s.messages.length, 1);
  const idle = { ...s0(), sessionId: "a" };
  const applied = reduceHostMessage(idle, {
    type: "history",
    sessionId: "a",
    messages: [{ role: "user", text: "回放", ts: 1 }],
  });
  assert.equal(applied.messages.length, 1);
  assert.equal(applied.messages[0].text, "回放");
});

// ---- M5：记录-06 亚秒竞态（UI result 已解锁、宿主进程未退）----

test("记录-06: SESSION_BUSY 拒绝 → 保留在途轮 + 不弹横幅，置待自动重发（定案修法）", () => {
  const inFlight = {
    ...w0(),
    sessionId: "a",
    messages: [{ role: "user", text: "被拒的问题" }],
  };
  const s = reduceHostMessage(inFlight, {
    type: "error",
    code: "SESSION_BUSY",
    message: "进行中的 turn 未结束",
    sessionId: "a",
  });
  assert.equal(s.turnStatus, "idle", "被拒后未解锁输入");
  assert.deepEqual(
    s.messages.map((m) => m.text),
    ["被拒的问题"],
    "自动重发期间在途轮被退回（幽灵轮/闪没）",
  );
  assert.deepEqual(s.pendingRetry, { text: "被拒的问题", attempts: 0 });
  assert.equal(s.restoreDraft, null, "自动重发期间不该同时退回草稿");
  assert.equal(s.errorBanner, null, "自动重发期间不该弹横幅");
  assert.equal(s.errorCode, null);
  assert.ok(s.statusDetail.includes("收尾中"));
});

test("记录-06: 末尾已是 assistant 轮（该轮真的应答过）→ SESSION_BUSY 不误退", () => {
  const answered = {
    ...s0(),
    sessionId: "a",
    messages: [
      { role: "user", text: "问题" },
      { role: "assistant", text: "回答" },
    ],
  };
  const s = reduceHostMessage(answered, {
    type: "error",
    code: "SESSION_BUSY",
    message: "busy",
    sessionId: "a",
  });
  assert.equal(s.messages.length, 2);
  assert.equal(s.restoreDraft, null);
});

test("记录-06: 非 SESSION_BUSY 错误不退轮（真失败由用户自行决定重发）", () => {
  const inFlight = {
    ...w0(),
    sessionId: "a",
    messages: [{ role: "user", text: "问题" }],
  };
  const s = reduceHostMessage(inFlight, {
    type: "error",
    code: "SPAWN_FAILED",
    message: "spawn 失败",
    sessionId: "a",
  });
  assert.equal(s.messages.length, 1);
  assert.equal(s.restoreDraft, null);
  assert.equal(s.errorCode, "SPAWN_FAILED");
});

test("记录-06: 再发送时清掉待恢复草稿（避免旧草稿盖住新输入）", () => {
  const withDraft = { ...s0(), restoreDraft: "旧草稿" };
  const { state } = userSend(withDraft, "新问题");
  assert.equal(state.restoreDraft, null);
});

// ---- M7 笔记（§4.3）：存为笔记的选择器流程 ----

const withContext = () => ({
  ...s0(),
  readerContext: {
    itemKey: "ITEM1",
    title: "一篇论文",
    page: 1,
    selection: null,
  },
});

test("M7: beginNoteSave 无绑定条目 → 无动作（不发 listNotes）", () => {
  const { state, msg } = beginNoteSave(s0(), 0, "<p>x</p>");
  assert.equal(msg, null);
  assert.equal(state.notePicker, null);
});

test("M7: beginNoteSave 空 HTML（markdown 转换失败兜底）→ 无动作", () => {
  const { msg } = beginNoteSave(withContext(), 0, "   ");
  assert.equal(msg, null);
});

test("M7: beginNoteSave → 开选择器（notes=null 加载中）+ 发 listNotes", () => {
  const { state, msg } = beginNoteSave(withContext(), 2, "<p>x</p>");
  assert.deepEqual(msg, { type: "listNotes", itemKey: "ITEM1" });
  assert.deepEqual(state.notePicker, {
    turnIndex: 2,
    itemKey: "ITEM1",
    html: "<p>x</p>",
    notes: null,
  });
});

test("M7: noteList → 填充清单；坏条目归一（无 noteKey 丢弃）", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>").state;
  const s = reduceHostMessage(picked, {
    type: "noteList",
    notes: [
      { noteKey: "N1", title: "甲", updatedAt: 2 },
      { title: "no-key" },
      null,
      { noteKey: "N2", title: 7, updatedAt: "bad" },
    ],
  });
  assert.deepEqual(s.notePicker.notes, [
    { noteKey: "N1", title: "甲", updatedAt: 2 },
    { noteKey: "N2", title: "", updatedAt: 0 },
  ]);
});

test("M7: notePickerSelect(null) → 新建；带 noteKey → 追加（都带 html 与固化 itemKey）", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>").state;
  const created = notePickerSelect(picked, null);
  assert.deepEqual(created.msg, {
    type: "saveNote",
    itemKey: "ITEM1",
    mode: "new",
    html: "<p>x</p>",
  });
  assert.equal(created.state.notePicker, null); // 发出即收起
  const appended = notePickerSelect(picked, "N9");
  assert.deepEqual(appended.msg, {
    type: "saveNote",
    itemKey: "ITEM1",
    mode: "append",
    noteKey: "N9",
    html: "<p>x</p>",
  });
});

test("M7: noteSaved ok → 状态行回执；失败 → 横幅带错误码（各自收起选择器）", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>").state;
  const ok = reduceHostMessage(picked, {
    type: "noteSaved",
    ok: true,
    noteKey: "NEW1",
  });
  assert.equal(ok.notePicker, null);
  assert.ok(ok.statusDetail.includes("NEW1"));
  const bad = reduceHostMessage(picked, {
    type: "noteSaved",
    ok: false,
    code: "SANITIZE_REJECTED",
  });
  assert.equal(bad.notePicker, null);
  assert.equal(bad.errorCode, "SANITIZE_REJECTED");
  assert.ok(bad.errorBanner.includes("SANITIZE_REJECTED"));
});

test("M7: cancelNotePicker 关选择器；换会话时选择器作废", () => {
  const picked = beginNoteSave(withContext(), 0, "<p>x</p>").state;
  assert.equal(cancelNotePicker(picked).notePicker, null);
  const switched = selectSession(picked, "other").state;
  assert.equal(switched.notePicker, null);
});

test("M7: 无选择器时 notePickerSelect/cancel 无动作（幂等）", () => {
  const base = s0();
  assert.equal(notePickerSelect(base, "N1").msg, null);
  assert.equal(cancelNotePicker(base), base); // 无选择器 → 原对象返回
});
