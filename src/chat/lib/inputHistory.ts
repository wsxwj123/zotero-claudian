// 输入框历史导航（shell 风格 ↑/↓ 翻已发送消息）——纯状态机 + 存储适配层。
// DOM 只在 App.ts 的 InputBox 里接线（读光标、取/设 value），本文件 node:test 直接可测。
//
// 为什么按会话分桶存：不同会话常是不同文献/不同话题的提问，共享一份历史会把 A 文献的问题
// 翻进 B 文献的会话里（答非所问，且用户按 ↑ 时并不知道自己将要发的是什么）。
// 分桶是唯一不串的存法，故历史的存储键、内存态、游标都带 sessionId。
//
// 持久化（2026-09-11 需求：宿主持久化，面板重载/重启后仍在）：**页面侧不再摸 localStorage**。
// 本插件唯一的聊天页是 chrome://claudian/content/chat/index.html，chrome 特权文档**没有** localStorage
// （2026-09-11 hist-harness 真机实测：win.localStorage 属性访问即抛 NS_ERROR_NOT_AVAILABLE，
// system principal 文档不挂存储）——旧实现那层 localStorage 兜底是死代码，面板一重载历史就丢。
// 现在的存储层 = 内存 + 桥：写走 `saveInputHistory`（宿主落盘 <profile>/claudian/input-history.json，
// 见 modules/inputHistoryStore.ts），载入走宿主回推的 `inputHistory` 消息（main.ts 在会话桶首次加载时
// 发 getInputHistory 请求）→ 归约进 ChatState → InputBox 用 mergeHostEntries 并入本会话桶。
// 桥未接线/写失败一律静默降级为内存历史、绝不抛：翻历史是便利功能，不值得为它在输入法路径上炸掉输入框。

import type { UiMessage } from "./types";

/** 历史条数上限：超出丢最老（防存储无限膨胀，也防游标翻到手酸） */
export const INPUT_HISTORY_LIMIT = 50;

/** 存储键前缀（插件专属，避免与页面同源其它键打架） */
export const INPUT_HISTORY_PREFIX = "zotero-claudian.input-history.";

export interface InputHistory {
  /** 已发送原文（旧 → 新），相邻重复只留一份 */
  entries: string[];
  /** null = 非历史态（正在编辑自己的草稿）；数字 = 当前显示的 entries 下标 */
  cursor: number | null;
  /** 进入历史前暂存的未发送草稿（cursor === null 时无意义）；翻回底部时回填 */
  draft: string;
}

export function emptyInputHistory(): InputHistory {
  return { entries: [], cursor: null, draft: "" };
}

/** 一次翻页的结果：新状态 + 要回填进输入框的原文 */
export interface HistoryMove {
  history: InputHistory;
  text: string;
}

/**
 * 发出一条消息后记入历史（最新在末尾），游标复位到非历史态、暂存草稿作废。
 * - 空/纯空白不入历史（发送路径本就拦了，这里再拦一次防其它调用方塞脏数据）；
 * - **相邻重复只留一份**（shell 同款）：连发两条同样的消息不该占两格；
 * - 存原文（含前后空白），取用时按原样回填——用户敲了什么就还回什么。
 */
export function recordSent(h: InputHistory, text: string): InputHistory {
  const base: InputHistory = { entries: h.entries, cursor: null, draft: "" };
  if (!text.trim()) {
    return base;
  }
  const entries =
    h.entries[h.entries.length - 1] === text
      ? h.entries
      : [...h.entries, text].slice(-INPUT_HISTORY_LIMIT);
  return { ...base, entries };
}

/**
 * ↑：切到上一条已发送消息。返回 null = 无动作（没有历史，或已停在最老一条——不循环）。
 * 进入历史的第一下先把当前草稿存起来（这就是「包括当前输入没发送的」）。
 */
export function historyPrev(
  h: InputHistory,
  currentText: string,
): HistoryMove | null {
  if (h.cursor === null) {
    if (h.entries.length === 0) {
      return null;
    }
    const cursor = h.entries.length - 1;
    return {
      history: { ...h, cursor, draft: currentText },
      text: h.entries[cursor],
    };
  }
  if (h.cursor === 0) {
    return null;
  }
  const cursor = h.cursor - 1;
  return { history: { ...h, cursor }, text: h.entries[cursor] };
}

/**
 * ↓：切到下一条已发送消息；已是最新一条时退出历史态，**还原进入历史前的未发送草稿**
 * （当时输入框为空就回空）。返回 null = 无动作（非历史态的 ↓：草稿本就在输入框里，无事可做）。
 */
export function historyNext(h: InputHistory): HistoryMove | null {
  if (h.cursor === null) {
    return null;
  }
  if (h.cursor >= h.entries.length - 1) {
    return { history: { ...h, cursor: null, draft: "" }, text: h.draft };
  }
  const cursor = h.cursor + 1;
  return { history: { ...h, cursor }, text: h.entries[cursor] };
}

