// cliRunner.ts — 每轮 spawn 的命令行组装与进程错误分类（PLAN §4.1 / §4.2 / §4.6）
// 纯函数，不 import Zotero 全局。OS 分叉按平台参数抽离：
// darwin/win32 的 argv 直传同构；win32 仅 .cmd 壳走 cmd.exe 派发（buildWin32CmdInvocation，见 cliDetect.ts）。
// prompt 恒不在参数内（走 stdin）——这是 cmd.exe 8191 上限 / 换行截断 / CRT 引号陷阱的整体规避点（PLAN §2.10 B）。
// M4 增补：spawnTurn 进程编排（Subprocess 注入，流读分帧喂 protocol.mapStreamLine，§4.2）。

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypass",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * 内部档位 id → CLI `--permission-mode` 取值（R5 实测：`claude --help` 的 choices 只有
 * acceptEdits/auto/bypassPermissions/manual/dontAsk/plan，没有 bypass；`default` 实测被接受，
 * 其余同名直传，只有「放任」档要映射成 CLI 的 bypassPermissions）。
 */
const CLI_PERMISSION_MODE_ARGV: Record<PermissionMode, string> = {
  default: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
};

/** --permission-prompt-tool 的固定工具名（PLAN §2.5 主案） */
const PERMISSION_TOOL_NAME = "mcp__claudian-perm__permission_check";

export interface BuildSpawnArgsOptions {
  /** 会话当前权限档（恒带） */
  permissionMode: PermissionMode;
  /** 权限 MCP 端点端口（恒带） */
  mcpPort: number;
  /** 端点一次性随机 token（恒带） */
  mcpToken: string;
  /** 续接时的 CLI session_id；null/空 = 首轮，不带 --resume */
  resumeClaudeSessionId?: string | null;
  /**
   * R7-H：分叉（`--resume <id> --fork-session`，新会话 id 由 CLI 生成）。
   * 只由「真回滚」路径携带（宿主先截断原文件、分叉后立刻还原，见 utils/rewind.ts）——
   * 其余调用点恒不带，保持「append-system-prompt/model/bare 恒不携带」同款写死纪律。
   */
  forkSession?: boolean;
  /** 当前 PDF 附件所在目录；无 PDF 不带 --add-dir */
  addDir?: string | null;
  /**
   * R7-B：本轮 --add-dir 目录集（当前附件目录 ∪ 各引用条目的 PDF 目录，见
   * utils/mentions.mergeAddDirs）；非空时**取代** addDir 逐目录各出一条 `--add-dir`。
   */
  addDirs?: string[];
  /** 附件目录写保护 settings 文件路径（prepareDenySettings 产物）；null/空 = 不带 --settings */
  settingsPath?: string | null;
  /**
   * 该轮 mcp-config 文件路径（prepareMcpConfigFile 产物）；null/空 = 内联 JSON 回落形态。
   * 传路径是生产形态：一次性 token 只落 0600 文件，不进 argv（本机任意进程 ps 即可读到 argv）。
   */
  mcpConfigPath?: string | null;
  /** remember 规则串；空数组不带 --allowedTools */
  allowedTools?: string[];
}

/**
 * 附件目录写保护 settings 内容（M10 真机实证 2026-09-11，claude 2.1.267）：
 * acceptEdits 档下 `--add-dir` 目录内的 Write/Edit 免卡静默落盘（实测），本文件给该目录
 * 加 `permissions.deny` 硬拒绝——deny 优先于权限档与权限卡通道，AI 收到
 * "File is in a directory that is denied by your permission settings."，文件不动。
 * **路径模式必须写 `//<绝对路径>/**`**（`//` 是绝对路径锚点；实测单斜杠 `/abs/**` 不命中、
 * 不报错、静默放行——见 .scratch/smoke/run-adddir-* 与 M10 实验）。只 deny Write/Edit，
 * Read 不受影响（PDF 原文照读）。win32 反斜杠按 gitignore 语义转 `/`；`//C:/…` 形态
 * 未经 Windows 真机验证（Windows 首验项）。
 * 非法输入（空/相对路径）直接抛错：宁可不 spawn，也不带一个不生效的 deny 跑（fail-closed）。
 * R5 复测（2026-09-11，claude 2.1.267，bypassPermissions 档）：
 *  - Write 工具 → `<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>`，文件不动；
 *  - Bash 重定向（`printf ... > <该目录文件>`）同样被拒（"Permission to use Bash with command ... has been denied."）；
 *  - 但脚本类写入（`python3 -c "open(...,'w')"`）**不被 deny 覆盖**——放任档没有权限卡兜底，这条边界见 README「放任」小节。
 * 另：CLI 启动时会对 `Write(...)` 规则提示「only Edit(path) rules are matched by file permission checks」——
 * Edit 规则覆盖全部文件编辑类工具（Write 规则是冗余层，保留是为了不改变既有 deny 内容）。
 */
