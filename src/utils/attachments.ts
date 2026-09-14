// attachments.ts — R7-J「附件（粘贴图片/文件）」纯逻辑（PLAN-R7 §3.11，裁决 2026-09-11）。
// 落点（裁决 J6）：**本轮 cwd 下** `<cwd>/attachments/<会话id>/<轮序号>/<净化名>`——
// collection 模式下 cwd 已含合集目录，所以永远在 cwd 内：CLI 天然可读，
// 不需要额外 --add-dir，也不削弱既有 deny（写保护面不扩大）。
//
// 类型策略（裁决 J10）：**可执行黑名单拒绝**，其余一律放行（pdf/svg/无扩展名都放）。
// 体积/条数：单文件 ≤ 20MB（含等号）、单条 ≤ 10 个（前 10 照落、第 11 拒）、0 字节放行。
// 编辑态增删：以新集合为准；**旧附件文件一个都不删**（历史消息仍引用它）——
// 编排里只允许 makeDir / listNames / copyFile / exists（fs 上的 remove 永不调用）。
// fs 面注入（node 单测用内存实现，宿主用 IOUtils）。

import { isWindowsReservedName } from "./paths";

export const ATTACHMENT_DIR_NAME = "attachments";
/** 图片扩展名（区块里带「可用 Read 查看」提示的就这些；也是 UI 图标的判据） */
export const ATTACHMENT_IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
] as const;
/** 单文件上限 20MB（正好 20MB 放行） */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** 单条消息最多 10 个附件 */
export const ATTACHMENT_MAX_PER_MESSAGE = 10;
/** 净化后文件名长度上限（扩展名保住） */
export const ATTACHMENT_NAME_MAX = 120;

/** 可执行/脚本类黑名单（大小写不敏感；伪装扩展名 `.png.exe` 也按最后一段判） */
export const ATTACHMENT_EXEC_EXTS = [
  "exe",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "app",
  "dmg",
  "com",
  "scr",
  "msi",
  "vbs",
  "jar",
  "lnk",
  "command",
  "desktop",
] as const;

const EXEC_SET: ReadonlySet<string> = new Set<string>(ATTACHMENT_EXEC_EXTS);
const IMAGE_SET: ReadonlySet<string> = new Set<string>(ATTACHMENT_IMAGE_EXTS);

/**
 * 待落盘的一枚附件（**宿主内部形态**）。信任边界（安全修 2026-09-11）：`sourcePath`
 * 只允许由宿主写入——要么来自宿主原生选择器的一次性凭据换回的本机路径，要么是本模块
 * 调用方自己写的临时文件；**页面传来的任何路径字段都不会进到这个结构**（hostBridge
 * 的载荷归一直接不读 sourcePath）。页面能给的只有 base64 字节或 token。
 */
export interface AttachmentInput {
  name: string;
  sizeBytes: number;
  /** 宿主侧本机路径（直拷，不走 base64）；只在宿主内存里流转 */
  sourcePath?: string;
  /** 拿不到宿主凭据时的 base64 字节（粘贴剪贴板文件；不带 data URL 前缀） */
  base64?: string;
}

/** 已落盘附件（回执与 prompt 区块的形态） */
export interface Attachment {
  name: string;
  path: string;
  sizeBytes: number;
  /** 发送前已不存在（UI 标红；区块里不列） */
  missing?: boolean;
}

export interface RejectedAttachment {
  name: string;
  reason: string;
}

export interface SavedAttachment {
  name: string;
  path: string;
  size: number;
}

export interface SaveAttachmentsResult {
  saved: SavedAttachment[];
  rejected: RejectedAttachment[];
}

/** fs 注入面：**没有 delete/remove**（旧附件永不删，见文件头） */
export interface AttachmentsFs {
  exists(path: string): Promise<boolean>;
  makeDir(path: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  listNames(dir: string): Promise<string[]>;
  join(...segments: string[]): string;
}

function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  // 无点 / 点在最前（.png 这类隐藏名）→ 整个当主干；超长「扩展名」不当扩展名
  if (i <= 0 || name.length - i - 1 > 20) {
    return [name, ""];
  }
  return [name.slice(0, i), name.slice(i)];
}

/** 去掉路径分隔符/控制字符/Windows 非法字符，压掉 `..`，去首尾空白与点，保住 Unicode */
/** 逐字符判非法（控制字符用码点判——正则字面量里的控制字符会触发 no-control-regex） */
function isIllegalChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f) {
    return true; // 控制字符（含 NUL 与 DEL）
  }
  return '<>:"|?*'.includes(ch); // Windows 非法字符（路径分隔符另走 basename 截断）
}

/** 去掉路径分隔符/控制字符/Windows 非法字符，压掉 `..`，去首尾空白与点，保住 Unicode */
function stripIllegal(raw: string): string {
  const base = raw.split(/[\\/]+/).pop() ?? ""; // 只取最后一段（穿越形态在此截断）
  let out = "";
  for (const ch of base) {
    if (!isIllegalChar(ch)) {
      out += ch;
    }
  }
  return out
    .replace(/\.{2,}/g, ".") // 压掉 .. 组合
    .trim()
    .replace(/^\.+/, "") // 前导点（隐藏名 / 「..」残形）
    .replace(/[. ]+$/g, ""); // Windows 下不得以点或空格结尾
}

