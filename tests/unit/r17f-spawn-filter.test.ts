// 黑盒复现测试 — R17 P9 spawn 前过滤:会话里已存的旧不安全规则不得进入 CLI 启动参数
//
// 契约来源：.devflow/INTERFACE-R17.md §5.3（buildSpawnArgs 传参前 allowedTools.filter(isSafeRememberRule);
//   有丢弃记一条 [bridge] allowedTools: dropped <N> unsafe rule(s) (session <id>);不回写会话索引)
//   与 .devflow/BRIEF-R17b.md §3 P9③。
// 走宿主桥 fake 链路(helpers/r17Bridge.makeBridge):预置会话 allowedTools = [旧不安全, 安全],
// 发一条消息触发启动,断言实际传给 spawnTurn 的 args。不看实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, tick } from "./helpers/r17Bridge.ts";

const UNSAFE = 'Bash(a"&calc&"b *)';
const SAFE = "Bash(git *)";

/** 预置一条带旧不安全规则的会话并发一轮,返回启动参数、存盘规则与日志 */
async function arm(): Promise<{
  args: string[];
  storedAfter: string[] | undefined;
  logs: string[];
}> {
  const fx = makeBridge();
  const logs: string[] = [];
  fx.deps.log = (m: string) => logs.push(m);

  const win = {};
  fx.register(win);
  await tick();

  const rec = await fx.store.create({ itemKey: "ITEM1" });
  await fx.store.update(rec.id, { allowedTools: [UNSAFE, SAFE] });
  await fx.store.flush();

  fx.bridge.dispatch({
    source: win,
    data: { type: "send", text: "hello", sessionId: rec.id },
  });
  await tick();

  return {
    args: fx.turns[0]?.options.args ?? [],
    storedAfter: fx.store.get(rec.id)?.allowedTools,
    logs,
  };
}

test("P9-6 🔴 旧不安全规则不得出现在 CLI 启动参数里", async () => {
  const { args } = await arm();
  assert.equal(
    args.some((a) => a.includes('a"&calc&"b')),
    false,
    `不安全规则泄漏进启动参数：${JSON.stringify(args)}`,
  );
});

test("P9-6 🔒 同一会话的安全规则 Bash(git *) 照旧带入启动参数（不误伤）", async () => {
  const { args } = await arm();
  assert.equal(
    args.includes(SAFE),
    true,
    `安全规则被误删：${JSON.stringify(args)}`,
  );
});

test("P9-6 🔒 过滤只发生在进参前——会话索引存盘内容不被改写", async () => {
  const { storedAfter } = await arm();
  assert.deepEqual(storedAfter, [UNSAFE, SAFE]);
});

test("P9-6 🔴 丢弃不安全规则时留一条日志 [bridge] allowedTools: dropped 1 unsafe rule(s)", async () => {
  const { logs } = await arm();
  assert.equal(
    logs.some((l) => /allowedTools: dropped 1 unsafe rule\(s\)/.test(l)),
    true,
    `未见丢弃日志：${JSON.stringify(logs)}`,
  );
});
