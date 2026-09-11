// 复核轮（m7-verify）—— htmlSanitize 三修复独立复核（İ 索引错位 / 半截标签回吐 / O(n²)）。
//
// 独立性声明：向量、期望值、检查器全部本轮自写；不 import tests/unit/m7-review 的任何断言/常量，
// 不 import src 的白名单常量。期望输出逐条人工核对过（按 PLAN §2.8/INTERFACE §4.3 契约推导），
// 不是抄实现运行结果。
//
// 出口标准（本轮口径）：
//   1) 危险形态（事件属性/非 http(s) 的 href·src/嵌入类标签/脚本）在任何输出里不得成对出现；
//   2) 规范化内容（白名单标签、正文、İ 等特殊字符）不得被破坏；
//   3) 性能不得回到可感知的卡顿（阈值放宽，只钉「不许数量级回退」）。
//
// 说明：真浏览器解析器（DOMParser）层面的「输出拼不成真元素」验证在真机轮与
// .scratch/m7-verify/dom-parse.ts（Chromium）里做，node:test 层只做文本级不变量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeNoteHtml } from "../../../src/utils/htmlSanitize.ts";

// ---- 自写危险形态检查器（文本级；保守，宁可误报）----

const FORBIDDEN_ELEMENT = [
  "<script",
  "<iframe",
  "<object",
  "<embed",
  "<applet",
  "<style",
  "<link",
  "<meta",
  "<base",
  "<form",
  "<input",
  "<textarea",
  "<title",
  "<template",
  "<svg",
  "<math",
  "<noscript",
  "<xmp",
  "<plaintext",
  "<listing",
];

/** 输出里是否有「看起来还能是属性」的危险形态 */
function dangerFindings(out: string): string[] {
  const bad: string[] = [];
  const lower = out.toLowerCase();
  for (const f of FORBIDDEN_ELEMENT) {
    if (lower.includes(f)) {
      bad.push(`输出残留元素文本 ${f}`);
    }
  }
  const onRe = /\bon[a-z]+\s*=/gi;
  for (const m of lower.matchAll(onRe)) {
    bad.push(`输出残留事件属性形态 ${m[0].trim()}`);
  }
  // href/src 值非 http(s)（引号或无引号都查；空值不算——契约明示无跳转面）
  const attrRe = /(?:href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*))/gi;
  for (const m of out.matchAll(attrRe)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (value !== "" && !/^https?:\/\//i.test(value.replace(/\s+/g, ""))) {
      bad.push(`href/src 值非 http(s)：${JSON.stringify(m[0])}`);
    }
  }
  return bad;
}

function assertNoDanger(out: string, ctx: string): void {
  const bad = dangerFindings(out);
  assert.deepEqual(
    bad,
    [],
    `${ctx}：${JSON.stringify(out)} 残留危险形态:\n  - ${bad.join("\n  - ")}`,
  );
}

// ---- 1. İ（U+0130）向量族：前置/多枚/属性内/文本内 ----
// 索引错位若回归，下列向量会原样回吐危险标签或改名/多闭合。

const İ = "İ";

