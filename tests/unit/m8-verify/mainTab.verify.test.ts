// 复核轮（m8-verify）—— M8 独立标签页模块独立复核（只测不修）。
//
// 独立性声明：fake DOM / fake Zotero_Tabs / 用例与期望全部本轮自写，不复用 tests/unit/mainTab.test.ts
// 的任何 helper 或断言。覆盖面（任务书）：状态机直打（未开→新建 / 已开→聚焦 / onClose 注销+复位 /
// 装配中途失败收半成品 / 宿主卸载与插件停用各自复位 / select 边界）+ 入口注入幂等与候选链 +
// mountChatBrowser 抽取重构回归（section 与 tab 共用装配的守卫、fail-closed、load 回调）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMainTabHost,
  installToolbarButton,
  removeToolbarButton,
  openMainTab,
  registerMainTabEntry,
  unregisterMainTabEntry,
  TOOLBAR_BUTTON_ID,
  type ElementLike,
  type DocumentLike,
  type MainTabHostDeps,
  type MainWindowLike,
  type ZoteroTabsLike,
} from "../../../src/modules/mainTab.ts";
import {
  mountChatBrowser,
  type ChatBrowser,
} from "../../../src/modules/sections.ts";

// ---------------- 自写 fake DOM ----------------

interface FakeNode extends ElementLike {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly events: { type: string; capture: boolean; fn: () => void }[];
  readonly kids: FakeNode[];
  parent: FakeNode | null;
  currentURI?: { spec: string };
  fire(type: string): void;
}

/**
 * R8：宿主侧栏（context-pane / item-pane）的 fake —— activateChatPane 用到的最小面：
 * collapsed 展开、section 的 render、sidenav 按钮（data-pane 用 CSS.escape 后的真机形态）。
 * 不给 getBoundingClientRect：按「拿不到 rect 就不算已在顶部」的口径，每次都会派发点击。
 */
class FakePane {
  collapsed: boolean;
  renderCalls = 0;
  clickCalls = 0;
  /** 真机形态：section 元素也带 data-pane（R8 起按它匹配，不再按标签名单取） */
  private readonly section = {
    getAttribute: (name: string) =>
      name === "data-pane" ? FakePane.PANE_ID_ESCAPED : null,
    hidden: false,
    render: () => {
      this.renderCalls += 1;
      return undefined;
    },
  };
  private readonly button = {
    getAttribute: (name: string) =>
      name === "data-pane" ? FakePane.PANE_ID_ESCAPED : null,
    click: () => {
      this.clickCalls += 1;
    },
    dispatchEvent: (event: { init?: unknown }) => {
      // 有 MouseEvent 构造器的真实路径才会走到这（本文件的 fake doc 没有 defaultView）
      void event;
      this.clickCalls += 1;
      return true;
    },
  };
  /** 真机形态：Zotero 写进 data-pane 的是 CSS.escape 之后的值 */
  static readonly PANE_ID_ESCAPED =
    "zotero-claudian\\@wsxwj123\\.github\\.io-claudian-chat";

  constructor(collapsed = true) {
    this.collapsed = collapsed;
  }

  querySelectorAll(selector: string): unknown[] {
    if (selector === ".btn[data-pane]") return [this.button];
    if (selector === "item-pane-custom-section") return [this.section];
    return [];
  }

  querySelector(selector: string): unknown {
    return selector === "item-pane-custom-section" ? this.section : null;
  }
}

class FakeDoc implements DocumentLike {
  readonly byId = new Map<string, FakeNode>();
  /** R8：工具栏入口按标签类型去这里取宿主侧栏（context-pane / item-pane） */
  readonly panes = new Map<string, FakePane>();
  documentElement!: FakeNode;
  constructor(ids: string[] = []) {
    this.documentElement = this.createXULElement("window-root");
    for (const id of ids) this.createXULElement("div").setAttributeSelf(id);
  }
  /** R8：activateChatPane 的宿主查找入口（没有对应标签的 pane → null，走「找不到」日志分支） */
  querySelector(selector: string): FakePane | null {
    return this.panes.get(selector) ?? null;
  }
  /** 造一个带 id 的节点（不进 DOM 树，只进 id 表——模拟布局标记已存在） */
  private sealed = new Set<string>();
  getElementById(id: string): FakeNode | null {
    return this.byId.get(id) ?? null;
  }
  createXULElement(tag: string): FakeNode {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const doc = this;
    const node: FakeNode = {
      tag,
      attrs: {},
      events: [],
      kids: [],
      parent: null,
      // 元素 style（fake 只需可赋值；页面装配路径会写属性）
      style: {} as Record<string, string>,
      get id() {
        return node.attrs.id ?? "";
      },
      set id(v: string) {
        node.attrs.id = v;
        doc.byId.set(v, node);
      },
      setAttributeSelf(v: string) {
        node.attrs.id = v;
        doc.byId.set(v, node);
      },
      setAttribute(name: string, value: string) {
        node.attrs[name] = value;
        if (name === "id") doc.byId.set(value, node);
      },
      // 供真实 mountChatBrowser（接线路径）使用的最小浏览器面
      getAttribute(name: string) {
        return node.attrs[name] ?? null;
      },
      loadURI(uri: { spec?: string } | string) {
        node.currentURI = {
          spec: String((uri as { spec?: string })?.spec ?? uri),
        };
      },
      currentURI: { spec: "about:blank" },
      addEventListener(type: string, fn: () => void, opts?: unknown) {
        node.events.push({
          type,
          capture: !!(opts && (opts as { capture?: boolean }).capture),
          fn,
        });
      },
      appendChild(child: FakeNode) {
        node.kids.push(child);
        child.parent = node;
        if (child.attrs.id) doc.byId.set(child.attrs.id, child);
      },
      remove() {
        if (node.parent) {
          node.parent.kids.splice(node.parent.kids.indexOf(node), 1);
        }
        node.parent = null;
        if (node.attrs.id) doc.byId.delete(node.attrs.id);
      },
      fire(type: string) {
        for (const e of node.events) if (e.type === type) e.fn();
      },
    } as unknown as FakeNode;
    return node;
  }
}

