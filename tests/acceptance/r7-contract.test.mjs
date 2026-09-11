// 验收测试 — R7 增量契约（PLAN-R7 §2 / §3 / §4）
// 被测契约：src/contract.ts 导出（R7 起需转出下列符号）
//   §2 指令编辑器：INSTRUCTIONS_FILE / INSTRUCTIONS_MAX_CHARS(20000) /
//     readInstructions → {scope, path, text, exists, error?}（文件不存在 → exists:false, text:""）
//     saveInstructions → {scope, ok, path?, error?}
//   §3 @ 提及：MENTION_QUERY_MAX(64) / MENTION_RESULTS_MAX(20) / MENTION_CHIPS_MAX(20) /
//     MENTION_ABSTRACT_MAX(500) / searchMentionItems / resolveMentionRefs /
//     buildReferencedItemsBlock（[Referenced items] … [/Referenced items]）/ mergeAddDirs
//   §3 安全红线：buildAttachmentDenySettings 接受多目录，每个目录各有 Write/Edit 拒绝规则
//   §3.5 命令面板：listCommands → commandList（每条 {name,description,source}，source ∈ local|user|project）；
//     LOCAL_COMMANDS 白名单 / COMMAND_FILE_MAX_BYTES(64KB) / COMMANDS_MAX(200) / scanCommands / filterCommands
//   §3.6 范围注入：resolveScope → scopeResolved（{kind,label,items,truncated}）/ SCOPE_ITEMS_MAX(40) /
//     SCOPE_ABSTRACT_MAX(300) / buildScopeBlock（[Scope: <label>] 标记）/ mergeScopeAddDirs
//     （dockRect 第二参改 box 的几何用例在 tests/unit/r4-dock.test.ts，本文件只锁跨模块的存档格式）
//   §3.8 消息级操作：COLLAPSE_LINE_THRESHOLD(12) —— 纯 UI 面，无新协议消息（其余用例在
//     tests/unit/r7-message-actions.test.mjs）
//   §3.9 真回滚：SNAPSHOT_FILE_MODE(0o600) / SNAPSHOT_DIR_NAME / REWIND_JOURNAL_FILE /
//     snapshotPath / journalPath / rewindToTurn（fork 参数逐字 `--resume <id> --fork-session`）
//   §3.10 分支按钮：新协议消息 `branchSession`（UI→宿主，载荷只有 messageIndex/turn）
//   §3.11 附件：ATTACHMENT_DIR_NAME / ATTACHMENT_MAX_BYTES(20MB) / ATTACHMENT_MAX_PER_MESSAGE(10) /
//     ATTACHMENT_IMAGE_EXTS / ATTACHMENT_NAME_MAX(120) / attachmentDirPath（**本轮 cwd 下**）/
//     saveAttachments（`attachmentSaved` 回执字段：saved[{name,path,size}] / rejected[{name,reason}]）/
//     buildAttachmentsBlock（[Attachments] … [/Attachments] 标记，图片带「可用 Read 查看」）
//   §3.12 会话列表重组：ARCHIVE_IDLE_DAYS(90) / ARCHIVE_MAX_RECENT(50) —— 纯 UI 投影（其余用例在
//     tests/unit/r7-sessionlist.test.mjs）
// 说明：本文件与 tests/unit/r7-*.test.ts 的分工是「契约口径锁定 vs 实现细节覆盖」，
//       刻意只锁会对外承诺的部分（数值边界、消息字段形态、prompt 标记、deny 覆盖面）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSE_LINE_THRESHOLD,
  COMMANDS_MAX,
  COMMAND_FILE_MAX_BYTES,
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_MAX_CHARS,
  LOCAL_COMMANDS,
  MENTION_ABSTRACT_MAX,
  MENTION_CHIPS_MAX,
  MENTION_QUERY_MAX,
  MENTION_RESULTS_MAX,
  SCOPE_ABSTRACT_MAX,
  SCOPE_ITEMS_MAX,
  buildAttachmentDenySettings,
  buildReferencedItemsBlock,
  buildScopeBlock,
  filterCommands,
  mergeAddDirs,
  parseCommandFile,
  readInstructions,
  resolveLocalCommand,
  resolveMentionRefs,
  resolveScope,
  saveInstructions,
  scanCommands,
  searchMentionItems,
  ATTACHMENT_DIR_NAME,
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_NAME_MAX,
  ARCHIVE_IDLE_DAYS,
  ARCHIVE_MAX_RECENT,
  REWIND_JOURNAL_FILE,
  SNAPSHOT_DIR_NAME,
  SNAPSHOT_FILE_MODE,
  attachmentDirPath,
  buildAttachmentsBlock,
  journalPath,
  rewindToTurn,
  saveAttachments,
  snapshotPath,
} from '../../src/contract.ts';
import {
  initialBranchState,
  messageBranchClick,
} from '../../src/chat/lib/branchActions.ts';

