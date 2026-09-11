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
//
// R8：同一个三步被两个入口复用——① 打开文献自动切（createPaneAutoShow）② 工具栏「Claude」按钮
//（activateChatPane：展开右侧栏 + 定位到面板，取代 R4 的浮层方案）。别再写第三套。

/** 等 item pane 完成装载再点（真机 300-600ms 量级；太早点会落空——面板尚未就位） */
export const AUTO_SHOW_DELAY_MS = 400;

/**
 * 「已在顶部」的容差（px）。Zotero 自己的判据是 <1px（itemPaneContainerBase.scrollToPane：
 * `Math.abs(pane.top - _paneParent.top) < 1` 就直接不滚），这里放宽——宿主元素
 *（item-pane / context-pane）与内部滚动容器之间还有一条结构差，真机实测约 6px。
 * 判宽了只会多派发一次点击（Zotero 自己 no-op，无副作用），判窄了也不会错——宁多滚一次。
 */
export const PANE_AT_TOP_TOLERANCE = 8;

// ---- 最小宿主面（真实为 chrome 文档元素；测试注入 fake）----

export interface PaneButtonLike {
  getAttribute(name: string): string | null;
  dispatchEvent(event: object): boolean;
  click?(): void;
  /** 从按钮上溯找到所在 item pane（折叠时先展开；fake 可不实现 → 跳过展开） */
  closest?(selector: string): PaneHostLike | null;
}

/** 上溯查找用的最小元素面（parentElement 链 + 子查询 + 几何） */
export interface PaneAncestorLike {
  getBoundingClientRect?(): { top: number } | null;
  querySelectorAll?(selector: string): ArrayLike<PaneElementLike>;
  parentElement?: PaneAncestorLike | null;
}

/** section 元素（真机为 <item-pane-custom-section>，见 itemPaneCustomSection.js）的最小面 */
export interface PaneSectionLike {
  /** section 的懒渲染入口（真机是真方法；fake 可不实现） */
  render?(): unknown;
  /** 位置（幂等判据用；fake/异常取不到 → 判据不成立，照常派发点击） */
  getBoundingClientRect?(): { top: number; height?: number } | null;
  /** 所在滚动容器（Zotero 的 _paneParent）：判据优先比它的顶，也是按钮上溯起点 */
  parentElement?: PaneAncestorLike | null;
  /** 未启用（Zotero 的 setEnabled(false) 落成 hidden）→ 一律不算「已在顶部」 */
  hidden?: boolean;
  /** data-pane（找 section 用，按钮与 section 都是同一个 paneID） */
  getAttribute(name: string): string | null;
}

/** 宿主里可查到的元素（sidenav 按钮 / section 元素共用同一最小面） */
export interface PaneElementLike extends PaneButtonLike, PaneSectionLike {}

/**
 * Zotero 侧栏宿主（<item-pane> 书库侧 / <context-pane> 阅读器侧）的最小面。
 * 真机实测（2026-09-11）：**reader 侧 section 挂在 context-pane 下**（不是 item-pane）——
 * 书库里那个 item-pane 里也有一份同名 section（hidden），照文档全局找按钮会点到书库那份。
 */
export interface PaneHostLike {
  /** 侧栏折叠态（真实元素由 Zotero 定义 collapsed 属性存取器；老版本无属性 → undefined） */
  collapsed?: boolean;
  /** 该侧栏内的元素（找不到目标时回落到整个文档） */
  querySelectorAll?(selector: string): ArrayLike<PaneElementLike>;
  /** 该侧栏内的 section 元素（工具栏入口定位用；fake 可不实现） */
  querySelector?(selector: string): PaneSectionLike | null;
  /** 宿主几何（「已在顶部」判据的兜底参照） */
  getBoundingClientRect?(): { top: number } | null;
  /** 宿主所在外层（按钮上溯起点之一；fake 可不实现） */
  parentElement?: PaneAncestorLike | null;
  /** section 元素的懒渲染入口（Zotero 只在 section 可见时自动调；折叠/离屏时不调） */
  render?(): unknown;
}

