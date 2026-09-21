// 消息列表渲染 — user 纯文本气泡 / assistant 块流（text→Markdown、thinking→折叠、tool→卡片）。
// Markdown 一律 renderMarkdown（marked→DOMPurify）后 innerHTML（§4.7）；
// 工具入参/结果用 textContent 展示，不过 HTML 管道；
// 容器级 capture 点击拦截渲染产物内所有链接（handleContentClick → openExternal）。
import { h } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, RefObject, VNode } from "preact";
import {
  handleContentClick,
  renderChatMarkdown,
  renderMarkdown,
} from "../lib/markdown";
import { enhanceMermaidBlocks } from "../lib/mermaidRender";
import { recordDiag } from "../lib/bridgeClient";
import { nextRenderDelay, shouldRender } from "../lib/renderThrottle";
import {
  assistantTurnContent,
  notePickerView,
  pendingPermissionElsewhere,
} from "../lib/chatModel";
import {
  canEditTurn,
  isOverflowing,
  messageBodyCollapsed,
  type MessageActionState,
} from "../lib/messageActions";
import type { BranchButtonState } from "../lib/branchActions";
import { noteSourceText, resolveSelectedNote } from "../lib/selectionNote";
import type { SelectedNote } from "../lib/selectionNote";
import {
  buildRenderItems,
  stripAutoOpen,
  stripSummary,
} from "../lib/roundStrip";
import type { RoundGroup } from "../lib/roundStrip";
import { icon } from "../lib/icons";
import type { ChatState, NotePicker, Turn, TurnBlock } from "../lib/chatModel";
import { isImageAttachment } from "../../utils/attachments";

export function MessageList(props: {
  state: ChatState;
  onOpenExternal: (url: string) => void;
  /** M7：该条目可存笔记（readerContext 绑定条目才可） */
  canSaveNote: boolean;
  notePicker: NotePicker | null;
  /** origin="selection" = 选段浮钮那条路径（选项就地展开在选区旁） */
  onNoteSave: (turnIndex: number, html: string, origin?: "selection") => void;
  onNoteChoose: (noteKey: string | null) => void;
  onNoteCancel: () => void;
  /** R7-F：消息级操作视图态（复制态/展开态/编辑态；归约在 lib/messageActions） */
  actions: MessageActionState;
  onCopy: (turn: Turn) => void;
  onEdit: (index: number) => void;
  onCollapseToggle: (index: number) => void;
  /** R7-I：消息分支（每条消息都有入口；快照缺失 → 禁用 + 原因） */
  branchStateFor: (index: number) => BranchButtonState;
  onBranch: (index: number) => void;
}): VNode<any> {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // §4.7：capture 阶段拦截渲染产物内所有 a 点击——特权页面绝不导航到远程内容。
  // 必须 useLayoutEffect（commit 阶段同步挂载）：passive effect 走 after-paint 调度（Preact：rAF +
  // 35ms 定时器兜底；与 BUG-19 同一个延迟来源，只是那里丢的是消息、这里丢的是拦截窗口）——
  // 挂载前 DOM 已带渲染产物，延迟窗口里点链接就是特权页默认导航（拦截器没在）。
  // 注册监听器只是同步动作，放 layout 阶段零代价。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const handler = (e: MouseEvent): void => {
      const url = handleContentClick(e);
      if (url) {
        props.onOpenExternal(url);
      }
    };
    el.addEventListener("click", handler, true);
    return () => el.removeEventListener("click", handler, true);
  }, []);

  // 流式期间自动滚底：用户上滚离开底部后不再强拉
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const onScroll = (): void => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  };

  return h(
    "div",
    { class: "messages", ref: containerRef, onScroll },
    props.state.messages.length === 0
      ? h(EmptyState, {
          connected: props.state.connected,
          hasSession: props.state.sessionId !== null,
          // R20：别的文献的会话有在途权限卡（判定在 model 层，组件不现算——见修订 r3）
          hasForeignPending: pendingPermissionElsewhere(props.state),
        })
      : null,
    // R13：由「逐 Turn 映射」改为「逐渲染项映射」——条带项与助手行项交错，index 仍恒等于
    // state.messages 下标（data-turn-index、MessageActions、NotePicker 全依赖这一对应关系）
    buildRenderItems(props.state.messages).map((item) => {
      if (item.kind === "strip" && item.round) {
        return h(StripView, {
          key: item.key,
          round: item.round,
          state: props.state,
        });
      }
      const i = item.index;
      return h(TurnView, {
        key: item.key,
        turn: props.state.messages[i],
        index: i,
        canSaveNote: props.canSaveNote,
        // 选段路径的 picker 就地画在浮钮位置（SelectionSaveButton），消息行不再重复一份
        picker:
          props.notePicker &&
          props.notePicker.turnIndex === i &&
          props.notePicker.origin !== "selection"
            ? props.notePicker
            : null,
        onNoteSave: props.onNoteSave,
        onNoteChoose: props.onNoteChoose,
        onNoteCancel: props.onNoteCancel,
        actions: props.actions,
        onCopy: props.onCopy,
        onEdit: props.onEdit,
        onCollapseToggle: props.onCollapseToggle,
        branchStateFor: props.branchStateFor,
        onBranch: props.onBranch,
      });
    }),
    // 选段浮动按钮：绝对定位在 .messages 内容坐标系里，跟随选区
    h(SelectionSaveButton, {
      containerRef,
      canSaveNote: props.canSaveNote,
      onNoteSave: props.onNoteSave,
      picker: props.notePicker,
      onNoteChoose: props.onNoteChoose,
      onNoteCancel: props.onNoteCancel,
    }),
  );
}