const ROOT = '/ws';

/** 最小 fake fs（注入面与 WorkspaceFs 同形；宿主真实现走 IOUtils） */
function fakeFs(files = {}) {
  const store = new Map(Object.entries(files));
  const writes = [];
  return {
    store,
    writes,
    async exists(p) {
      return store.has(p);
    },
    async makeDir() {},
    async readText(p) {
      return store.has(p) ? store.get(p) : null;
    },
    async writeText(p, text) {
      writes.push(p);
      store.set(p, text);
    },
    join: (dir, name) => `${dir}/${name}`,
  };
}

// ---- 数值口径锁定 ----

test('R7 §2/§3：配额常量逐字锁定', () => {
  assert.equal(INSTRUCTIONS_FILE, 'CLAUDE.md');
  assert.equal(INSTRUCTIONS_MAX_CHARS, 20000);
  assert.equal(MENTION_QUERY_MAX, 64);
  assert.equal(MENTION_RESULTS_MAX, 20);
  assert.equal(MENTION_CHIPS_MAX, 20);
  assert.equal(MENTION_ABSTRACT_MAX, 500);
});

// ---- §2 指令编辑器：消息字段形态 ----

test('R7 §2：未创建的文件 → instructions 回执 {exists:false, text:""} 且 path 照给', async () => {
  const res = await readInstructions({
    root: ROOT,
    scope: 'global',
    mode: 'single',
    collectionDir: null,
    fs: fakeFs(),
  });
  assert.equal(res.scope, 'global');
  assert.equal(res.exists, false);
  assert.equal(res.text, '');
  assert.equal(res.path, `${ROOT}/${INSTRUCTIONS_FILE}`);
});

test('R7 §2：已创建的文件 → instructions 回执带原文', async () => {
  const body = '# 规则\n用中文\n';
  const res = await readInstructions({
    root: ROOT,
    scope: 'global',
    mode: 'single',
    collectionDir: null,
    fs: fakeFs({ [`${ROOT}/${INSTRUCTIONS_FILE}`]: body }),
  });
  assert.equal(res.exists, true);
  assert.equal(res.text, body);
});

test('R7 §2：instructionsSaved 回执形态 —— 成功带 path、失败带 error', async () => {
  const fs = fakeFs();
  const ok = await saveInstructions({
    root: ROOT,
    scope: 'global',
    mode: 'single',
    collectionDir: null,
    text: 'x',
    fs,
  });
  assert.equal(ok.scope, 'global');
  assert.equal(ok.ok, true);
  assert.equal(ok.path, `${ROOT}/${INSTRUCTIONS_FILE}`);
  assert.deepEqual(fs.writes, [`${ROOT}/${INSTRUCTIONS_FILE}`]);

  const tooLong = await saveInstructions({
    root: ROOT,
    scope: 'global',
    mode: 'single',
    collectionDir: null,
    text: '字'.repeat(INSTRUCTIONS_MAX_CHARS + 1),
    fs: fakeFs(),
  });
  assert.equal(tooLong.ok, false);
  assert.ok(typeof tooLong.error === 'string' && tooLong.error.length > 0);
});

// ---- §3 检索与解析：消息字段形态 ----

const ITEMS = [
  {
    itemKey: 'A1',
    title: 'Attention Is All You Need',
    creators: ['Vaswani, Ashish'],
    year: '2017',
    publication: 'NeurIPS',
    itemType: 'conferencePaper',
    collectionNames: ['深度学习'],
  },
];

test('R7 §3：itemSearchResult.items 字段齐备（UI 靠这五个字段画列表）', () => {
  const hit = searchMentionItems(ITEMS, 'attention');
  assert.equal(hit.length, 1);
  for (const field of ['itemKey', 'title', 'creators', 'year', 'publication']) {
    assert.notEqual(hit[0][field], undefined, `候选缺字段 ${field}`);
  }
  assert.equal(hit[0].itemKey, 'A1');
});

