// 单测 — F6：对话页顶栏权限档切换（chatModel 侧状态机）。
// 验收缺口（M10）：PLAN §2 要求「顶栏可切 default/acceptEdits/plan」，实测对话页无控件，
// 换档只能经设置页（仅影响新会话）。修法：顶栏三档控件 → setPermissionMode 消息
//（宿主更新索引，**下一轮 spawn 才生效**，§4.6）。本文件锁 reducer 行为：
// 消息发出、档位回显、状态行提示下轮生效、未知档不伪装成 default、换会话回未知。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  isPermissionMode,
  reduceHostMessage,
  selectSession,
  setPermissionMode,
  userSend,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage, SessionSummary } from "../../src/chat/lib/types.ts";

const summary = (id: string): SessionSummary => ({
  id,
  title: id,
  updatedAt: 0,
  itemKey: null,
  claudeSessionId: null,
  itemTitle: null,
});

function feed(state: ChatState, ...msgs: HostMessage[]): ChatState {
  return msgs.reduce((s, m) => reduceHostMessage(s, m), state);
}

/** 已绑定 S1、且有一轮在途（流事件仅在非 idle 态被应用） */
function inFlight(): ChatState {
  const bound = feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  return userSend(bound, "问一句").state;
}

function initEvent(permissionMode: unknown): HostMessage {
  return {
    type: "streamEvent",
    sessionId: "S1",
    event: {
      kind: "init",
      claudeSessionId: "c1",
      model: "m",
      permissionMode,
      tools: [],
      mcpServers: [],
    },
  } as HostMessage;
}

test("F6: init 事件报告的档位记入状态（顶栏回显的数据来源）", () => {
  const s = feed(inFlight(), initEvent("plan"));
  assert.equal(s.permissionMode, "plan");
  assert.ok(s.statusDetail.includes("plan"), "状态行未带档位");
});

test("F6: setPermissionMode → 发消息 + 立即回显 + 状态行提示下一轮生效", () => {
  const s = feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  assert.equal(s.permissionMode, null, "前置：档位未知");
  const r = setPermissionMode(s, "plan");
  assert.deepEqual(r.msg, {
    type: "setPermissionMode",
    sessionId: "S1",
    mode: "plan",
  });
  assert.equal(r.state.permissionMode, "plan", "顶栏未回显所选档位");
  assert.ok(r.state.statusDetail.includes("plan"));
  assert.ok(
    r.state.statusDetail.includes("下一轮生效"),
    "未告知宿主侧改动只在下一轮 spawn 生效",
  );
});

test("F6: 未绑定会话 → 不发消息（宿主对未知 sessionId 只会忽略）", () => {
  const s = initialChatState();
  const r = setPermissionMode(s, "acceptEdits");
  assert.equal(r.msg, null);
  assert.equal(r.state, s, "无会话时状态不该被改动");
});

test("F6: 档位畸形/非三档 → 不回显、不伪装成 default", () => {
  assert.equal(isPermissionMode("default"), true);
  assert.equal(isPermissionMode("acceptEdits"), true);
  assert.equal(isPermissionMode("plan"), true);
  assert.equal(isPermissionMode("bypassPermissions"), false);
  assert.equal(isPermissionMode(""), false);
  assert.equal(isPermissionMode(null), false);

  // 畸形 init：保留旧值，不把未知写成 default
  const before: ChatState = { ...inFlight(), permissionMode: "plan" };
  const s = feed(before, initEvent(123));
  assert.equal(s.permissionMode, "plan");
  // 从未知起步的畸形 init：仍是未知（顶栏显示占位项，而非假装 default）
  const fresh = feed(inFlight(), initEvent(undefined));
  assert.equal(fresh.permissionMode, null);
});

test("F6: 换会话（点选 / 重绑）→ 档位回未知，等新会话首轮 init 报告", () => {
  const s = feed(inFlight(), initEvent("plan"));
  const switched = selectSession(s, "S2").state;
  assert.equal(switched.permissionMode, null);

  const rebound = feed(
    { ...s, creatingSession: true },
    { type: "sessionList", sessions: [summary("S9")] },
  );
  assert.equal(rebound.permissionMode, null);
});
