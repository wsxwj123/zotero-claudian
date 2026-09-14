// 单测 — R7-F「消息级操作：复制 / 编辑回填 / 折叠」（PLAN-R7 §3.8，黑盒：只按契约写，不看实现——
// 本轮 R7-F 尚未开工，红基线即「模块不存在/未导出」）。
//
// 锁定的契约点：
//   1) 复制态：idle → copied →（~1.5s 定时器到）idle；连点清旧定时器、**不早退**
//   2) 复制内容：user 复制原文（纯文本）；AI 回复复制 **Markdown 源码**（不是渲染后的 HTML）
//   3) 复制实现：navigator.clipboard.writeText 优先，失败回落 execCommand，两条都失败记日志不抛
//   4) 折叠：> 12 行默认折叠、点击展开/再点收起；短消息不折叠；**视图态，切会话即重置**
//   5) 编辑：文本回填输入框 + 原消息标「待重发」；AI 消息**没有**编辑入口（只有复制）
//   6) 发送语义：编辑的是最后一条 → 不截断；不是最后一条 → 移除其后消息 + 插「已编辑重发」分隔
//
// 契约未给纯函数名与形状，本文件锁定的形（开发需照此导出；若主会话另有裁决需同步改此文件）：
//   src/chat/lib/messageActions.ts → COPY_FEEDBACK_MS(1500) / COLLAPSE_LINE_THRESHOLD(12) /
//     initialMessageActionState() -> { expanded:number[], editingIndex:number|null, composerText:string } /
//     messageCopyClick(state) -> { status:"copied", token } / messageCopyRevert(state, token) /
//     copyTurnText(turn) / copyToClipboard(text, deps{writeText, execCommand, log}) /
//     isOverflowing(text) / messageCollapsed(state, index, text) / messageCollapseToggle(state, index) /
//     messageActionsReset(state) / canEditTurn(turn) / messageEditStart(state, messages, index) /
//     editResend(messages, index) -> { messages, truncated }
//   turn 沿用既有 Turn 形状：{ role:"user", text } / { role:"assistant", blocks:[{blockType,text,...}] }；
//   截断分隔条形状假设：{ role:"divider", text:"已编辑重发" }
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSE_LINE_THRESHOLD,
  COPY_FEEDBACK_MS,
  canEditTurn,
  copyToClipboard,
  copyTurnText,
  editResend,
  initialMessageActionState,
  isOverflowing,
  messageActionsReset,
  messageCollapseToggle,
  messageCollapsed,
  messageCopyClick,
  messageCopyRevert,
  messageEditStart,
} from "../../src/chat/lib/messageActions.ts";

const user = (text) => ({ role: "user", text });
const ai = (text) => ({
  role: "assistant",
  blocks: [{ blockType: "text", index: 0, text, streaming: false }],
});

// ---- 复制态机 ----

test("R7-F 复制态：初始 idle；点击 → copied（token 更新，UI 据此重排定时器）", () => {
  const s0 = initialMessageActionState();
  assert.equal(s0.copy.status, "idle");
  const s1 = messageCopyClick(s0);
  assert.equal(s1.copy.status, "copied");
  assert.notEqual(s1.copy.token, s0.copy.token, "每次点击要换一个新 token");
});

test("R7-F 复制态：定时器到点（token 匹配）→ 回落 idle", () => {
  const clicked = messageCopyClick(initialMessageActionState());
  const back = messageCopyRevert(clicked, clicked.copy.token);
  assert.equal(back.copy.status, "idle");
});

test("R7-F 复制态：连点 —— 仍为 copied（不早退）且 token 递增", () => {
  const s1 = messageCopyClick(initialMessageActionState());
  const s2 = messageCopyClick(s1);
  assert.equal(
    s2.copy.status,
    "copied",
    "第二次点击不得把「已复制」吞掉（要重新计时）",
  );
  assert.notEqual(s2.copy.token, s1.copy.token, "第二次点击要换新 token");
});

test("R7-F 复制态：连点后旧定时器作废（用旧 token 回落无效）", () => {
  const s1 = messageCopyClick(initialMessageActionState());
  const s2 = messageCopyClick(s1);
  const stale = messageCopyRevert(s2, s1.copy.token);
  assert.equal(
    stale.copy.status,
    "copied",
    "旧定时器不得把新一次的「已复制」提前清掉",
  );
  const fresh = messageCopyRevert(stale, s2.copy.token);
  assert.equal(fresh.copy.status, "idle", "最新 token 到点才回落");
});

test("R7-F 复制态：回落幂等（定时器重复触发不叠加副作用）", () => {
  const clicked = messageCopyClick(initialMessageActionState());
  const once = messageCopyRevert(clicked, clicked.copy.token);
  const twice = messageCopyRevert(once, clicked.copy.token);
  assert.equal(twice.copy.status, "idle");
  assert.deepEqual(twice, once);
});

