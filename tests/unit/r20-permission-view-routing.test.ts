// 单测 — R20 §3 权限卡的视图归属判定表 + §7 非法输入 + 修订 r3 pendingPermissionElsewhere
//
// 契约来源：.devflow/INTERFACE-R20.md §2.1/§2.2/§2.3/§2.4、§3 判定表、§6、§7，
// 以及修订 r2（r2-2 / r2-3 / r2-5）与修订 r3（空面板提示的公开纯函数）。§8 已作废，不测。
// 黑盒：只按契约写，不看实现。
// 一句话口径：带字符串 sessionId 的权限卡只被绑定到该会话的视图接收；
//            不带（或非字符串）则按全局消息照常显示；permissionResolved 永远不做会话判定。
//
// 本文件红/绿计数（改动时同步更新）：🔴 修前必红 = 21 条；🔒 修前就绿 = 17 条。合计 38 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  permissionRespond,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import * as chatModel from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

const SA = "sA"; // 卡所属会话（文献 A）
const SC = "sC"; // 另一条会话（文献 C）

const msg = (m: Record<string, unknown>): HostMessage =>
  m as unknown as HostMessage;

// ---- 三种视图状态（§3 的三列）----

const boundIdle = (sid: string): ChatState =>
  ({
    ...initialChatState(),
    connected: true,
    sessionId: sid,
    turnStatus: "waiting",
  }) as unknown as ChatState;

const unboundIdle = (): ChatState =>
  ({
    ...initialChatState(),
    connected: true,
    sessionId: null,
  }) as unknown as ChatState;

// ---- 断言原语（与 R19 同口径）----

/** 丢弃 = 整个状态对象逐字段不变（§7 末行） */
function assertDropped(before: ChatState, m: HostMessage, why: string): void {
  const after = reduceHostMessage(before, m);
  assert.deepEqual(after, before, why);
}

/** 应用 = 状态确实被这条消息改动过 */
function assertApplied(before: ChatState, m: HostMessage): ChatState {
  const after = reduceHostMessage(before, m);
  assert.notDeepEqual(
    after,
    before,
    "这条消息归本视图，必须产生可观察的状态变化",
  );
  return after;
}

// ---- 标准载荷 ----

/** §2.1 的五字段卡；extra 覆盖 sessionId（含缺失/非法） */
const cardMsg = (
  extra: Record<string, unknown> = {},
  requestId = "req-1",
): HostMessage =>
  msg({
    type: "permissionRequest",
    sessionId: SA,
    requestId,
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
    ...extra,
  });

/** 老宿主的四字段卡（连 sessionId 这个键都没有） */
const legacyCard = (requestId = "req-1"): HostMessage =>
  msg({
    type: "permissionRequest",
    requestId,
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
  });

const resolved = (requestId: string): HostMessage =>
  msg({ type: "permissionResolved", requestId });

/** 卡入列后的形状（§1：本轮不变，四字段，不含 sessionId） */
const CARD = {
  requestId: "req-1",
  tool: "Bash",
  inputSummary: "python -V",
  rawInput: { command: "python -V" },
};

const sessionRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `会话 ${id}`,
  updatedAt: 10,
  itemKey: `ITEM_${id}`,
  claudeSessionId: null,
  itemTitle: null,
  usage: null,
  ...extra,
});

// ================= §3 判定表：permissionRequest =================

test("🔒 permissionRequest{sessionId:sA} / 绑定同会话 → 卡入列（四字段逐字，末尾追加）", () => {
  const after = reduceHostMessage(boundIdle(SA), cardMsg());
  assert.deepEqual(after.pendingPermissions, [CARD]);
});

test("🔴 permissionRequest{sessionId:sA} / 绑定他会话 sC → 丢弃", () => {
  assertDropped(
    boundIdle(SC),
    cardMsg(),
    "绑着 sC 的面板不得弹出 sA 的权限卡（R20-1 串屏原形）",
  );
});

test("🔴 permissionRequest{sessionId:sA} / 未绑定空面板 → 丢弃", () => {
  assertDropped(
    unboundIdle(),
    cardMsg(),
    "空面板不得弹出任何会话的权限卡（R20-1）",
  );
});

test("🔒 permissionRequest 无 sessionId 键 / 绑定同会话 → 应用（老宿主兼容）", () => {
  const after = reduceHostMessage(boundIdle(SA), legacyCard());
  assert.deepEqual(after.pendingPermissions, [CARD]);
});

