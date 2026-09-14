// 单测 — R7-B「@ 提及」宿主侧纯逻辑（PLAN-R7 §3）。
// 契约来源只有 PLAN-R7.md（黑盒，不看实现——本轮开发尚未开始，红基线即「模块不存在/未导出」）。
//
// 锁定的契约点：
//   1) 检索过滤面 = 标题/作者/期刊/年份/分类名，大小写不敏感、中文可匹配；返回最多 20 条
//   2) resolveRefs：查不到的条目标 missing:true（位置不丢）
//   3) prompt 注入区块 [Referenced items] … [/Referenced items]，摘要截 500、无附件 PDF: (none)
//   4) --add-dir 合并 = 当前附件目录 ∪ 各 chip 的 pdfDir（去重、顺序稳定、最多 20）
//   5) **安全红线**：deny 规则对每个目录各生成 Write/Edit（扩权不得削弱 PDF 写保护）
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/utils/mentions.ts → MENTION_QUERY_MAX / MENTION_RESULTS_MAX / MENTION_CHIPS_MAX /
//     MENTION_ABSTRACT_MAX / searchMentionItems / resolveMentionRefs / buildReferencedItemsBlock /
//     mergeAddDirs
//   src/modules/cliRunner.ts → buildAttachmentDenySettings（R7 起需接受 string | string[]）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MENTION_ABSTRACT_MAX,
  MENTION_CHIPS_MAX,
  MENTION_QUERY_MAX,
  MENTION_RESULTS_MAX,
  buildReferencedItemsBlock,
  mergeAddDirs,
  resolveMentionRefs,
  searchMentionItems,
  type MentionSearchItem,
  type ResolvedRef,
} from "../../src/utils/mentions.ts";
import { buildAttachmentDenySettings } from "../../src/modules/cliRunner.ts";

const ITEMS: MentionSearchItem[] = [
  {
    itemKey: "A1",
    title: "Attention Is All You Need",
    creators: ["Vaswani, Ashish", "Shazeer, Noam"],
    year: "2017",
    publication: "NeurIPS",
    itemType: "conferencePaper",
    collectionNames: ["深度学习"],
  },
  {
    itemKey: "A2",
    title: "Deep Residual Learning for Image Recognition",
    creators: ["He, Kaiming"],
    year: "2016",
    publication: "CVPR",
    itemType: "conferencePaper",
    collectionNames: ["计算机视觉"],
  },
  {
    itemKey: "A3",
    title: "科学的极致：机器学习实践",
    creators: ["张三", "李四"],
    year: "2020",
    publication: "中国科学",
    itemType: "journalArticle",
    collectionNames: ["科学前言"],
  },
  {
    itemKey: "A4",
    title: "Sparse Retrieval at Scale",
    creators: ["Wang, Li"],
    year: "2021",
    publication: "SIGIR",
    itemType: "journalArticle",
    collectionNames: ["信息检索"],
  },
];

/** 命中 key 的断言助手：只比对 itemKey，避免耦合结果对象里不重要的字段 */
function keysOf(query: string): string[] {
  return searchMentionItems(ITEMS, query).map((it) => it.itemKey);
}

// ---- 检索过滤（标题/作者/期刊/年份/分类名各命中一次）----

test("R7-B 检索：命中标题（attention）", () => {
  assert.deepEqual(keysOf("attention"), ["A1"]);
});

test("R7-B 检索：命中作者（kaiming）", () => {
  assert.deepEqual(keysOf("kaiming"), ["A2"]);
});

test("R7-B 检索：命中期刊（cvpr）", () => {
  assert.deepEqual(keysOf("cvpr"), ["A2"]);
});

test("R7-B 检索：命中年份（2020）", () => {
  assert.deepEqual(keysOf("2020"), ["A3"]);
});

test("R7-B 检索：命中分类名（计算机视觉）", () => {
  assert.deepEqual(keysOf("计算机视觉"), ["A2"]);
});

test("R7-B 检索：大小写不敏感（查询与数据两侧都试）", () => {
  assert.deepEqual(keysOf("ATTENTION"), ["A1"]);
  assert.deepEqual(keysOf("neurips"), ["A1"]);
  assert.deepEqual(keysOf("Sparse RETRIEVAL"), ["A4"]);
});

test("R7-B 检索：中文关键词可匹配（题名与分类名）", () => {
  assert.deepEqual(keysOf("机器学习"), ["A3"]);
  assert.deepEqual(keysOf("信息检索"), ["A4"]);
});

