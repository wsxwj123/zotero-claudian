// 单测 — M8 独立标签页：tab 生命周期状态机（createMainTabHost，DI 部分）+ 工具栏按钮注入幂等。
// 真实 Zotero_Tabs / DOM / 桥都不进这层：用最小 fake 覆盖「开→聚焦→关→再开」与半途失败收尾。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMainTabHost,
  installToolbarButton,
  removeToolbarButton,
  TOOLBAR_BUTTON_ID,
  type DocumentLike,
  type ElementLike,
  type MainTabHostDeps,
  type MainWindowLike,
  type ZoteroTabsLike,
} from "../../src/modules/mainTab.ts";

const TAB_ID = "claudian-main-tab";

// ---- 最小 fake DOM：只实现 mainTab.ts 用到的那几个口 ----

interface FakeElement extends ElementLike {
  tag: string;
  attributes: Record<string, string>;
  listeners: Record<string, Array<() => void>>;
  children: FakeElement[];
  parent: FakeElement | null;
  fire(type: string): void;
}

interface FakeDocument extends DocumentLike {
  getEl(id: string): FakeElement | null;
}

function createFakeDocument(
  toolbarIds: string[] = ["zotero-tabs-toolbar"],
): FakeDocument {
  const registry = new Map<string, FakeElement>();

  function makeElement(tag: string): FakeElement {
    const el = {
      tag,
      attributes: {} as Record<string, string>,
      listeners: {} as Record<string, Array<() => void>>,
      children: [] as FakeElement[],
      parent: null as FakeElement | null,
      setAttribute(name: string, value: string) {
        el.attributes[name] = value;
        if (name === "id") {
          registry.set(value, el);
        }
      },
      addEventListener(type: string, listener: () => void) {
        (el.listeners[type] ??= []).push(listener);
      },
      appendChild(child: FakeElement) {
        el.children.push(child);
        child.parent = el;
        if (child.attributes.id) {
          registry.set(child.attributes.id, child);
        }
      },
      remove() {
        if (el.parent) {
          el.parent.children = el.parent.children.filter((c) => c !== el);
        }
        el.parent = null;
        if (el.attributes.id) {
          registry.delete(el.attributes.id);
        }
      },
      fire(type: string) {
        for (const listener of el.listeners[type] ?? []) {
          listener();
        }
      },
    };
    Object.defineProperty(el, "id", {
      get: () => el.attributes.id ?? "",
      set: (value: string) => {
        el.attributes.id = value;
        registry.set(value, el);
      },
    });
    return el as unknown as FakeElement;
  }

  for (const id of toolbarIds) {
    makeElement("toolbar").setAttribute("id", id);
  }
  return {
    getElementById: (id) => registry.get(id) ?? null,
    getEl: (id) => registry.get(id) ?? null,
    createXULElement: (tag) => makeElement(tag),
  };
}

interface FakeTabs {
  tabs: ZoteroTabsLike;
  /** add 收到的完整参数（断言 data 必传等） */
  added: Array<Record<string, unknown>>;
  selected: string[];
  closed: string[];
  /** 模拟 Zotero_Tabs.close / 用户点 X：触发登记过的 onClose */
  closeFromZotero(id: string): void;
  fail: { add: boolean; select: boolean };
}

function createFakeTabs(doc: FakeDocument): FakeTabs {
  const added: Array<Record<string, unknown>> = [];
  const selected: string[] = [];
  const closed: string[] = [];
  const fail = { add: false, select: false };
  let onClose: (() => void) | null = null;
  const tabs: ZoteroTabsLike = {
    add(options) {
      if (fail.add) {
        throw new Error("add exploded");
      }
      added.push(options as unknown as Record<string, unknown>);
      onClose = options.onClose;
      // 真实实现（omni/tabs.js）：容器由 add 建好并把 id 挂成容器 id
      const container = doc.createXULElement("tab-content");
      container.setAttribute("id", options.id);
      return { id: options.id, container };
    },
    select(id) {
      if (fail.select) {
        throw new Error("select exploded");
      }
      selected.push(id);
    },
    close(id) {
      closed.push(id);
      onClose?.();
    },
  };
  return {
    tabs,
    added,
    selected,
    closed,
    closeFromZotero: (id) => {
      closed.push(id);
      onClose?.();
    },
    fail,
  };
}

