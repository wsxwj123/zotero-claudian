// 单测 — src/chat/lib/markdown.ts 的图形分段与渲染（原生 svg 块 / mermaid 标记）
// 覆盖：分段规则（围栏内/缩进代码块/行内不认）、内联渲染与退回源码、笔记路径（renderSvg:false）、
// mermaid 块只落源码标记、fail-closed 不变。Node 无 DOM：sanitizer 用替身注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MERMAID_BLOCK_CLASS,
  SVG_BLOCK_CLASS,
  SVG_GUARD_CONFIG,
  guardSvg,
  renderMarkdown,
  setSanitizer,
  setSvgGuard,
  splitSvgBlocks,
} from "../../src/chat/lib/markdown.ts";

/** 替身消毒器：只做「不许出现 script」的粗校验，便于观察管线拼装（真实 DOMPurify 在页面侧） */
function fakeSanitizer(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "");
}

function render(md: string, opts?: { renderSvg?: boolean }): string {
  setSanitizer(fakeSanitizer);
  return renderMarkdown(md, opts);
}

// ---- splitSvgBlocks：分段规则 ----

test("分段: 纯 markdown → 单个 md 片段", () => {
  const segs = splitSvgBlocks("普通段落\n\n- 列表\n");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "md");
});

test("分段: 行首 svg 块被切出来（前后文本各自成段）", () => {
  const md =
    '上文\n\n<svg viewBox="0 0 1 1">\n<rect width="1" height="1"/>\n</svg>\n\n下文\n';
  const segs = splitSvgBlocks(md);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ["md", "svg", "md"],
  );
  assert.ok(segs[1].text.startsWith('<svg viewBox="0 0 1 1">'), segs[1].text);
  assert.ok(segs[1].text.trimEnd().endsWith("</svg>"), segs[1].text);
  assert.ok(segs[0].text.includes("上文"));
  assert.ok(segs[2].text.includes("下文"));
});

test("分段: svg/xml/html 围栏里「只有一个 svg」→ 按图渲染（真机实测的真实习惯）", () => {
  for (const info of ["svg", "xml", "html"]) {
    const md = `\`\`\`${info}\n<svg viewBox="0 0 1 1"><rect/></svg>\n\`\`\`\n`;
    const segs = splitSvgBlocks(md);
    assert.equal(segs.filter((s) => s.kind === "svg").length, 1, info);
    assert.ok(segs[0].text.includes("<rect/>"), info);
  }
  // 围栏里夹着别的 HTML/文本 → 是代码示例，不是图
  const withText = "```html\n<div>x</div>\n<svg><rect/></svg>\n```\n";
  assert.deepEqual(
    splitSvgBlocks(withText).map((s) => s.kind),
    ["md"],
  );
  const textAfter = "```html\n<svg><rect/></svg>\n后面还有字\n```\n";
  assert.deepEqual(
    splitSvgBlocks(textAfter).map((s) => s.kind),
    ["md"],
  );
});

test("分段: 普通语言围栏、未闭合围栏、~~~ 围栏原样交回（不误切）", () => {
  const js = "```js\nconst s = '<svg><rect/></svg>';\n```\n";
  assert.deepEqual(
    splitSvgBlocks(js).map((s) => s.kind),
    ["md"],
  );
  const unclosed = "```html\n<svg><rect/></svg>\n";
  assert.deepEqual(
    splitSvgBlocks(unclosed).map((s) => s.kind),
    ["md"],
  );
  const tilde = '~~~\n<svg><rect/></svg>\n~~~\n\n<svg><circle r="1"/></svg>\n';
  const segs = splitSvgBlocks(tilde);
  assert.equal(segs.filter((s) => s.kind === "svg").length, 1);
  assert.ok(segs.every((s) => s.kind !== "svg" || s.text.includes("circle")));
});

test("分段: 4 空格缩进（缩进代码块）与行内出现都不切", () => {
  assert.deepEqual(
    splitSvgBlocks("    <svg><rect/></svg>\n").map((s) => s.kind),
    ["md"],
  );
  assert.deepEqual(
    splitSvgBlocks("看这个 <svg><rect/></svg> 图示\n").map((s) => s.kind),
    ["md"],
  );
});

