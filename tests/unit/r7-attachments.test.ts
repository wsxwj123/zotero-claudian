// 单测 — R7-J「附件」（PLAN-R7 §3.11，黑盒：只按契约写，本轮尚未开工 → 红基线即「模块不存在/未导出」）。
//
// 锁定的契约点（含主会话裁决 2026-09-11）：
//   1) 类型：png/jpg/jpeg/webp/gif = 图片（放行 + 区块带「可用 Read 查看」提示）；
//      **可执行类型拒绝**（exe/bat/cmd/sh/ps1/app/dmg/com/scr）；其余（md/txt/zip/pdf/svg/无扩展名）
//      一律放行（J10：pdf 也允许——用户可能真想塞一篇 PDF 当附件）
//   2) 上限：单文件 ≤ 20MB（正好 20MB 放行、0 字节放行）、单条 ≤ 10 个（前 10 照落、第 11 拒）
//   3) 文件名净化：去路径分隔符 / 控制字符 / Windows 保留设备名（含大小写与带扩展名形态）、
//      超长名截断到 **120 字符**（扩展名保住）、Unicode 保留
//   4) 落点（裁决 J6）：**本轮 cwd 下** `<cwd>/attachments/<插件会话id>/<轮序号>/<净化名>`——
//      collection 模式下 cwd = `<工作区根>/<合集目录>`，所以永远在 cwd 内、不需要额外 add-dir、
//      也不削弱 deny；重名自动加序号（a.png → a-2.png，大小写视为同名）
//   5) prompt 区块 `[Attachments]` … `[/Attachments]`：绝对路径逐条列出；空列表不产区块
//   6) 编辑态增删：以**新集合**为准；**旧附件文件一个都不删**（历史消息还引用它）
//   7) 缺失文件：发送前不存在 → 标记 missing（UI 据此提示），区块里不列坏路径
//
// 假设的导出面（开发若改名，改 import 名即可）：
//   src/utils/attachments.ts →
//     ATTACHMENT_MAX_BYTES(20MB) / ATTACHMENT_MAX_PER_MESSAGE(10) / ATTACHMENT_IMAGE_EXTS /
//     ATTACHMENT_NAME_MAX(120) / ATTACHMENT_DIR_NAME("attachments") /
//     sanitizeAttachmentName(name) -> string / uniqueAttachmentName(name, takenNames) -> string /
//     attachmentDirPath({cwd, sessionId, turn}) -> string /
//     attachmentRejectReason({name, sizeBytes}) -> string|null /
//     saveAttachments({cwd, sessionId, turn, files}, {fs}) -> {saved:[{name,path,size}], rejected:[{name,reason}]} /
//     resolveEditedAttachments(original, {add, remove}) -> Attachment[] /
//     markMissingAttachments(list, {fs}) -> (Attachment & {missing:boolean})[] /
//     buildAttachmentsBlock(list) -> string
//   fs 注入面 AttachmentsFs：exists / copyFile(from,to) / makeDir / listNames / join——
//     **编排里只许用这几个动作**：旧附件文件永不删除（见第 6 条），remove 只作为反向断言的探针存在。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_DIR_NAME,
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_NAME_MAX,
  attachmentDirPath,
  attachmentRejectReason,
  buildAttachmentsBlock,
  markMissingAttachments,
  resolveEditedAttachments,
  sanitizeAttachmentName,
  saveAttachments,
  uniqueAttachmentName,
} from "../../src/utils/attachments.ts";

const CWD = "/ws/科学前言"; // 本轮 cwd（collection 模式 = <工作区根>/<合集目录>）
const ROOT = "/ws";
const SID = "sess-1";
const TURN = 3;
const DIR = `${CWD}/${ATTACHMENT_DIR_NAME}/${SID}/${TURN}`;

const MB = 1024 * 1024;

