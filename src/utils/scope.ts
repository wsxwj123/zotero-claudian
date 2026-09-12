// scope.ts — R7-D「跨文献范围注入」宿主侧纯逻辑（PLAN-R7 §3.6）。
// 一次把「一个分类 / 选中的 N 条」作为参考条目注入（几十篇级别的对比与共性总结），
// 仍**不预读全文**：只给清单（题名/作者/年/期刊/DOI/PDF 路径 + 摘要前 300 字），
// Claude 需要时自己按路径 Read；--add-dir 与 deny 同步扩展（安全红线，见 mergeScopeAddDirs）。
//
// 与 @ 提及（mentions.ts）的关系：@ 是点名精读（≤20，摘要 500），范围是批量清单（≤40，摘要 300）；
// 两者共存、上限各自独立，注入区块用不同标记（[Referenced items] / [Scope: …]）。

import {
  MENTION_CHIPS_MAX,
  formatRefLine,
  normalizeRawRef,
  type RawRef,
  type ResolvedRef,
} from "./mentions";

/** 条目上限（PLAN §3.6：超出截断并在 UI/区块标注，按 Zotero 当前排序取前 40） */
export const SCOPE_ITEMS_MAX = 40;
/** 摘要截断（比 @ 的 500 更狠：量大要控 token） */
export const SCOPE_ABSTRACT_MAX = 300;

export type ScopeKind = "collection" | "selection";

/**
 * 「书库中选中的文献」= selection 范围的标签（R12 文案统一）：UI 选项按钮 / chip /
 * 宿主回执 / prompt 区块共用同一串，三处不许各写一份。
 */
export const SCOPE_SELECTION_LABEL = "书库中选中的文献";

/** 范围请求（UI→宿主 resolveScope 的载荷；chip 上只留显示用的 label） */
export interface ScopeRequest {
  kind: ScopeKind;
  /** kind=collection 时必给（Zotero collection id） */
  collectionId?: string | null;
  label: string;
}

/** 候选条目（宿主取数产物；regular=false 模拟附件/笔记——**不该被取数**） */
export interface ScopeCandidate {
  itemKey: string;
  regular: boolean;
}

export interface ScopeDeps {
  resolveItem(itemKey: string): Promise<RawRef | null>;
  /** kind=collection：按 collectionId 取顶层条目（recursive 恒 false，不含子分类） */
  listCollection?(
    id: string,
    opts: { recursive: boolean },
  ): Promise<ScopeCandidate[]>;
  /** kind=selection：ZoteroPane.getSelectedItems()（过滤附件/笔记在纯逻辑里做） */
  listSelected(): Promise<ScopeCandidate[]>;
}

export interface ResolvedScope {
  kind: ScopeKind;
  label: string;
  items: ResolvedRef[];
  truncated: boolean;
}

/** 清单为空/取数失败时的兜底标签（chip 要显示，不能是空串） */
function fallbackLabel(kind: ScopeKind): string {
  return kind === "collection" ? "当前分类" : SCOPE_SELECTION_LABEL;
}

/** 条目形态归一（与 resolveRefs 同口径，见 mentions.normalizeRawRef） */
function toRef(itemKey: string, raw: RawRef): ResolvedRef {
  return { itemKey, ...normalizeRawRef(raw) };
}

/**
 * 范围解析（PLAN §3.6）：
 * - 只取 **regular=true** 的顶层文献条目（附件/笔记连取数都不发）；
 * - 上限 40：按宿主给的**当前排序**取前 40，超出 truncated:true（不抽样）；
 * - 条目在 Zotero 侧已删（resolveItem 回 null）→ 跳过且**不占条目、不标 missing**
 * （missing 是 @ 提及的口径：chip 标红提示；范围清单不标）；
 * - 取数抛错 → 回执仍成形（空清单/truncated:false），绝不把整轮发送打崩。
 */
