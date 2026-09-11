// 单测 — src/chat/lib/bridgeClient.ts 的 BridgeClient 类本体（攻击面）。
// 用假 window（无 jsdom）驱动真实 handleMessage：握手 token 校验 / 回发通道选择（端口优先、
// source 回退）/ 来源过滤 / outbox / 幂等重握手 / destroy / mock / 病态输入兜底。
// 纯函数覆盖面见 bridgeClient.test.mjs（本文件不含）。
// 来源：.scratch/verify-m4b/probe-page-client.mjs（test-m4b 重测探针）收编改造，另补 N3/N4 回归。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BridgeClient } from "../../src/chat/lib/bridgeClient.ts";

/** 假页面环境：window（监听表 + diag + location）+ 宿主窗口 + 外来窗口 + 一个 MessagePort。
 * fire 同步派发给全部已注册监听器——监听器抛错直接冒到调用点（被测行为的一部分）。 */
function makeEnv(search = "?token=tk-1") {
  const listeners = [];
  const win = {
    __claudianDiag: [],
    location: { search },
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) {
        listeners.splice(i, 1);
      }
    },
  };
  globalThis.window = win;
  const fakeHost = {
    sent: [],
    postMessage: (m, o, ports) => fakeHost.sent.push({ m, o, ports }),
  };
  const other = { tag: "other-window" };
  const port = { sent: [], postMessage: (m) => port.sent.push(m) };
  return {
    listeners,
    win,
    fakeHost,
    other,
    port,
    fire: (ev) => [...listeners].forEach((fn) => fn(ev)),
  };
}

after(() => {
  delete globalThis.window; // node 环境无 window；避免影响同进程其他测试文件
});

// ---- 握手：一次性 token（BUG-16）----

test("init 错/缺 token → 拒绝（不回 hello），diag 留痕且不落 token 值", () => {
  const env = makeEnv("?token=tk-1");
  const got = [];
  const c = new BridgeClient((m) => got.push(m), { mock: false });
  c.start();
  env.fire({ data: { type: "init" }, source: env.fakeHost, ports: [] });
  env.fire({
    data: { type: "init", token: "tk-2" },
    source: env.fakeHost,
    ports: [],
  });
  assert.equal(env.fakeHost.sent.length, 0);
  assert.equal(c.connected, false);
  assert.equal(got.length, 0);
  assert.equal(
    env.win.__claudianDiag.filter((d) => d.includes("init REJECTED")).length,
    2,
  );
  assert.ok(
    !env.win.__claudianDiag.join("\n").includes("tk-"),
    env.win.__claudianDiag,
  );
});

test("页面 URL 无 token（裸 URL）→ 一切 init 拒绝（无信任根，不放行）", () => {
  const env = makeEnv("");
  const c = new BridgeClient(() => {}, { mock: false });
  c.start();
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: env.fakeHost,
    ports: [],
  });
  assert.equal(env.fakeHost.sent.length, 0);
  assert.equal(c.connected, false);
});

test("init token 正确但无回发通道（无端口无 source）→ 丢 + diag，不崩", () => {
  const env = makeEnv();
  const c = new BridgeClient(() => {}, { mock: false });
  c.start();
  env.fire({ data: { type: "init", token: "tk-1" }, source: null, ports: [] });
  assert.equal(env.fakeHost.sent.length, 0);
  assert.equal(c.connected, false);
  assert.ok(
    env.win.__claudianDiag.some((d) => d.includes("without reply channel")),
  );
});

// ---- 回发通道与来源过滤 ----

test("source 回退路径：hello 带 token 回发、outbox 冲出、后续消息按来源过滤", () => {
  const env = makeEnv();
  const got = [];
  const c = new BridgeClient((m) => got.push(m), { mock: false });
  c.start();
  c.send({ type: "getHistory", sessionId: "s" }); // 握手前 → outbox
  assert.equal(env.fakeHost.sent.length, 0);
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: env.fakeHost,
    ports: [],
  });
  const hello = env.fakeHost.sent.find((s) => s.m.type === "hello");
  assert.ok(hello);
  assert.equal(hello.m.token, "tk-1");
  assert.ok(env.fakeHost.sent.some((s) => s.m.type === "getHistory")); // outbox 已冲出
  assert.equal(c.connected, true);
  // 外来来源的会话消息 → 丢弃，不投递 reducer
  env.fire({
    data: { type: "sessionList", sessions: [] },
    source: env.other,
    ports: [],
  });
  assert.equal(got.length, 0);
  assert.ok(env.win.__claudianDiag.some((d) => d.includes("source mismatch")));
  // 握手来源 → 投递
  env.fire({
    data: { type: "sessionList", sessions: [] },
    source: env.fakeHost,
    ports: [],
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "sessionList");
});

