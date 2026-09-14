// npmPrefix.ts — R15 F4：npm 全局 prefix 目录（纯函数）。
//
// 为什么需要它（PLAN-R15 RC3）：`npm config set prefix D:\npm-global` 是「装成功但检测不到」
// 的经典原因——npm 不把自定义 prefix 写进 PATH。不 spawn `npm config get prefix`（win32 上
// npm 是 .cmd，要走 cmd.exe 派发 + 超时 + 输出解析），改为读它写下的那份配置：
// `%USERPROFILE%\.npmrc` 的 `prefix=` 行 + `npm_config_prefix` 环境变量 + 默认 `%APPDATA%\npm`。
//
// 每一处 prefix 除 `prefix\claude.exe` / `prefix\claude.cmd` 外，还要直扫包内真二进制
// `prefix\node_modules\@anthropic-ai\claude-code\bin\claude.exe`——shim 断链 / 被杀软隔离时
// 这条仍能命中（与 cliDetect 既有 resolvePkgExe 同款理由）。

/** 路径是否 Windows 绝对路径（`X:\` 或 UNC `\\`） */
function isAbsWinPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"')
    ? t.slice(1, -1).trim()
    : t;
}

/**
 * `.npmrc` 文本 → prefix 值（纯函数）。语义与 npm 一致：后出现的覆盖先出现的；
 * `#`/`;` 开头的行是注释；相对路径丢弃（npm 会按 cwd 解析，不可预测）。
 */
export function parseNpmrcPrefix(text: string): string {
  let prefix = "";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    if (line.slice(0, eq).trim().toLowerCase() !== "prefix") {
      continue;
    }
    prefix = unquote(line.slice(eq + 1));
  }
  return isAbsWinPath(prefix) ? prefix : "";
}

/**
 * 汇总 npm 全局 prefix 目录（去重、保序：环境变量 → .npmrc → 默认位置）。
 * 空串/非绝对路径一律不进列。
 */
export function resolveNpmPrefixDirs(input: {
  npmrcText?: string;
  envPrefix?: string;
  appData?: string;
}): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    const v = unquote(p ?? "");
    if (
      isAbsWinPath(v) &&
      !out.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      out.push(v);
    }
  };
  push(input.envPrefix ?? "");
  push(parseNpmrcPrefix(input.npmrcText ?? ""));
  const appData = (input.appData ?? "").trim();
  if (appData) {
    push(`${appData.replace(/[\\/]+$/, "")}\\npm`);
  }
  return out;
}