/** Zotero_Tabs 最小面：openTabs 是真实注册表（select 未知 id 抛错，close 触发 onClose） */
class FakeTabs implements ZoteroTabsLike {
  readonly openTabs = new Map<
    string,
    { container: FakeNode; onClose: () => void; data: unknown }
  >();
  readonly addCalls: Record<string, unknown>[] = [];
  readonly selectCalls: string[] = [];
  readonly closeCalls: string[] = [];
  failAdd = false;
  failSelect = false;
  failClose = false;
  /** R8：当前选中的标签类型（真实 Zotero_Tabs 属性；测试里按用例改） */
  selectedType = "library";

  constructor(private doc: FakeDoc) {}

  add(options: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    title: string;
    select: boolean;
    preventJumpback: boolean;
    onClose: () => void;
  }): { id: string; container: ElementLike } {
    if (this.failAdd) throw new Error("tabs.add exploded");
    this.addCalls.push(options as unknown as Record<string, unknown>);
    // 真实实现（omni/tabs.js）：容器由 add 建好并把 tab id 挂成容器 id
    const container = this.doc.createXULElement("tab-content");
    container.setAttribute("id", options.id);
    this.openTabs.set(options.id, {
      container,
      onClose: options.onClose,
      data: options.data,
    });
    return { id: options.id, container };
  }
  select(id: string): void {
    if (this.failSelect) throw new Error("tabs.select exploded");
    if (!this.openTabs.has(id)) throw new Error("no such tab: " + id);
    this.selectCalls.push(id);
  }
  close(id: string): void {
    if (this.failClose) throw new Error("tabs.close exploded");
    this.closeCalls.push(id);
    this.closeFromZotero(id);
  }
  /** 用户点 X：Zotero 内部回调 onClose（不走 close()） */
  closeFromZotero(id: string): void {
    const entry = this.openTabs.get(id);
    if (!entry) return;
    this.openTabs.delete(id);
    entry.container.remove();
    entry.onClose();
  }
}

interface HostRig {
  doc: FakeDoc;
  tabs: FakeTabs;
  win: MainWindowLike;
  host: ReturnType<typeof createMainTabHost>;
  mountedBrowsers: FakeNode[];
  /** 每次 mountPage 收到的 onLoaded 回调（可手动迟到触发） */
  loadCallbacks: ((w: object) => void)[];
  unregistered: object[];
  logs: string[];
  /** mountPage 是否自动回调 onLoaded（模拟页面 load 完成） */
  autoLoad: { on: boolean; win: object };
}

