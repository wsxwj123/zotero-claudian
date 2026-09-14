// 单测 — cliDetect.ts：命令发现边界 + spawn env 组装 + win32 引号化逐例
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveClaudeCommand,
  buildSpawnEnv,
  buildWin32PathPlan,
  buildWin32CmdInvocation,
  resolveCmdExePath,
  quoteWinArg,
  CMD_LINE_LIMIT,
  CLAUDE_INSTALL_URL,
  parseClaudeVersion,
  parseAuthStatus,
  evaluateCliStatus,
  buildCliInvocation,
  DARWIN_FD_RAISE_SCRIPT,
} from "../../src/modules/cliDetect.ts";
import { buildSpawnArgs } from "../../src/modules/cliRunner.ts";

const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
const WIN_NPM = "C:\\Users\\x\\AppData\\Roaming\\npm";
const WIN_CMD_SHELL = WIN_NPM + "\\claude.cmd";
// 真实 npm 布局：package.json 的 bin 字段 = bin/claude.exe（W-A13 坐实）
const WIN_PKG_EXE =
  WIN_NPM + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const WIN_CMD_EXE = "C:\\Windows\\System32\\cmd.exe";

// ---- resolveClaudeCommand 边界 ----

test("detect: darwin override 为空串 = 自动解析（§4.4 空串语义）", () => {
  const r = resolveClaudeCommand({
    platform: "darwin",
    pathDirs: ["/usr/bin"],
    override: "",
    exists: existsIn("/usr/bin/claude"),
  });
  assert.equal(r.status, "found");
  assert.equal((r as { source: string }).source, "path");
});

test("detect: darwin override 非空但不存在 → 回落 PATH（回落结果带 source）", () => {
  const r = resolveClaudeCommand({
    platform: "darwin",
    pathDirs: ["/usr/bin"],
    override: "/gone/claude",
    exists: existsIn("/usr/bin/claude"),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: "/usr/bin/claude",
    source: "path",
  });
});

test("detect: darwin PATH 内多目录，前目录有目录无文件 → 顺序敏感性", () => {
  const r = resolveClaudeCommand({
    platform: "darwin",
    pathDirs: ["/a", "/b"],
    exists: (p) => p === "/b/claude",
  });
  assert.equal((r as { path: string }).path, "/b/claude");
});

test("detect: win32 override 指向 .cmd 且包内 exe 存在 → 解析到包内 exe（source=override）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: WIN_PKG_EXE,
    source: "override",
  });
});

test("detect: win32 override 指向 .cmd、包内 exe 缺失 → cmd 通道 + override 源", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [],
    override: WIN_CMD_SHELL,
    exists: existsIn(WIN_CMD_SHELL),
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "cmd",
    path: WIN_CMD_SHELL,
    source: "override",
  });
});

test("detect: win32 包内 exe <5MB（注入 fileSize）→ 判残缺，落 cmd 通道", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
    fileSize: () => 1024,
  });
  assert.equal((r as { channel: string }).channel, "cmd");
});

test("detect: win32 包内 exe ≥5MB → direct（fileSize 注入时不放行残缺文件）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: [WIN_NPM],
    exists: existsIn(WIN_CMD_SHELL, WIN_PKG_EXE),
    fileSize: () => 5 * 1024 * 1024,
  });
  assert.deepEqual(r, {
    status: "found",
    channel: "direct",
    path: WIN_PKG_EXE,
    source: "path",
  });
});

test("detect: win32 PATH 目录只含 claude（无扩展名）不命中（仅 .exe/.cmd 两形态）", () => {
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: ["C:\\bin"],
    exists: existsIn("C:\\bin\\claude"),
  });
  assert.deepEqual(r, { status: "not_found", error: "CLAUDE_NOT_FOUND" });
});

test("detect: darwin PATH 与常驻目录全空 → not_found", () => {
  const r = resolveClaudeCommand({
    platform: "darwin",
    pathDirs: [],
    exists: () => false,
  });
  assert.deepEqual(r, { status: "not_found", error: "CLAUDE_NOT_FOUND" });
});

// ---- buildSpawnEnv 边界 ----

test("env: darwin 其余环境键透传且不污染入参对象", () => {
  const env = { HOME: "/Users/x", PATH: "/old", LANG: "zh_CN.UTF-8" };
  const out = buildSpawnEnv("darwin", { env, shellPathDirs: ["/n1"] });
  assert.equal(out.LANG, "zh_CN.UTF-8");
  assert.equal(env.PATH, "/old", "入参不可被改写");
});