test('R7 §3：refsResolved.refs 字段齐备，查不到的条目 missing:true', async () => {
  const raw = {
    title: 'T',
    creators: ['A'],
    year: '2017',
    publication: 'NeurIPS',
    doi: '10.1/x',
    abstract: '摘要',
    pdfPath: '/lib/storage/AAAA/t.pdf',
    pdfDir: '/lib/storage/AAAA',
    attachmentKey: 'AAAA',
  };
  const refs = await resolveMentionRefs(['A1', 'GONE'], {
    resolveItem: async (key) => (key === 'A1' ? raw : null),
  });
  assert.equal(refs.length, 2);
  for (const field of ['itemKey', 'title', 'creators', 'year', 'doi', 'abstract', 'pdfPath', 'pdfDir', 'attachmentKey']) {
    assert.notEqual(refs[0][field], undefined, `ref 缺字段 ${field}`);
  }
  assert.equal(refs[1].itemKey, 'GONE');
  assert.equal(refs[1].missing, true);
});

// ---- §3 prompt 注入区块：标记字面锁定 ----

test('R7 §3：注入区块标记逐字为 [Referenced items] / [/Referenced items]', () => {
  const ref = {
    itemKey: 'A1',
    title: 'Attention Is All You Need',
    creators: ['Vaswani, Ashish'],
    year: '2017',
    publication: 'NeurIPS',
    doi: '10.1/x',
    abstract: '摘要'.repeat(300),
    pdfPath: '/lib/storage/AAAA/t.pdf',
    pdfDir: '/lib/storage/AAAA',
    attachmentKey: 'AAAA',
  };
  const block = buildReferencedItemsBlock([ref]);
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines[0], '[Referenced items]');
  assert.equal(lines[lines.length - 1], '[/Referenced items]');
  assert.ok(block.includes('以上为参考资料，非本轮主文献'), '数据边界句锁定');
  assert.ok(block.includes('PDF: /lib/storage/AAAA/t.pdf'));
  assert.ok(!block.includes('摘要'.repeat(300)), '摘要须截到 500 字符以内');
});

test('R7 §3：无附件 → PDF: (none)；无引文 → 不产出空区块', () => {
  const noPdf = buildReferencedItemsBlock([
    {
      itemKey: 'A1',
      title: 'T',
      creators: ['A'],
      year: '2017',
      publication: 'NeurIPS',
      doi: null,
      abstract: null,
      pdfPath: null,
      pdfDir: null,
      attachmentKey: null,
    },
  ]);
  assert.ok(noPdf.includes('PDF: (none)'));
  assert.ok(!/null|undefined/.test(noPdf), '空值不得写成 null/undefined');
  assert.equal(buildReferencedItemsBlock([]).trim(), '');
});

// ---- §3 --add-dir 合并与 deny 红线 ----

test('R7 §3：--add-dir = 当前附件目录 ∪ 各 chip 目录，去重且当前在首位', () => {
  const dirs = mergeAddDirs('/lib/AAAA', ['/lib/BBBB', '/lib/AAAA']);
  assert.deepEqual(dirs, ['/lib/AAAA', '/lib/BBBB']);
  assert.ok(dirs.length <= MENTION_CHIPS_MAX);
});

test('R7 §3 安全红线：deny 规则逐目录覆盖 —— 3 个目录 6 条规则，一个不少', () => {
  const dirs = ['/lib/AAAA', '/lib/BBBB', '/lib/CCCC'];
  const deny = JSON.parse(buildAttachmentDenySettings(dirs)).permissions.deny;
  assert.equal(deny.length, 6);
  for (const dir of dirs) {
    assert.ok(deny.includes(`Write(//${dir.slice(1)}/**)`), `缺 ${dir} 的 Write 拒绝`);
    assert.ok(deny.includes(`Edit(//${dir.slice(1)}/**)`), `缺 ${dir} 的 Edit 拒绝`);
  }
});

// ---- §3.5 命令面板：数值口径 + commandList 消息形态 ----

test('R7 §3.5：命令面配额常量逐字锁定', () => {
  assert.equal(COMMAND_FILE_MAX_BYTES, 64 * 1024);
  assert.equal(COMMANDS_MAX, 200);
});

