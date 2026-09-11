// rememberRule.ts — §4.6 permissionResponse「记住」规则串生成（INTERFACE.md，确定性算法）
// 纯函数。仅 allow=true 且 remember=true 时由宿主调用，结果追加进 session.allowedTools。
// 规则串里绝不带参数内容（路径类前缀无泛化价值且泄露文件路径）。

import type { PermissionMode } from "../modules/cliRunner";

/** acceptEdits 档已默认放行、不追加规则串的文件编辑类工具 */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * 生成 remember 规则串；返回 null = 不追加。
 * - Bash → `Bash(<command 首个词> *)`；command 非字符串/空白 → 记整名 `Bash`；
 * - Edit/Write/NotebookEdit → acceptEdits 档不追加（null）；default/plan 档记整名；
 * - MCP 工具（mcp__<server>__<tool>）→ 整名；
 * - 其余工具 → 整名，不记参数前缀。
 * 规则串最终语法以 §4.8 实测为准（PLAN §4.8 实测项），不符则回改本算法。
 * R5：`bypass`（放任）档下 CLI 不会发权限请求 → 本函数不会被调用，分支不必特判。
 */
export function buildRememberRule(
  tool: string,
  input: unknown,
  mode: PermissionMode,
): string | null {
  if (tool === "Bash") {
    const command = isRecord(input) ? input.command : undefined;
    if (typeof command === "string" && command.trim()) {
      const firstWord = command.trim().split(/\s+/)[0];
      return `Bash(${firstWord} *)`;
    }
    return "Bash";
  }
  if (EDIT_TOOLS.has(tool) && mode === "acceptEdits") {
    return null;
  }
  // MCP 工具与其余工具一律记整名
  return tool;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
