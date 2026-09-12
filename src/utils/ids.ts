// ids.ts — 会话 id 判据的**唯一来源**（sessionStore 与 cliRunner 共用）。
// 为什么要独立成模块：sessionStore 已经 import 了 cliRunner（PERMISSION_MODES），
// 若 cliRunner 反过来 import sessionStore 就会成环 —— 判据放这里，两边都引它。
//
// 信任边界：会话 id 会被**拼进文件路径**（history/<id>.jsonl、snapshots/<id>/）**且拼进 argv**
// （`--resume <id>`）。所以它必须同时满足：①不含路径分隔符/上跳 ②不以 `-` 开头（否则会被
// 当成 CLI 选项，即 argv flag smuggling）③长度有界。三处（读写会话存储、argv 构造）共用本判据。

/** ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ —— 首字符字母数字（挡住 `--foo` 形态），总长 ≤ 64 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeSessionId(id: unknown): boolean {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}
