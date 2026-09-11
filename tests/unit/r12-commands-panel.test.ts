// 单测 — R12-A 命令面板补全（用户原话：「slash命令怎么只有几个？连 compact 都没有」
//        「而且所有的skill也没有在slash命令中显示」）。
//
// 锁定的契约点：
//   1) BUILTIN_COMMANDS：只收 headless 实测「CLI 亲自处理了」的命令（/compact /model）；
//      与本地白名单零重名（撞名会让面板出现两条同名项、选中语义分叉）
//   2) scanSkills：固定两处（<工作区根>/.claude/skills、~/.claude/skills），只下一层；
//      技能名 = frontmatter 的 name（没写则回落目录名；headless 实测两种名字都能展开）；
//      描述取 frontmatter；**正文不进结果**；source 统一标 skill；
//      非目录/符号链接目录/没有 SKILL.md/名字带路径语义/超 64KB 一律跳过
//   3) 去重：项目级覆盖用户级；命令与技能同名时命令赢（宿主侧过滤，这里只锁扫描面）
//   4) 面板上限：COMMANDS_PANEL_MAX ≥ 本地+内置+两处命令+两处技能的最大可能量
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_COMMANDS,
  COMMAND_FILE_MAX_BYTES,
  COMMANDS_DIR_PROJECT,
  COMMANDS_DIR_USER,
  COMMANDS_MAX,
  COMMANDS_PANEL_MAX,
  LOCAL_COMMANDS,
  SKILLS_DIR_PROJECT,
  SKILLS_DIR_USER,
  SKILL_FILE_NAME,
  isSafeSkillDirName,
  scanSkills,
} from "../../src/utils/commands.ts";
import {
  commandAccept,
  commandPanelOpen,
  commandResults,
  initialCommandPickerState,
} from "../../src/chat/lib/commandPicker.ts";
import { commandTokenAt } from "../../src/chat/App.ts";

interface Entry {
  name: string;
  size?: number;
  symlink?: boolean;
  dir?: boolean;
}

function makeDeps(
  entries: Record<string, Entry[]>,
  texts: Record<string, string> = {},
): {
  root: string;
  home: string;
  listed: string[];
  read: string[];
  fs: {
    listDir(dir: string): Promise<Entry[]>;
    readText(path: string): Promise<string | null>;
    join(dir: string, name: string): string;
  };
} {
  const listed: string[] = [];
  const read: string[] = [];
  return {
    root: "/ws",
    home: "/home/u",
    listed,
    read,
    fs: {
      async listDir(dir) {
        listed.push(dir);
        return entries[dir] ?? [];
      },
      async readText(path) {
        read.push(path);
        return texts[path] ?? null;
      },
      join: (dir, name) => `${dir}/${name}`,
    },
  };
}

const USER_SKILLS = `/home/u/${SKILLS_DIR_USER.replace(/^~\//, "")}`;
const PROJECT_SKILLS = `/ws/${SKILLS_DIR_PROJECT}`;
const skillMd = (dir: string, name: string): string => `${dir}/${name}/SKILL.md`;

