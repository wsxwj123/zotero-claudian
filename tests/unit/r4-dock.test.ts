// 单测 — R4 需求 2 顶部按钮浮层（dock）的纯逻辑面（PLAN-R4 §3，黑盒：只按契约写，不建 DOM）。
// 契约：浮层宽度默认 420px、可拖、范围 320–900，拖动结束落 prefs；浮层 position:fixed，
//       right 贴齐窗口、top/bottom 贴合窗口内容区、宽度取钳制后的值；重复 toggle 幂等，
//       destroy 后（插件停用/窗口关闭）再操作不崩。
// 宽度口径（主会话 R4 裁决 A1）：非有限值（NaN/字符串/undefined/null/Infinity）或 <= 0 → 默认 420；
//       其余一律 clamp 到 [320, 900]（319→320、901→900、5000→900）。
//
// 契约未给出纯函数名与形状，本文件锁定的形（开发需照此导出；若主会话另有裁决需同步改此文件）：
//   DOCK_WIDTH_DEFAULT / DOCK_WIDTH_MIN / DOCK_WIDTH_MAX = 420 / 320 / 900
//   normalizeDockWidth(raw: unknown) -> number
//   dockRect(viewport: { width, height, top?, bottom? }, rawWidth: unknown)
//     -> { left, top, right, bottom, width, height }
//   dockReduce(phase: "closed"|"open"|"destroyed", action: "toggle"|"show"|"hide"|"destroy")
//     -> phase
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  dockRect,
  dockReduce,
  normalizeDockWidth,
} from "../../src/modules/dockPanel.ts";

// ---- 宽度 ----

test("dock 宽度：默认/上下限常量为 420 / 320 / 900", () => {
  assert.equal(DOCK_WIDTH_DEFAULT, 420);
  assert.equal(DOCK_WIDTH_MIN, 320);
  assert.equal(DOCK_WIDTH_MAX, 900);
});

test("dock 宽度：区间内原值返回（含两端 320 / 900）", () => {
  for (const px of [320, 420, 500, 899, 900]) {
    assert.equal(normalizeDockWidth(px), px);
  }
});

test("dock 宽度：越界钳制到边界（319→320、1→320、901→900、5000→900）", () => {
  assert.equal(normalizeDockWidth(319), DOCK_WIDTH_MIN);
  assert.equal(normalizeDockWidth(1), DOCK_WIDTH_MIN);
  assert.equal(normalizeDockWidth(901), DOCK_WIDTH_MAX);
  assert.equal(normalizeDockWidth(5000), DOCK_WIDTH_MAX);
});

test("dock 宽度：非有限值/非数字（NaN/字符串/null/undefined/对象/Infinity）→ 默认 420 不抛", () => {
  // Infinity 属「非有限值」→ 420（不是超大数钳制到 900）
  for (const bad of [NaN, "500", "abc", null, undefined, {}, [], Infinity, -Infinity]) {
    let got: any;
    assert.doesNotThrow(() => {
      got = normalizeDockWidth(bad);
    }, String(bad));
    assert.equal(got, DOCK_WIDTH_DEFAULT, String(bad));
  }
});

test("dock 宽度：负数 / 0 → 默认 420（不是负宽也不是钳到 320）", () => {
  assert.equal(normalizeDockWidth(-1), DOCK_WIDTH_DEFAULT);
  assert.equal(normalizeDockWidth(-500), DOCK_WIDTH_DEFAULT);
  assert.equal(normalizeDockWidth(0), DOCK_WIDTH_DEFAULT);
});

// ---- 几何 ----

test("dock 几何：右贴齐窗口、上下贴内容区、宽=给定量", () => {
  const r = dockRect({ width: 1200, height: 800, top: 32, bottom: 0 }, 500);
  assert.deepEqual(r, {
    left: 700,
    top: 32,
    right: 1200,
    bottom: 800,
    width: 500,
    height: 768,
  });
});

test("dock 几何：right 始终贴齐窗口右缘（left = 窗口宽 - 浮层宽）", () => {
  for (const vw of [800, 1440, 2560]) {
    const r = dockRect({ width: vw, height: 900 }, 420);
    assert.equal(r.right, vw, `窗口宽 ${vw}`);
    assert.equal(r.left, vw - 420, `窗口宽 ${vw}`);
  }
});

test("dock 几何：top/bottom 贴合内容区（顶部工具栏 + 底部状态栏都让开）", () => {
  const r = dockRect({ width: 1000, height: 600, top: 40, bottom: 24 }, 400);
  assert.equal(r.top, 40);
  assert.equal(r.bottom, 576);
  assert.equal(r.height, 536);
  assert.equal(r.left, 600);
});

test("dock 几何：viewport 未给 top/bottom → 按 0 处理（贴合整个内容区）", () => {
  const r = dockRect({ width: 1000, height: 600 }, 400);
  assert.equal(r.top, 0);
  assert.equal(r.bottom, 600);
  assert.equal(r.height, 600);
});

test("dock 几何：宽度取归一化后的值（越界/非法输入不直接进 rect）", () => {
  assert.equal(dockRect({ width: 1200, height: 800 }, 5000).width, DOCK_WIDTH_MAX);
  assert.equal(dockRect({ width: 1200, height: 800 }, "500" as any).width, 420);
  assert.equal(
    dockRect({ width: 1200, height: 800 }, 500).width,
    normalizeDockWidth(500),
  );
});

// ---- 开合状态机 ----

test("dock 状态：toggle 开 → 关 → 回到原态（closed 起）", () => {
  const open = dockReduce("closed", "toggle");
  assert.equal(open, "open");
  assert.equal(dockReduce(open, "toggle"), "closed");
});

test("dock 状态：toggle 两次从 open 回到 open（幂等，不成环）", () => {
  assert.equal(dockReduce(dockReduce("open", "toggle"), "toggle"), "open");
});

test("dock 状态：show/hide 幂等", () => {
  assert.equal(dockReduce("open", "show"), "open");
  assert.equal(dockReduce("closed", "show"), "open");
  assert.equal(dockReduce("closed", "hide"), "closed");
  assert.equal(dockReduce("open", "hide"), "closed");
});

test("dock 状态：destroy 后 hide/show/toggle 都不抛且保持 destroyed", () => {
  const dead = dockReduce("open", "destroy");
  assert.equal(dead, "destroyed");
  for (const action of ["hide", "show", "toggle", "destroy"] as const) {
    let got: any;
    assert.doesNotThrow(() => {
      got = dockReduce(dockReduce("open", "destroy"), action);
    }, action);
    assert.equal(got, "destroyed", action);
  }
});

test("dock 状态：destroy 幂等（停用/关窗两次调用不叠加副作用）", () => {
  assert.equal(dockReduce(dockReduce("closed", "destroy"), "destroy"), "destroyed");
});
