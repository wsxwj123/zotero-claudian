// 单测 — R4-3 自补：fetchBalance 的请求形态/错误分派/凭证纪律 + createBalanceService 的
// 「不认识 provider / 没 Key 就不发请求」与 60s TTL 缓存（PLAN-R4 §4）。
// 契约文件 r4-balance.test.ts 锁 parseBalance/detectProvider；本文件锁「真的会发出去什么、什么时候不发」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BALANCE_TTL_MS,
  BALANCE_URL,
  createBalanceService,
  detectProvider,
  fetchBalance,
  parseClaudeEnv,
  type AbortLike,
  type FetcherLike,
} from "../../src/modules/balance.ts";

const KEY = "sk-super-secret-123";

/** 假 fetcher：记录调用，返回脚本化响应 */
function makeFetcher(
  script: (
    url: string,
    init: Parameters<FetcherLike>[1],
  ) => {
    status: number;
    ok?: boolean;
    body?: string;
    reject?: unknown;
    hang?: boolean;
  },
) {
  const calls: { url: string; init: Parameters<FetcherLike>[1] }[] = [];
  const fetcher: FetcherLike = async (url, init) => {
    calls.push({ url, init });
    const r = script(url, init);
    if (r.reject) {
      throw r.reject;
    }
    if (r.hang) {
      // 永不返回，除非被 abort（与真 fetch 的 signal 语义一致）
      return new Promise((_, reject) => {
        const signal = init.signal as {
          addEventListener?: (t: string, fn: () => void) => void;
        } | null;
        signal?.addEventListener?.("abort", () =>
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            }),
          ),
        );
      });
    }
    const status = r.status;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => r.body ?? "",
    };
  };
  return { fetcher, calls };
}

const okBody = JSON.stringify({
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
});

// ---- fetchBalance：请求形态 ----

test("fetchBalance: GET 契约地址 + Bearer/Accept 头（唯一出网目标）", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: okBody }));
  const r = await fetchBalance({ fetcher }, KEY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BALANCE_URL);
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.currency, "CNY");
  assert.equal(r.ok && r.total, "110.00");
});

test("fetchBalance: 401/403 → 「Key 无效或未开通余额查询」（两码同文案）", async () => {
  for (const status of [401, 403]) {
    const { fetcher } = makeFetcher(() => ({
      status,
      body: '{"error":"auth"}',
    }));
    const r = await fetchBalance({ fetcher }, KEY);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "Key 无效或未开通余额查询");
  }
});

test("fetchBalance: 其余非 2xx → 失败且带状态码；响应体截断且不含 Key", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 502,
    body: "<html>502 Bad Gateway</html>",
  }));
  const r = await fetchBalance({ fetcher }, KEY);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /502/);
  assert.ok(!(r.ok === false && r.reason.includes(KEY)), "错误消息回显了 Key");
});

test("fetchBalance: 2xx 但无 balance_infos → 失败（不在解析层抛）", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: JSON.stringify({ is_available: true }),
  }));
  const r = await fetchBalance({ fetcher }, KEY);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.reason.length > 0);
});

test("fetchBalance: 网络异常 → ok:false 不抛；超时（abort）→ 文案含「超时」且 abort 被调用", async () => {
  const netErr = new TypeError(
    "NetworkError when attempting to fetch resource.",
  );
  const r1 = await fetchBalance(
    { fetcher: makeFetcher(() => ({ status: 0, reject: netErr })).fetcher },
    KEY,
  );
  assert.equal(r1.ok, false);
  assert.match(r1.ok === false ? r1.reason : "", /网络错误/);

  // 超时：用真实 AbortController（node 有该全局）走默认路径——假 fetcher 挂在 signal 上等 abort
  let abortedBySignal = false;
  const real: AbortLike = (() => {
    const c = new AbortController();
    c.signal.addEventListener("abort", () => (abortedBySignal = true));
    return c;
  })();
  const r2 = await fetchBalance(
    {
      fetcher: makeFetcher(() => ({ status: 0, hang: true })).fetcher,
      newAbortController: () => real,
      timeoutMs: 5,
    },
    KEY,
  );
  assert.equal(abortedBySignal, true, "超时未 abort 请求");
  assert.equal(r2.ok, false);
  assert.match(r2.ok === false ? r2.reason : "", /超时/);
});

