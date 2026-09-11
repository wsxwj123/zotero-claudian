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

const WORKSPACE_DIR_NAME = "zotero-claudian-workspace";

export interface WorkspacePathInput {
  home: string;
  /** Documents 实际落点（宿主经系统 API 注入，兼容 OneDrive 重定向，PLAN §2.10 D） */
  documentsDir?: string | null;
}

/**
 * workspacePath 默认值（INTERFACE §4.4）：
 * darwin：<home>/Documents/zotero-claudian-workspace（~ 已展开形态）；
 * win32：<documentsDir>\zotero-claudian-workspace（documentsDir 优先，不回落 USERPROFILE）。
 */
export function defaultWorkspacePath(
  platform: Platform,
  input: WorkspacePathInput,
): string {
  const documents = input.documentsDir
    ? input.documentsDir
    : joinPath(platform, input.home, "Documents");
  return joinPath(platform, documents, WORKSPACE_DIR_NAME);
}