function makeHost(overrides: Partial<MainTabHostDeps> = {}): HostRig {
  const doc = new FakeDoc(["zotero-tabs-toolbar"]);
  const tabs = new FakeTabs(doc);
  const win: MainWindowLike = { document: doc, Zotero_Tabs: tabs };
  const mountedBrowsers: FakeNode[] = [];
  const loadCallbacks: ((w: object) => void)[] = [];
  const unregistered: object[] = [];
  const logs: string[] = [];
  const autoLoad = { on: true, win: { name: "page-window-A" } };
  const deps: MainTabHostDeps = {
    getMainWindow: () => win,
    mountPage: (browser, onLoaded) => {
      mountedBrowsers.push(browser as FakeNode);
      loadCallbacks.push(onLoaded);
      if (autoLoad.on) onLoaded(autoLoad.win);
    },
    unregisterPage: (w) => unregistered.push(w),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return {
    doc,
    tabs,
    win,
    host: createMainTabHost(deps),
    mountedBrowsers,
    loadCallbacks,
    unregistered,
    logs,
    autoLoad,
  };
}

const TAB_ID = "claudian-main-tab";
const BROWSER_ID = "claudian-main-tab-browser";

// ---------------- 1. 状态机：未开→新建 / 已开→聚焦 ----------------

test("状态机·未开→新建：add 参数齐全（data 非空对象、type 无短横线）、塞 browser、装配页面", () => {
  const r = makeHost();
  assert.equal(r.host.open(), "opened");
  assert.equal(r.host.isOpen(), true);
  assert.equal(r.tabs.addCalls.length, 1);
  const o = r.tabs.addCalls[0];
  assert.equal(o.id, TAB_ID);
  assert.equal(o.title, "Claude");
  assert.equal(o.select, true);
  assert.equal(typeof o.onClose, "function");
  assert.ok(
    o.data !== undefined && o.data !== null && typeof o.data === "object",
    "SPIKE 假设 6：data 必传且为对象",
  );
  assert.ok(
    !String(o.type).includes("-"),
    `type 不得含短横线（Zotero 按 '-' 拆 type/state）：${String(o.type)}`,
  );

  assert.equal(r.mountedBrowsers.length, 1);
  const browser = r.mountedBrowsers[0];
  assert.equal(browser.tag, "browser");
  assert.equal(browser.attrs.id, BROWSER_ID);
  assert.equal(browser.attrs.type, "content");
  assert.equal(browser.attrs.disableglobalhistory, "true");
  assert.equal(browser.parent, r.tabs.openTabs.get(TAB_ID)?.container);
});

test("状态机·已开→聚焦：只 select 不重复 add（连续两次点击）", () => {
  const r = makeHost();
  assert.equal(r.host.open(), "opened");
  assert.equal(r.host.open(), "focused");
  assert.equal(r.host.open(), "focused");
  assert.equal(r.tabs.addCalls.length, 1);
  assert.deepEqual(r.tabs.selectCalls, [TAB_ID, TAB_ID]);
  assert.equal(r.mountedBrowsers.length, 1, "聚焦不得重新装配页面");
});

test("状态机·onClose（用户点 X）→ 注销页面实例 + 复位；重复回调幂等", () => {
  const r = makeHost();
  r.host.open();
  assert.deepEqual(r.unregistered, []);

  r.tabs.closeFromZotero(TAB_ID);
  assert.deepEqual(r.unregistered, [r.autoLoad.win], "关 tab 必须注销桥实例");
  assert.equal(r.host.isOpen(), false);

  // 第二次回调（异常重复）不得再注销、不得抛
  r.tabs.closeFromZotero(TAB_ID);
  assert.equal(r.unregistered.length, 1);

  assert.equal(r.host.open(), "opened");
  assert.equal(r.tabs.addCalls.length, 2, "复位后可重建");
});

test("状态机·页面尚未 load 就关 tab：不注销（没有页面实例）也不报错", () => {
  const r = makeHost();
  r.autoLoad.on = false;
  r.host.open();
  r.tabs.closeFromZotero(TAB_ID);
  assert.deepEqual(r.unregistered, []);
  assert.equal(r.host.isOpen(), false);
});

// ---------------- 2. 装配中途失败：收半成品 ----------------

test("装配失败·createXULElement 抛错 → failed + 收掉半成品 tab + 可重试", () => {
  const r = makeHost();
  const orig = r.doc.createXULElement.bind(r.doc);
  r.doc.createXULElement = (tag: string) => {
    if (tag === "browser") throw new Error("no browser element");
    return orig(tag);
  };
  assert.equal(r.host.open(), "failed");
  assert.deepEqual(
    r.tabs.closeCalls,
    [TAB_ID],
    "半成品 tab 必须关掉（空 tab 会让下次点击卡死）",
  );
  assert.equal(r.host.isOpen(), false);
  assert.ok(r.logs.some((m) => m.includes("open failed")));

  r.doc.createXULElement = orig;
  assert.equal(r.host.open(), "opened", "环境恢复后可重试");
  assert.equal(r.tabs.addCalls.length, 2);
});

test("装配失败·容器 appendChild 抛错 → failed + 收掉半成品 tab + 可重试", () => {
  const r = makeHost();
  const realAdd = r.tabs.add.bind(r.tabs);
  r.tabs.add = ((options: Parameters<ZoteroTabsLike["add"]>[0]) => {
    const res = realAdd(options);
    (res.container as unknown as { appendChild: unknown }).appendChild = () => {
      throw new Error("appendChild exploded");
    };
    return res;
  }) as ZoteroTabsLike["add"];
  assert.equal(r.host.open(), "failed");
  assert.deepEqual(r.tabs.closeCalls, [TAB_ID]);
  assert.equal(r.host.isOpen(), false);
  assert.ok(r.logs.some((m) => m.includes("open failed")));

  r.tabs.add = realAdd;
  assert.equal(r.host.open(), "opened");
  assert.equal(r.tabs.addCalls.length, 2);
});

test("装配失败·mountPage 抛错 → failed + 收掉半成品 tab + 可重试", () => {
  const doc = new FakeDoc(["zotero-tabs-toolbar"]);
  const tabs = new FakeTabs(doc);
  const logs: string[] = [];
  let failMount = true;
  const host = createMainTabHost({
    getMainWindow: () => ({ document: doc, Zotero_Tabs: tabs }),
    mountPage: (browser, onLoaded) => {
      if (failMount) throw new Error("mountPage exploded");
      onLoaded({ name: "w" });
    },
    unregisterPage: () => {},
    log: (m) => logs.push(m),
  });
  assert.equal(host.open(), "failed");
  assert.deepEqual(tabs.closeCalls, [TAB_ID]);
  assert.equal(host.isOpen(), false);
  assert.ok(logs.some((m) => m.includes("open failed")));

  failMount = false;
  assert.equal(host.open(), "opened");
  assert.equal(tabs.addCalls.length, 2);
});

test("装配失败·add 自身抛错 → failed 且不产生 close 调用（无可收）", () => {
  const r = makeHost();
  r.tabs.failAdd = true;
  assert.equal(r.host.open(), "failed");
  assert.deepEqual(r.tabs.closeCalls, []);
  assert.equal(r.host.isOpen(), false);
  r.tabs.failAdd = false;
  assert.equal(r.host.open(), "opened");
  assert.equal(r.tabs.addCalls.length, 1);
});

test("装配失败·主窗口不可用 → failed + 记日志；close() 同步不炸", () => {
  const r = makeHost({ getMainWindow: () => null });
  assert.equal(r.host.open(), "failed");
  assert.ok(r.logs.some((m) => m.includes("open failed")));
  assert.equal(r.host.isOpen(), false);
  assert.doesNotThrow(() => r.host.close());
  assert.deepEqual(r.tabs.closeCalls, []);
});

// ---------------- 3. 复位路径：宿主卸载 / 插件停用 ----------------

test("复位·宿主窗口卸载：仅当 tab 在该窗口时复位；重复卸载/异窗卸载无副作用", () => {
  const r = makeHost();
  r.host.open();
  r.host.handleWindowUnload({ 别的窗口: true });
  assert.equal(r.host.isOpen(), true);
  assert.deepEqual(r.unregistered, []);

  r.host.handleWindowUnload(r.win);
  assert.equal(r.host.isOpen(), false);
  assert.deepEqual(r.unregistered, [r.autoLoad.win]);
  assert.doesNotThrow(() => r.host.handleWindowUnload(r.win));
  assert.equal(r.unregistered.length, 1);
});

test("复位·插件停用 close()：开→关 tab 并经 onClose 注销；未开→no-op", () => {
  const r = makeHost();
  r.host.close();
  assert.deepEqual(r.tabs.closeCalls, [], "未开时不得碰 Zotero_Tabs");

  r.host.open();
  r.host.close();
  assert.deepEqual(r.tabs.closeCalls, [TAB_ID]);
  assert.deepEqual(r.unregistered, [r.autoLoad.win]);
  assert.equal(r.host.isOpen(), false);
});

test("复位·close() 时 Zotero_Tabs.close 抛错 → 兜底复位（不永真）", () => {
  const r = makeHost();
  r.host.open();
  r.tabs.failClose = true;
  assert.doesNotThrow(() => r.host.close());
  assert.equal(r.host.isOpen(), false);
  assert.ok(r.logs.some((m) => m.includes("close failed")));
  assert.deepEqual(r.unregistered, [r.autoLoad.win]);
  r.tabs.failClose = false;
  assert.equal(r.host.open(), "opened", "兜底复位后下次点击重建");
});

// ---------------- 4. select 边界 ----------------

test("边界·tab 容器被外力摘掉（未经 onClose）→ 聚焦前先复位再重建", () => {
  const r = makeHost();
  r.host.open();
  r.tabs.openTabs.get(TAB_ID)?.container.remove(); // DOM 里没了，但状态还记着已开
  assert.equal(r.host.open(), "failed");
  assert.equal(
    r.host.isOpen(),
    false,
    "必须先复位，避免反复 select 不存在的 id",
  );
  assert.deepEqual(r.unregistered, [r.autoLoad.win]);
  assert.equal(r.host.open(), "opened");
  assert.equal(r.tabs.addCalls.length, 2);
});

test("边界·select 抛错（容器还在）→ failed + 记日志；不复位（宁下次重点）", () => {
  const r = makeHost();
  r.host.open();
  r.tabs.failSelect = true;
  assert.equal(r.host.open(), "failed");
  assert.ok(r.logs.some((m) => m.includes("focus failed")));
  assert.equal(
    r.host.isOpen(),
    true,
    "设计取舍：不把已开误判为已关（重复 add 同 id 会毁 deck）",
  );
  r.tabs.failSelect = false;
  assert.equal(r.host.open(), "focused");
  assert.equal(r.tabs.addCalls.length, 1);
});

// 边界现状（复核实测）：关 tab 后迟到的页面 load 回调会把 pageWindow 写回宿主（宿主不校验状态）；
// 此后复位路径只注销「最近写入」的页面实例，迟到那个再没有注销入口（桥注册表残留一个窗口）。
// 真机可达性=窄竞态（页面 load 与关 tab 抢跑）；先钉现状，见复核报告 OBS-2。
test("关 tab 后迟到的 onLoaded 被忽略并立刻注销（NEW-4 修复后行为）", () => {
  const r = makeHost();
  r.autoLoad.on = false;
  r.host.open();
  const lateCb = r.loadCallbacks[0];
  r.tabs.closeFromZotero(TAB_ID); // 页面还没 load 就关了
  assert.equal(r.host.isOpen(), false);
  assert.deepEqual(r.unregistered, []);

  const lateWindow = { name: "late-window" };
  assert.doesNotThrow(() => lateCb(lateWindow), "迟到回调不得抛");
  // 迟到回调：不写回 pageWindow + 立刻注销（撤掉刚起的握手）
  assert.deepEqual(
    r.unregistered,
    [{ name: "late-window" }],
    "迟到窗口须被注销",
  );

  // 下一轮正常开/关：只注销新页面实例，lateWindow 不覆盖当前世代
  r.autoLoad.on = true;
  r.autoLoad.win = { name: "page-window-B" };
  assert.equal(r.host.open(), "opened");
  r.tabs.closeFromZotero(TAB_ID);
  assert.deepEqual(r.unregistered, [
    { name: "late-window" },
    { name: "page-window-B" },
  ]);
});

// ---------------- 5. 工具栏按钮注入 ----------------

function buttonDoc(ids: string[]): FakeDoc {
  return new FakeDoc(ids);
}

/** R8：能承载右侧栏面板的 fake 主窗口（工具栏按钮所在窗口；Zotero_Tabs 提供 selectedType） */
function paneWin(
  doc: FakeDoc,
  tabs: FakeTabs,
  selectedType = "reader",
): MainWindowLike {
  tabs.selectedType = selectedType;
  return { document: doc, Zotero_Tabs: tabs } as unknown as MainWindowLike;
}

test("入口·幂等：同窗口重复注入只插一个按钮，二次返回 false", () => {
  const doc = buttonDoc(["zotero-tabs-toolbar"]);
  const win: MainWindowLike = { document: doc, Zotero_Tabs: new FakeTabs(doc) };
  const logs: string[] = [];
  let clicks = 0;
  const opts = {
    tooltip: "打开 Claude",
    onCommand: () => clicks++,
    log: (m: string) => logs.push(m),
  };
  assert.equal(installToolbarButton(win, opts), true);
  assert.equal(installToolbarButton(win, opts), false);
  const toolbar = doc.getElementById("zotero-tabs-toolbar")!;
  assert.equal(toolbar.kids.length, 1);
  const btn = toolbar.kids[0];
  assert.equal(btn.id, TOOLBAR_BUTTON_ID);
  assert.equal(btn.attrs.tooltiptext, "打开 Claude");
  assert.equal(btn.attrs.tabindex, "-1");
  assert.match(btn.attrs.class, /zotero-tb-button/);
  assert.match(
    btn.attrs.style ?? "",
    /list-style-image: url\("chrome:\/\/[^"]+\/content\/icons\/claude\.svg"\)/,
    "图标必须是自带 SVG（不外链）",
  );
  // command 监听：点一次只算一次
  assert.equal(btn.events.filter((e) => e.type === "command").length, 1);
  btn.fire("command");
  assert.equal(clicks, 1);
});

test("入口·候选链：多容器都在时优先 tab 工具条；只有兜底标记时用兜底", () => {
  const doc = buttonDoc([
    "zotero-toolbar",
    "zotero-tabs-toolbar",
    "zotero-toolbar-item-tree",
  ]);
  const win: MainWindowLike = { document: doc, Zotero_Tabs: new FakeTabs(doc) };
  assert.equal(
    installToolbarButton(win, {
      tooltip: "t",
      onCommand: () => {},
      log: () => {},
    }),
    true,
  );
  assert.equal(doc.getElementById("zotero-tabs-toolbar")!.kids.length, 1);
  assert.equal(doc.getElementById("zotero-toolbar")!.kids.length, 0);
  assert.equal(doc.getElementById("zotero-toolbar-item-tree")!.kids.length, 0);

  const fb = buttonDoc(["zotero-toolbar-item-tree"]);
  assert.equal(
    installToolbarButton(
      { document: fb, Zotero_Tabs: new FakeTabs(fb) },
      { tooltip: "t", onCommand: () => {}, log: () => {} },
    ),
    true,
  );
  assert.equal(fb.getElementById("zotero-toolbar-item-tree")!.kids.length, 1);
});

test("入口·全落空：不抛、只记日志（列出试过的 id）；再注入不重复", () => {
  const doc = buttonDoc([]);
  const logs: string[] = [];
  const win: MainWindowLike = { document: doc, Zotero_Tabs: new FakeTabs(doc) };
  assert.equal(
    installToolbarButton(win, {
      tooltip: "t",
      onCommand: () => {},
      log: (m: string) => logs.push(m),
    }),
    false,
  );
  assert.equal(logs.length, 1);
  for (const id of [
    "zotero-tabs-toolbar",
    "zotero-toolbar",
    "zotero-toolbar-item-tree",
  ]) {
    assert.ok(logs[0].includes(id), `日志应列出候选 ${id}`);
  }
  assert.equal(doc.getElementById(TOOLBAR_BUTTON_ID), null);
});

test("入口·同 id 元素已存在（非本插件遗留）→ 视为已注入不再插", () => {
  const doc = buttonDoc(["zotero-tabs-toolbar"]);
  const stray = doc.createXULElement("toolbarbutton");
  stray.id = TOOLBAR_BUTTON_ID;
  const win: MainWindowLike = { document: doc, Zotero_Tabs: new FakeTabs(doc) };
  assert.equal(
    installToolbarButton(win, {
      tooltip: "t",
      onCommand: () => {},
      log: () => {},
    }),
    false,
  );
  assert.equal(doc.getElementById("zotero-tabs-toolbar")!.kids.length, 0);
});

test("入口·摘除：无按钮时 no-op；摘后可在同窗口重注入（窗口重建语义）", () => {
  const doc = buttonDoc(["zotero-tabs-toolbar"]);
  const win: MainWindowLike = { document: doc, Zotero_Tabs: new FakeTabs(doc) };
  assert.doesNotThrow(() => removeToolbarButton(win));
  const opts = { tooltip: "t", onCommand: () => {}, log: () => {} };
  installToolbarButton(win, opts);
  removeToolbarButton(win);
  assert.equal(doc.getElementById(TOOLBAR_BUTTON_ID), null);
  assert.doesNotThrow(() => removeToolbarButton(win));
  assert.equal(installToolbarButton(win, opts), true);
});

// ---------------- 6. mountChatBrowser 抽取重构回归 ----------------

interface FakeBrowser {
  attrs: Record<string, string>;
  events: { type: string; capture: boolean; fn: () => void }[];
  loadURICalls: { spec: string }[];
  currentURI: { spec: string };
  contentWindow: object;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void, capture?: boolean): void;
  loadURI(uri: unknown, flags: unknown): void;
}

