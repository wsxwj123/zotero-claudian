// 单测 — UI 侧会话交互（chatModel reducer）。
// D9 记录-06 幽灵轮退回；D10 记录-02 claudeSessionId 保留；D11 会话切换/新建/删除的消息归位；
// BUG-22/23/26 回归锁（由 test-m5 的 m5-probe 探针转正，修复后全绿，红灯即回归）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginCreateSession,
  consumeDraft,
  fireRetry,
  formatSessionTime,
  initialChatState,
  reduceHostMessage,
  renameSession,
  RETRY_MAX_ATTEMPTS,
  selectSession,
  sessionLabel,
  userSend,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage, SessionSummary } from "../../src/chat/lib/types.ts";

function summary(
  id: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    title: id,
    updatedAt: 0,
    itemKey: null,
    claudeSessionId: null,
    itemTitle: null,
    ...extra,
  };
}

function feed(state: ChatState, ...msgs: HostMessage[]): ChatState {
  return msgs.reduce((s, m) => reduceHostMessage(s, m), state);
}

/** 在会话 id 下走「用户发送 → 流式一轮完成」的最短序列 */
function chatOnce(
  state: ChatState,
  sessionId: string,
  text: string,
  answer: string,
): ChatState {
  const send = userSend({ ...state, sessionId, turnStatus: "idle" }, text);
  return feed(
    send.state,
    {
      type: "streamEvent",
      sessionId,
      event: {
        kind: "init",
        claudeSessionId: sessionId,
        model: "m",
        permissionMode: "acceptEdits",
        tools: [],
        mcpServers: [],
      },
    },
    { type: "streamEvent", sessionId, event: { kind: "messageStart" } },
    {
      type: "streamEvent",
      sessionId,
      event: { kind: "textDelta", index: 0, text: answer },
    },
    {
      type: "streamEvent",
      sessionId,
      event: {
        kind: "result",
        claudeSessionId: sessionId,
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
      },
    },
  );
}

// ---------- D9 记录-06：SESSION_BUSY 自动重发（定案修法：UI 侧排队重试，不改桥协议） ----------
//
// 场景：UI 在 result 就解锁输入，宿主却要等进程退出（实测 ≥2.3 秒）才接受新 send——这段窗口
// 发出的消息吃 SESSION_BUSY。定案口径：不清输入框、不弹横幅，保留在途轮，1 秒一次自动重发
// 同一条（上限 RETRY_MAX_ATTEMPTS）；用尽仍被拒才走 M5 兜底（退字 + 横幅）。

const busyMsg = (sessionId = "S1"): HostMessage => ({
  type: "error",
  code: "SESSION_BUSY",
  message: "进行中的 turn 未结束",
  sessionId,
});

/** 发送一条消息并吃下第一次 SESSION_BUSY（进入待自动重发态） */
function busyOnce(text = "这句话没发出去"): ChatState {
  let s = initialChatState();
  s = feed(s, { type: "sessionList", sessions: [summary("S1")] });
  return feed(userSend(s, text).state, busyMsg());
}

test("D9-1: SESSION_BUSY → 保留在途轮 + 不弹横幅，置待自动重发 + 1 秒重发一次", () => {
  const busy = busyOnce();
  assert.deepEqual(
    busy.messages.map((m) => m.text),
    ["这句话没发出去"],
    "自动重发期间在途轮被退回（闪没/幽灵）",
  );
  assert.deepEqual(busy.pendingRetry, { text: "这句话没发出去", attempts: 0 });
  assert.equal(busy.restoreDraft, null, "自动重发期间不该同时退回草稿");
  assert.equal(busy.errorBanner, null, "自动重发期间不该弹横幅");
  assert.equal(busy.errorCode, null);
  assert.equal(busy.turnStatus, "idle", "被拒后未解锁输入");
  assert.ok(busy.statusDetail.includes("收尾中"));
});

