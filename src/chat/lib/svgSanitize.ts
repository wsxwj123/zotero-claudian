// svgSanitize.ts — AI 输出 SVG 的保守消毒器（纯函数，无 DOM，node:test 可测）。
//
// 安全边界（一个不省）：
// 1. 白名单制：只有极少数几何/文本标签能存活，**其余标签整棵子树丢弃**（含内容）——
//    script/foreignObject/iframe/image/use/animate 系/filter 系一律出局（they 要么执行脚本、
//    要么发起外部请求、要么是 HTML 注入的壳体）。
// 2. 属性白名单 + 值字符集双重收紧：on* 一律丢；href/xlink:href 一律丢（防外部引用与
//    javascript: 伪协议）；style 属性只保留「表现类」声明（属性白名单，见 CSS_PROPS）；
//    url(...) 只允许 `url(#本地片段)`。
// 3. 所有输出都是**重新序列化**的：标签/属性名来自白名单常量、属性值重新转义 + 字符集校验，
//    绝不原样回吐输入的任何一段（半截标签、畸形闭合、注释/doctype 都不进输出）。
// 4. `<style>` 元素默认整体丢弃；仅 mermaid 产物（allowStyle）放行，且内容逐条规则校验：
//    选择器必须以本 SVG 的 `#id` 打头（CSS 在 HTML 文档里是全局生效的，靠 id 前缀把它关回本图内），
//    声明必须在 CSS_PROPS 白名单内、值过字符集。
// 5. 输入超长（> MAX_INPUT）直接判空：廉价拒绝，避免病态输入把渲染路径拖住。
//
// 与 src/utils/htmlSanitize.ts 同源思路（自写流式扫描器、栈式配平、无 DOM 依赖），
// 但规则集不同：那份面向「笔记本体 HTML」，这份面向「SVG 图形」，且必须容忍 mermaid 的产物形态。

/** 允许存活的标签（任务口径：极保守，余者一律丢） */
export const SVG_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
]);

/** 允许存活的属性（几何 + 表现 + mermaid 产物实际用到的引用/无障碍属性） */
export const SVG_ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  // 结构/无障碍（aria-* 在下方按前缀放行）
  "id",
  "class",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-roledescription",
  "aria-hidden",
  // 尺寸与视口
  "viewBox",
  "width",
  "height",
  "xmlns",
  // 几何
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "transform",
  "transform-origin",
  "gradientTransform",
  "gradientUnits",
  "spreadMethod",
  "fx",
  "fy",
  "offset",
  "orient",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "marker-start",
  "marker-mid",
  "marker-end",
  "marker",
  // 表现
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "color",
  "shape-rendering",
  "text-rendering",
  "vector-effect",
  "paint-order",
  "clip-rule",
  "stop-color",
  "stop-opacity",
  "visibility",
  // 文本
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  // 保守子集：style 属性（值另过 sanitizeStyleDecls）
  "style",
]);

/** text/tspan 之外的元素上出现这些属性也照常放行（SVG 表现属性本就可继承） */

/**
 * style 属性与 <style> 里允许的 CSS 声明白名单（**只有表现类**）。
 * 关键排除：position/z-index/top/left（可把图形摆到全页做 UI 伪装）、
 * pointer-events/cursor、display/visibility 之外的布局属性、background/border（HTML 标签用）、
 * filter（会引用我们已丢弃的 filter 元素）、animation（会引用 @keyframes，且非必要）。
 */
export const SVG_CSS_PROPS: ReadonlySet<string> = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "color",
  "shape-rendering",
  "text-rendering",
  "vector-effect",
  "paint-order",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "marker-start",
  "marker-mid",
  "marker-end",
  "marker",
  "width",
  "height",
  "max-width",
  "min-width",
  "max-height",
  "min-height",
]);

/** 输入上限（字符）：svg 产物远超此值的必定是病态输入，直接判空 */
const MAX_INPUT = 512 * 1024;

