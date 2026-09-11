// 复核轮（m7-review）—— notes.ts（全项目唯一写库口）白盒自查。
// 独立性：Zotero 假件在 ./fakes.ts（本轮自写，不复用被测方与其它轮次的假件）；
// 每条测试自建世界、互不共享状态。
//
// 覆盖口径（INTERFACE §4.3）：错误码五分支、append 原子语义、findChildNote 越权边界、
// 消毒拒绝不写半截（反向用例）、listNotes 出参口径（title≤80 / updatedAt 倒序）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  saveNote,
  listNotes,
  type SaveNoteInput,
} from "../../../src/modules/notes.ts";
import { withWorld } from "./fakes.ts";

const marker = (iso: string): string =>
  `<hr><p><small>zotero-claudian 追加（${iso}）</small></p>`;

// ---- saveNote：mode=new 正常路径 ----

test(
  "saveNote·new：写入子笔记并返回新 noteKey；libraryID/parentItemID 指向目标条目",
  withWorld(async (w) => {
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: "<p>正文</p>",
    });
    assert.equal(res.ok, true);
    const note = w.notes[0];
    assert.ok(note, "应创建一条笔记");
    assert.equal(note.parentItemID, w.item1.id, "parentItemID 必须是目标条目");
    assert.equal(note.libraryID, 1, "libraryID 继承目标条目");
    assert.equal(note.html, "<p>正文</p>", "落库内容为消毒后 HTML");
    assert.equal(note.savedCount, 1, "恰好保存一次");
    assert.equal(
      res.ok && res.noteKey,
      note.key,
      "返回的 noteKey 与落库笔记一致",
    );
  }),
);

test(
  "saveNote·new：落库内容已过白名单（script/on* 不进库）",
  withWorld(async (w) => {
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: '<p onclick="x()">正文</p><script>alert(1)</script><img src="https://e/a.png" onerror="y()">',
    });
    assert.equal(res.ok, true);
    const stored = w.notes[0].html;
    assert.equal(
      stored,
      '<p>正文</p><img src="https://e/a.png">',
      "落库内容必须是消毒产物",
    );
    assert.ok(!stored.includes("script"), "script 不得进库");
    assert.ok(!stored.includes("onerror"), "onerror 不得进库");
  }),
);

test(
  "saveNote·new：条目在非第一个库时也能找到（遍历全库）",
  withWorld(async (w) => {
    const res = await saveNote({
      itemKey: "ITEM2",
      mode: "new",
      html: "<p>二库</p>",
    });
    assert.equal(res.ok, true);
    assert.equal(w.notes[0].libraryID, 2, "二库条目的笔记应落在二库");
  }),
);

// ---- saveNote：错误路径 ----

test(
  "saveNote·new：itemKey 空/非字符串/查无 → ITEM_NOT_FOUND，且不创建任何笔记",
  withWorld(async (w) => {
    for (const key of ["", undefined, null, 42]) {
      const res = await saveNote({
        itemKey: key as unknown as string,
        mode: "new",
        html: "<p>x</p>",
      });
      assert.equal(res.ok, false, `itemKey=${String(key)} 应失败`);
      assert.equal(res.ok === false && res.code, "ITEM_NOT_FOUND");
    }
    const ghost = await saveNote({
      itemKey: "NOPE",
      mode: "new",
      html: "<p>x</p>",
    });
    assert.equal(ghost.ok === false && ghost.code, "ITEM_NOT_FOUND");
    assert.equal(w.notes.length, 0, "失败路径不得写库（反向用例）");
  }),
);

test(
  "saveNote·new：空内容/纯空白/非字符串 → EMPTY_CONTENT，且不写库",
  withWorld(async (w) => {
    for (const html of ["", "   ", "\n\t ", undefined, null, 42]) {
      const res = await saveNote({
        itemKey: "ITEM1",
        mode: "new",
        html: html as unknown as string,
      });
      assert.equal(res.ok, false, `html=${JSON.stringify(html)} 应失败`);
      assert.equal(res.ok === false && res.code, "EMPTY_CONTENT");
    }
    assert.equal(w.item1.children.length, 0, "失败路径不得挂上子笔记");
    assert.equal(w.notes.length, 0);
  }),
);

