import { config } from "../package.json";
import { getString } from "./utils/locale";

// amIAddonManagerStartup.registerChrome() 的返回句柄未收录进 zotero-types，
// 本项目唯一用到的成员是 destruct()
type ChromeHandle = { destruct: () => void };

let chromeHandle: ChromeHandle | null = null;
let chromeError: unknown = null;

/**
 * 注册 chrome://<addonRef> → 插件 content/ 的映射（PLAN §4.7 / SPIKE 附录要点 1）。
 * file:// 直载与 remote browser 均实测不可用（SPIKE 假设 1），chrome:// 是唯一可用
 * UI 加载路径——因此注册失败不可静默：log error，主窗口就绪后再通知区提示（无回退路径）。
 * 原模板在 addon/bootstrap.js 内联注册且无失败处理，此处收拢进 TS 侧统一管理句柄。
 */
export function registerChrome(): void {
  try {
    // aomStartup 服务与 amIAddonManagerStartup 接口均未收录进 zotero-types
    type AomStartup = {
      registerChrome: (
        manifestURI: unknown,
        flags: Array<[string, string, string]>,
      ) => ChromeHandle;
    };
    const classes = Components.classes as unknown as Record<
      string,
      { getService(iface: unknown): AomStartup }
    >;
    const interfaces = Components.interfaces as unknown as Record<
      string,
      unknown
    >;
    const aomStartup = classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(`${rootURI}manifest.json`);
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", config.addonRef, `${rootURI}content/`],
    ]);
    Zotero.debug(
      `[${config.addonRef}] chrome registered: chrome://${config.addonRef}/content/`,
    );
  } catch (err) {
    chromeError = err;
    Zotero.logError(err as Error);
  }
}

/** shutdown 时注销 chrome 映射，防句柄泄漏（PLAN §4.7） */
export function unregisterChrome(): void {
  if (!chromeHandle) {
    return;
  }
  try {
    chromeHandle.destruct();
  } catch (err) {
    Zotero.logError(err as Error);
  }
  chromeHandle = null;
}

export function hasChromeError(): boolean {
  return chromeError !== null;
}

/**
 * 通知区提示 chrome 注册失败。须在主窗口就绪后调用
 * （onStartup 在 Zotero.uiReadyPromise 之后，满足该前提）。
 */
export function notifyChromeError(): void {
  try {
    const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWin.changeHeadline(config.addonName);
    progressWin.addDescription(getString("chrome-register-failed"));
    progressWin.show();
    progressWin.startCloseTimer(10000);
  } catch (err) {
    // 通知本身失败（如窗口异常）只留日志，不再升级
    Zotero.logError(err as Error);
  }
}