test('R7 §3.5：本地命令白名单是枚举 —— 八个命令 + 未知命令零执行通道', () => {
  const names = LOCAL_COMMANDS.map((c) => String(c.name).replace(/^\//, '')).sort();
  assert.deepEqual(names, [
    'balance',
    'clear',
    'export',
    'help',
    'instructions',
    'new',
    'note',
    'workspace',
  ]);
  assert.equal(LOCAL_COMMANDS.every((c) => c.source === 'local'), true);
  assert.equal(resolveLocalCommand('/exec'), null);
  assert.equal(resolveLocalCommand('rm -rf /'), null);
  assert.equal(resolveLocalCommand(''), null);
});

test('R7 §3.5：commandList.commands 每条字段齐备，source ∈ local|user|project', async () => {
  const commands = await scanCommands({
    root: '/ws',
    home: '/home/u',
    fs: {
      async listDir(dir) {
        return dir === '/ws/.claude/commands'
          ? [{ name: 'review.md' }, { name: 'skip.txt' }]
          : [{ name: 'review.md' }, { name: 'mine.md' }];
      },
      async readText(path) {
        return path.includes('review') ? '---\nname: review\ndescription: 代码审查\n---\n' : '正文';
      },
      join: (dir, name) => `${dir}/${name}`,
    },
  });
  for (const c of commands) {
    for (const field of ['name', 'description', 'source']) {
      assert.notEqual(c[field], undefined, `commandList 缺字段 ${field}`);
    }
    assert.ok(
      ['local', 'user', 'project'].includes(c.source),
      `source 取值越界：${c.source}`,
    );
  }
  // project 覆盖同名 user 命令
  assert.equal(commands.filter((c) => c.name === 'review').length, 1);
  assert.equal(commands.find((c) => c.name === 'review').source, 'project');
});

test('R7 §3.5：自定义命令只取 frontmatter 的 name/description（正文不进结果）', () => {
  const parsed = parseCommandFile({
    fileName: 'x.md',
    text: '---\nname: 总结\ndescription: 总结文献\n---\n危险正文 rm -rf /\n',
  });
  assert.equal(parsed.name, '总结');
  assert.equal(parsed.description, '总结文献');
  assert.ok(!JSON.stringify(parsed).includes('rm -rf'));
});

test('R7 §3.5：过滤 —— 前缀优先于包含、大小写不敏感、无命中给空数组', () => {
  const list = filterCommands(
    [
      { name: 'summarize', description: '', source: 'project' },
      { name: 'xx-summarize', description: '', source: 'project' },
    ],
    'SUM',
  );
  assert.deepEqual(list.map((c) => c.name), ['summarize', 'xx-summarize']);
  assert.deepEqual(filterCommands(list, '找不到的东西'), []);
});

// ---- §3.6 范围注入：scopeResolved 消息形态 + [Scope: label] 标记 ----

const SCOPE_RAW = {
  title: 'T',
  creators: ['A'],
  year: '2020',
  publication: '某刊',
  doi: '10.1/x',
  abstract: '摘要'.repeat(200),
  pdfPath: '/lib/storage/AAAA/t.pdf',
  pdfDir: '/lib/storage/AAAA',
  attachmentKey: 'AAAA',
};

function scopeDeps(count) {
  return {
    resolveItem: async () => SCOPE_RAW,
    listSelected: async () =>
      Array.from({ length: count }, (_, i) => ({ itemKey: `K${i}`, regular: true })),
    listCollection: async () => [],
  };
}

test('R7 §3.6：scopeResolved 字段齐备（kind/label/items/truncated），items 同 resolveRefs 结构', async () => {
  const res = await resolveScope({ kind: 'selection', label: '选中条目' }, scopeDeps(3));
  for (const field of ['kind', 'label', 'items', 'truncated']) {
    assert.notEqual(res[field], undefined, `scopeResolved 缺字段 ${field}`);
  }
  assert.equal(res.kind, 'selection');
  assert.equal(typeof res.label, 'string');
  assert.equal(res.truncated, false);
  for (const field of ['itemKey', 'title', 'creators', 'year', 'pdfPath', 'pdfDir', 'attachmentKey']) {
    assert.notEqual(res.items[0][field], undefined, `scope 条目缺字段 ${field}`);
  }
});

test('R7 §3.6：条目上限 40 —— 41 条截断（truncated:true）、正好 40 条不截断', async () => {
  assert.equal(SCOPE_ITEMS_MAX, 40);
  const over = await resolveScope({ kind: 'selection', label: '选中条目' }, scopeDeps(41));
  assert.equal(over.items.length, 40);
  assert.equal(over.truncated, true);

  const exact = await resolveScope({ kind: 'selection', label: '选中条目' }, scopeDeps(40));
  assert.equal(exact.items.length, 40);
  assert.equal(exact.truncated, false);
});

test('R7 §3.6：注入区块标记逐字为 [Scope: <label>]，摘要截 300、无附件 PDF: (none)', () => {
  assert.equal(SCOPE_ABSTRACT_MAX, 300);
  const block = buildScopeBlock({
    kind: 'collection',
    label: '科学前言',
    items: [
      {
        itemKey: 'K0',
        title: '第一篇',
        creators: ['A'],
        year: '2020',
        doi: null,
        abstract: 'A'.repeat(300) + 'ZZZ',
        pdfPath: null,
        pdfDir: null,
        attachmentKey: null,
      },
    ],
    truncated: true,
  });
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines[0], '[Scope: 科学前言]');
  assert.ok(block.includes('PDF: (none)'));
  assert.ok(!block.includes('ZZZ'), '摘要必须截到 300 字符以内');
  assert.ok(block.includes('已截断至 40 篇'), '截断须在区块里标注');
  assert.ok(!/null|undefined/.test(block), '空值不得写成 null/undefined');
});

// ---- §3.8 消息级操作：折叠阈值（纯 UI 面的对外承诺）----

test('R7 §3.8：折叠阈值 12 行（超过才默认折叠）', () => {
  assert.equal(COLLAPSE_LINE_THRESHOLD, 12);
});

// ---- §3.9 真回滚：落点 / 权限 / 分叉参数（对外承诺面）----

test('R7 §3.9：回滚面常量逐字锁定（0600 / snapshots / journal 名）', () => {
  assert.equal(SNAPSHOT_FILE_MODE, 0o600);
  assert.equal(SNAPSHOT_DIR_NAME, 'snapshots');
  assert.equal(REWIND_JOURNAL_FILE, 'rewind-journal.json');
});

test('R7 §3.9：快照落点 = <数据目录>/snapshots/<会话id>/<轮序号>.jsonl，journal 在数据目录内', () => {
  assert.equal(snapshotPath('/data/claudian', 'sess-1', 2), '/data/claudian/snapshots/sess-1/2.jsonl');
  assert.equal(snapshotPath('/data/claudian', 'sess-1', 0), '/data/claudian/snapshots/sess-1/0.jsonl');
  assert.ok(journalPath('/data/claudian').startsWith('/data/claudian/'), 'journal 不许出数据目录');
});

test('R7 §3.9：分叉参数逐字 `--resume <原id> --fork-session`，且分叉后立刻还原原文件', async () => {
  const ORIGINAL = '{"type":"user","text":"原第1轮"}\n';
  const SNAP = '{"type":"user","text":"原第1轮"}\n';
  const store = new Map([
    ['/home/u/.claude/projects/-ws/claude-1.jsonl', ORIGINAL],
    ['/data/claudian/snapshots/sess-1/index.json', JSON.stringify({
      claudeSessionId: 'claude-1',
      snapshots: [{ turn: 1, projectDir: '-ws' }],
    })],
    ['/data/claudian/snapshots/sess-1/1.jsonl', SNAP],
  ]);
  const calls = [];
  const fs = {
    async readText(p) { return store.has(p) ? store.get(p) : null; },
    async writeText(p, data) { calls.push(['write', p]); store.set(p, data); },
    async listNames() { return []; },
    async makeDir() {},
    async remove(p) { calls.push(['remove', p]); store.delete(p); },
    async exists(p) { return store.has(p); },
    join: (...seg) => seg.join('/'),
  };
  const runner = {
    async fork(input) {
      calls.push(['fork', input.args.join(' ')]);
      return { newClaudeSessionId: 'claude-2' };
    },
  };
  const res = await rewindToTurn(
    {
      dataDir: '/data/claudian',
      sessionId: 'sess-1',
      claudeSessionId: 'claude-1',
      turn: 1,
      projectDir: '-ws',
      sourcePath: '/home/u/.claude/projects/-ws/claude-1.jsonl',
      cwd: '/ws',
    },
    { fs, runner, log: () => {} },
  );
  assert.equal(res.ok, true);
  assert.equal(res.claudeSessionId, 'claude-2');
  assert.deepEqual(
    calls.find((c) => c[0] === 'fork'),
    ['fork', '--resume claude-1 --fork-session'],
  );
  assert.equal(store.get('/home/u/.claude/projects/-ws/claude-1.jsonl'), ORIGINAL, '原文件必须还原');
  assert.equal(store.has('/data/claudian/snapshots/rewind-journal.json'), false, 'journal 必须清');
});

// ---- §3.10 分支按钮：新协议消息形态 ----

test('R7 §3.10：分支动作的消息 = branchSession，载荷**只有** messageIndex 与 turn', () => {
  const messages = [{ role: 'user', text: '问' }, { role: 'assistant', blocks: [] }];
  const { message } = messageBranchClick(initialBranchState(), messages, 0);
  assert.equal(message.type, 'branchSession');
  assert.deepEqual(Object.keys(message).sort(), ['messageIndex', 'turn', 'type']);
  assert.equal(message.turn, 1, '第一条消息属于第 1 轮');
});

// ---- §3.11 附件：落点 / 配额 / 回执与区块形态 ----

test('R7 §3.11：附件面常量逐字锁定（落点目录 / 20MB / 10 个 / 名字 120 / 图片白名单）', () => {
  assert.equal(ATTACHMENT_DIR_NAME, 'attachments');
  assert.equal(ATTACHMENT_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(ATTACHMENT_MAX_PER_MESSAGE, 10);
  assert.equal(ATTACHMENT_NAME_MAX, 120);
  assert.deepEqual([...ATTACHMENT_IMAGE_EXTS].sort(), ['gif', 'jpeg', 'jpg', 'png', 'webp']);
});

test('R7 §3.11：落点 = <本轮 cwd>/attachments/<会话id>/<轮序号>，会话 id 非法即拒', () => {
  assert.equal(
    attachmentDirPath({ cwd: '/ws', sessionId: 'sess-1', turn: 3 }),
    '/ws/attachments/sess-1/3',
  );
  // collection 模式：cwd 是合集目录，落点跟着走（永远在 cwd 内 → 不需要额外 add-dir）
  assert.equal(
    attachmentDirPath({ cwd: '/ws/科学前言', sessionId: 'sess-1', turn: 0 }),
    '/ws/科学前言/attachments/sess-1/0',
  );
  assert.throws(() => attachmentDirPath({ cwd: '/ws', sessionId: '../../etc', turn: 3 }), Error);
});

test('R7 §3.11：attachmentSaved 回执字段齐备（saved 三条、rejected 两条）', async () => {
  const store = new Map([['/tmp/粘贴/图.png', 'bytes']]);
  const fs = {
    async exists(p) { return store.has(p); },
    async copyFile(from, to) { store.set(to, store.get(from)); },
    async makeDir() {},
    async listNames() { return []; },
    async remove() { throw new Error('R7-J 不许删附件'); },
    join: (...seg) => seg.join('/'),
  };
  const res = await saveAttachments(
    {
      cwd: '/ws',
      sessionId: 'sess-1',
      turn: 3,
      files: [
        { name: '图.png', sizeBytes: 1024, sourcePath: '/tmp/粘贴/图.png' },
        { name: '坏东西.exe', sizeBytes: 1024, sourcePath: '/tmp/粘贴/坏东西.exe' },
      ],
    },
    { fs },
  );
  assert.equal(res.saved.length, 1);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.saved[0].path, '/ws/attachments/sess-1/3/图.png');
  for (const field of ['name', 'path', 'size']) {
    assert.notEqual(res.saved[0][field], undefined, `saved 缺字段 ${field}`);
  }
  for (const field of ['name', 'reason']) {
    assert.notEqual(res.rejected[0][field], undefined, `rejected 缺字段 ${field}`);
  }
});

test('R7 §3.11：prompt 区块标记逐字为 [Attachments] … [/Attachments]，图片带「可用 Read 查看」', () => {
  const block = buildAttachmentsBlock([
    { name: '图.png', path: '/ws/attachments/sess-1/3/图.png', sizeBytes: 1024 },
  ]);
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines[0], '[Attachments]');
  assert.equal(lines[lines.length - 1], '[/Attachments]');
  assert.ok(block.includes('/ws/attachments/sess-1/3/图.png'));
  assert.ok(block.includes('这是图片，可用 Read 查看'));
  assert.equal(buildAttachmentsBlock([]).trim(), '');
});

// ---- §3.12 会话列表重组：归档阈值（对外承诺的两个数）----

test('R7 §3.12：归档阈值 90 天 / 50 条逐字锁定', () => {
  assert.equal(ARCHIVE_IDLE_DAYS, 90);
  assert.equal(ARCHIVE_MAX_RECENT, 50);
});