/** 「真画了东西」的判据：出现任一绘图元素才认为渲染有内容（空壳 svg 退回源码展示） */
const DRAWABLE_RE =
  /<(path|rect|circle|ellipse|line|polyline|polygon|text)[\s>]/;

export interface SvgSanitizeOptions {
  /** 放行 <style>（仅 mermaid 产物；内容逐条规则校验，见 sanitizeSvgCss） */
  allowStyle?: boolean;
}

// ---- 值校验 ----

/** 属性值字符集：字母数字 + 空白 + `,.&#%()+-!` —— 无 `:` `/` `\` `;` `<>` `=`，绝对 URL 与
 *  伪协议在字符集层面就不成立（`javascript:` 需要 `:`，`url(http://…)` 需要 `:`/`/`）。 */
const VAL_SAFE_RE = /^[A-Za-z0-9 \t\r\n,.#%()+\-!"']*$/;

/** 值里允许出现的函数式写法（`ident(` 的 ident 必须在表内）——`expression(` 这类历史遗留
 *  危险形态即在此出局；出现未知函数一律判不安全（保守）。 */
const SAFE_FUNCS: ReadonlySet<string> = new Set([
  "url",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "var",
  "calc",
  "attr",
  "min",
  "max",
  "clamp",
  "translate",
  "translatex",
  "translatey",
  "rotate",
  "scale",
  "scalex",
  "scaley",
  "skewx",
  "skewy",
  "matrix",
]);

const FUNC_RE = /([a-zA-Z][a-zA-Z0-9-]*)\(/g;

function hasUnknownFunction(value: string): boolean {
  FUNC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_RE.exec(value)) !== null) {
    if (!SAFE_FUNCS.has(m[1].toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** 本地片段引用：`url(#id)`（marker-end / filter 用）；其余 url(...) 一律拒 */
function hasForeignUrl(value: string): boolean {
  const lower = value.toLowerCase();
  let i = lower.indexOf("url(");
  while (i !== -1) {
    if (value[i + 4] !== "#") {
      return true;
    }
    const end = value.indexOf(")", i + 4);
    if (end === -1) {
      return true;
    }
    i = lower.indexOf("url(", end);
  }
  return false;
}

/** id/class：只允许标识符字符（mermaid 产物形态；`.foo` 这类选择器只在 CSS 里出现） */
const IDENT_RE = /^[A-Za-z0-9_\- ]*$/;

function isSafeAttrValue(name: string, value: string): boolean {
  if (value.length > 8192) {
    return false;
  }
  if (name === "style") {
    return sanitizeStyleDecls(value) !== "";
  }
  if (name === "xmlns") {
    return value === "http://www.w3.org/2000/svg";
  }
  if (name === "id" || name === "class") {
    return IDENT_RE.test(value);
  }
  if (!VAL_SAFE_RE.test(value) || hasForeignUrl(value)) {
    return false;
  }
  return !hasUnknownFunction(value);
}

/**
 * style 属性 / 声明块解析：`prop: value; prop2: value2` → 只留白名单属性，返回重建的声明串。
 * **逐条判定、逐条丢弃**（坏声明不会牵连整条 style，也不会原样回吐）：属性不在白名单、
 * 值字符集不符、`url()` 非本地片段、未知函数、引号不配对 —— 命中任一即丢该条。
 * 返回空串 = 没有任何声明可用（调用方据此不输出该属性 / 该规则）。
 */
export function sanitizeStyleDecls(style: string): string {
  if (style.length > 4096) {
    return "";
  }
  const decls: string[] = [];
  for (const raw of style.split(";")) {
    const decl = raw.trim();
    if (decl === "") {
      continue;
    }
    const colon = decl.indexOf(":");
    if (colon === -1) {
      continue; // 畸形（不是 prop: value）
    }
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim();
    if (!SVG_CSS_PROPS.has(prop)) {
      continue;
    }
    if (/!important$/i.test(value)) {
      value = value.replace(/!important$/i, "").trim();
    }
    if (!VAL_SAFE_RE.test(value) || hasForeignUrl(value)) {
      continue;
    }
    if (hasUnknownFunction(value)) {
      continue;
    }
    // 引号必须配对：不配对的引号会让 CSS 解析器把后续 `}` 吞进字符串，跨规则影响样式
    if ((value.match(/"/g)?.length ?? 0) % 2 !== 0) {
      continue;
    }
    if ((value.match(/'/g)?.length ?? 0) % 2 !== 0) {
      continue;
    }
    decls.push(`${prop}:${value}`);
  }
  return decls.join(";");
}

/**
 * `<style>` 内容校验（仅 mermaid 产物走这里）：逐条规则校验，非法规则丢弃，返回合法 CSS。
 *
 * 为什么选择器必须以 `#rootId` 打头：`<style>` 在 HTML 文档里是**全局生效**的，不随所在 SVG 子树
 * 收敛。mermaid 的 stylis 产物天然是 `#<svgId> …` 形态；把这条形态钉死，就等于把样式关回本图内。
 * 含 `~`/`+` 的选择器（兄弟组合子）会横向溢出到图外元素 → 一并拒。
 */
export function sanitizeSvgCss(css: string, rootId: string): string {
  if (css.length > 256 * 1024 || rootId === "" || css.includes("<")) {
    return "";
  }
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const brace = css.indexOf("{", i);
    if (brace === -1) {
      break;
    }
    const selector = css.slice(i, brace).trim();
    const end = matchBrace(css, brace);
    if (end === -1) {
      break; // 括号不配平 → 到此为止（保留已校验部分）
    }
    i = end + 1;
    if (selector.startsWith("@")) {
      continue; // 所有 at-rule（@keyframes/@media/@import…）整体丢
    }
    const ok = selector.split(",").every((part) => {
      const sel = part.trim();
      return (
        sel.startsWith(`#${rootId}`) &&
        !sel.includes("~") &&
        !sel.includes("+") &&
        SEL_SAFE_RE.test(sel)
      );
    });
    if (!ok) {
      continue;
    }
    const body = css.slice(brace + 1, end);
    if (body.includes("{")) {
      continue; // 声明块里出现嵌套块 → 非预期形态，丢
    }
    const decls = sanitizeStyleDecls(body);
    if (decls === "") {
      continue;
    }
    out.push(`${selector}{${decls}}`);
  }
  return out.join("");
}

/** 选择器字符集：在 `#rootId` 前缀 + 无兄弟组合子之上，再收紧可用字符 */
const SEL_SAFE_RE = /^[A-Za-z0-9_\- #>[\]="':.()*%^$|]*$/;

/** 从 `{` 找到配对的 `}`（跳过引号内的括号）；-1 = 不配平 */
function matchBrace(s: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// ---- 标签/属性解析 ----

/** 标签结束位置（尊重引号）；-1 = 未闭合 */
function findTagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** 属性串 → [名(小写), 值] 列表 */
function parseAttrs(s: string): [string, string][] {
  const attrs: [string, string][] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s/]/.test(s[i])) {
      i++;
    }
    if (i >= s.length) {
      break;
    }
    const nameStart = i;
    while (i < s.length && !/[\s=/>]/.test(s[i])) {
      i++;
    }
    const name = s.slice(nameStart, i).toLowerCase();
    while (i < s.length && /\s/.test(s[i])) {
      i++;
    }
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < s.length && /\s/.test(s[i])) {
        i++;
      }
      const quote = s[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = s.indexOf(quote, i);
        value = end === -1 ? s.slice(i) : s.slice(i, end);
        i = end === -1 ? s.length : end + 1;
      } else {
        const start = i;
        while (i < s.length && !/[\s>]/.test(s[i])) {
          i++;
        }
        value = s.slice(start, i);
      }
    }
    if (name) {
      attrs.push([name, value]);
    }
  }
  return attrs;
}

/** 属性值转义（引号 + 边界字符；`&` 仅在非实体时转义，防双重转义） */
function escapeValue(value: string): string {
  return value
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 文本节点转义 */
function escapeText(text: string): string {
  return text
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 该标签是否自闭合（末尾 `/`，允许尾随空白） */
function isSelfClosing(rawTag: string): boolean {
  return /\/\s*$/.test(rawTag);
}

// 名字大小写：SVG 是大小写敏感的（linearGradient / viewBox / refX），但输入可能任意大小写，
// 比对一律走小写表，输出统一用白名单里的**规范拼写**（HTML 解析器虽有 adjust-SVG-names 表，
// 但不能把正确性押在解析器的兜底上——输出在任何解析路径下都该一致）。
const TAG_CANON = new Map(
  [...SVG_ALLOWED_TAGS].map((t) => [t.toLowerCase(), t]),
);
const ATTR_CANON = new Map(
  [...SVG_ALLOWED_ATTRS].map((a) => [a.toLowerCase(), a]),
);

/** 允许的标签名（规范拼写；未知的名字 → null） */
function canonTag(name: string): string | null {
  return TAG_CANON.get(name) ?? null;
}

/** 允许的属性名（规范拼写；aria-* 前缀放行；`xlink:href`、`xmlns:xlink` 这类带 `:` 的出局） */
function canonAttr(name: string): string | null {
  const canon = ATTR_CANON.get(name);
  if (canon !== undefined) {
    return canon;
  }
  return /^aria-[a-z-]+$/.test(name) ? name : null;
}

function renderAttrs(raw: string, rootIdHolder: { id: string | null }): string {
  let out = "";
  for (const [rawName, value] of parseAttrs(raw)) {
    const name = canonAttr(rawName);
    if (name === null) {
      continue;
    }
    if (!isSafeAttrValue(name, value)) {
      continue;
    }
    if (name === "id" && rootIdHolder.id === null) {
      rootIdHolder.id = value;
    }
    if (name === "style") {
      const decls = sanitizeStyleDecls(value);
      if (decls === "") {
        continue;
      }
      out += ` style="${escapeValue(decls)}"`;
      continue;
    }
    out += ` ${name}="${escapeValue(value)}"`;
  }
  return out;
}

// ---- 主体扫描 ----

/** 开启标签入栈 + 记名（name → 栈内位置），闭合查找 O(1)（错位闭合 × 深栈不退化） */
function pushOpen(
  stack: string[],
  openAt: Map<string, number[]>,
  name: string,
): void {
  stack.push(name);
  const positions = openAt.get(name);
  if (positions) {
    positions.push(stack.length - 1);
  } else {
    openAt.set(name, [stack.length - 1]);
  }
}

/** 关闭到同名标签：中途未闭合的一并补上（输出必然配平）；无同名开启标签 → 丢弃 */
function closeTag(
  stack: string[],
  openAt: Map<string, number[]>,
  name: string,
): string {
  const positions = openAt.get(name);
  if (!positions || positions.length === 0) {
    return "";
  }
  const idx = positions[positions.length - 1];
  let tail = "";
  for (let i = stack.length - 1; i > idx; i--) {
    tail += `</${stack[i]}>`;
    openAt.get(stack[i])?.pop();
  }
  positions.pop();
  stack.length = idx;
  return `${tail}</${name}>`;
}

/**
 * 消毒入口：返回可安全 innerHTML 的 SVG 标记。
 * - 输入非串/空/超长 → ""
 * - 输出里没有任何元素存活（全被丢光）→ ""（调用方据此退回源码展示）
 */
export function sanitizeSvg(
  markup: string,
  opts: SvgSanitizeOptions = {},
): string {
  if (
    typeof markup !== "string" ||
    markup === "" ||
    markup.length > MAX_INPUT
  ) {
    return "";
  }
  const allowStyle = opts.allowStyle === true;
  const stack: string[] = [];
  const openAt = new Map<string, number[]>();
  const rootIdHolder: { id: string | null } = { id: null };
  let out = "";
  let i = 0;
  const n = markup.length;
  // 正在丢弃的子树（含内容）：depth 记同类嵌套层数
  let skip: { name: string; depth: number } | null = null;

  while (i < n) {
    const lt = markup.indexOf("<", i);
    if (lt === -1) {
      if (skip === null) {
        out += escapeText(markup.slice(i));
      }
      break;
    }
    if (skip === null) {
      out += escapeText(markup.slice(i, lt));
    }

    if (markup.startsWith("<!--", lt)) {
      const end = markup.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (markup.startsWith("<![CDATA[", lt)) {
      const end = markup.indexOf("]]>", lt + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (markup.startsWith("<!", lt) || markup.startsWith("<?", lt)) {
      const end = markup.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    let j = lt + 1;
    const closing = markup[j] === "/";
    if (closing) {
      j++;
    }
    const nameStart = j;
    while (j < n && /[A-Za-z0-9-]/.test(markup[j])) {
      j++;
    }
    const rawName = markup.slice(nameStart, j);
    // 非标签（`a < b`）：按文本留 `<`
    if (!rawName || !/^[A-Za-z]/.test(rawName)) {
      if (skip === null) {
        out += "&lt;";
      }
      i = lt + 1;
      continue;
    }
    // 名字比对走小写（元素名大小写不敏感），输出用白名单规范拼写
    const name = rawName.toLowerCase();
    const tagEnd = findTagEnd(markup, j);
    if (tagEnd === -1) {
      break; // 半截标签（到 EOF 无 `>`）：fail-closed，余下丢掉
    }
    const selfClosing = isSelfClosing(markup.slice(j, tagEnd));

    if (skip !== null) {
      // 丢弃子树内：只跟踪同类嵌套，其余一概不看
      if (!closing && name === skip.name && !selfClosing) {
        skip.depth++;
      } else if (closing && name === skip.name) {
        skip.depth--;
        if (skip.depth === 0) {
          skip = null;
        }
      }
      i = tagEnd + 1;
      continue;
    }

    if (closing) {
      i = tagEnd + 1;
      const canon = canonTag(name);
      if (canon !== null) {
        out += closeTag(stack, openAt, canon);
      }
      continue;
    }

    // <style>：**不在标签白名单里**（默认整族丢弃），仅 mermaid 产物（allowStyle）另走此分支，
    // 内容逐条规则校验；无根 id 时无法把 CSS 收敛回本图 → 丢。
    if (name === "style") {
      const closeAt = markup.toLowerCase().indexOf("</style", tagEnd + 1);
      const closeEnd = closeAt === -1 ? -1 : markup.indexOf(">", closeAt);
      const body =
        closeAt === -1
          ? markup.slice(tagEnd + 1)
          : markup.slice(tagEnd + 1, closeAt);
      i = closeEnd === -1 ? n : closeEnd + 1;
      if (allowStyle && rootIdHolder.id !== null) {
        const css = sanitizeSvgCss(body, rootIdHolder.id);
        if (css !== "") {
          out += `<style>${css}</style>`;
        }
      }
      continue;
    }

    const canon = canonTag(name);
    // 白名单外标签（含 script/foreignObject/image/use/animate/filter 系）：整棵子树丢弃
    if (canon === null) {
      if (!selfClosing) {
        skip = { name, depth: 1 };
      }
      i = tagEnd + 1;
      continue;
    }

    out += `<${canon}${renderAttrs(markup.slice(j, tagEnd), rootIdHolder)}>`;
    if (selfClosing) {
      // 自闭合改写成显式配平：SVG 在 HTML 解析里没有「自闭合即空元素」的待遇，
      // 漏掉 `</rect>` 会让后续兄弟节点全变成它的子节点（图形错位）。
      out += `</${canon}>`;
    } else {
      pushOpen(stack, openAt, canon);
    }
    i = tagEnd + 1;
  }

  for (let k = stack.length - 1; k >= 0; k--) {
    out += `</${stack[k]}>`;
  }
  // 没有任何可画元素（只剩空壳 svg/g/defs）→ 视为「没渲染出东西」，调用方退回源码展示
  return DRAWABLE_RE.test(out) ? out : "";
}
