// 复核轮（m7-review）—— htmlSanitize 攻击面自查（白盒，直打）。
// 独立性声明：向量集、期望值、以及下面这个「输出标记扫描器」全部自写，
// 不复用被测方测试的任何断言/常量，也不 import src 的白名单常量（测试侧单独列一份规格）。
//
// 判定口径（两条不变量，逐向量检查输出而不只看输入）：
//   1) 输出里可再解析出的标记，只能是白名单标签 + 白名单属性 + http(s) URL；
//      任何白名单外标签（含未闭合/半截形态）出现 = 输出回吐了未消毒内容。
//   2) 输出配平（栈式嵌套良好，可再解析不产生新标签）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNoteHtml } from "../../../src/utils/htmlSanitize.ts";

// ---- 测试侧规格副本（INTERFACE §4.3 / PLAN §2.8 白名单）----

const SPEC_TAGS = new Set([
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
const SPEC_VOID = new Set(["br", "hr", "img"]);
const SPEC_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "title"]),
  ol: new Set(["start"]),
};

// ---- 独立标记扫描器（与实现无关：只按「浏览器怎么看这段 HTML」抽取标记）----

interface Scanned {
  closing: boolean;
  name: string;
  attrs: [string, string][];
  raw: string;
  unterminated: boolean;
}

function parseAttrText(s: string): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s/]/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/[\s=/>]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    while (i < s.length && /\s/.test(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        i++;
        const end = s.indexOf(q, i);
        value = end === -1 ? s.slice(i) : s.slice(i, end);
        i = end === -1 ? s.length : end + 1;
      } else {
        const vs = i;
        while (i < s.length && !/[\s>]/.test(s[i])) i++;
        value = s.slice(vs, i);
      }
    }
    if (name) out.push([name, value]);
  }
  return out;
}

/** 抽出输出里所有「像标签」的片段（引号感知；`a < b` 这类裸 < 跳过） */
function scanTags(s: string): Scanned[] {
  const tags: Scanned[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) break;
    let j = lt + 1;
    const closing = s[j] === "/";
    if (closing) j++;
    if (!/[a-zA-Z]/.test(s[j] ?? "")) {
      i = lt + 1;
      continue;
    }
    let k = j;
    while (k < s.length && !/[\s/>]/.test(s[k])) k++;
    const name = s.slice(j, k).toLowerCase();
    let quote: string | null = null;
    let end = -1;
    for (let p = k; p < s.length; p++) {
      const c = s[p];
      if (quote !== null) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === ">") {
        end = p;
        break;
      }
    }
    if (end === -1) {
      tags.push({
        closing,
        name,
        attrs: parseAttrText(s.slice(k)),
        raw: s.slice(lt),
        unterminated: true,
      });
      break;
    }
    tags.push({
      closing,
      name,
      attrs: parseAttrText(s.slice(k, end)),
      raw: s.slice(lt, end + 1),
      unterminated: false,
    });
    i = end + 1;
  }
  return tags;
}

const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 危险标记检测：事件属性 / 非 http(s) 协议属性值（空值不算——无值属性不构成跳转面） */
function dangerousAttrs(t: Scanned): string[] {
  const bad: string[] = [];
  for (const [n, v] of t.attrs) {
    if (/^on/i.test(n)) bad.push(`事件属性 ${n}=${JSON.stringify(v)}`);
    if ((n === "href" || n === "src") && v !== "" && !/^https?:\/\//i.test(v)) {
      bad.push(`<${t.name} ${n}> 值非 http(s)：${JSON.stringify(v)}`);
    }
  }
  return bad;
}

/**
 * 违规清单：空数组 = 输出满足「白名单标记 + 配平 + 无危险残留」不变量。
 * 未终止标签（原文截断产生）单独分级：白名单标签 + 无危险属性 → 视为文本残留（契约明示的边界行为）；
 * 含事件属性/危险协议、或本身就是白名单外标签 → 违规（输出回吐了未消毒标记）。
 */
