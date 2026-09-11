// 单测 — R8 折叠口径收窄（用户反馈原话：「为什么现在 AI 的消息会自动折叠？应该是**代码块包裹的内容**
// 自动折叠，**用户的消息超过一定长度后**自动折叠，不是所有内容都折叠」）。
//
// 锁定的口径：
//   ① AI 正文（长到 100 行）→ 不折叠；② AI 代码块 19 行不折 / 21 行折（阈值 20，超过才折）；
//   ③ 用户消息 13 行折 / 11 行不折（沿用 12 行阈值）；④ 同一条 AI 消息里多个代码块各自独立折叠；
//   ⑤ 折叠态是视图态：渲染产物默认折起、不带持久化状态（重画/切会话即复位）；
//   ⑥ 流式期间代码块不折（renderChatMarkdown(md, true)），结束时才折（false）。
// 被测面：src/chat/lib/messageActions.ts（判据）+ src/chat/lib/markdown.ts（renderChatMarkdown 渲染产物）。
// 环境注：Node 无 DOM，真实 DOMPurify 在页面侧；这里注入恒等消毒器观察渲染产物形状（同 markdown.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_COLLAPSE_LINE_THRESHOLD,
  COLLAPSE_LINE_THRESHOLD,
  codeLineCount,
  copyTurnText,
  initialMessageActionState,
  isCodeOverflowing,
  messageBodyCollapsed,
  messageCollapseToggle,
} from "../../src/chat/lib/messageActions.ts";
import {
  renderChatMarkdown,
  renderMarkdown,
  setSanitizer,
} from "../../src/chat/lib/markdown.ts";

setSanitizer((html) => html); // 恒等消毒器：只看折叠容器贴得对不对（消毒本身由 markdown.test.mjs 锁）

/** n 行正文（每行一段） */
const lines = (n, tag = "正文") =>
  Array.from({ length: n }, (_, i) => `${tag}第 ${i + 1} 行`).join("\n");
/** n 行的代码正文（不带围栏 —— 行数判据比的就是它） */
const codeBody = (n) =>
  Array.from({ length: n }, (_, i) => `code_line_${i + 1}`).join("\n");
/** n 行的围栏代码块（围栏内容的行数 = n） */
const fenceLines = (n, lang = "python") =>
  "```" + lang + "\n" + codeBody(n) + "\n```";
/** 去标签后的可见文本（hljs 会把标识符裹进 span，比对内容前先剥掉） */
const plain = (html) => html.replace(/<[^>]+>/g, "");
const aiTurn = (text) => ({
  role: "assistant",
  blocks: [{ blockType: "text", index: 0, text, streaming: false }],
});

const FOLD_RE = /<details class="code-fold">[\s\S]*?<\/details>/g;
const folds = (html) => [...html.matchAll(FOLD_RE)].map((m) => m[0]);

// ---- ① AI 正文恒不折 ----

test("R8 折叠①：AI 正文 100 行 → 不折叠（12 行判据只对用户消息）", () => {
  const text = lines(100);
  assert.equal(text.split("\n").length, 100);
  // 渲染产物里没有折叠容器（foldCodeBlocks 只认 pre>code，正文再长也不贴）
  assert.equal(folds(renderChatMarkdown(text, false)).length, 0);
  // MessageList 用 messageBodyCollapsed 决定 msg-body 的 collapsed 类 → 它必须恒 false
  const s = initialMessageActionState();
  assert.equal(
    messageBodyCollapsed(s, 0, aiTurn(text)),
    false,
    "AI 正文 100 行也不折叠（旧口径按 12 行折，这正是用户投诉的行为）",
  );
  assert.equal(
    messageBodyCollapsed(messageCollapseToggle(s, 0), 0, aiTurn(text)),
    false,
    "展开态与否都恒不折",
  );
  // 对照：同样的 100 行换成用户消息 → 折（阈值还是在的，只是只对用户生效）
  assert.equal(messageBodyCollapsed(s, 0, { role: "user", text }), true);
});

// ---- ② AI 代码块按 20 行折 ----

test("R8 折叠②：代码块 19 行不折、21 行折，头部显示「展开代码（N 行）」", () => {
  assert.equal(CODE_COLLAPSE_LINE_THRESHOLD, 20);
  assert.equal(
    codeLineCount(codeBody(20) + "\n"),
    20,
    "渲染器补的尾部换行不算新行",
  );
  assert.equal(isCodeOverflowing(codeBody(20)), false, "正好 20 行不折");
  assert.equal(isCodeOverflowing(codeBody(19)), false);
  assert.equal(isCodeOverflowing(codeBody(21)), true);

  const md19 = fenceLines(19);
  const html19 = renderChatMarkdown(md19, false);
  assert.equal(folds(html19).length, 0, "19 行不折");
  assert.ok(plain(html19).includes("code_line_19"), "内容照旧渲染");

  const html21 = renderChatMarkdown(fenceLines(21), false);
  const folded = folds(html21);
  assert.equal(folded.length, 1, "21 行 → 折进一个容器");
  assert.ok(
    folded[0].includes("展开代码（21 行）"),
    `头部要有行数，实际 ${folded[0].slice(0, 160)}`,
  );
  assert.ok(folded[0].includes("code-lang"), "头部要有语言");
  assert.ok(
    plain(folded[0]).includes("code_line_21"),
    "折的是容器，代码内容原样在内（展开即完整）",
  );
  assert.ok(folded[0].includes("<pre><code"), "折叠容器包着原来的 pre 代码块");
  // 头部行数与容器里的代码正文一致（展开就是完整 21 行）
  const pre = /<pre[\s\S]*<\/pre>/.exec(folded[0])[0];
  assert.equal(codeLineCount(pre.replace(/<[^>]+>/g, "")), 21);
});