/**
 * 文件名净化（裁决 J7）：去分隔符/控制字符/Windows 保留设备名，超长截到 120 保住扩展名；
 * 中文/emoji/空格原样保留。净化后**永远非空且不含 `/` `\` `..`**（落点目录的安全前提）。
 */
export function sanitizeAttachmentName(raw: unknown): string {
  const source = typeof raw === "string" ? raw : "";
  let name = stripIllegal(source);
  if (!name) {
    name = "attachment";
  }
  // Windows 保留设备名（CON / com9.png / LPT1 / COM¹.png…）：补一个下划线打头，形态就不再命中
  // （判据与合集目录名净化共用 utils/paths 的 isWindowsReservedName，R7 兼容审查必修-2）
  if (isWindowsReservedName(name)) {
    name = `_${name}`;
  }
  if (name.length > ATTACHMENT_NAME_MAX) {
    const [base, ext] = splitExt(name);
    const room = Math.max(1, ATTACHMENT_NAME_MAX - ext.length);
    name = `${base.slice(0, room).replace(/[. ]+$/g, "")}${ext}`;
  }
  return name || "attachment";
}

/** 目录内重名 → 加序号（`a.png` → `a-2.png`；大小写不敏感，裁决 J8，按最后一个点切分） */
export function uniqueAttachmentName(
  name: string,
  takenNames: readonly string[] | null | undefined,
): string {
  const taken = new Set(
    (Array.isArray(takenNames) ? takenNames : []).map((n) =>
      String(n).toLowerCase(),
    ),
  );
  if (!taken.has(name.toLowerCase())) {
    return name;
  }
  const [base, ext] = splitExt(name);
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** 是否图片（条目带「可用 Read 查看」提示 / UI 出图片图标） */
export function isImageAttachment(name: unknown): boolean {
  const raw = typeof name === "string" ? name : "";
  const i = raw.lastIndexOf(".");
  return i > 0 && IMAGE_SET.has(raw.slice(i + 1).toLowerCase());
}

/**
 * 拒绝原因（null = 放行）：可执行类型黑名单 + 单文件 20MB 上限。
 * 条数上限在 saveAttachments 里按「已接受个数」判（第 11 个才拒，不整批失败）。
 */
export function attachmentRejectReason(
  file: { name?: unknown; sizeBytes?: unknown } | null | undefined,
): string | null {
  const name = sanitizeAttachmentName(file?.name);
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  if (ext && EXEC_SET.has(ext)) {
    return `不支持可执行/脚本类文件（.${ext}）`;
  }
  const size = file?.sizeBytes;
  if (
    typeof size === "number" &&
    Number.isFinite(size) &&
    size > ATTACHMENT_MAX_BYTES
  ) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return `文件 ${mb}MB 超过单文件 20MB 上限`;
  }
  return null;
}

/**
 * 路径分隔符跟着 cwd 走（Windows cwd 用 `\`）；纯函数，与 PathUtils 同口径。
 * R17 P6 同族收尾：这只是**猜**（win32 用户把工作区写成 `E:/Zotero/ws` 就会拼出
 * `E:/Zotero/ws/attachments\…` 这种混用路径，Gecko 直接判 NS_ERROR_FILE_UNRECOGNIZED_PATH）
 * ——新调用方请传下面那个注入的 `join`（真宿主 = PathUtils.join）；缺省分支只为老调用方保留。
 */
function separatorOf(cwd: string): string {
  return cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
}

/**
 * 附件落点（裁决 J6）：`<本轮 cwd>/attachments/<会话id>/<轮序号>`。
 * 会话 id / 轮序号在这里白名单化 —— 拼出的路径永远在 cwd 内（穿越形态直接抛）。
 */
export function attachmentDirPath(input: {
  cwd: string;
  sessionId: string;
  turn: number;
  /**
   * R17 P6 同族收尾：可选注入的路径拼接（真宿主传 PathUtils.join）。
   * 缺省 = 今天的按 cwd 猜分隔符（老调用方与既有单测逐字不变）。
   */
  join?: (...segs: string[]) => string;
}): string {
  const cwd = typeof input?.cwd === "string" ? input.cwd : "";
  if (!cwd) {
    throw new Error("attachmentDirPath: cwd 必填");
  }
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    [...sessionId].some(isIllegalChar) ||
    /[\\/]/.test(sessionId)
  ) {
    throw new Error(
      `attachmentDirPath: 非法会话 id ${JSON.stringify(sessionId)}`,
    );
  }
  const turn = input?.turn;
  if (!Number.isInteger(turn) || (turn as number) < 0) {
    throw new Error(`attachmentDirPath: 非法轮序号 ${String(turn)}`);
  }
  const root = cwd.replace(/[\\/]+$/, "");
  const segs = [root, ATTACHMENT_DIR_NAME, sessionId, String(turn)];
  return input.join ? input.join(...segs) : segs.join(separatorOf(cwd));
}

