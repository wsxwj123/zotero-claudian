// sessionStore.ts — 会话索引 + 旁挂历史（PLAN §2.4 / INTERFACE §4.5）。
// 纯逻辑模块：文件系统经 SessionStoreFs 注入（Gecko 侧 IOUtils，见 modules/sections.ts），
// 不 import 任何 Zotero 全局 → node:test 直接跑。
//
// 写策略（§4.5）：所有写操作收敛到**单一 writer 队列**串行执行（防并发交错落盘）；
// 索引每次状态变化全量重写、先写 .tmp 再 move（原子替换）；历史 read-modify-write 也在队列内完成。
// 信任边界：只操作索引内存在的 session id，且 id 需过 ID_PATTERN —— 手改索引塞进
// "../../x" 类 id 不能穿透出数据目录（history/<sessionId>.jsonl 是拼出来的路径）。
// 删除语义（§2.4/§4.5）：只删本模块自管的索引记录与旁挂历史，绝不触碰 ~/.claude 下 CLI 自己的会话文件。

import { PERMISSION_MODES, type PermissionMode } from "../modules/cliRunner";
import type { Platform } from "../modules/cliDetect";
import { isUsageStats, type UsageStats } from "../chat/lib/usage";
import { joinPath } from "./paths";

/** 索引文件格式版本（§4.5；未来迁移时按 version 分叉） */
export const SESSIONS_INDEX_VERSION = 1;
/** 会话标题上限（§4.5：首条用户消息前 40 字符） */
export const SESSION_TITLE_MAX = 40;

/** 索引记录（§4.5 JSON 形态） */
export interface SessionRecord {
  /** 插件侧 uuid */
  id: string;
  /** CLI session_id；首轮未完成时为 null（此时不带 --resume） */
  claudeSessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 父条目 key；通用会话为 null */
  itemKey: string | null;
  itemLibraryID: number | null;
  /** PDF 附件 key；无则 null */
  attachmentKey: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  messageCount: number;
  lastCostUsd: number;
  /**
   * R7-H/I：分支会话的父（插件会话 id）。顶层会话缺省；分支可再分支（层级不限）。
   * 父被删 → 孤儿分支仍按顶层展示（UI 侧 sessionRows 负责），索引不做级联删除。
   */
  parentId?: string | null;
  /** R7-H/I：同一父下的分支序号（1 起，按父各自递增）；非分支缺省 */
  branchIndex?: number | null;
  /**
   * R7-I：待分叉 —— 分支会话的首轮 spawn 时执行「截断父会话 → --fork-session → 立刻还原」，
   * 拿到 CLI 新 id 后清空本字段（此后就是一个普通会话）。正常会话缺省。
   */
  forkFrom?: { sessionId: string; turn: number } | null;
  /**
   * R4-3：该会话累计 token 用量（每轮 result 的 usage 累加，随索引入口落盘）。
   * 从未跑过带用量的轮 → 缺省（不写该键：旧索引/新索引形态一致，UI 见「无数据」不显示该段）。
   */
  usage?: UsageStats;
}

