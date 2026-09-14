// 黑盒静态纪律锁 — R17b / P6「src/ 内每个调用点都必须显式带注入 join」
//
// 契约来源：.devflow/INTERFACE-R17.md §1.5 末条「src 侧纪律：缺省值是给既有测试与老调用方的 ——
// `src/` 内每个调用点都必须走注入 `join`」。
//
// 做法：读 src/**/*.ts 的**文本**（不 import、不执行），正则匹配四个路径落点函数与
// `resolveInstructionsPath` 的调用点，逐个提取实参，要求实参里出现注入的 `join`
// （或显式平台实参）。缺省分支只允许出现在测试里，src 内出现即视为回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

/** 「产出路径字符串」的函数：src 内每个调用点都必须显式交代用哪种拼接 */
const TARGETS = [
  "snapshotDir",
  "snapshotPath",
  "backupPath",
  "journalPath",
  "resolveInstructionsPath",
] as const;

/**
 * 已核对、允许不带注入 join 的调用点（键 = `<相对路径> :: <函数名>`，值 = 为什么允许）。
 * 本轮为空：INTERFACE §1.5 要求 src 内**每一处**都走注入 join。将来若出现确实不需要
 * 拼接的调用点，键写在这里并把理由写全（不许只写"已知问题"）。
 */
const VERIFIED = new Map<string, string>();

const SRC_DIR = path.resolve(process.cwd(), "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 去注释（字符串字面量里出现函数名的概率极低，不做词法分析）；换行必须保留，行号才对得上 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

const lineAt = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/** 从 `(` 起取平衡括号内的实参文本 */
function argsFrom(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  return text.slice(open + 1);
}

interface Offender {
  file: string;
  line: number;
  name: string;
  args: string;
}

function scan(text: string, file: string): Offender[] {
  const src = stripComments(text);
  const found: Offender[] = [];
  const re = new RegExp(`\\b(${TARGETS.join("|")})\\s*\\(`, "g");
  for (const m of src.matchAll(re)) {
    const index = m.index as number;
    // 跳过函数声明（`export function snapshotDir(...)`）——只查调用点
    const before = src.slice(Math.max(0, index - 20), index);
    if (/\bfunction\s+$/.test(before) || /\bfunction\s*$/.test(before)) {
      continue;
    }
    const args = argsFrom(src, index + m[0].length - 1);
    if (/\bjoin\b/.test(args) || /\bplatform\b/.test(args)) {
      continue;
    }
    const key = `${path.relative(process.cwd(), file)} :: ${m[1]}`;
    if (VERIFIED.has(key)) {
      continue;
    }
    found.push({
      file: key.split(" :: ")[0],
      line: lineAt(src, index),
      name: m[1],
      args: args.trim(),
    });
  }
  return found;
}

test("T-P6-h 🔴 src/ 内每个路径落点调用点都显式带注入 join（或平台实参）", () => {
  const offenders: Offender[] = [];
  for (const file of tsFiles(SRC_DIR)) {
    offenders.push(...scan(readFileSync(file, "utf8"), file));
  }

  assert.deepEqual(
    offenders.map(
      (o) => `${o.file}:${o.line} ${o.name}(${o.args.slice(0, 60)})`,
    ),
    [],
    "这些调用点用了缺省拼法（Windows 上会拼出混用分隔符的路径）：给它们传注入的 join",
  );
});
