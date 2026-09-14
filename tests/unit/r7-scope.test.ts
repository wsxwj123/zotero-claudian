// 单测 — R7-D「跨文献范围注入」（PLAN-R7 §3.6，黑盒：只按契约写，不看实现——本轮 R7-D 尚未开工，
// 红基线即「模块不存在/未导出」）。
//
// 锁定的契约点：
//   1) 只取顶层文献条目：附件 / 笔记被过滤掉（且**不该被取数**，不是取了再扔）
//   2) 条目上限 40：41 → 40 且 truncated:true；正好 40 → truncated:false（按当前排序取前 40）
//   3) 分类模式不含子分类（recursive 恒 false）；选中模式用选中集，不碰分类
//   4) 注入区块：`[Scope: <label>]` 开头、摘要截 300 字、无 PDF → `PDF: (none)`、截断时标「已截断至 40 篇」
//   5) 与 @ chips 共存：上限各自独立（20 / 40）；add-dir 合并（当前 ∪ @chip ∪ 范围）去重且总数正确
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/utils/scope.ts → SCOPE_ITEMS_MAX / SCOPE_ABSTRACT_MAX / resolveScope / buildScopeBlock /
//     mergeScopeAddDirs
//   src/chat/lib/scopePicker.ts → initialScopeState / scopePickerOpen / scopeChipSet / scopeChipClear
//   范围 chip 形状假设：{ kind, label, count, itemKeys, truncated }（count = 清单篇数，UI 显示「分类名 · N 篇」）
//   resolveScope 注入面假设：deps = { resolveItem(key) → RawRef|null,
//     listCollection(id, { recursive }) → [{ itemKey, regular }], listSelected() → [{ itemKey, regular }] }
//     （regular=false 模拟附件/笔记；resolveItem 回 null 表示条目已删/取不到）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_ABSTRACT_MAX,
  SCOPE_ITEMS_MAX,
  buildScopeBlock,
  mergeScopeAddDirs,
  resolveScope,
} from "../../src/utils/scope.ts";
import {
  initialScopeState,
  scopeChipClear,
  scopeChipSet,
  scopePickerOpen,
} from "../../src/chat/lib/scopePicker.ts";
import {
  MENTION_CHIPS_MAX,
  mergeAddDirs,
  type RawRef,
  type ResolvedRef,
} from "../../src/utils/mentions.ts";
import {
  initialMentionPickerState,
  mentionChipAdd,
} from "../../src/chat/lib/mentionPicker.ts";
import { buildAttachmentDenySettings } from "../../src/modules/cliRunner.ts";

type Candidate = { itemKey: string; regular: boolean };

const RAW: RawRef = {
  title: "某篇文献",
  creators: ["张三", "李四"],
  year: "2020",
  publication: "中国科学",
  doi: "10.1/x",
  abstract: "摘要",
  pdfPath: "/lib/storage/AAAA/t.pdf",
  pdfDir: "/lib/storage/AAAA",
  attachmentKey: "AAAA",
};

/** 造 candidate 列表：regular=true 为顶层文献条目，false 模拟附件/笔记 */
function regular(n: number, prefix = "R"): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    itemKey: `${prefix}${String(i).padStart(3, "0")}`,
    regular: true,
  }));
}

function depsOf(
  candidates: Candidate[],
  over: Partial<{
    /** 子分类里的条目（递归开关若没关就会混进来——用来验证「不含子分类」） */
    sub: Candidate[];
  }> = {},
) {
  const known = [...candidates, ...(over.sub ?? [])];
  const state = {
    resolved: [] as string[],
    collectionCalls: [] as Array<{ id: string; opts: { recursive?: boolean } }>,
    selectedCalls: 0,
    resolveItem: async (key: string): Promise<RawRef | null> => {
      state.resolved.push(key);
      // 夹具语义：key 以 GONE 开头 = 该条目在 Zotero 侧已删（列在候选里但解析回 null）
      return known.some((c) => c.itemKey === key) && !key.startsWith("GONE")
        ? { ...RAW, title: `题名 ${key}` }
        : null;
    },
    /** 像 Zotero 的 getChildItems(recursive) 一样：只有递归为真才带上子分类 */
    listCollection: async (id: string, opts: { recursive?: boolean }) => {
      state.collectionCalls.push({ id, opts: opts ?? {} });
      return opts?.recursive
        ? [...candidates, ...(over.sub ?? [])]
        : candidates;
    },
    listSelected: async () => {
      state.selectedCalls += 1;
      return candidates;
    },
  };
  return state;
}

