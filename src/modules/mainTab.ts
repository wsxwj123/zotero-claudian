// mainTab.ts — 独立 Claude 标签页（Zotero_Tabs.add）+ 主窗口工具栏按钮入口（M8，PLAN §2.2/§3/§5）。
// 与 section 共用同一套装配：chrome:// 页面 + 一次性 token 握手 + hostBridge 单例注册表
//（SPIKE 假设 6/7 实测定型：tab 形态可用、section+tab 双实例广播不互踩）。
// 入口注入 = 主窗口 DOM 直建 toolbarbutton：Zotero 7.0.11 与 9.0.6 的主窗口标记里都有
// #zotero-tabs-toolbar（tab 工具条），7/8/9 通行；不用仅 8+ 才有的 Zotero.MenuManager（PLAN §2.9）。
//
// 分层：createMainTabHost（状态机 + 全依赖注入，node 单测主战场）→ installToolbarButton（DOM 注入，
// tooltip/日志也走注入）→ 文件尾部真实接线（Zotero_Tabs / sections.mountChatBrowser / getMainWindow）。

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  mountChatBrowser,
  unregisterUiInstance,
  type ChatBrowser,
} from "./sections";
import { toggleDockForWindow } from "./dockPanel";

const TAB_ID = `${config.addonRef}-main-tab`;
/**
 * tab 类型串：Zotero 内部按 '-' 拆 `{contentType}-{state}`（omni/tabs.js parseTabType），
 * 取无短横线的 addonRef 本身，免被拆出意外的 state（state 会走 load/refocus 钩子分支）。
 */
const TAB_TYPE = config.addonRef;
const BROWSER_ID = `${config.addonRef}-main-tab-browser`;
/** 工具栏按钮 DOM id（幂等判据 + 测试探针） */
export const TOOLBAR_BUTTON_ID = `${config.addonRef}-toolbar-button`;
/** tab 标题：产品名不翻译（与 section header 的 l10n 值同名） */
const TAB_TITLE = "Claude";
/** 自带 SVG（context-fill 跟随主题），不外链（PLAN §2.2） */
const ICON_URL = `chrome://${config.addonRef}/content/icons/claude.svg`;
/** 注入目标候选：7/8/9 的 tab 工具条优先，其余为标记改版兜底；全落空只记日志不抛 */
const TOOLBAR_IDS = [
  "zotero-tabs-toolbar",
  "zotero-toolbar",
  "zotero-toolbar-item-tree",
];

// ---- 最小宿主面（真实为 chrome://zotero/content/zoteroPane.xhtml 窗口；测试注入 fake）----

export interface ElementLike {
  id: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  appendChild(child: ElementLike): void;
  remove(): void;
}

export interface DocumentLike {
  getElementById(id: string): ElementLike | null;
  createXULElement(tag: string): ElementLike;
}

/** Zotero_Tabs 用到的最小面（全量签名见 omni/tabs.js；`data` 必传——不传 Zotero 内部直接 throw） */
export interface ZoteroTabsLike {
  add(options: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    title: string;
    select: boolean;
    preventJumpback: boolean;
    onClose: () => void;
  }): { id: string; container: ElementLike };
  select(id: string): void;
  close(id: string): void;
}

export interface MainWindowLike {
  document: DocumentLike;
  Zotero_Tabs: ZoteroTabsLike;
}

export type MainTabOpenResult = "opened" | "focused" | "failed";

export interface MainTabHostDeps {
  /** 主窗口现值（窗口可能重建，不缓存） */
  getMainWindow(): MainWindowLike | null;
  /**
   * 建 chat 页并开始握手（真实 = sections.mountChatBrowser）；onLoaded 给页面 window（注销用），
   * 且握手已先行起好——迟到的 onLoaded（关 tab 后才 load 完）才能被宿主撤销。
   */
  mountPage(browser: ElementLike, onLoaded: (win: object) => void): void;
  /** 页面 window 注销（真实 = sections.unregisterUiInstance） */
  unregisterPage(win: object): void;
  log(message: string): void;
}

export interface MainTabHost {
  /** 工具栏按钮入口：未开 → 新建并握手；已开 → 聚焦（不重复开，M8 要求 3） */
  open(): MainTabOpenResult;
  /** 关掉当前 tab（插件停用用；正常路径经 Zotero_Tabs onClose → 复位） */
  close(): void;
  /** 宿主窗口卸载：tab 随窗口销毁（Zotero 不会回调 onClose）→ 状态复位，下次点击可重建 */
  handleWindowUnload(win: unknown): void;
  isOpen(): boolean;
}

