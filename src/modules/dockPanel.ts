// dockPanel.ts — R4 需求 2（PLAN-R4 §3）：顶部按钮打开的右侧浮层（dock）——不依赖 Zotero 侧栏 section，
// 阅读 PDF 时浮层贴在内容区右侧，PDF 保持可见。
//
// 分层与 mainTab.ts 同款：纯逻辑（宽度钳制 / 几何 / 开合状态机，黑盒契约见 tests/unit/r4-dock.test.ts）
// → createDock（DOM 与宿主能力全依赖注入）→ 文件尾部真实接线（Zotero / sections / mainTab）。
//
// 复用（不许另写一份）：chat 页装配走 sections.mountChatBrowser——chrome:// URI + 一次性 token +
// loadURI(systemPrincipal) + beginHandshake 注册到同一个 hostBridge；注销走 sections.unregisterUiInstance。
// 会话列表 / 流事件 sessionId 过滤 / 权限卡三路广播因此与 section / 全页实例完全同路。
//
// 布局（0 高前科，见 sections.ts bodyXHTML 注释）：容器 position:fixed 自带确定高度（px 由 dockRect 给），
// 内部 header / browser / 拖柄一律绝对定位——不赌 flex 与百分比高度在 XUL 父下的解析结果。
// 上下贴合量由真实 DOM 探测（probeDockInsets）：优先取内容容器 #zotero-pane-stack 的 rect，
// 拿不到才回落「顶栏底边」推算（阅读器独立窗口等形态）。

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
// 装配与全页入口复用既有模块（与 mainTab 互为循环 import：都只在函数体内调用，模块求值期不取用）
import {
  mountChatBrowser,
  unregisterUiInstance,
  type ChatBrowser,
} from "./sections";
import { openMainTab } from "./mainTab";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ---- 纯逻辑（黑盒契约：tests/unit/r4-dock.test.ts 锁定，不许改口径）----

export const DOCK_WIDTH_DEFAULT = 420;
export const DOCK_WIDTH_MIN = 320;
export const DOCK_WIDTH_MAX = 900;

/**
 * 宽度归一化（裁决 A1）：非有限值 / 非数字 / <= 0 → 默认 420；其余 clamp 到 [320, 900]。
 * prefs 里可能是历史脏值（字符串/负数），一律在这里收口，别把脏值带进布局。
 */
export function normalizeDockWidth(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DOCK_WIDTH_DEFAULT;
  }
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, raw));
}

/** 窗口视口（逻辑像素）：top/bottom 为内容区上下内缩（顶部工具栏/tab 栏、底部状态栏） */
export interface DockViewport {
  width: number;
  height: number;
  top?: number;
  bottom?: number;
}

export interface DockRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** dock 几何：右贴齐窗口右缘、上下贴内容区、宽度取归一化后的值 */
export function dockRect(viewport: DockViewport, rawWidth: unknown): DockRect {
  const width = normalizeDockWidth(rawWidth);
  const top = viewport.top ?? 0;
  const bottomInset = viewport.bottom ?? 0;
  const bottom = viewport.height - bottomInset;
  return {
    left: viewport.width - width,
    top,
    right: viewport.width,
    bottom,
    width,
    height: bottom - top,
  };
}

/** 开合状态：destroyed 为终态（插件停用/窗口关闭后再操作不崩、不复活） */
export type DockPhase = "closed" | "open" | "destroyed";
export type DockAction = "toggle" | "show" | "hide" | "destroy";

export function dockReduce(phase: DockPhase, action: DockAction): DockPhase {
  if (phase === "destroyed") {
    return "destroyed";
  }
  switch (action) {
    case "toggle":
      return phase === "open" ? "closed" : "open";
    case "show":
      return "open";
    case "hide":
      return "closed";
    case "destroy":
      return "destroyed";
  }
}

// ---- 真实 DOM 探测（不拍脑袋：候选按 Zotero 9 zoteroPane.xhtml 的实际标记，取不到就退让）----