test("env: win32 大小写不敏感去重（NTFS 语义），保留首现原样大小写", () => {
  const out = buildSpawnEnv("win32", {
    env: { PATH: "C:\\Bin" },
    shellPathDirs: ["c:\\bin", "C:\\Tools"],
  });
  assert.equal(out.PATH, "C:\\Bin;C:\\Tools");
});

test("env: win32 键名规范化——Path/PATH 双键合并为 PATH，SYSTEMROOT 归一为 SystemRoot（BUG-02）", () => {
  const input = {
    Path: "C:\\first",
    PATH: "C:\\bin",
    SYSTEMROOT: "C:\\W",
    HOME: "C:\\Users\\x",
  };
  const out = buildSpawnEnv("win32", { env: input, shellPathDirs: [] });
  assert.equal(out.PATH, "C:\\bin", "后值覆盖，单键输出");
  assert.equal(out.SystemRoot, "C:\\W");
  assert.equal(out.HOME, "C:\\Users\\x", "非规范键保留原形态");
  assert.ok(!("Path" in out) && !("SYSTEMROOT" in out), "不得残留大小写变体键");
  assert.deepEqual(
    Object.keys(input).sort(),
    ["HOME", "PATH", "Path", "SYSTEMROOT"],
    "入参不可被改写",
  );
});

test("env: win32 PATH 内空段剔除，TEMP 缺省兜底", () => {
  const out = buildSpawnEnv("win32", {
    env: { PATH: "C:\\a;;C:\\b" },
    shellPathDirs: [],
  });
  assert.equal(out.PATH, "C:\\a;C:\\b");
  assert.ok("SystemRoot" in out);
  assert.ok("TEMP" in out);
});

test("env: win32 无任何 PATH 输入 → PATH 为空串不抛错", () => {
  const out = buildSpawnEnv("win32", { env: {}, shellPathDirs: [] });
  assert.equal(out.PATH, "");
});

// ---- win32 PATH 组装（M10 走查：win32 不探登录 shell，进程 PATH + 常驻目录）----

test("win32 plan: 进程 PATH 为基底 + 常驻目录兜底——PATH 非空、含常驻目录、不依赖 SHELL", () => {
  const plan = buildWin32PathPlan({
    processPath: "C:\\Windows\\System32;C:\\Users\\x\\AppData\\Roaming\\npm",
    residentDirs: [
      "C:\\Users\\x\\scoop\\shims",
      "C:\\Users\\x\\AppData\\Roaming\\npm",
    ],
  });
  assert.deepEqual(plan.pathDirs, [
    "C:\\Windows\\System32",
    "C:\\Users\\x\\AppData\\Roaming\\npm",
  ]);
  // PATH 非空且合并序 = 进程 PATH → 常驻目录；大小写不敏感去重（npm 目录不重复出现）
  assert.deepEqual(plan.environment.PATH.split(";"), [
    "C:\\Windows\\System32",
    "C:\\Users\\x\\AppData\\Roaming\\npm",
    "C:\\Users\\x\\scoop\\shims",
  ]);
});

test("win32 plan: 进程 PATH 缺失/空串 → 常驻目录兜底仍给非空 PATH（不靠 SHELL 探测）", () => {
  const plan = buildWin32PathPlan({
    processPath: "",
    residentDirs: ["C:\\Users\\x\\scoop\\shims"],
  });
  assert.deepEqual(plan.pathDirs, []);
  assert.equal(plan.environment.PATH, "C:\\Users\\x\\scoop\\shims");
});

test("win32 plan: PATH 空段剔除；SystemRoot/TEMP 真值带上，空串不落进环境（不被兜底默认值覆盖）", () => {
  const plan = buildWin32PathPlan({
    processPath: "C:\\A;;C:\\B;",
    env: { SystemRoot: "D:\\Windows", TEMP: "" },
    residentDirs: [],
  });
  assert.deepEqual(plan.pathDirs, ["C:\\A", "C:\\B"]);
  assert.equal(plan.environment.SystemRoot, "D:\\Windows", "真值直通");
  assert.equal(plan.environment.TEMP, "C:\\WINDOWS\\Temp", "空串被剔 → 兜底");
});

