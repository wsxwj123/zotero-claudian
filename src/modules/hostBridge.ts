// hostBridge.ts — 宿主↔UI postMessage 桥（INTERFACE §4.6）+ 会话运行时（M4 起，M5 补全会话管理）。
// 纯逻辑模块：所有宿主服务（postMessage/launchURL/spawn/上下文/工作区/prefs/会话存储）依赖注入，
// node:test 全程 fake（Gecko API 零引用）；Zotero 真实接线在 sections.ts。
// 握手方向（spike 实测定型）：宿主在 browser load 先发 init，页面经 event.source 回 hello。
// M5 范围：会话索引 CRUD（createSession/deleteSession/setPermissionMode）、getHistory 回放、
// resume（session.claudeSessionId → --resume）、SESSION_GONE 判定（classifyProcError）；
// M6 范围：权限卡流转（requestPermission 广播 / permissionResponse 回写 / remember 规则串落 allowedTools /
// 该轮结束撤销 MCP token）；
// M7 范围：saveNote/listNotes 转发到 notes.ts（宿主唯一写库模块，deps.notes 注入；
// 未接线 → 回 SAVE_FAILED，UI 不悬挂等待）。

import {
  buildSpawnArgs,
  classifyProcError,
  PERMISSION_MODES,
  type PermissionMode,
  type SpawnTurnOptions,
  type TurnEvent,
  type TurnHandle,
} from "./cliRunner";
import type { CliChannel, CliStatus } from "./cliDetect";
import {
  SESSION_TITLE_MAX,
  type SessionRecord,
  type SessionStore,
} from "../utils/sessionStore";
import type { HostMessage, SessionSummary } from "../chat/lib/types";
import { buildRememberRule } from "../utils/rememberRule";
import type {
  PermissionRequestPayload,
  ResolvedPermission,
} from "./permissionMcp";
// 类型只读导入（notes.ts 运行时依赖 Zotero 全局，宿主侧接线在 sections.ts 完成）
import type { NoteListResult, NoteSaveResult, SaveNoteInput } from "./notes";

/** UI 实例键（真实形态为 browser.contentWindow；测试用普通对象） */
export type UiWindowKey = object;

/** 页面回发通道（MessageChannel 宿主端；按实际用到的成员收窄，与 sections.ts 同风格） */
export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close?(): void;
}

/** 该轮 prompt 与上下文（宿主组装，§4.1/§4.1.1） */
export interface TurnPromptInput {
  itemKey: string | null;
  attachmentKey: string | null;
  prompt: string;
  addDir: string | null;
}

export interface HostBridgeDeps {
  /** 向实例发消息（真实实现：contentWindow.postMessage(msg, "*", ports)，内部 try/catch 防死实例） */
  post(win: UiWindowKey, msg: HostMessage, ports?: unknown[]): void;
  /** 建握手用 MessageChannel（Gecko 侧注入；不可用返回 null → 页面回退 event.source，见 §4.6） */
  createChannel(): { port1: PortLike; port2: unknown } | null;
  log(message: string): void;
  now(): number;
  /** 打开外部链接（http/https 校验在本模块，§4.6 openExternal 行） */
  launchURL(url: string): void;
  /** 组装该轮 prompt 与上下文（真实实现经 contextBuilder + promptTemplate） */
  buildTurnPrompt(text: string): Promise<TurnPromptInput>;
  /** 工作区确保存在；失败抛 code=WORKSPACE_UNAVAILABLE 的 Error（§4.1 cwd 行） */
  ensureWorkspace(): Promise<string>;
  /** spawn 基础；command 为 null = claude 未解析到（→ CLAUDE_NOT_FOUND） */
  getSpawnBase(): Promise<{
    command: string | null;
    /** 派发通道（cliDetect 解析产物）：win32 .cmd 壳必须带至此，否则 spawnTurn 无从包装（§2.10 B） */
    channel: CliChannel;
    environment: Record<string, string>;
    environmentAppend: boolean;
    /** cmd 通道的 cmd.exe 绝对路径（win32 专有；Gecko 拒收裸名，§2.10 B） */
    cmdExe?: string;
  }>;
  /**
   * 权限 MCP 端点（§4.8）：该轮一次性 token + 监听端口；实现抛错 = 端点故障
   * → 该轮不 spawn，桥回 SPAWN_FAILED（无后备路径）。允许返回 Promise（真实实现需先起监听）。
   */
  getMcpEndpoint(
    sessionId: string,
  ): { port: number; token: string } | Promise<{ port: number; token: string }>;
  /** 该轮进程退出：撤销一次性 token + 结掉在途权限请求（§4.8 token 随进程作废） */
  closeMcpTurn?(token: string): void;
  /**
   * 该轮附件目录写保护（M10）：把 deny 规则写进临时 settings 文件并返回其路径；
   * 无附件目录（addDir null）→ null（不带 --settings）。实现抛错 = 写保护没建成
   * → 该轮不 spawn（fail-closed：宁可缺这一轮，也不放一个未受保护的附件目录跑）。
   */
  prepareDenySettings?(addDir: string | null): Promise<string | null>;
  /** 该轮进程退出：删除该轮 settings 文件（清理失败只 log，不影响解锁） */
  cleanupDenySettings?(path: string): void;
  /** permissionResponse 回写端点；未知/已结 requestId → null（§4.6：忽略 + log） */
  resolvePermission?(
    requestId: string,
    allow: boolean,
  ): ResolvedPermission | null;
  getDefaultPermissionMode(): PermissionMode;
  spawnTurn(options: SpawnTurnOptions): TurnHandle;
  /** hello 注册完成后向实例广播 readerContext（§4.6 宿主→UI 表；返回 null 跳过） */
  buildReaderContext(): Promise<HostMessage | null>;
  /** 会话索引与旁挂历史（§4.5；纯逻辑模块，宿主侧注入 IOUtils 实现） */
  sessions: SessionStore;
  /** itemKey → 条目信息（createSession 校验 + sessionList 标题 + itemLibraryID 回填）；查无 → null */
  lookupItem(
    itemKey: string,
  ): Promise<{ libraryID: number; title: string | null } | null>;
  /** init→hello 握手超时（§4.6：30s 未 hello → log error）；测试注入小值 */
  helloTimeoutMs?: number;
  /**
   * M9 CLI 检测结论（PLAN §2.7）：实例注册完成即按需推 error 横幅；
   * null/未注入 = 不推（尚未测完时由 sections 测完后 broadcast 补推）
   */
  getCliStatus?(): CliStatus | null;
  /**
   * 笔记写入（M7，§4.3）：真实实现在 modules/notes.ts（全项目唯一写库模块，sections.ts 接线）。
   * 未注入 → saveNote 回 noteSaved{ok:false, code:SAVE_FAILED}、listNotes 回 error。
   */
  notes?: {
    saveNote(input: SaveNoteInput): Promise<NoteSaveResult>;
    listNotes(itemKey: string): Promise<NoteListResult>;
  };
}

