// R15 黑盒单测 —— winRegistry 纯解析（splitRegPathList / dedupeWinDirsCaseInsensitive /
// readWinLivePathDirs 的非 win32 分支）。契约来源：INTERFACE-R15 §2.2。
// 真读注册表（HKCU/HKLM 真值）归真机验证——本文件只测可在任何平台跑的纯逻辑面。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitRegPathList,
  dedupeWinDirsCaseInsensitive,
  readWinLivePathDirs,
} from "../../src/modules/winRegistry.ts";

test("r15 reg: 去引号 + 去空段 + 只留绝对路径（相对段丢弃）", () => {
  assert.deepEqual(
    splitRegPathList(
      'C:\\bin;"C:\\Program Files\\nodejs";;relative\\dir;C:\\Tools;',
    ),
    ["C:\\bin", "C:\\Program Files\\nodejs", "C:\\Tools"],
  );
});

test("r15 reg: UNC 路径（\\\\server\\share\\…）算绝对路径，保留", () => {
  assert.deepEqual(splitRegPathList("\\\\srv\\share\\bin"), [
    "\\\\srv\\share\\bin",
  ]);
});

test("r15 reg: POSIX 路径 / 路径分隔符不符 → 丢弃（reg 的 PATH 是 Windows 语法）", () => {
  assert.deepEqual(splitRegPathList("/usr/bin;/opt/x"), []);
});

test("r15 reg: 空串 / 全空段 → 空列（不抛）", () => {
  assert.deepEqual(splitRegPathList(""), []);
  assert.deepEqual(splitRegPathList(";;;"), []);
});

test("r15 reg: 大小写不敏感去重，保留首现原样大小写", () => {
  assert.deepEqual(
    dedupeWinDirsCaseInsensitive([
      "C:\\Bin",
      "c:\\bin",
      "C:\\Tools",
      "C:\\Bin",
    ]),
    ["C:\\Bin", "C:\\Tools"],
  );
});

test("r15 reg: 去重不改变顺序（列表为空 → 空列）", () => {
  assert.deepEqual(dedupeWinDirsCaseInsensitive([]), []);
  assert.deepEqual(dedupeWinDirsCaseInsensitive(["D:\\a", "C:\\b"]), [
    "D:\\a",
    "C:\\b",
  ]);
});

test("r15 reg: readWinLivePathDirs(false) 非 win32 → []（不抛）", () => {
  assert.deepEqual(readWinLivePathDirs(false), []);
});