const UNICODE_OFFSET_CASES: [string, string, string][] = [
  // [说明, 输入, 期望输出（人工核对）]
  ["İ+img onerror", `${İ}<img src=x onerror=alert(1)>`, `${İ}<img>`],
  ["İ×3+script", `${İ.repeat(3)}<script>alert(1)</script>`, `${İ.repeat(3)}`],
  ["İ+svg onload", `${İ}<svg onload=alert(1)></svg>`, `${İ}`],
  [
    "İ+iframe javascript",
    `${İ}<iframe src=javascript:alert(1)></iframe>`,
    `${İ}`,
  ],
  [
    "İ+a javascript href",
    `${İ}<a href="javascript:alert(1)">点我</a>`,
    `${İ}<a>点我</a>`,
  ],
  [
    "İ+a http href 保留",
    `${İ}<a href="https://e.com/x">链</a>`,
    `${İ}<a href="https://e.com/x">链</a>`,
  ],
  [
    "İ 在属性值内（值不动）",
    `<a href="https://${İ}.example/x">链</a>`,
    `<a href="https://${İ}.example/x">链</a>`,
  ],
  ["İ 冒充属性名前缀", `<img src=x ${İ}onerror=alert(1)>`, "<img>"],
  ["İ 在标签名后（仅丢该字符）", `<p${İ}>a</p>`, "<p>a</p>"],
  ["İ+style", `${İ}<style>body{color:red}</style>`, `${İ}`],
  ["İ+object", `${İ}<object data="javascript:alert(1)"></object>`, `${İ}`],
  ["İ+embed", `${İ}<embed src="javascript:alert(1)">`, `${İ}`],
  ["İ+title 藏标签", `${İ}<title><img src=x onerror=alert(1)></title>`, `${İ}`],
  ["İ 在注释里", `${İ}<!-- ${İ} --><p>a</p>`, `${İ}<p>a</p>`],
  ["İ 在闭合标签里", `<p>a</p${İ}>`, "<p>a</p>"],
  [
    "İ+大写 SCRIPT/大小写闭合",
    `${İ}<SCRIPT>alert(1)</ScRiPt><p>x</p>`,
    `${İ}<p>x</p>`,
  ],
  [
    "script 闭合里插 İ（闭合不认→内容按文本留下，无标签）",
    `<script>alert(1)</script${İ}><p>x</p>`,
    "alert(1)<p>x</p>",
  ],
];

for (const [label, input, want] of UNICODE_OFFSET_CASES) {
  test(`İ 族：${label}`, () => {
    const out = sanitizeNoteHtml(input);
    assert.equal(out, want, `输入 ${JSON.stringify(input)}`);
    assertNoDanger(out, label);
  });
}

test("İ 族：İ 在正文里不被吞、配平不破（可正常保存路径触发）", () => {
  const cases: string[] = [
    `<p>${İ}stanbul 是土耳其城市</p><p>第二段</p>`,
    `<p>${İ}İ</p><ul><li>${İ}</li></ul>`,
    `<h2>${İ}</h2><p>${İ}İ</p><p>正文</p>`,
    `<p>关于 ${İ} 的说明</p><p><strong>粗</strong>与<em>斜</em></p>`,
    `<p>${İ}</p><p><a href="https://e.com">链</a></p>`,
    `<p>${İ}</p><table><tr><td>c</td></tr></table>`,
    `<p>${İ}</p><pre><code>code</code></pre>`,
    `<p>a</p>${İ}<p>b</p>`,
  ];
  for (const input of cases) {
    assert.equal(
      sanitizeNoteHtml(input),
      input,
      `规范产物应原样通过：${input}`,
    );
  }
});

test("İ 族：闭合标签查找大小写不敏感（</P> 关 <p>、</SCRIPT> 丢 script）", () => {
  assert.equal(sanitizeNoteHtml("<p>a</P>"), "<p>a</p>");
  assert.equal(sanitizeNoteHtml("<p>a</p></p>"), "<p>a</p>", "多余闭合丢弃");
  assert.equal(
    sanitizeNoteHtml("<SCRIPT>alert(1)</ScRiPt><p>x</p>"),
    "<p>x</p>",
  );
});

// 长度变化/大小写展开的特殊字符 sweep：不依赖实现「枚举了哪个字符」，行为必须一致。
const SWEEP_CHARS: [string, string][] = [
  ["İ U+0130（小写展开 1→2）", "İ"],
  ["ı U+0131", "ı"],
  ["ſ U+017F（大写折叠到 S）", "ſ"],
  ["ẞ U+1E9E", "ẞ"],
  ["ß U+00DF", "ß"],
  ["Σ U+03A3", "Σ"],
  ["ﬁ U+FB01", "ﬁ"],
  ["ǅ U+01C5", "ǅ"],
  ["软连字符 U+00AD", "­"],
  ["零宽空格 U+200B", "​"],
];

