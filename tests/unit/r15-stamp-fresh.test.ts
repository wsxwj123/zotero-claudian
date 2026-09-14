// R15 黑盒单测 —— 缓存戳新鲜度判据（F6 纯函数 isStampFresh）。
// 契约来源：INTERFACE-R15 §3（verifiedStamp{mtime,size} 逐次校验；抛错 → 失效）。
//
// 接线类（resolveSpawnBase 每次调用校验、spawn 报 CLAUDE_NOT_FOUND 后失效重解析、
// 15s 重探一次、面板 hello 的 ≥20s 最小间隔）没有导出缝：见本目录
// r15-diag-candidates.test.ts 顶部的说明与 REVIEW-R15 重要-3 —— 归真机验证，
// 不在这里用假实现硬凑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStampFresh } from "../../src/modules/sections.ts";

const STAMP = { size: 100, mtimeMs: 1000 };

test("r15 stamp: 指纹逐字相同 → 新鲜（true）", () => {
  assert.equal(isStampFresh({ size: 100, mtimeMs: 1000 }, { ...STAMP }), true);
});

test("r15 stamp: size 变化 → 失效（false）", () => {
  assert.equal(isStampFresh(STAMP, { size: 101, mtimeMs: 1000 }), false);
});

test("r15 stamp: mtime 变化 → 失效（false）", () => {
  assert.equal(isStampFresh(STAMP, { size: 100, mtimeMs: 1001 }), false);
});

test("r15 stamp: 现任 size 读不到（null）→ 失效（false）", () => {
  assert.equal(isStampFresh(STAMP, { size: null, mtimeMs: 1000 }), false);
});

test("r15 stamp: 现任 mtime 读不到（null）→ 失效（false）", () => {
  assert.equal(isStampFresh(STAMP, { size: 100, mtimeMs: null }), false);
});

test("r15 stamp: 无戳（null）→ 失效（false，必须重新解析）", () => {
  assert.equal(isStampFresh(null, { size: 100, mtimeMs: 1000 }), false);
});