function violations(out: string): string[] {
  const bad: string[] = [];
  const stack: string[] = [];
  for (const t of scanTags(out)) {
    if (!SPEC_TAGS.has(t.name)) {
      bad.push(
        `白名单外标签 <${t.closing ? "/" : ""}${t.name}>` +
          (t.unterminated ? "（未终止，含其后的原始属性串）" : ""),
      );
      if (!t.closing) bad.push(...dangerousAttrs(t));
      continue;
    }
    if (t.unterminated) {
      bad.push(...dangerousAttrs(t));
      continue;
    }
    if (t.closing) {
      if (stack.length === 0) bad.push(`多余闭合 </${t.name}>`);
      else if (stack[stack.length - 1] !== t.name)
        bad.push(`闭合错位 </${t.name}>（栈顶 ${stack[stack.length - 1]}）`);
      else stack.pop();
      continue;
    }
    const allowed = SPEC_ATTRS[t.name] ?? new Set<string>();
    for (const [n, v] of t.attrs) {
      if (!allowed.has(n)) {
        bad.push(`<${t.name}> 上出现白名单外属性 ${n}=${JSON.stringify(v)}`);
        continue;
      }
      if ((n === "href" || n === "src") && !/^https?:\/\//i.test(v)) {
        bad.push(`<${t.name} ${n}> 值非 http(s)：${JSON.stringify(v)}`);
      }
    }
    if (!SPEC_VOID.has(t.name)) stack.push(t.name);
  }
  if (stack.length) bad.push(`未闭合标签：${stack.join(">")}`);
  return bad;
}

/** 单测断言：输出必须干净（每个向量都跑一遍）；附输出原文便于失败定位 */
function assertClean(input: string, out: string): void {
  const bad = violations(out);
  assert.deepEqual(
    bad,
    [],
    `输入 ${JSON.stringify(input)} 的输出 ${JSON.stringify(out)} 违反不变量：\n  - ${bad.join("\n  - ")}`,
  );
}

/** 通用检查：sanitize + 守卫 + 幂等（消毒产物再消毒不变） */
function run(input: string): string {
  const out = sanitizeNoteHtml(input);
  assertClean(input, out);
  assert.equal(sanitizeNoteHtml(out), out, "消毒不幂等");
  return out;
}

// ---- 1. 脚本/嵌入类：整段丢弃（连内容）----

const DROP_CASES: [string, string][] = [
  ["script 带 src", '<script src="https://e/x.js"></script>'],
  ["style", "<style>body{background:url(javascript:alert(1))}</style>"],
  ["style 与表达式", "<style>@import 'javascript:alert(1)';</style>"],
  ["iframe javascript:", '<iframe src="javascript:alert(1)"></iframe>'],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["object data", '<object data="javascript:alert(1)"></object>'],
  ["embed src", '<embed src="javascript:alert(1)">'],
  ["applet code", '<applet code="Evil.class"></applet>'],
  ["template 藏内容", "<template><img src=x onerror=alert(1)></template>"],
  ["textarea 藏内容", "<textarea><img src=x onerror=alert(1)></textarea>"],
  ["xmp", "<xmp><img src=x onerror=alert(1)></xmp>"],
  ["listing", "<listing><img src=x onerror=alert(1)></listing>"],
  ["title", "<title><img src=x onerror=alert(1)></title>"],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  [
    "svg 内嵌 foreignObject",
    "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
  ],
  ["math", "<math><mtext><img src=x onerror=alert(1)></mtext></math>"],
  ["noscript", "<noscript><img src=x onerror=alert(1)></noscript>"],
];

for (const [label, input] of DROP_CASES) {
  test(`消毒矩阵·整段丢弃：${label} 不残留标记且内容被丢弃`, () => {
    const out = run(input);
    assert.equal(
      out,
      "",
      `整段丢弃类应向输出交付空串，实际 ${JSON.stringify(out)}`,
    );
  });
}

test("消毒矩阵·整段丢弃：script 丢弃但周围段落原文保留", () => {
  assert.equal(
    run("<p>a</p><script>alert(1)</script><p>b</p>"),
    "<p>a</p><p>b</p>",
  );
  assert.equal(run("<SCRIPT>alert(1)</ScRiPt><p>x</p>"), "<p>x</p>");
  assert.equal(
    run("<p>引</p><style>body{}</style><p>尾</p>"),
    "<p>引</p><p>尾</p>",
  );
});

