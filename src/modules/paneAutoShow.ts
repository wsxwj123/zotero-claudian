// paneAutoShow.ts — 打开文献（阅读器）自动切到 Claude 面板（用户真机反馈，2026-09-11）。
//
// 动机：用户打开 PDF 的预期是「直接看到 Claude」，而 section 只是被启用了（面板在 item pane
// 下方，要自己点 sidenav 图标滚过去）。Zotero 没有「pane 被激活」这类插件事件，等效用户路径是
// 点 section 的 sidenav 按钮（`.btn[data-pane]`，`.scratch/sectv-harness` 真机验证过按钮可达）。
// 读 Zotero 9.0.6 源码（elements/itemPaneSidenav.js handleButtonClick）得到的两条要点：
//  1. 只有 `event.detail === 1` 才走 scrollToPane；`btn.click()` 的合成事件 detail=0 → 不滚动，
//     面板停在下方看不见 → 这里自己派发 detail:1 的 MouseEvent（button=0）。
//  2. 该按钮的 click 监听挂在容器上 → 事件必须冒泡。
//
// 纯逻辑 + 注入（不 import Zotero / DOM 全局），node 单测可用 fake document 驱动。

/** 等 item pane 完成装载再点（真机 300-600ms 量级；太早点会落空——面板尚未就位） */
export const AUTO_SHOW_DELAY_MS = 400;

// ---- 最小宿主面（真实为 chrome 文档元素；测试注入 fake）----

export interface PaneButtonLike {
  getAttribute(name: string): string | null;
  dispatchEvent(event: object): boolean;
  click?(): void;
  /** 从按钮上溯找到所在 item pane（折叠时先展开；fake 可不实现 → 跳过展开） */
  closest?(selector: string): PaneHostLike | null;
}

/**
 * Zotero 侧栏宿主（<item-pane> 书库侧 / <context-pane> 阅读器侧）的最小面。
 * 真机实测（2026-09-11）：**reader 侧 section 挂在 context-pane 下**（不是 item-pane）——
 * 书库里那个 item-pane 里也有一份同名 section（hidden），照文档全局找按钮会点到书库那份。
 */
export interface PaneHostLike {
  /** 侧栏折叠态（真实元素由 Zotero 定义 collapsed 属性存取器；老版本无属性 → undefined） */
  collapsed?: boolean;
  /** 该侧栏内的 sidenav 按钮（找不到目标时回落到整个文档） */
  querySelectorAll?(selector: string): ArrayLike<PaneButtonLike>;
  /** section 元素的懒渲染入口（Zotero 只在 section 可见时自动调；折叠/离屏时不调） */
  render?(): unknown;
}

/** section 的 body 元素（onItemChange 的 body）：从它上溯就能定位到本 section 与宿主侧栏 */
export interface PaneBodyLike {
  closest(selector: string): PaneHostLike | null;
}

export interface PaneDocumentLike {
  /** MouseEvent 构造器（造 detail=1 的点击事件用；取不到时回落元素原生 click()） */
  defaultView?: {
    MouseEvent?: new (type: string, init?: object) => object;
  } | null;
  querySelectorAll(selector: string): ArrayLike<PaneButtonLike>;
}

export interface PaneAutoShowInput {
  /** section 所在文档（onItemChange 的 doc；reader 窗口/主窗口都对） */
  doc: PaneDocumentLike;
  /** section 的 body（onItemChange 的 body；据此定位本 section 与它的侧栏） */
  body: PaneBodyLike;
  /** onItemChange 给的 tabType（"library" | "reader"） */
  tabType: string;
  /** 当前条目的 key（reader 侧为附件；null = 取不到，按「同一次阅读」处理） */
  itemKey: string | null;
}

export interface PaneAutoShowDeps {
  /** 设置开关（现取：用户可能中途改） */
  isEnabled(): boolean;
  /** 延时执行；返回取消句柄（真实现 setTimeout/clearTimeout，测试注入受控调度） */
  schedule(fn: () => void, delayMs: number): () => void;
  log(message: string): void;
}

export interface PaneAutoShow {
  onItemChange(input: PaneAutoShowInput): void;
  /** 取消挂起的激活（插件停用/卸载） */
  cancel(): void;
}

/**
 * 按 data-pane 匹配本插件的 sidenav 按钮。
 * 注意真机口径（2026-09-11 实测）：Zotero 写进 data-pane 的是 **CSS.escape 之后**的 paneID
 * （`zotero-claudian\@wsxwj123\.github\.io-claudian-chat`），与 `${pluginID}-${paneID}` 字面不等——
 * 精确比对之外再比一次「剥掉转义反斜杠」的形态（CSS 转义只加反斜杠，剥离即还原）。
 */
export function findPaneButton(
  doc: PaneDocumentLike,
  paneID: string,
): PaneButtonLike | null {
  const buttons = doc.querySelectorAll(".btn[data-pane]");
  const unescape = (v: string): string => v.replace(/\\/g, "");
  for (let i = 0; i < buttons.length; i++) {
    const value = buttons[i].getAttribute("data-pane") ?? "";
    if (value === paneID || unescape(value) === paneID) {
      return buttons[i];
    }
  }
  return null;
}

