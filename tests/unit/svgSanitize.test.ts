// 单测 — src/chat/lib/svgSanitize.ts（AI 输出 SVG 的保守消毒器）
// 覆盖：恶意向量矩阵（执行面/外联面/结构面）、白名单行为、样式收敛（<style> 必须以 #id 打头）、
// 幂等与配平。所有断言只看「消毒产物」本身（不依赖 DOM）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SVG_ALLOWED_TAGS,
  sanitizeSvg,
  sanitizeStyleDecls,
  sanitizeSvgCss,
} from "../../src/chat/lib/svgSanitize.ts";

/** 产物里不得出现的危险形态（可执行/外联/哈希/属性残留） */
const DANGEROUS = [
  "<script",
  "javascript:",
  "onload",
  "onerror",
  "onbegin",
  "onclick",
  "foreignobject",
  "foreignObject",
  "xlink:href",
  "<use",
  "<image",
  "<iframe",
  "<animate",
  "<filter",
  "<style",
];

function assertNoDanger(out: string, label: string): void {
  for (const bad of DANGEROUS) {
    assert.ok(
      !out.toLowerCase().includes(bad.toLowerCase()),
      `${label}: 产物残留危险形态 ${bad} —— ${out.slice(0, 200)}`,
    );
  }
}

// ---- 恶意向量矩阵 ----

test("svg: 事件属性 onload/onerror/onclick 全剥（属性名层面出局）", () => {
  const out = sanitizeSvg(
    `<svg onload="alert(1)"><rect onerror="alert(2)" onclick="alert(3)" width="10"/></svg>`,
  );
  assertNoDanger(out, "events");
  assert.ok(out.startsWith("<svg>"), out);
  assert.ok(out.includes('<rect width="10"></rect>'), out);
});

test("svg: <script> 连内容一起丢（内容不是图形，留着只会泄漏代码）", () => {
  const out = sanitizeSvg(
    `<svg><script>alert('XSS-MARK')</script><rect/></svg>`,
  );
  assertNoDanger(out, "script");
  assert.ok(!out.includes("XSS-MARK"), out);
  assert.ok(out.includes("<rect>"), out);
});

test("svg: <foreignObject> 连内容整棵丢弃（HTML 注入壳体）", () => {
  const out = sanitizeSvg(
    `<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject><circle r="4"/></svg>`,
  );
  assertNoDanger(out, "foreignObject");
  assert.ok(!out.includes("img"), out);
  assert.ok(out.includes('<circle r="4">'), out);
});

test("svg: <use href=javascript:…> 出局（use 不在白名单，href 也不在）", () => {
  const out = sanitizeSvg(
    `<svg><use href="javascript:alert(1)"/><use xlink:href="#x"/></svg>`,
  );
  assertNoDanger(out, "use");
  assert.equal(out, ""); // 全被丢光（没有绘图元素）→ 空串，调用方退回源码展示
});

test("svg: <animate onbegin=…> 出局（动画系整族不在白名单）", () => {
  const out = sanitizeSvg(
    `<svg><rect width="1"><animate onbegin="alert(1)" attributeName="x"/><animateTransform onbegin="alert(2)"/></rect></svg>`,
  );
  assertNoDanger(out, "animate");
  assert.equal(out, `<svg><rect width="1"></rect></svg>`);
});

test("svg: <image href=…> 出局（无点击外发通道，与 markdown 侧 img 同策）", () => {
  const out = sanitizeSvg(
    `<svg><image href="https://evil.example/x.png"/><image xlink:href="data:image/svg+xml;base64,PHN2Zz4="/></svg>`,
  );
  assertNoDanger(out, "image");
  assert.equal(out, "");
});

test("svg: 嵌套 svg 的内层属性同样按白名单剥（不存在「里层豁免」）", () => {
  const out = sanitizeSvg(
    `<svg><svg onload="alert(1)" viewBox="0 0 1 1"><rect/></svg></svg>`,
  );
  assertNoDanger(out, "nested");
  assert.equal(out, `<svg><svg viewBox="0 0 1 1"><rect></rect></svg></svg>`);
});

