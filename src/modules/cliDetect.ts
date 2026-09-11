// cliDetect.ts — claude 命令发现 / spawn 环境组装 / win32 cmd.exe 派发（PLAN §2.10 A/B 段、INTERFACE §4.1）
// 纯函数，不 import Zotero 全局：所有环境输入（PATH 目录、文件存在性）显式注入，
// node:test 双平台矩阵可跑；win32 真机行为另验（PLAN §6 实测项 6-9）。

import { joinPath } from "../utils/paths";

export type Platform = "darwin" | "win32" | "linux";

/**
 * 派发通道：
 * - direct = argv 直传；
 * - cmd = 经 cmd.exe 派发（win32 仅 .cmd 壳）；
 * - sh = 经 /bin/sh 包装（darwin 专有：先提 fd 上限再 exec，见 DARWIN_FD_RAISE_SCRIPT）。
 *   linux 不在该通道范围（低 fd 上限是 macOS launchd 继承问题；linux 保持 direct）。
 */
export type CliChannel = "direct" | "cmd" | "sh";

/** 命令发现结果：found（direct=argv 直传 / cmd=经 cmd.exe 派发）或 not_found */
export type ResolveCommandResult =
  | {
      status: "found";
      channel: CliChannel;
      path: string;
      source: "override" | "path" | "registry" | "resident";
    }
  | { status: "not_found"; error: "CLAUDE_NOT_FOUND" };

/**
 * win32 npm .cmd 壳 → 包内真实 exe 的探测路径。
 * 真实布局（W-A13 按真包坐实）：`<prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
 * ——package.json 的 `bin` 字段就是 `bin/claude.exe`（install.cjs 注释「Always write to
 * bin/claude.exe」，同一 tarball 三平台共用布局）。此前漏了 `bin` 段 → win32 上恒探不到，
 * 「优先走包内 exe」的设计路径从未成立，永远落回 .cmd 通道。
 * 包内 exe 的有效性靠数值门（MIN_PKG_EXE_BYTES）+ 真机验收，不靠路径猜测。
 */
const NPM_PKG_EXE_SEGMENTS = [
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
];

/** 包内 exe 有效性下限：≥5MB，防下载中断残缺文件（PLAN §2.10 A；fileSize 未注入则只查存在性） */
const MIN_PKG_EXE_BYTES = 5 * 1024 * 1024;

export interface ResolveCommandEnv {
  platform: Platform;
  /** PATH 逐目录（darwin 登录 shell PATH；win32 进程 PATH） */
  pathDirs: string[];
  /** win32 注册表快照 PATH（HKCU/HKLM 合并结果）；darwin 忽略 */
  registryPathDirs?: string[];
  /** 常驻目录兜底（按 OS 序，调用方按 PLAN §2.10 A 表组装） */
  residentDirs?: string[];
  /** 设置项 cliPathOverride；空串 = 自动解析 */
  override?: string;
  /** 文件存在性判断（宿主注入真实 fs；大小写不敏感由宿主保证，win32 NTFS 天然如此） */
  exists: (p: string) => boolean;
  /** 可选：文件字节数（包内 exe ≥5MB 校验用；不注入则跳过该校验） */
  fileSize?: (p: string) => number;
}

/**
 * claude 命令发现（确定性契约，PLAN §2.10 A 表）：
 * - darwin/linux：PATH 逐目录 → 常驻目录兜底；
 * - win32：进程 PATH → 注册表快照 PATH → 常驻目录兜底；同目录 .exe 优先于 .cmd；
 *   .cmd 命中先解析包内 claude.exe（direct 通道），解析失败落 .cmd 壳（cmd 通道）；
 * - override 非空且存在 → 直接采用，不查 PATH；不存在 → 回落自动解析（INTERFACE §4.4）。
 */
