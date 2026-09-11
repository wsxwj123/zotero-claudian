// sessionList.ts — R7-K「会话列表重组」纯投影（PLAN-R7 §3.12，用户拍板六条全做）。
// 纯函数不碰 DOM、无 IO：输入会话记录（UI 侧投影）+ 置顶/展开/搜索态，输出四个区：
//   置顶（不限量、不折叠、不受归档影响） → 当前文献 → 「全部会话」抽屉（按合集分组） → 归档。
//
// 分区归属按**树根**算（裁决：分支跟着父所在的分区走，父在抽屉里分支不跑进当前文献区）；
// 排序除置顶区外一律 updatedAt 倒序（分支按 branchIndex 升序挂在父之下，默认只展开一层）。
// 搜索只做过滤（不改变分区结构），命中会话标题 + 文献题名（大小写不敏感、中文子串）；
// 搜索时归档区参与（归档默认隐藏、但不是搜不到）。

export const ARCHIVE_IDLE_DAYS = 90;
export const ARCHIVE_MAX_RECENT = 50;
export const UNFILED_LABEL = "未分类";

/** 会话记录（UI 侧投影；字段缺省都按「无」处理，脏数据不抛） */
export interface SessionListItem {
  id: string;
  title?: string | null;
  itemKey?: string | null;
  itemTitle?: string | null;
  collectionName?: string | null;
  updatedAt?: number | null;
  parentId?: string | null;
  branchIndex?: number | null;
}

export type SessionListRow<T extends SessionListItem = SessionListItem> = T & {
  /** 0 = 顶层；父之下的分支为 1，再往下 2… */
  depth: number;
};

export interface SessionListGroup<T extends SessionListItem = SessionListItem> {
  label: string;
  rows: SessionListRow<T>[];
}

export interface SessionListModel<T extends SessionListItem = SessionListItem> {
  pinned: SessionListRow<T>[];
  current: SessionListRow<T>[];
  groups: SessionListGroup<T>[];
  archive: SessionListRow<T>[];
}

export interface SessionListInput<T extends SessionListItem = SessionListItem> {
  sessions?: readonly T[] | null;
  currentItemKey?: string | null;
  pinned?: readonly string[] | null;
  expanded?: readonly string[] | null;
  query?: string | null;
  now?: number | null;
  showArchive?: boolean | null;
}

const DAY_MS = 86_400_000;

function timeOf(s: SessionListItem): number {
  return typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt)
    ? s.updatedAt
    : 0;
}

function branchOrder(s: SessionListItem): number {
  return typeof s.branchIndex === "number" && Number.isFinite(s.branchIndex)
    ? s.branchIndex
    : 0;
}

/** 树根（父在集合里才认父；父被删的孤儿 = 顶层，不消失；自环/成环在本函数外侧的 visited 里兜住） */
function rootOf(
  s: SessionListItem,
  byId: Map<string, SessionListItem>,
): SessionListItem {
  const seen = new Set<string>([s.id]);
  let cur = s;
  while (true) {
    const parentId = cur.parentId;
    if (typeof parentId !== "string" || parentId === "" || seen.has(parentId)) {
      return cur;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return cur;
    }
    seen.add(parentId);
    cur = parent;
  }
}

/** 搜索命中：会话标题 + 文献题名（大小写不敏感、中文子串） */
function matches(s: SessionListItem, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const hay = [s.title, s.itemTitle]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  return hay.some((v) => v.includes(needle));
}

function labelOf(s: SessionListItem): string {
  return typeof s.collectionName === "string" && s.collectionName !== ""
    ? s.collectionName
    : UNFILED_LABEL;
}

/**
 * 会话列表投影。入参全可缺省（空态直接四区皆空，不抛）。
 * 分区互斥：一条会话只出现在一个区里（置顶 > 归档 > 当前文献 > 抽屉分组）。
 */
