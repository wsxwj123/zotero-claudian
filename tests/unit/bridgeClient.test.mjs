// 单测 — src/chat/lib/bridgeClient.ts 纯函数（握手 token 校验 / 消息解析 / mock 判定）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIAG_MAX,
  isTrustedInitToken,
  parseBridgeMessage,
  readOwnToken,
  recordDiag,
  shouldUseMock,
} from "../../src/chat/lib/bridgeClient.ts";

// ---- 真机排障留痕：写入 window.__claudianDiag，超上限丢最早（页面寿命 = 整个 Zotero 会话）----

test("recordDiag: 逐条追加，超过上限丢最早的", () => {
  globalThis.window = { __claudianDiag: [] };
  try {
    for (let i = 0; i < DIAG_MAX + 50; i++) {
      recordDiag(`e${i}`);
    }
    const diag = globalThis.window.__claudianDiag;
    assert.equal(diag.length, DIAG_MAX);
    assert.equal(diag[0], "e50");
    assert.equal(diag[diag.length - 1], `e${DIAG_MAX + 49}`);
  } finally {
    delete globalThis.window;
  }
});

test("recordDiag: 无 window（node 环境）/ 写入抛错 → 静默不抛", () => {
  assert.doesNotThrow(() => recordDiag("no window here"));
  const boom = {
    get __claudianDiag() {
      throw new Error("nope");
    },
  };
  globalThis.window = boom;
  try {
    assert.doesNotThrow(() => recordDiag("write fails"));
  } finally {
    delete globalThis.window;
  }
});

// ---- BUG-16：信任依据 = 页面 URL 上的一次性 token（origin 在 chrome 作用域恒为空串）----

test("BUG-16: readOwnToken 从查询串读出 token；缺失/空 → null", () => {
  assert.equal(readOwnToken("?token=abc123"), "abc123");
  assert.equal(readOwnToken("?mock=1&token=abc123"), "abc123");
  assert.equal(readOwnToken("?token="), null);
  assert.equal(readOwnToken(""), null);
  assert.equal(readOwnToken("?other=1"), null);
});

test("BUG-16: init token 与页面 URL token 一致 → 可信", () => {
  assert.equal(isTrustedInitToken("abc123", "abc123"), true);
});

test("BUG-16: token 不一致 / 缺失 / 空串 / 非字符串 → 拒绝", () => {
  assert.equal(isTrustedInitToken("wrong", "abc123"), false);
  assert.equal(isTrustedInitToken(undefined, "abc123"), false);
  assert.equal(isTrustedInitToken(null, "abc123"), false);
  assert.equal(isTrustedInitToken("", ""), false);
  assert.equal(isTrustedInitToken("", "abc123"), false);
  assert.equal(isTrustedInitToken(42, "abc123"), false);
  // 页面自身无 token（老路径 reload 等）→ 一律拒绝，不放行
  assert.equal(isTrustedInitToken("abc123", null), false);
});

// ---- parseBridgeMessage 回归（原样返回对象，不重建丢字段）----

test("parseBridgeMessage: 校验通过且保留全部字段", () => {
  const msg = {
    type: "streamEvent",
    sessionId: "s1",
    event: { kind: "messageStart" },
  };
  const out = parseBridgeMessage(msg);
  assert.equal(out, msg);
  assert.equal(out.event.kind, "messageStart");
});

test("parseBridgeMessage: 非 JSON 对象/数组/缺 type → null", () => {
  assert.equal(parseBridgeMessage(null), null);
  assert.equal(parseBridgeMessage("str"), null);
  assert.equal(parseBridgeMessage(42), null);
  assert.equal(parseBridgeMessage([1, 2]), null);
  assert.equal(parseBridgeMessage({ noType: 1 }), null);
});

// ---- BUG-11：chrome:// 生产页忽略 ?mock=1 ----

test("BUG-11: chrome:// 协议下 ?mock=1 不触发 mock", () => {
  assert.equal(
    shouldUseMock({ protocol: "chrome:", search: "?mock=1" }),
    false,
  );
  assert.equal(
    shouldUseMock({
      protocol: "chrome:",
      host: "claudian",
      search: "?mock=1&x=2",
    }),
    false,
  );
});

test("BUG-11: chrome:// 无参数 → 不 mock", () => {
  assert.equal(shouldUseMock({ protocol: "chrome:", search: "" }), false);
});

test("BUG-11: 非 chrome:// 环境（file:///dev server）自动 mock", () => {
  assert.equal(shouldUseMock({ protocol: "file:", search: "" }), true);
  assert.equal(shouldUseMock({ protocol: "file:", search: "?mock=1" }), true);
  assert.equal(shouldUseMock({ protocol: "https:", search: "" }), true);
});