export function resolveClaudeCommand(
  env: ResolveCommandEnv,
): ResolveCommandResult {
  if (env.override && env.exists(env.override)) {
    if (env.platform === "win32" && isCmdShell(env.override)) {
      const pkg = resolvePkgExe(env, dirOf(env.override));
      if (pkg) return found("direct", pkg, "override");
      return found("cmd", env.override, "override");
    }
    return found("direct", env.override, "override");
  }

  if (env.platform === "win32") {
    const sources: Array<[string[], "path" | "registry" | "resident"]> = [
      [env.pathDirs, "path"],
      [env.registryPathDirs ?? [], "registry"],
      [env.residentDirs ?? [], "resident"],
    ];
    for (const [dirs, source] of sources) {
      for (const dir of dirs) {
        const exe = joinPath("win32", dir, "claude.exe");
        if (env.exists(exe)) {
          return found("direct", exe, source);
        }
        const cmdShell = joinPath("win32", dir, "claude.cmd");
        if (env.exists(cmdShell)) {
          const pkg = resolvePkgExe(env, dir);
          if (pkg) return found("direct", pkg, source);
          return found("cmd", cmdShell, source);
        }
      }
    }
    return { status: "not_found", error: "CLAUDE_NOT_FOUND" };
  }

  // darwin / linux：POSIX 命令名恒为 claude，argv 直传
  for (const dir of env.pathDirs) {
    const candidate = joinPath(env.platform, dir, "claude");
    if (env.exists(candidate)) {
      return found("direct", candidate, "path");
    }
  }
  for (const dir of env.residentDirs ?? []) {
    const candidate = joinPath(env.platform, dir, "claude");
    if (env.exists(candidate)) {
      return found("direct", candidate, "resident");
    }
  }
  return { status: "not_found", error: "CLAUDE_NOT_FOUND" };
}

function found(
  channel: "direct" | "cmd",
  path: string,
  source: "override" | "path" | "registry" | "resident",
): ResolveCommandResult {
  return { status: "found", channel, path, source };
}

