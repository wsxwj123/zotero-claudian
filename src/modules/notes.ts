// notes.ts — 笔记写入（M7，INTERFACE §4.3）【全项目唯一允许出现 Zotero 写 API 的文件】
// 审查口径（PLAN §7.1）：setNote/saveTx 只准出现在本文件。写入口是两个导出函数：
//   saveNote   ← 桥消息 saveNote（hostBridge）与划选弹窗按钮（contextSource）
//   listNotes  ← 桥消息 listNotes（笔记选择器数据源）
// 入参 HTML 一律过 htmlSanitize 白名单终检后才写库——桥消息/页面内容一律视为不可信。
// 失败不自动重试；单次写入原子性由 saveTx 事务保证（INTERFACE §4.3）。

import { appendNoteHtml } from "../utils/noteAppend";
import { sanitizeNoteHtml } from "../utils/htmlSanitize";

/** §4.3 错误码（SAVE_FAILED 的 message 附 Zotero 异常原文） */
export type NoteErrorCode =
  | "ITEM_NOT_FOUND"
  | "NOTE_NOT_FOUND"
  | "EMPTY_CONTENT"
  | "SANITIZE_REJECTED"
  | "SAVE_FAILED";

export interface NoteSummary {
  noteKey: string;
  /** 笔记首行，≤80 字符（§4.3 listNotes 出参口径） */
  title: string;
  /** 修改时间（毫秒时间戳；取不到 → 0） */
  updatedAt: number;
}

export type SaveNoteInput =
  | { itemKey: string; mode: "new"; html: string }
  | { itemKey: string; mode: "append"; noteKey: string; html: string };

export type NoteSaveResult =
  | { ok: true; noteKey: string }
  | { ok: false; code: NoteErrorCode; message: string };

export type NoteListResult =
  | { ok: true; notes: NoteSummary[] }
  | { ok: false; code: NoteErrorCode; message: string };

/** 笔记标题上限（§4.3：title ≤80 字符） */
const NOTE_TITLE_MAX = 80;

function fail(
  code: NoteErrorCode,
  message: string,
): { ok: false; code: NoteErrorCode; message: string } {
  return { ok: false, code, message };
}

/** itemKey → 条目（遍历全部馆藏库：个人库 + 群组库）；查无/异常 → null */
function findItemByKey(itemKey: string): Zotero.Item | null {
  try {
    for (const library of Zotero.Libraries.getAll()) {
      const item = Zotero.Items.getByLibraryAndKey(library.libraryID, itemKey);
      if (item) {
        return item;
      }
    }
  } catch (err) {
    Zotero.logError(err as Error);
  }
  return null;
}

/** 父条目下按 key 找子笔记（只认该条目自己的子笔记，防拿任意 noteKey 写到别处） */
function findChildNote(
  parent: Zotero.Item,
  noteKey: string,
): Zotero.Item | null {
  try {
    for (const id of parent.getNotes()) {
      const note = Zotero.Items.get(id);
      if (note && note.key === noteKey) {
        return note;
      }
    }
  } catch (err) {
    Zotero.logError(err as Error);
  }
  return null;
}

function isRegularItem(item: Zotero.Item): boolean {
  try {
    return item.isRegularItem();
  } catch {
    return false;
  }
}

function isAttachment(item: Zotero.Item): boolean {
  try {
    return item.isAttachment();
  } catch {
    return false;
  }
}

function isNote(item: Zotero.Item): boolean {
  try {
    return item.isNote();
  } catch {
    return false;
  }
}

/**
 * 附件（独立 PDF）的「附件笔记」在 Zotero 里的原生形态：**顶层笔记 + 双向 related 关系**——
 * Zotero 不允许笔记挂非 regular 父项（item.js _saveData 硬拦；2026-09-11 真机实证 + 源码核对），
 * 官方自身（attachmentBox.convertAttachmentNote / relatedBox）就是这么存「PDF 的笔记」的。
 * 返回值：related 关系里属于本条目、且确实是笔记的条目（只认该条目自己的，防 noteKey 写到别处）。
 */
function findRelatedNote(
  item: Zotero.Item,
  noteKey: string,
): Zotero.Item | null {
  for (const note of relatedNotes(item)) {
    if (note.key === noteKey) {
      return note;
    }
  }
  return null;
}

/** 附件 related 关系里的笔记条目（relatedItems 里的 key → 条目；过滤非笔记/查无/跨库） */
function relatedNotes(item: Zotero.Item): Zotero.Item[] {
  const notes: Zotero.Item[] = [];
  try {
    for (const key of item.relatedItems ?? []) {
      const rel = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
      if (rel && isNote(rel)) {
        notes.push(rel);
      }
    }
  } catch (err) {
    Zotero.logError(err as Error);
  }
  return notes;
}

