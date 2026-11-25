// 单测 — r22-supsub：src/chat/lib/markdown.ts 中插入符上标扩展与双波浪线删除线规则的白盒补充。
// 覆盖验收用例（tests/acceptance/r22-supsub.test.mjs）未涉及的停止字符、触发前导字符、
// 无内容与未闭合花括号、块级容器、链接地址、混合波浪线与流式半截文本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Marked } from "marked";
import {
  MARKED_BASE_EXTENSION,
  parseMarkdownUnsafe,
  renderCaretSup,
} from "../../src/chat/lib/markdown.ts";

const render = (md) => parseMarkdownUnsafe(md).trim();

test("普通形式遇 | $ < * , ; 停止，停止字符留在上标外", () => {
  assert.equal(render("x^a|b"), "<p>x<sup>a</sup>|b</p>");
  assert.equal(render("x^a$b"), "<p>x<sup>a</sup>$b</p>");
  assert.equal(render("x^a<b"), "<p>x<sup>a</sup>&lt;b</p>");
  assert.equal(render("x^a*b*"), "<p>x<sup>a</sup><em>b</em></p>");
  assert.equal(render("x^a,b"), "<p>x<sup>a</sup>,b</p>");
  assert.equal(render("x^a;b"), "<p>x<sup>a</sup>;b</p>");
});

test("普通形式遇 ( ) [ ] 与反引号停止", () => {
  assert.equal(render("x^a(b)"), "<p>x<sup>a</sup>(b)</p>");
  assert.equal(render("x^a)b"), "<p>x<sup>a</sup>)b</p>");
  assert.equal(render("x^a[b"), "<p>x<sup>a</sup>[b</p>");
  assert.equal(render("x^a]b"), "<p>x<sup>a</sup>]b</p>");
  assert.equal(render("x^a`b`"), "<p>x<sup>a</sup><code>b</code></p>");
});

test("末尾的 : ! ? 留在上标外；内容中间的 . 保留", () => {
  assert.equal(render("x^a:"), "<p>x<sup>a</sup>:</p>");
  assert.equal(render("x^a!"), "<p>x<sup>a</sup>!</p>");
  assert.equal(render("x^a? 好"), "<p>x<sup>a</sup>? 好</p>");
  assert.equal(render("x^a.b"), "<p>x<sup>a.b</sup></p>");
});

test("前一个字符为希腊字母、) 或 ] 时触发", () => {
  assert.equal(render("α^2"), "<p>α<sup>2</sup></p>");
  assert.equal(render("β^{n}"), "<p>β<sup>n</sup></p>");
  assert.equal(render("(a+b)^2"), "<p>(a+b)<sup>2</sup></p>");
  assert.equal(render("[1]^3"), "<p>[1]<sup>3</sup></p>");
  // 第三次补充：前一个字符在别的语法片段里（链接）时不触发
  assert.equal(render("[t](u)^2"), '<p><a href="u">t</a>^2</p>');
});

test("前一个字符为中文时不触发", () => {
  assert.equal(render("中^2"), "<p>中^2</p>");
});

test("^ 后无内容时原样输出", () => {
  assert.equal(render("a^ b"), "<p>a^ b</p>");
  assert.equal(render("行尾 a^"), "<p>行尾 a^</p>");
  assert.equal(render("x^."), "<p>x^.</p>");
});

test("^{ 无闭合花括号或花括号为空时原样输出，不按普通形式处理", () => {
  assert.equal(render("x^{a"), "<p>x^{a</p>");
  assert.equal(render("x^{a b"), "<p>x^{a b</p>");
  assert.equal(render("x^{}"), "<p>x^{}</p>");
});

test("花括号内容按 HTML 转义；内含 HTML 标签时文字被切成多段，不成上标", () => {
  assert.equal(render("x^{a&b}"), "<p>x<sup>a&amp;b</sup></p>");
  assert.equal(render("x^{<b>}"), "<p>x^{<b>}</p>");
});

test("表格单元格、列表项、标题与链接文字中的上标", () => {
  const table = render("| h |\n|---|\n| Ca^2+ |");
  assert.equal(table.includes("<td>Ca<sup>2+</sup></td>"), true);
  assert.equal(
    render("- CD8^+ 细胞"),
    "<ul>\n<li>CD8<sup>+</sup> 细胞</li>\n</ul>",
  );
  assert.equal(render("# Tgfbr2^flox"), "<h1>Tgfbr2<sup>flox</sup></h1>");
  assert.equal(
    render("[Ca^2+ 链接](https://e.com/p)"),
    '<p><a href="https://e.com/p">Ca<sup>2+</sup> 链接</a></p>',
  );
});

