// m5-retest —— BUG-22 / BUG-23 / BUG-26 的 UI 归约独立验证（纯 reducer 直打）。
// 复合链路（真宿主 + UI 集成）另见 m5.integration.retest.ts；本文件只压 reducer 的
// 边界与反向用例——每个断言都直接对应「修复前会挂」或「修复不得引入」的行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginCreateSession,
  initialChatState,
  reduceHostMessage,
  selectSession,
  userSend,
} from "../../../src/chat/lib/chatModel.ts";
import type { ChatState } from "../../../src/chat/lib/chatModel.ts";

const summary = (
  id: string,
  updatedAt = 0,
): {
  id: string;
  title: string;
  updatedAt: number;
  itemKey: null;
  claudeSessionId: null;
  itemTitle: null;
} => ({
  id,
  title: id,
  updatedAt,
  itemKey: null,
  claudeSessionId: null,
  itemTitle: null,
});

const feed = (state: ChatState, msg: unknown): ChatState =>
  reduceHostMessage(state, msg as never);

/** 输入框可用性 = App.ts 的 disabled 口径（busy = turnStatus !== "idle"） */
const inputEnabled = (s: ChatState): boolean => s.turnStatus === "idle";

const boundToS1 = (): ChatState =>
  feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("s1", 9), summary("s2", 1)],
  });

const streamingInS1 = (): ChatState => {
  let s = boundToS1();
  s = userSend(s, "s1 的在途问题").state; // waiting（乐观 user 轮）
  s = feed(s, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "messageStart" },
  });
  return feed(s, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "textDelta", index: 0, text: "流式中…" },
  });
};

// ---------- BUG-22：流式中删除当前会话 ----------

test("22-R1: 流式中删当前会话（还有别的会话）→ 视图清空 + 输入立即解锁", () => {
  const streaming = streamingInS1();
  assert.equal(streaming.turnStatus, "streaming");

  const after = feed(streaming, {
    type: "sessionList",
    sessions: [summary("s2")],
  });

  assert.equal(after.sessionId, "s2", "已删会话未解绑");
  assert.deepEqual(after.messages, [], "已删会话的消息残留在新会话视图");
  assert.equal(
    inputEnabled(after),
    true,
    `输入框仍禁用（turnStatus=${after.turnStatus}）——用户被卡死，只能手动切会话自救`,
  );

  // 被杀进程的迟到事件（真机形态：procError）不得把 UI 拉回任何忙碌态
  const late = feed(after, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "procError", exitCode: null, reason: "SIGTERM" },
  });
  assert.equal(inputEnabled(late), true);
  assert.deepEqual(late.messages, []);

  // 输入确实可用：在新会话里发送
  const send = userSend(late, "删除后的新问题");
  assert.equal(send.msg?.sessionId, "s2");
  assert.equal(send.state.turnStatus, "waiting");
});

test("22-R2: 流式中删「唯一」会话 → sessionId 归 null、输入解锁、再发走自动建会话", () => {
  const streaming = streamingInS1();
  const after = feed(streaming, { type: "sessionList", sessions: [] });

  assert.equal(after.sessionId, null);
  assert.deepEqual(after.messages, []);
  assert.equal(inputEnabled(after), true, "删最后一个会话后输入框仍禁用");

  // 迟到事件（sessionId 已为 null，过滤条件放行）不得破坏空闲态
  const late = feed(after, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "textDelta", index: 0, text: "迟到内容" },
  });
  assert.equal(inputEnabled(late), true);
  assert.deepEqual(late.messages, [], "迟到 delta 落进了空视图");

  const send = userSend(late, "重开一条");
  assert.equal(
    send.msg?.sessionId,
    null,
    "无会话时应走缺省 send（宿主自动建会话）",
  );
});

test("22-R3: 删除的不是当前会话 → 视图与在途状态一概不动（反向用例）", () => {
  const streaming = streamingInS1();
  const after = feed(streaming, {
    type: "sessionList",
    sessions: [summary("s1", 9)],
  });
  assert.equal(after.sessionId, "s1");
  assert.equal(after.turnStatus, "streaming", "删他会话把当前在途 turn 拍平了");
  assert.equal(after.messages.length, 2, "删他会话清空了当前视图");
});

// ---------- BUG-23：流式中新建会话 ----------

test("23-R1: 流式中新建会话 → 新会话视图干净（无旧消息、无在途态）", () => {
  const streaming = streamingInS1();
  const creating = beginCreateSession(streaming);
  assert.equal(creating.state.creatingSession, true);

  const after = feed(creating.state, {
    type: "sessionList",
    sessions: [summary("s9", 999), summary("s1", 9)],
  });
  assert.equal(after.sessionId, "s9", "未绑定到新建会话");
  assert.deepEqual(
    after.messages,
    [],
    `新会话视图残留旧会话消息（turnStatus=${after.turnStatus} 挡掉了回放）`,
  );
  assert.equal(inputEnabled(after), true);
  assert.equal(after.creatingSession, false, "「新建中…」未收敛");

  // 新会话空回放到达 → 视图照样干净
  const replayed = feed(after, {
    type: "history",
    sessionId: "s9",
    messages: [],
  });
  assert.deepEqual(replayed.messages, []);
});

// ---------- BUG-26：切会话即回放 + 切换后立即发送 ----------

