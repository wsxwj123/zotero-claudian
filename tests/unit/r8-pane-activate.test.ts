// 单测 — R8：工具栏「Claude」按钮 = 展开右侧栏 + 定位到 Claude 面板（浮层方案已撤）。
// 被测：src/modules/paneAutoShow.ts 的 activateChatPane（复用自动显示那三步）。
// 全程 fake DOM（无 Zotero 全局），断言五件事：
//  ① 按当前标签类型选宿主：reader → context-pane，书库 → item-pane；
//  ② 宿主侧栏折叠时先展开；③ 顺序 = 展开 → render → 点击；
//  ④ 找不到按钮/宿主 → 记日志不抛；⑤ 幂等：已在顶部时不再派发点击。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateChatPane,
  hostSelectorForTabType,
  PANE_AT_TOP_TOLERANCE,
  type PaneDocumentLike,
  type PaneHostLike,
  type PaneSectionLike,
} from "../../src/modules/paneAutoShow.ts";

const PANE_ID = "zotero-claudian@wsxwj123.github.io-claudian-chat";
/** 真机实况：Zotero 写进 data-pane 的是 CSS.escape 之后的值（按钮与 section 都是） */
const ESCAPED_PANE_ID =
  "zotero-claudian\\@wsxwj123\\.github\\.io-claudian-chat";
const OTHER_PANE_ID = "zotero-x-abstract";

class FakeMouseEvent {
  constructor(
    public type: string,
    public init?: { detail?: number; bubbles?: boolean; button?: number },
  ) {}
}

interface ClickRecord {
  pane: string;
  detail?: number;
  bubbles?: boolean;
}

/** 一个宿主侧栏的 fake：按钮 / section / 折叠态 / 几何全可注入 */
interface FakePaneOptions {
  collapsed?: boolean;
  /** 按钮的 data-pane 值（默认真机转义形态） */
  buttonPane?: string | null;
  sectionPane?: string | null;
  /** section 的 rect（不给 = 拿不到几何，按「不在顶部」处理） */
  sectionTop?: number;
  sectionHeight?: number;
  /** section 所在滚动容器的顶（不给 → 回落宿主顶） */
  containerTop?: number;
  paneTop?: number;
}

interface FakePane {
  host: PaneHostLike;
  collapsed(): boolean;
  renderCalls(): number;
}

/** 造宿主 + 事件顺序记录（events 里按发生顺序落 "expand" / "render" / "click:<pane>"） */
function fakePane(
  events: string[],
  clicks: ClickRecord[],
  opts: FakePaneOptions = {},
): FakePane {
  let collapsed = opts.collapsed ?? false;
  let renderCalls = 0;
  const buttonPane =
    opts.buttonPane === undefined ? ESCAPED_PANE_ID : opts.buttonPane;
  const sectionPane =
    opts.sectionPane === undefined ? ESCAPED_PANE_ID : opts.sectionPane;
  const button = {
    getAttribute: (name: string) => (name === "data-pane" ? buttonPane : null),
    dispatchEvent: (event: object) => {
      const e = event as FakeMouseEvent;
      events.push(`click:${String(buttonPane)}`);
      clicks.push({
        pane: String(buttonPane),
        detail: e.init?.detail,
        bubbles: e.init?.bubbles,
      });
      return true;
    },
  };
  const section: PaneSectionLike = {
    getAttribute: (name: string) => (name === "data-pane" ? sectionPane : null),
    hidden: false,
    render: () => {
      renderCalls += 1;
      events.push("render");
      return undefined;
    },
    parentElement: {
      getBoundingClientRect: () =>
        typeof opts.containerTop === "number"
          ? { top: opts.containerTop }
          : null,
    },
    getBoundingClientRect: () =>
      typeof opts.sectionTop === "number"
        ? { top: opts.sectionTop, height: opts.sectionHeight ?? 400 }
        : null,
  };
  const host = {
    get collapsed() {
      return collapsed;
    },
    set collapsed(value: boolean) {
      collapsed = value;
      events.push("expand");
    },
    getBoundingClientRect: () =>
      typeof opts.paneTop === "number" ? { top: opts.paneTop } : null,
    querySelectorAll: (selector: string) => {
      if (selector === ".btn[data-pane]") {
        return buttonPane === null ? [] : [button];
      }
      if (selector === "item-pane-custom-section") {
        return sectionPane === null ? [] : [section];
      }
      return [];
    },
  } as unknown as PaneHostLike;
  return { host, collapsed: () => collapsed, renderCalls: () => renderCalls };
}

