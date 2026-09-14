// 单测 — R7-A「面板内指令编辑器」宿主侧纯逻辑（PLAN-R7 §2）。
// 契约来源只有 PLAN-R7.md（黑盒，不看实现——本轮开发尚未开始，红基线即「模块不存在/未导出」）。
//
// 锁定的契约点：
//   1) scope 是**枚举**（不是路径）：global → <根>/CLAUDE.md；collection → <根>/<当前分类目录>/CLAUDE.md
//   2) single 模式下 collection 作用域禁用（PLAN §2 表格）；collection 模式下当前无合集 → 回落根 + 提示（PLAN §4）
//   3) 落点必须落在工作区根或其一阶子目录内；归一化后越界即拒并回 error
//   4) 读：不存在 → exists:false + text:""；存在 → 原文回读
//   5) 写：往返一致；>20 000 字符拒绝且不落盘
//   6) 读写异常（EACCES/ENOSPC/EISDIR）→ 返回 error，不抛
//
// 假设的导出面（开发若改名，改 import 名即可，下面每条断言对应 PLAN 的哪句话都在注释里）：
//   src/utils/instructions.ts → INSTRUCTIONS_FILE / INSTRUCTIONS_MAX_CHARS /
//     normalizeInstructionScope / resolveInstructionsPath / readInstructions / saveInstructions
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_MAX_CHARS,
  normalizeInstructionScope,
  readInstructions,
  resolveInstructionsPath,
  saveInstructions,
  type InstructionsFs,
} from "../../src/utils/instructions.ts";

const ROOT = "/ws";
const GLOBAL_PATH = `${ROOT}/${INSTRUCTIONS_FILE}`;
const COLLECTION_DIR = "科学前言";
const COLLECTION_PATH = `${ROOT}/${COLLECTION_DIR}/${INSTRUCTIONS_FILE}`;

// ---- fake fs（注入面与既有 WorkspaceFs 同形，宿主真实现走 IOUtils/PathUtils）----

interface FakeFs extends InstructionsFs {
  files: Map<string, string>;
  dirs: Set<string>;
  /** 命中该路径的 readText 抛错（EACCES/EISDIR 形态） */
  failRead: string | null;
  /** 命中该路径的 writeText 抛错（ENOSPC 形态） */
  failWrite: string | null;
  /** 写盘调用记录——反向用例靠它断言「没写盘」 */
  writes: string[];
  readError: Error;
}

function makeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>([ROOT]);
  const fs: FakeFs = {
    files,
    dirs,
    failRead: null,
    failWrite: null,
    writes: [],
    readError: new Error(`EACCES: permission denied, open '${GLOBAL_PATH}'`),
    async exists(path) {
      return dirs.has(path) || files.has(path);
    },
    async makeDir(path) {
      dirs.add(path);
    },
    async readText(path) {
      if (fs.failRead === path) throw fs.readError;
      return files.has(path) ? (files.get(path) as string) : null;
    },
    async writeText(path, text) {
      if (fs.failWrite === path) {
        throw new Error(`ENOSPC: no space left on device, write '${path}'`);
      }
      fs.writes.push(path);
      files.set(path, text);
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent) dirs.add(parent);
    },
    join: (dir, name) => `${dir}/${name}`,
  };
  return fs;
}

/** PLAN §2：scope 是枚举、不是路径 —— 越界形态一律拒绝（ok:false + 非空 error） */
function assertRefused(
  res: ReturnType<typeof resolveInstructionsPath>,
  label: string,
): void {
  assert.equal(
    res.ok,
    false,
    `${label}：应当拒绝，实际 ${JSON.stringify(res)}`,
  );
  if (!res.ok) {
    assert.equal(typeof res.error, "string", `${label}：error 必须是字符串`);
    assert.ok(res.error.length > 0, `${label}：拒绝必须带说明原文`);
  }
}

// ---- 落点解析 ----

