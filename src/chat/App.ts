// 根组件 + 状态存储 + 状态行 + 输入框。
// 数据流：桥消息 → reduceHostMessage → store.set → 订阅者触发重渲染；
// UI 动作经 chatModel 纯函数（userSend/interrupt）归约后经桥发出。
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import { MessageList } from "./components/MessageList";
import { PermissionCards } from "./components/PermissionCard";
import { SessionList } from "./components/SessionList";
import {
  beginCreateSession,
  beginNoteSave,
  BYPASS_CONFIRM_WINDOW_MS,
  branchButtonStateFor,
  bypassOptionClick,
  cancelMessageEdit,
  cancelNotePicker,
  CLAUDE_INSTALL_URL,
  clearScope,
  clearView,
  closeCommandPanel,
  closeScopePicker,
  commandActiveChanged,
  commandQueryChanged,
  consumeComposerInsert,
  consumeDraft,
  currentSessionUsage,
  currentTitle,
  deleteSession,
  dismissError,
  editSessionRequest,
  fireRetry,
  flushQueuedSend,
  formatBalance,
  initialChatState,
  instructionsClose,
  instructionsEdit,
  instructionsSave,
  instructionsScopeChange,
  interrupt,
  isPermissionMode,
  messageBranchRequest,
  messageEditRequest,
  notePickerSelect,
  openCommandPanel,
  openInstructions,
  PERMISSION_MODE_OPTIONS,
  permissionRespond,
  reduceHostMessage,
  renameSession,
  requestScope,
  RETRY_DELAY_MS,
  scopePayload,
  selectCommand,
  selectSession,
  sendWithAutoSession,
  sessionMarkdown,
  setHelpOpen,
  setPermissionMode,
  startBalanceRefresh,
} from "./lib/chatModel";
import type {
  BypassConfirmState,
  ChatState,
  PermissionMode,
} from "./lib/chatModel";
import {
  mentionActiveSet,
  mentionChipAdd,
  mentionChipRemove,
  mentionChipsClear,
  mentionPanelClose,
  mentionQueryChange,
  type MentionPickerState,
} from "./lib/mentionPicker";
import { type CommandPickerState } from "./lib/commandPicker";
import { type ScopePickerState } from "./lib/scopePicker";
// R7-J：附件 chips（粘贴/选择文件；输入框上方的 chip 区复用既有 .chips/.chip 机制）
import {
  attachmentChipRemove,
  attachmentChipsAdd,
  attachmentChipsClear,
  attachmentPayload,
  formatAttachmentSize,
  pendingAttachment,
  type AttachmentChipsState,
  type PendingAttachment,
} from "./lib/attachmentChips";
import { isImageAttachment } from "../utils/attachments";
import {
  COPY_FEEDBACK_MS,
  copyToClipboard,
  copyTurnText,
  messageCollapseToggle,
  messageCollapsed,
  messageCopyClick,
  messageCopyRevert,
  type MessageActionState,
} from "./lib/messageActions";
import { LOCAL_COMMANDS, type CommandEntry } from "../utils/commands";
import { renderMarkdown } from "./lib/markdown";
import { assistantTurnContent, type Turn } from "./lib/chatModel";
import type { InstructionsEditorState } from "./lib/instructionsEditor";
import {
  INSTRUCTIONS_MAX_CHARS,
  type InstructionScope,
} from "../utils/instructions";
import type { MentionSearchItem } from "../utils/mentions";
import {
  applyHistoryKey,
  emptyInputHistory,
  historyForSession,
  mergeHostEntries,
  recordSent,
  saveInputHistory,
  type HistoryBucket,
} from "./lib/inputHistory";

/** R5-B：放任档两步确认文案（下拉项与提示行共用同一句） */
const BYPASS_CONFIRM_LABEL = "再点一次确认放任（5 秒内）";
/** R5-B：放任档生效时的 tooltip（后果明示；只读保护边界见 README「放任」） */
const BYPASS_ACTIVE_TITLE =
  "放任模式已生效：不再弹权限卡，命令执行与文件读写一律放行。仅附件目录的改写仍被 deny 硬挡（AI 用脚本绕道写文件时不在保护内）——只在你完全信任本轮任务时使用";
import {
  cacheHitPercent,
  formatTokens,
  isZeroUsage,
  type UsageStats,
} from "./lib/usage";
import { recordDiag } from "./lib/bridgeClient";
import type { BridgeClient } from "./lib/bridgeClient";

/** 极简外置 store：reducer 产物 + 订阅重渲染 */
export class ChatStore {
  private state: ChatState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = initialChatState();
  }

  get(): ChatState {
    return this.state;
  }

  set(next: ChatState): void {
    this.state = next;
    for (const l of this.listeners) {
      l();
    }
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export interface AppProps {
  bridge: BridgeClient;
  store: ChatStore;
}

/** 上一次渲染时记入 diag 的 connected 值（排障留痕去重用，见 App） */
let lastRenderConnected: boolean | null = null;

/** 最后一条 assistant 回答的下标（本地命令 /note 用；没有 → -1） */
function lastAssistantIndex(messages: Turn[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      return i;
    }
  }
  return -1;
}

/**
 * 整轮回答的笔记 HTML（与消息里的「存为笔记」同管道：marked→DOMPurify，失败 fail-closed）。
 * renderSvg:false 与 MessageList 同口径（原生 svg 在笔记里保持源码文本）。
 */
