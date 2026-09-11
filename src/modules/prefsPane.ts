// prefsPane.ts — 设置页（PLAN §4.4 / §5 M9）：Zotero.PreferencePanes 注册 + 面板装载后的
// 文案/浏览/校验接线。存储靠面板内 `preference="<全键>"` 声明式绑定（Zotero 原生读写 +
// 跨窗口同步），校验纯逻辑在 utils/prefs.ts（node 单测），本模块只做宿主侧接线。

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  getDefaultWorkspacePath,
  isAbsolutePath,
  normalizePathInput,
} from "../utils/prefs";
import type { Platform } from "./cliDetect";

export const PREFS_PANE_ID = `${config.addonRef}-prefs-pane`;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

let registeredPaneID: string | null = null;

/** 注册设置面板（Zotero.PreferencePanes，PLAN §4.4）。宿主 onStartup 调用；失败只 log。 */
export function registerPrefsPane(): void {
  if (registeredPaneID) {
    return;
  }
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREFS_PANE_ID,
    src: `chrome://${config.addonRef}/content/preferences.xhtml`,
    label: getString("prefs-pane-label"),
    image: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  }).then(
    (id) => {
      registeredPaneID = id;
      Zotero.debug(`[claudian] prefs pane registered: ${id}`);
    },
    (err) => Zotero.logError(err as Error),
  );
}

