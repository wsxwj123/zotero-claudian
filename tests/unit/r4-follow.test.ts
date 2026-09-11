// 单测 — R4 需求 1「会话跟随」纯函数 followReader（PLAN-R4 §2，黑盒：只按契约写）。
// 契约：followReader(state, itemKey) -> { state, changed }
//   itemKey == null → 不变；当前会话属于该 itemKey → 不变（不抢用户手选）；
//   否则 → 切到该 itemKey 下 updatedAt 最大的会话，没有则 sessionId = null（不新建会话）；
//   换绑定走「换视图」语义（清空 messages/pendingPermissions/turnStatus，与 selectSession 一致）；
//   在途 turn 照常跟随。
// changed 口径（主会话 R4 裁决 A4）：newSessionId !== oldSessionId && newSessionId !== null
//   —— 只有真的切到「另一条会话」才为真（调用方据此补发 getHistory）；绑到 null 只是清空视图，为假。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followReader,
  initialChatState,
} from "../../src/chat/lib/chatModel.ts";

// sessionList 条目形状（与 chatModel.test.mjs 既有用例一致）
const S = (id: string, itemKey: string | null, updatedAt: number) => ({
  id,
  title: id,
  updatedAt,
  itemKey,
});

/** 造一个只有会话列表 / 当前会话不同的基础状态，避免每例手写全量字段 */
function st(
  sessions: ReturnType<typeof S>[],
  sessionId: string | null,
  over: Record<string, unknown> = {},
): any {
  return { ...initialChatState(), sessions, sessionId, ...over };
}

// ---- 基本跟随 ----

test("跟随：当前会话属于别的条目 → 切到新条目下的会话", () => {
  const s = st([S("a", "X", 5), S("b", "Y", 3)], "a");
  const r = followReader(s, "Y");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "b");
});

test("跟随：新条目下多会话 → 取 updatedAt 最大者（输入乱序）", () => {
  const s = st([S("c", "Y", 7), S("a", "Y", 9), S("b", "Y", 3)], null);
  const r = followReader(s, "Y");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "a");
});

test("跟随：当前会话已属于该条目 → 不动（用户手选的旧会话不被抢）", () => {
  // a 属于 X 但不是 X 下最新的：跟随也不该改绑到 b
  const s = st([S("b", "X", 9), S("a", "X", 5)], "a");
  const r = followReader(s, "X");
  assert.equal(r.changed, false);
  assert.equal(r.state.sessionId, "a");
});

test("跟随：当前 sessionId 不在列表里（会话已删/未同步）→ 按新条目重新找", () => {
  const s = st([S("b", "Y", 3)], "ghost");
  const r = followReader(s, "Y");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "b");
});

test("跟随：itemKey 为 null → 原样返回", () => {
  const s = st([S("a", "X", 5), S("b", null, 9)], "a");
  const r = followReader(s, null);
  assert.equal(r.changed, false);
  assert.equal(r.state.sessionId, "a");
  assert.equal(r.state.sessions.length, 2);
});

// ---- changed 取值（裁决 A4：newSessionId !== oldSessionId && newSessionId !== null）----

test("changed：切到有会话的条目 → true（调用方据此补发 getHistory）", () => {
  const r = followReader(st([S("a", "X", 1), S("b", "Y", 2)], "a"), "Y");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "b");
});

test("changed：切到无会话的条目（绑 null）→ false", () => {
  const r = followReader(st([S("a", "X", 1)], "a"), "Y");
  assert.equal(r.changed, false);
  assert.equal(r.state.sessionId, null);
});

test("changed：原地不动（itemKey=null / 已是该条目）→ false", () => {
  const s = st([S("a", "X", 1)], "a");
  assert.equal(followReader(s, null).changed, false);
  assert.equal(followReader(s, "X").changed, false);
});

// ---- 空状态：不新建会话 ----

test("跟随：该条目下无会话 → sessionId 置 null，且不新建会话（列表不变）", () => {
  const before = [S("a", "X", 5)];
  const s = st([...before], "a");
  const r = followReader(s, "Z");
  assert.equal(r.changed, false); // 绑到 null 只是清空视图，不拉历史（A4）
  assert.equal(r.state.sessionId, null);
  assert.equal(r.state.sessions.length, 1);
  assert.deepEqual(r.state.sessions, before);
});

