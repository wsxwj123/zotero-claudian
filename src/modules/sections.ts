// sections.ts — 阅读器侧栏 chat section（registerSection 嵌非 remote browser）+
// hostBridge 的 Zotero 真实服务接线（M4，PLAN §2.2 / §4.6 / §4.7）。
// 加载路径为 spike 实测定型：chrome:// 注册（bootstrap.ts）+ loadURI(nsIURI + systemPrincipal)，
// file:// 直载与 remote="true" 均实测不可用。握手方向：宿主在 browser load 先发 init。

import { config } from "../../package.json";
import { getLocaleID } from "../utils/locale";
import { createSeqGuard } from "../utils/seqGuard";
import {
  getAutoShowPane,
  getDefaultPermissionMode,
  getCliPathOverride,
  getDeepseekApiKey,
  getShowUsage,
  getWorkspacePath,
} from "../utils/prefs";
import {
  createBalanceService,
  detectProvider,
  parseClaudeEnv,
  type BalanceService,
  type FetcherLike,
} from "./balance";
import {
  createPaneAutoShow,
  type PaneAutoShow,
  type PaneBodyLike,
  type PaneDocumentLike,
} from "./paneAutoShow";
import { buildPrompt } from "../utils/promptTemplate";
import { buildTurnContext, type ItemMetadata } from "../utils/contextBuilder";
import type { HostMessage } from "../chat/lib/types";
import {
  createHostBridge,
  type HostBridge,
  type HostBridgeDeps,
  type PortLike,
  type TurnPromptInput,
} from "./hostBridge";
import {
  resolveClaudeCommand,
  buildCliInvocation,
  buildWin32PathPlan,
  resolveCmdExePath,
  evaluateCliStatus,
  parseAuthStatus,
  parseClaudeVersion,
  type CliChannel,
  type CliStatus,
  type Platform,
} from "./cliDetect";
import {
  drainPipe,
  spawnTurn,
  buildAttachmentDenySettings,
  type ProcHandleLike,
  type SubprocessLike,
} from "./cliRunner";
import {
  createPermissionCore,
  startPermissionServer,
  type PermissionCore,
  type PermissionServer,
  type ResolvedPermission,
} from "./permissionMcp";
import {
  createZoteroContextDeps,
  fileExistsSync,
  lookupItemByKey,
  readerContextMessage,
  registerSelectionNoteButton,
  registerSelectionTracking,
} from "./contextSource";
import { listNotes, saveNote } from "./notes";
import {
  createSessionStore,
  type SessionStore,
  type SessionStoreFs,
} from "../utils/sessionStore";
import {
  createInputHistoryStore,
  type InputHistoryStore,
} from "./inputHistoryStore";

const PANE_ID = `${config.addonRef}-chat`;
const CHAT_URL = `chrome://${config.addonRef}/content/chat/index.html`;
/** browser 元素上的握手凭据属性（reload 沿用同值，page 从 URL 读回，BUG-16） */
const TOKEN_ATTR = "data-claudian-token";

let sectionRegistered = false;
let bridge: HostBridge | null = null;
let messageListener: ((ev: MessageEvent) => void) | null = null;
/** 打开文献自动激活本面板（设置项 autoShowPane；registerChatSection 建、unregister 拆） */
let paneAutoShow: PaneAutoShow | null = null;

// ---- Gecko Subprocess 注入（按实际用到的成员收窄） ----

/** importESModule 返回的是模块命名空间：真机实测 moduleKeys = ["Subprocess", "getSubprocessImplForTest"] */
type SubprocessModule = { Subprocess: { call: SubprocessLike["call"] } };
let subprocessModule: SubprocessModule | null = null;

function getSubprocess(): SubprocessLike {
  if (!subprocessModule) {
    subprocessModule = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    ) as unknown as SubprocessModule;
  }
  return { call: (options) => subprocessModule!.Subprocess.call(options) };
}

// ---- claude 命令与 spawn 基础环境（登录 shell PATH，PLAN §2.3）----

/** claude 命令解析产物（含派发通道：win32 .cmd 壳走 cmd.exe，§2.10 B；darwin 走 sh 提 fd 上限） */
interface SpawnBase {
  command: string | null;
  channel: CliChannel;
  environment: Record<string, string>;
  environmentAppend: boolean;
  /** win32 cmd 通道用的 cmd.exe 绝对路径（Gecko 拒收裸名，见 cliDetect.resolveCmdExePath）；非 win32 为 "" */
  cmdExe: string;
}

let spawnBase: SpawnBase | null = null;
let shellPathDirs: string[] | null = null;

function currentPlatform(): Platform {
  if (Zotero.isWin) return "win32";
  if (Zotero.isMac) return "darwin";
  return "linux";
}

function homeDir(): string {
  return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
}

