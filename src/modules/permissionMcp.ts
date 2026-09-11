// permissionMcp.ts — 插件本地权限 MCP 端点（PLAN §2.5 主案 / §4.8 契约；spike 假设 4 实测定型）。
//
// 两层结构：
//   ① 纯逻辑核心（文件上半部）：HTTP 报文解析/组装 + JSON-RPC 2.0 握手序列 + 权限决策等待。
//      不碰任何 Gecko API，node:test 直接跑（tests/unit/permissionMcp.test.ts）。
//   ② Gecko 传输层（文件下半部）：nsIServerSocket 回环监听 + 异步读 + 逐连接驱动核心。
//
// 信任边界（§4.8 / §7.1）：仅绑定 127.0.0.1；每个请求校验 URL 一次性 token，不合法 → 403；
// token 由宿主按轮注册/撤销（openTurn/closeTurn），随该轮 CLI 进程结束作废。
// 故障契约（§4.8）：启动失败/端口占用 → startPermissionServer 抛错 → 宿主该轮不 spawn（回 SPAWN_FAILED）；
// 用户 120s 未响应 → 按 deny 结掉；请求体畸形 → 400；工具入参缺 tool_name → deny（fail closed，绝不放行）。
// token 值不落日志（§7.1「不记录令牌」，只记状态码与原因）。

/** 权限工具名（--permission-prompt-tool 的尾段，全名为 mcp__claudian-perm__permission_check） */
export const PERMISSION_TOOL = "permission_check";

/** 拒绝消息原文（§4.8：原样传达给 AI；spike 实测 AI 明确知晓被拒且不换工具绕过） */
export const PERMISSION_DENY_MESSAGE =
  "User denied this action on the permission card.";

/** 用户未响应超时（§4.8：120s 按 deny） */
export const PERMISSION_TIMEOUT_MS = 120_000;

/** 端点 HTTP 路径（与 cliRunner.ts buildSpawnArgs 拼出的 URL 一致） */
export const PERMISSION_MCP_PATH = "/mcp";

// ===================== ① 纯逻辑核心 =====================

/** 权限卡请求载荷（端点 → 宿主 → 桥 → UI；§4.6 permissionRequest 的宿主侧形态） */
export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  tool: string;
  /** 图形卡上展示的入参摘要（Bash 命令 / Edit-Write 路径与 diff 预览 / 其余 JSON） */
  inputSummary: string;
  /** 原样入参（工具卡折叠区展示用，UI 用 textContent 渲染） */
  rawInput: unknown;
  toolUseId: string;
}

/** resolve() 回写结果：宿主拿它决定 remember 规则串（tool + input + 档位） */
export interface ResolvedPermission {
  sessionId: string;
  tool: string;
  input: unknown;
}

export interface PermissionCoreDeps {
  log(message: string): void;
  /** 把卡推给 UI（同步、不等结果）；用户决策经 core.resolve() 回写。
   *  实现抛错时该请求直接按 deny 结掉（UI 故障不该把 CLI 吊死）。 */
  present(req: PermissionRequestPayload): void;
  /**
   * 结算回调（用户作答 / 120s 超时 / 该轮关闭）：宿主据此通知**所有** UI 实例摘掉这张卡。
   * 卡是广播给多实例的，只在作答的那一个实例本地摘卡会留残影——别的实例（后台 reader tab
   * 的侧栏页）再看时，一张早已结算的卡还在那儿，点它只会得到 unknown/expired。
   * 实现抛错只记日志：卡已结算，UI 同步失败不该反噬端点。
   */
  settled?(requestId: string): void;
  /** 决策等待上限；缺省 PERMISSION_TIMEOUT_MS（测试注入小值） */
  timeoutMs?: number;
}

export interface PermissionCore {
  /** 该轮开始：注册一次性 token ↔ 会话映射（port 为端点监听端口） */
  openTurn(sessionId: string, port: number): { port: number; token: string };
  /** 该轮结束（CLI 进程退出）：撤销 token + 在途请求按 deny 结掉 */
  closeTurn(token: string): void;
  /** UI 决策回写；未知/已结 requestId → null（§4.6 非法输入契约：忽略） */
  resolve(requestId: string, allow: boolean): ResolvedPermission | null;
  /** 单次 HTTP 请求处理（纯函数形态：入参已解析，出参待字节化）。不抛错。 */
  handle(req: ParsedHttpRequest): Promise<HttpResponseParts>;
  /** 在途权限请求数（测试与宿主日志用） */
  pendingCount(): number;
  /** 已注册（未撤销）token 数（测试与宿主日志用） */
  openTurnCount(): number;
}