interface FakeEnv {
  doc: PaneDocumentLike;
  events: string[];
  clicks: ClickRecord[];
  logs: string[];
  panes: Map<string, FakePane>;
}

/** 文档 fake：querySelector 只认宿主选择器；querySelectorAll 认按钮（文档级兜底查找） */
function fakeEnv(
  hosts: Record<string, FakePane>,
  docButtons: Array<{ pane: string }> = [],
): FakeEnv {
  const events: string[] = [];
  const clicks: ClickRecord[] = [];
  const logs: string[] = [];
  const buttons = docButtons.map(({ pane }) => ({
    getAttribute: (name: string) => (name === "data-pane" ? pane : null),
    dispatchEvent: () => true,
  }));
  const doc: PaneDocumentLike = {
    defaultView: { MouseEvent: FakeMouseEvent },
    querySelector: (selector: string) => hosts[selector]?.host ?? null,
    querySelectorAll: (selector: string) =>
      selector === ".btn[data-pane]" ? buttons : [],
  };
  return { doc, events, clicks, logs, panes: new Map(Object.entries(hosts)) };
}

function run(
  env: FakeEnv,
  tabType: string,
): { clicks: ClickRecord[]; logs: string[] } {
  activateChatPane(
    { doc: env.doc, paneID: PANE_ID, tabType },
    { log: (message) => env.logs.push(message) },
  );
  return { clicks: env.clicks, logs: env.logs };
}

test("hostSelectorForTabType: reader（含 reader-unloaded）→ context-pane，其余 → item-pane", () => {
  assert.equal(hostSelectorForTabType("reader"), "context-pane");
  assert.equal(hostSelectorForTabType("reader-unloaded"), "context-pane");
  assert.equal(hostSelectorForTabType("library"), "item-pane");
  assert.equal(hostSelectorForTabType("note"), "item-pane");
});

test("R8：reader 标签 → 点 context-pane 那份按钮（书库那份同名按钮不许被碰）", () => {
  const env = fakeEnv({});
  const context = fakePane(env.events, env.clicks, { collapsed: true });
  const item = fakePane(env.events, env.clicks, { collapsed: false });
  const doc: PaneDocumentLike = {
    ...env.doc,
    querySelector: (selector: string) =>
      selector === "context-pane" ? context.host : item.host,
  };
  activateChatPane(
    { doc, paneID: PANE_ID, tabType: "reader" },
    { log: (m) => env.logs.push(m) },
  );
  assert.equal(env.clicks.length, 1);
  assert.equal(
    env.clicks[0].pane,
    ESCAPED_PANE_ID,
    "命中的是转义形态的 paneID",
  );
  assert.equal(context.renderCalls(), 1, "reader 侧的 section 被 render");
  assert.equal(item.renderCalls(), 0, "书库侧那份不该动");
});

test("R8：书库标签 → 目标是 item-pane（context-pane 存在也不去碰）", () => {
  const env = fakeEnv({});
  const context = fakePane(env.events, env.clicks, { collapsed: true });
  const item = fakePane(env.events, env.clicks, { collapsed: false });
  const doc: PaneDocumentLike = {
    ...env.doc,
    querySelector: (selector: string) =>
      selector === "context-pane" ? context.host : item.host,
  };
  activateChatPane(
    { doc, paneID: PANE_ID, tabType: "library" },
    { log: (m) => env.logs.push(m) },
  );
  assert.equal(
    env.clicks.length,
    1,
    "书库侧点得到（R8 起两侧栏都启用本 section）",
  );
  assert.equal(item.renderCalls(), 1);
  assert.equal(context.collapsed(), true, "不该顺手展开阅读器侧的栏");
  assert.equal(context.renderCalls(), 0);
});

