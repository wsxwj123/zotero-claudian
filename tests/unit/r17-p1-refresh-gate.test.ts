// 单测 — R17 / P1：`needsSessionListRefresh` 纯函数（页面侧回填闸门）
//
// 契约来源：.devflow/INTERFACE-R17.md §1.4——「readerContext.itemKey 非空 + 本地 sessions 里
// 没有任何该 itemKey 的会话 + 该 itemKey 尚未请求过 ⇒ 返回该 itemKey（发一次 getState）」，
// 每个 itemKey 最多一次。其余情况一律返回 null。
// 单独成文件：该导出在修复前不存在，import 失败不应盖住其它用例的红绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  needsSessionListRefresh,
  reduceHostMessage,
  type ChatState,
} from "../../src/chat/lib/chatModel.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";

const SESSION_ON_A = {
  id: "sA",
  title: "A 会话",
  updatedAt: 2,
  createdAt: 1,
  itemKey: "ITEM_A",
  claudeSessionId: null,
};

/** 只用真实入口造 state：init → sessionList → readerContext */
function viewAt(itemKey: string | null, sessions: unknown[]): ChatState {
  let s = reduceHostMessage(initialChatState(), { type: "init" });
  s = reduceHostMessage(s, {
    type: "sessionList",
    sessions,
  } as unknown as HostMessage);
  if (itemKey !== null) {
    s = reduceHostMessage(s, {
      type: "readerContext",
      itemKey,
      title: "论文",
      page: 1,
      selection: null,
    });
  }
  return s;
}

test("T-P1-a5a 🔴 当前文献没有任何会话且没请求过 → 返回该 itemKey（该发 getState）", () => {
  const s = viewAt("ITEM_NEW", [SESSION_ON_A]);
  assert.equal(needsSessionListRefresh(s, null), "ITEM_NEW");
});

test("T-P1-a5b 🔴 同一个 itemKey 第二次 → 返回 null（每个 itemKey 最多请求一次）", () => {
  const s = viewAt("ITEM_NEW", [SESSION_ON_A]);
  assert.equal(needsSessionListRefresh(s, "ITEM_NEW"), null);
});

test("T-P1-a5c 🔴 当前文献已经有会话 → 返回 null（不发 getState）", () => {
  const s = viewAt("ITEM_A", [SESSION_ON_A]);
  assert.equal(needsSessionListRefresh(s, null), null);
});

test("T-P1-a5d 🔴 还没有文献上下文（itemKey 为 null）→ 返回 null", () => {
  const s = viewAt(null, [SESSION_ON_A]);
  assert.equal(s.readerContext, null, "夹具自检：此时没有文献上下文");
  assert.equal(needsSessionListRefresh(s, null), null);
});

test("T-P1-a5e 🔴 换到另一篇没有会话的文献：上次请求的是别的 key → 仍要请求", () => {
  const s = viewAt("ITEM_OTHER", [SESSION_ON_A]);
  assert.equal(needsSessionListRefresh(s, "ITEM_NEW"), "ITEM_OTHER");
});

test("T-P1-a5f 🔴 会话列表为空（一条会话都没有）→ 返回当前 itemKey", () => {
  const s = viewAt("ITEM_NEW", []);
  assert.equal(needsSessionListRefresh(s, null), "ITEM_NEW");
});