/** 常驻目录候选（PLAN §2.10 A 表，依序探测） */
function residentDirsFor(platform: Platform): string[] {
  const home = homeDir();
  if (platform === "win32") {
    const appData = Services.env.get("APPDATA") ?? "";
    const localAppData = Services.env.get("LOCALAPPDATA") ?? "";
    const userProfile = Services.env.get("USERPROFILE") ?? "";
    return [
      `${userProfile}\\.local\\bin`,
      `${appData}\\npm`,
      `${localAppData}\\Programs`,
      `${userProfile}\\scoop\\shims`,
    ].filter(Boolean);
  }
  return [
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.claude/local`,
  ];
}

/** 登录 shell PATH（darwin/linux：$SHELL -l -c 'echo $PATH'，Zotero scaffold 范式），缓存。
 *  win32 不走这里（无 SHELL，探测恒失败）——见 resolveSpawnBase 的 buildWin32PathPlan 分支。 */
async function getShellPathDirs(): Promise<string[]> {
  if (shellPathDirs) {
    return shellPathDirs;
  }
  try {
    const shell = Services.env.get("SHELL") || "/bin/zsh";
    const proc = await getSubprocess().call({
      command: shell,
      arguments: ["-l", "-c", "echo $PATH"],
      stderr: "pipe",
    });
    // 抽干 stderr 防管道阻塞；输出异常不阻塞 PATH 解析
    void proc.stderr.readString().catch(() => undefined);
    // 空串≠EOF（BUG-18 同根因调用点）：PATH 含多字节目录名时流式解码会先返回空串，
    // 只按空串断流会截断 PATH → claude 解析不到。与进程退出状态合并判定。
    let exited = false;
    let out = "";
    const readAll = drainPipe(
      proc.stdout,
      (chunk) => {
        out += chunk;
      },
      () => exited,
    ).catch((err) => Zotero.logError(err as Error));
    try {
      proc.stdin.close();
    } catch {
      // 无 stdin 需求
    }
    await proc.wait();
    exited = true;
    await readAll;
    shellPathDirs = out
      .trim()
      .split(":")
      .map((d) => d.trim())
      .filter(Boolean);
  } catch (err) {
    Zotero.logError(err as Error);
    shellPathDirs = [];
  }
  return shellPathDirs;
}

/** spawn 基础（结果缓存；解析失败不缓存，下次 send 重试——用户可能中途装好 CLI）。
 *  设置页改 cliPathOverride 时由 startCliStatusWatch 的偏好观察者置空缓存（改动下一次 spawn 生效）。 */
async function resolveSpawnBase(): Promise<SpawnBase> {
  if (spawnBase) {
    return spawnBase;
  }
  const platform = currentPlatform();
  let pathDirs: string[];
  let environment: Record<string, string>;
  let cmdExe = "";
  if (platform === "win32") {
    // cmd.exe 绝对路径：Gecko 的 Subprocess 不查 COMSPEC/PATH（裸名直接拒收），
    // 这里一次取定喂给 cmd 通道（§2.10 B）
    cmdExe = resolveCmdExePath({
      ComSpec: Services.env.get("ComSpec") ?? "",
      SystemRoot: Services.env.get("SystemRoot") ?? "",
    });
    // win32 无登录 shell 可探（M10 走查：探测必失败 → 此前 PATH 为空串，claude.cmd 里的
    // node 解析不到）。以进程 PATH 为基底 + 常驻目录兜底，走 buildSpawnEnv 组装（§2.10 A/C）。
    const plan = buildWin32PathPlan({
      processPath: Services.env.get("PATH") ?? "",
      env: {
        SystemRoot: Services.env.get("SystemRoot") ?? "",
        TEMP: Services.env.get("TEMP") ?? "",
      },
      residentDirs: residentDirsFor(platform),
    });
    pathDirs = plan.pathDirs;
    environment = plan.environment;
  } else {
    pathDirs = await getShellPathDirs();
    // 环境原样透传（environmentAppend），仅覆盖 PATH = 登录 shell PATH（§4.1 env 行）
    environment = { PATH: pathDirs.join(":") };
  }
  const resolved = resolveClaudeCommand({
    platform,
    pathDirs,
    residentDirs: residentDirsFor(platform),
    override: getCliPathOverride(),
    exists: fileExistsSync,
  });
  if (resolved.status === "not_found") {
    Zotero.debug(
      `[claudian] claude CLI not found (PATH dirs: ${pathDirs.length})`,
    );
    return {
      command: null,
      channel: "direct",
      environment: {},
      environmentAppend: true,
      cmdExe,
    };
  }
  spawnBase = {
    command: resolved.path,
    // darwin 恒经 sh 包装（提 fd 上限，真实实测 2026-09-11）：launchd 启动的 Zotero 继承的
    // fd 上限低于 CLI 启动所需，CLI 启动即 exit 1；解析层的 channel 保持 direct（发现语义），
    // 包装是 spawn 层的事。linux 不提（非 launchd 环境，本版不在范围）。
    channel: platform === "darwin" ? "sh" : resolved.channel,
    environment,
    environmentAppend: true,
    cmdExe,
  };
  Zotero.debug(
    `[claudian] claude CLI resolved: ${resolved.path} (${resolved.source})`,
  );
  return spawnBase;
}

// ---- CLI 检测（M9，PLAN §2.7）：启动探测 + 设置变更重查 + 结果推 UI 横幅 ----

/** 探测输出保留上限（--version/auth status 输出极短；异常进程防撑爆内存） */
const PROBE_MAX_CHARS = 64 * 1024;
/** 探测超时（实测 --version 8ms / auth status 130ms；留足冷启动余量，超时 kill 按失败计） */
const PROBE_TIMEOUT_MS = 10_000;

/** 最近一次检测结论；null = 尚未测完（hostBridge 在 hello 注册后据此补推横幅） */
let cliStatus: CliStatus | null = null;
let cliProbeInflight: Promise<void> | null = null;
let cliPrefObserver: symbol | null = null;

/** 供 hostBridge 在实例注册后取用（null = 还没测完；测完时 refreshCliStatus 会广播） */
export function getCliStatus(): CliStatus | null {
  return cliStatus;
}

function applyCliStatus(status: CliStatus): void {
  cliStatus = status;
  Zotero.debug(
    `[claudian] cli status: ${status.ok ? "ok" : String(status.code)} ${status.message}`,
  );
  if (!status.ok && status.code) {
    // 桥协议无专用状态消息：按既有 error 通道推横幅（与 SESSION_GONE 提示同路，§4.6）
    bridge?.broadcast({
      type: "error",
      code: status.code,
      message: status.message,
    });
  }
}

/** 探测并广播（在途合并：并发调用共享同一次探测） */
export function refreshCliStatus(): Promise<void> {
  if (cliProbeInflight) {
    return cliProbeInflight;
  }
  cliProbeInflight = (async () => {
    try {
      applyCliStatus(await probeCliStatus());
    } catch (err) {
      Zotero.logError(err as Error);
    } finally {
      cliProbeInflight = null;
    }
  })();
  return cliProbeInflight;
}

/**
 * 短命令探测：spawn → 抽干 stdout → 限时收尾。任何失败（spawn 失败/超时/非零退出）
 * 不抛错，返回 ok:false（结论判定交给 evaluateCliStatus）。
 */
async function runProbe(
  base: SpawnBase,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  const invocation = base.command
    ? buildCliInvocation(base.channel, base.command, args, base.cmdExe)
    : null;
  if (!invocation?.ok) {
    // 参数组装失败（含 win32 转义拒绝）→ 按不可执行计
    return { ok: false, stdout: "" };
  }
  let proc: ProcHandleLike | null = null;
  try {
    proc = await getSubprocess().call({
      command: invocation.file,
      arguments: invocation.args,
      environment: base.environment,
      environmentAppend: base.environmentAppend,
      stderr: "pipe",
    });
  } catch (err) {
    Zotero.debug(`[claudian] probe spawn failed: ${String(err)}`);
    return { ok: false, stdout: "" };
  }
  const p = proc;
  let exited = false;
  let stdout = "";
  const readDone = drainPipe(
    p.stdout,
    (chunk) => {
      if (stdout.length < PROBE_MAX_CHARS) {
        stdout += chunk;
      }
    },
    () => exited,
  ).catch((err) => Zotero.logError(err as Error));
  // stderr 无用途，读掉防管道阻塞（与 PATH 读取调用点同法）
  void p.stderr.readString().catch(() => undefined);
  const timer = setTimeout(() => {
    try {
      p.kill();
    } catch (err) {
      Zotero.logError(err as Error);
    }
  }, PROBE_TIMEOUT_MS);
  try {
    const status = await p.wait();
    exited = true;
    await readDone;
    return { ok: status.exitCode === 0, stdout };
  } catch (err) {
    Zotero.debug(`[claudian] probe wait failed: ${String(err)}`);
    return { ok: false, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/** 探测链：解析路径 → `claude --version`（≥2）→ `claude auth status`（登录态） */
async function probeCliStatus(): Promise<CliStatus> {
  const base = await resolveSpawnBase();
  const override = getCliPathOverride().trim();
  const overrideExists = override ? fileExistsSync(override) : false;
  if (!base.command) {
    return evaluateCliStatus({
      resolvedPath: null,
      override,
      overrideExists,
      version: null,
      auth: null,
    });
  }
  const versionRun = await runProbe(base, ["--version"]);
  const major = versionRun.ok ? parseClaudeVersion(versionRun.stdout) : null;
  const version = major === null ? ({ failed: true } as const) : { major };
  let auth: { loggedIn: boolean } | null = null;
  if ("major" in version) {
    const authRun = await runProbe(base, ["auth", "status"]);
    const parsed = authRun.ok ? parseAuthStatus(authRun.stdout) : null;
    // 探测执行失败/输出不可判定 → 不据此报「未登录」（fail-open：检测的毛病不该怪用户）
    auth = parsed ? { loggedIn: parsed.loggedIn } : null;
  }
  return evaluateCliStatus({
    resolvedPath: base.command,
    override,
    overrideExists,
    version,
    auth,
  });
}

/**
 * 启动探测 + 监听 cliPathOverride 变更：改动即作废解析缓存并重查（设置页改动下一次 spawn 生效）。
 * 宿主 onStartup 调用；探测异步，不阻塞启动。
 */
export function startCliStatusWatch(): void {
  void refreshCliStatus();
  if (!cliPrefObserver) {
    cliPrefObserver = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.cliPathOverride`,
      () => {
        spawnBase = null;
        void refreshCliStatus();
      },
      true,
    );
  }
}

