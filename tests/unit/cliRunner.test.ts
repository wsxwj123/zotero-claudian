// 单测 — cliRunner.ts：buildSpawnArgs 信任边界校验 + classifyProcError 边界
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttachmentDenySettings,
  buildSpawnArgs,
  classifyProcError,
  PERMISSION_MODES,
} from "../../src/modules/cliRunner.ts";

const BASE = {
  permissionMode: "acceptEdits" as const,
  mcpPort: 52100,
  mcpToken: "tok",
};

test("buildSpawnArgs: 非法 permissionMode 抛错（信任边界，不静默纠正）", () => {
  for (const bad of [
    "bypassPermissions",
    "auto",
    "",
    "ACCEPDEDITS",
    42,
    null,
    undefined,
  ]) {
    assert.throws(
      () => buildSpawnArgs({ ...BASE, permissionMode: bad as never }),
      /invalid permissionMode/,
    );
  }
});

test("buildSpawnArgs: 非法 mcpPort 抛错（0/负数/超 65535/非整数）", () => {
  for (const bad of [0, -1, 65536, 1.5, NaN]) {
    assert.throws(
      () => buildSpawnArgs({ ...BASE, mcpPort: bad as number }),
      /invalid mcpPort/,
    );
  }
});

test("buildSpawnArgs: 空 token 抛错", () => {
  assert.throws(
    () => buildSpawnArgs({ ...BASE, mcpToken: "" }),
    /invalid mcpToken/,
  );
  assert.throws(
    () => buildSpawnArgs({ ...BASE, mcpToken: undefined as never }),
    /invalid mcpToken/,
  );
});

test("buildSpawnArgs: token 含 URL 特殊字符时原样嵌入（生成方负责随机安全字符集）", () => {
  const args = buildSpawnArgs({ ...BASE, mcpToken: "a-b_C1" });
  const raw = args[args.indexOf("--mcp-config") + 1];
  assert.ok(raw.includes("token=a-b_C1"));
});

test("buildSpawnArgs: resumeClaudeSessionId 空串 = 首轮，不带 --resume", () => {
  assert.ok(
    !buildSpawnArgs({ ...BASE, resumeClaudeSessionId: "" }).includes(
      "--resume",
    ),
  );
});

test("buildSpawnArgs: addDir 空串 = 不带 --add-dir", () => {
  assert.ok(!buildSpawnArgs({ ...BASE, addDir: "" }).includes("--add-dir"));
});

test("buildSpawnArgs: resume 值原样透传（不转义——argv 数组直传，转义仅在 cmd.exe 通道）", () => {
  const args = buildSpawnArgs({ ...BASE, resumeClaudeSessionId: "a b&c" });
  assert.equal(args[args.indexOf("--resume") + 1], "a b&c");
});

test("PERMISSION_MODES 恰为三档", () => {
  assert.deepEqual([...PERMISSION_MODES], ["default", "acceptEdits", "plan"]);
});

// ---- 附件目录写保护（M10：--settings deny 文件）----

test("buildSpawnArgs: settingsPath → --settings <path> 位于 --add-dir 之后、--allowedTools 之前", () => {
  const args = buildSpawnArgs({
    ...BASE,
    addDir: "/papers",
    settingsPath: "/data/deny-adddir-1.json",
    allowedTools: ["Read"],
  });
  const i = args.indexOf("--settings");
  assert.equal(args[i + 1], "/data/deny-adddir-1.json");
  assert.ok(i > args.indexOf("--add-dir"));
  assert.ok(i < args.indexOf("--allowedTools"));
});

test("buildSpawnArgs: settingsPath null/空串 → 不带 --settings（无附件目录的轮次）", () => {
  assert.ok(!buildSpawnArgs(BASE).includes("--settings"));
  assert.ok(
    !buildSpawnArgs({ ...BASE, settingsPath: null }).includes("--settings"),
  );
  assert.ok(
    !buildSpawnArgs({ ...BASE, settingsPath: "" }).includes("--settings"),
  );
});

test("buildAttachmentDenySettings: 精确 JSON —— deny 恰为 Write/Edit 两条 `//<dir>/**` 规则", () => {
  const raw = buildAttachmentDenySettings("/Users/x/Zotero/storage/ABCD1234");
  assert.deepEqual(JSON.parse(raw), {
    permissions: {
      deny: [
        "Write(//Users/x/Zotero/storage/ABCD1234/**)",
        "Edit(//Users/x/Zotero/storage/ABCD1234/**)",
      ],
    },
  });
});

test("buildAttachmentDenySettings: 尾部斜杠剔除；含空格路径原样（JSON 层转义）", () => {
  assert.deepEqual(
    JSON.parse(buildAttachmentDenySettings("/Users/x/My Docs/att/")).permissions
      .deny,
    ["Write(//Users/x/My Docs/att/**)", "Edit(//Users/x/My Docs/att/**)"],
  );
});