/**
 * 落盘（裁决 J5/J6）：逐条判类型/体积 → 前 10 个落、其余拒；重名自动加序号。
 * 一条坏文件不掀翻整批（只拒那一条）；被拒的**不建目录也不落盘**（全拒时连目录都不建）。
 * 编排里永不调用 fs 的删除动作 —— 旧附件文件属于历史消息。
 */
export async function saveAttachments(
  input: {
    cwd: string;
    sessionId: string;
    turn: number;
    files?: readonly AttachmentInput[] | null;
    /** R17 P6 同族收尾：落点拼接的注入面（透传给 attachmentDirPath；缺省 = 猜分隔符） */
    join?: (...segs: string[]) => string;
  },
  deps: { fs: AttachmentsFs },
): Promise<SaveAttachmentsResult> {
  const { fs } = deps;
  const dir = attachmentDirPath(input); // 非法 cwd/会话 id/轮序号在此抛
  const files = Array.isArray(input?.files) ? input.files : [];
  const rejected: RejectedAttachment[] = [];
  const accepted: AttachmentInput[] = [];
  for (const file of files) {
    const name = sanitizeAttachmentName(file?.name);
    const reason = attachmentRejectReason(file);
    if (reason) {
      rejected.push({ name, reason });
      continue;
    }
    if (accepted.length >= ATTACHMENT_MAX_PER_MESSAGE) {
      rejected.push({
        name,
        reason: `单条最多 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件，超出部分未保存`,
      });
      continue;
    }
    accepted.push(file);
  }
  if (accepted.length === 0) {
    return { saved: [], rejected };
  }
  await fs.makeDir(dir);
  // 同批次内也要查重（两次粘贴同名图）；目录里已有的用 listNames 现读
  const taken = (await fs.listNames(dir)).map((n) => String(n));
  const saved: SavedAttachment[] = [];
  for (const file of accepted) {
    const name = uniqueAttachmentName(sanitizeAttachmentName(file.name), taken);
    const path = fs.join(dir, name);
    try {
      await fs.copyFile(file.sourcePath ?? "", path);
    } catch (err) {
      // 单条落盘失败（保留名漏网/权限/源被删…）→ 只拒这一条，其余照落（文件头承诺）
      rejected.push({
        name,
        reason: `附件保存失败：${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    taken.push(name); // 只有真落盘的才占名（失败的没产出文件，不该把名字挤掉）
    saved.push({ name, path, size: file.sizeBytes });
  }
  return { saved, rejected };
}

/** 编辑态增删：以新集合为准（原序保持，新增追加）；纯函数，无删除语义（旧文件不动） */
export function resolveEditedAttachments(
  original: readonly Attachment[] | null | undefined,
  edit: {
    add?: readonly Attachment[] | null;
    remove?: readonly string[] | null;
  },
): Attachment[] {
  const removed = new Set(
    (Array.isArray(edit?.remove) ? edit.remove : []).map((n) =>
      String(n).toLowerCase(),
    ),
  );
  const kept = (Array.isArray(original) ? original : []).filter(
    (a) => !removed.has(String(a?.name ?? "").toLowerCase()),
  );
  return [...kept, ...(Array.isArray(edit?.add) ? edit.add : [])];
}

/** 发送前标记缺失（UI 据此标红；区块里不列坏路径） */
export async function markMissingAttachments(
  list: readonly Attachment[] | null | undefined,
  deps: { fs: AttachmentsFs },
): Promise<(Attachment & { missing: boolean })[]> {
  const items = Array.isArray(list) ? list : [];
  const out: (Attachment & { missing: boolean })[] = [];
  for (const item of items) {
    let missing = false;
    try {
      missing = !(await deps.fs.exists(item?.path ?? ""));
    } catch {
      missing = true;
    }
    out.push({ ...item, missing });
  }
  return out;
}

/**
 * prompt 区块：`[Attachments]` … `[/Attachments]`，逐条编号 + 绝对路径；
 * 图片条目带「这是图片，可用 Read 查看」。空列表 / 全部缺失 → 空串（不产出区块）。
 */
export function buildAttachmentsBlock(
  list:
    | readonly { name?: unknown; path?: unknown; missing?: boolean }[]
    | null
    | undefined,
): string {
  const items = (Array.isArray(list) ? list : []).filter(
    (a) =>
      a && typeof a.path === "string" && a.path !== "" && a.missing !== true,
  );
  if (items.length === 0) {
    return "";
  }
  const lines = ["[Attachments]"];
  items.forEach((item, i) => {
    const hint = isImageAttachment(item.name)
      ? "（这是图片，可用 Read 查看）"
      : "";
    lines.push(`${i + 1}. ${item.path}${hint}`);
  });
  lines.push("[/Attachments]");
  return lines.join("\n");
}
