// mentions.ts — R7-B「@ 提及」宿主侧纯逻辑（PLAN-R7 §3）。
// 检索过滤面（标题/作者/期刊/年份/分类名）、候选与 chips 上限、resolveRefs 缺项、
// prompt 注入区块 [Referenced items]、--add-dir 合并（去重、当前附件目录在前）。
// 不 import Zotero 全局：真实取数经 MentionRefDeps 注入（modules/contextSource.ts）。
//
// 为什么（用户原话 2026-09-11）：「跨 pdf 的对话…对比不同文献（几篇 几十篇）之间的差异或者总结共性」——
// 跨文献的前提是「读得到 + 不一篇篇弹卡」：点名文献 → 注入参考条目 + 扩大 --add-dir 只读面
//（写保护不因此削弱，见 cliRunner.buildAttachmentDenySettings 的多目录 deny）。

/** 检索关键词上限（PLAN §3：query 64 字符） */
export const MENTION_QUERY_MAX = 64;
/** 候选上限（下拉最多 20 条） */
export const MENTION_RESULTS_MAX = 20;
/** chips / --add-dir 上限（一次最多引用 20 篇） */
export const MENTION_CHIPS_MAX = 20;
/** 注入区块里摘要的截断长度（控 token） */
export const MENTION_ABSTRACT_MAX = 500;
/** 注入区块里作者只留前 3 位（PLAN §3 格式行） */
export const MENTION_AUTHORS_MAX = 3;

/** 候选条目（itemSearchResult.items 的元素形态，UI 靠这几个字段画列表） */
export interface MentionSearchItem {
  itemKey: string;
  title: string;
  creators: string[];
  year: string | null;
  publication: string | null;
  itemType: string;
  /** 所属分类名（PLAN §3 检索面之一；取不到 → 空/缺省） */
  collectionNames?: string[];
}

/** 解析后的引用条目（refsResolved.refs 的元素形态） */
export interface ResolvedRef {
  itemKey: string;
  title: string;
  creators: string[];
  year: string | null;
  publication: string | null;
  doi: string | null;
  abstract: string | null;
  pdfPath: string | null;
  pdfDir: string | null;
  attachmentKey: string | null;
  /** 查不到该条目（已删/权限/内部异常）→ true：UI 标红，发送时跳过 */
  missing?: boolean;
}

/** 宿主取数产物（不含 itemKey/missing——那两个由 resolveMentionRefs 填） */
export type RawRef = Omit<ResolvedRef, "itemKey" | "missing">;

export interface MentionRefDeps {
  /** itemKey → 条目字段；查不到 → null（缺项标 missing，不抛） */
  resolveItem(itemKey: string): Promise<RawRef | null>;
}

/** 检索匹配面：标题/作者/期刊/年份/分类名（同一串里各字段拼一起，大小写不敏感；中文天然可匹配） */
function searchableFields(item: MentionSearchItem): string[] {
  const collectionNames = Array.isArray(item.collectionNames)
    ? item.collectionNames
    : [];
  return [
    typeof item.title === "string" ? item.title : "",
    Array.isArray(item.creators) ? item.creators.join(" ") : "",
    typeof item.publication === "string" ? item.publication : "",
    item.year == null ? "" : String(item.year),
    collectionNames.join(" "),
  ];
}

/**
 * 检索（纯函数，宿主已把候选集取来）：
 * - 大小写不敏感、中文按子串匹配；命中多条按**输入序**返回（下拉不抖动）；
 * - 空关键词 → 列前 20 条（用户打 `@` 先看到东西，而不是空下拉）；超长关键词截到 64；
 * - 候选上限 20，截断保留前 20（不抽样）。
 */
export function searchMentionItems(
  items: readonly MentionSearchItem[],
  query: unknown,
): MentionSearchItem[] {
  const list = Array.isArray(items) ? items : [];
  const q = String(query ?? "")
    .trim()
    .slice(0, MENTION_QUERY_MAX)
    .toLowerCase();
  const hit = (item: MentionSearchItem): boolean =>
    !q ||
    searchableFields(item).some((field) => field.toLowerCase().includes(q));
  return list.filter(hit).slice(0, MENTION_RESULTS_MAX);
}

function missingRef(itemKey: string): ResolvedRef {
  return {
    itemKey,
    title: "",
    creators: [],
    year: null,
    publication: null,
    doi: null,
    abstract: null,
    pdfPath: null,
    pdfDir: null,
    attachmentKey: null,
    missing: true,
  };
}

