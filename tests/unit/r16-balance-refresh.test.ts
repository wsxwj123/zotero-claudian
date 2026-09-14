// 单测 — R16：切到「不支持余额查询」的 provider 后，刷新入口不许消失（用户真机报障）
//
// 现象：切到别的 provider → 点刷新 → 显示「当前 provider 不支持余额查询」；切回 deepseek
// 后仍是这句、余额再也看不到——因为刷新按钮的显示条件曾是「上次结果的 provider 是不是
// deepseek」，一旦变了就永久拿掉，此后没有任何入口触发重新查询（provider 在插件外切换，
// 插件察觉不到），只能重开面板。
// 契约：刷新入口随「有没有余额状态」出现（balance !== null），不随 provider 消失；
// 宿主侧 force 刷新每次重新判定 provider，多点没有副作用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceTextOf } from "../../src/chat/App.ts";
import type { BalanceStatus } from "../../src/chat/lib/types.ts";

const st = (
  provider: BalanceStatus["provider"],
  balance: BalanceStatus["balance"],
): BalanceStatus => ({
  provider,
  balance,
});

test("R16 🔴 unsupported（provider=unknown）→ 刷新入口必须仍在（修前红）", () => {
  const r = balanceTextOf(st("unknown", { state: "unsupported" }));
  assert.ok(r, "说明文案要在");
  assert.equal(r!.text, "当前 provider 不支持余额查询");
  assert.equal(
    r!.canRefresh,
    true,
    "不支持态仍要能点刷新（切回 deepseek 后靠它恢复）",
  );
});

test("R16 🔴 切回 deepseek 的完整序列：unknown/unsupported → deepseek/ok 都要能刷新", () => {
  const seq: BalanceStatus[] = [
    st("deepseek", {
      state: "ok",
      currency: "CNY",
      total: "12.34",
      all: [{ currency: "CNY", total: "12.34" }],
    }),
    st("unknown", { state: "unsupported" }), // 切到别的 provider 后刷新
    st("deepseek", {
      state: "ok",
      currency: "CNY",
      total: "12.34",
      all: [{ currency: "CNY", total: "12.34" }],
    }), // 切回后刷新
  ];
  for (const s of seq) {
    assert.equal(
      balanceTextOf(s)?.canRefresh,
      true,
      `provider=${s.provider} 状态=${s.balance.state}`,
    );
  }
});

test("R16 🔒 其余状态回归锁：loading / nokey / error / ok / 无状态", () => {
  assert.equal(balanceTextOf(null), null, "宿主没推 → 不占位");
  assert.equal(
    balanceTextOf(st("deepseek", { state: "loading" }))?.canRefresh,
    true,
  );
  assert.equal(
    balanceTextOf(st("deepseek", { state: "nokey" }))?.canRefresh,
    true,
  );
  const err = balanceTextOf(
    st("deepseek", {
      state: "error",
      reason: "HTTP 500 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    }),
  );
  assert.ok(err && err.text.startsWith("余额查询失败："), "错误态有短文案");
  assert.ok(err!.text.length < 45, "行内短文案");
  const ok = balanceTextOf(
    st("deepseek", {
      state: "ok",
      currency: "CNY",
      total: "1.00",
      all: [{ currency: "CNY", total: "1.00" }],
    }),
  );
  assert.ok(ok && ok.text.includes("1.00"), "正常态显示金额");
});