// ---- 顶层条目过滤 ----

test("R7-D 过滤：附件 / 笔记被过滤掉（只留顶层文献条目）", async () => {
  const deps = depsOf([
    { itemKey: "A1", regular: true },
    { itemKey: "ATT", regular: false },
    { itemKey: "NOTE", regular: false },
    { itemKey: "A2", regular: true },
  ]);
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    deps,
  );
  assert.deepEqual(
    res.items.map((r) => r.itemKey),
    ["A1", "A2"],
  );
  assert.ok(
    !deps.resolved.includes("ATT") && !deps.resolved.includes("NOTE"),
    `附件/笔记不该被取数：${JSON.stringify(deps.resolved)}`,
  );
});

test("R7-D 过滤：全是附件/笔记 → 空清单、不抛、truncated:false", async () => {
  const deps = depsOf([
    { itemKey: "ATT", regular: false },
    { itemKey: "NOTE", regular: false },
  ]);
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    deps,
  );
  assert.deepEqual(res.items, []);
  assert.equal(res.truncated, false);
});

test("R7-D 过滤：条目在 Zotero 侧已删（resolveItem 回 null）→ 跳过，不占条目也不标 missing", async () => {
  const deps = depsOf([
    { itemKey: "A1", regular: true },
    { itemKey: "GONE", regular: true },
  ]);
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    deps,
  );
  assert.deepEqual(
    res.items.map((r) => r.itemKey),
    ["A1"],
  );
  assert.ok(
    res.items.every((r) => !r.missing),
    "范围清单不做 missing 标红（那是 @ 提及的口径）",
  );
});

// ---- 上限 40 ----

test("R7-D 上限：41 条 → 40 条且 truncated:true（按当前排序取前 40）", async () => {
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    depsOf(regular(41)),
  );
  assert.equal(SCOPE_ITEMS_MAX, 40, "条目上限 40（PLAN §3.6）");
  assert.equal(res.items.length, SCOPE_ITEMS_MAX);
  assert.equal(res.truncated, true);
  assert.equal(res.items[0].itemKey, "R000", "截断保留前 40，不抽样");
  assert.equal(res.items[res.items.length - 1].itemKey, "R039");
});

test("R7-D 上限：正好 40 条 → truncated:false（边界不多不少）", async () => {
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    depsOf(regular(40)),
  );
  assert.equal(res.items.length, 40);
  assert.equal(res.truncated, false);
});

test("R7-D 上限：附件/笔记不占额度（30 条文献 + 20 条附件 → 30 条、不截断）", async () => {
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    depsOf([
      ...regular(30),
      ...Array.from({ length: 20 }, (_, i) => ({
        itemKey: `ATT${i}`,
        regular: false,
      })),
    ]),
  );
  assert.equal(res.items.length, 30);
  assert.equal(res.truncated, false);
});

// ---- 分类模式 / 选中模式 ----