/**
 * 空视图文案（R17 P1-d）：已连接但会话绑定为空（`sessionId===null`）时补一句说明——
 * 此前是纯白，用户分不清「这篇文献还没有会话」与「坏了」。原句一字不改，只追加一行提示。
 */
function EmptyState(props: {
  connected: boolean;
  hasSession: boolean;
  /** R20：别处（没绑在本面板上的会话）有在途权限卡 —— pendingPermissionElsewhere 的返回值 */
  hasForeignPending: boolean;
}): VNode<any> {
  return h(
    "div",
    { class: "empty" },
    props.connected ? "已连接。输入问题开始对话。" : "等待宿主握手……",
    props.connected && !props.hasSession
      ? h(
          "div",
          { class: "empty-hint" },
          "这篇文献还没有会话，直接输入问题即可新建。",
        )
      : null,
    // R20：卡改为按会话过滤后，空面板上看不见别处的卡 ⇒ 120s 静默 deny。补一句指路
    //（纯文字、不可点：非绑定视图上永远没有「允许/拒绝」入口；带标记的是哪条由会话列表承担）
    props.hasForeignPending
      ? h(
          "div",
          { class: "empty-hint" },
          "其它文献的会话有操作等你确认，去会话列表里点开带标记的那条。",
        )
      : null,
  );
}

/**
 * R17 P3：paint 耗时直方图（**只观测，不改渲染管线、不改节流器**）。
 * 读法：devtools / 外部探针读 `window.__claudianPaint`（与 `window.__claudianDiag` 同款只读约定）。
 * p99 是**桶上界**（粗）：只用来定性「有没有 100ms 级帧」，不用于性能回归的精确判定。
 * 模块级累加：页面寿命内有效（面板重载即清零，与 __claudianDiag 同口径）。
 */
const PAINT_SLOW_MS = 20;
/** 桶上界（ms）——超过最后一档的算进「∞」档 */
const PAINT_BUCKETS_MS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

interface PaintStats {
  count: number;
  maxMs: number;
  p99Ms: number;
  slow: number;
  buckets: number[];
}