/** 已解析的 HTTP 请求（传输层产物） */
export interface ParsedHttpRequest {
  method: string;
  /** 不含查询串，如 "/mcp" */
  path: string;
  /** 查询参数（已 percent-decode）；token 在这里 */
  query: Record<string, string>;
  /** 全小写键 */
  headers: Record<string, string>;
  /** UTF-8 解码后的正文（GET 为空串） */
  body: string;
}

export interface HttpResponseParts {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface PendingPermission {
  sessionId: string;
  tool: string;
  input: unknown;
  settle(allow: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 随机 hex（token / requestId / MCP 会话 id 共用）。
 * **fail-closed**：CSPRNG 不可用直接抛错，绝不回退弱随机——token 与 requestId 都是能力凭据，
 * 弱随机等于把权限卡端点交给本机其他进程猜（§7.1）。抛错向上变成「端点不可用」→ 该轮不 spawn。
 * （Gecko/Node 两侧 crypto 均常驻；真机跑日志从未出现过 crypto 缺失，此处是防降级护栏。）
 */
function randomHex(bytes: number): string {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error(
      "CSPRNG unavailable: refusing to create a permission token (fail-closed)",
    );
  }
  const buf = new Uint8Array(bytes);
  c.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- 入参摘要（图形卡正文；纯函数） ----

const SUMMARY_MAX = 4000;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX
    ? `${text.slice(0, SUMMARY_MAX)}\n…（已截断，完整入参见下方折叠区）`
    : text;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 工具入参摘要（§4.6 permissionRequest.inputSummary）：
 * Bash 显示命令；Edit 显示路径 + 旧/新内容对照；Write 显示路径 + 内容预览；
 * 其余工具取常见路径/模式字段，都没有则 JSON 全文。截断到 SUMMARY_MAX。
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (!isRecord(input)) {
    return truncate(safeStringify(input));
  }
  if (tool === "Bash") {
    const command = asString(input.command);
    if (command === null) {
      return truncate(safeStringify(input));
    }
    const description = asString(input.description);
    return truncate(description ? `${command}\n\n# ${description}` : command);
  }
  const path =
    asString(input.file_path) ??
    asString(input.notebook_path) ??
    asString(input.path);
  if (tool === "Edit") {
    const oldText = asString(input.old_string);
    const newText = asString(input.new_string);
    const diff =
      oldText !== null && newText !== null
        ? `--- 原内容\n${oldText}\n+++ 新内容\n${newText}`
        : safeStringify(input);
    return truncate(path ? `${path}\n\n${diff}` : diff);
  }
  if (tool === "Write" || tool === "NotebookEdit") {
    const content =
      asString(input.content) ??
      asString(input.new_source) ??
      asString(input.new_str);
    const preview =
      content === null
        ? safeStringify(input)
        : `（共 ${content.length} 字符）\n${content}`;
    return truncate(path ? `${path}\n\n${preview}` : preview);
  }
  // 检索类优先给检索词（比路径更能说明这次调用要干什么）
  const pattern = asString(input.pattern);
  if (pattern !== null) {
    return truncate(pattern);
  }
  if (path !== null) {
    return truncate(path);
  }
  const url = asString(input.url);
  if (url !== null) {
    return truncate(url);
  }
  return truncate(safeStringify(input));
}

// ---- 核心 ----

export function createPermissionCore(deps: PermissionCoreDeps): PermissionCore {
  const timeoutMs = deps.timeoutMs ?? PERMISSION_TIMEOUT_MS;
  /** token → sessionId（该轮有效；closeTurn 撤销） */
  const turns = new Map<string, string>();
  /** requestId → 在途决策 */
  const pending = new Map<string, PendingPermission>();
  /** 本端点实例的 MCP 会话 id（initialize 响应头回给 CLI；CLI 回传但我们只认 token） */
  const mcpSessionId = `claudian-perm-${randomHex(8)}`;

  /** 结算通知（宿主接桥广播给全实例摘卡）。回调抛错只记日志——卡已结算，不反噬端点。 */
  function notifySettled(requestId: string): void {
    if (!deps.settled) {
      return;
    }
    try {
      deps.settled(requestId);
    } catch (err) {
      deps.log(`[perm-mcp] settled() threw (ignored): ${String(err)}`);
    }
  }

  function json(status: number, payload: unknown): HttpResponseParts {
    return {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  }

  function jsonrpcResult(id: unknown, result: unknown): HttpResponseParts {
    return json(200, {
      jsonrpc: "2.0",
      id: id === undefined ? null : id,
      result,
    });
  }

  /**
   * 等用户决策：present 推卡 → pending 登记 → resolve()/超时 结掉。
   * 超时按 deny（§4.8）；present 抛错同样按 deny（不把 CLI 吊在 120s 上）。
   */
  function ask(payload: PermissionRequestPayload): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(payload.requestId)) {
          deps.log(
            `[perm-mcp] permission request ${payload.requestId} timed out (${timeoutMs}ms) → deny`,
          );
          resolve(false);
          notifySettled(payload.requestId);
        }
      }, timeoutMs);
      pending.set(payload.requestId, {
        sessionId: payload.sessionId,
        tool: payload.tool,
        input: payload.rawInput,
        settle: resolve,
        timer,
      });
      try {
        deps.present(payload);
      } catch (err) {
        // UI 侧故障：结掉请求（deny），绝不静默放行
        deps.log(`[perm-mcp] present() threw → deny: ${String(err)}`);
        const p = pending.get(payload.requestId);
        if (p) {
          pending.delete(payload.requestId);
          clearTimeout(p.timer);
          resolve(false);
          notifySettled(payload.requestId);
        }
      }
    });
  }

  /** tools/call：正常返 allow/deny 文本；入参畸形（缺 tool_name）返 deny（fail closed） */
  async function handleToolsCall(
    id: unknown,
    msg: Record<string, unknown>,
    sessionId: string,
  ): Promise<HttpResponseParts> {
    const params = isRecord(msg.params) ? msg.params : {};
    const name = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name && name !== PERMISSION_TOOL) {
      deps.log(`[perm-mcp] tools/call unknown tool: ${name}`);
      return json(200, {
        jsonrpc: "2.0",
        id: id === undefined ? null : id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
    }
    const tool = asString(args.tool_name) ?? "";
    const input = args.input === undefined ? {} : args.input;
    const toolUseId = asString(args.tool_use_id) ?? "";
    if (!tool) {
      // 畸形请求：宁可拒绝也不放行（信任边界不允许「缺字段就当允许」）
      deps.log("[perm-mcp] tools/call malformed (missing tool_name) → deny");
      return toolsCallText(id, {
        behavior: "deny",
        message: "Malformed permission request (missing tool_name).",
      });
    }
    const payload: PermissionRequestPayload = {
      requestId: randomHex(8),
      sessionId,
      tool,
      inputSummary: summarizeToolInput(tool, input),
      rawInput: input,
      toolUseId,
    };
    const allow = await ask(payload);
    deps.log(
      `[perm-mcp] decision for ${payload.requestId} (${tool}): ${allow ? "allow" : "deny"}`,
    );
    return toolsCallText(
      id,
      allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: PERMISSION_DENY_MESSAGE },
    );
  }

  /** 回包形态（§4.8 实测）：content 单 text 块，text 是上述 JSON 的字符串 */
  function toolsCallText(id: unknown, decision: unknown): HttpResponseParts {
    return jsonrpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(decision) }],
    });
  }

  async function handle(req: ParsedHttpRequest): Promise<HttpResponseParts> {
    try {
      if (req.path !== PERMISSION_MCP_PATH) {
        return json(404, { error: "not found" });
      }
      const token = req.query.token ?? "";
      const sessionId = token ? turns.get(token) : undefined;
      if (!sessionId) {
        // §7.1：本机其他进程/过期轮次的骚扰在此拦下（不记 token 值）
        deps.log(`[perm-mcp] 403: token rejected (${req.method} ${req.path})`);
        return json(403, { error: "forbidden" });
      }
      if (req.method !== "POST") {
        // §4.8 表：GET /mcp（SSE 长连接探测）回 405，不影响后续流程
        return { status: 405, headers: { Allow: "POST" }, body: "" };
      }
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(req.body);
        if (!isRecord(parsed)) {
          throw new Error("body is not a JSON object");
        }
        msg = parsed;
      } catch (err) {
        deps.log(`[perm-mcp] 400: bad JSON body: ${String(err)}`);
        return json(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
      }
      const method = asString(msg.method) ?? "";
      switch (method) {
        case "server/discover":
          // 探测（实测首包）：回空 result 即通过
          return jsonrpcResult(msg.id, {});
        case "initialize": {
          const params = isRecord(msg.params) ? msg.params : {};
          const protocolVersion =
            asString(params.protocolVersion) ?? "2025-11-25";
          const res = jsonrpcResult(msg.id, {
            protocolVersion, // 回显（实测形态）
            capabilities: { tools: {} },
            serverInfo: { name: "claudian-perm", version: "0.1.0" },
          });
          res.headers["Mcp-Session-Id"] = mcpSessionId; // §4.8：响应头必带
          return res;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          // §4.8 表：202 空体
          return { status: 202, headers: {}, body: "" };
        case "tools/list":
          return jsonrpcResult(msg.id, {
            tools: [
              {
                name: PERMISSION_TOOL,
                description:
                  'Permission gate for tool use. Reply with JSON {behavior:"allow",updatedInput} or {behavior:"deny",message} as text content.',
                inputSchema: {
                  type: "object",
                  properties: {
                    tool_name: { type: "string" },
                    input: { type: "object" },
                    tool_use_id: { type: "string" },
                  },
                  required: ["tool_name", "input", "tool_use_id"],
                },
              },
            ],
          });
        case "tools/call":
          return await handleToolsCall(msg.id, msg, sessionId);
        default:
          // 未知方法（前向兼容）：与 spike 一致回空 result，不打断 CLI
          deps.log(`[perm-mcp] unknown method (empty result): ${method}`);
          return jsonrpcResult(msg.id, {});
      }
    } catch (err) {
      // 任何未预期异常都不能掀翻传输层：回 500 + 留痕
      deps.log(`[perm-mcp] internal error: ${String(err)}`);
      return json(500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: String(err) },
      });
    }
  }

  function openTurn(
    sessionId: string,
    port: number,
  ): { port: number; token: string } {
    const token = randomHex(16);
    turns.set(token, sessionId);
    deps.log(`[perm-mcp] turn opened for session ${sessionId} (port ${port})`);
    return { port, token };
  }

  function closeTurn(token: string): void {
    const sessionId = turns.get(token);
    if (sessionId === undefined) {
      return;
    }
    turns.delete(token);
    let denied = 0;
    for (const [requestId, p] of [...pending]) {
      if (p.sessionId !== sessionId) {
        continue;
      }
      // 进程已退：卡留着没有意义，一律 deny 结掉（别让 HTTP 侧永远吊着）
      pending.delete(requestId);
      clearTimeout(p.timer);
      p.settle(false);
      notifySettled(requestId); // 各实例撤卡：这张卡再也答不出结果了
      denied += 1;
    }
    deps.log(
      `[perm-mcp] turn closed (session ${sessionId}), token revoked, ${denied} pending request(s) denied`,
    );
  }

  function resolve(
    requestId: string,
    allow: boolean,
  ): ResolvedPermission | null {
    const p = pending.get(requestId);
    if (!p) {
      return null;
    }
    pending.delete(requestId);
    clearTimeout(p.timer);
    p.settle(allow);
    // 卡是广播给多实例的：作答方本地摘卡，其余实例靠这条通知摘（否则后台 tab 的侧栏留残影）
    notifySettled(requestId);
    return { sessionId: p.sessionId, tool: p.tool, input: p.input };
  }

  return {
    openTurn,
    closeTurn,
    resolve,
    handle,
    pendingCount: () => pending.size,
    openTurnCount: () => turns.size,
  };
}

