// 单测 — src/modules/paneAutoShow.ts：打开文献自动激活 Claude 面板的触发规则与动作。
// 用户真机反馈（2026-09-11）：只该在「进入 reader / 换文献」时动一次，且设置关掉就不动。
// 全程 fake DOM：查询走的确实是 `.btn[data-pane]`、派发的确实是 detail=1 的点击事件、
// 折叠的侧栏确实被展开、section 的 render 确实被调到（这三步都是首轮真机走查出来的必需项）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_SHOW_DELAY_MS,
  createPaneAutoShow,
  findPaneButton,
  type PaneAutoShowDeps,
  type PaneBodyLike,
  type PaneButtonLike,
  type PaneDocumentLike,
} from "../../src/modules/paneAutoShow.ts";

const PANE_ID = "zotero-claudian@wsxwj123.github.io-claudian-chat";
/** 真机实况：Zotero 写进 data-pane 的是 CSS.escape 之后的值 */
const ESCAPED_PANE_ID =
  "zotero-claudian\\@wsxwj123\\.github\\.io-claudian-chat";

interface ClickRecord {
  pane: string;
  detail?: number;
  bubbles?: boolean;
  where: "pane" | "doc";
}

interface FakeButton extends PaneButtonLike {
  pane: string;
}

interface FakePane {
  collapsed?: boolean;
}

interface FakeSection {
  renderCalls: number;
  render(): unknown;
}

class FakeMouseEvent {
  constructor(
    public type: string,
    public init?: { detail?: number; bubbles?: boolean; button?: number },
  ) {}
}

interface FakeEnv {
  doc: PaneDocumentLike;
  body: PaneBodyLike;
  clicks: ClickRecord[];
  scheduler: ReturnType<typeof fakeScheduler>;
  logs: string[];
  pane: FakePane;
  section: FakeSection;
}

/**
 * 最小 fake 现场：文档（只含一组按钮，模拟「书库那份」同名 section）+ body 上溯到
 * 本 section 所在侧栏（按钮集合是「本侧栏那份」，与文档那份区分开）。
 */
function fakeEnv(
  docPaneIDs: string[],
  panePaneIDs: string[] = docPaneIDs,
  pane: FakePane = {},
): FakeEnv {
  const clicks: ClickRecord[] = [];
  const makeButtons = (
    ids: string[],
    where: ClickRecord["where"],
  ): FakeButton[] =>
    ids.map((paneID) => ({
      pane: paneID,
      getAttribute: (name: string) => (name === "data-pane" ? paneID : null),
      dispatchEvent: (ev: object) => {
        const e = ev as FakeMouseEvent;
        clicks.push({
          pane: paneID,
          detail: e.init?.detail,
          bubbles: e.init?.bubbles,
          where,
        });
        return true;
      },
    }));
  const docButtons = makeButtons(docPaneIDs, "doc");
  const paneButtons = makeButtons(panePaneIDs, "pane");
  const section: FakeSection = {
    renderCalls: 0,
    render() {
      section.renderCalls += 1;
      return undefined;
    },
  };
  const paneObj = {
    collapsed: pane.collapsed,
    querySelectorAll: (selector: string) =>
      selector === ".btn[data-pane]" ? paneButtons : [],
  };
  const body: PaneBodyLike = {
    closest: (selector: string) =>
      selector === "item-pane-custom-section"
        ? (section as unknown as { render(): unknown })
        : paneObj,
  };
  return {
    doc: {
      defaultView: { MouseEvent: FakeMouseEvent },
      querySelectorAll: (selector: string) =>
        selector === ".btn[data-pane]" ? docButtons : [],
    },
    body,
    clicks,
    scheduler: fakeScheduler(),
    logs: [],
    pane: paneObj as FakePane,
    section,
  };
}

/** 受控调度器：手动决定 400ms 延迟任务何时跑（真机是 setTimeout） */
function fakeScheduler(): {
  schedule: (fn: () => void, delayMs: number) => () => void;
  runAll: () => void;
  delays: number[];
  pending: () => number;
} {
  let tasks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    schedule(fn, delayMs) {
      delays.push(delayMs);
      tasks.push(fn);
      return () => {
        tasks = tasks.filter((t) => t !== fn);
      };
    },
    runAll() {
      const queued = tasks;
      tasks = [];
      for (const fn of queued) {
        fn();
      }
    },
    delays,
    pending: () => tasks.length,
  };
}