test("链接地址中的 ^ 与 ~ 不被改写为上标或删除线", () => {
  const html = render("[t](https://e.com/a^b~c~d)");
  assert.equal(html.includes("<sup>"), false);
  assert.equal(html.includes("<del>"), false);
  assert.equal(html.includes('href="https://e.com/a%5Eb~c~d"'), true);
});

test("裸 URL 中的 ^ 与 ~ 不被改写为上标或删除线", () => {
  const html = render("见 https://e.com/x^y~z~/p 处");
  assert.equal(html.includes("<sup>"), false);
  assert.equal(html.includes("<del>"), false);
  assert.equal(html.includes('href="https://e.com/x%5Ey~z~/p"'), true);
});

test("混合波浪线：双波浪线内的单波浪线原样；单波浪线开头不成删除线", () => {
  assert.equal(render("~~a~b~~"), "<p><del>a~b</del></p>");
  assert.equal(render("~a~~b~"), "<p>~a~~b~</p>");
  assert.equal(render("H~~2~~O"), "<p>H<del>2</del>O</p>");
});

test("流式半截文本不抛错", () => {
  for (const partial of ["x^", "x^{a", "~~删", "x^{", "^", "~", "Tgfbr2^fl"]) {
    assert.doesNotThrow(() => parseMarkdownUnsafe(partial));
  }
  assert.equal(render("x^"), "<p>x^</p>");
  assert.equal(render("x^{a"), "<p>x^{a</p>");
  assert.equal(render("~~删"), "<p>~~删</p>");
  assert.equal(render("Tgfbr2^fl"), "<p>Tgfbr2<sup>fl</sup></p>");
});

// ---- 修订节（行为清单 16–25 及补充说明）的边界 ----

test("数字形式：U+2212 减号可作前导正负号", () => {
  assert.equal(render("10^−5 后"), "<p>10<sup>−5</sup> 后</p>");
});

test("数字形式：小数指数，小数点后须有数字", () => {
  assert.equal(render("x^1.5倍"), "<p>x<sup>1.5</sup>倍</p>");
  assert.equal(render("10^3."), "<p>10<sup>3</sup>.</p>");
  assert.equal(render("x^1.5.2"), "<p>x<sup>1.5</sup>.2</p>");
});

test("数字形式：尾随正负号后接希腊字母时不并入，后接空白或结尾时并入", () => {
  assert.equal(render("x^2+α"), "<p>x<sup>2</sup>+α</p>");
  assert.equal(render("x^2+ y"), "<p>x<sup>2+</sup> y</p>");
  assert.equal(render("x^2+"), "<p>x<sup>2+</sup></p>");
});

test("数字形式：尾随正负号后接开括号不并入，后接 ) , 。 时并入", () => {
  assert.equal(render("x^2+(y)"), "<p>x<sup>2</sup>+(y)</p>");
  assert.equal(render("(Ca^2+)"), "<p>(Ca<sup>2+</sup>)</p>");
  assert.equal(
    render("Ca^2+, Mg^2+。"),
    "<p>Ca<sup>2+</sup>, Mg<sup>2+</sup>。</p>",
  );
});

test("字母形式：在 = { } 与反斜杠处停止", () => {
  assert.equal(render("x^a=b"), "<p>x<sup>a</sup>=b</p>");
  assert.equal(render("x^a{b"), "<p>x<sup>a</sup>{b</p>");
  assert.equal(render("x^a}b"), "<p>x<sup>a</sup>}b</p>");
  assert.equal(render("x^a\\*b"), "<p>x<sup>a</sup>*b</p>");
});

test("闭合 ^ 位于文本结尾或后接 . 时被吃掉", () => {
  assert.equal(render("Tgfbr2^flox^"), "<p>Tgfbr2<sup>flox</sup></p>");
  assert.equal(render("2^3^"), "<p>2<sup>3</sup></p>");
  assert.equal(render("x^a^."), "<p>x<sup>a</sup>.</p>");
});

test("闭合 ^ 后接字母时保留并重新触发", () => {
  assert.equal(render("x^a^b"), "<p>x<sup>a</sup><sup>b</sup></p>");
});

test("连续 ^（a^b^^c）不抛错，只吃掉一个闭合符", () => {
  assert.doesNotThrow(() => parseMarkdownUnsafe("a^b^^c"));
  assert.equal(render("a^b^^c"), "<p>a<sup>b</sup>^c</p>");
});