/** 旁挂历史单行（§4.5；也是桥 history 消息的载荷形态） */
export interface HistoryRecord {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface SessionsIndexResult {
  version: number;
  sessions: SessionRecord[];
  /** true = 原文件不可用 → 宿主改名 bak 并新建空索引（§4.5 损坏恢复） */
  corrupted: boolean;
}

/** id 白名单：本模块自产 id 形态（uuid / sess-…）之外一律拒绝。
 *  两处信任边界共用同一形态：① session id 拼进历史文件名（路径拼接）；
 *  ② claudeSessionId 拼进 argv 的 `--resume <id>` 参数位（BUG-32）。
 *  首字符必须字母数字——`-`/`--xxx` 形态会被命令行解析器当选项吃掉，绝不能进参数位。
 *  写法注意：连字符与 `_` 必须置于字符类**末尾**（`9` 与 `_` 之间会被解析成区间 0x39–0x5F，
 *  把 [ ] \ ^ ` 一并漏放；见 BUG-32 单测）。 */
/**
 * 会话索引/历史文件权限（同机其他用户不可读；与快照 0600 同口径）。
 * **写位（0o200）是硬要求，不许改成 0o400/0o500**：win32 上 `IOUtils.setPermissions` 只映射
 * 读/写两档（`nsLocalFileWin.cpp` 的模式位映射），去掉写位 = 给文件置 `FILE_ATTRIBUTE_READONLY`
 * → 后续 `appendOrCreate` 追加历史、索引的「remove + move」原子覆盖全部失败。
 * 另注：win32 上 0600 **给不了**「同机其他用户不可读」（读权限由 ACL 决定，只读属性最多挡写），
 * 这里的两条语义在 Windows 上只剩「保持可写」这一条真正生效。
 */
export const SESSION_FILE_MODE = 0o600;

// 判据唯一来源见 utils/ids.ts（cliRunner 的 argv 边界共用同一份）
import { SESSION_ID_PATTERN as ID_PATTERN } from "./ids";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** R8：卡口外露给 utils/rewind 的会话文件定位（CLI 会话 id 拼进路径前也走同一形态） */
export function isSafeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * claudeSessionId 落索引前的白名单（R8 写侧补齐）：
 * 该字段是 argv 注入面（拼进 `--resume <id>`，BUG-32）——读盘归一（normalizeSessionRecord）
 * 一直拦着，写侧（create/update）却原样落盘，于是「同一份索引，重启前后两套行为」：
 * 本进程内存里那串畸形值会直接被拼进 argv。判据与读盘归一同一处，改口径只改这里。
 */
function safeClaudeSessionId(value: unknown): string | null {
  const s = asNonEmptyString(value);
  return s && isSafeId(s) ? s : null;
}

/** R7-I：待分叉标记归一（形态不对 → null，缺省不写该键） */
function normalizeForkFrom(
  value: unknown,
): { sessionId: string; turn: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = asNonEmptyString(value.sessionId);
  const turn = value.turn;
  if (!sessionId || typeof turn !== "number" || !Number.isFinite(turn)) {
    return null;
  }
  return { sessionId, turn };
}

/**
 * 索引反序列化 + 归一（契约函数，验收锁定）。
 * 判定口径：JSON 解析失败 / 非对象 / 缺 sessions 数组 / null → corrupted=true。
 * 单条记录形态不对（非对象、无字符串 id）只丢该条，不整份判损坏——其余会话照常可用。
 */
export function loadSessionsIndex(
  raw: string,
  defaultPermissionMode: PermissionMode = "acceptEdits",
): SessionsIndexResult {
  const corrupted = (): SessionsIndexResult => ({
    version: SESSIONS_INDEX_VERSION,
    sessions: [],
    corrupted: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupted();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    return corrupted();
  }
  const sessions: SessionRecord[] = [];
  for (const entry of parsed.sessions) {
    const record = normalizeSessionRecord(entry, defaultPermissionMode);
    if (record) {
      sessions.push(record);
    }
  }
  return {
    version: asFiniteNumber(parsed.version, SESSIONS_INDEX_VERSION),
    sessions,
    corrupted: false,
  };
}

function normalizeSessionRecord(
  entry: unknown,
  defaultPermissionMode: PermissionMode,
): SessionRecord | null {
  if (!isRecord(entry)) {
    return null;
  }
  const id = asNonEmptyString(entry.id);
  if (!id) {
    return null; // 无 id 的记录无法寻址，丢弃该条
  }
  const mode = entry.permissionMode;
  const libraryID = entry.itemLibraryID;
  return {
    id,
    // argv 卫生（BUG-32）：claudeSessionId 会拼进 `--resume <id>`，磁盘上被篡改的索引
    // 能借此把 `--xxx` 形态 token 塞进参数位。只放行本模块 id 白名单形态（CLI session_id 为
    // uuid），畸形值丢弃 —— 该会话退化为首轮重开，绝不把任意串递给 CLI。
    claudeSessionId: safeClaudeSessionId(entry.claudeSessionId),
    title: typeof entry.title === "string" ? entry.title : "",
    createdAt: asFiniteNumber(entry.createdAt, 0),
    updatedAt: asFiniteNumber(entry.updatedAt, 0),
    itemKey: asNonEmptyString(entry.itemKey),
    itemLibraryID: typeof libraryID === "number" ? libraryID : null,
    attachmentKey: asNonEmptyString(entry.attachmentKey),
    permissionMode: (PERMISSION_MODES as readonly string[]).includes(
      mode as string,
    )
      ? (mode as PermissionMode)
      : defaultPermissionMode,
    allowedTools: Array.isArray(entry.allowedTools)
      ? entry.allowedTools.filter((t): t is string => typeof t === "string")
      : [],
    messageCount: asFiniteNumber(entry.messageCount, 0),
    lastCostUsd: asFiniteNumber(entry.lastCostUsd, 0),
    // R7-H/I：分支字段（缺省不写该键，旧索引形态不变）
    ...(asNonEmptyString(entry.parentId)
      ? { parentId: entry.parentId as string }
      : {}),
    ...(typeof entry.branchIndex === "number" &&
    Number.isFinite(entry.branchIndex)
      ? { branchIndex: entry.branchIndex }
      : {}),
    ...(normalizeForkFrom(entry.forkFrom)
      ? { forkFrom: normalizeForkFrom(entry.forkFrom) }
      : {}),
    // R4-3：形态不合法/缺省 → 不带该键（不写 0 值假数据，UI 才不会显示「0 用量」）
    ...(isUsageStats(entry.usage) ? { usage: entry.usage } : {}),
  };
}

/**
 * 旁挂历史反序列化（契约函数，验收锁定）。
 * 逐行 JSON.parse：空行跳过、非法 JSON 行跳过、非消息形态（非对象 / role 不是 user|assistant /
 * text 非字符串）跳过——单行坏不牵连其余行，永不抛错。
 */
export function parseHistoryJsonl(raw: string): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const role = parsed.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (typeof parsed.text !== "string") {
      continue;
    }
    out.push({
      role,
      text: parsed.text,
      ts: asFiniteNumber(parsed.ts, 0),
    });
  }
  return out;
}