for (const [label, ch] of SWEEP_CHARS) {
  test(`特殊字符 sweep：${label} 前置不改变判定`, () => {
    const img = sanitizeNoteHtml(`${ch}<img src=x onerror=alert(1)>`);
    assert.equal(img, `${ch}<img>`, "危险属性必须剥净、正文权重字符保留");
    assertNoDanger(img, label);
    const script = sanitizeNoteHtml(`${ch}<script>alert(1)</script>`);
    assert.equal(script, ch, "script 连内容整体移除");
    const normal = sanitizeNoteHtml(`<p>${ch}文本</p><p>${ch}</p>`);
    assert.equal(normal, `<p>${ch}文本</p><p>${ch}</p>`, "正常文本原样");
  });
}

// ---- 2. 半截（截到 EOF 无 >）片段族 ----
// 口径：危险半截整段丢弃（fail-closed）；安全的自然文本半截原样保留、不吞正文。

const TRUNCATED_DANGEROUS: [string, string][] = [
  ["img 无引号 onerror", "<img src=x onerror=alert(1)"],
  ["img 带尾空格", "<img src=x onerror=alert(1) "],
  ["iframe javascript", "<iframe src=javascript:alert(1) "],
  ["svg onload", "<svg onload=alert(1)"],
  ["a 非 http href", "<a href=javascript:alert(1)"],
  ["大写 ONERROR", "<IMG SRC=x ONERROR=y"],
  ["引号包裹的 > 不豁免", '<img src=x onerror="alert(1)>x'],
  ["已闭合 script 后接半截危险", "<script>alert(1)</script><img onerror=x"],
];

for (const [label, input] of TRUNCATED_DANGEROUS) {
  test(`半截危险：${label} → 整段丢弃，不残留 on*/标签文本`, () => {
    const out = sanitizeNoteHtml(input);
    assert.equal(
      out,
      "",
      `应全部丢弃（fail-closed），实际 ${JSON.stringify(out)}`,
    );
  });
}

test("半截危险：正文在危险片段之前时只丢危险段", () => {
  assert.equal(sanitizeNoteHtml("前文 <img src=x onerror=alert(1)"), "前文 ");
});

const TRUNCATED_SAFE: [string, string][] = [
  ["连续半截 p", "<p<p<p"],
  ["自然文本里的半截 a", "看这个 <a href="],
  ["半截 p 接正文", "前文 <p<p"],
  ["引号里含 > 的半截 a（https 值）", '<a href="https://e>x"'],
  ["裸 <", "a < b，<3 都算文本"],
  ["半截 img 仅 https src", "<img src=https://e/a.png"],
];

for (const [label, input] of TRUNCATED_SAFE) {
  test(`半截安全：${label} 原样按文本保留`, () => {
    assert.equal(sanitizeNoteHtml(input), input);
  });
}

test("半截安全：未闭合的相对 src（可补成相对路径跳转面）整段丢弃", () => {
  assert.equal(sanitizeNoteHtml("<img src=/a.png"), "");
});

test("半截：未闭合 <script> 的文本无标签泄露（无执行面）", () => {
  const out = sanitizeNoteHtml("<script>alert(1)");
  assert.equal(out, "alert(1)");
  assert.ok(!out.includes("<"), "不允许残留任何 <");
  assertNoDanger(out, "未闭合 script");
});

test("半截：未闭合 <style> 同理（文本留下、无标签）", () => {
  const out = sanitizeNoteHtml("<style>body{color:red}");
  assert.equal(out, "body{color:red}");
  assert.ok(!out.includes("<"));
});

// ---- 3. 危险形态扫描（自写检查器逐输出跑一遍）----

test("全向量输出扫危险形态：不允许 script/事件属性/非 http 引用成对出现", () => {
  const all = [
    ...UNICODE_OFFSET_CASES.map(([, input]) => input),
    ...TRUNCATED_DANGEROUS.map(([, input]) => input),
    ...TRUNCATED_SAFE.map(([, input]) => input),
    '<a href="javascript:alert(1)">x</a>',
    "<div onclick=x>t</div>",
    '<img src="data:text/html,x">',
    "<!--[if IE]><script>alert(1)</script><![endif]-->",
  ];
  for (const input of all) {
    const out = sanitizeNoteHtml(input);
    assertNoDanger(out, JSON.stringify(input));
  }
});