// ---- 被测 host 的组装（页面装配与注销都是 fake，Zotero 与桥零参与）----

interface Harness {
  win: MainWindowLike;
  doc: FakeDocument;
  tabs: FakeTabs;
  host: ReturnType<typeof createMainTabHost>;
  /** mountPage 收到的 browser 元素 */
  mounted: FakeElement[];
  /** mountPage 收到的 onLoaded 回调（可手动「迟到」触发，NEW-4 回归用） */
  loadCallbacks: Array<(win: object) => void>;
  /** unregisterPage 收到的页面 window */
  unregistered: object[];
  logs: string[];
  /** page 加载完成回调（默认自动触发；测试可关掉模拟「页面还没 load」） */
  autoLoad: { value: boolean };
  pageWindow: object;
}

function createHarness(options: { withToolbar?: boolean } = {}): Harness {
  const doc = createFakeDocument(
    options.withToolbar === false ? [] : undefined,
  );
  const tabs = createFakeTabs(doc);
  const win: MainWindowLike = { document: doc, Zotero_Tabs: tabs.tabs };
  const mounted: FakeElement[] = [];
  const loadCallbacks: Array<(win: object) => void> = [];
  const unregistered: object[] = [];
  const logs: string[] = [];
  const autoLoad = { value: true, win: null as object | null };
  const pageWindow = { name: "fake-page-window" };
  const deps: MainTabHostDeps = {
    getMainWindow: () => win,
    mountPage: (browser, onLoaded) => {
      mounted.push(browser as FakeElement);
      loadCallbacks.push(onLoaded);
      if (autoLoad.value) {
        onLoaded(autoLoad.win ?? pageWindow);
      }
    },
    unregisterPage: (w) => {
      unregistered.push(w);
    },
    log: (message) => {
      logs.push(message);
    },
  };
  return {
    win,
    doc,
    tabs,
    host: createMainTabHost(deps),
    mounted,
    loadCallbacks,
    unregistered,
    logs,
    autoLoad,
    pageWindow,
  };
}

// ---- tab 生命周期 ----

test("mainTab: 首次 open → 新建 tab（data 必传）+ 塞非 remote browser + 装配页面", () => {
  const h = createHarness();
  assert.equal(h.host.open(), "opened");
  assert.equal(h.host.isOpen(), true);
  assert.equal(h.tabs.added.length, 1);
  const options = h.tabs.added[0];
  assert.equal(options.id, TAB_ID);
  assert.equal(
    options.type,
    "claudian",
    "type 不带短横线（Zotero 按 '-' 拆 type/state）",
  );
  assert.deepEqual(
    options.data,
    {},
    "SPIKE 假设 6：data 必传，否则 Zotero 内部 throw",
  );
  assert.equal(options.title, "Claude");
  assert.equal(options.select, true);
  assert.equal(typeof options.onClose, "function");

  const container = h.doc.getEl(TAB_ID);
  assert.ok(container, "容器由 Zotero_Tabs.add 建出（id = tab id）");
  assert.equal(container.children.length, 1);
  const browser = container.children[0];
  assert.equal(browser.tag, "browser");
  assert.equal(browser.attributes.type, "content");
  assert.equal(browser.attributes.disableglobalhistory, "true");
  assert.equal(browser.attributes.flex, "1");
  assert.equal(
    h.mounted.length,
    1,
    "页面装配走 sections.mountChatBrowser 同一路径",
  );
  assert.equal(h.mounted[0], browser);
});

test("mainTab: 已开时再 open → 只 select 聚焦，不再 add（M8 要求 3）", () => {
  const h = createHarness();
  assert.equal(h.host.open(), "opened");
  assert.equal(h.host.open(), "focused");
  assert.equal(h.host.open(), "focused");
  assert.equal(
    h.tabs.added.length,
    1,
    "不允许重复开（同 id 重复 add 会毁掉 deck）",
  );
  assert.deepEqual(h.tabs.selected, [TAB_ID, TAB_ID]);
});

