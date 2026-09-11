// 单测 — R7 平台兼容审查（.devflow/WIN-COMPAT-R7.md）两条必修的锁定用例。
// 独立文件（既有 r7-attachments / r6-workspace-mode 一条不改）：
//   必修-2：Windows 保留名判据漏上标形态（COM¹.png / lpt³.md）→ 抽共享 isWindowsReservedName，
//           attachments（附件名净化）与 collectionWorkspace（合集目录名净化）两处都换成它；
//           `com0`/`lpt0` 不在保留表里，**必须继续放行**（别顺手扩成 [0-9]）。
//   顺带：单条落盘失败只拒那一条（原先 copyFile 抛错会穿出循环 → 整批报「保存失败」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isWindowsReservedName, joinPath } from "../../src/utils/paths.ts";
import {
  ATTACHMENT_DIR_NAME,
  sanitizeAttachmentName,
  saveAttachments,
} from "../../src/utils/attachments.ts";
import { sanitizeCollectionDirName } from "../../src/utils/collectionWorkspace.ts";

const CWD = "/ws/科学前言";
const SID = "sess-wcompat";
const TURN = 1;
const DIR = `${CWD}/${ATTACHMENT_DIR_NAME}/${SID}/${TURN}`;

/** 内存 fs（AttachmentsFs 同形）：源文件不在 store 里 → copyFile 抛（模拟 IOUtils.copy 失败） */
function fakeFs(files: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(files));
  return {
    store,
    async exists(path: string) {
      return store.has(path);
    },
    async makeDir() {
      /* 内存实现：目录是路径前缀，无需真建 */
    },
    async copyFile(from: string, to: string) {
      if (!store.has(from)) {
        throw new Error(`NS_ERROR_FILE_NOT_FOUND: ${from}`);
      }
      store.set(to, store.get(from) as string);
    },
    async listNames(dir: string) {
      const names: string[] = [];
      for (const key of store.keys()) {
        if (!key.startsWith(`${dir}/`)) continue;
        const rest = key.slice(dir.length + 1);
        if (!rest.includes("/")) names.push(rest);
      }
      return names;
    },
    join(dir: string, name: string) {
      return `${dir}/${name}`;
    },
  };
}

// ---- 共享判据本身 ----

test("R7-WCOMPAT 保留名：ASCII 全表（含带扩展名/大小写混排）命中", () => {
  for (const name of [
    "CON",
    "con",
    "Con.txt",
    "CON.txt",
    "PRN.txt",
    "AUX",
    "NUL.png",
    "nul.md",
    "COM1",
    "com9.png",
    "LPT1",
    "lpt9.PNG",
    "AUX.tar.gz", // 只看第一个点之前的段（Windows 的解析口径）——整串仍会被当设备名
    "con. ", // 尾部空白（Windows 静默吞掉）
  ]) {
    assert.equal(isWindowsReservedName(name), true, `${name} 应命中保留名`);
  }
});

test("R7-WCOMPAT 保留名：上标形态命中（MSDN 保留表里的 COM¹ COM² COM³ / LPT¹ LPT² LPT³）", () => {
  for (const name of [
    "COM¹",
    "COM²",
    "COM¹.png",
    "COM².pdf",
    "COM³",
    "LPT¹",
    "LPT².log",
    "lpt³.md",
    "CoM¹.png", // 大小写混排
    "lPt³", // 大小写混排
  ]) {
    assert.equal(isWindowsReservedName(name), true, `${name} 应命中保留名`);
  }
});

test("R7-WCOMPAT 保留名：非保留名放行（com0/lpt0 不在表里，别扩成 [0-9]）", () => {
  for (const name of [
    "com0.png",
    "lpt0.png",
    "COM0",
    "LPT0.md",
    "com10.png", // 10 也不在表里
    "CONCEPT", // 前缀相似 ≠ 保留名
    "console.log",
    "aux-1.png",
    "我的 figure.png",
    "",
  ]) {
    assert.equal(isWindowsReservedName(name), false, `${name} 不该命中保留名`);
  }
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.equal(
      isWindowsReservedName(junk),
      false,
      `非字符串输入 ${String(junk)} 应放行`,
    );
  }
});

// ---- 消费者 1：附件名净化 ----

test("R7-WCOMPAT 附件名：上标形态的保留名被加下划线（必修-2 的正例）", () => {
  for (const [raw, want] of [
    ["COM¹.png", "_COM¹.png"],
    ["COM²", "_COM²"],
    ["lpt³.md", "_lpt³.md"],
    ["CoM¹.pdf", "_CoM¹.pdf"],
  ]) {
    const out = sanitizeAttachmentName(raw);
    assert.equal(out, want);
    assert.equal(
      isWindowsReservedName(out),
      false,
      `${raw} → ${out}：净化后不该再命中保留名`,
    );
  }
});

test("R7-WCOMPAT 附件名：ASCII 形态回归（共享判据没改坏既有行为）", () => {
  for (const [raw, want] of [
    ["CON", "_CON"],
    ["con", "_con"],
    ["CON.txt", "_CON.txt"],
    ["nul.md", "_nul.md"],
    ["LPT1.log", "_LPT1.log"],
    ["com9.PNG", "_com9.PNG"],
  ]) {
    assert.equal(sanitizeAttachmentName(raw), want);
  }
});

test("R7-WCOMPAT 附件名：com0/lpt0 原样放行（现状是对的）", () => {
  for (const raw of ["com0.png", "lpt0.png", "COM0", "LPT0.md"]) {
    assert.equal(sanitizeAttachmentName(raw), raw);
  }
});