// ---- ③ 用户消息仍按 12 行折 ----

test("R8 折叠③：用户消息 13 行折、11 行不折（沿用阈值 12）", () => {
  assert.equal(COLLAPSE_LINE_THRESHOLD, 12);
  const s = initialMessageActionState();
  const user13 = { role: "user", text: lines(13) };
  const user11 = { role: "user", text: lines(11) };
  assert.equal(messageBodyCollapsed(s, 2, user13), true, "13 行默认折起");
  assert.equal(messageBodyCollapsed(s, 2, user11), false, "11 行不折");
  assert.equal(
    messageBodyCollapsed(messageCollapseToggle(s, 2), 2, user13),
    false,
    "点「展开」看全文（原有语义不变）",
  );
  assert.equal(
    messageBodyCollapsed(s, 2, { role: "divider", text: lines(13) }),
    false,
  );
});

// ---- ④ 同一条 AI 消息里多个代码块各自独立 ----

test("R8 折叠④：同一条 AI 消息里两个代码块各自独立折叠（各是一个容器）", () => {
  const md = [
    "开头一段正文。",
    fenceLines(25, "python"),
    "中间一段正文。",
    fenceLines(3, "bash"),
    "结尾一段正文。",
    fenceLines(22, "javascript"),
  ].join("\n\n");
  const html = renderChatMarkdown(md, false);
  const folded = folds(html);
  assert.equal(folded.length, 2, "超长的两块各有一个容器；3 行的块不折");
  assert.equal(
    (html.match(/<pre/g) ?? []).length,
    3,
    "三个代码块都在（折的是容器不是删内容）",
  );
  // 每个容器只包自己那一块（不共用一个折叠状态）
  assert.equal(folded[0].match(/<pre/g).length, 1);
  assert.equal(folded[1].match(/<pre/g).length, 1);
  assert.ok(folded[0].includes("展开代码（25 行）"));
  assert.ok(folded[1].includes("展开代码（22 行）"));
  const rest = html.replace(FOLD_RE, "");
  assert.ok(rest.includes("language-bash"), "短块（3 行）必须留在折叠容器外");
  assert.ok(
    !rest.includes("language-python") && !rest.includes("language-javascript"),
    "长块必须待在折叠容器里",
  );
});

// ---- ⑤ 折叠态是视图态（默认折起、不持久化） ----

test("R8 折叠⑤：折叠态是视图态 —— 渲染产物默认折起、无持久状态（重画/切会话即复位）", () => {
  const md = fenceLines(30);
  const html = renderChatMarkdown(md, false);
  assert.equal(folds(html).length, 1);
  assert.ok(
    !/<details[^>]*\bopen\b/.test(html),
    "渲染产物不得带 open：没有持久状态 → 重画/切会话回到默认折起",
  );
  assert.equal(
    renderChatMarkdown(md, false),
    html,
    "同输入同输出（纯函数、无累积状态）",
  );
  // 视图态的清理钩子仍是既有那个：切会话重置（展开态不跨会话）
  const reset = initialMessageActionState();
  assert.deepEqual(reset.expanded, []);
});

// ---- ⑥ 流式期间不折，结束才折 ----

test("R8 折叠⑥：流式期间代码块不折（边流边跳），回合结束后才折", () => {
  const md = lines(6) + "\n\n" + fenceLines(30) + "\n\n" + lines(3);
  const during = renderChatMarkdown(md, true);
  assert.equal(folds(during).length, 0, "流式期间不出现折叠容器");
  assert.ok(plain(during).includes("code_line_30"), "流式期间内容照旧完整渲染");
  const after = renderChatMarkdown(md, false);
  assert.equal(folds(after).length, 1, "结束后折");
  assert.ok(folds(after)[0].includes("展开代码（30 行）"));
});

// ---- 既有路径不受影响（笔记 / 导出 / 复制取的是原文） ----

test("R8 折叠：笔记/导出走的 renderMarkdown 不带折叠容器；复制取的仍是 Markdown 源码", () => {
  const md = fenceLines(30);
  assert.equal(
    folds(renderMarkdown(md)).length,
    0,
    "renderMarkdown 原样（笔记/导出路径）",
  );
  const copied = copyTurnText(aiTurn(md));
  assert.equal(copied, md, "复制的是源码原文（含被折起来的代码）");
  assert.ok(!copied.includes("details"), "剪贴板里不得混进折叠容器");
});
