// 会话列表条（M5）——§4.6 sessionList / createSession / deleteSession / renameSession 的 UI 侧。
// 用原生 <select> 做切换：没有自定义弹层的焦点/键盘坑，会话多时浏览器自带滚动。
// 删除走两步确认（删会话即丢旁挂历史，不可逆）；点别的会话/新建即自动解除待删状态。
// 重命名（用户需求 2026-09-11）：点「改名」就地换成输入框，回车提交 / Esc 取消 / 失焦提交。
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  formatSessionTime,
  sessionLabel,
  type ChatState,
} from "../lib/chatModel";
import type { SessionSummary } from "../lib/types";

export function SessionList(props: {
  state: ChatState;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** 提交重命名（空标题/没改 → 归约层不发消息） */
  onRename: (title: string) => void;
}): VNode<any> {
  const { sessions, sessionId, connected, creatingSession } = props.state;
  // 待删 id 存在本地：与当前绑定会话不一致时自然失效，无需定时器（重命名同法）
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 提交/取消只生效一次：Enter 提交后卸载输入框可能再触发 blur，别把同一次改名发两遍
  const doneRef = useRef(false);
  const cancelledRef = useRef(false);
  const pending = pendingId !== null && pendingId === sessionId;
  const renaming = renamingId !== null && renamingId === sessionId;

  const onDeleteClick = (): void => {
    if (!sessionId) {
      return;
    }
    if (pending) {
      setPendingId(null);
      props.onDelete(sessionId);
      return;
    }
    setPendingId(sessionId);
  };

  const startRename = (): void => {
    if (!sessionId) {
      return;
    }
    const current = sessions.find((s) => s.id === sessionId);
    doneRef.current = false;
    cancelledRef.current = false;
    setDraft(current?.title ?? "");
    setRenamingId(sessionId);
  };

  const commitRename = (value: string): void => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    setRenamingId(null);
    props.onRename(value);
  };

  const cancelRename = (): void => {
    cancelledRef.current = true;
    setRenamingId(null);
  };

  return h(
    "div",
    { class: "sessions" },
    renaming
      ? h("input", {
          class: "session-rename-input",
          value: draft,
          title: "会话名：回车保存，Esc 取消",
          placeholder: "会话名（回车保存，Esc 取消）",
          onInput: (e: Event) => setDraft((e.target as HTMLInputElement).value),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          },
          // 失焦即提交（点别处不该白改一场）；Esc 已取消 / 已提交过就不再提交
          onBlur: (e: FocusEvent) => {
            if (!cancelledRef.current) {
              commitRename((e.target as HTMLInputElement).value);
            }
          },
          ref: (el: HTMLInputElement | null) => {
            if (el) {
              el.focus();
              el.select();
            }
          },
        })
      : h(
          "select",
          {
            class: "session-select",
            value: sessionId ?? "",
            disabled: !connected || sessions.length === 0,
            title: "切换会话",
            onChange: (e: Event) => {
              const id = (e.target as HTMLSelectElement).value;
              if (id && id !== sessionId) {
                props.onSelect(id);
              }
            },
          },
          sessions.length === 0
            ? h(
                "option",
                { value: "" },
                connected ? "（暂无会话）" : "等待连接…",
              )
            : sessions.map((s) =>
                h(
                  "option",
                  { key: s.id, value: s.id, title: sessionTip(s) },
                  sessionLabel(s, sessions),
                ),
              ),
        ),
    h(
      "button",
      {
        class: "session-rename",
        onClick: startRename,
        disabled: !connected || !sessionId || renaming,
        title: "重命名当前会话",
      },
      "改名",
    ),
    h(
      "button",
      {
        class: "session-new",
        onClick: props.onCreate,
        disabled: !connected || creatingSession,
        title: "新建会话（绑定当前阅读条目）",
      },
      creatingSession ? "新建中…" : "新建",
    ),
    h(
      "button",
      {
        class: `session-del${pending ? " confirm" : ""}`,
        onClick: onDeleteClick,
        disabled: !sessionId,
        title: "删除该会话（含本地历史记录，不影响 CLI 侧文件）",
      },
      pending ? "确认删除" : "删除",
    ),
  );
}

/** 悬浮提示：关联条目 + 创建时间 + 续接状态（claudeSessionId 为空 = CLI 侧尚无会话，下一轮起新会话） */
function sessionTip(s: SessionSummary): string {
  const parts = [s.itemKey ? `关联条目 ${s.itemKey}` : "通用会话"];
  parts.push(`创建于 ${formatSessionTime(s.createdAt)}`);
  parts.push(
    s.claudeSessionId ? "可续接上一轮上下文" : "首轮未完成（续接时为新会话）",
  );
  return parts.join("；");
}