/** 插件停用时收尾（观察者注销；探测在途结果自然丢弃，不再广播） */
export function stopCliStatusWatch(): void {
  if (cliPrefObserver) {
    try {
      Zotero.Prefs.unregisterObserver(cliPrefObserver);
    } catch (err) {
      Zotero.logError(err as Error);
    }
    cliPrefObserver = null;
  }
  cliStatus = null;
}

// ---- 工作区（§4.1 cwd 行：spawn 前不存在则插件侧 mkdir）----

async function ensureWorkspace(): Promise<string> {
  const path = getWorkspacePath();
  try {
    if (!(await IOUtils.exists(path))) {
      await IOUtils.makeDirectory(path, { createAncestors: true });
    }
    // 可访问性探测（2026-09-11 真实实测加固）：macOS TCC 拒绝后 exists 仍可能为 true、
    // 但真实读写被系统拦——子进程会以 getcwd EPERM / "CLI 进程异常退出 (exit 1)" 形式失败，
    // 远不如在此处显式报 WORKSPACE_UNAVAILABLE 清楚。getChildren 触发一次真实访问。
    await IOUtils.getChildren(path);
    return path;
  } catch (err) {
    Zotero.logError(err as Error);
    const error = new Error(`workspace unavailable: ${path} (${String(err)})`);
    (error as { code?: string }).code = "WORKSPACE_UNAVAILABLE";
    throw error;
  }
}

