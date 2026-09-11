// 单测 — M7 笔记纯函数（src/utils/noteAppend.ts + src/utils/htmlSanitize.ts）。
// 验收层（tests/acceptance/notes.test.mjs，15 条）锁的是契约主干；这里补边界与攻击样例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendNoteHtml } from "../../src/utils/noteAppend.ts";
import { sanitizeNoteHtml } from "../../src/utils/htmlSanitize.ts";

const T = "2026-09-09T10:00:00.000Z";

// ---- appendNoteHtml ----

test("append: 原文含尾随空白也原样保留（不做规范化）", () => {
  const out = appendNoteHtml("<p>原文</p>\n", "<p>x</p>", T);
  assert.ok(out.startsWith("<p>原文</p>\n<hr>"));
});

test("append: 追加标记是唯一格式来源（编码/换行等特殊字符原样进入 ISO 串）", () => {
  const out = appendNoteHtml("", "<p>x</p>", "2026-01-01T00:00:00+08:00");
  assert.equal(
    out,
    "<hr><p><small>zotero-claudian 追加（2026-01-01T00:00:00+08:00）</small></p><p>x</p>",
  );
});

// ---- sanitizeNoteHtml：结构 ----

test("sanitize: 未闭合标签自动补闭合（输出配平）", () => {
  assert.equal(sanitizeNoteHtml("<p>a<strong>b"), "<p>a<strong>b</strong></p>");
});

test("sanitize: 交叉闭合按栈收敛（<p><em>x</p></em>）", () => {
  assert.equal(sanitizeNoteHtml("<p><em>x</p></em>"), "<p><em>x</em></p>");
});

test("sanitize: 白名单外标签去标签留文字（div/span/未知自定义标签）", () => {
  assert.equal(sanitizeNoteHtml("<div><span>正文</span></div>"), "正文");
  assert.equal(
    sanitizeNoteHtml("<my-widget onclick='x()'>正文</my-widget>"),
    "正文",
  );
});

test("sanitize: 裸 < 与未闭合的截断标签按文本保留（不产出半截标签）", () => {
  assert.equal(sanitizeNoteHtml("a < b"), "a < b");
  assert.equal(sanitizeNoteHtml("看这个 <a href="), "看这个 <a href=");
});

test("sanitize: 注释/doctype/自闭合 br 处理", () => {
  assert.equal(sanitizeNoteHtml("<!-- 注释 --><p>x</p>"), "<p>x</p>");
  assert.equal(sanitizeNoteHtml("<!doctype html>text"), "text");
  assert.equal(sanitizeNoteHtml("<p>a<br/>b</p>"), "<p>a<br>b</p>");
});

test("sanitize: 引号内的 > 不提前结束标签（值内 > 转义为 &gt;）", () => {
  assert.equal(
    sanitizeNoteHtml('<a href="https://e.com/a>b">x</a>'),
    '<a href="https://e.com/a&gt;b">x</a>',
  );
});

// ---- sanitizeNoteHtml：属性与 URL ----

test("sanitize: 事件属性无论引号形态一律剥离（单引号/无引号/带空白）", () => {
  assert.equal(sanitizeNoteHtml("<p onmouseover='x()'>t</p>"), "<p>t</p>");
  assert.equal(sanitizeNoteHtml("<p onclick=x()>t</p>"), "<p>t</p>");
  assert.equal(sanitizeNoteHtml('<p ONCLICK = "x()">t</p>'), "<p>t</p>");
});

test("sanitize: style/class/target 属性剥离（a 只留 href）", () => {
  assert.equal(
    sanitizeNoteHtml('<a href="https://e.com" target="_blank" class="x">t</a>'),
    '<a href="https://e.com">t</a>',
  );
  assert.equal(
    sanitizeNoteHtml('<code class="hljs language-py">x</code>'),
    "<code>x</code>",
  );
});

test("sanitize: 协议混淆与伪协议一律剥离", () => {
  assert.equal(
    sanitizeNoteHtml('<a href="java\nscript:alert(1)">t</a>'),
    "<a>t</a>",
  );
  assert.equal(
    sanitizeNoteHtml('<a href="  JavaScript:alert(1)">t</a>'),
    "<a>t</a>",
  );
  assert.equal(
    sanitizeNoteHtml('<img src="data:text/html,<script>x</script>">'),
    "<img>",
  );
  assert.equal(sanitizeNoteHtml('<img src="file:///etc/passwd">'), "<img>");
});

test("sanitize: 相对路径与原样 http(s)（img 同规则）", () => {
  assert.equal(sanitizeNoteHtml('<a href="/local/path">t</a>'), "<a>t</a>");
  assert.equal(
    sanitizeNoteHtml('<img src="https://e.com/a.png" alt="图">'),
    '<img src="https://e.com/a.png" alt="图">',
  );
});