test("mainTab: 关 tab → 注销 UI 实例 + 状态复位；再 open → 新开一条", () => {
  const h = createHarness();
  h.host.open();
  assert.equal(h.unregistered.length, 0);

  h.tabs.closeFromZotero(TAB_ID); // 用户点 X：Zotero_Tabs 回调 onClose
  assert.deepEqual(
    h.unregistered,
    [h.pageWindow],
    "关 tab 必须桥侧注销（§4.6 实例注销）",
  );
  assert.equal(h.host.isOpen(), false);

  assert.equal(h.host.open(), "opened");
  assert.equal(h.tabs.added.length, 2);
  assert.equal(h.mounted.length, 2, "新 tab 重新装配页面（重新握手）");
});

test("mainTab: 页面没 load 时关 tab（pageWindow 尚未拿到）→ 不调注销也不报错", () => {
  const h = createHarness();
  h.autoLoad.value = false;
  h.host.open();
  h.tabs.closeFromZotero(TAB_ID);
  assert.deepEqual(h.unregistered, []);
  assert.equal(h.host.isOpen(), false);
});

test("NEW-4：关 tab 后迟到的 onLoaded → 不写回状态，且立刻注销该窗口（桥不留死实例）", () => {
  const h = createHarness();
  h.autoLoad.value = false; // 页面还没 load，tab 就被关了（load 与 close 抢跑）
  h.host.open();
  const lateCb = h.loadCallbacks[0];
  h.tabs.closeFromZotero(TAB_ID);
  assert.equal(h.host.isOpen(), false);
  assert.deepEqual(h.unregistered, [], "关闭时还没拿到页面窗口，无可注销");

  const lateWindow = { name: "late-window" };
  assert.doesNotThrow(() => lateCb(lateWindow), "迟到回调不得抛");
  assert.deepEqual(
    h.unregistered,
    [lateWindow],
    "迟到窗口必须注销（撤掉刚起的握手：清 pending/注册表）",
  );
  assert.ok(h.logs.some((m) => m.includes("stale page load")));
  assert.equal(h.host.isOpen(), false, "迟到回调不得把已关状态改回「已开」");
});

test("NEW-4：迟到的旧世代回调不覆盖新一轮的 pageWindow", () => {
  const h = createHarness();
  h.autoLoad.value = false;
  h.host.open(); // 世代 1（页面未 load）
  const staleCb = h.loadCallbacks[0];
  h.tabs.closeFromZotero(TAB_ID); // 作废世代 1

  const liveWindow = { name: "page-window-B" };
  h.autoLoad.value = true;
  h.autoLoad.win = liveWindow;
  assert.equal(h.host.open(), "opened"); // 世代 2 正常 load

  staleCb({ name: "late-window" }); // 世代 1 的回调此刻才到
  assert.deepEqual(h.unregistered, [{ name: "late-window" }]);

  h.tabs.closeFromZotero(TAB_ID); // 关的是世代 2 的 tab
  assert.deepEqual(
    h.unregistered,
    [{ name: "late-window" }, liveWindow],
    "注销必须只针对当前世代，旧的迟到窗口不能顶替它",
  );
});

test("mainTab: add 抛错 → failed 且状态未开；恢复后重试可开", () => {
  const h = createHarness();
  h.tabs.fail.add = true;
  assert.equal(h.host.open(), "failed");
  assert.equal(h.host.isOpen(), false);
  assert.ok(h.logs.some((m) => m.includes("open failed")));

  h.tabs.fail.add = false;
  assert.equal(h.host.open(), "opened");
  assert.equal(h.tabs.added.length, 1);
});

test("mainTab: 装配中途失败 → 收掉半成品 tab（不留空 tab）+ failed", () => {
  const h = createHarness();
  // 只让 browser 建不出来（add 自己的容器创建要照常走通，才验证到「建完 tab 后失败」这一段）
  const original = h.doc.createXULElement.bind(h.doc);
  h.doc.createXULElement = (tag: string) => {
    if (tag === "browser") {
      throw new Error("no browser element");
    }
    return original(tag);
  };
  assert.equal(h.host.open(), "failed");
  assert.equal(h.tabs.added.length, 1, "tab 已 add 成功过——才需要收尾");
  assert.ok(h.logs.some((m) => m.includes("open failed")));
  assert.deepEqual(
    h.tabs.closed,
    [TAB_ID],
    "半成品 tab 必须关掉，否则下次点击走 select 卡死",
  );
  assert.equal(h.host.isOpen(), false);
});

