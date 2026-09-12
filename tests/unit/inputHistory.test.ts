// 单测 — 输入框历史导航（用户需求：方向键 ↑/↓ 翻已发送消息，含「当前没发送的草稿」）。
// 分层：状态机/键判据/存储适配都是纯函数（src/chat/lib/inputHistory.ts），
// DOM 只负责取 value、取光标、写回（App.ts InputBox 的 onKeyDown，见文件尾的接线契约）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHistoryKey,
  caretOnFirstLine,
  caretOnLastLine,
  defaultHistoryStorage,
  emptyInputHistory,
  historyForSession,
  historyNavKey,
  historyNext,
  historyPrev,
  historyStorageKey,
  INPUT_HISTORY_LIMIT,
  INPUT_HISTORY_PREFIX,
  loadInputHistory,
  parseInputHistory,
  recordSent,
  saveInputHistory,
  type HistoryKeyEvent,
  type InputHistory,
} from "../../src/chat/lib/inputHistory.ts";

/** 键盘事件最小形态（只取判据用到的字段，默认「无修饰键、非 IME、无选区」） */
function key(k: string, extra: Partial<HistoryKeyEvent> = {}): HistoryKeyEvent {
  return {
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...extra,
  };
}

/** 光标收起在 pos（textarea 无选区时的形态） */
function at(pos: number): { start: number; end: number } {
  return { start: pos, end: pos };
}

/** 按若干条消息造历史（等价于连发这些消息） */
function withSent(...texts: string[]): InputHistory {
  return texts.reduce<InputHistory>(
    (h, t) => recordSent(h, t),
    emptyInputHistory(),
  );
}

/** 假存储：只记一个键值对 */
function fakeStorage(init: Record<string, string> = {}): {
  map: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
} {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

// ---- 记录（发出消息入历史）----

test("记录：发出的原文进历史（最新在末尾），游标复位为「非历史态」", () => {
  let h = withSent("第一条", "第二条");
  assert.deepEqual(h.entries, ["第一条", "第二条"]);
  assert.equal(h.cursor, null);
  // 翻进历史后发消息 → 游标必须复位（否则下一条显示的还是历史里那条）
  const moved = historyPrev(h, "草稿");
  assert.ok(moved);
  h = recordSent(moved.history, "第三条");
  assert.equal(h.cursor, null);
  assert.equal(h.draft, "");
  assert.deepEqual(h.entries, ["第一条", "第二条", "第三条"]);
});

test("记录：空串/纯空白不入历史", () => {
  const h = recordSent(emptyInputHistory(), "");
  assert.deepEqual(h.entries, []);
  assert.deepEqual(recordSent(emptyInputHistory(), "   ").entries, []);
});

test("记录：相邻重复只留一份（shell 同款），隔一条的重复照常保留", () => {
  assert.deepEqual(withSent("a", "a", "a").entries, ["a"]);
  assert.deepEqual(withSent("a", "b", "a").entries, ["a", "b", "a"]);
});

test("记录：带前后空白存原文（trim 判定只用于「是否为空」）", () => {
  const h = withSent("  缩进的问题  ");
  assert.deepEqual(h.entries, ["  缩进的问题  "]);
  const moved = historyPrev(h, "");
  assert.equal(moved?.text, "  缩进的问题  ");
});

test(`记录：上限 ${INPUT_HISTORY_LIMIT} 条，超出丢最老`, () => {
  const many: string[] = [];
  for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i++) {
    many.push(`第 ${i} 条`);
  }
  const h = withSent(...many);
  assert.equal(h.entries.length, INPUT_HISTORY_LIMIT);
  assert.equal(h.entries[0], "第 5 条");
  assert.equal(
    h.entries[INPUT_HISTORY_LIMIT - 1],
    `第 ${INPUT_HISTORY_LIMIT + 4} 条`,
  );
});

// ---- ↑/↓ 导航 ----

test("↑：空历史无动作；有历史时切到最新一条，并把当前草稿先存起来", () => {
  assert.equal(historyPrev(emptyInputHistory(), "草稿"), null);
  const r = historyPrev(withSent("A", "B"), "没发出去的草稿");
  assert.ok(r);
  assert.equal(r.text, "B");
  assert.equal(r.history.cursor, 1);
  assert.equal(r.history.draft, "没发出去的草稿");
});

