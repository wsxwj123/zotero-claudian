// 复核轮（m7-review）—— 两条写入路径的端到端自查（伪造消息直打）：
//   A. chat 路径：UI 消息 → hostBridge → 真 notes.ts → （假）Zotero 写库
//   B. 划选路径：阅读器弹窗按钮 → contextSource → 真 notes.ts → 写库（不经桥）
// 独立性：假件在 ./fakes.ts（本轮自写）；真 hostBridge / 真 notes 参与链路，验证的是真实接线。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
} from "../../../src/modules/hostBridge.ts";
import { registerSelectionNoteButton } from "../../../src/modules/contextSource.ts";
import type { SaveNoteInput } from "../../../src/modules/notes.ts";
import {
  FakeEl,
  installFakeUtilities,
  makeBridgeHarness,
  tick,
  withWorld,
  type FakeZoteroWorld,
} from "./fakes.ts";

const TOKEN = "tok-m7";

// ---------- A. chat 路径：桥 → 真 notes ----------

async function connectedBridge(
  w: FakeZoteroWorld,
  overrides: Partial<HostBridgeDeps> = {},
): Promise<{
  bridge: ReturnType<typeof createHostBridge>;
  win: object;
  harness: ReturnType<typeof makeBridgeHarness>;
}> {
  const harness = makeBridgeHarness(w, overrides);
  const bridge = createHostBridge(harness.deps);
  const win = { __fakeWindow: true };
  bridge.beginHandshake(win, TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: TOKEN } });
  await tick();
  return { bridge, win, harness };
}

test(
  "桥·chat 路径：伪造消息送恶意 HTML → 落库内容已过白名单终检",
  withWorld(async (w) => {
    const { bridge, win, harness } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "new",
        html: '<p onclick="steal()">正文</p><script>alert(1)</script><img src="https://e/a.png" onerror="evil()">',
      },
    });
    await tick();
    const stored = w.notes[0]?.html ?? "";
    assert.equal(
      stored,
      '<p>正文</p><img src="https://e/a.png">',
      "落库必须是消毒产物",
    );
    assert.ok(!stored.includes("onerror") && !stored.includes("script"));
    assert.equal(harness.lastOf("noteSaved")?.ok, true);
  }),
);

test(
  "桥·chat 路径（对抗）：伪造消息送 Unicode 错位向量 → 落库不得含事件属性",
  withWorld(async (w) => {
    const { bridge, win } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "new",
        html: "İ<img src=x onerror=alert(1)>",
      },
    });
    await tick();
    const stored = w.notes[0]?.html ?? "";
    assert.ok(
      !/\bon\w+\s*=/i.test(stored),
      `落库残留事件属性：${JSON.stringify(stored)}`,
    );
    assert.ok(
      !/<img\s/i.test(stored),
      `落库残留未消毒标签：${JSON.stringify(stored)}`,
    );
  }),
);

test(
  "桥·chat 路径（对抗）：伪造消息送截断标签向量 → 落库不得含事件属性",
  withWorld(async (w) => {
    const { bridge, win } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "new",
        html: "<img src=x onerror=alert(1)",
      },
    });
    await tick();
    const stored = w.notes[0]?.html ?? "";
    assert.ok(
      !/\bon\w+\s*=/i.test(stored),
      `落库残留事件属性：${JSON.stringify(stored)}`,
    );
  }),
);

test(
  "桥·chat 路径：append 追加落到目标子笔记，新增段消毒、原文不动",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      html: "<p>已有原文</p>",
    });
    w.item1.children.push(note.id);
    const { bridge, win, harness } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "append",
        noteKey: "N1",
        html: '<p onclick="x">追加段</p>',
      },
    });
    await tick();
    assert.ok(note.html.startsWith("<p>已有原文</p>"), "原文必须保留");
    assert.ok(note.html.includes("<p>追加段</p>"), "新增段入正文");
    assert.ok(!note.html.includes("onclick"), "新增段事件属性已剥");
    assert.equal(harness.lastOf("noteSaved")?.ok, true);
    assert.equal(harness.lastOf("noteSaved")?.noteKey, "N1");
  }),
);

test(
  "桥·chat 路径：伪造消息越权追加（noteKey 指向别的条目）→ NOTE_NOT_FOUND 回包",
  withWorld(async (w) => {
    const foreign = w.addNote({
      parentItemID: w.item2.id,
      key: "FOREIGN",
      html: "<p>别人的</p>",
    });
    w.item2.children.push(foreign.id);
    const { bridge, win, harness } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "append",
        noteKey: "FOREIGN",
        html: "<p>越权</p>",
      },
    });
    await tick();
    assert.equal(harness.lastOf("noteSaved")?.code, "NOTE_NOT_FOUND");
    assert.equal(foreign.html, "<p>别人的</p>", "越权目标不得被改");
  }),
);