// ---- 键盘判据（DOM 事件只取用到的字段；node 单测传普通对象即可）----

/** ↑/↓ 键盘事件的最小形态 */
export interface HistoryKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** IME 候选态：↑/↓ 此时是「选候选词」，不是翻历史 */
  isComposing: boolean;
  /** 老式 IME 信号：229 = 本键已被输入法消费 */
  keyCode: number;
}

/** 输入框光标区间（textarea 的 selectionStart/selectionEnd） */
export interface CaretSpan {
  start: number;
  end: number;
}

/** 光标是否在首行（它前面没有换行） */
export function caretOnFirstLine(text: string, pos: number): boolean {
  return text.lastIndexOf("\n", pos - 1) === -1;
}

/** 光标是否在末行（它后面没有换行） */
export function caretOnLastLine(text: string, pos: number): boolean {
  return text.indexOf("\n", pos) === -1;
}

/**
 * 这次方向键该不该翻历史。返回 null = 交给浏览器默认行为。
 * 拦截条件（任一条不满足就放行，宁可少翻一次也不要抢用户的光标）：
 * - 无修饰键：Shift+↑ 是选区、Cmd+↑ 是「跳到文首」、Alt/Ctrl+↑ 各平台另有含义；
 * - 无选区：有选区时默认行为是折叠光标，抢过来会顺手吞掉用户选中的文本；
 * - 非 IME 候选态（isComposing / keyCode 229）：候选框里 ↑/↓ 是选词，命中就是灾难；
 * - 光标在首行（↑）/ 末行（↓）：多行文本且光标在中间时，默认行为是行间移动，必须让路。
 */
export function historyNavKey(
  e: HistoryKeyEvent,
  text: string,
  caret: CaretSpan,
): "prev" | "next" | null {
  if (e.isComposing || e.keyCode === 229) {
    return null;
  }
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
    return null;
  }
  if (caret.start !== caret.end) {
    return null;
  }
  if (e.key === "ArrowUp") {
    return caretOnFirstLine(text, caret.start) ? "prev" : null;
  }
  if (e.key === "ArrowDown") {
    return caretOnLastLine(text, caret.start) ? "next" : null;
  }
  return null;
}

/** 一次方向键的完整结果（新状态 + 要回填的原文） */
export type HistoryKeyResult = HistoryMove;

/**
 * 一次 ↑/↓ 的完整处理：判定该不该翻 + 迁移状态（App.ts 的 onKeyDown 就调这一个函数，
 * DOM 侧只剩「取 value/光标 → 调它 → 写回」三件事，行为全在这里，单测即锁接线）。
 * 返回 null = 不处理，放给浏览器默认行为。
 */
export function applyHistoryKey(
  e: HistoryKeyEvent,
  text: string,
  caret: CaretSpan,
  h: InputHistory,
): HistoryKeyResult | null {
  const nav = historyNavKey(e, text, caret);
  if (nav === null) {
    return null;
  }
  return nav === "prev" ? historyPrev(h, text) : historyNext(h);
}

// ---- 存储（宿主持久化，经桥；未接线/写失败 → 内存历史）----

/** 存储适配面（只用到 get/set；node 单测传假实现，浏览器默认取注入的桥存储） */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 该会话的历史存储键；未绑定会话（sessionId=null）走独立的 none 桶 */
export function historyStorageKey(sessionId: string | null): string {
  return `${INPUT_HISTORY_PREFIX}${sessionId ?? "none"}`;
}

/** 页面侧默认存储（main.ts 装配桥存储后注入；未注入 → null → 纯内存历史） */
let defaultStorage: HistoryStorage | null = null;

/**
 * 装配页面侧存储（main.ts 在挂载 App 前调用一次）。
 * 为什么是注入而不是自己去找 localStorage：chrome 特权文档拿不到 localStorage（文件头实测），
 * 而桥存储需要 bridge 实例——它由 main.ts 组装，本模块（纯逻辑，node 可测）不该反向依赖它。
 */
export function setDefaultHistoryStorage(storage: HistoryStorage | null): void {
  defaultStorage = storage;
}

/** 当前页面侧存储；null = 无存储（调用方降级为纯内存历史） */
export function defaultHistoryStorage(): HistoryStorage | null {
  return defaultStorage;
}

/**
 * 桥存储（页面侧）：写经桥交给宿主落盘（宿主 500ms 合并后才写盘），读只回本页面已知的。
 * getItem 返回 null 只表示「本页面还不知道」，**不是「无历史」**——本会话的历史由宿主经
 * `inputHistory` 消息推来，InputBox 用 mergeHostEntries 并入桶（那才是载入路径）。
 * 未绑定会话（none 桶）不发消息：宿主侧无会话可归，且绑定会话后本就要换桶（与旧形态的
 * 可见行为一致：none 桶的内容在绑定会话后照样翻不到）。
 */