test("消毒矩阵·整段丢弃：script 未闭合只丢标签、后续正文保留", () => {
  const out = run("<script>alert(1)<p>后面</p>");
  assert.equal(out, "alert(1)<p>后面</p>");
});

test("消毒矩阵·整段丢弃：嵌套里藏的 script 照样丢弃、外层保留", () => {
  const out = run("<blockquote><p>引</p><script>bad()</script></blockquote>");
  assert.equal(out, "<blockquote><p>引</p></blockquote>");
});

// ---- 2. 非白名单容器标签：去标签留文字 ----

const UNWRAP_CASES: [string, string][] = [
  ["div/span", "<div><span>正文</span></div>", "正文"],
  ["自定义标签带事件", "<my-widget onclick='x()'>正文</my-widget>", "正文"],
  ["body onload", "<body onload=alert(1)><p>x</p></body>", "<p>x</p>"],
  ["marquee onstart", "<marquee onstart=alert(1)>x</marquee>", "x"],
  ["details ontoggle", "<details open ontoggle=alert(1)>x</details>", "x"],
  ["video/source onerror", '<video><source onerror="alert(1)"></video>', ""],
  [
    "form action",
    '<form action="javascript:alert(1)"><input type=submit></form>',
    "",
  ],
  [
    "meta refresh",
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    "",
  ],
  ["base href", '<base href="javascript:alert(1)//">', ""],
  ["link stylesheet", '<link rel="stylesheet" href="javascript:alert(1)">', ""],
  ["div style 表达式", '<div style="width:expression(alert(1))">x</div>', "x"],
];

for (const [label, input, want] of UNWRAP_CASES) {
  test(`消毒矩阵·去标签留文字：${label}`, () => {
    assert.equal(run(input), want);
  });
}

// ---- 3. 事件属性：on* 全属性矩阵（挂白名单标签/白名单外标签都剥）----

const ON_ATTRS = [
  "onload",
  "onerror",
  "onclick",
  "onmouseover",
  "onmouseenter",
  "onfocus",
  "onblur",
  "oninput",
  "onchange",
  "onsubmit",
  "onanimationstart",
  "ontoggle",
  "onstart",
  "onbegin",
  "onend",
  "onrepeat",
  "onactivate",
  "onbeforeactivate",
  "onfocusin",
  "onpointerenter",
  "onwheel",
  "onauxclick",
  "oncontextmenu",
  "ondrag",
  "ondrop",
  "onpaste",
  "oncut",
  "oncopy",
  "onbeforeinput",
  "onhashchange",
  "onmessage",
  "onplay",
  "oncanplay",
  "onloadedmetadata",
];

for (const attr of ON_ATTRS) {
  test(`消毒矩阵·事件属性：<img ${attr}> 与 <p ${attr}> 一律剥离`, () => {
    const imgOut = run(`<img src="https://e/a.png" ${attr}="alert(1)">`);
    assert.equal(imgOut, '<img src="https://e/a.png">');
    const pOut = run(`<p ${attr}="alert(1)">t</p>`);
    assert.equal(pOut, "<p>t</p>");
  });
}

test("消毒矩阵·事件属性：混排多属性时只留白名单项（大小写/单引号/无引号/空白形态）", () => {
  for (const form of [
    `<a href="https://e" ONMOUSEOVER="alert(1)">t</a>`,
    `<a href="https://e" onmouseover='alert(1)'>t</a>`,
    `<a href="https://e" onmouseover=alert(1)>t</a>`,
    `<a href="https://e" onmouseover = "alert(1)">t</a>`,
    `<a href="https://e" onmouseover="alert(1)"onclick="x()">t</a>`,
  ]) {
    assert.equal(run(form), '<a href="https://e">t</a>', form);
  }
});