/** 记一次 paint：更新直方图；单帧超阈值再记一条 recordDiag（行格式固定，INTERFACE-R17 §2） */
function notePaint(ms: number, chars: number): void {
  try {
    const w = window as Window & { __claudianPaint?: PaintStats };
    const stats = (w.__claudianPaint ??= {
      count: 0,
      maxMs: 0,
      p99Ms: 0,
      slow: 0,
      buckets: new Array(PAINT_BUCKETS_MS.length + 1).fill(0),
    });
    stats.count += 1;
    if (ms > stats.maxMs) {
      stats.maxMs = ms;
    }
    let at = PAINT_BUCKETS_MS.findIndex((edge) => ms <= edge);
    if (at < 0) {
      at = PAINT_BUCKETS_MS.length; // ∞ 档
    }
    stats.buckets[at] += 1;
    const target = Math.ceil(stats.count * 0.99);
    let seen = 0;
    for (let i = 0; i < stats.buckets.length; i++) {
      seen += stats.buckets[i];
      if (seen >= target) {
        stats.p99Ms = i < PAINT_BUCKETS_MS.length ? PAINT_BUCKETS_MS[i] : ms;
        break;
      }
    }
    if (ms > PAINT_SLOW_MS) {
      stats.slow += 1;
      recordDiag(`ui.paint slow ${ms.toFixed(1)}ms len=${chars}`);
    }
  } catch {
    // 探针失败不影响渲染（同 recordDiag 的口径）
  }
}

interface TurnViewProps {
  turn: Turn;
  index: number;
  canSaveNote: boolean;
  picker: NotePicker | null;
  /** origin="selection" = 选段浮钮那条路径（选项就地展开在选区旁） */
  onNoteSave: (turnIndex: number, html: string, origin?: "selection") => void;
  onNoteChoose: (noteKey: string | null) => void;
  onNoteCancel: () => void;
  /** R7-F：复制/编辑/折叠 */
  actions: MessageActionState;
  onCopy: (turn: Turn) => void;
  onEdit: (index: number) => void;
  onCollapseToggle: (index: number) => void;
  /** R7-I：消息分支（每条消息都有入口；快照缺失 → 禁用 + 原因） */
  branchStateFor: (index: number) => BranchButtonState;
  onBranch: (index: number) => void;
}