test("R7-F 复制态：提示时长常量 1500ms（~1.5s）", () => {
  assert.equal(COPY_FEEDBACK_MS, 1500);
});

// ---- 复制内容 ----

test("R7-F 复制内容：AI 回复复制的是 Markdown 源码（**粗体** / ```代码块``` 原样）", () => {
  const src = "这是**粗体**与 `行内代码`：\n\n```js\nconst a = 1;\n```\n";
  const copied = copyTurnText(ai(src));
  assert.equal(copied, src, "必须逐字是 Markdown 源码");
  assert.ok(
    !copied.includes("<strong>") && !copied.includes("<pre>"),
    "不得是渲染后的 HTML",
  );
});

test("R7-F 复制内容：多条 text 块按序拼接；思考块与工具卡不进复制内容", () => {
  const turn = {
    role: "assistant",
    blocks: [
      {
        blockType: "thinking",
        index: 0,
        text: "内部思考不该被复制",
        streaming: false,
      },
      { blockType: "text", index: 1, text: "第一段。", streaming: false },
      {
        blockType: "tool",
        index: 2,
        toolName: "Read",
        toolUseId: "t1",
        inputJson: '{"file_path":"/secret.pdf"}',
        result: { isError: false, summary: "ok" },
        streaming: false,
      },
      { blockType: "text", index: 3, text: "第二段。", streaming: false },
    ],
  };
  const copied = copyTurnText(turn);
  assert.ok(copied.includes("第一段。") && copied.includes("第二段。"));
  assert.ok(!copied.includes("内部思考"), "思考过程不进剪贴板");
  assert.ok(!copied.includes("secret.pdf"), "工具入参不进剪贴板");
});

test("R7-F 复制内容：用户消息复制原文（纯文本，不渲染）", () => {
  const src = "帮我看下 **这个** 是不是 bug";
  assert.equal(copyTurnText(user(src)), src);
});

test("R7-F 复制内容：空/异常输入 → 空串，不抛", () => {
  for (const bad of [
    undefined,
    null,
    {},
    { role: "assistant" },
    { role: "user" },
  ]) {
    let got;
    assert.doesNotThrow(() => {
      got = copyTurnText(bad);
    }, JSON.stringify(bad));
    assert.equal(typeof got, "string");
  }
});

// ---- 剪贴板两条路径 ----