test("win32 plan: pathDirs 直接喂 resolveClaudeCommand → 解析到 claude.cmd（cmd 通道）", () => {
  const plan = buildWin32PathPlan({
    processPath: WIN_NPM + ";",
    residentDirs: [],
  });
  const r = resolveClaudeCommand({
    platform: "win32",
    pathDirs: plan.pathDirs,
    exists: existsIn(WIN_CMD_SHELL),
  });
  assert.equal(r.status, "found");
  assert.equal(r.status === "found" && r.channel, "cmd");
  assert.equal(r.status === "found" && r.path, WIN_CMD_SHELL);
});

// ---- quoteWinArg / buildWin32CmdInvocation 逐例 ----

// 期望串用拼接构造，避免手写反斜杠转义本身出错
const bs = (n: number) => "\\".repeat(n);

test("quote: 尾部任意数量反斜杠 → 翻倍且单收引号（标准 CRT，BUG-01 修正口径）", () => {
  assert.equal(quoteWinArg("C:\\dir\\"), '"C:\\dir' + bs(2) + '"');
  assert.equal(quoteWinArg("C:\\dir\\\\" + "\\"), '"C:\\dir' + bs(6) + '"');
  assert.equal(quoteWinArg("C:\\dir\\\\"), '"C:\\dir' + bs(4) + '"');
});

test("quote: 中部反斜杠原样；裸引号转义；反斜杠+引号组合翻倍", () => {
  assert.equal(quoteWinArg("C:\\Users\\x"), '"C:\\Users\\x"');
  assert.equal(quoteWinArg('he said "hi"'), '"he said \\"hi\\""');
  assert.equal(quoteWinArg('a\\"b'), '"a' + bs(2) + '\\"b"');
  assert.equal(quoteWinArg("a\\"), '"a' + bs(2) + '"'); // 尾部单反斜杠
  assert.equal(quoteWinArg(""), '""');
});

test("quote: 参数收尾恰为反斜杠+引号（run 后紧跟字面引号）→ 按紧邻引号规则", () => {
  // 内容 a\"：反斜杠紧邻字面引号 → 翻倍 + \"，再收引号
  assert.equal(quoteWinArg('a\\"'), '"a' + bs(2) + '\\""');
});

test("wspawn: 形态 = 绝对 cmd.exe + ['/C', 整行]（exe 路径同样过引号化，argv 为空也成立）", () => {
  const r = buildWin32CmdInvocation("C:\\npm\\claude.cmd", [], WIN_CMD_EXE);
  assert.deepEqual(r, {
    ok: true,
    file: WIN_CMD_EXE,
    args: ["/C", '"C:\\npm\\claude.cmd"'],
  });
});

test("wspawn: cmd.exe 路径缺省 = resolveCmdExePath 兜底（不是裸名 'cmd.exe'）", () => {
  const r = buildWin32CmdInvocation("C:\\npm\\claude.cmd", ["-p"]);
  assert.ok(r.ok);
  assert.equal(r.file, "C:\\Windows\\System32\\cmd.exe");
  assert.ok(r.file.includes("\\"), "必须是绝对路径：Gecko 拒收裸名/相对路径");
});

test("cmdpath: ComSpec 优先；缺 ComSpec 用 SystemRoot；两者都缺用标准系统根", () => {
  assert.equal(
    resolveCmdExePath({ ComSpec: "D:\\os\\cmd.exe", SystemRoot: "D:\\os" }),
    "D:\\os\\cmd.exe",
  );
  assert.equal(
    resolveCmdExePath({ SystemRoot: "D:\\os" }),
    "D:\\os\\System32\\cmd.exe",
  );
  assert.equal(resolveCmdExePath({}), "C:\\Windows\\System32\\cmd.exe");
  // Services.env 在 Windows 上大小写不敏感 → 纯函数侧按名比对同样不敏感；尾部分隔符归一
  assert.equal(
    resolveCmdExePath({ COMSPEC: "C:\\Windows\\cmd.exe" }),
    "C:\\Windows\\cmd.exe",
  );
  assert.equal(
    resolveCmdExePath({ systemroot: "C:\\Windows\\" }),
    "C:\\Windows\\System32\\cmd.exe",
  );
});

test("wspawn: exe 路径含换行同样拒绝（整行任一成分的换行禁入）", () => {
  const r = buildWin32CmdInvocation("C:\\bad\npath\\claude.cmd", ["-p"]);
  assert.deepEqual(r, {
    ok: false,
    code: "SPAWN_FAILED",
    reason: "ARG_HAS_NEWLINE",
  });
});