// ---- HTTP 报文（字节层；纯函数，node 可测） ----

/** 请求头区上限（防畸形请求撑爆内存） */
const MAX_HEADER_BYTES = 64 * 1024;
/** 请求体上限（MCP 请求体实测 <1KB，这是宽松护栏） */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8");

export type HttpParseResult =
  | { status: "incomplete" }
  | { status: "error"; message: string }
  | { status: "ok"; request: ParsedHttpRequest; consumed: number };

/** 字节区间 → latin1 字符串（每个字符 = 一个字节；分块拼接防 apply 参数上限） */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  const CHUNK = 4096;
  for (let i = start; i < end; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, end));
    out += String.fromCharCode(...slice);
  }
  return out;
}

function parseQuery(target: string): {
  path: string;
  query: Record<string, string>;
} {
  const idx = target.indexOf("?");
  const path = idx >= 0 ? target.slice(0, idx) : target;
  const query: Record<string, string> = {};
  if (idx < 0) {
    return { path, query };
  }
  for (const pair of target.slice(idx + 1).split("&")) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf("=");
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawValue = eq >= 0 ? pair.slice(eq + 1) : "";
    try {
      query[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      // 畸形 percent 编码：原样保留（token 比对自然失败 → 403）
      query[rawKey] = rawValue;
    }
  }
  return { path, query };
}