test("🔒 permissionRequest 无 sessionId 键 / 绑定他会话 → 应用（老宿主按全局显示）", () => {
  const after = reduceHostMessage(boundIdle(SC), legacyCard());
  assert.deepEqual(after.pendingPermissions, [CARD]);
});

test("🔒 permissionRequest 无 sessionId 键 / 未绑定 → 应用（老宿主按全局显示）", () => {
  const after = reduceHostMessage(unboundIdle(), legacyCard());
  assert.deepEqual(after.pendingPermissions, [CARD]);
});

test("🔒 permissionRequest sessionId 非字符串（null/undefined/数字/对象/数组）→ 全局放行", () => {
  for (const bad of [null, undefined, 42, {}, [SA], true] as unknown[]) {
    const after = reduceHostMessage(boundIdle(SC), cardMsg({ sessionId: bad }));
    assert.deepEqual(
      after.pendingPermissions,
      [CARD],
      `sessionId=${JSON.stringify(bad)} 属非字符串 → 按老宿主全局消息放行`,
    );
  }
});

test('🔴 permissionRequest{sessionId:""} / 绑定同会话 → 丢弃（state.sessionId 永不为空串）', () => {
  assertDropped(
    boundIdle(SA),
    cardMsg({ sessionId: "" }),
    "空串是会话级但配不上任何视图 ⇒ 谁都不收",
  );
});

test('🔴 permissionRequest{sessionId:""} / 绑定他会话 → 丢弃', () => {
  assertDropped(boundIdle(SC), cardMsg({ sessionId: "" }), "空串一律丢弃");
});

test('🔴 permissionRequest{sessionId:""} / 未绑定 → 丢弃', () => {
  assertDropped(unboundIdle(), cardMsg({ sessionId: "" }), "空串一律丢弃");
});

test("🔒 permissionRequest 判定顺序：会话守卫先于 requestId 校验（缺 requestId 且非本会话 → 丢弃不抛）", () => {
  const before = boundIdle(SC);
  const m = msg({
    type: "permissionRequest",
    sessionId: SA,
    tool: "Bash",
    inputSummary: "python -V",
    rawInput: { command: "python -V" },
  });
  assert.doesNotThrow(() => reduceHostMessage(before, m));
  assertDropped(before, m, "缺 requestId 的他会话卡：两道关任何一道都必须挡住");
});

test("🔒 permissionRequest requestId 为空串（本会话）→ 忽略整条", () => {
  assertDropped(
    boundIdle(SA),
    cardMsg({}, ""),
    "空 requestId 无法结算，今天就忽略，本轮不变",
  );
});

test("🔴 permissionRequest 多卡混流：绑 sA 只收 sA 的卡，sC 的卡不入列", () => {
  let s = reduceHostMessage(boundIdle(SA), cardMsg({}, "req-1"));
  s = reduceHostMessage(s, cardMsg({ sessionId: SC }, "req-2"));
  s = reduceHostMessage(s, cardMsg({}, "req-3"));
  assert.deepEqual(
    s.pendingPermissions.map((p) => p.requestId),
    ["req-1", "req-3"],
    "他会话的卡不入列；本会话的卡按到达顺序末尾追加",
  );
});

// ================= §2.2 / §3：permissionResolved 永远不做会话判定 =================

test("🔒 permissionResolved / 绑定同会话 → 摘掉对应的卡", () => {
  const withCard = reduceHostMessage(boundIdle(SA), cardMsg());
  const after = reduceHostMessage(withCard, resolved("req-1"));
  assert.deepEqual(after.pendingPermissions, []);
});

test("🔒 permissionResolved / 绑定他会话且本地无此卡 → 原样返回（不抛、状态不变）", () => {
  const before = boundIdle(SC);
  assert.doesNotThrow(() => reduceHostMessage(before, resolved("req-1")));
  assertDropped(before, resolved("req-1"), "本地没这张 ⇒ 无事发生");
});

test("🔒 permissionResolved / 未绑定且本地无此卡 → 原样返回（不抛、状态不变）", () => {
  const before = unboundIdle();
  assertDropped(before, resolved("req-1"), "本地没这张 ⇒ 无事发生");
});

test("🔒 permissionResolved 不得被加上会话过滤：绑 sC 的老宿主卡也必须摘掉", () => {
  // 老宿主（卡不带 sessionId）在绑 sC 的面板上入了列；摘卡通知是全局消息，
  // 若给 permissionResolved 加会话守卫，这张卡将永久残影（§2.2 明写：别"顺手"加过滤）。
  const withCard = reduceHostMessage(boundIdle(SC), legacyCard());
  assert.equal(withCard.pendingPermissions.length, 1, "夹具自检：卡已入列");
  const after = reduceHostMessage(withCard, resolved("req-1"));
  assert.deepEqual(after.pendingPermissions, []);
});

