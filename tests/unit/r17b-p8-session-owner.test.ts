// 黑盒复现 — R17b / P8「切了文献但侧栏会话没跟」
//
// 契约来源（只依据这两份）：.devflow/BRIEF-R17b.md §1.3/§2 根因 4、§3 成功标准 P8。
//
// 判据：无会话时对着文献 B 直接发送 → **「包含该新会话的那条 sessionList」推送那一刻**，
// 载荷里该会话 itemKey 已是 ITEM_B（并保证后续 followReader 绑得到它）；早退路径
// （CLI 不可用 / spawn 失败）同样要有一次含正确归属的列表推送，会话不得永久停在无归属；
// 拿不到上下文时不得写入空串/假值，保持 null。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followReader,
  initialChatState,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage, SessionSummary } from "../../src/chat/lib/types.ts";
import { makeBridge, tick, type BridgeFixture } from "./helpers/r17Bridge.ts";

const ITEM_B = "ITEM_B";
const QUESTION = "文献 B 里这个方法怎么复现？";

/** 本轮 prompt 解析出的文献归属 */
const promptFor = (itemKey: string | null) => async () => ({
  itemKey,
  attachmentKey: null,
  prompt: "ctx",
  addDir: null,
});

const sessionLists = (fx: BridgeFixture): SessionSummary[][] =>
  fx.sent
    .filter((s) => s.msg.type === "sessionList")
    .map(
      (s) =>
        (s.msg as unknown as { sessions?: SessionSummary[] }).sessions ?? [],
    );

const errorCodes = (fx: BridgeFixture): string[] =>
  fx.sent
    .filter((s) => s.msg.type === "error")
    .map((s) => (s.msg as unknown as { code?: string }).code ?? "");

const idsOfList = (list: SessionSummary[]): string[] => list.map((s) => s.id);

/** 无会话时直接发送（UI 侧「直接打字发送」= 不带 sessionId） */
async function sendWithoutSession(
  fx: BridgeFixture,
  win: object,
): Promise<{ createdId: string; firstPushWithIt: SessionSummary[] }> {
  const mark = fx.sent.length;
  fx.bridge.dispatch({ source: win, data: { type: "send", text: QUESTION } });
  await tick(8);

  const created = fx.store.list();
  assert.equal(created.length, 1, "夹具自检：这次 send 建出了唯一一条新会话");
  const createdId = created[0].id;

  const after = fx.sent
    .slice(mark)
    .filter((s) => s.msg.type === "sessionList")
    .map(
      (s) =>
        (s.msg as unknown as { sessions?: SessionSummary[] }).sessions ?? [],
    );

  const hit = after.find((list) => idsOfList(list).includes(createdId));
  assert.ok(
    hit,
    `携该新会话的 sessionList 一次都没推过（该次 send 共推 ${after.length} 次列表）`,
  );
  return { createdId, firstPushWithIt: hit };
}

// ---------- T-P8-a：正常路径 ----------

test("T-P8-a 🔴 无会话时对文献 B 发送：含该新会话的那条 sessionList 推送里 itemKey 已就位", async () => {
  const fx = makeBridge();
  const win = {};
  fx.deps.buildTurnPrompt = promptFor(ITEM_B);
  fx.register(win);
  await tick();

  const { createdId, firstPushWithIt } = await sendWithoutSession(fx, win);
  const row = firstPushWithIt.find((s) => s.id === createdId);

  assert.equal(
    row?.itemKey,
    ITEM_B,
    "推送那一刻该会话的 itemKey 必须已是 ITEM_B（否则侧栏永远显示旧文献）",
  );
  assert.equal(
    fx.store.list()[0].itemKey,
    ITEM_B,
    "归属同时要落到索引（否则下一次推送又退回无归属）",
  );

  // 页面据此绑定：切到文献 B 后能跟上这条新会话
  let view: ChatState = reduceHostMessage(initialChatState(), {
    type: "init",
  } as HostMessage);
  view = reduceHostMessage(view, {
    type: "sessionList",
    sessions: firstPushWithIt,
  } as unknown as HostMessage);
  const followed = followReader(view, ITEM_B);
  assert.equal(
    followed.state.sessionId,
    createdId,
    "followReader(文献 B) 必须绑到刚建的那条会话",
  );
});

// ---------- T-P8-b：早退路径 ----------

test("T-P8-b 🔴 CLI 不可用（CLAUDE_NOT_FOUND）早退：也要推一次含正确归属的列表", async () => {
  const fx = makeBridge();
  const win = {};
  fx.deps.buildTurnPrompt = promptFor(ITEM_B);
  fx.deps.getSpawnBase = async () => ({
    command: null,
    channel: "direct",
    environment: {},
    environmentAppend: true,
  });
  fx.register(win);
  await tick();

  const { createdId } = await sendWithoutSession(fx, win);

  assert.ok(
    errorCodes(fx).includes("CLAUDE_NOT_FOUND"),
    `夹具自检：确实走的是 CLI 不可用早退（收到的错误码 ${JSON.stringify(errorCodes(fx))}）`,
  );
  assert.ok(
    sessionLists(fx).some(
      (list) => list.find((s) => s.id === createdId)?.itemKey === ITEM_B,
    ),
    "早退路径必须推一次含 ITEM_B 归属的列表（否则侧栏一直挂在上一条文献）",
  );
  assert.equal(
    fx.store.list()[0].itemKey,
    ITEM_B,
    "早退也要把归属写进索引：会话不得永久停在无归属",
  );
});

test("T-P8-c 🔴 spawn 失败早退：也要推一次含正确归属的列表", async () => {
  const fx = makeBridge();
  const win = {};
  fx.deps.buildTurnPrompt = promptFor(ITEM_B);
  fx.deps.spawnTurn = () => {
    throw new Error("injected spawn failure");
  };
  fx.register(win);
  await tick();

  const { createdId } = await sendWithoutSession(fx, win);

  assert.ok(
    errorCodes(fx).includes("SPAWN_FAILED"),
    `夹具自检：确实走的是 spawn 失败早退（收到的错误码 ${JSON.stringify(errorCodes(fx))}）`,
  );
  assert.ok(
    sessionLists(fx).some(
      (list) => list.find((s) => s.id === createdId)?.itemKey === ITEM_B,
    ),
    "早退路径必须推一次含 ITEM_B 归属的列表",
  );
  assert.equal(
    fx.store.list()[0].itemKey,
    ITEM_B,
    "早退也要把归属写进索引：会话不得永久停在无归属",
  );
});

// ---------- T-P8-d：回归锁 ----------

test("T-P8-d 🔒 解析不到文献上下文：不得写入空串/假值，保持 null", async () => {
  const fx = makeBridge();
  const win = {};
  fx.deps.buildTurnPrompt = promptFor(null);
  fx.register(win);
  await tick();

  await sendWithoutSession(fx, win);

  assert.equal(fx.store.list()[0].itemKey, null, "无上下文时归属保持 null");
  for (const list of sessionLists(fx)) {
    for (const s of list) {
      assert.ok(
        s.itemKey === null || typeof s.itemKey === "string",
        "itemKey 只能是 string 或 null",
      );
      assert.notEqual(
        s.itemKey,
        "",
        "不得把空串当归属写进去（页面会当成「有文献」）",
      );
    }
  }
});