test("D9-5: BUSY → 自动重发序列 → 被接受即收手（全程无需用户操作）", () => {
  // App 定时器到点 → fireRetry：重发原报文，不追加新轮
  const r1 = fireRetry(busyOnce());
  assert.deepEqual(r1.msg, {
    type: "send",
    sessionId: "S1",
    text: "这句话没发出去",
  });
  assert.equal(r1.state.turnStatus, "waiting");
  assert.deepEqual(r1.state.pendingRetry, {
    text: "这句话没发出去",
    attempts: 1,
  });
  assert.deepEqual(
    r1.state.messages.map((m) => m.text),
    ["这句话没发出去"],
  );

  // 宿主仍在收尾 → 再拒 → 计数递增后接着重发
  const busy2 = feed(r1.state, busyMsg());
  assert.equal(busy2.pendingRetry?.attempts, 1);
  assert.equal(busy2.errorBanner, null);
  assert.equal(busy2.turnStatus, "idle");
  const r2 = fireRetry(busy2);
  assert.equal(r2.state.pendingRetry?.attempts, 2);

  // 这次被接受：流事件到达即证据（被拒的轮不产生任何流事件）→ 清重发标记，正文照常流入
  const accepted = feed(r2.state, {
    type: "streamEvent",
    sessionId: "S1",
    event: { kind: "messageStart" },
  });
  assert.equal(accepted.pendingRetry, null, "被接受后仍在重发");
  assert.equal(accepted.statusDetail, "", "「收尾中」文案未随接受作废");
  assert.equal(accepted.turnStatus, "streaming");
  assert.deepEqual(
    accepted.messages.filter((m) => m.role === "user").map((m) => m.text),
    ["这句话没发出去"],
    "重发造成了重复 user 轮",
  );

  // 收手后不再有下一次重发
  assert.deepEqual(fireRetry(accepted), { state: accepted, msg: null });
});

test("D9-6: 重发用尽（5 次）仍 BUSY → 兜底生效（退字 + 横幅），不再重发", () => {
  let s = busyOnce();
  for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i++) {
    const r = fireRetry(s);
    assert.equal(r.state.pendingRetry?.attempts, i, `第 ${i} 次重发未计数`);
    s = feed(r.state, busyMsg());
  }

  // 第 RETRY_MAX_ATTEMPTS 次重发也被拒 → M5 兜底口径
  assert.equal(s.pendingRetry, null, "用尽后仍挂在重试态");
  assert.deepEqual(s.messages, [], "幽灵轮未退回");
  assert.equal(s.restoreDraft, "这句话没发出去");
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.errorBanner?.startsWith("SESSION_BUSY"), "兜底未弹横幅");
  assert.ok(s.statusDetail.includes("已恢复输入内容"));
  assert.deepEqual(fireRetry(s), { state: s, msg: null }, "兜底后仍在重发");

  // 草稿消费仍按原口径工作（InputBox 写回后清标记）
  assert.equal(consumeDraft(s).restoreDraft, null);
});

test("D9-7: 重试期间用户重新发送 → 取消自动重发，旧轮退回不留幽灵", () => {
  const resend = userSend(busyOnce(), "换个问题");
  assert.equal(resend.state.pendingRetry, null, "用户新发送未取消自动重发");
  assert.deepEqual(
    resend.state.messages.map((m) => m.text),
    ["换个问题"],
    "被拒的旧轮留在列表（幽灵轮）",
  );
  assert.deepEqual(resend.msg, {
    type: "send",
    sessionId: "S1",
    text: "换个问题",
  });
});

test("D9-8: 重发在途点中断 → 取消自动重发；该次仍被拒则走兜底且不锁死输入", () => {
  const inFlight = fireRetry(busyOnce());
  const int = interruptOf(inFlight.state);
  assert.equal(int.state.turnStatus, "interrupting");
  assert.equal(int.state.pendingRetry, null, "中断未取消自动重发");

  // 宿主其实没接到这次发送（BUSY）→ 中断不该把 UI 永久锁在 interrupting
  const after = feed(int.state, busyMsg());
  assert.equal(after.turnStatus, "idle");
  assert.equal(after.pendingRetry, null, "中断后仍自动重发");
  assert.deepEqual(after.messages, []);
  assert.equal(after.restoreDraft, "这句话没发出去");
});

