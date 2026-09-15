// 黑盒复现 — R18-1「范围」多选只显示一个（INTERFACE-R18 §2 / §4）。只按接口约定写，不看实现。
// 约定：「书库中选中的文献」读的永远是书库标签那棵条目树的当前选中行，不管当前在哪个标签页；
//       不许依赖 getSelectedItems 的第二参数（7.0.12–9.0.6 会丢掉它）。
// 假宿主（globalThis.Zotero）两种版本形态：
//   legacy = 7.0.12–9.0.6：ZoteroPane.getSelectedItems(asIDs, libraryTabOnly) 忽略第二参数，
//            按当前标签返回（书库→选中集；阅读器→打开的那条；其他标签→空）
//   v10    = 10.x：认第二参数，libraryTabOnly=true 时返回书库选中集
import { test } from "node:test";
import assert from "node:assert/strict";
import { createZoteroScopeDeps } from "../../src/modules/contextSource.ts";
import { SCOPE_EMPTY_HINT } from "../../src/chat/lib/scopePicker.ts";

type Kind = "regular" | "attachment" | "note";
type Tab = "library" | "reader" | "fullpage";

function item(id: number, key: string, kind: Kind = "regular", parent = 0) {
  return {
    id,
    key,
    libraryID: 1,
    itemType: kind === "regular" ? "journalArticle" : kind,
    parentItemID: parent || false,
    isRegularItem: () => kind === "regular",
    isAttachment: () => kind === "attachment",
    isNote: () => kind === "note",
    isTopLevelItem: () => !parent,
  };
}
type FakeItem = ReturnType<typeof item>;

const A = item(1, "AAAA1111");
const B = item(2, "BBBB2222");
const C = item(3, "CCCC3333");
const THREE = [A, B, C];

interface Host {
  version?: "legacy" | "v10";
  tab?: Tab;
  selected?: FakeItem[];
  itemsView?: boolean; // 默认 true：条目树已建好
  paneApi?: boolean; // 默认 true：ZoteroPane.getSelectedItems 存在
  throws?: boolean; // 两个取选择的入口都抛错
  noWindow?: boolean; // 没有主窗口
}

function fakeZotero(h: Host) {
  const sel = h.selected ?? THREE;
  const tab = h.tab ?? "library";
  const all = [...THREE, ...sel];
  const out = (list: FakeItem[], asIDs?: boolean) =>
    asIDs ? list.map((i) => i.id) : [...list];
  const boom = () => {
    throw new Error("fake: Zotero 内部抛错");
  };
  // 阅读器里打开的是第 1 条的 PDF：旧版接口在阅读器标签只回这 1 条
  const byTab = () => (tab === "library" ? sel : tab === "reader" ? [A] : []);
  const itemsView = {
    rowCount: sel.length,
    selection: { count: sel.length, selected: new Set(sel.map((_, i) => i)) },
    getRow: (i: number) => ({ ref: sel[i], id: sel[i]?.id }),
    getSelectedItems: (asIDs?: boolean) =>
      h.throws ? boom() : out(sel, asIDs),
    getSelectedObjects: () => (h.throws ? boom() : [...sel]),
  };
  const pane: Record<string, unknown> = {};
  if (h.itemsView !== false) pane.itemsView = itemsView;
  if (h.paneApi !== false) {
    pane.getSelectedItems = (asIDs?: boolean, libraryTabOnly?: boolean) => {
      if (h.throws) boom();
      if ((h.version ?? "legacy") === "v10" && libraryTabOnly)
        return out(sel, asIDs);
      return out(byTab(), asIDs);
    };
  }
  const tabs = {
    selectedID: tab === "library" ? "zotero-pane" : `tab-${tab}`,
    selectedType: tab,
  };
  const win = h.noWindow ? null : { ZoteroPane: pane, Zotero_Tabs: tabs };
  return {
    getMainWindow: () => win,
    getMainWindows: () => (win ? [win] : []),
    getActiveZoteroPane: () => (win ? pane : null),
    Items: {
      get: (ids: number | number[]) =>
        Array.isArray(ids)
          ? ids.map((id) => all.find((i) => i.id === id) ?? null)
          : (all.find((i) => i.id === ids) ?? null),
    },
    debug: () => {},
    logError: () => {},
  };
}

