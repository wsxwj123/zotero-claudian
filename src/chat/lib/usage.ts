// usage.ts — R4-3 用量纯函数（PLAN-R4 §4）：缓存命中率 / token 人类可读格式化 / 累加。
// 无 DOM、无 Preact、无 Zotero 依赖：前端 bundle 与宿主（会话索引聚合）共用，node:test 直接跑。

/** 一轮 / 一个会话的 token 用量（协议层 snake_case → 此形态，PLAN-R4 §4） */
export interface UsageStats {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

/** 全 0 用量（缺省 / 无数据） */
export const EMPTY_USAGE: UsageStats = {
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
};

/** 形态校验（索引反序列化与 sessionList 归一用；不合法 → 调用方按「无数据」处理） */
export function isUsageStats(v: unknown): v is UsageStats {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const u = v as Record<string, unknown>;
  return (
    typeof u.input === "number" &&
    Number.isFinite(u.input) &&
    typeof u.cacheRead === "number" &&
    Number.isFinite(u.cacheRead) &&
    typeof u.cacheCreation === "number" &&
    Number.isFinite(u.cacheCreation) &&
    typeof u.output === "number" &&
    Number.isFinite(u.output)
  );
}

/**
 * 缓存命中率（契约公式，测试锁定）：
 *   cacheRead / (input + cacheRead + cacheCreation) * 100，Math.round；output 不进分母。
 * 分母 0 → null；字段缺失/非有限数字/入参整体缺失 → null（UI 据此**不显示**该段，不显示 0%）。
 * 永不抛。
 */
export function cacheHitPercent(
  u: UsageStats | null | undefined,
): number | null {
  if (!isUsageStats(u)) {
    return null;
  }
  const denom = u.input + u.cacheRead + u.cacheCreation;
  if (denom === 0) {
    return null;
  }
  return Math.round((u.cacheRead / denom) * 100);
}

/**
 * token 数人类可读（顶栏紧凑显示）：< 1000 原样整数；K/M 各一档、一位小数（整数去 `.0`）；
 * 三位数以上不带小数（119040 → "119K"）。非数字/负数 → "0"。
 */
export function formatTokens(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  const [div, suffix] = n < 1_000_000 ? [1000, "K"] : [1_000_000, "M"];
  const v = n / div;
  const text =
    v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text}${suffix}`;
}

/** 累加（宿主聚合：turn 用量累进会话累计）。null/缺省按 0 处理，永不抛。 */
export function addUsage(
  a: UsageStats | null | undefined,
  b: UsageStats | null | undefined,
): UsageStats {
  const x = isUsageStats(a) ? a : EMPTY_USAGE;
  const y = isUsageStats(b) ? b : EMPTY_USAGE;
  return {
    input: x.input + y.input,
    cacheRead: x.cacheRead + y.cacheRead,
    cacheCreation: x.cacheCreation + y.cacheCreation,
    output: x.output + y.output,
  };
}

/** 全 0 判定（UI：全 0 → 整行不显示）。缺失/畸形视为全 0。 */
export function isZeroUsage(u: UsageStats | null | undefined): boolean {
  return (
    !isUsageStats(u) ||
    (u.input === 0 &&
      u.cacheRead === 0 &&
      u.cacheCreation === 0 &&
      u.output === 0)
  );
}