export function createMainTabHost(deps: MainTabHostDeps): MainTabHost {
  let open = false;
  let pageWindow: object | null = null;
  let hostWindow: unknown = null;
  /**
   * 装配世代号：mount 自增、reset 自增。页面 load 与关 tab 抢跑时（先 close → 后 load 回调），
   * 迟到回调凭世代号被识别（NEW-4：它既不能把已关 tab 的窗口写回状态，也不能让桥里留下死实例）。
   */
  let mountGen = 0;

  /** 复位（onClose / 窗口卸载 / 装配失败）：注销 UI 实例 + 作废在途装配 + 允许下次重建 */
  function reset(): void {
    mountGen += 1;
    if (pageWindow) {
      deps.unregisterPage(pageWindow);
      pageWindow = null;
    }
    hostWindow = null;
    open = false;
  }

  function mount(): void {
    const win = deps.getMainWindow();
    if (!win) {
      throw new Error("main window unavailable");
    }
    const { container } = win.Zotero_Tabs.add({
      id: TAB_ID,
      type: TAB_TYPE,
      data: {},
      title: TAB_TITLE,
      select: true,
      preventJumpback: true,
      onClose: () => reset(),
    });
    try {
      const browser = win.document.createXULElement("browser");
      browser.setAttribute("id", BROWSER_ID);
      // SPIKE 附录要点 3 同款：type=content + disableglobalhistory，不加 remote
      browser.setAttribute("type", "content");
      browser.setAttribute("disableglobalhistory", "true");
      browser.setAttribute("flex", "1");
      container.appendChild(browser);
      hostWindow = win;
      mountGen += 1;
      const gen = mountGen;
      deps.mountPage(browser, (loaded) => {
        if (gen !== mountGen) {
          // 迟到回调（关 tab / 换了一轮装配之后页面才 load 完）：不写回状态；
          // mountPage 已在回调前起了握手，这里立刻注销把它撤掉（清 pending/注册表），
          // 否则桥里会留一条指向死页面的实例，直到下次广播或插件重载。
          deps.unregisterPage(loaded);
          deps.log(
            `[mainTab] stale page load ignored (gen ${gen} ≠ ${mountGen}) → unregistered`,
          );
          return;
        }
        pageWindow = loaded;
      });
    } catch (err) {
      // 装配中途失败：收掉刚建的半成品 tab——空 tab 留着会让下次点击走 select 分支卡死
      try {
        win.Zotero_Tabs.close(TAB_ID);
      } catch (closeErr) {
        deps.log(`[mainTab] cleanup close failed: ${String(closeErr)}`);
      }
      throw err;
    }
  }

  function focus(): void {
    const win = deps.getMainWindow();
    if (!win || !win.document.getElementById(TAB_ID)) {
      // 异常路径（未经 onClose 就没了）：复位后抛错，下次点击重建而非反复 select 不存在的 id
      reset();
      throw new Error(`tab not found: ${TAB_ID}`);
    }
    win.Zotero_Tabs.select(TAB_ID);
  }

  return {
    open(): MainTabOpenResult {
      if (open) {
        try {
          focus();
          return "focused";
        } catch (err) {
          // 不复位为「已开」以外的猜测：重复 add 同 id 会毁掉 deck，宁可让用户再点一次
          deps.log(`[mainTab] focus failed: ${String(err)}`);
          return "failed";
        }
      }
      try {
        mount();
      } catch (err) {
        deps.log(`[mainTab] open failed: ${String(err)}`);
        return "failed";
      }
      open = true;
      return "opened";
    },
    close(): void {
      if (!open) {
        return;
      }
      const win = deps.getMainWindow();
      try {
        win?.Zotero_Tabs.close(TAB_ID);
      } catch (err) {
        deps.log(`[mainTab] close failed: ${String(err)}`);
      }
      if (open) {
        // close 正常路径经 onClose → reset；窗口异常没回调时兜底（否则状态永真、下次点不重建）
        reset();
      }
    },
    handleWindowUnload(win: unknown): void {
      if (hostWindow === win) {
        reset();
      }
    },
    isOpen: () => open,
  };
}

// ---- 工具栏按钮注入（7/8/9 兼容：主窗口 DOM 直建，PLAN §2.2）----

export interface ToolbarButtonOptions {
  /** tooltip 文案（真实接线取 l10n 串） */
  tooltip: string;
  onCommand(): void;
  log(message: string): void;
}