/** 头区结束（CRLFCRLF）位置；返回 -1 = 还没收齐 */
function headerEndIndex(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * 增量解析（每收到一段字节就整段重放；请求体实测 <1KB，简单优先）：
 * incomplete = 还没收齐，继续读；error = 畸形（400）；ok = 完整请求。
 * 按 Content-Length 的**字节数**计数（不是字符数），中文正文不会截断。
 */
export function parseHttpRequest(buf: Uint8Array): HttpParseResult {
  const headEnd = headerEndIndex(buf);
  if (headEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) {
      return { status: "error", message: "header too large" };
    }
    return { status: "incomplete" };
  }
  const headText = latin1(buf, 0, headEnd).replace(/\r\n/g, "\n");
  const lines = headText.split("\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length < 3) {
    return {
      status: "error",
      message: `bad request line: ${requestLine.slice(0, 80)}`,
    };
  }
  const [method, target] = parts;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    headers[key] = line.slice(colon + 1).trim();
  }
  const lengthRaw = headers["content-length"];
  let contentLength = 0;
  if (lengthRaw !== undefined) {
    const parsed = Number(lengthRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { status: "error", message: `bad content-length: ${lengthRaw}` };
    }
    if (parsed > MAX_BODY_BYTES) {
      return { status: "error", message: `body too large: ${parsed}` };
    }
    contentLength = parsed;
  }
  const bodyStart = headEnd + 4;
  if (buf.length < bodyStart + contentLength) {
    return { status: "incomplete" };
  }
  const body =
    contentLength > 0
      ? DECODER.decode(buf.subarray(bodyStart, bodyStart + contentLength))
      : "";
  const { path, query } = parseQuery(target);
  return {
    status: "ok",
    request: { method, path, query, headers, body },
    consumed: bodyStart + contentLength,
  };
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  202: "Accepted",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
};

