// 单测 — R17 / P4「归属」：readerContext 按实例定向投递 + instances() 实例名册
//
// 契约来源：.devflow/INTERFACE-R17.md §1.1（谁收：由广播改为「每个实例收它所在标签页的那一份」；
// 取不到上下文 → 该实例本 tick 跳过，其余实例照常）与 §3（HostBridge.instances()；
// HostBridgeDeps.buildReaderContext(win?)；错误契约：取数抛错 → 该实例跳过 + 一条日志，不推 error）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import { makeBridge, tick } from "./helpers/r17Bridge.ts";

const readerContextMsg = (itemKey: string): HostMessage =>
  ({
    type: "readerContext",
    itemKey,
    title: `文献 ${itemKey}`,
    page: 1,
    selection: null,
  }) as HostMessage;

const itemKeysOf = (msgs: HostMessage[]): string[] =>
  msgs.map((m) => (m as unknown as { itemKey: string }).itemKey);

/** R17 新增句柄；HEAD 上还不存在 → 先断言存在，失败信息才说得清 */
function instancesOf(bridge: unknown): object[] {
  const fn = (bridge as { instances?: () => object[] }).instances;
  assert.equal(
    typeof fn,
    "function",
    "HostBridge 必须提供 instances()（R17 §3 新增句柄）",
  );
  return (fn as () => object[]).call(bridge);
}

// ---------- T-P4-a：实例名册 ----------

test("T-P4-a 🔴 instances() 返回已注册实例，注销后名册减少", async () => {
  const fx = makeBridge();
  const winA = {};
  const winB = {};
  fx.register(winA);
  fx.register(winB);
  await tick();

  const both = instancesOf(fx.bridge);
  assert.equal(both.length, 2, "两个实例都在名册里");
  assert.ok(both.includes(winA), "名册含实例 A");
  assert.ok(both.includes(winB), "名册含实例 B");

  fx.bridge.unregister(winB);
  const left = instancesOf(fx.bridge);
  assert.deepEqual(left, [winA], "注销实例 B 后名册只剩 A");
});

// ---------- T-P4-b：定向投递（主复现） ----------

test("T-P4-b 🔴 两个实例各收自己那份 readerContext（不是全局那一份）", async () => {
  const fx = makeBridge();
  const winA = {};
  const winB = {};
  const perWindow = new Map<object, string>([
    [winA, "ITEM_TAB_A"],
    [winB, "ITEM_TAB_B"],
  ]);
  fx.readerContext = async (win) =>
    readerContextMsg(
      win !== undefined && perWindow.has(win)
        ? (perWindow.get(win) as string)
        : "ITEM_GLOBAL",
    );

  fx.register(winA);
  await tick();
  fx.register(winB);
  await tick();

  assert.deepEqual(
    itemKeysOf(fx.sentTo(winA, "readerContext")),
    ["ITEM_TAB_A"],
    "实例 A 收到的是 A 标签页的文献（不得是全局选中的那份）",
  );
  assert.deepEqual(
    itemKeysOf(fx.sentTo(winB, "readerContext")),
    ["ITEM_TAB_B"],
    "实例 B 收到的是 B 标签页的文献",
  );
});

// ---------- T-P4-c：单实例取数抛错 ----------

test("T-P4-c 🔴 某实例 readerContext 取数抛错：该实例跳过，其余照常，不推 error", async () => {
  const fx = makeBridge();
  const winA = {};
  const winB = {};
  let calls = 0;
  fx.readerContext = async () => {
    calls++;
    if (calls === 1) {
      throw new Error("reader 取数炸了");
    }
    return readerContextMsg("ITEM_OK");
  };

  // HEAD 上这条拒绝会逃逸出 bridge.dispatch()，node:test 直接把它记到本用例头上
  // （失败形态是 `Error: reader 取数炸了`）；修好后它应被宿主吞掉，本数组保持为空。
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    fx.register(winA);
    await tick();
    fx.register(winB);
    await tick();
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  assert.deepEqual(
    rejections,
    [],
    "取数抛错必须被宿主吞掉（不得逃逸成未处理的 promise 拒绝）",
  );
  assert.equal(
    fx.sentTo(winA, "readerContext").length,
    0,
    "取数失败的实例本轮跳过（不推空的 readerContext）",
  );
  assert.equal(fx.sentTo(winA, "error").length, 0, "不得升级成 error 消息");
  assert.equal(
    fx.sentTo(winB, "error").length,
    0,
    "另一个实例也不该收到 error",
  );
  assert.deepEqual(
    itemKeysOf(fx.sentTo(winB, "readerContext")),
    ["ITEM_OK"],
    "另一个实例照常收到自己的 readerContext",
  );
  assert.ok(
    fx.sentTo(winA, "sessionList").length > 0,
    "取数失败不得连累该实例的握手（sessionList 照常送达）",
  );
});

// ---------- T-P4-c2：取数返回 null ----------

test("T-P4-c2 🔒 某实例取不到文献上下文（返回 null）：该实例不收 readerContext，其余照常", async () => {
  const fx = makeBridge();
  const winA = {};
  const winB = {};
  let calls = 0;
  fx.readerContext = async () => {
    calls++;
    return calls === 1 ? null : readerContextMsg("ITEM_OK");
  };

  fx.register(winA);
  await tick();
  fx.register(winB);
  await tick();

  assert.equal(
    fx.sentTo(winA, "readerContext").length,
    0,
    "itemKey 取不到 → 整条不推（口径不变）",
  );
  assert.deepEqual(itemKeysOf(fx.sentTo(winB, "readerContext")), ["ITEM_OK"]);
  assert.equal(fx.sentTo(winA, "error").length, 0, "不推 error");
});