test("R7-B 检索：无命中 → 空数组（不是 null/undefined）", () => {
  const hit = searchMentionItems(ITEMS, "量子纠缠拓扑绝缘体");
  assert.ok(Array.isArray(hit));
  assert.deepEqual(hit, []);
});

test("R7-B 检索：命中多条时按输入序返回（下拉列表不抖动）", () => {
  const many: MentionSearchItem[] = [
    {
      itemKey: "M1",
      title: "共同主题：甲",
      creators: [],
      year: "2024",
      publication: "某刊",
      itemType: "journalArticle",
    },
    {
      itemKey: "M2",
      title: "无关条目",
      creators: [],
      year: "2024",
      publication: "某刊",
      itemType: "journalArticle",
    },
    {
      itemKey: "M3",
      title: "共同主题：丙",
      creators: [],
      year: "2024",
      publication: "某刊",
      itemType: "journalArticle",
    },
  ];
  assert.deepEqual(
    searchMentionItems(many, "共同主题").map((it) => it.itemKey),
    ["M1", "M3"],
  );
});

test("R7-B 检索：候选上限 20（25 条命中只回前 20）", () => {
  const many: MentionSearchItem[] = Array.from({ length: 25 }, (_, i) => ({
    itemKey: `K${i}`,
    title: `共同主题 ${String(i).padStart(2, "0")}`,
    creators: ["某人"],
    year: "2024",
    publication: "某刊",
    itemType: "journalArticle",
  }));
  const hit = searchMentionItems(many, "共同主题");
  assert.equal(MENTION_RESULTS_MAX, 20, "候选上限 20（PLAN §3）");
  assert.equal(hit.length, MENTION_RESULTS_MAX);
  assert.equal(hit[0].itemKey, "K0", "截断保留前 20 条，不随机抽样");
});

test("R7-B 检索：结果字段形态 —— itemKey/title/creators/year/publication/itemType 齐备", () => {
  const [first] = searchMentionItems(ITEMS, "attention");
  for (const field of [
    "itemKey",
    "title",
    "creators",
    "year",
    "publication",
    "itemType",
  ] as const) {
    assert.notEqual(
      (first as Record<string, unknown>)[field],
      undefined,
      `候选缺字段：${field}`,
    );
  }
  assert.deepEqual(first.creators, ["Vaswani, Ashish", "Shazeer, Noam"]);
  assert.equal(String(first.year), "2017");
});

test("R7-B 检索：query 超 64 字符 → 不抛错且候选 ≤20（截断/拒绝口径未写死，仅锁安全边界）", () => {
  const hit = searchMentionItems(ITEMS, "a".repeat(MENTION_QUERY_MAX + 100));
  assert.equal(MENTION_QUERY_MAX, 64, "query 上限 64 字符（PLAN §3）");
  assert.ok(Array.isArray(hit));
  assert.ok(hit.length <= MENTION_RESULTS_MAX);
});

test("R7-B 检索：空 query → 不抛错且候选 ≤20（列全部/空结果口径未写死，仅锁安全边界）", () => {
  for (const q of ["", "   "]) {
    const hit = searchMentionItems(ITEMS, q);
    assert.ok(Array.isArray(hit), `空 query 必须回数组：${JSON.stringify(q)}`);
    assert.ok(hit.length <= MENTION_RESULTS_MAX);
    for (const it of hit) {
      assert.equal(typeof it.itemKey, "string");
    }
  }
});

// ---- resolveRefs ----

type RawRef = Omit<ResolvedRef, "itemKey" | "missing">;

const TABLE: Record<string, RawRef> = {
  A1: {
    title: "Attention Is All You Need",
    creators: ["Vaswani, Ashish", "Shazeer, Noam"],
    year: "2017",
    publication: "NeurIPS",
    doi: "10.5555/3295222",
    abstract: "The dominant sequence transduction models are based on RNNs.",
    pdfPath: "/lib/storage/AAAA/attention.pdf",
    pdfDir: "/lib/storage/AAAA",
    attachmentKey: "AAAA",
  },
  A3: {
    title: "科学的极致：机器学习实践",
    creators: ["张三"],
    year: "2020",
    publication: "中国科学",
    doi: null,
    abstract: null,
    pdfPath: null,
    pdfDir: null,
    attachmentKey: null,
  },
};

