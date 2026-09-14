// 单测 — R17 / P1「切会话空白与错绑」：sessionList 推送纪律（宿主侧）+ 空绑定态（页面侧）
//
// 契约来源：.devflow/INTERFACE-R17.md §1.3（sessionList 收敛为单一产出口、带序号守卫；
// 「页面可依赖：收到的最后一条 sessionList 就是宿主最新索引的全量快照」；单条记录取数失败
// 走 per-record 兜底，不让整批推送失败）与 BRIEF-R17 §3 的 P1 成功标准。
// 全部经公开句柄驱动（beginHandshake / dispatch / unregister），时序用可控 deferred，不用真实等待。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import { idsOf, makeBridge, tick } from "./helpers/r17Bridge.ts";

/** 新建一条会话并等它落定，返回会话 id */
async function createSession(
  fx: ReturnType<typeof makeBridge>,
  win: object,
  itemKey: string,
): Promise<string> {
  const before = new Set(fx.store.list().map((s) => s.id));
  fx.bridge.dispatch({ source: win, data: { type: "createSession", itemKey } });
  await tick();
  const created = fx.store.list().find((s) => !before.has(s.id));
  assert.ok(created, `夹具自检：itemKey=${itemKey} 的会话应已建出`);
  return created.id;
}

const allIds = (fx: ReturnType<typeof makeBridge>): string[] =>
  fx.store
    .list()
    .map((s) => s.id)
    .sort();

// ---------- T-P1-a1：两次取数乱序完成（主复现） ----------

test("T-P1-a1 🔴 两次会话列表取数乱序完成：页面拿到的最后一条必须是较新的快照", async () => {
  const fx = makeBridge();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await createSession(fx, win, "ITEM_A");

  // 取数①：快照 = [sA]，卡在 lookupItem 上（用户此刻还没建第二条会话）
  fx.hang.add("ITEM_A");
  fx.bridge.dispatch({ source: win, data: { type: "getState" } });
  await tick();
  const pushedWhileHung = fx.sentTo(win, "sessionList").length;

  // 取数②：用户新建了第二条会话 → 索引变为 [sA,sB]，这次取数不卡，先完成
  fx.hang.clear();
  const sB = await createSession(fx, win, "ITEM_B");
  assert.deepEqual(
    idsOf(fx.sentTo(win, "sessionList").at(-1)),
    [sA, sB].sort(),
    "夹具自检：较新的那次取数已经先送达（两条会话都在）",
  );
  assert.ok(
    fx.sentTo(win, "sessionList").length > pushedWhileHung,
    "夹具自检：两次取数确实是并发的（②在①之前完成）",
  );

  // 放行①：它带的是过期快照（只有 sA）
  assert.equal(fx.releaseHung(), 1, "夹具自检：恰有一次取数被卡住过");
  await tick();

  const last = fx.sentTo(win, "sessionList").at(-1);
  assert.deepEqual(
    idsOf(last),
    [sA, sB].sort(),
    "最后一条 sessionList 必须是最新索引的全量快照（旧快照不得覆盖新快照）",
  );
  assert.equal(idsOf(last).length, 2, "页面最终应看到 2 条会话，而不是 1 条");
});

// ---------- T-P1-a2：单次推送照常送达（回归锁） ----------

test("T-P1-a2 🔒 没有并发时：握手推一次列表，createSession 后新会话必达", async () => {
  const fx = makeBridge();
  const win = {};
  fx.register(win);
  await tick();

  const afterHello = fx.sentTo(win, "sessionList");
  assert.equal(afterHello.length, 1, "握手恰推一条 sessionList");
  assert.deepEqual(idsOf(afterHello[0]), [], "此时索引为空 → 空列表");

  const sA = await createSession(fx, win, "ITEM_A");
  const lists = fx.sentTo(win, "sessionList");
  assert.ok(lists.length >= 2, "createSession 后必须再推至少一条 sessionList");
  assert.deepEqual(idsOf(lists.at(-1)), [sA], "最后一条列表必须含刚建出的会话");
});

// ---------- T-P1-a3：握手与并发推送同时发生（回归锁） ----------