// ---- 性能回归：三处曾为二次复杂度的输入 ----

test("性能：上标内容末尾大量句读不回溯", { timeout: 2000 }, () => {
  // 第二次补充第 1 条起首字符须为字母/数字/正负号，故以 a 起首、中间大量句读
  const html = parseMarkdownUnsafe("x^a" + ".".repeat(40000) + "b");
  assert.equal(html.includes("<sup>"), true);
  const trailing = parseMarkdownUnsafe("x^a" + ".".repeat(40000));
  assert.equal(trailing.includes("<sup>a</sup>"), true);
});

test("性能：大量未闭合 ^{ 不反复扫到行尾", { timeout: 2000 }, () => {
  const html = parseMarkdownUnsafe("a^{".repeat(40000));
  assert.equal(html.includes("<sup>"), false);
});

test("性能：大量不触发的 ^ 不逐段分词", { timeout: 2000 }, () => {
  const html = parseMarkdownUnsafe("中^".repeat(40000));
  assert.equal(html.includes("<sup>"), false);
});

// ---- 第二次补充（规则收紧）----

test("补充 1：内容首字符须为字母、数字或正负号", () => {
  assert.equal(render("ok^_^"), "<p>ok^_^</p>");
  assert.equal(render("x^\u{1F600}"), "<p>x^\u{1F600}</p>");
  assert.equal(render("x^.a"), "<p>x^.a</p>");
  assert.equal(render("x^/a"), "<p>x^/a</p>");
});

test("补充 2：路径与地址中的 ^ 不触发", () => {
  assert.equal(render("/tmp/a^b.txt"), "<p>/tmp/a^b.txt</p>");
  assert.equal(render("C:\\Users\\a^b"), "<p>C:\\Users\\a^b</p>");
  assert.equal(render("~/a^b/c"), "<p>~/a^b/c</p>");
  assert.equal(render("e.com/a^b"), "<p>e.com/a^b</p>");
});

test("补充 2：回看止于 ; 、空白与中文，基因型组合照常触发", () => {
  assert.equal(
    render("Kras^LSL-G12D/+;Trp53^fl/fl"),
    "<p>Kras<sup>LSL-G12D/+</sup>;Trp53<sup>fl/fl</sup></p>",
  );
  assert.equal(render("a/b x^2"), "<p>a/b x<sup>2</sup></p>");
  assert.equal(render("a/b中x^2"), "<p>a/b中x<sup>2</sup></p>");
});

test("补充 2：回看至多 64 个字符", () => {
  const far = "/" + "a".repeat(64);
  assert.equal(render(far + "^2"), `<p>${far}<sup>2</sup></p>`);
  const near = "/" + "a".repeat(63);
  assert.equal(render(near + "^2"), `<p>${near}^2</p>`);
});

test("第三次补充 2、3：上标与回看只在同一段连续文字内", () => {
  // 回看不跨越加粗：段内 x 之前无 / ，照常触发
  assert.equal(render("/**a**x^2"), "<p>/<strong>a</strong>x<sup>2</sup></p>");
  // ^ 位于一段文字开头（前一个字符在链接、加粗里）不触发
  assert.equal(render("[t](u)^2"), '<p><a href="u">t</a>^2</p>');
  assert.equal(render("**a**^b"), "<p><strong>a</strong>^b</p>");
  // 转义字符是独立片段：2\*10^3 中 10^3 所在的文字段照常触发
  assert.equal(render("2\\*10^3"), "<p>2*10<sup>3</sup></p>");
});

test("第三次补充 5：上标内容不解析其他 Markdown 语法", () => {
  assert.equal(render("x^*y*"), "<p>x^<em>y</em></p>");
});

test("补充 3：字母形式在半角双引号与单引号处停止", () => {
  assert.equal(render('grep "x^y"'), "<p>grep &quot;x<sup>y</sup>&quot;</p>");
  assert.equal(render("x^a'b"), "<p>x<sup>a</sup>&#39;b</p>");
});

test("补充 4：字母形式内部的 + - / 属于内容", () => {
  assert.equal(render("Apc^Min/+ 小鼠"), "<p>Apc<sup>Min/+</sup> 小鼠</p>");
  assert.equal(render("p53^-/- 小鼠"), "<p>p53<sup>-/-</sup> 小鼠</p>");
  // 已知局限：字母指数的算式会把 n+b 一并抬高
  assert.equal(render("a^n+b^n"), "<p>a<sup>n+b</sup><sup>n</sup></p>");
});

