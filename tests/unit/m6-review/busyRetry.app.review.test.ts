// m6 复核轮 — 记录-06 的 App 层独立验证：真实 Preact 渲染 + 真实 useEffect 定时器接线。
// 验证点（reducer 测试覆盖不到的部分）：App 的 useEffect 是否真的按 RETRY_DELAY_MS 上表、
// 定时器到点是否真的走 fireRetry + bridge.send、被接受/取消后是否收手、用尽后输入框是否真退字、
// 横幅是否真进 DOM、重试窗口里用户能否手动发送（send 按钮可用、无中断按钮）。
// 手法：把 delay === RETRY_DELAY_MS 的 setTimeout 捕获下来手动触发（其余定时器走真实调度），
// 于是不必真等 5 秒。
import "./domShim.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "preact";
import { App, ChatStore } from "../../../src/chat/App.ts";
import {
  initialChatState,
  reduceHostMessage,
  RETRY_DELAY_MS,
  userSend,
  type ChatState,
} from "../../../src/chat/lib/chatModel.ts";
import type { HostMessage, UiMessage } from "../../../src/chat/lib/types.ts";
import { setSanitizer } from "../../../src/chat/lib/markdown.ts";
import {
  byClass,
  collectText,
  mountPoint,
  type ShimElement,
} from "./domShim.ts";

setSanitizer((html) => html);

const S1 = "S1";
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const busyMsg: HostMessage = {
  type: "error",
  code: "SESSION_BUSY",
  message: "进行中的 turn 未结束",
  sessionId: S1,
};

/** 捕获 RETRY_DELAY_MS 定时器；其余 delay 走真实调度 */
function captureRetryTimers(): {
  timers: Array<{ fn: () => void; cancelled: boolean }>;
  restore: () => void;
} {
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    fn: (...a: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay === RETRY_DELAY_MS) {
      const t = { fn: () => fn(), cancelled: false };
      timers.push(t);
      return t;
    }
    return realSetTimeout(fn, delay, ...(rest as []));
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle && typeof handle === "object" && "cancelled" in handle) {
      (handle as { cancelled: boolean }).cancelled = true;
      return;
    }
    return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    timers,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

interface Harness {
  store: ChatStore;
  sends: UiMessage[];
  container: ShimElement;
  timers: Array<{ fn: () => void; cancelled: boolean }>;
  restoreTimers: () => void;
  feed: (msg: HostMessage) => void;
  unmount: () => void;
}

function mountApp(): Harness {
  const { timers, restore } = captureRetryTimers();
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
  return {
    store,
    sends,
    container,
    timers,
    restoreTimers: restore,
    feed: (msg: HostMessage) => store.set(reduceHostMessage(store.get(), msg)),
    unmount: () => render(null, container),
  };
}

function sendFromUi(store: ChatStore, text: string): void {
  const r = userSend(store.get(), text);
  store.set(r.state);
}

function input(container: ShimElement): ShimElement {
  const els = byClass(container, "input");
  assert.equal(els.length, 1, "输入框数量异常");
  return els[0];
}

/** 在窗口内直接敲字 + 点发送（走真实组件事件链；两者之间留一拍让 Preact 提交重渲染） */
async function typeAndClickSend(
  container: ShimElement,
  text: string,
): Promise<void> {
  const ta = input(container);
  ta.value = text;
  ta.dispatch("input");
  await sleep(40);
  const send = byClass(container, "send")[0];
  assert.ok(send, "找不到发送按钮");
  send.dispatch("click");
}

test("App 层: BUSY → 1 秒定时器自动重发（同一条报文）→ 被接受即收手", async () => {
  const t = mountApp();
  try {
    t.feed({ type: "sessionList", sessions: [] } as unknown as HostMessage);
    t.store.set({ ...t.store.get(), sessionId: S1, connected: true });
    sendFromUi(t.store, "自动重发的问题");
    t.feed(busyMsg);
    await sleep(80); // 等 Preact passive effect 上表

    assert.equal(t.timers.length, 1, "被拒后未按 1 秒上表");
    assert.equal(t.timers[0].cancelled, false);
    // 重试窗口内：提示「收尾中」、无中断按钮、发送按钮可用（用户可手动顶掉）
    assert.ok(
      collectText(input(t.container)).includes("收尾中") ||
        String(input(t.container).getAttribute("placeholder")).includes(
          "收尾中",
        ),
      "重试窗口未提示「上一轮收尾中…」",
    );
    assert.equal(
      byClass(t.container, "interrupt").length,
      0,
      "idle 期不应有中断按钮",
    );

    t.timers[0].fn();
    assert.deepEqual(t.sends, [
      { type: "send", sessionId: S1, text: "自动重发的问题" },
    ]);
    assert.equal(t.store.get().turnStatus, "waiting");
    assert.equal(t.store.get().pendingRetry?.attempts, 1);

    // 宿主接受（流事件到达）→ 收手：不再上表、不再重发
    t.feed({
      type: "streamEvent",
      sessionId: S1,
      event: { kind: "messageStart" },
    } as unknown as HostMessage);
    await sleep(80);
    assert.equal(t.store.get().pendingRetry, null);
    const timersAfterAccept = t.timers.length;
    await sleep(60);
    assert.equal(t.timers.length, timersAfterAccept, "被接受后仍在重试");
    assert.equal(t.sends.length, 1, "被接受后仍重复发送");
  } finally {
    t.unmount();
    t.restoreTimers();
  }
});