test("跟随：绑到 null 时也清空视图（换视图语义照旧，只是 changed=false）", () => {
  const s = st([S("a", "X", 5)], "a", {
    messages: [{ role: "user", text: "旧内容" }],
    pendingPermissions: [{ id: "p1" }],
    turnStatus: "streaming",
  });
  const r = followReader(s, "Z");
  assert.equal(r.changed, false);
  assert.equal(r.state.sessionId, null);
  assert.deepEqual(r.state.messages, []);
  assert.deepEqual(r.state.pendingPermissions, []);
  assert.equal(r.state.turnStatus, "idle");
});

test("跟随：列表里只有通用会话（itemKey=null）→ 不算该条目的会话，置空", () => {
  const s = st([S("g", null, 99)], "g");
  const r = followReader(s, "X");
  assert.equal(r.changed, false); // 同样只是从 g 绑到 null
  assert.equal(r.state.sessionId, null);
});

test("跟随：该条目有专属会话时不选通用会话（哪怕它的 updatedAt 更大）", () => {
  const s = st([S("g", null, 99), S("a", "X", 1)], "g");
  const r = followReader(s, "X");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "a");
});

// ---- 换视图语义（与 selectSession 一致）----

test("跟随：换绑定清空视图（messages / pendingPermissions / turnStatus）", () => {
  const s = st([S("a", "X", 1), S("b", "Y", 2)], "a", {
    messages: [{ role: "user", text: "旧会话内容" }],
    pendingPermissions: [{ id: "p1" }],
    turnStatus: "streaming",
  });
  const r = followReader(s, "Y");
  assert.equal(r.state.sessionId, "b");
  assert.deepEqual(r.state.messages, []);
  assert.deepEqual(r.state.pendingPermissions, []);
  assert.equal(r.state.turnStatus, "idle");
});

test("跟随：换绑定同时清掉错误横幅与笔记选择器（selectSession 归零语义）", () => {
  const s = st([S("a", "X", 1), S("b", "Y", 2)], "a", {
    errorBanner: "旧错误",
    errorCode: "SPAWN_FAILED",
    notePicker: { notes: [{ key: "N1" }] },
  });
  const r = followReader(s, "Y");
  assert.equal(r.state.errorBanner, null);
  assert.equal(r.state.errorCode, null);
  assert.equal(r.state.notePicker, null);
});

test("跟随：在途 turn（turnStatus=waiting）也照样跟随", () => {
  const s = st([S("a", "X", 1), S("b", "Y", 2)], "a", {
    turnStatus: "waiting",
    waitingSince: 1234567,
  });
  const r = followReader(s, "Y");
  assert.equal(r.changed, true);
  assert.equal(r.state.sessionId, "b");
  assert.equal(r.state.turnStatus, "idle");
});

test("跟随：同条目时在途 turn 不受影响（不改 turnStatus）", () => {
  const s = st([S("a", "X", 1)], "a", { turnStatus: "streaming" });
  const r = followReader(s, "X");
  assert.equal(r.changed, false);
  assert.equal(r.state.turnStatus, "streaming");
});

// ---- 无变化时不做多余拷贝（沿用 chatModel 既有归约约定）----

test("跟随：itemKey=null 无变化 → 返回原对象（同一引用）", () => {
  const s = st([S("a", "X", 5)], "a");
  assert.equal(followReader(s, null).state, s);
});

test("跟随：已在该条目上无变化 → 返回原对象（同一引用）", () => {
  const s = st([S("a", "X", 5), S("b", "X", 9)], "a");
  assert.equal(followReader(s, "X").state, s);
});

// ---- updatedAt 边界（契约只写「取最大者」，缺失值行为在此锁定）----

test("跟随：updatedAt 缺失的会话不被选中（有合法值者胜，且不受输入顺序影响）", () => {
  const bad = { id: "bad", title: "bad", itemKey: "Y" } as any;
  const r1 = followReader(st([bad, S("good", "Y", 5)], null), "Y");
  assert.equal(r1.state.sessionId, "good");
  const r2 = followReader(st([S("good", "Y", 5), bad], null), "Y");
  assert.equal(r2.state.sessionId, "good");
});

test("跟随：全都没有 updatedAt → 也选出一条（不崩、不置空）", () => {
  const a = { id: "a", title: "a", itemKey: "Y" } as any;
  const b = { id: "b", title: "b", itemKey: "Y" } as any;
  const r = followReader(st([a, b], null), "Y");
  assert.ok(
    r.state.sessionId === "a" || r.state.sessionId === "b",
    `应选出一条，实际 ${String(r.state.sessionId)}`,
  );
});
