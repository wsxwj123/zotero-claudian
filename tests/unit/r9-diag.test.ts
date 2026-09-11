// 单测 — R9「/diag 诊断报告」纯逻辑（src/utils/diag.ts）。
//
// 锁定的契约点（PLAN-R9）：
//   1) 报告 = 固定首行 + 15 行 `标签: 值`（标签补空格对齐，值在固定列开始；
//      15 = 原 14 行 + R11 复查新增的 history 行——行数断言一律走 DIAG_KEYS.length）
//   2) 缺字段 → `(error: 未采集)`；采集失败（{error}）→ `(error: 原因)`，整份报告照出
//   3) 脱敏：疑似 secret 的键名（key/token/secret/…）只写 set/unset；
//      且报告**只打印白名单里的行**——输入里夹带的任何其它键（含 DeepSeek Key、
//      ANTHROPIC_* 环境值）原值一律不出现
//   4) 值单行化 + 超长截断（一行一条、不刷屏）
//   5) 平台/工作区各形态原样透传（报告层不做语义解析，形态由宿主决定）
//   6) ZOTERO_SUPPORT_RANGE 与 addon/manifest.json 逐字一致（防两处漂移）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIAG_HEADER,
  DIAG_KEYS,
  DIAG_LABEL_WIDTH,
  DIAG_VALUE_MAX,
  ZOTERO_SUPPORT_RANGE,
  buildDiagReport,
  formatDiagLine,
  redactValue,
} from "../../src/utils/diag.ts";

/** 一份「全字段正常」的输入（宿主采集成功的形态） */
function fullInput(): Record<string, unknown> {
  return {
    time: "2026-09-11T10:00:00.000Z",
    plugin: "0.1.15 (6.999~99.*)",
    zotero: "8.0.1",
    platform: "win32 / x86_64",
    cli: "command=C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd channel=cmd version=2.0.14 (Claude Code)",
    "cli.auth": "ok",
    workspace: "mode=single path=C:\\Users\\me\\ws exists=true writable=true",
    collection: "(none)",
    reader: "itemKey=ABCD1234 attachmentKey=EFGH5678 hasParent=true",
    session:
      "current=8f3a-1c2b claudeSessionId=0f8c1a2b-3d4e-5f60-7a8b-9c0d1e2f3a4b",
    sessionFile: "found=true via=quick dir=C--Users-me-ws",
    history: "files=2 lastAppended=2026-09-11T09:59:00.000Z perms=0o600",
    snapshots:
      "dir=C:\\profile\\claudian\\snapshots\\8f3a-1c2b count=3 lastTurn=2",
    journal: "pending=false",
    prefs:
      "permissionMode=default showUsage=true autoShowPane=false pinnedSessions=2",
  };
}

/** 报告正文行（去首行） */
function bodyLines(text: string): string[] {
  return text.split("\n").slice(1);
}

test("R9-diag 报告：首行固定 + 每个白名单键恰好一行（标签对齐到固定列）", () => {
  const text = buildDiagReport(fullInput());
  const lines = text.split("\n");
  assert.equal(lines[0], DIAG_HEADER);
  assert.equal(lines.length, DIAG_KEYS.length + 1);
  DIAG_KEYS.forEach((key, i) => {
    const line = lines[i + 1];
    // 键名 + 冒号 + 空格填充 → 值从 DIAG_LABEL_WIDTH 列开始
    assert.ok(
      line.startsWith(`${key}:`.padEnd(DIAG_LABEL_WIDTH, " ")),
      `第 ${i + 1} 行标签未对齐：${JSON.stringify(line)}`,
    );
    assert.equal(line.slice(DIAG_LABEL_WIDTH), fullInput()[key]);
  });
});

test("R9-diag 报告：行顺序与白名单一致，且没有多余行", () => {
  const keys = bodyLines(buildDiagReport(fullInput())).map(
    (line) => line.split(":")[0],
  );
  assert.deepEqual(keys, [...DIAG_KEYS]);
  assert.deepEqual(
    [...DIAG_KEYS],
    [
      "time",
      "plugin",
      "zotero",
      "platform",
      "cli",
      "cli.auth",
      "workspace",
      "collection",
      "reader",
      "session",
      "sessionFile",
      // R11 复查新增：history 行插在 sessionFile 与 snapshots 之间（宿主采集器同步新增该项）
      "history",
      "snapshots",
      "journal",
      "prefs",
    ],
  );
});