test("D9-9: 重试期间切会话 → 自动重发作废（不把原文重发到新会话）", () => {
  let s: ChatState = busyOnce();
  s = feed(s, {
    type: "sessionList",
    sessions: [summary("S2", { updatedAt: 999 }), summary("S1")],
  });
  const sel = selectSession(s, "S2");
  assert.equal(sel.state.pendingRetry, null);
  assert.deepEqual(fireRetry(sel.state), { state: sel.state, msg: null });
});

test("D9-10: 重发在途收到非 BUSY 错误 → 自动重发作废（横幅告知，不静默续发）", () => {
  const failed = feed(fireRetry(busyOnce()).state, {
    type: "error",
    code: "SPAWN_FAILED",
    message: "spawn 失败",
    sessionId: "S1",
  });
  assert.equal(failed.pendingRetry, null);
  assert.equal(failed.turnStatus, "idle");
  assert.ok(failed.errorBanner?.startsWith("SPAWN_FAILED"));
  assert.deepEqual(fireRetry(failed), { state: failed, msg: null });
});

test("D9-2: 非 SESSION_BUSY 错误 → 不退回消息、不设草稿（防误退已发出的轮）", () => {
  let s = initialChatState();
  s = feed(s, { type: "sessionList", sessions: [summary("S1")] });
  const send = userSend(s, "正文");
  for (const code of [
    "SPAWN_FAILED",
    "WORKSPACE_UNAVAILABLE",
    "CLAUDE_NOT_FOUND",
  ]) {
    const next = feed(send.state, {
      type: "error",
      code,
      message: "x",
      sessionId: "S1",
    });
    assert.equal(next.restoreDraft, null, `${code} 误设草稿`);
    assert.equal(next.messages.length, 1, `${code} 误退消息`);
  }
});

test("D9-3: SESSION_BUSY 但末条不是 user 轮（异常序）→ 不越界退回、不崩", () => {
  let s = initialChatState();
  s = feed(s, { type: "sessionList", sessions: [summary("S1")] });
  s = chatOnce(s, "S1", "问", "答"); // 末条是 assistant
  const busy = feed(s, {
    type: "error",
    code: "SESSION_BUSY",
    message: "x",
    sessionId: "S1",
  });
  assert.equal(busy.messages.length, 2, "把上一轮的 assistant 轮误退了");
  assert.equal(busy.restoreDraft, null);
});

test("D9-4: 他会话的 SESSION_BUSY → 整体忽略（不误退本会话在途消息）", () => {
  let s = initialChatState();
  s = feed(s, {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  const send = userSend(s, "S1 的在途消息"); // 绑定 S1
  const other = feed(send.state, {
    type: "error",
    code: "SESSION_BUSY",
    message: "x",
    sessionId: "S2",
  });
  assert.equal(other.messages.length, 1);
  assert.equal(other.restoreDraft, null);
  assert.equal(other.turnStatus, "waiting");
});

// ---------- D10 记录-02：claudeSessionId 保留 ----------

test("D10-1: sessionList 归一保留 claudeSessionId / itemTitle（记录-02 修复验证）", () => {
  const s = feed(initialChatState(), {
    type: "sessionList",
    sessions: [
      summary("S1", {
        claudeSessionId: "cli-1",
        itemTitle: "论文甲",
        title: "会话一",
      }),
      summary("S2", { claudeSessionId: null, itemTitle: null }),
    ],
  });
  assert.equal(s.sessions[0].claudeSessionId, "cli-1");
  assert.equal(s.sessions[0].itemTitle, "论文甲");
  assert.equal(s.sessions[1].claudeSessionId, null);
  assert.equal(s.sessions[1].itemTitle, null);
});

test("D10-2: 坏 sessionList 条目（非对象/无 id/字段类型错）→ 丢弃或补默认，不崩", () => {
  const s = feed(initialChatState(), {
    type: "sessionList",
    sessions: [
      null,
      1,
      "x",
      [],
      { title: "无 id" },
      { id: 42 },
      { id: "ok", title: 5, updatedAt: "x", itemKey: 7, claudeSessionId: 9 },
    ] as unknown as SessionSummary[],
  });
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(s.sessions[0], {
    id: "ok",
    title: "",
    updatedAt: 0,
    createdAt: 0,
    itemKey: null,
    claudeSessionId: null,
    itemTitle: null,
  });
  // 非数组 → 空列表（不崩）
  assert.deepEqual(
    reduceHostMessage(s, { type: "sessionList", sessions: null as never })
      .sessions,
    [],
  );
});

test("D10-3: 未绑定 → 自动绑最新；绑定会话仍在列表 → 保持不动", () => {
  const s1 = feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1", { updatedAt: 9 }), summary("S2")],
  });
  assert.equal(s1.sessionId, "S1");
  const s2 = feed(s1, {
    type: "sessionList",
    sessions: [summary("S2", { updatedAt: 99 }), summary("S1")],
  });
  assert.equal(s2.sessionId, "S1", "列表刷新把用户绑定的会话顶掉了");
});

