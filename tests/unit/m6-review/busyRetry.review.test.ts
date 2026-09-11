// m6 复核轮 — 记录-06（SESSION_BUSY 自动重发）修复的独立场景验证（reducer 层）。
// 被测契约（修复自述）：被拒 → 保留在途轮 + 不弹横幅 + pendingRetry 置位；1 秒一次自动重发，
// 上限 5 次；被接受的最早证据 = 流事件到达（清标记）；用尽/中断 → M5 兜底（退字 + 横幅）；
// 用户新发送/切会话/非 BUSY 错误 → 重发作废；核心不变量 = BUSY 不丢消息（消息要么在途、要么回输入框）。
// 不复用修复者改过的 D9-1/D9-5~10 断言，序列全部自建。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consumeDraft,
  fireRetry,
  initialChatState,
  interrupt,
  reduceHostMessage,
  RETRY_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  selectSession,
  userSend,
  type ChatState,
} from "../../../src/chat/lib/chatModel.ts";
import type {
  HostMessage,
  SessionSummary,
} from "../../../src/chat/lib/types.ts";

const S1 = "S1";

const busy = (): HostMessage => ({
  type: "error",
  code: "SESSION_BUSY",
  message: "进行中的 turn 未结束",
  sessionId: S1,
});

function summary(id: string, updatedAt = 0): SessionSummary {
  return {
    id,
    title: id,
    updatedAt,
    itemKey: null,
    claudeSessionId: null,
    itemTitle: null,
  };
}

/** 与真实 App 同序：会话列表 → 发送 → 被拒 */
function rejected(text: string): ChatState {
  let s = initialChatState();
  s = reduceHostMessage(s, { type: "sessionList", sessions: [summary(S1)] });
  s = userSend(s, text).state;
  return reduceHostMessage(s, busy());
}

function accepted(state: ChatState): ChatState {
  return reduceHostMessage(state, {
    type: "streamEvent",
    sessionId: S1,
    event: { kind: "messageStart" },
  });
}

function userTexts(state: ChatState): string[] {
  return state.messages.filter((m) => m.role === "user").map((m) => m.text);
}

test("被拒态: 在途轮保留 + pendingRetry(0) + 无横幅无错误码 + 输入解锁", () => {
  const s = rejected("被拒的问题");
  assert.deepEqual(userTexts(s), ["被拒的问题"], "在途轮被退回（幽灵/闪没）");
  assert.deepEqual(s.pendingRetry, { text: "被拒的问题", attempts: 0 });
  assert.equal(s.restoreDraft, null, "重发期间不该同时退草稿");
  assert.equal(s.errorBanner, null);
  assert.equal(s.errorCode, null);
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.statusDetail.length > 0, "应有「收尾中」类提示文案");
});

test("重发: fireRetry 重发同一条且不追加新轮；再次被拒仅计数递增", () => {
  const r1 = fireRetry(rejected("问题"));
  assert.deepEqual(r1.msg, { type: "send", sessionId: S1, text: "问题" });
  assert.equal(r1.state.turnStatus, "waiting");
  assert.equal(r1.state.pendingRetry?.attempts, 1);
  assert.deepEqual(userTexts(r1.state), ["问题"], "重发叠加了重复 user 轮");

  const again = reduceHostMessage(r1.state, busy());
  assert.equal(again.pendingRetry?.attempts, 1, "再次被拒应保留计数");
  assert.deepEqual(userTexts(again), ["问题"]);
  assert.equal(again.errorBanner, null);
});

test("接受即收手: 流事件到达 → 清 pendingRetry，且不再有下一次重发", () => {
  const r = fireRetry(rejected("问题"));
  const ok = accepted(r.state);
  assert.equal(ok.pendingRetry, null);
  assert.equal(ok.turnStatus, "streaming");
  assert.deepEqual(userTexts(ok), ["问题"], "接受路径出现重复 user 轮");
  assert.equal(fireRetry(ok).msg, null, "接受后仍在重发");
  assert.deepEqual(fireRetry(ok).state, ok);
});