test("R7-A 落点：global 作用域 → <根>/CLAUDE.md（single 模式）", () => {
  const res = resolveInstructionsPath({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.path, GLOBAL_PATH);
});

test("R7-A 落点：global 作用域 → <根>/CLAUDE.md（collection 模式同样落根）", () => {
  const res = resolveInstructionsPath({
    root: ROOT,
    scope: "global",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.path, GLOBAL_PATH);
});

test("R7-A 落点：collection 作用域 + 当前分类目录 → <根>/<分类目录>/CLAUDE.md", () => {
  const res = resolveInstructionsPath({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.path, COLLECTION_PATH);
    assert.ok(res.path.startsWith(`${ROOT}/`), "必须落在工作区根内");
  }
});

test("R7-A 落点：collection 模式但当前无合集 → 回落根目录并给出提示（PLAN §4）", () => {
  const res = resolveInstructionsPath({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: null,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.path, GLOBAL_PATH, "无分类可归属 → 落点是工作区根");
    assert.ok(
      typeof res.notice === "string" && res.notice.length > 0,
      "回落必须带提示（用户要知道自己编的是根指令）",
    );
  }
});

test("R7-A 落点：single 模式 + collection 作用域 → 禁用（拒绝并给说明，不给分类落点）", () => {
  // PLAN §2 表格：「仅 workspaceMode=collection 时有意义；single 模式下该作用域禁用并给出说明」
  const res = resolveInstructionsPath({
    root: ROOT,
    scope: "collection",
    mode: "single",
    collectionDir: COLLECTION_DIR,
  });
  assertRefused(res, "single 模式下的 collection 作用域");
});

test("R7-A 落点：根带尾分隔符 → 不产生双分隔符", () => {
  const g = resolveInstructionsPath({
    root: `${ROOT}/`,
    scope: "global",
    mode: "single",
    collectionDir: null,
  });
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.path, GLOBAL_PATH);

  const c = resolveInstructionsPath({
    root: `${ROOT}/`,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
  });
  assert.equal(c.ok, true);
  if (c.ok) assert.equal(c.path, COLLECTION_PATH);
});

// ---- 越界（scope 是枚举，越界只可能来自脏值 / 分类目录形态）----

test("R7-A 越界：scope 非枚举值 → 一律拒绝（normalize 回 null）", () => {
  // PLAN §2：「作用域（枚举，不是路径——UI 永不传路径，防穿越）」
  for (const bad of [
    "../..",
    "/etc",
    "global/../..",
    "",
    "GLOBAL",
    "collection ",
    123,
    null,
    undefined,
    {},
  ]) {
    assert.equal(
      normalizeInstructionScope(bad),
      null,
      `脏值不应通过枚举白名单：${JSON.stringify(bad)}`,
    );
  }
  assert.equal(normalizeInstructionScope("global"), "global");
  assert.equal(normalizeInstructionScope("collection"), "collection");
});

test("R7-A 越界：分类目录含逃逸形态（..、绝对路径、二级路径、盘符、~）→ 拒绝", () => {
  for (const dir of [
    "..",
    "../evil",
    "/etc",
    "科学/../..",
    "a/b",
    "C:\\Windows",
    "~/.ssh",
  ]) {
    const res = resolveInstructionsPath({
      root: ROOT,
      scope: "collection",
      mode: "collection",
      collectionDir: dir,
    });
    assertRefused(res, `分类目录 ${dir}`);
  }
});

// ---- 读 ----

test("R7-A 读：文件不存在 → exists:false、text 为空串（path 照给，UI 好显落点）", async () => {
  const fs = makeFs();
  const res = await readInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    fs,
  });
  assert.equal(res.exists, false);
  assert.equal(res.text, "");
  assert.equal(res.path, GLOBAL_PATH);
  assert.equal(res.scope, "global");
  assert.equal(res.error ?? "", "", "正常缺文件不是错误");
});

test("R7-A 读：文件存在 → 原文回读（多行/中文/emoji 一字不差）", async () => {
  const body = "# 规则\n\n- 中文要点 📚\n- second line\n";
  const fs = makeFs({ [COLLECTION_PATH]: body });
  const res = await readInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
    fs,
  });
  assert.equal(res.exists, true);
  assert.equal(res.text, body);
  assert.equal(res.path, COLLECTION_PATH);
});

test("R7-A 读：读取失败（EACCES）→ 返回 error 且 text 为空串，不抛", async () => {
  const fs = makeFs();
  fs.failRead = GLOBAL_PATH; // 文件存在但读不动（权限/TCC 形态）
  fs.files.set(GLOBAL_PATH, "旧内容");
  fs.readError = new Error("EACCES: permission denied, open '/ws/CLAUDE.md'");
  const res = await readInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    fs,
  });
  assert.ok(
    res.error && res.error.includes("EACCES"),
    `错误原文要带出来：${res.error}`,
  );
  assert.equal(res.text, "");
  assert.equal(res.exists, false, "读不到就当没有——UI 不能显示半截状态");
});

test("R7-A 读：目标路径是目录（EISDIR）→ 返回 error，不抛", async () => {
  const fs = makeFs();
  fs.failRead = GLOBAL_PATH;
  fs.readError = new Error(`EISDIR: illegal operation on a directory, read`);
  const res = await readInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    fs,
  });
  assert.ok(res.error && res.error.length > 0, "同名目录形态要回可判定的错误");
  assert.equal(res.text, "");
});