function TurnView(props: TurnViewProps): VNode<any> {
  if (props.turn.role === "divider") {
    // R7-F：编辑重发后的视图分隔（原分支被截断的显式标记）
    return h("div", { class: "msg divider" }, props.turn.text ?? "已编辑重发");
  }
  if (props.turn.role === "user") {
    // R8：整条折叠只对用户消息生效（超 12 行默认收起，点「展开」看全文）
    const collapsed = messageBodyCollapsed(
      props.actions,
      props.index,
      props.turn,
    );
    return h(
      "div",
      { class: "msg user", "data-turn-index": props.index },
      h(
        "div",
        { class: collapsed ? "msg-body collapsed" : "msg-body" },
        props.turn.text,
      ),
      // R7-J：该轮带的附件（只读展示；编辑态可增删，见输入区 chips）
      (props.turn.attachments ?? []).length > 0
        ? h(
            "div",
            { class: "msg-attachments", "data-testid": "msg-attachments" },
            ...(props.turn.attachments ?? []).map((att, i) =>
              h(
                "span",
                {
                  key: i,
                  class: att.missing ? "chip chip-missing" : "chip chip-attach",
                  title: att.path ?? att.name,
                },
                h(
                  "span",
                  { class: "chip-icon" },
                  isImageAttachment(att.name) ? "🖼" : "📄",
                ),
                h("span", { class: "chip-text" }, att.name),
              ),
            ),
          )
        : null,
      h(MessageActions, { ...props, text: props.turn.text ?? "" }),
    );
  }
  const content = assistantTurnContent(props.turn);
  const plain =
    content.kind === "markdown"
      ? content.text
      : content.blocks
          .filter((b) => b.blockType === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n\n");
  // R8：AI 回复**正文恒不折**（messageBodyCollapsed 对 assistant 恒 false）——流式与否都整块展开；
  // 长代码块另由 MarkdownBlock 按块折（渲染侧 renderChatMarkdown，流式期间同样不折）。
  const collapsed = messageBodyCollapsed(
    props.actions,
    props.index,
    props.turn,
  );
  return h(
    "div",
    // data-turn-index：选段存笔记的归属判据（resolveSelectedNote 从选区向上 closest 取）
    { class: "msg assistant", "data-turn-index": props.index },
    h(
      "div",
      { class: collapsed ? "msg-body collapsed" : "msg-body" },
      content.kind === "blocks"
        ? // R13：本行只画自己的 text 块——thinking / tool 已上提到条带（不重复渲染）
          content.blocks
            .filter((b) => b.blockType === "text")
            .map((b, i) => h(BlockView, { key: i, block: b }))
        : h(MarkdownBlock, { text: content.text, streaming: false }),
    ),
    h(MessageActions, { ...props, text: plain }),
    h(NoteSaveAction, props),
  );
}

/**
 * R13 条带：一轮问答的全部思考条 / 工具卡合并成一条可展开的条带（口径 1–7）。正文因此不用滚动
 * 就能看见；条带内部条目形态逐字不变（原样调用 ThinkingBlock / ToolCard，各自仍可独立展开）。
 *
 * `open` **不参与属性 diff**：Preact 的 props 里不写 open，改由 `useLayoutEffect` 命令式写——
 * 挂载时先写一次（`<details>` 无 open 属性默认收起，漏掉首写会让流式条带一开始就是收起的，
 * 违反口径 3），此后**仅在自动态翻转时**再写一次。用户手动点开的开合态改的是 DOM 本身，
 * 任何一次 store 重渲染都不会把它打回（口径 6：手动开合不记忆——由"根本不存"满足）。
 */
function StripView(props: {
  round: RoundGroup;
  state: ChatState;
}): VNode<any> | null {
  const ref = useRef<HTMLDetailsElement>(null);
  const summary = stripSummary(props.round);
  const auto = stripAutoOpen(props.state, props.round);
  const writtenRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (writtenRef.current === null || writtenRef.current !== auto) {
      el.open = auto;
    }
    writtenRef.current = auto;
  }, [auto]);
  if (summary === null) {
    return null; // processSteps === 0（调用方本就不该渲染条带，这里兜底）
  }
  return h(
    "details",
    {
      class: "strip",
      "data-testid": "strip",
      "data-round-index": props.round.startIndex,
      ref,
    },
    h("summary", null, summary),
    // key 用 `${turnIndex}:${block.index}:${block.blockType}`：calibrateBlocks 会按 toolUseId
    // 去重删块，无 key 时按位置复用会让相邻工具卡短暂错配 props
    props.round.processBlocks.map((item) => {
      const key = `${item.turnIndex}:${item.block.index}:${item.block.blockType}`;
      const b = item.block;
      return h(
        "div",
        { class: "strip-block", "data-turn-index": item.turnIndex, key },
        b.blockType === "thinking"
          ? h(ThinkingBlock, {
              key,
              text: b.text,
              streaming: b.streaming,
            })
          : b.blockType === "tool"
            ? h(ToolCard, {
                key,
                toolName: b.toolName,
                inputJson: b.inputJson,
                result: b.result,
                streaming: b.streaming,
              })
            : h(BlockView, { key, block: b }), // text 块不会进条带（类型兜底）
      );
    }),
  );
}

/**
 * R7-F：气泡操作条（复制 / 编辑 / 展开收起）+ 存为笔记。
 * 用户反馈：这一排文字按钮太占地方 → 改**简笔画图标**（手写 SVG，见 lib/icons），
 * 全称走 title + aria-label（键盘可达的真 button）；默认极淡，行 hover / 按钮 focus 变清晰。
 * 复制：AI 回复复制 Markdown 源码、用户消息复制原文（copyTurnText）；图标变对勾 + title 变「已复制」。
 * 编辑：只对 user 消息出现（AI 回复没有编辑入口）；点一下把原文回填输入框并标「待重发」。
 */