test("消毒矩阵·事件属性：style/class/target/id/name/rel 等非事件属性同样剥离", () => {
  assert.equal(
    run(
      '<a href="https://e" style="color:red" class="x" id="y" target="_blank" rel="opener">t</a>',
    ),
    '<a href="https://e">t</a>',
  );
  assert.equal(
    run(
      '<img src="https://e/a.png" class="x" style="width:1px" ismap usemap="#m">',
    ),
    '<img src="https://e/a.png">',
  );
});

// ---- 4. URL 协议：只放行 http(s)，混淆/伪协议/相对路径全挡 ----

const BAD_URLS: [string, string][] = [
  ["javascript: 小写", "javascript:alert(1)"],
  ["JaVaScRiPt: 大小写", "JaVaScRiPt:alert(1)"],
  ["换行混淆 ja\\nvascript:", "ja\nvascript:alert(1)"],
  ["制表混淆 jav\\tascript:", "jav\tascript:alert(1)"],
  ["回车混淆", "java\rscript:alert(1)"],
  ["前导空白 + js", "  javascript:alert(1)"],
  ["HTML 实体编码", "&#106;avascript:alert(1)"],
  ["十六进制实体", "&#x6a;avascript:alert(1)"],
  ["命名实体", "&Tab;javascript:alert(1)"],
  [
    "data: base64",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  ],
  ["data: inline", "data:text/html,<script>alert(1)</script>"],
  ["vbscript:", "vbscript:msgbox(1)"],
  ["file:", "file:///etc/passwd"],
  ["blob:", "blob:https://e/uuid"],
  ["about:", "about:blank"],
  ["chrome:", "chrome://zotero/content/x.html"],
  ["moz-extension:", "moz-extension://abc/x.html"],
  ["相对路径", "/local/path"],
  ["协议相对", "//evil.com"],
  ["点开头", "../x"],
  ["无协议裸串", "evil.com"],
  ["空值", ""],
  ["只有空白", "   "],
  ["零宽空格混淆", "java\u200bscript:alert(1)"],
  ["非断行空格混淆", "java\u00a0script:alert(1)"],
];

for (const [label, url] of BAD_URLS) {
  test(`消毒矩阵·URL：${label} 的 href/src 被剥离`, () => {
    const a = run(`<a href="${url}">t</a>`);
    assert.equal(a, "<a>t</a>", `a.href 未剥离：${a}`);
    const img = run(`<img src="${url}">`);
    assert.equal(img, "<img>", `img.src 未剥离：${img}`);
  });
}

test("消毒矩阵·URL：http/https 绝对地址保留（含大小写与查询串）", () => {
  assert.equal(
    run('<a href="https://example.com/paper?q=1&x=2#frag">原文</a>'),
    '<a href="https://example.com/paper?q=1&x=2#frag">原文</a>',
  );
  assert.equal(
    run('<a href="HTTP://example.com/a">t</a>'),
    '<a href="HTTP://example.com/a">t</a>',
  );
  assert.equal(
    run('<img src="https://e.com/a.png" alt="图" title="标">'),
    '<img src="https://e.com/a.png" alt="图" title="标">',
  );
});

test("消毒矩阵·URL：重复属性只留安全值（不安全项不得留下）", () => {
  assert.equal(
    run('<a href="javascript:alert(1)" href="https://e">t</a>'),
    '<a href="https://e">t</a>',
  );
  assert.equal(
    run('<a href="https://e" href="javascript:alert(1)">t</a>'),
    '<a href="https://e">t</a>',
  );
  assert.equal(
    run('<img src=x src="https://e/a.png">'),
    '<img src="https://e/a.png">',
  );
});

test("消毒矩阵·URL：href 值内的引号被转义，无法越出属性边界", () => {
  const out = run('<a href="https://e.com/\\" onmouseover=\\"alert(1)">t</a>');
  assert.ok(!out.includes("onmouseover"), out);
  assertClean(out, out);
});

// ---- 5. mXSS：解析差异型向量 ----

