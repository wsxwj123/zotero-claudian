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
/** 用户级技能目录（R12-A：扫一层子目录，读 <技能>/SKILL.md 的 frontmatter） */
export const SKILLS_DIR_USER = "~/.claude/skills";
/** 项目级技能目录（相对工作区根） */
export const SKILLS_DIR_PROJECT = ".claude/skills";
/** 技能入口文件名（固定：Claude Code 的技能定义文件） */
export const SKILL_FILE_NAME = "SKILL.md";
/** 单文件上限（PLAN §3.5：> 64KB 跳过；正好 64KB 保留） */
export const COMMAND_FILE_MAX_BYTES = 64 * 1024;
/** 单处扫描的条目上限（PLAN §3.5） */
export const COMMANDS_MAX = 200;
/**
 * 面板可见上限（R12-A）：宿主把「本地(9) + 内置(2) + 命令(≤200) + 技能(≤200)」拼在一起送上来，
 * 前端若还按 COMMANDS_MAX 切，尾部的技能会被整段切掉（用户反馈要的正是技能）。
 * = 2×COMMANDS_MAX + 20（本地 9 + 内置 2 = 11，留 20 的余量）——宿主送多少就照单全收。
 */
export const COMMANDS_PANEL_MAX = COMMANDS_MAX * 2 + 20;

/**
 * 自定义命令的转发口径（headless 实测结论，2026-09-11）：
 * `claude -p "/probe hello"` 被 CLI 展开 → "expand"（原样转发 `/名字 参数`）。
 * 若某天 CLI 不展开（版本/设置差异），改成 "inline"：宿主读命令正文，把「正文 + 参数」当 prompt 发。
 */
export const COMMAND_FORWARD_MODE: "expand" | "inline" = "expand";

export type CommandSource = "local" | "builtin" | "user" | "project" | "skill";

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

/**
 * 内置命令（R12-A 实测产出）：**只收「CLI 亲自处理了」的**——选中后原样插 `/名字 ` 转发给 CLI，
 * 与自定义命令同一条路径（不本地执行、不自动发送）。
 *
 * 实测方法（2026-09-12，claude 2.1.267，`claude -p "/<名>" --output-format json`）：
 * 判据 = num_turns=0 且 output_tokens=0（模型没被调用，CLI 自己应答）＋ result 文本体现命令语义。
 * 八个候选的结论：
 *   /compact → "Not enough messages to compact."        → ①CLI 处理，收
 *   /model   → "Current model: ... Usage: /model <名>"  → ①CLI 处理，收
 *   /config  → "Usage: /config key=value ..."           → ①CLI 处理，但只吐用法（无参数即无动作）→ 不收
 *   /agents  → "The /agents wizard has been removed."   → ①CLI 处理，但功能已被官方移除 → 不收
 *   /clear   → 空 result（CLI 静默清会话）               → ①CLI 处理，但本地白名单已有同名 /clear（清视图）→ 不收
 *   /help    → "/help isn't available in this environment." → ③不可用 → 不收
 *   /status  → "/status isn't available in this environment." → ③不可用 → 不收
 *   /review  → 无输出、240s 挂死；stderr `unrecognized_model {"query_source":"agent:custom"}` → ③报错挂死 → 不收
 * 无「②被当成普通文本发给模型」样本：未知命令回 "Unknown command: /x"（num_turns=0），CLI 不把斜杠开头当 prompt。
 * 名字不得与 LOCAL_COMMANDS 撞车（撞了本地优先，宿主侧还会再过滤一次）。
 */
export const BUILTIN_COMMANDS: readonly CommandEntry[] = [
  {
    name: "compact",
    description: "压缩当前会话上下文（CLI 内置；消息太少时会回「不够压缩」）",
    source: "builtin",
  },
  {
    name: "model",
    description: "查看当前模型；`/model 名字` 切换（CLI 内置）",
    source: "builtin",
  },
];

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