test("svg: 畸形闭合（交叉/多余闭合/未闭合）→ 产物必定配平", () => {
  const cases = [
    `<svg><g></svg></g>`,
    `<svg><g><rect></g></rect></svg>`,
    `<svg><g><rect/>`,
    `</svg><svg><g></g>`,
  ];
  for (const c of cases) {
    const out = sanitizeSvg(c);
    assertNoDanger(out, `malformed ${c}`);
    const opens = (out.match(/<([a-z]+)[\s>]/g) ?? []).length;
    const closes = (out.match(/<\/([a-z]+)>/g) ?? []).length;
    assert.equal(opens, closes, `未配平：${c} → ${out}`);
  }
});

test("svg: 超大嵌套（1 万层 g）不成 O(n²) 卡死，且配平", () => {
  const deep = "<g>".repeat(10000) + "</g>".repeat(10000);
  const t0 = Date.now();
  const out = sanitizeSvg(`<svg>${deep}</svg>`);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `耗时 ${ms}ms`);
  assert.equal(
    (out.match(/<g>/g) ?? []).length,
    (out.match(/<\/g>/g) ?? []).length,
  );
});

test("svg: 错位闭合 × 深栈（闭合查找必须 O(1)，否则主线程冻结）", () => {
  const evil = `<svg>${"<g>".repeat(20000)}${"</svg>".repeat(20000)}</svg>`;
  const t0 = Date.now();
  sanitizeSvg(evil);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `耗时 ${ms}ms`);
});

test("svg: 半截标签（到 EOF 无 >）→ 余下丢掉（fail-closed，不回吐半截）", () => {
  const out = sanitizeSvg(`<svg><rect width="10"`);
  assert.equal(out, ""); // 半截 rect 没落地 → 无绘图元素 → 空串
  const out2 = sanitizeSvg(`<svg><g><rect onload="alert(1)"`);
  assertNoDanger(out2, "truncated");
});

test("svg: 注释/CDATA/doctype/处理指令不进产物", () => {
  const out = sanitizeSvg(
    `<!--<script>alert(1)</script>--><svg><![CDATA[alert(2)]]><!DOCTYPE svg><?pi alert(3)?><rect/></svg>`,
  );
  assertNoDanger(out, "comments");
  assert.ok(!out.includes("alert"), out);
  assert.equal(out, `<svg><rect></rect></svg>`);
});

test("svg: 非法协议/外链属性一律剥（xlink:href、href、src、data-*）", () => {
  const out = sanitizeSvg(
    `<svg><path d="M0 0" href="https://evil.example" src="https://evil.example/x" data-id="1" xlink:href="#y"/></svg>`,
  );
  assert.ok(!out.includes("evil.example"), out);
  assert.ok(!out.includes("xlink"), out);
  assert.ok(!out.includes("data-id"), out);
  assert.equal(out, `<svg><path d="M0 0"></path></svg>`);
});

test("svg: url(...) 只放行本地片段引用（marker-end/fill）", () => {
  const ok = sanitizeSvg(
    `<svg><path marker-end="url(#arrow)" fill="url(#grad)"/></svg>`,
  );
  assert.ok(ok.includes('marker-end="url(#arrow)"'), ok);
  assert.ok(ok.includes('fill="url(#grad)"'), ok);
  const bad = sanitizeSvg(
    `<svg><path marker-end="url(https://evil.example/x)" fill="url(//evil.example/g)"/></svg>`,
  );
  assert.ok(!bad.includes("evil.example"), bad);
  assert.equal(bad, `<svg><path></path></svg>`);
});

test("svg: style 属性只留表现类声明（布局/定位类逐条丢，其余照常保留）", () => {
  assert.equal(
    sanitizeStyleDecls("fill:#f9f !important;stroke:#333"),
    "fill:#f9f;stroke:#333",
  );
  // position/z-index/top/left/pointer-events/cursor/background/behavior 不在白名单 → 逐条丢
  for (const bad of [
    "position:fixed",
    "top:0",
    "left:0",
    "z-index:99999",
    "pointer-events:auto",
    "cursor:pointer",
    "background:url(#x)",
    "behavior:url(#default#time2)",
  ]) {
    assert.equal(sanitizeStyleDecls(bad), "", `不该放行：${bad}`);
  }
  // 混在一起时：坏的丢、好的留（改动不得把整条 style 牵连掉）
  assert.equal(
    sanitizeStyleDecls("position:fixed;fill:red;z-index:9"),
    "fill:red",
  );
  const out = sanitizeSvg(`<svg><rect style="position:fixed;fill:red"/></svg>`);
  assert.ok(!out.includes("position"), out);
  assert.ok(out.includes('style="fill:red"'), out);
});

