// 单测 — utils/prefs.ts 纯函数（M9 设置页校验/规范化，PLAN §4.4）。
// 注意：只 import 纯函数（不触碰 Zotero 全局；prefs.ts 的存取器在调用时才碰）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolutePath, normalizePathInput } from "../../src/utils/prefs.ts";

// ---- isAbsolutePath ----

test("prefs: darwin 绝对路径判定", () => {
  assert.equal(isAbsolutePath("/Users/x/ws", "darwin"), true);
  assert.equal(isAbsolutePath("relative/path", "darwin"), false);
  assert.equal(isAbsolutePath("~/Documents", "darwin"), false); // 展开前不是绝对路径
  assert.equal(isAbsolutePath("", "darwin"), false);
  assert.equal(isAbsolutePath("/", "darwin"), true);
});

test("prefs: win32 绝对路径判定（盘符大小写 / 混合分隔符 / UNC）", () => {
  assert.equal(isAbsolutePath("C:\\Users\\x", "win32"), true);
  assert.equal(isAbsolutePath("c:/Users/x", "win32"), true);
  assert.equal(isAbsolutePath("\\\\srv\\share\\ws", "win32"), true);
  assert.equal(isAbsolutePath("C:relative", "win32"), false); // 盘符相对（无分隔符）
  assert.equal(isAbsolutePath("\\Users\\x", "win32"), false); // 根相对
  assert.equal(isAbsolutePath("Users\\x", "win32"), false);
  assert.equal(isAbsolutePath("", "win32"), false);
});

// ---- normalizePathInput ----

test("prefs: normalizePathInput 去首尾空白；纯空白 → 空串（跟随默认）", () => {
  assert.equal(normalizePathInput("  /a/b  ", "/Users/x", "darwin"), "/a/b");
  assert.equal(normalizePathInput("   ", "/Users/x", "darwin"), "");
  assert.equal(normalizePathInput("", "/Users/x", "darwin"), "");
});

test("prefs: normalizePathInput 展开 ~/（darwin）", () => {
  assert.equal(
    normalizePathInput("~/Documents/ws", "/Users/x", "darwin"),
    "/Users/x/Documents/ws",
  );
  assert.equal(normalizePathInput("~", "/Users/x", "darwin"), "~"); // 裸 ~ 不展开（提示走 isAbsolutePath）
});

test("prefs: normalizePathInput 展开 ~\\（win32，joinPath 走反斜杠）", () => {
  assert.equal(
    normalizePathInput("~\\Documents\\ws", "C:\\Users\\x", "win32"),
    "C:\\Users\\x\\Documents\\ws",
  );
  // 尾段带 `/` 时 joinPath 只规范连接处，段内分隔符原样（Windows API 两种都认）
  assert.equal(
    normalizePathInput("~/Documents/ws", "C:\\Users\\x", "win32"),
    "C:\\Users\\x\\Documents/ws",
  );
});

test("prefs: normalizePathInput 普通路径原样（不擅自改分隔符/大小写）", () => {
  assert.equal(
    normalizePathInput("C:\\Users\\X\\Docs", "C:\\Users\\x", "win32"),
    "C:\\Users\\X\\Docs",
  );
  assert.equal(normalizePathInput("/a//b/", "/Users/x", "darwin"), "/a//b/");
});
