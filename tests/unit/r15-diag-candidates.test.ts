// R15 黑盒单测 —— /diag 的 `cli.candidates` 行（F9）。
//
// 先说清楚这批测试测不到什么（REVIEW-R15 重要-3 的口径，如实降级、不造假实现）：
//   · 候选行的**字符串拼装与预算裁剪**（INTERFACE §4：最多 5 条、超预算先丢候选、
//     尾巴保留「共 N 条，省略 M」、整值 ≤ DIAG_VALUE_MAX=300 字）实现面是
//     src/modules/sections.ts 里**未导出**的私有函数，纯逻辑层没有调用缝；
//   · 它同时又依赖宿主采集（nsIFile 真值），伪造注入面等于把测试写成实现的影子。
//   → 该行的最终格式与截断行为归**真机验证**（在 Zotero 里跑 /diag 目视核对）：
//     ① 长路径多候选时，行尾的「共 N 条」不许被 300 字截断吞掉（尾巴先留）；
//     ② 展示条数随路径长度自适应变少，不是固定 5 条；
//     ③ 每条带来源标识与体积门标记（不过门者可见）；
//     ④ 行里不出现环境变量值 / 凭据。
//
// 能测且值得测的是它的**数据地基**：候选列必须是完整的（含不过体积门者）、按解析序。
// 行里能写出「共 N 条」的前提就是这个列表没被提前砍掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanClaudeCandidates,
  pickClaudeCandidate,
} from "../../src/modules/cliDetect.ts";

/** 8 个超长形态的 PATH 目录（真实 Windows 里常见的长路径） */
const DIRS = Array.from(
  { length: 8 },
  (_, i) =>
    `C:\\Program Files\\Very Long Vendor Directory Name\\nodejs-global-stack-${i}\\bin`,
);
const EXES = DIRS.map((d) => `${d}\\claude.exe`);
const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
// 第 2/4/6 份体积不足（模拟 0 字节 / 半截安装），其余过门
const TOO_SMALL = new Set([2, 4, 6]);

test("r15 diag: 8 条长路径候选全量保留在列（不过门者不消失），顺序 = PATH 序", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: DIRS,
    exists: existsIn(...EXES),
    fileSize: (p) => (TOO_SMALL.has(EXES.indexOf(p)) ? 1024 : 6 * 1024 * 1024),
  });
  assert.equal(
    scan.candidates.length,
    8,
    "候选列必须完整，行里才数得出「共 8 条」",
  );
  assert.deepEqual(
    scan.candidates.map((c) => c.path),
    EXES,
  );
  assert.deepEqual(
    scan.candidates.map((c) => c.sizeOk),
    EXES.map((_, i) => !TOO_SMALL.has(i)),
  );
  // 不过门者仍在列里（带 sizeOk=false 供诊断标注），且仍能选出过门的那份
  assert.equal(scan.candidates[2].sizeOk, false);
  assert.equal(pickClaudeCandidate(scan)?.path, EXES[0]);
});

test("r15 diag: 候选的 via 是短标识（可塞进 300 字的诊断行）", () => {
  const scan = scanClaudeCandidates({
    platform: "win32",
    pathDirs: [DIRS[0]],
    exists: existsIn(EXES[0]),
  });
  const via = scan.candidates[0].via;
  assert.ok(
    via.length > 0 && via.length <= 24,
    `via 过长：${JSON.stringify(via)}`,
  );
  assert.ok(!via.includes("\n"), "诊断行是单行，via 不得含换行");
});