// ---------- D11 会话切换 / 新建 / 删除的消息归位 ----------
//
// 两条链路合起来决定消息归位，缺一不可：
// 1) reducer：绑定从一个会话换到另一个时收敛视图（BUG-22/23 修复起在 reduceSessionList 内完成）；
// 2) src/chat/main.ts：「绑定变化 → 发 getHistory」→ 回放覆盖/补齐消息内容（下一帧）。
// 因此本组用例一律走 appFeed（忠实模拟 main.ts 的绑定监听），只测 reducer 会得出错误结论。

/** 忠实模拟 main.ts：reduce 后若会话绑定变化 → 发 getHistory → 把宿主回包再喂回 reducer */
function appFeed(
  state: ChatState,
  msg: HostMessage,
  hostReply: (id: string) => HostMessage = (id) => ({
    type: "history",
    sessionId: id,
    messages: [],
  }),
): ChatState {
  const prev = state;
  const next = reduceHostMessage(prev, msg);
  if (next.sessionId && next.sessionId !== prev.sessionId) {
    return reduceHostMessage(next, hostReply(next.sessionId));
  }
  return next;
}

test("D11-1: 切换会话 → 清空视图 + 发 getHistory；他会话流事件不落错列表（BUG-12 回归）", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  s = chatOnce(s, "S1", "S1 的问题", "S1 的回答");
  assert.equal(s.messages.length, 2);

  const sel = selectSession(s, "S2");
  assert.deepEqual(sel.state.messages, [], "切换会话未清空视图（串屏）");
  assert.equal(sel.state.turnStatus, "idle");
  assert.deepEqual(sel.msg, { type: "getHistory", sessionId: "S2" });

  // S1 的迟到流事件（进程还在跑）→ 不得落进 S2 视图
  const leaked = feed(sel.state, {
    type: "streamEvent",
    sessionId: "S1",
    event: { kind: "textDelta", index: 0, text: "S1 的迟到内容" },
  });
  assert.deepEqual(leaked.messages, [], "他会话流事件落进了当前列表");

  // S2 自己的历史回放正常落位
  const replayed = feed(sel.state, {
    type: "history",
    sessionId: "S2",
    messages: [{ role: "user", text: "S2 旧问", ts: 1 }],
  });
  assert.deepEqual(
    replayed.messages.map((m) => m.text),
    ["S2 旧问"],
  );
});

test("D11-2: 在跑会话切走再切回 → 回放重建原消息（不丢不串）", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  s = chatOnce(s, "S1", "问1", "答1");
  const toS2 = selectSession(s, "S2").state;
  const back = selectSession(toS2, "S1").state;
  const replayed = feed(back, {
    type: "history",
    sessionId: "S1",
    messages: [
      { role: "user", text: "问1", ts: 1 },
      { role: "assistant", text: "答1", ts: 1 },
    ],
  });
  assert.deepEqual(
    replayed.messages.map((m) => m.text),
    ["问1", "答1"],
  );
});