test(
  "saveNote·new：纯 script/style 内容 → SANITIZE_REJECTED，且不写库（不写半截）",
  withWorld(async (w) => {
    for (const html of [
      "<script>alert(1)</script>",
      "<style>body{}</style>",
      '<iframe src="https://e"></iframe>',
    ]) {
      const res = await saveNote({ itemKey: "ITEM1", mode: "new", html });
      assert.equal(res.ok, false, `html=${html} 应被拒`);
      assert.equal(res.ok === false && res.code, "SANITIZE_REJECTED");
    }
    assert.equal(w.notes.length, 0, "消毒拒绝后不得落库");
  }),
);

test(
  "saveNote：EMPTY_CONTENT 优先于 SANITIZE_REJECTED（纯空白是空，纯脚本是拒绝）",
  withWorld(async () => {
    const blank = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: "  \n ",
    });
    assert.equal(blank.ok === false && blank.code, "EMPTY_CONTENT");
    const script = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: "<script> </script>",
    });
    assert.equal(script.ok === false && script.code, "SANITIZE_REJECTED");
  }),
);

test(
  "saveNote·new：未闭合 script 截断输入 → 内容以文本入正文（不拒绝，也不带标记）",
  withWorld(async (w) => {
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: "<script>alert(1)",
    });
    assert.equal(res.ok, true, "截断 script 不是空内容");
    assert.equal(w.notes[0].html, "alert(1)");
  }),
);

test(
  "saveNote：saveTx 抛错 → SAVE_FAILED 且 message 含异常原文",
  withWorld(async (w) => {
    const note = w.addNote({ parentItemID: w.item1.id, key: "N1" });
    w.item1.children.push(note.id);
    note.failSaveTx = new Error("db locked");
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>x</p>",
    });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "SAVE_FAILED");
    assert.ok(
      res.ok === false && res.message.includes("db locked"),
      `message 应附异常原文，实际 ${res.ok === false ? res.message : ""}`,
    );
    assert.ok(
      w.logs.some((l) => l.includes("db locked")),
      "异常应进 logError",
    );
  }),
);

test(
  "saveNote：非法 mode（运行时畸形）→ SAVE_FAILED，不写库",
  withWorld(async (w) => {
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "bogus",
      html: "<p>x</p>",
    } as unknown as SaveNoteInput);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "SAVE_FAILED");
    assert.equal(w.notes.length, 0);
  }),
);

test(
  "saveNote：条目不存在优先于非法 mode 报出（ITEM_NOT_FOUND）",
  withWorld(async () => {
    const res = await saveNote({
      itemKey: "NOPE",
      mode: "bogus",
      html: "<p>x</p>",
    } as unknown as SaveNoteInput);
    assert.equal(res.ok === false && res.code, "ITEM_NOT_FOUND");
  }),
);

test(
  "saveNote：入参为 null/undefined 不崩，回 SAVE_FAILED",
  withWorld(async () => {
    for (const bad of [null, undefined]) {
      const res = await saveNote(bad as unknown as SaveNoteInput);
      assert.equal(res.ok === false && res.code, "SAVE_FAILED");
    }
  }),
);

// ---- saveNote：mode=append ----

test(
  "saveNote·append：原文逐字保留，追加段为 hr + 时间戳 + 新内容",
  withWorld(async (w) => {
    const original = "<p>原文</p><ul><li>一</li></ul>";
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: original,
    });
    w.item1.children.push(note.id);
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>新内容</p>",
    });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.noteKey, "N1");
    const stored = note.html;
    assert.ok(
      stored.startsWith(original),
      "原文必须原样出现在开头（一字不动）",
    );
    const tail = stored.slice(original.length);
    const m = tail.match(
      /^<hr><p><small>zotero-claudian 追加（(.+?)）<\/small><\/p><p>新内容<\/p>$/,
    );
    assert.ok(m, `追加段格式不符：${JSON.stringify(tail)}`);
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m![1]),
      `时间戳应为 ISO 串，实际 ${m![1]}`,
    );
    assert.equal(note.savedCount, 1);
    assert.equal(w.notes.length, 1, "追加不得顺手新建第二条笔记（反向用例）");
  }),
);

