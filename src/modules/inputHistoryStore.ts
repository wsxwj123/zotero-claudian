// inputHistoryStore.ts — 输入框历史（↑/↓ 翻已发送消息）的**宿主侧**持久化（2026-09-11 需求）。
// 纯逻辑模块：文件系统经 SessionStoreFs 注入（Gecko 侧 IOUtils，见 modules/sections.ts），
// 不 import 任何 Zotero 全局 → node:test 直接跑。
//
// 为什么必须搬到宿主：本插件唯一的聊天页是 chrome:// 特权文档，**没有 localStorage**
// （2026-09-11 hist-harness 真机实测：win.localStorage 属性访问即抛 NS_ERROR_NOT_AVAILABLE，
// system principal 文档不挂存储）。页面侧那层 localStorage 兜底是死代码——面板一重载历史就没了。
// 宿主进程活得比面板久，且已有「唯一写盘方」的既有范式（sessionStore）。
//
// 文件：<插件数据目录>/input-history.json，形如
//   { "version": 1, "sessions": { "<sessionId>": ["第一条", "第二条"] } }
// 写策略：内存持唯一真相（首次用到时懒载入一次），整份文件全量重写；先写 .tmp 再 move（原子替换，
// 与 sessionStore 同手法）。**save 是并入而非替换**（多个面板实例/刚重载的页面各持一份本地副本，
// 替换会把别处发的条目抹掉）；**写盘节流**：连续发送走 coalesceMs（默认 500ms）合并窗口，窗口内的
// 多次 save 只落一次盘（写的是「窗口关闭那一刻」的最新状态）；flush() 绕过窗口立即落盘（插件停用/
// 测试同步点）。选宿主侧合并而非页面侧 debounce 的理由：页面的定时器会随面板重载一起死掉（丢最后一笔），
// 宿主不会。
//
// 信任边界（与 page 侧 lib/inputHistory.ts 同口径，只存字符串数组）：
// - 条目一律过「非空串 + 相邻去重 + 上限 50」归一，坏条目丢弃；
// - 坏文件（非 JSON / 结构不对）当空，**绝不因一份坏文件让聊天面板崩**；
// - 读失败（I/O 错误）≠ 空文件：保持未载入、拒绝后续写入（写是全量重写，会把未知内容整份覆盖——BUG-21b 同款教训）。
// 写失败（磁盘/权限）静默：输入历史是便利功能，不值得为它在桥协议上报错。

import { joinPath } from "../utils/paths";
import type { Platform } from "./cliDetect";
import type { SessionStoreFs } from "../utils/sessionStore";
// 归一 / 并入只有一份实现（页面 lib/inputHistory.ts）——宿主侧同款规则运行。两处各写一份曾在
// 「已存头部被 50 条上限挤掉 / 新来的是残份」时对齐错位（复查修-7），收口到一处。
import {
  mergeHistoryEntries,
  normalizeHistoryEntries,
} from "../chat/lib/inputHistory";

/** 落盘文件名（与 sessions.json 同目录：<profile>/claudian/） */
export const INPUT_HISTORY_FILE = "input-history.json";
/** 文件格式版本（未来迁移按 version 分叉） */
export const INPUT_HISTORY_FILE_VERSION = 1;
/** 写盘合并窗口：窗口内多次 save 只落一次盘 */
export const DEFAULT_COALESCE_MS = 500;

export {
  INPUT_HISTORY_LIMIT,
  mergeHistoryEntries,
  normalizeHistoryEntries,
} from "../chat/lib/inputHistory";

/**
 * 解析落盘文件：整体形态不对（非 JSON / 非对象 / 缺 sessions 对象）→ 空；
 * 单个会话桶坏（非数组）→ 丢该桶，其余照常。永不抛。
 */
export function parseInputHistoryFile(raw: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (
    typeof sessions !== "object" ||
    sessions === null ||
    Array.isArray(sessions)
  ) {
    return {};
  }
  // 无原型对象：磁盘上被改出 "__proto__" / "constructor" 这类键名也污染不到任何东西
  const out: Record<string, string[]> = Object.create(null);
  for (const [sid, value] of Object.entries(sessions)) {
    const entries = normalizeHistoryEntries(value);
    if (entries.length > 0) {
      out[sid] = entries; // 空桶不保留（读语义相同，文件更干净）
    }
  }
  return out;
}