/** 扫一处目录（不递归、符号链接目录会**跟随**（用户可把技能目录软链进来；实测如此，勿改）、非 .md 忽略、超限不读、读失败跳过） */
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
      continue; // 子目录不递归；符号链接会跟随（IOUtils.stat 跟随链接；用户可软链技能/命令进来）
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
 * 技能目录名净化（R12-A）：目录名会变成面板里的 `/名字`，只认「单段、非隐藏、无路径分隔符」的普通名。
 * 挡掉 `..`、`/`、`\`、空白与控制字符、以 `.` 开头的项——名字里不带任何路径语义。
 */
export function isSafeSkillDirName(name: unknown): boolean {
  if (typeof name !== "string" || !name) {
    return false;
  }
  if (name.startsWith(".") || name.includes("..")) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[/\\\s\u0000-\u001f]/.test(name);
}

/**
 * 扫一处技能目录（R12-A）：**只一层**——`<dir>/<技能名>/SKILL.md`。
 * 技能名取 frontmatter 的 `name`（headless 实测 2026-09-12：目录 `probe2-dir` + frontmatter
 * `name: probe2-front`，`/probe2-dir` 与 `/probe2-front` **都能**把正文带进上下文；既然两个名字都通，
 * 取作者声明的那个），没写 name 时回落**目录名**；描述取 frontmatter 的 description（**不读正文**）。
 * 非目录条目跳过（符号链接目录**会**被跟随——用户可把技能目录软链进来）；`SKILL.md` 读不到跳过；> 64KB 跳过。
 * 元数据里的「插件 : 技能」命名（`ponytail:ponytail`）实测**不是**可展开形态（被当普通文本发给模型），
 * 故插件技能不在此列（见 R12 报告）。
 */
async function scanSkillsDir(
  dir: string,
  deps: CommandScanDeps,
  seen: Set<string>,
  out: ScannedCommand[],
): Promise<void> {
  let entries: CommandDirEntry[];
  try {
    const listed = await deps.fs.listDir(dir);
    entries = Array.isArray(listed) ? listed : [];
  } catch {
    return; // 目录不存在/读不到 → 这一处当空
  }
  for (const entry of entries) {
    if (out.length >= COMMANDS_MAX) {
      return;
    }
    if (!entry || typeof entry.name !== "string") {
      continue;
    }
    if (!entry.dir || entry.symlink) {
      continue; // 只认一层子目录；符号链接目录会跟随（同上）
    }
    const skillName = entry.name;
    if (!isSafeSkillDirName(skillName) || seen.has(skillName)) {
      continue;
    }
    const skillPath = deps.fs.join(
      deps.fs.join(dir, skillName),
      SKILL_FILE_NAME,
    );
    let text: string | null;
    try {
      text = await deps.fs.readText(skillPath);
    } catch {
      continue;
    }
    if (typeof text !== "string") {
      continue; // 没有 SKILL.md（或读不到）→ 这不是技能目录
    }
    // ponytail: 大小门放在读之后（注入面只有 readText，没有 ranged read）——> 64KB 的 SKILL.md 会被
    // 整段读一次再丢；实测环境 91 个技能共 ~1.9MB、超限 7 个，代价可忽略。要省这点 IO 再给 fs 加口径。
    if (text.length > COMMAND_FILE_MAX_BYTES) {
      continue;
    }
    const parsed = parseCommandFile({ fileName: skillName, text });
    if (!parsed) {
      continue;
    }
    // frontmatter 的 name 也会变成面板里的 `/名字` → 同样过净化；不合法就回落目录名
    const commandName = isSafeSkillDirName(parsed.name)
      ? parsed.name
      : skillName;
    if (seen.has(commandName)) {
      continue;
    }
    seen.add(commandName);
    out.push({
      name: commandName,
      description: parsed.description,
      source: "skill", // 两处技能目录都标 skill（面板标签「技能」；项目/用户的区别只体现在去重优先级）
      body: "", // 技能正文绝不进 inline 转发（技能由 CLI 展开，宿主不代读）
    });
  }
}

/**
 * 扫描技能目录（R12-A，用户反馈「所有的 skill 也没有在 slash 命令中显示」）：
 * **固定两处**——`<工作区根>/.claude/skills` 与 `~/.claude/skills`，各只下一层。
 * 与 `scanCommands` 分开（命令那两处的扫描面是既有契约，不掺进来）；去重口径同：项目级先扫、同名覆盖用户级。
 * 任一处不可读都不抛：面板是加分项，不该拦发送。
 */
export async function scanSkills(
  deps: CommandScanDeps,
): Promise<CommandEntry[]> {
  const out: ScannedCommand[] = [];
  const seen = new Set<string>();
  await scanSkillsDir(joinBase(deps.root, SKILLS_DIR_PROJECT), deps, seen, out);
  await scanSkillsDir(joinBase(deps.home, SKILLS_DIR_USER), deps, seen, out);
  return out.map(({ name, description, source }) => ({
    name,
    description,
    source,
  }));
}

/**
 * 扫描命令目录（PLAN §3.5）：**固定两处**——`<工作区根>/.claude/commands` 与 `~/.claude/commands`。
 * project 先扫（同名覆盖 user）、不递归、符号链接目录会**跟随**（用户可把技能目录软链进来；实测如此，勿改）、> 64KB 跳过、总数上限 200。
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