/** 取数字段归一：非字符串 → null（防把 undefined 写进注入区块）；R7-D 范围条目同用 */
export function normalizeRawRef(raw: RawRef): RawRef {
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    creators: Array.isArray(raw.creators) ? raw.creators : [],
    year: raw.year == null ? null : String(raw.year),
    publication: raw.publication ?? null,
    doi: raw.doi ?? null,
    abstract: raw.abstract ?? null,
    pdfPath: raw.pdfPath ?? null,
    pdfDir: raw.pdfDir ?? null,
    attachmentKey: raw.attachmentKey ?? null,
  };
}

/**
 * 发送前解析 chips → 注入用结构（PLAN §3）：
 * - 顺序与输入一致（UI 按位置标红）；
 * - 查不到 → missing:true，位置不丢；单条取数抛错按缺项处理（整批不崩，与 R6「取数抛错回落」同口径）；
 * - 空输入 → 空数组且一次取数都不发（只读原则）；
 * - 输入先按 chips 上限截断（防 UI 侧漏掉上限时无限查库）。
 */
export async function resolveMentionRefs(
  itemKeys: unknown,
  deps: MentionRefDeps,
): Promise<ResolvedRef[]> {
  const keys = (Array.isArray(itemKeys) ? itemKeys : [])
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .slice(0, MENTION_CHIPS_MAX);
  const refs: ResolvedRef[] = [];
  for (const key of keys) {
    try {
      const raw = await deps.resolveItem(key);
      refs.push(
        raw ? { itemKey: key, ...normalizeRawRef(raw) } : missingRef(key),
      );
    } catch {
      refs.push(missingRef(key));
    }
  }
  return refs;
}

/** 按码点截断（不切断 emoji），到界即返 */
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/**
 * 单条引文行：`<题名> — <作者(前3)> (<年>) <期刊> | DOI: … | PDF: … | 摘要: …`（缺项整段省略）。
 * R7-D 范围区块复用同一行格式（摘要上限不同：@ 是 500，范围是 300）。
 */
export function formatRefLine(
  ref: ResolvedRef,
  abstractMax: number = MENTION_ABSTRACT_MAX,
): string {
  const authors = ref.creators.slice(0, MENTION_AUTHORS_MAX).join(", ");
  const head = authors ? `${ref.title} — ${authors}` : ref.title;
  const yearPub = [ref.year ? `(${ref.year})` : "", ref.publication ?? ""]
    .filter(Boolean)
    .join(" ");
  const tail = [
    ref.doi ? `DOI: ${ref.doi}` : "",
    ref.pdfPath ? `PDF: ${ref.pdfPath}` : "PDF: (none)",
    ref.abstract ? `摘要: ${truncate(ref.abstract, abstractMax)}` : "",
  ].filter(Boolean);
  return [head, yearPub, tail.join(" | ")].filter(Boolean).join(" ");
}

/**
 * prompt 注入区块（PLAN §3）：区块排在 [Zotero context] 之后、用户输入之前。
 * 首尾标记逐字为 `[Referenced items]` / `[/Referenced items]`；missing 条目不上屏；
 * 无引文 → 空串（调用方据此整块省略）。同一输入两次调用逐字一致。
 */
export function buildReferencedItemsBlock(
  refs: readonly ResolvedRef[],
): string {
  const list = (Array.isArray(refs) ? refs : []).filter(
    (ref): ref is ResolvedRef => !!ref && !ref.missing,
  );
  if (list.length === 0) {
    return "";
  }
  const lines = ["[Referenced items]"];
  list.forEach((ref, index) => {
    lines.push(`${index + 1}. ${formatRefLine(ref)}`);
  });
  // 数据边界（PLAN §3 明确要求）：别让 Claude 把参考资料当主文献
  lines.push("以上为参考资料，非本轮主文献。");
  lines.push("[/Referenced items]");
  return lines.join("\n");
}

/**
 * 本轮 `--add-dir` 列表（PLAN §3 读权限行）：当前附件目录 ∪ 各 chip 的 pdfDir。
 * 顺序稳定（当前在前）、去重、过滤空值、最多 20 个（当前附件目录优先保留）。
 */
export function mergeAddDirs(
  current: string | null | undefined,
  chipDirs: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const push = (dir: string | null | undefined): void => {
    if (
      typeof dir === "string" &&
      dir.length > 0 &&
      out.length < MENTION_CHIPS_MAX &&
      !out.includes(dir)
    ) {
      out.push(dir);
    }
  };
  push(current);
  for (const dir of Array.isArray(chipDirs) ? chipDirs : []) {
    push(dir);
  }
  return out;
}
