// collectionWorkspace.ts — R6「按合集分工作区」：合集判定 / 目录名净化 / 重名索引（纯函数）
// + 一个 DI 可测的落盘编排 resolveTurnWorkspace（宿主注入 IOUtils 与 Zotero 取数）。
// 不 import Zotero 全局：node:test 用 fake fs + fake CollectionDeps 跑全矩阵。
//
// 为什么有这层：用户希望在具体分类（如「科学前言」）下读文献时有专属工作区目录，好在里面放
// 项目级 CLAUDE.md。工作区根目录的 CLAUDE.md 依然生效（Claude Code 从 cwd 逐级向上加载），
// 所以根放通用要求、合集目录放项目要求。

/** 工作区模式（设置页 workspaceMode） */
export type WorkspaceMode = "single" | "collection";

export const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  "single",
  "collection",
];

/** 脏值/空值一律回落 single（= 既有行为，回归零容忍） */
export function normalizeWorkspaceMode(value: unknown): WorkspaceMode {
  return (WORKSPACE_MODES as readonly unknown[]).includes(value)
    ? (value as WorkspaceMode)
    : "single";
}

/** 目录名长度上限（码点计；Windows 整路径 260 上限下的安全余量，超出截断） */
export const COLLECTION_DIR_MAX = 80;

/** 合集索引文件（落在工作区根；只记 目录名 → collectionID 归属） */
export const WORKSPACE_INDEX_FILE = ".claudian-collections.json";

export interface CollectionIndexEntry {
  dir: string;
  collectionID: number;
}

/** Zotero 侧取数注入面（真实实现见 modules/contextSource.ts） */
export interface CollectionDeps {
  /** 当前 Zotero 面板里选中的 collection id；没选中/取不到 → null */
  getSelectedCollectionID(): number | null;
  /** 该条目的全部所属合集 id（取不到 → []） */
  getItemCollectionIDs(itemKey: string): Promise<number[]>;
  /** 合集名（取不到 → null，调用方回落 collection-<id>） */
  getCollectionName(collectionID: number): string | null;
}

/** 文件系统注入面（真实实现走 IOUtils/PathUtils，见 sections.ts） */
export interface WorkspaceFs {
  exists(path: string): Promise<boolean>;
  /** createAncestors 语义（父目录一并建） */
  makeDir(path: string): Promise<void>;
  /** 不存在 → null */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** 目录下子项名（文件+子目录）——顺带触发一次真实访问（macOS TCC 探针同 getChildren） */
  listNames(dir: string): Promise<string[]>;
  join(dir: string, name: string): string;
}

// ---- 合集判定（契约优先级）----

/**
 * 本轮该用哪个合集：
 * ① 面板选中的 collection 且该文献属于它 → 用它（用户「正在某分类下看文献」的直接证据）；
 * ② 否则该文献所属合集里 collectionID 最小的那个（稳定序，不随 Zotero 返回顺序抖动）；
 * ③ 不属于任何合集 → null（调用方回落工作区根）。
 */
export function pickCollectionID(
  selectedCollectionID: number | null | undefined,
  itemCollectionIDs: readonly number[],
): number | null {
  const ids = itemCollectionIDs.filter(
    (id) => Number.isInteger(id) && (id as number) > 0,
  );
  if (
    typeof selectedCollectionID === "number" &&
    ids.includes(selectedCollectionID)
  ) {
    return selectedCollectionID;
  }
  if (ids.length === 0) {
    return null;
  }
  return [...ids].sort((a, b) => a - b)[0];
}

// ---- 目录名净化 ----