test("wspawn: 参数含 % 拒绝（批处理变量展开，拒绝优于转义猜测，PLAN §2.10 B.3）", () => {
  const r = buildWin32CmdInvocation("C:\\npm\\claude.cmd", [
    "--add-dir",
    "C:\\100%\\dir",
  ]);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "ARG_HAS_PERCENT");
  const r2 = buildWin32CmdInvocation("C:\\100%\\claude.cmd", ["-p"]); // exe 路径同样覆盖（BUG-03）
  assert.equal(r2.ok, false);
  assert.equal((r2 as { reason: string }).reason, "ARG_HAS_PERCENT");
});

test("wspawn: 超长报错带 limit 字段；恰在边界通过", () => {
  const EXE = "C:\\npm\\claude.cmd";
  const base = 2 + EXE.length; // 引号化 exe 长度
  const ok = buildWin32CmdInvocation(EXE, [
    "--pad",
    "x".repeat(CMD_LINE_LIMIT - base - 1 - 7 - 1 - 2),
  ]);
  assert.equal(ok.ok, true);
  const bad = buildWin32CmdInvocation(EXE, [
    "--pad",
    "x".repeat(CMD_LINE_LIMIT - base - 7),
  ]);
  assert.equal(bad.ok, false);
  assert.equal((bad as { limit?: number }).limit, CMD_LINE_LIMIT);
});

test("wspawn: 生产 argv 全量经 cmd.exe 通道组装不拒绝（mcp JSON 无 % 无换行）", () => {
  const argv = buildSpawnArgs({
    permissionMode: "plan",
    mcpPort: 80,
    mcpToken: "t",
  });
  const r = buildWin32CmdInvocation("C:\\npm\\claude.cmd", argv, WIN_CMD_EXE);
  assert.equal(r.ok, true);
});

// ---- Gecko 现状模拟：cmd.exe 特例分支（subprocess_win.worker.js 判定照抄）----

/**
 * worker 收到的 args 是 Subprocess.call 前插 command 之后的数组
 * （Subprocess.sys.mjs: `options.arguments.unshift(options.command)`）。
 * 特例命中条件与上游逐字一致：cmd.exe 结尾 + 3 个参数 + args[1] ∈ {/C, /S/C}。
 */
function geckoCmdSpecialCaseHit(file: string, args: string[]): boolean {
  const workerArgs = [file, ...args];
  return (
    /\\cmd\.exe$/i.test(file) &&
    workerArgs.length === 3 &&
    /^(\/S)?\/C$/i.test(workerArgs[1])
  );
}

/**
 * 全链模拟：命中特例 → Gecko 对整行原样补一层外层引号（不做转义）→
 * cmd /s 剥掉该层引号 → 目标程序的 CRT 按 MSVCRT 规则切 argv。
 * 返回 null = 没命中特例（走通用分支被 quoteString 二次转义 → cmd 拿到的命令行不可执行）。
 */
function win32TargetArgv(inv: {
  file: string;
  args: string[];
}): string[] | null {
  if (!geckoCmdSpecialCaseHit(inv.file, inv.args)) {
    return null;
  }
  return crtParse(cmdStrip(`"${inv.args[inv.args.length - 1]}"`));
}

/** MSVCRT/CommandLineToArgvW 解析（规则照抄 crt-roundtrip.mjs，勿手改） */
function crtParse(cmdline: string): string[] {
  const out: string[] = [];
  let i = 0;
  let inQ = false;
  let cur = "";
  let started = false;
  while (i < cmdline.length) {
    const c = cmdline[i];
    if (!inQ && (c === " " || c === "\t")) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      i++;
      continue;
    }
    started = true;
    let bs = 0;
    while (cmdline[i] === "\\") {
      i++;
      bs++;
    }
    if (cmdline[i] === '"') {
      let copy = true;
      if (bs % 2 === 0) {
        if (inQ && cmdline[i + 1] === '"') {
          i++;
        } else {
          copy = false;
          inQ = !inQ;
        }
      }
      cur += "\\".repeat(Math.floor(bs / 2));
      if (copy) cur += '"';
      i++;
    } else {
      cur += "\\".repeat(bs);
      if (i < cmdline.length) {
        cur += cmdline[i];
        i++;
      }
    }
  }
  if (started) out.push(cur);
  return out;
}

