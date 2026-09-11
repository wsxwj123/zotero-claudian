// contextSource.ts — contextBuilder 的 Zotero 真实数据源（M4）。
// 取数口径（PLAN §2.6 / INTERFACE §4.1.1）：
// - 当前阅读器 = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)；
// - PDF 附件 = 正在阅读的附件（getFilePathAsync 原生路径），目录即 --add-dir 值；
// - 页码 = reader.state.pageIndex（0-based），pageLabel 从 reader 内部视图尽力获取；
// - 划选 = renderTextSelectionPopup 事件的 annotation 快照（text/pageIndex/pageLabel 同源、最准），
//   无缓存时回落 reader 内部 DOM selection（页码用当前页近似）。
// 所有 Zotero 访问包 try/catch：任一环失败退化为 null，由 contextBuilder 走通用会话缺省规则。

import { config } from "../../package.json";
import type {
  AttachmentInfo,
  ContextDeps,
  ItemMetadata,
  ReaderInfo,
  SelectionInfo,
} from "../utils/contextBuilder";
import type { HostMessage } from "../chat/lib/types";
import { listNotes, saveNote, type SaveNoteInput } from "./notes";

/** 最近一次划选快照（发送时刻语义：用户最新划选即随轮固化） */
let lastSelection: {
  itemID: number;
  text: string;
  pageIndex: number;
  pageLabel: string;
} | null = null;

let selectionListenerRegistered = false;

/** 启动时调用一次：跟踪划选弹窗事件，缓存最新划选（M7 的「问 AI」按钮复用同一数据源） */
export function registerSelectionTracking(): void {
  if (selectionListenerRegistered) {
    return;
  }
  selectionListenerRegistered = true;
  try {
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event) => {
      try {
        const annotation = (
          event as unknown as {
            params?: {
              annotation?: {
                text?: unknown;
                pageLabel?: unknown;
                position?: { pageIndex?: unknown };
              };
            };
          }
        ).params?.annotation;
        const itemID = (event as unknown as { reader?: { itemID?: unknown } })
          .reader?.itemID;
        if (
          annotation &&
          typeof annotation.text === "string" &&
          annotation.text &&
          typeof itemID === "number"
        ) {
          lastSelection = {
            itemID,
            text: annotation.text,
            pageIndex:
              typeof annotation.position?.pageIndex === "number"
                ? annotation.position.pageIndex
                : 0,
            pageLabel:
              typeof annotation.pageLabel === "string"
                ? annotation.pageLabel
                : "",
          };
        }
      } catch (err) {
        Zotero.logError(err as Error);
      }
    });
    Zotero.debug(
      "[claudian] selection tracking registered (renderTextSelectionPopup)",
    );
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

// ---- 划选弹窗「存为笔记」按钮（M7，PLAN §2.8）----
// 流程：划选 → 弹窗按钮「存为笔记」→ 选新建/追加（追加清单来自 notes.listNotes）→
// notes.saveNote 写库（唯一写入口；HTML 在 notes.ts 内过白名单终检）。
// 与聊天页无关：按钮活在阅读器弹窗里，不依赖侧栏 Claude 面板是否打开。

let noteButtonRegistered = false;