test("↑：连续往上翻；到最老一条停住（不循环）", () => {
  const cur = withSent("A", "B", "C");
  const first = historyPrev(cur, "");
  assert.ok(first);
  assert.equal(first.text, "C");
  const second = historyPrev(first.history, "C");
  assert.ok(second);
  assert.equal(second.text, "B");
  assert.equal(
    second.history.draft,
    "",
    "草稿只在进入历史的第一下存一次，不被历史文本覆盖",
  );
  const third = historyPrev(second.history, "B");
  assert.ok(third);
  assert.equal(third.text, "A");
  assert.equal(third.history.cursor, 0);
  assert.equal(
    historyPrev(third.history, "A"),
    null,
    "停在最老一条，不回到最新",
  );
});

test("↓：往下回翻，翻到底部还原进入历史前的草稿（当时为空则回空）", () => {
  const cur = withSent("A", "B");
  const draft = "用户正在写的草稿";
  const up1 = historyPrev(cur, draft);
  assert.ok(up1);
  const up2 = historyPrev(up1.history, "B");
  assert.ok(up2);
  assert.equal(up2.text, "A");
  const back1 = historyNext(up2.history); // ← 从最老开始 ↓
  assert.ok(back1);
  assert.equal(back1.text, "B");
  const back2 = historyNext(back1.history); // ← 到底部：还原草稿
  assert.ok(back2);
  assert.equal(back2.text, draft);
  assert.equal(back2.history.cursor, null, "退出历史态");
  assert.equal(historyNext(back2.history), null, "非历史态的 ↓ 无事可做");
});

test("↓：进入历史时输入框为空 → 翻回底部回空串（不是上一格的历史文本）", () => {
  const up = historyPrev(withSent("A"), "");
  assert.ok(up);
  const down = historyNext(up.history);
  assert.ok(down);
  assert.equal(down.text, "");
});

test("↑↓ 往返：同一格来回翻，草稿始终是进入历史前那份", () => {
  const draft = "  mid-draft  ";
  let h = withSent("A", "B", "C");
  const up = historyPrev(h, draft);
  assert.ok(up);
  h = up.history;
  assert.equal(up.text, "C");
  const down = historyNext(h); // 从最新一条 ↓ 直接出历史
  assert.ok(down);
  assert.equal(down.text, draft);
  const upAgain = historyPrev(down.history, down.text);
  assert.ok(upAgain);
  assert.equal(upAgain.text, "C");
  assert.equal(upAgain.history.draft, draft);
});

test("回归：发出历史里的那条消息后，游标复位且不产生重复条目", () => {
  let h = withSent("A", "B");
  const up = historyPrev(h, "");
  assert.ok(up);
  assert.equal(up.text, "B");
  h = recordSent(up.history, up.text); // 直接回车重发翻出来的那条
  assert.deepEqual(h.entries, ["A", "B"], "相邻重复只留一份");
  assert.equal(h.cursor, null);
  assert.equal(h.draft, "", "暂存草稿随发送作废（它已不是当前输入）");
});

// ---- 键判据（首行/末行、IME、修饰键）----

test("键判据：单行文本里 ↑/↓ 都能翻（它既是首行也是末行）", () => {
  assert.equal(historyNavKey(key("ArrowUp"), "abc", at(3)), "prev");
  assert.equal(historyNavKey(key("ArrowDown"), "abc", at(0)), "next");
});

test("键判据：多行文本光标不在首/末行 → 不劫持（交给行间移动）", () => {
  const text = "第一行\n第二行\n第三行";
  assert.equal(caretOnFirstLine(text, 0), true);
  assert.equal(
    caretOnFirstLine(text, 5),
    false,
    "光标在第二行开头（前面有换行）",
  );
  assert.equal(historyNavKey(key("ArrowUp"), text, at(5)), null);
  assert.equal(caretOnLastLine(text, text.length), true);
  assert.equal(caretOnLastLine(text, 5), false);
  assert.equal(historyNavKey(key("ArrowDown"), text, at(5)), null);
});

test("键判据：多行文本光标在首行 ↑、末行 ↓ → 翻历史", () => {
  const text = "第一行\n第二行";
  assert.equal(historyNavKey(key("ArrowUp"), text, at(2)), "prev");
  assert.equal(historyNavKey(key("ArrowDown"), text, at(text.length)), "next");
});

