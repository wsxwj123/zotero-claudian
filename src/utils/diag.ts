// diag.ts — R9「/diag 诊断报告」**纯逻辑**（宿主采集事实 → 这里拼文本，单测主战场）。
//
// 为什么（用户原话 2026-09-11）：真机验证不该是「逐项人工核对」——让用户（尤其 Windows）
// 一条命令产出一段可粘贴的报告，把排障降成「贴一段输出」。
//
// 两条红线（本文件的职责）：
//  1. **绝不输出密钥/令牌**：报告只打印 DIAG_KEYS 白名单里的行（输入里其它键一律不出现），
//     且每个值都过 redactValue——疑似 secret 的键名只写 set/unset。
//  2. **降级不抛**：任一字段拿不到 → `(error: 原因)`，报告整体照出（宿主侧采集同样逐项兜底）。

/** 报告首行（固定，便于粘贴时一眼认出） */
export const DIAG_HEADER = "=== claudian diag ===";

/**
 * 标签列宽（`time:` 后补空格到这一列再写值）：等宽对齐，粘贴到聊天/issue 里不散架。
 * 17 = 最长标签 `sessionFile:`(12) + 余量，与 PLAN-R9 样例逐字一致。
 */
export const DIAG_LABEL_WIDTH = 17;

/**
 * 单值长度上限：截断只是防「PATH 级长串」把报告刷爆，不追求无损
 *（超长值本身就是要看的东西，保留前缀足够定位）。
 */
export const DIAG_VALUE_MAX = 300;

/**
 * 报告里会出现的行（**白名单，顺序即输出顺序**）。
 * 红线 1 的落地方式：输入里其它键（`deepseekApiKey`、`ANTHROPIC_AUTH_TOKEN`…）**一律不打印**，
 * 所以「哪个键会进报告」在代码里是可数的，不靠调用方自律。
 */
export const DIAG_KEYS = [
  "time",
  "plugin",
  "zotero",
  "platform",
  "cli",
  "cli.auth",
  // R15：候选清单（本机找到的 claude 都在哪——报障时看它）
  "cli.candidates",
  "workspace",
  "collection",
  "reader",
  "session",
  "sessionFile",
  // R11 复查新增（win32 追加回归的只读判据：只列目录 + stat，不读内容）
  "history",
  "snapshots",
  "journal",
  "prefs",
] as const;

export type DiagKey = (typeof DIAG_KEYS)[number];

/** 单行取值：字符串/数字/布尔 = 正常；null/undefined = 没采集到；`{error}` = 采集失败（原因写明） */
export type DiagValue =
  string | number | boolean | null | undefined | { error: unknown };

/**
 * 采集结果（宿主传入）。已知键见 DIAG_KEYS；**额外键允许存在但不进报告**——
 * 采集面难免夹带 secret（prefs 里的 Key、环境变量里的 ANTHROPIC_*），
 * 白名单是「夹带也不会漏」的保证，而不是「调用方记得别传」的约定。
 */
export interface DiagInput {
  [key: string]: unknown;
}

/**
 * 疑似 secret 的键名。刻意**不含**裸 `auth`：`cli.auth` 是登录态（ok/not-logged-in），
 * 不是凭据；凭据类键名必带 key/token/secret/… 这些词。
 */
const SECRET_KEY_RE = /(key|token|secret|passw|credential|cookie|bearer)/i;

/** 键名是否疑似凭据（导出便于宿主在别处复用同一口径） */
export function isSecretKey(key: unknown): boolean {
  return SECRET_KEY_RE.test(String(key ?? ""));
}

/** 值是否「有」（决定 set/unset；空串/纯空白/null/undefined 都算没设） */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return true;
}

/** 单行化 + 截断（报告格式：一行一条，换行会毁掉键=值 的对齐与 diff） */
function flat(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
  return text.length > DIAG_VALUE_MAX
    ? `${text.slice(0, DIAG_VALUE_MAX)}…`
    : text;
}

/**
 * 单值脱敏（纯函数）：
 * - 疑似 secret 的键 → 只回 `set`/`unset`，**值一律不出现**（报告的凭据纪律）；
 * - 其余键 → 单行化 + 超长截断。
 */
export function redactValue(key: string, value: unknown): string {
  if (isSecretKey(key)) {
    return hasValue(value) ? "set" : "unset";
  }
  if (value !== null && typeof value === "object" && "error" in value) {
    const reason = flat((value as { error: unknown }).error);
    return `(error: ${reason || "未知原因"})`;
  }
  return flat(value);
}

/** 一行：`标签补空格到 DIAG_LABEL_WIDTH + 值`；缺字段 → (error: 未采集) */
export function formatDiagLine(key: string, value: unknown): string {
  const label = `${key}:`.padEnd(DIAG_LABEL_WIDTH, " ");
  if (value === undefined || value === null) {
    return `${label}(error: 未采集)`;
  }
  return `${label}${redactValue(key, value)}`;
}

/**
 * 报告生成（纯字符串拼接，无模板引擎）：DIAG_KEYS 顺序逐行输出，键=值、每行一条。
 * 输入里的额外键（含疑似 secret）不打印；缺字段写 `(error: 未采集)`；单项错误写 `(error: 原因)`。
 */
export function buildDiagReport(input: DiagInput): string {
  const facts = input ?? {};
  return [
    DIAG_HEADER,
    ...DIAG_KEYS.map((key) => formatDiagLine(key, facts[key])),
  ].join("\n");
}

/**
 * 插件声明的 Zotero 版本兼容区间（manifest `strict_min_version~strict_max_version`）。
 * 值必须与 addon/manifest.json 逐字一致（单测对照该文件，防两处漂移）——运行时读不到完整
 * 安装 manifest（沙箱内没有 AddonManager 面），故在此定格为常量。
 */
export const ZOTERO_SUPPORT_RANGE = "6.999~99.*";