test("26-R1: 切换会话（idle）→ 回放整份落位（该会话上下文可见）", () => {
  const streaming = streamingInS1();
  const sel = selectSession(streaming, "s2");
  assert.deepEqual(sel.msg, { type: "getHistory", sessionId: "s2" });

  const replayed = feed(sel.state, {
    type: "history",
    sessionId: "s2",
    messages: [
      { role: "user", text: "s2 旧问", ts: 1 },
      { role: "assistant", text: "s2 旧答", ts: 1 },
    ],
  });
  assert.deepEqual(
    replayed.messages.map((m) => m.text),
    ["s2 旧问", "s2 旧答"],
  );
});

test("26-R2: 切换后立即发送 → 回放在前、本地在途轮在后（回放不得被丢）", () => {
  const streaming = streamingInS1();
  const sel = selectSession(streaming, "s2");
  const send = userSend(sel.state, "s2 新问题"); // 回放到达前就发了
  assert.equal(send.state.turnStatus, "waiting");

  const afterReplay = feed(send.state, {
    type: "history",
    sessionId: "s2",
    messages: [
      { role: "user", text: "s2 旧问", ts: 1 },
      { role: "assistant", text: "s2 旧答", ts: 1 },
    ],
  });
  assert.deepEqual(
    afterReplay.messages.map((m) => m.text),
    ["s2 旧问", "s2 旧答", "s2 新问题"],
    `回放被丢弃或乐观轮被抹掉：${JSON.stringify(afterReplay.messages.map((m) => m.text))}`,
  );
  assert.equal(afterReplay.turnStatus, "waiting", "回放把在途状态拍平了");
});

test("26-R3: 切换后立即发送且流已开始 → 回放插入不破坏在途 assistant 块", () => {
  let s = selectSession(streamingInS1(), "s2").state;
  s = userSend(s, "s2 新问题").state;
  s = feed(s, {
    type: "streamEvent",
    sessionId: "s2",
    event: { kind: "messageStart" },
  });
  s = feed(s, {
    type: "streamEvent",
    sessionId: "s2",
    event: { kind: "textDelta", index: 0, text: "流式回答" },
  });

  const after = feed(s, {
    type: "history",
    sessionId: "s2",
    messages: [{ role: "user", text: "s2 旧问", ts: 1 }],
  });
  assert.deepEqual(
    after.messages.map((m) => m.role),
    ["user", "user", "assistant"],
  );
  const assistant = after.messages[2];
  assert.equal(assistant.blocks?.[0]?.blockType, "text");
  assert.equal(
    assistant.blocks && "text" in assistant.blocks[0]
      ? assistant.blocks[0].text
      : null,
    "流式回答",
    "在途 assistant 块内容被回放覆盖/清空",
  );
});

test("26-R4: 他会话回放不落当前视图；他会话错误不影响本视图（反向用例）", () => {
  const replayed = feed(streamingInS1(), {
    type: "history",
    sessionId: "s2",
    messages: [{ role: "user", text: "别人的历史", ts: 1 }],
  });
  assert.equal(
    replayed.messages.some((m) => m.text === "别人的历史"),
    false,
    "他会话回放串进了当前视图",
  );
  const errored = feed(streamingInS1(), {
    type: "error",
    code: "SESSION_GONE",
    message: "别的会话没了",
    sessionId: "s2",
  });
  assert.equal(errored.errorBanner, null, "他会话错误影响了本视图");
  assert.equal(errored.turnStatus, "streaming");
});

// ---------- 边界与现状固化（重测轮新增观察，非修复点） ----------

test("22-R4（OBS-1 修复后）: 被杀进程的终止事件先于 sessionList 到达 → 重绑清掉错误横幅", () => {
  let s = streamingInS1();
  // 宿主 kill 后进程先退出（真实竞态：退出事件与索引删除/sessionList 推送给谁先到不保证）
  s = feed(s, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "procError", exitCode: null, reason: "SIGTERM" },
  });
  assert.ok(
    s.errorBanner?.includes("CLI 进程异常退出"),
    "前置条件：错误横幅已出现",
  );

  const after = feed(s, { type: "sessionList", sessions: [summary("s2")] });
  assert.equal(inputEnabled(after), true);
  // OBS-1 修复后：重绑一并清 errorBanner/errorCode，不留残留红条
  assert.equal(after.errorBanner, null, "重绑须清错误横幅（OBS-1）");
});

test("26-R5（现状固化）: 切进正在跑的会话 → 其流事件被 idle 守卫丢弃，完成后视图不刷新", () => {
  let s = boundToS1();
  const sel = selectSession(s, "s1");
  assert.equal(sel.state.turnStatus, "idle");

  // s1 在宿主侧仍在跑：messageStart/… 事件到达本视图（sessionId 匹配，过滤放行）
  s = feed(sel.state, {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "messageStart" },
  });
  assert.deepEqual(
    s.messages,
    [],
    "现状：切进在跑会话时流事件被 idle 守卫丢弃",
  );

  // turn 结束的 result 同样被丢弃 → 视图停在切换时的回放内容（须再切一次才刷新）
  s = feed(s, {
    type: "streamEvent",
    sessionId: "s1",
    event: {
      kind: "result",
      claudeSessionId: "c1",
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
    },
  });
  assert.equal(s.turnStatus, "idle");
  assert.deepEqual(s.messages, []);
  assert.equal(
    s.statusDetail,
    "",
    "现状：切进在跑会话时完成状态不反映到状态行",
  );
});