const fm = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文（不该进结果）`;

// ---- 内置命令 ----

test("R12-A 内置：只收实测可用的两个（/compact /model），且都标 builtin", () => {
  assert.deepEqual(
    BUILTIN_COMMANDS.map((c) => c.name).sort(),
    ["compact", "model"],
  );
  for (const cmd of BUILTIN_COMMANDS) {
    assert.equal(cmd.source, "builtin");
    assert.ok(cmd.description.length > 0, `缺描述：${cmd.name}`);
  }
});

test("R12-A 内置：与本地白名单零重名（面板不出两条同名项）", () => {
  const local = new Set(LOCAL_COMMANDS.map((c) => c.name));
  for (const cmd of BUILTIN_COMMANDS) {
    assert.ok(!local.has(cmd.name), `内置与本地撞名：${cmd.name}`);
  }
});

// ---- 技能扫描 ----

test("R12-A 技能：只扫固定两处（工作区 .claude/skills 与 home .claude/skills）", async () => {
  const deps = makeDeps({ [USER_SKILLS]: [], [PROJECT_SKILLS]: [] });
  await scanSkills(deps);
  assert.deepEqual(
    [...deps.listed].sort(),
    [USER_SKILLS, PROJECT_SKILLS].sort(),
  );
});

test("R12-A 技能：名字取 frontmatter 的 name（与目录名不同则以 frontmatter 为准，两者都能展开）", async () => {
  // headless 实测（2026-09-12）：目录 probe2-dir + frontmatter name: probe2-front，
  // `/probe2-dir` 与 `/probe2-front` **都能**把技能正文带进上下文（正文里的唯一标记都原样回显）→
  // 取 frontmatter name（技能作者声明的身份），目录名只在没写 name 时兜底。
  const deps = makeDeps(
    {
      [USER_SKILLS]: [{ name: "probe2-dir", dir: true }],
    },
    {
      [skillMd(USER_SKILLS, "probe2-dir")]: fm("probe2-front", "名字解析探针"),
    },
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out.map((c) => c.name), ["probe2-front"]);
  assert.equal(out[0].source, "skill");
  assert.equal(out[0].description, "名字解析探针");
});

test("R12-A 技能：frontmatter 没写 name → 用目录名兜底（面板里能选中）", async () => {
  const deps = makeDeps(
    { [USER_SKILLS]: [{ name: "dir-only", dir: true }] },
    { [skillMd(USER_SKILLS, "dir-only")]: "---\ndescription: 只有描述\n---\n" },
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out.map((c) => c.name), ["dir-only"]);
  assert.equal(out[0].description, "只有描述");
});

test("R12-A 技能：frontmatter 缺 description → 空串照收（面板仍能只显示名字）", async () => {
  const deps = makeDeps(
    { [PROJECT_SKILLS]: [{ name: "bare", dir: true }] },
    { [skillMd(PROJECT_SKILLS, "bare")]: "正文，没有 frontmatter" },
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out, [{ name: "bare", description: "", source: "skill" }]);
});

test("R12-A 技能：正文不进结果（解析产物只有 name/description/source）", async () => {
  const deps = makeDeps(
    { [PROJECT_SKILLS]: [{ name: "s1", dir: true }] },
    { [skillMd(PROJECT_SKILLS, "s1")]: fm("s1", "描述") },
  );
  const [entry] = await scanSkills(deps);
  assert.deepEqual(Object.keys(entry).sort(), [
    "description",
    "name",
    "source",
  ]);
});

test("R12-A 技能：非目录、符号链接、没有 SKILL.md 的目录一律跳过", async () => {
  const deps = makeDeps(
    {
      [USER_SKILLS]: [
        { name: "readme.txt" }, // 普通文件
        { name: "linked", dir: true, symlink: true }, // 符号链接目录不跟随
        { name: "empty", dir: true }, // 目录里没有 SKILL.md
        { name: "ok", dir: true },
      ],
      [`${USER_SKILLS}/empty`]: [{ name: "notes.md" }],
    },
    { [skillMd(USER_SKILLS, "ok")]: fm("ok", "好技能") },
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out.map((c) => c.name), ["ok"]);
  assert.ok(
    !deps.listed.includes(`${USER_SKILLS}/linked`),
    "符号链接目录不得被展开",
  );
});

test("R12-A 技能：名字带路径语义/隐藏/空白 → 跳过（文件名净化）", async () => {
  const bad = ["..", ".hidden", "a/b", "a\\b", "has space", ""];
  for (const name of bad) {
    assert.equal(isSafeSkillDirName(name), false, `${name} 不该放行`);
  }
  assert.equal(isSafeSkillDirName("academic-gate"), true);
  assert.equal(isSafeSkillDirName("中文学术"), true);

  const deps = makeDeps(
    {
      [USER_SKILLS]: bad.map((n) => ({ name: n, dir: true })),
    },
    Object.fromEntries(bad.map((n) => [skillMd(USER_SKILLS, n), fm(n, "x")])),
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out, []);
});

test("R12-A 技能：SKILL.md > 64KB 跳过（正好 64KB 保留）", async () => {
  const deps = makeDeps(
    {
      [USER_SKILLS]: [
        { name: "big", dir: true },
        { name: "exact", dir: true },
      ],
    },
    {
      [skillMd(USER_SKILLS, "big")]: "x".repeat(COMMAND_FILE_MAX_BYTES + 1),
      [skillMd(USER_SKILLS, "exact")]: "x".repeat(COMMAND_FILE_MAX_BYTES),
    },
  );
  const out = await scanSkills(deps);
  assert.deepEqual(out.map((c) => c.name), ["exact"]);
});

test("R12-A 技能：同名去重 —— 项目级覆盖用户级（只留一条，描述取项目级）", async () => {
  const deps = makeDeps(
    {
      [PROJECT_SKILLS]: [{ name: "same", dir: true }],
      [USER_SKILLS]: [{ name: "same", dir: true }],
    },
    {
      [skillMd(PROJECT_SKILLS, "same")]: fm("same", "项目版"),
      [skillMd(USER_SKILLS, "same")]: fm("same", "用户版"),
    },
  );
  const out = await scanSkills(deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, "项目版");
  assert.equal(out[0].source, "skill");
});

test("R12-A 技能：目录读不到不抛（面板是加分项，不该拦发送）", async () => {
  const deps = makeDeps({});
  deps.fs.listDir = async () => {
    throw new Error("boom");
  };
  assert.deepEqual(await scanSkills(deps), []);
});

test("R12-A 技能：目录名里的换行/控制字符也算不安全（防注入显示）", () => {
  assert.equal(isSafeSkillDirName("a\nb"), false);
  assert.equal(isSafeSkillDirName("a b"), false);
  assert.equal(isSafeSkillDirName(null), false);
  assert.equal(isSafeSkillDirName(42), false);
});

// ---- 面板口径 ----

test("R12-A 面板：上限覆盖「本地+内置+两处命令+两处技能」的最大量（技能不会被尾部截断）", () => {
  const maxPossible =
    LOCAL_COMMANDS.length +
    BUILTIN_COMMANDS.length +
    COMMANDS_MAX +
    COMMANDS_MAX;
  assert.ok(
    COMMANDS_PANEL_MAX >= maxPossible,
    `面板上限 ${COMMANDS_PANEL_MAX} < 宿主最大可能 ${maxPossible}`,
  );
  const many = Array.from({ length: maxPossible + 50 }, (_, i) => ({
    name: `cmd${String(i).padStart(3, "0")}`,
    description: "",
    source: "skill" as const,
  }));
  const s = commandResults(commandPanelOpen(initialCommandPickerState()), many);
  assert.equal(s.items.length, COMMANDS_PANEL_MAX);
});

test("R12-A 面板：选中技能/内置 → 只往输入框插 `/名字 `，**不自动发送**", () => {
  for (const cmd of [
    { name: "academic-gate", description: "技能", source: "skill" as const },
    { name: "compact", description: "内置", source: "builtin" as const },
  ]) {
    const inserted: string[] = [];
    const sent: string[] = [];
    const state = commandResults(commandPanelOpen(initialCommandPickerState()), [
      cmd,
    ]);
    commandAccept(state, cmd, {
      insertText: (t: string) => inserted.push(t),
      send: (t: string) => sent.push(t),
    });
    assert.deepEqual(inserted, [`/${cmd.name} `], `${cmd.name} 的骨架文本`);
    assert.equal(sent.length, 0, "选中不得自动发送");
  }
});

test("R12-A 面板：插骨架后的文本能过 commandTokenAt（回归：`/skill-name ` 仍是命令语境）", () => {
  assert.deepEqual(commandTokenAt("/academic-gate ", 15), null);
  assert.deepEqual(commandTokenAt("/academic-gate", 14), {
    query: "academic-gate",
    start: 0,
  });
});

test("R12-A 常量：命令目录两处与技能目录两处各就各位（不互相串）", () => {
  assert.equal(COMMANDS_DIR_PROJECT, ".claude/commands");
  assert.equal(COMMANDS_DIR_USER, "~/.claude/commands");
  assert.equal(SKILLS_DIR_PROJECT, ".claude/skills");
  assert.equal(SKILLS_DIR_USER, "~/.claude/skills");
  assert.equal(SKILL_FILE_NAME, "SKILL.md");
});