test("sanitize: ol start 仅接受整数（其余形态剥离）", () => {
  assert.equal(
    sanitizeNoteHtml('<ol start="3"><li>x</li></ol>'),
    '<ol start="3"><li>x</li></ol>',
  );
  assert.equal(
    sanitizeNoteHtml('<ol start="3abc"><li>x</li></ol>'),
    "<ol><li>x</li></ol>",
  );
});

// ---- sanitizeNoteHtml：整段丢弃 ----

test("sanitize: svg/math/template/textarea 连内容丢弃", () => {
  assert.equal(
    sanitizeNoteHtml("<svg><path d='M0 0'/></svg><p>x</p>"),
    "<p>x</p>",
  );
  assert.equal(sanitizeNoteHtml("<template>secret</template>"), "");
  assert.equal(
    sanitizeNoteHtml("<textarea>raw</textarea><p>x</p>"),
    "<p>x</p>",
  );
});

test("sanitize: 未闭合的 script 只丢标签、后续正文保留（截断输入不吞全文）", () => {
  assert.equal(
    sanitizeNoteHtml("<script>alert(1)<p>后面</p>"),
    "alert(1)<p>后面</p>",
  );
});

test("sanitize: 嵌套结构里藏的 script 照样丢弃", () => {
  assert.equal(
    sanitizeNoteHtml(
      "<blockquote><p>引</p><script>bad()</script></blockquote>",
    ),
    "<blockquote><p>引</p></blockquote>",
  );
});

// ---- sanitizeNoteHtml：正常内容不误伤 ----

test("sanitize: 表格/markdown 产物保留", () => {
  const html =
    "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>";
  assert.equal(sanitizeNoteHtml(html), html);
});

test("sanitize: 实体与中文/emoji 原样保留", () => {
  assert.equal(
    sanitizeNoteHtml("<p>结论 ✅ &nbsp; &amp; 更多</p>"),
    "<p>结论 ✅ &nbsp; &amp; 更多</p>",
  );
});

test("sanitize: 幂等——消毒产物再消毒不变", () => {
  const once = sanitizeNoteHtml(
    '<p onclick="x()"><a href="javascript:y()">点我</a><script>z</script></p>',
  );
  assert.equal(sanitizeNoteHtml(once), once);
});

test("sanitize: 追加标记原样存活（small/hr 在白名单内，格式契约不被消毒破坏）", () => {
  const marker = `<hr><p><small>zotero-claudian 追加（${T}）</small></p>`;
  assert.equal(sanitizeNoteHtml(marker), marker);
});

test("sanitize: 非字符串输入 → 空串（防御桥消息畸形字段）", () => {
  assert.equal(sanitizeNoteHtml(undefined as unknown as string), "");
  assert.equal(sanitizeNoteHtml(null as unknown as string), "");
});

// ---- BUG-29：Unicode 大小写展开（İ）导致的索引错位 ----
// 整串 toLowerCase 不是等长变换（İ U+0130 → i + U+0307，2 码元），
// 任何「拿小写串索引切原文」的实现都会错位：原样回吐危险标签、白名单标签改名、凭空多出闭合标签。

test("İ 回归：前置 İ 时危险标签不得原样回吐（逐向量精确输出）", () => {
  // 期望 = 正常消毒语义：img 是白名单标签但属性全剥、script/svg/iframe 整段丢弃
  const cases: [string, string][] = [
    ["<img src=x onerror=alert(1)>", "<img>"],
    ["<script>alert(1)</script>", ""],
    ["<svg onload=alert(1)>", ""],
    ["<iframe src=javascript:alert(1)>", ""],
    ["<p onclick=alert(1)>t</p>", "<p>t</p>"],
  ];
  for (const [payload, tail] of cases) {
    for (const k of [1, 2, 3, 7]) {
      const prefix = "İ".repeat(k);
      const out = sanitizeNoteHtml(prefix + payload);
      assert.equal(out, prefix + tail, `İ×${k} + ${payload}`);
      assert.ok(
        !/on\w+\s*=/i.test(out),
        `残留事件属性：${JSON.stringify(out)}`,
      );
      assert.ok(
        !/javascript:/i.test(out),
        `残留伪协议：${JSON.stringify(out)}`,
      );
    }
  }
});

test("İ 回归：İ 是普通正文，规范产物原样通过（不得改名/丢字）", () => {
  assert.equal(
    sanitizeNoteHtml("<p>İstanbul 是土耳其城市</p><p>第二段</p>"),
    "<p>İstanbul 是土耳其城市</p><p>第二段</p>",
  );
  assert.equal(sanitizeNoteHtml("<!-- 注 -->İİİİİ<p>a</p>"), "İİİİİ<p>a</p>");
});

test("İ 回归：配平保持（script 连内容丢弃，段落各归各位）", () => {
  // 注：m7-review 的同名用例把期望写成 "...</p>a<p>后</p>"（保留 script 内容 "a"），
  // 与该复核套件自己的矩阵用例"...<script>alert(1)</script>→ 整体丢弃"、以及
  // 验收锁定用例「<script> 连标签带内容整体移除」互相矛盾——按后者口径实现。
  assert.equal(
    sanitizeNoteHtml("<p>İİİ</p><script>a</script><p>后</p>"),
    "<p>İİİ</p><p>后</p>",
  );
  assert.equal(
    sanitizeNoteHtml("İ<script>alert(1)</script><p>x</p>"),
    "İ<p>x</p>",
  );
});