test("🔒 permissionResolved requestId 未知 / 空串 / 缺失 → 原样返回不抛", () => {
  const withCard = reduceHostMessage(boundIdle(SA), cardMsg());
  for (const m of [
    resolved("没见过的-id"),
    resolved(""),
    msg({ type: "permissionResolved" }),
  ]) {
    const after = reduceHostMessage(withCard, m);
    assert.deepEqual(after.pendingPermissions, [CARD], "在途卡不得被误摘");
  }
});

// ================= §7 / r2-4：同 requestId 幂等（含切回补推的二次到达）=================

test("🔒 补推幂等：同 requestId 的卡二次到达 → 不重复入列（队列长度不变）", () => {
  const s1 = reduceHostMessage(boundIdle(SA), cardMsg());
  const s2 = reduceHostMessage(s1, cardMsg());
  assert.deepEqual(s2.pendingPermissions, [CARD]);
  assert.equal(s2.pendingPermissions.length, 1);
});

test("🔒 补推幂等：补推不改变既有卡的相对次序", () => {
  let s = reduceHostMessage(boundIdle(SA), cardMsg({}, "req-1"));
  s = reduceHostMessage(s, cardMsg({}, "req-2"));
  const after = reduceHostMessage(s, cardMsg({}, "req-1")); // 补推第一张
  assert.deepEqual(
    after.pendingPermissions.map((p) => p.requestId),
    ["req-1", "req-2"],
    "补推不得把老卡挪到队尾",
  );
});

// ================= §6 / r2-5 对照组：不回归 =================

test("🔒 permissionRespond 产出的 permissionResponse 形状一字不改（§2.3）", () => {
  const withCard = reduceHostMessage(boundIdle(SA), cardMsg());
  const out = permissionRespond(withCard, "req-1", true, true);
  assert.deepEqual(out.msg, {
    type: "permissionResponse",
    requestId: "req-1",
    allow: true,
    remember: true,
  });
  assert.deepEqual(out.state.pendingPermissions, [], "本地立即摘卡（乐观）");
});

test("🔴 未绑定视图的 pendingPermissions 恒为空数组（卡从不入列 ⇒ 没有允许的路径）", () => {
  let s = unboundIdle();
  for (const id of ["req-1", "req-2", "req-3"]) {
    s = reduceHostMessage(s, cardMsg({}, id));
    s = reduceHostMessage(s, cardMsg({ sessionId: SC }, id));
  }
  assert.deepEqual(s.pendingPermissions, []);
});

// ================= §2.4 / r2-2：sessionList 条目的 pendingPermission（UI 侧归一）=================

test("🔒 sessionList 条目缺 pendingPermission（老宿主）→ 不崩，列表照常落地", () => {
  const before = unboundIdle();
  const after = reduceHostMessage(
    before,
    msg({ type: "sessionList", sessions: [sessionRow(SA), sessionRow(SC)] }),
  );
  assert.equal(after.sessions.length, 2);
});

test('🔒 sessionList 条目 pendingPermission 非布尔（"true"/1/{}）→ 不崩，列表照常落地', () => {
  const before = unboundIdle();
  const after = reduceHostMessage(
    before,
    msg({
      type: "sessionList",
      sessions: [
        sessionRow(SA, { pendingPermission: "true" }),
        sessionRow(SC, { pendingPermission: 1 }),
        sessionRow("sD", { pendingPermission: {} }),
      ],
    }),
  );
  assert.equal(after.sessions.length, 3);
});

// ================= 修订 r3：pendingPermissionElsewhere(state) =================

type Predicate = (state: ChatState) => boolean;

const exported = (
  chatModel as unknown as { pendingPermissionElsewhere?: Predicate }
).pendingPermissionElsewhere;

/** 只调用、不看实现；函数没导出时给出明确的失败原因 */
function ppe(state: ChatState): boolean {
  assert.equal(
    typeof exported,
    "function",
    "R20 修订 r3：src/chat/lib/chatModel.ts 必须导出纯函数 pendingPermissionElsewhere(state)",
  );
  return (exported as Predicate)(state);
}