test("键判据：IME 候选态（isComposing / keyCode 229）→ 不劫持（↑↓ 是选候选词）", () => {
  assert.equal(
    historyNavKey(key("ArrowUp", { isComposing: true }), "拼音", at(2)),
    null,
  );
  assert.equal(
    historyNavKey(key("ArrowDown", { keyCode: 229 }), "拼音", at(2)),
    null,
  );
});

test("键判据：带修饰键（Shift 选区 / Cmd 文首 / Alt、Ctrl）→ 不劫持", () => {
  for (const m of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
    assert.equal(
      historyNavKey(key("ArrowUp", { [m]: true }), "abc", at(1)),
      null,
      `${m} + ↑ 不该翻历史`,
    );
  }
});

test("键判据：有选区 → 不劫持（默认行为是折叠光标，抢过来会吞掉选中文本）", () => {
  assert.equal(
    historyNavKey(key("ArrowUp"), "abc", { start: 1, end: 3 }),
    null,
  );
});

test("键判据：非方向键（含 Enter 换行、字母）一律放行", () => {
  assert.equal(historyNavKey(key("Enter"), "abc", at(1)), null);
  assert.equal(historyNavKey(key("a"), "abc", at(1)), null);
  assert.equal(historyNavKey(key("Process"), "", at(0)), null);
});

// ---- 接线契约：App.ts 的 onKeyDown 就调 applyHistoryKey（判定 + 迁移一体）----

test("接线：applyHistoryKey 一次调用即完成「↑ 翻上一条 + 存草稿」", () => {
  const move = applyHistoryKey(
    key("ArrowUp"),
    "正在写的草稿",
    at(6),
    withSent("A", "B"),
  );
  assert.ok(move);
  assert.equal(move.text, "B");
  assert.equal(move.history.draft, "正在写的草稿");
});

test("接线：光标不在首/末行、IME 候选态、带修饰键、有选区 → 返回 null（不劫持）", () => {
  const text = "第一行\n第二行";
  assert.equal(
    applyHistoryKey(key("ArrowUp"), text, at(5), withSent("A")),
    null,
  );
  assert.equal(
    applyHistoryKey(
      key("ArrowDown", { isComposing: true }),
      text,
      at(5),
      withSent("A"),
    ),
    null,
  );
  assert.equal(
    applyHistoryKey(
      key("ArrowUp", { shiftKey: true }),
      "x",
      at(1),
      withSent("A"),
    ),
    null,
  );
  assert.equal(
    applyHistoryKey(key("ArrowUp"), "abc", { start: 0, end: 1 }, withSent("A")),
    null,
  );
});

test("接线：空历史 ↑ / 非历史态 ↓ → null（不 preventDefault，光标行为照旧）", () => {
  assert.equal(
    applyHistoryKey(key("ArrowUp"), "", at(0), emptyInputHistory()),
    null,
  );
  assert.equal(
    applyHistoryKey(key("ArrowDown"), "草稿", at(2), withSent("A", "B")),
    null,
  );
});

test("接线：↑↑↓↓ 一整轮——翻上两条再翻回，草稿原样还回来", () => {
  const draft = "问题写到一半";
  let h = withSent("A", "B", "C");
  const up1 = applyHistoryKey(key("ArrowUp"), draft, at(draft.length), h);
  assert.ok(up1);
  assert.equal(up1.text, "C");
  h = up1.history;
  const up2 = applyHistoryKey(key("ArrowUp"), up1.text, at(up1.text.length), h);
  assert.ok(up2);
  assert.equal(up2.text, "B");
  h = up2.history;
  const down1 = applyHistoryKey(key("ArrowDown"), up2.text, at(1), h);
  assert.ok(down1);
  assert.equal(down1.text, "C");
  h = down1.history;
  const down2 = applyHistoryKey(key("ArrowDown"), down1.text, at(1), h);
  assert.ok(down2);
  assert.equal(down2.text, draft, "翻回底部还原进入历史前的草稿");
  h = down2.history;
  const again = applyHistoryKey(key("ArrowUp"), draft, at(draft.length), h);
  assert.ok(again);
  assert.equal(again.text, "C", "再 ↑ 又从最新一条开始");
});

// ---- 会话隔离 + 持久化 ----