test("svg: style 属性值里的伪协议/表达式在字符集层面就不成立", () => {
  for (const bad of [
    "fill:url(javascript:alert(1))",
    "fill:expression(alert(1))",
    "fill:url(http://evil.example/x)",
    "color:url('//evil.example/x')",
  ]) {
    assert.equal(sanitizeStyleDecls(bad), "", `不该放行：${bad}`);
  }
  // 引号不配对（会把后续 } 吞进字符串）也拒
  assert.equal(sanitizeStyleDecls(`font-family:"unterminated`), "");
  assert.equal(
    sanitizeStyleDecls(`font-family:"Ok Font", sans-serif`),
    `font-family:"Ok Font", sans-serif`,
  );
});

// ---- 白名单行为（收白名单不得把正常图形删残） ----

test("svg: 几何/文本/渐变标签与属性照常放行", () => {
  const src =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="80" class="diagram" role="img" aria-label="示意图">` +
    `<title>标题</title><desc>描述</desc><defs><linearGradient id="g1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/></linearGradient></defs>` +
    `<g transform="translate(1,2)" fill="none" stroke="#333" stroke-width="2" stroke-dasharray="3,2" opacity="0.9">` +
    `<rect x="1" y="2" width="10" height="20" rx="2" ry="3"/>` +
    `<circle cx="5" cy="5" r="4"/><ellipse cx="1" cy="1" rx="3" ry="2"/>` +
    `<line x1="0" y1="0" x2="9" y2="9"/><polyline points="0,0 1,1 2,0"/><polygon points="0,0 3,3 6,0"/>` +
    `<path d="M0 0 L10 10 z" marker-end="url(#arrow)"/>` +
    `<text x="1" y="2" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="12">文字<tspan dx="1" dy="2">子串</tspan></text>` +
    `</g><marker id="arrow" refX="1" refY="2" markerWidth="3" markerHeight="4" orient="auto"><path d="M0 0 L1 1 z"/></marker></svg>`;
  const out = sanitizeSvg(src);
  for (const piece of [
    "<title>标题</title>",
    "<desc>描述</desc>",
    "<linearGradient",
    "<stop",
    "<rect",
    "<circle",
    "<ellipse",
    "<line",
    "<polyline",
    "<polygon",
    "<path",
    "<text",
    "<tspan",
    "<marker",
    'marker-end="url(#arrow)"',
    'viewBox="0 0 100 100"',
    'text-anchor="middle"',
  ]) {
    assert.ok(out.includes(piece), `放行清单缺 ${piece}：${out.slice(0, 300)}`);
  }
  assert.ok(!out.includes("<script"), out);
});

test("svg: 文本节点按 HTML 规则转义（裸 < & 不得变成标签）", () => {
  const out = sanitizeSvg(
    `<svg><text>a &amp; b &lt;script&gt; & c</text></svg>`,
  );
  assert.ok(out.includes("a &amp; b &lt;script&gt; &amp; c"), out);
  assert.ok(!out.includes("<script>"), out);
});

test("svg: 空输入/非串/超长 → 空串；全被丢光 → 空串（调用方据此退回源码）", () => {
  assert.equal(sanitizeSvg(""), "");
  assert.equal(sanitizeSvg("<div>不是 svg</div>"), "");
  assert.equal(sanitizeSvg("<svg><foo>全被丢</foo></svg>"), "");
  assert.equal(sanitizeSvg("x".repeat(600 * 1024)), "");
});

test("svg: 消毒幂等（消毒产物再消一遍不变）", () => {
  const src = `<svg viewBox="0 0 10 10" style="max-width: 20px"><g class="a"><rect width="1" style="fill:#f00"/></g></svg>`;
  const once = sanitizeSvg(src);
  assert.equal(sanitizeSvg(once), once);
});

// ---- <style> 收敛（仅 mermaid 产物；CSS 在文档里是全局的，必须钉死 #id 前缀） ----