/** 入参内容终检：空 → EMPTY_CONTENT；消毒后为空（纯脚本/样式类）→ SANITIZE_REJECTED */
function prepareContent(
  html: unknown,
):
  | { ok: true; html: string }
  | { ok: false; code: NoteErrorCode; message: string } {
  if (typeof html !== "string" || !html.trim()) {
    return fail("EMPTY_CONTENT", "笔记内容为空");
  }
  const clean = sanitizeNoteHtml(html).trim();
  if (!clean) {
    return fail(
      "SANITIZE_REJECTED",
      "内容经白名单消毒后为空（疑似 script/style 类标签）",
    );
  }
  return { ok: true, html: clean };
}

function noteTitle(note: Zotero.Item): string {
  try {
    return String(note.getNoteTitle() ?? "").slice(0, NOTE_TITLE_MAX);
  } catch {
    return "";
  }
}

/** dateModified（SQL 日期串，UTC）→ 毫秒时间戳；取不到 → 0 */
function modifiedAt(note: Zotero.Item): number {
  try {
    const date = Zotero.Date.sqlToDate(note.dateModified, true);
    return date ? date.getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * 写入：mode="new" 在目标条目下新建笔记；mode="append" 在指定笔记末尾追加
 *（原文原样保留，只对新增内容消毒——见 appendNoteHtml）。
 * 目标为附件（独立 PDF）时没有子笔记可挂（Zotero 硬拦）→ 走原生「附件笔记」：
 * 顶层笔记 + 双向 related 关系（见 findRelatedNote 注释），追加也认这一族。
 */
export async function saveNote(input: SaveNoteInput): Promise<NoteSaveResult> {
  try {
    const itemKey = input.itemKey;
    if (typeof itemKey !== "string" || !itemKey) {
      return fail("ITEM_NOT_FOUND", "缺少条目 key");
    }
    const prepared = prepareContent(input.html);
    if (!prepared.ok) {
      return prepared;
    }
    const item = findItemByKey(itemKey);
    if (!item) {
      return fail("ITEM_NOT_FOUND", `条目不存在：${itemKey}`);
    }

    // 运行期模式校验（类型层已收窄，这里防桥消息/调用方传入畸形值）
    const mode = (input as { mode?: unknown }).mode;
    if (mode !== "new" && mode !== "append") {
      return fail("SAVE_FAILED", `未知写入模式：${String(mode)}`);
    }

    const regular = isRegularItem(item);
    const attachment = isAttachment(item);

    if (input.mode === "append") {
      const noteKey = typeof input.noteKey === "string" ? input.noteKey : "";
      const note = !noteKey
        ? null
        : regular
          ? findChildNote(item, noteKey)
          : attachment
            ? findRelatedNote(item, noteKey)
            : null;
      if (!note) {
        return fail(
          "NOTE_NOT_FOUND",
          `条目下无此笔记：${noteKey || "(未指定)"}`,
        );
      }
      note.setNote(
        appendNoteHtml(note.getNote(), prepared.html, new Date().toISOString()),
      );
      await note.saveTx();
      return { ok: true, noteKey: note.key };
    }

    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    note.setNote(prepared.html);
    if (regular) {
      note.parentItemID = item.id;
      await note.saveTx();
      return { ok: true, noteKey: note.key };
    }
    if (!attachment) {
      return fail("SAVE_FAILED", `该条目类型不支持存为笔记：${itemKey}`);
    }
    // 附件自身不可能是笔记的父项（上面注释）：顶层笔记（子附件才挂到其父条目，同 Zotero
    // attachmentBox.convertAttachmentNote）+ 与附件同集合 + 双向 related，用户可在附件
    // 的「相关」里找到它，后续也能被 listNotes 列出来追加。
    const parentID = item.parentItemID;
    if (typeof parentID === "number" && parentID) {
      note.parentItemID = parentID;
    }
    try {
      note.setCollections(item.getCollections());
    } catch {
      // 集合取不到 → 不复制（不因此拦下保存）
    }
    note.addRelatedItem(item);
    await note.saveTx();
    item.addRelatedItem(note);
    await item.saveTx();
    return { ok: true, noteKey: note.key };
  } catch (err) {
    Zotero.logError(err as Error);
    return fail("SAVE_FAILED", `写入失败：${String(err)}`);
  }
}

/** 目标条目下已有笔记清单（选择器数据源）；按修改时间倒序（最近改的在前） */
export async function listNotes(itemKey: string): Promise<NoteListResult> {
  try {
    if (typeof itemKey !== "string" || !itemKey) {
      return fail("ITEM_NOT_FOUND", "缺少条目 key");
    }
    const item = findItemByKey(itemKey);
    if (!item) {
      return fail("ITEM_NOT_FOUND", `条目不存在：${itemKey}`);
    }
    const notes: NoteSummary[] = [];
    const noteItems = isAttachment(item)
      ? relatedNotes(item)
      : (item.getNotes() ?? [])
          .map((id) => Zotero.Items.get(id))
          .filter((n): n is Zotero.Item => !!n);
    for (const note of noteItems) {
      notes.push({
        noteKey: note.key,
        title: noteTitle(note),
        updatedAt: modifiedAt(note),
      });
    }
    notes.sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, notes };
  } catch (err) {
    Zotero.logError(err as Error);
    return fail("SAVE_FAILED", `读取笔记清单失败：${String(err)}`);
  }
}