test("会话隔离：存储键按 sessionId 分桶（未绑定会话走独立桶）", () => {
  assert.equal(historyStorageKey("S1"), `${INPUT_HISTORY_PREFIX}S1`);
  assert.notEqual(historyStorageKey("S1"), historyStorageKey("S2"));
  assert.equal(historyStorageKey(null), `${INPUT_HISTORY_PREFIX}none`);
  assert.ok(historyStorageKey("S1").startsWith("zotero-claudian."));
});

test("会话隔离：A 会话的历史读不到 B 会话里（不跨文献串历史）", () => {
  const st = fakeStorage();
  saveInputHistory("A", withSent("A 的提问"), st);
  saveInputHistory("B", withSent("B 的提问"), st);
  assert.deepEqual(loadInputHistory("A", st).entries, ["A 的提问"]);
  assert.deepEqual(loadInputHistory("B", st).entries, ["B 的提问"]);
  assert.deepEqual(loadInputHistory("C", st).entries, []);
});

test("会话隔离：换会话即换桶——游标复位到非历史态，草稿不跟着串", () => {
  const st = fakeStorage();
  saveInputHistory("A", withSent("A1", "A2"), st);
  saveInputHistory("B", withSent("B1"), st);
  const a = historyForSession(null, "A", st);
  const up = historyPrev(a.h, "写了一半");
  assert.ok(up);
  const inHistory = { sid: "A", h: up.history };
  assert.equal(inHistory.h.cursor, 1);
  // 同一个会话：原样返回（渲染期反复调用不重读存储、不丢游标）
  assert.equal(historyForSession(inHistory, "A", st), inHistory);
  // 换会话：换桶 + 游标复位
  const switched = historyForSession(inHistory, "B", st);
  assert.equal(switched.h.cursor, null);
  assert.equal(switched.h.draft, "");
  assert.deepEqual(switched.h.entries, ["B1"]);
});

test("持久化：落盘只存 entries，读回来游标是非历史态", () => {
  const st = fakeStorage();
  const up = historyPrev(withSent("A", "B"), "草稿");
  assert.ok(up);
  saveInputHistory("S1", up.history, st);
  const back = loadInputHistory("S1", st);
  assert.deepEqual(back.entries, ["A", "B"]);
  assert.equal(back.cursor, null);
  assert.equal(back.draft, "");
  assert.equal(
    st.map.get(historyStorageKey("S1")),
    JSON.stringify(["A", "B"]),
    "落盘形态是字符串数组（可直接肉眼核对）",
  );
});

test("持久化：坏数据（非 JSON / 非数组 / 混入非字符串）只取合法条目，不抛", () => {
  assert.deepEqual(parseInputHistory(null).entries, []);
  assert.deepEqual(parseInputHistory("{不是 JSON").entries, []);
  assert.deepEqual(parseInputHistory('{"a":1}').entries, []);
  assert.deepEqual(
    parseInputHistory('["好的", 42, null, "另一条", "  "]').entries,
    ["好的", "另一条"],
  );
  assert.deepEqual(
    parseInputHistory('["dup","dup","x"]').entries,
    ["dup", "x"],
    "落盘数据也走去重口径",
  );
});

test("持久化：超限数据读回时截到上限（丢最老）", () => {
  const raw = JSON.stringify(
    Array.from({ length: INPUT_HISTORY_LIMIT + 3 }, (_, i) => `m${i}`),
  );
  const h = parseInputHistory(raw);
  assert.equal(h.entries.length, INPUT_HISTORY_LIMIT);
  assert.equal(h.entries[0], "m3");
});

test("持久化：写入失败（隐私模式/配额满）静默降级——不抛，历史仍在内存里可翻", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.doesNotThrow(() => saveInputHistory("S1", withSent("A"), throwing));
  assert.deepEqual(loadInputHistory("S1", throwing).entries, []);
  // 内存态照常可翻（组件侧持有的那桶不受存储失败影响）
  const h = recordSent(emptyInputHistory(), "A");
  const up = historyPrev(h, "");
  assert.equal(up?.text, "A");
});

test("持久化：localStorage 不存在/被禁时为 null（调用方降级为内存历史）", () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  try {
    delete g.localStorage;
    assert.equal(defaultHistoryStorage(), null);
    assert.deepEqual(loadInputHistory("S1"), emptyInputHistory());
    assert.doesNotThrow(() => saveInputHistory("S1", emptyInputHistory()));
  } finally {
    if (saved !== undefined) {
      g.localStorage = saved;
    }
  }
});