test(
  "桥·畸形入参：缺 itemKey / itemKey 非字符串 → 回 ITEM_NOT_FOUND（不悬挂）",
  withWorld(async (w) => {
    const { bridge, win, harness } = await connectedBridge(w);
    const cases: Record<string, unknown>[] = [
      { type: "saveNote", mode: "new", html: "<p>x</p>" },
      { type: "saveNote", itemKey: 42, mode: "new", html: "<p>x</p>" },
      { type: "saveNote", itemKey: null, mode: "new", html: "<p>x</p>" },
      {
        type: "saveNote",
        itemKey: { k: "ITEM1" },
        mode: "new",
        html: "<p>x</p>",
      },
    ];
    for (const data of cases) {
      harness.sent.length = 0;
      bridge.dispatch({ source: win, data });
      await tick();
      assert.equal(
        harness.lastOf("noteSaved")?.code,
        "ITEM_NOT_FOUND",
        `入参 ${JSON.stringify(data)} 应回 ITEM_NOT_FOUND`,
      );
    }
    assert.equal(w.notes.length, 0, "畸形入参不得写库");
  }),
);

test(
  "桥·畸形入参：html 非字符串/空 → EMPTY_CONTENT；纯脚本 → SANITIZE_REJECTED",
  withWorld(async (w) => {
    const { bridge, win, harness } = await connectedBridge(w);
    for (const html of [123, null, undefined, "", "   "]) {
      harness.sent.length = 0;
      bridge.dispatch({
        source: win,
        data: { type: "saveNote", itemKey: "ITEM1", mode: "new", html },
      });
      await tick();
      assert.equal(
        harness.lastOf("noteSaved")?.code,
        "EMPTY_CONTENT",
        `html=${JSON.stringify(html)} 应回 EMPTY_CONTENT`,
      );
    }
    harness.sent.length = 0;
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "new",
        html: "<script>x</script>",
      },
    });
    await tick();
    assert.equal(harness.lastOf("noteSaved")?.code, "SANITIZE_REJECTED");
    assert.equal(w.notes.length, 0, "拒绝路径不得写库");
  }),
);

test(
  "桥·畸形入参：append 缺 noteKey/noteKey 非字符串 → NOTE_NOT_FOUND",
  withWorld(async (w) => {
    const { bridge, win, harness } = await connectedBridge(w);
    for (const noteKey of [undefined, null, 42, "", {}]) {
      harness.sent.length = 0;
      bridge.dispatch({
        source: win,
        data: {
          type: "saveNote",
          itemKey: "ITEM1",
          mode: "append",
          noteKey,
          html: "<p>x</p>",
        },
      });
      await tick();
      assert.equal(
        harness.lastOf("noteSaved")?.code,
        "NOTE_NOT_FOUND",
        `noteKey=${JSON.stringify(noteKey)} 应回 NOTE_NOT_FOUND`,
      );
    }
    assert.equal(w.notes.length, 0);
  }),
);

test(
  "桥·畸形入参：mode 非法 → 忽略（不回包、不调 notes）",
  withWorld(async (w) => {
    const calls: SaveNoteInput[] = [];
    const { bridge, win, harness } = await connectedBridge(w, {
      notes: {
        saveNote: async (input) => {
          calls.push(input);
          return { ok: true, noteKey: "X" };
        },
        listNotes: async () => ({ ok: true, notes: [] }),
      },
    });
    for (const mode of ["new2", "New", "append ", "", null, 1, {}]) {
      bridge.dispatch({
        source: win,
        data: { type: "saveNote", itemKey: "ITEM1", mode, html: "<p>x</p>" },
      });
    }
    await tick();
    assert.equal(calls.length, 0, "非法 mode 不得触发写库");
    assert.equal(harness.lastOf("noteSaved"), undefined, "非法 mode 不回包");
  }),
);

test(
  "桥·消息来源：未注册实例发 saveNote/listNotes → 忽略（不回包、不写库）",
  withWorld(async (w) => {
    const harness = makeBridgeHarness(w);
    const bridge = createHostBridge(harness.deps);
    const stranger = { __fakeWindow: "stranger" };
    bridge.dispatch({
      source: stranger,
      data: {
        type: "saveNote",
        itemKey: "ITEM1",
        mode: "new",
        html: "<p>x</p>",
      },
    });
    bridge.dispatch({
      source: stranger,
      data: { type: "listNotes", itemKey: "ITEM1" },
    });
    await tick();
    assert.equal(harness.sent.length, 0, "未注册来源不得收到任何回包");
    assert.equal(w.notes.length, 0, "未注册来源不得触发写库");
  }),
);

