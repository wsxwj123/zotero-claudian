// 验收 — r23-shift-enter：输入框回车键不再向外层传递（黑盒，依据 .devflow/r23-shift-enter-接口.md 行为清单 1–6）
// 只经对外入口：渲染 App（src/chat/App.ts），在无头 DOM 里向类名 input 的 textarea 派发 keydown，
// 观察事件对象的 stopPropagation / preventDefault 调用次数，以及页面经 bridge 发往宿主的消息。
import "../unit/m6-review/domShim.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { h, render } from "preact";
import { App, ChatStore } from "../../src/chat/App.ts";
import { byClass, mountPoint } from "../unit/m6-review/domShim.ts";

const SESSION_ID = "S-r23";

/** 前置：视图已连接并绑定一个会话，处于空闲 */
async function mountConnectedApp() {
  const store = new ChatStore();
  const sends = [];
  const container = mountPoint();
  const bridge = {
    send: (msg) => {
      sends.push(msg);
    },
  };
  render(h(App, { store, bridge }), container);
  store.set({ ...store.get(), sessionId: SESSION_ID, connected: true });
  await sleep(40);
  return { sends, container, unmount: () => render(null, container) };
}

function inputBox(container) {
  const boxes = byClass(container, "input");
  assert.equal(boxes.length, 1, "输入框数量异常");
  assert.equal(boxes[0].localName, "textarea", "类名 input 的元素不是 textarea");
  return boxes[0];
}

/** 走真实 input 事件把内容写进输入框，留一拍让 Preact 提交重渲染 */
async function typeInto(box, text) {
  box.value = text;
  box.dispatch("input");
  await sleep(40);
}

/** 构造带计数器的 keydown 事件并派发 */
function pressKey(box, fields) {
  const counts = { stopPropagation: 0, preventDefault: 0 };
  box.dispatch("keydown", {
    key: fields.key,
    shiftKey: fields.shiftKey ?? false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: fields.isComposing ?? false,
    keyCode: fields.keyCode,
    target: box,
    stopPropagation() {
      counts.stopPropagation += 1;
    },
    preventDefault() {
      counts.preventDefault += 1;
    },
  });
  return counts;
}

const sendMessages = (sends) => sends.filter((m) => m && m.type === "send");

test("r23-1 Shift+Enter：stopPropagation 1 次、preventDefault 0 次、不发送", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    await typeInto(box, "第一行");
    const counts = pressKey(box, { key: "Enter", shiftKey: true, keyCode: 13 });
    await sleep(40);
    assert.equal(counts.stopPropagation, 1, "Shift+Enter 未阻止向外层传递");
    assert.equal(counts.preventDefault, 0, "Shift+Enter 不应 preventDefault");
    assert.equal(sendMessages(t.sends).length, 0, "Shift+Enter 不应发出 send");
  } finally {
    t.unmount();
  }
});

test("r23-2 普通 Enter：stopPropagation 1 次、preventDefault 1 次、发出恰好一条 send(你好)", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    await typeInto(box, "你好");
    const counts = pressKey(box, { key: "Enter", shiftKey: false, keyCode: 13 });
    await sleep(40);
    assert.equal(counts.stopPropagation, 1, "Enter 未阻止向外层传递");
    assert.equal(counts.preventDefault, 1, "Enter 应 preventDefault 恰好 1 次");
    const sent = sendMessages(t.sends);
    assert.equal(sent.length, 1, "Enter 应发出恰好一条 send");
    assert.equal(sent[0].text, "你好");
  } finally {
    t.unmount();
  }
});

test("r23-3 输入法候选态 Enter：stopPropagation 1 次、preventDefault 0 次、不发送", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    await typeInto(box, "ni");
    const counts = pressKey(box, {
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 229,
    });
    await sleep(40);
    assert.equal(counts.stopPropagation, 1, "候选态 Enter 未阻止向外层传递");
    assert.equal(counts.preventDefault, 0, "候选态 Enter 不应 preventDefault");
    assert.equal(sendMessages(t.sends).length, 0, "候选态 Enter 不应发出 send");
  } finally {
    t.unmount();
  }
});

test("r23-4（回归）普通字符键 a：stopPropagation 0 次、preventDefault 0 次", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    const counts = pressKey(box, { key: "a", keyCode: 65 });
    assert.equal(counts.stopPropagation, 0, "字符键不应阻止向外层传递");
    assert.equal(counts.preventDefault, 0, "字符键不应 preventDefault");
  } finally {
    t.unmount();
  }
});

test("r23-5（回归）空输入框 ArrowUp：stopPropagation 0 次", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    await typeInto(box, "");
    const counts = pressKey(box, { key: "ArrowUp", keyCode: 38 });
    assert.equal(counts.stopPropagation, 0, "ArrowUp 不应阻止向外层传递");
  } finally {
    t.unmount();
  }
});

test("r23-6（回归）Escape：stopPropagation 0 次", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    const counts = pressKey(box, { key: "Escape", keyCode: 27 });
    assert.equal(counts.stopPropagation, 0, "Escape 不应阻止向外层传递");
  } finally {
    t.unmount();
  }
});