// ---- BUG-30：半截标签（截到 EOF 无 >）不得留下可补全成真标签的片段 ----

test("截断回归：带危险属性的半截标签整段丢弃（不残留 on*= 文本）", () => {
  for (const input of [
    "<img src=x onerror=alert(1)",
    "<img src=x onerror=alert(1) ",
    "<svg onload=alert(1)",
    "<iframe src=javascript:alert(1) ",
    '<a href="https://e/x onclick=alert(1)',
    '<img src="https://e/a.png" alt="x onerror=alert(1)',
    "<p>正文" + "<img src=x onerror=alert(1)",
  ]) {
    const out = sanitizeNoteHtml(input);
    assert.ok(
      !/\bon\w+\s*=/i.test(out),
      `残留事件属性文本：${JSON.stringify(out)}`,
    );
    assert.ok(
      !/<(img|svg|iframe|script)\b/i.test(out),
      `残留标签：${JSON.stringify(out)}`,
    );
  }
});

test("截断回归：无危险属性的半截片段按文本保留（不吞正文）", () => {
  assert.equal(sanitizeNoteHtml("看这个 <a href="), "看这个 <a href=");
  assert.equal(sanitizeNoteHtml("a < b"), "a < b");
  assert.equal(sanitizeNoteHtml("3 < 5 > 2"), "3 < 5 > 2");
  assert.equal(sanitizeNoteHtml("x <p"), "x <p");
});

// ---- BUG-31：无 `>` 输入不得退化成 O(n²)（每个 `<` 都全串扫一遍）----

test("性能回归：20 万字符无 `>` 输入线性完成（原实现每字符扫到串尾）", () => {
  const input = "<p".repeat(100_000); // 20 万字符，全串无 `>`
  const t0 = Date.now();
  const out = sanitizeNoteHtml(input);
  const elapsed = Date.now() - t0;
  assert.equal(out, input, "每个 < 都应作为文本保留、内容不丢");
  assert.ok(elapsed < 5000, `耗时 ${elapsed}ms（>5s 说明扫描退化成 O(n²)）`);
});

// ---- NEW-1：closeTag 残余 O(n²)（错位闭合 × 深栈）----

test("closeTag：错位闭合 × 深栈语义不变（未匹配闭合丢弃、开启标签全部配平）", () => {
  const n = 1000;
  const out = sanitizeNoteHtml("<p>".repeat(n) + "</strong>".repeat(n));
  assert.equal(
    out,
    "<p>".repeat(n) + "</p>".repeat(n),
    "未匹配 </strong> 应丢弃",
  );
  // 交叉闭合仍按栈收敛
  assert.equal(sanitizeNoteHtml("<p><em>x</p></em>"), "<p><em>x</em></p>");
  assert.equal(sanitizeNoteHtml("<div><p>a</p></div>"), "<p>a</p>");
});

test("closeTag：10 万×10 万错位闭合线性完成（原实现全栈扫 = O(N²) 冻结）", () => {
  const n = 100_000;
  const input = "<p>".repeat(n) + "</strong>".repeat(n); // 120 万字符
  const t0 = Date.now();
  const out = sanitizeNoteHtml(input);
  const elapsed = Date.now() - t0;
  assert.equal(out, "<p>".repeat(n) + "</p>".repeat(n));
  assert.ok(
    elapsed < 1000,
    `耗时 ${elapsed}ms（>1s 说明闭合查找退化成全栈扫）`,
  );
});

// ---- NEW-2：截断的闭合标签（`</p ` 截到 EOF）不得破坏幂等 ----

test("截断闭合标签：消毒幂等（sanitize∘sanitize = sanitize）", () => {
  for (const input of [
    "<p>a</p ",
    "<p>a</p",
    "<p>a</p 正文",
    "</div ",
    "<p>a</p><p>b</p ",
    "İ<p>a</p ",
  ]) {
    const once = sanitizeNoteHtml(input);
    assert.equal(
      sanitizeNoteHtml(once),
      once,
      `不幂等：${JSON.stringify(input)} → ${JSON.stringify(once)}`,
    );
  }
});

test("截断闭合标签：丢 `<` 后文本其余照留、不留可补全的半截闭合", () => {
  assert.equal(sanitizeNoteHtml("<p>a</p "), "<p>a/p </p>");
  assert.equal(sanitizeNoteHtml("<p>a</p 正文"), "<p>a/p 正文</p>");
  // 输出里不得残留「可被后续文本补全成真闭合标签」的半截形态
  for (const input of ["<p>a</p ", "<p>a</p", "</div "]) {
    assert.ok(!/<\/[a-zA-Z][^>]*$/.test(sanitizeNoteHtml(input)), input);
  }
});