test(
  "桥·listNotes：正常回 noteList；itemKey 畸形 → error ITEM_NOT_FOUND",
  withWorld(async (w) => {
    const note = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      title: "甲",
    });
    w.item1.children.push(note.id);
    const { bridge, win, harness } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: { type: "listNotes", itemKey: "ITEM1" },
    });
    await tick();
    const list = harness.lastOf("noteList");
    assert.deepEqual((list as { notes?: unknown }).notes, [
      {
        noteKey: "N1",
        title: "甲",
        updatedAt: Date.parse("2026-09-11T08:00:00Z"),
      },
    ]);
    harness.sent.length = 0;
    bridge.dispatch({ source: win, data: { type: "listNotes" } });
    await tick();
    assert.equal(harness.lastOf("error")?.code, "ITEM_NOT_FOUND");
  }),
);

test(
  "桥·消息类型：未知 type 忽略（不影响 M7 链路）",
  withWorld(async (w) => {
    const { bridge, win, harness } = await connectedBridge(w);
    bridge.dispatch({
      source: win,
      data: {
        type: "saveNoteEvil",
        itemKey: "ITEM1",
        mode: "new",
        html: "<p>x</p>",
      },
    });
    await tick();
    assert.equal(harness.lastOf("noteSaved"), undefined);
    assert.equal(w.notes.length, 0);
  }),
);

// ---------- B. 划选路径：阅读器弹窗按钮 → contextSource → 真 notes ----------

let capturedHandler: ((ev: unknown) => void) | null = null;

/** 注册一次即捕获事件回调（模块级注册幂等；回调内部走全局 Zotero，跨测试仍指向当前世界） */
function selectionHandlerOf(w: FakeZoteroWorld): (ev: unknown) => void {
  if (capturedHandler) return capturedHandler;
  w.zotero.Reader = {
    registerEventListener: (_type: string, handler: (ev: unknown) => void) => {
      capturedHandler = handler;
    },
  };
  registerSelectionNoteButton();
  if (!capturedHandler) throw new Error("划选按钮未注册成功");
  return capturedHandler;
}

interface PopupCapture {
  appended: FakeEl | null;
  container: FakeEl | null;
}

/** 触发一次划选弹窗渲染；返回 append 进去的容器（默认挂 world 的 ITEM1） */
function renderPopup(
  handler: (ev: unknown) => void,
  w: FakeZoteroWorld,
  opts: {
    itemID?: number | null;
    text?: string;
    pageLabel?: string;
  } = {},
): PopupCapture {
  const cap: PopupCapture = { appended: null, container: null };
  const doc = { createElement: (tag: string) => new FakeEl(tag) };
  handler({
    reader: { itemID: opts.itemID === undefined ? w.item1.id : opts.itemID },
    doc,
    params: {
      annotation: {
        text: opts.text ?? "划选的一段话",
        pageLabel: opts.pageLabel ?? "3",
      },
    },
    append: (el: FakeEl) => {
      cap.appended = el;
      cap.container = el;
    },
  });
  return cap;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test(
  "划选路径：弹窗按钮「存为笔记」→ 新建 → 落库格式为 blockquote + 页码小字（已消毒）",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const handler = selectionHandlerOf(w);
    const cap = renderPopup(handler, w, {
      text: "结论：X 有效",
      pageLabel: "3",
    });
    const btn = cap.appended?.find((e) => e.tagName === "button");
    assert.ok(btn, "弹窗里应出现按钮");
    assert.equal(btn?.textContent, "存为笔记");

    btn!.fire("click"); // 点按钮 → 打开选择器（listNotes）
    await settle();
    const newBtn = cap.container?.find(
      (e) => e.tagName === "button" && e.textContent === "新建笔记",
    );
    assert.ok(newBtn, "选择器应含「新建笔记」");
    newBtn!.fire("click"); // 选新建 → saveNote
    await settle();

    const stored = w.notes[0]?.html ?? "";
    assert.equal(
      stored,
      "<blockquote><p>结论：X 有效</p></blockquote><p><small>第 3 页</small></p>",
      "落库形态：引用块 + 页码小字（页码只转义、不 text2html 包 <p>）",
    );
    assert.equal(cap.container?.textContent, "已存为笔记 ✓");
  }),
);