/** 内容容器候选：dock 上下与它贴齐（#zotero-pane-stack = 标签内容区，deck 的父 stack） */
const CONTENT_IDS = ["zotero-pane-stack", "tabs-deck"];
/** 顶栏候选（回落用）：#zotero-title-bar = 顶部 tab 栏 + 工具条整条 */
const TOP_BAR_IDS = [
  "zotero-title-bar",
  "zotero-tabs-toolbar",
  "tab-bar-container",
];
/** 底栏候选（Zotero 9 主窗口没有；留着防别的形态把 dock 盖住） */
const BOTTOM_BAR_IDS = ["zotero-status-bar", "statusbar"];

interface BoxMetrics {
  top: number;
  bottom: number;
}

function boxMetrics(doc: Document, id: string): BoxMetrics | null {
  const el = doc.getElementById(id);
  if (!el || typeof el.getBoundingClientRect !== "function") {
    return null;
  }
  const r = el.getBoundingClientRect();
  // 隐藏/未布局的元素 rect 恒 0 → 不认（认了会把 dock 贴到 0）
  if (!r || !(r.height > 0) || !(r.width > 0)) {
    return null;
  }
  return { top: r.top, bottom: r.bottom };
}

/**
 * dock 与窗口内容区的上下内缩量（px，取整）。
 * 主路径：内容容器 rect → dock 恰好覆盖内容区（避开 tab 栏与工具条）；
 * 回落：top = 顶栏底边、bottom = 0（形态不认识时至少不盖住 tab 栏）。
 */
export function probeDockInsets(
  doc: Document,
  viewportH: number,
): { top: number; bottom: number } {
  for (const id of CONTENT_IDS) {
    const box = boxMetrics(doc, id);
    if (box) {
      return {
        top: Math.max(0, Math.round(box.top)),
        bottom: Math.max(0, Math.round(viewportH - box.bottom)),
      };
    }
  }
  let top = 0;
  for (const id of TOP_BAR_IDS) {
    const box = boxMetrics(doc, id);
    if (box) {
      top = Math.max(top, box.bottom);
    }
  }
  let bottom = 0;
  for (const id of BOTTOM_BAR_IDS) {
    const box = boxMetrics(doc, id);
    if (box) {
      bottom = Math.max(bottom, viewportH - box.top);
    }
  }
  return { top: Math.round(top), bottom: Math.round(bottom) };
}

// ---- dock 本体（依赖注入：node 侧可用 fake 覆盖；真实接线在文件尾部）----

export interface DockDeps {
  /** 设置开关（当前恒开；将来加「禁用浮层」设置时接这里，false = show/toggle 不动 UI） */
  isEnabled(): boolean;
  /** prefs 里的宽度（原始值；钳制在 normalizeDockWidth，脏值不落地） */
  getWidth(): unknown;
  /** 拖动结束落 prefs */
  setWidth(px: number): void;
  /** 装配 chat 页（真实 = sections.mountChatBrowser；onLoaded 给页面 window） */
  mountBrowser(browser: object, onLoaded: (win: object) => void): void;
  /** 页面 window 注销（真实 = sections.unregisterUiInstance） */
  unregisterPage(win: object): void;
  /** 头部「全页」按钮（真实 = mainTab.openMainTab：全页工作台入口） */
  openFullPage(): void;
  /** 开合状态落 prefs（dockOpen，下次开窗口恢复） */
  setOpen(open: boolean): void;
  log(message: string): void;
}

export interface Dock {
  toggle(): void;
  show(): void;
  hide(): void;
  isOpen(): boolean;
  /** 插件停用/窗口关闭：移除 DOM、注销桥实例、摘监听器；幂等，之后一切操作 no-op */
  destroy(): void;
}

/** 头部条高度（browser 从其下方起铺） */
const HEADER_H = 28;

/**
 * 建一个 dock 实例（一个宿主窗口至多一个，由调用方保证）。
 * 容器在首次 show 时才建 DOM（不开就不建，省一次页面装配）。
 */
