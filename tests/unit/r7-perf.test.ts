// 单测 — 流式 Markdown 重渲染节流（用户实测「Zotero 好卡」的修复：合并重渲染）。
// 覆盖：shouldRender 的边界（非流式恒真 / 首帧 / 到点 / 未到点的合并）、nextRenderDelay 的钳制、
//       以及一段 3s / 120 个 delta 的流式模拟——渲染次数掉到 ~时长/150ms，且最后一帧不丢。
// 纯逻辑（时钟与文本经形参注入，不碰 DOM）：组件侧的 setTimeout 调度是它的直译
//（delta 到达 → shouldRender 说不行就排一个 nextRenderDelay 的定时器，到点画最新文本）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_RENDER_INTERVAL_MS,
  nextRenderDelay,
  shouldRender,
} from "../../src/chat/lib/renderThrottle.ts";

const NEVER = Number.NEGATIVE_INFINITY;

test("R7-PERF 间隔常量：150ms（取值依据写在模块注释里）", () => {
  assert.equal(STREAM_RENDER_INTERVAL_MS, 150);
});

test("R7-PERF shouldRender：非流式恒真（最后一帧永远不被节流吞掉）", () => {
  assert.equal(shouldRender(1000, 999, false), true, "刚渲染完也要画最终帧");
  assert.equal(shouldRender(1000, 1000, false), true);
  assert.equal(shouldRender(0, 0, false), true);
});

test("R7-PERF shouldRender：流式首帧（从未渲染过）→ 立即画", () => {
  assert.equal(shouldRender(12345, NEVER, true), true);
  assert.equal(shouldRender(0, NEVER, true), true);
});

test("R7-PERF shouldRender：流式距上次不足间隔 → 不画；到点 → 画", () => {
  const last = 10_000;
  assert.equal(shouldRender(last + 1, last, true), false);
  assert.equal(shouldRender(last + 149, last, true), false);
  assert.equal(shouldRender(last + 150, last, true), true, "到点即画");
  assert.equal(
    shouldRender(last + 900, last, true),
    true,
    "卡顿/后台节流后补画",
  );
});

test("R7-PERF nextRenderDelay：补足到间隔的剩余毫秒；已到点/从未渲染 → 0", () => {
  assert.equal(nextRenderDelay(10_000 + 40, 10_000), 110);
  assert.equal(nextRenderDelay(10_000, 10_000), 150);
  assert.equal(nextRenderDelay(10_000 + 150, 10_000), 0);
  assert.equal(nextRenderDelay(10_000 + 500, 10_000), 0);
  assert.equal(nextRenderDelay(10_000, NEVER), 0, "首帧不排定时器，直接画");
  // 时钟回拨（NTP 校正等）：按差值顺延，绝不排负延迟
  assert.ok(nextRenderDelay(9_950, 10_000) > 0);
});

/** 组件同款合并逻辑的纯模拟：到点立刻画；未到点排一个「到点画最新文本」的定时器 */
function simulateStream(
  samples: { at: number; text: string }[],
  interval: number,
): { paints: number; painted: string[] } {
  let last = NEVER;
  let pendingAt: number | null = null;
  let latest = "";
  const painted: string[] = [];
  for (const s of samples) {
    if (pendingAt !== null && pendingAt <= s.at) {
      // 挂起的定时器到点：画此刻已知的最新文本（中间 delta 全丢）
      last = pendingAt;
      pendingAt = null;
      painted.push(latest);
    }
    latest = s.text;
    if (shouldRender(s.at, last, true, interval)) {
      last = s.at;
      painted.push(latest);
    } else if (pendingAt === null) {
      pendingAt = s.at + nextRenderDelay(s.at, last, interval);
    }
  }
  painted.push(latest); // 流式收尾：streaming=false 那帧恒渲染
  return { paints: painted.length, painted };
}

test("R7-PERF 3s/120 个 delta：渲染次数 ≈ 时长/150ms（合并中间帧），且末帧是最新文本", () => {
  const samples = Array.from({ length: 120 }, (_, i) => ({
    at: 25 * (i + 1),
    text: "x".repeat(i + 1),
  }));
  const spanMs = 25 * samples.length; // 3000ms
  const { paints, painted } = simulateStream(
    samples,
    STREAM_RENDER_INTERVAL_MS,
  );

  const naive = samples.length; // 未节流：每个 delta 一次全量重解析（修复前的行为）
  assert.equal(naive, 120);
  assert.ok(
    paints <= Math.ceil(spanMs / STREAM_RENDER_INTERVAL_MS) + 2,
    `渲染 ${paints} 次，应 ≤ 时长/150ms+2 = ${Math.ceil(spanMs / 150) + 2}`,
  );
  assert.ok(paints >= Math.floor(spanMs / STREAM_RENDER_INTERVAL_MS) - 1);
  assert.ok(paints * 5 < naive, `省下的量应足够多（${paints} vs ${naive}）`);
  assert.equal(
    painted[painted.length - 1],
    samples[samples.length - 1].text,
    "最后一帧必须是流式结束时的最新文本",
  );
  // 画出来的帧是「越来越长」的原文，绝不会回退到旧文本
  for (let i = 1; i < painted.length; i++) {
    assert.ok(painted[i].length >= painted[i - 1].length);
  }
});

test("R7-PERF 极慢流（delta 间隔 > 150ms）：每个 delta 立即画，不额外积压", () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({
    at: 400 * (i + 1),
    text: "y".repeat(i + 1),
  }));
  const { paints, painted } = simulateStream(
    samples,
    STREAM_RENDER_INTERVAL_MS,
  );
  assert.equal(
    paints,
    samples.length + 1, // 每个 delta 一次 + 收尾帧一次
    "不节流：本来就不密，画得动就画，没有多余的重渲染",
  );
  assert.equal(painted[painted.length - 1], samples[samples.length - 1].text);
});
