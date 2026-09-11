// htmlSanitize.ts — 笔记 HTML 白名单消毒（纯函数，可 node 单测；M7，PLAN §2.8 / INTERFACE §4.3）。
// 宿主对写库前 HTML 做终检：白名单外标签「去标签留文字」，脚本/样式/嵌入类整段丢弃，
// 事件属性（on*）、style/class/target 等一律剥离，URL 仅放行 http(s)。
// 不依赖 DOM（宿主 Gecko 与 node 测试同源）：自写流式扫描器——输入是「AI 产出/桥消息」这类
// 半可信 HTML，输出保证标签配平（栈式闭合），绝不原样回吐未识别标签。

/** 允许保留的标签：markdown 常规产物 + 追加标记用到的 hr/small/br（INTERFACE §4.3 追加格式） */
const ALLOWED_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "ins",
  "sup",
  "sub",
  "small",
  "br",
  "hr",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
]);

/**
 * 整段丢弃（标签 + 内容）：脚本、样式、嵌入内容——其文本不是文档正文，
 * 单独留文字既无意义也可能泄漏（如 <script> 源码）。
 * 只对「有闭合标签」的输入丢内容；未闭合时仅丢该标签本身（其文本按普通文本留在文中，无执行面）。
 */
const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "svg",
  "math",
  "title",
  "textarea",
  "xmp",
  "plaintext",
  "listing",
]);

/** 空元素（无闭合标签，不应压栈） */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/** 逐标签属性白名单；未列出的标签属性全部剥离（on*、style、class、target… 无例外） */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "title"]),
  ol: new Set(["start"]),
};

/** URL 仅放行绝对 http(s)：javascript:/data:/vbscript:/相对路径与协议混淆（java\tscript:）全挡 */
function isSafeUrl(raw: string): boolean {
  // 空白先归一：`ja\nvascript:` 这类混淆在归一后露出真协议。其余控制字符不必归一——
  // 它们只会让下面的前缀匹配失败（fail-closed：可能误拒，绝不可能误放）
  const compact = raw.replace(/\s+/g, "");
  return /^https?:\/\//i.test(compact);
}

/**
 * 标签结束位置（尊重引号：`<a title="a>b">` 的 `>` 不算结束）；-1 = 未闭合。
 * `lastGt` = 输入中最后一个 `>` 的位置：`from` 之后已无 `>` 时可立刻判负（O(1)），
 * 否则 `"<p".repeat(50000)` 这类无 `>` 输入会让每个 `<` 都全串扫一遍 → O(n²) 卡死主线程。
 */
