// commands.ts — R7-C「/ 命令面板」宿主侧纯逻辑（PLAN-R7 §3.5）。
// 本地命令 = 硬编码白名单（UI 只能传命令名）；自定义命令 = 只读两处固定目录里的 frontmatter
// name/description（**正文不进解析结果**，故不存在把面板输入当命令执行的通道）。
//
// 为什么（用户原话 2026-09-11）：输入框打 `/` 弹命令面板——插件本地命令零往返执行，
// Claude Code 自定义命令/技能转发给 CLI 展开。
//
// headless 展开实测（2026-09-11，见报告）：
//   cd /tmp/r7probe && claude -p "/probe hello"   →  输出 PROBE-EXPANDED-OK
// 即 CLI **会**展开自定义命令 → 选中后原样转发 `/名字 参数` 即可；若某天不展开，
// 宿主分支用 forwardCommandText 把「命令正文 + 参数」当 prompt 发送（两条路径都留）。

/** 用户级命令目录（`~` 由注入的 home 展开；测试口径：home + 相对段） */
export const COMMANDS_DIR_USER = "~/.claude/commands";
/** 项目级命令目录（相对工作区根；project 覆盖同名 user——就近优先） */
export const COMMANDS_DIR_PROJECT = ".claude/commands";
/** 单文件上限（PLAN §3.5：> 64KB 跳过；正好 64KB 保留） */
export const COMMAND_FILE_MAX_BYTES = 64 * 1024;
/** 命令总数上限（PLAN §3.5） */
export const COMMANDS_MAX = 200;

/**
 * 自定义命令的转发口径（headless 实测结论，2026-09-11）：
 * `claude -p "/probe hello"` 被 CLI 展开 → "expand"（原样转发 `/名字 参数`）。
 * 若某天 CLI 不展开（版本/设置差异），改成 "inline"：宿主读命令正文，把「正文 + 参数」当 prompt 发。
 */
export const COMMAND_FORWARD_MODE: "expand" | "inline" = "expand";

export type CommandSource = "local" | "user" | "project";

/** 面板里的每一条（commandList.commands 元素形态） */
export interface CommandEntry {
  /** 命令名，**不带**前导 `/`（UI 显示时加；头部裁决 4） */
  name: string;
  description: string;
  source: CommandSource;
}

/** 本地命令（白名单条目）：action 是**枚举字符串**，不是可执行体（不存在注入面） */
export interface LocalCommand extends CommandEntry {
  source: "local";
  /** 动作 id（UI 侧映射到具体行为：新会话/清视图/存笔记/…） */
  action: string;
}

/**
 * 本地命令白名单（PLAN §3.5 表格逐字）：面板直接执行、零往返零 token。
 * 名称不带前导 `/`（头部裁决 4）；`resolveLocalCommand` 是唯一解析入口。
 * 注意：本地命令**不接受参数**（`/new foo` 仍按 `/new` 处理，忽略尾巴）——头部裁决 2。
 */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  {
    name: "new",
    description: "新建会话（当前视图换到新会话）",
    action: "newSession",
    source: "local",
  },
  {
    name: "clear",
    description: "清空当前视图的消息（不删会话，历史仍在磁盘上）",
    action: "clearView",
    source: "local",
  },
  {
    name: "note",
    description: "把上一条回答存为笔记",
    action: "saveNote",
    source: "local",
  },
  {
    name: "instructions",
    description: "打开项目指令编辑器（CLAUDE.md）",
    action: "openInstructions",
    source: "local",
  },
  {
    name: "workspace",
    description: "打开当前工作区目录",
    action: "openWorkspace",
    source: "local",
  },
  {
    name: "balance",
    description: "刷新账户余额",
    action: "refreshBalance",
    source: "local",
  },
  {
    name: "export",
    description: "把当前会话导出为 Markdown 到工作区",
    action: "exportSession",
    source: "local",
  },
  {
    name: "help",
    description: "显示命令帮助",
    action: "showHelp",
    source: "local",
  },
  {
    name: "diag",
    description: "生成诊断报告（可复制粘贴给开发）",
    action: "showDiag",
    source: "local",
  },
];

/**
 * 命令名解析（唯一入口；白名单枚举）：接受 `/name`、`name`、`/name 参数`（参数忽略）；
 * 其余（未知命令、空串、孤斜杠、非字符串、`/rm -rf /` 之类）一律 null，**没有任何执行通道**。
 */
