// 单测 — R14b（WIN-COMPAT-R14R15 必修-1）：长消息下 inFlight 的截断不许破坏 R-B 幂等闸
//
// 现象：用户文本 > 4000 UTF-16 码元（中文 4001 字即触发；emoji 占 2 码元更早）时，
// `info.userText` 已被归一阶段截到 4000，而本地末条 user 轮是全文 → 直接比 "不相等" →
// 发送方**自己的视图**里又补一条截断副本（同一句话两条气泡，后续回答挂在副本下面）。
// 契约：比较口径与显示口径解耦——两侧按同一上限截断后再比。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialChatState,
  reduceHostMessage,
  userSend,
} from "../../src/chat/lib/chatModel.ts";

const boot = () => {
  let s = initialChatState();
  s = reduceHostMessage(s, {
    type: "sessionList",
    sessions: [
      { id: "s1", title: "S", updatedAt: 1, createdAt: 1, itemKey: "A" },
    ],
  });
  return { ...s, sessionId: "s1" };
};

const countUsers = (s: { messages: { role: string }[] }): number =>
  s.messages.filter((t) => t.role === "user").length;

const inflightHistory = (userText: string) =>
  ({
    type: "history",
    sessionId: "s1",
    messages: [],
    inFlight: {
      userText: userText.slice(0, 4000), // 宿主直传全文，UI 归一阶段截到 4000
      assistantText: "",
      busy: "running",
      baseRows: 0,
    },
  }) as const;

test("R14b 🔴 5000 字中文：发送方视图不得因截断口径多出重复气泡（修前红）", () => {
  let s = boot();
  s = userSend(s, "甲".repeat(5000)).state;
  const before = countUsers(s);
  s = reduceHostMessage(s, inflightHistory("甲".repeat(5000)));
  assert.equal(countUsers(s), before, "长消息不得多补占位轮");
});

test("R14b 🔴 emoji 落在第 4000 码元边界：同样不得重复", () => {
  const text = "甲".repeat(3999) + "😀" + "乙".repeat(50);
  let s = boot();
  s = userSend(s, text).state;
  const before = countUsers(s);
  s = reduceHostMessage(s, inflightHistory(text));
  assert.equal(countUsers(s), before, "边界处截断也不得多补");
});

test("R14b 🔒 正常长度（4000 以内）行为不变", () => {
  let s = boot();
  s = userSend(s, "短消息").state;
  const before = countUsers(s);
  s = reduceHostMessage(s, inflightHistory("短消息"));
  assert.equal(countUsers(s), before);
});

test("R14b 🔒 换一条消息（文本不同）仍要补占位（不许过度去重）", () => {
  let s = boot();
  s = userSend(s, "我的问题").state;
  const before = countUsers(s);
  s = reduceHostMessage(s, inflightHistory("别人的问题"));
  assert.equal(countUsers(s), before + 1, "不同文本必须补上（多实例场景）");
});