function isCmdShell(p: string): boolean {
  return p.toLowerCase().endsWith(".cmd");
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

/** npm .cmd 壳 → 包内 claude.exe；存在（且注入 fileSize 时 ≥5MB）才返回，否则 null */
function resolvePkgExe(env: ResolveCommandEnv, cmdDir: string): string | null {
  const pkgExe = joinPath("win32", cmdDir, ...NPM_PKG_EXE_SEGMENTS);
  if (!env.exists(pkgExe)) {
    return null;
  }
  if (env.fileSize && env.fileSize(pkgExe) < MIN_PKG_EXE_BYTES) {
    return null;
  }
  return pkgExe;
}

export interface BuildSpawnEnvInput {
  /** 宿主进程环境（原样透传，仅 PATH 覆盖追加） */
  env: Record<string, string>;
  /** darwin：登录 shell PATH 逐目录（整体替换 PATH）；win32：进程 PATH 目录（合并序第二位） */
  shellPathDirs: string[];
  /** win32 注册表快照 PATH 目录（合并序第三位）；darwin 忽略 */
  registryPathDirs?: string[];
  /** win32 常驻目录（合并序第四位）；darwin 忽略 */
  residentDirs?: string[];
}

/**
 * spawn 环境组装（INTERFACE §4.1 env 行）：
 * - darwin：PATH 整体替换为登录 shell PATH（':' 连接），其余透传；
 * - win32：环境键名按大小写不敏感合并、规范键输出（PATH/SystemRoot/TEMP，BUG-02：
 *   杜绝 Path+PATH 双键共存），PATH = 进程 PATH ∪ 注册表快照 ∪ 常驻目录
 *   （';' 连接、首现去重、大小写不敏感），并保证 SystemRoot/TEMP 在环境内（防用户环境残缺，PLAN §2.10 C）。
 * 不改写入参 env，返回新对象。
 */
export function buildSpawnEnv(
  platform: Platform,
  input: BuildSpawnEnvInput,
): Record<string, string> {
  const out: Record<string, string> = { ...input.env };
  if (platform === "win32") {
    normalizeWin32EnvKeys(out);
    const seen = new Set<string>();
    const merged: string[] = [];
    const pushAll = (dirs: string[]) => {
      for (const d of dirs) {
        if (!d) continue;
        const key = d.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(d);
      }
    };
    pushAll((out.PATH || "").split(";"));
    pushAll(input.shellPathDirs);
    pushAll(input.registryPathDirs ?? []);
    pushAll(input.residentDirs ?? []);
    out.PATH = merged.join(";");
    // Node 子进程缺 SystemRoot 会启动异常；透传用户环境天然满足，此处仅防残缺
    if (!("SystemRoot" in out)) {
      out.SystemRoot = "C:\\WINDOWS";
    }
    if (!("TEMP" in out)) {
      out.TEMP = "C:\\WINDOWS\\Temp";
    }
    return out;
  }
  out.PATH = input.shellPathDirs.join(":");
  return out;
}

/** win32 PATH 组装产物：命令发现用的 pathDirs + spawn 环境增量 environment（buildSpawnEnv 产物） */
export interface Win32PathPlan {
  /** 进程 PATH 逐目录（';' 分隔、去空、trim）——resolveClaudeCommand 的 win32 pathDirs 输入 */
  pathDirs: string[];
  /** spawn 环境增量（environmentAppend=true 用）：PATH = 进程 PATH ∪ 注册表快照 ∪ 常驻目录 */
  environment: Record<string, string>;
}

/**
 * win32 的 PATH 组装（M10 走查修复）：**不探测登录 shell**。
 * Zotero 进程无 SHELL，`$SHELL -l -c 'echo $PATH'` 在 win32 恒失败（回落 /bin/zsh 也不存在）
 * → 此前 spawn 环境 PATH 为空串、claude.cmd 里的 node 解析不到（runProbe 同理失明）。
 * 改为：以进程 PATH 为基底，注册表快照（预留参数，本版未接线）+ 常驻目录兜底，
 * 交 buildSpawnEnv 合并（大小写不敏感去重、';' 连接、SystemRoot/TEMP 兜底）。
 * env 传进程环境里 SystemRoot/TEMP 的真值：空串剔除——既防兜底默认值覆盖真实值，
 * 也防空值落进增量环境。
 */
export function buildWin32PathPlan(input: {
  processPath: string;
  env?: Record<string, string>;
  registryPathDirs?: string[];
  residentDirs?: string[];
}): Win32PathPlan {
  const processPath = input.processPath ?? "";
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value) {
      baseEnv[key] = value;
    }
  }
  baseEnv.PATH = processPath;
  const environment = buildSpawnEnv("win32", {
    env: baseEnv,
    shellPathDirs: [], // win32 不依赖 SHELL（此参数是 darwin 的登录 shell 产物）
    registryPathDirs: input.registryPathDirs,
    residentDirs: input.residentDirs,
  });
  const pathDirs = processPath
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  return { pathDirs, environment };
}

/** win32 环境键名规范映射：小写键名 → 规范输出键（其余键保持原形态） */
const WIN32_CANON_ENV_KEYS: Record<string, string> = {
  path: "PATH",
  systemroot: "SystemRoot",
  temp: "TEMP",
};

/**
 * 原地规范化 win32 环境键名：比较一律小写，输出统一规范键。
 * 大小写冲突（如 Path 与 PATH 并存）合并为单键、后值覆盖前值（与对象展开语义一致）。
 */