test("R9-diag 报告：缺字段写 (error: 未采集)，采集失败写 (error: 原因)——整份报告仍产出", () => {
  const text = buildDiagReport({
    time: "2026-09-11T10:00:00.000Z",
    // plugin 缺
    cli: { error: "shell PATH 探测失败" },
  });
  const lines = bodyLines(text);
  assert.equal(lines.length, DIAG_KEYS.length, "缺字段不吞行：行数仍是白名单长度");
  assert.match(lines[1], /^plugin: +\(error: 未采集\)$/);
  assert.match(lines[4], /^cli: +\(error: shell PATH 探测失败\)$/);
  // 已有的值照常打印
  assert.match(lines[0], /^time: +2026-09-11T10:00:00\.000Z$/);
});

test("R9-diag 脱敏：输入里夹带的密钥原值一律不出现在报告里", () => {
  const DEEPSEEK = "sk-1234567890abcdef-relay";
  const TOKEN = "tok_AbCdEf-987654321";
  const ANTHROPIC = "sk-ant-api03-ZZZZZZZZZZZZZZ";
  const text = buildDiagReport({
    ...fullInput(),
    deepseekApiKey: DEEPSEEK,
    token: TOKEN,
    ANTHROPIC_AUTH_TOKEN: ANTHROPIC,
    // 白名单外的普通键同样不打印（白名单是「夹带也不会漏」的保证）
    extraPath: "C:\\Users\\me\\secret-folder",
  });
  for (const secret of [DEEPSEEK, TOKEN, ANTHROPIC]) {
    assert.ok(!text.includes(secret), `报告泄漏了密钥：${secret}`);
  }
  assert.ok(!text.includes("secret-folder"));
  assert.ok(!text.includes("deepseekApiKey"));
  assert.ok(!text.includes("ANTHROPIC"));
});

test("R9-diag 脱敏：redactValue —— 疑似 secret 的键只给 set/unset，值永不输出", () => {
  assert.equal(redactValue("deepseekApiKey", "sk-real"), "set");
  assert.equal(redactValue("token", "abc"), "set");
  assert.equal(redactValue("ANTHROPIC_AUTH_TOKEN", "abc"), "set");
  assert.equal(redactValue("deepseekApiKey", ""), "unset");
  assert.equal(redactValue("token", null), "unset");
  assert.equal(redactValue("token", "   "), "unset");
  // 非 secret 键原样输出（含 cli.auth —— 它是登录态不是凭据）
  assert.equal(redactValue("cli.auth", "ok"), "ok");
  assert.equal(
    redactValue("time", "2026-09-11T10:00:00.000Z"),
    "2026-09-11T10:00:00.000Z",
  );
  assert.equal(
    redactValue("workspace", "mode=single path=/w exists=true writable=false"),
    "mode=single path=/w exists=true writable=false",
  );
  // cli.auth 不被 secret 规则误伤（裸 auth 不算凭据词）
  assert.match(bodyLines(buildDiagReport(fullInput()))[5], /^cli\.auth: +ok$/);
});

test("R9-diag 报告：超长值截断（保留前缀 + 省略号），多行值压成一行", () => {
  const long = "x".repeat(DIAG_VALUE_MAX * 3);
  const text = buildDiagReport({ ...fullInput(), cli: long });
  const line = bodyLines(text)[4];
  assert.equal(line.length, DIAG_LABEL_WIDTH + DIAG_VALUE_MAX + 1);
  assert.ok(line.endsWith("…"));
  assert.ok(line.startsWith("cli:"));
  // 截断后仍是单行报告
  assert.equal(text.split("\n").length, DIAG_KEYS.length + 1);

  const multiline = buildDiagReport({
    ...fullInput(),
    workspace: "mode=single\npath=/w\r\nexists=true",
  });
  assert.equal(multiline.split("\n").length, DIAG_KEYS.length + 1);
  assert.match(
    bodyLines(multiline)[6],
    /^workspace: +mode=single path=\/w exists=true$/,
  );
});

