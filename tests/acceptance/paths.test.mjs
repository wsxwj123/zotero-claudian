// 验收测试 — §4.5/§4.4/§4.1.1 路径契约（INTERFACE.md v2 Windows 增补）
// 被测契约：src/contract.ts 导出
//   joinPath(platform, ...segments) → PathUtils.join 的纯函数等价（宿主真实现走 PathUtils）：
//     darwin 以 '/' 连接、win32 以 '\' 连接，连接处不产生双分隔符，绝对根保留。
//   defaultWorkspacePath(platform, {home, documentsDir}) → §4.4 workspacePath 默认值：
//     darwin：<home>/zotero-claudian-workspace（~ 已展开形态；2026-09-11 修订避 macOS TCC）；
//     win32：<documentsDir>\zotero-claudian-workspace（documentsDir 由宿主经系统 API 注入，兼容 OneDrive 重定向）。
// 另覆盖 §4.1.1（PDF path 行保留原生分隔符不转义）与 §4.1（--add-dir 原生路径单元素）。
// 假设 A9（见 TEST-PLAN）：joinPath 为 PathUtils.join 的纯函数替身，语义按上注锁定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPath, defaultWorkspacePath, buildPrompt, buildSpawnArgs } from '../../src/contract.ts';

const CTX = {
  itemKey: 'ITEM1',
  displayTitle: 'T',
  creators: ['A'],
  date: '2024',
  doi: null,
  abstractNote: '',
  pdfPath: null,
  currentPage: 1,
  pageLabel: null,
  selection: null,
  selectionPage: null,
  selectionItemKey: null,
};

// ---- joinPath 双平台分隔符 ----

test('join: darwin 以 / 连接多段', () => {
  assert.equal(joinPath('darwin', '/Users', 'x', 'claudian'), '/Users/x/claudian');
});

test('join: win32 以 \\ 连接多段', () => {
  assert.equal(joinPath('win32', 'C:\\Users', 'x', 'claudian'), 'C:\\Users\\x\\claudian');
});

test('join: 段已带尾分隔符 → 不产生双分隔符', () => {
  assert.equal(joinPath('darwin', '/Users/', 'x'), '/Users/x');
  assert.equal(joinPath('win32', 'C:\\', 'x'), 'C:\\x');
});

test('join: win32 profile → claudian 数据目录组合（sessions.json 与 history 路径）', () => {
  const profile = 'C:\\Users\\x\\AppData\\Roaming\\Zotero\\Profiles\\abc123.default';
  assert.equal(joinPath('win32', profile, 'claudian', 'sessions.json'),
    'C:\\Users\\x\\AppData\\Roaming\\Zotero\\Profiles\\abc123.default\\claudian\\sessions.json');
  assert.equal(joinPath('win32', profile, 'claudian', 'history', 'sess-1.jsonl'),
    'C:\\Users\\x\\AppData\\Roaming\\Zotero\\Profiles\\abc123.default\\claudian\\history\\sess-1.jsonl');
});

test('join: darwin profile（~/Zotero 展开后）→ 同结构 / 形态', () => {
  const profile = '/Users/x/Zotero';
  assert.equal(joinPath('darwin', profile, 'claudian', 'sessions.json'), '/Users/x/Zotero/claudian/sessions.json');
  assert.equal(joinPath('darwin', profile, 'claudian', 'history', 'sess-1.jsonl'), '/Users/x/Zotero/claudian/history/sess-1.jsonl');
});

// ---- defaultWorkspacePath（§4.4）----

test('workspace: darwin 默认 → <home>/zotero-claudian-workspace（避 TCC，2026-09-11 实测修订）', () => {
  assert.equal(
    defaultWorkspacePath('darwin', { home: '/Users/x', documentsDir: '/Users/x/Documents' }),
    '/Users/x/zotero-claudian-workspace',
  );
});

test('workspace: win32 默认 → <documentsDir>\\zotero-claudian-workspace', () => {
  assert.equal(
    defaultWorkspacePath('win32', { home: 'C:\\Users\\x', documentsDir: 'C:\\Users\\x\\Documents' }),
    'C:\\Users\\x\\Documents\\zotero-claudian-workspace',
  );
});

test('workspace: win32 OneDrive 重定向 → 采用系统 API 实际落点，不回落 USERPROFILE', () => {
  assert.equal(
    defaultWorkspacePath('win32', { home: 'C:\\Users\\x', documentsDir: 'C:\\Users\\x\\OneDrive\\文档' }),
    'C:\\Users\\x\\OneDrive\\文档\\zotero-claudian-workspace',
  );
});

// ---- 附件路径分隔符不改写（§4.1.1：经 stdin 不经 shell，win32 反斜杠原样）----

test('prompt: win32 PDF 路径（反斜杠+中文）原样进入 PDF path 行', () => {
  const out = buildPrompt({ ...CTX, pdfPath: 'C:\\Users\\x\\文献\\paper.pdf' }, '问题');
  assert.ok(out.includes('PDF path: C:\\Users\\x\\文献\\paper.pdf'), out);
});

test('prompt: PDF 路径不引入转义（反向：不得出现双反斜杠改写）', () => {
  const out = buildPrompt({ ...CTX, pdfPath: 'C:\\Users\\x\\paper.pdf' }, '问题');
  assert.ok(!out.includes('\\\\'), '反斜杠不得被改写为双写');
});

test('spawn: win32 --add-dir 原生路径（含空格+中文）为单元素原样透传', () => {
  const dir = 'C:\\My Papers\\文献 副本';
  const args = buildSpawnArgs({ permissionMode: 'acceptEdits', mcpPort: 52100, mcpToken: 't', addDir: dir });
  const i = args.indexOf('--add-dir');
  assert.equal(args[i + 1], dir);
});