function makeBrowser(): FakeBrowser {
  const b: FakeBrowser = {
    attrs: {},
    events: [],
    loadURICalls: [],
    currentURI: { spec: "chrome://claudian/content/chat/index.html" },
    contentWindow: { name: "chat-window" },
    getAttribute: (n) => b.attrs[n] ?? null,
    setAttribute: (n, v) => {
      b.attrs[n] = v;
    },
    addEventListener: (type, fn, capture) => {
      b.events.push({ type, capture: !!capture, fn });
    },
    loadURI: (uri: any) => {
      b.loadURICalls.push({ spec: String(uri?.spec ?? uri) });
      b.currentURI = { spec: String(uri?.spec ?? uri) };
    },
  };
  return b;
}

function withGlobals(
  stubs: { Zotero?: unknown; Services?: unknown; crypto?: unknown },
  fn: () => void,
): void {
  const names = ["Zotero", "Services", "crypto"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const n of names)
    saved.set(n, Object.getOwnPropertyDescriptor(globalThis, n));
  // crypto 在 node 里是 getter-only 全局：必须用 defineProperty 覆写，普通赋值会 TypeError
  const define = (n: string, v: unknown) =>
    Object.defineProperty(globalThis, n, {
      value: v,
      configurable: true,
      writable: true,
    });
  try {
    for (const n of names) if (n in stubs) define(n, stubs[n]);
    fn();
  } finally {
    for (const n of names) {
      const d = saved.get(n);
      if (d) Object.defineProperty(globalThis, n, d);
      else delete (globalThis as Record<string, unknown>)[n];
    }
  }
}