test("R8：折叠的宿主先展开；顺序 = 展开 → render → 点击", () => {
  const env = fakeEnv({});
  const pane = fakePane(env.events, env.clicks, {
    collapsed: true,
    sectionTop: 900,
    containerTop: 40,
  });
  const doc: PaneDocumentLike = {
    ...env.doc,
    querySelector: () => pane.host,
  };
  const { clicks, logs } = run({ ...env, doc }, "reader");
  assert.deepEqual(env.events, [
    "expand",
    "render",
    `click:${ESCAPED_PANE_ID}`,
  ]);
  assert.equal(pane.collapsed(), false);
  assert.equal(pane.renderCalls(), 1);
  assert.equal(
    clicks[0].detail,
    1,
    "detail=1 才滚（detail=0 会被 Zotero 丢掉）",
  );
  assert.equal(clicks[0].bubbles, true, "监听挂在容器上，事件必须冒泡");
  assert.ok(logs.some((l) => l.includes("toolbar: sidebar expanded")));
});

test("R8：已展开的宿主不动 collapsed（不重复写 false）", () => {
  const env = fakeEnv({});
  const pane = fakePane(env.events, env.clicks, {
    collapsed: false,
    sectionTop: 900,
    containerTop: 40,
  });
  const doc: PaneDocumentLike = { ...env.doc, querySelector: () => pane.host };
  run({ ...env, doc }, "reader");
  assert.deepEqual(env.events, ["render", `click:${ESCAPED_PANE_ID}`]);
});

test("R8 幂等：已展开且 section 已贴在容器顶 → 不派发点击（判据见 paneAutoShow 注释）", () => {
  const env = fakeEnv({});
  const pane = fakePane(env.events, env.clicks, {
    collapsed: false,
    sectionTop: 40,
    containerTop: 40,
    sectionHeight: 600,
  });
  const doc: PaneDocumentLike = { ...env.doc, querySelector: () => pane.host };
  const { clicks, logs } = run({ ...env, doc }, "reader");
  assert.equal(
    clicks.length,
    0,
    "已在顶部：Zotero 自己也会 no-op，连点击都不发",
  );
  assert.equal(pane.renderCalls(), 1, "render 照旧补（幂等只省点击）");
  assert.ok(logs.some((l) => l.includes("toolbar: pane already at top")));

  // 容差边界：刚好超出一个像素就要照常点
  const tolerance = PANE_AT_TOP_TOLERANCE;
  const border = fakePane(env.events, env.clicks, {
    collapsed: false,
    sectionTop: 40 + tolerance,
    containerTop: 40,
  });
  activateChatPane(
    {
      doc: { ...env.doc, querySelector: () => border.host },
      paneID: PANE_ID,
      tabType: "reader",
    },
    { log: (m) => env.logs.push(m) },
  );
  assert.equal(env.clicks.length, 1, "超出容差 → 照常派发点击");
});

test("R8 幂等：刚由我们展开的那一次不算「本来展开」——仍派发点击", () => {
  // 展开会触发 Zotero 自己滚到它记着的那一项，此刻量到的位置不作数（判据只在 wasCollapsed=false 时生效）
  const env = fakeEnv({});
  const pane = fakePane(env.events, env.clicks, {
    collapsed: true,
    sectionTop: 40,
    containerTop: 40,
    sectionHeight: 600,
  });
  const doc: PaneDocumentLike = { ...env.doc, querySelector: () => pane.host };
  run({ ...env, doc }, "reader");
  assert.equal(env.clicks.length, 1);
});

test("R8 幂等：未启用（hidden）的 section 不算「已在顶部」", () => {
  const env = fakeEnv({});
  const base = fakePane(env.events, env.clicks, {
    collapsed: false,
    sectionTop: 40,
    containerTop: 40,
  });
  const host = base.host as unknown as {
    querySelectorAll(selector: string): ArrayLike<{
      hidden?: boolean;
      getAttribute(name: string): string | null;
      render?(): unknown;
      getBoundingClientRect?(): { top: number; height?: number } | null;
    }>;
  };
  const original = host.querySelectorAll.bind(host);
  host.querySelectorAll = (selector: string) => {
    const list = original(selector);
    for (let i = 0; i < list.length; i++) {
      // Zotero 的 setEnabled(false) 落成 hidden：该侧栏的滚动面根本不认它
      (list[i] as { hidden?: boolean }).hidden = true;
    }
    return list;
  };
  const doc: PaneDocumentLike = { ...env.doc, querySelector: () => base.host };
  run({ ...env, doc }, "reader");
  assert.equal(env.clicks.length, 1, "hidden 的 section 滑不到顶，得照常点");
});