test("fetchBalance: 响应体里出现 Key（异常回显）→ 错误消息被擦除（凭证纪律）", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 500,
    body: `bad key: ${KEY}`,
  }));
  const r = await fetchBalance({ fetcher }, KEY);
  assert.equal(r.ok, false);
  assert.ok(
    !(r.ok === false && r.reason.includes(KEY)),
    "错误消息里带出了 Key",
  );
  assert.match(r.ok === false ? r.reason : "", /\*\*\*/);
});

// 复查修-5：2xx 但解析失败（reason 带响应体截断片段）同样要擦除 Key——此前只有非 2xx 的
// fail() 有这一道，解析路径漏了；reason 会进 Zotero.debug 与顶栏 tooltip
test("复查修-5: 2xx 解析失败且响应体回显 Key → UI reason 与宿主日志都不含 Key", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: `key=${KEY} 不是 JSON`,
  }));
  const logs: string[] = [];
  const svc = createBalanceService({
    provider: () => "deepseek",
    getKey: () => KEY,
    fetcher,
    log: (m) => logs.push(m),
  });
  const r = await svc.get(false);
  assert.equal(r.balance.state, "error");
  const reason = r.balance.state === "error" ? r.balance.reason : "";
  assert.ok(!reason.includes(KEY), "解析失败的 reason 回显了 Key");
  assert.match(reason, /\*\*\*/, "没有走擦除（reason 未出现 ***）");
  assert.ok(!logs.some((l) => l.includes(KEY)), "宿主日志带出了 Key");
});

test("fetchBalance: 空 key → 不请求、直接失败", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: okBody }));
  for (const k of ["", "   "]) {
    const r = await fetchBalance({ fetcher }, k);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0, "空 Key 仍发出了请求");
});

test("fetchBalance: AbortController 不可用（沙箱）→ 不抛，照常请求", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: okBody }));
  const r = await fetchBalance(
    { fetcher, newAbortController: () => null },
    KEY,
  );
  assert.equal(r.ok, true);
});

// ---- createBalanceService：什么时候不发请求 ----

test("service: provider=unknown → unsupported 态且**零请求**", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: okBody }));
  const svc = createBalanceService({
    provider: () => "unknown",
    getKey: () => KEY,
    fetcher,
  });
  const r = await svc.get(false);
  assert.deepEqual(r, {
    provider: "unknown",
    balance: { state: "unsupported" },
  });
  assert.equal(calls.length, 0);
});

test("service: deepseek 但未填 Key → nokey 态且**零请求**（getKey 之外的都不看）", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: okBody }));
  const svc = createBalanceService({
    provider: () => "deepseek",
    getKey: () => "",
    fetcher,
  });
  const r = await svc.get(false);
  assert.deepEqual(r, { provider: "deepseek", balance: { state: "nokey" } });
  assert.equal(calls.length, 0);
});

test("service: deepseek + Key → 查一次并返回 ok；60s 内再取走缓存（不再请求）", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: okBody }));
  let nowMs = 1_000_000;
  const svc = createBalanceService({
    provider: () => "deepseek",
    getKey: () => KEY,
    fetcher,
    now: () => nowMs,
  });
  const a = await svc.get(false);
  assert.deepEqual(a.balance, {
    state: "ok",
    currency: "CNY",
    total: "110.00",
    all: [{ currency: "CNY", total: "110.00" }],
  });
  assert.equal(calls.length, 1);

  nowMs += BALANCE_TTL_MS - 1;
  await svc.get(false);
  assert.equal(calls.length, 1, "TTL 内重复请求了 api.deepseek.com");

  nowMs += 2; // 过期
  await svc.get(false);
  assert.equal(calls.length, 2, "TTL 过期后未重查");

  await svc.get(true); // force 绕过
  assert.equal(calls.length, 3, "手动刷新未绕过 TTL");
});