const zStub = (debugs: string[], errors: unknown[]) => ({
  debug: (m: string) => debugs.push(m),
  logError: (e: unknown) => errors.push(e),
  getMainWindow: () => {
    throw new Error("no main window in node harness");
  },
});

test("mountChatBrowser·首载：写 token、注册 capture load 监听、loadURI 一次、置 loaded 标志", () => {
  const debugs: string[] = [];
  const errors: unknown[] = [];
  withGlobals(
    {
      Zotero: zStub(debugs, errors),
      Services: {
        io: { newURI: (s: string) => ({ spec: s }) },
        scriptSecurityManager: { getSystemPrincipal: () => ({}) },
      },
    },
    () => {
      const b = makeBrowser();
      mountChatBrowser(b as unknown as ChatBrowser);
      assert.equal(b.loadURICalls.length, 1);
      assert.match(
        b.loadURICalls[0].spec,
        /^chrome:\/\/.+\?token=[0-9a-f]{32}$/,
      );
      assert.equal(b.attrs["data-claudian-loaded"], "true");
      assert.equal(
        b.attrs["data-claudian-token"],
        b.loadURICalls[0].spec.split("token=")[1],
      );
      const load = b.events.filter((e) => e.type === "load");
      assert.equal(load.length, 1);
      assert.equal(load[0].capture, true, "BUG-15：load 不冒泡，必须 capture");
    },
  );
});