test("buildAttachmentDenySettings: win32 反斜杠 → `/`（gitignore 语义；真机形态待 Windows 首验）", () => {
  assert.deepEqual(
    JSON.parse(
      buildAttachmentDenySettings("C:\\Users\\x\\Zotero\\storage\\KEY"),
    ).permissions.deny,
    [
      "Write(//C:/Users/x/Zotero/storage/KEY/**)",
      "Edit(//C:/Users/x/Zotero/storage/KEY/**)",
    ],
  );
});

test("buildAttachmentDenySettings: 空/相对路径抛错（fail-closed：不生成不生效的 deny）", () => {
  for (const bad of ["", "papers/att", "/", "./x", "C:relative\\x"]) {
    assert.throws(
      () => buildAttachmentDenySettings(bad),
      /invalid addDir for deny settings/,
    );
  }
});

// ---- classifyProcError ----

test("classify: reason ENOENT 优先于 stderr 内容（即便 stderr 碰巧含关键字）", () => {
  assert.equal(
    classifyProcError({
      exitCode: null,
      stderrTail: "No conversation found",
      reason: "ENOENT",
    }),
    "CLAUDE_NOT_FOUND",
  );
});

test('BUG-27: 认得生产侧 reason（spawnTurn 产出 "CLAUDE_NOT_FOUND"）——分支不得落空', () => {
  assert.equal(
    classifyProcError({
      exitCode: null,
      stderrTail: "spawn claude ENOENT",
      reason: "CLAUDE_NOT_FOUND",
    }),
    "CLAUDE_NOT_FOUND",
  );
  // 未知 reason 串不构成 CLAUDE_NOT_FOUND（不把任意 reason 当命中）
  assert.equal(
    classifyProcError({ exitCode: 1, stderrTail: "", reason: "WHATEVER" }),
    "GENERIC",
  );
});

test("W-A11: Gecko 拒收可执行文件的原文 → CLAUDE_NOT_FOUND（win32 上引导卡不再不可达）", () => {
  // subprocess_win 的 isExecutableFile 对非绝对路径/不存在/reparse point 直接 false，
  // Subprocess.call 抛的就是这句（恒英文，与系统语言无关）
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: 'File at path "cmd.exe" does not exist, or is not executable',
    }),
    "CLAUDE_NOT_FOUND",
  );
});

test("W-A11: cmd.exe 找不到目标的原文（英文系统）→ CLAUDE_NOT_FOUND", () => {
  // cmd.exe 起得来、是它找不到 .cmd 壳或壳里的 node：走 stderr + 非 0 退出，不经 spawn 抛错
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "The system cannot find the file specified.",
    }),
    "CLAUDE_NOT_FOUND",
  );
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "The system cannot find the path specified.",
    }),
    "CLAUDE_NOT_FOUND",
  );
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail:
        "'C:\\npm\\claude.cmd' is not recognized as an internal or external command,\noperable program or batch file.",
    }),
    "CLAUDE_NOT_FOUND",
  );
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "THE SYSTEM CANNOT FIND THE FILE SPECIFIED.",
    }),
    "CLAUDE_NOT_FOUND",
    "大小写不敏感",
  );
});

test("W-A11 反例: 相近文案不误判（does not exist 单独出现 ≠ CLI 找不到）", () => {
  assert.equal(
    classifyProcError({ exitCode: 1, stderrTail: "workdir does not exist" }),
    "GENERIC",
  );
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "warning: file not found in index, skipping",
    }),
    "CLAUDE_NOT_FOUND",
    "既有 ENOENT 口径（file not found）不因本次收紧而丢",
  );
});

test("classify: 关键字大小写不敏感且只看尾部内容", () => {
  assert.equal(
    classifyProcError({ exitCode: 1, stderrTail: "NO SUCH SESSION: abc" }),
    "SESSION_GONE",
  );
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "Session Does Not Exist — id",
    }),
    "SESSION_GONE",
  );
});

test("classify: 相近但不同的报错不误判（如 conversation found 无 no）", () => {
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: "conversation found, continuing",
    }),
    "GENERIC",
  );
});

test("classify: exitCode 0 恒不判 SESSION_GONE（BUG-04 收紧：正常退出不因 stderr 残留误判）", () => {
  assert.equal(
    classifyProcError({ exitCode: 0, stderrTail: "No conversation found" }),
    "GENERIC",
  );
});

test("classify: exitCode null（异常退出）+ 关键字仍判 SESSION_GONE", () => {
  assert.equal(
    classifyProcError({ exitCode: null, stderrTail: "session not found: abc" }),
    "SESSION_GONE",
  );
});

test("classify: stderrTail undefined/null 容错", () => {
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: undefined as unknown as string,
    }),
    "GENERIC",
  );
});