function deps(
  overrides: Partial<{
    resolveItem: (k: string) => Promise<RawRef | null>;
  }> = {},
) {
  return {
    resolveItem: async (key: string): Promise<RawRef | null> =>
      TABLE[key] ?? null,
    ...overrides,
  };
}

test("R7-B 解析：正常解析 → 条数与顺序与输入一致、字段齐备", async () => {
  const refs = await resolveMentionRefs(["A1", "A3"], deps());
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.itemKey),
    ["A1", "A3"],
  );
  assert.equal(refs[0].title, "Attention Is All You Need");
  assert.equal(refs[0].doi, "10.5555/3295222");
  assert.equal(refs[0].pdfPath, "/lib/storage/AAAA/attention.pdf");
  assert.equal(refs[0].pdfDir, "/lib/storage/AAAA");
  assert.equal(refs[0].attachmentKey, "AAAA");
  assert.ok(!refs[0].missing, "存在的条目不得标 missing");
});

test("R7-B 解析：查不到的条目 → missing:true，且**位置不丢**（UI 要标红哪一条）", async () => {
  const refs = await resolveMentionRefs(["A1", "GONE", "A3"], deps());
  assert.equal(refs.length, 3);
  assert.equal(refs[1].itemKey, "GONE");
  assert.equal(refs[1].missing, true);
  assert.ok(!refs[0].missing);
  assert.ok(!refs[2].missing);
});

test("R7-B 解析：空数组输入 → 空数组，且一次取数都不发（只读原则）", async () => {
  let calls = 0;
  const refs = await resolveMentionRefs(
    [],
    deps({
      resolveItem: async (key: string) => {
        calls += 1;
        return TABLE[key] ?? null;
      },
    }),
  );
  assert.deepEqual(refs, []);
  assert.equal(calls, 0);
});

test("R7-B 解析：单条取数抛错 → 该条缺省处理，整批不崩、条数不缩水", async () => {
  // 加固断言：契约只写了「查不到标 missing」，但宿主取数抛错（Zotero 内部形态变化）
  // 不得让整轮发送失败——与 R6「取数抛错回落根目录」同口径。
  const refs = await resolveMentionRefs(
    ["A1", "BOOM"],
    deps({
      resolveItem: async (key: string) => {
        if (key === "BOOM") throw new Error("Zotero 内部形态变化");
        return TABLE[key] ?? null;
      },
    }),
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[1].missing, true);
});

// ---- prompt 注入区块 ----

const REF_FULL: ResolvedRef = {
  itemKey: "A1",
  title: "Attention Is All You Need",
  creators: ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones"],
  year: "2017",
  publication: "NeurIPS",
  doi: "10.5555/3295222",
  abstract: "A".repeat(500) + "ZZZ",
  pdfPath: "/lib/storage/AAAA/attention.pdf",
  pdfDir: "/lib/storage/AAAA",
  attachmentKey: "AAAA",
};

test("R7-B 注入：区块首尾标记逐字为 [Referenced items] / [/Referenced items]", () => {
  const block = buildReferencedItemsBlock([REF_FULL]);
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "[Referenced items]");
  assert.equal(lines[lines.length - 1], "[/Referenced items]");
});

test("R7-B 注入：条目编号从 1 起，每条一行（两条 → 两行编号行）", () => {
  const two = [REF_FULL, { ...REF_FULL, itemKey: "A3", title: "第二篇" }];
  const block = buildReferencedItemsBlock(two);
  const numbered = block.split("\n").filter((l) => /^\d+\. /.test(l.trim()));
  assert.equal(numbered.length, 2, "一条引文一行，不得挤压或丢行");
  assert.ok(numbered[0].trim().startsWith("1. "));
  assert.ok(numbered[1].trim().startsWith("2. "));
});

test("R7-B 注入：行内含题名 / 年份 / 期刊 / DOI / PDF 绝对路径", () => {
  const block = buildReferencedItemsBlock([REF_FULL]);
  assert.ok(block.includes("Attention Is All You Need"), "缺题名");
  assert.ok(block.includes("(2017)"), "缺年份（括号形态）");
  assert.ok(block.includes("NeurIPS"), "缺期刊");
  assert.ok(block.includes("DOI: 10.5555/3295222"), "缺 DOI");
  assert.ok(
    block.includes("PDF: /lib/storage/AAAA/attention.pdf"),
    "缺 PDF 绝对路径",
  );
});