export function buildAttachmentDenySettings(
  addDir: string | readonly string[],
): string {
  const dirs = Array.isArray(addDir) ? [...addDir] : [addDir as string];
  if (dirs.length === 0) {
    // 空集合没有可保护的目录：调用方本就该传 null 不带 --settings；静默产出空 deny
    // 等于「以为保护了」，故 fail-closed 抛错（与非法路径同口径）
    throw new Error("invalid addDir for deny settings: empty list");
  }
  const deny: string[] = [];
  const seen = new Set<string>();
  for (const raw of dirs) {
    const slashed = String(raw).replace(/\\/g, "/");
    const absolute = slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed);
    // 规则字面是 `//` + 无前导斜杠的路径（实测形态），故这里剥掉前导/尾随斜杠
    const dir = slashed.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!absolute || !dir) {
      // 一个非法项就整批拒绝：绝不静默漏掉某个目录的保护（R7 安全红线）
      throw new Error(`invalid addDir for deny settings: ${String(raw)}`);
    }
    if (seen.has(dir)) {
      continue; // 去重（同一目录的重复规则只是噪声；规则集仍逐目录齐全）
    }
    seen.add(dir);
    deny.push(`Write(//${dir}/**)`, `Edit(//${dir}/**)`);
  }
  return JSON.stringify({ permissions: { deny } });
}

/**
 * mcp-config JSON 内容（唯一来源）：内联回落形态与临时文件内容共用，
 * 两形态必逐字一致（`claude --mcp-config` 接受 JSON 字符串或 JSON 文件路径，实测见 `.devflow`）。
 */
