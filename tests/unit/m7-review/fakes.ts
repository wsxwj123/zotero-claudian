// 复核轮（m7-review）自写假件集合——供本目录测试使用。
// 独立性声明：全部按真机调用面自写，不复用被测方测试假件、也不复用其它轮次（m5-retest/m6-review）的假件；
// 特别不复用 tests/unit/helpers/*（该目录正被并行开发改动，复用会把别处口径引进来）。
import type {
  SessionStoreFs,
  SessionStore,
} from "../../../src/utils/sessionStore.ts";
import { createSessionStore } from "../../../src/utils/sessionStore.ts";
import type { HostBridgeDeps } from "../../../src/modules/hostBridge.ts";
import type { PermissionMode } from "../../../src/modules/cliRunner.ts";
import { saveNote, listNotes } from "../../../src/modules/notes.ts";

// ---------- 内存 fs（SessionStoreFs 的最小实现）----------

export class MemFs implements SessionStoreFs {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async readText(path: string): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async writeText(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async appendText(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  async move(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data !== undefined) {
      this.files.delete(from);
      this.files.set(to, data);
    }
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async makeDir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
}

// ---------- 假 Zotero（notes.ts / contextSource.ts 的调用面）----------

export interface FakeNoteItem {
  kind: "note";
  id: number;
  key: string;
  libraryID: number;
  parentItemID: number | null;
  dateModified: string;
  title: string;
  html: string;
  savedCount: number;
  setNoteCalls: string[];
  saveTxCalls: number;
  failSaveTx: Error | null;
  failSetNote: Error | null;
  getNotes(): number[];
  getNote(): string;
  setNote(h: string): void;
  saveTx(): Promise<void>;
  getNoteTitle(): string;
}

export interface FakeRegularItem {
  kind: "regular";
  id: number;
  key: string;
  libraryID: number;
  parentItem: { key: string } | null;
  children: number[];
  failGetNotes: Error | null;
  getNotes(): number[];
}

export interface FakeZoteroWorld {
  logs: string[];
  notes: FakeNoteItem[];
  zotero: Record<string, unknown>;
  item1: FakeRegularItem;
  item2: FakeRegularItem;
  addNote(opts: Partial<FakeNoteItem> & { parentItemID: number }): FakeNoteItem;
  addRegularItem(
    key: string,
    libraryID?: number,
    parentItem?: { key: string } | null,
  ): FakeRegularItem;
  unregister(id: number): void;
  restore(): void;
}

/**
 * 装一套假 Zotero 全局。世界形态：
 * - 库 1 有 ITEM1；库 2 有 ITEM2（验证「遍历全库找条目」）
 * - 新 note 由 `new Zotero.Item("note")` 创建，key 在 saveTx 时分配（真机同语义）
 * - Reader/Utilities 只提供 contextSource 用到的面；测试可按需覆盖
 */
export function installFakeZotero(): FakeZoteroWorld {
  const logs: string[] = [];
  const items = new Map<number, FakeNoteItem | FakeRegularItem>();
  const byKey = new Map<string, FakeNoteItem | FakeRegularItem>();
  const notes: FakeNoteItem[] = [];
  let nextId = 1;
  let nextKey = 1;
  let seq = 0;

  const register = (it: FakeNoteItem | FakeRegularItem): void => {
    items.set(it.id, it);
    byKey.set(`${it.libraryID}:${it.key}`, it);
  };

  function makeRegularItem(
    key: string,
    libraryID: number,
    parentItem: { key: string } | null = null,
  ): FakeRegularItem {
    const it: FakeRegularItem = {
      kind: "regular",
      id: nextId++,
      key,
      libraryID,
      parentItem,
      children: [],
      failGetNotes: null,
      getNotes() {
        if (it.failGetNotes) throw it.failGetNotes;
        return [...it.children];
      },
    };
    register(it);
    return it;
  }

  function makeNote(
    opts: Partial<FakeNoteItem> & { parentItemID: number },
  ): FakeNoteItem {
    const it = {
      kind: "note",
      id: nextId++,
      key: opts.key ?? `NOTE${nextKey++}`,
      libraryID: 1,
      dateModified: "2026-09-11 08:00:00",
      title: "",
      html: "",
      savedCount: 0,
      setNoteCalls: [],
      saveTxCalls: 0,
      failSaveTx: null,
      failSetNote: null,
      ...opts,
      getNotes: () => [],
      getNote(): string {
        return it.html;
      },
      setNote(h: string): void {
        it.setNoteCalls.push(h);
        if (it.failSetNote) throw it.failSetNote;
        it.html = h;
      },
      async saveTx(): Promise<void> {
        it.saveTxCalls++;
        if (it.failSaveTx) throw it.failSaveTx;
        it.savedCount++;
      },
      getNoteTitle(): string {
        return it.title;
      },
    } as unknown as FakeNoteItem;
    notes.push(it);
    register(it);
    return it;
  }

  const item1 = makeRegularItem("ITEM1", 1);
  const item2 = makeRegularItem("ITEM2", 2);

  class FakeItem {
    kind = "note";
    id = nextId++;
    key = "";
    libraryID = 0;
    parentItemID: number | null = null;
    dateModified = "2026-09-11 09:00:00";
    title = "";
    html = "";
    savedCount = 0;
    setNoteCalls: string[] = [];
    saveTxCalls = 0;
    failSaveTx: Error | null = null;
    failSetNote: Error | null = null;
    constructor(public type: string) {
      if (type !== "note") throw new Error(`fake 只支持 note，收到 ${type}`);
    }
    getNotes(): number[] {
      return [];
    }
    getNote(): string {
      return this.html;
    }
    setNote(h: string): void {
      this.setNoteCalls.push(h);
      if (this.failSetNote) throw this.failSetNote;
      this.html = h;
    }
    async saveTx(): Promise<void> {
      this.saveTxCalls++;
      if (this.failSaveTx) throw this.failSaveTx;
      if (!this.key) this.key = `NEW${++seq}`;
      this.savedCount++;
      const note = this as unknown as FakeNoteItem;
      notes.push(note);
      register(note);
    }
    getNoteTitle(): string {
      return this.title;
    }
  }

  const zotero: Record<string, unknown> = {
    Libraries: {
      getAll: () => [{ libraryID: 1 }, { libraryID: 2 }],
    },
    Items: {
      getByLibraryAndKey: (libraryID: number, key: string) =>
        byKey.get(`${libraryID}:${key}`) ?? null,
      get: (id: number) => items.get(id) ?? false,
    },
    Item: FakeItem,
    Date: {
      sqlToDate: (sql: string) =>
        sql ? new Date(sql.replace(" ", "T") + "Z") : false,
    },
    logError: (err: unknown) => {
      logs.push(String(err));
    },
  };

  const prev = (globalThis as { Zotero?: unknown }).Zotero;
  (globalThis as { Zotero?: unknown }).Zotero = zotero;

  return {
    logs,
    notes,
    zotero,
    item1,
    item2,
    addNote: makeNote,
    addRegularItem: makeRegularItem,
    unregister: (id: number) => {
      const it = items.get(id);
      if (it) {
        items.delete(id);
        byKey.delete(`${it.libraryID}:${it.key}`);
      }
    },
    restore: () => {
      if (prev === undefined) {
        delete (globalThis as { Zotero?: unknown }).Zotero;
      } else {
        (globalThis as { Zotero?: unknown }).Zotero = prev;
      }
    },
  };
}

/** 每个测试一个干净世界；测试结束还原全局 */
export function withWorld(
  fn: (w: FakeZoteroWorld) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const w = installFakeZotero();
    try {
      await fn(w);
    } finally {
      w.restore();
    }
  };
}

// ---------- 假 Zotero.Utilities（真机语义：text2html 会包 <p>，LEARNINGS 实证）----------

export function fakeHtmlSpecialChars(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 真机行为：块级转换，返回 `<p>转义文本</p>` */
export function fakeText2Html(s: string): string {
  return `<p>${fakeHtmlSpecialChars(s)}</p>`;
}

export function installFakeUtilities(
  world: FakeZoteroWorld,
  text2html: (s: string) => string = fakeText2Html,
): void {
  world.zotero.Utilities = {
    text2html,
    htmlSpecialChars: fakeHtmlSpecialChars,
  };
}

// ---------- 极简 DOM 假件（contextSource 弹窗按钮用到的面）----------

export class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  private text = "";
  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(public tagName: string) {}

  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** 合成事件派发（测试触发按钮点击用） */
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  append(...nodes: (FakeEl | string)[]): void {
    for (const n of nodes) {
      if (typeof n === "string") this.text += n;
      else this.children.push(n);
    }
  }

  replaceChildren(...nodes: (FakeEl | string)[]): void {
    this.children = [];
    this.text = "";
    this.append(...nodes);
  }

  /** 深度优先找第一个满足条件的元素 */
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    for (const c of this.children) {
      if (pred(c)) return c;
      const deeper = c.find(pred);
      if (deeper) return deeper;
    }
    return null;
  }