function normalizeWin32EnvKeys(env: Record<string, string>): void {
  const entries = Object.entries(env); // 先快照键值：改名目标键可能与既有键相撞，直接原地改会丢值
  for (const [k] of entries) {
    delete env[k];
  }
  const byLower = new Map<string, string>(); // 小写键 → 当前输出键名
  for (const [rawKey, value] of entries) {
    const lower = rawKey.toLowerCase();
    const key = WIN32_CANON_ENV_KEYS[lower] ?? rawKey;
    const prevKey = byLower.get(lower);
    if (prevKey !== undefined && prevKey !== key) {
      delete env[prevKey];
    }
    byLower.set(lower, key);
    env[key] = value; // 后值覆盖
  }
}

/** cmd.exe 整行上限（cmd.exe 8191 字符，PLAN §2.10 B） */
export const CMD_LINE_LIMIT = 8191;

// ---- M9：启动检测（PLAN §2.7）与设置页共用的纯函数 ----

/** Claude Code 安装说明链接（PLAN §2.7 横幅文案；chat-ui 侧同名常量见 chat/lib/chatModel.ts） */
export const CLAUDE_INSTALL_URL =
  "https://docs.claude.com/en/docs/claude-code/setup";

/** `claude --version` 输出 → 主版本号；认不出数字 → null（纯函数） */
export function parseClaudeVersion(stdout: string): number | null {
  const match = /(\d+)(?:\.\d+)*/.exec(stdout ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * `claude auth status` 输出（JSON）→ 登录态（实测定型 2026-09-11：`{"loggedIn":true,
 * "authMethod":"oauth_token",...}`，exit 0）。非 JSON / 缺 loggedIn 布尔位 → null（不可判定，
 * 调用方按「探测失败」处理，不据此报未登录）。
 */
export function parseAuthStatus(
  stdout: string,
): { loggedIn: boolean; authMethod: string | null } | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") {
    return null;
  }
  return {
    loggedIn: record.loggedIn,
    authMethod:
      typeof record.authMethod === "string" ? record.authMethod : null,
  };
}

/** CLI 状态错误码（横幅用；前两个与 §4.6 错误码表同值，后两个为 M9 检测专有） */
export type CliStatusCode =
  | "CLAUDE_NOT_FOUND"
  | "CLAUDE_AUTH_FAILED"
  | "CLAUDE_VERSION_TOO_OLD"
  | "CLI_PATH_OVERRIDE_INVALID";

/** CLI 检测结论（宿主推 UI 横幅的依据） */
export interface CliStatus {
  ok: boolean;
  /** ok=false 时为横幅错误码 */
  code: CliStatusCode | null;
  /** 横幅文案（含安装/登录引导；ok=true 为空串） */
  message: string;
}

/** 探测原始事实（effects 由宿主注入后喂给 evaluateCliStatus） */
export interface CliProbeFacts {
  /** 解析出的可执行文件绝对路径；null = 未找到 */
  resolvedPath: string | null;
  /** cliPathOverride 设置原值（空串 = 自动解析） */
  override: string;
  /** override 非空时的存在性检查结果 */
  overrideExists: boolean;
  /** `--version` 结果；null = 未探测（前置步骤已失败） */
  version: { major: number } | { failed: true } | null;
  /** auth status 可判定结果；null = 未探测/不可判定 */
  auth: { loggedIn: boolean } | null;
}

/**
 * 检测结论的判定与文案（纯函数，单测主战场）。优先级：
 * 未找到/不可执行 > 版本过旧 > 未登录 > override 无效（override 无效但自动解析可用时
 * 仍按 §4.4「回落自动解析并 UI 告警」出告警，其余检测项照常判定）。
 */