test(
  "saveNote·append：新增内容过白名单，原文里的既有内容不被改写（追加不修复原文）",
  withWorld(async (w) => {
    const original = "<p>旧</p><script>legacy()</script>";
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: original,
    });
    w.item1.children.push(note.id);
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: '<p onclick="x">新</p><script>evil()</script>',
    });
    assert.equal(res.ok, true);
    assert.ok(note.html.startsWith(original), "原文（含 legacy 内容）保持原样");
    const tail = note.html.slice(original.length);
    assert.ok(tail.includes("<p>新</p>"), "新增段落保留");
    assert.ok(!tail.includes("onclick"), "新增内容事件属性剥掉");
    assert.ok(!tail.includes("evil"), "新增内容 script 丢弃");
  }),
);

test(
  "saveNote·append：连续两次追加 → 两段 hr、两次内容都在（累积语义）",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>底</p>",
    });
    w.item1.children.push(note.id);
    await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>一</p>",
    });
    await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>二</p>",
    });
    assert.equal((note.html.match(/<hr>/g) ?? []).length, 2, "两段 hr");
    assert.ok(note.html.includes("<p>一</p><hr>"), "第一次追加夹在中间");
    assert.ok(note.html.startsWith("<p>底</p>"));
    assert.ok(note.html.endsWith("<p>二</p>"));
  }),
);

test(
  "saveNote·append：noteKey 指向别的条目的笔记 → NOTE_NOT_FOUND，且该笔记一字不动",
  withWorld(async (w) => {
    const foreign = w.addNote({
      parentItemID: w.item2.id,
      key: "FOREIGN",
      html: "<p>别人的笔记</p>",
    });
    w.item2.children.push(foreign.id);
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "FOREIGN",
      html: "<p>越权写入</p>",
    });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "NOTE_NOT_FOUND");
    assert.equal(foreign.html, "<p>别人的笔记</p>", "越权目标不得被改动");
    assert.equal(foreign.setNoteCalls.length, 0, "不得对越权笔记调用 setNote");
  }),
);

test(
  "saveNote·append：noteKey 不存在/非字符串/缺失 → NOTE_NOT_FOUND，不写库",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>底</p>",
    });
    w.item1.children.push(note.id);
    for (const key of ["GHOST", "", undefined, null, 42]) {
      const res = await saveNote({
        itemKey: "ITEM1",
        mode: "append",
        noteKey: key as unknown as string,
        html: "<p>x</p>",
      });
      assert.equal(res.ok, false, `noteKey=${String(key)} 应失败`);
      assert.equal(res.ok === false && res.code, "NOTE_NOT_FOUND");
    }
    assert.equal(note.html, "<p>底</p>", "失败路径不得改动任何笔记");
  }),
);

test(
  "saveNote·append：noteKey 指向非笔记子项（getNotes 不含）→ NOTE_NOT_FOUND",
  withWorld(async (w) => {
    // 目标条目下确实有个对象叫 "N9"，但它不在 getNotes() 清单里（模拟非笔记子项 / 已删笔记）
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N9",
      html: "<p>x</p>",
    });
    assert.equal(res.ok === false && res.code, "NOTE_NOT_FOUND");
  }),
);

test(
  "saveNote·append：笔记被删（getNotes 已不含）→ NOTE_NOT_FOUND",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>底</p>",
    });
    w.item1.children.push(note.id);
    w.unregister(note.id); // 笔记被删
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>x</p>",
    });
    assert.equal(res.ok === false && res.code, "NOTE_NOT_FOUND");
  }),
);

test(
  "saveNote·append：内容经消毒后为空 → SANITIZE_REJECTED，笔记一字不动",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>底</p>",
    });
    w.item1.children.push(note.id);
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<script>bad()</script>",
    });
    assert.equal(res.ok === false && res.code, "SANITIZE_REJECTED");
    assert.equal(note.setNoteCalls.length, 0, "不得 setNote（不写半截）");
    assert.equal(note.html, "<p>底</p>");
  }),
);

test(
  "saveNote·append：setNote 抛错 → SAVE_FAILED 且带异常原文",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>底</p>",
    });
    w.item1.children.push(note.id);
    note.failSetNote = new Error("read-only note");
    const res = await saveNote({
      itemKey: "ITEM1",
      mode: "append",
      noteKey: "N1",
      html: "<p>x</p>",
    });
    assert.equal(res.ok === false && res.code, "SAVE_FAILED");
    assert.ok(res.ok === false && res.message.includes("read-only note"));
  }),
);

// ---- listNotes ----