test("D11-3: 空闲时新建会话 → 视图清空并绑定新会话（含 main.ts 监听的真机口径）", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  s = chatOnce(s, "S1", "S1 的问题", "S1 的回答");

  const creating = beginCreateSession(s);
  assert.equal(creating.state.creatingSession, true);
  assert.equal(creating.msg.type, "createSession");

  const after = appFeed(creating.state, {
    type: "sessionList",
    sessions: [summary("S9", { updatedAt: 999 }), summary("S1")],
  });
  assert.equal(after.sessionId, "S9", "未绑定到新建会话");
  assert.equal(
    after.creatingSession,
    false,
    "新建在途标志未清（按钮卡「新建中…」）",
  );
  assert.deepEqual(after.messages, [], "切到新会话后视图未清空");
});

test("D11-4: 空闲时删除当前会话 → 解绑并清空视图（含 main.ts 监听的真机口径）", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  s = chatOnce(s, "S1", "S1 的问题", "S1 的回答");

  const after = appFeed(s, {
    type: "sessionList",
    sessions: [summary("S2", { updatedAt: 999 })],
  });
  assert.equal(after.sessionId, "S2", "已删会话未解绑");
  assert.deepEqual(after.messages, [], "已删会话的消息仍留在视图");
});

test("BUG-23: turn 进行中新建会话 → 新会话视图不得残留旧会话消息", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  const send = userSend(s, "S1 的在途消息"); // turnStatus = waiting
  s = send.state;

  // 流式期间点「新建」（SessionList 的新建按钮不因 turn 禁用）
  const creating = beginCreateSession(s);
  const after = appFeed(creating.state, {
    type: "sessionList",
    sessions: [summary("S9", { updatedAt: 999 }), summary("S1")],
  });
  assert.equal(after.creatingSession, false);
  assert.deepEqual(
    after.messages.map((m) => m.text),
    [],
    `绑定已切到新会话，但回放被 turnStatus=${after.turnStatus} 挡掉，视图仍显示旧会话消息`,
  );
});

test("BUG-22: turn 进行中删除当前会话 → UI 不得卡在 waiting/禁用输入", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  const send = userSend(s, "S1 的在途消息");
  s = send.state;

  // 删 S1（宿主会 kill 其进程）→ 重绑 S2
  s = appFeed(s, { type: "sessionList", sessions: [summary("S2")] });
  assert.equal(s.sessionId, "S2");
  // 被 kill 的 S1 进程退出事件到达，但会话 id 已被过滤
  const afterExit = feed(s, {
    type: "streamEvent",
    sessionId: "S1",
    event: {
      kind: "procError",
      exitCode: null,
      stderrTail: "killed",
      reason: "SIGTERM",
    },
  });
  assert.equal(
    afterExit.turnStatus,
    "idle",
    `已删会话的终止事件被 sessionId 过滤 → UI 永久停在 ${afterExit.turnStatus}（输入框禁用，只能靠手动切会话自救）`,
  );
});

test("OBS-1: 终止事件先于 sessionList 到达 → 重绑清掉旧会话的错误横幅（不残留噪音）", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  s = userSend(s, "S1 的在途消息").state; // turnStatus = waiting

  // 真机竞态：宿主 kill 后进程先退出，终止事件早于「删除 + 推列表」到达——
  // 此刻 S1 仍绑定本视图，事件通过 sessionId 过滤并被应用（横幅出现）
  s = feed(s, {
    type: "streamEvent",
    sessionId: "S1",
    event: {
      kind: "procError",
      exitCode: null,
      stderrTail: "killed",
      reason: "SIGTERM",
    },
  });
  assert.ok(
    s.errorBanner?.includes("CLI 进程异常退出"),
    `前置条件不成立：终止事件未被应用（banner=${String(s.errorBanner)}）`,
  );

  // 随后 sessionList 到达（S1 已删）→ 重绑 S2
  const after = appFeed(s, { type: "sessionList", sessions: [summary("S2")] });
  assert.equal(after.sessionId, "S2");
  assert.equal(
    after.errorBanner,
    null,
    "已删会话的终止横幅残留在新会话视图（输入已解锁，纯噪音）",
  );
  assert.equal(after.errorCode, null);
});

