// 会话列表条（M5）——§4.6 sessionList / createSession / deleteSession 的 UI 侧。
// 用原生 <select> 做切换：没有自定义弹层的焦点/键盘坑，会话多时浏览器自带滚动。
// 删除走两步确认（删会话即丢旁挂历史，不可逆）；点别的会话/新建即自动解除待删状态。
import { h } from "preact";
import { useState } from "preact/hooks";
import type { VNode } from "preact";
import type { ChatState } from "../lib/chatModel";
import type { SessionSummary } from "../lib/types";

export function SessionList(props: {
  state: ChatState;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}): VNode<any> {
  const { sessions, sessionId, connected, creatingSession } = props.state;
  // 待删 id 存在本地：与当前绑定会话不一致时自然失效，无需定时器
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = pendingId !== null && pendingId === sessionId;

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

  return h(
    "div",
    { class: "sessions" },
    h(
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
        ? h("option", { value: "" }, connected ? "（暂无会话）" : "等待连接…")
        : sessions.map((s) =>
            h(
              "option",
              { key: s.id, value: s.id, title: sessionTip(s) },
              sessionLabel(s),
            ),
          ),
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

function sessionLabel(s: SessionSummary): string {
  const base = s.title || "新会话";
  return s.itemTitle ? `${s.itemTitle} · ${base}` : base;
}

/** 悬浮提示：关联条目 + 续接状态（claudeSessionId 为空 = CLI 侧尚无会话，下一轮起新会话） */
function sessionTip(s: SessionSummary): string {
  const parts = [s.itemKey ? `关联条目 ${s.itemKey}` : "通用会话"];
  parts.push(
    s.claudeSessionId ? "可续接上一轮上下文" : "首轮未完成（续接时为新会话）",
  );
  return parts.join("；");
}