function makeController(
  env: FakeEnv,
  enabled = true,
): ReturnType<typeof createPaneAutoShow> {
  const deps: PaneAutoShowDeps = {
    isEnabled: () => enabled,
    schedule: env.scheduler.schedule,
    log: (m) => env.logs.push(m),
  };
  return createPaneAutoShow(deps, PANE_ID);
}

function reader(
  controller: ReturnType<typeof createPaneAutoShow>,
  env: FakeEnv,
  itemKey: string | null,
): void {
  controller.onItemChange({
    doc: env.doc,
    body: env.body,
    tabType: itemKey === null ? "library" : "reader",
    itemKey,
  });
}

test("autoShow: 进入 reader 延时后「展开侧栏 → 渲染 section → 点按钮」三步齐做", () => {
  const env = fakeEnv([ESCAPED_PANE_ID], [ESCAPED_PANE_ID], {
    collapsed: true,
  });
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  assert.equal(env.clicks.length, 0, "延时内不该立即点（等 item pane 装载）");
  assert.deepEqual(env.scheduler.delays, [AUTO_SHOW_DELAY_MS]);
  env.scheduler.runAll();
  // ① 折叠侧栏先展开（折叠态下 Zotero 不渲染、也不滚到面板）
  assert.equal(env.pane.collapsed, false);
  // ② section 渲染（懒渲染只在可见时触发；不补这一步聊天页永远 about:blank）
  assert.equal(env.section.renderCalls, 1);
  // ③ 点 sidenav 按钮：detail=1（detail=0 不滚）+ 冒泡（监听在容器上）
  assert.equal(env.clicks.length, 1);
  assert.equal(env.clicks[0].detail, 1);
  assert.equal(env.clicks[0].bubbles, true);
  assert.equal(
    env.clicks[0].where,
    "pane",
    "必须点本 section 所在侧栏那份按钮",
  );
});

test("autoShow: 未折叠时不动 folded 状态；data-pane 是 CSS.escape 形态也命中", () => {
  const env = fakeEnv([ESCAPED_PANE_ID], [ESCAPED_PANE_ID], {
    collapsed: false,
  });
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  env.scheduler.runAll();
  assert.equal(env.pane.collapsed, false);
  assert.equal(
    env.clicks.length,
    1,
    "转义形态必须命中（首轮真机就栽在字面比对）",
  );
  assert.ok(!env.logs.some((l) => l.includes("sidebar expanded")));
});

test("autoShow: 同一篇文献内重复 onItemChange（刷新/翻页）不再动", () => {
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  env.scheduler.runAll();
  reader(controller, env, "ATT1");
  reader(controller, env, "ATT1");
  assert.equal(env.scheduler.pending(), 0, "重复触发不该再挂一次激活");
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 1);
  assert.equal(env.section.renderCalls, 1);
});

test("autoShow: 换另一篇文献 → 重新激活；离开 reader 再进来也重新激活", () => {
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  env.scheduler.runAll();
  reader(controller, env, "ATT2");
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 2);
  // 回书库 → 复位；再进 reader（同一篇）也重新激活
  reader(controller, env, null);
  reader(controller, env, "ATT2");
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 3);
});

test("autoShow: 切换文献时取消挂起的激活（不在旧文档上迟到点击）", () => {
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  reader(controller, env, "ATT2");
  assert.equal(env.scheduler.pending(), 1, "同一次阅读只留一个挂起任务");
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 1, "旧任务的迟到点击不该发生");
});

test("autoShow: 设置关闭 → 不点、不挂任务；挂起期间关掉设置 → 触发时也不点", () => {
  const off = fakeEnv([ESCAPED_PANE_ID]);
  const offController = makeController(off, false);
  reader(offController, off, "ATT1");
  assert.equal(off.scheduler.pending(), 0);
  off.scheduler.runAll();
  assert.equal(off.clicks.length, 0);
  assert.equal(off.section.renderCalls, 0);

  // 挂起后关设置（延时窗口内改设置）：触发时再确认一次
  let enabled = true;
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const controller = createPaneAutoShow(
    {
      isEnabled: () => enabled,
      schedule: env.scheduler.schedule,
      log: () => {},
    },
    PANE_ID,
  );
  reader(controller, env, "ATT1");
  enabled = false;
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 0);
  assert.equal(env.section.renderCalls, 0);
});

