// 单测 — R4 需求 3 余额解析与 provider 判定（PLAN-R4 §4，黑盒：只按契约写）。
// 契约：GET https://api.deepseek.com/user/balance → { balance_infos: [{ currency, total_balance }] }
//   无 balance_infos → 失败结果（带原因）；多币种取第一条；CNY/USD 展示对应符号，未知币种原样后缀。
//   detectProvider({baseUrl, model})：任一个（大小写不敏感）含 'deepseek' → 'deepseek'，否则 'unknown'。
//
// 入参口径（主会话 R4 裁决 A2）：parseBalance 只吃 HTTP 响应文本（JSON 字符串）；传对象按畸形处理。
// 契约未给出返回结构，本文件锁定的形（开发需照此导出；若主会话另有裁决需同步改此文件）：
//   parseBalance(body: string) -> { ok: true, currency, total, all: [{currency, total}] }
//                              | { ok: false, reason: string }
//   detectProvider(input: { baseUrl?, model? }) -> "deepseek" | "unknown"
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProvider, parseBalance } from "../../src/modules/balance.ts";

/** 真机形态：字段全为字符串，total_balance 带两位小数 */
const cnyBody = JSON.stringify({
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
});

// ---- parseBalance：正常解析 ----

test("余额：CNY 正常响应 → total/currency 取出", () => {
  const r = parseBalance(cnyBody);
  assert.equal(r.ok, true);
  assert.equal(r.currency, "CNY");
  assert.equal(r.total, "110.00");
});

test("余额：USD 正常响应 → currency=USD（展示层配 $）", () => {
  const r = parseBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "1.23" }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.currency, "USD");
  assert.equal(r.total, "1.23");
});

test("余额：未知币种原样保留（不做映射，展示层自行后缀）", () => {
  const r = parseBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "JPY", total_balance: "500" }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.currency, "JPY");
  assert.equal(r.total, "500");
});

test("余额：多币种 → 取第一条，且全部保留在 all 里", () => {
  const r = parseBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00" },
        { currency: "USD", total_balance: "1.23" },
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.currency, "CNY");
  assert.equal(r.total, "110.00");
  assert.equal(r.all.length, 2);
  assert.deepEqual(r.all[1], { currency: "USD", total: "1.23" });
});

test("余额：余额为 0 是合法值（不当成失败）", () => {
  const r = parseBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.total, "0.00");
});

// ---- parseBalance：失败路径 ----

test("余额：balance_infos 为空数组 → 失败且带原因", () => {
  const r = parseBalance(
    JSON.stringify({ is_available: false, balance_infos: [] }),
  );
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0, "失败原因不能是空串");
});

test("余额：响应无 balance_infos 字段 → 失败", () => {
  assert.equal(parseBalance(JSON.stringify({ is_available: true })).ok, false);
});

test("余额：balance_infos 不是数组 → 失败不抛", () => {
  const r = parseBalance(JSON.stringify({ balance_infos: "junk" }));
  assert.equal(r.ok, false);
});

test("余额：首条缺 total_balance → 失败（没有可显示的数字）", () => {
  const r = parseBalance(
    JSON.stringify({ balance_infos: [{ currency: "CNY" }] }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test("余额：畸形 JSON（截断/纯文本/空串）→ 失败不抛", () => {
  for (const body of [
    '{"balance_infos":[',
    "not json",
    "",
    "   ",
    "<html>502</html>",
  ]) {
    let r: any;
    assert.doesNotThrow(() => {
      r = parseBalance(body);
    }, JSON.stringify(body));
    assert.equal(r.ok, false, JSON.stringify(body));
  }
});

test("余额：入参不是字符串（宿主误传已解析对象）→ 失败不抛（裁决 A2：入参锁定响应文本）", () => {
  for (const body of [
    { balance_infos: [{ currency: "CNY", total_balance: "110.00" }] },
    [{ currency: "CNY", total_balance: "110.00" }],
    null,
    undefined,
    42,
  ] as any[]) {
    let r: any;
    assert.doesNotThrow(() => {
      r = parseBalance(body);
    }, JSON.stringify(body));
    assert.equal(r.ok, false, JSON.stringify(body));
  }
});

test("余额：JSON 合法但非对象（标量/数组/null）→ 失败不抛", () => {
  for (const body of ["42", '"str"', "[1,2,3]", "null", "true"]) {
    let r: any;
    assert.doesNotThrow(() => {
      r = parseBalance(body);
    }, body);
    assert.equal(r.ok, false, body);
  }
});

test("余额：超长响应体 → 失败原因被截断（不原样回显整段 body）", () => {
  const body = `<html>${"x".repeat(10000)}</html>`;
  const r = parseBalance(body);
  assert.equal(r.ok, false);
  assert.ok(
    r.reason.length < body.length,
    `reason 长度 ${r.reason.length} 应明显短于 body 长度 ${body.length}`,
  );
});

// ---- detectProvider ----

test("provider：baseUrl 含 deepseek → 'deepseek'", () => {
  assert.equal(
    detectProvider({ baseUrl: "https://api.deepseek.com/anthropic" }),
    "deepseek",
  );
});

test("provider：model 含 deepseek（baseUrl 缺失）→ 'deepseek'", () => {
  assert.equal(detectProvider({ model: "deepseek-chat" }), "deepseek");
  assert.equal(
    detectProvider({ baseUrl: null, model: "deepseek-chat" }),
    "deepseek",
  );
});

test("provider：大小写不敏感（DeepSeek / DEEPSEEK）", () => {
  assert.equal(
    detectProvider({ baseUrl: "https://API.DeepSeek.com" }),
    "deepseek",
  );
  assert.equal(detectProvider({ model: "DeepSeek-V3.2" }), "deepseek");
  assert.equal(detectProvider({ model: "DEEPSEEK-REASONER" }), "deepseek");
});

test("provider：真实用户场景（本机代理 + deepseek 模型）→ 'deepseek'", () => {
  assert.equal(
    detectProvider({
      baseUrl: "http://127.0.0.1:8799",
      model: "deepseek-flash",
    }),
    "deepseek",
  );
});

test("provider：两者皆空/为 null/缺字段 → 'unknown'", () => {
  assert.equal(detectProvider({ baseUrl: "", model: "" }), "unknown");
  assert.equal(detectProvider({ baseUrl: null, model: null }), "unknown");
  assert.equal(detectProvider({}), "unknown");
});

test("provider：非字符串字段（数字/对象）→ 'unknown' 不抛", () => {
  let got: any;
  assert.doesNotThrow(() => {
    got = detectProvider({ baseUrl: 42, model: { name: "x" } } as any);
  });
  assert.equal(got, "unknown");
});

test("provider：入参整体缺失 → 'unknown' 不抛", () => {
  let got: any;
  assert.doesNotThrow(() => {
    got = detectProvider(undefined as any);
  });
  assert.equal(got, "unknown");
});

test("provider：Claude 官方端点 + 非 deepseek 模型 → 'unknown'（不猜）", () => {
  assert.equal(
    detectProvider({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5-20250929",
    }),
    "unknown",
  );
});