/** 装上假宿主 → 调 listSelected → 还原全局（测试之间不共享状态） */
async function listWith(h: Host) {
  const g = globalThis as Record<string, unknown>;
  const had = "Zotero" in g;
  const prev = g.Zotero;
  g.Zotero = fakeZotero(h);
  try {
    const got = await createZoteroScopeDeps().listSelected();
    return got.map((c) => ({ itemKey: c.itemKey, regular: c.regular }));
  } finally {
    if (had) g.Zotero = prev;
    else delete g.Zotero;
  }
}

const KEYS3 = THREE.map((i) => ({ itemKey: i.key, regular: true }));

// ---- 7.0.12–9.0.6（第二参数被丢掉） ----

test("R18 计数 🔒：7.0.12–9.0.6 在书库标签多选 3 篇 → 读到 3 篇、按条目树顺序", async () => {
  assert.deepEqual(
    await listWith({ version: "legacy", tab: "library" }),
    KEYS3,
  );
});

test("R18 计数 🔴：7.0.12–9.0.6 在阅读器标签（开着第 1 篇的 PDF）→ 仍读书库选中的 3 篇（修前 1）", async () => {
  assert.deepEqual(await listWith({ version: "legacy", tab: "reader" }), KEYS3);
});

test("R18 计数 🔴：7.0.12–9.0.6 在「全页」标签 → 仍读书库选中的 3 篇（修前 0）", async () => {
  assert.deepEqual(
    await listWith({ version: "legacy", tab: "fullpage" }),
    KEYS3,
  );
});

// ---- 10.x（第二参数被认） ----

for (const tab of ["library", "reader", "fullpage"] as const) {
  test(`R18 计数 🔒：Zotero 10.x 在 ${tab} 标签 → 读到书库选中的 3 篇`, async () => {
    assert.deepEqual(await listWith({ version: "v10", tab }), KEYS3);
  });
}

// ---- 新旧入口只剩一个 / 都没有 ----

test("R18 计数 🔒：没有 itemsView、官方接口认 libraryTabOnly → 等于官方接口给的书库选中集", async () => {
  const got = await listWith({
    version: "v10",
    tab: "reader",
    selected: [B, C],
    itemsView: false,
  });
  assert.deepEqual(got, [
    { itemKey: B.key, regular: true },
    { itemKey: C.key, regular: true },
  ]);
});

test("R18 计数 🔒：itemsView 与官方接口都没有 → 候选为空、不抛", async () => {
  assert.deepEqual(await listWith({ itemsView: false, paneApi: false }), []);
});

test("R18 计数 🔒：没有主窗口 → 候选为空、不抛", async () => {
  assert.deepEqual(await listWith({ noWindow: true }), []);
});

test("R18 计数 🔒：取选择的调用抛错 → 候选为空、不抛", async () => {
  assert.deepEqual(await listWith({ throws: true, tab: "reader" }), []);
});

test("R18 计数 🔒：附件 / 笔记本身不冒充顶层文献；顶层文献保持条目树顺序", async () => {
  const att = item(21, "ATTX0001", "attachment", 1);
  const note = item(22, "NOTE0001", "note");
  const got = await listWith({ tab: "library", selected: [C, att, note, A] });
  assert.deepEqual(
    got.filter((c) => c.regular),
    [
      { itemKey: C.key, regular: true },
      { itemKey: A.key, regular: true },
    ],
  );
});

// ---- 0 篇提示文案（§4 唯一改动） ----

test("R18 提示 🔴：选中模式 0 篇提示逐字为「⌘/Ctrl 多选」版本", () => {
  assert.equal(
    SCOPE_EMPTY_HINT.selection,
    "没读到选中的文献——请先在左侧文献列表里选中文献（⌘/Ctrl 多选），再点「重试」",
  );
});
