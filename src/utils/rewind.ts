// rewind.ts — R7-H「真回滚」（PLAN-R7 §3.9）：每轮快照 + 编辑/分支时「截断→分叉→还原」编排。
// 纯逻辑模块：文件系统与 CLI 分叉均注入（Gecko 侧 IOUtils + spawnTurn，见 modules/sections.ts），
// 不 import 任何 Zotero 全局 → node:test 直接跑。
//
// 机制（已由主会话真机实测确认，勿改）：
//   每轮结束把 `~/.claude/projects/<项目目录>/<claudeSessionId>.jsonl` 快照到
//   `<插件数据目录>/snapshots/<插件会话id>/<轮序号>.jsonl`；「编辑/分支」时：
//     ①写 journal → ②备份原文件 → ③用第 k 轮快照替换原文件 → ④`--resume <原id> --fork-session`
//     → ⑤立刻还原原文件 → ⑥清 journal。
//   替原文件存在的窗口里崩溃 → 下次启动按 journal 还原（幂等）。
//
// 信任边界：原文件路径（sourcePath）由宿主用 cwd 拼出，本模块只认「快照索引里记的 projectDir
// 与本次传入一致」这一条闸——不一致即拒绝（cwd 变了=项目目录变了，绝不猜）。

/** 快照 / 备份 / journal / 索引一律 0600（同机其它用户读不到会话内容） */
export const SNAPSHOT_FILE_MODE = 0o600;
/** 快照目录名（落在插件数据目录下，不进工作区、不入 git） */
export const SNAPSHOT_DIR_NAME = "snapshots";
/** 回滚 journal（单个全局文件；同一时刻只允许一次回滚在跑） */
export const REWIND_JOURNAL_FILE = "rewind-journal.json";

/** 文件系统注入面（与 SessionStoreFs 同形，多一个 writeText 的 mode 选项） */
export interface RewindFs {
  /** 文件不存在 → null；读取失败（I/O 错误）抛 */
  readText(path: string): Promise<string | null>;
  writeText(
    path: string,
    data: string,
    opts?: { mode?: number },
  ): Promise<void>;
  /** 仅本目录一层的文件名（无则空数组），不含子目录 */
  listNames(dir: string): Promise<string[]>;
  makeDir(path: string): Promise<void>;
  /** 不存在不抛 */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  join(...seg: string[]): string;
}

export interface RewindDeps {
  fs: RewindFs;
  log?(message: string): void;
}

/** 分叉 runner 注入面：跑一次 `claude --resume <id> --fork-session`，回 CLI 生成的新会话 id */
export interface RewindRunner {
  fork(input: {
    args: string[];
    cwd: string;
  }): Promise<{ newClaudeSessionId: string }>;
}

/** 回滚失败原因（拒绝路径一律零副作用：不写 journal、不分叉、不碰原文件） */
export type RewindFailReason =
  | "PROJECT_DIR_MISMATCH"
  | "SNAPSHOT_MISSING"
  | "SOURCE_MISSING"
  | "REWIND_BUSY"
  | "FORK_FAILED"
  | "RESTORE_FAILED";

export type RewindResult =
  | { ok: true; claudeSessionId: string }
  | { ok: false; reason: RewindFailReason; error?: string };

export interface SnapshotIndexEntry {
  turn: number;
  projectDir: string;
}

export interface SnapshotIndex {
  /** 拍快照时的 CLI 会话 id（第 0 轮还不知道 → ""） */
  claudeSessionId: string;
  snapshots: SnapshotIndexEntry[];
}

export interface SnapshotInput {
  dataDir: string;
  /** 插件会话 id（快照目录名） */
  sessionId: string;
  /** 拍快照时的 CLI 会话 id；第 0 轮（尚未 init）传 null → 索引记 "" */
  claudeSessionId?: string | null;
  /** 本轮 cwd 派生的 CLI 项目目录名 */
  projectDir: string;
  /** CLI 自己的会话文件；null/不存在 → 快照落空文件（第 0 轮） */
  sourcePath: string | null;
}

