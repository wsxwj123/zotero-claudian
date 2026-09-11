// 单测 — R7-K「会话列表重组」前端归约/投影（PLAN-R7 §3.12，纯函数不碰 DOM、无 IO；黑盒：只按契约写，
// 本轮尚未开工 → 红基线即「模块不存在/未导出」）。
//
// 锁定的契约点（用户拍板：六条全做、置顶不限量、按新旧排序）：
//   1) 分支树折叠：分支缩进挂在父会话之下（depth 1）；默认只展开一层，显式展开才出 depth 2
//   2) 默认只显示**当前文献**的会话；其余收进「全部会话」抽屉
//   3) 抽屉内按合集分组（无合集归「未分类」）
//   4) 搜索框匹配会话标题 + 文献题名（大小写不敏感、中文子串）
//   5) 自动归档：> 90 天未更新 或 按 updatedAt 倒序第 51 条起 → 「归档」，默认隐藏、可搜索
//   6) 置顶任意条数、不限量；固定排最上、不受归档影响
//   7) 除置顶区外一律按 updatedAt 倒序；孤儿分支（父已删）当顶层不消失
//
// 未写死的口径（见交付报告「剩余歧义」，实现若选另一种读法需同步改这里的用例）：
//   - 「50 条」的计数范围 = 全表剔除置顶后的近期窗口；归档与抽屉/当前文献互斥（一条只出现一次）
//   - 置顶区「不折叠」按「区不折叠」读：区内的分支仍走同一套 depth 规则
//   - 搜索只做过滤，分区结构与排序不变；搜索时归档区参与（归档可搜索）
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/chat/lib/sessionList.ts →
//     ARCHIVE_IDLE_DAYS(90) / ARCHIVE_MAX_RECENT(50) / UNFILED_LABEL("未分类") /
//     buildSessionList({sessions, currentItemKey, pinned, expanded, query, now, showArchive})
//       -> { pinned: Row[], current: Row[], groups: [{label, rows: Row[]}], archive: Row[] }
//   session 记录形状（UI 侧投影，非 SessionRecord 本体）：
//     { id, title, itemKey, itemTitle, collectionName, updatedAt, parentId, branchIndex }
//   Row = 上述记录 + depth（0 = 顶层；父会话下的分支为 1，再往下 2…）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_IDLE_DAYS,
  ARCHIVE_MAX_RECENT,
  UNFILED_LABEL,
  buildSessionList,
} from "../../src/chat/lib/sessionList.ts";

const NOW = Date.parse("2026-09-11T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n) => NOW - n * DAY;

/** 会话记录工厂（默认：非置顶、无父、属于当前文献） */
const s = (id, over = {}) => ({
  id,
  title: `会话 ${id}`,
  itemKey: "ITEM-A",
  itemTitle: "Attention Is All You Need",
  collectionName: "深度学习",
  updatedAt: daysAgo(1),
  parentId: null,
  branchIndex: null,
  ...over,
});

/** 带默认参数的调用（每个用例只写自己要验的那几个入参） */
const build = (over = {}) =>
  buildSessionList({
    sessions: [],
    currentItemKey: "ITEM-A",
    pinned: [],
    expanded: [],
    query: "",
    now: NOW,
    ...over,
  });

/** 把四个区压平成 [{id, depth, 区名}]，便于断言「在哪一区、缩进多少」 */
function flat(model) {
  return [
    ...model.pinned.map((r) => [r.id, r.depth, "pinned"]),
    ...model.current.map((r) => [r.id, r.depth, "current"]),
    ...model.groups.flatMap((g) =>
      g.rows.map((r) => [r.id, r.depth, `drawer:${g.label}`]),
    ),
    ...model.archive.map((r) => [r.id, r.depth, "archive"]),
  ];
}

const ids = (rows) => rows.map((r) => r.id);

// ---- 分区与排序 ----

test("R7-K 分区：返回四区，顺序为 置顶 → 当前文献 → 抽屉分组 → 归档", () => {
  const model = build();
  assert.deepEqual(Object.keys(model), [
    "pinned",
    "current",
    "groups",
    "archive",
  ]);
  assert.deepEqual(model.pinned, []);
  assert.deepEqual(model.current, []);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.archive, []);
});