export function createDock(
  deps: DockDeps,
  host: Window,
  idPrefix: string,
): Dock {
  const dockId = `${idPrefix}-dock`;
  const browserId = `${dockId}-browser`;
  const handleId = `${dockId}-resize`;
  const doc = host.document;

  let phase: DockPhase = "closed";
  let root: HTMLElement | null = null;
  let frame: HTMLElement | null = null;
  /** 当前内容宽（px）：拖柄的权威值（容器 rect 含 1px 边框，不能拿 rect 宽落 prefs） */
  let width = normalizeDockWidth(deps.getWidth());
  let pageWindow: object | null = null;
  /** 挂到宿主 window 上的监听器（destroy 逐个摘掉，不留悬挂引用） */
  let listeners: Array<[string, EventListener]> = [];

  function listen(type: string, fn: EventListener): void {
    host.addEventListener(type, fn);
    listeners.push([type, fn]);
  }

  function html(tag: string): HTMLElement {
    // Gecko 的类型定义把 createElementNS 收窄成返回 Element；这里按实际渲染的元素用
    return doc.createElementNS(XHTML_NS, tag) as HTMLElement;
  }

  /** 摘 DOM 节点（不存在/已摘 → no-op） */
  function removeNode(el: HTMLElement | null): void {
    try {
      el?.remove();
    } catch (err) {
      deps.log(`[dock] dom remove failed: ${String(err)}`);
    }
  }

  /** 窗口尺寸变化重算几何（内容区上下内缩每次都重探：全屏切换/布局改动不留旧值） */
  function applyRect(): void {
    if (!root) {
      return;
    }
    const insets = probeDockInsets(doc, host.innerHeight);
    const rect = dockRect(
      {
        width: host.innerWidth,
        height: host.innerHeight,
        top: insets.top,
        bottom: insets.bottom,
      },
      width,
    );
    const style = root.style;
    style.left = `${rect.left}px`;
    style.top = `${rect.top}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    // browser 高显式给 px：XUL <browser> 当替换元素算，只给 top+bottom 不拉伸
    //（真实实测：高度停在 min-height。见 .scratch/dock-harness 记录）
    if (frame) {
      frame.style.height = `${Math.max(0, rect.height - HEADER_H)}px`;
    }
  }

  /** 拖动中实时改宽（browser 随容器绝对定位同步变），松手才落 prefs */
  function applyWidth(px: number): void {
    if (!root) {
      return;
    }
    width = normalizeDockWidth(px);
    root.style.width = `${width}px`;
    root.style.left = `${host.innerWidth - width}px`;
  }

  function makeButton(
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLElement {
    const button = html("button");
    button.textContent = label;
    button.setAttribute("title", title);
    button.setAttribute(
      "style",
      "font:inherit;font-size:11px;line-height:1;padding:3px 7px;border:0;border-radius:3px;" +
        "background:transparent;color:inherit;cursor:pointer",
    );
    button.addEventListener("click", onClick);
    return button;
  }

  function build(): void {
    const wrap = html("div");
    wrap.id = dockId;
    // 探针/幂等判据（harness 与人工排查都按它找）
    wrap.setAttribute("data-claudian-dock", "true");
    wrap.setAttribute(
      "style",
      "position:fixed;z-index:2147483000;display:block;overflow:hidden;" +
        "border-left:1px solid var(--fill-quaternary, rgba(127,127,127,.35));" +
        "box-shadow:-2px 0 8px rgba(0,0,0,.18);" +
        "background:var(--material-background, Canvas)",
    );

    const header = html("div");
    header.id = `${dockId}-header`;
    header.setAttribute(
      "style",
      `position:absolute;left:0;right:0;top:0;height:${HEADER_H}px;display:flex;align-items:center;` +
        "gap:6px;padding:0 8px;box-sizing:border-box;" +
        "color:var(--fill-secondary, currentColor);background:var(--fill-tertiary, rgba(127,127,127,.2))",
    );
    const title = html("span");
    title.textContent = "Claude";
    title.setAttribute(
      "style",
      "font-size:12px;font-weight:600;margin-right:auto;overflow:hidden;white-space:nowrap",
    );
    header.appendChild(title);
    // 「全页」= 既有独立标签页工作台入口（工具栏按钮语义搬到这里，PLAN-R4 §3）
    header.appendChild(
      makeButton(
        getString("dock-fullpage-label"),
        getString("dock-fullpage-label", "tooltiptext"),
        () => deps.openFullPage(),
      ),
    );
    header.appendChild(
      makeButton(
        getString("dock-close-label"),
        getString("dock-close-label", "tooltiptext"),
        () => hide(),
      ),
    );
    wrap.appendChild(header);

    const browser = doc.createXULElement("browser") as unknown as HTMLElement;
    browser.setAttribute("id", browserId);
    // SPIKE 附录要点 3 / mainTab 同款：type=content + disableglobalhistory，不加 remote
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    // 绝对定位铺满 header 以下：宽 100%（XUL browser 当替换元素算，left+right 撑不开宽度）、
    // 高由 applyRect 显式给 px（容器高是确定的 px）
    browser.setAttribute(
      "style",
      `position:absolute;left:0;top:${HEADER_H}px;width:100%`,
    );
    wrap.appendChild(browser);
    frame = browser;

    // 左边缘拖柄（浮层在右侧，往左拖 = 变宽）
    const handle = html("div");
    handle.id = handleId;
    handle.setAttribute("data-claudian-dock-handle", "true");
    handle.setAttribute(
      "style",
      "position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2",
    );
    handle.addEventListener("pointerdown", (event) =>
      startDrag(event as PointerEvent, handle),
    );
    wrap.appendChild(handle);

    // 父节点：优先内容 stack（与标签内容同层、DOM 序在最后 → 天然压住内容），
    // 拿不到则挂窗口根（position:fixed 的包含块是视口，二者视觉等价）
    const parent =
      doc.getElementById("zotero-pane-stack") ?? doc.documentElement;
    parent.appendChild(wrap);
    root = wrap;

    // 装配 chat 页：复用 section 的 chrome:// + 一次性 token + loadURI(systemPrincipal) 链路
    deps.mountBrowser(browser, (win) => {
      if (phase === "destroyed") {
        // 迟到的 load（dock 已销毁）：桥里别留死实例
        try {
          deps.unregisterPage(win);
        } catch (err) {
          deps.log(`[dock] stale page unregister failed: ${String(err)}`);
        }
        return;
      }
      pageWindow = win;
    });

    // 窗口尺寸变化（含全屏切换）实时重贴
    listen("resize", () => applyRect());
  }

  function startDrag(event: PointerEvent, handle: HTMLElement): void {
    if (!root || typeof event.clientX !== "number") {
      return;
    }
    const startX = event.clientX;
    const startWidth = width;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件/无指针设备：没有 capture 也能靠元素自身监听收尾
    }
    const onMove = (moveEvent: Event) => {
      const clientX = (moveEvent as PointerEvent).clientX;
      if (typeof clientX !== "number") {
        return;
      }
      // 浮层贴右缘：往左拖（clientX 变小）= 变宽
      applyWidth(startWidth + (startX - clientX));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      deps.setWidth(width);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  /** 状态迁移唯一出口：DOM/prefs 副作用都按「上次是否开着」算，避免重复写 prefs */
  function transition(next: DockPhase): void {
    if (next === "destroyed") {
      destroy();
      return;
    }
    const wasOpen = phase === "open";
    if (!deps.isEnabled()) {
      return;
    }
    phase = next;
    if (next === "open") {
      if (!wasOpen) {
        // 每次「关→开」跟随 prefs（外部改了 dockWidth 也认）
        width = normalizeDockWidth(deps.getWidth());
      }
      if (!root) {
        try {
          build();
        } catch (err) {
          // 装配失败（DOM 形态不认识等）：收掉半成品并回到关闭态，下次点击可重试
          deps.log(`[dock] build failed: ${String(err)}`);
          removeNode(root);
          root = null;
          frame = null;
          phase = "closed";
          return;
        }
      }
      if (root) {
        root.style.display = "";
        applyRect();
      }
      if (!wasOpen) {
        deps.setOpen(true);
      }
    } else {
      if (root) {
        root.style.display = "none";
      }
      if (wasOpen) {
        deps.setOpen(false);
      }
    }
  }

  function show(): void {
    transition(dockReduce(phase, "show"));
  }

  function hide(): void {
    transition(dockReduce(phase, "hide"));
  }

  function toggle(): void {
    transition(dockReduce(phase, "toggle"));
  }

  function destroy(): void {
    if (phase === "destroyed") {
      return;
    }
    phase = "destroyed";
    for (const [type, fn] of listeners) {
      try {
        host.removeEventListener(type, fn);
      } catch (err) {
        deps.log(`[dock] removeEventListener failed: ${String(err)}`);
      }
    }
    listeners = [];
    if (pageWindow) {
      try {
        deps.unregisterPage(pageWindow);
      } catch (err) {
        deps.log(`[dock] unregister failed: ${String(err)}`);
      }
      pageWindow = null;
    }
    try {
      removeNode(root);
    } finally {
      root = null;
      frame = null;
    }
  }

  return {
    toggle,
    show,
    hide,
    isOpen: () => phase === "open",
    destroy,
  };
}

// ---- 真实接线（Zotero 全局；复用 sections 装配与 mainTab 全页入口）----

/** 每个宿主窗口一个 dock（键 = 窗口；窗口卸载/插件停用逐个销毁 → 多实例不串扰、无悬挂） */
const docks = new Map<Window, Dock>();

/** 当前活动窗口：阅读器独立窗口与主窗口都从这取（Zotero.getActiveZoteroPane().window） */
function activeHostWindow(): Window | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.();
    const win = (pane?.window as Window | undefined) ?? Zotero.getMainWindow();
    return (win as Window) ?? null;
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/** 取该窗口的 dock（没有就建；首建即挂 window unload 清理，覆盖阅读器独立窗口） */
export function dockForWindow(host: Window): Dock {
  let dock = docks.get(host);
  if (dock) {
    return dock;
  }
  dock = createDock(
    {
      // ponytail: 开关位预留，恒开；加「禁用浮层」设置项时接这条
      isEnabled: () => true,
      getWidth: () => getPref("dockWidth"),
      setWidth: (px) => setPref("dockWidth", px),
      mountBrowser: (browser, onLoaded) =>
        mountChatBrowser(browser as unknown as ChatBrowser, onLoaded),
      unregisterPage: (win) => unregisterUiInstance(win),
      openFullPage: () => {
        openMainTab();
      },
      setOpen: (open) => setPref("dockOpen", open),
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    },
    host,
    config.addonRef,
  );
  docks.set(host, dock);
  try {
    host.addEventListener("unload", () => destroyDockForWindow(host));
  } catch (err) {
    Zotero.logError(err as Error);
  }
  return dock;
}

/** 工具栏按钮入口（mainTab 接线）：开关**该按钮所在窗口**的 dock
 *（比"当前活动窗口"更可预期：阅读器独立窗口没有 ZoteroPane，按活动窗口取会打到主窗口去） */
export function toggleDockForWindow(host: Window): void {
  dockForWindow(host).toggle();
}

/** 新窗口恢复（hooks.onMainWindowLoad）：prefs.dockOpen 为真 → 该窗口直接显示浮层 */
export function restoreDock(host: Window): void {
  if (getPref("dockOpen") !== true) {
    return;
  }
  dockForWindow(host).show();
}

/** 启动恢复（hooks.onStartup）：既有主窗口不会走 onMainWindowLoad，这里自己补一次 */
export function restoreDockOnStartup(): void {
  const host = activeHostWindow();
  if (host) {
    restoreDock(host);
  }
}

/** 该窗口卸载：销毁它的 dock（幂等；没建过就是 no-op） */
export function destroyDockForWindow(host: Window): void {
  const dock = docks.get(host);
  docks.delete(host);
  dock?.destroy();
}

/** 插件停用：全部销毁（桥还活着时调用，注销才能真的从注册表摘掉实例） */
export function destroyAllDocks(): void {
  for (const [host, dock] of docks) {
    docks.delete(host);
    dock.destroy();
  }
}