export interface RewindInput {
  dataDir: string;
  /** 被回滚的插件会话 id（快照目录名） */
  sessionId: string;
  /** 该会话的 CLI 会话 id（分叉的 --resume 目标） */
  claudeSessionId: string;
  /** 目标轮序号：编辑用户消息 k → k−1；分支消息 k → k */
  turn: number;
  /** 本次 cwd 派生（与快照时不一致即拒绝） */
  projectDir: string;
  /** CLI 会话文件绝对路径 */
  sourcePath: string;
  /** 分叉进程的 cwd（= 本轮工作区） */
  cwd?: string;
}

/** 回滚 journal（崩溃恢复的唯一依据；字段名即磁盘格式） */
export interface RewindJournal {
  sessionId: string;
  turn: number;
  originalPath: string;
  backupPath: string;
  snapshotPath: string;
}

// ---- 落点 ----

export function snapshotDir(dataDir: string, sessionId: string): string {
  return `${dataDir}/${SNAPSHOT_DIR_NAME}/${sessionId}`;
}

export function snapshotPath(
  dataDir: string,
  sessionId: string,
  turn: number,
): string {
  return `${snapshotDir(dataDir, sessionId)}/${turn}.jsonl`;
}

export function backupPath(
  dataDir: string,
  sessionId: string,
  turn: number,
): string {
  return `${snapshotDir(dataDir, sessionId)}/${turn}.backup.jsonl`;
}

/** 回滚 journal 落点（数据目录内，全局唯一） */
export function journalPath(dataDir: string): string {
  return `${dataDir}/${SNAPSHOT_DIR_NAME}/${REWIND_JOURNAL_FILE}`;
}

function indexPath(dataDir: string, sessionId: string): string {
  return `${snapshotDir(dataDir, sessionId)}/index.json`;
}

/**
 * cwd → CLI 项目目录名（`~/.claude/projects/<此值>/<sessionId>.jsonl`）。
 * 实测（CLI 2.1.267）：非 [A-Za-z0-9] 的字符一律换成 `-`
 * （/Users/me/.scratch → -Users-me--scratch）。
 */
