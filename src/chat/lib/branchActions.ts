// branchActions.ts — R7-I「消息分支按钮」前端归约（纯函数，不碰 DOM；PLAN-R7 §3.10）。
// 分支 = 以某条消息**之后**的状态为新起点另开一条会话（服务端机制见 utils/rewind.ts §3.9）：
// 点分支只发一条 `branchSession`（建会话，不替用户说话、不回填输入框），回执到了自动切过去。
//
// 轮号映射（H3，两条路口径**不同**，别混）：
//   「分支」消息 k → 快照 **k**（含该消息及其回答）；第 k 轮的用户消息与 AI 回答都归 k；
//   「编辑」用户消息 k → 快照 **k−1**（k=1 时 = 0.jsonl）= 该消息**之前**的状态。
// 「编辑」用户消息 1（第一条）→ turn **0** = 会话开始前的**空历史**：没有历史可 fork（CLI 也无法
// resume 空会话文件），宿主改为「新建全新会话 + 编辑后文本首轮」，完全绕开回滚编排（见 hostBridge
// 的 createBranch turn 0 分支）。「分支」口径不变（k=1 → 快照 1，验收锁定）：那条路 fork 得到。
// 快照缺失 → 按钮禁用 + 带原因（§3.9：不降级成「假回滚」）。

/** 消息形态（Turn 的子集；divider 是编辑重发插入的分隔条） */
interface TurnLike {
  role?: unknown;
  text?: unknown;
  blocks?: unknown;
}

export interface BranchButtonState {
  visible: boolean;
  enabled: boolean;
  reason?: string;
}

/** 分支动作消息（载荷只有这三项；sessionId 由 App 发送时补，见 App.ts） */
export interface BranchSessionMessage {
  type: "branchSession";
  messageIndex: number;
  turn: number;
}

/** 会话行（既有 SessionRecord/SessionSummary 子集 + R7-H 分支字段） */
export interface BranchSessionLike {
  id: string;
  parentId?: string | null;
  branchIndex?: number | null;
}

/** 分支视图态（本模块只管「点分支/回执」两件事，其余视图态在 messageActions） */
export interface BranchState {
  /** 当前绑定会话（分叉成功后 = 新分支） */
  sessionId: string | null;
  sessions: BranchSessionLike[];
  /** 编辑回填（本模块恒不写；存在只为锁「点分支不回填输入框」） */
  composerText: string;
  /** 编辑态下标（本模块恒不写；同上） */
  editingIndex: number | null;
}

export function initialBranchState(): BranchState {
  return {
    sessionId: null,
    sessions: [],
    composerText: "",
    editingIndex: null,
  };
}

function turnAt(messages: unknown, index: number): TurnLike | null {
  const list = Array.isArray(messages) ? messages : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return null;
  }
  const turn = list[index] as TurnLike | null;
  return turn && typeof turn === "object" ? turn : null;
}

/** 该条能不能分支：用户消息与 AI 回答都可以；分隔条等非消息行不行 */
export function canBranchTurn(turn: unknown): boolean {
  const t = (turn ?? {}) as TurnLike;
  return t.role === "user" || t.role === "assistant";
}

/**
 * 消息下标 → 轮序号（1 起；只数**用户**消息，分隔条不占号）。
 * 越界/分隔条/空数组 → null（不把 NaN/undefined 混进协议载荷）。
 */
function turnNumberOf(messages: unknown, index: number): number | null {
  const turn = turnAt(messages, index);
  if (!canBranchTurn(turn)) {
    return null;
  }
  const list = messages as TurnLike[];
  let n = 0;
  for (let i = 0; i <= index; i += 1) {
    if ((list[i] as TurnLike)?.role === "user") {
      n += 1;
    }
  }
  return n > 0 ? n : null;
}

/** 「分支」口径：消息 k → 快照 k（含该消息及其回答） */
export function snapshotTurnForMessage(
  messages: unknown,
  index: number,
): number | null {
  return turnNumberOf(messages, index);
}

/** 「编辑」口径：用户消息 k → 快照 k−1（该消息**之前**的状态）；AI 消息没有编辑入口 → null */
export function snapshotTurnForEdit(
  messages: unknown,
  index: number,
): number | null {
  const turn = turnAt(messages, index);
  if (turn?.role !== "user") {
    return null;
  }
  const k = turnNumberOf(messages, index);
  return k === null ? null : k - 1;
}

/**
 * 按钮状态：非消息行 → 不显示；快照缺失 → 显示但禁用 + 原因。
 * opts.snapshotTurns 缺省 = 不限制（宿主还没回快照清单时不假禁用）。
 */