const MXSS: [string, string][] = [
  [
    "math 里藏 style/注释",
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
  ],
  [
    "noscript 里的伪闭合",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ],
  [
    "svg 嵌套 animate",
    "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
  ],
  [
    "svg desc 里藏标签",
    "<svg><desc><![CDATA[</desc><img src=x onerror=alert(1)>]]></desc></svg>",
  ],
  ["template 里的表", "<template><table><tr><td>x</table></template>"],
  [
    "表单嵌套",
    "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  ],
  ["注释截断", "<!--><img src=x onerror=alert(1)>--><p>x</p>"],
  ["CDATA", "<![CDATA[<img src=x onerror=alert(1)>]]><p>y</p>"],
  ["处理指令", '<?xml-stylesheet href="javascript:alert(1)"?><p>z</p>'],
  ["条件注释", "<!--[if IE]><script>alert(1)</script><![endif]--><p>w</p>"],
];

for (const [label, input] of MXSS) {
  test(`消毒矩阵·mXSS：${label} 不产生可执行标记`, () => {
    run(input);
  });
}

test("消毒矩阵·mXSS：整段丢弃后无残留（math/noscript 版本精确断言）", () => {
  assert.equal(
    run("<math><mtext>1</mtext></math>"),
    "",
    "math 类整段丢弃应连文字一起丢",
  );
  assert.equal(run("<noscript>raw</noscript>"), "");
  assert.equal(run("<svg><desc>d</desc></svg>"), "");
});

// ---- 6. 白名单边界形态 ----

test("白名单·畸形：未闭合标签自动补闭合（栈式配平）", () => {
  assert.equal(run("<p>a<strong>b"), "<p>a<strong>b</strong></p>");
  assert.equal(
    run("<p><strong><em><code>x"),
    "<p><strong><em><code>x</code></em></strong></p>",
  );
});

test("白名单·畸形：交叉闭合按栈收敛，不产生错位闭合", () => {
  assert.equal(run("<p><em>x</p></em>"), "<p><em>x</em></p>");
  assert.equal(run("<b><i>x</b></i>"), "<b><i>x</i></b>");
});

test("白名单·畸形：孤立闭合标签丢弃、不产生多余闭合", () => {
  assert.equal(run("</p></div>x"), "x");
  assert.equal(run("<p>x</strong></p>"), "<p>x</p>");
});

test("白名单·畸形：裸 < 与非标签按文本保留（不吞正文）", () => {
  assert.equal(run("a < b"), "a < b");
  assert.equal(run("3 < 5 > 2"), "3 < 5 > 2");
  assert.equal(run("<3 元"), "<3 元");
  assert.equal(run("看这个 <a href="), "看这个 <a href=");
});

test("白名单·畸形：XHTML 自闭合 br/hr/img 归一到无斜杠形态", () => {
  assert.equal(
    run('<p>a<br />b<hr/>c<img src="https://e/a.png"/></p>'),
    '<p>a<br>b<hr>c<img src="https://e/a.png"></p>',
  );
});

test("白名单·畸形：属性大小写归一、重复属性不重复输出", () => {
  assert.equal(
    run('<A HREF="https://E.COM">t</A>'),
    '<a href="https://E.COM">t</a>',
  );
  assert.equal(run('<p class="a" class="b" onclick="x">t</p>'), "<p>t</p>");
  assert.equal(
    run('<ol START="3"><li>x</li></ol>'),
    '<ol start="3"><li>x</li></ol>',
  );
  assert.equal(run('<ol start="3abc"><li>x</li></ol>'), "<ol><li>x</li></ol>");
});

test("白名单·畸形：引号内的 > 不提前结束标签；值内 > 被转义", () => {
  assert.equal(
    run('<img title=">" src="https://e/a.png">'),
    '<img title="&gt;" src="https://e/a.png">',
  );
  assert.equal(
    run('<a href="https://e.com/a>b">x</a>'),
    '<a href="https://e.com/a&gt;b">x</a>',
  );
});

test("白名单·畸形：单引号属性形态归一为双引号", () => {
  assert.equal(
    run("<a href='https://e.com'>t</a>"),
    '<a href="https://e.com">t</a>',
  );
});

test("白名单·畸形：注释/doctype/处理指令丢弃", () => {
  assert.equal(run("<!-- 注释 --><p>x</p>"), "<p>x</p>");
  assert.equal(run("<!doctype html>text"), "text");
});

test("白名单·畸形：实体与中文/emoji 原样保留（不误伤正文）", () => {
  assert.equal(
    run("<p>结论 ✅ &nbsp; &amp; 更多</p>"),
    "<p>结论 ✅ &nbsp; &amp; 更多</p>",
  );
});

test("白名单·畸形：表格与 markdown 常规产物保留", () => {
  const html =
    "<h1>题</h1><p><strong>粗</strong><em>斜</em><code>c</code></p>" +
    "<pre><code>block</code></pre><ul><li>i</li></ul><blockquote>q</blockquote><hr>" +
    "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>";
  assert.equal(run(html), html);
});

test("白名单·畸形：追加标记（hr/small 格式契约）不被消毒破坏", () => {
  const marker =
    "<hr><p><small>zotero-claudian 追加（2026-09-09T10:00:00.000Z）</small></p>";
  assert.equal(run(marker), marker);
});

test("消毒·非字符串输入：一律空串（防御桥消息畸形字段）", () => {
  for (const v of [undefined, null, 0, 1, true, {}, [], Symbol("x")]) {
    assert.equal(
      sanitizeNoteHtml(v as unknown as string),
      "",
      `非字符串 ${String(v)} 应得空串`,
    );
  }
});

// ---- 7. 已知攻击面回归：Unicode 大小写展开导致的索引错位（U+0130）----
// toLowerCase 会改变字符串长度（İ → i + U+0307），任何「拿小写串的索引去切原文」的实现都会错位。
// 期望口径：无论输入里混入什么字符，白名单外标签都不得出现在输出里。

const OFFSET_PAYLOADS: [string, string][] = [
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["script", "<script>alert(1)</script>"],
  ["svg onload", "<svg onload=alert(1)>"],
  ["iframe", "<iframe src=javascript:alert(1)>"],
  ["p onclick", "<p onclick=alert(1)>t</p>"],
];

for (const [label, payload] of OFFSET_PAYLOADS) {
  for (const k of [1, 2, 4]) {
    test(`消毒·Unicode 错位（前置 ${k} 个 İ）：${label} 不得原样出现在输出`, () => {
      const input = "\u0130".repeat(k) + payload;
      const out = sanitizeNoteHtml(input);
      assertClean(input, out);
    });
  }
}

test("消毒·Unicode 错位：前置 İ 时 script 标签整体不得残留", () => {
  const out = sanitizeNoteHtml("\u0130<script>alert(1)</script>");
  assert.ok(
    !/<\s*script/i.test(out),
    `输出残留 script 标签：${JSON.stringify(out)}`,
  );
});

test("消毒·Unicode 错位：不得把白名单标签改名（<p> 不得变成别的标签）", () => {
  const out = sanitizeNoteHtml("<!-- c -->" + "\u0130".repeat(5) + "<p>a</p>");
  assert.ok(!/<i>/.test(out), `白名单标签被错位改名：${JSON.stringify(out)}`);
  assert.equal(
    run("<!-- c -->" + "\u0130".repeat(5) + "<p>a</p>"),
    "\u0130\u0130\u0130\u0130\u0130<p>a</p>",
  );
});

test("消毒·Unicode 错位：不得产生多余闭合标签（配平保持）", () => {
  const input = "<p>" + "\u0130".repeat(3) + "</p><script>a</script><p>后</p>";
  const out = sanitizeNoteHtml(input);
  assertClean(input, out);
  // 期望对齐「script 连内容整体移除」（本文件矩阵用例第 266 行 + 验收锁定 notes.test.mjs:52）：
  // 原文是保留 script 内容 "a" 的 `<p>İİİ</p>a<p>后</p>`，与本套件其余用例自相矛盾；
  // 2026-09-11 复核轮修正为丢弃 script 内容。
  assert.equal(out, "<p>\u0130\u0130\u0130</p><p>后</p>");
});

// 正常路径形态（marked + DOMPurify 的规范产物）：İ 是普通正文文本，规范标签必须原样通过。
// 这一组不含任何"危险输入"，因此可在正常保存链路里被触发——可达性高于上面的对抗向量。
const NORMAL_SHAPE_CASES: [string, string][] = [
  ["İ 后接段落", "<p>İstanbul 是土耳其城市</p><p>第二段</p>"],
  ["İ 后接列表", "<p>İ</p><ul><li>一</li><li>二</li></ul>"],
  ["İ 后接强调", "<p>关于 İ 的说明</p><p><strong>粗</strong>与<em>斜</em></p>"],
  ["İ 后接链接", '<p>İ</p><p><a href="https://e.com">链</a></p>'],
  ["İ 后接表格", "<p>İ</p><table><tr><td>c</td></tr></table>"],
  ["多级标题含 İ", "<h2>İ</h2><p>İİ</p><p>正文</p>"],
  ["İ 在代码块前", "<p>İ</p><pre><code>code</code></pre>"],
];

for (const [label, input] of NORMAL_SHAPE_CASES) {
  test(`消毒·规范产物（正常路径可达）：${label} 原样通过、无多余闭合`, () => {
    const out = sanitizeNoteHtml(input);
    assert.equal(
      out,
      input,
      `规范 HTML 应原样通过（不新增/丢失标记），实际 ${JSON.stringify(out)}`,
    );
  });
}

// ---- 8. 截断/未闭合标签（无 > 或引号未闭合）：不得原样回吐 ----

const TRUNCATED: [string, string][] = [
  ["img 无引号 onerror 无 >", "<img src=x onerror=alert(1)"],
  ["img 带尾空格", "<img src=x onerror=alert(1) "],
  ["svg onload 无 >", "<svg onload=alert(1)"],
  ["iframe 无 >", "<iframe src=javascript:alert(1) "],
  ["a 未闭合引号", '<a href="https://e/x onclick=alert(1)'],
  [
    "img 未闭合引号 onerror",
    '<img src="https://e/a.png" alt="x onerror=alert(1)',
  ],
  ["未闭合引号接后续文本", '<a href="https://e>text'],
];

for (const [label, input] of TRUNCATED) {
  test(`消毒·截断标签：${label} 不得把未消毒标记留在输出`, () => {
    const out = sanitizeNoteHtml(input);
    assertClean(input, out);
  });
}

test("消毒·截断标签：输出中不得出现可再解析的事件属性", () => {
  const out = sanitizeNoteHtml("<img src=x onerror=alert(1)");
  assert.ok(
    !/\bon\w+\s*=/i.test(out),
    `输出残留事件属性：${JSON.stringify(out)}`,
  );
});

// ---- 9. 规模/性能：不崩、正确、配平 ----

test("规模·1000 层嵌套（闭合）正确且配平", () => {
  const input = "<p>".repeat(1000) + "x" + "</p>".repeat(1000);
  const out = sanitizeNoteHtml(input);
  assert.equal(out, input);
  assertClean(input, out);
});

test("规模·1000 层嵌套（不闭合）自动补齐且配平", () => {
  const input = "<p>".repeat(1000) + "x";
  const out = sanitizeNoteHtml(input);
  assert.equal(out, input + "</p>".repeat(1000));
  assertClean(input, out);
});

test("规模·10 万字符纯文本原样保留", () => {
  const input = "a".repeat(100_000);
  assert.equal(sanitizeNoteHtml(input), input);
});

test(
  "规模·10 万字符未闭合半截标签序列不崩（O(n²) 扫描，见复核报告性能项）",
  {
    timeout: 60_000,
  },
  () => {
    const out = sanitizeNoteHtml("<p".repeat(50_000));
    assert.equal(out.length, 100_000, "每个 < 都应作为文本保留");
    assert.ok(out.startsWith("<p<p"));
  },
);

test("规模·大量未闭合 DROP 标签不崩", { timeout: 60_000 }, () => {
  const out = sanitizeNoteHtml("<script>".repeat(15_000));
  assert.equal(out, "");
});