/** 响应字节化：Content-Length 按 UTF-8 字节数（不是字符数）；Connection: close 简化连接生命周期 */
export function formatHttpResponse(res: HttpResponseParts): Uint8Array {
  const bodyBytes = res.body ? ENCODER.encode(res.body) : new Uint8Array(0);
  const head: string[] = [
    `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? "OK"}`,
    `Content-Length: ${bodyBytes.length}`,
    "Connection: close",
    "Cache-Control: no-store",
  ];
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "connection") {
      continue; // 上面已写死，防重复头
    }
    // 防御性加固（安全审查建议 3）：头名/头值里的 CR/LF 一律剔除，杜绝响应头注入。
    // 当前四个响应头都是字面量、无可达注入点，这里是防未来有人把头值改成外部输入。
    const safeKey = key.replace(/[\r\n]/g, "");
    const safeValue = String(value).replace(/[\r\n]/g, "");
    head.push(`${safeKey}: ${safeValue}`);
  }
  const headBytes = ENCODER.encode(`${head.join("\r\n")}\r\n\r\n`);
  const out = new Uint8Array(headBytes.length + bodyBytes.length);
  out.set(headBytes, 0);
  out.set(bodyBytes, headBytes.length);
  return out;
}

// ===================== ② Gecko 传输层（nsIServerSocket） =====================

/** 连接空闲上限：收齐请求前长时间没动静就断开（防半开连接堆积） */
const CONNECTION_IDLE_MS = 30_000;
/** 回包后等对端关闭（FIN）的兜底时限；到点仍开着就强制收（防连接堆积） */
const POST_RESPONSE_LINGER_MS = 15_000;

export interface PermissionServer {
  port: number;
  stop(): void;
}

type ServerSocketLike = {
  init(port: number, loopbackOnly: boolean, backlog: number): void;
  asyncListen(listener: unknown): void;
  close(): void;
  readonly port: number;
};

type InputStreamLike = {
  close(): void;
};

type OutputStreamLike = {
  write(buf: string, count: number): number;
  close(): void;
};

type SocketTransportLike = {
  openInputStream(
    flags: number,
    segsize: number,
    segcount: number,
  ): InputStreamLike;
  openOutputStream(
    flags: number,
    segsize: number,
    segcount: number,
  ): OutputStreamLike;
  close(status: number): void;
};

/**
 * nsIInputStreamPump（C++ 驱动的异步读；分段/重新排程都由实现内部处理）。
 * init 签名随 Gecko 版本演化（5 参带 mainThreadTarget / 4 参 / 3 参旧版），
 * 故这里按「逐签名试探 + try/catch」调用，不写死参数表。
 */
type InputStreamPumpLike = {
  init(...args: unknown[]): void;
  asyncRead(listener: unknown): void;
};

type BinaryInputStreamLike = {
  setInputStream(stream: unknown): void;
  readBytes(count: number): string;
};