/** 旁挂历史序列化（契约函数，验收锁定）：单行 JSON、无结尾换行（拼 "\n" 即写进 jsonl） */
export function formatHistoryRecord(rec: HistoryRecord): string {
  return JSON.stringify({ role: rec.role, text: rec.text, ts: rec.ts });
}

// ---- 文件系统注入面（Gecko 侧 IOUtils，测试侧内存实现）----

export interface SessionStoreFs {
  /** 文件不存在 → null（区别于空文件 ""：后者是损坏）。读取失败（I/O 错误）必须抛，不得吞成 null/"": */
  readText(path: string): Promise<string | null>;
  /**
   * 写入文本。`opts.mode` 指定权限位（如 0o600）——**会话索引与历史属用户研究内容**，
   * 默认 umask 会写成 0644（同机其他用户可读），故调用方一律传 0o600（2026-09-11 安全复查）。
   */
  writeText(
    path: string,
    data: string,
    opts?: { mode?: number },
  ): Promise<void>;
  /** 追加写（文件不存在则创建）。历史文件只走这个口——既有内容绝不重写（BUG-21） */
  appendText(
    path: string,
    data: string,
    opts?: { mode?: number },
  ): Promise<void>;
  /** 同目录改名/移动，目标已存在时覆盖 */
  move(from: string, to: string): Promise<void>;
  /** 不存在不抛 */
  remove(path: string): Promise<void>;
  /** 递归建目录；已存在不抛 */
  makeDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface SessionStoreDeps {
  /** 插件数据目录（Zotero.Profile.dir + /claudian/，宿主侧 PathUtils.join 拼好） */
  dataDir: string;
  /** 路径分隔符分叉（joinPath） */
  platform: Platform;
  fs: SessionStoreFs;
  log(message: string): void;
  now(): number;
  defaultPermissionMode(): PermissionMode;
}

export interface SessionRecordInput {
  title?: string;
  claudeSessionId?: string | null;
  itemKey?: string | null;
  itemLibraryID?: number | null;
  attachmentKey?: string | null;
  permissionMode?: PermissionMode;
  /** R7-H/I：分支会话的父 / 同父序号 / 待分叉标记（普通会话不传） */
  parentId?: string | null;
  branchIndex?: number | null;
  forkFrom?: { sessionId: string; turn: number } | null;
}

export interface SessionStore {
  /**
   * 载入索引（幂等，首次调用者触发）；损坏 → 改名 bak + 新建空索引。
   * 读失败不 reject（记日志 + 保持未载入，下次操作重试）：此调用方是握手路径，
   * 抛出去只会变成未处理拒绝；数据安全由「载入成功前写操作被拒」保证（BUG-21b）。
   */
  init(): Promise<void>;
  /** 全量列表，按 updatedAt 降序（最新在前，UI 列表顺序） */
  list(): SessionRecord[];
  get(id: string): SessionRecord | null;
  /** 最近活动的一条（UI 未绑定会话时的兜底目标） */
  mostRecent(): SessionRecord | null;
  /**
   * 新建会话（分配 id → 落索引）。
   * **失败即 reject**（既有约定）：索引写盘失败、以及 R11 复查后的 fail-closed
   * ——环境没有安全随机源时 newSessionId 抛错，本方法原样上抛（hostBridge 走既有错误路径：
   * handleCreateSession → SAVE_FAILED；send 的隐式建会话 → guard 记录并中止本轮）。
   * 绝不返回「无名 id」的半成品：那种记录会落盘、可被 list()/mostRecent() 认领，却读不了历史。
   */
  create(input?: SessionRecordInput): Promise<SessionRecord>;
  /** 局部更新（updatedAt 自动写 now()）；未知 id → null */
  update(
    id: string,
    patch: Partial<SessionRecord>,
  ): Promise<SessionRecord | null>;
  /**
   * 用户重命名：trim + 截断 40 字符（与创建时同口径）；空标题/未知 id → null（不改动）。
   * **不动 updatedAt**：改名不是「活动」，列表（按 updatedAt 降序）顺序不该因此跳动。
   */
  rename(id: string, title: string): Promise<SessionRecord | null>;
  /** 删索引记录 + 旁挂历史文件（§4.5；不碰 ~/.claude）；未知 id → false */
  remove(id: string): Promise<boolean>;
  /** 追加一轮 user+assistant 两行；返回写入行数（未知 id → 0） */
  appendTurn(
    id: string,
    userText: string,
    assistantText: string,
  ): Promise<number>;
  /** 读旁挂历史；未知 id/无文件/读失败 → []（§4.6 getHistory 契约） */
  readHistory(id: string): Promise<HistoryRecord[]>;
  /** 排空写队列（宿主 shutdown 与测试同步点） */
  flush(): Promise<void>;
  /** 索引曾因损坏被重置（UI 提示「会话索引已重置」） */
  wasReset(): boolean;
}

/**
 * 会话 id 生成（**两档，都以强随机为源、都过 ID_PATTERN**）：
 *   ① crypto.randomUUID()（uuid）—— 正常环境恒走这档；
 *   ② crypto.getRandomValues 自造 hex —— 有 WebCrypto 但没 randomUUID 的旧 Gecko/测试桩。
 * R11 安全复查（第二次点名，2026-09-12）：删掉「时间戳 + Math.random」第三档。
 * Math.random 可预测（V8 的 xorshift128+ 可由少量输出反推状态），而会话 id 会拼进
 * history/<id>.jsonl 的路径与 `--resume <id>` 的参数位——不该拿弱随机当标识。
 * fail-closed：两档都拿不到 → **抛错**，绝不退回可预测 id（宁可不建，也不落一个可猜的名字）。
 * 调用方见 create()：异常沿既有错误路径上抛（hostBridge 的 SAVE_FAILED / guard 记录）。
 */
export function newSessionId(): string {
  try {
    const uuid = globalThis.crypto.randomUUID();
    // 产出必须过白名单：不然后续所有路径操作都会被 isSafeId 拒掉（会话建了却读不了历史）
    if (isSafeId(uuid)) {
      return uuid;
    }
  } catch {
    // 没有 randomUUID（或它抛）→ 试第二档
  }
  try {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // 连 WebCrypto 都没有 → 无安全随机源，fail-closed（见上）
  }
  throw new Error(
    "当前环境缺少安全随机源（crypto.randomUUID 与 crypto.getRandomValues 均不可用），拒绝生成会话 id",
  );
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const indexPath = (): string =>
    joinPath(deps.platform, deps.dataDir, "sessions.json");
  const historyDir = (): string =>
    joinPath(deps.platform, deps.dataDir, "history");
  /** 唯一把会话 id 拼进路径的地方：**三个调用点各自先过 isSafeId**（remove→removeHistoryFile /
   *  appendTurn / readHistory），新增调用点必须照做（id 是路径片段，`../` 类串能逃出数据目录）。 */
  const historyPath = (id: string): string =>
    joinPath(deps.platform, historyDir(), `${id}.jsonl`);

  let sessions: SessionRecord[] = [];
  let version = SESSIONS_INDEX_VERSION;
  let reset = false;
  let loadPromise: Promise<void> | null = null;

  // 单一 writer 队列（§4.5）：任务串行执行；链尾吞掉失败（各调用方自行接住自己的那一步）
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function atomicWrite(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await deps.fs.writeText(tmp, data, { mode: SESSION_FILE_MODE });
    await deps.fs.move(tmp, path);
  }

  /** 索引全量落盘（队列内调用；入队请用 enqueue，避免自等待死锁） */
  async function writeIndex(next: SessionRecord[] = sessions): Promise<void> {
    await atomicWrite(
      indexPath(),
      JSON.stringify({ version, sessions: next }, null, 2),
    );
  }

  /**
   * 索引提交（OBS-3）：**先落盘、成功才改内存**。
   * 旧实现（create/update/remove）都是先改内存再写盘，写失败时内存里留着没落盘的变更——
   * create 失败就多一条「幽灵会话」：list()/mostRecent() 会把它当既成事实（下次 send 认领它），
   * 但它并不在盘上，重启后又凭空消失。
   */
  async function commitIndex(next: SessionRecord[]): Promise<void> {
    await writeIndex(next);
    sessions = next;
  }

  /** 队列内任务：只删 id 合法且存在的历史文件 */
  async function removeHistoryFile(id: string): Promise<void> {
    if (!isSafeId(id)) {
      deps.log(`[sessionStore] refuse unsafe session id: ${id}`);
      return;
    }
    try {
      await deps.fs.remove(historyPath(id));
    } catch (err) {
      deps.log(`[sessionStore] remove history failed (${id}): ${String(err)}`);
    }
  }

  /**
   * 首次调用触发载入；成功后复用同一 Promise（幂等）。
   * 失败（索引读不出来）**不缓存**：置空以便下次操作重试——磁盘临时故障不该让本进程永久瘫掉，
   * 但重试成功之前所有写操作都会被这一步挡住（见 load 的抛错口径，BUG-21b）。
   */
  function ensureLoaded(): Promise<void> {
    loadPromise ??= enqueue(load).catch((err: unknown) => {
      loadPromise = null; // 允许下次重试
      throw err; // 让调用方看到失败：写操作据此中止，绝不覆盖内容未知的索引
    });
    return loadPromise;
  }

  async function load(): Promise<void> {
    // 目录只需在首次写之前存在；这里建一次，后续写路径不再重复 exists 检查
    try {
      await deps.fs.makeDir(deps.dataDir);
      await deps.fs.makeDir(historyDir());
    } catch (err) {
      deps.log(`[sessionStore] makeDirectory failed: ${String(err)}`);
    }
    let raw: string | null;
    try {
      raw = await deps.fs.readText(indexPath());
    } catch (err) {
      // BUG-21b：读失败 ≠ 首次运行。绝不把「读不出来」当空索引——后续任何写都是全量重写，
      // 会把未知内容的既有索引整份覆盖。抛出去让本次调用失败，下次操作重试（loadPromise 已置空）。
      deps.log(
        `[sessionStore] read index failed, stay unloaded (will retry): ${String(err)}`,
      );
      throw err;
    }
    if (raw === null) {
      return; // 首次运行（文件确实不存在）：空索引，不落盘（等首次状态变化）
    }
    const parsed = loadSessionsIndex(raw, deps.defaultPermissionMode());
    if (!parsed.corrupted) {
      version = parsed.version;
      sessions = parsed.sessions;
      return;
    }
    // 损坏恢复（§4.5）：原文件改名 bak（保留现场供排查），再新建空索引
    reset = true;
    const bak = `${indexPath()}.bak-${deps.now()}`;
    try {
      await deps.fs.move(indexPath(), bak);
      deps.log(`[sessionStore] index corrupted → renamed to ${bak}`);
    } catch (err) {
      // 备份没成就不写空索引：原文件可能还能人工捞回，覆盖它等于二次损坏。保持未载入 + 下次重试
      deps.log(
        `[sessionStore] backup corrupted index failed, keep original: ${String(err)}`,
      );
      throw err;
    }
    sessions = [];
    try {
      await writeIndex();
    } catch (err) {
      deps.log(`[sessionStore] write empty index failed: ${String(err)}`);
    }
  }

  function findIndex(id: string): number {
    return sessions.findIndex((s) => s.id === id);
  }

  return {
    init(): Promise<void> {
      // 读失败只记日志：init 的调用方（握手路径）没有错误出口，数据安全靠写操作拒绝兜住
      return ensureLoaded().catch((err: unknown) => {
        deps.log(`[sessionStore] init: index not loaded yet: ${String(err)}`);
      });
    },

    list(): SessionRecord[] {
      return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get(id: string): SessionRecord | null {
      return sessions.find((s) => s.id === id) ?? null;
    },

    mostRecent(): SessionRecord | null {
      // 不用 this.list()：方法被解构后 this 会丢
      let best: SessionRecord | null = null;
      for (const s of sessions) {
        if (!best || s.updatedAt > best.updatedAt) {
          best = s;
        }
      }
      return best;
    },

    create(input: SessionRecordInput = {}): Promise<SessionRecord> {
      return ensureLoaded().then(() =>
        enqueue(async () => {
          const ts = deps.now();
          // 无安全随机源时这里抛（R11 复查 fail-closed）：本任务 reject、commitIndex 不执行，
          // 索引与内存都不留半成品（见 SessionStore.create 的契约注释）
          const record: SessionRecord = {
            id: newSessionId(),
            // 写侧白名单（R8）：与读盘归一同一判据，畸形值不落索引（否则重启后凭空变 null）
            claudeSessionId: safeClaudeSessionId(input.claudeSessionId),
            title: input.title ?? "",
            createdAt: ts,
            updatedAt: ts,
            itemKey: input.itemKey ?? null,
            itemLibraryID: input.itemLibraryID ?? null,
            attachmentKey: input.attachmentKey ?? null,
            permissionMode:
              input.permissionMode ?? deps.defaultPermissionMode(),
            allowedTools: [],
            messageCount: 0,
            lastCostUsd: 0,
            // R7-H/I：分支字段只在传了值时写入（普通会话的索引形态不变）
            ...(input.parentId ? { parentId: input.parentId } : {}),
            ...(typeof input.branchIndex === "number"
              ? { branchIndex: input.branchIndex }
              : {}),
            ...(input.forkFrom ? { forkFrom: input.forkFrom } : {}),
          };
          await commitIndex([...sessions, record]);
          return record;
        }),
      );
    },

    update(
      id: string,
      patch: Partial<SessionRecord>,
    ): Promise<SessionRecord | null> {
      return ensureLoaded().then(() =>
        enqueue(async () => {
          const i = findIndex(id);
          if (i < 0) {
            return null;
          }
          const merged: SessionRecord = {
            ...sessions[i],
            ...patch,
            id: sessions[i].id, // id 不可被 patch 改写
            // 写侧白名单（R8）：patch 里的 claudeSessionId 与 create/读盘同一判据过筛——
            // 该字段下一轮就拼进 `--resume <id>`，不能靠「重启后才归一」兜底。
            // 用 in 判定而非 ??：显式 null（BUG-25 清死 id）必须清得掉，不能被 fallback 留住
            claudeSessionId: safeClaudeSessionId(
              "claudeSessionId" in patch
                ? patch.claudeSessionId
                : sessions[i].claudeSessionId,
            ),
            updatedAt: patch.updatedAt ?? deps.now(),
          };
          await commitIndex(sessions.map((s, j) => (j === i ? merged : s)));
          return merged;
        }),
      );
    },

    rename(id: string, title: string): Promise<SessionRecord | null> {
      // 标题口径与创建时一致（handleSend 的 text.slice(0, SESSION_TITLE_MAX)）：trim 后截断。
      // 截断在**入队前**判定，空标题连索引都不碰（UX：清空输入框 = 不改名）
      const clean = title.trim().slice(0, SESSION_TITLE_MAX);
      if (!clean) {
        deps.log(`[sessionStore] rename: empty title ignored (${id})`);
        return Promise.resolve(null);
      }
      return ensureLoaded().then(() =>
        enqueue(async () => {
          const i = findIndex(id);
          if (i < 0) {
            return null;
          }
          const renamed: SessionRecord = { ...sessions[i], title: clean };
          await commitIndex(sessions.map((s, j) => (j === i ? renamed : s)));
          return renamed;
        }),
      );
    },

    remove(id: string): Promise<boolean> {
      return ensureLoaded().then(() =>
        enqueue(async () => {
          const i = findIndex(id);
          if (i < 0) {
            deps.log(`[sessionStore] remove: unknown session ${id}`);
            return false;
          }
          // 先落索引：历史文件删不掉时，会话也不会再出现在列表里
          await commitIndex(sessions.filter((s, j) => j !== i));
          // isSafeId 在 removeHistoryFile 内（手改索引入逃逸 id 时：记录照删、越界路径绝不碰，
          // 语义见 sessionStore.attack.test.ts B3-3）
          await removeHistoryFile(id);
          return true;
        }),
      );
    },

    appendTurn(
      id: string,
      userText: string,
      assistantText: string,
    ): Promise<number> {
      return ensureLoaded().then(() =>
        enqueue(async () => {
          if (findIndex(id) < 0 || !isSafeId(id)) {
            deps.log(`[sessionStore] appendTurn: unknown session ${id}`);
            return 0;
          }
          const ts = deps.now();
          const lines = [
            formatHistoryRecord({ role: "user", text: userText, ts }),
          ];
          if (assistantText) {
            // assistant 无文本（纯工具轮）不写空行：UI 回放会渲染空气泡
            lines.push(
              formatHistoryRecord({
                role: "assistant",
                text: assistantText,
                ts,
              }),
            );
          }
          // BUG-21：历史**只追加、绝不重写**。旧实现是「读全文 → 拼接 → 整份写回」，
          // 读一旦失败（I/O 错误）就被当成空历史 → 整段旧对话被覆盖且返回成功。
          // 现在读只用来判断要不要补前导换行，读失败也只影响这一处、不牵动既有内容。
          const path = historyPath(id);
          let needsLeadingNewline = false;
          try {
            const prev = await deps.fs.readText(path);
            needsLeadingNewline =
              prev !== null && prev.length > 0 && !prev.endsWith("\n");
          } catch (err) {
            // 读不出来时保守补一个换行：多出的空行会被 parseHistoryJsonl 跳过，
            // 代价远小于「两行粘成一行」丢记录（B4-3 同口径）
            needsLeadingNewline = true;
            deps.log(
              `[sessionStore] read history failed (${id}) → conservative append: ${String(err)}`,
            );
          }
          await deps.fs.appendText(
            path,
            `${needsLeadingNewline ? "\n" : ""}${lines.join("\n")}\n`,
            { mode: SESSION_FILE_MODE },
          );
          return lines.length;
        }),
      );
    },

    async readHistory(id: string): Promise<HistoryRecord[]> {
      await ensureLoaded();
      // 未知 id（含已删除会话）→ 空数组（§4.6）；id 白名单是路径拼接的第二道闸
      if (!isSafeId(id) || findIndex(id) < 0) {
        return [];
      }
      try {
        const raw = await deps.fs.readText(historyPath(id));
        return raw === null ? [] : parseHistoryJsonl(raw);
      } catch (err) {
        deps.log(`[sessionStore] readHistory failed (${id}): ${String(err)}`);
        return [];
      }
    },

    async flush(): Promise<void> {
      await ensureLoaded();
      await chain;
    },

    wasReset(): boolean {
      return reset;
    },
  };
}
