import { config } from "../package.json";
import {
  registerChrome,
  hasChromeError,
  notifyChromeError,
  unregisterChrome,
} from "./bootstrap";
import { initLocale } from "./utils/locale";
import {
  registerChatSection,
  unregisterChatSection,
  startCliStatusWatch,
  stopCliStatusWatch,
} from "./modules/sections";
import {
  onPrefsPaneEvent,
  registerPrefsPane,
  unregisterPrefsPane,
} from "./modules/prefsPane";
import {
  registerMainTabEntry,
  unregisterMainTabEntry,
  type MainWindowLike,
} from "./modules/mainTab";
import {
  destroyAllDocks,
  destroyDockForWindow,
  restoreDock,
  restoreDockOnStartup,
} from "./modules/dockPanel";

async function onStartup() {
  // chrome 注册先行（对应模板 bootstrap.js 原位时序；失败不阻塞插件其余初始化）
  registerChrome();

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerChatSection();
  // 工具栏入口（M8）：这里对**既有的**主窗口注入——onMainWindowLoad 只覆盖之后新开的窗口
  //（omni/plugins.js 的 wm listener 只挂 open 事件），所以 onStartup 必须自己补一次
  registerMainTabEntry();
  // R4-2 同理：既有主窗口的上次开合状态（prefs.dockOpen）在这里恢复
  restoreDockOnStartup();
  // 设置页（M9，PLAN §4.4）+ CLI 可用性/登录态检测（PLAN §2.7；异步探测，不阻塞启动）
  registerPrefsPane();
  startCliStatusWatch();

  if (hasChromeError()) {
    // PLAN §4.7：注册失败 → log error（registerChrome 内已做）+ 通知区提示，不静默
    notifyChromeError();
  }

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // 多主窗口：每个窗口都要有自己的工具栏按钮（幂等，窗口重建后 DOM 全新需重注入）
  registerMainTabEntry(win as unknown as MainWindowLike);
  // R4-2：上次退出时浮层开着（prefs.dockOpen）→ 新窗口直接恢复
  try {
    restoreDock(win as unknown as Window);
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterMainTabEntry(win as unknown as MainWindowLike);
  // 窗口销毁：dock 的 DOM/桥注册/监听器一并收掉（幂等）
  try {
    destroyDockForWindow(win);
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

/** 设置面板事件（preferences.xhtml 根元素 onload 分发口，模板同款） */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    onPrefsPaneEvent(type, data as { window?: Window });
  }
}

function onShutdown(): void {
  // 顺序要紧：先关独立 tab 与浮层（它们的注销要走桥），再拆 section 与桥
  unregisterMainTabEntry();
  destroyAllDocks();
  unregisterChatSection();
  unregisterPrefsPane();
  stopCliStatusWatch();
  unregisterChrome();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