function createServerSocket(): ServerSocketLike {
  const classes = Components.classes as unknown as Record<
    string,
    { createInstance(iface: unknown): ServerSocketLike }
  >;
  return classes["@mozilla.org/network/server-socket;1"].createInstance(
    Components.interfaces.nsIServerSocket,
  );
}

function createInputStreamPump(): InputStreamPumpLike {
  const classes = Components.classes as unknown as Record<
    string,
    { createInstance(iface: unknown): InputStreamPumpLike }
  >;
  return classes["@mozilla.org/network/input-stream-pump;1"].createInstance(
    Components.interfaces.nsIInputStreamPump,
  );
}

/** 读 n 字节（binary input stream：每字符 = 一字节，转回 Uint8Array） */
function readBytes(stream: InputStreamLike, count: number): Uint8Array {
  const classes = Components.classes as unknown as Record<
    string,
    { createInstance(iface: unknown): BinaryInputStreamLike }
  >;
  const bin = classes["@mozilla.org/binaryinputstream;1"].createInstance(
    Components.interfaces.nsIBinaryInputStream,
  );
  bin.setInputStream(stream);
  const raw = bin.readBytes(count);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i) & 0xff;
  }
  return out;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return out;
}

/**
 * 起端点（同步绑定，失败抛错）：
 * 端口 0 = 系统分配空闲端口（首选，无冲突面）；失败再退到随机高位端口重试。
 * §4.8 错误契约：抛错即「端点不可用」，由宿主转成该轮 SPAWN_FAILED（无后备路径）。
 */
export function startPermissionServer(opts: {
  core: PermissionCore;
  log(message: string): void;
}): PermissionServer {
  const { core, log } = opts;
  // 端口 0 = 由内核分配空闲端口（随后读 bound.port 告诉 CLI）：
  // 不存在「端口占用」这条失败路径，也就不需要随机端口重试（弱随机不进安全相邻代码）。
  // loopbackOnly=true：只接受 127.0.0.1 连接（§7.1）。
  let bound: ServerSocketLike;
  try {
    bound = createServerSocket();
    bound.init(0, true, -1);
  } catch (err) {
    throw new Error(`permission endpoint bind failed: ${String(err)}`);
  }
  const port = bound.port;
  bound.asyncListen({
    QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
    onSocketAccepted(_srv: unknown, transport: SocketTransportLike): void {
      try {
        handleConnection(transport, core, log);
      } catch (err) {
        log(`[perm-mcp] connection setup failed: ${String(err)}`);
        try {
          transport.close(0);
        } catch {
          // 已死连接，忽略
        }
      }
    },
    onStopListening(): void {
      log("[perm-mcp] server socket stopped listening");
    },
  });
  return {
    port,
    stop(): void {
      try {
        bound.close();
      } catch (err) {
        log(`[perm-mcp] socket close failed: ${String(err)}`);
      }
    },
  };
}

/**
 * 单连接驱动：收齐一个请求 → 交给核心（可能等用户决策，最长 120s）→ 写回包。
 * 一个连接只服务一个请求（回包带 Connection: close，语义明确，避免 keep-alive 状态机）。
 *
 * 读法：nsIInputStreamPump（C++ 驱动），**不用 JS 侧 input.asyncWait**。
 * 真机 crash 定位（2026-09-10/11 四份 Zotero 崩溃报告 + .scratch/m6-check/socket-bisect*.js 二分）：
 *   - `input.asyncWait(cb, 0, 0, null)`（null = 当前线程 eventTarget）在第二次就绪事件投递时段错误
 *     （Socket Thread、KERN_INVALID_ADDRESS 0x0），可 100% 复现；
 *   - 同一场景换成显式 `Services.tm.mainThread` eventTarget、或换 nsIInputStreamPump，都不崩；
 *   - 故此处彻底改用泵读法（分段与重新排程由 C++ 侧处理，顺带消掉一整类 JS 时序坑）。
 * 关闭策略：写端只在 respond() 里 close 一次（flush），不单独关流；连接收尾只走
 * transport.close(0)，时点交给「对端 FIN」或 linger 定时器。
 */
// ---- 单连接状态机（纯逻辑，node 可测；端点所有安全边界都在这里）----

/** 连接写/关/日志出口（Gecko 侧接 socket，测试侧接假件） */
export interface ConnectionIo {
  /** 写回响应字节（一个连接只会被调一次——幂等由本状态机保证） */
  write(bytes: Uint8Array): void;
  /** 收连接（幂等：closed 之后不会再调） */
  close(reason: string): void;
  log(message: string): void;
}