test("分段: 嵌套 svg 一次切净；未闭合则不切（fail-closed 交给原管线）", () => {
  const nested = '<svg><svg viewBox="0 0 1 1"><rect/></svg></svg>\n';
  const segs = splitSvgBlocks(nested);
  assert.equal(segs[0].kind, "svg");
  assert.equal(segs[0].text, nested.trimEnd());
  assert.ok(segs.slice(1).every((s) => s.text.trim() === ""));
  assert.deepEqual(
    splitSvgBlocks("<svg><rect/>\n没有闭合\n").map((s) => s.kind),
    ["md"],
  );
});

test("分段: </svg> 之后的同行文本归回 markdown", () => {
  const segs = splitSvgBlocks("<svg><rect/></svg>\n后一行\n");
  assert.deepEqual(
    segs.map((s) => s.kind),
    ["svg", "md"],
  );
  assert.ok(segs[1].text.includes("后一行"));
});

// ---- renderMarkdown：渲染与退回 ----

test("渲染: 原生 svg 消毒后内联（包在 md-svg 容器里，不进 DOMPurify 白名单）", () => {
  const out = render(
    '前后\n\n<svg viewBox="0 0 4 4"><rect width="4" height="4" fill="#0f0"/></svg>\n',
  );
  assert.ok(out.includes(`<div class="${SVG_BLOCK_CLASS}">`), out);
  assert.ok(out.includes('<rect width="4" height="4" fill="#0f0">'), out);
  assert.ok(!out.includes("<script"), out);
  assert.ok(out.includes("<p>前后</p>"), out);
});

test("渲染: 恶意 svg 消毒后只剩干净图形，无执行面", () => {
  const out = render(
    '<svg onload="alert(1)"><script>alert(2)</script><foreignObject><b>x</b></foreignObject><rect width="1" height="1"/></svg>\n',
  );
  assert.ok(!out.includes("onload"), out);
  assert.ok(!out.includes("script"), out);
  assert.ok(!out.includes("foreignobject"), out);
  assert.ok(out.includes("<rect"), out);
});

test("渲染: 消毒后什么都不剩 → 退回源码展示（不白屏、不吞内容）", () => {
  const src = "<svg><foo><bar/></foo></svg>";
  const out = render(src + "\n");
  assert.ok(out.includes('<pre><code class="hljs">'), out);
  assert.ok(out.includes("&lt;svg&gt;"), out);
  assert.ok(!out.includes("<svg"), out);
});

test("渲染: renderSvg:false（笔记落库路径）→ 一律源码文本，不内联 svg", () => {
  const out = render(
    '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n',
    {
      renderSvg: false,
    },
  );
  assert.ok(!out.includes("<svg"), out);
  assert.ok(out.includes("&lt;svg"), out);
});

test("渲染: mermaid 代码块落成带标记的源码块（渲染失败即源码，页面对它做二次替换）", () => {
  const out = render("```mermaid\ngraph TD\n  A-->B\n```\n");
  assert.ok(out.includes(`<pre class="${MERMAID_BLOCK_CLASS}">`), out);
  assert.ok(out.includes('class="hljs"'), out);
  assert.ok(out.includes("graph TD"), out);
  // 源码是转义文本，不是标签
  const evil = render("```mermaid\n<script>alert(1)</script>\n```\n");
  assert.ok(!evil.includes("<script"), evil);
  assert.ok(evil.includes("&lt;script&gt;"), evil);
});

test("渲染: 非 mermaid 代码块不带标记类（不误触发二次渲染）", () => {
  const out = render("```python\nprint(1)\n```\n");
  assert.ok(!out.includes(MERMAID_BLOCK_CLASS), out);
  assert.ok(out.includes('class="hljs language-python"'), out);
});

test("渲染: fail-closed 不变（未初始化 sanitizer 抛错）", () => {
  setSanitizer(null);
  assert.throws(
    () => renderMarkdown("<svg><rect/></svg>"),
    /sanitizer not initialized/,
  );
});

// ---- 第二道防线：DOMPurify SVG 兜底层（注入式；node 侧注入 fake 验证调用链）----

/** 假兜底层：记录收到的输入，并按脚本做减法（模拟「成熟库再剥一层」） */
function fakeGuard(behavior: (svg: string) => string) {
  const seen: string[] = [];
  const fn = (svg: string): string => {
    seen.push(svg);
    return behavior(svg);
  };
  return { fn, seen };
}