// ---- 权限 MCP 端点（M6，§4.8）----

/** 纯逻辑核心（单例）：token 注册表 + 在途权限请求；present 出口接到桥的广播口 */
let permissionCore: PermissionCore | null = null;
/** Gecko 传输层（单例，懒启动）：起失败保持 null，下次 send 重试（§4.8 无后备路径） */
let permissionServer: PermissionServer | null = null;

function getPermissionCore(): PermissionCore {
  if (!permissionCore) {
    permissionCore = createPermissionCore({
      log: (message) => Zotero.debug(`[claudian] ${message}`),
      // 卡推给 UI：桥广播（多实例同收，先答者生效）
      present: (req) => bridge?.requestPermission(req),
      // 结算（作答/超时/该轮结束）也广播：其余实例同步摘卡，别留已结算的残影
      settled: (requestId) => bridge?.permissionSettled(requestId),
    });
  }
  return permissionCore;
}

/**
 * 该轮端点凭据（§4.8）：首次调用起回环监听（端口系统分配），之后每轮开一个一次性 token。
 * 起监听失败 → 抛错 → 宿主该轮不 spawn + SPAWN_FAILED 横幅（无后备路径，用户重试即重试）。
 */
function getMcpEndpoint(sessionId: string): { port: number; token: string } {
  if (!permissionServer) {
    permissionServer = startPermissionServer({
      core: getPermissionCore(),
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    });
    Zotero.debug(
      `[claudian] permission endpoint listening on 127.0.0.1:${permissionServer.port}`,
    );
  }
  return getPermissionCore().openTurn(sessionId, permissionServer.port);
}

/** 该轮进程退出：撤销 token + 在途请求按 deny 结掉（§4.8） */
function closeMcpTurn(token: string): void {
  permissionCore?.closeTurn(token);
}

/** permissionResponse 回写（§4.6）：未知 requestId → null（桥侧忽略 + log） */
function resolvePermission(
  requestId: string,
  allow: boolean,
): ResolvedPermission | null {
  return permissionCore?.resolve(requestId, allow) ?? null;
}

// ---- 附件目录写保护（M10，acceptEdits × --add-dir 的写边界）----

/**
 * 写保护文件序号：文件名每轮唯一。清理发生在进程退出后，若复用同一路径，
 * 上一轮的删除可能落在下一轮刚写的文件上 → 那一轮静默失去保护（宁多留几个垃圾文件）。
 */
let denySettingsSeq = 0;

/**
 * 该轮 deny settings 文件（buildAttachmentDenySettings 内容 → 插件数据目录，0600）：
 * spawn 参数经 --settings 加载，把当前 `--add-dir` 附件目录的 Write/Edit 硬拒绝
 *（acceptEdits 档对该目录免卡实测成立，见 cliRunner.buildAttachmentDenySettings 注释）。
 * 任何一步失败都抛错 → 该轮不 spawn（宁可不发车，也不带未受保护的附件目录跑）。
 */