/** 内存 fs（AttachmentsFs 同形）+ 调用记录；remove 只用来做「没人调它」的反向断言 */
function fakeFs(files = {}) {
  const store = new Map(Object.entries(files));
  const calls = [];
  return {
    store,
    calls,
    async exists(p) {
      return store.has(p);
    },
    async copyFile(from, to) {
      calls.push({ op: "copyFile", from, to });
      store.set(to, store.get(from) ?? "");
    },
    async makeDir(p) {
      calls.push({ op: "makeDir", path: p });
    },
    async listNames(dir) {
      const prefix = `${dir}/`;
      const names = new Set();
      for (const key of [...store.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
    async remove(p) {
      calls.push({ op: "remove", path: p });
      store.delete(p);
    },
    join: (...seg) => seg.join("/"),
  };
}

const file = (name, sizeBytes = 1024) => ({
  name,
  sizeBytes,
  sourcePath: `/tmp/粘贴/${name}`,
});

const EXEC_EXTS = [
  "exe",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "app",
  "dmg",
  "com",
  "scr",
];

// ---- 类型：图片放行 / 可执行拒绝 / 其余放行 ----

test("R7-J 类型：图片白名单五连（png/jpg/jpeg/webp/gif）全部放行", () => {
  assert.deepEqual([...ATTACHMENT_IMAGE_EXTS].sort(), [
    "gif",
    "jpeg",
    "jpg",
    "png",
    "webp",
  ]);
  for (const name of [
    "图.png",
    "照片.jpg",
    "扫描.jpeg",
    "动图.gif",
    "表情.webp",
  ]) {
    assert.equal(attachmentRejectReason(file(name)), null, `${name} 应放行`);
  }
});

test("R7-J 类型：可执行类型一律拒绝（J10 黑名单九个扩展名）", () => {
  for (const ext of EXEC_EXTS) {
    const reason = attachmentRejectReason(file(`坏东西.${ext}`));
    assert.ok(
      typeof reason === "string" && reason.length > 0,
      `.${ext} 应拒绝，实际 ${JSON.stringify(reason)}`,
    );
  }
});

test("R7-J 类型：可执行类型大小写不敏感，伪装扩展名（.png.exe）照样拒", () => {
  for (const name of ["坏东西.EXE", "脚本.Bat", "伪装.png.exe", "双击.CMD"]) {
    const reason = attachmentRejectReason(file(name));
    assert.ok(
      typeof reason === "string" && reason.length > 0,
      `${name} 应拒绝，实际 ${JSON.stringify(reason)}`,
    );
  }
});

test("R7-J 类型：其余类型全部放行（pdf/md/txt/zip/svg/无扩展名）", () => {
  for (const name of [
    "论文.pdf",
    "笔记.md",
    "数据.txt",
    "打包.zip",
    "图标.svg",
    "没有扩展名",
  ]) {
    assert.equal(
      attachmentRejectReason(file(name)),
      null,
      `${name} 应放行（允许用户塞任意非可执行文件）`,
    );
  }
});

test("R7-J 类型：拒绝原因是人话（说得出「可执行」或那个扩展名）", () => {
  const reason = attachmentRejectReason(file("坏东西.exe"));
  assert.ok(/可执行|exe/i.test(reason), `原因要能看懂：${reason}`);
});

// ---- 体积与条数上限 ----

test("R7-J 上限：单文件 20MB —— 正好 20MB 放行，20MB+1 字节拒绝", () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 20 * MB);
  assert.equal(attachmentRejectReason(file("大图.png", 20 * MB)), null);
  const over = attachmentRejectReason(file("大图.png", 20 * MB + 1));
  assert.ok(typeof over === "string" && over.length > 0, "超限要拒绝");
  assert.ok(/20|大小|体积/.test(over), `原因要说清上限：${over}`);
});

test("R7-J 上限：0 字节文件放行（空文件由 CLI 自己报错，不在这里拦）", () => {
  assert.equal(attachmentRejectReason(file("空.png", 0)), null);
});

test("R7-J 上限：单条 10 个 —— 第 11 个拒绝、前 10 个照落", async () => {
  assert.equal(ATTACHMENT_MAX_PER_MESSAGE, 10);
  const fs = fakeFs();
  const files = Array.from({ length: 11 }, (_, i) => file(`图${i}.png`));
  for (const f of files) {
    fs.store.set(f.sourcePath, "bytes");
  }
  const out = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files },
    { fs },
  );
  assert.equal(out.saved.length, 10, "前 10 个要落盘");
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].name, "图10.png");
  assert.ok(
    /10|数量|最多/.test(out.rejected[0].reason),
    `原因要说清上限：${out.rejected[0].reason}`,
  );
});