function findTagEnd(s: string, from: number, lastGt: number): number {
  if (from > lastGt) {
    return -1;
  }
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

/** 属性串 → [名, 值] 列表（名一律小写；无值属性得空串） */
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

/** 属性值转义（仅转义会破坏属性边界的三个字符；`&` 不转义，防双重转义） */
function escapeAttrValue(value: string): string {
  return value
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 该标签允许保留的属性串（含前导空格；无保留属性 → 空串） */
function renderAttrs(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) {
    return "";
  }
  let out = "";
  for (const [name, value] of parseAttrs(raw)) {
    if (!allowed.has(name)) {
      continue;
    }
    if (name === "href" || name === "src") {
      if (!isSafeUrl(value)) {
        continue;
      }
    } else if (name === "start" && !/^-?\d+$/.test(value)) {
      continue;
    }
    out += ` ${name}="${escapeAttrValue(value)}"`;
  }
  return out;
}

/**
 * 开启标签入栈 + 记名：`openAt` 是 name → 栈内位置（递增）。
 * 有它闭合查找才是 O(1)；否则 `stack.lastIndexOf` 每次全栈扫，
 * 「错位闭合 × 深栈」（`"<p>"×100k + "</strong>"×100k`）就是 O(N²) 主线程冻结。
 */
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

/**
 * 关闭标签：栈内找同名开启标签（O(1) 查索引），中途未闭合的一并补上（保证输出配平）；
 * 无同名开启标签 → 丢弃（未匹配闭合不产出）。出栈时同步摘掉各名字的位置记录，
 * 弹出的元素各自只弹一次 → 整体均摊 O(1)。
 */
function closeTag(
  stack: string[],
  openAt: Map<string, number[]>,
  out: string,
  name: string,
): string {
  const positions = openAt.get(name);
  if (!positions || positions.length === 0) {
    return out; // 无对应开启标签（或该标签本就被剥离）→ 丢弃
  }
  const idx = positions[positions.length - 1];
  let next = out;
  for (let i = stack.length - 1; i > idx; i--) {
    next += `</${stack[i]}>`;
    openAt.get(stack[i])?.pop();
  }
  positions.pop();
  stack.length = idx;
  return next + `</${name}>`;
}

// 闭合标签查找（大小写不敏感）：逐名缓存正则；**不得**拿整串 toLowerCase 的副本做索引
// ——`İ`.toLowerCase() 展开成 2 码元，任何「小写串的索引切原文」都会错位（BUG-29）。
// 名字只含 [a-z0-9-]（扫描时已限定），无正则元字符。
const closeTagReCache = new Map<string, RegExp>();

function closeTagRe(name: string): RegExp {
  let re = closeTagReCache.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?=[\\s/>])`, "gi");
    closeTagReCache.set(name, re);
  }
  return re;
}

/**
 * 半截片段里的危险形态（保守检出：宁可多丢，不放过）。用纯文本模式而非逐属性解析——
 * 属性解析要切出整段尾巴（O(片段长)），半截片段又必然是「到 EOF 的尾巴」，
 * 连发半截标签时就是 O(n²)；模式扫描可单调备忘（见 findRiskAtOrAfter）。
 *  - `on*=`：事件属性；
 *  - `href/src=` 后接非空且非 http(s) 的值：伪协议/相对路径（空值如 `href=` 不算——补全后无跳转面）。
 */
const ON_ATTR_RISK_RE = /\bon[a-z]+\s*=/gi;
const URL_ATTR_RISK_RE =
  /(?:href|src)\s*=\s*["']?\s*(?!https?:\/\/)(?=[^\s"'>])/gi;

/**
 * 在 `from` 之后找 `re` 的首个命中；找不到 → -1。
 * `memo` 记「已确认从此处起无命中」：命中是纯文本性质、与解析起点无关，
 * 故后续更靠后的查询可直接判负（半截标签连发时避免反复空搜到串尾）。
 */
function findRiskAtOrAfter(
  s: string,
  re: RegExp,
  from: number,
  memo: Map<RegExp, number>,
): number {
  const known = memo.get(re);
  if (known !== undefined && from >= known) {
    return -1;
  }
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) {
    memo.set(re, from);
    return -1;
  }
  return m.index;
}

/**
 * 半截标签（到 EOF 都没有 `>`）能否原样当**文本**留下：
 * 名字必须在白名单内，且名字之后没有危险形态。危险 → 调用方整段丢弃（fail-closed）。
 * 典型：`<p<p<p…`、`看这个 <a href=` 可留；`<img src=x onerror=…`、`<a href=javascript:…` 不可留。
 */
function isTruncatedFragmentSafeToKeep(
  s: string,
  nameEnd: number,
  name: string,
  riskMemo: Map<RegExp, number>,
): boolean {
  if (!ALLOWED_TAGS.has(name)) {
    return false;
  }
  if (findRiskAtOrAfter(s, ON_ATTR_RISK_RE, nameEnd, riskMemo) !== -1) {
    return false;
  }
  if (findRiskAtOrAfter(s, URL_ATTR_RISK_RE, nameEnd, riskMemo) !== -1) {
    return false;
  }
  return true;
}

/**
 * 找 `</name` 的起点（不区分大小写；找不到 → -1）。
 * `noClose` 是**本次调用**的备忘（name → 已确认无闭合的起点）：未闭合的 `<script>` 连发
 * （`"<script>".repeat(15000)`）若不备忘，每个都空搜到串尾 → O(n²)。只搜一次即可判定后续都无。
 */
function findClosingTag(
  s: string,
  name: string,
  from: number,
  noClose: Map<string, number>,
): number {
  const known = noClose.get(name);
  if (known !== undefined && from >= known) {
    return -1;
  }
  const re = closeTagRe(name);
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) {
    noClose.set(name, from);
    return -1;
  }
  return m.index;
}

/**
 * 白名单消毒：返回可安全写入 Zotero 笔记的 HTML。
 * 输入空串/非串 → 空串（调用方按 EMPTY_CONTENT / SANITIZE_REJECTED 判定）。
 * 全程在原文上取索引、切片（名字比较时才局部小写）——整串大小写变换会改变长度。
 */
export function sanitizeNoteHtml(html: string): string {
  if (typeof html !== "string" || html === "") {
    return "";
  }
  const stack: string[] = [];
  const openAt = new Map<string, number[]>();
  let out = "";
  let i = 0;
  const n = html.length;
  const lastGt = html.lastIndexOf(">");
  const noClose = new Map<string, number>();
  const riskMemo = new Map<RegExp, number>();

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    // 注释 / doctype / 处理指令 / CDATA：整体丢弃
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    let j = lt + 1;
    const closing = html[j] === "/";
    if (closing) {
      j++;
    }
    const nameStart = j;
    while (j < n && /[a-zA-Z0-9-]/.test(html[j])) {
      j++;
    }
    // 名字只在此处局部小写（ASCII 切片，长度不变）
    const name = html.slice(nameStart, j).toLowerCase();
    // 非标签（`a < b` 的裸 <、`<3`）：按文本原样保留
    if (!name || !/^[a-z]/.test(name)) {
      out += "<";
      i = lt + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, j, lastGt);
    if (tagEnd === -1) {
      // 半截闭合标签（`</p ` 截到 EOF）：结构性 token，丢掉首字符 `<` 断掉「被后续文本补全成
      // 真闭合标签」的面（文本其余部分照常按正文留下）。不能按文本保留 `<`——补全后关掉元素会
      // 破坏配平，且输出不幂等（NEW-2：`<p>a</p ` → `<p>a</p </p>` 再消毒变 `<p>a</p>`）。
      if (closing) {
        i = lt + 1;
        continue;
      }
      // 半截开启标签（截到 EOF 都没有 `>`；续写文本可能把它补成真标签）：
      // 危险片段（非白名单名字 / on* / 非 http(s) 的 href·src）→ 余下整段丢弃（fail-closed）；
      // 其余按文本保留（只保留首字符 `<`，后续照常扫描）——`<p<p<p…`、`看这个 <a href=` 都不吞正文。
      if (!isTruncatedFragmentSafeToKeep(html, j, name, riskMemo)) {
        break;
      }
      out += "<";
      i = lt + 1;
      continue;
    }

    if (closing) {
      i = tagEnd + 1;
      if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) {
        out = closeTag(stack, openAt, out, name);
      }
      continue;
    }

    if (DROP_CONTENT_TAGS.has(name)) {
      const closeAt = findClosingTag(html, name, tagEnd + 1, noClose);
      const closeEnd = closeAt === -1 ? -1 : html.indexOf(">", closeAt);
      i = closeEnd === -1 ? tagEnd + 1 : closeEnd + 1; // 无闭合 → 只丢标签本身
      continue;
    }

    if (ALLOWED_TAGS.has(name)) {
      out += `<${name}${renderAttrs(name, html.slice(j, tagEnd))}>`;
      if (!VOID_TAGS.has(name)) {
        pushOpen(stack, openAt, name);
      }
    }
    // 白名单外标签：去标签留文字（内容继续参与扫描，其中的危险标签照常被处理）
    i = tagEnd + 1;
  }

  for (let k = stack.length - 1; k >= 0; k--) {
    out += `</${stack[k]}>`;
  }
  return out;
}
