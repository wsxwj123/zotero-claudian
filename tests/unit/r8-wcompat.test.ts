// 单测 — R8 平台兼容审查（.devflow/WIN-COMPAT-R7.md 剩下四条建议项）的锁定用例。
// 独立文件（既有 r7-* / r8-pane-activate 一条不改）：
//   建议-5：PROJECT_DIR_MISMATCH 闸门大小写敏感（win32 盘符/路径大小写不一致 → 误拒）→
//           抽纯函数 sameProjectDir(a,b,platform)，win32 不敏感 + 分隔符等价，其余平台严格。
//   建议-3：encodeProjectDir 缺 CLI 的「转义串 >200 截断 + `-<hash>`」规则（长路径下真回滚静默不可用）
//           —— hash 规则逐字抄自 CLI 2.1.267 二进制字符串表（见下方 hashBase36 注释）。
//   建议-4：注释口径（不测行为，只在源码里锁「不许再自称逐字节」）。
//   建议-7：前端体积门 —— 粘贴的超 20MB 文件不许进 FileReader（DI 注入读取器，不碰 DOM）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROJECT_DIR_MAX_LEN,
  encodeProjectDir,
  rewindToTurn,
  sameProjectDir,
  type RewindFs,
  type SnapshotIndex,
} from "../../src/utils/rewind.ts";
import {
  attachmentChipsAdd,
  initialAttachmentChips,
  withinAttachmentSizeGate,
} from "../../src/chat/lib/attachmentChips.ts";
import { ATTACHMENT_MAX_BYTES } from "../../src/utils/attachments.ts";
import { filesToByteAttachments } from "../../src/chat/App.ts";

// ---- 建议-5：闸门比较口径 ----

test("R8-WCOMPAT sameProjectDir：win32 大小写不敏感 + `\\` 与 `/` 等价", () => {
  assert.equal(sameProjectDir("C:\\ws", "c:\\ws", "win32"), true);
  assert.equal(sameProjectDir("C:\\ws", "c:/ws", "win32"), true);
  assert.equal(sameProjectDir("C:\\a\\b", "c:/A/B", "win32"), true);
  // 真实形态：两轮各自转义出来的 slug（分隔符已被换 `-`），只有盘符大小写不同
  assert.equal(
    sameProjectDir("C--Users-me-ws", "c--Users-me-ws", "win32"),
    true,
  );
  assert.equal(
    sameProjectDir("C:\\Users\\me\\科学前言", "c:/users/ME/科学前言", "win32"),
    true,
  );
});

test("R8-WCOMPAT sameProjectDir：win32 仍能认出「不是同一个目录」", () => {
  assert.equal(sameProjectDir("C:\\ws", "C:\\ws2", "win32"), false);
  assert.equal(
    sameProjectDir("C--Users-me-ws-a", "C--Users-me-ws-b", "win32"),
    false,
  );
  assert.equal(sameProjectDir("D:\\ws", "C:\\ws", "win32"), false);
  assert.equal(sameProjectDir("", "C--ws", "win32"), false);
});

test("R8-WCOMPAT sameProjectDir：darwin/linux/未注入平台一律严格（宁可多拒）", () => {
  for (const platform of ["darwin", "linux", undefined, "", "freebsd"]) {
    assert.equal(
      sameProjectDir("/Users/me/ws", "/users/me/ws", platform),
      false,
      `${String(platform)} 不该做大小写归一`,
    );
    assert.equal(
      sameProjectDir("/Users/me/ws", "/Users/me/ws", platform),
      true,
      `${String(platform)} 相同路径必须放行`,
    );
  }
});

test("R8-WCOMPAT 闸门接线：win32 下大小写不同不再拒，darwin 下照旧拒", async () => {
  // 索引里记的是拍快照那轮的 slug（大写盘符），本次推导出小写盘符 —— Windows 用户改了设置页
  // 里工作区的写法，实际什么都没变。
  const run = async (platform?: string) => {
    const index: SnapshotIndex = {
      claudeSessionId: "claude-1",
      snapshots: [{ turn: 1, projectDir: "C--Users-me-ws" }],
    };
    const res = await rewindToTurn(
      {
        dataDir: "/d",
        sessionId: "s1",
        claudeSessionId: "claude-1",
        turn: 1,
        projectDir: "c--Users-me-ws",
        sourcePath: "/p/claude-1.jsonl",
      },
      {
        fs: memFs([
          ["/d/snapshots/s1/index.json", JSON.stringify(index)],
          ["/d/snapshots/s1/1.jsonl", "{}\n"],
          ["/p/claude-1.jsonl", "{}\n"],
        ]),
        runner: { fork: async () => ({ newClaudeSessionId: "claude-2" }) },
        ...(platform === undefined ? {} : { platform }),
      },
    );
    return res;
  };
  const win = await run("win32");
  assert.equal(win.ok, true, "win32 大小写不同不该被误判成「项目目录不一致」");
  const mac = await run("darwin");
  assert.equal(mac.ok, false);
  assert.equal(mac.ok === false && mac.reason, "PROJECT_DIR_MISMATCH");
});