test("R9-diag 报告：值与形态原样透传（win32/darwin、single/collection 各一例）", () => {
  // win32 + cmd 通道 + 未登录
  const win = buildDiagReport({
    ...fullInput(),
    platform: "win32 / x86_64",
    cli: "command=C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd channel=cmd version=timeout",
    "cli.auth": "not-logged-in",
    workspace: "mode=collection path=D:\\ws exists=true writable=false",
    collection: "机器学习-classic",
  });
  const winLines = bodyLines(win);
  assert.match(winLines[3], /^platform: +win32 \/ x86_64$/);
  assert.match(winLines[4], /channel=cmd version=timeout$/);
  assert.match(winLines[5], /^cli\.auth: +not-logged-in$/);
  assert.match(
    winLines[6],
    /^workspace: +mode=collection path=D:\\ws exists=true writable=false$/,
  );
  assert.match(winLines[7], /^collection: +机器学习-classic$/);

  // darwin（sh 包装通道）+ single 模式 + 工作区不存在
  const mac = buildDiagReport({
    ...fullInput(),
    platform: "darwin / arm64",
    cli: "command=/opt/homebrew/bin/claude channel=sh version=2.0.14 (Claude Code)",
    workspace: "mode=single path=/Users/me/ws exists=false writable=false",
    collection: "(none)",
  });
  const macLines = bodyLines(mac);
  assert.match(macLines[3], /^platform: +darwin \/ arm64$/);
  assert.match(
    macLines[4],
    /^cli: +command=\/opt\/homebrew\/bin\/claude channel=sh version=2\.0\.14 \(Claude Code\)$/,
  );
  assert.match(macLines[6], /exists=false writable=false$/);
  assert.match(macLines[7], /^collection: +\(none\)$/);
});

test("R9-diag 报告：session/sessionFile/snapshots/journal 的空态写 (none)/false，不写假值", () => {
  const lines = bodyLines(
    buildDiagReport({
      ...fullInput(),
      cli: "command=未找到 channel=none version=none",
      reader: "itemKey=(none) attachmentKey=(none) hasParent=false",
      session: "current=(none) claudeSessionId=(none)",
      sessionFile: "found=false via=none dir=(none)",
      snapshots: "dir=(none) count=0 lastTurn=none",
      journal: "pending=false",
    }),
  );
  assert.match(lines[4], /^cli: +command=未找到 channel=none version=none$/);
  assert.match(
    lines[8],
    /^reader: +itemKey=\(none\) attachmentKey=\(none\) hasParent=false$/,
  );
  assert.match(
    lines[9],
    /^session: +current=\(none\) claudeSessionId=\(none\)$/,
  );
  assert.match(lines[10], /^sessionFile: +found=false via=none dir=\(none\)$/);
  assert.match(lines[12], /^snapshots: +dir=\(none\) count=0 lastTurn=none$/);
});

test("R9-diag 报告：formatDiagLine 是唯一行格式入口（同一输入 → 同一行）", () => {
  assert.equal(
    formatDiagLine("time", "2026-09-11T10:00:00.000Z"),
    `time:${" ".repeat(DIAG_LABEL_WIDTH - "time:".length)}2026-09-11T10:00:00.000Z`,
  );
  assert.equal(
    formatDiagLine("zotero", null),
    `zotero:${" ".repeat(DIAG_LABEL_WIDTH - "zotero:".length)}(error: 未采集)`,
  );
});

test("R9-diag 常量：ZOTERO_SUPPORT_RANGE 与 addon/manifest.json 逐字一致", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../addon/manifest.json", import.meta.url), "utf8"),
  ) as {
    applications: {
      zotero: { strict_min_version: string; strict_max_version: string };
    };
  };
  const z = manifest.applications.zotero;
  assert.equal(
    ZOTERO_SUPPORT_RANGE,
    `${z.strict_min_version}~${z.strict_max_version}`,
  );
});