test("R7-J 上限：一批里混着坏文件 → 只拒那一个，其余照落（不整批失败）", async () => {
  const fs = fakeFs();
  const files = [file("好.png"), file("太大.png", 21 * MB), file("也好的.pdf")];
  for (const f of files) fs.store.set(f.sourcePath, "bytes");
  const out = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files },
    { fs },
  );
  assert.deepEqual(
    out.saved.map((s) => s.name),
    ["好.png", "也好的.pdf"],
  );
  assert.deepEqual(
    out.rejected.map((r) => r.name),
    ["太大.png"],
  );
  assert.equal(fs.store.has(`${DIR}/太大.png`), false, "被拒的文件不许落盘");
});

test("R7-J 上限：坏文件一个都不发（saved 为空、rejected 有原因）", async () => {
  const fs = fakeFs();
  const out = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [file("坏东西.exe")] },
    { fs },
  );
  assert.deepEqual(out.saved, []);
  assert.deepEqual(
    fs.calls.filter((c) => c.op === "copyFile"),
    [],
  );
});

// ---- 文件名净化 ----

/** 净化后必须永远成立的性质 */
function assertSafe(name) {
  assert.equal(typeof name, "string");
  assert.ok(name.length > 0, "净化后不能是空名");
  assert.ok(
    !name.includes("/") && !name.includes("\\"),
    `不得残留路径分隔符：${name}`,
  );
  assert.ok(!name.includes(".."), `不得残留 ..：${name}`);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/.test(name), `不得残留控制字符：${name}`);
  assert.equal(name, name.trim(), "首尾不得有空白");
  assert.ok(!/[. ]$/.test(name), "Windows 下文件名不得以点或空格结尾");
}

test("R7-J 净化：路径分隔符被去掉（POSIX 形态的穿越企图）", () => {
  const out = sanitizeAttachmentName("../../etc/passwd.png");
  assertSafe(out);
  assert.ok(out.endsWith(".png"));
});

test("R7-J 净化：Windows 反斜杠与盘符被去掉", () => {
  const out = sanitizeAttachmentName("C:\\Users\\x\\我的 图.png");
  assertSafe(out);
  assert.ok(!out.includes(":"), `不得残留盘符冒号：${out}`);
  assert.ok(out.endsWith(".png"));
});

test("R7-J 净化：控制字符被去掉（含 NUL 与 DEL）", () => {
  const out = sanitizeAttachmentName("截图\u0000\u001f\u007f.png");
  assertSafe(out);
  assert.ok(out.includes("截图"));
});

test("R7-J 净化：Windows 保留设备名 —— 大小写与带扩展名形态都要处理", () => {
  const reserved = [
    "CON",
    "con",
    "Con.png",
    "PRN.txt",
    "AUX",
    "NUL.png",
    "COM1",
    "com9.png",
    "LPT1",
    "lpt9.PNG",
  ];
  for (const raw of reserved) {
    const out = sanitizeAttachmentName(raw);
    assertSafe(out);
    const base = out.split(".")[0].toLowerCase();
    assert.ok(
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base),
      `${raw} → ${out}：仍落在 Windows 保留设备名上`,
    );
  }
});

