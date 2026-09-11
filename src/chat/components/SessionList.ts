// 会话列表（M5 起，R7-K 重组 PLAN-R7 §3.12）——四区：置顶 → 当前文献 →「全部会话」抽屉 → 归档。
// 用户诉求「文献一多、会话一多，现在的样式会显的很乱」：默认只显示当前文献的会话，
// 其余收进抽屉（按合集分组折叠）、老会话进归档（默认隐藏、可搜）、常用会话可置顶（不限量）。
// 分区/排序/搜索/归档全是纯投影（lib/sessionList.ts，有单测）——本组件只管渲染与交互。
// 删除走两步确认；点别的会话/新建即自动解除待删状态；改名就地输入（回车提交 / Esc 取消 / 失焦提交）。
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  formatSessionTime,
  sessionLabel,
  type ChatState,
} from "../lib/chatModel";
import { buildSessionList, type SessionListRow } from "../lib/sessionList";
import type { SessionSummary } from "../lib/types";

export function SessionList(props: {
  state: ChatState;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** 提交重命名（空标题/没改 → 归约层不发消息） */
  onRename: (title: string) => void;
  /** R7-K：置顶/取消置顶（集合存宿主 prefs，回执推 sessionList） */
  onTogglePin: (id: string) => void;
}): VNode<any> {
  const { sessions, sessionId, connected, creatingSession } = props.state;
  // 待删 id 存在本地：与当前绑定会话不一致时自然失效，无需定时器（重命名同法）
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  /** 已显式展开的**分支**（默认只展开一层，展开的第二层才出 depth 2）；点行上的 ▶/▼ 切 */
  const [expanded, setExpanded] = useState<string[]>([]);
  // 提交/取消只生效一次：Enter 提交后卸载输入框可能再触发 blur，别把同一次改名发两遍
  const doneRef = useRef(false);
  const cancelledRef = useRef(false);
  const pending = pendingId !== null && pendingId === sessionId;
  const renaming = renamingId !== null && renamingId === sessionId;

  const model = buildSessionList({
    sessions,
    currentItemKey: props.state.readerContext?.itemKey ?? null,
    pinned: props.state.pinnedSessions,
    expanded,
    query,
    showArchive: archiveOpen,
  });

  const known = new Set(sessions.map((s) => s.id));
  const pinnedSet = new Set(
    props.state.pinnedSessions.filter((id) => known.has(id)),
  );

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

  const rowOf = (row: SessionListRow<SessionSummary>): VNode<any> => {
    const active = row.id === sessionId;
    const pinned = pinnedSet.has(row.id);
    const hasChildren = sessions.some((s) => s.parentId === row.id);
    return h(
      "div",
      {
        key: row.id,
        class: `session-row${active ? " active" : ""}`,
        "data-testid": "session-row",
        "data-depth": String(row.depth),
        "data-pinned": pinned ? "1" : "0",
        "data-session-id": row.id,
        title: sessionTip(row),
      },
      row.depth > 0
        ? h("span", { class: "session-indent" }, "　".repeat(row.depth) + "└ ")
        : null,
      hasChildren
        ? h(
            "button",
            {
              class: "session-branch-toggle",
              "aria-label": expanded.includes(row.id) ? "收起分支" : "展开分支",
              onClick: () =>
                setExpanded((prev) =>
                  prev.includes(row.id)
                    ? prev.filter((x) => x !== row.id)
                    : [...prev, row.id],
                ),
            },
            expanded.includes(row.id) ? "▾" : "▸",
          )
        : null,
      h(
        "button",
        {
          class: "session-label",
          onClick: () => props.onSelect(row.id),
        },
        sessionLabel(row, sessions),
      ),
      h(
        "span",
        { class: "session-time" },
        row.updatedAt ? formatSessionTime(row.updatedAt) : "",
      ),
      h(
        "button",
        {
          class: `session-pin${pinned ? " on" : ""}`,
          "aria-label": pinned ? "取消置顶" : "置顶",
          title: pinned ? "取消置顶" : "置顶（不限量、不受归档影响）",
          onClick: () => props.onTogglePin(row.id),
        },
        pinned ? "★" : "☆",
      ),
    );
  };

  const section = (
    label: string,
    rows: SessionListRow<SessionSummary>[],
    extra?: VNode<any>,
  ): VNode<any> | null =>
    rows.length > 0 || extra
      ? h(
          "div",
          { class: "session-section", "data-testid": "session-section" },
          h("div", { class: "session-section-title" }, label),
          ...rows.map(rowOf),
          extra ?? null,
        )
      : null;

  const drawerRows = model.groups.length;
  const totalShown =
    model.pinned.length +
    model.current.length +
    model.archive.length +
    drawerRows;

  return h(
    "div",
    { class: "sessions" },
    // R7-K：搜索框（会话标题 + 文献题名，大小写不敏感、中文子串）
    h("div", { class: "session-toolbar" }, [
      h("input", {
        class: "session-search",
        type: "search",
        value: query,
        placeholder: "搜索会话 / 文献题名…",
        "data-testid": "session-search",
        onInput: (e: Event) => setQuery((e.target as HTMLInputElement).value),
      }),
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
    ]),
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
      : null,
    !connected && sessions.length === 0
      ? h("div", { class: "session-section-title" }, "等待连接…")
      : null,
    sessions.length === 0 && connected
      ? h("div", { class: "session-section-title" }, "（暂无会话）")
      : null,
    // 1) 置顶（不限量、不折叠、不受归档影响）
    section("置顶", model.pinned),
    // 2) 当前文献
    section("当前文献", model.current),
    // 3) 「全部会话」抽屉（按合集分组折叠）
    model.groups.length > 0 || archiveOpen
      ? h(
          "div",
          { class: "session-drawer", "data-testid": "session-drawer" },
          h(
            "button",
            {
              class: "session-drawer-toggle",
              "data-open": drawerOpen ? "1" : "0",
              onClick: () => setDrawerOpen((v) => !v),
            },
            `${drawerOpen ? "▾" : "▸"} 全部会话（${model.groups.reduce(
              (n, g) => n + g.rows.length,
              0,
            )}）`,
          ),
          drawerOpen
            ? model.groups.map((group) =>
                h(
                  "div",
                  {
                    key: group.label,
                    class: "session-group",
                    "data-testid": "session-group",
                    "data-label": group.label,
                  },
                  h(
                    "div",
                    { class: "session-group-title" },
                    `${group.label}（${group.rows.length}）`,
                  ),
                  ...group.rows.map(rowOf),
                ),
              )
            : null,
        )
      : null,
    // 4) 归档（默认隐藏；≥90 天未更新 或 近期窗口（50 条）之外；可搜索）
    h(
      "div",
      { class: "session-archive", "data-testid": "session-archive" },
      h(
        "button",
        {
          class: "session-archive-toggle",
          "data-open": archiveOpen ? "1" : "0",
          onClick: () => setArchiveOpen((v) => !v),
        },
        `归档（${model.archive.length}）${archiveOpen ? "▾" : "▸"}`,
      ),
      archiveOpen ? model.archive.map(rowOf) : null,
    ),
    totalShown === 0
      ? h("div", { class: "session-section-title" }, "没有匹配的会话")
      : null,
    query === "" && totalShown > 0
      ? h("div", { class: "session-hint" }, `共 ${sessions.length} 条会话`)
      : null,
  );
}

/** 悬浮提示：关联条目 + 创建时间 + 续接状态（claudeSessionId 为空 = CLI 侧尚无会话，下一轮起新会话） */
function sessionTip(s: SessionSummary): string {
  const parts = [
    s.itemTitle
      ? `文献 ${s.itemTitle}`
      : s.itemKey
        ? `关联条目 ${s.itemKey}`
        : "通用会话",
  ];
  parts.push(`创建于 ${formatSessionTime(s.createdAt ?? s.updatedAt)}`);
  parts.push(
    s.claudeSessionId ? "可续接上一轮上下文" : "首轮未完成（续接时为新会话）",
  );
  return parts.join("；");
}