/** cmd /s：命令串首尾各是一对引号时剥掉最外层（cmd 的引用剥离规则） */
const cmdStrip = (s: string): string =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

const EXE = "C:\\npm\\claude.cmd";

test("wspawn: 派发形态命中 Gecko cmd.exe 特例（不命中就会被二次转义 → 命令行不可执行）", () => {
  const r = buildWin32CmdInvocation(EXE, ["-p"], WIN_CMD_EXE);
  assert.ok(r.ok);
  assert.equal(geckoCmdSpecialCaseHit(r.file, r.args), true);
  // 反例锚：旧形态（裸名 + /d /s /c 四元）恒不命中——这正是 win32 上每轮必挂的根因
  assert.equal(
    geckoCmdSpecialCaseHit("cmd.exe", [
      "/d",
      "/s",
      "/c",
      '"C:\\npm\\claude.cmd"',
    ]),
    false,
  );
  assert.equal(
    geckoCmdSpecialCaseHit(WIN_CMD_EXE, [
      "/d",
      "/s",
      "/c",
      '"C:\\npm\\claude.cmd"',
    ]),
    false,
  );
});

test("wspawn: line 还原——Gecko 补外层引号 + cmd /s 剥引号后目标 argv 逐字还原", () => {
  const cases: Array<[string, string[]]> = [
    ["尾 1 个 \\", ["-e", "ROOT=D:\\data\\", "--", "npx"]],
    ["盘根 D:\\", ["project", "purge", "-y", "D:\\"]],
    ["空串 token", ["", "next"]],
    [
      "路径带空格（--add-dir 默认形态）",
      ["--add-dir", "C:\\My Papers\\a b.pdf"],
    ],
    ["中文路径", ["--add-dir", "C:\\文献\\论文.pdf"]],
    ["尾部双反斜杠", ["D:\\a\\\\", "next"]],
    [
      "JSON 参数（--mcp-config 实测形态）",
      [
        "--mcp-config",
        '{"mcpServers":{"claudian-perm":{"type":"http","url":"http://127.0.0.1:52100/mcp?token=tok123"}}}',
      ],
    ],
  ];
  for (const [name, argv] of cases) {
    const r = buildWin32CmdInvocation(EXE, argv, WIN_CMD_EXE);
    assert.ok(r.ok, name);
    assert.deepEqual(win32TargetArgv(r), [EXE, ...argv], name);
  }
});

// ---- M9：CLI 检测纯函数（PLAN §2.7 / §4.4）----

test('m9: parseClaudeVersion 实测形态 "2.1.267 (Claude Code)" → 2', () => {
  assert.equal(parseClaudeVersion("2.1.267 (Claude Code)\n"), 2);
});

test("m9: parseClaudeVersion 边界——v 前缀/单段/多余空白/无数字", () => {
  assert.equal(parseClaudeVersion("v3.0.0"), 3);
  assert.equal(parseClaudeVersion("  2  "), 2);
  assert.equal(parseClaudeVersion("Claude Code"), null);
  assert.equal(parseClaudeVersion(""), null);
});

test("m9: parseAuthStatus 实测形态（2026-09-11 本机 claude auth status 输出）", () => {
  const raw = JSON.stringify({
    loggedIn: true,
    authMethod: "oauth_token",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: "/Users/x/.claude/projects",
  });
  assert.deepEqual(parseAuthStatus(raw), {
    loggedIn: true,
    authMethod: "oauth_token",
  });
});

test("m9: parseAuthStatus 未登录形态 → loggedIn:false；authMethod 缺失给 null", () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), {
    loggedIn: false,
    authMethod: null,
  });
  assert.deepEqual(parseAuthStatus('{"loggedIn":false,"authMethod":7}'), {
    loggedIn: false,
    authMethod: null,
  });
});

test("m9: parseAuthStatus 非 JSON / 形态不符 / 数组 → null（不误报）", () => {
  assert.equal(parseAuthStatus("not json"), null);
  assert.equal(parseAuthStatus("[1,2]"), null);
  assert.equal(parseAuthStatus('"loggedIn"'), null);
  assert.equal(parseAuthStatus('{"loggedIn":"yes"}'), null);
  assert.equal(parseAuthStatus(""), null);
});

test("m9: evaluateCliStatus 全绿 → ok 无码无文案", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "",
    overrideExists: false,
    version: { major: 2 },
    auth: { loggedIn: true },
  });
  assert.deepEqual(s, { ok: true, code: null, message: "" });
});