test("BUG-26: 切换会话后立即发送 → history 回放不得被丢弃", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1"), summary("S2")],
  });
  s = chatOnce(s, "S1", "S1 的问题", "S1 的回答");
  const switched = selectSession(s, "S2").state;

  // 用户在回放到达前就发了消息（输入框在 switching 后即可用）
  const send = userSend(switched, "S2 的新问题");
  const late = feed(send.state, {
    type: "history",
    sessionId: "S2",
    messages: [
      { role: "user", text: "S2 的历史问", ts: 1 },
      { role: "assistant", text: "S2 的历史答", ts: 1 },
    ],
  });
  assert.deepEqual(
    late.messages.map((m) => m.text),
    ["S2 的历史问", "S2 的历史答", "S2 的新问题"],
    `回放被丢弃，视图缺少该会话既有上下文：${JSON.stringify(late.messages.map((m) => m.text))}`,
  );
});

test("D11-6b: 边界——删掉「最后一个」会话（解绑）→ UI 立即自愈，迟到的终止事件被丢弃不留噪音", () => {
  let s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  s = userSend(s, "S1 的在途消息").state; // waiting
  s = appFeed(s, { type: "sessionList", sessions: [] });

  // 自愈点：重绑把视图收敛回 idle（输入框立即可用），不依赖迟到的终止事件
  assert.equal(s.sessionId, null, "已删会话未解绑");
  assert.equal(s.turnStatus, "idle", "重绑未收敛 turn 状态（输入框仍禁用）");
  assert.equal(s.waitingSince, null);

  const killed = {
    kind: "procError",
    exitCode: null,
    stderrTail: "killed",
    reason: "SIGTERM",
  } as const;

  // 对照组：视图在途（waiting）时同一事件会被应用 → 证明「errorBanner 变化」是本事件的
  // 可观测效应，下面的 null 断言才有意义（OBS-4：只看 turnStatus 等于假绿——两条路径都是 idle）
  const inFlight = feed(
    { ...s, turnStatus: "waiting" },
    { type: "streamEvent", sessionId: "S1", event: killed },
  );
  assert.ok(
    inFlight.errorBanner?.includes("CLI 进程异常退出"),
    "对照组：终止事件的可观测效应不存在（用例本身失效）",
  );

  // 本体：已解绑且已收敛 → 迟到事件被 BUG-09 idle 守卫丢弃，不会给解绑后的视图留下
  // 一条再也抹不掉的「CLI 进程异常退出」横幅
  const late = feed(s, {
    type: "streamEvent",
    sessionId: "S1",
    event: killed,
  });
  assert.equal(late.turnStatus, "idle");
  assert.equal(
    late.errorBanner,
    null,
    `已删会话的终止事件留下噪音横幅（banner=${String(late.errorBanner)}）`,
  );
});

test("D11-8: SESSION_GONE 错误 → 置 errorCode 供「新建会话」按钮；新建在途标志一并清零", () => {
  const s = appFeed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  const gone = feed(s, {
    type: "error",
    code: "SESSION_GONE",
    message: "续接失败",
    sessionId: "S1",
  });
  assert.equal(gone.errorCode, "SESSION_GONE");
  assert.ok(gone.errorBanner?.startsWith("SESSION_GONE:"));

  // 记录-06 修复点：createSession 失败时按钮不得永久「新建中…」
  const creating = beginCreateSession(s);
  const failed = feed(creating.state, {
    type: "error",
    code: "ITEM_NOT_FOUND",
    message: "条目不存在",
  });
  assert.equal(failed.creatingSession, false, "新建失败后按钮停在「新建中…」");
});

test("D11-9: 中断按钮在无绑定会话时仍可用（记录-03 修复验证）", () => {
  const s: ChatState = {
    ...initialChatState(),
    turnStatus: "streaming",
    sessionId: null,
  };
  const r = interruptOf(s);
  assert.ok(r.msg, "无 sessionId 时中断按钮失效（记录-03 回归）");
  assert.equal(r.state.turnStatus, "interrupting");
});