test("R7-B 注入：作者只留前 3 位（第 4、5 位不上屏）", () => {
  const block = buildReferencedItemsBlock([REF_FULL]);
  assert.ok(block.includes("Vaswani"));
  assert.ok(block.includes("Shazeer"));
  assert.ok(block.includes("Parmar"));
  assert.ok(!block.includes("Uszkoreit"), "第 4 位作者不应出现");
  assert.ok(!block.includes("Jones"), "第 5 位作者不应出现");
});

test("R7-B 注入：摘要截断到 500 字符（第 501 字符起不得出现）", () => {
  const block = buildReferencedItemsBlock([REF_FULL]);
  assert.equal(MENTION_ABSTRACT_MAX, 500, "摘要上限 500 字符（PLAN §3）");
  assert.ok(block.includes("A".repeat(500)), "前 500 字符要在");
  assert.ok(!block.includes("ZZZ"), "超出的部分必须被截掉（控 token）");
});

test("R7-B 注入：短摘要原样保留（不截、不截断成空）", () => {
  const block = buildReferencedItemsBlock([
    { ...REF_FULL, abstract: "短摘要：结论先行。" },
  ]);
  assert.ok(block.includes("短摘要：结论先行。"));
});

test("R7-B 注入：无 PDF 附件 → PDF: (none)", () => {
  const block = buildReferencedItemsBlock([
    { ...REF_FULL, pdfPath: null, pdfDir: null, attachmentKey: null },
  ]);
  assert.ok(block.includes("PDF: (none)"), `无附件要给 (none)：\n${block}`);
});

test("R7-B 注入：作者缺失 → 不产出 null/undefined 字样", () => {
  const block = buildReferencedItemsBlock([{ ...REF_FULL, creators: [] }]);
  assert.ok(!/null|undefined/.test(block), `出现了空值字样：\n${block}`);
});

test("R7-B 注入：摘要/DOI 缺失 → 不产出 null/undefined 字样", () => {
  const block = buildReferencedItemsBlock([
    { ...REF_FULL, abstract: null, doi: null },
  ]);
  assert.ok(!/null|undefined/.test(block), `出现了空值字样：\n${block}`);
});

test("R7-B 注入：区块带数据边界声明（参考资料，非本轮主文献）", () => {
  const block = buildReferencedItemsBlock([REF_FULL]);
  assert.ok(
    block.includes("以上为参考资料，非本轮主文献"),
    `PLAN §3 明确要求写一句数据边界：\n${block}`,
  );
});

test("R7-B 注入：无引文 → 不产出空区块（trim 后为空串）", () => {
  assert.equal(buildReferencedItemsBlock([]).trim(), "");
});

test("R7-B 注入：同一输入两次调用逐字一致（多条目分隔稳定）", () => {
  const two = [REF_FULL, { ...REF_FULL, itemKey: "A3", title: "第二篇" }];
  const a = buildReferencedItemsBlock(two);
  const b = buildReferencedItemsBlock(two);
  assert.equal(a, b);
});

// ---- add-dir 合并 ----

test("R7-B add-dir：当前附件目录 ∪ 各 chip pdfDir → 顺序稳定（当前在前）", () => {
  const dirs = mergeAddDirs("/lib/storage/AAAA", [
    "/lib/storage/BBBB",
    "/lib/storage/CCCC",
  ]);
  assert.deepEqual(dirs, [
    "/lib/storage/AAAA",
    "/lib/storage/BBBB",
    "/lib/storage/CCCC",
  ]);
});

test("R7-B add-dir：重复目录去重（chip 与当前同目录 / 两个 chip 同目录）", () => {
  const dirs = mergeAddDirs("/lib/storage/AAAA", [
    "/lib/storage/AAAA",
    "/lib/storage/BBBB",
    "/lib/storage/BBBB",
  ]);
  assert.deepEqual(dirs, ["/lib/storage/AAAA", "/lib/storage/BBBB"]);
});

test("R7-B add-dir：当前无附件（null）→ 只留 chips 的目录", () => {
  assert.deepEqual(mergeAddDirs(null, ["/lib/storage/BBBB"]), [
    "/lib/storage/BBBB",
  ]);
});

test("R7-B add-dir：空集合（无附件 + 无 chip 或无 PDF 的 chip）→ 空数组，不产出空串项", () => {
  assert.deepEqual(mergeAddDirs(null, []), []);
  assert.deepEqual(mergeAddDirs(null, [null, undefined, ""]), []);
  assert.deepEqual(mergeAddDirs("", [""]), []);
  assert.ok(!mergeAddDirs(null, [null, "/lib/x"]).includes(""));
});