test("R7-K 分区：当前文献的会话进 current，别人的进抽屉", () => {
  const model = build({
    sessions: [
      s("a", { itemKey: "ITEM-A" }),
      s("b", { itemKey: "ITEM-B", itemTitle: "另一篇文献" }),
    ],
  });
  assert.deepEqual(ids(model.current), ["a"]);
  assert.deepEqual(
    flat(model).filter((r) => r[2].startsWith("drawer")),
    [["b", 0, "drawer:深度学习"]],
  );
});

test("R7-K 分区：一条会话只出现一次（分区互斥，不重复渲染）", () => {
  const model = build({
    sessions: [
      s("a"),
      s("b", { itemKey: "ITEM-B" }),
      s("old", { updatedAt: daysAgo(200) }),
    ],
  });
  const all = flat(model).map((r) => r[0]);
  assert.equal(
    new Set(all).size,
    all.length,
    `有会话被渲染了两次：${all.join(",")}`,
  );
});

test("R7-K 排序：除置顶区外一律按 updatedAt 倒序（新在前）", () => {
  const model = build({
    sessions: [
      s("旧", { updatedAt: daysAgo(10) }),
      s("新", { updatedAt: daysAgo(1) }),
      s("中", { updatedAt: daysAgo(5) }),
    ],
  });
  assert.deepEqual(ids(model.current), ["新", "中", "旧"]);
});

test("R7-K 排序：置顶区排最上，且区内同样按 updatedAt 倒序", () => {
  const model = build({
    sessions: [
      s("新", { updatedAt: daysAgo(1) }),
      s("钉旧", { updatedAt: daysAgo(30) }),
      s("钉新", { updatedAt: daysAgo(2) }),
    ],
    pinned: ["钉旧", "钉新"],
  });
  assert.deepEqual(ids(model.pinned), ["钉新", "钉旧"]);
  assert.deepEqual(
    ids(model.current),
    ["新"],
    "置顶的会话不再重复出现在当前文献区",
  );
});

// ---- 抽屉：按合集分组 ----

test("R7-K 抽屉：按合集分组，组名取自会话的 collectionName", () => {
  const model = build({
    sessions: [
      s("b1", { itemKey: "ITEM-B", collectionName: "计算机视觉" }),
      s("a1", { itemKey: "ITEM-B", collectionName: "深度学习" }),
    ],
  });
  assert.deepEqual(model.groups.map((g) => g.label).sort(), [
    "深度学习",
    "计算机视觉",
  ]);
});

test("R7-K 抽屉：无合集 → 归「未分类」（不出现空组名）", () => {
  const model = build({
    sessions: [
      s("x", { itemKey: "ITEM-B", collectionName: null }),
      s("y", { itemKey: "ITEM-B", collectionName: "" }),
    ],
  });
  assert.deepEqual(
    model.groups.map((g) => g.label),
    [UNFILED_LABEL],
  );
  assert.equal(model.groups[0].rows.length, 2);
});

test("R7-K 抽屉：组内按 updatedAt 倒序", () => {
  const model = build({
    sessions: [
      s("旧", { itemKey: "ITEM-B", updatedAt: daysAgo(9) }),
      s("新", { itemKey: "ITEM-B", updatedAt: daysAgo(1) }),
    ],
  });
  assert.deepEqual(ids(model.groups[0].rows), ["新", "旧"]);
});

test("R7-K 抽屉：组间按组内最新一条的 updatedAt 倒序（整体也是新旧排序）", () => {
  const model = build({
    sessions: [
      s("老组的", {
        itemKey: "ITEM-B",
        collectionName: "老组",
        updatedAt: daysAgo(20),
      }),
      s("新组的", {
        itemKey: "ITEM-B",
        collectionName: "新组",
        updatedAt: daysAgo(2),
      }),
    ],
  });
  assert.deepEqual(
    model.groups.map((g) => g.label),
    ["新组", "老组"],
  );
});

// ---- 置顶 ----

test("R7-K 置顶：不限量 —— 60 个置顶全部在置顶区（不被 50 条归档规则吃掉）", () => {
  const sessions = Array.from({ length: 60 }, (_, i) =>
    s(`p${i}`, { updatedAt: daysAgo(i + 1) }),
  );
  const model = build({ sessions, pinned: sessions.map((x) => x.id) });
  assert.equal(model.pinned.length, 60);
  assert.deepEqual(model.archive, [], "置顶区不受归档影响");
  assert.equal(model.pinned[0].id, "p0", "最老的置顶也还在（只是排在后面）");
});

