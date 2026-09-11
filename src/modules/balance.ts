// balance.ts — R4-3：DeepSeek 余额查询（PLAN-R4 §4）。
// 纯逻辑 + 依赖注入（fetcher / provider / key / now / log 全从外部给）：node:test 直接跑，
// 宿主侧真实接线见 modules/sections.ts。
//
// 凭证纪律（PLAN-R4 §4）：key 只来自 prefs、只发给 api.deepseek.com；不进任何日志、会话文件、
// 错误消息（失败原因里的响应体截断，且再做一次 key 擦除兜底）。

import type { BalanceProvider, BalanceState } from "../chat/lib/types";

/** 余额接口（契约地址，唯一出网目标） */
export const BALANCE_URL = "https://api.deepseek.com/user/balance";
/** 查询超时（PLAN-R4 §4：15s） */
export const BALANCE_TIMEOUT_MS = 15_000;
/** 结果缓存时长（PLAN-R4 §4：60s TTL；手动刷新绕过） */
export const BALANCE_TTL_MS = 60_000;

const REASON_BODY_MAX = 120;

export interface BalanceEntry {
  currency: string;
  total: string;
}

export type BalanceResult =
  | { ok: true; currency: string; total: string; all: BalanceEntry[] }
  | { ok: false; reason: string };

/** 响应体截断：不原样回显整段 body（测试锁定：reason 明显短于 body） */
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REASON_BODY_MAX
    ? `${flat.slice(0, REASON_BODY_MAX)}…`
    : flat;
}

/** 兜底擦除：任何要落日志/回显的文本都要过一遍（凭证纪律最后一道防线） */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("***") : text;
}

/**
 * 余额响应解析（契约函数，测试锁定）：入参是 HTTP 响应**文本**（裁决 A2），
 * 传对象/数组/null 等一律按畸形处理（ok:false），永不抛。
 * 形态：`{ balance_infos: [{ currency, total_balance }] }`；多币种取第一条并全量保留在 all。
 */
