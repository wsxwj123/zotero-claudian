// 单测 — ChatStore（App.ts 外置 store）：订阅/通知/取消订阅基础语义 + BUG-19 排序竞态回归。
// App 的订阅时序（订阅必须早于任何握手消息）不在 node 层测：那需要 DOM + Preact 真实 commit
// 时序（仓库无 jsdom）。这里锁住竞态的另一半——ChatStore 只通知「建立订阅那一刻」的监听者、
// 不重放历史；App 侧「订阅必须早于任何消息」由 useLayoutEffect 结构性保证（见 App.ts 注释）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../../src/chat/App.ts";
import { initialChatState } from "../../src/chat/lib/chatModel.ts";

test("ChatStore: 初始状态 = initialChatState；set → get 拿到新状态且订阅者各通知一次", () => {
  const store = new ChatStore();
  assert.deepEqual(store.get(), initialChatState());
  let a = 0;
  let b = 0;
  store.subscribe(() => a++);
  store.subscribe(() => b++);
  const next = { ...store.get(), connected: true };
  store.set(next);
  assert.equal(store.get(), next);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("ChatStore: subscribe 返回取消函数——取消后不再通知，不影响其他订阅者", () => {
  const store = new ChatStore();
  let kept = 0;
  let dropped = 0;
  const unsubscribe = store.subscribe(() => dropped++);
  store.subscribe(() => kept++);
  store.set({ ...store.get(), connected: true });
  assert.equal(dropped, 1);
  assert.equal(kept, 1);
  unsubscribe();
  store.set({ ...store.get(), connected: false });
  assert.equal(dropped, 1);
  assert.equal(kept, 2);
});

test("ChatStore: 通知期间取消订阅（含自身）不打断本轮通知", () => {
  const store = new ChatStore();
  const calls: string[] = [];
  const unsubscribe = store.subscribe(() => {
    calls.push("self");
    unsubscribe();
  });
  store.subscribe(() => calls.push("other"));
  store.set({ ...store.get(), connected: true });
  assert.deepEqual(calls, ["self", "other"]);
  store.set({ ...store.get(), connected: false });
  assert.deepEqual(calls, ["self", "other", "other"]); // 已取消者不再收到
});

test("BUG-19 回归：set 早于订阅 → 不重放（迟到订阅者看不到这次更新，根因是排序竞态）", () => {
  const store = new ChatStore();
  // 模拟「握手消息在订阅建立之前到达」：store 先被 set，订阅随后才挂上
  store.set({ ...store.get(), connected: true });
  let notified = 0;
  store.subscribe(() => notified++);
  assert.equal(notified, 0); // 不重放 → DOM 会停在初始态（绿点灭/输入框 disabled），故订阅必须走 useLayoutEffect
  assert.equal(store.get().connected, true); // 状态本身在，只是没人被叫醒
});
