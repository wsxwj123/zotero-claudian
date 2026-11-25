// r23 白盒补充：输入框 onKeyDown 对回车一律 stopPropagation（防宿主条目面板按类名 input 移走焦点），
// preventDefault 与发送行为保持修改前语义。验收用例未覆盖的两类：
// 1) 命令面板展开时被面板消费的回车；2) 带 Alt / Ctrl / Meta 的回车。
// 修改前语义：命令面板分支对 Enter 调 preventDefault 并选中命令、不走发送；
// isSendEnter 只看 key / shiftKey / isComposing / keyCode，不看 Alt/Ctrl/Meta，
// 所以带这三个修饰键的回车照常 preventDefault 并发送。
import "./m6-review/domShim.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "preact";
import { App, ChatStore } from "../../src/chat/App.ts";
import { reduceHostMessage } from "../../src/chat/lib/chatModel.ts";
import type { UiMessage } from "../../src/chat/lib/types.ts";
import { byClass, mountPoint, type ShimElement } from "./m6-review/domShim.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function mountConnectedApp(): Promise<{
  store: ChatStore;
  sends: UiMessage[];
  container: ShimElement;
  unmount: () => void;
}> {
  const store = new ChatStore();
  const sends: UiMessage[] = [];
  const container = mountPoint();
  const bridge = {
    send: (msg: UiMessage) => {
      sends.push(msg);
    },
  };
  // @ts-expect-error 测试替身只实现 App 用到的 send
  render(h(App, { store, bridge }), container);
  store.set({ ...store.get(), sessionId: "S-r23-unit", connected: true });
  await sleep(40);
  return { store, sends, container, unmount: () => render(null, container) };
}

function inputBox(container: ShimElement): ShimElement {
  const boxes = byClass(container, "input");
  assert.equal(boxes.length, 1, "输入框数量异常");
  return boxes[0];
}

async function typeInto(box: ShimElement, text: string): Promise<void> {
  box.value = text;
  box.dispatch("input");
  await sleep(40);
}

function pressEnter(
  box: ShimElement,
  mods: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): { stopPropagation: number; preventDefault: number } {
  const counts = { stopPropagation: 0, preventDefault: 0 };
  box.dispatch("keydown", {
    key: "Enter",
    shiftKey: false,
    altKey: mods.altKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    isComposing: false,
    keyCode: 13,
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

const sendMessages = (sends: UiMessage[]): UiMessage[] =>
  sends.filter((m) => m && m.type === "send");

test("r23-u1 命令面板展开时的回车：stopPropagation 1 次、preventDefault 1 次、不发送", async () => {
  const t = await mountConnectedApp();
  try {
    const box = inputBox(t.container);
    // 仿真元素缺 focus/setSelectionRange；pickCommand 落光标时会调用，补空实现
    Object.assign(box, { focus() {}, setSelectionRange() {} });
    await typeInto(box, "/");
    // 面板打开后宿主回执命令清单（自定义命令：选中只插骨架，不触发任何发送）
    t.store.set(
      reduceHostMessage(t.store.get(), {
        type: "commandList",
        commands: [
          { name: "r23cmd", description: "r23 测试命令", source: "project" },
        ],
      }),
    );
    await sleep(40);
    assert.equal(
      byClass(t.container, "command-panel").length,
      1,
      "前置失败：输入 / 后命令面板未展开",
    );
    const counts = pressEnter(box);
    await sleep(40);
    assert.equal(counts.stopPropagation, 1, "面板消费的回车也应阻止向外层传递");
    assert.equal(
      counts.preventDefault,
      1,
      "面板消费的回车应 preventDefault（修改前即如此）",
    );
    assert.equal(
      sendMessages(t.sends).length,
      0,
      "面板消费的回车不应发出 send",
    );
    assert.equal(box.value, "/r23cmd ", "回车应由面板消费：插入命令骨架");
  } finally {
    t.unmount();
  }
});

for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
  test(`r23-u2 ${mod}+Enter：stopPropagation 1 次，preventDefault 与发送同修改前（各 1）`, async () => {
    const t = await mountConnectedApp();
    try {
      const box = inputBox(t.container);
      await typeInto(box, "你好");
      const counts = pressEnter(box, { [mod]: true });
      await sleep(40);
      assert.equal(counts.stopPropagation, 1, `${mod}+Enter 未阻止向外层传递`);
      assert.equal(
        counts.preventDefault,
        1,
        `${mod}+Enter 应 preventDefault 恰好 1 次`,
      );
      const sent = sendMessages(t.sends);
      assert.equal(sent.length, 1, `${mod}+Enter 应发出恰好一条 send`);
      assert.equal((sent[0] as { text?: string }).text, "你好");
    } finally {
      t.unmount();
    }
  });
}