test("R7-F 剪贴板：优先 clipboard.writeText（失败回落通道一次都不调）", async () => {
  const calls = [];
  const ok = await copyToClipboard("要复制的文本", {
    writeText: async (t) => calls.push(`writeText:${t}`),
    execCommand: (t) => {
      calls.push(`exec:${t}`);
      return true;
    },
    log: (m) => calls.push(`log:${m}`),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["writeText:要复制的文本"]);
});

test("R7-F 剪贴板：writeText 抛错（chrome:// 特权页限制）→ 回落 execCommand 并成功", async () => {
  const calls = [];
  const ok = await copyToClipboard("文本", {
    writeText: async () => {
      throw new Error("NotAllowedError: clipboard disabled");
    },
    execCommand: () => {
      calls.push("exec");
      return true;
    },
    log: () => {},
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["exec"], "要真的走回落通道");
});

test("R7-F 剪贴板：两条都失败 → 返回 false + 记日志，**不抛**（UI 不能崩）", async () => {
  const logs = [];
  let ok;
  await assert.doesNotReject(async () => {
    ok = await copyToClipboard("文本", {
      writeText: async () => {
        throw new Error("no clipboard");
      },
      execCommand: () => false,
      log: (m) => logs.push(m),
    });
  });
  assert.equal(ok, false);
  assert.ok(
    logs.length > 0,
    "失败必须留日志（契约要求两条路径都有兜底 + 日志）",
  );
});

test("R7-F 剪贴板：execCommand 抛错也不外泄（回落路径同样兜底）", async () => {
  let ok;
  await assert.doesNotReject(async () => {
    ok = await copyToClipboard("文本", {
      writeText: async () => {
        throw new Error("a");
      },
      execCommand: () => {
        throw new Error("b");
      },
      log: () => {},
    });
  });
  assert.equal(ok, false);
});

// ---- 折叠 ----

const LONG = Array.from({ length: 13 }, (_, i) => `第 ${i + 1} 行`).join("\n");

test("R7-F 折叠：超阈值（> 12 行）默认折叠；正好 12 行不折叠", () => {
  assert.equal(COLLAPSE_LINE_THRESHOLD, 12);
  assert.equal(isOverflowing(LONG), true);
  assert.equal(
    isOverflowing(Array.from({ length: 12 }, () => "行").join("\n")),
    false,
  );
  const s = initialMessageActionState();
  assert.equal(messageCollapsed(s, 3, LONG), true, "超长消息默认折叠");
  assert.equal(messageCollapsed(s, 3, "短消息"), false);
});

test("R7-F 折叠：点击展开 → 再点收起", () => {
  const s0 = initialMessageActionState();
  const expanded = messageCollapseToggle(s0, 3);
  assert.equal(messageCollapsed(expanded, 3, LONG), false, "点开要看全文");
  const collapsed = messageCollapseToggle(expanded, 3);
  assert.equal(messageCollapsed(collapsed, 3, LONG), true, "再点收回去");
});

test("R7-F 折叠：各条独立（展开第 1 条不影响第 2 条）", () => {
  const s = messageCollapseToggle(initialMessageActionState(), 0);
  assert.equal(messageCollapsed(s, 0, LONG), false);
  assert.equal(messageCollapsed(s, 1, LONG), true);
});

test("R7-F 折叠：短消息点「展开」也不会变成折叠态（阈值是硬条件）", () => {
  const s = messageCollapseToggle(initialMessageActionState(), 5);
  assert.equal(messageCollapsed(s, 5, "只有一行"), false);
});

test("R7-F 折叠：切会话即重置（视图态：不落盘、不进历史）", () => {
  let s = messageCollapseToggle(initialMessageActionState(), 3);
  s = messageCopyClick(s);
  const fresh = messageActionsReset(s);
  assert.deepEqual(fresh, initialMessageActionState(), "重置要逐字回到初始态");
  assert.equal(messageCollapsed(fresh, 3, LONG), true, "展开态不得跨会话残留");
  assert.equal(fresh.copy.status, "idle", "「已复制」也不跨会话");
});

// ---- 编辑入口 ----

const MESSAGES = [
  user("第一条问题"),
  ai("第一条回答"),
  user("第二条问题"),
  ai("第二条回答"),
];

test("R7-F 编辑：用户消息可编辑 —— 原文回填输入框、原下标标「待重发」、原消息保留", () => {
  const { state, ok } = messageEditStart(
    initialMessageActionState(),
    MESSAGES,
    2,
  );
  assert.equal(ok, true);
  assert.equal(state.composerText, "第二条问题");
  assert.equal(state.editingIndex, 2);
});

test("R7-F 编辑：AI 消息没有编辑入口（只有复制）", () => {
  assert.equal(canEditTurn(MESSAGES[1]), false);
  assert.equal(canEditTurn(MESSAGES[2]), true);
  const before = initialMessageActionState();
  const { state, ok } = messageEditStart(before, MESSAGES, 1);
  assert.equal(ok, false);
  assert.equal(state.composerText, "", "AI 消息不得往输入框回填");
  assert.equal(state.editingIndex, null);
});

test("R7-F 编辑：非法下标 / 空数组 → 不抛、不置编辑态", () => {
  for (const [msgs, idx] of [
    [MESSAGES, 99],
    [MESSAGES, -1],
    [[], 0],
  ]) {
    let out;
    assert.doesNotThrow(() => {
      out = messageEditStart(initialMessageActionState(), msgs, idx);
    });
    assert.equal(out.ok, false);
    assert.equal(out.state.editingIndex, null);
  }
});

// ---- 发送语义 ----

test("R7-F 重发：编辑的是最后一条 → 不截断（消息数组逐字不变）", () => {
  const tail = [user("第一条问题"), ai("第一条回答"), user("第二条问题")];
  const out = editResend(tail, 2);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.messages, tail);
});

// 口径：这里按「该条不是最后一条 → 截断」的消息级读法写（其后的 AI 回复一并移除，
// 因为那是针对被改掉那句的旧答案）。PLAN §3.8 写的是「最后一条用户消息」，两读法在
// 「最后一条用户消息后面还跟着 AI 回复」这一格上不一致——已记进契约歧义，等主会话裁决。
test("R7-F 重发：编辑的不是最后一条 → 移除其后消息 + 插「已编辑重发」分隔", () => {
  const out = editResend(MESSAGES, 2);
  assert.equal(out.truncated, true);
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ["user", "assistant", "user", "divider"],
    "前面保留、其后清掉、末尾插分隔",
  );
  assert.deepEqual(out.messages[2], MESSAGES[2], "被编辑的原文保留（不删）");
  assert.equal(out.messages[3].text, "已编辑重发");
  assert.ok(
    !out.messages.includes(MESSAGES[3]),
    "其后的 AI 回复必须移除（视图不假装还在）",
  );
});

test("R7-F 重发：编辑第一条 → 只剩原文 + 分隔", () => {
  const out = editResend(MESSAGES, 0);
  assert.equal(out.truncated, true);
  assert.equal(out.messages.length, 2);
  assert.deepEqual(out.messages[0], MESSAGES[0]);
  assert.equal(out.messages[1].role, "divider");
});

test("R7-F 重发：纯函数 —— 不改入参；结果与原数组不共享截断段", () => {
  const snapshot = JSON.stringify(MESSAGES);
  const out = editResend(MESSAGES, 2);
  assert.equal(JSON.stringify(MESSAGES), snapshot, "入参被改了");
  assert.notEqual(out.messages, MESSAGES, "要返回新数组");
});
