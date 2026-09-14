// 黑盒静态纪律锁 — R17e「路径拼接的注入：调用点 + 注入源」双门
//
// 契约来源：.devflow/INTERFACE-R17.md §1.5（路径注入面）与 .devflow/BRIEF-R17b.md §2 根因 #1/#1b。
// 背景：Windows 上 Gecko 无法解析含 "/" 的路径（NS_ERROR_FILE_UNRECOGNIZED_PATH），修法是
//   ① 每个把路径交给文件系统的调用点，显式带上宿主注入的拼接函数（join / deps.fs.join）；
//   ② 宿主接线处（src/modules/sections.ts）构造的注入对象字面量必须真的带 join 成员。
// 既有门 tests/unit/r17b-p6-callsites.test.ts 只看了 ① 的 5 个函数、且只看实参文本里有没有
// 「join」这个词——注入源 ② 无人看守：把宿主接线处的 join 删掉，既有用例仍全绿，而 Windows
// 上写项目级 CLAUDE.md 的报错会原样复发。本文件补的就是这个盲区。
//
// 判据（文本级，不看实现逻辑）：
//   - 调用点：src/**/*.ts 里调用 12 个「产出/落点路径」函数时，实参必须能追到注入的 join
//     （或平台拼接 platform）。追不到 = 命中缺省拼法 = fail。
//   - 注入源：sections.ts 里构造给这几个模块的 fs/注入对象字面量必须含 join 键，
//     清单是本文件的显式常量 INJECTION_SOURCES —— 删掉任何一处注入都会变红。
//   - 反向锁：12 个目标全量普查，确认「缺省拼法」在 src/ 内零命中。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

/** 尾参 = join 的一族（缺省 = 今天的 "/" 拼法） */
const POSITIONAL_TARGETS = [
  "snapshotDir",
  "snapshotPath",
  "backupPath",
  "journalPath",
] as const;

/** 注入对象族：join 从 input / deps 里读（input.join / deps.fs.join） */
const CARRIER_TARGETS = [
  "resolveInstructionsPath",
  "readSnapshotIndex",
  "snapshotTurn",
  "rewindToTurn",
  "attachmentDirPath",
  "saveAttachments",
  "scanCommands",
  "scanSkills",
] as const;

/** 契约 §1.5 点名的 12 个函数（清单自洽用；改两族必须同时改这里） */
const ALL_TARGETS = [
  "snapshotDir",
  "snapshotPath",
  "backupPath",
  "journalPath",
  "resolveInstructionsPath",
  "attachmentDirPath",
  "saveAttachments",
  "scanCommands",
  "scanSkills",
  "readSnapshotIndex",
  "snapshotTurn",
  "rewindToTurn",
] as const;

/**
 * 注入源清单（显式常量）：对象名 + 必须出现的键 + 为什么它必须带 join。
 * 每一条对应一个 test —— 删掉哪一处注入，就红哪一条，失败信息直接报对象名。
 */
const INJECTION_SOURCES = [
  {
    name: "rewindFs",
    key: "join",
    why: "rewind 五个路径函数 + 读侧 readSnapshotIndex/snapshotTurn 内部走 deps.fs.join",
  },
  {
    name: "instructionsFs",
    key: "join",
    why: "resolveInstructionsPath 的 `join: input.join ?? input.fs.join` 透传面（用户报障的那条路）",
  },
  {
    name: "commandsFs",
    key: "join",
    why: "scanCommands/scanSkills 的 deps.fs.join（Windows 上命令面板/技能清单恒不可用）",
  },
  {
    name: "attachmentsFs",
    key: "join",
    why: "附件落点的 fs.join",
  },
  {
    name: "workspaceFs",
    key: "join",
    why: "collectionWorkspace 的 fs.join（工作区索引落点，同族缺陷）",
  },
] as const;

const SRC_DIR = path.resolve(process.cwd(), "src");
const SECTIONS_REL = "src/modules/sections.ts";

/** 去注释（保留换行，行号才对得上）；字符串里出现函数名的概率极低，不做词法分析 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

interface Source {
  /** 仓库相对路径（失败信息用） */
  rel: string;
  /** 去注释后的文本 */
  text: string;
}

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

function readSources(): Source[] {
  return tsFiles(SRC_DIR).map((file) => {
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    return { rel, text: stripComments(readFileSync(file, "utf8")) };
  });
}

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

