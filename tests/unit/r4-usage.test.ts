// 单测 — R4 需求 3 缓存命中率纯函数 cacheHitPercent（PLAN-R4 §4，黑盒：只按契约公式写）。
// 契约：cacheHitPercent({input, cacheRead, cacheCreation, output})
//   = (input + cacheRead + cacheCreation) === 0 ? null
//     : Math.round(cacheRead / (input + cacheRead + cacheCreation) * 100)
// output 不进分母；分母 0 → null（UI 不显示）；字段缺失/非法 → null 不抛。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheHitPercent } from "../../src/chat/lib/usage.ts";

type Usage = {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
};

const u = (p: Partial<Usage> = {}): Usage => ({
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  ...p,
});

// ---- 正常路径 ----

test("命中率：真实一轮（input=697 / cacheRead=119040 / cacheCreation=0）→ 99", () => {
  assert.equal(
    cacheHitPercent(u({ input: 697, cacheRead: 119040, output: 340 })),
    99, // 119040 / 119737 = 99.42%
  );
});

test("命中率：全命中（无未缓存 input）→ 100", () => {
  assert.equal(cacheHitPercent(u({ cacheRead: 100, output: 5 })), 100);
});

test("命中率：全 miss（cacheRead=0 但有 input）→ 0（不是 null）", () => {
  assert.equal(cacheHitPercent(u({ input: 1000, output: 20 })), 0);
});

test("命中率：只有 cacheCreation 无 cacheRead → 0（分母非 0，不返回 null）", () => {
  assert.equal(cacheHitPercent(u({ cacheCreation: 100 })), 0);
});

test("命中率：只计分母三项（input=0 / cacheRead=500 / cacheCreation=500）→ 50", () => {
  assert.equal(
    cacheHitPercent(u({ input: 0, cacheRead: 500, cacheCreation: 500 })),
    50,
  );
});

test("命中率：返回整数（Math.round，不是小数百分比）", () => {
  assert.ok(
    Number.isInteger(cacheHitPercent(u({ input: 697, cacheRead: 119040 }))),
  );
  assert.ok(Number.isInteger(cacheHitPercent(u({ input: 3, cacheRead: 1 }))));
});

// ---- 分母为 0 → null ----

test("命中率：三项全 0 → null（UI 不显示）", () => {
  assert.equal(cacheHitPercent(u()), null);
});

test("命中率：分母 0 但 output 有值 → 仍 null（output 不算分母）", () => {
  assert.equal(cacheHitPercent(u({ output: 12345 })), null);
});

// ---- output 不进分母 ----

test("命中率：output 变化不影响结果", () => {
  const base = { input: 1000, cacheRead: 1000, cacheCreation: 0 };
  assert.equal(
    cacheHitPercent(u({ ...base, output: 0 })),
    cacheHitPercent(u({ ...base, output: 99999999 })),
  );
  assert.equal(cacheHitPercent(u({ ...base, output: 99999999 })), 50);
});

// ---- 舍入边界 ----

test("命中率：恰好 99.5% → 进位到 100（Math.round 语义）", () => {
  assert.equal(cacheHitPercent(u({ input: 1, cacheRead: 199 })), 100);
});

test("命中率：极低命中（1/100001）→ 0（舍入到 0 而非 null）", () => {
  assert.equal(cacheHitPercent(u({ input: 100000, cacheRead: 1 })), 0);
});

// ---- 非法输入：返回 null 且不抛 ----

test("命中率：字段缺失 → null 不抛", () => {
  assert.equal(cacheHitPercent({} as any), null);
  assert.equal(cacheHitPercent({ input: 1000 } as any), null);
  assert.equal(cacheHitPercent({ input: 1000, cacheRead: 5 } as any), null);
});

test("命中率：字段非数字（字符串/NaN/null/对象）→ null 不抛", () => {
  for (const bad of ["697", NaN, null, {}, []]) {
    const got = cacheHitPercent({
      input: 697,
      cacheRead: bad,
      cacheCreation: 0,
      output: 0,
    } as any);
    assert.equal(got, null, JSON.stringify(bad));
  }
});

test("命中率：入参为 null/undefined（usage 整体缺失）→ null 不抛", () => {
  assert.doesNotThrow(() => cacheHitPercent(null));
  assert.doesNotThrow(() => cacheHitPercent(undefined));
  assert.equal(cacheHitPercent(null), null);
  assert.equal(cacheHitPercent(undefined), null);
});