export async function resolveScope(
  req: ScopeRequest,
  deps: ScopeDeps,
): Promise<ResolvedScope> {
  const kind: ScopeKind =
    req?.kind === "collection" ? "collection" : "selection";
  const rawLabel = typeof req?.label === "string" ? req.label.trim() : "";
  const label = rawLabel || fallbackLabel(kind);
  try {
    const candidates =
      kind === "collection"
        ? ((await deps.listCollection?.(String(req.collectionId ?? ""), {
            recursive: false,
          })) ?? [])
        : await deps.listSelected();
    const regular = (Array.isArray(candidates) ? candidates : []).filter(
      (c): c is ScopeCandidate =>
        !!c &&
        c.regular === true &&
        typeof c.itemKey === "string" &&
        !!c.itemKey,
    );
    const truncated = regular.length > SCOPE_ITEMS_MAX;
    const items: ResolvedRef[] = [];
    for (const candidate of regular.slice(0, SCOPE_ITEMS_MAX)) {
      try {
        const raw = await deps.resolveItem(candidate.itemKey);
        if (raw) {
          items.push(toRef(candidate.itemKey, raw));
        }
      } catch {
        // 单条取数失败 → 跳过该条（范围清单是加分项，不是发送前提）
      }
    }
    return { kind, label, items, truncated };
  } catch {
    return { kind, label, items: [], truncated: false };
  }
}

/**
 * prompt 注入区块（PLAN §3.6）：
 * 首行逐字 `[Scope: <label>]`，尾部 `[/Scope]`；一条一行、从 1 起编号；
 * 摘要截 300；无附件 `PDF: (none)`；截断时标「已截断至 40 篇」；无条目 → 空串（调用方整块省略）。
 */
export function buildScopeBlock(scope: {
  label?: unknown;
  items?: unknown;
  truncated?: unknown;
}): string {
  const items = (Array.isArray(scope?.items) ? scope.items : []).filter(
    (ref): ref is ResolvedRef => !!ref && !ref.missing,
  );
  if (items.length === 0) {
    return "";
  }
  const label =
    typeof scope?.label === "string" && scope.label.trim()
      ? scope.label.trim()
      : fallbackLabel("collection");
  const lines = [`[Scope: ${label}]`];
  items.forEach((ref, index) => {
    lines.push(`${index + 1}. ${formatRefLine(ref, SCOPE_ABSTRACT_MAX)}`);
  });
  if (scope?.truncated === true) {
    lines.push(
      `（已截断至 ${SCOPE_ITEMS_MAX} 篇，按当前排序取前 ${SCOPE_ITEMS_MAX}）`,
    );
  }
  // 数据边界（与 [Referenced items] 同口径）：别让 Claude 把清单当主文献
  lines.push("以上为参考资料，非本轮主文献。");
  lines.push("[/Scope]");
  return lines.join("\n");
}

/**
 * 本轮 `--add-dir` 列表（PLAN §3.6 读权限行）：当前附件目录 ∪ @ chip 目录 ∪ 范围目录。
 * 有范围目录时上限 40（当前目录与 @chip 目录优先保留），无范围时与 R7-B 的 mergeAddDirs
 * 逐字一致（上限 20，不回归）；顺序稳定、去重、过滤空值。
 * **返回值整批喂给 cliRunner.buildAttachmentDenySettings**（逐目录生成 Write/Edit 拒绝行，
 * 只取第一个 = 漏保护，见单测安全红线）。
 */
export function mergeScopeAddDirs(
  current: string | null | undefined,
  chipDirs: readonly (string | null | undefined)[] | null | undefined,
  scopeDirs: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  const valid = (
    list: readonly (string | null | undefined)[] | null | undefined,
  ): string[] =>
    (Array.isArray(list) ? list : []).filter(
      (dir): dir is string => typeof dir === "string" && dir.length > 0,
    );
  const scope = valid(scopeDirs);
  const cap = scope.length > 0 ? SCOPE_ITEMS_MAX : MENTION_CHIPS_MAX;
  const out: string[] = [];
  const push = (dir: string | null | undefined): void => {
    if (
      typeof dir === "string" &&
      dir.length > 0 &&
      out.length < cap &&
      !out.includes(dir)
    ) {
      out.push(dir);
    }
  };
  push(current);
  for (const dir of valid(chipDirs)) {
    push(dir);
  }
  for (const dir of scope) {
    push(dir);
  }
  return out;
}
