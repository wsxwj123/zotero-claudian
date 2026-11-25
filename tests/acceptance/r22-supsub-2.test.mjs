// 验收 — r22-supsub 修订节：数字指数与闭合符（黑盒，依据 .devflow/r22-supsub-接口.md 行为清单 16–25）
// 只经对外入口：parseMarkdownUnsafe(md) → HTML 字符串。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownUnsafe } from "../../src/chat/lib/markdown.ts";

const render = (md) => parseMarkdownUnsafe(md).trim();

test("r22-16 数字形式：尾随 + 后接字母不并入上标，= 留在上标外", () => {
  assert.equal(
    render("x^2+y^2=z^2"),
    "<p>x<sup>2</sup>+y<sup>2</sup>=z<sup>2</sup></p>",
  );
});

test("r22-17 闭合 ^ 后接数字时保留并重新触发上标", () => {
  assert.equal(render("2^3^2"), "<p>2<sup>3</sup><sup>2</sup></p>");
});

test("r22-18 数字形式：R^2 后的 =0.89 与逗号留在上标外", () => {
  assert.equal(
    render("R^2=0.89, n=5"),
    "<p>R<sup>2</sup>=0.89, n=5</p>",
  );
});

test("r22-19 数字形式：10^9 后的 /L 留在上标外", () => {
  assert.equal(
    render("WBC 6.5×10^9/L"),
    "<p>WBC 6.5×10<sup>9</sup>/L</p>",
  );
});

test("r22-20 数字形式：n^2 后的 /2 留在上标外", () => {
  assert.equal(render("n^2/2 次"), "<p>n<sup>2</sup>/2 次</p>");
});

test("r22-21 数字形式：10^6 后紧跟的字母留在上标外", () => {
  assert.equal(
    render("10^6cells/mL"),
    "<p>10<sup>6</sup>cells/mL</p>",
  );
});

test("r22-22 字母形式：半角 = 为停止字符", () => {
  assert.equal(render("key^a=b"), "<p>key<sup>a</sup>=b</p>");
});

test("r22-23 字母形式：闭合 ^ 后接字母时保留并重新触发上标", () => {
  assert.equal(render("a^b^c"), "<p>a<sup>b</sup><sup>c</sup></p>");
});

test("r22-24 数字形式：其后的 }{ 原样留在上标外", () => {
  assert.equal(
    render("比值 a^2}{b 后"),
    "<p>比值 a<sup>2</sup>}{b 后</p>",
  );
});

test("r22-25 回归：负指数、离子电荷尾随 + 与句末全角句号", () => {
  assert.equal(
    render("10^-5 与 Ca^2+浓度 与 E = mc^2。"),
    "<p>10<sup>-5</sup> 与 Ca<sup>2+</sup>浓度 与 E = mc<sup>2</sup>。</p>",
  );
});