/**
 * 注入工具栏按钮（幂等：同窗口已有同 id 按钮 → 返回 false 不再插）。
 * 窗口重建后 DOM 全新，需在 onMainWindowLoad 重注入；找不到工具栏只记日志不抛（不阻断插件）。
 */
export function installToolbarButton(
  win: MainWindowLike,
  options: ToolbarButtonOptions,
): boolean {
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BUTTON_ID)) {
    return false;
  }
  const toolbar = TOOLBAR_IDS.map((id) => doc.getElementById(id)).find(
    (el): el is ElementLike => el !== null,
  );
  if (!toolbar) {
    options.log(
      `[mainTab] toolbar not found (tried: ${TOOLBAR_IDS.join(", ")})`,
    );
    return false;
  }
  const button = doc.createXULElement("toolbarbutton");
  button.id = TOOLBAR_BUTTON_ID;
  // 与 Zotero 原生图标按钮同款（zotero.css：#zotero-tb-sync 用 list-style-image + context-fill）
  button.setAttribute("class", "zotero-tb-button");
  button.setAttribute("tabindex", "-1");
  button.setAttribute("tooltiptext", options.tooltip);
  button.setAttribute(
    "style",
    `list-style-image: url("${ICON_URL}"); fill: currentColor; -moz-context-properties: fill, fill-opacity;`,
  );
  button.addEventListener("command", options.onCommand);
  toolbar.appendChild(button);
  options.log(`[mainTab] toolbar button installed: ${TOOLBAR_BUTTON_ID}`);
  return true;
}

/** 摘按钮（重复调用无害）。窗口已销毁时 getElementById 可能抛，调用方兜 */
export function removeToolbarButton(win: { document: DocumentLike }): void {
  win.document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
}

// ---- 真实接线（Zotero 全局）----

let host: MainTabHost | null = null;

function mainWindow(): MainWindowLike | null {
  try {
    return (Zotero.getMainWindow() as unknown as MainWindowLike) ?? null;
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

function mainWindows(): MainWindowLike[] {
  try {
    return (Zotero.getMainWindows() ?? []) as unknown as MainWindowLike[];
  } catch (err) {
    Zotero.logError(err as Error);
    return [];
  }
}

function getMainTabHost(): MainTabHost {
  if (!host) {
    host = createMainTabHost({
      getMainWindow: mainWindow,
      mountPage: (browser, onLoaded) => {
        mountChatBrowser(browser as unknown as ChatBrowser, onLoaded);
      },
      unregisterPage: (win) => {
        unregisterUiInstance(win);
      },
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    });
  }
  return host;
}

/** 用户入口（工具栏按钮点击）：未开 → 新建；已开 → 聚焦 */
export function openMainTab(): MainTabOpenResult {
  return getMainTabHost().open();
}

/**
 * 入口注册：onStartup 对既有主窗口直接调（onMainWindowLoad 只覆盖之后新开的窗口，
 * omni/plugins.js 的 wm listener 只挂在 open 事件上）+ onMainWindowLoad 对新窗口。幂等。
 * R4-2：按钮行为改为开关右侧浮层（dock）——全页工作台入口搬到 dock 头部「全页」按钮。
 */
export function registerMainTabEntry(win?: MainWindowLike | null): void {
  const target = win ?? mainWindow();
  if (!target) {
    Zotero.debug("[claudian] mainTab entry: no main window yet, skipped");
    return;
  }
  installToolbarButton(target, {
    tooltip: getString("main-tab-button", "tooltiptext"),
    onCommand: () => toggleDockForWindow(target as unknown as Window),
    log: (message) => Zotero.debug(`[claudian] ${message}`),
  });
}

/**
 * 入口拆除。传 win = 该主窗口卸载（摘它的按钮 + 若 tab 在它上面则复位）;
 * 不传 = 插件停用/重载：关 tab（onClose 里要经桥注销实例，此时桥还在）+ 摘所有主窗口按钮。
 */
export function unregisterMainTabEntry(win?: MainWindowLike | null): void {
  if (win) {
    try {
      removeToolbarButton(win);
    } catch (err) {
      Zotero.logError(err as Error);
    }
    getMainTabHost().handleWindowUnload(win);
    return;
  }
  getMainTabHost().close();
  for (const w of mainWindows()) {
    try {
      removeToolbarButton(w);
    } catch (err) {
      Zotero.logError(err as Error);
    }
  }
}
