// 消息列表渲染 — user 纯文本气泡 / assistant 块流（text→Markdown、thinking→折叠、tool→卡片）。
// Markdown 一律 renderMarkdown（marked→DOMPurify）后 innerHTML（§4.7）；
// 工具入参/结果用 textContent 展示，不过 HTML 管道；
// 容器级 capture 点击拦截渲染产物内所有链接（handleContentClick → openExternal）。
import { h } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ComponentChildren, VNode } from "preact";
import { handleContentClick, renderMarkdown } from "../lib/markdown";
import { recordDiag } from "../lib/bridgeClient";
import { assistantTurnContent } from "../lib/chatModel";
import type { ChatState, NotePicker, Turn, TurnBlock } from "../lib/chatModel";

export function MessageList(props: {
  state: ChatState;
  onOpenExternal: (url: string) => void;
  /** M7：该条目可存笔记（readerContext 绑定条目才可） */
  canSaveNote: boolean;
  notePicker: NotePicker | null;
  onNoteSave: (turnIndex: number, html: string) => void;
  onNoteChoose: (noteKey: string | null) => void;
  onNoteCancel: () => void;
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
      ? h(EmptyState, { connected: props.state.connected })
      : null,
    props.state.messages.map((turn, i) =>
      h(TurnView, {
        key: i,
        turn,
        index: i,
        canSaveNote: props.canSaveNote,
        picker: props.notePicker?.turnIndex === i ? props.notePicker : null,
        onNoteSave: props.onNoteSave,
        onNoteChoose: props.onNoteChoose,
        onNoteCancel: props.onNoteCancel,
      }),
    ),
  );
}

function EmptyState(props: { connected: boolean }): VNode<any> {
  return h(
    "div",
    { class: "empty" },
    props.connected ? "已连接。输入问题开始对话。" : "等待宿主握手……",
  );
}

interface TurnViewProps {
  turn: Turn;
  index: number;
  canSaveNote: boolean;
  picker: NotePicker | null;
  onNoteSave: (turnIndex: number, html: string) => void;
  onNoteChoose: (noteKey: string | null) => void;
  onNoteCancel: () => void;
}

function TurnView(props: TurnViewProps): VNode<any> {
  if (props.turn.role === "user") {
    return h("div", { class: "msg user" }, props.turn.text);
  }
  const content = assistantTurnContent(props.turn);
  return h(
    "div",
    { class: "msg assistant" },
    content.kind === "blocks"
      ? content.blocks.map((b, i) => h(BlockView, { key: i, block: b }))
      : h(MarkdownBlock, { text: content.text, streaming: false }),
    h(NoteSaveAction, props),
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
 * 「存为笔记」（M7，§4.3）：md→HTML 在前端做（marked→DOMPurify，与渲染同管道），
 * 宿主 notes.ts 写库前再过一道白名单终检。选择器选中即发 saveNote，回执走 noteSaved。
 */
function NoteSaveAction(props: TurnViewProps): VNode<any> {
  if (props.turn.blocks && props.turn.blocks.length === 0) {
    return h("div", { class: "msg-actions" }); // 空 turn（无任何输出）不提供存笔记
  }
  const doSave = (): void => {
    let html = "";
    try {
      html = renderMarkdown(assistantText(props.turn));
    } catch (err) {
      // fail-closed：消毒器未就位时 renderMarkdown 抛错——不存未经消毒的 HTML
      recordDiag(`note.markdown failed: ${String(err)}`);
      return;
    }
    props.onNoteSave(props.index, html);
  };
  return h(
    "div",
    { class: "msg-actions" },
    h(
      "button",
      {
        class: "note-save",
        disabled: !props.canSaveNote,
        title: props.canSaveNote
          ? "把这条回答存为该条目的笔记"
          : "当前无关联条目（在阅读器打开 PDF 后可存笔记）",
        onClick: doSave,
      },
      "存为笔记",
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

function NotePickerBox(props: {
  picker: NotePicker;
  onChoose: (noteKey: string | null) => void;
  onCancel: () => void;
}): VNode<any> {
  const children: ComponentChildren[] = [
    h(
      "button",
      { class: "note-opt", onClick: () => props.onChoose(null) },
      "新建笔记",
    ),
  ];
  if (props.picker.notes === null) {
    children.push(h("span", { class: "note-hint" }, "读取笔记列表…"));
  } else {
    for (const note of props.picker.notes) {
      children.push(
        h(
          "button",
          {
            class: "note-opt",
            key: note.noteKey,
            title: note.title,
            onClick: () => props.onChoose(note.noteKey),
          },
          `追加到「${note.title ? note.title.slice(0, 30) : "(无标题)"}」`,
        ),
      );
    }
    if (props.picker.notes.length === 0) {
      children.push(h("span", { class: "note-hint" }, "（该条目暂无笔记）"));
    }
  }
  children.push(
    h("button", { class: "note-cancel", onClick: props.onCancel }, "取消"),
  );
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

/** 消毒后 innerHTML 的唯一落点：renderMarkdown 内部 fail-closed，未消毒 HTML 到不了这里 */
function MarkdownBlock(props: {
  text: string;
  streaming: boolean;
}): VNode<any> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = renderMarkdown(props.text);
    }
  }, [props.text]);
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
