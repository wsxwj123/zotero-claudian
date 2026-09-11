// 单测 — R4-3 自补：token 格式化 / 累加 / 全 0 判定 / 余额文案（PLAN-R4 §4 展示口径）。
// 契约文件（r4-usage / r4-balance / protocol）之外的口径锁：这些函数由 UI 直接渲染，值错=用户看到错数。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addUsage,
  cacheHitPercent,
  formatTokens,
  isZeroUsage,
  type UsageStats,
} from "../../src/chat/lib/usage.ts";
import {
  currentSessionUsage,
  formatBalance,
  initialChatState,
  reduceHostMessage,
} from "../../src/chat/lib/chatModel.ts";
import type { SessionSummary } from "../../src/chat/lib/types.ts";

const u = (p: Partial<UsageStats> = {}): UsageStats => ({
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  ...p,
});

// ---- formatTokens ----

test("fmt: < 1000 原样整数", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(1), "1");
  assert.equal(formatTokens(697), "697");
  assert.equal(formatTokens(999), "999");
});

test("fmt: K 档一位小数，整十去尾（119040 → 119K，12345 → 12.3K）", () => {
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(12345), "12.3K");
  assert.equal(formatTokens(119040), "119K");
  assert.equal(formatTokens(999499), "999K");
});

test("fmt: M 档（1200000 → 1.2M）", () => {
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(formatTokens(12_500_000), "12.5M");
});

test("fmt: 非法输入（负数/NaN/undefined 形态）→ 0，不抛", () => {
  assert.equal(formatTokens(-5), "0");
  assert.equal(formatTokens(Number.NaN), "0");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "0");
  assert.doesNotThrow(() => formatTokens(undefined as unknown as number));
});

// ---- addUsage / isZeroUsage ----

test("agg: addUsage 四项各加，缺省/null 按 0", () => {
  assert.deepEqual(addUsage(u({ input: 1 }), u({ input: 2, output: 5 })), {
    input: 3,
    cacheRead: 0,
    cacheCreation: 0,
    output: 5,
  });
  assert.deepEqual(addUsage(null, undefined), u());
  assert.deepEqual(addUsage(u({ cacheRead: 7 }), null), u({ cacheRead: 7 }));
});

test("agg: isZeroUsage —— 全 0/缺失 为 true；任一项非 0 为 false（output 也算）", () => {
  assert.equal(isZeroUsage(null), true);
  assert.equal(isZeroUsage(u()), true);
  assert.equal(isZeroUsage(u({ output: 1 })), false);
  assert.equal(isZeroUsage(u({ cacheRead: 1 })), false);
});

test("agg: 累加 3 轮后命中率按整段算（不是各轮平均）", () => {
  const total = [
    u({ input: 100, cacheRead: 0 }),
    u({ input: 100, cacheRead: 100 }),
    u({ input: 100, cacheRead: 200 }),
  ].reduce((acc: UsageStats, x) => addUsage(acc, x), u());
  assert.deepEqual(total, u({ input: 300, cacheRead: 300 }));
  assert.equal(cacheHitPercent(total), 50);
});

// ---- formatBalance ----

test("balance 文案：CNY/USD 前缀，未知币种原样后缀", () => {
  assert.equal(formatBalance("CNY", "110.00"), "¥110.00");
  assert.equal(formatBalance("USD", "1.23"), "$1.23");
  assert.equal(formatBalance("JPY", "500"), "500 JPY");
  assert.equal(formatBalance("", "42.10"), "42.10");
  assert.equal(formatBalance("cny", "0.00"), "¥0.00");
});

// ---- chatModel：会话累计取自 sessionList 条目（切会话/重启即显示） ----

const summary = (id: string, usage?: UsageStats): SessionSummary => ({
  id,
  title: id,
  updatedAt: 1,
  itemKey: null,
  claudeSessionId: null,
  ...(usage ? { usage } : {}),
});

test("model: sessionList 带 usage → 绑定会话的累计可读；换绑另一条 → 读另一条的值", () => {
  const uA = u({ input: 1000, cacheRead: 500 });
  const uB = u({ input: 20 });
  let s = reduceHostMessage(initialChatState(), {
    type: "sessionList",
    sessions: [summary("A", uA), summary("B", uB)],
  });
  assert.equal(s.sessionId, "A");
  assert.deepEqual(currentSessionUsage(s), uA);

  s = reduceHostMessage(s, {
    type: "sessionList",
    sessions: [summary("B", uB)],
  });
  assert.equal(s.sessionId, "B");
  assert.deepEqual(currentSessionUsage(s), uB);
});

test("model: usageStats 只认当前绑定会话；total 就地并入该会话条目", () => {
  let s = reduceHostMessage(initialChatState(), {
    type: "sessionList",
    sessions: [summary("A"), summary("B")],
  });
  const turn = u({ input: 697, cacheRead: 119040, output: 340 });
  const total = u({ input: 5000, cacheRead: 250000, output: 12000 });

  // 他会话的广播 → 整体忽略（与 streamEvent 同口径）
  const other = reduceHostMessage(s, {
    type: "usageStats",
    sessionId: "B",
    turn,
    total,
  });
  assert.equal(other.turnUsage, null);
  assert.equal(currentSessionUsage(other), null);

  s = reduceHostMessage(s, { type: "usageStats", sessionId: "A", turn, total });
  assert.deepEqual(s.turnUsage, turn);
  assert.deepEqual(currentSessionUsage(s), total);
  assert.equal(cacheHitPercent(s.turnUsage), 99);
});

test("model: balanceStatus / uiPrefs 归约（缺省 showUsage=true，非 false 才关）", () => {
  let s = reduceHostMessage(initialChatState(), {
    type: "balanceStatus",
    provider: "deepseek",
    balance: { state: "ok", currency: "CNY", total: "110.00", all: [] },
  });
  assert.equal(s.balance?.provider, "deepseek");
  assert.deepEqual(s.balance?.balance, {
    state: "ok",
    currency: "CNY",
    total: "110.00",
    all: [],
  });

  s = reduceHostMessage(s, {
    type: "balanceStatus",
    provider: "unknown",
    balance: { state: "unsupported" },
  });
  assert.deepEqual(s.balance, {
    provider: "unknown",
    balance: { state: "unsupported" },
  });

  assert.equal(initialChatState().showUsage, true);
  assert.equal(
    reduceHostMessage(s, { type: "uiPrefs", showUsage: false }).showUsage,
    false,
  );
});

test("model: 畸形 balanceStatus 载荷（非对象/坏 state）→ 不崩，落到 unsupported", () => {
  for (const raw of [null, 42, {}, { state: "wat" }]) {
    let s: ReturnType<typeof initialChatState>;
    assert.doesNotThrow(() => {
      s = reduceHostMessage(initialChatState(), {
        type: "balanceStatus",
        provider: "deepseek",
        balance: raw as never,
      });
    });
    assert.equal(s!.balance?.balance.state, "unsupported");
  }
});
