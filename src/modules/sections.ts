// sections.ts — 阅读器侧栏 chat section（registerSection 嵌非 remote browser）+
// hostBridge 的 Zotero 真实服务接线（M4，PLAN §2.2 / §4.6 / §4.7）。
// 加载路径为 spike 实测定型：chrome:// 注册（bootstrap.ts）+ loadURI(nsIURI + systemPrincipal)，
// file:// 直载与 remote="true" 均实测不可用。握手方向：宿主在 browser load 先发 init。

import { config, version as PLUGIN_VERSION } from "../../package.json";
import { getLocaleID } from "../utils/locale";
import { createSeqGuard } from "../utils/seqGuard";
import {
  getAutoShowPane,
  getDefaultPermissionMode,
  getCliPathOverride,
  getDeepseekApiKey,
  getPinnedSessions,
  getSessionsExpanded,
  getShowUsage,
  getWorkspaceMode,
  getWorkspacePath,
  setPinnedSessions,
  setSessionsExpanded,
} from "../utils/prefs";
import {
  parseCollectionIndex,
  pickCollectionID,
  resolveCollectionDirName,
  resolveTurnWorkspace,
  WORKSPACE_INDEX_FILE,
  type WorkspaceFs,
} from "../utils/collectionWorkspace";
import {
  buildDiagReport,
  DIAG_VALUE_MAX,
  ZOTERO_SUPPORT_RANGE,
} from "../utils/diag";
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
import {
  buildTurnContext,
  resolveContextItem,
  type ItemMetadata,
} from "../utils/contextBuilder";
import type { HostMessage } from "../chat/lib/types";
import {
  createHostBridge,
  type HostBridge,
  type HostBridgeDeps,
  type PickedFile,
  type PortLike,
  type ScopeInject,
  type TurnPromptInput,
  type UiWindowKey,
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
  prepareMcpConfigFile,
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
  createZoteroCollectionDeps,
  createZoteroContextDeps,
  createZoteroScopeDeps,
  fileExistsSync,
  getCollectionName,
  getItemCollectionIDs,
  getSelectedCollectionID,
  lookupItemByKey,
  readerContextMessage,
  registerSelectionNoteButton,
  registerSelectionTracking,
  resolveMentionItem,
  searchMentionItemsInLibrary,
} from "./contextSource";
import {
  readInstructions,
  saveInstructions,
  type InstructionsFs,
  type InstructionsReadResult,
  type InstructionsSavedResult,
} from "../utils/instructions";
import {
  encodeProjectDir,
  findClaudeSessionFile,
  journalPath,
  readSnapshotIndex,
  recoverPendingRewind,
  snapshotDir,
  type RewindFs,
  type SessionFileLookup,
} from "../utils/rewind";
import {
  buildReferencedItemsBlock,
  resolveMentionRefs,
  type ResolvedRef,
} from "../utils/mentions";
import {
  buildAttachmentsBlock,
  saveAttachments,
  sanitizeAttachmentName,
  type AttachmentInput,
  type AttachmentsFs,
  type RejectedAttachment,
  type SaveAttachmentsResult,
} from "../utils/attachments";
import {
  buildScopeBlock,
  mergeScopeAddDirs,
  resolveScope,
  SCOPE_SELECTION_LABEL,
  type ResolvedScope,
  type ScopeKind,
} from "../utils/scope";
import {
  COMMAND_FORWARD_MODE,
  forwardCommandText,
  parseCommandInvocation,
  readCommandBody,
  scanCommands,
  scanSkills,
  type CommandDirEntry,
  type CommandEntry,
  type CommandScanDeps,
} from "../utils/commands";
import { listNotes, saveNote } from "./notes";
// R8：「全页」入口（面板顶栏按钮 → 桥 → 独立工作台标签页）。mainTab 反向 import 本模块的
// CHAT_PANE_ID / mountChatBrowser —— 循环 import 只在函数体内取用，模块求值期不碰
//（与 R4 起就有的 section↔mainTab 循环同款约束）。
import { openMainTab } from "./mainTab";
import {
  createSessionStore,
  type SessionRecord,
  type SessionStore,
  type SessionStoreFs,
} from "../utils/sessionStore";
import {
  createInputHistoryStore,
  type InputHistoryStore,
} from "./inputHistoryStore";

const PANE_ID = `${config.addonRef}-chat`;
/**
 * sidenav 按钮 / section 元素上的 data-pane 值（R8：工具栏入口按它找人，所以对外导出）：
 * Zotero 会把 pluginID 前缀进 paneID（pluginAPIBase），真机实测两条 DOM 上写的是这个串
 *（CSS.escape 之后的形态，paneAutoShow.paneIDMatches 两种形态都认）。
 */
export const CHAT_PANE_ID = `${config.addonID}-${PANE_ID}`;
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
/** 探测 stderr 留尾上限（G-15：只给诊断印原文用，尾部才是报错；全量读但不无限留） */
const PROBE_STDERR_KEEP_CHARS = 400;

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
 * `timedOut`（R9 诊断用）：到点被 kill 的轮次单独标出来——报告要区分「超时」与「跑不起来」。
 * `reason`（R9 诊断用，G-15）：失败**原文**（spawn 异常 / 非零退出时的 stderr 尾部）。
 * 普通探测路径不看它；`/diag` 拿它当 win32 cmd 通道类故障的唯一判据——只写「无法执行」
 * 等于把最有用的一行扔掉。ok=true 时恒为空串。
 */
