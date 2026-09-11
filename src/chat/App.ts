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
  bypassOptionClick,
  cancelNotePicker,
  CLAUDE_INSTALL_URL,
  consumeDraft,
  currentSessionUsage,
  deleteSession,
  dismissError,
  fireRetry,
  formatBalance,
  initialChatState,
  interrupt,
  isPermissionMode,
  notePickerSelect,
  PERMISSION_MODE_OPTIONS,
  permissionRespond,
  reduceHostMessage,
  renameSession,
  RETRY_DELAY_MS,
  selectSession,
  setPermissionMode,
  startBalanceRefresh,
  userSend,
} from "./lib/chatModel";
import type {
  BypassConfirmState,
  ChatState,
  PermissionMode,
} from "./lib/chatModel";
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
    h(Header, { state, onChangeMode, onRefreshBalance }),
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
      sessionId: state.sessionId,
      hostHistory: state.inputHistory,
      onDraftConsumed: () => props.store.set(consumeDraft(props.store.get())),
      onSend,
      onInterrupt,
    }),
  );
}

function Header(props: {
  state: ChatState;
  onChangeMode: (mode: PermissionMode) => void;
  onRefreshBalance: () => void;
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

  const onKeyDown = (e: KeyboardEvent): void => {
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
          : "向 Claude 提问…（Enter 发送，Shift+Enter 换行，↑↓ 翻历史）",
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
