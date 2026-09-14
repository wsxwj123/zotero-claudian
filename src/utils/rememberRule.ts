// rememberRule.ts — §4.6 permissionResponse「记住」规则串生成（INTERFACE.md，确定性算法）
// 纯函数。仅 allow=true 且 remember=true 时由宿主调用，结果追加进 session.allowedTools。
// 规则串里绝不带参数内容（路径类前缀无泛化价值且泄露文件路径）。

import type { PermissionMode } from "../modules/cliRunner";

/** acceptEdits 档已默认放行、不追加规则串的文件编辑类工具 */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * R17 P9：记住规则的安全字符集（INTERFACE-R17 §5.2，写死）。
 * 为什么要校验：规则串存进 allowedTools 后**每一轮**都作为 CLI 启动参数传入；Windows npm
 * `.cmd` 通道经 cmd.exe 派发，cmd.exe 不认 `\"` 转义 ⇒ 首词/工具名里的 `"&…&"` 会落到引号外
 * 被当命令分隔符执行（每轮一次、且发生在 CLI 权限系统之前）。首词来自模型的工具调用，
 * 可被 PDF 里的提示词注入影响；工具名可由恶意 MCP server 宣告 ⇒ 两者都不可信。
 * `*` 不在字符集里：`Bash(* *)` 等于放行所有命令。长度上限 128 顺手防「超长规则让该会话
 * 此后每轮都 CMD_LINE_TOO_LONG」。
 * ponytail：Windows 形态首词（`.\x.ps1`、`C:\x.exe`）本轮不放行（CLI 匹配器对 `\`、`:` 的语义
 * 未实测）→ 只是「这次放行、不记住，下次再问」；放宽前先实测匹配器（PLAN §7-21）。
 */
const SAFE_FIRST_WORD = /^[A-Za-z0-9._/-]{1,128}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const BASH_RULE = /^Bash\((.*) \*\)$/;

/**
 * 规则串是否可以记住 / 可以进启动参数（**唯一判定源**：生成器与 spawn 前过滤共用，
 * 不许写第二份）。`Bash(<首词> *)` 校验首词；其余一律按整名校验（含 `Bash`、`Read`、
 * `mcp__<server>__<tool>`）；非字符串不通过。
 */
export function isSafeRememberRule(rule: unknown): rule is string {
  if (typeof rule !== "string") {
    return false;
  }
  const m = BASH_RULE.exec(rule);
  return m ? SAFE_FIRST_WORD.test(m[1]) : SAFE_TOOL_NAME.test(rule);
}

/**
 * 生成 remember 规则串；返回 null = 不追加。
 * - Bash → `Bash(<command 首个词> *)`；command 非字符串/空白 → 记整名 `Bash`；
 * - Edit/Write/NotebookEdit → acceptEdits 档不追加（null）；default/plan 档记整名；
 * - MCP 工具（mcp__<server>__<tool>）→ 整名；
 * - 其余工具 → 整名，不记参数前缀。
 * R17 P9：以上算出的规则串**必须过 isSafeRememberRule**，不过就返回 null（这次放行、不记住）
 * ——**绝不退化成整名 `Bash`**（那等于放行所有 Bash 命令）。
 * 规则串最终语法以 §4.8 实测为准（PLAN §4.8 实测项），不符则回改本算法。
 * R5：`bypass`（放任）档下 CLI 不会发权限请求 → 本函数不会被调用，分支不必特判。
 */
export function buildRememberRule(
  tool: string,
  input: unknown,
  mode: PermissionMode,
): string | null {
  const rule = candidateRule(tool, input, mode);
  return rule !== null && isSafeRememberRule(rule) ? rule : null;
}

/** 规则串的原始算法（未过安全判定；只被 buildRememberRule 调用） */
function candidateRule(
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
    // 空/非字符串 command 记整名 Bash：锁定行为（remember-rule.test.mjs:27-41），
    // 与 P9 原则冲突，交用户裁决（PLAN §7-20），本轮不动
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