export function buildMcpConfigJson(port: number, token: string): string {
  return JSON.stringify({
    mcpServers: {
      "claudian-perm": {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp?token=${token}`,
      },
    },
  });
}

/** mcp-config 临时文件的写入面（sections 注入 IOUtils 真实现；测试注入假 fs） */
export interface McpConfigFileFs {
  makeDir(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /** 内容含一次性 token，权限必须收到 0600；收不紧按写失败处理 */
  chmod(path: string, mode: number): Promise<void>;
  /** 失败路径的删除（尽力而为；异常由 prepareMcpConfigFile 接住） */
  remove(path: string): Promise<void>;
}

export interface McpConfigFileDeps {
  /** 目标目录（sections 传 sessionDataDir()，与 deny settings 同目录） */
  dataDir: string;
  fs: McpConfigFileFs;
  /** 路径拼接（sections 传 PathUtils.join；win32 分隔符由它负责） */
  joinPath(dir: string, name: string): string;
  /** 文件名唯一化（跨调用递增：清理可能落在下一轮同路径文件上，同 deny settings 理由） */
  nextNonce(): string;
  log(message: string): void;
}

/**
 * 该轮 mcp-config 临时文件（内容 = buildMcpConfigJson，0600）：spawn 参数改传文件路径，
 * 一次性 token 不再出现在 argv——否则同机任意进程 `ps` 读到 argv 即握有该轮权限端点凭据，
 * 可伪造权限卡应答。清理时机与 deny settings 相同（宿主在进程退出/失败路径删）。
 * **可用性优先**：任何一步失败（建目录/写入/chmod）→ 记日志 + 返回 null，调用方回落内联 JSON
 *（现状形态），不因此让用户发不出消息。
 */
export async function prepareMcpConfigFile(
  deps: McpConfigFileDeps,
  port: number,
  token: string,
): Promise<string | null> {
  let path: string | null = null;
  try {
    await deps.fs.makeDir(deps.dataDir);
    try {
      // 目录先收紧到 0700：写文件与 chmod 之间存在「文件短暂按 umask 可读」的窗口，
      // 目录不可穿越可把这个窗口关掉（安全复查：凭据写入的权限窗口）
      await deps.fs.chmod(deps.dataDir, 0o700);
    } catch (err) {
      deps.log(`mcp-config dir chmod skipped: ${String(err)}`);
    }
    path = deps.joinPath(deps.dataDir, `mcp-config-${deps.nextNonce()}.json`);
    await deps.fs.writeText(path, buildMcpConfigJson(port, token));
    try {
      await deps.fs.chmod(path, 0o600);
    } catch (err) {
      // chmod 失败不改用内联形态：agent 目录本身已是用户私有（与 deny settings 同目录），
      // 文件形态仍比 argv 暴露更小；内联回落只在「写文件失败」这种真的没法用时才走
      deps.log(`mcp-config chmod failed (keep file form): ${String(err)}`);
    }
    return path;
  } catch (err) {
    deps.log(`mcp-config file write failed → inline fallback: ${String(err)}`);
    if (path) {
      try {
        // 半成品不上报：token 随该轮结束在端点侧作废，且写失败不影响回落后的可用性
        await deps.fs.remove(path);
      } catch {
        // 尽力而为
      }
    }
    return null;
  }
}

/**
 * spawn 参数序列（顺序固定，INTERFACE §4.1）：
 * 基础流参数 → --resume → --permission-mode → --add-dir → --settings → --allowedTools → --mcp-config/--permission-prompt-tool。
 * 恒不携带 --bare/--model/--append-system-prompt/--fork-session 与 prompt argv（写死）。
 * 信任边界：permissionMode / mcpPort / mcpToken 非法直接抛错（调用方回 SPAWN_FAILED），不静默纠正。
 */
export function buildSpawnArgs(opts: BuildSpawnArgsOptions): string[] {
  if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
    throw new Error(`invalid permissionMode: ${String(opts.permissionMode)}`);
  }
  if (
    !Number.isInteger(opts.mcpPort) ||
    opts.mcpPort < 1 ||
    opts.mcpPort > 65535
  ) {
    throw new Error(`invalid mcpPort: ${String(opts.mcpPort)}`);
  }
  if (typeof opts.mcpToken !== "string" || !opts.mcpToken) {
    throw new Error("invalid mcpToken: must be a non-empty string");
  }

  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (opts.resumeClaudeSessionId) {
    args.push("--resume", opts.resumeClaudeSessionId);
    if (opts.forkSession) {
      args.push("--fork-session");
    }
  }
  // bypass（放任）档下仍照传 mcp-config/--permission-prompt-tool：R5 实测（2.1.267，活端点 mock）
  // bypassPermissions 下 Write 直接放行、权限端点 0 次调用——传了不影响，故不动参数结构。
  args.push("--permission-mode", CLI_PERMISSION_MODE_ARGV[opts.permissionMode]);
  // R7-B：addDirs 非空 → 逐目录各一条 --add-dir（当前附件目录在首位）；否则回落单值 addDir
  //（单值形态逐字不变：传 "" 仍不带该参数，见 tests/acceptance/spawn-args.test.mjs）
  const addDirs = opts.addDirs?.length
    ? opts.addDirs
    : opts.addDir
      ? [opts.addDir]
      : [];
  for (const dir of addDirs) {
    args.push("--add-dir", dir);
  }
  if (opts.settingsPath) {
    // 额外 settings 层（只含附件目录 deny 规则）：不影响用户全局配置/hooks/MCP（实测：与用户
    // settings 合并加载，非 --bare 的替换语义）
    args.push("--settings", opts.settingsPath);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }
  // 生产形态传文件路径（token 不进 argv）；路径缺失 = 写文件失败，回落内联 JSON（可用性优先）
  const mcpConfig =
    opts.mcpConfigPath || buildMcpConfigJson(opts.mcpPort, opts.mcpToken);
  args.push(
    "--mcp-config",
    mcpConfig,
    "--permission-prompt-tool",
    PERMISSION_TOOL_NAME,
  );
  return args;
}

/** classifyProcError 的返回码（INTERFACE §4.6 错误码表子集） */
export type ProcErrorKind = "SESSION_GONE" | "GENERIC" | "CLAUDE_NOT_FOUND";

/**
 * resume/session 失效关键字（INTERFACE §4.2/§4.6：如 No conversation found 及 session 不存在类报错）。
 * 全 ASCII（PLAN §2.10 C：GBK 码页污染下判定不受影响），匹配大小写不敏感。
 */
const SESSION_GONE_PATTERNS = [
  "no conversation found",
  "session not found",
  "no such session",
  "session does not exist",
].map((kw) => kw.toLowerCase());

/**
 * 「可执行文件/命令找不到」的报错原文（W-A11：只认 node ENOENT 会在 Windows 上漏判）：
 * - node（darwin/linux）：ENOENT / no such file / file not found；
 * - Gecko Subprocess（win32）：`File at path "…" does not exist, or is not executable`
 *   ——非绝对路径 / 目标不存在 / reparse point 时 `Subprocess.call` 抛的就是这句；
 * - cmd.exe（英文版系统）：`The system cannot find the file|path specified.`、
 *   `'…' is not recognized as an internal or external command`。
 * 注：cmd.exe 的文案随系统语言本地化（中文系统上是 GBK 中文字面，不在 UTF-8 解码面内），
 * 非英文系统的 cmd 文案命中不了——主判据是 Gecko 那句（恒英文，与系统语言无关）。
 */
const SPAWN_MISSING_RE =
  /ENOENT|no such file|file not found|does not exist, or is not executable|the system cannot find the (?:file|path) specified|is not recognized as an internal or external command/i;

/**
 * 进程错误分类（仅在「进程退出非 0 且无 result」或 spawn 失败时调用）：
 * spawn ENOENT / Gecko 拒收可执行文件 / cmd 找不到目标 → CLAUDE_NOT_FOUND（安装引导卡）；
 * 进程异常退出（exitCode ≠ 0）且 stderr 含 resume/session 失效关键字 → SESSION_GONE（UI 给「新建会话」按钮）；
 * 其余 → GENERIC。exitCode === 0 恒不判 SESSION_GONE（BUG-04 收紧：正常退出不因 stderr 残留误判）。
 */
export function classifyProcError(input: {
  exitCode: number | null;
  stderrTail: string;
  reason?: string;
}): ProcErrorKind {
  // BUG-27：spawnTurn 的产出侧（见下）写的是 "CLAUDE_NOT_FOUND"，而验收契约
  // （tests/acceptance/spawn-args.test.mjs）喂的是 "ENOENT"——两种拼写都认，
  // 否则「CLI 未找到」分支恒不命中，用户拿到的是通用错误卡而非安装引导。
  if (input.reason === "CLAUDE_NOT_FOUND" || input.reason === "ENOENT") {
    return "CLAUDE_NOT_FOUND";
  }
  if (input.exitCode === 0) {
    return "GENERIC";
  }
  const tail = input.stderrTail || "";
  // win32 上「CLI 根本起不来」不走 spawn 抛错：cmd.exe 起得来、是它找不到目标
  // （或 .cmd 壳里的 node 找不到），报错落在 stderr、进程非 0 退出且无 result。
  // 不认这几句原文 → UI 只显示英文原文，「装 CLI / 填路径」引导卡（W-A11）永不可达。
  if (SPAWN_MISSING_RE.test(tail)) {
    return "CLAUDE_NOT_FOUND";
  }
  const lowerTail = tail.toLowerCase();
  if (SESSION_GONE_PATTERNS.some((kw) => lowerTail.includes(kw))) {
    return "SESSION_GONE";
  }
  return "GENERIC";
}

// ---- spawnTurn 进程编排（M4，PLAN §2.3 / INTERFACE §4.2）----
// Subprocess 经 SubprocessLike 注入：node:test 用 fake 进程跑全链路；
// Gecko 侧真实注入为 ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")。

import { mapStreamLine, type StreamEvent, type StreamLogger } from "./protocol";
import { buildCliInvocation, type CliChannel } from "./cliDetect";

/** Gecko Subprocess.call 产出的进程句柄（按实际用到的成员收窄，与 sections.ts 同风格） */
export interface ProcHandleLike {
  stdin: { write(data: string): void; close(): void };
  stdout: { readString(): Promise<string | null | undefined> };
  stderr: { readString(): Promise<string | null | undefined> };
  wait(): Promise<{ exitCode: number }>;
  /** 不带参 = SIGTERM 软杀（PLAN §2.4 中断语义） */
  kill(hard?: boolean): void;
}

/** spawn 注入面（真实形态见 sections.ts 的 getSubprocess） */
export interface SubprocessLike {
  call(options: {
    command: string;
    arguments: string[];
    workdir?: string;
    /** 传全量替换环境；配 environmentAppend=true 则为增量覆盖（仅覆盖 PATH） */
    environment?: Record<string, string>;
    environmentAppend?: boolean;
    stderr?: "pipe";
  }): Promise<ProcHandleLike>;
}

/** turn 终止事件（INTERFACE §4.2 procError 行；procError 经 streamEvent 通道广播给 UI） */
export interface ProcErrorEvent {
  kind: "procError";
  exitCode: number | null;
  stderrTail?: string;
  /** spawn ENOENT → "CLAUDE_NOT_FOUND"（安装引导卡） */
  reason?: string;
}

export type TurnEvent = StreamEvent | ProcErrorEvent;

export interface SpawnTurnOptions {
  command: string;
  args: string[];
  /**
   * 派发通道（cliDetect.resolveClaudeCommand 的解析产物透传至此）：
   * "cmd" = win32 .cmd 壳，经 cmd.exe 包装（BRIEF §2.10 B）；
   * "sh" = darwin 经 /bin/sh 提 fd 上限后 exec（真实实测 2026-09-11，见 buildCliInvocation）；
   * 缺省 "direct" = argv 直传。
   */
  channel?: CliChannel;
  /**
   * win32 cmd 通道用的 cmd.exe 绝对路径（宿主从 Services.env 的 ComSpec 取，见
   * cliDetect.resolveCmdExePath）；缺省 = 该函数的兜底值。direct 通道忽略。
   */
  cmdExePath?: string;
  workdir: string;
  environment?: Record<string, string>;
  environmentAppend?: boolean;
  /** prompt 全文（§4.1：恒走 stdin，写入后 close） */
  prompt: string;
  /** 标准事件与 procError 的出口；每条 stream-json 行经 mapStreamLine 映射 */
  onEvent: (event: TurnEvent) => void;
  logger?: StreamLogger;
}

export interface TurnHandle {
  /** SIGTERM 软杀；重复调用与进程已退出时安全 */
  kill(): void;
  /** 进程退出并完成清理后 resolve（spawn 失败立即 resolve）——宿主据此解锁 send（§4.6 并发契约） */
  exitPromise: Promise<void>;
}

/** stderr 内存上限（事件里再截 500 字符，双保险防超长 stderr 撑爆内存） */
const STDERR_KEEP_CHARS = 8192;
/** procError.stderrTail 截取上限（INTERFACE §4.2） */
const STDERR_TAIL_CHARS = 500;
/** 空串读到的重试间隔（毫秒）——给流式解码缓冲补齐/进程退出留时间，非 EOF 时快速重读 */
const EMPTY_READ_RETRY_MS = 25;
/**
 * 进程**退出后**连续空读达此次数才判 EOF（存活期的空读不计入，见 drainPipe）。
 * 不用「单次空读 + 已退出」直接断：进程退出后缓冲区里可能还剩数据，
 * 空读可能是「下一个字符只到了一半」——紧接着还有续字节+后续数据要读（提前断会截尾）。
 */
const EMPTY_STRIKES_BEFORE_EOF = 3;

/**
 * 抽干一条文本管道到真 EOF（BUG-18）。
 * Gecko 的 readString 在两种情形都返回空串：① 真 EOF（进程退出、管道关闭）；
 * ② 流式 TextDecoder 缓冲里只剩半个多字节字符、当下无可解码内容（**不是** EOF）。
 * 只按「空串」断流会在 ② 提前截断（stdout 丢 result → 误判 procError；PATH 读取丢目录）。
 * 因此空串当「暂无数据」重试；进程退出后，从**首次观察到退出的那一刻**起再连续读到
 * EMPTY_STRIKES_BEFORE_EOF 次空串才判 EOF——存活期的空读不计入这段宽限（它们可能只是
 * 半个多字节字符；若跨存活期累计 strike，退出后的宽限会被缩到 1 次，缓冲里残留的尾数据
 * 仍有截断面）。
 * isExited 视为单调（进程退出不可逆）：一旦为真不再调用。
 * 上限：进程退出后仍永久阻塞不返回的异常管道会挂住本 Promise（Gecko Subprocess 未观察到该形态）。
 */
export async function drainPipe(
  pipe: { readString(): Promise<string | null | undefined> },
  onChunk: (chunk: string) => void,
  isExited: () => boolean,
): Promise<void> {
  let emptyStrikes = 0;
  let exited = false;
  for (;;) {
    const chunk = await pipe.readString();
    if (chunk) {
      emptyStrikes = 0;
      onChunk(chunk);
      continue;
    }
    if (!exited && isExited()) {
      exited = true;
      emptyStrikes = 0; // 宽限从观察到退出起算
    }
    emptyStrikes++;
    if (exited && emptyStrikes >= EMPTY_STRIKES_BEFORE_EOF) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, EMPTY_READ_RETRY_MS));
  }
}

/** spawn 抛错是否属「可执行文件找不到」（node ENOENT 与 Gecko/cmd 形态同判，见 SPAWN_MISSING_RE） */
function isSpawnEnoent(err: unknown): boolean {
  const e = err as { errno?: unknown; message?: unknown } | null;
  if (e && typeof e === "object") {
    if (e.errno === 2) return true; // darwin ENOENT
    if (typeof e.message === "string" && SPAWN_MISSING_RE.test(e.message)) {
      return true;
    }
  }
  return false;
}

/**
 * 拉起一轮 CLI 进程（turn-per-spawn）：
 * stdin 写 prompt 后 close → stdout 按 \n 分帧逐行喂 mapStreamLine → stderr 收尾 → wait 退出。
 * 终止契约：见到 result 事件即认为 turn 正常收尾；退出时无 result（含被 kill）→
 * 补发一条 procError（exitCode 任意，exit 0 无 result 也补发防 UI 卡 waiting）；
 * spawn 失败 → procError {exitCode:null, reason: ENOENT 时 "CLAUDE_NOT_FOUND"}。
 * 本函数不抛错：一切失败走 onEvent(procError) + exitPromise resolve。
 */
export function spawnTurn(
  deps: SubprocessLike,
  opts: SpawnTurnOptions,
): TurnHandle {
  const log = opts.logger ?? (() => {});
  let proc: ProcHandleLike | null = null;

  const emitProcError = (event: ProcErrorEvent): void => {
    try {
      opts.onEvent(event);
    } catch (err) {
      log(`[cliRunner] onEvent(procError) handler threw: ${String(err)}`);
    }
  };

  const exitPromise = (async () => {
    // 命令组装与探测路径共用 buildCliInvocation：win32 .cmd 壳经 cmd.exe 包装（§2.10 B），
    // direct 通道 argv 原样直传。组装失败（换行/百分号/8191 超限）→ 该轮不 spawn，只报 SPAWN_FAILED + 原因。
    const invocation = buildCliInvocation(
      opts.channel ?? "direct",
      opts.command,
      opts.args,
      opts.cmdExePath,
    );
    if (!invocation.ok) {
      log(
        `[cliRunner] spawn failed: ${invocation.code} (${invocation.reason})`,
      );
      emitProcError({
        kind: "procError",
        exitCode: null,
        stderrTail: `${invocation.code}: ${invocation.reason}`,
        reason: invocation.reason,
      });
      return;
    }
    const callCli = (command: string, args: string[]) =>
      deps.call({
        command,
        arguments: args,
        workdir: opts.workdir,
        environment: opts.environment,
        environmentAppend: opts.environmentAppend,
        stderr: "pipe",
      });
    const emitSpawnFailure = (err: unknown): void => {
      log(`[cliRunner] spawn failed: ${String(err)}`);
      emitProcError({
        kind: "procError",
        exitCode: null,
        stderrTail: String(err).slice(0, STDERR_TAIL_CHARS),
        ...(isSpawnEnoent(err) ? { reason: "CLAUDE_NOT_FOUND" } : {}),
      });
    };
    try {
      proc = await callCli(invocation.file, invocation.args);
    } catch (err) {
      if ((opts.channel ?? "direct") === "sh") {
        // sh 包装兜底：起不来只可能是包装壳本身的问题（/bin/sh 缺失等；claude 目标不存在是
        // shell 起来后 exec 失败、走 stderr 非 0 退出，不落这里）→ 回退直接 spawn claude 路径。
        // 提限是尽力而为，不因包装缺失把这一轮对话挡死。
        log(
          `[cliRunner] sh wrapper spawn failed, falling back to direct: ${String(err)}`,
        );
        try {
          proc = await callCli(opts.command, opts.args);
        } catch (err2) {
          emitSpawnFailure(err2);
          return;
        }
      } else {
        emitSpawnFailure(err);
        return;
      }
    }
    const p = proc;

    // prompt 恒走 stdin，写入后关闭（§4.1）；write/close 失败不影响流读（进程会自行报错退出）
    try {
      p.stdin.write(opts.prompt);
    } catch (err) {
      log(`[cliRunner] stdin write failed: ${String(err)}`);
    }
    try {
      p.stdin.close();
    } catch (err) {
      log(`[cliRunner] stdin close failed: ${String(err)}`);
    }

    let sawResult = false;
    let stderrTail = "";

    const handleLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) return;
      const mapped = mapStreamLine(line, log);
      if (!mapped) return;
      const events = Array.isArray(mapped) ? mapped : [mapped];
      for (const event of events) {
        if (event.kind === "result") sawResult = true;
        try {
          opts.onEvent(event);
        } catch (err) {
          log(`[cliRunner] onEvent handler threw: ${String(err)}`);
        }
      }
    };

    // 进程退出标志：drainPipe 只在「读到空串且进程已退出」时判 EOF（BUG-18）
    let exited = false;

    // 并行抽干两根管道：任一管道不抽干进程都可能阻塞在管道写上（死锁面）
    const readStdout = (async () => {
      let buf = "";
      await drainPipe(
        p.stdout,
        (chunk) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            handleLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        },
        () => exited,
      );
      if (buf) handleLine(buf);
    })().catch((err) => log(`[cliRunner] stdout read error: ${String(err)}`));

    const readStderr = (async () => {
      await drainPipe(
        p.stderr,
        (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP_CHARS);
        },
        () => exited,
      );
    })().catch((err) => log(`[cliRunner] stderr read error: ${String(err)}`));

    let exitCode: number | null = null;
    try {
      const status = await p.wait();
      exitCode = status.exitCode;
    } catch (err) {
      log(`[cliRunner] wait() failed: ${String(err)}`);
    } finally {
      exited = true;
    }
    await Promise.allSettled([readStdout, readStderr]);

    if (!sawResult) {
      emitProcError({
        kind: "procError",
        exitCode,
        stderrTail: stderrTail.slice(-STDERR_TAIL_CHARS),
      });
    }
  })();

  return {
    kill(): void {
      try {
        proc?.kill();
      } catch (err) {
        log(`[cliRunner] kill failed: ${String(err)}`);
      }
    },
    exitPromise,
  };
}