test(
  "划选路径：无页码 → 不产出页码行",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const handler = selectionHandlerOf(w);
    const cap = renderPopup(handler, w, { text: "只有正文", pageLabel: "" });
    cap.appended!.find((e) => e.tagName === "button")!.fire("click");
    await settle();
    cap
      .container!.find(
        (e) => e.tagName === "button" && e.textContent === "新建笔记",
      )!
      .fire("click");
    await settle();
    assert.equal(w.notes[0]?.html, "<blockquote><p>只有正文</p></blockquote>");
  }),
);

test(
  "划选路径：已有笔记时可追加到选中项；按钮标题用笔记标题",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const existing = w.addNote({
      parentItemID: w.item1.id,
      key: "N1",
      title: "既有笔记",
      html: "<p>底</p>",
    });
    w.item1.children.push(existing.id);
    // 目标条目：reader.itemID=9 挂父条目 ITEM1
    const child = w.addRegularItem("ATT9", 1, { key: "ITEM1" });
    const handler = selectionHandlerOf(w);
    const cap = renderPopup(handler, w, { itemID: child.id, text: "追加内容" });
    cap.appended!.find((e) => e.tagName === "button")!.fire("click");
    await settle();
    const appendBtn = cap.container!.find(
      (e) => e.tagName === "button" && e.textContent.includes("追加到"),
    );
    assert.ok(appendBtn, "选择器应含追加按钮");
    assert.ok(appendBtn!.textContent.includes("既有笔记"));
    appendBtn!.fire("click");
    await settle();
    assert.ok(existing.html.startsWith("<p>底</p>"), "原文保留");
    assert.ok(
      existing.html.includes("<blockquote><p>追加内容</p></blockquote>"),
      "新内容进追加段",
    );
    assert.equal(cap.container!.textContent, "已存为笔记 ✓");
  }),
);

test(
  "划选路径（对抗）：上游转义失效（text2html 不转义）时，落库仍被宿主终检消毒",
  withWorld(async (w) => {
    installFakeUtilities(w, (s) => s); // 模拟转义层失效：原文直通
    const handler = selectionHandlerOf(w);
    const cap = renderPopup(handler, w, {
      text: "<img src=x onerror=alert(1)>",
      pageLabel: "1",
    });
    cap.appended!.find((e) => e.tagName === "button")!.fire("click");
    await settle();
    cap
      .container!.find(
        (e) => e.tagName === "button" && e.textContent === "新建笔记",
      )!
      .fire("click");
    await settle();
    const stored = w.notes[0]?.html ?? "";
    assert.ok(!/\bon\w+\s*=/i.test(stored), `落库残留事件属性：${stored}`);
    assert.ok(
      !/<img\s/i.test(stored),
      `落库残留带属性的 img（属性未被剥）：${stored}`,
    );
    assert.equal(cap.container!.textContent, "已存为笔记 ✓");
  }),
);

test(
  "划选路径：空划选文本 → 不渲染按钮（图片类划选无笔记入口）",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const handler = selectionHandlerOf(w);
    const cap = renderPopup(handler, w, { text: "   " });
    assert.equal(cap.appended, null, "空文本不应 append 任何容器");
  }),
);

test(
  "划选路径：拿不到挂靠条目（itemID 为空/条目不存在）→ 不渲染按钮",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const handler = selectionHandlerOf(w);
    assert.equal(renderPopup(handler, w, { itemID: null }).appended, null);
    assert.equal(renderPopup(handler, w, { itemID: 99999 }).appended, null);
  }),
);

test(
  "划选路径：条目无父条目时挂附件自身；有父条目时挂父条目",
  withWorld(async (w) => {
    installFakeUtilities(w);
    const handler = selectionHandlerOf(w);
    const standalone = w.addRegularItem("STANDALONE", 1, null);
    const child = w.addRegularItem("CHILD", 1, { key: "ITEM1" });
    for (const [item, expectParent] of [
      [standalone, "STANDALONE"],
      [child, "ITEM1"],
    ] as const) {
      const cap = renderPopup(handler, w, { itemID: item.id, text: "x" });
      cap.appended!.find((e) => e.tagName === "button")!.fire("click");
      await settle();
      cap
        .container!.find(
          (e) => e.tagName === "button" && e.textContent === "新建笔记",
        )!
        .fire("click");
      await settle();
      const saved = w.notes.filter(
        (n) => n.parentItemID === item.id || n.html.includes("<blockquote>"),
      );
      assert.ok(saved.length > 0, `itemID=${item.id} 未产生笔记`);
      const last = w.notes[w.notes.length - 1];
      const target = w.zotero.Items as unknown as {
        getByLibraryAndKey(l: number, k: string): { key: string } | null;
      };
      assert.ok(
        target.getByLibraryAndKey(1, expectParent),
        `应挂到 ${expectParent}`,
      );
      assert.equal(last.libraryID, 1);
    }
  }),
);