function MessageActions(props: TurnViewProps & { text: string }): VNode<any> {
  const isUser = props.turn.role === "user";
  const canEdit = canEditTurn(props.turn);
  const copied = props.actions.copy.status === "copied";
  // R8：整条折叠只对用户消息存在（AI 正文恒不折，长代码块在块级自带展开/收起）
  const overflowing = isUser && isOverflowing(props.text);
  const expanded = props.actions.expanded.includes(props.index);
  const editing = props.actions.editingIndex === props.index;
  return h(
    "div",
    { class: "msg-tools" },
    h(
      "button",
      {
        class: "msg-tool",
        title: copied ? "已复制" : isUser ? "复制原文" : "复制 Markdown 源码",
        "aria-label": "复制",
        onClick: () => props.onCopy(props.turn),
      },
      copied ? icon("check", 18) : icon("copy", 18),
    ),
    canEdit
      ? h(
          "button",
          {
            class: editing ? "msg-tool on" : "msg-tool",
            title: editing
              ? "正在编辑：原文已回填输入框，发送即从该句之前真回滚并重发"
              : "编辑后重发：从该句之前真回滚（模型记忆也清掉），重发即新分支",
            "aria-label": "编辑后重发",
            onClick: () => props.onEdit(props.index),
          },
          icon("edit", 18),
        )
      : null,
    // R7-I：每条消息（用户与 AI）都能从「这条之后」另开分支；快照缺失 → 禁用 + 说明
    (() => {
      const branch = props.branchStateFor(props.index);
      if (!branch.visible) {
        return null;
      }
      return h(
        "button",
        {
          class: "msg-tool",
          disabled: !branch.enabled,
          title: branch.enabled
            ? "从这里分支：以该消息之后的状态另开会话（原会话保留）"
            : (branch.reason ?? "该消息不可分支"),
          "aria-label": "从此处分支",
          onClick: () => props.onBranch(props.index),
        },
        icon("branch", 18),
      );
    })(),
    // 折叠/展开仍用文字：它是状态开关，文字比图标更不含糊（用户反馈只点名了四个操作）
    overflowing
      ? h(
          "button",
          {
            class: "msg-tool",
            title: expanded ? "收起" : "展开全文",
            onClick: () => props.onCollapseToggle(props.index),
          },
          expanded ? "收起" : "展开",
        )
      : null,
  );
}

