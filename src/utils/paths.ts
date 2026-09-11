// paths.ts — 路径纯函数（PLAN §2.10 D、INTERFACE §4.4/§4.5）
// joinPath 是 PathUtils.join 的纯函数等价（宿主真实现走 PathUtils，TEST-PLAN 假设 A9）；
// 纯函数形态供 node 单测与双平台 CI 矩阵使用。

import type { Platform } from "../modules/cliDetect";

function separatorFor(platform: Platform): string {
  return platform === "win32" ? "\\" : "/";
}

/** 剥掉段尾全部分隔符（两种分隔符都剥，跨平台输入容错）；纯分隔符段返回空串 */
function stripTrailing(segment: string): string {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === "/" || segment[end - 1] === "\\")) {
    end -= 1;
  }
  return segment.slice(0, end);
}

/**
 * 路径拼接：darwin/linux 以 '/' 连接、win32 以 '\' 连接；
 * 连接处不产生双分隔符（段已带尾分隔符则剥去），绝对根保留。
 */
export function joinPath(platform: Platform, ...segments: string[]): string {
  const sep = separatorFor(platform);
  let result = "";
  for (const segment of segments) {
    if (!segment) continue;
    const body = stripTrailing(segment);
    if (!body) {
      // 纯分隔符段（如 "/"、"\"）只作为根占位，不重复叠加
      if (result === "") {
        result = sep;
      }
      continue;
    }
    if (result === "") {
      // 首段保留其绝对根形态（"/Users"、"C:\Users"）
      result = body;
    } else if (result === sep) {
      result += body;
    } else {
      result += sep + body.replace(/^[\\/]+/, "");
    }
  }
  return result;
}

/** Windows 保留设备名（DOS 设备名）：`COM1`…`COM9` 与 `LPT1`…`LPT9` **只到 9**，`com0`/`lpt0` 放行 */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 上标数字：MSDN《Naming Files, Paths, and Namespaces》的保留表里明确列了 `COM¹`…`COM³`/`LPT¹`…`LPT³` */
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "¹": "1",
  "²": "2",
  "³": "3",
};

/**
 * 是否命中 Windows 保留设备名（共用判据：附件名净化 `utils/attachments` + 合集目录名净化
 * `utils/collectionWorkspace` 都用这一个，别再各写一套）。
 * - **按第一个 `.` 之前的段判**：`CON.txt` / `nul.md` / `LPT1.log` 在 Windows 上同样是设备名；
 * - 大小写不敏感；上标形态 `COM¹`…`COM³`、`LPT¹`…`LPT³` 等同 ASCII 数字；
 * - 段内末尾空白按 Windows 的解析习惯剥掉（`CON .txt` 也是设备名）；
 * - 只认 1-9：`com0`/`lpt0` 不在保留表里（现状放行是对的，别顺手扩成 `[0-9]`）。
 */
export function isWindowsReservedName(name: unknown): boolean {
  if (typeof name !== "string") {
    return false;
  }
  const head = (name.split(".")[0] ?? "")
    .replace(/[¹²³]/g, (ch) => SUPERSCRIPT_DIGITS[ch] ?? ch)
    .trim()
    .toLowerCase();
  return RESERVED_DEVICE_RE.test(head);
}

const WORKSPACE_DIR_NAME = "zotero-claudian-workspace";

export interface WorkspacePathInput {
  home: string;
  /** Documents 实际落点（宿主经系统 API 注入，兼容 OneDrive 重定向，PLAN §2.10 D） */
  documentsDir?: string | null;
}

/**
 * workspacePath 默认值（INTERFACE §4.4）：
 * darwin：<home>/zotero-claudian-workspace（~ 已展开形态；**2026-09-11 真实实测修订**——
 *   原 <home>/Documents/… 在 macOS 触发 TCC「文稿文件夹」授权，用户拒绝后目录不可访问，
 *   CLI 以 getcwd EPERM / exit 1 失败；home 根不在 TCC 保护面内，无授权弹窗）；
 * win32：<documentsDir>\zotero-claudian-workspace（documentsDir 优先，不回落 USERPROFILE；Windows 无 TCC）。
 */
export function defaultWorkspacePath(
  platform: Platform,
  input: WorkspacePathInput,
): string {
  if (platform === "darwin") {
    return joinPath(platform, input.home, WORKSPACE_DIR_NAME);
  }
  const documents = input.documentsDir
    ? input.documentsDir
    : joinPath(platform, input.home, "Documents");
  return joinPath(platform, documents, WORKSPACE_DIR_NAME);
}