async function prepareDenySettings(
  addDir: string | null,
): Promise<string | null> {
  if (!addDir) {
    return null;
  }
  const content = buildAttachmentDenySettings(addDir); // 非法路径在此抛错
  const dataDir = sessionDataDir();
  try {
    await IOUtils.makeDirectory(dataDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const nonce = `${Date.now().toString(36)}-${(denySettingsSeq++).toString(36)}`;
    const path = PathUtils.join(dataDir, `deny-adddir-${nonce}.json`);
    await IOUtils.writeUTF8(path, content);
    // IOUtils.writeUTF8 无 mode 参数：写后单独收紧权限（失败只告警——文件内容不是凭据，
    // 泄露面仅是「某个 Zotero 附件目录路径」，不因此拦下这一轮）
    try {
      await IOUtils.setPermissions(path, 0o600);
    } catch (err) {
      Zotero.debug(`[claudian] deny settings chmod failed: ${String(err)}`);
    }
    return path;
  } catch (err) {
    Zotero.logError(err as Error);
    throw new Error(`deny settings write failed: ${String(err)}`);
  }
}

/** 该轮进程退出：删除本轮写保护文件（ignoreAbsent；失败只 log，不影响解锁） */
function cleanupDenySettings(path: string): void {
  void IOUtils.remove(path, { ignoreAbsent: true }).catch((err: unknown) => {
    Zotero.debug(`[claudian] deny settings cleanup failed: ${String(err)}`);
  });
}

// ---- 上下文与 prompt（contextBuilder DI + promptTemplate 模板）----

async function buildTurnPrompt(text: string): Promise<TurnPromptInput> {
  const ctx = await buildTurnContext(createZoteroContextDeps());
  return {
    itemKey: ctx.itemKey,
    attachmentKey: ctx.attachmentKey,
    addDir: ctx.addDir,
    prompt: buildPrompt(ctx.promptContext, text),
  };
}

/** UI 顶栏 readerContext（§4.6 宿主→UI 表）：取数（DI）与映射（纯函数）分工，映射有单测 */
async function buildReaderContext(): Promise<HostMessage | null> {
  try {
    const deps = createZoteroContextDeps();
    const reader = await deps.getSelectedReader();
    let parent: ItemMetadata | null = null;
    if (reader?.itemID != null) {
      const attachment = await deps.getAttachment(reader.itemID);
      if (attachment?.parentItemID != null) {
        parent = await deps.getItemMetadata(attachment.parentItemID);
      }
    }
    return readerContextMessage(reader, parent);
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/**
 * readerContext 增量推送：当前页/划选会随阅读变化，而 reader 没有对应的插件事件
 *（官方事件只有 render* 系列）——2s 轮询取数、变了才推（PONYTAIL：平台无 pageChange 事件，
 * 轮询是当前最简替代；单次只读几个属性，若日后有官方事件再换成事件驱动）。
 * 只在拿到有效阅读上下文（有绑定的父条目）时推：切到书库/无阅读器不推 null 覆盖，
 * 免得 UI 顶栏在翻页/切页时闪断（发送时刻的真实上下文仍由 buildTurnContext 现取）。
 */
const READER_CONTEXT_POLL_MS = 2000;
let readerContextTimer: ReturnType<typeof setInterval> | null = null;
let lastReaderContextKey = "";
/** 在途取数序号：轮询与 Notifier 两路都调 pushReaderContext，先发起的可能后完成 */
const readerContextGuard = createSeqGuard();

/** 取数 → 去重 → 广播（轮询与「切标签即时重推」共用；同一条上下文不发两遍，去重 key 就在这） */
async function pushReaderContext(): Promise<void> {
  const isLatest = readerContextGuard.begin();
  try {
    const msg = await buildReaderContext();
    // 复查修-3：期间又发起过（取数慢的那次回来晚了）→ 丢弃旧快照，不让旧文献覆盖新状态
    if (!isLatest()) {
      return;
    }
    if (!msg || msg.type !== "readerContext" || msg.itemKey == null) {
      return;
    }
    const key = JSON.stringify(msg);
    if (key === lastReaderContextKey) {
      return;
    }
    lastReaderContextKey = key;
    bridge?.broadcast(msg);
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

/**
 * R4-1：切标签即时重推——轮询只管页码/划选，切 PDF 不该等下一个 tick。
 * Zotero 在标签选择落定后 trigger('select', 'tab', [id], { [id]: { type } }, true)
 *（chrome/content/zotero/tabs.js:937），extraData 里带标签类型：是 reader 标签才推
 *（选书库/笔记标签不必取数）。老版本或形态变化导致 extraData 缺 type 时按「可能是 reader」照推
 *——pushReaderContext 自带去重与 null 过滤，多推一次无副作用。
 */
let readerContextObserverId: string | null = null;

function startReaderContextNotifier(): void {
  if (readerContextObserverId) {
    return;
  }
  try {
    readerContextObserverId = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids, extraData) => {
          if (event !== "select" || type !== "tab") {
            return;
          }
          const data = extraData as
            | Record<string, { type?: unknown } | undefined>
            | undefined;
          const isReader = ids.some((id) => {
            const t = data?.[String(id)]?.type;
            return typeof t !== "string" || t.startsWith("reader");
          });
          if (isReader) {
            void pushReaderContext();
          }
        },
      },
      ["tab"],
      "claudian-r4",
    );
  } catch (err) {
    Zotero.logError(err as Error);
  }
}

function stopReaderContextNotifier(): void {
  if (!readerContextObserverId) {
    return;
  }
  try {
    Zotero.Notifier.unregisterObserver(readerContextObserverId);
  } catch (err) {
    Zotero.logError(err as Error);
  }
  readerContextObserverId = null;
}

function startReaderContextWatch(): void {
  if (readerContextTimer) {
    return;
  }
  readerContextTimer = setInterval(() => {
    void pushReaderContext();
  }, READER_CONTEXT_POLL_MS);
  startReaderContextNotifier();
}

function stopReaderContextWatch(): void {
  if (readerContextTimer) {
    clearInterval(readerContextTimer);
    readerContextTimer = null;
  }
  stopReaderContextNotifier();
  lastReaderContextKey = "";
}

// ---- 会话数据目录与存储（M5，§4.5）----

/** profile 目录（PLAN §2.4/§4.5 用 Zotero.Profile.dir；API 缺失时回落 Zotero.getProfileDirectory） */
function profileDir(): string {
  const fromProfile = (Zotero as unknown as { Profile?: { dir?: unknown } })
    .Profile?.dir;
  if (typeof fromProfile === "string" && fromProfile) {
    return fromProfile;
  }
  return Zotero.getProfileDirectory().path;
}

/** 插件数据目录：profile + /claudian/（不放 extensions/<id>/ 下，防扩展更新流程波及数据，§4.5） */
function sessionDataDir(): string {
  return PathUtils.join(profileDir(), "claudian");
}

/** sessionStore 的文件系统注入面（IOUtils 真实现；纯逻辑侧只认接口，见 utils/sessionStore.ts） */
const sessionFs: SessionStoreFs = {
  async readText(path) {
    // 不存在 → null；空文件 → ""（后者按索引损坏处理）
    return (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
  },
  async writeText(path, data) {
    await IOUtils.writeUTF8(path, data);
  },
  async appendText(path, data) {
    // 真追加（不读不改写）：历史文件唯一写入口，读故障不再能演变成覆盖（BUG-21）。
    // appendOrCreate：首次追加时文件还不存在，append 模式会失败
    await IOUtils.writeUTF8(path, data, { mode: "appendOrCreate" });
  },
  async move(from, to) {
    try {
      await IOUtils.move(from, to, { noOverwrite: false });
    } catch (err) {
      // 覆盖语义兜底（不同 Gecko 版本对「目标已存在」的处理不一致）：先删再接
      Zotero.debug(`[claudian] IOUtils.move fallback: ${String(err)}`);
      await IOUtils.remove(to, { ignoreAbsent: true });
      await IOUtils.move(from, to, { noOverwrite: false });
    }
  },
  async remove(path) {
    await IOUtils.remove(path, { ignoreAbsent: true });
  },
  async makeDir(path) {
    await IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
  },
  async exists(path) {
    return IOUtils.exists(path);
  },
};

let sessionStore: SessionStore | null = null;

function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = createSessionStore({
      dataDir: sessionDataDir(),
      platform: currentPlatform(),
      fs: sessionFs,
      log: (message) => Zotero.debug(`[claudian] ${message}`),
      now: () => Date.now(),
      defaultPermissionMode: getDefaultPermissionMode,
    });
  }
  return sessionStore;
}

/** 输入历史（↑/↓ 翻已发送消息）的宿主持久化：与 sessionStore 同目录、同 fs 注入面 */
let inputHistoryStore: InputHistoryStore | null = null;

function getInputHistoryStore(): InputHistoryStore {
  if (!inputHistoryStore) {
    inputHistoryStore = createInputHistoryStore({
      dataDir: sessionDataDir(),
      platform: currentPlatform(),
      fs: sessionFs,
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    });
  }
  return inputHistoryStore;
}

// ---- 握手凭据与回发通道（BUG-16）----

/**
 * 每实例一次性握手 token（拼进页面 URL，宿主 init/hello 双向校验）。
 * **fail-closed**：CSPRNG 不可用直接抛错，不回退弱随机——握手 token 是「谁有资格注册为 UI 实例」
 * 的唯一凭据（BUG-16），弱随机等于把这个资格交给任意本机/同进程来源猜。
 * 调用方（loadChatPage）接住并记 error + 不加载页面（宁可无 UI，也不放行弱凭据）。
 */
function makeHandshakeToken(): string {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error(
      "CSPRNG unavailable: refusing to create a handshake token (fail-closed)",
    );
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 握手 MessageChannel（bootstrap 作用域无 MessageChannel 全局 → 从主窗口取构造器） */
function makeHandshakeChannel(): { port1: PortLike; port2: unknown } | null {
  try {
    const win = Zotero.getMainWindow() as unknown as {
      MessageChannel?: new () => { port1: unknown; port2: unknown };
    } | null;
    if (!win?.MessageChannel) {
      return null;
    }
    const channel = new win.MessageChannel();
    return { port1: channel.port1 as PortLike, port2: channel.port2 };
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

// ---- R4-3：余额服务装配（provider 判定 / Key / HTTP 全在此接线）----

/**
 * provider 判定数据源（PLAN-R4 §4）：`~/.claude/settings.json` 的 env 对象 + 进程 env，
 * 只读 ANTHROPIC_BASE_URL / ANTHROPIC_MODEL。文件读不出来（没装/没权限/坏 JSON）→ 只看 env，
 * 一律不抛（判定不出就是 unknown，UI 显示「不支持余额查询」而不是猜）。
 */
async function currentProvider(): Promise<"deepseek" | "unknown"> {
  let settings: { baseUrl: string | null; model: string | null } = {
    baseUrl: null,
    model: null,
  };
  try {
    const raw = await IOUtils.readUTF8(
      PathUtils.join(homeDir(), ".claude", "settings.json"),
    );
    settings = parseClaudeEnv(raw);
  } catch {
    // 常态（用户没装 claude CLI / 无该文件）：静默回落进程 env，不打扰用户
  }
  return detectProvider({
    baseUrl: settings.baseUrl ?? Services.env.get("ANTHROPIC_BASE_URL"),
    model: settings.model ?? Services.env.get("ANTHROPIC_MODEL"),
  });
}

/**
 * 宿主侧 HTTP（R4-3）：插件沙箱作用域没有 fetch 全局（MessageChannel 同理，见 makeHandshakeChannel）
 * → 唯一可用通道是主窗口的 fetch（chrome 主体：不受 CORS 与页面 CSP 约束——页面侧 connect-src 'none'）。
 */
const hostFetcher: FetcherLike = (url, init) => {
  const win = Zotero.getMainWindow() as unknown as {
    fetch?: (url: string, init: unknown) => Promise<never>;
  } | null;
  if (typeof win?.fetch !== "function") {
    throw new Error("fetch unavailable in main window");
  }
  return win.fetch(url, init);
};

/** AbortController 同理（signal 跨 realm 传给主窗口 fetch 不可靠）→ 用主窗口的构造器 */
function hostAbortController(): { signal: unknown; abort(): void } | null {
  const win = Zotero.getMainWindow() as unknown as {
    AbortController?: new () => { signal: unknown; abort(): void };
  } | null;
  return typeof win?.AbortController === "function"
    ? new win.AbortController()
    : null;
}

let balanceService: BalanceService | null = null;
function getBalanceService(): BalanceService {
  balanceService ??= createBalanceService({
    provider: currentProvider,
    // 凭证纪律：Key 只在这里（prefs → 查询）流动，不进日志/会话文件（balance.ts 统一擦除）
    getKey: getDeepseekApiKey,
    fetcher: hostFetcher,
    newAbortController: hostAbortController,
    log: (message) => Zotero.debug(`[claudian] ${message}`),
  });
  return balanceService;
}

// ---- hostBridge 单例（真实服务装配）----

function getHostBridge(): HostBridge {
  if (bridge) {
    return bridge;
  }
  const deps: HostBridgeDeps = {
    post: (win, msg, ports) => {
      (win as Window).postMessage(msg, "*", ports ?? []);
    },
    createChannel: makeHandshakeChannel,
    log: (message) => Zotero.debug(`[claudian] ${message}`),
    now: () => Date.now(),
    launchURL: (url) => {
      try {
        Zotero.launchURL(url);
      } catch (err) {
        Zotero.logError(err as Error);
      }
    },
    buildTurnPrompt,
    ensureWorkspace,
    getSpawnBase: resolveSpawnBase,
    getCliStatus,
    getMcpEndpoint,
    closeMcpTurn,
    prepareDenySettings,
    cleanupDenySettings,
    resolvePermission,
    getDefaultPermissionMode,
    spawnTurn: (options) => spawnTurn(getSubprocess(), options),
    buildReaderContext,
    sessions: getSessionStore(),
    inputHistory: getInputHistoryStore(),
    lookupItem: lookupItemByKey,
    // M7 笔记写入：唯一写库模块（PLAN §7.1 审查口径——写 API 只出现在 notes.ts）
    notes: { saveNote, listNotes },
    // R4-3 用量/余额
    balance: { get: (force) => getBalanceService().get(force) },
    showUsage: getShowUsage,
  };
  bridge = createHostBridge(deps);
  // 页面回发经 event.source（= 发 init 的宿主主窗口）送达，主窗口收 message 事件；
  // shutdown 时移除，防插件重载后监听泄漏
  const win = Zotero.getMainWindow();
  if (win) {
    messageListener = (ev: MessageEvent) => {
      bridge?.dispatch({ source: ev.source, data: ev.data });
    };
    win.addEventListener("message", messageListener);
  }
  return bridge;
}

// ---- section 注册与 browser 装配 ----

export function registerChatSection(): void {
  if (sectionRegistered) {
    return;
  }
  registerSelectionTracking();
  registerSelectionNoteButton();
  startReaderContextWatch();
  // 自动显示控制器：sidenav 按钮的 data-pane = `<pluginID>-<paneID>`（Zotero pluginAPIBase
  // 把插件 id 前缀进 paneID；.scratch/sectv-harness 真机记录同值）
  paneAutoShow = createPaneAutoShow(
    {
      isEnabled: getAutoShowPane,
      schedule: (fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        return () => clearTimeout(timer);
      },
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    },
    `${config.addonID}-${PANE_ID}`,
  );
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("hello-section-header"),
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    },
    sidenav: {
      l10nID: getLocaleID("hello-section-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    },
    // SPIKE 附录要点 3：type="content" + disableglobalhistory，不加 remote
    // 尺寸链（2026-09-11 真实环境实测修复）：XUL <browser> 默认 display:inline，且 Zotero 的
    // section body 容器是 block——flex="1" 在 block 父下不生效 → browser 高 0、面板全白
    // （此前所有验证走桥消息、未验可见性，此问题自 M1 起潜伏）。显式 flex 列容器 + min-height
    // 兜底（百分百高在无高度父下无效，min-height 保证可见；browser flex:1 在可用空间内自适应）。
    bodyXHTML: `<html:div id="${config.addonRef}-chat-wrap" style="display:flex;flex-direction:column;width:100%;height:calc(100vh - 180px);min-height:320px"><browser id="${config.addonRef}-chat-browser" type="content" disableglobalhistory="true" style="width:100%;height:100%;min-height:300px"/></html:div>`,
    // PLAN §2.2：只在阅读器侧栏显示（M1 冒烟期恒可见已收敛）
    onItemChange: ({ doc, body, item, tabType, setEnabled }) => {
      setEnabled(tabType === "reader");
      // 用户真机反馈（2026-09-11）：打开文献要直接看到 Claude 面板，别让人自己去点图标。
      // 整段兜住——体验增强项出问题不该影响 section 的启用逻辑
      try {
        paneAutoShow?.onItemChange({
          doc: doc as unknown as PaneDocumentLike,
          body: body as unknown as PaneBodyLike,
          tabType,
          itemKey: item?.key ?? null,
        });
      } catch (err) {
        Zotero.logError(err as Error);
      }
      return true;
    },
    onRender: ({ body }) => {
      loadChatPage(body);
    },
    onDestroy: ({ body }) => {
      const browser = body.querySelector(
        `#${config.addonRef}-chat-browser`,
      ) as ChatBrowser | null;
      const win = browser?.contentWindow;
      if (win) {
        bridge?.unregister(win);
      }
    },
  });
  sectionRegistered = true;
}

export function unregisterChatSection(): void {
  if (!sectionRegistered) {
    return;
  }
  try {
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
  } catch (err) {
    Zotero.logError(err as Error);
  }
  sectionRegistered = false;
  stopReaderContextWatch();
  paneAutoShow?.cancel(); // 别让挂起的激活点到已停用的插件上
  paneAutoShow = null;
  // 排空会话写队列（插件停用/重载时别把已入队的索引写留在半路）
  void sessionStore?.flush().catch((err) => Zotero.logError(err as Error));
  // 输入历史的写盘合并窗口同样排空（否则最后 500ms 内的发送白记）
  void inputHistoryStore?.flush().catch((err) => Zotero.logError(err as Error));
  // 收掉权限端点监听 + 丢掉在途请求（插件停用后不该再接受任何本机连接）
  try {
    permissionServer?.stop();
    permissionCore = null;
  } catch (err) {
    Zotero.logError(err as Error);
  }
  permissionServer = null;
  if (messageListener) {
    try {
      Zotero.getMainWindow()?.removeEventListener("message", messageListener);
    } catch (err) {
      Zotero.logError(err as Error);
    }
    messageListener = null;
  }
  bridge = null;
}

/**
 * chat 页装配（section 侧栏与独立 tab 共用一套，M8）：一次性 token 拼 URL + load 事件里 beginHandshake。
 * @param onLoaded 页面 load 后回调（真实页窗口）——tab 侧借它缓存实例引用，供 onClose 时注销（§4.6）。
 *   在 beginHandshake **之后**调用（NEW-4）：调用方若判定这是迟到的装配，可在回调里 unregister
 *   把这轮刚起的握手撤掉；顺序反了就只能撤销空气，桥里会留一条死实例。
 */
export function mountChatBrowser(
  browser: ChatBrowser,
  onLoaded?: (win: Window) => void,
): void {
  if (browser.getAttribute("data-claudian-loaded")) {
    return;
  }
  // BUG-16：一次性 token 拼进 URL——页面读自己 URL 得到同一凭据，宿主 init 携带、页面 hello 回抄，
  // 宿主校验通过才注册实例（chrome 作用域 origin 恒空串，不能作信任依据）。reload 沿用同 URL。
  // CSPRNG 缺失时 makeHandshakeToken 抛错：这里接住 → 记 error + 不加载页面（fail-closed）
  let token: string;
  try {
    token = makeHandshakeToken();
  } catch (err) {
    Zotero.logError(err as Error);
    Zotero.debug(
      "[claudian] handshake token unavailable → chat page not loaded (fail-closed)",
    );
    return;
  }
  browser.setAttribute(TOKEN_ATTR, token);
  // load 事件不发 once：页面重载触发二次握手（§4.6，宿主以 contentWindow 幂等去重）
  // capture=true 必需（BUG-15 真机实测）：load 事件 target 是 browser 内部 #document、不冒泡，
  // 只在捕获阶段经过 browser 元素；缺 capture 时此监听器永不触发 → 握手永不开始。
  browser.addEventListener(
    "load",
    () => {
      // 整段包 try/catch：load 监听器里抛错在真机上会静默丢掉（只进浏览器控制台，不进调试日志）
      try {
        // 只打路径部分：spec 带 ?token=<一次性握手凭据>（BUG-16），调试日志不落凭据
        const spec = browser.currentURI?.spec ?? "unknown";
        Zotero.debug(`[claudian] chat page loaded: ${spec.split("?")[0]}`);
        const win = browser.contentWindow;
        if (win) {
          // 握手异常不阻断 onLoaded：调用方（tab）要用它登记实例引用，缺了它就没有注销入口
          try {
            getHostBridge().beginHandshake(win, token);
          } catch (err) {
            Zotero.logError(err as Error);
          }
          onLoaded?.(win);
        } else {
          Zotero.debug(
            "[claudian] chat page loaded but contentWindow is null → no handshake",
          );
        }
      } catch (err) {
        Zotero.logError(err as Error);
      }
    },
    true,
  );
  browser.loadURI(
    Services.io.newURI(`${CHAT_URL}?token=${encodeURIComponent(token)}`),
    {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    },
  );
  browser.setAttribute("data-claudian-loaded", "true");
}

/**
 * UI 实例注销（section onDestroy / tab onClose，§4.6 实例注销）：移出桥注册表，此后不再向其发消息。
 * 桥已收掉（插件停用后）→ 静默：绝不能在这里 getHostBridge() 重新建一个（会漏监听）。
 */
export function unregisterUiInstance(win: object): void {
  bridge?.unregister(win);
}

function loadChatPage(body: HTMLElement): void {
  const browser = body.querySelector(
    `#${config.addonRef}-chat-browser`,
  ) as ChatBrowser | null;
  if (browser) {
    mountChatBrowser(browser);
  }
}

// section bodyXHTML / tab 容器里的 XUL <browser>，zotero-types 未给出精确元素类型，
// 按实际用到的成员收窄（M1 同款）
export type ChatBrowser = Element & {
  loadURI: (uri: unknown, flags: { triggeringPrincipal: unknown }) => void;
  currentURI?: { spec: string };
  contentWindow?: Window;
};