test("service: 多实例同时打开（并发 get）→ 只发一次请求（在途去重）", async () => {
  let release: () => void = () => {};
  const calls: number[] = [];
  const fetcher: FetcherLike = async () => {
    calls.push(1);
    return new Promise((res) => {
      release = () => res({ ok: true, status: 200, text: async () => okBody });
    });
  };
  const svc = createBalanceService({
    provider: () => "deepseek",
    getKey: () => KEY,
    fetcher,
  });
  const p1 = svc.get(false);
  const p2 = svc.get(false);
  const p3 = svc.get(false);
  // provider() 的 await 是微任务：等一个宏任务让 fetch 真正发起
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, "并发打开发了多次请求");
  release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);
  assert.equal(calls.length, 1);
});

test("service: 失败也返回结果对象（不抛）——provider 抛错按 unknown 兜底", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: okBody }));
  const boom = createBalanceService({
    provider: () => {
      throw new Error("settings read exploded");
    },
    getKey: () => KEY,
    fetcher,
  });
  const r = await boom.get(false);
  assert.equal(r.provider, "unknown");
  assert.deepEqual(r.balance, { state: "unsupported" });
});

// ---- parseClaudeEnv（provider 数据源之一） ----

test("parseClaudeEnv: 取 env 下两个键；缺/坏/非对象 → null 不抛", () => {
  assert.deepEqual(
    parseClaudeEnv(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8799",
          ANTHROPIC_MODEL: "deepseek-flash",
        },
        other: 1,
      }),
    ),
    { baseUrl: "http://127.0.0.1:8799", model: "deepseek-flash" },
  );
  assert.deepEqual(parseClaudeEnv(JSON.stringify({ env: {} })), {
    baseUrl: null,
    model: null,
  });
  for (const raw of [
    null,
    "",
    "   ",
    "not json",
    "[1]",
    JSON.stringify({ env: 5 }),
  ]) {
    assert.doesNotThrow(() => parseClaudeEnv(raw as string));
    assert.deepEqual(parseClaudeEnv(raw as string), {
      baseUrl: null,
      model: null,
    });
  }
});

// ---- UTF-8 BOM（WIN-COMPAT-R4 建议 1：Windows 记事本「UTF-8 带 BOM」另存的 settings.json）----
// 修复前：BOM 让 JSON.parse 抛 → 静默 catch → provider 误判 unknown → 顶栏「不支持余额查询」，用户无从排查。

test("parseClaudeEnv: 带 BOM 的正常 settings.json → 照常解析出 env（剥 BOM 再 parse）", () => {
  const raw =
    "\uFEFF" +
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-chat",
      },
    });
  assert.deepEqual(parseClaudeEnv(raw), {
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-chat",
  });
});

test("provider 判定：带 BOM 的 settings.json + 无进程 env → 'deepseek'（修复前静默误判 unknown）", () => {
  const raw =
    "\uFEFF" +
    JSON.stringify({ env: { ANTHROPIC_MODEL: "deepseek-reasoner" } });
  const env = parseClaudeEnv(raw);
  assert.equal(
    detectProvider({ baseUrl: env.baseUrl, model: env.model }),
    "deepseek",
  );
});

test("parseClaudeEnv: 纯 BOM / BOM+空白 / BOM+畸形 JSON → null 不抛，provider 不猜（unknown）", () => {
  for (const raw of [
    "\uFEFF",
    "\uFEFF   \n",
    "\uFEFFnot json",
    "\uFEFF[1]",
    "\uFEFF{}",
  ]) {
    let got: ReturnType<typeof parseClaudeEnv>;
    assert.doesNotThrow(() => {
      got = parseClaudeEnv(raw);
    }, JSON.stringify(raw));
    assert.deepEqual(got!, { baseUrl: null, model: null }, JSON.stringify(raw));
    assert.equal(
      detectProvider({ baseUrl: got!.baseUrl, model: got!.model }),
      "unknown",
      JSON.stringify(raw),
    );
  }
});