// ---- 建议-3：encodeProjectDir 的截断 + 哈希 ----

test("R8-WCOMPAT encodeProjectDir：长度 ≤200 原样转义（既有行为不变）", () => {
  assert.equal(PROJECT_DIR_MAX_LEN, 200);
  assert.equal(
    encodeProjectDir("/Users/me/.scratch"),
    "-Users-me--scratch",
    "非字母数字换 `-` 的既有口径不许动",
  );
  assert.equal(encodeProjectDir("/ws/科学前言"), "-ws-----");
  assert.equal(encodeProjectDir("C:\\x\\y"), "C--x-y");
  assert.equal(encodeProjectDir("a".repeat(200)), "a".repeat(200));
  assert.equal(encodeProjectDir("C:/x/y"), encodeProjectDir("C:\\x\\y"));
});

test("R8-WCOMPAT encodeProjectDir：>200 截前 200 再接 `-<base36 哈希>`（照 CLI 的 golden）", () => {
  // golden 由 CLI 2.1.267 自己的代码算出（`yC` 原文：
  //   function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
  //   var Gq=200; function Te(e){return Math.abs(Jq(e)).toString(36)}
  //   function yC(e){let n=k(e); if(n.length<=Gq) return n; return `${n.slice(0,Gq)}-${Te(e)}`}
  //   function Jq(t){let e=0;for(let r=0;r<t.length;r++)e=(e<<5)-e+t.charCodeAt(r)|0;return e}
  // ）
  const LONG_ASCII = "a".repeat(201);
  assert.equal(
    encodeProjectDir(LONG_ASCII),
    `${"a".repeat(200)}-rkvsv5`,
    "201 个字符：截 200 + 哈希（不再是纯转义串）",
  );

  const WIN_BASE =
    "C:\\Users\\zhangsan.verylongdomainaccount\\OneDrive - 某某某科技有限责任公司某某事业部" +
    "\\Documents\\zotero-claudian-workspace\\";
  const WIN_2024 = `${WIN_BASE}${"文献综述与知识图谱".repeat(10)}（2024-2026）`;
  assert.equal(WIN_2024.length, 205, "用例本身要真的越线（>200）");
  assert.equal(
    encodeProjectDir(WIN_2024),
    "C--Users-zhangsan-verylongdomainaccount-OneDrive--------------------" +
      "Documents-zotero-claudian-workspace--------------------------------" +
      "------------------------------------------------------------" +
      "2024--5gdp8f",
  );
});

test("R8-WCOMPAT encodeProjectDir：超长后仍稳定、且同前缀不同尾部不撞（区分度）", () => {
  const WIN_BASE =
    "C:\\Users\\zhangsan.verylongdomainaccount\\OneDrive - 某某某科技有限责任公司某某事业部" +
    "\\Documents\\zotero-claudian-workspace\\";
  const win = (yearOrTail: string) =>
    `${WIN_BASE}${"文献综述与知识图谱".repeat(10)}${yearOrTail}`;
  const a = encodeProjectDir(win("（2024-2026）"));
  const a2 = encodeProjectDir(win("（2024-2026）"));
  const b = encodeProjectDir(win("（2025-2026）"));
  const c = encodeProjectDir(win("（2024-2026）x"));
  assert.equal(a, a2, "同一输入必须稳定（哈希不能带随机/时间）");
  assert.notEqual(a, b, "只差 5 个字符的不同 cwd 必须给出不同目录名");
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  for (const out of [a, b, c]) {
    assert.ok(out.length > PROJECT_DIR_MAX_LEN, "超长输入不能退回原样");
    assert.match(
      out,
      /^[A-Za-z0-9-]+-[0-9a-z]{1,7}$/,
      "形态：<前 200 字符>-<base36 哈希>",
    );
  }
});