test("补充 5：花括号形式之后紧跟的 ^ 照常重新判定", () => {
  assert.equal(render("x^{a}^{b}"), "<p>x<sup>a</sup><sup>b</sup></p>");
  assert.equal(render("x^{a}^2"), "<p>x<sup>a</sup><sup>2</sup></p>");
});

test("第三次补充 4：图片替代文字、链接地址、原始 HTML 内的 ^ 原样保留", () => {
  assert.equal(render("![x^2](u)"), '<p><img src="u" alt="x^2"></p>');
  assert.equal(render("x^2 ![a](u)").includes("x<sup>2</sup>"), true);
  assert.equal(render("[t](u^2)"), '<p><a href="u%5E2">t</a></p>');
  assert.equal(
    render('<span title="a^2">b</span>'),
    '<p><span title="a^2">b</span></p>',
  );
});

// ---- 第二次复判的性能回归（20 万字符级单段落）----

const perfCases = [
  ["a^. ", 50000],
  ["a^! ", 50000],
  ["[^1] ", 40000],
  ["x^ ", 66000],
  ["中^", 100000],
  ["a/b^c ", 33000],
  ["a!b ", 50000],
];
for (const [unit, times] of perfCases) {
  test(
    `性能：${JSON.stringify(unit)} 重复 ${times} 次`,
    { timeout: 2000 },
    () => {
      const html = parseMarkdownUnsafe(unit.repeat(times));
      assert.equal(html.includes("<sup>"), false);
    },
  );
}

// ---- 第三次打回：文本渲染阶段实现的差分、回归与性质测试 ----

// 对照实例：同一份基础配置（双波浪线删除线 + code 渲染器），不装上标文本渲染
const baseline = new Marked(MARKED_BASE_EXTENSION);

function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomPieces(next, pieces, maxPieces) {
  const count = 1 + Math.floor(next() * maxPieces);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += pieces[Math.floor(next() * pieces.length)];
  }
  return out;
}

// 字符实体片段：按一定比例混入随机输入（实体与相邻字符之间可能被上标边界切开）
const ENTITY_PIECES = ["&amp;", "&nbsp;", "&lt;", "&#39;", "&quot;", "&#x41;"];
const PLAIN_CHARS = [..."abcXYZ019σ中文字 \n*_~`[]()<>&!#-+.|:/\\\"';"];

test("差分：2000 组不含 ^ 的随机输入（含 ; 与字符实体）与对照实例逐字相等", () => {
  const pieces = [...PLAIN_CHARS, ...PLAIN_CHARS, ...ENTITY_PIECES];
  const next = makeRandom(20261125);
  for (let n = 0; n < 2000; n++) {
    const input = randomPieces(next, pieces, 40);
    assert.equal(
      parseMarkdownUnsafe(input),
      baseline.parse(input),
      `输入 ${JSON.stringify(input)}`,
    );
  }
});

test("回归：原始 HTML 内的 ^ 与特殊字符不被二次转义", () => {
  const input = `<code>^ "q" & 'p' <= 1</code>`;
  assert.equal(parseMarkdownUnsafe(input), baseline.parse(input));
});

test("回归：上标后的 _i_ 不被误判为斜体、下划线不丢失", () => {
  assert.equal(
    render("σ^2_i_ 与 σ^2_j_"),
    "<p>σ<sup>2</sup>_i_ 与 σ<sup>2</sup>_j_</p>",
  );
  assert.equal(render("x^2_foo_ bar"), "<p>x<sup>2</sup>_foo_ bar</p>");
});

test("回归：单行大量成立的上标不重扫行尾", { timeout: 2000 }, () => {
  const html = parseMarkdownUnsafe("x^2 ".repeat(50000));
  assert.equal(html.split("<sup>2</sup>").length - 1, 50000);
});

test("回归：字母形式内容不把字符实体从中间切开", () => {
  assert.equal(render("a^b&amp;c"), "<p>a<sup>b</sup>&amp;c</p>");
  assert.equal(
    render("Tgfbr2^flox&nbsp;小鼠"),
    "<p>Tgfbr2<sup>flox</sup>&nbsp;小鼠</p>",
  );
  assert.equal(render("x^a&lt;b"), "<p>x<sup>a</sup>&lt;b</p>");
  assert.equal(render("x^a&#39;s"), "<p>x<sup>a</sup>&#39;s</p>");
  assert.equal(render("x^a&quot;b"), "<p>x<sup>a</sup>&quot;b</p>");
  assert.equal(render("x^a&#x41;b"), "<p>x<sup>a</sup>&#x41;b</p>");
  // 截到 & 之前为空：不成上标
  assert.equal(render("x^&amp;"), "<p>x^&amp;</p>");
  // & 后不构成实体：照常转义并留在上标内（验收第 8 条）
  assert.equal(render("x^a&b 后"), "<p>x<sup>a&amp;b</sup> 后</p>");
  assert.equal(renderCaretSup("a^b&amp;c"), "a<sup>b</sup>&amp;c");
  // 先截实体、再剥末尾句读：截断后新暴露的 . : ! 留在上标外
  assert.equal(render("a^b.&amp;c"), "<p>a<sup>b</sup>.&amp;c</p>");
  assert.equal(render("a^b:&lt;"), "<p>a<sup>b</sup>:&lt;</p>");
  assert.equal(render("x^a!&#39;s"), "<p>x<sup>a</sup>!&#39;s</p>");
});