test("m9: evaluateCliStatus 未找到（无 override）→ CLAUDE_NOT_FOUND + 安装链接", () => {
  const s = evaluateCliStatus({
    resolvedPath: null,
    override: "",
    overrideExists: false,
    version: null,
    auth: null,
  });
  assert.equal(s.ok, false);
  assert.equal(s.code, "CLAUDE_NOT_FOUND");
  assert.ok(s.message.includes(CLAUDE_INSTALL_URL));
});

test("m9: evaluateCliStatus 未找到（override 非空）→ 文案带 override 原值", () => {
  const s = evaluateCliStatus({
    resolvedPath: null,
    override: "/gone/claude",
    overrideExists: false,
    version: null,
    auth: null,
  });
  assert.equal(s.code, "CLAUDE_NOT_FOUND");
  assert.ok(s.message.includes("/gone/claude"));
});

test("m9: evaluateCliStatus --version 执行失败 → CLAUDE_NOT_FOUND（不可执行）", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/opt/broken/claude",
    override: "",
    overrideExists: false,
    version: { failed: true },
    auth: null,
  });
  assert.equal(s.code, "CLAUDE_NOT_FOUND");
  assert.ok(s.message.includes("/opt/broken/claude"));
});

test("m9: evaluateCliStatus v1 → CLAUDE_VERSION_TOO_OLD（需 ≥ 2）", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "",
    overrideExists: false,
    version: { major: 1 },
    auth: { loggedIn: true },
  });
  assert.equal(s.code, "CLAUDE_VERSION_TOO_OLD");
  assert.ok(s.message.includes("v1"));
});

test("m9: evaluateCliStatus 未登录 → CLAUDE_AUTH_FAILED", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "",
    overrideExists: false,
    version: { major: 2 },
    auth: { loggedIn: false },
  });
  assert.equal(s.code, "CLAUDE_AUTH_FAILED");
});

test("m9: evaluateCliStatus 优先级——未登录压过 override 无效告警", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "/gone/claude",
    overrideExists: false,
    version: { major: 2 },
    auth: { loggedIn: false },
  });
  assert.equal(s.code, "CLAUDE_AUTH_FAILED");
});

test("m9: evaluateCliStatus 未登录压不过版本过旧；版本过旧压不过未找到", () => {
  const old = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "",
    overrideExists: false,
    version: { major: 1 },
    auth: { loggedIn: false },
  });
  assert.equal(old.code, "CLAUDE_VERSION_TOO_OLD");
  const missing = evaluateCliStatus({
    resolvedPath: null,
    override: "",
    overrideExists: false,
    version: { major: 1 },
    auth: { loggedIn: false },
  });
  assert.equal(missing.code, "CLAUDE_NOT_FOUND");
});

test("m9: evaluateCliStatus override 无效但自动解析可用 → 回落告警（§4.4 UI 告警）", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/usr/bin/claude",
    override: "/gone/claude",
    overrideExists: false,
    version: { major: 2 },
    auth: { loggedIn: true },
  });
  assert.equal(s.ok, false);
  assert.equal(s.code, "CLI_PATH_OVERRIDE_INVALID");
  assert.ok(s.message.includes("/gone/claude"));
  assert.ok(s.message.includes("/usr/bin/claude"));
});

test("m9: evaluateCliStatus override 有效（exists）不告警", () => {
  const s = evaluateCliStatus({
    resolvedPath: "/custom/claude",
    override: "/custom/claude",
    overrideExists: true,
    version: { major: 2 },
    auth: { loggedIn: true },
  });
  assert.equal(s.ok, true);
});

test("detect: buildCliInvocation direct 通道 argv 原样直传", () => {
  assert.deepEqual(
    buildCliInvocation("direct", "/usr/bin/claude", ["--version"]),
    {
      ok: true,
      file: "/usr/bin/claude",
      args: ["--version"],
    },
  );
});

