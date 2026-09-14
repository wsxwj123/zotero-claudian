// R15 黑盒单测 —— npm 全局 prefix 纯函数（parseNpmrcPrefix / resolveNpmPrefixDirs）。
// 契约来源：INTERFACE-R15 §2.1。错误契约：不抛；拿不到 → ""。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNpmrcPrefix,
  resolveNpmPrefixDirs,
} from "../../src/modules/npmPrefix.ts";

test("r15 npmrc: 基本形态 prefix=C:\\npm-global → 原样取值", () => {
  assert.equal(parseNpmrcPrefix("prefix=D:\\npm-global"), "D:\\npm-global");
});

test("r15 npmrc: 等号两侧空白容忍", () => {
  assert.equal(parseNpmrcPrefix("  prefix =  C:\\npm  "), "C:\\npm");
});

// 注：只测双引号。单引号在 npm 自己的 ini 解析里也不是引号（会被当成路径字符），
// 故「prefix='D:\npm'」丢弃属正确口径——契约「值可带引号」按 npm 语义解读。
test("r15 npmrc: 双引号包裹的值去引号（含空格路径）", () => {
  assert.equal(
    parseNpmrcPrefix('prefix="C:\\Program Files\\npm"'),
    "C:\\Program Files\\npm",
  );
});

test("r15 npmrc: 单引号不算引号（与 npm ini 语义一致）→ 丢弃为空串", () => {
  assert.equal(parseNpmrcPrefix("prefix='D:\\npm'"), "");
});

test("r15 npmrc: # 与 ; 注释行、空行被跳过（注释里的 prefix 不算数）", () => {
  assert.equal(parseNpmrcPrefix("# prefix=C:\\bad"), "");
  assert.equal(parseNpmrcPrefix("; prefix=D:\\bad\n"), "");
  assert.equal(parseNpmrcPrefix("\n\n   \nprefix=C:\\good\n"), "C:\\good");
});

test("r15 npmrc: 后者覆盖前者（同一文件重复 key 取最后一次）", () => {
  assert.equal(
    parseNpmrcPrefix("prefix=C:\\first\nprefix=D:\\second"),
    "D:\\second",
  );
});

test("r15 npmrc: key 大小写不敏感", () => {
  assert.equal(parseNpmrcPrefix("PREFIX=D:\\npm"), "D:\\npm");
  assert.equal(parseNpmrcPrefix("Prefix = D:\\npm"), "D:\\npm");
});

test("r15 npmrc: 相对路径 / ~ / POSIX 路径 → 丢弃（返回空串）", () => {
  assert.equal(parseNpmrcPrefix("prefix=npm-global"), "");
  assert.equal(parseNpmrcPrefix("prefix=.\\npm"), "");
  assert.equal(parseNpmrcPrefix("prefix=~/npm"), "");
  assert.equal(parseNpmrcPrefix("prefix=/usr/local"), "");
});

test("r15 npmrc: UNC 路径保留；空文本 → 空串（不抛）", () => {
  assert.equal(
    parseNpmrcPrefix("prefix=\\\\srv\\share\\npm"),
    "\\\\srv\\share\\npm",
  );
  assert.equal(parseNpmrcPrefix(""), "");
});

test("r15 prefix: 三来源按序合并 = env → npmrc → appData\\npm", () => {
  assert.deepEqual(
    resolveNpmPrefixDirs({
      envPrefix: "C:\\EnvPrefix",
      npmrcText: "prefix=D:\\npm-global",
      appData: "C:\\Users\\x\\AppData\\Roaming",
    }),
    ["C:\\EnvPrefix", "D:\\npm-global", "C:\\Users\\x\\AppData\\Roaming\\npm"],
  );
});

test("r15 prefix: 大小写不敏感去重（保留首现原样大小写）", () => {
  assert.deepEqual(
    resolveNpmPrefixDirs({
      envPrefix: "D:\\NPM",
      npmrcText: "prefix=d:\\npm",
      appData: "",
    }),
    ["D:\\NPM"],
  );
});

test("r15 prefix: 无 env / 无 npmrc → 只剩默认 appData\\npm", () => {
  assert.deepEqual(resolveNpmPrefixDirs({ appData: "C:\\a" }), ["C:\\a\\npm"]);
});

test("r15 prefix: 空串项被剔除（appData 缺省 → 空列）", () => {
  assert.deepEqual(resolveNpmPrefixDirs({}), []);
  assert.deepEqual(resolveNpmPrefixDirs({ appData: "" }), []);
  assert.deepEqual(
    resolveNpmPrefixDirs({ envPrefix: "", npmrcText: "", appData: "" }),
    [],
  );
});