test("R7-K 置顶：不受归档影响 —— 置顶的老会话不进归档区", () => {
  const model = build({
    sessions: [s("钉住的老会话", { updatedAt: daysAgo(365) })],
    pinned: ["钉住的老会话"],
  });
  assert.deepEqual(ids(model.pinned), ["钉住的老会话"]);
  assert.deepEqual(model.archive, [], "归档区不因它变脏");
  assert.deepEqual(model.current, [], "置顶的不会再在当前文献区重复出现");
});

test("R7-K 置顶：没置顶的会话进不了置顶区；置顶集合里的未知 id 被忽略且不抛", () => {
  const model = build({
    sessions: [s("a")],
    pinned: ["不存在的 id", "a"],
  });
  assert.deepEqual(ids(model.pinned), ["a"]);
});

// ---- 分支 depth 与展开 ----

const TREE = [
  s("父", { updatedAt: daysAgo(1) }),
  s("子2", { parentId: "父", branchIndex: 2, updatedAt: daysAgo(2) }),
  s("子1", { parentId: "父", branchIndex: 1, updatedAt: daysAgo(3) }),
];

test("R7-K 分支：分支缩进挂在父之下（depth 1），按 branchIndex 升序", () => {
  const model = build({ sessions: TREE });
  assert.deepEqual(
    model.current.map((r) => [r.id, r.depth]),
    [
      ["父", 0],
      ["子1", 1],
      ["子2", 1],
    ],
  );
});

test("R7-K 分支：默认只展开一层 —— 分支的分支不出现", () => {
  const model = build({
    sessions: [...TREE, s("孙", { parentId: "子1", branchIndex: 1 })],
  });
  assert.ok(!`${ids(model.current)}`.includes("孙"), "默认不展开第二层");
  assert.equal(model.current.length, 3);
});

test("R7-K 分支：显式展开某分支 → 其子分支出现且 depth 2", () => {
  const model = build({
    sessions: [...TREE, s("孙", { parentId: "子1", branchIndex: 1 })],
    expanded: ["子1"],
  });
  const 孙 = model.current.find((r) => r.id === "孙");
  assert.ok(孙, "展开后子分支要出现");
  assert.equal(孙.depth, 2);
  assert.ok(
    model.current.indexOf(孙) > model.current.findIndex((r) => r.id === "子1"),
    "子分支排在其父之后",
  );
});

test("R7-K 分支：孤儿分支（父已删）当顶层不消失", () => {
  const model = build({
    sessions: [
      s("活着", {}),
      s("孤儿", { parentId: "已删除的父", branchIndex: 1 }),
    ],
  });
  const 孤儿 = model.current.find((r) => r.id === "孤儿");
  assert.ok(孤儿, "父没了也要能看见");
  assert.equal(孤儿.depth, 0);
});

test("R7-K 分支：分支跟着父所在的分区走（当前文献的分支不跑进抽屉）", () => {
  const model = build({
    sessions: [
      s("父", { itemKey: "ITEM-A" }),
      s("子", { parentId: "父", itemKey: "ITEM-A", branchIndex: 1 }),
    ],
  });
  assert.deepEqual(
    model.current.map((r) => [r.id, r.depth]),
    [
      ["父", 0],
      ["子", 1],
    ],
  );
  assert.deepEqual(model.groups, []);
});

// ---- 搜索 ----

test("R7-K 搜索：命中会话标题（大小写不敏感）", () => {
  const model = build({
    sessions: [
      // 文献题名置空，确保命中的是「标题」这一路
      s("a", { title: "Attention 精读", itemTitle: null }),
      s("b", { title: "别的东西", itemTitle: null }),
    ],
    query: "ATTENTION",
  });
  assert.deepEqual(ids(model.current), ["a"]);
});

test("R7-K 搜索：命中文献题名（会话标题里没有该词也能搜到）", () => {
  const model = build({
    sessions: [
      s("a", { title: "总结", itemTitle: "Deep Residual Learning" }),
      s("b", { title: "总结", itemTitle: "别的东西" }),
    ],
    query: "residual",
  });
  assert.deepEqual(ids(model.current), ["a"]);
});