test("detect: buildCliInvocation cmd 通道（win32 .cmd 壳）→ 绝对 cmd.exe + ['/C', 整行]", () => {
  const r = buildCliInvocation(
    "cmd",
    "C:\\npm\\claude.cmd",
    ["auth", "status"],
    WIN_CMD_EXE,
  );
  assert.ok(r.ok);
  assert.equal(r.file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(r.args.length, 2);
  assert.equal(
    r.args[0],
    "/C",
    "args[1]（含前插 command 后）必须是 /C 或 /S/C —— Gecko cmd 特例的判定条件",
  );
  assert.equal(r.args[1], '"C:\\npm\\claude.cmd" "auth" "status"');
});

test("detect: buildCliInvocation cmd 通道入参 cmdExePath 可注入（宿主喂 ComSpec）", () => {
  const r = buildCliInvocation(
    "cmd",
    "C:\\npm\\claude.cmd",
    ["-p"],
    "D:\\os\\cmd.exe",
  );
  assert.ok(r.ok);
  assert.equal(r.file, "D:\\os\\cmd.exe");
});

test("detect: buildCliInvocation cmd 通道组装失败（参数含 %）→ ok:false 透出原因（探测/对话共用）", () => {
  assert.deepEqual(buildCliInvocation("cmd", "C:\\npm\\claude.cmd", ["--%x"]), {
    ok: false,
    code: "SPAWN_FAILED",
    reason: "ARG_HAS_PERCENT",
  });
});

// ---- darwin sh 提限通道（真实实测 2026-09-11：launchd 继承低 fd limit → CLI 启动即 exit 1）----

test("detect: buildCliInvocation sh 通道 → /bin/sh -c 提限脚本 + $0 位 claude 路径", () => {
  const r = buildCliInvocation("sh", "/Users/x/.local/bin/claude", [
    "--version",
  ]);
  assert.ok(r.ok);
  assert.equal(r.file, "/bin/sh");
  // ["-c", script, $0=claude 路径, ...原参数]
  assert.equal(r.args.length, 4);
  assert.equal(r.args[0], "-c");
  assert.equal(
    r.args[1],
    'ulimit -n 2147483646 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true; exec "$0" "$@"',
  );
  assert.equal(
    r.args[2],
    "/Users/x/.local/bin/claude",
    "claude 路径必须落 $0 位",
  );
});

test("detect: sh 通道生产形态 → 原参数逐元素跟在 $0 之后（不经字符串拼接）", () => {
  const argv = buildSpawnArgs({
    permissionMode: "acceptEdits",
    mcpPort: 52100,
    mcpToken: "tok123",
  });
  const r = buildCliInvocation("sh", "/opt/homebrew/bin/claude", argv);
  assert.ok(r.ok);
  assert.deepEqual(r.args, [
    "-c",
    DARWIN_FD_RAISE_SCRIPT,
    "/opt/homebrew/bin/claude",
    ...argv,
  ]);
});

test("detect: sh 通道特殊字符参数独立成元素、不被拒绝（argv 直传，无 cmd 的字符门）", () => {
  // 空格 / 引号 / 百分号 / 换行都只在独立 argv 元素里，永远不进 shell 解析面
  const nasty = [
    "--add-dir",
    "/Users/x/My Papers",
    "Bash(python *)",
    "%Z%",
    "it's\nx",
  ];
  const r = buildCliInvocation("sh", "/b/claude", nasty);
  assert.ok(r.ok);
  assert.deepEqual(r.args.slice(2), ["/b/claude", ...nasty]);
});

test(
  "detect: sh 通道真 shell 行为（低 limit 提限生效 + 参数经 $@ 逐元素不失真）",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "claudian-sh-"));
    const fake = join(dir, "fake-claude");
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf "limit=%s\\n" "$(ulimit -n)"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n',
      { mode: 0o755 },
    );
    const r = buildCliInvocation("sh", fake, ["a b", "%z", "it's q"]);
    assert.ok(r.ok);
    // 外层先把**软**上限压到 256 模拟 launchd 继承态（-S 只动软限：macOS 的 sh 里不加 -S 会连硬限一起降，
    // 那是比真实 launchd 环境更苛刻的假象，硬限在真实场景是 unlimited），再跑被测包装；假 claude 打印自身 limit/argv
    const out = spawnSync(
      "/bin/sh",
      ["-c", 'ulimit -S -n 256 2>/dev/null; exec "$0" "$@"', r.file, ...r.args],
      { encoding: "utf8" },
    );
    assert.equal(out.status, 0, String(out.stderr));
    const lines = out.stdout.trim().split("\n");
    assert.ok(
      Number(lines[0].slice("limit=".length)) > 256,
      `提限未生效: ${lines[0]}`,
    );
    assert.deepEqual(lines.slice(1), ["arg=a b", "arg=%z", "arg=it's q"]);
  },
);