test("R8-WCOMPAT encodeProjectDir：哈希按 UTF-16 码元算（代理对占两格）", () => {
  // CLI 用 charCodeAt，emoji 按 2 个码元参与哈希；这里只锁「不炸 + 稳定 + 形态对」
  const withEmoji = `/${"notes/".repeat(40)}🧪📚/`;
  assert.ok(withEmoji.length > PROJECT_DIR_MAX_LEN);
  const out = encodeProjectDir(withEmoji);
  assert.equal(out, encodeProjectDir(withEmoji));
  assert.equal(
    out.slice(0, 200),
    withEmoji.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200),
  );
  assert.match(out, /^[A-Za-z0-9-]+-[0-9a-z]{1,7}$/);
});

// ---- 建议-4：口径注释（不测行为，只防「注释又跑回说自己逐字节」）----

test("R8-WCOMPAT 快照口径：源码里不许再自称「逐字节」而不提 BOM 被吞", () => {
  const rewindSrc = readFileSync(
    fileURLToPath(new URL("../../src/utils/rewind.ts", import.meta.url)),
    "utf8",
  );
  assert.match(rewindSrc, /BOM/, "rewind.ts 必须写明 BOM 会被吞掉");
  assert.ok(
    !/原文件逐字节/.test(rewindSrc),
    "「原文件逐字节」这句要么删掉要么补上 BOM 口径",
  );
});

// ---- 建议-7：前端体积门 ----

test("R8-WCOMPAT 体积门：超 20MB 的文件不进读取器（不读字节）", async () => {
  const read: string[] = [];
  const reader = async (file: { name: string }) => {
    read.push(file.name);
    return "QkFTRTY0";
  };
  const files = [
    { name: "小图.png", size: 12 * 1024, type: "image/png" },
    { name: "巨图.png", size: ATTACHMENT_MAX_BYTES + 1, type: "image/png" },
  ];
  const out = await filesToByteAttachments(files as never, reader as never);
  assert.deepEqual(read, ["小图.png"], "超限文件连读取器都不该调");
  assert.equal(
    out.length,
    2,
    "两条都要进 chips 流程（超限的那条由 chipsAdd 出提示）",
  );
  assert.equal(out[0].base64, "QkFTRTY0");
  assert.equal(out[1].base64, undefined, "超限的那条不带字节");

  const chips = attachmentChipsAdd(initialAttachmentChips(), out);
  assert.deepEqual(
    chips.items.map((x) => x.name),
    ["小图.png"],
  );
  assert.match(String(chips.notice), /20MB/, "用户必须看到人话原因");
});

test("R8-WCOMPAT 体积门：正好 20MB 放行、非数字放行（与宿主同口径）", async () => {
  assert.equal(withinAttachmentSizeGate(ATTACHMENT_MAX_BYTES), true);
  assert.equal(withinAttachmentSizeGate(ATTACHMENT_MAX_BYTES + 1), false);
  assert.equal(withinAttachmentSizeGate(0), true);
  for (const junk of [undefined, null, "123", NaN, Infinity, {}]) {
    assert.equal(
      withinAttachmentSizeGate(junk),
      true,
      `${String(junk)} 应放行`,
    );
  }
  const read: string[] = [];
  const out = await filesToByteAttachments(
    [
      { name: "正好.png", size: ATTACHMENT_MAX_BYTES },
      { name: "超一字节.png", size: ATTACHMENT_MAX_BYTES + 1 },
    ] as never,
    (async (f: { name: string }) => {
      read.push(f.name);
      return "QQ==";
    }) as never,
  );
  assert.deepEqual(read, ["正好.png"]);
  assert.equal(out[0].base64, "QQ==");
  assert.equal(out[1].base64, undefined);
});

// ---- 测试脚手架：内存 RewindFs（够 rewindToTurn 走完编排，不做真实 IO）----

function memFs(files: Array<[string, string]>): RewindFs {
  const find = (path: string) => files.find(([p]) => p === path);
  return {
    async readText(path) {
      const hit = find(path);
      return hit ? hit[1] : null;
    },
    async writeText(path, data) {
      const hit = find(path);
      if (hit) {
        hit[1] = data;
      } else {
        files.push([path, data]);
      }
    },
    async listNames() {
      return [];
    },
    async makeDir() {
      /* 内存实现：目录是路径前缀，无需真建 */
    },
    async remove(path) {
      const i = files.findIndex(([p]) => p === path);
      if (i >= 0) {
        files.splice(i, 1);
      }
    },
    async exists(path) {
      return files.some(([p]) => p === path);
    },
    join: (...seg) => seg.join("/"),
  };
}