/** section 的 body 元素（onItemChange 的 body）：从它上溯就能定位到本 section 与宿主侧栏 */
export interface PaneBodyLike {
  /** 上溯（返回类型按调用点断言：宿主或 section 元素；取不到/抛错 → null） */
  closest(selector: string): unknown;
}

export interface PaneDocumentLike {
  /** MouseEvent 构造器（造 detail=1 的点击事件用；取不到时回落元素原生 click()） */
  defaultView?: {
    MouseEvent?: new (type: string, init?: object) => object;
  } | null;
  querySelectorAll(selector: string): ArrayLike<PaneElementLike>;
  /** 文档里找宿主元素（工具栏入口用；非文档对象/老版本没有 → 当找不到，记日志不抛） */
  querySelector?(selector: string): PaneHostLike | null;
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
 * data-pane 匹配（按钮与 section 元素共用——两者写的是同一个 paneID）。
 * 注意真机口径（2026-09-11 实测）：Zotero 写进 data-pane 的是 **CSS.escape 之后**的 paneID
 *（`zotero-claudian\@wsxwj123\.github\.io-claudian-chat`），与 `${pluginID}-${paneID}` 字面不等——
 * 精确比对之外再比一次「剥掉转义反斜杠」的形态（CSS 转义只加反斜杠，剥离即还原）。
 */
function paneIDMatches(value: string | null, paneID: string): boolean {
  return value === paneID || (value ?? "").replace(/\\/g, "") === paneID;
}

/** 按 data-pane 在全文档找本插件的 sidenav 按钮 */

export function findPaneButton(
  doc: PaneDocumentLike,
  paneID: string,
): PaneElementLike | null {
  const buttons = doc.querySelectorAll(".btn[data-pane]");
  for (let i = 0; i < buttons.length; i++) {
    if (paneIDMatches(buttons[i].getAttribute("data-pane"), paneID)) {
      return buttons[i];
    }
  }
  return null;
}

/** 宿主内找本插件的 section 元素（工具栏入口用；onItemChange 路径直接用 body.closest） */
function findSectionElement(
  host: PaneHostLike | null,
  paneID: string,
): PaneSectionLike | null {
  try {
    const list = host?.querySelectorAll?.("item-pane-custom-section");
    if (!list) {
      return null;
    }
    for (let i = 0; i < list.length; i++) {
      if (paneIDMatches(list[i].getAttribute("data-pane"), paneID)) {
        return list[i];
      }
    }
  } catch {
    // 查找本身抛错 → 当找不到（后续 render/点击各有自己的兜错）
  }
  return null;
}

/**
 * 祖先链上溯层数上限。真机实测（Zotero 10.0.2，2026-09-11）阅读器侧要上溯 9 层：
 * section → div#zotero-view-item → div → hbox#zotero-view-item-container → item-details
 * → deck → deck → context-pane → vbox → box#zotero-context-pane（sidenav 在这层）；留余量到 12。
 */
const BUTTON_SEARCH_DEPTH = 12;

/** 把元素包成 findPaneButton 要的「文档面」（元素为空 → 查不到任何按钮） */
function scopeOf(
  el: {
    querySelectorAll?(selector: string): ArrayLike<PaneElementLike>;
  } | null,
): PaneDocumentLike {
  return {
    querySelectorAll: (selector: string) =>
      el?.querySelectorAll?.(selector) ?? [],
  };
}

/**
 * 找「本 section 那一份」sidenav 按钮。真机（Zotero 10.0.2，2026-09-11）实测两种形态：
 *  - 书库侧：sidenav（#zotero-view-item-sidenav）就在 <item-pane> 内部 → 宿主内一查即中；
 *  - 阅读器侧：sidenav（#zotero-context-pane-sidenav）与 <context-pane> 是**兄弟**，两者同在
 *    <box id="zotero-context-pane"> 下 → 宿主内部与中间层一个按钮都没有（实测 9 层内全为 0），
 *    必须从 section 逐级上溯到那个外层 box 才找得到。
 * 为什么不能直接全局兜底（实测教训）：两份 sidenav 的按钮 data-pane 同名（同一个 paneID），
 * 文档全局找会命中书库那份 → 点击只会滚书库那个隐藏面板，阅读器侧纹丝不动
 *（R7 自动显示「只展开、不滚到面板」与 R8 首轮「展开了但面板还在下面」的根因都是它）。
 */
function findPaneButtonFor(
  doc: PaneDocumentLike,
  pane: PaneHostLike | null,
  section: PaneSectionLike | null,
  paneID: string,
): PaneElementLike | null {
  const inPane = findPaneButton(scopeOf(pane), paneID);
  if (inPane) {
    return inPane;
  }
  let el: PaneAncestorLike | null =
    section?.parentElement ?? pane?.parentElement ?? null;
  for (let i = 0; i < BUTTON_SEARCH_DEPTH && el; i++) {
    const found = findPaneButton(scopeOf(el), paneID);
    if (found) {
      return found;
    }
    el = el.parentElement ?? null;
  }
  return findPaneButton(doc, paneID); // 形态都不认识：全局兜底（日志里会有线索）
}

/** 当前标签类型 → 目标侧栏宿主的选择器（reader 系列 → context-pane；书库/笔记等 → item-pane） */
export function hostSelectorForTabType(tabType: string): string {
  return tabType.startsWith("reader") ? "context-pane" : "item-pane";
}

/** closest 的安全版（老版本元素没有该方法 / 查找本身抛错 → null，不牵连后续步骤） */
function closest<T>(el: PaneBodyLike, selector: string): T | null {
  try {
    return (el.closest?.(selector) as T | undefined) ?? null;
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
 * 「section 已在容器顶部」判据（幂等：已在顶部就不派发点击）。口径与 Zotero
 * itemPaneContainerBase.scrollToPane 同源（它自己也是「pane 顶与 _paneParent 顶差 <1px 即不滚」），
 * 容差放宽到 PANE_AT_TOP_TOLERANCE（宿主元素内还有结构差，见常量注释）。
 * 拿不到 rect / 未启用（hidden）/ 高 0（未渲染）→ 一律判「不在顶部」：宁多滚一次，不赌。
 */
function isSectionAtTop(
  pane: PaneHostLike | null,
  section: PaneSectionLike | null,
): boolean {
  if (!pane || !section || pane.collapsed === true || section.hidden === true) {
    return false;
  }
  try {
    const rect = section.getBoundingClientRect?.();
    if (!rect || !(typeof rect.height === "number" && rect.height > 0)) {
      return false;
    }
    const refTop =
      section.parentElement?.getBoundingClientRect?.()?.top ??
      pane.getBoundingClientRect?.()?.top;
    if (typeof refTop !== "number" || !Number.isFinite(refTop)) {
      return false;
    }
    return Math.abs(rect.top - refTop) < PANE_AT_TOP_TOLERANCE;
  } catch {
    return false;
  }
}

/** 激活所需的注入面（两个入口共用：日志出口） */
export interface PaneActivateDeps {
  log(message: string): void;
}

/**
 * 三步激活（真机 2026-09-11 走查后的结论，两个入口共用，缺一不可，每步独立兜错、失败不抛）：
 *  ① 展开宿主侧栏：阅读器侧是 context-pane，**新 profile 默认折叠**——折叠态下 Zotero 既不渲染
 *     section（页面不会加载）也不会滚动（scrollToPane 只记目标），必须先展开；
 *  ② 直接调本 section 的 render()：Zotero 的懒渲染只在 section 进入可视区时触发，展开动作本身
 *     不保证补一次渲染（真机实测：只点按钮时 section 高 0、聊天页始终 about:blank）；
 *  ③ 派发 detail=1 的点击（用户等效激活）：把面板滚到可视区顶部、并让侧栏把它标成当前项。
 *     按钮按「本 section 所在侧栏」的作用域找——文档全局找会命中书库那份同名 section 的按钮。
 * 幂等：侧栏本来就展开、且 section 已启用并已贴到容器顶 → 连点击都不派发（Zotero 那次也只会
 * no-op，跳过它省掉 smooth 滚动与 focus 抢焦点）。注意刚由我们展开的这一次不算「本来展开」——
 * 展开会触发 Zotero 自己滚到它记着的上一项，此刻量到的位置不作数。
 *
 * @param label 日志前缀（auto-show / toolbar）：真机日志里一眼分辨是哪个入口干的
 */
function activatePaneIn(
  deps: PaneActivateDeps,
  label: string,
  paneID: string,
  doc: PaneDocumentLike,
  pane: PaneHostLike | null,
  section: PaneSectionLike | null,
): void {
  const wasCollapsed = pane?.collapsed === true;
  try {
    if (wasCollapsed && pane) {
      pane.collapsed = false;
      deps.log(`[claudian] ${label}: sidebar expanded (${paneID})`);
    }
  } catch (err) {
    deps.log(`[claudian] ${label}: expand sidebar failed: ${String(err)}`);
  }
  try {
    section?.render?.();
  } catch (err) {
    deps.log(`[claudian] ${label}: section render failed: ${String(err)}`);
  }
  if (!wasCollapsed && isSectionAtTop(pane, section)) {
    deps.log(`[claudian] ${label}: pane already at top (${paneID})`);
    return;
  }
  const btn = findPaneButtonFor(doc, pane, section, paneID);
  if (!btn) {
    deps.log(
      `[claudian] ${label}: sidenav button not found (${paneID}; have: ${listPaneIDs(doc).join("|")})`,
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
    deps.log(`[claudian] ${label}: pane activated (${paneID})`);
  } catch (err) {
    // 失败静默：这是锦上添花的体验项，不该冒泡打断 section 的启用流程
    deps.log(`[claudian] ${label}: click failed: ${String(err)}`);
  }
}

/** 工具栏按钮入口的输入（宿主窗口文档 + 本插件 paneID + 当前标签类型） */
export interface ActivateChatPaneInput {
  /** 宿主窗口文档（工具栏按钮所在窗口的 document） */
  doc: PaneDocumentLike;
  /** 本插件 section 的 paneID（带 pluginID 前缀，与 sidenav 按钮的 data-pane 同源） */
  paneID: string;
  /** 当前选中的标签类型（"reader" | "library" | …）：决定去哪个侧栏找人 */
  tabType: string;
}

/**
 * 工具栏「Claude」按钮入口（R8）：展开右侧栏 + 定位到 Claude 面板。
 * - reader 标签 → context-pane；其余（书库…）→ item-pane（见 hostSelectorForTabType）；
 * - 三步与自动显示共用（activatePaneIn），失败只记日志、不抛；
 * - 幂等：已展开且面板已在顶部 → 保持不动（不收起、不重复滚）。
 */
export function activateChatPane(
  input: ActivateChatPaneInput,
  deps: PaneActivateDeps,
): void {
  const { doc, paneID, tabType } = input;
  const selector = hostSelectorForTabType(tabType);
  let pane: PaneHostLike | null = null;
  try {
    pane = doc.querySelector?.(selector) ?? null;
  } catch (err) {
    deps.log(`[claudian] toolbar: query ${selector} failed: ${String(err)}`);
  }
  if (!pane) {
    deps.log(
      `[claudian] toolbar: host not found (${selector}; tabType: ${tabType})`,
    );
  }
  activatePaneIn(
    deps,
    "toolbar",
    paneID,
    doc,
    pane,
    findSectionElement(pane, paneID),
  );
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

  /** onItemChange 路径的激活：宿主/section 都从 body 上溯（三步本体在 activatePaneIn） */
  function activate(input: {
    doc: PaneDocumentLike;
    body: PaneBodyLike;
  }): void {
    if (!deps.isEnabled()) {
      return; // 设置可能在延时窗口内被关掉：触发时再确认一次
    }
    const { doc, body } = input;
    activatePaneIn(
      deps,
      "auto-show",
      paneID,
      doc,
      closest<PaneHostLike>(body, "item-pane, context-pane"),
      closest<PaneSectionLike>(body, "item-pane-custom-section"),
    );
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