export function evaluateCliStatus(facts: CliProbeFacts): CliStatus {
  const overrideNote = facts.override
    ? `（设置中填写的路径「${facts.override}」不可用）`
    : "";
  if (!facts.resolvedPath) {
    return {
      ok: false,
      code: "CLAUDE_NOT_FOUND",
      message: `未找到 claude 命令。请安装 Claude Code（${CLAUDE_INSTALL_URL}），装好后重启 Zotero；或在 设置 → zotero-claudian 中填写 claude 可执行文件完整路径。${overrideNote}`,
    };
  }
  if (facts.version && "failed" in facts.version) {
    return {
      ok: false,
      code: "CLAUDE_NOT_FOUND",
      message: `claude 无法执行（${facts.resolvedPath}）。请确认安装完整，或在 设置 → zotero-claudian 中重新指定可执行文件路径。${overrideNote}`,
    };
  }
  if (facts.version && "major" in facts.version && facts.version.major < 2) {
    return {
      ok: false,
      code: "CLAUDE_VERSION_TOO_OLD",
      message: `claude 版本过旧（检测到 v${facts.version.major}，需 ≥ 2）。请升级 Claude Code（${CLAUDE_INSTALL_URL}）后重启 Zotero。`,
    };
  }
  if (facts.auth && !facts.auth.loggedIn) {
    return {
      ok: false,
      code: "CLAUDE_AUTH_FAILED",
      message:
        "claude 未登录。请在终端运行 claude 完成登录（浏览器授权）后重试，无需重启 Zotero。",
    };
  }
  if (facts.override && !facts.overrideExists) {
    return {
      ok: false,
      code: "CLI_PATH_OVERRIDE_INVALID",
      message: `设置中的 claude 路径无效（${facts.override} 不存在），已回落自动解析：${facts.resolvedPath}。请在 设置 → zotero-claudian 中修正或清空该路径。`,
    };
  }
  return { ok: true, code: null, message: "" };
}

/**
 * win32 cmd.exe 的**绝对路径**（Gecko Subprocess 的硬要求）。
 * Gecko 与 node 的 spawn 不同：`command` 非绝对路径时 win32 实现的 `isExecutableFile`
 * 直接返回 false，`Subprocess.call` 在起进程前就抛
 * `File at path "cmd.exe" does not exist, or is not executable`（不查 COMSPEC，也不搜 PATH）。
 * ComSpec 优先（Windows 系统变量真值）→ `SystemRoot\System32\cmd.exe` 兜底 →
 * 标准系统根常量（与 buildSpawnEnv 的 SystemRoot 兜底同口径）。
 */
export function resolveCmdExePath(
  env: Record<string, string | undefined> = {},
): string {
  // Services.env 在 Windows 上大小写不敏感，纯函数侧按名比对也得大小写不敏感
  const get = (name: string): string => {
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase() === name && v) {
        return v;
      }
    }
    return "";
  };
  const comspec = get("comspec");
  if (comspec) {
    return comspec;
  }
  const root = get("systemroot").replace(/[\\/]+$/, "");
  return root ? `${root}\\System32\\cmd.exe` : "C:\\Windows\\System32\\cmd.exe";
}

/** darwin sh 包装通道的 shell 绝对路径：脚本只用 POSIX 构造（ulimit -n / exec "$0" "$@"），
 *  /bin/sh 是 macOS 上最小且恒在的解释器（zsh 亦可，但无 zsh 专有语法需求，不必多依赖一个壳）。 */
export const POSIX_SH_PATH = "/bin/sh";

/**
 * darwin fd 提限脚本（真实 Zotero 实测 2026-09-11 致命缺陷）：launchd 启动的 Zotero 继承的
 * fd 上限（软 256 级）远低于 claude CLI 启动所需，CLI 启动即 exit 1
 * "An unknown error occurred, possibly due to low max file descriptors"。子进程只能自己提，
 * 故 spawn 前经 shell 抬软上限。
 * - 先试 CLI 报错里自己建议的 2147483646（macOS 上恒可设）；失败（hard 更小）退到 hard 上限；
 *   再失败就保持原值——提限是尽力而为，绝不因它阻断 exec；
 * - `exec "$0" "$@"`：claude 路径放 $0、原参数经 $@ 独立 argv 传递（全程无字符串拼接、无注入面，
 *   含空格/引号/换行的参数原样到目标）；exec 不换 pid——SIGTERM 直达 claude，stdin/退出码穿透。
 */