test("R7-J 净化：超长名截断到 120 字符（裁决 J7），扩展名保住", () => {
  assert.equal(ATTACHMENT_NAME_MAX, 120);
  const out = sanitizeAttachmentName(`${"超".repeat(300)}.png`);
  assert.ok(
    out.length <= ATTACHMENT_NAME_MAX,
    `净化后长度要 ≤ ${ATTACHMENT_NAME_MAX}，实际 ${out.length}`,
  );
  assert.ok(out.endsWith(".png"), "扩展名不能截掉（否则类型判断失效）");
});

test("R7-J 净化：正好 120 字符的名不动它（边界不多截）", () => {
  const name = `${"a".repeat(ATTACHMENT_NAME_MAX - 4)}.png`;
  assert.equal(name.length, ATTACHMENT_NAME_MAX);
  assert.equal(sanitizeAttachmentName(name), name);
});

test("R7-J 净化：Unicode（中文 / emoji / 空格）原样保留", () => {
  const out = sanitizeAttachmentName("实验数据 截图 📊.png");
  assert.ok(out.includes("实验数据"));
  assert.ok(out.includes("📊"), "emoji 不该被吞");
  assert.ok(out.endsWith(".png"));
});

test("R7-J 净化：全是非法字符 / 空名 → 仍给出可用的非空名", () => {
  for (const raw of ["", "   ", "...", "///", "\u0000\u0001"]) {
    const out = sanitizeAttachmentName(raw);
    assert.ok(
      typeof out === "string" && out.length > 0,
      `输入 ${JSON.stringify(raw)}`,
    );
    assert.ok(!out.includes("/") && !out.includes("\\"));
    assert.ok(!/^\.+$/.test(out), `不得只剩点：${out}`);
  }
});

test("R7-J 净化：不碰合法名（没有非法字符就原样返回）", () => {
  assert.equal(sanitizeAttachmentName("figure-1.png"), "figure-1.png");
});

// ---- 重名序号 ----

test("R7-J 重名：目录里没有同名 → 原名", () => {
  assert.equal(uniqueAttachmentName("a.png", []), "a.png");
});

test("R7-J 重名：已有 a.png → a-2.png；再撞 → a-3.png", () => {
  assert.equal(uniqueAttachmentName("a.png", ["a.png"]), "a-2.png");
  assert.equal(uniqueAttachmentName("a.png", ["a.png", "a-2.png"]), "a-3.png");
});

test("R7-J 重名：多扩展名与无扩展名都不误伤（按最后一个点切分）", () => {
  assert.equal(uniqueAttachmentName("a.tar.png", ["a.tar.png"]), "a.tar-2.png");
  assert.equal(uniqueAttachmentName("README", ["README"]), "README-2");
});

test("R7-J 重名：大小写不同视为同名（macOS/Windows 文件系统不区分，裁决 J8）", () => {
  assert.equal(uniqueAttachmentName("A.PNG", ["a.png"]), "A-2.PNG");
});

// ---- 落点（裁决 J6：本轮 cwd 下）----

test("R7-J 落点：<cwd>/attachments/<会话id>/<轮序号>", () => {
  assert.equal(ATTACHMENT_DIR_NAME, "attachments");
  assert.equal(
    attachmentDirPath({ cwd: CWD, sessionId: SID, turn: TURN }),
    DIR,
  );
});

test("R7-J 落点：collection 模式下落在本轮 cwd 内（不需要额外 add-dir、不削弱 deny）", () => {
  const cwd = `${ROOT}/科学前言`; // resolveTurnWorkspace：collection 模式 cwd = <根>/<合集目录>
  const dir = attachmentDirPath({ cwd, sessionId: SID, turn: 0 });
  assert.equal(dir, `${ROOT}/科学前言/attachments/${SID}/0`);
  assert.ok(dir.startsWith(`${cwd}/`), "落点必须在本轮 cwd 内");
  assert.ok(
    !dir.startsWith(`${ROOT}/attachments/`),
    "不许落在工作区根（那是 cwd 之外，又要 add-dir）",
  );
});