/** ①未绑定 ②已连接 ③存在 pendingPermission===true 的条目 */
const truthState = (
  unbound: boolean,
  connected: boolean,
  flagged: boolean,
): ChatState =>
  ({
    ...initialChatState(),
    sessionId: unbound ? null : SA,
    connected,
    sessions: [
      sessionRow(SA, { pendingPermission: flagged }),
      sessionRow(SC, { pendingPermission: false }),
    ],
  }) as unknown as ChatState;

test("🔴 ppe 真值表 ①未绑定✓ ②已连接✓ ③有待审批✓ → true", () => {
  assert.equal(ppe(truthState(true, true, true)), true);
});

test("🔴 ppe 真值表 ①✓ ②✓ ③✗（没有任何会话待审批）→ false", () => {
  assert.equal(ppe(truthState(true, true, false)), false);
});

test("🔴 ppe 真值表 ①✓ ②✗（未连接）③✓ → false", () => {
  assert.equal(ppe(truthState(true, false, true)), false);
});

test("🔴 ppe 真值表 ①✓ ②✗ ③✗ → false", () => {
  assert.equal(ppe(truthState(true, false, false)), false);
});

test("🔴 ppe 真值表 ①✗（已绑定 sA）②✓ ③✓ → false", () => {
  assert.equal(ppe(truthState(false, true, true)), false);
});

test("🔴 ppe 真值表 ①✗ ②✓ ③✗ → false", () => {
  assert.equal(ppe(truthState(false, true, false)), false);
});

test("🔴 ppe 真值表 ①✗ ②✗ ③✓ → false", () => {
  assert.equal(ppe(truthState(false, false, true)), false);
});

test("🔴 ppe 真值表 ①✗ ②✗ ③✗ → false", () => {
  assert.equal(ppe(truthState(false, false, false)), false);
});

test("🔴 ppe 归一：sessions 非数组（null/undefined/字符串/对象）→ false，不抛", () => {
  for (const bad of [null, undefined, "junk", {}, 7] as unknown[]) {
    const state = {
      ...initialChatState(),
      sessionId: null,
      connected: true,
      sessions: bad,
    } as unknown as ChatState;
    assert.equal(ppe(state), false, `sessions=${JSON.stringify(bad)} ⇒ false`);
  }
});

test("🔴 ppe 归一：sessions 为空数组 → false", () => {
  const state = {
    ...initialChatState(),
    sessionId: null,
    connected: true,
    sessions: [],
  } as unknown as ChatState;
  assert.equal(ppe(state), false);
});

test('🔴 ppe 归一：条目为 null / 缺键 / 键非布尔（"true"、1、{}）→ 都不计入 ⇒ false', () => {
  const state = {
    ...initialChatState(),
    sessionId: null,
    connected: true,
    sessions: [
      null,
      undefined,
      sessionRow(SA),
      sessionRow(SC, { pendingPermission: "true" }),
      sessionRow("sD", { pendingPermission: 1 }),
      sessionRow("sE", { pendingPermission: {} }),
    ],
  } as unknown as ChatState;
  assert.equal(ppe(state), false, "只有严格的 true 才算待审批");
});

test("🔴 ppe：多条会话中只要有一条 pendingPermission===true 就 true", () => {
  const state = {
    ...initialChatState(),
    sessionId: null,
    connected: true,
    sessions: [
      sessionRow(SA, { pendingPermission: false }),
      null,
      sessionRow(SC, { pendingPermission: "true" }),
      sessionRow("sD", { pendingPermission: true }),
    ],
  } as unknown as ChatState;
  assert.equal(ppe(state), true);
});

test("🔴 ppe 是纯函数：不改 state、同输入同输出、不抛", () => {
  const state = truthState(true, true, true);
  const snapshot = JSON.parse(JSON.stringify(state)) as unknown;
  const first = ppe(state);
  const second = ppe(state);
  assert.equal(first, second, "同输入同输出");
  assert.deepEqual(
    JSON.parse(JSON.stringify(state)),
    snapshot,
    "不得改 state 的任何字段",
  );
});

test("🔴 ppe 不读 pendingPermissions：本地有卡但无 pendingPermission===true 的会话 ⇒ false", () => {
  // 非绑定视图里 pendingPermissions 恒为空（卡从不入列）；若实现去读它，永远算不出 true。
  const state = {
    ...initialChatState(),
    sessionId: null,
    connected: true,
    pendingPermissions: [CARD],
    sessions: [sessionRow(SA, { pendingPermission: false })],
  } as unknown as ChatState;
  assert.equal(ppe(state), false, "判定只看 sessions[].pendingPermission");
});

// ---- 文件末尾对账：🔴 21 条 / 🔒 17 条 / 合计 38 条 ----