test("App 层: 连续被拒直到用尽 → 输入框真退字 + 横幅进 DOM + 不再重发", async () => {
  const t = mountApp();
  try {
    t.store.set({ ...t.store.get(), sessionId: S1, connected: true });
    await typeAndClickSend(t.container, "被拒的问题");
    assert.deepEqual(t.sends, [
      { type: "send", sessionId: S1, text: "被拒的问题" },
    ]);
    t.feed(busyMsg);
    await sleep(80);

    // 5 次重发全部被拒
    for (let i = 1; i <= 5; i++) {
      const armed = t.timers.filter((x) => !x.cancelled);
      assert.equal(armed.length, 1, `第 ${i} 次重发未按秒上表`);
      armed[0].fn();
      assert.deepEqual(t.sends[i], {
        type: "send",
        sessionId: S1,
        text: "被拒的问题",
      });
      t.feed(busyMsg);
      await sleep(80);
    }

    assert.equal(t.sends.length, 6, "总发送次数应为首次 + 5 次重发");
    assert.equal(t.store.get().pendingRetry, null, "用尽后仍挂重试态");
    assert.equal(
      input(t.container).value,
      "被拒的问题",
      "兜底未把原文退回输入框（丢字）",
    );
    const banner = byClass(t.container, "banner");
    assert.equal(banner.length, 1, "兜底未弹横幅");
    assert.ok(
      collectText(t.container).includes("SESSION_BUSY"),
      "横幅文案未告知 SESSION_BUSY",
    );
    const n = t.timers.length;
    await sleep(60);
    assert.equal(t.timers.length, n, "兜底后仍在重试");
  } finally {
    t.unmount();
    t.restoreTimers();
  }
});

test("App 层: 重试窗口内用户手动发送 → 取消自动重发且不留幽灵轮", async () => {
  const t = mountApp();
  try {
    t.store.set({ ...t.store.get(), sessionId: S1, connected: true });
    sendFromUi(t.store, "旧问题");
    t.feed(busyMsg);
    await sleep(80);
    assert.equal(t.timers.filter((x) => !x.cancelled).length, 1);

    await typeAndClickSend(t.container, "新问题");
    assert.deepEqual(t.sends, [
      { type: "send", sessionId: S1, text: "新问题" },
    ]);
    assert.equal(t.store.get().pendingRetry, null);
    // 旧拒轮不得留在消息列表（幽灵轮），也不得再被重发
    const texts = t.store
      .get()
      .messages.filter((m) => m.role === "user")
      .map((m) => m.text);
    assert.deepEqual(texts, ["新问题"]);
    await sleep(1100); // 让被取消的定时器（若未取消）有机会露头
    assert.equal(t.sends.length, 1, "取消后仍重发了旧文");
  } finally {
    t.unmount();
    t.restoreTimers();
  }
});

test("App 层: 重试窗口点中断不可达（无按钮）；重发在途中断 → 取消且 BUSY 后收敛回 idle", async () => {
  const t = mountApp();
  try {
    t.store.set({ ...t.store.get(), sessionId: S1, connected: true });
    sendFromUi(t.store, "问题");
    t.feed(busyMsg);
    await sleep(80);
    const armed = t.timers.filter((x) => !x.cancelled);
    assert.equal(armed.length, 1);
    armed[0].fn(); // 重发在途（waiting）→ 中断按钮出现
    await sleep(40);
    const btns = byClass(t.container, "interrupt");
    assert.equal(btns.length, 1, "重发在途应能中断");
    btns[0].dispatch("click");
    assert.equal(t.store.get().turnStatus, "interrupting");
    assert.equal(t.store.get().pendingRetry, null, "中断未取消自动重发");
    // 该次发送其实被宿主拒了（BUSY）→ 必须收敛回 idle 并退字，不得锁死
    t.feed(busyMsg);
    await sleep(60);
    assert.equal(
      t.store.get().turnStatus,
      "idle",
      "中断路径把 UI 锁死在 interrupting",
    );
    assert.equal(input(t.container).value, "问题");
    const n = t.timers.length;
    await sleep(60);
    assert.equal(t.timers.length, n, "中断后仍在重试");
  } finally {
    t.unmount();
    t.restoreTimers();
  }
});