/** 该划选所属的挂靠条目：父文献条目；独立 PDF（无父条目）挂附件自身 */
function noteTargetKey(itemID: number | null): string | null {
  if (itemID == null) {
    return null;
  }
  try {
    const item = Zotero.Items.get(itemID);
    return item ? (item.parentItem?.key ?? item.key) : null;
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/** 弹窗内小按钮（不引样式表：阅读器弹窗是宿主 DOM 的访客） */
function popupButton(doc: Document, label: string): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.textContent = label;
  btn.setAttribute(
    "style",
    "font:inherit;font-size:12px;margin:2px 4px 2px 0;padding:2px 8px;" +
      "border:1px solid rgba(128,128,128,.5);border-radius:4px;background:transparent;" +
      "color:inherit;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  );
  return btn;
}

/** 划选内容 → 笔记 HTML：引用块 + 页码小字（整段仍会过 notes.ts 的白名单终检） */
function selectionNoteHtml(text: string, pageLabel: string): string {
  const quote = Zotero.Utilities.text2html(text);
  // 页码只转义不 text2html——后者会包一层 <p>，嵌进 <small> 会产出块级标签套块级标签
  // （真机实证：<small>第 <p>1</p> 页</small>）
  const page = pageLabel
    ? `<p><small>第 ${Zotero.Utilities.htmlSpecialChars(pageLabel)} 页</small></p>`
    : "";
  return `<blockquote>${quote}</blockquote>${page}`;
}

/** 写入并就地回执（成功/失败都显示在弹出容器里，不弹系统对话框） */
async function saveSelectionNote(
  container: HTMLElement,
  input: SaveNoteInput,
): Promise<void> {
  container.replaceChildren("保存中…");
  try {
    const result = await saveNote(input);
    container.replaceChildren(
      result.ok ? "已存为笔记 ✓" : `保存失败：${result.code}`,
    );
  } catch (err) {
    Zotero.logError(err as Error);
    container.replaceChildren("保存失败：SAVE_FAILED");
  }
}

/** 选新建 or 追加到哪条已有笔记（清单取自目标条目，最近修改在前） */
async function openNotePicker(
  container: HTMLElement,
  doc: Document,
  input: SaveNoteInput,
): Promise<void> {
  container.replaceChildren("读取笔记列表…");
  const result = await listNotes(input.itemKey);
  if (!result.ok) {
    container.replaceChildren(`读取失败：${result.code}`);
    return;
  }
  container.replaceChildren();
  const newBtn = popupButton(doc, "新建笔记");
  newBtn.addEventListener("click", () => {
    void saveSelectionNote(container, { ...input, mode: "new" });
  });
  container.append(newBtn);
  for (const note of result.notes) {
    const label = note.title ? note.title.slice(0, 30) : "(无标题)";
    const btn = popupButton(doc, `追加到「${label}」`);
    btn.addEventListener("click", () => {
      void saveSelectionNote(container, {
        itemKey: input.itemKey,
        mode: "append",
        noteKey: note.noteKey,
        html: input.html,
      });
    });
    container.append(btn);
  }
}

/** 启动时调用一次：注册划选弹窗的「存为笔记」按钮（pluginID → 插件停用自动注销） */
export function registerSelectionNoteButton(): void {
  if (noteButtonRegistered) {
    return;
  }
  noteButtonRegistered = true;
  try {
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => {
        try {
          const { reader, doc, params, append } = event;
          const text = params.annotation?.text ?? "";
          if (!text.trim()) {
            return; // 图片类划选无文本，不提供存笔记
          }
          const itemKey = noteTargetKey(
            typeof reader.itemID === "number" ? reader.itemID : null,
          );
          if (!itemKey) {
            return;
          }
          const container = doc.createElement("div");
          const btn = popupButton(doc, "存为笔记");
          btn.addEventListener("click", () => {
            void openNotePicker(container, doc, {
              itemKey,
              mode: "new",
              html: selectionNoteHtml(text, params.annotation?.pageLabel ?? ""),
            });
          });
          container.append(btn);
          append(container);
        } catch (err) {
          Zotero.logError(err as Error);
        }
      },
      config.addonID,
    );
    Zotero.debug("[claudian] selection note button registered");
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

function getSelectedTabID(): string | null {
  try {
    const win = Zotero.getMainWindow() as
      | (Window & { Zotero_Tabs?: { selectedID: string } })
      | null;
    return win?.Zotero_Tabs?.selectedID ?? null;
  } catch {
    return null;
  }
}

/** reader 内部视图的 pageLabel（未公开 API，尽力获取；拿不到 → null 只写物理页码） */
function peekPageLabel(
  reader: unknown,
  pageIndex: number | null,
): string | null {
  if (pageIndex == null) {
    return null;
  }
  try {
    const view = (
      reader as {
        _internalReader?: {
          _primaryView?: { getPageLabel?: (i: number) => unknown };
        };
      }
    )?._internalReader?._primaryView;
    if (typeof view?.getPageLabel === "function") {
      const label = view.getPageLabel(pageIndex);
      return label == null ? null : String(label);
    }
  } catch {
    // 内部形态变化 → 无 label
  }
  return null;
}

/** reader 内部 DOM selection（pdf.js 文本层为真实 DOM 文本，toString 可取） */
function peekLiveSelection(
  reader: unknown,
  itemID: number | null,
): SelectionInfo | null {
  try {
    const iframeWin = (
      reader as {
        _internalReader?: { _primaryView?: { _iframeWindow?: Window } };
      }
    )?._internalReader?._primaryView?._iframeWindow;
    const selection = iframeWin?.getSelection?.();
    const text =
      typeof selection?.toString === "function"
        ? String(selection.toString())
        : "";
    if (!text.trim()) {
      return null;
    }
    const state = (reader as { state?: { pageIndex?: unknown } }).state;
    const pageIndex =
      typeof state?.pageIndex === "number" ? state.pageIndex : null;
    return {
      text,
      page: pageIndex == null ? null : pageIndex + 1,
      parentKey: itemID == null ? null : parentKeyOfItemID(itemID),
    };
  } catch {
    return null;
  }
}

function parentKeyOfItemID(itemID: number): string | null {
  try {
    return Zotero.Items.get(itemID)?.parentItem?.key ?? null;
  } catch {
    return null;
  }
}

function itemField(item: Zotero.Item, field: string): string | null {
  try {
    const value: unknown = item.getField(field);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 条目标题：必须走 `item.getDisplayTitle()`——"displayTitle" 不是 ItemFields 里的真字段，
 * `getField("displayTitle")` 静默返回空串（真机实证：readerContext title 恒 null、
 * prompt 的 Title 行整行消失、会话列表条目名恒空）。
 */
function itemDisplayTitle(item: Zotero.Item): string | null {
  try {
    const title = item.getDisplayTitle();
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/**
 * 当前页码（0-based）：主路径 `reader.state.pageIndex`（reader 对插件公开的形态）。
 * 回落：附件上由 Zotero 自己维护的最后阅读页（reader 内部 _setState 落盘的同一值）——
 * 刚打开尚未渲染出页、或内部形态变化时，页头不至于恒空。
 */
function readerPageIndex(
  reader: unknown,
  itemID: number | null,
): number | null {
  try {
    const state = (reader as { state?: { pageIndex?: unknown } } | null)?.state;
    if (state && typeof state.pageIndex === "number") {
      return state.pageIndex;
    }
  } catch {
    // 内部形态变化 → 走回落
  }
  if (itemID == null) {
    return null;
  }
  try {
    const item = Zotero.Items.get(itemID);
    const last = item?.getAttachmentLastPageIndex?.();
    return typeof last === "number" ? last : null;
  } catch {
    return null;
  }
}

function isRegularItem(item: Zotero.Item): boolean {
  try {
    return item.isRegularItem();
  } catch {
    return false;
  }
}

function getLocalFile(path: string): nsIFile | null {
  try {
    const classes = Components.classes as unknown as Record<
      string,
      { createInstance(iface: unknown): nsIFile }
    >;
    const file = classes["@mozilla.org/file/local;1"].createInstance(
      Components.interfaces.nsIFile,
    );
    file.initWithPath(path);
    return file;
  } catch {
    return null;
  }
}

/** PDF 所在目录（--add-dir 值）；经 nsIFile 取父目录，失败 → null */
function dirOf(path: string): string | null {
  return getLocalFile(path)?.parent?.path ?? null;
}

/** 同步文件存在性（cliDetect.resolveClaudeCommand 注入用） */
export function fileExistsSync(path: string): boolean {
  const file = getLocalFile(path);
  return file ? file.exists() : false;
}

/**
 * itemKey → 条目信息（M5 会话存储用）：createSession 的存在性校验、sessionList 的条目标题解析、
 * 索引 itemLibraryID 回填，三处共用同一个入口（§2.4「标题运行时查 displayTitle，不冗余存储」）。
 * 遍历全部馆藏库（个人库 + 群组库），查无/异常 → null。
 */
export async function lookupItemByKey(
  itemKey: string,
): Promise<{ libraryID: number; title: string | null } | null> {
  try {
    for (const library of Zotero.Libraries.getAll()) {
      const item = Zotero.Items.getByLibraryAndKey(library.libraryID, itemKey);
      if (item) {
        return {
          libraryID: item.libraryID,
          title: itemDisplayTitle(item),
        };
      }
    }
  } catch (err) {
    Zotero.logError(err as Error);
  }
  return null;
}

/**
 * §4.6 readerContext 消息（宿主→UI 表）：DI 数据 → 桥消息的纯映射（node 单测可测）。
 * title 取父条目 displayTitle；page 为物理页码（0-based +1）；selection 取发送时刻快照文本；
 * 无阅读器/无附件 → 整条空值（UI 显示空态，不猜）。
 */
export function readerContextMessage(
  reader: ReaderInfo | null,
  parent: ItemMetadata | null,
): HostMessage {
  if (!reader || reader.itemID == null) {
    return {
      type: "readerContext",
      itemKey: null,
      title: null,
      page: null,
      selection: null,
    };
  }
  return {
    type: "readerContext",
    itemKey: parent?.key ?? null,
    title: parent?.displayTitle ?? null,
    page: reader.pageIndex == null ? null : reader.pageIndex + 1,
    selection: reader.selection?.text ?? null,
  };
}

export function createZoteroContextDeps(): ContextDeps {
  return {
    async getSelectedReader(): Promise<ReaderInfo | null> {
      try {
        const tabID = getSelectedTabID();
        if (!tabID) {
          return null;
        }
        const reader = Zotero.Reader.getByTabID(tabID);
        if (!reader) {
          return null;
        }
        const rawItemID =
          typeof reader.itemID === "number"
            ? reader.itemID
            : (reader as unknown as { _item?: unknown })._item;
        const nestedID = (rawItemID as { id?: unknown } | null | undefined)?.id;
        const itemID: number | null =
          typeof reader.itemID === "number"
            ? reader.itemID
            : typeof nestedID === "number"
              ? nestedID
              : null;
        const pageIndex = readerPageIndex(reader, itemID);
        let selection: SelectionInfo | null = null;
        if (
          itemID != null &&
          lastSelection &&
          lastSelection.itemID === itemID
        ) {
          selection = {
            text: lastSelection.text,
            page: lastSelection.pageIndex + 1,
            parentKey: parentKeyOfItemID(itemID),
          };
        } else {
          selection = peekLiveSelection(reader, itemID);
        }
        return {
          itemID: itemID == null ? null : itemID,
          pageIndex,
          pageLabel: peekPageLabel(reader, pageIndex),
          selection,
        };
      } catch (err) {
        Zotero.logError(err as Error);
        return null;
      }
    },

    async getAttachment(itemID: number): Promise<AttachmentInfo | null> {
      try {
        const item = Zotero.Items.get(itemID);
        if (!item) {
          return null;
        }
        let path: string | null = null;
        try {
          const raw = await item.getFilePathAsync();
          path = typeof raw === "string" && raw ? raw : null;
        } catch {
          path = null;
        }
        const rawParent = item.parentItemID;
        return {
          key: item.key,
          pdfPath: path,
          pdfDir: path ? dirOf(path) : null,
          parentItemID: typeof rawParent === "number" ? rawParent : null,
        };
      } catch (err) {
        Zotero.logError(err as Error);
        return null;
      }
    },

    async getItemMetadata(itemID: number): Promise<ItemMetadata | null> {
      try {
        const item = Zotero.Items.get(itemID);
        if (!item || !isRegularItem(item)) {
          return null;
        }
        const creatorNames: string[] = [];
        try {
          for (const creator of item.getCreators() ?? []) {
            // 单字段模式（机构作者）在 zotero-types 的 Creator 联合里未收 name，这里按运行时形态读
            const c = creator as unknown as {
              name?: unknown;
              firstName?: unknown;
              lastName?: unknown;
            };
            if (typeof c.name === "string" && c.name) {
              creatorNames.push(c.name);
            } else {
              const name = [c.firstName, c.lastName]
                .filter(
                  (v): v is string => typeof v === "string" && v.length > 0,
                )
                .join(" ");
              if (name) {
                creatorNames.push(name);
              }
            }
          }
        } catch {
          // creators 取不到 → 空数组（模板省 Authors 行）
        }
        return {
          key: item.key,
          displayTitle: itemDisplayTitle(item),
          creatorNames,
          date: itemField(item, "date"),
          doi: itemField(item, "DOI"),
          abstractNote: itemField(item, "abstractNote"),
        };
      } catch (err) {
        Zotero.logError(err as Error);
        return null;
      }
    },
  };
}