/**
 * 单会话运行时状态（内存侧；持久侧是 SessionStore 的 SessionRecord，两者按 id 对应）。
 * 会话记录本身不驻留内存：每次用到就向 store 取，保证「索引是唯一真相」。
 */
interface SessionRuntime {
  /** null=空闲；running=进程存活；interrupting=kill 已发、进程未退（§4.6 并发契约） */
  busy: "running" | "interrupting" | null;
  turn: TurnHandle | null;
  /** 本轮用户输入原文（result 到达时与 assistant 最终文本一起落旁挂历史，§4.5） */
  pendingUserText: string;
  /** 本轮 assistant 最终文本：assistantMessage 校准优先，textDelta 累积兜底 */
  assistantText: string;
  streamText: string;
}

/** 会话运行时快照（测试与宿主日志用） */
export interface SessionRuntimeSnapshot {
  sessionId: string;
  busy: "running" | "interrupting" | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** assistantMessage.content[] 的文本块拼接（落旁挂历史的最终 assistant 文本，§4.5） */
function textOfAssistantMessage(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export interface HostBridge {
  /** browser load 后调用：记 pending（含一次性 token）+ 发 init（幂等：重复调用重复 init，页面侧重发 hello 即完成二次握手） */
  beginHandshake(win: UiWindowKey, token: string): void;
  /** message 事件入口（真实宿主接 window "message"，测试直接喂 {source, data}） */
  dispatch(ev: { source: unknown; data: unknown }): void;
  /** 向全部已注册实例广播（§2.2 多实例同收） */
  broadcast(msg: HostMessage): void;
  sendTo(win: UiWindowKey, msg: HostMessage): void;
  /** 权限卡请求广播（§4.6 permissionRequest；permissionMcp 端点经宿主调此口） */
  requestPermission(req: PermissionRequestPayload): void;
  /**
   * 权限卡结算通知（§4.6 permissionResolved，permissionMcp 的 settled 回调经宿主调此口）：
   * 该卡已结算（任一实例作答 / 120s 超时 / 该轮进程退出）→ 广播给**全部**实例摘卡。
   * 缺这条通知时，卡只在作答的那个实例本地消失；后台 reader tab 的侧栏页留着残影，
   * 用户切过去（或打开该侧栏）会看到一张「早已审批完」的卡（用户报障原形）。
   */
  permissionSettled(requestId: string): void;
  /** 实例注销（section onDestroy / tab onClose）：移出 pending 与注册表 */
  unregister(win: UiWindowKey): void;
  /** 会话运行时快照（测试与宿主日志用）；未知会话 → null */
  getRuntime(sessionId: string): SessionRuntimeSnapshot | null;
}

/** 握手实例条目：一次性 token（BUG-16）+ 页面回发端口 */
interface InstanceEntry {
  token: string;
  timer?: ReturnType<typeof setTimeout>;
  /** MessageChannel 宿主端；null = 只能走窗口 event.source 回发路径 */
  port: PortLike | null;
}

export function createHostBridge(deps: HostBridgeDeps): HostBridge {
  const registry = new Map<UiWindowKey, InstanceEntry>();
  const pending = new Map<UiWindowKey, InstanceEntry>();
  /** 会话运行时（按会话 id；索引记录在 deps.sessions，这里只放进程/本轮文本等易失状态） */
  const runtimes = new Map<string, SessionRuntime>();

  const helloTimeoutMs = deps.helloTimeoutMs ?? 30_000;

  /** 索引写失败只记日志不抛（数据安全路径：静默失败比报错更危险，但也不能掀翻桥上协议） */
  function persist(promise: Promise<unknown>): void {
    void promise.catch((err) => {
      deps.log(`[bridge] session persist failed: ${String(err)}`);
    });
  }

  /** 删除本轮写保护文件；失败只 log（清理是卫生动作，不该影响解锁/后续轮） */
  function cleanupDenySettingsFile(path: string | null): void {
    if (!path || !deps.cleanupDenySettings) {
      return;
    }
    try {
      deps.cleanupDenySettings(path);
    } catch (err) {
      deps.log(`[bridge] deny settings cleanup failed: ${String(err)}`);
    }
  }

  /** 异步分发兜底：任务抛错既不静默吞掉，也不许变成未处理拒绝（否则 UI 侧状态可能永久卡住） */
  function guard(label: string, task: Promise<unknown>): void {
    void task.catch((err) => {
      deps.log(`[bridge] ${label} failed: ${String(err)}`);
    });
  }

  function clearPendingTimer(win: UiWindowKey): void {
    const entry = pending.get(win);
    if (entry) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      pending.delete(win);
    }
  }

  function sendTo(win: UiWindowKey, msg: HostMessage): void {
    try {
      deps.post(win, msg);
    } catch (err) {
      // 死实例（section 已销毁未注销）：摘除引用，此后不再向其发消息
      deps.log(
        `[bridge] post failed, unregistering dead instance: ${String(err)}`,
      );
      registry.get(win)?.port?.close?.();
      registry.delete(win);
      clearPendingTimer(win);
    }
  }

  function broadcast(msg: HostMessage): void {
    for (const win of [...registry.keys()]) {
      sendTo(win, msg);
    }
  }

  /**
   * 握手首条 init（BUG-16）：init 携带本实例一次性 token（页面从自己 URL 读到的同值），
   * 并转移一个 MessagePort 作为页面回发通道——chrome 作用域下 postMessage 的 origin 恒为空串、
   * event.source 不可依赖，不能作信任依据（真机实测见 §4.6 修订）。
   * 端口转移失败（DataCloneError 等）回退纯窗口通道，页面侧按 event.source 回发。
   */
  function beginHandshake(win: UiWindowKey, token: string): void {
    clearPendingTimer(win);
    const entry: InstanceEntry = { token, port: null };
    entry.timer = setTimeout(() => {
      if (pending.get(win) === entry) {
        deps.log(
          `[bridge] hello timeout (${Math.round(helloTimeoutMs / 1000)}s): page never replied, instance stays unregistered`,
        );
        entry.port?.close?.();
        pending.delete(win);
      }
    }, helloTimeoutMs);
    pending.set(win, entry);

    // 通道构造与 init 投递全程兜底：任何一步抛错都必须留下日志（真机调试埋点，故障排查的第一现场）
    let channel: { port1: PortLike; port2: unknown } | null = null;
    try {
      channel = deps.createChannel();
    } catch (err) {
      deps.log(
        `[bridge] createChannel threw, fallback to window channel: ${String(err)}`,
      );
    }
    if (channel) {
      channel.port1.onmessage = (ev) => dispatchFrom(win, ev.data, "port");
      entry.port = channel.port1;
      try {
        deps.post(win, { type: "init", token }, [channel.port2]);
        deps.log("[bridge] init sent (token set, port transferred)");
        return;
      } catch (err) {
        deps.log(
          `[bridge] init with port rejected, retry via window: ${String(err)}`,
        );
        entry.port = null;
      }
    }
    try {
      deps.post(win, { type: "init", token });
      deps.log("[bridge] init sent (token set, window channel)");
    } catch (err) {
      deps.log(`[bridge] init failed (window channel): ${String(err)}`);
    }
  }

  function runtimeFor(id: string): SessionRuntime {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        busy: null,
        turn: null,
        pendingUserText: "",
        assistantText: "",
        streamText: "",
      };
      runtimes.set(id, rt);
    }
    return rt;
  }

  /** sessionList 消息：全量索引 + 条目标题解析（§4.6 宿主→UI 表） */
  async function sessionListMessage(): Promise<HostMessage> {
    const sessions: SessionSummary[] = [];
    for (const rec of deps.sessions.list()) {
      let itemTitle: string | null = null;
      if (rec.itemKey) {
        try {
          itemTitle = (await deps.lookupItem(rec.itemKey))?.title ?? null;
        } catch (err) {
          deps.log(`[bridge] itemTitle lookup failed: ${String(err)}`);
        }
      }
      sessions.push({
        id: rec.id,
        title: rec.title,
        updatedAt: rec.updatedAt,
        createdAt: rec.createdAt, // 同条目多会话的列表区分信息（UI 补时间戳）
        itemKey: rec.itemKey,
        claudeSessionId: rec.claudeSessionId,
        itemTitle,
      });
    }
    return { type: "sessionList", sessions };
  }

  async function pushSessionList(): Promise<void> {
    try {
      broadcast(await sessionListMessage());
    } catch (err) {
      deps.log(`[bridge] sessionList build failed: ${String(err)}`);
    }
  }

  /** 索引更新（含 claudeSessionId / 计数 / 费用），失败只记日志 */
  function updateIndex(id: string, patch: Partial<SessionRecord>): void {
    persist(deps.sessions.update(id, patch));
  }

  /**
   * turn 收尾（result 到达）：落旁挂历史两行 + 更新索引（§4.2 result 行 / §4.5）。
   * 历史与索引都写失败也不能抛——该轮已经结束，UI 还等着 sessionList。
   */
  async function finishTurn(
    sessionId: string,
    rt: SessionRuntime,
    event: Extract<TurnEvent, { kind: "result" }>,
  ): Promise<void> {
    const userText = rt.pendingUserText;
    const assistantText = rt.assistantText || rt.streamText;
    rt.pendingUserText = "";
    rt.assistantText = "";
    rt.streamText = "";
    try {
      const written = await deps.sessions.appendTurn(
        sessionId,
        userText,
        assistantText,
      );
      const rec = deps.sessions.get(sessionId);
      if (rec) {
        await deps.sessions.update(sessionId, {
          claudeSessionId: event.claudeSessionId || rec.claudeSessionId,
          messageCount: rec.messageCount + written,
          lastCostUsd: event.costUsd,
          updatedAt: deps.now(),
        });
      }
    } catch (err) {
      deps.log(`[bridge] finishTurn persist failed: ${String(err)}`);
    }
    await pushSessionList();
  }

  /**
   * 权限卡请求广播（§4.6 宿主→UI 表 permissionRequest）。
   * 字段与契约逐字一致：{requestId, tool, inputSummary, rawInput}——不加 sessionId，
   * 与 streamEvent/error 的会话过滤不同，卡是全局的（多实例同收，先答者生效）。
   */
  function requestPermission(req: PermissionRequestPayload): void {
    deps.log(
      `[bridge] permissionRequest: ${req.tool} (${req.requestId}) → ${registry.size} instance(s)`,
    );
    broadcast({
      type: "permissionRequest",
      requestId: req.requestId,
      tool: req.tool,
      inputSummary: req.inputSummary,
      rawInput: req.rawInput,
    });
  }

  /**
   * 权限卡结算广播（§4.6 permissionResolved）：与 permissionRequest 同为全局消息
   * （卡是广播给多实例的，摘卡也必须全实例一致）。空 id → 忽略 + log（防御非法调用）。
   */
  function permissionSettled(requestId: string): void {
    if (!requestId) {
      deps.log("[bridge] permissionSettled: empty requestId → ignored");
      return;
    }
    deps.log(
      `[bridge] permissionSettled: ${requestId} → ${registry.size} instance(s)`,
    );
    broadcast({ type: "permissionResolved", requestId });
  }

  /**
   * permissionResponse（§4.6）：回写端点（端点据此放行/拒绝 CLI）；allow+remember 时
   * 按 §4.6 确定性算法追加规则串到 session.allowedTools，下一轮 spawn 的 --allowedTools 携带。
   * 未知 requestId → 忽略 + log（过期/重复点击/他实例已答）。
   */
  function handlePermissionResponse(msg: Record<string, unknown>): void {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    if (!requestId) {
      deps.log("[bridge] permissionResponse: missing requestId → ignored");
      return;
    }
    const allow = msg.allow === true;
    const remember = msg.remember === true;
    const resolved = deps.resolvePermission?.(requestId, allow) ?? null;
    if (!resolved) {
      deps.log(
        `[bridge] permissionResponse: unknown/expired requestId → ignored`,
      );
      return;
    }
    deps.log(
      `[bridge] permissionResponse: ${resolved.tool} → ${allow ? "allow" : "deny"}${remember ? "（本会话记住）" : ""}`,
    );
    if (!allow || !remember) {
      return;
    }
    const rec = deps.sessions.get(resolved.sessionId);
    if (!rec) {
      deps.log(
        `[bridge] remember: session gone (${resolved.sessionId}) → skipped`,
      );
      return;
    }
    const rule = buildRememberRule(
      resolved.tool,
      resolved.input,
      rec.permissionMode,
    );
    if (!rule) {
      deps.log(
        `[bridge] remember: no rule for ${resolved.tool}（档位 ${rec.permissionMode} 已默认放行）`,
      );
      return;
    }
    if (rec.allowedTools.includes(rule)) {
      deps.log(`[bridge] remember: rule already present: ${rule}`);
      return;
    }
    deps.log(`[bridge] remember: appended rule ${rule}`);
    updateIndex(resolved.sessionId, {
      allowedTools: [...rec.allowedTools, rule],
    });
  }

  function onTurnEvent(targetSessionId: string, event: TurnEvent): void {
    deps.log(`[bridge] turn event: ${event.kind} (session ${targetSessionId})`);
    broadcast({ type: "streamEvent", sessionId: targetSessionId, event });
    const rt = runtimes.get(targetSessionId);
    if (!rt) return;
    switch (event.kind) {
      case "init":
        // 首轮把 claudeSessionId 落索引，供后续轮 --resume（§4.2 init 行）
        if (event.claudeSessionId) {
          updateIndex(targetSessionId, {
            claudeSessionId: event.claudeSessionId,
          });
        }
        break;
      case "assistantMessage":
        // content[] 为权威最终文本；工具轮（无文本块）不覆盖上一段有文本的
        rt.assistantText =
          textOfAssistantMessage(event.content) || rt.assistantText;
        break;
      case "textDelta":
        // assistantMessage 缺失（丢帧）时的兜底文本
        rt.streamText += event.text;
        break;
      case "result":
        void finishTurn(targetSessionId, rt, event);
        break;
      case "procError": {
        // 命令组装失败（ARG_HAS_NEWLINE / ARG_HAS_PERCENT / CMD_LINE_TOO_LONG）带 reason 直落日志：
        // 用户报障时凭这条定位「CLI 进程异常退出」的真实原因（§2.10 B）
        if (event.reason) {
          deps.log(
            `[bridge] procError reason=${event.reason} session=${targetSessionId}`,
          );
        }
        // resume 失效判定（§4.2 procError 行 / §4.6 错误码表）：UI 给「新建会话」按钮
        const kind = classifyProcError({
          exitCode: event.exitCode,
          stderrTail: event.stderrTail ?? "",
          reason: event.reason,
        });
        if (kind === "SESSION_GONE") {
          deps.log("[bridge] procError classified SESSION_GONE");
          broadcast({
            type: "error",
            code: "SESSION_GONE",
            message:
              "续接失败：CLI 侧会话已不存在（--resume 失效），请新建会话",
            sessionId: targetSessionId,
          });
          // BUG-25：死 id 必须清出索引——否则同会话再发仍拼 --resume，永远复读同一错误。
          // 清 id 后本轮就是首轮语义（CLI 侧起新会话），不必强迫用户新建会话。
          // 用 update 的 promise 串列表广播：列表要反映清除后的 claudeSessionId。
          void deps.sessions
            .update(targetSessionId, { claudeSessionId: null })
            .catch((err: unknown) => {
              deps.log(
                `[bridge] clear stale claudeSessionId failed (${targetSessionId}): ${String(err)}`,
              );
            })
            .then(() => pushSessionList());
        }
        break;
      }
      default:
        break;
    }
  }

  /** send 的消息目标会话：显式 id 优先，缺省取最近活动的一条 */
  function resolveSendTarget(rawId: unknown): SessionRecord | null | "gone" {
    if (typeof rawId === "string" && rawId) {
      return deps.sessions.get(rawId) ?? "gone";
    }
    return deps.sessions.mostRecent();
  }

  async function handleSend(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const text = msg.text;
    if (typeof text !== "string" || !text.trim()) {
      deps.log("[bridge] send: blank/non-string text → ignored");
      return;
    }
    let record = resolveSendTarget(msg.sessionId);
    if (record === "gone") {
      // UI 拿着一个不存在的会话（他处已删）：按 §4.6 失效语义处理，并推列表让 UI 重新绑定
      const staleId = String(msg.sessionId);
      deps.log(`[bridge] send: unknown session ${staleId} → SESSION_GONE`);
      sendTo(win, {
        type: "error",
        code: "SESSION_GONE",
        message: "会话不存在（可能已被删除），请新建会话",
        sessionId: staleId,
      });
      await pushSessionList();
      return;
    }
    if (!record) {
      // 无任何会话（首次使用）：本轮起一条（§4.6 createSession 的隐式形态）
      record = await deps.sessions.create({
        title: text.slice(0, SESSION_TITLE_MAX),
      });
      deps.log(`[bridge] session auto-created: ${record.id}`);
      await pushSessionList(); // UI 据此绑定新会话 id
    } else if (!record.title) {
      record =
        (await deps.sessions.update(record.id, {
          title: text.slice(0, SESSION_TITLE_MAX),
        })) ?? record;
    }
    const sessionId = record.id;

    // 并发契约：该会话有进行中 turn → SESSION_BUSY，不排队（§4.6）
    const rt = runtimeFor(sessionId);
    if (rt.busy) {
      deps.log(`[bridge] send rejected: session busy (${rt.busy})`);
      sendTo(win, {
        type: "error",
        code: "SESSION_BUSY",
        message: "进行中的 turn 未结束",
        sessionId,
      });
      return;
    }

    rt.busy = "running";
    rt.pendingUserText = text;
    rt.assistantText = "";
    rt.streamText = "";
    /** 本轮端点凭据：spawn 失败/进程退出都要撤销（§4.8 token 随该轮作废） */
    let mcp: { port: number; token: string } | null = null;
    /** 本轮附件目录写保护文件（spawn 失败/进程退出都要清理） */
    let denySettings: string | null = null;
    try {
      const workspace = await deps.ensureWorkspace();
      const base = await deps.getSpawnBase();
      if (!base.command) {
        rt.busy = null;
        sendTo(win, {
          type: "error",
          code: "CLAUDE_NOT_FOUND",
          message: "claude CLI 未找到，请安装或在设置中指定 cliPathOverride",
          sessionId,
        });
        return;
      }
      const input = await deps.buildTurnPrompt(text);
      // 会话绑定条目（§2.4 条目分组）：随本轮上下文刷新（切文献后续接旧会话时更新为当前条目）
      if (
        input.itemKey &&
        (record.itemKey !== input.itemKey ||
          record.attachmentKey !== input.attachmentKey)
      ) {
        const info = await deps.lookupItem(input.itemKey);
        if (info) {
          record =
            (await deps.sessions.update(sessionId, {
              itemKey: input.itemKey,
              itemLibraryID: info.libraryID,
              attachmentKey: input.attachmentKey,
            })) ?? record;
        }
      }
      // 端点故障（起监听失败/端口占用）→ 抛出 → 下方 catch 回 SPAWN_FAILED，该轮不 spawn（§4.8）
      mcp = await deps.getMcpEndpoint(sessionId);
      // 附件目录写保护（acceptEdits 档 Write/Edit 免卡 → 用 settings deny 硬挡）：写失败 → 抛出
      // → 同样走 SPAWN_FAILED，不带一个未受保护的 --add-dir 跑
      denySettings = (await deps.prepareDenySettings?.(input.addDir)) ?? null;
      const args = buildSpawnArgs({
        permissionMode: record.permissionMode,
        mcpPort: mcp.port,
        mcpToken: mcp.token,
        resumeClaudeSessionId: record.claudeSessionId,
        addDir: input.addDir,
        settingsPath: denySettings,
        allowedTools: record.allowedTools, // remember 规则串由 M6 写入索引
      });
      deps.log(
        `[bridge] spawning turn: session=${sessionId} resume=${record.claudeSessionId ?? "none"} addDir=${input.addDir ?? "none"} denySettings=${denySettings ?? "none"} cwd=${workspace}`,
      );
      const turn = deps.spawnTurn({
        command: base.command,
        channel: base.channel, // win32 .cmd 壳的 cmd.exe 包装由 spawnTurn 内统一组装（§2.10 B）
        cmdExePath: base.cmdExe || undefined, // 空 = 未提供，走 resolveCmdExePath 兜底
        args,
        workdir: workspace,
        environment: base.environment,
        environmentAppend: base.environmentAppend,
        prompt: input.prompt,
        onEvent: (event) => onTurnEvent(sessionId, event),
        logger: (m) => deps.log(m),
      });
      rt.turn = turn;
      // 解锁时点 = 进程退出（收到 result 也要等进程退出，§4.6 并发契约）；
      // 同刻撤销端点 token（§4.8：token 只活在「该轮 spawn 参数 + 端点内存」里）
      const turnToken = mcp.token;
      void turn.exitPromise.then(() => {
        deps.closeMcpTurn?.(turnToken);
        cleanupDenySettingsFile(denySettings);
        if (rt.turn === turn) {
          deps.log("[bridge] turn exit: session unlocked");
          rt.busy = null;
          rt.turn = null;
        }
      });
    } catch (err) {
      const code =
        (err as { code?: string } | null)?.code === "WORKSPACE_UNAVAILABLE"
          ? "WORKSPACE_UNAVAILABLE"
          : "SPAWN_FAILED";
      deps.log(`[bridge] send failed (${code}): ${String(err)}`);
      // 已开出的端点 token 一并撤销（没 spawn 出去，凭据不该留在内存里）
      if (mcp) {
        deps.closeMcpTurn?.(mcp.token);
      }
      cleanupDenySettingsFile(denySettings);
      rt.busy = null;
      rt.turn = null;
      sendTo(win, { type: "error", code, message: String(err), sessionId });
    }
  }

  /** 中断目标：显式 id 优先；缺省取当前唯一在跑的 turn（BUG-17 的 M5 形态） */
  function resolveInterruptTarget(
    rawId: unknown,
  ): { id: string; rt: SessionRuntime } | null {
    if (typeof rawId === "string" && rawId) {
      const rt = runtimes.get(rawId);
      return rt ? { id: rawId, rt } : null;
    }
    for (const [id, rt] of runtimes) {
      if (rt.busy === "running") {
        return { id, rt };
      }
    }
    return null;
  }

  function handleInterrupt(msg: Record<string, unknown>): void {
    const target = resolveInterruptTarget(msg.sessionId);
    if (!target || target.rt.busy !== "running" || !target.rt.turn) {
      deps.log("[bridge] interrupt: no running turn → ignored");
      return;
    }
    target.rt.busy = "interrupting";
    deps.log(`[bridge] interrupt: killing turn for session ${target.id}`);
    target.rt.turn.kill();
  }

  async function handleGetHistory(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    // 未知 id / 无文件 → 空消息数组（§4.6 getHistory 行）；读失败在 store 内降级为 []
    const messages = sessionId
      ? await deps.sessions.readHistory(sessionId)
      : [];
    sendTo(win, { type: "history", sessionId, messages });
  }

  async function handleCreateSession(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // BUG-24：建会话链路（查条目 / 写索引）任何一步失败都必须回包——UI 的「新建中…」
    // 只在收到 error / sessionList 后才解除，零回包 = 按钮永久停用（只能重载页面）。
    // 索引写入失败按 §4.6 错误码表用 SAVE_FAILED（持久化失败，message 附原文）。
    try {
      const rawKey = msg.itemKey;
      const itemKey = typeof rawKey === "string" && rawKey ? rawKey : null;
      let libraryID: number | null = null;
      if (itemKey) {
        const info = await deps.lookupItem(itemKey);
        if (!info) {
          deps.log(`[bridge] createSession: item not found: ${itemKey}`);
          sendTo(win, {
            type: "error",
            code: "ITEM_NOT_FOUND",
            message: `条目不存在：${itemKey}`,
          });
          return;
        }
        libraryID = info.libraryID;
      }
      const rec = await deps.sessions.create({
        itemKey,
        itemLibraryID: libraryID,
      });
      deps.log(`[bridge] session created: ${rec.id}`);
      await pushSessionList();
    } catch (err) {
      deps.log(`[bridge] createSession failed: ${String(err)}`);
      sendTo(win, {
        type: "error",
        code: "SAVE_FAILED",
        message: `会话创建失败（索引未写入）：${String(err)}`,
      });
    }
  }

  /**
   * renameSession（§4.6 UI→宿主表）：用户改名唯一入口，改名成功推 sessionList 作回执。
   * 未知 id / 空标题（清空输入 = 不改名）→ 忽略 + log：与 deleteSession 同口径，
   * 该会话可能已在他处删除，列表随后自然收敛。
   */
  async function handleRenameSession(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const title = typeof msg.title === "string" ? msg.title : "";
    if (!sessionId || !deps.sessions.get(sessionId)) {
      deps.log(`[bridge] renameSession: unknown id → ignored: ${sessionId}`);
      return;
    }
    const rec = await deps.sessions.rename(sessionId, title);
    if (!rec) {
      deps.log(`[bridge] renameSession: empty/invalid title → ignored`);
      return;
    }
    deps.log(`[bridge] session renamed: ${rec.id}`);
    await pushSessionList();
  }

  async function handleDeleteSession(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!sessionId || !deps.sessions.get(sessionId)) {
      deps.log(`[bridge] deleteSession: unknown id → ignored`);
      return;
    }
    const rt = runtimes.get(sessionId);
    if (rt?.busy) {
      // 会话要被删掉，其进行中的进程必须收掉（否则成了无主进程）
      deps.log(`[bridge] deleteSession: killing running turn (${sessionId})`);
      rt.turn?.kill();
    }
    runtimes.delete(sessionId);
    await deps.sessions.remove(sessionId);
    deps.log(`[bridge] session deleted: ${sessionId}`);
    await pushSessionList();
  }

  function handleSetPermissionMode(msg: Record<string, unknown>): void {
    const mode = msg.mode;
    if (!(PERMISSION_MODES as readonly string[]).includes(mode as string)) {
      deps.log(
        `[bridge] setPermissionMode: invalid mode ignored: ${String(mode)}`,
      );
      return;
    }
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!deps.sessions.get(sessionId)) {
      deps.log("[bridge] setPermissionMode: unknown session ignored");
      return;
    }
    updateIndex(sessionId, { permissionMode: mode as PermissionMode });
    deps.log(`[bridge] setPermissionMode: ${sessionId} → ${String(mode)}`);
  }

  /**
   * saveNote（§4.3）：HTML 消毒与写库全在 notes.ts（宿主唯一写入口），桥只做字段形态校验与回包。
   * 出参按 §4.3 错误契约：noteSaved {ok:true, noteKey} / {ok:false, code}；非法 mode → 忽略 + log。
   */
  async function handleSaveNote(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const itemKey = typeof msg.itemKey === "string" ? msg.itemKey : "";
    const html = typeof msg.html === "string" ? msg.html : "";
    if (!deps.notes) {
      deps.log("[bridge] saveNote: notes module not wired → SAVE_FAILED");
      sendTo(win, { type: "noteSaved", ok: false, code: "SAVE_FAILED" });
      return;
    }
    const mode = msg.mode;
    let result: NoteSaveResult;
    if (mode === "new") {
      result = await deps.notes.saveNote({ itemKey, mode: "new", html });
    } else if (mode === "append") {
      const noteKey = typeof msg.noteKey === "string" ? msg.noteKey : "";
      result = await deps.notes.saveNote({
        itemKey,
        mode: "append",
        noteKey,
        html,
      });
    } else {
      deps.log(`[bridge] saveNote: invalid mode ignored: ${String(mode)}`);
      return;
    }
    deps.log(
      `[bridge] saveNote: ${result.ok ? `ok (${result.noteKey})` : `failed (${result.code})`}`,
    );
    sendTo(
      win,
      result.ok
        ? { type: "noteSaved", ok: true, noteKey: result.noteKey }
        : { type: "noteSaved", ok: false, code: result.code },
    );
  }

  /**
   * listNotes（§4.3）：回笔记清单；失败按 §4.6 listNotes 行「回错误码」——noteList 无错误字段，
   * 走通用 error 通道（错误码总表与函数出参共用）。
   */
  async function handleListNotes(
    win: UiWindowKey,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const itemKey = typeof msg.itemKey === "string" ? msg.itemKey : "";
    if (!deps.notes) {
      deps.log("[bridge] listNotes: notes module not wired → SAVE_FAILED");
      sendTo(win, {
        type: "error",
        code: "SAVE_FAILED",
        message: "笔记模块未接线",
      });
      return;
    }
    const result = await deps.notes.listNotes(itemKey);
    if (result.ok) {
      sendTo(win, { type: "noteList", notes: result.notes });
      return;
    }
    deps.log(`[bridge] listNotes failed (${result.code})`);
    sendTo(win, {
      type: "error",
      code: result.code,
      message: result.message,
    });
  }

  function handleOpenExternal(msg: Record<string, unknown>): void {
    const url = msg.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      deps.log(
        `[bridge] openExternal: non-http(s) url ignored: ${String(url)}`,
      );
      return;
    }
    deps.launchURL(url);
  }

  function dispatchFrom(
    win: UiWindowKey,
    data: unknown,
    via: "window" | "port",
  ): void {
    if (!isRecord(data) || typeof data.type !== "string") {
      return; // 非 JSON 对象/缺 type → 忽略（§4.6）
    }
    const msg = data;
    const type = msg.type;

    if (type === "hello") {
      const pended = pending.get(win);
      const entry = pended ?? registry.get(win);
      if (!entry) {
        deps.log("[bridge] hello from unknown source → ignored");
        return;
      }
      // token 校验（BUG-16）：一次性 token 不一致 → 拒绝 + log，绝不静默放行、绝不注册
      if (msg.token !== entry.token) {
        deps.log(`[bridge] hello REJECTED: token mismatch (via ${via})`);
        return;
      }
      const isReload = !pended;
      if (pended) {
        clearPendingTimer(win);
        // 注册（重载场景以新条目覆盖：端口随之更新）
        registry.set(win, pended);
      }
      if (isReload) {
        // browser 重载的二次握手：已注册窗口重复 hello → 幂等重发 sessionList（只注册一次）
        deps.log(
          `[bridge] hello (page reload, via ${via}) → re-send sessionList`,
        );
      } else {
        deps.log(
          `[bridge] hello received (via ${via}), registered (${registry.size} instance(s))`,
        );
      }
      // 索引载入可能触发损坏重置：重置过就顺带告知（§4.5「UI 提示会话索引已重置」；
      // 桥协议无专用通知消息，按 §4.6 失效语义走 error 横幅 + 「新建会话」按钮）
      void (async () => {
        await deps.sessions.init();
        if (deps.sessions.wasReset()) {
          sendTo(win, {
            type: "error",
            code: "SESSION_GONE",
            message:
              "会话索引已损坏并重置（原文件备份为 sessions.json.bak-*），历史会话列表已清空",
          });
        }
        // M9 CLI 检测引导（PLAN §2.7）：可用性/登录态有问题 → 注册即推横幅
        const cliStatus = deps.getCliStatus?.() ?? null;
        if (cliStatus && !cliStatus.ok && cliStatus.code) {
          sendTo(win, {
            type: "error",
            code: cliStatus.code,
            message: cliStatus.message,
          });
        }
        sendTo(win, await sessionListMessage());
      })();
      if (!isReload) {
        void deps.buildReaderContext().then((ctx) => {
          if (ctx) sendTo(win, ctx);
        });
      }
      return;
    }

    // 其余消息只接受已注册实例（§4.6：宿主只接受已注册实例的消息）
    if (!registry.has(win)) {
      deps.log(`[bridge] drop message from unregistered source: ${type}`);
      return;
    }
    deps.log(`[bridge] msg: ${type} (via ${via})`);

    switch (type) {
      case "send":
        guard("send", handleSend(win, msg));
        break;
      case "interrupt":
        handleInterrupt(msg);
        break;
      case "getHistory":
        guard("getHistory", handleGetHistory(win, msg));
        break;
      case "openExternal":
        handleOpenExternal(msg);
        break;
      case "getState":
        guard("getState", pushSessionList());
        break;
      case "createSession":
        guard("createSession", handleCreateSession(win, msg));
        break;
      case "deleteSession":
        guard("deleteSession", handleDeleteSession(msg));
        break;
      case "renameSession":
        guard("renameSession", handleRenameSession(msg));
        break;
      case "setPermissionMode":
        handleSetPermissionMode(msg);
        break;
      case "permissionResponse":
        handlePermissionResponse(msg);
        break;
      case "saveNote":
        guard("saveNote", handleSaveNote(win, msg));
        break;
      case "listNotes":
        guard("listNotes", handleListNotes(win, msg));
        break;
      default:
        deps.log(`[bridge] unknown message type ignored: ${type}`);
        break;
    }
  }

  /** message 事件入口（真实宿主接主窗口 "message"；端口路径在 beginHandshake 内直连） */
  function dispatch(ev: { source: unknown; data: unknown }): void {
    dispatchFrom(ev.source as UiWindowKey, ev.data, "window");
  }

  function unregister(win: UiWindowKey): void {
    clearPendingTimer(win);
    const entry = registry.get(win);
    entry?.port?.close?.();
    registry.delete(win);
  }

  return {
    beginHandshake,
    dispatch,
    broadcast,
    sendTo,
    requestPermission,
    permissionSettled,
    unregister,
    getRuntime: (sessionId: string) => {
      const rt = runtimes.get(sessionId);
      return rt ? { sessionId, busy: rt.busy } : null;
    },
  };
}