  /** 全部后代文本（断言提示文案用） */
  get deepText(): string {
    return this.textContent;
  }
}

export function makeFakeDoc(): { createElement(tag: string): FakeEl } {
  return { createElement: (tag: string) => new FakeEl(tag) };
}

// ---------- 假宿主桥接（hostBridge deps 最小实现）----------

export interface BridgeHarness {
  deps: HostBridgeDeps;
  sent: { win: object; msg: { type: string; [k: string]: unknown } }[];
  logs: string[];
  store: SessionStore;
  lastOf(type: string): { type: string; [k: string]: unknown } | undefined;
}

export function makeBridgeHarness(
  world: FakeZoteroWorld,
  overrides: Partial<HostBridgeDeps> = {},
): BridgeHarness {
  const sent: BridgeHarness["sent"] = [];
  const logs: string[] = [];
  const fs = new MemFs();
  const store = createSessionStore({
    dataDir: "/data/claudian",
    platform: "darwin",
    fs,
    log: () => {},
    now: () => 1_700_000_000_000,
    defaultPermissionMode: () => "acceptEdits" as PermissionMode,
  });
  const deps: HostBridgeDeps = {
    post: (win, msg) => sent.push({ win, msg: msg as never }),
    createChannel: () => null,
    log: (m) => logs.push(m),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string) => ({
      itemKey: "ITEM1",
      attachmentKey: null,
      prompt: text,
      addDir: null,
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 52000, token: "tok" }),
    getDefaultPermissionMode: () => "acceptEdits" as PermissionMode,
    spawnTurn: () => ({ kill: () => {}, exitPromise: Promise.resolve() }),
    buildReaderContext: async () => null,
    sessions: store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "一篇论文" } : null,
    // 真 notes 模块（经假 Zotero 写库）——本文件的核心：桥→写库口的真实链路
    notes: { saveNote, listNotes },
    ...overrides,
  };
  return {
    deps,
    sent,
    logs,
    store,
    lastOf: (type) =>
      [...sent].reverse().find((s) => s.msg.type === type)?.msg as never,
  };
}

/** 让挂起的 microtask 全部跑完 */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
