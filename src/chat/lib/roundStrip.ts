// roundStrip.ts — R13「过程块合并为一条条带」的纯逻辑（无 DOM / 无 Preact / 无 Zotero，全部输入经形参；
// 口径来源：BRIEF R13 七条 + INTERFACE-R13 §1/§2）。命名与注释风格跟随 messageActions.ts。
//
// 只动渲染层：不新造块类型（复用 chatModel 的 Turn / TurnBlock），不改 state.messages 的形状。
// 分轮判据只用数据里现成的 user 轮边界；条带只折「思考 + 工具」，**不隐藏任何文字块**（口径 4）。
import { assistantTurnContent } from "./chatModel";
import type { ChatState, Turn, TurnBlock } from "./chatModel";

/** 摘要行前缀（逐字：不带动词与标点；`▸` 由原生 `<details>` 的 marker 渲染，不在字符串里） */
export const STRIP_LABEL = "思考与工具调用";

/** 末句过程文字的截断上限（Unicode 码点数） */
export const STRIP_TAIL_MAX_CHARS = 40;

/** 条带里的一个过程块：块本体 + 它所属 assistant Turn 在 state.messages 里的下标 */
export interface StripBlockRef {
  block: TurnBlock;
  turnIndex: number;
}

/** 一轮的收尾方式（口径 2/3 的状态机输入） */
export type TurnEnd = "ok" | "error" | "aborted";

/** 一轮问答 = 一条用户消息到下一条用户消息之间的全部 Turn（口径 1） */
export interface RoundGroup {
  /** 该轮第一条 Turn 的下标（有 user 轮时 = 该 user 轮的下标；前导无主段 = 0） */
  startIndex: number;
  /** 该轮最后一条 Turn 的下标（含） */
  endIndex: number;
  /**
   * 该轮是否由 user 轮打头（前导无主段为 false）。
   * 唯一用途：条带插位规则——条带插在该轮 user 轮之后，仅前导无主段才插在该轮起点。
   */
  hasUser: boolean;
  /** 该轮是否为 messages 里的最后一轮 */
  isLast: boolean;
  /** 摘要行「N 轮」：该轮内 assistant Turn 的条数 */
  assistantTurns: number;
  /** 摘要行「M 步」：该轮内过程块（thinking + tool）的条数 */
  processSteps: number;
  /** 该轮全部过程块，按原始顺序展平（跨 assistant Turn；text 块不在内） */
  processBlocks: StripBlockRef[];
  /** 摘要行尾段的「末句过程文字」成品；无则 null */
  tailText: string | null;
}

/** 渲染项：Turn 项与条带项的交错顺序 */
export interface RenderItem {
  kind: "turn" | "strip";
  /** turn: `u${i}` / `a${i}` / `d${i}`；strip: `s${round.startIndex}` */
  key: string;
  /** turn = state.messages 下标；strip = round.startIndex */
  index: number;
  /** kind === "strip" 时给出 */
  round?: RoundGroup;
}

/** 分轮期间的累积器（对外只出 RoundGroup；tailText 的原料在收尾时才算完成品） */
interface PendingRound {
  startIndex: number;
  endIndex: number;
  hasUser: boolean;
  assistantTurns: number;
  processBlocks: StripBlockRef[];
  /** 该轮展平后最后一块是不是 text 块（位置判据，不做语义分类） */
  lastBlockIsText: boolean;
  /** 最后一条 text / thinking 块的原文（清洗与截断在 cleanTail 里） */
  lastText: string | null;
  lastThinking: string | null;
}

/** 一条可入轮的 Turn（畸形条目按跳过处理——不抛、不算作前导无主段） */
function isTurnLike(v: unknown): v is Turn {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const role = (v as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "divider";
}

/** 一条可读的块（blocks 被归一成数组；数组内畸形条目同样跳过） */
function isBlockLike(v: unknown): v is TurnBlock {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const t = (v as { blockType?: unknown }).blockType;
  return t === "text" || t === "thinking" || t === "tool";
}

function blocksOf(turn: Turn): TurnBlock[] {
  const blocks = (turn as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? blocks.filter(isBlockLike) : [];
}

/** 末句过程文字：位置判据 + 空白折叠 + 按码点截断；取不到 / 清洗后为空 → null */
function cleanTail(raw: string | null): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return null;
  }
  const points = [...flat];
  return points.length > STRIP_TAIL_MAX_CHARS
    ? points.slice(0, STRIP_TAIL_MAX_CHARS).join("") + "…"
    : flat;
}

/**
 * 尾段取值（§1.3，位置判据不做语义分类）：
 * 末块是 text（收尾正文）→ 回取最后一条 thinking；否则（thinking / tool 收尾）→ 回取最后一条 text。
 * 该轮无过程块 → null（该轮也不渲染条带）。
 */
function tailOf(round: PendingRound): string | null {
  if (round.processBlocks.length === 0) {
    return null;
  }
  return cleanTail(round.lastBlockIsText ? round.lastThinking : round.lastText);
}

function toRoundGroup(p: PendingRound, isLast: boolean): RoundGroup {
  return {
    startIndex: p.startIndex,
    endIndex: p.endIndex,
    hasUser: p.hasUser,
    isLast,
    assistantTurns: p.assistantTurns,
    processSteps: p.processBlocks.length,
    processBlocks: p.processBlocks,
    tailText: tailOf(p),
  };
}