test("R7-D 分类模式：不含子分类（递归开关恒关，子分类条目进不了清单）", async () => {
  // fake 与 Zotero 的 getChildItems(recursive) 同形：只有递归为真才带上子分类
  const deps = depsOf(regular(3, "DIR"), { sub: regular(2, "SUB") });
  const res = await resolveScope(
    { kind: "collection", collectionId: "C1", label: "科学前言" },
    deps,
  );
  assert.equal(res.kind, "collection");
  assert.equal(res.label, "科学前言");
  assert.ok(
    deps.collectionCalls.length === 1 && deps.collectionCalls[0].id === "C1",
    `分类模式要按 collectionId 取数：${JSON.stringify(deps.collectionCalls)}`,
  );
  assert.equal(
    deps.collectionCalls[0].opts.recursive,
    false,
    "递归开关必须关（不含子分类，PLAN §3.6）",
  );
  assert.deepEqual(
    res.items.map((r) => r.itemKey),
    ["DIR000", "DIR001", "DIR002"],
  );
  assert.ok(
    !deps.resolved.some((k) => k.startsWith("SUB")),
    `子分类里的条目不得进入取数面：${JSON.stringify(deps.resolved)}`,
  );
});

test("R7-D 选中模式：用选中集，且不碰分类", async () => {
  const deps = depsOf(regular(2, "SEL"));
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    deps,
  );
  assert.equal(res.kind, "selection");
  assert.equal(deps.selectedCalls, 1);
  assert.equal(deps.collectionCalls.length, 0, "选中模式不该去查分类");
  assert.deepEqual(
    res.items.map((r) => r.itemKey),
    ["SEL000", "SEL001"],
  );
});

test("R7-D 形态：scopeResolved 回执字段齐备（kind / label / items / truncated）", async () => {
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    depsOf(regular(1)),
  );
  for (const field of ["kind", "label", "items", "truncated"] as const) {
    assert.notEqual(
      (res as Record<string, unknown>)[field],
      undefined,
      `缺字段 ${field}`,
    );
  }
  assert.equal(typeof res.label, "string");
  assert.ok(res.label.length > 0, "label 不能是空串（chip 要显示）");
  for (const field of [
    "itemKey",
    "title",
    "creators",
    "year",
    "doi",
    "pdfPath",
    "pdfDir",
    "attachmentKey",
  ]) {
    assert.notEqual(
      (res.items[0] as unknown as Record<string, unknown>)[field],
      undefined,
      `条目缺字段 ${field}（与 resolveRefs 同形）`,
    );
  }
});

test("R7-D 稳健：取数抛错 → 回执仍成形（不把整轮发送打崩）", async () => {
  const res = await resolveScope(
    { kind: "selection", label: "选中条目" },
    {
      resolveItem: async () => {
        throw new Error("Zotero 内部形态变化");
      },
      listSelected: async () => regular(2),
    },
  );
  assert.ok(Array.isArray(res.items));
  assert.equal(typeof res.truncated, "boolean");
});

// ---- 注入区块 ----

const REF: ResolvedRef = {
  itemKey: "A1",
  title: "Attention Is All You Need",
  creators: ["Vaswani", "Shazeer", "Parmar", "Uszkoreit"],
  year: "2017",
  publication: "NeurIPS",
  doi: "10.5555/3295222",
  abstract: "A".repeat(300) + "ZZZ",
  pdfPath: "/lib/storage/AAAA/attention.pdf",
  pdfDir: "/lib/storage/AAAA",
  attachmentKey: "AAAA",
};

const SCOPE = {
  kind: "collection" as const,
  label: "科学前言",
  items: [REF],
  truncated: false,
};

test("R7-D 区块：首行逐字为 `[Scope: <label>]`", () => {
  const block = buildScopeBlock(SCOPE);
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "[Scope: 科学前言]");
});