export function parseBalance(body: string): BalanceResult {
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, reason: "响应为空" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: `响应不是合法 JSON：${truncate(body)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `响应不是 JSON 对象：${truncate(body)}` };
  }
  const infos = (parsed as Record<string, unknown>).balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return {
      ok: false,
      reason: "响应无 balance_infos（Key 无效或未开通余额查询）",
    };
  }
  const all: BalanceEntry[] = [];
  for (const entry of infos) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const rawTotal = rec.total_balance;
    const total =
      typeof rawTotal === "string"
        ? rawTotal
        : typeof rawTotal === "number" && Number.isFinite(rawTotal)
          ? String(rawTotal)
          : null;
    if (total === null) {
      continue; // 没有可显示的数字 → 该条不算数（首条即此情况 → 整体失败）
    }
    all.push({
      currency: typeof rec.currency === "string" ? rec.currency : "",
      total,
    });
  }
  if (all.length === 0) {
    return { ok: false, reason: "响应无可显示的余额数字（缺 total_balance）" };
  }
  return { ok: true, currency: all[0].currency, total: all[0].total, all };
}

/**
 * provider 判定（契约函数，测试锁定）：baseUrl 或 model（大小写不敏感）含 'deepseek' → 'deepseek'，
 * 否则 'unknown'（不猜）。非字符串/缺字段/入参整体缺失 → 'unknown'，永不抛。
 */
export function detectProvider(input: {
  baseUrl?: unknown;
  model?: unknown;
}): BalanceProvider {
  const rec =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  for (const v of [rec.baseUrl, rec.model]) {
    if (typeof v === "string" && v.toLowerCase().includes("deepseek")) {
      return "deepseek";
    }
  }
  return "unknown";
}

/**
 * `~/.claude/settings.json` 的 env 对象解析（纯函数；读文件由宿主做，失败一律 unknown 不抛）。
 * 只认 ANTHROPIC_BASE_URL / ANTHROPIC_MODEL 两个键。
 */
export function parseClaudeEnv(raw: string | null): {
  baseUrl: string | null;
  model: string | null;
} {
  const empty = { baseUrl: null, model: null };
  if (typeof raw !== "string" || !raw.trim()) {
    return empty;
  }
  let parsed: unknown;
  try {
    // 先剥 UTF-8 BOM（\uFEFF）：Windows 记事本「UTF-8 带 BOM」另存的 settings.json 会带上它，
    // JSON.parse 就此抛错 → 被静默 catch → provider 静默误判 unknown（用户只看到「不支持余额查询」，无从排查）
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return empty;
  }
  const env = (parsed as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null) {
    return empty;
  }
  const rec = env as Record<string, unknown>;
  return {
    baseUrl:
      typeof rec.ANTHROPIC_BASE_URL === "string"
        ? rec.ANTHROPIC_BASE_URL
        : null,
    model: typeof rec.ANTHROPIC_MODEL === "string" ? rec.ANTHROPIC_MODEL : null,
  };
}

/** fetch 的最小形态（只用到这些成员；注入假 fetcher 单测用） */
export type FetcherLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: unknown;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** AbortController 最小形态（沙箱作用域可能没有该全局 → 宿主注入主窗口的构造器） */
export interface AbortLike {
  signal: unknown;
  abort(): void;
}

export interface BalanceFetchDeps {
  fetcher: FetcherLike;
  /** 缺省取运行作用域的 AbortController；取不到 → 无超时（不抛） */
  newAbortController?: () => AbortLike | null;
  timeoutMs?: number;
  log?: (message: string) => void;
}

function defaultAbortController(): AbortLike | null {
  const Ctor = (globalThis as { AbortController?: new () => AbortLike })
    .AbortController;
  try {
    return typeof Ctor === "function" ? new Ctor() : null;
  } catch {
    return null;
  }
}

/**
 * 查余额（GET api.deepseek.com/user/balance）。**永不抛**：一切失败都归到 ok:false + reason。
 * 401/403 → 「Key 无效或未开通余额查询」；其余非 2xx / 网络错 / 超时 → 失败（响应体截断、key 擦除）。
 */
export async function fetchBalance(
  deps: BalanceFetchDeps,
  key: string,
): Promise<BalanceResult> {
  const timeoutMs = deps.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const log = deps.log ?? (() => {});
  const makeAbort = deps.newAbortController ?? defaultAbortController;
  if (typeof key !== "string" || !key.trim()) {
    return { ok: false, reason: "未配置 DeepSeek API Key" };
  }
  let abort: AbortLike | null = null;
  try {
    abort = makeAbort();
  } catch {
    abort = null;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (abort) {
    timer = setTimeout(() => {
      try {
        abort?.abort();
      } catch {
        // abort 失败无所谓：等 fetch 自己收尾
      }
    }, timeoutMs);
  }
  const fail = (reason: string): BalanceResult => ({
    ok: false,
    reason: redact(reason, key),
  });
  try {
    const res = await deps.fetcher(BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      ...(abort ? { signal: abort.signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      return fail("Key 无效或未开通余额查询");
    }
    if (!res.ok) {
      let body = "";
      try {
        body = truncate(await res.text());
      } catch {
        body = "";
      }
      log(`[balance] HTTP ${res.status}`);
      return fail(
        `余额查询失败（HTTP ${res.status}）${body ? `：${body}` : ""}`,
      );
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      return fail(`余额查询失败（响应读取失败）：${String(err)}`);
    }
    // 复查修-5：解析失败的 reason 可能带响应体截断片段（非 2xx 走 fail() 已擦除，这条 2xx
    // 路径此前漏了）——同样过一遍 key 擦除，日志与 UI tooltip 都不该带出凭证
    const parsed = parseBalance(text);
    return parsed.ok ? parsed : fail(parsed.reason);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || /abort/i.test(message)) {
      return fail(`余额查询超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    return fail(`余额查询失败（网络错误）：${message}`);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

// ---- 查询编排（provider/key 判定 + 60s TTL 缓存 + 在途去重）----

export interface BalanceServiceDeps {
  /** provider 判定（宿主：settings.json 的 env + 进程 env；读失败 → 'unknown'） */
  provider: () => Promise<BalanceProvider> | BalanceProvider;
  /** 只在 provider==='deepseek' 时被调用（prefs 里的 Key；空 = 不启用） */
  getKey: () => string;
  fetcher: FetcherLike;
  newAbortController?: () => AbortLike | null;
  timeoutMs?: number;
  now?: () => number;
  ttlMs?: number;
  log?: (message: string) => void;
}

export interface BalanceService {
  /**
   * 取余额状态。force=true = 顶栏手动刷新（绕过 TTL）。
   * provider 非 deepseek / 未填 Key → 直接返回说明态，**不发任何请求**（测试锁定）。
   */
  get(force: boolean): Promise<BalanceStatusLike>;
}

/** 与 chat/lib/types.ts 的 BalanceStatus 同形（此处只依赖结构，避免宿主↔UI 类型的运行期耦合） */
export interface BalanceStatusLike {
  provider: BalanceProvider;
  balance: BalanceState;
}

export function createBalanceService(deps: BalanceServiceDeps): BalanceService {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? BALANCE_TTL_MS;
  const log = deps.log ?? (() => {});
  let cache: { at: number; value: BalanceStatusLike } | null = null;
  let inflight: Promise<BalanceStatusLike> | null = null;

  async function load(): Promise<BalanceStatusLike> {
    const provider = await deps.provider();
    if (provider !== "deepseek") {
      // 不猜、不请求：非 deepseek 的余额端点在别处（PLAN-R4 §4）
      log("[balance] provider!=deepseek → 不查询（无请求）");
      return { provider, balance: { state: "unsupported" } };
    }
    const key = deps.getKey();
    if (!key || !key.trim()) {
      log("[balance] 未配置 Key → 不查询（无请求）");
      return { provider, balance: { state: "nokey" } };
    }
    const result = await fetchBalance(
      {
        fetcher: deps.fetcher,
        newAbortController: deps.newAbortController,
        timeoutMs: deps.timeoutMs,
        log,
      },
      key,
    );
    log(
      result.ok
        ? `[balance] ok currency=${result.currency}`
        : `[balance] failed: ${result.reason}`,
    );
    return {
      provider,
      balance: result.ok
        ? {
            state: "ok",
            currency: result.currency,
            total: result.total,
            all: result.all,
          }
        : { state: "error", reason: result.reason },
    };
  }

  return {
    async get(force: boolean): Promise<BalanceStatusLike> {
      if (!force && cache && now() - cache.at < ttlMs) {
        return cache.value;
      }
      // 在途去重：多实例（dock/侧栏/全页）同时 hello 时只发一次请求
      inflight ??= load()
        .catch((err: unknown) => {
          log(`[balance] unexpected failure: ${String(err)}`);
          return {
            provider: "unknown" as const,
            balance: { state: "unsupported" as const },
          };
        })
        .then((value) => {
          cache = { at: now(), value };
          inflight = null;
          return value;
        });
      return inflight;
    },
  };
}
