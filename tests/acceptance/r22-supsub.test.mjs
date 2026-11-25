// 验收 — r22-supsub：插入符上标与单波浪线不再删除线（黑盒，依据 .devflow/r22-supsub-接口.md 行为清单 1–15）
// 只经对外入口：parseMarkdownUnsafe(md) → HTML 字符串。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownUnsafe } from "../../src/chat/lib/markdown.ts";

const render = (md) => parseMarkdownUnsafe(md).trim();

test("r22-1 基因型上标：普通形式遇全角括号与中文即止", () => {
  assert.equal(
    render("Tgfbr2^flox/flox（Tgfbr2^ΔDC）骨髓"),
    "<p>Tgfbr2<sup>flox/flox</sup>（Tgfbr2<sup>ΔDC</sup>）骨髓</p>",
  );
});

test("r22-2 CD8^+ 上标为 +，遇空格即止", () => {
  assert.equal(render("CD8^+ T细胞"), "<p>CD8<sup>+</sup> T细胞</p>");
});

test("r22-3 离子电荷 Ca^2+ 上标，遇中文即止", () => {
  assert.equal(render("Ca^2+浓度"), "<p>Ca<sup>2+</sup>浓度</p>");
});

test("r22-4 成对写法 ^内容^ 的闭合 ^ 被吃掉", () => {
  assert.equal(
    render("Tgfbr2^flox/flox^ 小鼠"),
    "<p>Tgfbr2<sup>flox/flox</sup> 小鼠</p>",
  );
});

test("r22-5 花括号形式 ^{a b} 内容含空格、花括号不输出", () => {
  assert.equal(render("x^{a b} y"), "<p>x<sup>a b</sup> y</p>");
});

test("r22-6 上标末尾的句点留在上标之后", () => {
  assert.equal(render("共 10^3. 然后"), "<p>共 10<sup>3</sup>. 然后</p>");
});

test("r22-7 加粗内部的上标", () => {
  assert.equal(
    render("**Tgfbr2^ΔDC**肿瘤"),
    "<p><strong>Tgfbr2<sup>ΔDC</sup></strong>肿瘤</p>",
  );
});

test("r22-8 上标内容中的 & 按 HTML 转义", () => {
  assert.equal(render("x^a&b 后"), "<p>x<sup>a&amp;b</sup> 后</p>");
});

test("r22-9 约数写法的单波浪线原样输出，不产生删除线", () => {
  assert.equal(render("频率从~7%升至~14%"), "<p>频率从~7%升至~14%</p>");
});

test("r22-10 成对单波浪线 H~2~O 原样输出，不产生删除线或下标", () => {
  assert.equal(render("H~2~O"), "<p>H~2~O</p>");
});

test("r22-11 回归：双波浪线仍为删除线", () => {
  assert.equal(render("~~删除~~"), "<p><del>删除</del></p>");
});

test("r22-12 回归：行内代码里的 ^ 与 ~ 不受影响", () => {
  assert.equal(
    render("行内 `a^b ~c~` 代码"),
    "<p>行内 <code>a^b ~c~</code> 代码</p>",
  );
});

test("r22-13 回归：围栏代码块里的 ^ 与 ~ 不受影响", () => {
  const html = render("```\nx^2 ~y~\n```");
  assert.equal(html.includes("x^2 ~y~"), true);
  assert.equal(html.includes("<sup>"), false);
  assert.equal(html.includes("<del>"), false);
});

test("r22-14 不满足触发条件的 ^ 原样输出（前为空格或 [）", () => {
  const html = render("a ^b 与 [^1] 与 ^c");
  assert.equal(html.includes("<sup>"), false);
  assert.equal(html.includes("a ^b 与 [^1] 与 ^c"), true);
});

test("r22-15 回归：原生 <sup>/<sub> 标签照常透传", () => {
  assert.equal(
    render("Tgfbr2<sup>flox</sup> H<sub>2</sub>O"),
    "<p>Tgfbr2<sup>flox</sup> H<sub>2</sub>O</p>",
  );
});