/** 注销设置面板（插件停用/卸载；Zotero 对插件 shutdown 另有自动清理，双保险） */
export function unregisterPrefsPane(): void {
  const id = registeredPaneID;
  registeredPaneID = null;
  if (!id) {
    return;
  }
  try {
    Zotero.PreferencePanes.unregister(id);
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

/** hooks.onPrefsEvent 的分发口：面板根元素 onload → 接线（模板同款路径） */
export function onPrefsPaneEvent(
  type: string,
  data: { window?: Window },
): void {
  if (type !== "load" || !data?.window) {
    return;
  }
  try {
    wirePrefsPane(data.window);
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

// ---- 面板接线 ----

function currentPlatform(): Platform {
  return Zotero.isWin ? "win32" : "darwin";
}

function homeDir(): string {
  try {
    return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  } catch (err) {
    Zotero.logError(err as Error);
    return "";
  }
}

/** XUL button/menuitem 的可见文本是 label 属性；label/description/html 用文本节点 */
const XUL_LABEL_ATTR_TAGS = new Set([
  "button",
  "menuitem",
  "checkbox",
  "radio",
]);

function setText(el: Element | null, text: string): void {
  if (!el) {
    return;
  }
  if (el.namespaceURI === XUL_NS && XUL_LABEL_ATTR_TAGS.has(el.localName)) {
    el.setAttribute("label", text);
  } else {
    el.textContent = text;
  }
}

function wirePrefsPane(win: Window): void {
  const doc = win.document;
  const byId = <T extends Element>(suffix: string) =>
    doc.getElementById(`${config.addonRef}-pref-${suffix}`) as T | null;

  // 文案统一走插件自己的 Fluent bundle（getString）；不用面板 data-l10n-id：
  // 插件 FTL 在面板文档里的 linkset 解析随版本有差异，走已验证的 bundle 更稳。
  setText(
    doc.getElementById(`${config.addonRef}-prefs-title`),
    getString("prefs-pane-title"),
  );
  setText(
    doc.getElementById(`${config.addonRef}-prefs-intro`),
    getString("prefs-pane-intro"),
  );
  setText(byId("workspace-label"), getString("prefs-workspace-label"));
  setText(byId("mode-label"), getString("prefs-mode-label"));
  // 复选框的可见文本也是 label 属性（setText 内按 XUL tag 分派）
  setText(byId("auto-show"), getString("prefs-autoshow-label"));
  setText(byId("auto-show-hint"), getString("prefs-autoshow-hint"));
  setText(byId("cli-label"), getString("prefs-cli-label"));
  setText(byId("mode-hint"), getString("prefs-mode-hint"));
  setText(byId("mode-default"), getString("prefs-mode-item-default"));
  setText(byId("mode-acceptEdits"), getString("prefs-mode-item-acceptEdits"));
  setText(byId("mode-plan"), getString("prefs-mode-item-plan"));
  setText(byId("mode-bypass"), getString("prefs-mode-item-bypass"));
  setText(byId("mode-bypass-hint"), getString("prefs-mode-bypass-hint"));
  setText(byId("workspace-browse"), getString("prefs-workspace-browse"));
  // R4-3：用量/余额
  setText(byId("usage"), getString("prefs-usage-label"));
  setText(byId("usage-hint"), getString("prefs-usage-hint"));
  setText(byId("deepseek-label"), getString("prefs-deepseek-label"));

  const workspaceInput = byId<HTMLInputElement>("workspace");
  const workspaceHint = byId("workspace-hint");
  const cliInput = byId<HTMLInputElement>("cli-path");
  const cliHint = byId("cli-hint");
  if (workspaceInput && workspaceHint) {
    const refresh = () => refreshWorkspaceHint(workspaceInput, workspaceHint);
    workspaceInput.addEventListener("change", () => {
      persistNormalized(
        win,
        workspaceInput,
        normalizePathInput(workspaceInput.value, homeDir(), currentPlatform()),
      );
      refresh();
    });
    // 面板偏好绑定在装载时回填值（异步），挂 syncfrompreference 保证首屏提示跟随真实值
    workspaceInput.addEventListener("syncfrompreference", refresh);
    byId("workspace-browse")?.addEventListener("command", () => {
      void browseWorkspace(win, workspaceInput, refresh);
    });
    refresh();
  }
  if (cliInput && cliHint) {
    const refresh = () => refreshCliHint(cliInput, cliHint);
    cliInput.addEventListener("change", () => {
      persistNormalized(
        win,
        cliInput,
        normalizePathInput(cliInput.value, homeDir(), currentPlatform()),
      );
      refresh();
    });
    cliInput.addEventListener("syncfrompreference", refresh);
    refresh();
  }
  const keyInput = byId<HTMLInputElement>("deepseek");
  const keyHint = byId("deepseek-hint");
  if (keyInput && keyHint) {
    // R4-3：只提示「填没填」，绝不回显 Key 内容
    const refresh = () =>
      setText(
        keyHint,
        getString(
          keyInput.value.trim()
            ? "prefs-deepseek-hint-set"
            : "prefs-deepseek-hint-empty",
        ),
      );
    keyInput.addEventListener("change", refresh);
    keyInput.addEventListener("syncfrompreference", refresh);
    refresh();
  }
  Zotero.debug("[claudian] prefs pane wired");
}

/**
 * 规范化写回：值有变化时先改 input.value 再重派 change（面板绑定监听 change 落 pref，
 * 二次触发时值已规范 = 不会自激）。
 */
function persistNormalized(
  win: Window,
  input: HTMLInputElement,
  normalized: string,
): void {
  if (input.value === normalized) {
    return;
  }
  input.value = normalized;
  input.dispatchEvent(new win.Event("change", { bubbles: false }));
}

function refreshWorkspaceHint(input: HTMLInputElement, hint: Element): void {
  const platform = currentPlatform();
  const value = normalizePathInput(input.value, homeDir(), platform);
  if (!value) {
    setText(
      hint,
      getString("prefs-workspace-hint-empty", {
        args: { path: getDefaultWorkspacePath() },
      }),
    );
    return;
  }
  if (!isAbsolutePath(value, platform)) {
    setText(hint, getString("prefs-workspace-hint-relative"));
    return;
  }
  void IOUtils.exists(value).then(
    (exists) =>
      setText(
        hint,
        getString(
          exists ? "prefs-workspace-hint-ok" : "prefs-workspace-hint-missing",
        ),
      ),
    (err) => Zotero.logError(err as Error),
  );
}

function refreshCliHint(input: HTMLInputElement, hint: Element): void {
  const value = normalizePathInput(input.value, homeDir(), currentPlatform());
  if (!value) {
    setText(hint, getString("prefs-cli-hint-empty"));
    return;
  }
  void IOUtils.exists(value).then(
    (exists) =>
      setText(
        hint,
        getString(exists ? "prefs-cli-hint-ok" : "prefs-cli-hint-missing"),
      ),
    (err) => Zotero.logError(err as Error),
  );
}

/** 目录选择（Zotero.FilePicker：7/8/9 同款封装，Zotero 官方偏好面板即此用法） */
async function browseWorkspace(
  win: Window,
  input: HTMLInputElement,
  refresh: () => void,
): Promise<void> {
  type PickerLike = {
    init(w: Window, title: string, mode: number): void;
    show(): Promise<number>;
    file: string;
    displayDirectory: string;
    modeGetFolder: number;
    returnOK: number;
  };
  try {
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    ) as unknown as { FilePicker: new () => PickerLike };
    const picker = new FilePicker();
    const platform = currentPlatform();
    const current = normalizePathInput(input.value, homeDir(), platform);
    if (current && isAbsolutePath(current, platform)) {
      try {
        picker.displayDirectory = current;
      } catch {
        // 目录不存在时 displayDirectory 赋值可能失败：不影响选择
      }
    }
    picker.init(win, getString("prefs-workspace-label"), picker.modeGetFolder);
    const rv = await picker.show();
    if (rv !== picker.returnOK || !picker.file) {
      return;
    }
    input.value = picker.file;
    input.dispatchEvent(new win.Event("change", { bubbles: false }));
    refresh();
  } catch (err) {
    Zotero.logError(err as Error);
  }
}