test("R7-WCOMPAT 落盘：COM¹.png 真能落（报告里的用户场景）", async () => {
  const fs = fakeFs({ "/tmp/粘贴/COM¹.png": "bytes" });
  const out = await saveAttachments(
    {
      cwd: CWD,
      sessionId: SID,
      turn: TURN,
      files: [
        { name: "COM¹.png", sizeBytes: 5, sourcePath: "/tmp/粘贴/COM¹.png" },
      ],
    },
    { fs },
  );
  assert.deepEqual(out.rejected, []);
  assert.equal(out.saved.length, 1);
  assert.equal(out.saved[0].path, `${DIR}/_COM¹.png`);
  assert.ok(fs.store.has(`${DIR}/_COM¹.png`), "净化后的名要真的落盘");
});

// ---- 消费者 2：合集目录名净化 ----

test("R7-WCOMPAT 合集目录名：上标形态的保留名同样加 -<collectionID> 后缀", () => {
  assert.equal(sanitizeCollectionDirName("COM¹", 42), "COM¹-42");
  assert.equal(sanitizeCollectionDirName("lpt³", 7), "lpt³-7");
  // 后缀必须插在**第一个点之前**（Windows 只看到第一个点为止）
  assert.equal(sanitizeCollectionDirName("COM².txt", 5), "COM²-5.txt");
  assert.equal(sanitizeCollectionDirName("LPT¹.log", 9), "LPT¹-9.log");
});

test("R7-WCOMPAT 合集目录名：com0/lpt0 与普通名不动", () => {
  assert.equal(sanitizeCollectionDirName("com0", 42), "com0");
  assert.equal(sanitizeCollectionDirName("lpt0.md", 3), "lpt0.md");
  assert.equal(sanitizeCollectionDirName("科学前言", 1), "科学前言");
});

// ---- 共享来源（防止两处再各自长出一份清单）----

test("R7-WCOMPAT 共享：两处消费者都 import 同一个 isWindowsReservedName，没有私有清单", () => {
  const src = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  for (const rel of [
    "../../src/utils/attachments.ts",
    "../../src/utils/collectionWorkspace.ts",
  ]) {
    const text = src(rel);
    assert.match(
      text,
      /import \{[^}]*\bisWindowsReservedName\b[^}]*\} from "\.\/paths"/,
      `${rel} 应从 ./paths 引入共享判据`,
    );
    // 私有清单的指纹：保留名正则（CON/PRN/AUX/NUL/COM/LPT）与上标映射表
    assert.ok(
      !/con\|prn\|aux\|nul\|com\[1-9\]\|lpt\[1-9\]/.test(text),
      `${rel} 不该再留私有保留名正则`,
    );
    assert.ok(
      !/SUPERSCRIPT_DIGITS/.test(text),
      `${rel} 不该再留私有的上标归一表`,
    );
  }
});

// ---- 单条失败不掀整批 ----

test("R7-WCOMPAT 落盘：单条 copyFile 抛错只拒那一条，其余照落（不整批报「保存失败」）", async () => {
  const fs = fakeFs({ "/tmp/粘贴/好-1.png": "a", "/tmp/粘贴/好-2.png": "c" });
  const out = await saveAttachments(
    {
      cwd: CWD,
      sessionId: SID,
      turn: TURN,
      files: [
        { name: "好-1.png", sizeBytes: 1, sourcePath: "/tmp/粘贴/好-1.png" },
        { name: "坏的.pdf", sizeBytes: 2, sourcePath: "/tmp/粘贴/不存在.pdf" },
        { name: "好-2.png", sizeBytes: 3, sourcePath: "/tmp/粘贴/好-2.png" },
      ],
    },
    { fs },
  );
  assert.deepEqual(
    out.saved.map((s) => s.name),
    ["好-1.png", "好-2.png"],
    "另外两条必须照落",
  );
  assert.ok(fs.store.has(`${DIR}/好-1.png`) && fs.store.has(`${DIR}/好-2.png`));
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].name, "坏的.pdf");
  assert.match(out.rejected[0].reason, /附件保存失败/, "拒绝原因要有人话");
});

test("R7-WCOMPAT 落盘：失败的那条不占名（后续同名文件仍用原名）", async () => {
  const fs = fakeFs({ "/tmp/粘贴/报告.pdf": "good" });
  const out = await saveAttachments(
    {
      cwd: CWD,
      sessionId: SID,
      turn: TURN,
      files: [
        { name: "报告.pdf", sizeBytes: 1, sourcePath: "/tmp/粘贴/缺失.pdf" },
        { name: "报告.pdf", sizeBytes: 1, sourcePath: "/tmp/粘贴/报告.pdf" },
      ],
    },
    { fs },
  );
  assert.equal(out.saved.length, 1);
  assert.equal(
    out.saved[0].path,
    `${DIR}/报告.pdf`,
    "没落盘的条目不该把名字挤成 -2",
  );
});

// ---- 既有工具没被这次改动带坏（joinPath 与本次共用同一个模块）----

test("R7-WCOMPAT paths.ts 仍是纯路径工具（joinPath 基本形态不回归）", () => {
  assert.equal(joinPath("win32", "C:\\Users\\me", "ws"), "C:\\Users\\me\\ws");
  assert.equal(joinPath("darwin", "/Users/me", "ws"), "/Users/me/ws");
});