export function createBridgeHistoryStorage(
  send: (msg: UiMessage) => void,
): HistoryStorage {
  const cache = new Map<string, string>();
  return {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      cache.set(key, value);
      if (!key.startsWith(INPUT_HISTORY_PREFIX)) {
        return; // 非本模块的键（防御：调用方只该用 historyStorageKey 拼键）
      }
      const sid = key.slice(INPUT_HISTORY_PREFIX.length);
      if (!sid || sid === "none") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return; // 坏值只留在内存缓存里，不往桥上递
      }
      send({
        type: "saveInputHistory",
        sessionId: sid,
        entries: normalizeHistoryEntries(parsed),
      });
    },
  };
}

/**
 * 解析落盘内容：坏数据（非 JSON / 非字符串数组 / 混入非字符串）一律只取合法条目，整份坏就空历史
 */
export function parseInputHistory(raw: string | null): InputHistory {
  if (raw === null) {
    return emptyInputHistory();
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyInputHistory();
  }
  return {
    entries: normalizeHistoryEntries(data),
    cursor: null,
    draft: "",
  };
}

/**
 * 条目归一（parseInputHistory / mergeHostEntries 共用）：只留非空字符串、相邻重复只留一份、
 * 超出丢最老——与 recordSent（发送路径）同一套规则，两条路径不会给出不同口径的历史。
 */
export function normalizeHistoryEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !x.trim()) {
      continue;
    }
    if (entries[entries.length - 1] === x) {
      continue; // 落盘数据被外部改坏时，保持与 recordSent 同一份去重口径
    }
    entries.push(x);
  }
  return entries.slice(-INPUT_HISTORY_LIMIT);
}

/** 载入该会话的历史（游标恒为非历史态；缺失/坏数据 → 空历史） */
export function loadInputHistory(
  sessionId: string | null,
  storage: HistoryStorage | null = defaultHistoryStorage(),
): InputHistory {
  if (!storage) {
    return emptyInputHistory();
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(historyStorageKey(sessionId));
  } catch {
    return emptyInputHistory();
  }
  return parseInputHistory(raw);
}

/** 落盘该会话的历史（只存 entries——游标/暂存草稿是一次导航的中间态，不值得持久化）。失败静默 */
export function saveInputHistory(
  sessionId: string | null,
  h: InputHistory,
  storage: HistoryStorage | null = defaultHistoryStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(historyStorageKey(sessionId), JSON.stringify(h.entries));
  } catch {
    // 写失败（桥未接线/宿主写盘失败）：本次会话内照常可翻（内存态在组件侧），重载后从头开始
  }
}

/** 组件持有的一桶历史：与它绑定的会话 id（换会话即换桶） */
export interface HistoryBucket {
  sid: string | null;
  h: InputHistory;
}

/**
 * 会话隔离的载入点：sessionId 没变就原样返回在途实例（渲染期反复调用不会重读存储），
 * 变了（含首次挂载）就换桶重新载入——把 cursor 从旧会话的游标复位到非历史态。
 */
export function historyForSession(
  current: HistoryBucket | null,
  sessionId: string | null,
  storage: HistoryStorage | null = defaultHistoryStorage(),
): HistoryBucket {
  if (current && current.sid === sessionId) {
    return current;
  }
  return { sid: sessionId, h: loadInputHistory(sessionId, storage) };
}

/**
 * 宿主到达的历史并入本地桶——**面板重载后 ↑ 还能翻到旧消息的唯一路径**（写入由 recordSent 走
 * saveInputHistory 经桥交给宿主；载入则只有这一条）。
 * - 正在翻历史（cursor 非空）→ 原样返回：用户正看着某条，晚到的宿主快照只会把视图拽走；
 * - 否则按「宿主是本地前缀」对齐后拼接：本地通常是「宿主那份 + 本页面新发的几条」（重载后历史
 *   未到就先发了消息），直接 concat 会把重复段留成两遍，故先跳过与宿主逐条相同的本地前缀；
 * - 拼接结果再走同一套归一（相邻去重 + 上限 50），重复并入幂等（内容不变则返回原对象）。
 */
export function mergeHostEntries(
  current: HistoryBucket,
  entries: unknown,
): HistoryBucket {
  if (current.h.cursor !== null) {
    return current;
  }
  const host = normalizeHistoryEntries(entries);
  if (host.length === 0) {
    return current; // 宿主没这份历史（或形态坏）：本地照旧
  }
  const local = current.h.entries;
  let i = 0;
  while (i < local.length && i < host.length && local[i] === host[i]) {
    i++;
  }
  const merged = normalizeHistoryEntries([...host, ...local.slice(i)]);
  if (
    merged.length === local.length &&
    merged.every((x, j) => x === local[j])
  ) {
    return current; // 已经是并过的（渲染期反复调用不换对象）
  }
  return { sid: current.sid, h: { ...current.h, entries: merged } };
}