test("mountChatBrowser·幂等：已装配的 browser 再调不重载、token 不变", () => {
  const debugs: string[] = [];
  const errors: unknown[] = [];
  withGlobals(
    {
      Zotero: zStub(debugs, errors),
      Services: {
        io: { newURI: (s: string) => ({ spec: s }) },
        scriptSecurityManager: { getSystemPrincipal: () => ({}) },
      },
    },
    () => {
      const b = makeBrowser();
      mountChatBrowser(b as unknown as ChatBrowser);
      const token = b.attrs["data-claudian-token"];
      mountChatBrowser(b as unknown as ChatBrowser);
      assert.equal(b.loadURICalls.length, 1);
      assert.equal(b.attrs["data-claudian-token"], token);
      assert.equal(b.events.filter((e) => e.type === "load").length, 1);
    },
  );
});

test("mountChatBrowser·fail-closed：无 CSPRNG → 不加载、不置 loaded（可重试）+ 记 error", () => {
  const debugs: string[] = [];
  const errors: unknown[] = [];
  withGlobals(
    {
      Zotero: zStub(debugs, errors),
      Services: {
        io: { newURI: (s: string) => ({ spec: s }) },
        scriptSecurityManager: { getSystemPrincipal: () => ({}) },
      },
      crypto: undefined,
    },
    () => {
      const b = makeBrowser();
      mountChatBrowser(b as unknown as ChatBrowser);
      assert.equal(b.loadURICalls.length, 0, "弱随机不放行：宁可不加载");
      assert.equal(
        b.attrs["data-claudian-loaded"],
        undefined,
        "不置标志 → 下次可重试",
      );
      assert.equal(errors.length, 1);
      assert.ok(
        debugs.some((m) => m.includes("fail-closed")),
        "应记录 fail-closed 原因",
      );
    },
  );
});