test("回归：花括号内的完整实体不被二次转义，不完整的与对照一致转义", () => {
  assert.equal(render("x^{a&amp;b}"), "<p>x<sup>a&amp;b</sup></p>");
  assert.equal(render("x^{a&amp}"), "<p>x<sup>a&amp;amp</sup></p>");
});

/**
 * 本实现输出去掉 <sup>、</sup> 后，须能由对照输出只删去若干 ^ { } 得到（不做反转义）。
 * 返回 null 表示满足，否则返回首个不一致位置的说明
 */
function deletionOnlyMismatch(baselineHtml, oursHtml) {
  const ours = oursHtml.replaceAll("<sup>", "").replaceAll("</sup>", "");
  let j = 0;
  for (let i = 0; i < baselineHtml.length; i++) {
    const ch = baselineHtml[i];
    if (j < ours.length && ours[j] === ch) {
      j++;
    } else if (!"^{}".includes(ch)) {
      return `对照第 ${i} 字符 ${JSON.stringify(ch)} 未出现在本实现输出中`;
    }
  }
  return j === ours.length
    ? null
    : `本实现多出 ${JSON.stringify(ours.slice(j))}`;
}

test("性质：3000 组含 ^ 的随机输入，输出只比对照删去 ^ { }、增加 sup 标签", () => {
  const pieces = [
    ...PLAIN_CHARS,
    ...ENTITY_PIECES,
    "^",
    "^",
    // 前导字符可触发的 ^，提高上标成立的比例
    "a^",
    "x^",
    "2^",
    "σ^",
    ")^",
    "b^{",
    "{",
    "}",
    "**",
    "_",
    "*",
    "<code>",
    "</code>",
    "<kbd>",
    "</kbd>",
    "\\*",
    "\\^",
    "\\_",
    "\\\\",
  ];
  const next = makeRandom(20261127);
  for (let n = 0; n < 3000; n++) {
    const input = randomPieces(next, pieces, 40);
    let html = "";
    assert.doesNotThrow(
      () => {
        html = parseMarkdownUnsafe(input);
      },
      `输入 ${JSON.stringify(input)}`,
    );
    const mismatch = deletionOnlyMismatch(baseline.parse(input), html);
    assert.equal(mismatch, null, `输入 ${JSON.stringify(input)}：${mismatch}`);
  }
});

const mixedWords = [
  "Tgfbr2",
  "细胞",
  "表达",
  "CD8",
  "the",
  "mice",
  "显著",
  "and",
  "IL-6",
  "通路",
  "，",
  "。",
  "Ca",
];
function mixedLine(nChars, nSup) {
  const next = makeRandom(7);
  const sups = ["^2", "^{fl/fl}", "^+", "^-5"];
  let s = "";
  let count = 0;
  while (s.length < nChars) {
    s += mixedWords[Math.floor(next() * mixedWords.length)];
    if (count < nSup && next() < (3 * nSup) / nChars) {
      s += sups[count % sups.length];
      count++;
    }
    if (next() < 0.3) s += " ";
  }
  return s;
}

const textStagePerfCases = [
  ["x^2 ×50000", "x^2 ".repeat(50000)],
  ["ab^c d ×30000", "ab^c d ".repeat(30000)],
  ["a^. ×50000", "a^. ".repeat(50000)],
  ["[^1] ×40000", "[^1] ".repeat(40000)],
  ["/p/a^b ×30000", "/p/a^b ".repeat(30000)],
  ["5 万字混排夹 2000 个上标", mixedLine(50000, 2000)],
];
for (const [name, input] of textStagePerfCases) {
  test(`性能：${name}`, { timeout: 2000 }, () => {
    assert.doesNotThrow(() => parseMarkdownUnsafe(input));
  });
}