// ---------- 用户需求 2026-09-11：重命名 + 同条目多会话区分 ----------

test("rename: 有绑定会话且标题有变 → 发 renameSession（trim）；无绑定/空标题/未改 → null", () => {
  const s: ChatState = {
    ...initialChatState(),
    connected: true,
    sessionId: "S1",
    sessions: [summary("S1", { title: "旧名" }), summary("S2", { title: "" })],
  };
  assert.deepEqual(renameSession(s, "  新名  "), {
    type: "renameSession",
    sessionId: "S1",
    title: "新名",
  });
  assert.equal(renameSession(s, "   "), null, "清空输入 = 放弃改名");
  assert.equal(renameSession(s, "旧名"), null, "没改就不发");
  assert.equal(renameSession({ ...s, sessionId: null }, "新名"), null);
});

test("label: 同一条目下多会话补时间戳区分；单会话/有自定义标题不补", () => {
  const t1 = Date.UTC(2026, 8, 11, 6, 30); // 本地时区渲染，只断言格式与区分性
  const time = formatSessionTime(t1);
  assert.match(time, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  const a = summary("A", {
    title: "这文献讲什么",
    itemTitle: "论文甲",
    itemKey: "ITEM1",
    createdAt: t1,
  });
  const b = summary("B", {
    title: "这文献讲什么",
    itemTitle: "论文甲",
    itemKey: "ITEM1",
    createdAt: t1 + 60_000,
  });
  const timeB = formatSessionTime(t1 + 60_000);
  const single = summary("C", {
    title: "唯一会话",
    itemTitle: "论文乙",
    itemKey: "ITEM2",
    createdAt: t1,
  });
  // 同一 itemKey 两条且同名 → 时间戳 + 序号（同分钟建的两条光靠时间也分不开，真机实测）
  assert.equal(sessionLabel(a, [a, b]), `论文甲 · 这文献讲什么 · ${time} #1`);
  assert.equal(sessionLabel(b, [a, b]), `论文甲 · 这文献讲什么 · ${timeB} #2`);
  assert.notEqual(sessionLabel(a, [a, b]), sessionLabel(b, [a, b]));
  // 同条目但标题不同 → 只加时间戳，不加序号（别给能分得开的加噪音）
  const c = summary("C", {
    title: "另一问",
    itemTitle: "论文甲",
    itemKey: "ITEM1",
    createdAt: t1,
  });
  assert.equal(sessionLabel(a, [a, c]), `论文甲 · 这文献讲什么 · ${time}`);
  // 同名但条目不同 → 条目名已能分开，不补时间戳
  const other = summary("D", {
    title: "这文献讲什么",
    itemTitle: "论文乙",
    itemKey: "ITEM9",
  });
  assert.equal(sessionLabel(a, [a, other]), "论文甲 · 这文献讲什么");
  // 该条目只有一条 → 不加时间戳（条目内已无歧义，别白占宽度）
  assert.equal(sessionLabel(single, [single]), "论文乙 · 唯一会话");
  // 无标题的会话一律补时间戳（多条「新会话」彼此分不出；无 createdAt → 占位「--」）
  const untitled = summary("U", { title: "", itemTitle: "论文丙" });
  assert.equal(sessionLabel(untitled, [untitled]), "论文丙 · 新会话 · --");
  // 无 createdAt（旧数据）→ 占位，不崩
  assert.equal(formatSessionTime(undefined), "--");
  assert.equal(formatSessionTime(0), "--");
});

test("label: 无 itemTitle 时不拼条目名；createdAt 经 sessionList 归一透传", () => {
  const s = feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1", { title: "问一", createdAt: 1_700_000_000_000 })],
  });
  assert.equal(s.sessions[0].createdAt, 1_700_000_000_000);
  assert.equal(
    sessionLabel(s.sessions[0], s.sessions),
    "问一", // 单会话且有标题 → 不加时间戳、无条目名
  );
});

// interrupt 直接引用避免顶部 import 列表过长
import { interrupt as interruptOf } from "../../src/chat/lib/chatModel.ts";