test("兜底: svg 先过自写消毒器、再过注入的 DOM 层（顺序可证）", () => {
  const guard = fakeGuard((svg) => svg.replace("XSS-MARK", ""));
  setSvgGuard(guard.fn);
  setSanitizer(fakeSanitizer);
  renderMarkdown('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n');
  // 兜底层拿到的必须是自写器的产物（带配平闭合），不是原文（原文是自闭合 rect/）
  assert.equal(guard.seen.length, 1);
  assert.ok(
    guard.seen[0].includes('<rect width="1" height="1">'),
    guard.seen[0],
  );
  assert.ok(
    !guard.seen[0].includes('<rect width="1" height="1"/>'),
    guard.seen[0],
  );
  setSvgGuard(null);
});

test("兜底: DOM 层再剥一层后返回空 → 退回源码块（不白屏）", () => {
  setSvgGuard(() => ""); // 模拟兜底层把内容全剥了
  setSanitizer(fakeSanitizer);
  const out = renderMarkdown(
    '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n',
  );
  assert.ok(!out.includes("<div class="), out);
  assert.ok(out.includes('<pre><code class="hljs">'), out);
  assert.ok(out.includes("&lt;svg"), out);
  setSvgGuard(null);
});

test("兜底: DOM 层把危险残留剥掉（自写器若有漏，这层是最后一道）", () => {
  // 直接对 guardSvg 断言：模拟「自写器漏了 xx」的产物进兜底层
  setSvgGuard((svg) => svg.replace(/onload="[^"]*"/g, ""));
  const leaked =
    '<svg onload="alert(1)"><rect width="1" height="1"></rect></svg>';
  assert.ok(!guardSvg(leaked).includes("onload"));
  setSvgGuard(null);
});

test("兜底: 未注入时跳过该层（自写器仍是主门，管线不空转）", () => {
  setSvgGuard(null);
  setSanitizer(fakeSanitizer);
  const out = renderMarkdown('<svg><rect width="1" height="1"/></svg>\n');
  assert.ok(out.includes("<rect"), out);
  assert.equal(
    guardSvg("<svg><rect></rect></svg>"),
    "<svg><rect></rect></svg>",
  );
  assert.equal(guardSvg(""), "");
});

test("兜底: 配置钉死到与自写器一致（标签/属性白名单 + 危险族显式拉黑）", () => {
  // 标签白名单：必须含正常图形标签（含 style，mermaid 配色），且不含任何执行/外联面
  for (const t of [
    "svg",
    "g",
    "path",
    "rect",
    "text",
    "marker",
    "lineargradient",
    "style",
  ]) {
    assert.ok(SVG_GUARD_CONFIG.ALLOWED_TAGS.includes(t), `白名单缺 ${t}`);
  }
  for (const t of [
    "script",
    "use",
    "image",
    "foreignobject",
    "iframe",
    "filter",
    "animate",
    "animatetransform",
    "animatemotion",
    "set",
    "a",
    "clipPath".toLowerCase(),
  ]) {
    assert.ok(
      !SVG_GUARD_CONFIG.ALLOWED_TAGS.includes(t),
      `${t} 不该在兜底层白名单`,
    );
    assert.ok(
      SVG_GUARD_CONFIG.FORBID_TAGS.includes(t),
      `${t} 应在 FORBID_TAGS`,
    );
  }
  // 属性白名单同样是小写形态（DOMPurify 比对统一小写），且不含 URL/事件面
  for (const a of [
    "viewbox",
    "class",
    "id",
    "style",
    "marker-end",
    "d",
    "transform",
  ]) {
    assert.ok(SVG_GUARD_CONFIG.ALLOWED_ATTR.includes(a), `属性白名单缺 ${a}`);
  }
  for (const a of [
    "href",
    "xlink:href",
    "src",
    "srcset",
    "data",
    "action",
    "formaction",
    "ping",
  ]) {
    assert.ok(
      SVG_GUARD_CONFIG.FORBID_ATTR.includes(a),
      `${a} 应在 FORBID_ATTR`,
    );
  }
  assert.equal(SVG_GUARD_CONFIG.ALLOW_DATA_ATTR, false);
});