test("R7-K 搜索：中文子串命中", () => {
  const model = build({
    sessions: [
      s("a", { title: "机器学习综述" }),
      s("b", { title: "别的东西" }),
    ],
    query: "机器学习",
  });
  assert.deepEqual(ids(model.current), ["a"]);
});

test("R7-K 搜索：无命中 → 四个区都空（不显示全部）", () => {
  const model = build({ sessions: TREE, query: "查无此词" });
  assert.deepEqual(flat(model), []);
});

test("R7-K 搜索：归档会话可被搜到（归档默认隐藏、但不是搜不到）", () => {
  const old = s("老会话", { title: "三年前的对话", updatedAt: daysAgo(365) });
  assert.deepEqual(ids(build({ sessions: [old] }).archive), [], "默认隐藏");
  const searched = build({ sessions: [old], query: "三年前" });
  assert.deepEqual(ids(searched.archive), ["老会话"], "搜索时归档参与");
});

test("R7-K 搜索：搜索不改变分区结构（置顶命中的仍在置顶区）", () => {
  const model = build({
    sessions: [s("a", { title: "目标" }), s("b", { title: "目标 2" })],
    pinned: ["a"],
    query: "目标",
  });
  assert.deepEqual(ids(model.pinned), ["a"]);
  assert.deepEqual(ids(model.current), ["b"]);
});

// ---- 归档阈值 ----

test("R7-K 归档：90 天边界 —— 正好 90 天不归档，91 天归档", () => {
  assert.equal(ARCHIVE_IDLE_DAYS, 90);
  const model = build({
    sessions: [
      s("正好90", { updatedAt: NOW - ARCHIVE_IDLE_DAYS * DAY }),
      s("91天", { updatedAt: daysAgo(91) }),
    ],
    showArchive: true, // 归档默认隐藏，要看归档区得显式打开
  });
  assert.deepEqual(ids(model.current), ["正好90"]);
  assert.deepEqual(ids(model.archive), ["91天"]);
});

test("R7-K 归档：50 条边界 —— 正好 50 条都不归档，第 51 条起进归档", () => {
  assert.equal(ARCHIVE_MAX_RECENT, 50);
  const exact = Array.from({ length: 50 }, (_, i) =>
    s(`s${i}`, { updatedAt: daysAgo(1) }),
  );
  assert.deepEqual(build({ sessions: exact }).archive, []);

  const over = [...exact, s("第51条", { updatedAt: daysAgo(2) })];
  const model = build({ sessions: over, showArchive: true });
  assert.deepEqual(
    ids(model.archive),
    ["第51条"],
    "按 updatedAt 倒序第 51 条起归档",
  );
  assert.equal(model.current.length, 50, "近期窗口仍留在当前文献区");
});

test("R7-K 归档：默认隐藏；showArchive 才出现在归档区（内容不变）", () => {
  const sessions = [s("老", { updatedAt: daysAgo(200) })];
  assert.deepEqual(build({ sessions }).archive, []);
  assert.deepEqual(ids(build({ sessions, showArchive: true }).archive), ["老"]);
});

test("R7-K 归档：当前文献的老会话也照样归档（归档优先于分区）", () => {
  const model = build({
    sessions: [s("老", { itemKey: "ITEM-A", updatedAt: daysAgo(200) })],
    showArchive: true,
  });
  assert.deepEqual(model.current, []);
  assert.deepEqual(ids(model.archive), ["老"]);
});

// ---- 空态 ----

test("R7-K 空态：没有会话 → 四区皆空、不抛", () => {
  for (const over of [
    {},
    { currentItemKey: null },
    { sessions: undefined },
    { query: "有词但没会话" },
  ]) {
    let model;
    assert.doesNotThrow(() => {
      model = build(over);
    });
    assert.deepEqual(flat(model), []);
  }
});

test("R7-K 空态：没有当前文献（通用会话）→ 现存会话落抽屉的「未分类」", () => {
  const model = build({
    currentItemKey: null,
    sessions: [s("通用会话", { itemKey: null, collectionName: null })],
  });
  assert.deepEqual(model.current, []);
  assert.deepEqual(
    model.groups.map((g) => g.label),
    [UNFILED_LABEL],
  );
  assert.deepEqual(ids(model.groups[0].rows), ["通用会话"]);
});