test("T-P1-a3 🔒 新实例握手期间有并发列表推送：所有已注册实例都收到含新会话的列表", async () => {
  const fx = makeBridge();
  const winA = {};
  fx.register(winA);
  await tick();
  const sA = await createSession(fx, winA, "ITEM_A");

  // 卡住 sA 的取数 → 之后每一次列表构建都会挂起
  fx.hang.add("ITEM_A");

  // 并发推送：新建 sB（索引已变，推送卡住）
  fx.bridge.dispatch({
    source: winA,
    data: { type: "createSession", itemKey: "ITEM_B" },
  });
  await tick();

  // 同时：第二个实例握手（它的列表推送也卡在同一个取数上）
  const winB = {};
  fx.register(winB);
  await tick();

  fx.hang.clear();
  assert.ok(fx.releaseHung() >= 2, "夹具自检：握手与广播的取数确实并发挂起过");
  await tick();

  const sB = fx.store.list().find((s) => s.itemKey === "ITEM_B")?.id;
  assert.ok(sB, "夹具自检：第二条会话已建出");
  const expected = [sA, sB].sort();
  assert.deepEqual(
    idsOf(fx.sentTo(winA, "sessionList").at(-1)),
    expected,
    "老实例最终必须收到含新会话的列表",
  );
  assert.deepEqual(
    idsOf(fx.sentTo(winB, "sessionList").at(-1)),
    expected,
    "握手中的新实例最终必须收到含新会话的列表",
  );
});

// ---------- T-P1-a4：单条记录取数失败的降级 ----------
// 标 🔒 而非 🔴：HEAD 上 sessionList 的构建路径**没有任何按会话的快照读取**（只有
// store.list() + 每条一次 lookupItem，且 lookupItem 失败已被逐条兜住），所以
// 「修前整批无推送」这个前提在黑盒可达面上复现不出来。本用例按契约把降级行为锁住。

test("T-P1-a4 🔒 某条会话的快照取数抛错：整批列表仍送达，该条按无快照处理", async () => {
  const fx = makeBridge();
  const win = {};
  fx.register(win);
  await tick();
  const sA = await createSession(fx, win, "ITEM_A");
  const sB = await createSession(fx, win, "ITEM_B");

  // sB 这条记录的快照/历史类取数一律抛错（条目信息取数也一并失败）
  fx.failSession.add(sB);
  fx.failItem.add("ITEM_B");
  const before = fx.sentTo(win, "sessionList").length;

  fx.bridge.dispatch({ source: win, data: { type: "getState" } });
  await tick();

  const lists = fx.sentTo(win, "sessionList");
  assert.equal(
    lists.length,
    before + 1,
    "单条记录取数失败不得让整批推送消失（getState 必须仍回一条 sessionList）",
  );
  assert.deepEqual(
    idsOf(lists.at(-1)),
    [sA, sB].sort(),
    "两条会话都要在列表里（坏的那条不得被整条丢掉）",
  );
  const bad = (
    lists.at(-1) as unknown as {
      sessions: { id: string; snapshotTurns?: number[] }[];
    }
  ).sessions.find((s) => s.id === sB);
  assert.ok(bad, "坏记录仍在列表里");
  assert.deepEqual(
    bad.snapshotTurns ?? [],
    [],
    "该条按「读不到 = 无快照」处理（snapshotTurns 为空数组或不带该字段）",
  );
  assert.equal(fx.sentTo(win, "error").length, 0, "降级不得升级成 error 消息");
});

// ---------- T-P1-a6：空绑定态的前置状态（页面侧） ----------

test("T-P1-a6 🔒 切到没有会话的文献：已连接 + 未绑定 + 视图为空（空态提示的触发条件）", () => {
  const apply = (s: ChatState, msg: HostMessage): ChatState =>
    reduceHostMessage(s, msg);
  let s = apply(initialChatState(), { type: "init" });
  s = apply(s, {
    type: "sessionList",
    sessions: [
      {
        id: "s1",
        title: "会话一",
        updatedAt: 2,
        createdAt: 1,
        itemKey: "ITEM_A",
        claudeSessionId: null,
      },
    ],
  } as unknown as HostMessage);
  assert.equal(s.sessionId, "s1", "夹具自检：先绑定到已有会话");

  s = apply(s, {
    type: "readerContext",
    itemKey: "ITEM_NEW",
    title: "新文献",
    page: 1,
    selection: null,
  });

  assert.equal(s.sessionId, null, "目标文献没有会话 → 解绑");
  assert.equal(s.messages.length, 0, "视图被清空");
  assert.equal(s.connected, true, "仍然是已连接（不是断线）");
  assert.equal(s.readerContext?.itemKey, "ITEM_NEW", "顶栏跟随到新文献");
});