export function encodeProjectDir(cwd: string): string {
  return String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * 下一个快照轮序号 = max(既有轮号)+1（空目录从 0 起）。
 * 只认 `N.jsonl`：index.json / `2.backup.jsonl` / 临时文件都不计入。
 */
export function nextSnapshotTurn(existingNames: string[]): number {
  let max = -1;
  for (const name of Array.isArray(existingNames) ? existingNames : []) {
    const m = /^(\d+)\.jsonl$/.exec(String(name));
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
  }
  return max + 1;
}

// ---- 快照 ----

/** 读快照索引；文件不存在/坏 JSON/形态不对 → null（不抛） */
export async function readSnapshotIndex(
  input: { dataDir: string; sessionId: string },
  deps: { fs: RewindFs },
): Promise<SnapshotIndex | null> {
  let raw: string | null;
  try {
    raw = await deps.fs.readText(indexPath(input.dataDir, input.sessionId));
  } catch {
    // 读失败按「不可回滚」处理（回 null），绝不静默成空索引放行回滚
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as { claudeSessionId?: unknown; snapshots?: unknown };
  const snapshots: SnapshotIndexEntry[] = [];
  for (const entry of Array.isArray(obj.snapshots) ? obj.snapshots : []) {
    const e = entry as { turn?: unknown; projectDir?: unknown } | null;
    if (
      e &&
      typeof e.turn === "number" &&
      Number.isFinite(e.turn) &&
      typeof e.projectDir === "string"
    ) {
      snapshots.push({ turn: e.turn, projectDir: e.projectDir });
    }
  }
  return {
    claudeSessionId:
      typeof obj.claudeSessionId === "string" ? obj.claudeSessionId : "",
    snapshots,
  };
}

/**
 * 拍一次快照：原文件逐字节拷进 `snapshots/<会话id>/<max+1>.jsonl`（0600），并把
 * 本轮的项目目录记进 index.json（H2：collection 模式下 cwd 随合集变，拒绝路径靠它比对）。
 * 原文件不存在（会话刚建、CLI 还没写盘）→ 落空文件，不抛。
 */
export async function snapshotTurn(
  input: SnapshotInput,
  deps: { fs: RewindFs },
): Promise<{ turn: number; path: string }> {
  const dir = snapshotDir(input.dataDir, input.sessionId);
  await deps.fs.makeDir(dir);
  let names: string[] = [];
  try {
    names = await deps.fs.listNames(dir);
  } catch {
    names = [];
  }
  const turn = nextSnapshotTurn(names);
  const source = input.sourcePath
    ? await deps.fs.readText(input.sourcePath)
    : null;
  const path = snapshotPath(input.dataDir, input.sessionId, turn);
  await deps.fs.writeText(path, source ?? "", { mode: SNAPSHOT_FILE_MODE });

  const prev = await readSnapshotIndex(input, deps);
  const claudeSessionId =
    (input.claudeSessionId ?? "") || prev?.claudeSessionId || "";
  const snapshots = [
    ...(prev?.snapshots ?? []).filter((s) => s.turn !== turn),
    { turn, projectDir: input.projectDir },
  ].sort((a, b) => a.turn - b.turn);
  await deps.fs.writeText(
    indexPath(input.dataDir, input.sessionId),
    JSON.stringify({ claudeSessionId, snapshots }, null, 2),
    { mode: SNAPSHOT_FILE_MODE },
  );
  return { turn, path };
}

// ---- 回滚编排 ----

/**
 * 单次回滚在跑标记（H5：单 journal + 宿主串行 → 并发第二次**被拒**，不是排队）。
 * 模块级：journal 是全局唯一文件，同一刻只允许一次替换原文件的窗口存在。
 */
let rewindBusy = false;

/**
 * 回滚到第 turn 轮并分叉出新会话（编排顺序见文件头）。
 * - 拒绝路径（项目目录不一致 / 快照缺失 / 原文件不存在 / 并发）零副作用；
 * - fork 抛错也要还原原文件（失败不许把用户会话留成半截）；
 * - 还原失败 → journal 保留给下次启动重试 + 显式报错。
 */
export async function rewindToTurn(
  input: RewindInput,
  deps: RewindDeps & { runner: RewindRunner },
): Promise<RewindResult> {
  if (rewindBusy) {
    deps.log?.("rewind: another rewind in progress → rejected (REWIND_BUSY)");
    return { ok: false, reason: "REWIND_BUSY", error: "已有回滚在跑" };
  }
  rewindBusy = true;
  try {
    const index = await readSnapshotIndex(
      { dataDir: input.dataDir, sessionId: input.sessionId },
      deps,
    );
    const entry = index?.snapshots.find((s) => s.turn === input.turn);
    if (!entry) {
      return {
        ok: false,
        reason: "SNAPSHOT_MISSING",
        error: "该轮快照不存在（老会话或快照被清理过），不可回滚",
      };
    }
    if (entry.projectDir !== input.projectDir) {
      return {
        ok: false,
        reason: "PROJECT_DIR_MISMATCH",
        error:
          "当前项目目录与快照时不一致（工作区模式/合集变了），不猜测、已拒绝",
      };
    }
    const snapshot = await deps.fs.readText(
      snapshotPath(input.dataDir, input.sessionId, input.turn),
    );
    if (snapshot === null) {
      return {
        ok: false,
        reason: "SNAPSHOT_MISSING",
        error: "该轮快照内容读不到，不可回滚",
      };
    }
    const original = await deps.fs.readText(input.sourcePath);
    if (original === null) {
      return {
        ok: false,
        reason: "SOURCE_MISSING",
        error: "CLI 会话文件不存在，不可回滚",
      };
    }

    const journal: RewindJournal = {
      sessionId: input.sessionId,
      turn: input.turn,
      originalPath: input.sourcePath,
      backupPath: backupPath(input.dataDir, input.sessionId, input.turn),
      snapshotPath: snapshotPath(input.dataDir, input.sessionId, input.turn),
    };
    await deps.fs.makeDir(snapshotDir(input.dataDir, input.sessionId));
    // ① journal 先落（里面要有备份/还原所需的一切，崩了下次启动才有得救）
    await deps.fs.writeText(
      journalPath(input.dataDir),
      JSON.stringify(journal),
      {
        mode: SNAPSHOT_FILE_MODE,
      },
    );
    // ② 备份原文 ③ 用第 k 轮快照替换原文件
    await deps.fs.writeText(journal.backupPath, original, {
      mode: SNAPSHOT_FILE_MODE,
    });
    await deps.fs.writeText(input.sourcePath, snapshot);

    let forkError: unknown = null;
    let newClaudeSessionId = "";
    try {
      const out = await deps.runner.fork({
        args: ["--resume", input.claudeSessionId, "--fork-session"],
        cwd: input.cwd ?? "",
      });
      newClaudeSessionId = out?.newClaudeSessionId ?? "";
    } catch (err) {
      forkError = err;
    }

    // ⑤ 还原原文件（**任何一步失败都不许跳过**）⑥ 清 journal（还原成功才清）
    try {
      await deps.fs.writeText(input.sourcePath, original);
      await deps.fs.remove(journalPath(input.dataDir));
    } catch (err) {
      deps.log?.(`rewind: restore failed, journal kept: ${String(err)}`);
      return { ok: false, reason: "RESTORE_FAILED", error: String(err) };
    }
    if (forkError) {
      deps.log?.(`rewind: fork failed: ${String(forkError)}`);
      return { ok: false, reason: "FORK_FAILED", error: String(forkError) };
    }
    if (!newClaudeSessionId) {
      return {
        ok: false,
        reason: "FORK_FAILED",
        error: "分叉未返回新会话 id",
      };
    }
    return { ok: true, claudeSessionId: newClaudeSessionId };
  } finally {
    rewindBusy = false;
  }
}

/**
 * 启动时按 journal 还原（崩溃残留：进程死在被替换窗口里）。
 * 幂等：journal 清掉后第二次调用零动作；读不到备份/坏 JSON → 留 journal + 报错，绝不静默。
 */
export async function recoverPendingRewind(
  input: { dataDir: string },
  deps: RewindDeps,
): Promise<{ restored: boolean; error?: string }> {
  const jp = journalPath(input.dataDir);
  let raw: string | null;
  try {
    raw = await deps.fs.readText(jp);
  } catch (err) {
    return { restored: false, error: `journal 读失败：${String(err)}` };
  }
  if (raw === null) {
    return { restored: false };
  }
  let journal: Partial<RewindJournal>;
  try {
    journal = JSON.parse(raw) as Partial<RewindJournal>;
  } catch (err) {
    deps.log?.(`rewind: journal is not valid JSON, kept for triage`);
    return { restored: false, error: `journal 不是合法 JSON：${String(err)}` };
  }
  const originalPath = journal?.originalPath;
  const backup = journal?.backupPath;
  if (typeof originalPath !== "string" || typeof backup !== "string") {
    return { restored: false, error: "journal 字段不全，无法还原" };
  }
  let content: string | null;
  try {
    content = await deps.fs.readText(backup);
  } catch (err) {
    return { restored: false, error: `备份读失败：${String(err)}` };
  }
  if (content === null) {
    return {
      restored: false,
      error: "备份文件不存在，保留 journal 待人工处理",
    };
  }
  try {
    await deps.fs.writeText(originalPath, content, {
      mode: SNAPSHOT_FILE_MODE,
    });
    await deps.fs.remove(jp);
  } catch (err) {
    return { restored: false, error: `还原失败：${String(err)}` };
  }
  deps.log?.(`rewind: recovered pending rewind (${originalPath})`);
  return { restored: true };
}

// ---- 分支记录 ----

export interface BranchPlan {
  parentId: string;
  branchIndex: number;
  title: string;
}

/**
 * 分支会话命名/编号：序号按**同一父**内的 branchIndex 取 max+1（有洞不复用；别的父不占号；
 * 缺 branchIndex 的脏记录不参与编号）。标题用父会话的**当前**标题拼，父改名后新分支跟新名。
 */
export function planBranch(input: {
  parent: { id: string; title: string };
  sessions: Array<{
    id?: unknown;
    parentId?: unknown;
    branchIndex?: unknown;
  }>;
}): BranchPlan {
  let max = 0;
  for (const s of Array.isArray(input.sessions) ? input.sessions : []) {
    if (!s || s.parentId !== input.parent.id) {
      continue;
    }
    const idx = s.branchIndex;
    if (typeof idx === "number" && Number.isFinite(idx) && idx > max) {
      max = idx;
    }
  }
  const branchIndex = max + 1;
  return {
    parentId: input.parent.id,
    branchIndex,
    title: `${input.parent.title}-分支${branchIndex}`,
  };
}