test(
  "listNotes：返回目标条目的笔记清单（noteKey/title/updatedAt），按修改时间倒序",
  withWorld(async (w) => {
    const older = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      title: "旧",
      dateModified: "2026-09-10 08:00:00",
    });
    const newer = w.addNote({
      parentItemID: w.item1.id,
      key: "N2",
      title: "新",
      dateModified: "2026-09-11 08:00:00",
    });
    w.item1.children.push(older.id, newer.id);
    const res = await listNotes("ITEM1");
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok ? res.notes : null, [
      {
        noteKey: "N2",
        title: "新",
        updatedAt: Date.parse("2026-09-11T08:00:00Z"),
      },
      {
        noteKey: "N1",
        title: "旧",
        updatedAt: Date.parse("2026-09-10T08:00:00Z"),
      },
    ]);
  }),
);

test(
  "listNotes：只列目标条目自己的子笔记（别的条目的笔记不出现）",
  withWorld(async (w) => {
    const mine = w.addNote({ parentItemID: w.item1.id, key: "MINE" });
    const theirs = w.addNote({ parentItemID: w.item2.id, key: "THEIRS" });
    w.item1.children.push(mine.id);
    w.item2.children.push(theirs.id);
    const res = await listNotes("ITEM1");
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok ? res.notes.map((n) => n.noteKey) : null, ["MINE"]);
  }),
);

test(
  "listNotes：title 超 80 字符截断；getNoteTitle 抛错回落空串",
  withWorld(async (w) => {
    const long = w.addNote({
      parentItemID: w.item1.id,
      key: "LONG",
      title: "题".repeat(200),
    });
    const broken = w.addNote({ parentItemID: w.item1.id, key: "BROKEN" });
    (broken as unknown as { getNoteTitle: () => string }).getNoteTitle = () => {
      throw new Error("no title");
    };
    w.item1.children.push(long.id, broken.id);
    const res = await listNotes("ITEM1");
    assert.equal(res.ok, true);
    const byKey = new Map((res.ok ? res.notes : []).map((n) => [n.noteKey, n]));
    assert.equal(byKey.get("LONG")?.title.length, 80);
    assert.equal(byKey.get("BROKEN")?.title, "");
  }),
);

test(
  "listNotes：失效子项（Items.get 拿不到）跳过，不崩",
  withWorld(async (w) => {
    const alive = w.addNote({ parentItemID: w.item1.id, key: "ALIVE" });
    const dead = w.addNote({ parentItemID: w.item1.id, key: "DEAD" });
    w.item1.children.push(alive.id, dead.id);
    w.unregister(dead.id);
    const res = await listNotes("ITEM1");
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok ? res.notes.map((n) => n.noteKey) : null, [
      "ALIVE",
    ]);
  }),
);

test(
  "listNotes：itemKey 非法/查无 → ITEM_NOT_FOUND",
  withWorld(async () => {
    for (const key of ["", undefined, null, 42, "NOPE"]) {
      const res = await listNotes(key as unknown as string);
      assert.equal(res.ok, false, `itemKey=${String(key)} 应失败`);
      assert.equal(res.ok === false && res.code, "ITEM_NOT_FOUND");
    }
  }),
);

test(
  "listNotes：getNotes 抛错 → SAVE_FAILED（不崩、码明确）",
  withWorld(async (w) => {
    w.item1.failGetNotes = new Error("corrupt");
    const res = await listNotes("ITEM1");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "SAVE_FAILED");
    assert.ok(w.logs.some((l) => l.includes("corrupt")));
  }),
);

test(
  "saveNote/listNotes：馆藏枚举抛错（Libraries.getAll 故障）→ 不崩，回 ITEM_NOT_FOUND",
  withWorld(async (w) => {
    (w.zotero.Libraries as { getAll(): unknown }).getAll = () => {
      throw new Error("library index broken");
    };
    const saved = await saveNote({
      itemKey: "ITEM1",
      mode: "new",
      html: "<p>x</p>",
    });
    assert.equal(saved.ok === false && saved.code, "ITEM_NOT_FOUND");
    const listed = await listNotes("ITEM1");
    assert.equal(listed.ok === false && listed.code, "ITEM_NOT_FOUND");
    assert.equal(w.notes.length, 0, "故障路径不得写库");
  }),
);

test(
  "listNotes：目标条目无笔记 → 空清单（ok:true）",
  withWorld(async () => {
    const res = await listNotes("ITEM1");
    assert.deepEqual(res, { ok: true, notes: [] });
  }),
);