/**
 * 把消息流切成一轮一轮（口径 1：边界取现成的两条用户消息之间）。
 * 覆盖全部消息、无遗漏无重叠；divider 归入前一轮但不计数；空数组 / 非数组 / 畸形条目一律兜底不抛。
 */
export function groupRounds(messages: Turn[]): RoundGroup[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const pending: PendingRound[] = [];
  let cur: PendingRound | null = null;
  for (let i = 0; i < messages.length; i++) {
    const turn = messages[i];
    if (!isTurnLike(turn)) {
      continue; // 畸形条目跳过：不影响其余条目的分组
    }
    if (turn.role === "user" || cur === null) {
      // user 轮开新轮；首个有效条目非 user（前导无主段）也自成一轮
      cur = {
        startIndex: i,
        endIndex: i,
        hasUser: turn.role === "user",
        assistantTurns: 0,
        processBlocks: [],
        lastBlockIsText: false,
        lastText: null,
        lastThinking: null,
      };
      pending.push(cur);
    }
    cur.endIndex = i;
    if (turn.role !== "assistant") {
      continue; // divider 只进 endIndex，不计 N / M、不产过程块
    }
    cur.assistantTurns += 1;
    for (const block of blocksOf(turn)) {
      if (block.blockType === "text") {
        cur.lastBlockIsText = true;
        cur.lastText = block.text;
        continue;
      }
      cur.lastBlockIsText = false;
      cur.processBlocks.push({ block, turnIndex: i });
      if (block.blockType === "thinking") {
        cur.lastThinking = block.text;
      }
    }
  }
  return pending.map((p, i) => toRoundGroup(p, i === pending.length - 1));
}

/** 条带摘要行文案；processSteps === 0 时返回 null（调用方据此不渲染条带） */
export function stripSummary(round: RoundGroup): string | null {
  const r = (round ?? null) as {
    assistantTurns?: unknown;
    processSteps?: unknown;
  } | null;
  const steps = typeof r?.processSteps === "number" ? r.processSteps : 0;
  if (steps <= 0) {
    return null;
  }
  const turns = typeof r?.assistantTurns === "number" ? r.assistantTurns : 0;
  const head = `${STRIP_LABEL} · ${turns} 轮 ${steps} 步`;
  const tail = stripTailText(round);
  return tail === null ? head : `${head} · ${tail}`;
}

/** 末句过程文字（截断后的成品，由 groupRounds 在分组时算好）；取不到返回 null */
export function stripTailText(round: RoundGroup): string | null {
  const raw = (round ?? null) as { tailText?: unknown } | null;
  return typeof raw?.tailText === "string" && raw.tailText !== ""
    ? raw.tailText
    : null;
}

/** 该条带当前的自动开合态（口径 2/3/6）；用户手动开合不经此函数——那是 DOM 视图态，不存 */
export function stripAutoOpen(state: ChatState, round: RoundGroup): boolean {
  if (!state || !round) {
    return false;
  }
  if (round.isLast && state.turnStatus !== "idle") {
    return true; // 口径 3：流式中展开
  }
  const end = state.lastTurnEnd;
  if (end != null && end.round === round.startIndex && end.end !== "ok") {
    return true; // 口径 2：出错 / 中断保持展开（只对命中的那一轮生效）
  }
  return false; // 口径 2/6：正常完成收起、已完成轮默认收起
}

/** 助手行可渲染的正文（blocks 取 text 块；回放形态取 text）——空/纯空白视为不可渲染 */
function assistantTextOf(turn: Turn): string {
  const content = assistantTurnContent(turn);
  if (content.kind === "markdown") {
    return content.text;
  }
  const blocks: unknown = content.blocks;
  if (!Array.isArray(blocks)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of blocks) {
    if (
      isBlockLike(block) &&
      block.blockType === "text" &&
      typeof block.text === "string"
    ) {
      texts.push(block.text);
    }
  }
  return texts.join("\n\n");
}

function stripItem(round: RoundGroup): RenderItem {
  return {
    kind: "strip",
    key: `s${round.startIndex}`,
    index: round.startIndex,
    round,
  };
}

/**
 * 由消息流构造渲染项序列：user / divider 恒产出一项；assistant 仅在有正文可渲染时产出一项；
 * 每轮 processSteps > 0 时条带插在该轮 user 轮之后（仅前导无主段插在轮起点）。
 */
export function buildRenderItems(messages: Turn[]): RenderItem[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const items: RenderItem[] = [];
  for (const round of groupRounds(messages)) {
    let stripPlaced = round.processSteps === 0;
    if (!stripPlaced && !round.hasUser) {
      items.push(stripItem(round)); // 前导无主段：条带插在该轮起点
      stripPlaced = true;
    }
    for (let i = round.startIndex; i <= round.endIndex; i++) {
      const turn = messages[i];
      if (!isTurnLike(turn)) {
        continue;
      }
      if (turn.role === "user") {
        items.push({ kind: "turn", key: `u${i}`, index: i });
        if (!stripPlaced) {
          items.push(stripItem(round)); // 条带紧跟该轮 user 轮
          stripPlaced = true;
        }
        continue;
      }
      if (turn.role === "divider") {
        items.push({ kind: "turn", key: `d${i}`, index: i });
        continue;
      }
      if (assistantTextOf(turn).trim() !== "") {
        items.push({ kind: "turn", key: `a${i}`, index: i });
      }
    }
  }
  return items;
}