test("R7-J 落点：会话 id 非法（穿越形态）→ 拒绝，不拼出 cwd 外的路径", () => {
  for (const sessionId of ["../../etc", "..", "a/b", ""]) {
    assert.throws(
      () => attachmentDirPath({ cwd: CWD, sessionId, turn: 1 }),
      Error,
      `会话 id ${JSON.stringify(sessionId)} 必须拒绝`,
    );
  }
});

test("R7-J 落点：轮序号非非负整数 → 拒绝", () => {
  for (const turn of [-1, 1.5, NaN, "3/.."]) {
    assert.throws(
      () => attachmentDirPath({ cwd: CWD, sessionId: SID, turn }),
      Error,
      `轮序号 ${String(turn)} 必须拒绝`,
    );
  }
});

test("R7-J 落盘：复制到落点，落点目录先建（cwd 内 → 不需要额外授权）", async () => {
  const fs = fakeFs({ "/tmp/粘贴/图.png": "bytes" });
  const out = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [file("图.png")] },
    { fs },
  );
  assert.equal(out.saved.length, 1);
  assert.equal(out.saved[0].path, `${DIR}/图.png`);
  assert.equal(out.saved[0].size, 1024);
  assert.ok(fs.store.has(`${DIR}/图.png`), "文件要真的落盘");
  assert.ok(
    fs.calls.some((c) => c.op === "makeDir" && c.path === DIR),
    "落点目录要先建",
  );
});

test("R7-J 落盘：重名（同一轮连粘两次同名图）→ 自动加序号，两个都在", async () => {
  const fs = fakeFs({ "/tmp/粘贴/a.png": "first" });
  const first = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [file("a.png")] },
    { fs },
  );
  const second = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [file("a.png")] },
    { fs },
  );
  assert.equal(first.saved[0].path, `${DIR}/a.png`);
  assert.equal(second.saved[0].path, `${DIR}/a-2.png`);
  assert.ok(fs.store.has(`${DIR}/a.png`) && fs.store.has(`${DIR}/a-2.png`));
});

test("R7-J 落盘：落盘用的是**净化后**的名（原名的穿越形态不进路径）", async () => {
  const evil = "../../evil.png";
  const fs = fakeFs({ [`/tmp/粘贴/${evil}`]: "bytes" });
  const out = await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [file(evil)] },
    { fs },
  );
  const path = out.saved[0].path;
  assert.ok(path.startsWith(`${DIR}/`), `必须落在落点目录内：${path}`);
  assert.ok(!path.includes(".."), path);
  assert.equal(path.split("/").length, `${DIR}/x`.split("/").length);
});

// ---- prompt 区块 ----

const IMG = { name: "图.png", path: `${DIR}/图.png`, sizeBytes: 1024 };

test("R7-J 区块：首行 [Attachments]、尾行 [/Attachments]，绝对路径逐条列出", () => {
  const block = buildAttachmentsBlock([
    IMG,
    { name: "两.pdf", path: `${DIR}/两.pdf`, sizeBytes: 2 },
  ]);
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "[Attachments]");
  assert.equal(lines[lines.length - 1], "[/Attachments]");
  assert.ok(block.includes(`${DIR}/图.png`), "缺第一条绝对路径");
  assert.ok(block.includes(`${DIR}/两.pdf`), "缺第二条绝对路径");
  assert.ok(
    block.includes("1.") && block.includes("2."),
    "逐条编号（CLI 侧好引用）",
  );
});

test("R7-J 区块：图片条目带「可用 Read 查看」提示，非图片条目不带", () => {
  const imgOnly = buildAttachmentsBlock([IMG]);
  assert.ok(
    imgOnly.includes("这是图片，可用 Read 查看"),
    `图片要提示怎么读：\n${imgOnly}`,
  );
  const pdfOnly = buildAttachmentsBlock([
    { name: "论文.pdf", path: `${DIR}/论文.pdf`, sizeBytes: 2 },
  ]);
  assert.ok(pdfOnly.includes(`${DIR}/论文.pdf`), "pdf 要列出来");
  assert.ok(!pdfOnly.includes("可用 Read 查看"), "非图片不得套用图片提示");
});