function noteHtmlOf(turn: Turn): string | null {
  const content = assistantTurnContent(turn);
  const text =
    content.kind === "markdown"
      ? content.text
      : content.blocks
          .filter((b) => b.blockType === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n\n");
  if (!text.trim()) {
    return null;
  }
  try {
    return renderMarkdown(text, { renderSvg: false });
  } catch (err) {
    recordDiag(`ui.noteHtml failed (/note): ${String(err)}`);
    return null;
  }
}

export function App(props: AppProps): VNode<any> {
  const [, force] = useState(0);
  const state: ChatState = props.store.get();

  // 排障留痕：connected 翻转时记一条「渲染确实跑到了」——与 main.ts 的 ui.connected 对照，
  // 可区分「状态没更新」「渲染没跑」「DOM 没跟上」三类真机故障
  if (state.connected !== lastRenderConnected) {
    lastRenderConnected = state.connected;
    recordDiag(`ui.render connected=${String(state.connected)}`);
  }

  // 订阅必须走 useLayoutEffect（commit 阶段同步执行），不能用 useEffect。
  // 真实根因是**排序竞态**：ChatStore 只通知「建立订阅那一刻」的监听者、不重放历史，而订阅挂在
  // passive effect 上时执行时机由 after-paint 调度决定（Preact：rAF + 35ms 定时器兜底）。握手消息
  //（init/hello/sessionList/readerContext）都在页面 load 后几毫秒内到达——订阅一旦晚于这批消息，
  // 状态更新即永久丢失：DOM 停在初始态（绿点灭、输入框 disabled），且因 UI 自锁（disabled → 无法
  // 输入 → 再无新消息）永不自愈。
  // 可见性不是根因，只是把窗口放大：真机 run-fix4（visible，绿点亮）与 run-fix5（hidden，绿点恒灭）
  // 的页面 diag 消息流相同；hidden 下 rAF 虽不派发，35ms 兜底定时器照跑——订阅仍会挂上，只是挂得
  // 更晚，晚于消息到达就已丢状态。任何让 passive flush 晚于消息的调度都是同一个坑。
  // 订阅只是同步注册回调，放 layout 阶段零代价，从构造上消除这一竞态。
  useLayoutEffect(() => {
    recordDiag("ui.subscribe attached");
    return props.store.subscribe(() => {
      force((n) => n + 1);
    });
  }, [props.store]);

  // 记录-06：SESSION_BUSY 自动重发（RETRY_DELAY_MS 间隔，次数上限由 reducer 把关）。
  // 只在「pendingRetry 置位且 turn 空闲」时上表——重发在途（waiting）不重复计时；
  // 再次被拒时 reducer 生成新的 pendingRetry 对象，本效果依赖变化即重新计时。
  useEffect(() => {
    if (state.pendingRetry === null || state.turnStatus !== "idle") {
      return;
    }
    const t = setTimeout(() => {
      const r = fireRetry(props.store.get());
      if (r.msg) {
        props.store.set(r.state);
        props.bridge.send(r.msg);
      }
    }, RETRY_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.pendingRetry, state.turnStatus, props.store, props.bridge]);

  // 复查修-1：空绑定发送的收尾——先建会话，绑定一到（sessionId 非空）就把暂存原文发出去，
  // 恰一次（flushQueuedSend 发完即清）。不在这里发的话，原文永远卡在 queuedSend 里。
  useEffect(() => {
    const r = flushQueuedSend(props.store.get());
    if (r.msg) {
      props.store.set(r.state);
      props.bridge.send(r.msg);
    }
  }, [state.sessionId, state.queuedSend, props.store, props.bridge]);

  const busy = state.turnStatus !== "idle";

  const onSend = (text: string): void => {
    const cur = props.store.get();
    // R7-J：本轮附件载荷（名字 + 字节/源路径；落点由宿主算）
    const atts = attachmentPayload(cur.attachments);
    // R7-H：编辑重发 = 真回滚（该条及之后从模型记忆里清掉，重发即新分支；原会话不动）
    if (cur.actions.editingIndex !== null) {
      const edit = editSessionRequest(cur, text, atts);
      if (edit.msg) {
        props.store.set({
          ...edit.state,
          attachments: attachmentChipsClear(), // 附件属于本轮，发出即清
        });
        props.bridge.send(edit.msg);
      }
      return;
    }
    const base = cur;
    // 复查修-1：未绑定会话时走「先建会话、绑定后再发」（userSend 会把 null sessionId
    // 交给宿主，落到最近会话并改绑归属——见 sendWithAutoSession）
    // R7-B：chips 的 itemKey 随本轮发送；发出即清 chips（属于本轮）
    // R7-D：范围 chip 同轮注入（清单篇数多，随 send 的 scope 载荷走）
    const refs = base.mention.chips.map((c) => c.itemKey);
    const r = sendWithAutoSession(base, text, refs, scopePayload(base), atts);
    if (r.state !== base) {
      props.store.set(
        r.msg
          ? {
              ...r.state,
              mention: mentionChipsClear(r.state.mention),
              scope: clearScope(r.state).scope, // 范围 chip 属于本轮，发出即清
              actions: cancelMessageEdit(r.state).actions, // 编辑态收尾（展开态保留）
              commands: closeCommandPanel(r.state).commands,
              attachments: attachmentChipsClear(), // 附件属于本轮，发出即清
            }
          : r.state,
      );
    }
    if (r.msg) {
      props.bridge.send(r.msg);
    }
  };

  // ---- R7-A：指令编辑器 ----

  const onOpenInstructions = (): void => {
    const r = openInstructions(props.store.get());
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  const onInstructionsScope = (scope: InstructionScope): void => {
    const r = instructionsScopeChange(props.store.get(), scope);
    props.store.set(r.state);
    if (r.msg) {
      props.bridge.send(r.msg);
    }
  };

  const onInstructionsEdit = (text: string): void => {
    props.store.set(instructionsEdit(props.store.get(), text));
  };

  const onInstructionsSave = (): void => {
    const r = instructionsSave(props.store.get());
    if (r.msg) {
      props.bridge.send(r.msg);
    }
  };

  const onInstructionsClose = (): void => {
    const cur = props.store.get();
    // 脏态二次确认（PLAN §2：未保存关闭要确认）——确认文案直接说后果
    const dirty =
      cur.instructions !== null &&
      cur.instructions.text !== cur.instructions.savedText;
    // chrome:// 页面里 window.confirm 可用（无 alert/自动关闭限制）：最简的二次确认
    const confirmed =
      !dirty || window.confirm("有未保存的修改，关闭后将丢失。确定关闭？");
    const r = instructionsClose(cur, { confirmDiscard: confirmed });
    if (r.closed) {
      props.store.set(r.state);
    }
  };

  // ---- R7-B：@ 提及 ----

  const onMentionQuery = (query: string): void => {
    const cur = props.store.get();
    props.store.set({
      ...cur,
      mention: mentionQueryChange(cur.mention, query),
    });
    props.bridge.send({ type: "searchItems", query });
  };

  const onMentionClose = (): void => {
    const cur = props.store.get();
    props.store.set({
      ...cur,
      mention: mentionPanelClose(cur.mention),
    });
  };

  const onMentionSelect = (item: MentionSearchItem): void => {
    const cur = props.store.get();
    const next = mentionChipAdd(cur.mention, item);
    props.store.set({
      ...cur,
      mention: { ...next, open: false, query: "", items: [] },
    });
    if (next.chips.length !== cur.mention.chips.length) {
      // 解析一次（UI 据此把查不到的条目标红）；发送时宿主会再解析一次取最新
      props.bridge.send({
        type: "resolveRefs",
        itemKeys: next.chips.map((c) => c.itemKey),
      });
    }
  };

  const onMentionRemove = (itemKey: string): void => {
    const cur = props.store.get();
    props.store.set({
      ...cur,
      mention: mentionChipRemove(cur.mention, itemKey),
    });
  };

  const onMentionActive = (index: number): void => {
    const cur = props.store.get();
    props.store.set({
      ...cur,
      mention: mentionActiveSet(cur.mention, index),
    });
  };

  // ---- R7-C：`/` 命令面板 ----

  const onCommandsOpen = (): void => {
    const r = openCommandPanel(props.store.get());
    props.store.set(r.state);
    if (r.msg) {
      props.bridge.send(r.msg);
    }
  };

  const onCommandsQuery = (query: string): void => {
    props.store.set(commandQueryChanged(props.store.get(), query));
  };

  const onCommandsClose = (): void => {
    props.store.set(closeCommandPanel(props.store.get()));
  };

  const onCommandsActive = (index: number): void => {
    props.store.set(commandActiveChanged(props.store.get(), index));
  };

  /** 本地命令执行（白名单 action → 既有通道；**没有**任何「面板输入当命令执行」的路径） */
  const runLocalCommand = (action: string): void => {
    const cur = props.store.get();
    switch (action) {
      case "newSession": {
        const r = beginCreateSession(cur);
        props.store.set(r.state);
        props.bridge.send(r.msg);
        return;
      }
      case "clearView":
        props.store.set(clearView(cur));
        return;
      case "saveNote": {
        // 上一条 assistant 回答整轮存笔记（选段路径在消息里点「存为笔记」）
        const index = lastAssistantIndex(cur.messages);
        const turn = index >= 0 ? cur.messages[index] : null;
        if (!turn) {
          props.store.set({ ...cur, statusDetail: "还没有可存为笔记的回答" });
          return;
        }
        const html = noteHtmlOf(turn);
        if (html === null) {
          props.store.set({
            ...cur,
            statusDetail: "笔记生成失败（Markdown 渲染异常）",
          });
          return;
        }
        const r = beginNoteSave(cur, index, html);
        props.store.set(
          r.msg
            ? r.state
            : {
                ...cur,
                statusDetail: "当前无关联条目（在阅读器打开 PDF 后可存笔记）",
              },
        );
        if (r.msg) {
          props.bridge.send(r.msg);
        }
        return;
      }
      case "openInstructions": {
        const r = openInstructions(cur);
        props.store.set(r.state);
        props.bridge.send(r.msg);
        return;
      }
      case "openWorkspace":
        props.bridge.send({ type: "openWorkspace" });
        return;
      case "refreshBalance": {
        const r = startBalanceRefresh(cur);
        props.store.set(r.state);
        props.bridge.send(r.msg);
        return;
      }
      case "exportSession": {
        props.bridge.send({
          type: "exportSession",
          title: currentTitle(cur),
          markdown: sessionMarkdown(cur),
        });
        props.store.set({ ...cur, statusDetail: "导出中…" });
        return;
      }
      case "showHelp":
        props.store.set(setHelpOpen(cur, true));
        return;
      default:
        return;
    }
  };

  const onCommandsSelect = (cmd: CommandEntry): void => {
    const r = selectCommand(props.store.get(), cmd);
    props.store.set(r.state);
    if (r.action) {
      runLocalCommand(r.action);
    }
  };

  const onComposerInsertConsumed = (): void => {
    props.store.set(consumeComposerInsert(props.store.get()));
  };

  // ---- R7-D：范围选择 ----

  const onScopeOpen = (): void => {
    const r = requestScope(props.store.get(), "selection");
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  const onScopeRequest = (kind: "collection" | "selection"): void => {
    const r = requestScope(props.store.get(), kind);
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  const onScopeClose = (): void => {
    props.store.set(closeScopePicker(props.store.get()));
  };

  const onScopeClear = (): void => {
    props.store.set(clearScope(props.store.get()));
  };

  // ---- R7-F：消息级操作（复制 / 编辑 / 折叠）----

  const onMessageCopy = (turn: Turn): void => {
    const cur = props.store.get();
    const clicked = messageCopyClick(cur.actions);
    props.store.set({ ...cur, actions: clicked });
    const token = clicked.copy.token;
    void copyToClipboard(copyTurnText(turn)).then((ok) => {
      if (!ok) {
        recordDiag("ui.copy failed（clipboard 两条通道都失败）");
        return;
      }
      // 提示 1.5s 后回落；连点会换新 token，旧定时器按 token 作废
      setTimeout(() => {
        const now = props.store.get();
        props.store.set({
          ...now,
          actions: messageCopyRevert(now.actions, token),
        });
      }, COPY_FEEDBACK_MS);
    });
  };

  const onMessageCollapseToggle = (index: number): void => {
    const cur = props.store.get();
    props.store.set({
      ...cur,
      actions: messageCollapseToggle(cur.actions, index),
    });
  };

  const onMessageEdit = (index: number): void => {
    props.store.set(messageEditRequest(props.store.get(), index));
  };

  // R7-I：消息分支（只建会话；回执到达自动切到新分支，见 reduceBranchCreated）
  const onMessageBranch = (index: number): void => {
    const r = messageBranchRequest(props.store.get(), index);
    if (r.msg) {
      props.store.set(r.state);
      props.bridge.send(r.msg);
    }
  };

  const onInterrupt = (): void => {
    const r = interrupt(props.store.get());
    if (r.msg) {
      props.store.set(r.state);
      props.bridge.send(r.msg);
    }
  };

  const onSelectSession = (id: string): void => {
    const r = selectSession(props.store.get(), id);
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  const onCreateSession = (): void => {
    const r = beginCreateSession(props.store.get());
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  // R4-3：顶栏手动刷新余额（本地先置「查询中」，宿主绕过 60s TTL 重查）
  const onRefreshBalance = (): void => {
    const r = startBalanceRefresh(props.store.get());
    props.store.set(r.state);
    props.bridge.send(r.msg);
  };

  // F6：顶栏切权限档（下一轮 spawn 生效；未绑定会话时 setPermissionMode 返回空动作）
  const onChangeMode = (mode: PermissionMode): void => {
    const r = setPermissionMode(props.store.get(), mode);
    if (r.msg) {
      props.store.set(r.state);
      props.bridge.send(r.msg);
    }
  };

  return h(
    "div",
    { class: "app" },
    h(Header, {
      state,
      onChangeMode,
      onRefreshBalance,
      onOpenInstructions,
    }),
    h(SessionList, {
      state,
      onSelect: onSelectSession,
      onCreate: onCreateSession,
      onDelete: (id: string) => props.bridge.send(deleteSession(id)),
      // R7-K：置顶/取消置顶（集合存宿主 prefs，回执推 sessionList）
      onTogglePin: (id: string) => {
        const pinned = !props.store.get().pinnedSessions.includes(id);
        props.bridge.send({ type: "setSessionPinned", sessionId: id, pinned });
      },
      // 改名：本视图不动，宿主改完推 sessionList 收敛（空标题/没改 → renameSession 返回 null）
      onRename: (title: string) => {
        const msg = renameSession(props.store.get(), title);
        if (msg) {
          props.bridge.send(msg);
        }
      },
    }),
    state.errorBanner
      ? h(
          "div",
          { class: "banner" },
          h("span", { class: "banner-text" }, state.errorBanner),
          // SESSION_GONE：续接失效/会话已删——按 §4.2/§4.6 直接给「新建会话」出口
          state.errorCode === "SESSION_GONE"
            ? h(
                "button",
                { class: "banner-action", onClick: onCreateSession },
                "新建会话",
              )
            : null,
          // CLI 不可用（M9 检测引导）：给安装说明出口（§4.7：链接一律经桥 openExternal 外开）
          state.errorCode === "CLAUDE_NOT_FOUND"
            ? h(
                "button",
                {
                  class: "banner-action",
                  onClick: () =>
                    props.bridge.send({
                      type: "openExternal",
                      url: CLAUDE_INSTALL_URL,
                    }),
                },
                "安装说明",
              )
            : null,
          h(
            "button",
            {
              class: "banner-close",
              onClick: () => props.store.set(dismissError(props.store.get())),
              "aria-label": "关闭错误提示",
            },
            "×",
          ),
        )
      : null,
    h(MessageList, {
      state,
      // R7-F：消息级操作（复制/编辑/折叠）——归约在 lib/messageActions，视图态不落盘
      actions: state.actions,
      onCopy: onMessageCopy,
      onEdit: onMessageEdit,
      onCollapseToggle: onMessageCollapseToggle,
      branchStateFor: (index: number) => branchButtonStateFor(state, index),
      onBranch: onMessageBranch,
      onOpenExternal: (url: string) =>
        props.bridge.send({ type: "openExternal", url }),
      // M7 笔记：md→HTML 在 MessageList 内做（renderMarkdown），这里只负责发桥消息
      canSaveNote: state.readerContext?.itemKey != null,
      notePicker: state.notePicker,
      onNoteSave: (turnIndex: number, html: string, origin?: "selection") => {
        const r = beginNoteSave(props.store.get(), turnIndex, html, origin);
        if (r.msg) {
          props.store.set(r.state);
          props.bridge.send(r.msg);
        }
      },
      onNoteChoose: (noteKey: string | null) => {
        const r = notePickerSelect(props.store.get(), noteKey);
        if (r.msg) {
          props.store.set(r.state);
          props.bridge.send(r.msg);
        }
      },
      onNoteCancel: () => props.store.set(cancelNotePicker(props.store.get())),
    }),
    // 权限卡贴输入区上方（最靠近用户视线落点），不混进消息流
    h(PermissionCards, {
      items: state.pendingPermissions,
      onRespond: (requestId: string, allow: boolean, remember: boolean) => {
        const r = permissionRespond(
          props.store.get(),
          requestId,
          allow,
          remember,
        );
        props.store.set(r.state);
        props.bridge.send(r.msg);
      },
    }),
    h(StatusLine, { state }),
    h(InputBox, {
      disabled: busy || !state.connected,
      turnStatus: state.turnStatus,
      retrying: state.pendingRetry !== null,
      restoreDraft: state.restoreDraft,
      sessionId: state.sessionId,
      hostHistory: state.inputHistory,
      onDraftConsumed: () => props.store.set(consumeDraft(props.store.get())),
      onSend,
      onInterrupt,
      mention: state.mention,
      onMentionQuery,
      onMentionClose,
      onMentionSelect,
      onMentionRemove,
      onMentionActive,
      // R7-C：/ 命令面板
      commands: state.commands,
      composerInsert: state.composerInsert,
      onCommandsOpen,
      onCommandsQuery,
      onCommandsClose,
      onCommandsActive,
      onCommandsSelect,
      onComposerInsertConsumed,
      // R7-J：附件 chips（粘贴/「选择文件」）
      attachments: state.attachments,
      onAttachAdd: (files: PendingAttachment[]) =>
        props.store.set({
          ...props.store.get(),
          attachments: attachmentChipsAdd(props.store.get().attachments, files),
        }),
      onAttachRemove: (id: string) =>
        props.store.set({
          ...props.store.get(),
          attachments: attachmentChipRemove(props.store.get().attachments, id),
        }),
      // R7-J 安全修：选择文件交给宿主弹原生选择器（页面里没有文件路径这一项可传）
      onPickAttachments: () =>
        props.bridge.send({ type: "pickAttachments", multiple: true }),
      // R7-D：范围选择
      scope: state.scope,
      onScopeOpen,
      onScopeRequest,
      onScopeClose,
      onScopeClear,
    }),
    // R7-A：指令编辑器弹层（面板内弹层，不新开窗口）
    state.instructions
      ? h(InstructionsOverlay, {
          editor: state.instructions,
          workspaceMode: state.workspaceMode,
          onScope: onInstructionsScope,
          onEdit: onInstructionsEdit,
          onSave: onInstructionsSave,
          onClose: onInstructionsClose,
        })
      : null,
    // R7-C：/help 帮助弹层（纯本地，不新开窗口）
    state.helpOpen
      ? h(HelpOverlay, {
          onClose: () => props.store.set(setHelpOpen(props.store.get(), false)),
        })
      : null,
  );
}

/** R7-C：/help —— 本地命令白名单与选中语义的备忘（内容直接来自白名单，避免两处口径漂移） */
function HelpOverlay(props: { onClose: () => void }): VNode<any> {
  return h(
    "div",
    { class: "overlay", "data-testid": "help-overlay" },
    h(
      "div",
      { class: "overlay-card" },
      h(
        "div",
        { class: "overlay-head" },
        h("span", { class: "overlay-title" }, "命令帮助"),
        h(
          "button",
          { class: "overlay-close", onClick: props.onClose, title: "关闭" },
          "×",
        ),
      ),
      h("div", { class: "overlay-hint" }, HELP_HINT),
      h(
        "div",
        { class: "help-list" },
        ...LOCAL_COMMANDS.map((cmd) =>
          h(
            "div",
            { class: "help-row", key: cmd.name },
            h("span", { class: "help-name" }, `/${cmd.name}`),
            h("span", { class: "help-desc" }, cmd.description),
          ),
        ),
      ),
      h(
        "div",
        { class: "help-row" },
        h("span", { class: "help-name" }, "/<自定义命令>"),
        h(
          "span",
          { class: "help-desc" },
          "来自 .claude/commands（项目优先）：选中后插入输入框，自己补参数再发送",
        ),
      ),
    ),
  );
}

/** 帮助弹层说明（说清「本地/自定义」两类命令的执行差异——安全边界要让用户看得见） */
const HELP_HINT =
  "本地命令由面板直接执行，不发给 CLI、不花 token；带 / 的自定义命令是文本转发，交给 Claude Code 展开。";

function Header(props: {
  state: ChatState;
  onChangeMode: (mode: PermissionMode) => void;
  onRefreshBalance: () => void;
  onOpenInstructions: () => void;
}): VNode<any> {
  const ctx = props.state.readerContext;
  const parts: string[] = [];
  if (ctx?.title) {
    parts.push(ctx.title);
  }
  if (ctx && ctx.page != null) {
    parts.push(`第 ${ctx.page} 页`);
  }
  // F6：四档切换（PLAN §2 + R5「放任」）。值取最近一次 init 报告的档位；
  // 未知（未跑过 turn / 刚换会话）或非法值 → 显示占位项，绝不假装是 default。
  const mode = props.state.permissionMode;
  const selected = isPermissionMode(mode) ? mode : "";
  // R5-B：放任档两步确认（第一次点只武装 + 回退选择，5 秒内再点才生效；超时/选别档自动取消）
  const [bypassArmed, setBypassArmed] = useState<BypassConfirmState>(null);
  useEffect(() => {
    if (bypassArmed === null) {
      return;
    }
    const t = setTimeout(() => setBypassArmed(null), BYPASS_CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [bypassArmed]);
  const danger = selected === "bypass";
  return h(
    "div",
    { class: "header" },
    h(
      "div",
      { class: "header-row" },
      h("span", { class: `dot ${props.state.connected ? "on" : "off"}` }),
      h(
        "span",
        { class: "header-title" },
        parts.length > 0 ? parts.join(" · ") : "Claude",
      ),
      bypassArmed !== null
        ? h("span", { class: "perm-confirm" }, BYPASS_CONFIRM_LABEL)
        : null,
      // R7-A：面板内编辑项目指令（CLAUDE.md）——不离开面板
      h(
        "button",
        {
          class: "header-btn",
          title: "编辑项目指令（CLAUDE.md）：每轮都会加载的项目规则",
          onClick: props.onOpenInstructions,
        },
        "指令",
      ),
      h(
        "select",
        {
          class: danger ? "perm-mode perm-mode-danger" : "perm-mode",
          title: danger ? BYPASS_ACTIVE_TITLE : "权限档（下一轮生效）",
          value: selected,
          // 未绑定会话时宿主只会忽略（§4.6 setPermissionMode），禁用免得点了没反应
          disabled: props.state.sessionId === null,
          onChange: (e: Event) => {
            const el = e.target as HTMLSelectElement;
            const v = el.value;
            if (!isPermissionMode(v)) {
              return;
            }
            if (v === "bypass") {
              const r = bypassOptionClick(bypassArmed, Date.now());
              setBypassArmed(r.armed);
              if (r.confirmed) {
                props.onChangeMode("bypass");
              } else {
                // 第一次点：不换档，把控件显示退回真实档位（否则再点同一项不触发 change，第二步无法完成）
                el.value = selected;
              }
              return;
            }
            setBypassArmed(null); // 选了别档 = 取消确认
            props.onChangeMode(v);
          },
        },
        selected === ""
          ? h("option", { value: "", disabled: true }, "权限档未知")
          : null,
        ...PERMISSION_MODE_OPTIONS.map((o) =>
          h(
            "option",
            { value: o.value },
            o.value === "bypass" && bypassArmed !== null
              ? BYPASS_CONFIRM_LABEL
              : o.label,
          ),
        ),
      ),
    ),
    h(UsageRow, {
      state: props.state,
      onRefreshBalance: props.onRefreshBalance,
    }),
  );
}

/** 顶栏余额区文案（null = 该状态下不显示余额文本） */
function balanceTextOf(
  balance: ChatState["balance"],
): { text: string; title: string; canRefresh: boolean } | null {
  if (!balance) {
    return null; // 宿主还没推（老宿主/查询未接线）→ 不占位
  }
  const canRefresh = balance.provider === "deepseek";
  const b = balance.balance;
  switch (b.state) {
    case "loading":
      return { text: "查询余额中…", title: "", canRefresh };
    case "unsupported":
      return { text: "当前 provider 不支持余额查询", title: "", canRefresh };
    case "nokey":
      return {
        text: "未配置 DeepSeek Key（设置页填写后显示余额）",
        title: "",
        canRefresh,
      };
    case "ok":
      return {
        text: formatBalance(b.currency, b.total),
        // 多币种（deepseek 会给 CNY+USD 两条）时悬停看全量
        title: b.all.map((e) => formatBalance(e.currency, e.total)).join(" / "),
        canRefresh,
      };
    case "error":
      return {
        // 行内只给短文案，完整原因（可能含响应体截断片段）走悬停
        text: `余额查询失败：${b.reason.slice(0, 30)}${b.reason.length > 30 ? "…" : ""}`,
        title: b.reason,
        canRefresh,
      };
    default:
      return null;
  }
}

/**
 * R4-3 顶栏用量行：`本轮 ↑12.3K ↓1.2K · 缓存 87% · 会话累计 ↑… ↓… · 余额 …`。
 * 显示口径（PLAN-R4 §4）：
 *  - 开关关闭（showUsage=false）→ 整行不渲染；
 *  - token 全 0 / 无数据 → 整行不渲染；
 *  - 命中率 null（分母 0 / 无数据）→ 该段不显示（**不显示 0%**）；
 *  - 余额：unsupported / nokey 是「宿主未发请求」的说明态，文案如实说，不显示数字。
 */
function UsageRow(props: {
  state: ChatState;
  onRefreshBalance: () => void;
}): VNode<any> | null {
  const state = props.state;
  if (!state.showUsage) {
    return null;
  }
  const turn = state.turnUsage;
  const total = currentSessionUsage(state);
  const seg = (u: UsageStats): string =>
    `↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`;
  const turnText = turn && !isZeroUsage(turn) ? `本轮 ${seg(turn)}` : null;
  const totalText =
    total && !isZeroUsage(total) ? `会话累计 ${seg(total)}` : null;
  const balance = balanceTextOf(state.balance);
  if (!turnText && !totalText && !balance) {
    return null; // 无用量且无余额信息 → 整行不占位（token 全 0 同待遇）
  }
  // 命中率取「正在显示的那份用量」：有本轮就用本轮（分母 0 → null → 该段不显示），
  // 没有本轮才用累计。绝不用另一份的值冒充本轮的命中率
  const hit = turnText ? cacheHitPercent(turn) : cacheHitPercent(total);
  return h(
    "div",
    { class: "usage", "data-testid": "usage-row" },
    turnText ? h("span", { class: "usage-seg" }, turnText) : null,
    // 命中率 null = 没数据，不显示该段（不显示 0%）；0% 是合法值（全 miss）要显示
    hit === null ? null : h("span", { class: "usage-seg" }, `缓存 ${hit}%`),
    totalText ? h("span", { class: "usage-seg" }, totalText) : null,
    balance
      ? h(
          "span",
          { class: "usage-seg usage-balance", title: balance.title },
          balance.text,
        )
      : null,
    balance?.canRefresh
      ? h(
          "button",
          {
            class: "usage-refresh",
            title: "刷新余额（60 秒内缓存直接返回；手动刷新强制重查）",
            disabled: state.balance?.balance.state === "loading",
            onClick: props.onRefreshBalance,
          },
          "刷新",
        )
      : null,
  );
}

/** 状态行（PLAN §7.2 风险 5：CLI 冷启动最长 90s，等待期显示计时缓解焦虑） */
function StatusLine(props: { state: ChatState }): VNode<any> {
  const [, setTick] = useState(0);
  const waiting = props.state.turnStatus === "waiting";

  useEffect(() => {
    if (!waiting) {
      return;
    }
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  let text: string;
  if (waiting) {
    const since = props.state.waitingSince ?? Date.now();
    const elapsed = Math.max(0, Math.round((Date.now() - since) / 1000));
    text = `等待 claude CLI 首个响应…（冷启动最长可达 90 秒，已等待 ${elapsed} 秒）`;
  } else {
    text = props.state.statusDetail || "就绪";
  }
  return h("div", { class: "status" }, text);
}

/**
 * 发送键判定入参：只取用到的字段 → node 侧单测可传普通对象，无需真 KeyboardEvent。
 */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  /** IME 候选态：为 true 时这次按键属于输入法，不是用户「敲了回车」 */
  isComposing: boolean;
  /** 老式 IME 信号：229 = 「本键已被输入法消费」（真回车恒为 13） */
  keyCode: number;
}

/**
 * 发送键判定：Enter（不带 Shift）且**不在 IME 候选态**。
 * 为什么两条都留：`isComposing` 是 DOM 标准信号，Gecko 在「候选词上屏」的那次 Enter 上置 true，
 * 只看 key 会把「选词」当成「发送」（Windows 微软拼音等中文输入法高发）；`keyCode === 229` 是
 * IME 消费按键的老式信号，个别输入法/旧路径只给 229 而不置 isComposing，作兜底。真回车恒为 13，
 * 不会误伤正常发送。
 */
export function isSendEnter(e: SendKeyEvent): boolean {
  return (
    e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229
  );
}

/**
 * R7-J：粘贴的 File → 待发送附件（安全修后**只走字节**）。粘贴没有宿主选择器凭据，
 * 只能把内容读成 base64 给宿主；页面里就算能拿到 `path`/`mozFullPath` 也**不读**——
 * 客户端路径不参与协议（宿主只认 token 与字节）。FileReader 读不出内容 → 不带字节发出，
 * 由宿主按「缺少内容」拒绝并回人话原因。
 */
async function filesToByteAttachments(
  files: ArrayLike<File> | null | undefined,
): Promise<PendingAttachment[]> {
  const list = Array.from(files ?? []);
  const out: PendingAttachment[] = [];
  for (const file of list) {
    const base64 = await new Promise<string>((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const data = String(reader.result ?? "");
          resolve(data.slice(data.indexOf(",") + 1));
        };
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      } catch {
        resolve("");
      }
    });
    out.push(
      pendingAttachment({
        name: file.name,
        sizeBytes: file.size,
        ...(base64 ? { base64 } : {}),
      }),
    );
  }
  return out;
}

/**
 * `@` 提及语境判定（纯函数，App 内用）：值 + 光标位置 → 「正在提及谁」。
 * 语境 = 光标前最近的 `@` 前面是行首/空白，且它与光标之间没有空白或第二个 `@`。
 */
export function mentionTokenAt(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, Math.max(0, caret));
  const at = before.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null; // 邮箱 mid@ 之类不算提及语境
  }
  const query = before.slice(at + 1);
  if (/[\s@]/.test(query)) {
    return null;
  }
  return { query, start: at };
}

/**
 * `/` 命令语境判定（R7-C，纯函数）：光标前的当前 token 以 `/` 开头且还没输入空白
 * （`/sum` 算、`/sum foo` 不算——参数阶段不该继续弹命令面板；`http://x` 也不算）。
 */
export function commandTokenAt(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, Math.max(0, caret));
  const m = before.match(/(?:^|\s)\/([^\s/]*)$/);
  if (!m) {
    return null;
  }
  return { query: m[1], start: before.length - m[1].length - 1 };
}

function InputBox(props: {
  disabled: boolean;
  turnStatus: ChatState["turnStatus"];
  /** 记录-06：被 SESSION_BUSY 拒的那条正在自动重发（输入区提示「上一轮收尾中…」） */
  retrying: boolean;
  /** SESSION_BUSY 重试用尽后要还回的原文（记录-06 兜底） */
  restoreDraft: string | null;
  /** ↑/↓ 翻的那份历史按会话分桶，换会话即换桶（见 lib/inputHistory.ts） */
  sessionId: string | null;
  /** 宿主推来的当前会话输入历史（ChatState.inputHistory；面板重载后的载入路径） */
  hostHistory: { sessionId: string; entries: string[] } | null;
  onDraftConsumed: () => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** R7-B：@ 提及面板与 chips 状态（归约在 lib/mentionPicker.ts） */
  mention: MentionPickerState;
  onMentionQuery: (query: string) => void;
  onMentionClose: () => void;
  onMentionSelect: (item: MentionSearchItem) => void;
  onMentionRemove: (itemKey: string) => void;
  onMentionActive: (index: number) => void;
  /** R7-C：/ 命令面板（清单来自宿主；关键词过滤在前端本地） */
  commands: CommandPickerState;
  /** R7-C：选中命令后要插进输入框的骨架文本（消费后清标记） */
  composerInsert: string | null;
  onCommandsOpen: () => void;
  onCommandsQuery: (query: string) => void;
  onCommandsClose: () => void;
  onCommandsActive: (index: number) => void;
  onCommandsSelect: (cmd: CommandEntry) => void;
  onComposerInsertConsumed: () => void;
  /** R7-J：附件 chips（粘贴/「选择文件」进来的；可删，编辑态可增） */
  attachments: AttachmentChipsState;
  onAttachAdd: (files: PendingAttachment[]) => void;
  onAttachRemove: (id: string) => void;
  /** R7-J 安全修：「📎 附件」→ 请宿主弹原生选择器（路径只在宿主侧，chip 由回执带来） */
  onPickAttachments: () => void;
  /** R7-D：范围选择（+ 范围按钮 / chip） */
  scope: ScopePickerState;
  onScopeOpen: () => void;
  onScopeRequest: (kind: "collection" | "selection") => void;
  onScopeClose: () => void;
  onScopeClear: () => void;
}): VNode<any> {
  const [text, setText] = useState("");
  // 本会话的历史桶（entries + 游标 + 暂存草稿）。渲染期同步收敛：sessionId 变了就重载，
  // 游标随之复位到非历史态；没变则原样返回在途实例（不重读存储）。
  const histRef = useRef<HistoryBucket>({
    sid: props.sessionId,
    h: emptyInputHistory(),
  });
  histRef.current = historyForSession(histRef.current, props.sessionId);
  // 宿主到达的历史（面板重载后的载入路径）：只并本会话那份、且幂等（内容不变不换对象）——
  // 渲染期反复调用不会自激，也不会把正在翻的那条拽走（判据都在 mergeHostEntries 里）
  if (props.hostHistory && props.hostHistory.sessionId === props.sessionId) {
    histRef.current = mergeHostEntries(
      histRef.current,
      props.hostHistory.entries,
    );
  }

  // 恢复草稿：layout 阶段同步写回（与 BUG-19 同款理由——passive effect 走 after-paint 调度，
  // 用户在这段窗口里看到的仍是空输入框，可能已经重新敲字了）
  useLayoutEffect(() => {
    if (props.restoreDraft !== null) {
      setText(props.restoreDraft);
      props.onDraftConsumed();
    }
    // 依赖只取草稿值：onDraftConsumed 每次渲染都是新函数，进依赖会自激循环
  }, [props.restoreDraft]);

  // R7-C：命令骨架文本 / R7-F：编辑回填 —— 都走 composerInsert 通道（同一回填时机）
  useLayoutEffect(() => {
    if (props.composerInsert !== null) {
      setText(props.composerInsert);
      props.onComposerInsertConsumed();
    }
    // 依赖只取插入值（回调每次渲染都是新函数，进依赖会自激循环）
  }, [props.composerInsert]);

  const doSend = (): void => {
    if (props.disabled || !text.trim()) {
      return;
    }
    props.onSend(text);
    setText("");
    // 发出去的原文进历史（最新在末尾、相邻重复只留一份），游标复位到非历史态
    const h = recordSent(histRef.current.h, text);
    histRef.current = { sid: props.sessionId, h };
    saveInputHistory(props.sessionId, h);
  };

  // ---- R7-B：@ 提及（面板跟随输入框；Esc 关闭；↑↓ 选、回车选中）----
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mention = props.mention;

  /** 输入后同步提及语境：在 `@` 语境里发检索，离开就收面板 */
  const syncMention = (value: string, caret: number): void => {
    const token = mentionTokenAt(value, caret);
    if (token) {
      props.onMentionQuery(token.query);
    } else if (mention.open) {
      props.onMentionClose();
    }
  };

  /** 选中候选：加 chip、把输入框里的 `@关键词` 片段摘掉、光标落回原位 */
  const pickMention = (item: MentionSearchItem): void => {
    props.onMentionSelect(item);
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const token = mentionTokenAt(text, caret);
    if (!token) {
      return;
    }
    const nextText = text.slice(0, token.start) + text.slice(caret);
    setText(nextText);
    const pos = token.start;
    // 光标复位要等一次渲染（textarea 的 value 由 Preact 写回）；用 setTimeout 而非 rAF：
    // 隐藏窗口下 rAF 不派发（BUG-19 现场）
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    }, 0);
  };

  // ---- R7-C：/ 命令面板（与 @ 面板同一套交互；本地命令选中即执行、CLI 命令插骨架）----
  const commands = props.commands;

  /** 输入后同步命令语境：在 `/命令` 语境里过滤候选，离开就收面板 */
  const syncCommands = (value: string, caret: number): void => {
    const token = commandTokenAt(value, caret);
    if (token) {
      if (!commands.open) {
        props.onCommandsOpen();
      }
      props.onCommandsQuery(token.query);
    } else if (commands.open) {
      props.onCommandsClose();
    }
  };

  /** 选中一条命令：本地命令面板直接执行（不插文本）；自定义命令插 `/名字 ` 骨架 */
  const pickCommand = (cmd: CommandEntry): void => {
    props.onCommandsSelect(cmd);
    if (cmd.source === "local") {
      return; // 本地命令由面板直接执行（头部裁决 3：不往输入框插文本）
    }
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const token = commandTokenAt(text, caret);
    const skeleton = `/${cmd.name} `;
    const nextText = token
      ? text.slice(0, token.start) + skeleton + text.slice(caret)
      : skeleton;
    setText(nextText);
    const pos = token ? token.start + skeleton.length : skeleton.length;
    // 光标落到骨架末尾（等下一次渲染写回 value）；setTimeout 而非 rAF：隐藏窗口下 rAF 不派发
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // 命令面板展开时的键先归它所有（↑↓ 选项、回车选中、Esc 收起）
    if (commands.open && commands.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        props.onCommandsActive(commands.activeIndex + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        props.onCommandsActive(commands.activeIndex - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = commands.items[commands.activeIndex] ?? commands.items[0];
        if (cmd) {
          pickCommand(cmd);
        }
        return;
      }
    }
    if (commands.open && e.key === "Escape") {
      e.preventDefault();
      props.onCommandsClose();
      return;
    }
    // 提及面板展开时的键先归面板所有（↑↓ 选项、回车选中、Esc 收起）
    if (mention.open && mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        props.onMentionActive(mention.activeIndex + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        props.onMentionActive(mention.activeIndex - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = mention.items[mention.activeIndex] ?? mention.items[0];
        if (item) {
          pickMention(item);
        }
        return;
      }
    }
    if (mention.open && e.key === "Escape") {
      e.preventDefault();
      props.onMentionClose();
      return;
    }
    if (isSendEnter(e)) {
      e.preventDefault();
      doSend();
      return;
    }
    // ↑/↓ 翻历史：判据与迁移都在 applyHistoryKey 里（返回 null = 交给浏览器默认行为：
    // 多行文本的行间移动、IME 选词、Shift 选区、已到最老一条 / 非历史态的 ↓）
    const el = e.target as HTMLTextAreaElement;
    const move = applyHistoryKey(
      e,
      el.value,
      { start: el.selectionStart, end: el.selectionEnd },
      histRef.current.h,
    );
    if (move === null) {
      return;
    }
    e.preventDefault();
    histRef.current = { sid: props.sessionId, h: move.history };
    setText(move.text);
  };

  const scopeChip = props.scope.chip;
  return h(
    "div",
    { class: "input-wrap" },
    // R7-D：范围 chip（`分类名 · N 篇`；截断时标注）+ 「+ 范围」入口
    h(
      "div",
      { class: "chips", "data-testid": "scope-chips" },
      scopeChip
        ? h(
            "span",
            {
              class: "chip chip-scope",
              title: `${scopeChip.label}（${scopeChip.count} 篇${scopeChip.truncated ? "，已截断至 40 篇" : ""}）`,
            },
            h(
              "span",
              { class: "chip-text" },
              `${scopeChip.label} · ${scopeChip.count} 篇${scopeChip.truncated ? "（已截断至 40 篇）" : ""}`,
            ),
            h(
              "button",
              {
                class: "chip-x",
                "aria-label": `移除范围 ${scopeChip.label}`,
                onClick: props.onScopeClear,
              },
              "×",
            ),
          )
        : null,
      h(
        "button",
        {
          class: "scope-btn-add",
          title:
            "按范围注入：当前分类全部 / 我在书库选中的 N 条（先给清单，Claude 需要时自己读）",
          onClick: props.onScopeOpen,
        },
        "+ 范围",
      ),
      props.scope.open
        ? h(
            "span",
            { class: "scope-picker", "data-testid": "scope-picker" },
            h(
              "button",
              {
                class: "scope-opt",
                onClick: () => props.onScopeRequest("collection"),
              },
              "当前分类全部",
            ),
            h(
              "button",
              {
                class: "scope-opt",
                onClick: () => props.onScopeRequest("selection"),
              },
              "我在书库选中的",
            ),
            h(
              "button",
              { class: "scope-opt", onClick: props.onScopeClose },
              "取消",
            ),
          )
        : null,
    ),
    // R7-J：附件 chips（图标 + 文件名 + 大小 + 删除；粘贴/「选择文件」进来的）
    h(
      "div",
      { class: "chips", "data-testid": "attachment-chips" },
      ...props.attachments.items.map((att) =>
        h(
          "span",
          {
            class: "chip chip-attach",
            title: `${att.name}（${formatAttachmentSize(att.sizeBytes)}）`,
          },
          h(
            "span",
            { class: "chip-icon" },
            isImageAttachment(att.name) ? "🖼" : "📄",
          ),
          h("span", { class: "chip-text" }, att.name),
          h(
            "span",
            { class: "chip-size" },
            formatAttachmentSize(att.sizeBytes),
          ),
          h(
            "button",
            {
              class: "chip-x",
              "aria-label": `移除附件 ${att.name}`,
              onClick: () => props.onAttachRemove(att.id),
            },
            "×",
          ),
        ),
      ),
      h(
        "button",
        {
          class: "attach-btn",
          "data-testid": "attachment-pick",
          title:
            "选择文件作为附件（宿主弹原生选择器；也可以直接粘贴截图/文件）",
          onClick: () => props.onPickAttachments(),
        },
        "📎 附件",
      ),
      props.attachments.notice
        ? h("span", { class: "chip-notice" }, props.attachments.notice)
        : null,
    ),
    // R7-B：chips（本轮点名的文献；缺失的标红——发送时宿主会跳过并提示）
    mention.chips.length > 0
      ? h(
          "div",
          { class: "chips", "data-testid": "mention-chips" },
          ...mention.chips.map((chip) => {
            const missing =
              mention.refs?.find((r) => r.itemKey === chip.itemKey)?.missing ===
              true;
            return h(
              "span",
              {
                class: missing ? "chip chip-missing" : "chip",
                title: missing
                  ? `${chip.title}（已找不到该条目，发送时会跳过）`
                  : chip.title,
              },
              h("span", { class: "chip-text" }, chip.title),
              h(
                "button",
                {
                  class: "chip-x",
                  "aria-label": `移除 ${chip.title}`,
                  onClick: () => props.onMentionRemove(chip.itemKey),
                },
                "×",
              ),
            );
          }),
          mention.notice
            ? h("span", { class: "chip-notice" }, mention.notice)
            : null,
        )
      : null,
    // R7-B：检索面板（跟随输入框；无结果给文案，不显示空白下拉）
    mention.open
      ? h(
          "div",
          { class: "mention-panel", "data-testid": "mention-panel" },
          mention.items.length > 0
            ? mention.items.map((item, index) =>
                h(
                  "div",
                  {
                    class:
                      index === mention.activeIndex
                        ? "mention-item active"
                        : "mention-item",
                    title: item.title,
                    onMouseDown: (e: Event) => {
                      e.preventDefault(); // 别让 textarea 先失焦（否则光标位置判断落空）
                      pickMention(item);
                    },
                  },
                  h("span", { class: "mention-title" }, item.title),
                  h(
                    "span",
                    { class: "mention-meta" },
                    [
                      item.creators?.[0] ?? "",
                      item.year ?? "",
                      item.publication ?? "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ),
                ),
              )
            : h(
                "div",
                { class: "mention-empty" },
                mention.status === "empty" ? "无结果" : "检索中…",
              ),
        )
      : null,
    // R7-C：命令面板（本地命令在上、自定义命令在下；`/名字` + 一行说明）
    commands.open
      ? h(
          "div",
          {
            class: "mention-panel command-panel",
            "data-testid": "command-panel",
          },
          commands.items.length > 0
            ? commands.items.map((cmd, index) =>
                h(
                  "div",
                  {
                    class:
                      index === commands.activeIndex
                        ? "mention-item active"
                        : "mention-item",
                    title: cmd.description || cmd.name,
                    onMouseDown: (e: Event) => {
                      e.preventDefault(); // 别让 textarea 先失焦（光标位置判断靠它）
                      pickCommand(cmd);
                    },
                  },
                  h(
                    "span",
                    { class: "mention-title" },
                    `/${cmd.name}`,
                    cmd.source === "local"
                      ? h("span", { class: "command-tag" }, "本地")
                      : h(
                          "span",
                          { class: "command-tag" },
                          cmd.source === "project" ? "项目" : "用户",
                        ),
                  ),
                  h("span", { class: "mention-meta" }, cmd.description),
                ),
              )
            : h(
                "div",
                { class: "mention-empty" },
                commands.status === "empty" ? "无匹配命令" : "加载中…",
              ),
        )
      : null,
    h(
      "div",
      { class: "input-row" },
      props.turnStatus !== "idle"
        ? h(
            "button",
            {
              class: "interrupt",
              onClick: props.onInterrupt,
              disabled: props.turnStatus === "interrupting",
            },
            props.turnStatus === "interrupting" ? "中断中…" : "中断",
          )
        : null,
      h("textarea", {
        class: "input",
        ref: taRef,
        placeholder: props.retrying
          ? "上一轮收尾中…（自动重发中）"
          : props.disabled
            ? "进行中的 turn 未结束…"
            : "向 Claude 提问…（Enter 发送，Shift+Enter 换行，↑↓ 翻历史，@ 引用文献）",
        value: text,
        onInput: (e: Event) => {
          const el = e.target as HTMLTextAreaElement;
          setText(el.value);
          syncMention(el.value, el.selectionStart ?? el.value.length);
        },
        // R7-J：粘贴 —— 剪贴板里的图片/文件变附件 chip（只读字节；纯文本粘贴照旧走默认行为）
        onPaste: (e: ClipboardEvent) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length === 0) {
            return;
          }
          e.preventDefault(); // 别把图片当成文本/文件名插进输入框
          void filesToByteAttachments(files).then(props.onAttachAdd);
        },
        onKeyDown,
        disabled: props.disabled,
        rows: 2,
      }),
      h(
        "button",
        {
          class: "send",
          onClick: doSend,
          disabled: props.disabled || !text.trim(),
        },
        "发送",
      ),
    ),
  );
}

/**
 * R7-A：指令编辑器弹层（面板内，不新开窗口）。
 * 内容：作用域切换（全局 / 当前分类）→ 路径小字 → 等宽 textarea → 字符计数 → 保存/关闭。
 * 状态文案：加载中 / 尚未创建（保存即创建）/ 已保存（下一轮生效）/ 错误原文；脏标记由 App 二次确认。
 */
function InstructionsOverlay(props: {
  editor: InstructionsEditorState;
  workspaceMode: "single" | "collection";
  onScope: (scope: InstructionScope) => void;
  onEdit: (text: string) => void;
  onSave: () => void;
  onClose: () => void;
}): VNode<any> {
  const ed = props.editor;
  const overLimit = ed.text.length > INSTRUCTIONS_MAX_CHARS;
  const count = `${ed.text.length} / ${INSTRUCTIONS_MAX_CHARS}`;
  let stateText: string | null = null;
  if (ed.status === "loading") {
    stateText = "加载中…";
  } else if (ed.status === "saved") {
    stateText = "已保存（下一轮生效）";
  } else if (ed.status === "error") {
    stateText = ed.error ?? "出错了";
  } else if (!ed.exists) {
    stateText = "尚未创建，保存即创建";
  }
  return h(
    "div",
    { class: "overlay", "data-testid": "instructions-overlay" },
    h(
      "div",
      { class: "overlay-card" },
      h(
        "div",
        { class: "overlay-head" },
        h("span", { class: "overlay-title" }, "项目指令（CLAUDE.md）"),
        h(
          "button",
          { class: "overlay-close", onClick: props.onClose, title: "关闭" },
          "×",
        ),
      ),
      h(
        "div",
        { class: "overlay-scopes" },
        h(
          "button",
          {
            class: ed.scope === "global" ? "scope-btn on" : "scope-btn",
            onClick: () => props.onScope("global"),
          },
          "全局（工作区根）",
        ),
        h(
          "button",
          {
            class: ed.scope === "collection" ? "scope-btn on" : "scope-btn",
            onClick: () => props.onScope("collection"),
            // single 模式下没有分类目录可归属（PLAN §2 表格）→ 禁用并说明
            disabled: props.workspaceMode !== "collection",
            title:
              props.workspaceMode === "collection"
                ? "当前分类目录（仅对本分类下的文献生效）"
                : "当前是「单一工作区」模式：没有分类目录。到设置页切到「按分类分工作区」后可用",
          },
          "当前分类",
        ),
      ),
      h(
        "div",
        { class: "overlay-path", title: ed.path ?? "" },
        ed.path ?? "（路径未知）",
      ),
      // PLAN §4：回落/降级必须让用户看见（例如「当前分类」无分类可归属 → 编的是根指令）
      ed.notice ? h("div", { class: "overlay-notice" }, ed.notice) : null,
      h("div", { class: "overlay-hint" }, INSTRUCTIONS_HINT),
      h("textarea", {
        class: "overlay-text",
        value: ed.text,
        spellcheck: false,
        placeholder:
          "写规则，不写资料。例：\n- 用中文回答，结论先行\n- 引用原文时给出页码",
        onInput: (e: Event) =>
          props.onEdit((e.target as HTMLTextAreaElement).value),
      }),
      h(
        "div",
        { class: "overlay-foot" },
        stateText
          ? h("span", { class: `overlay-state ${ed.status}` }, stateText)
          : null,
        h(
          "span",
          { class: overLimit ? "overlay-count over" : "overlay-count" },
          count,
        ),
        h(
          "button",
          {
            class: "overlay-save",
            onClick: props.onSave,
            disabled: ed.status === "loading" || overLimit,
          },
          "保存",
        ),
        h(
          "button",
          { class: "overlay-cancel", onClick: props.onClose },
          "关闭",
        ),
      ),
    ),
  );
}

/** 弹层提示文案（PLAN §2：说明这些是每轮加载的项目指令，根与分类会叠加） */
const INSTRUCTIONS_HINT =
  "这些是每轮都会加载的项目指令，写规则不写资料；根目录与分类目录的指令会叠加生效。";