test("mountChatBrowser·load 回调：onLoaded 拿到 contentWindow；宿主桥不可用也不外泄异常", () => {
  const debugs: string[] = [];
  const errors: unknown[] = [];
  withGlobals(
    {
      Zotero: zStub(debugs, errors),
      Services: {
        io: { newURI: (s: string) => ({ spec: s }) },
        scriptSecurityManager: { getSystemPrincipal: () => ({}) },
      },
    },
    () => {
      const b = makeBrowser();
      const got: object[] = [];
      mountChatBrowser(b as unknown as ChatBrowser, (win) => got.push(win));
      assert.equal(got.length, 0, "仅在 load 事件里回调");
      const load = b.events.find((e) => e.type === "load")!;
      assert.doesNotThrow(
        () => load.fn(),
        "load 监听器内异常必须自吞（真机会静默丢日志）",
      );
      assert.deepEqual(
        got,
        [b.contentWindow],
        "M8 新增的 onLoaded 钩子要拿到页面窗口",
      );
      assert.ok(debugs.some((m) => m.includes("chat page loaded")));
      assert.ok(errors.length >= 1, "桥不可用的原因应进 logError");
    },
  );
});

// ---------------- 7. 真实接线（全局 stub）：入口注册/拆除 = 插件停用路径 ----------------