export const DARWIN_FD_RAISE_SCRIPT =
  'ulimit -n 2147483646 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true; exec "$0" "$@"';

/** 调用组装结果：ok=true 的 file/args 即 Subprocess.call 入参；失败原样透出 SPAWN_FAILED 原因 */
export type CliInvocation =
  | { ok: true; file: string; args: string[] }
  | Extract<Win32CmdInvocation, { ok: false }>;

/**
 * claude 命令调用的统一 argv 组装（PLAN §2.7 检测 + §2.3 正式 spawn 共用同一函数，§2.10 B）：
 * win32 仅 .cmd 壳（channel="cmd"）→ 经 cmd.exe 派发；darwin（channel="sh"）→ 经 /bin/sh
 * 提 fd 上限后 exec；其余 argv 直传。
 * `cmdExePath` 只被 cmd 通道消费（direct/sh 忽略）：宿主从 Services.env 取 ComSpec 喂进来，
 * 取不到时用 resolveCmdExePath 的兜底值——win32 上它必须是绝对路径，否则 Gecko 直接拒收。
 * 组装失败（换行/百分号/超限）→ ok:false 原样透出原因：探测路径按「不可执行」处理，
 * 对话路径回该轮 SPAWN_FAILED + 原因（两条路径共用同一包装，规则不复制）。
 * sh 通道无校验门：claude 路径与参数都是独立 argv（$0/$@），不经 shell 解析。
 */
export function buildCliInvocation(
  channel: CliChannel,
  exePath: string,
  args: string[],
  cmdExePath: string = resolveCmdExePath(),
): CliInvocation {
  if (channel === "direct") {
    return { ok: true, file: exePath, args };
  }
  if (channel === "sh") {
    // 形态：file=/bin/sh、args=["-c", 脚本, claude 路径, ...原参数]
    // sh -c 的 argv 约定：脚本后第一个参数是 $0（claude 路径），其后是 $1..（原参数）
    return {
      ok: true,
      file: POSIX_SH_PATH,
      args: ["-c", DARWIN_FD_RAISE_SCRIPT, exePath, ...args],
    };
  }
  return buildWin32CmdInvocation(exePath, args, cmdExePath);
}

export type Win32CmdInvocation =
  | { ok: true; file: string; args: ["/C", string] }
  | {
      ok: false;
      code: "SPAWN_FAILED";
      reason: "ARG_HAS_NEWLINE" | "ARG_HAS_PERCENT" | "CMD_LINE_TOO_LONG";
      limit?: number;
    };