test("次数上限: 首发 + RETRY_MAX_ATTEMPTS 次重发全被拒 → 兜底（退字 + 横幅），总发送次数恰为上限+1", () => {
  let s = rejected("被拒的问题");
  let sends = 1; // 首次发送
  for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i++) {
    const r = fireRetry(s);
    assert.notEqual(r.msg, null, `第 ${i} 次重发应仍可发出`);
    sends++;
    s = reduceHostMessage(r.state, busy());
    if (i < RETRY_MAX_ATTEMPTS) {
      assert.equal(s.pendingRetry?.attempts, i, "未达上限不该提前兜底");
    }
  }
  assert.equal(sends, RETRY_MAX_ATTEMPTS + 1);
  assert.equal(s.pendingRetry, null, "用尽后仍挂重试态");
  assert.deepEqual(userTexts(s), [], "兜底后幽灵轮未退回");
  assert.equal(s.restoreDraft, "被拒的问题", "文字未退回输入框（丢字）");
  assert.equal(s.turnStatus, "idle");
  assert.ok(s.errorBanner, "兜底未弹横幅");
  assert.equal(fireRetry(s).msg, null, "兜底后仍在重发");
  assert.equal(consumeDraft(s).restoreDraft, null);
});

test("取消·用户新发送: 取消重发、旧拒轮退回不留幽灵、新消息照发", () => {
  const r = userSend(rejected("旧问题"), "新问题");
  assert.deepEqual(r.msg, { type: "send", sessionId: S1, text: "新问题" });
  assert.equal(r.state.pendingRetry, null);
  assert.deepEqual(userTexts(r.state), ["新问题"], "旧拒轮残留（幽灵）");
  assert.equal(r.state.restoreDraft, null);
  assert.equal(fireRetry(r.state).msg, null, "新发送后仍在重发旧文");
});

test("取消·切会话: 清 pendingRetry，绝不把旧文重发到新会话", () => {
  let s = rejected("旧问题");
  s = reduceHostMessage(s, {
    type: "sessionList",
    sessions: [summary("S2", 999), summary(S1)],
  });
  const sel = selectSession(s, "S2");
  assert.equal(sel.state.pendingRetry, null);
  assert.equal(sel.msg?.type, "getHistory");
  assert.equal(fireRetry(sel.state).msg, null);
});

test("取消·中断（重发在途）: 取消重发；该次被拒后收敛回 idle + 退字（防锁死）", () => {
  const r = fireRetry(rejected("问题"));
  const int = interrupt(r.state);
  assert.equal(int.msg?.type, "interrupt");
  assert.equal(int.state.turnStatus, "interrupting");
  assert.equal(int.state.pendingRetry, null, "中断未取消自动重发");

  const after = reduceHostMessage(int.state, busy());
  assert.equal(
    after.turnStatus,
    "idle",
    "中断后卡死在 interrupting（输入锁死）",
  );
  assert.equal(after.pendingRetry, null, "中断后仍自动重发");
  assert.deepEqual(userTexts(after), []);
  assert.equal(after.restoreDraft, "问题");
  assert.equal(fireRetry(after).msg, null);
});

test("取消·非 BUSY 错误（重发在途）: 重发作废 + 横幅告知，不静默续发", () => {
  const r = fireRetry(rejected("问题"));
  const failed = reduceHostMessage(r.state, {
    type: "error",
    code: "SPAWN_FAILED",
    message: "spawn 失败",
    sessionId: S1,
  });
  assert.equal(failed.pendingRetry, null);
  assert.equal(failed.turnStatus, "idle");
  assert.ok(failed.errorBanner, "非 BUSY 错误应告知");
  assert.equal(fireRetry(failed).msg, null);
});

test("防误退: 被拒时末条不是自己的 user 轮（异常序）→ 不置重发、不动消息", () => {
  let s = initialChatState();
  s = reduceHostMessage(s, { type: "sessionList", sessions: [summary(S1)] });
  s = reduceHostMessage(s, {
    type: "streamEvent",
    sessionId: S1,
    event: { kind: "messageStart" },
  });
  const s2 = reduceHostMessage(s, busy());
  assert.equal(s2.pendingRetry, null);
  assert.equal(s2.messages.length, s.messages.length);
});

test("常量与口径: 间隔 1 秒、上限 5 次（真机 BUSY 窗口 ≥2.3s 时够用）", () => {
  assert.equal(RETRY_DELAY_MS, 1000);
  assert.equal(RETRY_MAX_ATTEMPTS, 5);
});