/** closest 的安全版（老版本元素没有该方法 / 查找本身抛错 → null，不牵连后续步骤） */
function closest(el: PaneBodyLike, selector: string): PaneHostLike | null {
  try {
    return el.closest?.(selector) ?? null;
  } catch {
    return null;
  }
}

/** 文档里全部 .btn[data-pane] 的 paneID（找不到目标时记日志用，真机排查一轮定位） */
function listPaneIDs(doc: PaneDocumentLike): string[] {
  const out: string[] = [];
  const buttons = doc.querySelectorAll(".btn[data-pane]");
  for (let i = 0; i < buttons.length; i++) {
    out.push(buttons[i].getAttribute("data-pane") ?? "");
  }
  return out;
}

/**
 * 自动显示控制器。触发规则（防「抢用户操作」）：
 *  - 只在 reader 侧、且**每篇文献只激活一次**——同一 section 的 onItemChange 在刷新/翻页时会反复
 *    触发，每次都点会把用户手动切走的面板一遍遍抢回来；
 *  - 离开 reader（tabType 变 library）即复位：下次打开（含再开同一篇）重新激活；
 *  - 换文献（itemKey 变）算新的一次阅读，重新激活。
 */
export function createPaneAutoShow(
  deps: PaneAutoShowDeps,
  paneID: string,
): PaneAutoShow {
  /** 本轮 reader 已激活过的条目 key；null = 不在 reader */
  let shownKey: string | null = null;
  let cancelPending: (() => void) | null = null;

  function cancel(): void {
    cancelPending?.();
    cancelPending = null;
  }

  /**
   * 真机（2026-09-11）走查后的三步，缺一不可，每步独立兜错（互不牵连、失败不抛）：
   *  ① 展开宿主侧栏：阅读器侧是 context-pane，**新 profile 默认折叠**——折叠态下 Zotero 既不渲染
   *     section（页面不会加载）也不会滚动（scrollToPane 只记目标），必须先展开；
   *  ② 直接调本 section 的 render()：Zotero 的懒渲染只在 section 进入可视区时触发，展开动作本身
   *     不保证补一次渲染（真机实测：只点按钮时 section 高 0、聊天页始终 about:blank）；
   *  ③ 点 sidenav 图标（用户等效激活）：把面板滚到可视区顶部、并让侧栏把它标成当前项。
   *     按钮按「本 section 所在侧栏」的作用域找——文档全局找会命中书库那份同名 section 的按钮。
   */
  function activate(input: {
    doc: PaneDocumentLike;
    body: PaneBodyLike;
  }): void {
    if (!deps.isEnabled()) {
      return; // 设置可能在延时窗口内被关掉：触发时再确认一次
    }
    const { doc, body } = input;
    const pane = closest(body, "item-pane, context-pane");
    const section = closest(body, "item-pane-custom-section");
    try {
      if (pane?.collapsed === true) {
        pane.collapsed = false;
        deps.log(`[claudian] auto-show: sidebar expanded (${paneID})`);
      }
    } catch (err) {
      deps.log(`[claudian] auto-show: expand sidebar failed: ${String(err)}`);
    }
    try {
      section?.render?.();
    } catch (err) {
      deps.log(`[claudian] auto-show: section render failed: ${String(err)}`);
    }
    const btn =
      (pane?.querySelectorAll
        ? findPaneButton(
            { querySelectorAll: pane.querySelectorAll.bind(pane) },
            paneID,
          )
        : null) ?? findPaneButton(doc, paneID);
    if (!btn) {
      deps.log(
        `[claudian] auto-show: sidenav button not found (${paneID}; have: ${listPaneIDs(doc).join("|")})`,
      );
      return;
    }
    try {
      const MouseEventCtor = doc.defaultView?.MouseEvent;
      if (MouseEventCtor) {
        // detail=1 + 冒泡：Zotero 的 sidenav 处理器靠这两个条件滚到面板（见文件头注释）
        btn.dispatchEvent(
          new MouseEventCtor("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
            button: 0,
          }),
        );
      } else {
        btn.click?.();
      }
      deps.log(`[claudian] auto-show: pane activated (${paneID})`);
    } catch (err) {
      // 失败静默：这是锦上添花的体验项，不该冒泡打断 section 的启用流程
      deps.log(`[claudian] auto-show: click failed: ${String(err)}`);
    }
  }

  return {
    onItemChange({ doc, body, tabType, itemKey }: PaneAutoShowInput): void {
      if (tabType !== "reader") {
        shownKey = null; // 回书库/关标签：下次进 reader 重新激活
        cancel();
        return;
      }
      const key = itemKey ?? "";
      if (key === shownKey) {
        return; // 同一篇文献内的重复触发：不抢用户手动切走的面板
      }
      if (!deps.isEnabled()) {
        return; // 关掉设置时连标记都不落：用户稍后打开设置、同一篇文献再触发仍会激活
      }
      shownKey = key;
      cancel();
      cancelPending = deps.schedule(() => {
        cancelPending = null;
        activate({ doc, body });
      }, AUTO_SHOW_DELAY_MS);
    },
    cancel,
  };
}