/**
 * win32 仅 .cmd 壳时的派发包装（PLAN §2.10 B；.exe 不经本函数，argv 直传与 darwin 同构）。
 *
 * 形态：`file` = cmd.exe **绝对路径**（见 resolveCmdExePath）、`args` = `["/C", <整行>]`。
 * 这个两元形态是**专门对上 Gecko 的 cmd.exe 特例分支**的（subprocess_win.worker.js）：
 *   命中条件（注释原文「cmd.exe is insane and requires special treatment」）：
 *   command 匹配 /\\cmd\.exe$/i、args.length == 3、args[1] 匹配 /^(\/S)?\/C$/i；
 *   命中 → args 改写为 [quoteString(args[0]), "/S/C", `"${args[2]}"`]（只补引号，不转义）；
 *   不命中 → args = args.map(quoteString)（每个参数按 MSVCRT 规则转义）。
 * worker 收到的 args 已由 Subprocess.call 前插了 command（`options.arguments.unshift(options.command)`），
 * 即 [<绝对 cmd.exe>, "/C", 整行] —— 恰好 3 个、args[1] 命中 → 命中特例：
 * Gecko 对整行**原样补最外层一对引号**（不做任何转义），cmd /s 剥掉该对引号后按整行执行。
 * 不命中就走通用分支：整行含引号 → quoteString 二次转义成 `\"`，cmd.exe 不认 → 命令行不可执行
 * （W-A2 复审：这才是 win32 .cmd 通道每轮必挂的根因）。
 * 外层引号归 Gecko 补，我们**不预先包**；整行内部仍是 quoteWinArg 的 CRT 形态
 * （每 token 双引号 + 反斜杠四条规则）：cmd 剥引号后原样交给目标程序，由目标的 CRT 还原 argv
 * （crt-roundtrip.mjs 对真源码 15/15 还原，见 tests/unit/cliDetect.test.ts 的现状模拟）。
 *
 * 安全边界（写死不省）：
 * - 任一参数（含 exe 路径）含 \n/\r → 拒绝（cmd.exe 在换行处截断命令，PLAN §2.10 B.4）；
 * - 参数含 % → 拒绝（批处理层展开变量，拒绝优于转义猜测，PLAN §2.10 B.3）；
 * - 组装后整行 > 8191 字符 → 拒绝并报实际上限（PLAN §2.10 B.5）。
 * prompt 恒走 stdin 不进参数，上列限制天然不适用（PLAN §2.3/§2.10 B）。
 * 注：cmdExePath 本身不在「整行」内（它是进程 argv[0]），故与换行/百分号门无关。
 */
export function buildWin32CmdInvocation(
  exePath: string,
  argv: string[],
  cmdExePath: string = resolveCmdExePath(),
): Win32CmdInvocation {
  const all = [exePath, ...argv];
  if (all.some((a) => /[\r\n]/.test(a))) {
    return { ok: false, code: "SPAWN_FAILED", reason: "ARG_HAS_NEWLINE" };
  }
  if (all.some((a) => a.includes("%"))) {
    // 含 exe 路径在内全部成分（BUG-03：与换行检查对称）
    return { ok: false, code: "SPAWN_FAILED", reason: "ARG_HAS_PERCENT" };
  }
  const commandLine = all.map(quoteWinArg).join(" ");
  if (commandLine.length > CMD_LINE_LIMIT) {
    return {
      ok: false,
      code: "SPAWN_FAILED",
      reason: "CMD_LINE_TOO_LONG",
      limit: CMD_LINE_LIMIT,
    };
  }
  return { ok: true, file: cmdExePath, args: ["/C", commandLine] };
}

/**
 * CRT/MSVCRT 命令行引号化（单参数 → "..."）：
 * - 参数内 `"` → `\"`；
 * - 连续 N 个反斜杠后紧跟 `"`（含收尾引号前）→ 反斜杠翻倍再接 `\"`；
 * - 其余反斜杠原样；参数收尾恰是反斜杠 → 翻倍后收引号（如 `D:\data\` → `"D:\data\\"`）。
 */
export function quoteWinArg(arg: string): string {
  let out = '"';
  const n = arg.length;
  let i = 0;
  while (i < n) {
    const ch = arg[i];
    if (ch === '"') {
      out += '\\"';
      i += 1;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < n && arg[i + run] === "\\") {
      run += 1;
    }
    const after = i + run;
    if (after < n && arg[after] === '"') {
      // 反斜杠紧邻引号：翻倍 + 转义引号
      out += "\\".repeat(run * 2) + '\\"';
      i = after + 1;
    } else if (after === n) {
      // 尾部反斜杠：翻倍后单收引号（标准 CRT，PLAN §2.10 B.2；BUG-01 修正：
      // 此前按 win32-spawn 旧 needle 的「奇数补引号」形态实现，主会话 449101d 已裁决定为标准 CRT）
      out += "\\".repeat(run * 2);
      i = after;
    } else {
      // 中部反斜杠（后跟普通字符）：原样，继续处理后续字符
      out += "\\".repeat(run);
      i = after;
    }
  }
  return `${out}"`;
}
