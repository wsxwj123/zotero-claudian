// 验收测试 — R4/R5 增量契约（PLAN-R4 §2/§3/§4）
// 被测契约：src/contract.ts 导出
//   followReader(state, itemKey) → { state, changed }：切文献时 UI 会话跟随该条目最新会话；
//     changed = new !== old && new !== null（绑 null 只清视图、不拉历史）
//   normalizePermissionMode(value)：四档（default/acceptEdits/plan/bypass）白名单，非法回落 acceptEdits
//   buildSpawnArgs({permissionMode:"bypass",...}) → --permission-mode bypassPermissions，
//     且 --settings（附件目录 deny）在该档下仍照带（保护不因档位失效）
//   cacheHitPercent / parseBalance / detectProvider：用量与余额口径（R4-3 已在此锁定）
// 说明：本文件与 tests/unit/r4-*.test.ts 的分工是「契约口径锁定 vs 实现细节覆盖」，
//       刻意只锁会对外承诺的部分（数值边界、兜底、argv 形态）。
// R8：R4 §3 的浮层几何/开合契约随浮层方案整体删除（改为右侧栏面板，见 tests/unit/r8-pane-activate.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followReader,
  normalizePermissionMode,
  buildSpawnArgs,
  cacheHitPercent,
  detectProvider,
  parseBalance,
} from '../../src/contract.ts';

const MCP = { mcpPort: 12345, mcpToken: 'tok' };

/** 最小 ChatState：只带 followReader 关心的字段（会话列表 + 当前绑定） */
function stateWith(sessions, sessionId) {
  return {
    sessions,
    sessionId,
    messages: [{ role: 'user' }],
    pendingPermissions: [{}],
    turnStatus: 'streaming',
    errorBanner: '上一个条目的错误',
    errorCode: 'SOMETHING',
    notePicker: { turnIndex: 0 },
    readerContext: { itemKey: 'ITEM_OLD', title: '旧文献', page: 1 },
  };
}

const A1 = { id: 's1', itemKey: 'ITEM_A', title: 'A 老', updatedAt: 100 };
const A2 = { id: 's2', itemKey: 'ITEM_A', title: 'A 新', updatedAt: 300 };
const B1 = { id: 's3', itemKey: 'ITEM_B', title: 'B', updatedAt: 200 };
const GEN = { id: 's4', itemKey: null, title: '通用', updatedAt: 999 };

// ---- followReader：切文献跟随该条目最新会话 ----

test('R4 §2：切到另一文献 → 绑到该条目 updatedAt 最新的会话', () => {
  const r = followReader(stateWith([A1, A2, B1, GEN], 's1'), 'ITEM_B');
  assert.equal(r.state.sessionId, 's3');
  assert.equal(r.changed, true);
});

test('R4 §2：当前会话已属于该条目 → 不动（不抢用户手选）', () => {
  const st = stateWith([A1, A2], 's1');
  const r = followReader(st, 'ITEM_A');
  assert.equal(r.state, st); // 同一引用
  assert.equal(r.changed, false);
});

test('R4 §2：该条目无会话 → 绑 null 清视图，但 changed=false（不拉历史、不新建）', () => {
  const st = stateWith([A1, B1], 's1');
  const r = followReader(st, 'ITEM_C');
  assert.equal(r.state.sessionId, null);
  assert.equal(r.changed, false);
  assert.equal(r.state.sessions.length, 2); // 没有新建会话
  assert.deepEqual(r.state.messages, []);
  assert.deepEqual(r.state.pendingPermissions, []);
  assert.equal(r.state.turnStatus, 'idle');
});

test('R4 §2：换绑定时清空视图状态，但 readerContext 保留（宿主推的上下文不动）', () => {
  const r = followReader(stateWith([A1, B1], 's1'), 'ITEM_B');
  assert.equal(r.state.errorBanner, null);
  assert.equal(r.state.notePicker, null);
  assert.equal(r.state.readerContext.itemKey, 'ITEM_OLD');
});

test('R4 §2：通用会话（itemKey=null）不算该条目会话，哪怕它最新', () => {
  const r = followReader(stateWith([A1, GEN], 's1'), 'ITEM_B');
  assert.equal(r.state.sessionId, null);
});

test('R4 §2：itemKey 为 null（无父条目/书库）→ 原样返回', () => {
  const st = stateWith([A1, B1], 's1');
  const r = followReader(st, null);
  assert.equal(r.state, st);
  assert.equal(r.changed, false);
});

// ---- 权限档与 argv（R5）----

test('R5：四档白名单，非法值回落 acceptEdits', () => {
  for (const ok of ['default', 'acceptEdits', 'plan', 'bypass']) {
    assert.equal(normalizePermissionMode(ok), ok);
  }
  assert.equal(normalizePermissionMode('bypassPermissions'), 'acceptEdits');
  assert.equal(normalizePermissionMode('YOLO'), 'acceptEdits');
  assert.equal(normalizePermissionMode(undefined), 'acceptEdits');
});

test('R5：放任档映射为 CLI 的 bypassPermissions，且仍带 --settings（deny 保护不因档位失效）', () => {
  const args = buildSpawnArgs({
    ...MCP,
    permissionMode: 'bypass',
    addDir: '/tmp/att',
    settingsPath: '/tmp/deny.json',
  });
  const i = args.indexOf('--permission-mode');
  assert.equal(args[i + 1], 'bypassPermissions');
  assert.ok(args.includes('--settings'));
  assert.equal(args[args.indexOf('--settings') + 1], '/tmp/deny.json');
});

// ---- 用量与余额（R4 §4）----

test('R4 §4：缓存命中率 = cacheRead/(input+cacheRead+cacheCreation)，分母 0 → null', () => {
  assert.equal(
    cacheHitPercent({ input: 697, cacheRead: 119040, cacheCreation: 0, output: 260 }),
    99,
  );
  assert.equal(cacheHitPercent({ input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }), null);
  assert.equal(cacheHitPercent({ input: 1000, cacheRead: 0, cacheCreation: 0, output: 5 }), 0);
});

test('R4 §4：provider 判定 —— base URL 或模型名含 deepseek 即 deepseek，否则 unknown', () => {
  assert.equal(detectProvider({ baseUrl: 'http://127.0.0.1:8799', model: 'deepseek-flash' }), 'deepseek');
  assert.equal(detectProvider({ baseUrl: 'https://api.deepseek.com/anthropic', model: null }), 'deepseek');
  assert.equal(detectProvider({ baseUrl: null, model: null }), 'unknown');
});

test('R4 §4：余额解析 —— 无 balance_infos 视为失败，不抛', () => {
  const bad = parseBalance(JSON.stringify({ error: { message: 'nope' } }));
  assert.equal(bad.ok, false);
  const good = parseBalance(
    JSON.stringify({
      balance_infos: [{ currency: 'CNY', total_balance: '42.10', granted_balance: '0', topped_up_balance: '42.10' }],
    }),
  );
  assert.equal(good.ok, true);
});