test("R7-B add-dir：目录数封顶 20，且当前附件目录优先保留在首位", () => {
  const chipDirs = Array.from({ length: 25 }, (_, i) => `/lib/storage/D${i}`);
  const dirs = mergeAddDirs("/lib/storage/AAAA", chipDirs);
  assert.equal(MENTION_CHIPS_MAX, 20, "chips / add-dir 上限 20（PLAN §3）");
  assert.ok(
    dirs.length <= MENTION_CHIPS_MAX,
    `--add-dir 去重后最多 20 个，实际 ${dirs.length}`,
  );
  assert.equal(dirs[0], "/lib/storage/AAAA");
});

// ---- deny 规则合并（安全红线）----

/** 从 settings JSON 里取 deny 规则串 */
function denyRules(raw: string): string[] {
  return JSON.parse(raw).permissions.deny as string[];
}

test("R7-B deny：3 个目录 → 每个目录各有 Write 与 Edit 拒绝规则（共 6 条）", () => {
  const dirs = ["/lib/storage/AAAA", "/lib/storage/BBBB", "/lib/storage/CCCC"];
  const rules = denyRules(buildAttachmentDenySettings(dirs));
  assert.equal(rules.length, dirs.length * 2);
  for (const dir of dirs) {
    assert.ok(
      rules.includes(`Write(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Write 拒绝规则：${JSON.stringify(rules)}`,
    );
    assert.ok(
      rules.includes(`Edit(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Edit 拒绝规则：${JSON.stringify(rules)}`,
    );
  }
});

test("R7-B deny：单目录数组形态与既有单目录字符串形态逐字一致（不改变既有规则）", () => {
  const one = "/lib/storage/AAAA";
  assert.deepEqual(
    denyRules(buildAttachmentDenySettings([one])),
    denyRules(buildAttachmentDenySettings(one)),
  );
});

test("R7-B deny：中文 / 空格目录名照常生成规则（各两条）", () => {
  const dirs = ["/Users/张 三/zotero/storage/AAAA", "/lib/科学 前言"];
  const rules = denyRules(buildAttachmentDenySettings(dirs));
  for (const dir of dirs) {
    assert.ok(rules.includes(`Write(//${dir.slice(1)}/**)`), `缺 ${dir}`);
    assert.ok(rules.includes(`Edit(//${dir.slice(1)}/**)`), `缺 ${dir}`);
  }
});

test("R7-B deny：win32 反斜杠形态 → 按既有口径转 /，每目录仍两条", () => {
  const dirs = ["C:\\Users\\x\\Zotero\\storage\\AAAA", "D:\\文库\\BBBB"];
  const rules = denyRules(buildAttachmentDenySettings(dirs));
  assert.equal(rules.length, 4);
  for (const norm of ["C:/Users/x/Zotero/storage/AAAA", "D:/文库/BBBB"]) {
    assert.ok(rules.includes(`Write(//${norm}/**)`), `缺 ${norm} 的 Write`);
    assert.ok(rules.includes(`Edit(//${norm}/**)`), `缺 ${norm} 的 Edit`);
  }
});

test("R7-B deny：目录里带一个非法项 → 整批拒绝（不静默漏掉某目录的保护）", () => {
  assert.throws(
    () => buildAttachmentDenySettings(["/lib/storage/AAAA", "rel/relative"]),
    Error,
  );
});

test("R7-B deny：20 个目录 → 40 条规则，一条不少（红线：不得只覆盖第一个目录）", () => {
  const dirs = Array.from({ length: 20 }, (_, i) => `/lib/storage/D${i}`);
  const rules = denyRules(buildAttachmentDenySettings(dirs));
  assert.equal(rules.length, 40);
  for (const dir of dirs) {
    assert.ok(
      rules.includes(`Write(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Write`,
    );
    assert.ok(
      rules.includes(`Edit(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Edit`,
    );
  }
});

test("R7-B deny：空目录数组 → 要么抛错，要么 deny 为空数组（绝不产出没有 deny 键的 settings）", () => {
  let raw: string;
  try {
    raw = buildAttachmentDenySettings([]);
  } catch (err) {
    assert.ok(err instanceof Error, "拒绝必须是 Error");
    return;
  }
  assert.deepEqual(denyRules(raw), []);
});