export function resolveLocalCommand(input: unknown): LocalCommand | null {
  if (typeof input !== "string") {
    return null;
  }
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  const body = raw.startsWith("/") ? raw.slice(1) : raw;
  const name = body.split(/\s+/)[0] ?? "";
  if (!name) {
    return null;
  }
  const hit = LOCAL_COMMANDS.find((cmd) => cmd.name === name);
  return hit ? { ...hit } : null;
}

/** frontmatter 解析产物（**只有** name/description：正文嗅探面为零） */
export interface ParsedCommandFile {
  name: string;
  description: string;
}

/** 剥一层成对引号（`"总结"` / `'总结'` → 总结） */
function unquote(value: string): string {
  const t = value.trim();
  const m = t.match(/^(['"])(.*)\1$/);
  return m ? m[2].trim() : t;
}

/**
 * 单个命令文件解析（PLAN §3.5）：只认文件头 `---` 块里的 name/description；
 * 无 frontmatter / 缺 name → 回落文件名（去 `.md`）；description 缺失给空串。
 * **正文一律不读**（危险正文进不了解析结果，见单测）。
 */
export function parseCommandFile(input: {
  fileName: string;
  text: string;
}): ParsedCommandFile | null {
  const fileName = typeof input?.fileName === "string" ? input.fileName : "";
  const text = typeof input?.text === "string" ? input.text : "";
  const fallback = fileName.replace(/\.md$/i, "").trim();

  let name = "";
  let description = "";
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") {
    i += 1; // 容忍文件头空行
  }
  if (i < lines.length && lines[i].trim() === "---") {
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "---") {
        break; // frontmatter 结束，其余是正文（不看）
      }
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) {
        continue;
      }
      const key = kv[1].toLowerCase();
      if (key === "name" && !name) {
        name = unquote(kv[2]);
      } else if (key === "description" && !description) {
        description = unquote(kv[2]);
      }
    }
  }
  const finalName = name || fallback;
  if (!finalName) {
    return null;
  }
  return { name: finalName, description };
}

/** 目录项（注入面；真实实现走 IOUtils，测试注入 fake） */
export interface CommandDirEntry {
  name: string;
  size?: number;
  symlink?: boolean;
  dir?: boolean;
}

/** 扫描注入面（不 import Zotero：单测注入 fake fs） */
export interface CommandScanDeps {
  /** 工作区根 */
  root: string;
  /** 用户 home（`~` 展开） */
  home: string;
  fs: {
    listDir(dir: string): Promise<CommandDirEntry[]>;
    readText(path: string): Promise<string | null>;
    join(dir: string, name: string): string;
  };
}

/** 相对段拼到 base 上（绝对段原样；`~/x` 剥掉 `~/`） */
function joinBase(base: string, rel: string): string {
  const tail = rel.replace(/^~\//, "");
  if (rel.startsWith("/")) {
    return rel;
  }
  const head = String(base ?? "").replace(/[/\\]+$/, "");
  return head ? `${head}/${tail}` : tail;
}

/** 扫描内部产物：面板条目 + 正文（正文只给 inline 转发分支用，绝不进 commandList） */
interface ScannedCommand extends CommandEntry {
  body: string;
}

/** 剥掉 frontmatter 块，留正文（inline 转发分支用） */
function bodyOf(text: string): string {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") {
    i += 1;
  }
  if (i < lines.length && lines[i].trim() === "---") {
    for (i += 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        i += 1;
        break;
      }
    }
  }
  return lines.slice(i).join("\n").trim();
}

/** 扫一处目录（不递归、不跟随符号链接、非 .md 忽略、超限不读、读失败跳过） */
async function scanDir(
  dir: string,
  source: "user" | "project",
  deps: CommandScanDeps,
  seen: Set<string>,
  out: ScannedCommand[],
): Promise<void> {
  let entries: CommandDirEntry[];
  try {
    const listed = await deps.fs.listDir(dir);
    entries = Array.isArray(listed) ? listed : [];
  } catch {
    return; // 目录不存在/读不到 → 这一处当空（另一处照常返回）
  }
  for (const entry of entries) {
    if (out.length >= COMMANDS_MAX) {
      return;
    }
    if (!entry || typeof entry.name !== "string") {
      continue;
    }
    if (entry.dir || entry.symlink) {
      continue; // 子目录不递归；符号链接（文件或目录）不跟随
    }
    if (!/\.md$/i.test(entry.name)) {
      continue;
    }
    if (typeof entry.size === "number" && entry.size > COMMAND_FILE_MAX_BYTES) {
      continue; // 超限跳过，且**不去读**（不做无谓 IO）
    }
    let text: string | null;
    try {
      text = await deps.fs.readText(deps.fs.join(dir, entry.name));
    } catch {
      continue;
    }
    if (typeof text !== "string") {
      continue; // 读不到 → 跳过它，整批不崩
    }
    const parsed = parseCommandFile({ fileName: entry.name, text });
    if (!parsed || seen.has(parsed.name)) {
      continue;
    }
    seen.add(parsed.name);
    out.push({
      name: parsed.name,
      description: parsed.description,
      source,
      body: bodyOf(text),
    });
  }
}