export function buildSessionList<T extends SessionListItem>(
  input: SessionListInput<T>,
): SessionListModel<T> {
  const empty: SessionListModel<T> = {
    pinned: [],
    current: [],
    groups: [],
    archive: [],
  };
  const list = (Array.isArray(input?.sessions) ? input.sessions : []).filter(
    (s): s is T => !!s && typeof s.id === "string" && s.id !== "",
  );
  if (list.length === 0) {
    return empty;
  }
  const byId = new Map(list.map((s) => [s.id, s]));
  const pinnedSet = new Set(
    (Array.isArray(input?.pinned) ? input.pinned : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const expandedSet = new Set(
    (Array.isArray(input?.expanded) ? input.expanded : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const now =
    typeof input?.now === "number" && Number.isFinite(input.now)
      ? input.now
      : Date.now();
  const idleBefore = now - ARCHIVE_IDLE_DAYS * DAY_MS;

  // 归档判定（全表、剔除置顶后按 updatedAt 倒序；空间/时间两个阈值取并集）：
  // 90 天未更新，或近期窗口（前 50 条）之外。
  const archivedIds = new Set<string>();
  const rest = list
    .filter((s) => !pinnedSet.has(s.id))
    .sort((a, b) => timeOf(b) - timeOf(a));
  let recent = 0;
  for (const s of rest) {
    const idle = timeOf(s) < idleBefore;
    recent += 1;
    if (idle || recent > ARCHIVE_MAX_RECENT) {
      archivedIds.add(s.id);
    }
  }

  const query =
    typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
  const showArchive = input?.showArchive === true || query !== "";
  const visible = list.filter((s) => matches(s, query));

  // 分区归属（按树根；搜索过滤后父不在可见集合里 → 该会话成了新的顶层，depth 0）
  type Zone = {
    kind: "pinned" | "current" | "group" | "archive";
    label: string;
  };
  const zoneOf = (s: SessionListItem): Zone => {
    if (pinnedSet.has(s.id)) {
      return { kind: "pinned", label: "" };
    }
    if (archivedIds.has(s.id)) {
      return { kind: "archive", label: "" };
    }
    if (
      input?.currentItemKey != null &&
      s.itemKey != null &&
      s.itemKey === input.currentItemKey
    ) {
      return { kind: "current", label: "" };
    }
    return { kind: "group", label: labelOf(s) };
  };

  const visibleIds = new Set(visible.map((s) => s.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of visible) {
    const parentId =
      typeof s.parentId === "string" &&
      s.parentId !== s.id &&
      visibleIds.has(s.parentId)
        ? s.parentId
        : null;
    if (parentId === null) {
      roots.push(s);
    } else {
      const siblings = children.get(parentId);
      if (siblings) {
        siblings.push(s);
      } else {
        children.set(parentId, [s]);
      }
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => branchOrder(a) - branchOrder(b));
  }

  const pinnedRows: SessionListRow<T>[] = [];
  const currentRows: SessionListRow<T>[] = [];
  const groupRows = new Map<string, SessionListRow<T>[]>();
  const archiveRows: SessionListRow<T>[] = [];
  const sortNewest = (a: T, b: T): number => timeOf(b) - timeOf(a);
  const visited = new Set<string>();
  const walk = (session: T, depth: number): void => {
    if (visited.has(session.id)) {
      return; // 脏数据成环时兜底：每个会话只出现一次
    }
    visited.add(session.id);
    const zone = zoneOf(rootOf(session, byId));
    const row: SessionListRow<T> = { ...session, depth };
    if (zone.kind === "pinned") {
      pinnedRows.push(row);
    } else if (zone.kind === "archive") {
      if (showArchive) {
        archiveRows.push(row);
      }
    } else if (zone.kind === "current") {
      currentRows.push(row);
    } else {
      const rows = groupRows.get(zone.label);
      if (rows) {
        rows.push(row);
      } else {
        groupRows.set(zone.label, [row]);
      }
    }
    if (depth >= 1 && !expandedSet.has(session.id)) {
      return; // 默认只展开一层：分支的分支要显式展开才出现
    }
    for (const child of children.get(session.id) ?? []) {
      walk(child, depth + 1);
    }
  };
  // 顶层按 updatedAt 倒序（分支跟着父走，不单独参与排序）
  for (const root of [...roots].sort(sortNewest)) {
    walk(root, 0);
  }

  const newest = (rows: SessionListRow<T>[]): number =>
    rows.reduce((acc, r) => Math.max(acc, timeOf(r)), 0);
  const groups = [...groupRows.entries()]
    .map(([label, rows]) => ({ label, rows }))
    .sort((a, b) => newest(b.rows) - newest(a.rows));

  return {
    pinned: pinnedRows,
    current: currentRows,
    groups,
    archive: archiveRows,
  };
}
