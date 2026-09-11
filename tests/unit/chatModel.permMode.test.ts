// 单测 — F6：对话页顶栏权限档切换（chatModel 侧状态机）。
// 验收缺口（M10）：PLAN §2 要求「顶栏可切 default/acceptEdits/plan」，实测对话页无控件，
// 换档只能经设置页（仅影响新会话）。修法：顶栏三档控件 → setPermissionMode 消息
//（宿主更新索引，**下一轮 spawn 才生效**，§4.6）。本文件锁 reducer 行为：
// 消息发出、档位回显、状态行提示下轮生效、未知档不伪装成 default、换会话回未知。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bypassConfirmArmed,
  BYPASS_CONFIRM_WINDOW_MS,
  bypassOptionClick,
  cliPermissionModeToId,
  initialChatState,
  isPermissionMode,
  PERMISSION_MODE_OPTIONS,
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

// ---- R5：「放任」档（bypass）----

test("R5: isPermissionMode 认 bypass；CLI 报的 bypassPermissions 映射回内部 id", () => {
  assert.equal(isPermissionMode("bypass"), true);
  assert.equal(cliPermissionModeToId("bypassPermissions"), "bypass");
  assert.equal(cliPermissionModeToId("acceptEdits"), "acceptEdits");
  assert.equal(cliPermissionModeToId("plan"), "plan");
});

test("R5: init 报 bypassPermissions → 顶栏回显为 bypass（不是未知档）", () => {
  const s = feed(inFlight(), initEvent("bypassPermissions"));
  assert.equal(s.permissionMode, "bypass");
  assert.ok(s.statusDetail.includes("bypass"));
});

test("R5: 切到 bypass → 走既有 setPermissionMode 消息（宿主索引下一轮生效）", () => {
  const s = feed(initialChatState(), {
    type: "sessionList",
    sessions: [summary("S1")],
  });
  const r = setPermissionMode(s, "bypass");
  assert.deepEqual(r.msg, {
    type: "setPermissionMode",
    sessionId: "S1",
    mode: "bypass",
  });
});

test("R5: 顶栏档位项恰四项，顺序 default/acceptEdits/plan/bypass", () => {
  assert.deepEqual(
    PERMISSION_MODE_OPTIONS.map((o) => o.value),
    ["default", "acceptEdits", "plan", "bypass"],
  );
  assert.equal(PERMISSION_MODE_OPTIONS.length, 4);
  for (const o of PERMISSION_MODE_OPTIONS) {
    assert.ok(o.label.length > 0, `${o.value} 缺文案`);
  }
});

test("R5: 两步确认——第一次点只武装（不换档），窗口内再点才确认", () => {
  const t0 = 1_000_000;
  const first = bypassOptionClick(null, t0);
  assert.equal(first.confirmed, false, "第一次点击不得直接生效");
  assert.equal(first.armed, t0 + BYPASS_CONFIRM_WINDOW_MS);
  assert.equal(bypassConfirmArmed(first.armed, t0), true);

  const second = bypassOptionClick(first.armed, t0 + 1_200);
  assert.equal(second.confirmed, true, "窗口内第二次点击应确认生效");
  assert.equal(second.armed, null, "确认后武装状态清空");
});

test("R5: 两步确认——超时复原（超时后点击只是重新武装，不生效）", () => {
  const t0 = 1_000_000;
  const armed = bypassOptionClick(null, t0).armed;
  const late = t0 + BYPASS_CONFIRM_WINDOW_MS + 1;
  assert.equal(bypassConfirmArmed(armed, late), false, "超时后不再是已武装");
  const again = bypassOptionClick(armed, late);
  assert.equal(again.confirmed, false, "超时后的点击不该直接生效");
  assert.equal(again.armed, late + BYPASS_CONFIRM_WINDOW_MS, "应重新计时");
});

test("R5: 两步确认——边界：恰在窗口末端点击仍算确认（now == deadline）", () => {
  const t0 = 1_000_000;
  const armed = bypassOptionClick(null, t0).armed;
  const r = bypassOptionClick(armed, t0 + BYPASS_CONFIRM_WINDOW_MS);
  assert.equal(r.confirmed, true);
});

test("R5: 两步确认——取消（未武装时 armed 恒为 null，点击从 null 起步）", () => {
  assert.equal(bypassConfirmArmed(null, 1_000_000), false);
  const r = bypassOptionClick(null, 1_000_000);
  assert.equal(r.confirmed, false);
});