export interface InputHistoryStoreDeps {
  /** 插件数据目录（Zotero.Profile.dir + /claudian/，宿主侧 PathUtils.join 拼好） */
  dataDir: string;
  /** 路径分隔符分叉（joinPath） */
  platform: Platform;
  fs: SessionStoreFs;
  log(message: string): void;
  /** 写盘合并窗口（ms）；测试注入小值，缺省 DEFAULT_COALESCE_MS */
  coalesceMs?: number;
}

export interface InputHistoryStore {
  /** 读该会话历史；未知会话/文件缺失/读失败 → []（永不抛） */
  get(sessionId: string): Promise<string[]>;
  /** 记录该会话历史（归一后落盘；失败静默，绝不抛）；空数组/空 id → 无动作 */
  save(sessionId: string, entries: unknown): Promise<void>;
  /** 立即落盘（不等合并窗口；插件停用与测试同步点） */
  flush(): Promise<void>;
}

export function createInputHistoryStore(
  deps: InputHistoryStoreDeps,
): InputHistoryStore {
  const filePath = (): string =>
    joinPath(deps.platform, deps.dataDir, INPUT_HISTORY_FILE);
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;

  /** 内存唯一真相；null = 尚未载入成功（此时一律拒绝写：全量重写会覆盖内容未知的文件） */
  let sessions: Record<string, string[]> | null = null;
  let loadPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  // 单一 writer 队列（与 sessionStore 同款）：写任务串行，防交错落盘
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load(): Promise<void> {
    try {
      await deps.fs.makeDir(deps.dataDir);
    } catch (err) {
      deps.log(`[inputHistory] makeDirectory failed: ${String(err)}`);
    }
    let raw: string | null;
    try {
      raw = await deps.fs.readText(filePath());
    } catch (err) {
      // 读失败 ≠ 首次运行：抛出去让本次调用失败（下次操作重试），写操作据此中止
      deps.log(
        `[inputHistory] read failed, stay unloaded (will retry): ${String(err)}`,
      );
      throw err;
    }
    sessions = raw === null ? Object.create(null) : parseInputHistoryFile(raw);
  }

  function ensureLoaded(): Promise<void> {
    loadPromise ??= enqueue(load).catch((err: unknown) => {
      loadPromise = null; // 允许下次重试
      throw err;
    });
    return loadPromise;
  }

  /** 队列内任务：把「此刻」的内存状态整份原子落盘 */
  async function writeFile(): Promise<void> {
    const data = JSON.stringify(
      { version: INPUT_HISTORY_FILE_VERSION, sessions: sessions ?? {} },
      null,
      2,
    );
    const path = filePath();
    await deps.fs.writeText(`${path}.tmp`, data);
    await deps.fs.move(`${path}.tmp`, path);
  }

  /** 立即写（有挂起变更才写）；失败只记日志——写盘是后台动作，绝不上抛 */
  function writeNow(): Promise<void> {
    if (dirty && sessions !== null) {
      dirty = false;
      return enqueue(writeFile).catch((err: unknown) => {
        deps.log(`[inputHistory] write failed: ${String(err)}`);
      });
    }
    return Promise.resolve();
  }

  function scheduleWrite(): void {
    dirty = true;
    if (timer !== null) {
      return; // 窗口已开：这次变更由窗口关闭时的那次写带上
    }
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, coalesceMs);
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await writeNow();
    await chain;
  }

  return {
    async get(sessionId: string): Promise<string[]> {
      try {
        await ensureLoaded();
      } catch (err) {
        deps.log(
          `[inputHistory] get: not loaded (${sessionId}): ${String(err)}`,
        );
        return [];
      }
      const entries = sessions?.[sessionId];
      return entries ? [...entries] : [];
    },

    async save(sessionId: string, entries: unknown): Promise<void> {
      if (!sessionId) {
        return;
      }
      const clean = normalizeHistoryEntries(entries);
      if (clean.length === 0) {
        return; // 空历史不值得写（新会话首次发送前不会走到这里）
      }
      try {
        await ensureLoaded();
      } catch (err) {
        deps.log(
          `[inputHistory] save: not loaded, skipped (${sessionId}): ${String(err)}`,
        );
        return;
      }
      if (sessions === null) {
        return;
      }
      // 并入而非替换：另一个面板实例/刚重载的页面递来的残份不该抹掉已存条目（见 mergeHistoryEntries）
      sessions[sessionId] = mergeHistoryEntries(
        sessions[sessionId] ?? [],
        clean,
      );
      scheduleWrite();
    },

    flush,
  };
}