/** assistant 回答的文本原文（blocks 取 text 块；回放消息取 text） */
function assistantText(turn: Turn): string {
  const content = assistantTurnContent(turn);
  if (content.kind === "markdown") {
    return content.text;
  }
  return content.blocks
    .filter((b) => b.blockType === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
}

/**
 * 笔记 HTML：与渲染同管道（marked→DOMPurify），失败 fail-closed 返回 null——不存未经消毒的 HTML。
 * where 只进诊断日志，便于区分整轮路径与选段路径的失败。
 * renderSvg:false —— 原生 svg 在笔记里保持源码文本：宿主 htmlSanitize 会把 <svg> 整段丢弃，
 * 内联渲染等于把图从笔记里悄悄删掉（M7 落库口径不变）。
 */
function noteHtml(text: string, where: string): string | null {
  try {
    return renderMarkdown(text, { renderSvg: false });
  } catch (err) {
    recordDiag(`note.markdown failed (${where}): ${String(err)}`);
    return null;
  }
}

/**
 * 「存为笔记」（M7，§4.3）：md→HTML 在前端做（marked→DOMPurify，与渲染同管道），
 * 宿主 notes.ts 写库前再过一道白名单终检。选择器选中即发 saveNote，回执走 noteSaved。
 * 用户反馈选段粒度：点击时若选区落在本消息内 → 只存选中部分；否则整轮（原行为）。
 */
function NoteSaveAction(props: TurnViewProps): VNode<any> {
  if (props.turn.blocks && props.turn.blocks.length === 0) {
    return h("div", { class: "msg-actions" }); // 空 turn（无任何输出）不提供存笔记
  }
  const doSave = (): void => {
    const source = noteSourceText(
      assistantText(props.turn),
      resolveSelectedNote(window.getSelection()),
      props.index,
    );
    const html = noteHtml(source, "turn");
    if (html !== null) {
      props.onNoteSave(props.index, html);
    }
  };
  return h(
    "div",
    { class: "msg-actions" },
    h(
      "button",
      {
        class: "note-save msg-tool",
        disabled: !props.canSaveNote,
        title: props.canSaveNote
          ? "存为笔记（在回答里选中一段时，只存选中的部分）"
          : "当前无关联条目（在阅读器打开 PDF 后可存笔记）",
        "aria-label": "存为笔记",
        // mousedown 默认行为会塌陷选区——塌陷后 doSave 里就读不到「选中的是哪段」
        onMouseDown: (e: Event) => e.preventDefault(),
        onClick: doSave,
      },
      icon("note", 18),
    ),
    props.picker
      ? h(NotePickerBox, {
          picker: props.picker,
          onChoose: props.onNoteChoose,
          onCancel: props.onNoteCancel,
        })
      : null,
  );
}

/** 浮动按钮与选区上方的间距（含按钮自身高度，用 CSS 里尺寸的保守估算做横向钳制） */
const SEL_BTN_H = 34;
const SEL_BTN_W = 96;
/** 就地展开的选项面板宽度上限（横向钳制用；面板实际宽度由内容与 CSS 决定） */
const SEL_PANEL_W = 300;

/**
 * 选段浮动按钮（用户反馈）：选中 assistant 回答里的一段文字时浮在选区上方，点一下只存选段。
 * 选区内容在 selectionchange 时快照进 selRef——点击时用快照，不依赖点击瞬间选区还在不在。
 * visibility 归约在 resolveSelectedNote：无选区/纯空白/选区不在单条 assistant 消息内 → 隐藏。
 * 点完按钮**就地**换成三个选项（创建新笔记 / 追加到《…》 / 取消）——用户反馈原话：
 * 「点击后并没有显示是创建还是追加」：选项不能跑到消息底部的操作行去。
 */
function SelectionSaveButton(props: {
  containerRef: RefObject<HTMLDivElement>;
  canSaveNote: boolean;
  onNoteSave: (turnIndex: number, html: string, origin?: "selection") => void;
  picker: NotePicker | null;
  onNoteChoose: (noteKey: string | null) => void;
  onNoteCancel: () => void;
}): VNode<any> | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const selRef = useRef<SelectedNote | null>(null);
  const panel =
    props.picker && props.picker.origin === "selection" ? props.picker : null;
  // update() 在 selectionchange 监听器里跑（闭包只建一次）→ 面板开合用 ref 传最新值
  const panelRef = useRef<NotePicker | null>(panel);
  useLayoutEffect(() => {
    panelRef.current = panel;
  });

  useLayoutEffect(() => {
    const container = props.containerRef.current;
    if (!container || !props.canSaveNote) {
      selRef.current = null;
      setPos(null);
      return undefined;
    }
    const update = (): void => {
      if (panelRef.current) {
        return; // 选项面板展开中：位置冻结（点选项会让选区塌陷，别把面板自己弄没了）
      }
      const sel = window.getSelection();
      const note = resolveSelectedNote(sel);
      selRef.current = note;
      if (!note || !sel) {
        setPos(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const box = container.getBoundingClientRect();
      if (
        r.bottom < box.top ||
        r.top > box.bottom ||
        (r.width === 0 && r.height === 0)
      ) {
        setPos(null); // 选区滚出可视区（或不可见）→ 收起；滚回来 scroll 事件会再算一次
        return;
      }
      // .messages 是滚动容器：坐标换算到「内容坐标系」（absolute + scrollTop/scrollLeft）
      const above = r.top - box.top > SEL_BTN_H;
      const y =
        (above ? r.top - box.top - SEL_BTN_H : r.bottom - box.top + 4) +
        container.scrollTop;
      const x = Math.max(
        0,
        Math.min(
          r.left - box.left + container.scrollLeft,
          container.clientWidth - SEL_BTN_W,
        ),
      );
      setPos((prev) =>
        prev && Math.abs(prev.x - x) < 1 && Math.abs(prev.y - y) < 1
          ? prev
          : { x, y },
      );
    };
    document.addEventListener("selectionchange", update);
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      document.removeEventListener("selectionchange", update);
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [props.canSaveNote]);

  if (!pos) {
    return null;
  }
  if (panel) {
    // 就地展开：位置钳到容器内（面板比按钮宽，用 SEL_PANEL_W 预留）
    const maxX = Math.max(
      0,
      (props.containerRef.current?.clientWidth ?? pos.x) - SEL_PANEL_W,
    );
    return h(
      "div",
      {
        class: "sel-note-panel",
        style: {
          left: `${Math.min(pos.x, maxX)}px`,
          top: `${pos.y}px`,
          maxWidth: `${SEL_PANEL_W}px`,
        },
      },
      h(NotePickerBox, {
        picker: panel,
        // 选完/取消都彻底收起浮层（清掉选区快照，别让旧选段的按钮再冒出来）
        onChoose: (noteKey: string | null) => {
          selRef.current = null;
          setPos(null);
          props.onNoteChoose(noteKey);
        },
        onCancel: () => {
          selRef.current = null;
          setPos(null);
          props.onNoteCancel();
        },
      }),
    );
  }
  return h(
    "button",
    {
      class: "sel-save",
      type: "button",
      style: { left: `${pos.x}px`, top: `${pos.y}px` },
      // 保住选区（同 note-save）；真正用的是 selRef 快照，这里只是别让选区无谓塌陷
      onMouseDown: (e: Event) => e.preventDefault(),
      onClick: () => {
        const note = selRef.current;
        if (!note) {
          return;
        }
        const html = noteHtml(note.text, "selection");
        if (html === null) {
          return;
        }
        // 不收起：点击后这个按钮就地变成三个选项（picker 由 beginNoteSave 打开）
        props.onNoteSave(note.turnIndex, html, "selection");
      },
    },
    "存选段为笔记",
  );
}

/** 选择器面貌（创建新笔记 / 追加到《…》 / 取消）——形态来自 chatModel.notePickerView（纯逻辑、有单测） */
function NotePickerBox(props: {
  picker: NotePicker;
  onChoose: (noteKey: string | null) => void;
  onCancel: () => void;
}): VNode<any> {
  const view = notePickerView(props.picker);
  const children: ComponentChildren[] = [];
  for (const opt of view.options) {
    if (opt.kind === "new") {
      children.push(
        h(
          "button",
          {
            class: "note-opt",
            key: "new",
            onClick: () => props.onChoose(null),
          },
          opt.label,
        ),
      );
    } else if (opt.kind === "append") {
      children.push(
        h(
          "button",
          {
            class: "note-opt",
            key: opt.noteKey,
            title: opt.title,
            onClick: () => props.onChoose(opt.noteKey ?? null),
          },
          opt.label,
        ),
      );
    } else {
      children.push(
        h(
          "button",
          { class: "note-cancel", key: "cancel", onClick: props.onCancel },
          opt.label,
        ),
      );
    }
  }
  if (view.hint) {
    children.splice(
      children.length - 1,
      0,
      h("span", { class: "note-hint" }, view.hint),
    );
  }
  return h("div", { class: "note-picker" }, children);
}

function BlockView(props: { block: TurnBlock }): VNode<any> {
  const b = props.block;
  if (b.blockType === "text") {
    return h(MarkdownBlock, { text: b.text, streaming: b.streaming });
  }
  if (b.blockType === "thinking") {
    return h(ThinkingBlock, { text: b.text, streaming: b.streaming });
  }
  return h(ToolCard, {
    toolName: b.toolName,
    inputJson: b.inputJson,
    result: b.result,
    streaming: b.streaming,
  });
}

/**
 * 消毒后 innerHTML 的唯一落点：renderMarkdown 内部 fail-closed，未消毒 HTML 到不了这里。
 * R8：走 renderChatMarkdown —— 流式期间与旧行为逐字相同；结束后把超 20 行的代码块折起（块级，正文不折）。
 * 流式期间按 STREAM_RENDER_INTERVAL_MS 合并重渲染（节流器见 lib/renderThrottle）：
 * 未到点的 delta 只更新 latest，到点用最新文本画一帧；合并只丢中间帧，不丢最后一帧
 * （streaming=false 那一次 shouldRender 恒真）。
 */
function MarkdownBlock(props: {
  text: string;
  streaming: boolean;
}): VNode<any> {
  const ref = useRef<HTMLDivElement>(null);
  const lastPaintRef = useRef(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(props.text);

  const paint = (text: string): void => {
    const el = ref.current;
    if (!el) {
      return;
    }
    // R17 P3：只量不改——RenderMarkdown + innerHTML 这一步的耗时（**解析 + DOM 构建，
    // 不含布局/绘制**：`innerHTML=` 不强制 reflow，布局是随后合成时才发生；离屏实测里的
    // 「replace+layout」那一半是量测脚本自己读 offsetHeight 逼出来的）。
    // 结论用途：真机上若从没出现 >PAINT_SLOW_MS 的帧，只能排除「解析+构建」这一半，
    // 布局/绘制与 GC 仍在嫌疑名单上；真出现 ~100ms 级帧才启用备选 B（tail 增量渲染）。
    const t0 = performance.now();
    el.innerHTML = renderChatMarkdown(text, props.streaming);
    notePaint(performance.now() - t0, text.length);
    lastPaintRef.current = Date.now();
  };

  useLayoutEffect(() => {
    latestRef.current = props.text;
    const now = Date.now();
    if (!shouldRender(now, lastPaintRef.current, props.streaming)) {
      if (timerRef.current === null) {
        timerRef.current = setTimeout(
          () => {
            timerRef.current = null;
            paint(latestRef.current); // 到点只画最新文本，中间 delta 全部丢掉
          },
          nextRenderDelay(now, lastPaintRef.current),
        );
      }
      return;
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    paint(props.text);
    // mermaid 二次渲染：只在回合结束（streaming=false）做——流式期间 DOM 按 150ms 一档反复重建，
    // 跟着渲染等于对同一张图反复算；渲染失败/未完成时显示的就是源码块本身。
    if (!props.streaming && ref.current) {
      enhanceMermaidBlocks(ref.current);
    }
  }, [props.text, props.streaming]);

  // 卸载时清掉挂起的合并定时器（回合被切换/清空时不留悬挂回调）
  useLayoutEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return h("div", { class: `md${props.streaming ? " streaming" : ""}`, ref });
}

/** thinking 折叠区：流式期间展开、结束自动收起；纯文本 pre-wrap 展示 */
function ThinkingBlock(props: {
  text: string;
  streaming: boolean;
}): VNode<any> {
  return h(
    "details",
    {
      class: `thinking${props.streaming ? " streaming" : ""}`,
      open: props.streaming ? true : undefined,
    },
    h(
      "summary",
      null,
      `思考过程 · ${props.text.length} 字${props.streaming ? "（流式中）" : ""}`,
    ),
    h("div", { class: "thinking-body" }, props.text),
  );
}

/** 工具卡：默认折叠；入参与结果均 textContent 展示（§4.7） */
function ToolCard(props: {
  toolName: string;
  inputJson: string;
  result: { isError: boolean; summary: string } | null;
  streaming: boolean;
}): VNode<any> {
  const children: ComponentChildren[] = [
    h(
      "summary",
      null,
      `工具 ${props.toolName}${props.result ? (props.result.isError ? " · 失败" : " · 完成") : props.streaming ? " · 运行中" : ""}`,
    ),
    h("pre", { class: "tool-input" }, props.inputJson),
  ];
  if (props.result) {
    children.push(
      h(
        "pre",
        { class: `tool-result${props.result.isError ? " error" : ""}` },
        props.result.summary,
      ),
    );
  }
  return h("details", { class: "tool" }, children);
}