test("接线·register 注入按钮 → 点击打开右侧栏 Claude 面板（R8）→ unregister 关 tab + 摘按钮（插件停用）", () => {
  const doc = buttonDoc(["zotero-tabs-toolbar"]);
  const tabs = new FakeTabs(doc);
  const win = paneWin(doc, tabs, "reader");
  const contextPane = new FakePane(true);
  const itemPane = new FakePane(false);
  doc.panes.set("context-pane", contextPane);
  doc.panes.set("item-pane", itemPane);
  const g = globalThis as Record<string, unknown>;
  const savedAddon = g.addon;
  const savedZotero = g.Zotero;
  const savedServices = g.Services;
  g.addon = { data: {} };
  g.Zotero = {
    debug: () => {},
    logError: () => {},
    getMainWindow: () => win,
    getMainWindows: () => [win],
  };
  g.Services = {
    io: { newURI: (s: string) => ({ spec: s }) },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  };
  try {
    unregisterMainTabEntry(); // 前置清理（幂等）：确保宿主单例处于关闭态
    registerMainTabEntry();
    const btn = doc.getElementById(TOOLBAR_BUTTON_ID);
    assert.ok(btn, "启动时应向既有主窗口注入按钮");
    assert.equal(typeof btn.attrs.tooltiptext, "string");
    assert.ok(
      btn.attrs.tooltiptext.length > 0,
      "tooltip 文案要走 l10n（降级也得非空）",
    );

    // R8 入口：工具栏按钮 = 展开右侧栏 + 定位到 Claude 面板（不再建 tab、不再开关浮层）
    btn.fire("command");
    assert.equal(
      tabs.addCalls.length,
      0,
      "点击按钮不建 tab（全页入口搬到面板顶栏）",
    );
    assert.equal(
      contextPane.collapsed,
      false,
      "reader 标签：折叠的 context-pane 要先展开",
    );
    assert.equal(
      contextPane.renderCalls,
      1,
      "section 要补一次 render（懒渲染不等展开）",
    );
    assert.equal(
      contextPane.clickCalls,
      1,
      "要点本插件那条 sidenav 按钮把面板滚到顶",
    );
    assert.equal(itemPane.clickCalls, 0, "书库侧那份同名 section 不许被点到");
    // 再点一次：已展开且面板已就位——幂等，不再重复点
    btn.fire("command");
    assert.equal(
      contextPane.clickCalls,
      2,
      "第二次点击仍要保证面板在顶部（本 fake 无 rect 判据）",
    );

    // 全页工作台仍可达（面板顶栏「全页」→ 桥 openFullPage → 同一入口）
    assert.equal(openMainTab(), "opened", "首次 openMainTab → 新建 tab");
    assert.equal(openMainTab(), "focused", "再点一次 → 聚焦");

    unregisterMainTabEntry(); // 插件停用路径（无参）
    assert.deepEqual(
      tabs.closeCalls,
      [TAB_ID],
      "停用必须关掉 tab（onClose 里还要注销桥实例）",
    );
    assert.equal(
      doc.getElementById(TOOLBAR_BUTTON_ID),
      null,
      "停用必须摘掉按钮",
    );
  } finally {
    unregisterMainTabEntry();
    g.addon = savedAddon;
    g.Zotero = savedZotero;
    g.Services = savedServices;
  }
});

test("接线·窗口卸载路径（带参）：摘该窗口按钮 + 只在该窗口承载 tab 时复位", () => {
  const doc = buttonDoc(["zotero-tabs-toolbar"]);
  const tabs = new FakeTabs(doc);
  const win = paneWin(doc, tabs, "reader");
  const contextPane = new FakePane(true);
  const itemPane = new FakePane(true);
  doc.panes.set("context-pane", contextPane);
  doc.panes.set("item-pane", itemPane);
  const other = buttonDoc(["zotero-tabs-toolbar"]);
  const otherWin = paneWin(other, new FakeTabs(other));
  const g = globalThis as Record<string, unknown>;
  const savedAddon = g.addon;
  const savedZotero = g.Zotero;
  const savedServices = g.Services;
  g.addon = { data: {} };
  g.Zotero = {
    debug: () => {},
    logError: () => {},
    getMainWindow: () => win,
    getMainWindows: () => [win, otherWin],
  };
  g.Services = {
    io: { newURI: (s: string) => ({ spec: s }) },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  };
  try {
    unregisterMainTabEntry();
    registerMainTabEntry();
    registerMainTabEntry(otherWin);
    assert.ok(doc.getElementById(TOOLBAR_BUTTON_ID));
    assert.ok(other.getElementById(TOOLBAR_BUTTON_ID));

    // 另开一个窗口的卸载：不动当前窗口的按钮与状态
    unregisterMainTabEntry(otherWin);
    assert.equal(other.getElementById(TOOLBAR_BUTTON_ID), null);
    assert.ok(doc.getElementById(TOOLBAR_BUTTON_ID));

    // R8：按钮开右侧栏面板，不建 tab；书库标签下改去 item-pane 找人
    doc.getElementById(TOOLBAR_BUTTON_ID)!.fire("command");
    assert.equal(tabs.addCalls.length, 0, "按钮不建 tab（只开面板）");
    assert.equal(
      contextPane.clickCalls,
      1,
      "reader 标签 → context-pane 那条按钮",
    );
    assert.equal(itemPane.clickCalls, 0, "不该误点书库那份");
    tabs.selectedType = "library";
    doc.getElementById(TOOLBAR_BUTTON_ID)!.fire("command");
    assert.equal(itemPane.clickCalls, 1, "书库标签 → item-pane 那条按钮");
    assert.equal(contextPane.clickCalls, 1, "reader 那份不动");
    // 别的窗口卸载不该复位 tab（此刻 tab 尚未开：先经全页入口建出来）
    unregisterMainTabEntry(otherWin);
    assert.equal(openMainTab(), "opened", "全页入口首次打开");
    unregisterMainTabEntry(otherWin);
    assert.equal(openMainTab(), "focused", "tab 仍开：只是聚焦");
    // 承载 tab 的窗口卸载 → 复位（下次点击重建）
    unregisterMainTabEntry(win);
    assert.equal(doc.getElementById(TOOLBAR_BUTTON_ID), null);
    assert.equal(openMainTab(), "opened", "窗口卸载后应能重建");
    assert.equal(tabs.addCalls.length, 2);
  } finally {
    unregisterMainTabEntry();
    g.addon = savedAddon;
    g.Zotero = savedZotero;
    g.Services = savedServices;
  }
});