/**
 * Windows 保留名（设备名）判定：**按第一个 `.` 之前的部分判**——`CON.txt` / `nul.md` / `LPT1.log`
 * 在 Windows 上同样是设备名，建目录会失败（R6 兼容审查必修-1）。
 * 另把上标数字（COM¹/COM²/COM³，U+00B9/B2/B3）归一成 ASCII 数字后再判——Windows 也认这些形态。
 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "¹": "1",
  "²": "2",
  "³": "3",
};

function isReservedDeviceName(name: string): boolean {
  const head = name.split(".")[0] ?? "";
  const normalized = head
    .replace(/[¹²³]/g, (ch) => SUPERSCRIPT_DIGITS[ch] ?? ch)
    .trim()
    .toLowerCase();
  return RESERVED_NAME_RE.test(normalized);
}

/** 非法字符：路径分隔符与 `*?"<>|`（换空格，防 "a/b"→"ab" 撞名）；控制字符直接删（见下） */
const ILLEGAL_RE = /[/\\:*?"<>|]/g;

/** 控制字符剔除（C0 + DEL）；按码点遍历，emoji 代理对不受影响（不写 \x00-\x1f 正则：eslint no-control-regex） */
function stripControlChars(text: string): string {
  return [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

/** 按码点截断（不切断 emoji 代理对），截断处不留尾点/尾空白（Windows 静默去尾点） */
function truncateDirName(name: string, max: number): string {
  const chars = [...name];
  if (chars.length <= max) {
    return name;
  }
  const cut = chars
    .slice(0, max)
    .join("")
    .replace(/[.\s]+$/u, "");
  return cut;
}

/** 加后缀且总长仍 ≤ 上限（后缀是 ASCII，正常不会超，防的是「80 字符名 + 后缀」） */
function withSuffix(base: string, suffix: string): string {
  return (
    truncateDirName(base, Math.max(1, COLLECTION_DIR_MAX - suffix.length)) +
    suffix
  );
}

/**
 * 合集名 → 目录名（纯函数，契约口径）：
 * 去非法字符与控制字符、首尾空白与点、压缩连续空白、Windows 保留名加 `-<collectionID>` 后缀、
 * 超长按码点截断到 80、空名回落 `collection-<collectionID>`。中文/emoji 原样保留。
 */
export function sanitizeCollectionDirName(
  raw: unknown,
  collectionID: number,
): string {
  const fallback = `collection-${collectionID}`;
  if (typeof raw !== "string") {
    return fallback;
  }
  let name = stripControlChars(raw)
    .replace(ILLEGAL_RE, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+/u, "")
    .replace(/[.\s]+$/u, "");
  if (!name) {
    return fallback;
  }
  if (isReservedDeviceName(name)) {
    // 后缀必须插在**第一个 `.` 之前**：Windows 只看到第一个点为止，`CON.txt-9` 依然被当设备名
    // （`CON-9.txt` / `CON-9` 才安全）
    const dot = name.indexOf(".");
    name =
      dot === -1
        ? `${name}-${collectionID}`
        : `${name.slice(0, dot)}-${collectionID}${name.slice(dot)}`;
  }
  return truncateDirName(name, COLLECTION_DIR_MAX) || fallback;
}

// ---- 目录名 → collectionID 索引（重名冲突与自愈）----

/** 索引解析：文件缺失/空/坏 JSON/形状不符 → []（调用方按「无归属」处理，不覆盖既有目录） */
export function parseCollectionIndex(
  raw: string | null,
  log?: (message: string) => void,
): CollectionIndexEntry[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const list = Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (!list) {
      log?.("[claudian] collection index: unexpected shape → treated as empty");
      return [];
    }
    const seenIDs = new Set<number>();
    const seenDirs = new Set<string>();
    const entries: CollectionIndexEntry[] = [];
    for (const item of list) {
      const dir = (item as { dir?: unknown })?.dir;
      const id = (item as { collectionID?: unknown })?.collectionID;
      if (typeof dir !== "string" || !dir.trim()) continue;
      // 必须是**单个目录名**，不能是路径：索引文件躺在工作区里（AI 可写），
      // 被改写后若原样 join+makeDir，下一轮 spawn 的 cwd 就能逃出工作区（R6 兼容审查建议-2 / 安全复查）
      if (dir.startsWith(".")) continue; // 含 "." ".." 与一切点开头（净化产物本就不会以点开头）
      if (/[/\\]/.test(dir) || /^[A-Za-z]:/.test(dir) || dir.startsWith("~")) {
        log?.(`[claudian] collection index: reject non-segment dir (${dir})`);
        continue;
      }
      if (stripControlChars(dir) !== dir) continue;
      if (!Number.isInteger(id) || (id as number) <= 0) continue;
      const key = dir.toLowerCase();
      if (seenIDs.has(id as number) || seenDirs.has(key)) continue;
      seenIDs.add(id as number);
      seenDirs.add(key);
      entries.push({ dir, collectionID: id as number });
    }
    return entries;
  } catch (err) {
    log?.(
      `[claudian] collection index parse failed → treated as empty: ${String(err)}`,
    );
    return [];
  }
}

export function serializeCollectionIndex(
  entries: readonly CollectionIndexEntry[],
): string {
  return JSON.stringify({ version: 1, entries }, null, 2);
}

/**
 * 该合集的目录名（纯函数）：
 * - 索引里已有该 collectionID 的归属 → 复用（同名同 ID 不新建，目录被删也照原路径重建）；
 * - 否则净化为 base；base 已被别的合集/既有条目占用（含大小写不敏感，macOS/Windows 同名即同目录）
 *   → 退让加 `-<collectionID>` 后缀；仍占用则再加 `-2`…（索引丢失时的自愈路径，绝不并入既有目录）。
 * 返回新索引（未变化时逐字相等，调用方据此决定是否落盘）。
 */
export function resolveCollectionDirName(input: {
  collectionID: number;
  name: string | null;
  index: readonly CollectionIndexEntry[];
  /** 工作区根下已存在的子项名（含文件）；索引丢失时靠它退让 */
  takenNames: readonly string[];
}): { dir: string; index: CollectionIndexEntry[] } {
  const { collectionID, index } = input;
  const owned = index.find((e) => e.collectionID === collectionID);
  if (owned) {
    return { dir: owned.dir, index: [...index] };
  }
  const taken = new Set(input.takenNames.map((n) => n.toLowerCase()));
  const occupied = (dir: string): boolean => {
    const key = dir.toLowerCase();
    if (taken.has(key)) {
      return true;
    }
    return index.some((e) => e.dir.toLowerCase() === key);
  };
  const base = sanitizeCollectionDirName(input.name, collectionID);
  let dir = base;
  for (let n = 1; occupied(dir) && n <= 9; n += 1) {
    dir =
      n === 1
        ? withSuffix(base, `-${collectionID}`)
        : // 走 withSuffix 而非裸拼：`-<id>-<n>` 后缀更长，裸拼会突破 80 上限（R6 兼容审查建议-1）
          withSuffix(base, `-${collectionID}-${n}`);
  }
  return { dir, index: [...index, { dir, collectionID }] };
}

// ---- 落盘编排（DI 可测）----

function workspaceUnavailable(root: string, cause: unknown): Error {
  const error = new Error(`workspace unavailable: ${root} (${String(cause)})`);
  (error as { code?: string }).code = "WORKSPACE_UNAVAILABLE";
  return error;
}

export interface ResolveTurnWorkspaceInput {
  /** 工作区根（getWorkspacePath()） */
  root: string;
  mode: WorkspaceMode;
  /** 本轮上下文条目 key（父条目优先，独立 PDF = 附件自身）；null = 通用会话 */
  itemKey: string | null;
  collections: CollectionDeps;
  fs: WorkspaceFs;
  log(message: string): void;
}

/**
 * 本轮 spawn cwd：
 * - single 模式 / 通用会话（无条目）→ 工作区根（= 既有行为，逐字不变）；
 * - collection 模式 → `<根>/<合集目录名>`；合集判定/净化/索引/建目录任何一步失败都**回落根目录**
 *   并记日志（可用性优先：绝不因目录问题让用户发不出消息）。
 * 只有「工作区根本身不可用」（TCC 拒绝等）才抛 code=WORKSPACE_UNAVAILABLE（显式报错，不静默）。
 */
export async function resolveTurnWorkspace(
  input: ResolveTurnWorkspaceInput,
): Promise<string> {
  const { root, fs, log } = input;
  // 根目录确保 + 真实访问探针（macOS TCC 拒绝后 exists 仍可能 true 但读写被拦）
  try {
    if (!(await fs.exists(root))) {
      await fs.makeDir(root);
    }
    await fs.listNames(root);
  } catch (err) {
    log(`[claudian] workspace unavailable: ${root} (${String(err)})`);
    throw workspaceUnavailable(root, err);
  }
  if (input.mode !== "collection" || !input.itemKey) {
    return root;
  }
  try {
    const ids = await input.collections.getItemCollectionIDs(input.itemKey);
    const picked = pickCollectionID(
      input.collections.getSelectedCollectionID(),
      ids,
    );
    if (picked == null) {
      log(
        "[claudian] collection workspace: item in no collection → workspace root",
      );
      return root;
    }
    const indexPath = fs.join(root, WORKSPACE_INDEX_FILE);
    const index = parseCollectionIndex(
      await fs.readText(indexPath).catch(() => null),
      log,
    );
    const { dir, index: nextIndex } = resolveCollectionDirName({
      collectionID: picked,
      name: input.collections.getCollectionName(picked),
      index,
      takenNames: await fs.listNames(root),
    });
    const dirPath = fs.join(root, dir);
    await fs.makeDir(dirPath);
    await fs.listNames(dirPath); // 可访问性探针（同根目录口径）
    if (
      serializeCollectionIndex(index) !== serializeCollectionIndex(nextIndex)
    ) {
      try {
        await fs.writeText(indexPath, serializeCollectionIndex(nextIndex));
      } catch (err) {
        // 目录已建成，索引写失败只影响下次的归属判定（可能多出一个 -<id> 目录），不拦本轮
        log(`[claudian] collection index write failed: ${String(err)}`);
      }
    }
    log(`[claudian] collection workspace: collection=${picked} dir=${dirPath}`);
    return dirPath;
  } catch (err) {
    log(
      `[claudian] collection workspace failed → falling back to root: ${String(err)}`,
    );
    return root;
  }
}