test("svg: 默认不放行 <style>（AI 自写 svg 无 CSS 通道）", () => {
  const out = sanitizeSvg(
    `<svg id="a"><style>#a{fill:red}</style><rect/></svg>`,
  );
  assert.ok(!out.includes("<style"), out);
  assert.ok(out.includes("<rect>"), out);
});

test("css: 必须以本图 #id 打头；兄弟组合子/他图选择器整体丢", () => {
  const css =
    "#m1{fill:#333}#m1 .node rect{fill:#fff}#m1 > g{stroke:none}" +
    "body{display:none}#m1 ~ div{display:none}#other{fill:red}";
  const out = sanitizeSvgCss(css, "m1");
  assert.ok(out.includes("#m1{fill:#333}"), out);
  assert.ok(out.includes("#m1 .node rect{fill:#fff}"), out);
  assert.ok(out.includes("#m1 > g{stroke:none}"), out);
  assert.ok(!out.includes("body"), out);
  assert.ok(!out.includes("#other"), out);
  assert.ok(!out.includes("~"), out);
});

test("css: 属性白名单 + 值字符集（position/z-index/外部 url 全拒）", () => {
  const out = sanitizeSvgCss(
    "#m1{position:fixed;top:0;z-index:9;cursor:pointer;pointer-events:auto}" +
      "#m1 .a{fill:url(https://evil.example/x)}" +
      "#m1 .b{fill:url(#local);stroke:#333}",
    "m1",
  );
  assert.ok(!out.includes("position"), out);
  assert.ok(!out.includes("z-index"), out);
  assert.ok(!out.includes("cursor"), out);
  assert.ok(!out.includes("evil.example"), out);
  assert.ok(out.includes("#m1 .b{fill:url(#local);stroke:#333}"), out);
});

test("css: at-rule（@keyframes/@media）整体丢，其余规则照常保留", () => {
  const out = sanitizeSvgCss(
    "@keyframes dash{to{stroke-dashoffset:0;}}#m1 .e{stroke-dasharray:9,5;animation:dash 50s linear infinite}",
    "m1",
  );
  assert.ok(!out.includes("@"), out);
  assert.ok(out.includes("#m1 .e{stroke-dasharray:9,5}"), out); // animation 不在白名单 → 逐条丢
});

test("css: 含 < 的样式整段丢（`</style` 在多路径下都不可能落地）", () => {
  assert.equal(sanitizeSvgCss("#m1{fill:red}/*</style><script>*/", "m1"), "");
  assert.equal(
    sanitizeSvgCss("#m1{fill:red}</style><script>alert(1)</script>", "m1"),
    "",
  );
  // 不配平括号 → 已校验的前缀保留，残缺尾巴不再产出
  assert.equal(
    sanitizeSvgCss("#m1{fill:red}#m1 .b{stroke:blue", "m1"),
    "#m1{fill:red}",
  );
});

test("css: 无根 id / 超长 CSS → 空串（无法收敛作用域就不放行）", () => {
  assert.equal(sanitizeSvgCss("#m1{fill:red}", ""), "");
  assert.equal(sanitizeSvgCss("x".repeat(300 * 1024), "m1"), "");
});

test("svg: <style> 仅在有根 id 且 allowStyle 时保留，内容逐条校验", () => {
  const out = sanitizeSvg(
    `<svg id="m1"><style>#m1 .node{fill:#fff}body{display:none}</style><g class="node"><rect/></g></svg>`,
    { allowStyle: true },
  );
  assert.ok(out.includes("<style>#m1 .node{fill:#fff}</style>"), out);
  assert.ok(!out.includes("body"), out);
  // 没有根 id → 无法把 CSS 关回本图 → <style> 整条丢
  const noId = sanitizeSvg(`<svg><style>#x{fill:red}</style><rect/></svg>`, {
    allowStyle: true,
  });
  assert.ok(!noId.includes("<style"), noId);
});

test("svg: 白名单常量本身不含执行/外联面（清单级回归锁）", () => {
  for (const tag of [
    "script",
    "foreignObject",
    "use",
    "image",
    "iframe",
    "animate",
    "animateTransform",
    "set",
    "filter",
    "feGaussianBlur",
    "style",
  ]) {
    assert.ok(
      !SVG_ALLOWED_TAGS.has(tag),
      `${tag} 不该进 SVG 白名单（执行/外联/HTML 注入面）`,
    );
  }
});