export function branchButtonState(
  messages: unknown,
  index: number,
  opts?: { snapshotTurns?: number[] } | null,
): BranchButtonState {
  const turn = snapshotTurnForMessage(messages, index);
  if (turn === null) {
    return { visible: false, enabled: false };
  }
  const turns = opts?.snapshotTurns;
  if (Array.isArray(turns) && !turns.includes(turn)) {
    return {
      visible: true,
      enabled: false,
      reason: `第 ${turn} 轮快照缺失，无法真回滚（老会话或快照被清理过）`,
    };
  }
  return { visible: true, enabled: true };
}

/**
 * 点「分支」：只产出 `branchSession`（建会话），**不**回填输入框、**不**进编辑态、
 * **不**携带任何 prompt。禁用/非法下标 → message:null 且状态原样。
 */
export function messageBranchClick(
  state: BranchState,
  messages: unknown,
  index: number,
  ctx?: { snapshotTurns?: number[] } | null,
): { state: BranchState; message: BranchSessionMessage | null } {
  const button = branchButtonState(messages, index, ctx);
  if (!button.visible || !button.enabled) {
    return { state, message: null };
  }
  const turn = snapshotTurnForMessage(messages, index);
  if (turn === null) {
    return { state, message: null };
  }
  return {
    state,
    message: { type: "branchSession", messageIndex: index, turn },
  };
}

/**
 * 分叉成功回执（宿主分支会话已建好）：把新分支记录并进列表，并切到它。
 * 原会话与别的会话原样保留（分叉不是搬家）。回执缺 id → 状态原样。
 */
export function branchCreated(
  state: BranchState,
  evt: {
    sessionId?: unknown;
    parentId?: unknown;
    branchIndex?: unknown;
    title?: unknown;
  },
): BranchState {
  const id = evt?.sessionId;
  if (typeof id !== "string" || !id) {
    return state;
  }
  const record: BranchSessionLike & { title: string } = {
    id,
    title: typeof evt.title === "string" ? evt.title : "",
    parentId: typeof evt.parentId === "string" ? evt.parentId : null,
    branchIndex:
      typeof evt.branchIndex === "number" && Number.isFinite(evt.branchIndex)
        ? evt.branchIndex
        : null,
  };
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  return {
    ...state,
    sessionId: id,
    sessions: [...sessions.filter((s) => s?.id !== id), record],
  };
}

export type SessionRow<T extends BranchSessionLike = BranchSessionLike> = T & {
  depth: number;
};

/**
 * 会话列表投影（分支缩进 + 折叠；R7-K 的完整分区/归档在 session/lib/sessionList.ts，本函数
 * 只做「父下缩进 + 同级按 branchIndex 升序 + 默认只展开一层」）：顶层 depth 0、分支 depth 1、
 * 显式展开的分支的子分支 depth 2…；parentId 指向不存在的会话（父被删）→ 当顶层展示不消失。
 * opts.expand = 已显式展开的分支 id 列表。
 */
export function sessionRows<T extends BranchSessionLike>(
  sessions: readonly T[],
  opts?: { expand?: string[] } | null,
): SessionRow<T>[] {
  const list = (Array.isArray(sessions) ? sessions : []).filter(
    (s): s is T => !!s && typeof (s as BranchSessionLike).id === "string",
  );
  const byId = new Map(list.map((s) => [s.id, s]));
  const expand = new Set(
    Array.isArray(opts?.expand) ? (opts?.expand as string[]) : [],
  );
  const children = new Map<string, T[]>();
  const tops: T[] = [];
  for (const s of list) {
    const parentId =
      typeof s.parentId === "string" &&
      s.parentId !== s.id &&
      byId.has(s.parentId)
        ? s.parentId
        : null;
    if (parentId === null) {
      tops.push(s);
      continue;
    }
    const siblings = children.get(parentId);
    if (siblings) {
      siblings.push(s);
    } else {
      children.set(parentId, [s]);
    }
  }
  const branchOrder = (s: T): number =>
    typeof s.branchIndex === "number" && Number.isFinite(s.branchIndex)
      ? s.branchIndex
      : 0;
  for (const siblings of children.values()) {
    siblings.sort((a, b) => branchOrder(a) - branchOrder(b));
  }
  const rows: SessionRow<T>[] = [];
  const seen = new Set<string>();
  const visit = (session: T, depth: number): void => {
    if (seen.has(session.id)) {
      return; // 脏数据成环时兜底：每个会话只出现一次
    }
    seen.add(session.id);
    rows.push({ ...session, depth });
    if (depth >= 1 && !expand.has(session.id)) {
      return; // 默认只展开一层：分支的分支要显式展开才出现
    }
    for (const child of children.get(session.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const top of tops) {
    visit(top, 0);
  }
  return rows;
}