/** 两处目录全扫（内部口径：带正文） */
async function collectCommands(
  deps: CommandScanDeps,
): Promise<ScannedCommand[]> {
  const out: ScannedCommand[] = [];
  const seen = new Set<string>();
  await scanDir(
    joinBase(deps.root, COMMANDS_DIR_PROJECT),
    "project",
    deps,
    seen,
    out,
  );
  await scanDir(
    joinBase(deps.home, COMMANDS_DIR_USER),
    "user",
    deps,
    seen,
    out,
  );
  return out;
}

/**
 * 扫描命令目录（PLAN §3.5）：**固定两处**——`<工作区根>/.claude/commands` 与 `~/.claude/commands`。
 * project 先扫（同名覆盖 user）、不递归、不跟随符号链接、> 64KB 跳过、总数上限 200。
 * 任一处不可读都不抛：命令面板是加分项，不该拦发送。
 */
export async function scanCommands(
  deps: CommandScanDeps,
): Promise<CommandEntry[]> {
  const scanned = await collectCommands(deps);
  // 正文剥掉再出面板面（commandList 里只有 name/description/source）
  return scanned.map(({ name, description, source }) => ({
    name,
    description,
    source,
  }));
}

/**
 * 自定义命令正文（inline 转发分支用；default 分支不走这里）：
 * name → 正文（去 frontmatter）；查不到 → null。project 优先（与去重口径一致）。
 */
export async function readCommandBody(
  name: unknown,
  deps: CommandScanDeps,
): Promise<string | null> {
  if (typeof name !== "string" || !name) {
    return null;
  }
  const hit = (await collectCommands(deps)).find((cmd) => cmd.name === name);
  return hit ? hit.body : null;
}

/**
 * 面板过滤（纯函数）：前缀命中排在包含命中之前（下拉第一条永远最贴近），大小写不敏感，
 * 中文按子串匹配；空关键词 → 全量（打 `/` 先看到全部命令）；非数组输入 → 空数组。
 */
export function filterCommands(list: unknown, query: unknown): CommandEntry[] {
  const items = (Array.isArray(list) ? list : []).filter(
    (c): c is CommandEntry => !!c && typeof c.name === "string",
  );
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) {
    return [...items];
  }
  const prefix: CommandEntry[] = [];
  const contains: CommandEntry[] = [];
  for (const cmd of items) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) {
      prefix.push(cmd);
    } else if (name.includes(q)) {
      contains.push(cmd);
    }
  }
  // 前缀组内按名字长度升序（等价于「精确命中/最短命中排最前」，同长保持原序）：
  // query=sum 时 sum 必须排在 summarize 之前
  prefix.sort((a, b) => a.name.length - b.name.length);
  return [...prefix, ...contains];
}

/** 发送文本开头的自定义命令形态：`/名字 参数…`（本地白名单命令不在此列，面板直接执行） */
export function parseCommandInvocation(
  text: unknown,
): { name: string; args: string } | null {
  if (typeof text !== "string") {
    return null;
  }
  const m = text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!m || resolveLocalCommand(m[1])) {
    return null;
  }
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/**
 * 自定义命令转发（headless 展开分支的落地）：
 * - 实测 CLI 会展开（见 COMMAND_FORWARD_MODE）→ `mode:"expand"`，原样把 `/名字 参数` 当 prompt 发；
 * - 若某天 CLI 不展开 → `mode:"inline"`，把「命令正文 + 参数」当 prompt 发。
 * 两条分支都留，调用方按 mode 记日志（宿主绝不本地执行命令）。
 */
export function forwardCommandText(
  text: string,
  body?: string | null,
): { text: string; mode: "expand" | "inline" } {
  if (COMMAND_FORWARD_MODE === "inline") {
    const inv = parseCommandInvocation(text);
    if (inv && typeof body === "string" && body.trim()) {
      return {
        text: inv.args ? `${body.trim()}\n\n${inv.args}` : body.trim(),
        mode: "inline",
      };
    }
  }
  return { text: typeof text === "string" ? text : "", mode: "expand" };
}