test("端口优先：init 带 port → source 为 null 也能握手；外来 source 的消息仍丢弃", () => {
  const env = makeEnv();
  const got = [];
  const c = new BridgeClient((m) => got.push(m), { mock: false });
  c.start();
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: null,
    ports: [env.port],
  });
  assert.ok(env.port.sent.some((m) => m.type === "hello"));
  assert.equal(c.connected, true);
  // hostSource 保持 init 事件的值（null）：端口模式下 source=null 的消息照常投递（hostSource 语义仅对窗口路径有意）
  env.fire({
    data: { type: "sessionList", sessions: [] },
    source: null,
    ports: [],
  });
  assert.equal(got.length, 1);
  // 端口模式下外来窗口发消息 → 丢
  got.length = 0;
  env.fire({
    data: { type: "sessionList", sessions: [] },
    source: env.other,
    ports: [],
  });
  assert.equal(got.length, 0);
});

test("重复 init（页面 reload 语义）→ 幂等重握手：再次回 hello", () => {
  const env = makeEnv();
  const c = new BridgeClient(() => {}, { mock: false });
  c.start();
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: env.fakeHost,
    ports: [],
  });
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: env.fakeHost,
    ports: [],
  });
  assert.equal(env.fakeHost.sent.filter((s) => s.m.type === "hello").length, 2);
});

test("destroy → 摘监听、不再握手、不再发送", () => {
  const env = makeEnv();
  const got = [];
  const c = new BridgeClient((m) => got.push(m), { mock: false });
  c.start();
  c.destroy();
  assert.equal(env.listeners.length, 0); // 监听器已摘
  env.fire({
    data: { type: "init", token: "tk-1" },
    source: env.fakeHost,
    ports: [],
  });
  c.send({ type: "getState" });
  assert.equal(env.fakeHost.sent.length, 0);
  assert.equal(got.length, 0);
});

test("mock 模式：跳过 token 校验仍走 hello（仅开发环境；chrome:// 页永不进入）", () => {
  const env = makeEnv("");
  const c = new BridgeClient(() => {}, { mock: true });
  c.start();
  env.fire({ data: { type: "init" }, source: env.fakeHost, ports: [] });
  assert.ok(env.fakeHost.sent.some((s) => s.m.type === "hello"));
});

test("非法载荷（字符串/null/数组/无 type）→ 静默忽略不抛", () => {
  const env = makeEnv();
  const c = new BridgeClient(() => {}, { mock: false });
  c.start();
  assert.doesNotThrow(() => {
    env.fire({ data: "string", source: env.fakeHost, ports: [] });
    env.fire({ data: null, source: env.fakeHost, ports: [] });
    env.fire({ data: [1, 2], source: env.fakeHost, ports: [] });
    env.fire({ data: { noType: 1 }, source: env.fakeHost, ports: [] });
  });
});

// ---- N3/N4 回归：排障/发送兜底不得反噬协议 ----

test("N3: ev.source 为 revoked proxy（读原型即抛）→ diagEvent 兜底，消息处理不中断", () => {
  const env = makeEnv();
  const got = [];
  const c = new BridgeClient((m) => got.push(m), { mock: false });
  c.start();
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  // 前置：确认这类来源确实「一读就抛」（否则本用例测不到兜底）
  assert.throws(() => Object.prototype.toString.call(revocable.proxy));
  assert.doesNotThrow(() =>
    env.fire({
      data: { type: "sessionList" },
      source: revocable.proxy,
      ports: [],
    }),
  );
  assert.equal(got.length, 0); // 未握手来源仍被丢
  const last = env.win.__claudianDiag.at(-1);
  assert.ok(last.includes("drop sessionList"), last);
  assert.ok(last.includes("diagEvent failed"), last); // 占位串有留痕，不是静默
});

test("N4: source 回退路径 postMessage 抛错（死窗口）→ hello 与 outbox 不中断，逐条记 diag", () => {
  const env = makeEnv();
  const c = new BridgeClient(() => {}, { mock: false });
  c.start();
  c.send({ type: "getHistory", sessionId: "s" }); // 握手前 → outbox
  let attempts = 0;
  const deadHost = {
    postMessage: () => {
      attempts++;
      throw new Error("dead window");
    },
  };
  assert.doesNotThrow(() =>
    env.fire({
      data: { type: "init", token: "tk-1" },
      source: deadHost,
      ports: [],
    }),
  );
  // hello 一次 + outbox（getHistory）一次：首条抛错不能吞掉后续消息（旧实现该次 init 直接中断，attempts=1）
  assert.equal(attempts, 2);
  const failed = env.win.__claudianDiag.filter((d) =>
    d.includes("FAILED via source"),
  );
  assert.equal(failed.length, 2);
  assert.ok(failed[0].includes("hello"));
  assert.ok(failed[1].includes("getHistory"));
});