test("autoShow: 按钮找不到 / 无 MouseEvent 构造器 / 点击抛错 → 静默不抛", () => {
  // 本侧栏与文档里都没有我们的按钮
  const missing = fakeEnv(["zotero-x-info"], ["zotero-x-info"]);
  const missingController = makeController(missing);
  reader(missingController, missing, "ATT1");
  missing.scheduler.runAll();
  assert.equal(missing.clicks.length, 0);
  assert.ok(missing.logs.some((l) => l.includes("not found")));

  // 无 MouseEvent 构造器 → 回落原生 click()
  let nativeClicks = 0;
  const btn = {
    getAttribute: (n: string) => (n === "data-pane" ? PANE_ID : null),
    dispatchEvent: () => {
      throw new Error("should not be called");
    },
    click: () => {
      nativeClicks++;
    },
  };
  const scheduler = fakeScheduler();
  const controller = createPaneAutoShow(
    { isEnabled: () => true, schedule: scheduler.schedule, log: () => {} },
    PANE_ID,
  );
  controller.onItemChange({
    doc: { querySelectorAll: () => [btn] },
    body: { closest: () => null },
    tabType: "reader",
    itemKey: "ATT1",
  });
  scheduler.runAll();
  assert.equal(nativeClicks, 1);

  // dispatchEvent 抛错 → 吞掉（不外抛打断 section 流程）
  const boom = {
    getAttribute: (n: string) => (n === "data-pane" ? PANE_ID : null),
    dispatchEvent: () => {
      throw new Error("boom");
    },
  };
  const scheduler2 = fakeScheduler();
  const logs: string[] = [];
  const controller2 = createPaneAutoShow(
    {
      isEnabled: () => true,
      schedule: scheduler2.schedule,
      log: (m) => logs.push(m),
    },
    PANE_ID,
  );
  controller2.onItemChange({
    doc: {
      defaultView: { MouseEvent: FakeMouseEvent },
      querySelectorAll: () => [boom],
    },
    body: { closest: () => null },
    tabType: "reader",
    itemKey: "ATT1",
  });
  scheduler2.runAll();
  assert.ok(logs.some((l) => l.includes("boom")));
});

test("autoShow: render/closest 抛错也不牵连其余步骤", () => {
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const body: PaneBodyLike = {
    closest: (selector: string) => {
      if (selector === "item-pane-custom-section") {
        return {
          render: () => {
            throw new Error("render boom");
          },
        };
      }
      throw new Error("closest boom");
    },
  };
  const controller = makeController(env);
  controller.onItemChange({
    doc: env.doc,
    body,
    tabType: "reader",
    itemKey: "ATT1",
  });
  env.scheduler.runAll();
  // 上溯/渲染都炸了，但按钮照点（按文档兜底找）
  assert.equal(env.clicks.length, 1);
  assert.ok(env.logs.some((l) => l.includes("render boom")));
});

test("autoShow: cancel 撤销挂起任务（插件停用不再点到面板）", () => {
  const env = fakeEnv([ESCAPED_PANE_ID]);
  const controller = makeController(env);
  reader(controller, env, "ATT1");
  controller.cancel();
  assert.equal(env.scheduler.pending(), 0);
  env.scheduler.runAll();
  assert.equal(env.clicks.length, 0);
});

test("findPaneButton: 精确匹配 data-pane（前缀命名空间），不做子串误配", () => {
  const env = fakeEnv([`evil-${PANE_ID}`, PANE_ID, "zotero-x-info"]);
  const btn = findPaneButton(env.doc, PANE_ID);
  assert.equal(btn?.getAttribute("data-pane"), PANE_ID);
  assert.equal(
    findPaneButton(env.doc, "claudian-chat"),
    null,
    "未加命名空间不该命中",
  );
});