test("mainTab: tab 异常消失（未经 onClose）→ focus 失败复位，下次 open 重建", () => {
  const h = createHarness();
  h.host.open();
  h.doc.getEl(TAB_ID)?.remove(); // 容器被外力摘掉，但状态还记着「已开」
  assert.equal(h.host.open(), "failed");
  assert.deepEqual(h.unregistered, [h.pageWindow], "复位时一并注销实例");
  assert.equal(h.host.isOpen(), false);
  assert.equal(h.host.open(), "opened");
  assert.equal(h.tabs.added.length, 2);
});

test("mainTab: close()（插件停用）→ 关 tab 并经 onClose 复位；未开时是 no-op", () => {
  const h = createHarness();
  h.host.close();
  assert.deepEqual(h.tabs.closed, [], "没开就别碰 Zotero_Tabs");

  h.host.open();
  h.host.close();
  assert.deepEqual(h.tabs.closed, [TAB_ID]);
  assert.deepEqual(h.unregistered, [h.pageWindow]);
  assert.equal(h.host.isOpen(), false);
});

test("mainTab: 宿主窗口卸载 → 仅当 tab 就在该窗口时复位", () => {
  const h = createHarness();
  h.host.open();
  const otherWindow = {};
  h.host.handleWindowUnload(otherWindow);
  assert.equal(h.host.isOpen(), true, "别的窗口卸载不该动本 tab 状态");
  h.host.handleWindowUnload(h.win);
  assert.equal(h.host.isOpen(), false);
  assert.deepEqual(h.unregistered, [h.pageWindow]);
});

// ---- 工具栏按钮注入（幂等 + 7/8/9 目标定位）----

test("toolbar: 注入到 tab 工具条，属性齐备；重复注入幂等", () => {
  const doc = createFakeDocument();
  const win: MainWindowLike = {
    document: doc,
    Zotero_Tabs: createFakeTabs(doc).tabs,
  };
  const logs: string[] = [];
  let clicked = 0;
  const options = {
    tooltip: "open claude",
    onCommand: () => clicked++,
    log: (m: string) => logs.push(m),
  };

  assert.equal(installToolbarButton(win, options), true);
  const toolbar = doc.getEl("zotero-tabs-toolbar") as FakeElement;
  assert.equal(toolbar.children.length, 1);
  const button = toolbar.children[0];
  assert.equal(button.id, TOOLBAR_BUTTON_ID);
  assert.equal(button.attributes.class, "zotero-tb-button");
  assert.equal(button.attributes.tooltiptext, "open claude");
  assert.match(
    button.attributes.style,
    /list-style-image: url\("chrome:\/\/claudian\/content\/icons\/claude\.svg"\)/,
  );

  assert.equal(
    installToolbarButton(win, options),
    false,
    "同窗口第二次注入必须幂等",
  );
  assert.equal(toolbar.children.length, 1);

  button.fire("command");
  assert.equal(clicked, 1, "点击走同一 open 入口");
});

test("toolbar: 目标标记改版时按候选链兜底；全落空只记日志不抛", () => {
  const fallback = createFakeDocument(["zotero-toolbar-item-tree"]);
  const win: MainWindowLike = {
    document: fallback,
    Zotero_Tabs: createFakeTabs(fallback).tabs,
  };
  assert.equal(
    installToolbarButton(win, {
      tooltip: "t",
      onCommand: () => {},
      log: () => {},
    }),
    true,
  );
  assert.equal(
    (fallback.getEl("zotero-toolbar-item-tree") as FakeElement).children.length,
    1,
  );

  const empty = createFakeDocument([]);
  const logs: string[] = [];
  assert.equal(
    installToolbarButton(
      { document: empty, Zotero_Tabs: createFakeTabs(empty).tabs },
      { tooltip: "t", onCommand: () => {}, log: (m) => logs.push(m) },
    ),
    false,
  );
  assert.ok(logs.some((m) => m.includes("toolbar not found")));
});

test("toolbar: 摘按钮后可重新注入（窗口重载语义）", () => {
  const doc = createFakeDocument();
  const win: MainWindowLike = {
    document: doc,
    Zotero_Tabs: createFakeTabs(doc).tabs,
  };
  const options = { tooltip: "t", onCommand: () => {}, log: () => {} };
  installToolbarButton(win, options);
  removeToolbarButton(win);
  assert.equal(doc.getEl(TOOLBAR_BUTTON_ID), null);
  assert.equal(installToolbarButton(win, options), true);
});