/** 定时器注入面（测试用假时钟；缺省用全局 setTimeout/clearTimeout） */
export interface ConnectionTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ConnectionOptions {
  core: PermissionCore;
  io: ConnectionIo;
  /** 收齐请求前的空闲上限（毫秒） */
  idleMs?: number;
  /** 回包后等对端 FIN 的兜底（毫秒） */
  lingerMs?: number;
  /** 请求（头区 + 正文）字节上限；超限即 400 + 立即收连接 */
  maxBytes?: number;
  timers?: ConnectionTimers;
}

export interface ConnectionHandler {
  /** 收到一段请求字节（泵的 onDataAvailable 产物） */
  onData(chunk: Uint8Array): void;
  /** 对端关闭 / 泵停止 */
  onEnd(): void;
}

const DEFAULT_TIMERS: ConnectionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function tooLargeResponse(): HttpResponseParts {
  return {
    status: 400,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "request too large" }),
  };
}

/**
 * 单连接状态机：收齐一个请求 → 交核心（可能等用户决策）→ 回一次包 → 收连接。
 *
 * DoS 加固（安全审计 2026-09-11 致命项）：**403 之前就要先收字节**，所以无凭据的本机进程
 * 也能让端点吃内存。三条不变量把面封死：
 *   1. 未回包前累积有上限：超过 maxBytes 立刻「回一次 400 + 释放缓冲 + 收连接」；
 *   2. 回包/超限后 onData 一律丢弃——不累积、不重设 linger（否则客户端持续发数据即可无限续命）；
 *   3. respond 幂等：一个连接只回一次（分片/重复事件不重复回包）。
 * 连接寿命只由「对端 FIN（onEnd）或 linger 兜底定时器」决定。
 */
export function createConnectionHandler(
  opts: ConnectionOptions,
): ConnectionHandler {
  const { core, io } = opts;
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const idleMs = opts.idleMs ?? CONNECTION_IDLE_MS;
  const lingerMs = opts.lingerMs ?? POST_RESPONSE_LINGER_MS;
  const maxBytes = opts.maxBytes ?? MAX_HEADER_BYTES + MAX_BODY_BYTES;

  let closed = false;
  /** 已产出回包（含超限/畸形）——此后字节与重复回包一律忽略 */
  let answered = false;
  /**
   * 请求已交给核心（可能正在等用户决策，最长 120s）——决策窗口内到达的后续字节不再
   * 二次 parse/dispatch（同连接单请求契约）。修流水线重复派发：首请求等待期间后续字节
   * 触发第二次 handleComplete，把同一份缓冲重新解析成完整请求 → handle/present 被调 2 次。
   */
  let dispatched = false;
  let chunks: Uint8Array[] = [];
  let total = 0;
  let timer: unknown = null;

  function clearTimer(): void {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  }

  function finish(reason: string): void {
    if (closed) {
      return;
    }
    closed = true;
    clearTimer();
    // 立刻断开对累积字节的引用：别让大请求体吊在内存里等 GC
    chunks = [];
    total = 0;
    io.close(reason);
  }

  function respond(res: HttpResponseParts): void {
    if (closed || answered) {
      return; // 幂等：一个连接只回一次
    }
    answered = true;
    io.write(formatHttpResponse(res));
    io.log(`[perm-mcp] responded ${res.status}`);
    // 回包后不再按空闲掐断；连接寿命交给对端 FIN 或 linger 兜底
    clearTimer();
    timer = timers.set(() => finish("linger elapsed"), lingerMs);
  }

  /** 累计缓冲快照（请求小，逐段拼接足够；解析层按 Content-Length 字节数判完） */
  function snapshot(): Uint8Array {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function handleComplete(buf: Uint8Array): void {
    if (dispatched) {
      return; // 已派发（决策等待中）：同一份缓冲不再重放
    }
    const parsed = parseHttpRequest(buf);
    if (parsed.status === "incomplete") {
      return; // 等下一段（泵自动续读）
    }
    // 请求已收齐：解除空闲计时（决策等待最长 120s，不能按空闲掐断）
    clearTimer();
    if (parsed.status === "error") {
      respond({
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: parsed.message }),
      });
      return;
    }
    dispatched = true; // 同步置位：handle 是异步的，等待期到达的字节必须被丢弃
    core
      .handle(parsed.request)
      .then((res) => respond(res))
      .catch((err: unknown) => {
        io.log(`[perm-mcp] handle threw (should not happen): ${String(err)}`);
        respond({
          status: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "internal" }),
        });
      });
  }

  function onData(chunk: Uint8Array): void {
    if (closed || answered || dispatched) {
      // 回包后 / 超限后 / 请求已派发（决策等待中）的字节一律丢弃：不累积、不续命、不重放
      return;
    }
    if (total + chunk.length > maxBytes) {
      // 超限：只回一次 400、立刻释放缓冲、直接收连接（不给「持续发数据续命 + 无限累积」的机会）
      chunks = [];
      total = 0;
      respond(tooLargeResponse());
      finish("oversize request");
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
    handleComplete(snapshot());
  }

  function onEnd(): void {
    if (closed) {
      return;
    }
    finish(
      answered
        ? "peer closed after response"
        : "peer closed before complete request",
    );
  }

  timer = timers.set(
    () => finish("idle timeout (no complete request)"),
    idleMs,
  );

  return { onData, onEnd };
}