// ---- 4. 验收锁定语义回归（PLAN §2.8 / acceptance notes 用例同口径）----

test("回归：script 连标签带内容整体移除，周围段落保留", () => {
  const out = sanitizeNoteHtml("<p>a</p><script>alert(1)</script><p>b</p>");
  assert.equal(out, "<p>a</p><p>b</p>");
  assert.ok(!out.includes("script"));
  assert.ok(!out.includes("alert"));
});

test("回归：纯 script 输入 → 空串（SANITIZE_REJECTED 路径）", () => {
  assert.equal(sanitizeNoteHtml("<script>alert(1)</script>"), "");
});

test("回归：白名单标签/属性原样保留（追加标记格式契约）", () => {
  const html =
    "<h1>题</h1><p><strong>粗</strong><em>斜</em><code>c</code></p><pre><code>block</code></pre><ul><li>i</li></ul><blockquote>q</blockquote><hr>";
  assert.equal(sanitizeNoteHtml(html), html);
  const marker =
    "<hr><p><small>zotero-claudian 追加（2026-09-09T10:00:00.000Z）</small></p>";
  assert.equal(sanitizeNoteHtml(marker), marker);
  assert.equal(
    sanitizeNoteHtml('<ol start="3"><li>三</li></ol>'),
    '<ol start="3"><li>三</li></ol>',
  );
  assert.equal(
    sanitizeNoteHtml('<ol start="x"><li>三</li></ol>'),
    "<ol><li>三</li></ol>",
    "start 非整数剥离",
  );
});

test("回归：URL 协议限制（http(s) 放行、其余剥离，混乱写法全挡）", () => {
  assert.equal(
    sanitizeNoteHtml('<a href="https://example.com/paper">原文</a>'),
    '<a href="https://example.com/paper">原文</a>',
  );
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "jav\tascript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example",
    "/relative",
  ]) {
    const out = sanitizeNoteHtml(`<a href="${bad}">点我</a>`);
    assert.ok(!out.includes("href"), `危险 href 应剥离：${bad} → ${out}`);
    assert.ok(out.includes("点我"), "正文保留");
  }
});

test("回归：事件属性矩阵（白名单标签上/非白名单标签上都剥）", () => {
  for (const attr of [
    "onclick",
    "onerror",
    "onload",
    "onmouseover",
    "onfocus",
  ]) {
    const input = `<p ${attr}="x()">hi</p>`;
    assert.equal(sanitizeNoteHtml(input), "<p>hi</p>");
    const img = `<img src="https://e/a.png" ${attr}="x()">`;
    assert.equal(
      sanitizeNoteHtml(img),
      '<img src="https://e/a.png">',
      `${attr} 必须剥`,
    );
  }
});

test("回归：空/非字符串输入 → 空串", () => {
  assert.equal(sanitizeNoteHtml(""), "");
  for (const v of [undefined, null, 0, 1, true, {}, [], Symbol("x")]) {
    assert.equal(sanitizeNoteHtml(v as unknown as string), "");
  }
});

test("回归：消毒幂等（除文档化的截断闭合边界外，二次消毒不变）", () => {
  const inputs = [
    ...UNICODE_OFFSET_CASES.map(([, input]) => input),
    ...TRUNCATED_DANGEROUS.map(([, input]) => input),
    ...TRUNCATED_SAFE.map(([, input]) => input),
    "<p>a</p><script>alert(1)</script><p>b</p>",
  ];
  for (const input of inputs) {
    const once = sanitizeNoteHtml(input);
    assert.equal(
      sanitizeNoteHtml(once),
      once,
      `不幂等：${JSON.stringify(input)}`,
    );
  }
});