test("R7-D 区块：尾部有对仗闭标记（[/Scope]〕", () => {
  const block = buildScopeBlock(SCOPE);
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.ok(
    /^\[\/Scope/.test(lines[lines.length - 1]),
    `闭标记形态要对仗（PLAN 只锁了开头，这里按 [Referenced items] 的口径取 [/Scope]）：${lines[lines.length - 1]}`,
  );
});

test("R7-D 区块：条目从 1 起编号，一条一行", () => {
  const block = buildScopeBlock({
    ...SCOPE,
    items: [REF, { ...REF, itemKey: "A2", title: "第二篇" }],
  });
  const numbered = block.split("\n").filter((l) => /^\d+\. /.test(l.trim()));
  assert.equal(numbered.length, 2);
  assert.ok(numbered[0].trim().startsWith("1. "));
  assert.ok(numbered[1].trim().startsWith("2. "));
});

test("R7-D 区块：摘要截到 300 字符（第 301 字符起不得出现）", () => {
  const block = buildScopeBlock(SCOPE);
  assert.equal(
    SCOPE_ABSTRACT_MAX,
    300,
    "范围摘要上限 300（PLAN §3.6，比 @ 的 500 更狠）",
  );
  assert.ok(block.includes("A".repeat(300)), "前 300 字符要在");
  assert.ok(!block.includes("ZZZ"), "超出部分必须截掉（量大要控 token）");
});

test("R7-D 区块：无 PDF 附件 → `PDF: (none)`", () => {
  const block = buildScopeBlock({
    ...SCOPE,
    items: [{ ...REF, pdfPath: null, pdfDir: null, attachmentKey: null }],
  });
  assert.ok(block.includes("PDF: (none)"), `无附件要给 (none)：\n${block}`);
});

test("R7-D 区块：作者缺失 / DOI 缺失 → 不产出 null/undefined 字样，作者只留前 3 位", () => {
  const block = buildScopeBlock({
    ...SCOPE,
    items: [{ ...REF, creators: [], doi: null }],
  });
  assert.ok(!/null|undefined/.test(block), `出现了空值字样：\n${block}`);

  const many = buildScopeBlock(SCOPE);
  assert.ok(
    many.includes("Vaswani") &&
      many.includes("Shazeer") &&
      many.includes("Parmar"),
  );
  assert.ok(!many.includes("Uszkoreit"), "第 4 位作者不上屏");
});

test("R7-D 区块：截断时标「已截断至 40 篇」", () => {
  const block = buildScopeBlock({ ...SCOPE, truncated: true });
  assert.ok(
    block.includes("已截断至 40 篇"),
    `截断要在区块里说清楚（UI 也要标注）：\n${block}`,
  );
});

test("R7-D 区块：同一输入两次调用逐字一致（多条目分隔稳定）", () => {
  const items = [REF, { ...REF, itemKey: "A2", title: "第二篇" }];
  assert.equal(
    buildScopeBlock({ ...SCOPE, items }),
    buildScopeBlock({ ...SCOPE, items }),
  );
});

// ---- 与 @ chips 共存 ----

test("R7-D 共存：上限各自独立 —— @ 满 20 不影响范围 40 条，范围也不占 @ 的额度", () => {
  let m = initialMentionPickerState();
  for (let i = 0; i < MENTION_CHIPS_MAX; i += 1) {
    m = mentionChipAdd(m, { itemKey: `K${i}`, title: `题名 ${i}` });
  }
  assert.equal(m.chips.length, 20);

  const picked = scopeChipSet(initialScopeState(), {
    kind: "collection",
    label: "科学前言",
    itemKeys: Array.from({ length: SCOPE_ITEMS_MAX }, (_, i) => `R${i}`),
    truncated: false,
  });
  assert.equal(SCOPE_ITEMS_MAX, 40);
  assert.equal(picked.chip?.itemKeys.length, 40);
  assert.equal(m.chips.length, 20, "范围 chip 不占 @ chips 的 20 额度");
  assert.equal(
    mentionChipAdd(m, { itemKey: "K20", title: "第 21 篇" }).chips.length,
    20,
    "@ 侧的第 21 个照样被拒",
  );
});

test("R7-D 共存：范围 chip 显示 `分类名 · N 篇`；重选覆盖旧的（同一时刻只留一个范围）", () => {
  const first = scopeChipSet(initialScopeState(), {
    kind: "collection",
    label: "科学前言",
    itemKeys: ["A1", "A2"],
    truncated: false,
  });
  assert.ok(first.chip);
  assert.equal(first.chip.label, "科学前言");
  assert.equal(first.chip.count, 2);

  const second = scopeChipSet(first, {
    kind: "selection",
    label: "我选中的",
    itemKeys: ["B1"],
    truncated: false,
  });
  assert.equal(second.chip?.kind, "selection", "重选覆盖，不叠两个范围 chip");

  const cleared = scopeChipClear(second);
  assert.equal(cleared.chip, null);
});

test("R7-D 共存：面板开合 —— 打开后开关状态跟随；关面板不丢已选范围", () => {
  const opened = scopePickerOpen(initialScopeState());
  assert.equal(opened.open, true);
  const withChip = scopeChipSet(opened, {
    kind: "selection",
    label: "我选中的",
    itemKeys: ["B1"],
    truncated: false,
  });
  assert.equal(withChip.chip?.kind, "selection");
});

test("R7-D add-dir：当前附件目录 ∪ @chip 目录 ∪ 范围目录 → 去重且总数正确", () => {
  const dirs = mergeScopeAddDirs(
    "/lib/A",
    ["/lib/B", "/lib/C"],
    ["/lib/B", "/lib/D", "/lib/E"],
  );
  assert.deepEqual(dirs, ["/lib/A", "/lib/B", "/lib/C", "/lib/D", "/lib/E"]);
});

test("R7-D add-dir：无范围 chip 时与 R7-B 的 mergeAddDirs 逐字一致（20 上限不回归）", () => {
  const chipDirs = Array.from({ length: 25 }, (_, i) => `/lib/D${i}`);
  assert.deepEqual(
    mergeScopeAddDirs("/lib/A", chipDirs, []),
    mergeAddDirs("/lib/A", chipDirs),
  );
});

test("R7-D add-dir：范围模式下最多 40 个目录，当前目录与 @chip 目录优先保留", () => {
  const scopeDirs = Array.from({ length: 60 }, (_, i) => `/lib/S${i}`);
  const dirs = mergeScopeAddDirs("/lib/A", ["/lib/B"], scopeDirs);
  assert.ok(
    dirs.length <= SCOPE_ITEMS_MAX,
    `范围模式 add-dir 最多 40 个目录，实际 ${dirs.length}`,
  );
  assert.equal(dirs[0], "/lib/A");
  assert.equal(dirs[1], "/lib/B");
  assert.equal(new Set(dirs).size, dirs.length, "不得有重复目录");
  assert.ok(!dirs.includes(""), "不得产出空串项");
});

test("R7-D add-dir：空集合 → 空数组（无附件、无 chip、无范围）", () => {
  assert.deepEqual(mergeScopeAddDirs(null, [], []), []);
  assert.deepEqual(mergeScopeAddDirs(null, [null, ""], [null, undefined]), []);
});

test("R7-D 安全红线：范围模式的 40 个目录逐目录都有 deny（扩权不得削弱 PDF 写保护）", () => {
  // §3.6：add-dir 与 deny 同步扩展；40 个目录 → 每个目录各 Write/Edit 两条，共 80 条，一条不少
  const scopeDirs = Array.from(
    { length: SCOPE_ITEMS_MAX },
    (_, i) => `/lib/storage/S${i}`,
  );
  const dirs = mergeScopeAddDirs(null, [], scopeDirs);
  assert.equal(dirs.length, SCOPE_ITEMS_MAX);
  const rules = JSON.parse(buildAttachmentDenySettings(dirs)).permissions.deny;
  assert.equal(rules.length, dirs.length * 2);
  for (const dir of dirs) {
    assert.ok(
      rules.includes(`Write(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Write 拒绝`,
    );
    assert.ok(
      rules.includes(`Edit(//${dir.slice(1)}/**)`),
      `缺 ${dir} 的 Edit 拒绝`,
    );
  }
});