/**
 * Gecko 传输层接线：连接的读/写/关都在这里，业务语义全在 createConnectionHandler。
 * 读法用 nsIInputStreamPump（C++ 驱动），不用 JS 侧 input.asyncWait——真机二分结论：
 * `asyncWait(cb, 0, 0, null)`（null eventTarget）在第二次就绪事件投递时段错误
 * （详见 .scratch/m6-check/socket-bisect*.js 与 LEARNINGS.md）。
 * 关闭策略：写端只 close 一次（flush），连接收尾只走 transport.close(0)，不单独关流。
 */
function handleConnection(
  transport: SocketTransportLike,
  core: PermissionCore,
  log: (m: string) => void,
): void {
  const input = transport.openInputStream(0, 0, 0);
  const output = transport.openOutputStream(0, 0, 0);
  const pump = createInputStreamPump();
  let writeClosed = false;

  function closeTransport(reason: string): void {
    try {
      transport.close(0);
    } catch (err) {
      log(`[perm-mcp] transport.close failed: ${String(err)}`);
    }
    log(`[perm-mcp] connection closed: ${reason}`);
  }

  const handler = createConnectionHandler({
    core,
    io: {
      write(bytes: Uint8Array): void {
        if (writeClosed) {
          return; // 双保险：状态机已保证单次回包，这里再防重复关写端
        }
        writeClosed = true;
        try {
          const bin = bytesToLatin1(bytes);
          let written = 0;
          while (written < bin.length) {
            const n = output.write(bin.slice(written), bin.length - written);
            if (!n) {
              log("[perm-mcp] short write, response may be truncated");
              break;
            }
            written += n;
          }
        } catch (err) {
          log(`[perm-mcp] write failed (client gone?): ${String(err)}`);
        }
        // 关写端 = flush（半关闭）；连接本体留给对端 FIN / linger 兜底
        try {
          output.close();
        } catch (err) {
          log(`[perm-mcp] output.close failed: ${String(err)}`);
        }
      },
      close: closeTransport,
      log,
    },
  });

  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
    onStartRequest(): void {
      // 无需动作：数据在 onDataAvailable，EOF 在 onStopRequest
    },
    onDataAvailable(
      _request: unknown,
      stream: unknown,
      _offset: number,
      count: number,
    ): void {
      let chunk: Uint8Array;
      try {
        chunk = readBytes(stream as InputStreamLike, count);
      } catch (err) {
        // 读失败：泵随后会以 onStopRequest 收尾，这里只留痕
        log(`[perm-mcp] read failed: ${String(err)}`);
        return;
      }
      handler.onData(chunk);
    },
    onStopRequest(): void {
      handler.onEnd();
    },
  };

  // 泵初始化（签名随 Gecko 版本演化：5 参带 mainThreadTarget 是现代形态；
  // 4 参 / 3 参是旧版（Zotero 7/8 的 Gecko 底座可能只认后者）——按序尝试，第一个不抛错的生效）
  const pumpCandidates: Array<[string, () => void]> = [
    [
      "5-arg+mainThread",
      () => pump.init(input, 0, 0, false, Services.tm.mainThread),
    ],
    ["4-arg", () => pump.init(input, 0, 0, false)],
    ["3-arg-legacy", () => pump.init(input, 0, false)],
  ];
  let pumpReady = false;
  for (const [label, init] of pumpCandidates) {
    try {
      init();
      log(`[perm-mcp] pump init ok (${label})`);
      pumpReady = true;
      break;
    } catch (err) {
      log(`[perm-mcp] pump init failed (${label}): ${String(err)}`);
    }
  }
  if (!pumpReady) {
    closeTransport("no usable nsIInputStreamPump.init signature");
    return;
  }
  try {
    pump.asyncRead(listener);
  } catch (err) {
    closeTransport(`asyncRead failed: ${String(err)}`);
  }
}
