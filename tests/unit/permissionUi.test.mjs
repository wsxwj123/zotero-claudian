// 单测 — src/chat/lib/chatModel.ts 权限卡分支（M6，§4.6 permissionRequest/permissionResponse）
// 覆盖：卡的入列/幂等去重/畸形忽略、并行多卡队列、应答摘卡并产出 permissionResponse、
//        turn 结束与切会话时卡片作废（宿主侧在途请求已被 deny 结掉，卡留着点也没用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  permissionRespond,
  reduceHostMessage,
  selectSession,
} from "../../src/chat/lib/chatModel.ts";

const cardMsg = (requestId, tool = "Bash", summary = "python -V") => ({
  type: "permissionRequest",
  requestId,
  tool,
  inputSummary: summary,
  rawInput: { command: summary },
});

const st0 = () => ({
  ...initialChatState(),
  connected: true,
  turnStatus: "waiting",
});

test("权限卡：permissionRequest → 入列（字段归一）", () => {
  const s = reduceHostMessage(st0(), cardMsg("r1"));
  assert.equal(s.pendingPermissions.length, 1);
  assert.deepEqual(s.pendingPermissions[0], {
    requestId: "r1",
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
  });
});

test("权限卡：同 requestId 重放 → 幂等（原样返回，不重复入列）", () => {
  const s1 = reduceHostMessage(st0(), cardMsg("r1"));
  const s2 = reduceHostMessage(s1, cardMsg("r1"));
  assert.equal(s2, s1);
});

test("权限卡：缺/非法 requestId → 忽略", () => {
  const s = st0();
  assert.equal(
    reduceHostMessage(s, { type: "permissionRequest", tool: "Bash" }),
    s,
  );
  assert.equal(
    reduceHostMessage(s, {
      type: "permissionRequest",
      requestId: 42,
      tool: "Bash",
    }),
    s,
  );
});

test("权限卡：并行工具调用 → 多卡按到达顺序排队", () => {
  let s = reduceHostMessage(st0(), cardMsg("r1", "Bash", "ls"));
  s = reduceHostMessage(s, cardMsg("r2", "Write", "/w/a.txt"));
  assert.deepEqual(
    s.pendingPermissions.map((p) => [p.requestId, p.tool]),
    [
      ["r1", "Bash"],
      ["r2", "Write"],
    ],
  );
});

test("权限卡：流式事件不冲掉在途卡", () => {
  let s = reduceHostMessage(st0(), cardMsg("r1"));
  s = reduceHostMessage(s, {
    type: "streamEvent",
    sessionId: undefined,
    event: { kind: "textDelta", index: 0, text: "…" },
  });
  assert.equal(s.pendingPermissions.length, 1);
});

test("权限卡：permissionRespond → 只摘该卡并产出 §4.6 回包", () => {
  let s = reduceHostMessage(st0(), cardMsg("r1", "Bash", "ls"));
  s = reduceHostMessage(s, cardMsg("r2", "Write", "/w/a.txt"));
  const r = permissionRespond(s, "r1", true, true);
  assert.deepEqual(
    r.state.pendingPermissions.map((p) => p.requestId),
    ["r2"],
  );
  assert.deepEqual(r.msg, {
    type: "permissionResponse",
    requestId: "r1",
    allow: true,
    remember: true,
  });
  const deny = permissionRespond(s, "r2", false, false);
  assert.deepEqual(deny.msg, {
    type: "permissionResponse",
    requestId: "r2",
    allow: false,
    remember: false,
  });
});

test("权限卡：turn 结束（result/procError/resultError）→ 卡作废", () => {
  const withCard = reduceHostMessage(st0(), cardMsg("r1"));
  const afterResult = reduceHostMessage(withCard, {
    type: "streamEvent",
    event: {
      kind: "result",
      claudeSessionId: "c1",
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
    },
  });
  assert.deepEqual(afterResult.pendingPermissions, []);
  const afterProcError = reduceHostMessage(withCard, {
    type: "streamEvent",
    event: { kind: "procError", exitCode: 1, stderrTail: "boom" },
  });
  assert.deepEqual(afterProcError.pendingPermissions, []);
  const afterResultError = reduceHostMessage(withCard, {
    type: "streamEvent",
    event: { kind: "resultError", subtype: "error_max_turns", errors: [] },
  });
  assert.deepEqual(afterResultError.pendingPermissions, []);
});

test("权限卡：切会话 / 会话列表重绑 → 卡随视图清空（卡属于原会话的在途 turn）", () => {
  let s = reduceHostMessage({ ...st0(), sessionId: "s1" }, cardMsg("r1"));
  assert.equal(s.pendingPermissions.length, 1);
  const switched = selectSession(s, "s2");
  assert.deepEqual(switched.state.pendingPermissions, []);
  // 会话被删（列表里没有 s1）→ 自动重绑最新一条 → 同样清空
  const rebound = reduceHostMessage(s, {
    type: "sessionList",
    sessions: [
      {
        id: "s9",
        title: "别的会话",
        updatedAt: 1,
        itemKey: null,
        claudeSessionId: null,
      },
    ],
  });
  assert.equal(rebound.sessionId, "s9");
  assert.deepEqual(rebound.pendingPermissions, []);
});

test("权限卡：tool 字段畸形 → 归一为 unknown（不崩，卡照出）", () => {
  const s = reduceHostMessage(st0(), {
    type: "permissionRequest",
    requestId: "r1",
    tool: null,
    inputSummary: 7,
    rawInput: undefined,
  });
  assert.deepEqual(s.pendingPermissions[0], {
    requestId: "r1",
    tool: "unknown",
    inputSummary: "",
    rawInput: undefined,
  });
});