async function runProbe(
  base: SpawnBase,
  args: string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; timedOut: boolean; reason: string }> {
  const invocation = base.command
    ? buildCliInvocation(base.channel, base.command, args, base.cmdExe)
    : null;
  if (!invocation?.ok) {
    // 参数组装失败（含 win32 转义拒绝）→ 按不可执行计；原文（拒绝原因）透出给诊断
    return {
      ok: false,
      stdout: "",
      timedOut: false,
      reason: invocation
        ? `invocation rejected: ${invocation.reason}`
        : "no command resolved",
    };
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
    // G-15：这句原文（如 win32 的 `File at path "cmd.exe" does not exist, or is not executable`）
    // 就是 cmd 通道类故障的唯一判据，原样带给诊断层
    return {
      ok: false,
      stdout: "",
      timedOut: false,
      reason: diagErrorReason(err),
    };
  }
  const p = proc;
  let exited = false;
  let timedOut = false;
  let stdout = "";
  /** stderr 尾部（只留尾部：报告只用 ~200 字，超长 stderr 不撑内存） */
  let stderrTail = "";
  const readDone = drainPipe(
    p.stdout,
    (chunk) => {
      if (stdout.length < PROBE_MAX_CHARS) {
        stdout += chunk;
      }
    },
    () => exited,
  ).catch((err) => Zotero.logError(err as Error));
  // stderr 同样抽干（防管道阻塞）+ 留尾：非零退出时的报错原文（如 cmd 的「不是内部或外部命令」）在诊断里要印出来
  const stderrDone = drainPipe(
    p.stderr,
    (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-PROBE_STDERR_KEEP_CHARS);
    },
    () => exited,
  ).catch((err) => Zotero.logError(err as Error));
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      p.kill();
    } catch (err) {
      Zotero.logError(err as Error);
    }
  }, timeoutMs);
  try {
    const status = await p.wait();
    exited = true;
    await readDone;
    await stderrDone;
    return {
      ok: status.exitCode === 0,
      stdout,
      timedOut,
      // 非零退出：报错原文通常只在 stderr（win32 cmd 通道的「不是内部或外部命令」就在这里）
      reason: status.exitCode === 0 ? "" : stderrTail.trim(),
    };
  } catch (err) {
    Zotero.debug(`[claudian] probe wait failed: ${String(err)}`);
    return { ok: false, stdout, timedOut, reason: diagErrorReason(err) };
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

/** collectionWorkspace.WorkspaceFs 的 IOUtils 实现（可访问性探针同 §4.1 cwd 行口径） */
const workspaceFs: WorkspaceFs = {
  exists: (path) => IOUtils.exists(path),
  makeDir: async (path) => {
    await IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
  },
  readText: async (path) =>
    (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null,
  writeText: async (path, text) => {
    await IOUtils.writeUTF8(path, text);
  },
  // 可访问性探测（2026-09-11 真实实测加固）：macOS TCC 拒绝后 exists 仍可能为 true、
  // 但真实读写被系统拦——子进程会以 getcwd EPERM / "CLI 进程异常退出 (exit 1)" 形式失败，
  // 远不如在 resolveTurnWorkspace 里显式报 WORKSPACE_UNAVAILABLE 清楚。getChildren 触发一次真实访问。
  listNames: async (dir) =>
    (await IOUtils.getChildren(dir)).map((path) => PathUtils.filename(path)),
  join: (dir, name) => PathUtils.join(dir, name),
};

// ---- R7-J：附件落盘（AttachmentsFs 的 IOUtils 实现）----

/** base64 → 字节（chrome 作用域没有 window.atob，手写一份，无依赖） */
function base64ToBytes(base64: string): Uint8Array {
  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of clean) {
    const v = table.indexOf(ch);
    if (v < 0) {
      continue;
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, i);
}

// ---- R7-J 安全修：宿主原生附件选择器（**路径绝不经过页面**）----

/** nsIFilePicker 的最小面（zotero-types 未收录全；调用序列与 Zotero 自己的 filePicker.mjs 同款） */
type NsIFilePickerLike = {
  init(parent: unknown, title: string, mode: number): void;
  open(callback: (rv: number) => void): void;
  /** 单选形态：XPConnect 包装的 nsIFile（**未经 QI 时面可能不全**，见 toNsIFile） */
  readonly file: unknown;
  readonly files: {
    hasMoreElements(): boolean;
    getNext(): unknown;
  } | null;
  modeOpen: number;
  modeOpenMultiple: number;
  returnOK: number;
};

/** QI 之后应有的 nsIFile 面（我们只用这三个字段） */
type NsIFileLike = { path: string; leafName: string; fileSize: number };

/**
 * 选择器回给的文件项做一次**显式接口转换**（G-14，必修-1 的根因）：
 * 官方 `filePicker.mjs` 在 `getNext()` 之后正是 `file.QueryInterface(Ci.nsIFile)`——
 * 少这一步时 `path/leafName/fileSize` 会一起变 undefined（XPConnect 不保证隐式 QI），
 * 落盘侧就拿不到源路径。接口名走 `Components.interfaces.nsIFile`；拿不到 `Components`
 * 全局（非 chrome 环境）时退回接口名字符串——`QueryInterface` 两种入参都收。
 * 转换失败**不抛**：交给 toPickedFile 的守卫统一报（那一步能同时看到三个字段的实况）。
 */
function toNsIFile(item: unknown): NsIFileLike | null {
  if (!item) {
    return null;
  }
  try {
    const iface =
      (Components as { interfaces?: { nsIFile?: unknown } }).interfaces
        ?.nsIFile ?? "nsIFile";
    (item as { QueryInterface?(i: unknown): unknown }).QueryInterface?.(iface);
  } catch {
    // 没有 Components 全局 / 不是 XPConnect 包装对象 → 交给守卫判
  }
  return item as NsIFileLike;
}

/**
 * 选择器的父窗口（Zotero 10 真机实测定的形态，见 .scratch/r7tok-dlg 证据）：
 * 面板页跑在 XUL `<browser>` 里，它的 browsingContext 是 **content** 上下文——
 * 拿它 init 后 `open()` 会在 2ms 内直接以「取消」返回（对话框根本不出现）。
 * 真正能承载原生对话框的是**宿主窗口**（`<browser>` 的 embedder 所属 chrome 窗口，
 * 如 zoteroPane）的 browsingContext；拿不到 embedder（离屏/测试形态）才退回页面自己的。
 */
function pickerParentFor(win: UiWindowKey): unknown {
  try {
    const bc = (
      win as {
        browsingContext?: {
          embedderElement?: {
            ownerGlobal?: { browsingContext?: unknown };
          } | null;
        };
      }
    ).browsingContext;
    const chromeBc = bc?.embedderElement?.ownerGlobal?.browsingContext;
    return chromeBc ?? bc ?? null;
  } catch {
    return null;
  }
}

/**
 * 「📎 附件」的宿主侧实现：弹**宿主窗口**的原生选择器（parent 见 pickerParentFor；
 * 用户看到的仍是他正在用的那个窗口）。选中的路径只回给桥做一次性凭据登记，
 * 页面永远拿不到路径。取消 → 空数组；选择器异常 → 抛出（桥接住后回空列表 + 记日志，
 * UI 不悬挂）。
 */
async function pickAttachmentFiles(
  win: UiWindowKey,
  opts: { multiple: boolean },
): Promise<PickedFile[]> {
  const classes = Components.classes as unknown as Record<
    string,
    { createInstance(iface: unknown): unknown }
  >;
  const picker = classes["@mozilla.org/filepicker;1"].createInstance(
    Components.interfaces.nsIFilePicker,
  ) as NsIFilePickerLike;
  picker.init(
    pickerParentFor(win),
    "选择附件",
    opts.multiple ? picker.modeOpenMultiple : picker.modeOpen,
  );
  const rv = await new Promise<number>((resolve) => {
    picker.open(resolve);
  });
  if (rv !== picker.returnOK) {
    return []; // 用户取消
  }
  const out: PickedFile[] = [];
  const enumerator = picker.files;
  if (enumerator) {
    while (enumerator.hasMoreElements()) {
      out.push(toPickedFile(enumerator.getNext()));
    }
  } else if (picker.file) {
    out.push(toPickedFile(picker.file));
  }
  return out;
}

/**
 * nsIFile → 桥的登记形态（fileSize 读不到就按 0：桥/落盘侧还会再判上限）。
 * 守卫（必修-1）：拿不到 path 就是**不可用**的条目——抛错让桥记日志 + 回空列表，
 * 绝不放行「三字段全 undefined 的空条目」（那种会一路走到落盘侧被当成「附件缺少内容」，
 * 错误信息认不出根因）。leafName 缺失时从 path 补一个，避免 chip 显示成 "attachment"。
 */
function toPickedFile(item: unknown): PickedFile {
  const file = toNsIFile(item);
  const path = typeof file?.path === "string" ? file.path : "";
  let sizeBytes = 0;
  try {
    sizeBytes =
      file && Number.isFinite(file.fileSize)
        ? Math.max(0, Number(file.fileSize))
        : 0;
  } catch {
    sizeBytes = 0;
  }
  if (!path) {
    const seen = `path=${String(file?.path)} leafName=${String(file?.leafName)} fileSize=${String(file?.fileSize)}`;
    Zotero.debug(
      `[claudian] picker: 返回项不是 nsIFile（${seen}）——缺 QueryInterface(nsIFile)？`,
    );
    throw new Error(`picker: 返回的文件项不可用（${seen}）`);
  }
  let name = typeof file?.leafName === "string" ? file.leafName : "";
  if (!name) {
    try {
      name = PathUtils.filename(path);
    } catch {
      name = "";
    }
  }
  return { path, name, sizeBytes };
}

/**
 * R7-J 落盘（裁决 J6，全程在**本轮 cwd 内**）：
 * - 有源路径（**只可能是宿主按一次性凭据换来的**，或本段自己写的临时文件）→ 直接 copy
 *   （不经 base64，省一次内存搬运）；
 * - 没有源路径 → 只能靠 base64 字节（截图直接粘贴）：先写进插件数据目录的临时文件再 copy，
 *   临时文件用完即删（**附件本体永不删**——历史消息还引用它）；
 * - 两条来源都没有 → 拒绝该条并给可读原因（安全修：客户端路径到此已被桥丢弃，不该出现
 *   「无路径又无字节」的半坏条目，这条是记账用的兜底）。
 * 名字净化/重名序号/20MB/10 个全在 utils/attachments 里（纯逻辑，有单测）。
 */
const attachmentsFs: AttachmentsFs = {
  exists: (path) => IOUtils.exists(path),
  makeDir: async (path) => {
    await IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
  },
  copyFile: async (from, to) => {
    await IOUtils.copy(from, to);
  },
  listNames: async (dir) => {
    try {
      return (await IOUtils.getChildren(dir)).map((p) => PathUtils.filename(p));
    } catch {
      return []; // 目录还不存在 → 没有重名
    }
  },
  join: (dir, name) => PathUtils.join(dir, name),
};

async function saveAttachmentFiles(
  attach: { files: AttachmentInput[]; sessionId: string; turn: number },
  cwd: string,
): Promise<SaveAttachmentsResult> {
  const temps: string[] = [];
  const tmpDir = PathUtils.join(sessionDataDir(), "attach-tmp");
  const files: AttachmentInput[] = [];
  /** 源已不在（编辑态引用的旧附件被手工删了）→ 只拒这一条，不掀翻整批 */
  const rejected: RejectedAttachment[] = [];
  for (const [i, file] of attach.files.entries()) {
    if (file.sourcePath) {
      if (!(await IOUtils.exists(file.sourcePath))) {
        rejected.push({ name: file.name, reason: "附件源文件已不存在" });
        continue;
      }
      files.push(file);
      continue;
    }
    if (!file.base64) {
      rejected.push({ name: file.name, reason: "附件缺少内容（未附字节）" });
      continue;
    }
    const tmp = PathUtils.join(
      tmpDir,
      `${Date.now().toString(36)}-${i}-${sanitizeAttachmentName(file.name)}`,
    );
    await IOUtils.makeDirectory(tmpDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.write(tmp, base64ToBytes(file.base64));
    temps.push(tmp);
    files.push({ ...file, sourcePath: tmp });
  }
  try {
    const out = await saveAttachments(
      { cwd, sessionId: attach.sessionId, turn: attach.turn, files },
      { fs: attachmentsFs },
    );
    return {
      saved: out.saved,
      rejected: [...rejected, ...out.rejected],
    };
  } finally {
    for (const tmp of temps) {
      void IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
    }
  }
}

/**
 * 本轮 spawn cwd（R6）：
 * single 模式 = 工作区根（既有行为逐字不变）；collection 模式 = `<根>/<合集目录名>`
 *（判定/净化/索引/建目录全在 utils/collectionWorkspace.ts，此函数只做宿主接线）。
 * 只有根本身不可用才抛 WORKSPACE_UNAVAILABLE；合集目录的任何问题都回落根目录并记日志。
 */
async function ensureWorkspace(itemKey: string | null): Promise<string> {
  try {
    return await resolveTurnWorkspace({
      root: getWorkspacePath(),
      mode: getWorkspaceMode(),
      itemKey,
      collections: createZoteroCollectionDeps(),
      fs: workspaceFs,
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    });
  } catch (err) {
    Zotero.logError(err as Error);
    throw err; // 根不可用 → 桥按 WORKSPACE_UNAVAILABLE 报错（§4.1 cwd 行）
  }
}

// ---- R7-A：面板内指令编辑器（CLAUDE.md 读写）----

/** instructions.InstructionsFs 的 IOUtils 实现（与 workspaceFs 同注入面风格） */
const instructionsFs: InstructionsFs = {
  exists: (path) => IOUtils.exists(path),
  makeDir: (path) =>
    IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    }),
  readText: async (path) =>
    (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null,
  writeText: async (path, text) => {
    await IOUtils.writeUTF8(path, text);
  },
};

/**
 * 当前分类目录名（R7-A 的 collection 作用域落点）：直接复用 R6 的 cwd 编排——
 * 「下一轮 spawn 会落在哪个目录」就是用户此刻该编的目录（单一真相，不另写一套合集判定）。
 * single 模式 / 无阅读文献 / 合集判定不出 → null（落点回落工作区根 + 提示）。
 * 副作用说明：ensureWorkspace 会建该目录（与「保存即创建」同一件事），失败只 log 不拦。
 */
async function currentCollectionDir(): Promise<string | null> {
  if (getWorkspaceMode() !== "collection") {
    return null;
  }
  try {
    const root = getWorkspacePath();
    const ctx = await buildTurnContext(createZoteroContextDeps());
    const cwd = await ensureWorkspace(ctx.itemKey);
    const trimmedRoot = root.replace(/[\\/]+$/, "");
    if (!cwd || cwd.replace(/[\\/]+$/, "") === trimmedRoot) {
      return null; // 本轮 cwd 就是根 → 没有分类目录可归属
    }
    // 取最后一段：两种分隔符都认（win32 反斜杠形态也不误判）
    const name = cwd.split(/[\\/]/).pop() ?? "";
    return name && name !== "." && name !== ".." ? name : null;
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/** R7-A：读指令（宿主自行拼路径 + 归一化校验在 utils/instructions.ts） */
async function readInstructionsFromHost(
  scope: unknown,
): Promise<InstructionsReadResult> {
  return readInstructions({
    root: getWorkspacePath(),
    scope,
    mode: getWorkspaceMode(),
    collectionDir: await currentCollectionDir(),
    fs: instructionsFs,
  });
}

/** R7-A：写指令（超限/越界拒绝且不落盘；父目录不存在先建） */
async function saveInstructionsFromHost(
  scope: unknown,
  text: unknown,
): Promise<InstructionsSavedResult> {
  return saveInstructions({
    root: getWorkspacePath(),
    scope,
    mode: getWorkspaceMode(),
    collectionDir: await currentCollectionDir(),
    text: typeof text === "string" ? text : "",
    fs: instructionsFs,
  });
}

// ---- R7-C：`/` 命令面板（宿主侧只扫两处固定目录；本地命令白名单在 utils/commands.ts）----

/**
 * 命令目录的 IOUtils 注入面（与 workspaceFs 同风格）：
 * 只列一层（不递归）、带类型/大小（符号链接与 > 64KB 在纯逻辑里跳过）、读失败回 null。
 */
const commandsFs: CommandScanDeps["fs"] = {
  listDir: async (dir) => {
    const paths = await IOUtils.getChildren(dir);
    const out: CommandDirEntry[] = [];
    for (const path of paths) {
      let stat: { type?: string; size?: number } | null = null;
      try {
        stat = (await IOUtils.stat(path)) as unknown as {
          type?: string;
          size?: number;
        };
      } catch {
        stat = null; // 取不到 stat → 当普通文件（读失败还会再兜一层）
      }
      out.push({
        name: PathUtils.filename(path),
        size: typeof stat?.size === "number" ? stat.size : undefined,
        symlink: stat?.type === "symlink",
        dir: stat?.type === "directory",
      });
    }
    return out;
  },
  readText: async (path) =>
    (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null,
  join: (dir, name) => PathUtils.join(dir, name),
};

/** 两处固定目录的扫描注入（home 与 CLI 探 PATH 用同一个 homeDir()，同源） */
function commandScanDeps(): CommandScanDeps {
  let home = "";
  try {
    home = homeDir();
  } catch {
    home = ""; // 取不到 home → 用户级命令目录当空（项目级照常）
  }
  return {
    root: getWorkspacePath(),
    home,
    fs: commandsFs,
  };
}

/**
 * R7-C / R12-A：命令清单（宿主只读 frontmatter；扫描异常在纯逻辑里收敛成空清单）。
 * 命令在前、技能在后（面板顺序即优先级：同名只留先出现的那条——命令赢技能）。
 */
async function listCommandsFromHost(): Promise<CommandEntry[]> {
  const deps = commandScanDeps();
  const commands = await scanCommands(deps);
  const taken = new Set(commands.map((c) => c.name));
  const skills = (await scanSkills(deps)).filter((s) => !taken.has(s.name));
  return [...commands, ...skills];
}

/**
 * R7-C：自定义命令的转发分支（headless 实测见 utils/commands.ts 的 COMMAND_FORWARD_MODE）。
 * expand（当前实测）→ 原样转发 `/名字 参数`，CLI 自己展开；inline（若 CLI 不再展开）→
 * 读命令正文，把「正文 + 参数」当 prompt 发。两条路径都留日志；宿主绝不本地执行命令。
 */
async function forwardCustomCommand(text: string): Promise<string> {
  const invocation = parseCommandInvocation(text);
  if (!invocation) {
    return text; // 普通输入（或本地命令——本地命令在面板里就执行了，不会走到发送）
  }
  if (COMMAND_FORWARD_MODE !== "inline") {
    Zotero.debug(
      `[claudian] command forward: /${invocation.name} mode=expand（CLI 自行展开）`,
    );
    return text;
  }
  const body = await readCommandBody(invocation.name, commandScanDeps());
  const forwarded = forwardCommandText(text, body);
  Zotero.debug(
    `[claudian] command forward: /${invocation.name} mode=${forwarded.mode} body=${body ? "found" : "missing"}`,
  );
  return forwarded.text;
}

/** R7-C：/export —— 落 `<工作区>/exports/<净化标题>-<时间戳>.md`（Markdown 源码，不经 HTML） */
async function exportSessionFromHost(input: {
  title: string;
  markdown: string;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const workspace = await ensureWorkspace(null);
    const dir = PathUtils.join(workspace, "exports");
    await IOUtils.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = sanitizeExportName(input.title) || "session";
    const path = PathUtils.join(dir, `${name}-${stamp}.md`);
    await IOUtils.writeUTF8(path, input.markdown);
    Zotero.debug(
      `[claudian] export: wrote ${input.markdown.length} chars → ${path}`,
    );
    return { ok: true, path };
  } catch (err) {
    Zotero.logError(err as Error);
    return { ok: false, error: `导出失败：${String(err)}` };
  }
}

/** 导出文件名净化：只留中英文数字与 `-_.`，其余换 `-`，长度截到 60（落点由宿主拼，UI 永不传路径） */
function sanitizeExportName(title: string): string {
  return title
    .replace(/[^\w一-龥.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

/** R7-C：打开工作区目录（Zotero.File.reveal：在系统文件管理器里定位） */
async function openWorkspacePathFromHost(path: string): Promise<void> {
  await Zotero.File.reveal(path);
}

// ---- R7-D：范围解析（宿主取数在 contextSource；纯逻辑在 utils/scope.ts）----

/**
 * resolveScope 的宿主实现：分类模式用**当前面板选中的分类**（PLAN §3.6 交互：菜单里只有
 * 「当前分类全部」，故 id 由宿主现取，UI 永不传 id）；无选中分类 → 空清单
 * （R12-C：UI 不落 0 篇 chip，就地给提示 + 重试）。
 * 请求**只在用户明确点了选项/重试/刷新时**到来（R12-A：展开面板不发请求）。
 */
async function resolveScopeFromHost(kind: ScopeKind): Promise<ResolvedScope> {
  if (kind === "collection") {
    const collectionID = getSelectedCollectionID();
    const label = collectionID
      ? (getCollectionName(collectionID) ?? "当前分类")
      : "当前分类";
    if (!collectionID) {
      return { kind, label, items: [], truncated: false };
    }
    return resolveScope(
      { kind, collectionId: String(collectionID), label },
      createZoteroScopeDeps(),
    );
  }
  return resolveScope(
    { kind, label: SCOPE_SELECTION_LABEL },
    createZoteroScopeDeps(),
  );
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
  addDirs: string[] | null,
): Promise<string | null> {
  if (!addDirs || addDirs.length === 0) {
    return null;
  }
  const content = buildAttachmentDenySettings(addDirs); // 非法路径/空集合在此抛错
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
    throw new Error(`deny settings write failed: ${String(err)}`, {
      cause: err,
    });
  }
}

/** 该轮进程退出：删除本轮写保护文件（ignoreAbsent；失败只 log，不影响解锁） */
function cleanupDenySettings(path: string): void {
  void IOUtils.remove(path, { ignoreAbsent: true }).catch((err: unknown) => {
    Zotero.debug(`[claudian] deny settings cleanup failed: ${String(err)}`);
  });
}

// ---- 该轮 mcp-config 文件（argv 只出现路径：一次性 token 不进 ps 可见面）----

/** mcp-config 文件序号：理由同 denySettingsSeq（清理可能落在下一轮刚写的文件上） */
let mcpConfigSeq = 0;

/**
 * 该轮 mcp-config 临时文件（0600，内容 = cliRunner.buildMcpConfigJson）：spawn 时经
 * `--mcp-config <path>` 加载，token 不再出现在 argv 里。与 deny settings 同目录/同命名风格/同清理时机。
 * 写失败 → 返回 null → 桥回落内联 JSON（可用性优先，绝不因此拦下这一轮；日志在 cliRunner 里记）。
 */
function prepareMcpConfig(port: number, token: string): Promise<string | null> {
  return prepareMcpConfigFile(
    {
      dataDir: sessionDataDir(),
      fs: {
        makeDir: (path) =>
          IOUtils.makeDirectory(path, {
            createAncestors: true,
            ignoreExisting: true,
          }),
        writeText: async (path, text) => {
          await IOUtils.writeUTF8(path, text);
        },
        // IOUtils.writeUTF8 无 mode 参数：写后单独收紧（与 deny settings 同法；此处收不紧按失败处理）
        chmod: async (path, mode) => {
          await IOUtils.setPermissions(path, mode);
        },
        remove: (path) => IOUtils.remove(path, { ignoreAbsent: true }),
      },
      joinPath: (dir, name) => PathUtils.join(dir, name),
      nextNonce: () =>
        `${Date.now().toString(36)}-${(mcpConfigSeq++).toString(36)}`,
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    },
    port,
    token,
  );
}

/** 该轮进程退出/失败：删除本轮 mcp-config 文件（ignoreAbsent；失败只 log，同 cleanupDenySettings） */
function cleanupMcpConfig(path: string): void {
  void IOUtils.remove(path, { ignoreAbsent: true }).catch((err: unknown) => {
    Zotero.debug(`[claudian] mcp config cleanup failed: ${String(err)}`);
  });
}

// ---- 上下文与 prompt（contextBuilder DI + promptTemplate 模板）----

async function buildTurnPrompt(
  text: string,
  refKeys: string[] = [],
  scope: ScopeInject | null = null,
  attach: {
    files: AttachmentInput[];
    sessionId: string;
    turn: number;
  } | null = null,
): Promise<TurnPromptInput> {
  const ctx = await buildTurnContext(createZoteroContextDeps());
  // R7-B：点名文献 → 参考条目区块 + 扩 --add-dir（只读面扩大，写保护由 deny 逐目录兜住）。
  // 取数异常不拦这一轮（参考条目是加分项，不是发送前提）：解析失败当没有引用处理。
  let refs: ResolvedRef[] = [];
  if (refKeys.length > 0) {
    try {
      refs = await resolveMentionRefs(refKeys, {
        resolveItem: resolveMentionItem,
      });
    } catch (err) {
      Zotero.logError(err as Error);
      refs = [];
    }
  }
  const usable = refs.filter((ref) => !ref.missing);
  const missing = refs.length - usable.length;
  if (missing > 0) {
    // 查不到的条目按 PLAN 跳过（UI 侧已由 refsResolved 标红提示）
    Zotero.debug(`[claudian] mention: ${missing} ref(s) missing → skipped`);
  }
  // R7-D：范围注入（PLAN §3.6）——itemKeys 在桥侧白名单化；发送前重新取数（已删的跳过）。
  // 与 @ 提及同款取舍：范围是加分项，不是发送前提，取数失败当没有范围处理。
  let scopeRefs: ResolvedRef[] = [];
  const scopeKeys = scope?.itemKeys ?? [];
  if (scopeKeys.length > 0) {
    try {
      scopeRefs = (
        await resolveMentionRefs(scopeKeys, { resolveItem: resolveMentionItem })
      ).filter((ref) => !ref.missing);
    } catch (err) {
      Zotero.logError(err as Error);
      scopeRefs = [];
    }
    if (scopeRefs.length < scopeKeys.length) {
      Zotero.debug(
        `[claudian] scope: ${scopeKeys.length - scopeRefs.length} item(s) missing → skipped`,
      );
    }
  }
  const scopeBlock = buildScopeBlock({
    label: scope?.label ?? "",
    items: scopeRefs,
    truncated: scope?.truncated === true,
  });
  // R7-J：本轮附件落盘 + [Attachments] 区块（落点 = 本轮 cwd 下，见 utils/attachments）。
  // 落盘失败不拦这一轮（附件是加分项）：当没有附件处理，拒绝原因照回 UI。
  let attachmentSaved: SaveAttachmentsResult | null = null;
  let attachmentsBlock = "";
  if (attach && attach.files.length > 0) {
    try {
      const cwd = await ensureWorkspace(ctx.itemKey); // 与 spawn 的 cwd 同源同值
      attachmentSaved = await saveAttachmentFiles(attach, cwd);
      attachmentsBlock = buildAttachmentsBlock(attachmentSaved.saved);
    } catch (err) {
      Zotero.logError(err as Error);
      attachmentSaved = {
        saved: [],
        rejected: attach.files.map((f) => ({
          name: f.name || "附件",
          reason: `保存失败：${String(err)}`,
        })),
      };
    }
  }
  // 三个区块都在用户输入之前（PLAN §3/§3.6）：[Referenced items] → [Scope: …] → [Attachments]
  const injectBlock = [
    buildReferencedItemsBlock(usable),
    scopeBlock,
    attachmentsBlock,
  ]
    .filter((block) => block.trim() !== "")
    .join("\n\n");
  // R7-C：自定义命令转发（CLI 会展开 → 原样；不展开 → 正文替身。两条分支见 forwardCustomCommand）
  const outgoing = await forwardCustomCommand(text);
  return {
    ...(attachmentSaved ? { attachmentSaved } : {}),
    itemKey: ctx.itemKey,
    attachmentKey: ctx.attachmentKey,
    addDir: ctx.addDir,
    // 安全红线：范围目录一并进 --add-dir（上限 40），整批喂给 deny 生成（桥侧逐目录覆盖）
    addDirs: mergeScopeAddDirs(
      ctx.addDir,
      usable.map((ref) => ref.pdfDir),
      scopeRefs.map((ref) => ref.pdfDir),
    ),
    prompt: buildPrompt(ctx.promptContext, outgoing, injectBlock),
  };
}

/** UI 顶栏 readerContext（§4.6 宿主→UI 表）：取数（DI）与映射（纯函数）分工，映射有单测 */
async function buildReaderContext(): Promise<HostMessage | null> {
  try {
    const deps = createZoteroContextDeps();
    const reader = await deps.getSelectedReader();
    let contextItem: ItemMetadata | null = null;
    if (reader?.itemID != null) {
      const attachment = await deps.getAttachment(reader.itemID);
      const parent =
        attachment?.parentItemID == null
          ? null
          : await deps.getItemMetadata(attachment.parentItemID);
      // 独立 PDF（无父条目）或父条目查不到 → 上下文条目回落附件自身（R6 契约，口径同发送轮）
      contextItem = resolveContextItem(
        parent,
        parent ? null : await deps.getItemMetadata(reader.itemID),
      );
    }
    return readerContextMessage(reader, contextItem);
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/**
 * readerContext 增量推送：当前页/划选会随阅读变化，而 reader 没有对应的插件事件
 *（官方事件只有 render* 系列）——2s 轮询取数、变了才推（PONYTAIL：平台无 pageChange 事件，
 * 轮询是当前最简替代；单次只读几个属性，若日后有官方事件再换成事件驱动）。
 * 只在拿到有效阅读上下文（有绑定的上下文条目：父条目，或独立 PDF 的附件自身）时推：
 * 切到书库/无阅读器不推 null 覆盖，免得 UI 顶栏在翻页/切页时闪断
 *（发送时刻的真实上下文仍由 buildTurnContext 现取）。
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
            Record<string, { type?: unknown } | undefined> | undefined;
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
  async writeText(path, data, opts) {
    await IOUtils.writeUTF8(path, data);
    // IOUtils.writeUTF8 无 mode 参数（同 rewindFs 的结论）→ 写后单独收紧；
    // 会话索引/历史是用户研究内容，默认 umask 会留成 0644（同机其他用户可读）
    if (opts?.mode !== undefined) {
      try {
        await IOUtils.setPermissions(path, opts.mode);
      } catch (err) {
        Zotero.debug(`[claudian] session chmod failed: ${String(err)}`);
      }
    }
  },
  async appendText(path, data, opts) {
    // 真追加（不读不改写）：历史文件唯一写入口，读故障不再能演变成覆盖（BUG-21）。
    // appendOrCreate：首次追加时文件还不存在，append 模式会失败
    await IOUtils.writeUTF8(path, data, { mode: "appendOrCreate" });
    if (opts?.mode !== undefined) {
      try {
        await IOUtils.setPermissions(path, opts.mode);
      } catch (err) {
        Zotero.debug(`[claudian] session chmod failed: ${String(err)}`);
      }
    }
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

// ---- R7-H：真回滚面（快照 / 分叉 / journal 崩溃恢复）----

/** 回滚面 fs（IOUtils 真实现）：写后单独收紧 0600（IOUtils.writeUTF8 无 mode 参数） */
const rewindFs: RewindFs = {
  async readText(path) {
    return (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
  },
  /** 可选能力：扫描超上限时按 mtime 降序挑候选（最近写过的项目目录更可能是目标） */
  async mtimeMs(path) {
    try {
      const st = await IOUtils.stat(path);
      return typeof st.lastModified === "number" ? st.lastModified : null;
    } catch {
      return null;
    }
  },
  async writeText(path, data, opts) {
    await IOUtils.writeUTF8(path, data);
    if (opts?.mode !== undefined) {
      try {
        await IOUtils.setPermissions(path, opts.mode);
      } catch (err) {
        // 收不紧只告警：内容不是凭据（最坏是本机其它用户读到自己的会话快照）
        Zotero.debug(`[claudian] rewind chmod failed: ${String(err)}`);
      }
    }
  },
  async listNames(dir) {
    if (!(await IOUtils.exists(dir))) {
      return [];
    }
    return (await IOUtils.getChildren(dir)).map((p) => PathUtils.filename(p));
  },
  async makeDir(path) {
    await IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
  },
  async remove(path) {
    await IOUtils.remove(path, { ignoreAbsent: true });
  },
  async exists(path) {
    return IOUtils.exists(path);
  },
  join: (...seg) => PathUtils.join(...seg),
};

/** CLI 的项目目录根（`~/.claude/projects`） */
function claudeProjectsRoot(): string {
  return PathUtils.join(homeDir(), ".claude", "projects");
}

/**
 * CLI 会话文件路径的**快路径提示**（`<projectsRoot>/<cwd 转义>/<id>.jsonl`）。
 * 不可当权威：cwd 用 spawn 时的原值转义，而 CLI 派生目录名用的是它自己看到的物理路径
 * （符号链接如 /tmp、Windows junction/短名、超长截断都会差）→ 权威来源见
 * claudeSessionLookupForHost（按会话 id 定位）。
 */
function claudeProjectDirFor(cwd: string): string {
  return encodeProjectDir(cwd);
}

/** 仅作 hostBridge 的回落口径（findSessionFile 未接线时）；真宿主走 findClaudeSessionFile */
function claudeSessionPath(cwd: string, claudeSessionId: string): string {
  return PathUtils.join(
    claudeProjectsRoot(),
    encodeProjectDir(cwd),
    `${claudeSessionId}.jsonl`,
  );
}

/**
 * R8：按会话 id 定位 CLI 会话文件（快路径 = encodeProjectDir 推目录；未命中扫 projects 一层）。
 * 返回实际命中的目录名 + 路径 + 「扫完了没有」（`capped`，`/diag` 要它；回滚/分支只看 `.found`）。
 * 找不到 → `found=null`（调用方 fail-safe）。回滚/分支/快照与 /diag 共用这一个入口。
 */
async function claudeSessionLookupForHost(
  cwd: string,
  claudeSessionId: string,
): Promise<SessionFileLookup> {
  return findClaudeSessionFile(
    { projectsRoot: claudeProjectsRoot(), claudeSessionId, cwd },
    { fs: rewindFs, log: (message) => Zotero.debug(`[claudian] ${message}`) },
  );
}

/**
 * 启动时清残留 journal（崩溃在被替换窗口里）：按 journal 还原原文件，幂等。
 * 失败只记日志（留给下一次启动重试），绝不拦插件加载。
 */
function recoverRewindAtStartup(): void {
  void recoverPendingRewind(
    { dataDir: sessionDataDir() },
    { fs: rewindFs, log: (message) => Zotero.debug(`[claudian] ${message}`) },
  )
    .then((res) => {
      if (res.restored) {
        Zotero.debug("[claudian] rewind journal recovered at startup");
      } else if (res.error) {
        Zotero.debug(`[claudian] rewind recovery pending: ${res.error}`);
      }
    })
    .catch((err: unknown) => {
      Zotero.debug(`[claudian] rewind recovery failed: ${String(err)}`);
    });
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

// ---- R9：/diag 诊断报告（只读采集 → utils/diag 纯函数拼文本）----
//
// 目的一句话：无法被远程操作的机器（尤其 Windows）跑一次 /diag，把输出贴回来就够排障。
// 纪律（PLAN-R9 红线，代码里逐条对应）：
//  - 绝不输出密钥/令牌：报告行由 utils/diag 白名单定死，本文件的采集器**只传**这 15 项；
//  - 不得触发权限卡 / 不得 spawn CLI 轮次（唯一子进程 = `claude --version`，超时文案见 diagCliLine）；
//  - 不得改任何状态：不建目录、不写索引、不碰 CLI 会话文件（全部只读）；
//  - 降级不抛：每项独立兜底，失败写 `(error: 原因)`，整份报告照出。

/**
 * `claude --version` 探测超时（诊断专用，比启动检测的 10s 短：弹层不该干等）。
 * 导出：冷启/杀软首扫拖慢一次就会撞上它（W-A10），要调就只调这一个数——
 * 报告里的秒数也由它算出来（diagVersionTimeoutText），不会两处漂移。
 */
export const DIAG_VERSION_TIMEOUT_MS = 3000;

/** 超时文案（自解释 + 可行动）：只写 "timeout" 会被读成「CLI 坏了」，得把最可能的成因与下一步写进原处 */
function diagVersionTimeoutText(): string {
  return `(error: 探测超时 ${DIAG_VERSION_TIMEOUT_MS / 1000}s——Windows 首次扫描/杀软可能拖慢，请重跑 /diag 或直接发消息试)`;
}

/** `(error: …)` 的原因文本：单行、限量（异常原文可能带路径/换行，别灌进报告） */
function diagErrorReason(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/\s+/g, " ").slice(0, 200).trim() || "未知原因";
}

/** 单项采集：成功 → 文本；抛错 → `{error}`（**逐项兜底**，一项坏不掀整份报告） */
async function diagField(
  collect: () => string | Promise<string>,
): Promise<unknown> {
  try {
    return await collect();
  } catch (err) {
    return { error: diagErrorReason(err) };
  }
}

/**
 * CLI 行：解析到的路径 + 派发通道 + `--version` 输出首行。
 * 通道写 spawn 层真值（darwin 恒为 sh：提 fd 上限的包装，见 resolveSpawnBase）；未找到时
 * 三项都写 none——报告不猜。
 * 失败分支带**原文**（G-15）：`runProbe` 的 reason（spawn 异常 / 非零退出的 stderr 尾部）。
 * win32 cmd 通道类故障（G-13 那一族）只有这句原文能判读；成功时 reason 为空。
 * 超时（W-A10：冷启/Defender 首扫可能 >3s）写自解释 + 可行动的文案，不写裸 "timeout"
 * ——报告是要贴给远程排障的人看的，「CLI 坏了」这个误判会让整轮白跑。
 * 原文长度让位给本行的其余字段，绝不因整值截断而丢掉原文尾巴。
 */
async function diagCliLine(): Promise<string> {
  const base = await resolveSpawnBase();
  if (!base.command) {
    return "command=未找到 channel=none version=none";
  }
  const run = await runProbe(base, ["--version"], DIAG_VERSION_TIMEOUT_MS);
  const firstLine = run.stdout.split(/\r?\n/)[0].trim();
  // 原文按**剩余空间**收敛（不是拍死 200）：报告层会把整值截到 DIAG_VALUE_MAX，
  // 不预留就会把最有用的那句原文尾巴切掉——而它正是这一行存在的理由（G-15）
  const prefix = `command=${base.command} channel=${base.channel} version=`;
  const reasonBudget = Math.max(80, DIAG_VALUE_MAX - prefix.length - 12);
  const rawReason = run.reason.replace(/\s+/g, " ").trim();
  const reason =
    rawReason.length > reasonBudget
      ? `${rawReason.slice(0, reasonBudget - 1)}…` // 截断必须留痕（与报告层同款省略号）
      : rawReason;
  const version = run.timedOut
    ? diagVersionTimeoutText()
    : firstLine && run.ok
      ? firstLine
      : `(error: ${reason || "无法执行"})`;
  return `${prefix}${version}`;
}

/** 登录态：取启动检测的缓存结论，**不重跑探测**（`:ok|not-logged-in|unknown`） */
function diagAuthState(): string {
  const status = getCliStatus();
  if (!status) {
    return "unknown";
  }
  if (status.ok) {
    return "ok";
  }
  return status.code === "CLAUDE_AUTH_FAILED" ? "not-logged-in" : "unknown";
}

/**
 * 工作区行：模式 + 根路径 + 根存在性/可写性（写成探针与下一轮 spawn 同一真相）。
 * win32 上 `writable` **不判**（写 unverified(win32)）：上游 `nsLocalFileWin::IsWritable`
 * 先 `IsDirectory(aIsWritable)` 再直接 `return NS_OK` → 对任何已存在目录恒为 true（工作区根
 * 永远是目录，且它只读 DOS 只读属性、不看 ACL），即「最需要它的那台机器上唯一会说谎的一行」（X-B6）。
 * 修法选了改动最小且不违反 R9 只读红线的那条（报告三选一里的「不假装能判断」）：
 * ① 写探针文件能真判但违反「不改任何状态」红线，排除；② 只印存在性 → 与 macOS 口径分叉、
 * 报告两边不可比；③ win32 明确标不可判定，Windows 的真实信号交给 history 行（追加有没有落盘）
 * 与 cli 行（spawn 原文）。darwin/linux 是 `access(W_OK)` 真检查，保留原判据。
 */
async function diagWorkspaceLine(): Promise<string> {
  const root = getWorkspacePath();
  const exists = await IOUtils.exists(root);
  let writable: string;
  if (!exists) {
    writable = "false"; // 目录都没有 → 无可写性可言（两平台同口径）
  } else if (currentPlatform() === "win32") {
    writable = "unverified(win32)";
  } else {
    writable = `${(await IOUtils.getFile(root)).isWritable()}`;
  }
  return `mode=${getWorkspaceMode()} path=${root} exists=${exists} writable=${writable}`;
}

/**
 * 历史目录行（本批新增；win32 上「能不能写」的实测替代判据）：
 * 只列目录 + stat——文件名个数、最近一次追加时间（目录内最新 mtime）、该文件的权限位，
 * **绝不读文件内容**（报告里不出现任何会话正文），也不建目录/不改权限。
 * 用途：验证 R11 的 0600 改动没有妨碍 Windows 上的追加（数量/时间会随每轮增长即算通过），
 * 以及 W-B13（去掉写位 = 置只读）有没有发生——win32 的 mode 由 DOS 只读属性映射而来，
 * 有没有写位是能看出来的；取不到就写 unknown，不编数。目录不存在 → files=0。
 */
async function diagHistoryLine(dataDir: string): Promise<string> {
  const dir = PathUtils.join(dataDir, "history");
  if (!(await IOUtils.exists(dir))) {
    return "files=0 lastAppended=none perms=unknown";
  }
  const paths = await IOUtils.getChildren(dir);
  let newestMs = -1;
  let perms = "unknown";
  for (const path of paths) {
    try {
      const stat = (await IOUtils.stat(path)) as unknown as {
        lastModified?: number;
        permissions?: number;
      };
      const ms = stat?.lastModified;
      if (typeof ms === "number" && Number.isFinite(ms) && ms > newestMs) {
        newestMs = ms;
        // 权限位写成源码同形的 0oNNN：读报告的人能直接与 SESSION_FILE_MODE 对照
        perms =
          typeof stat.permissions === "number" &&
          Number.isFinite(stat.permissions)
            ? `0o${stat.permissions.toString(8)}`
            : "unknown";
      }
    } catch {
      // 单条 stat 失败 → 跳过该条（不掀整行；降级不抛由 diagField 兜底）
    }
  }
  const lastAppended = newestMs < 0 ? "none" : new Date(newestMs).toISOString();
  return `files=${paths.length} lastAppended=${lastAppended} perms=${perms}`;
}

/**
 * 当前合集目录名（collection 模式）：判定口径与 resolveTurnWorkspace 的合集分支**逐字对齐**
 * （pickCollectionID → 读索引 → resolveCollectionDirName），只是去掉建目录/写索引那两步——
 * 诊断不得改任何状态。single 模式 / 无上下文条目 / 不在任何合集 → null。
 */
async function diagCollectionDir(
  itemKey: string | null,
): Promise<string | null> {
  if (getWorkspaceMode() !== "collection" || !itemKey) {
    return null;
  }
  const root = getWorkspacePath();
  const picked = pickCollectionID(
    getSelectedCollectionID(),
    await getItemCollectionIDs(itemKey),
  );
  if (picked == null) {
    return null;
  }
  const index = parseCollectionIndex(
    await workspaceFs.readText(PathUtils.join(root, WORKSPACE_INDEX_FILE)),
    (message) => Zotero.debug(`[claudian] ${message}`),
  );
  return resolveCollectionDirName({
    collectionID: picked,
    name: getCollectionName(picked),
    index,
    takenNames: await workspaceFs.listNames(root),
  }).dir;
}

interface DiagReaderFacts {
  itemKey: string | null;
  attachmentKey: string | null;
  hasParent: boolean;
}

/** 当前阅读上下文（与 buildReaderContext 同口径：父条目优先；独立 PDF 回落附件自身） */
async function diagReaderFacts(): Promise<DiagReaderFacts> {
  const zDeps = createZoteroContextDeps();
  const reader = await zDeps.getSelectedReader();
  if (!reader || reader.itemID == null) {
    return { itemKey: null, attachmentKey: null, hasParent: false };
  }
  const attachment = await zDeps.getAttachment(reader.itemID);
  const parent =
    attachment?.parentItemID == null
      ? null
      : await zDeps.getItemMetadata(attachment.parentItemID);
  const contextItem = resolveContextItem(
    parent,
    parent ? null : await zDeps.getItemMetadata(reader.itemID),
  );
  return {
    itemKey: contextItem?.key ?? null,
    attachmentKey: attachment?.key ?? null,
    hasParent: parent != null,
  };
}

/**
 * 会话文件行：快路径（cwd 推目录）命中 → quick；否则按会话 id 扫一层 → scan；都没有 → none。
 * 未命中且**扫满上限**时补 `capped=true`——「没找完」与「确实没有」在报告里必须能分出来
 * （失败方向是安全的：绝不会误碰别的会话文件，但用户得知道该清 projects 目录还是查 CLI）。
 */
async function diagSessionFileLine(
  claudeSessionId: string | null,
  cwd: string,
): Promise<string> {
  if (!claudeSessionId) {
    return "found=false via=none dir=(none)";
  }
  const quickDir = encodeProjectDir(cwd);
  const quickPath = PathUtils.join(
    claudeProjectsRoot(),
    quickDir,
    `${claudeSessionId}.jsonl`,
  );
  if (await rewindFs.exists(quickPath)) {
    return `found=true via=quick dir=${quickDir}`;
  }
  const lookup = await claudeSessionLookupForHost(cwd, claudeSessionId);
  if (lookup.found) {
    return `found=true via=scan dir=${lookup.found.projectDir}`;
  }
  // 扫满 500 个目录仍未命中 → 必须写出来：否则「没找完」会被读成「确实没有」，
  // 用户拿着假结论去查 CLI 侧（回滚/分支那两条路此时也是以 SOURCE_MISSING 拒的）
  return `found=false via=none dir=(none)${
    lookup.capped ? " capped=true（目录数超上限）" : ""
  }`;
}

/** 快照行：目录 + 张数 + 最大轮号（无会话/无索引 → 0 / none，不编数） */
async function diagSnapshotsLine(
  dataDir: string,
  sessionId: string | null,
): Promise<string> {
  if (!sessionId) {
    return "dir=(none) count=0 lastTurn=none";
  }
  const dir = snapshotDir(dataDir, sessionId);
  const index = await readSnapshotIndex(
    { dataDir, sessionId },
    { fs: rewindFs },
  );
  const snapshots = Array.isArray(index?.snapshots) ? index.snapshots : [];
  const turns = snapshots
    .map((entry) => entry.turn)
    .filter((turn) => typeof turn === "number" && Number.isFinite(turn));
  const lastTurn = turns.length > 0 ? Math.max(...turns) : "none";
  return `dir=${dir} count=${snapshots.length} lastTurn=${lastTurn}`;
}

/** journal 行：残留回滚 journal 是否待处理（崩溃后未还原的信号） */
async function diagJournalLine(dataDir: string): Promise<string> {
  return `pending=${await rewindFs.exists(journalPath(dataDir))}`;
}

/** prefs 行：只出档位/开关/置顶数（Key 等凭据不进报告——有值也只写 set/unset，此处根本不传） */
function diagPrefsLine(record: SessionRecord | null): string {
  return [
    `permissionMode=${record?.permissionMode ?? getDefaultPermissionMode()}`,
    `showUsage=${getShowUsage()}`,
    `autoShowPane=${getAutoShowPane()}`,
    `pinnedSessions=${getPinnedSessions().length}`,
  ].join(" ");
}

/**
 * 采集并拼出报告（hostBridge 的 diag.collect 实现）。只读、逐项兜底、永不抛。
 * sessionId = 面板当前绑定的插件会话（null = 未绑定；会话已删/换库 → 按查不到处理）。
 */
async function collectDiagReport(sessionId: string | null): Promise<string> {
  const dataDir = sessionDataDir();
  let record: SessionRecord | null = null;
  try {
    record = sessionId ? (getSessionStore().get(sessionId) ?? null) : null;
  } catch (err) {
    // 索引尚未载入/读失败：报告照出（session 行写 (none)，不影响其它项）
    Zotero.debug(`[claudian] diag session lookup failed: ${String(err)}`);
    record = null;
  }
  const claudeSessionId = record?.claudeSessionId ?? null;

  // 阅读上下文先取：reader 行 + 合集目录/sessionFile 的 cwd 判定都要它
  let readerError: unknown = null;
  let reader: DiagReaderFacts = {
    itemKey: null,
    attachmentKey: null,
    hasParent: false,
  };
  try {
    reader = await diagReaderFacts();
  } catch (err) {
    readerError = { error: diagErrorReason(err) };
  }

  let collection: unknown = null;
  try {
    collection = (await diagCollectionDir(reader.itemKey)) ?? "(none)";
  } catch (err) {
    collection = { error: diagErrorReason(err) };
  }

  // 下一轮 spawn 会用的 cwd（合集目录不存在也按「将落在那里」报——只读预测，不建目录）
  const cwd =
    typeof collection === "string" && collection !== "(none)"
      ? PathUtils.join(getWorkspacePath(), collection)
      : getWorkspacePath();

  return buildDiagReport({
    time: await diagField(() => new Date().toISOString()),
    plugin: await diagField(
      () => `${PLUGIN_VERSION} (${ZOTERO_SUPPORT_RANGE})`,
    ),
    zotero: await diagField(() => Zotero.version),
    platform: await diagField(
      () =>
        `${currentPlatform()} / ${Services.appinfo.XPCOMABI.split("-")[0] || "unknown"}`,
    ),
    cli: await diagField(diagCliLine),
    "cli.auth": await diagField(diagAuthState),
    workspace: await diagField(diagWorkspaceLine),
    collection,
    reader:
      readerError ??
      `itemKey=${reader.itemKey ?? "(none)"} attachmentKey=${reader.attachmentKey ?? "(none)"} hasParent=${reader.hasParent}`,
    session: `current=${sessionId ?? "(none)"} claudeSessionId=${claudeSessionId ?? "(none)"}`,
    sessionFile: await diagField(() =>
      diagSessionFileLine(claudeSessionId, cwd),
    ),
    history: await diagField(() => diagHistoryLine(dataDir)),
    snapshots: await diagField(() => diagSnapshotsLine(dataDir, sessionId)),
    journal: await diagField(() => diagJournalLine(dataDir)),
    prefs: await diagField(() => diagPrefsLine(record)),
  });
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
    prepareMcpConfig,
    cleanupMcpConfig,
    prepareDenySettings,
    cleanupDenySettings,
    resolvePermission,
    getDefaultPermissionMode,
    spawnTurn: (options) => spawnTurn(getSubprocess(), options),
    buildReaderContext,
    sessions: getSessionStore(),
    inputHistory: getInputHistoryStore(),
    lookupItem: lookupItemByKey,
    // R7-K：置顶集合（本地 prefs；置顶不限量、不受归档影响）
    pinnedSessions: {
      get: getPinnedSessions,
      set: setPinnedSessions,
    },
    // M7 笔记写入：唯一写库模块（PLAN §7.1 审查口径——写 API 只出现在 notes.ts）
    notes: { saveNote, listNotes },
    // R4-3 用量/余额
    balance: { get: (force) => getBalanceService().get(force) },
    showUsage: getShowUsage,
    // R10：会话区展开态（默认收起 = 一行；重开面板经 uiPrefs 还原）
    sessionsExpanded: {
      get: getSessionsExpanded,
      set: setSessionsExpanded,
    },
    getWorkspaceMode,
    // R7-A 指令编辑器 / R7-B @ 提及（取数与落点全在宿主侧）
    instructions: {
      read: readInstructionsFromHost,
      save: saveInstructionsFromHost,
    },
    mentions: {
      search: searchMentionItemsInLibrary,
      resolveItem: resolveMentionItem,
    },
    // R7-C 命令面板 / R7-D 范围注入（只读扫描 + 工作区内落盘）
    listCommands: listCommandsFromHost,
    resolveScope: resolveScopeFromHost,
    openWorkspacePath: openWorkspacePathFromHost,
    exportSession: exportSessionFromHost,
    // R9：/diag 诊断报告（只读采集；文本由 utils/diag 拼）
    diag: { collect: collectDiagReport },
    // R8：面板顶栏「全页」→ 独立工作台标签页（同一窗口只有一个实例，重复调用是聚焦）
    openFullPage: () => {
      openMainTab();
    },
    // R7-J 安全修：「选择文件」由宿主弹原生选择器（路径只在宿主内存，页面只拿一次性凭据）
    pickFiles: pickAttachmentFiles,
    // R7-H：真回滚面（快照落插件数据目录；分叉目标 = CLI 自己的会话文件）
    rewind: {
      dataDir: sessionDataDir(),
      fs: rewindFs,
      // 按会话 id 定位（形状与 utils/rewind.findClaudeSessionFile 同源：{found, capped}）
      findSessionFile: claudeSessionLookupForHost,
      projectDirFor: claudeProjectDirFor,
      claudeSessionPath,
      platform: currentPlatform(),
    },
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
  // R7-H：崩溃残留 journal 的还原时点（幂等，失败只记日志）
  recoverRewindAtStartup();
  registerSelectionTracking();
  registerSelectionNoteButton();
  startReaderContextWatch();
  // 自动显示控制器：sidenav 按钮的 data-pane = CHAT_PANE_ID
  paneAutoShow = createPaneAutoShow(
    {
      isEnabled: getAutoShowPane,
      schedule: (fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        return () => clearTimeout(timer);
      },
      log: (message) => Zotero.debug(`[claudian] ${message}`),
    },
    CHAT_PANE_ID,
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
    // 两侧栏都启用（R8 改）：工具栏「Claude」按钮要能在**书库标签**下也打开本面板
    //（reader 侧挂在 context-pane、书库侧挂在 item-pane）。Zotero 的 setEnabled(false) 会把
    // section 标 hidden → 该侧的 sidenav 按钮被收进 hidden 容器里、scrollToPane 也不认它，
    // 书库下点按钮就成了空动作。自动切面板仍只在 reader 侧触发（paneAutoShow 按 tabType 判）。
    onItemChange: ({ doc, body, item, tabType, setEnabled }) => {
      setEnabled(true);
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