// NEW-2 已修（dbcad29）：截断闭合标签丢首字符 `<`、其余按正文保留（不吞内容），输出幂等。
// 输入 `<p>a</p ` → 输出 `<p>a/p </p>`，再消毒不变。
test("截断闭合标签：不吐半截标记且输出幂等（NEW-2 修复后行为）", () => {
  const once = sanitizeNoteHtml("<p>a</p ");
  assert.equal(once, "<p>a/p </p>");
  assert.equal(sanitizeNoteHtml(once), once);
});

// ---- 5. 性能：修复者口径复测 + 自构最坏形态 ----

function ms(input: string): number {
  const t0 = performance.now();
  sanitizeNoteHtml(input);
  return performance.now() - t0;
}

test("性能：'<p'×50k（10 万字符无 >）线性完成", { timeout: 30_000 }, () => {
  const t = ms("<p".repeat(50_000));
  assert.ok(t < 1500, `实测 ${t.toFixed(1)}ms（修复前 3254ms 级）`);
});

test("性能：'<p'×100k（20 万字符）线性完成", { timeout: 30_000 }, () => {
  const t = ms("<p".repeat(100_000));
  assert.ok(t < 2000, `实测 ${t.toFixed(1)}ms`);
});

test("性能：'<script>'×15k 未闭合连发不空搜", { timeout: 30_000 }, () => {
  const t = ms("<script>".repeat(15_000));
  assert.ok(t < 1500, `实测 ${t.toFixed(1)}ms`);
});

test(
  "性能：半截危险连发（'<img onerror='×50k）一次判负",
  { timeout: 30_000 },
  () => {
    const t = ms("<img onerror=".repeat(50_000));
    assert.ok(t < 1500, `实测 ${t.toFixed(1)}ms`);
  },
);

test("性能：实体/深层嵌套等混合大输入不卡顿", { timeout: 60_000 }, () => {
  const cases: [string, string][] = [
    ["实体混合 60 万字符", "<p>&amp;</p>".repeat(50_000)],
    ["深嵌套 10k 闭合", "<p>".repeat(10_000) + "x" + "</p>".repeat(10_000)],
    [
      "交错闭合 <p><strong>×20k",
      "<p><strong>".repeat(20_000) + "</p>".repeat(20_000),
    ],
  ];
  for (const [label, input] of cases) {
    const t = ms(input);
    assert.ok(t < 3000, `${label} 实测 ${t.toFixed(1)}ms`);
  }
});

// 残余二次方（本轮新发现，见复核报告）：错位闭合标签 × 深栈命中 closeTag 的全栈 lastIndexOf。
// 20k+20k（24 万字符）实测 ~0.5s；100k+100k（120 万字符）实测 ~13s。
// 阈值放宽到 3s：只钉「不许再从 0.5s 量级恶化」；不掩盖其超线性事实。
test(
  "性能边界：错位闭合 × 深栈（20k+20k）超线性但暂在阈值内",
  { timeout: 60_000 },
  () => {
    const t = ms("<p>".repeat(20_000) + "</strong>".repeat(20_000));
    assert.ok(
      t < 3000,
      `实测 ${t.toFixed(1)}ms（线性应 <50ms，超线性为本轮新发现）`,
    );
  },
);

// ---- 6. 索引策略防回退守卫（读源码：不得再出现整串大小写变换）----

test("守卫：实现不得把整串 toLowerCase 的副本当索引用（BUG-29 根因防护）", () => {
  const src = readFileSync(
    new URL("../../../src/utils/htmlSanitize.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/html\.toLowerCase\(\)\s*;/.test(src),
    "出现整串 toLowerCase 副本——索引错位（İ 展开 1→2）会整体回归",
  );
  assert.ok(
    !/\blower\.(slice|indexOf|startsWith|startsWith)/.test(src),
    "出现用小写副本取索引/切原文的写法",
  );
  assert.ok(
    /lastIndexOf\(">"\)/.test(src),
    "findTagEnd 的 lastGt 前置守卫缺失（半截输入会回 O(n²)）",
  );
});
