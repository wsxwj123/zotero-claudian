// 根组件 + 状态存储 + 状态行 + 输入框。
// 数据流：桥消息 → reduceHostMessage → store.set → 订阅者触发重渲染；
// UI 动作经 chatModel 纯函数（userSend/interrupt）归约后经桥发出。
import { h } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { VNode } from "preact";
import { MessageList } from "./components/MessageList";
import { PermissionCards } from "./components/PermissionCard";
import { SessionList } from "./components/SessionList";
import {
  beginCreateSession,
  beginNoteSave,
  cancelNotePicker,
  CLAUDE_INSTALL_URL,
  consumeDraft,
  deleteSession,
  dismissError,
  fireRetry,
  initialChatState,
  interrupt,
  isPermissionMode,
  notePickerSelect,
  permissionRespond,
  reduceHostMessage,
  renameSession,
  RETRY_DELAY_MS,
  selectSession,
  setPermissionMode,
  userSend,
} from "./lib/chatModel";
import type { ChatState, PermissionMode } from "./lib/chatModel";
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

  const busy = state.turnStatus !== "idle";

  const onSend = (text: string): void => {
    const r = userSend(props.store.get(), text);
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
    h(Header, { state, onChangeMode }),
    h(SessionList, {
      state,
      onSelect: onSelectSession,
      onCreate: onCreateSession,
      onDelete: (id: string) => props.bridge.send(deleteSession(id)),
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
      onOpenExternal: (url: string) =>
        props.bridge.send({ type: "openExternal", url }),
      // M7 笔记：md→HTML 在 MessageList 内做（renderMarkdown），这里只负责发桥消息
      canSaveNote: state.readerContext?.itemKey != null,
      notePicker: state.notePicker,
      onNoteSave: (turnIndex: number, html: string) => {
        const r = beginNoteSave(props.store.get(), turnIndex, html);
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
      onDraftConsumed: () => props.store.set(consumeDraft(props.store.get())),
      onSend,
      onInterrupt,
    }),
  );
}

function Header(props: {
  state: ChatState;
  onChangeMode: (mode: PermissionMode) => void;
}): VNode<any> {
  const ctx = props.state.readerContext;
  const parts: string[] = [];
  if (ctx?.title) {
    parts.push(ctx.title);
  }
  if (ctx && ctx.page != null) {
    parts.push(`第 ${ctx.page} 页`);
  }
  // F6：三档切换（PLAN §2「顶栏可切 default/acceptEdits/plan」）。值取最近一次 init 报告的档位；
  // 未知（未跑过 turn / 刚换会话）或非三档 → 显示占位项，绝不假装是 default。
  const mode = props.state.permissionMode;
  const selected = isPermissionMode(mode) ? mode : "";
  return h(
    "div",
    { class: "header" },
    h("span", { class: `dot ${props.state.connected ? "on" : "off"}` }),
    h(
      "span",
      { class: "header-title" },
      parts.length > 0 ? parts.join(" · ") : "Claude",
    ),
    h(
      "select",
      {
        class: "perm-mode",
        title: "权限档（下一轮生效）",
        value: selected,
        // 未绑定会话时宿主只会忽略（§4.6 setPermissionMode），禁用免得点了没反应
        disabled: props.state.sessionId === null,
        onChange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (isPermissionMode(v)) {
            props.onChangeMode(v);
          }
        },
      },
      selected === ""
        ? h("option", { value: "", disabled: true }, "权限档未知")
        : null,
      h("option", { value: "default" }, "默认"),
      h("option", { value: "acceptEdits" }, "接受编辑"),
      h("option", { value: "plan" }, "计划"),
    ),
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

function InputBox(props: {
  disabled: boolean;
  turnStatus: ChatState["turnStatus"];
  /** 记录-06：被 SESSION_BUSY 拒的那条正在自动重发（输入区提示「上一轮收尾中…」） */
  retrying: boolean;
  /** SESSION_BUSY 重试用尽后要还回的原文（记录-06 兜底） */
  restoreDraft: string | null;
  onDraftConsumed: () => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}): VNode<any> {
  const [text, setText] = useState("");

  // 恢复草稿：layout 阶段同步写回（与 BUG-19 同款理由——passive effect 走 after-paint 调度，
  // 用户在这段窗口里看到的仍是空输入框，可能已经重新敲字了）
  useLayoutEffect(() => {
    if (props.restoreDraft !== null) {
      setText(props.restoreDraft);
      props.onDraftConsumed();
    }
    // 依赖只取草稿值：onDraftConsumed 每次渲染都是新函数，进依赖会自激循环
  }, [props.restoreDraft]);

  const doSend = (): void => {
    if (props.disabled || !text.trim()) {
      return;
    }
    props.onSend(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return h(
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
      placeholder: props.retrying
        ? "上一轮收尾中…（自动重发中）"
        : props.disabled
          ? "进行中的 turn 未结束…"
          : "向 Claude 提问…（Enter 发送，Shift+Enter 换行）",
      value: text,
      onInput: (e: Event) => setText((e.target as HTMLTextAreaElement).value),
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
  );
}