test("R7-J 区块：空列表 → 不产出区块（trim 后为空串）", () => {
  assert.equal(buildAttachmentsBlock([]).trim(), "");
});

test("R7-J 区块：同一输入两次调用逐字一致（多条分隔稳定）", () => {
  const list = [IMG, { name: "两.pdf", path: `${DIR}/两.pdf`, sizeBytes: 2 }];
  assert.equal(buildAttachmentsBlock(list), buildAttachmentsBlock(list));
});

test("R7-J 区块：缺失文件不进区块（不静默发送坏路径）", async () => {
  const fs = fakeFs({ [`${DIR}/在.png`]: "bytes" });
  const list = [
    { name: "在.png", path: `${DIR}/在.png`, sizeBytes: 1 },
    { name: "没.png", path: `${DIR}/没.png`, sizeBytes: 1 },
  ];
  const marked = await markMissingAttachments(list, { fs });
  assert.equal(marked[0].missing, false);
  assert.equal(marked[1].missing, true, "UI 要能标红");
  const block = buildAttachmentsBlock(marked);
  assert.ok(block.includes(`${DIR}/在.png`));
  assert.ok(!block.includes(`${DIR}/没.png`), "坏路径不许进 prompt");
});

test("R7-J 区块：全部缺失 → 不产出区块（等同于没有附件）", async () => {
  const fs = fakeFs();
  const marked = await markMissingAttachments(
    [{ name: "没.png", path: `${DIR}/没.png`, sizeBytes: 1 }],
    { fs },
  );
  assert.equal(buildAttachmentsBlock(marked).trim(), "");
});

// ---- 编辑态增删 ----

const OLD = [
  { name: "a.png", path: `${DIR}/a.png`, sizeBytes: 1 },
  { name: "b.png", path: `${DIR}/b.png`, sizeBytes: 1 },
];

const NEW = { name: "c.png", path: `${DIR}/c.png`, sizeBytes: 1 };

test("R7-J 编辑：以新集合为准 —— 删掉的不在、加上的在、其余保持原序", () => {
  const out = resolveEditedAttachments(OLD, { remove: ["a.png"], add: [NEW] });
  assert.deepEqual(
    out.map((a) => a.name),
    ["b.png", "c.png"],
  );
});

test("R7-J 编辑：只删不加 → 集合变小；只加不删 → 原样加新", () => {
  assert.deepEqual(
    resolveEditedAttachments(OLD, { remove: ["b.png"] }).map((a) => a.name),
    ["a.png"],
  );
  assert.deepEqual(
    resolveEditedAttachments(OLD, { add: [NEW] }).map((a) => a.name),
    ["a.png", "b.png", "c.png"],
  );
});

test("R7-J 编辑：纯函数 —— 不改入参、无删除语义", () => {
  const snapshot = JSON.stringify(OLD);
  resolveEditedAttachments(OLD, { remove: ["a.png"], add: [NEW] });
  assert.equal(JSON.stringify(OLD), snapshot, "入参被改");
});

test("R7-J 编辑：新增附件走落盘，且**旧附件文件一个都不删**", async () => {
  const fs = fakeFs({ [`${DIR}/a.png`]: "old-a", "/tmp/粘贴/c.png": "new-c" });
  const edited = resolveEditedAttachments(OLD, {
    remove: ["a.png"],
    add: [NEW],
  });
  await saveAttachments(
    { cwd: CWD, sessionId: SID, turn: TURN, files: [NEW] },
    { fs },
  );
  assert.deepEqual(
    fs.calls.filter((c) => c.op === "remove"),
    [],
    "编辑重发不许删旧附件文件（历史消息还引用它）",
  );
  assert.equal(
    fs.store.get(`${DIR}/a.png`),
    "old-a",
    "被移出集合的旧文件仍在盘上",
  );
  assert.equal(fs.store.has(`${DIR}/c.png`), true);
  assert.deepEqual(
    edited.map((a) => a.name),
    ["b.png", "c.png"],
  );
});