test("R7-A 读：越界形态 → 不读盘、回 error（path 为 null）", async () => {
  const fs = makeFs();
  const res = await readInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: "..",
    fs,
  });
  assert.equal(res.exists, false);
  assert.equal(res.text, "");
  assert.ok(res.path === null || res.path === undefined, "越界不给可用路径");
  assert.ok(res.error && res.error.length > 0);
});

// ---- 写 ----

test("R7-A 写：保存后读回一致（多行 + 中文 + emoji 往返）", async () => {
  const fs = makeFs();
  const text = "# 项目指令\n\n- 用中文回答 📚\n- 结论先行\n";
  const saved = await saveInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
    text,
    fs,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.path, COLLECTION_PATH);
  assert.equal(fs.files.get(COLLECTION_PATH), text);

  const back = await readInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
    fs,
  });
  assert.equal(back.exists, true);
  assert.equal(back.text, text, "往返必须逐字一致");
});

test("R7-A 写：覆盖既有内容（不追加、不留旧行）", async () => {
  const fs = makeFs({ [GLOBAL_PATH]: "# 旧\n旧内容\n" });
  const res = await saveInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    text: "# 新\n",
    fs,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.files.get(GLOBAL_PATH), "# 新\n");
  assert.ok(!(fs.files.get(GLOBAL_PATH) as string).includes("旧内容"));
});

test("R7-A 写：父目录不存在 → 建目录后落盘（分类目录首用时）", async () => {
  const fs = makeFs();
  fs.dirs.delete(ROOT);
  const res = await saveInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: COLLECTION_DIR,
    text: "x",
    fs,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.files.get(COLLECTION_PATH), "x");
  assert.ok(
    fs.dirs.has(`${ROOT}/${COLLECTION_DIR}`),
    "父目录要落出来（否则下一轮 spawn 的 cwd 不存在）",
  );
});

test("R7-A 写：恰好 20000 字符 → 允许（上限内边界）", async () => {
  const fs = makeFs();
  const text = "字".repeat(INSTRUCTIONS_MAX_CHARS);
  const res = await saveInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    text,
    fs,
  });
  assert.equal(
    INSTRUCTIONS_MAX_CHARS,
    20000,
    "上限口径 20 000 字符（PLAN §2）",
  );
  assert.equal(res.ok, true);
  assert.equal(
    (fs.files.get(GLOBAL_PATH) as string).length,
    INSTRUCTIONS_MAX_CHARS,
  );
});

test("R7-A 写：20001 字符 → 拒绝且**不落盘**（防手滑粘贴整篇论文）", async () => {
  const fs = makeFs();
  const res = await saveInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    text: "字".repeat(INSTRUCTIONS_MAX_CHARS + 1),
    fs,
  });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0, "拒绝要带提示原文");
  assert.deepEqual(fs.writes, [], "超限不得写盘");
  assert.equal(fs.files.has(GLOBAL_PATH), false);
});

test("R7-A 写：空文本 → 允许（0 ≤ 上限，用于清空指令）", async () => {
  // PLAN 只写了上限，没写下限；空文本按 0 字符处理（保存 = 清空）。
  const fs = makeFs({ [GLOBAL_PATH]: "旧" });
  const res = await saveInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    text: "",
    fs,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.files.get(GLOBAL_PATH), "");
});

test("R7-A 写：写盘失败（ENOSPC）→ ok:false + error 原文，不抛", async () => {
  const fs = makeFs();
  fs.failWrite = GLOBAL_PATH;
  const res = await saveInstructions({
    root: ROOT,
    scope: "global",
    mode: "single",
    collectionDir: null,
    text: "x",
    fs,
  });
  assert.equal(res.ok, false);
  assert.ok(
    res.error && res.error.includes("ENOSPC"),
    `错误原文要带出来：${res.error}`,
  );
});

test("R7-A 写：越界形态（分类目录 ..）→ 拒绝且不写盘", async () => {
  const fs = makeFs();
  const res = await saveInstructions({
    root: ROOT,
    scope: "collection",
    mode: "collection",
    collectionDir: "..",
    text: "越界内容",
    fs,
  });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0);
  assert.deepEqual(fs.writes, [], "越界不得写盘");
});

test("R7-A 写：single 模式下的 collection 保存 → 拒绝且不写盘（与读同口径）", async () => {
  const fs = makeFs();
  const res = await saveInstructions({
    root: ROOT,
    scope: "collection",
    mode: "single",
    collectionDir: COLLECTION_DIR,
    text: "x",
    fs,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(fs.writes, []);
});
