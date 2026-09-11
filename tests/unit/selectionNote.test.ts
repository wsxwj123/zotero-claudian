// 单测 — 选段存笔记（用户反馈：「只能把本轮回答的所有内容追加为笔记」→ 要选段粒度）。
// 覆盖：选区非空且落在 assistant 消息内 → 只存选段；选区空/纯空白/在别处/跨消息 → 整轮；
//       跨块选中 → 纯文本拼接原样带上。浮动按钮的出现/消失由 resolveSelectedNote 归约决定
//       （返回 null ↔ 按钮不渲染；真实 DOM 事件路径由真机轮覆盖——仓库无 jsdom）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  noteSourceText,
  resolveSelectedNote,
} from "../../src/chat/lib/selectionNote.ts";

// ---- 伪造 DOM 最小面（真实 Selection/Range/Element 在 node 环境不可得）----

/** 伪造 assistant 消息容器：closest(".msg.assistant") 命中时返回自身 */
function fakeMessage(turnIndex: string | null, isAssistant = true): any {
  const node: any = {
    nodeType: 1,
    getAttribute: (name: string) =>
      name === "data-turn-index" ? turnIndex : null,
  };
  node.closest = (selector: string) =>
    isAssistant && selector === ".msg.assistant" ? node : null;
  return node;
}

/** 伪造选区对象（SelectionLike 结构） */
function fakeSel(opts: {
  text: string;
  ancestor?: unknown;
  collapsed?: boolean;
  rangeCount?: number;
  rangeThrows?: boolean;
}): any {
  return {
    isCollapsed: opts.collapsed ?? false,
    rangeCount: opts.rangeCount ?? 1,
    toString: () => opts.text,
    getRangeAt: () => {
      if (opts.rangeThrows) {
        throw new Error("node removed");
      }
      return { commonAncestorContainer: opts.ancestor ?? null };
    },
  };
}

// ---- resolveSelectedNote：选区 → 可存选段 ----

test("选段：选区落在 assistant 消息内 → 命中（turnIndex + 选中文本）", () => {
  const got = resolveSelectedNote(
    fakeSel({ text: "选中的一段话", ancestor: fakeMessage("2") }),
  );
  assert.deepEqual(got, { turnIndex: 2, text: "选中的一段话" });
});

test("选段：turnIndex=0 是合法下标（首条 assistant 消息）", () => {
  const got = resolveSelectedNote(
    fakeSel({ text: "x", ancestor: fakeMessage("0") }),
  );
  assert.deepEqual(got, { turnIndex: 0, text: "x" });
});

test("选段：选区在非消息区（页面其余部分）→ null（存整轮）", () => {
  const outer: any = { nodeType: 1, closest: () => null };
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "x", ancestor: outer })),
    null,
  );
});

test("选段：选区落在 user 消息内 → null（只认 assistant 回答）", () => {
  const got = resolveSelectedNote(
    fakeSel({ text: "x", ancestor: fakeMessage(null, false) }),
  );
  assert.equal(got, null);
});

test("选段：跨消息划选（公共祖先在消息容器之外）→ null（不把别条消息算进来）", () => {
  // commonAncestorContainer 是 .messages 一类的公共容器：向上 closest 找不到 .msg.assistant
  const shared: any = { nodeType: 1, closest: () => null };
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "A 段\nB 段", ancestor: shared })),
    null,
  );
});

test("选段：纯空白选区（\\n、空格、tab）→ null", () => {
  for (const text of [" ", "\n", " \n\t ", "\u00a0"]) {
    assert.equal(
      resolveSelectedNote(fakeSel({ text, ancestor: fakeMessage("1") })),
      null,
      JSON.stringify(text),
    );
  }
});

test("选段：空文本选区 → null", () => {
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "", ancestor: fakeMessage("1") })),
    null,
  );
});

test("选段：折叠选区（只点击没划选）→ null", () => {
  assert.equal(
    resolveSelectedNote(
      fakeSel({ text: "", ancestor: fakeMessage("1"), collapsed: true }),
    ),
    null,
  );
});

test("选段：无 range（rangeCount=0）→ null", () => {
  assert.equal(
    resolveSelectedNote(
      fakeSel({ text: "x", ancestor: fakeMessage("1"), rangeCount: 0 }),
    ),
    null,
  );
});

test("选段：null 选区（页面无选择对象）→ null", () => {
  assert.equal(resolveSelectedNote(null), null);
});

test("选段：跨块选中 → 浏览器拼接的纯文本原样带上（换行保留）", () => {
  const got = resolveSelectedNote(
    fakeSel({ text: "第一段\n第二段", ancestor: fakeMessage("3") }),
  );
  assert.deepEqual(got, { turnIndex: 3, text: "第一段\n第二段" });
});

test("选段：祖先为文本节点（nodeType=3）→ 从父元素向上找", () => {
  const parent = fakeMessage("4");
  const textNode: any = { nodeType: 3, parentElement: parent };
  const got = resolveSelectedNote(
    fakeSel({ text: "选中", ancestor: textNode }),
  );
  assert.deepEqual(got, { turnIndex: 4, text: "选中" });
});

test("选段：文本节点已脱离文档（parentElement=null）→ null", () => {
  const orphan: any = { nodeType: 3, parentElement: null };
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "x", ancestor: orphan })),
    null,
  );
});

test("选段：容器缺 data-turn-index → null（防 undefined 索引误存）", () => {
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "x", ancestor: fakeMessage(null) })),
    null,
  );
});

test("选段：data-turn-index 非法（空串/非数字/小数/负数）→ null", () => {
  for (const raw of ["", "abc", "2.5", "-1"]) {
    assert.equal(
      resolveSelectedNote(fakeSel({ text: "x", ancestor: fakeMessage(raw) })),
      null,
      raw,
    );
  }
});

test("选段：取 range 抛错（选区节点已被移除）→ null 不抛", () => {
  assert.equal(
    resolveSelectedNote(fakeSel({ text: "x", rangeThrows: true })),
    null,
  );
});

// ---- noteSourceText：「存为笔记」该存什么 ----

const whole = "整轮回答正文";

test("存什么：选区命中本消息 → 只存选段", () => {
  assert.equal(
    noteSourceText(whole, { turnIndex: 1, text: "选段" }, 1),
    "选段",
  );
});

test("存什么：选区命中别条消息 → 整轮（选区不属于这条）", () => {
  assert.equal(
    noteSourceText(whole, { turnIndex: 0, text: "选段" }, 1),
    "整轮回答正文",
  );
});

test("存什么：无选区（null）→ 整轮", () => {
  assert.equal(noteSourceText(whole, null, 1), "整轮回答正文");
});

test("存什么：turnIndex 0 与选段命中同一条（0 不比 falsy 短路）", () => {
  assert.equal(
    noteSourceText(whole, { turnIndex: 0, text: "选段" }, 0),
    "选段",
  );
});