/** 去掉数组/字符串的 `.join("…")`，只留「注入的 join」语义 */
const stripArrayJoin = (text: string): string =>
  text.replace(/\.join\(\s*["'`][\s\S]*?["'`]\s*\)/g, "");

interface Definition {
  text: string;
  kind: "function" | "expr";
}

/** 同文件内找 `const X = …` / `function X(…) {…}` 的定义文本（找不到 → null） */
function definitionOf(file: string, name: string): Definition | null {
  const fn = new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`,
  ).exec(file);
  if (fn) {
    const open = file.indexOf("(", fn.index);
    if (open >= 0) {
      const params = argsFrom(file, open);
      const braceStart = file.indexOf("{", open + params.length);
      if (braceStart >= 0) {
        let depth = 0;
        for (let i = braceStart; i < file.length; i++) {
          if (file[i] === "{") {
            depth++;
          } else if (file[i] === "}") {
            depth--;
            if (depth === 0) {
              return { text: file.slice(fn.index, i + 1), kind: "function" };
            }
          }
        }
      }
    }
    return null;
  }
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).exec(file);
  if (decl) {
    const eq = file.indexOf("=", decl.index);
    if (eq < 0) {
      return null;
    }
    const start = eq + 1;
    const exprStart =
      start + (file.slice(start).length - file.slice(start).trimStart().length);
    if (file.slice(start).trimStart().startsWith("{")) {
      let depth = 0;
      for (let i = exprStart; i < file.length; i++) {
        if (file[i] === "{") {
          depth++;
        } else if (file[i] === "}") {
          depth--;
          if (depth === 0) {
            return { text: file.slice(exprStart, i + 1), kind: "expr" };
          }
        }
      }
    }
    // 非字面量初始化：读到本行末或 `;`
    const tail = file.slice(exprStart);
    const stop = tail.search(/;\s*\n|\n/);
    const text = stop >= 0 ? tail.slice(0, stop) : tail.slice(0, 200);
    return { text, kind: "expr" };
  }
  return null;
}

/** 顶层（不在括号/花括号内）的实参片段 */
function topLevelChunks(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 从 `start` 起读一个平衡的值表达式（`{…}`/`[…]`/`(…)` 或到顶层 `,`/`}`/换行为止） */
function readValue(text: string, start: number): string {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const close = pairs[text[i]];
  if (close) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === text[i]) {
        depth++;
      } else if (text[j] === close) {
        depth--;
        if (depth === 0) {
          return text.slice(i, j + 1);
        }
      }
    }
    return text.slice(i);
  }
  let j = i;
  let depth = 0;
  for (; j < text.length; j++) {
    const ch = text[j];
    if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      if (depth === 0) {
        break;
      }
      depth--;
    } else if ((ch === "," || ch === "\n") && depth === 0) {
      break;
    }
  }
  return text.slice(i, j).trim();
}

/**
 * 实参里 `fs: <值>` 的值（对象字面量的 fs 成员；含 `{ fs, … }` 简写）。
 * 值按平衡括号读整段 —— 内联字面量 `{ fs: { … } }` 才能整块被看到，而不是截成空串。
 */
function fsMemberValues(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bfs\s*:\s*/g)) {
    const value = readValue(text, (m.index as number) + m[0].length);
    if (value) {
      out.push(value);
    }
  }
  for (const m of text.matchAll(/(?:^|[{,])\s*fs\s*(?=[,}])/g)) {
    out.push("fs");
  }
  return out;
}

type Verdict = "join" | "missing" | "delegated";

const MAX_DEPTH = 3;

/** 对象字面量：看它的 fs 成员；既无 join 也无 fs = 明确缺省 */
function literalVerdict(t: string, file: string, depth: number): Verdict {
  const vals = fsMemberValues(t);
  if (vals.length === 0) {
    return "missing";
  }
  return combine(vals.map((val) => resolveValue(val, file, depth + 1)));
}

/**
 * 一个「值表达式」是否带注入的 join：
 * - 文本里出现 join / platform → join；
 * - 对象字面量 → 看 fs 成员（内联又不带 join = missing）；
 * - 标识符 → 在本文件里找定义：函数体只认它构造/返回的 fs 对象（**不**把函数体里
 *   出现的其它 PathUtils.join 当证据）；本文件外定义（宿主接线）→ delegated，交给注入源门。
 */
function resolveValue(v: string, file: string, depth = 0): Verdict {
  if (depth > MAX_DEPTH) {
    return "delegated";
  }
  const t = stripArrayJoin(v.trim());
  if (/\bjoin\b/.test(t) || /\bplatform\b/.test(t)) {
    return "join";
  }
  if (t.startsWith("{")) {
    return literalVerdict(t, file, depth);
  }
  const root = /^[A-Za-z_$][\w$]*/.exec(t)?.[0];
  if (!root) {
    return "delegated";
  }
  const def = definitionOf(file, root);
  if (!def) {
    return "delegated"; // 文件外定义：宿主接线，由注入源门看守
  }
  if (def.kind === "function") {
    return literalVerdict(def.text, file, depth);
  }
  return resolveValue(def.text, file, depth + 1);
}

function combine(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("join")) {
    return "join";
  }
  if (verdicts.includes("missing")) {
    return "missing";
  }
  return "delegated";
}

/**
 * 一次调用是否带注入的 join（实参整体判定）。
 * 先看字面量 join/platform，再看 `fs:` 成员，最后看裸标识符：本文件里读它的 `.join`/`.fs.join`
 * （例如 `attachmentDirPath(input)`，input 由 saveAttachments 透传，模块内读 input.join）。
 */
function carriesJoin(args: string, file: string): Verdict {
  if (/\bjoin\b/.test(args) || /\bplatform\b/.test(args)) {
    return "join";
  }
  const fsVals = fsMemberValues(args);
  if (fsVals.length > 0) {
    return combine(fsVals.map((v) => resolveValue(v, file)));
  }
  const evidence: Verdict[] = [];
  for (const chunk of topLevelChunks(args)) {
    if (/^[A-Za-z_$][\w$]*$/.test(chunk)) {
      if (new RegExp(`\\b${chunk}\\.(?:fs\\.)?join\\b`).test(file)) {
        evidence.push("join"); // 本文件里读它的 .join（如 attachmentDirPath(input) 的 input）
        continue;
      }
      const def = definitionOf(file, chunk);
      if (def) {
        evidence.push(resolveValue(def.text, file));
      }
      continue;
    }
    if (chunk.startsWith("{")) {
      // 注入对象字面量：只有它带 fs 成员时才算证据（input 字面量本身不携带 join）
      const vals = fsMemberValues(chunk);
      if (vals.length > 0) {
        evidence.push(combine(vals.map((v) => resolveValue(v, file))));
      }
    }
  }
  if (evidence.includes("join")) {
    return "join";
  }
  if (evidence.includes("missing")) {
    return "missing";
  }
  return evidence.includes("delegated") ? "delegated" : "missing";
}

/**
 * 尾参族专用：join 是**最后一个实参**，必须能追到注入的 join —— 追不到（含追到文件外
 * 的变量）一律算缺省拼法。理由：join 是函数引用（rewindFs.join / deps.fs.join / 形参 join），
 * 在任何合法调用里都能在本文件内看见 `.join`；看不见就是没传。
 */
function lastArgCarriesJoin(args: string, file: string): Verdict {
  const chunks = topLevelChunks(args);
  const last = chunks[chunks.length - 1] ?? "";
  if (/\bjoin\b/.test(last) || /\bplatform\b/.test(last)) {
    return "join";
  }
  const verdict = resolveValue(last, file);
  return verdict === "join" ? "join" : "missing";
}

interface Site {
  rel: string;
  line: number;
  name: string;
  args: string;
  verdict: Verdict;
}

/** 按函数所属族选判据：尾参族看最后一个实参，注入对象族看 join 载体 */
function verdictFor(name: string, args: string, file: string): Verdict {
  return (POSITIONAL_TARGETS as readonly string[]).includes(name)
    ? lastArgCarriesJoin(args, file)
    : carriesJoin(args, file);
}

function callSites(sources: Source[], names: readonly string[]): Site[] {
  const out: Site[] = [];
  const re = new RegExp(`\\b(${names.join("|")})\\s*\\(`, "g");
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(re)) {
      const index = m.index as number;
      const before = text.slice(Math.max(0, index - 30), index);
      if (/\b(?:async\s+)?function\s+$/.test(before) || /\.\s*$/.test(before)) {
        continue; // 函数声明 / 方法调用（不是本门的调用点）
      }
      const args = argsFrom(text, index + m[0].length - 1);
      out.push({
        rel,
        line: lineAt(text, index),
        name: m[1],
        args: args.trim().replace(/\s+/g, " "),
        verdict: verdictFor(m[1], args, text),
      });
    }
  }
  return out;
}

const describe = (s: Site): string =>
  `${s.rel}:${s.line} ${s.name}(${s.args.slice(0, 70)})`;

const offenders = (sites: Site[]): string[] =>
  sites.filter((s) => s.verdict === "missing").map(describe);

// ---- 调用点覆盖面 ----

test("T-R17e-01 目标清单自洽：两族合起来恰好是契约的 12 个函数，不重不漏", () => {
  const inFamilies = [...POSITIONAL_TARGETS, ...CARRIER_TARGETS];
  assert.deepEqual(
    [...inFamilies].sort(),
    [...ALL_TARGETS].sort(),
    "分族清单与 ALL_TARGETS 必须一致（新增/改名一个目标函数时两处同时改）",
  );
});

test("T-R17e-02 非空转：12 个目标函数在 src/ 内都有被审调用点（防正则失效后的假绿）", () => {
  const sites = callSites(readSources(), ALL_TARGETS);
  const seen = new Map<string, number>();
  for (const s of sites) {
    seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  }
  const missing = ALL_TARGETS.filter((name) => !seen.has(name));
  assert.deepEqual(
    missing,
    [],
    `这些目标函数在 src/ 内一个调用点都没扫到（改名了？扫描规则失效了？）：${missing.join(", ")}`,
  );
});

test("T-R17e-03 尾参族：snapshotDir/snapshotPath/backupPath/journalPath 每个调用点都带注入 join", () => {
  const sites = callSites(readSources(), POSITIONAL_TARGETS);
  assert.deepEqual(
    offenders(sites),
    [],
    '这些调用点用了缺省拼法（win32 上会拼出含 "/" 的路径 → NS_ERROR_FILE_UNRECOGNIZED_PATH）：给它们传注入的 join',
  );
});

test("T-R17e-04 注入对象族：8 个函数的每个调用点都带 join 载体（input.join / deps.fs.join）", () => {
  const sites = callSites(readSources(), CARRIER_TARGETS);
  assert.deepEqual(
    offenders(sites),
    [],
    "这些调用点的实参既没有 join 也没有带 join 的注入对象（缺省 = 按分隔符猜 → Windows 上写不进）：把注入面接上",
  );
});

// ---- 注入源覆盖面（本门的新增价值）----

for (const { name, key, why } of INJECTION_SOURCES) {
  test(`T-R17e-05 注入源：sections.ts 的 ${name} 字面量含 ${key} 键 —— ${why}`, () => {
    const source = readSources().find((s) => s.rel === SECTIONS_REL) ?? null;
    assert.ok(source, `找不到 ${SECTIONS_REL}（工作目录不对？）`);
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).exec(
      source.text,
    );
    assert.ok(
      decl,
      `${SECTIONS_REL} 里找不到注入对象 ${name}（被重命名/搬走了？先更新本门的清单）`,
    );
    const literal = definitionOf(source.text, name);
    assert.ok(
      literal && literal.text.trim().startsWith("{"),
      `${SECTIONS_REL} 的 ${name} 不是对象字面量（拿到的是 ${String(literal?.text).slice(0, 40)}）`,
    );
    const hasKey = new RegExp(
      `[{,]\\s*(?:${key}\\b|["']${key}["'])\\s*[,:(}]`,
    ).test(literal.text);
    assert.ok(
      hasKey,
      `${SECTIONS_REL}:${lineAt(source.text, decl.index as number)} 的注入对象 ${name} 缺 ${key} 键——` +
        `这是一条真实的 Windows 缺陷：${why}（注入源没了，调用点上的 join 也无从谈起）`,
    );
  });
}

// ---- 可达性反向锁 ----

test("T-R17e-06 反向锁：缺省拼法在 src/ 内零命中（可达者只有测试与既有调用方）", () => {
  const sources = readSources();
  const sites = callSites(sources, ALL_TARGETS);
  assert.deepEqual(
    offenders(sites),
    [],
    "src/ 内出现了走缺省拼法的调用点（缺省值只留给测试与老调用方）：见下方清单",
  );
});