test("R8：找不到宿主 / 找不到按钮 → 记日志、不抛（按钮那步连事件都不发）", () => {
  // 宿主不存在（标签类型对不上任何侧栏）
  const env1 = fakeEnv({});
  assert.doesNotThrow(() => run(env1, "reader"));
  assert.equal(env1.clicks.length, 0);
  assert.ok(env1.logs.some((l) => l.includes("host not found")));

  // 宿主在，但本插件的按钮没注册出来（只有别人的按钮）
  const env2 = fakeEnv({});
  const pane = fakePane(env2.events, env2.clicks, {
    collapsed: true,
    buttonPane: OTHER_PANE_ID,
  });
  const doc2: PaneDocumentLike = {
    ...env2.doc,
    querySelector: () => pane.host,
  };
  assert.doesNotThrow(() => run({ ...env2, doc: doc2 }, "reader"));
  assert.equal(env2.clicks.length, 0);
  assert.equal(pane.collapsed(), false, "展开与 render 与找按钮互不牵连");
  assert.equal(pane.renderCalls(), 1);
  assert.ok(env2.logs.some((l) => l.includes("sidenav button not found")));
});

test("R8：阅读器形态（sidenav 与宿主是兄弟）→ 从 section 上溯找那份按钮，不用全局第一份", () => {
  // 真机 10.0.2 实测：阅读器侧 sidenav(#zotero-context-pane-sidenav) 是 <context-pane> 的兄弟，
  // 都挂在 <box id="zotero-context-pane"> 下 → 宿主内部一个 .btn[data-pane] 都没有。
  // 若此刻回落到文档全局查找，会命中书库那份同名按钮（点了它只滚书库那个隐藏面板）。
  const clicks: ClickRecord[] = [];
  const button = (where: string) => ({
    getAttribute: (name: string) =>
      name === "data-pane" ? ESCAPED_PANE_ID : null,
    dispatchEvent: () => {
      clicks.push({ pane: where });
      return true;
    },
  });
  const docButton = button("doc-first");
  const siblingButton = button("outer-box");
  const box = {
    querySelectorAll: (selector: string) =>
      selector === ".btn[data-pane]" ? [siblingButton] : [],
    parentElement: null,
  };
  const wrap = {
    querySelectorAll: () =>
      [] as Array<{ getAttribute(n: string): string | null }>,
    parentElement: box,
  };
  const section = {
    getAttribute: (name: string) =>
      name === "data-pane" ? ESCAPED_PANE_ID : null,
    render: () => undefined,
    getBoundingClientRect: () => null,
    parentElement: wrap,
  };
  const host = {
    collapsed: true,
    // 宿主内部没有按钮（阅读器形态：sidenav 是宿主的兄弟）
    querySelectorAll: (selector: string) =>
      selector === "item-pane-custom-section" ? [section] : ([] as unknown[]),
    querySelector: () => section,
  };
  const env = fakeEnv({});
  const doc: PaneDocumentLike = {
    defaultView: { MouseEvent: FakeMouseEvent },
    querySelector: () => host as never,
    querySelectorAll: (selector: string) =>
      selector === ".btn[data-pane]" ? [docButton] : [],
  };
  activateChatPane(
    { doc, paneID: PANE_ID, tabType: "reader" },
    { log: (m) => env.logs.push(m) },
  );
  assert.deepEqual(clicks, [{ pane: "outer-box" }]);
});

test("R8：任何一步抛错都被吞掉（宿主几何炸了也不影响点击）", () => {
  const env = fakeEnv({});
  const pane = fakePane(env.events, env.clicks, {
    collapsed: false,
    sectionTop: 100,
    containerTop: 40,
  });
  const host = pane.host as unknown as { getBoundingClientRect(): unknown };
  host.getBoundingClientRect = () => {
    throw new Error("rect boom");
  };
  const doc: PaneDocumentLike = { ...env.doc, querySelector: () => pane.host };
  assert.doesNotThrow(() => run({ ...env, doc }, "reader"));
  assert.equal(env.clicks.length, 1, "判据炸了按「不在顶部」处理：照常点");
});
