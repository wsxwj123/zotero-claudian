// 开发期 mock 宿主 —— 页面内模拟真实宿主（INTERFACE §4.6 消息形态），
// 经同一 postMessage 通道与 bridgeClient 交互，使 chat-ui 脱离 Zotero 独立可跑。
// 仅在非 chrome:// 环境或 ?mock=1 时由 BridgeClient 挂载；不做真实 CLI 接线（M4）。
// 演示脚本刻意包含 XSS 样本（<script> / javascript: 链接），用于在页面上人工核验消毒边界。
import type { HostMessage, StreamEvent, UiMessage } from "./types";

const MOCK_SESSION_ID = "mock-session";

const THINKING_TEXT = [
  "用户发来一条演示消息。",
  "我需要展示 thinking 折叠区在流式期间的行为：增量追加、完成后可折叠回看。",
  "真实场景下 CLI 冷启动可达 90 秒（PLAN §7.2 风险 5），状态行负责降低等待焦虑。",
];

const ANSWER_MARKDOWN = `## Mock 流式回答

这是 **chat-ui** 的流式渲染演示：行内代码 \`renderMarkdown()\`、[外部链接（应经桥外部打开）](https://www.zotero.org)、以及表格：

| 文献 | 年份 |
| --- | --- |
| Zotero | 2006 |

\`\`\`python
def hello():
    print("zotero-claudian")
\`\`\`

XSS 自检（应被消毒：脚本不可见、坏链接降级为无 href 纯文本）：

<script>alert(1)</script>

[坏链接](javascript:alert(1))
`;

function chunkText(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

export function startMockHost(): void {
  let streaming = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  // M5 会话列表的页面内模拟：新建/切换/删除都在内存里走一遍，UI 交互可离线自测
  const sessions: { id: string; title: string; updatedAt: number }[] = [];
  let currentId = MOCK_SESSION_ID;
  let seq = 0;

  const post = (msg: HostMessage): void => {
    window.postMessage(msg, "*");
  };

  const postStream = (event: StreamEvent): void => {
    post({ type: "streamEvent", sessionId: currentId, event });
  };

  const clearTimers = (): void => {
    for (const t of timers) {
      clearTimeout(t);
    }
    timers = [];
  };

  const schedule = (delayMs: number, fn: () => void): void => {
    timers.push(setTimeout(fn, delayMs));
  };

  /** 脚本化一轮 turn：init → thinking → 文本流 → 工具卡 → 校准 → result */
  const runTurn = (userText: string): void => {
    streaming = true;
    let delay = 1200; // 模拟冷启动等待，让 waiting 状态行可见
    const step = (ms: number, fn: () => void): void => {
      delay += ms;
      schedule(delay, fn);
    };

    step(0, () =>
      postStream({
        kind: "init",
        claudeSessionId: "mock-claude-session",
        model: "mock-model",
        permissionMode: "acceptEdits",
        tools: ["Bash", "Read"],
        mcpServers: ["claudian-perm"],
      }),
    );
    step(100, () => postStream({ kind: "messageStart" }));

    // thinking 折叠区
    for (const piece of THINKING_TEXT) {
      step(400, () =>
        postStream({ kind: "thinkingDelta", index: 0, text: piece }),
      );
    }

    // 正文流式（markdown 按 24 字符粒度增量）
    step(300, () => postStream({ kind: "textBlockStart", index: 1 }));
    for (const piece of chunkText(ANSWER_MARKDOWN, 24)) {
      step(90, () => postStream({ kind: "textDelta", index: 1, text: piece }));
    }

    // 工具卡（Bash）
    step(200, () =>
      postStream({
        kind: "toolBlockStart",
        index: 2,
        toolName: "Bash",
        toolUseId: "tu-mock-1",
      }),
    );
    for (const piece of chunkText(
      JSON.stringify({ command: "python -V", description: "check python" }),
      12,
    )) {
      step(70, () =>
        postStream({ kind: "toolInputDelta", index: 2, jsonFragment: piece }),
      );
    }
    step(300, () =>
      postStream({
        kind: "toolResult",
        toolUseId: "tu-mock-1",
        isError: false,
        summary: "Python 3.12.4",
      }),
    );

    // 最终校准 + result（content[] 下标与 content_block index 一致：0=thinking 1=text 2=tool_use）
    step(300, () =>
      postStream({
        kind: "assistantMessage",
        content: [
          { type: "thinking", thinking: THINKING_TEXT.join(" ") },
          { type: "text", text: ANSWER_MARKDOWN },
          {
            type: "tool_use",
            id: "tu-mock-1",
            name: "Bash",
            input: { command: "python -V", description: "check python" },
          },
        ],
      }),
    );
    step(200, () => {
      postStream({
        kind: "result",
        claudeSessionId: "mock-claude-session",
        costUsd: 0.0042,
        durationMs: delay,
        numTurns: 1,
      });
      void userText;
      streaming = false;
    });
  };

  const sessionList = (): void => {
    post({
      type: "sessionList",
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        itemKey: null,
        claudeSessionId: null,
        itemTitle: null,
      })),
    });
  };

  /** 无会话时按 send 自动建（与宿主同语义）；返回当前会话 id */
  const ensureSession = (title: string): string => {
    let current = sessions.find((s) => s.id === currentId);
    if (!current) {
      current = {
        id: `mock-${++seq}`,
        title: title.slice(0, 40),
        updatedAt: Date.now(),
      };
      sessions.unshift(current);
      currentId = current.id;
      sessionList();
    } else if (!current.title) {
      current.title = title.slice(0, 40);
    }
    return current.id;
  };

  sessions.push({
    id: MOCK_SESSION_ID,
    title: "Mock 演示会话",
    updatedAt: Date.now(),
  });

  window.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as UiMessage | null;
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof msg.type !== "string"
    ) {
      return;
    }
    switch (msg.type) {
      case "hello":
        sessionList();
        break;
      case "send":
        if (streaming) {
          post({
            type: "error",
            code: "SESSION_BUSY",
            message: "进行中的 turn 未结束（演示并发契约）",
            sessionId: currentId,
          });
          return;
        }
        ensureSession(msg.text);
        runTurn(msg.text);
        break;
      case "interrupt":
        if (streaming) {
          clearTimers();
          streaming = false;
          postStream({
            kind: "result",
            claudeSessionId: "mock-claude-session",
            costUsd: 0,
            durationMs: 0,
            numTurns: 1,
          });
        }
        break;
      case "getHistory":
        post({
          type: "history",
          sessionId: msg.sessionId,
          messages: [
            {
              role: "user",
              text: "（mock 历史）上一轮的问题",
              ts: Date.now() - 60000,
            },
            {
              role: "assistant",
              text: "（mock 历史）上一轮的回答。",
              ts: Date.now() - 59000,
            },
          ],
        });
        break;
      case "createSession": {
        const created = {
          id: `mock-${++seq}`,
          title: "",
          updatedAt: Date.now(),
        };
        sessions.unshift(created);
        currentId = created.id;
        sessionList();
        break;
      }
      case "deleteSession": {
        const i = sessions.findIndex((s) => s.id === msg.sessionId);
        if (i >= 0) {
          sessions.splice(i, 1);
          if (currentId === msg.sessionId) {
            currentId = sessions[0]?.id ?? MOCK_SESSION_ID;
          }
          sessionList();
        }
        break;
      }
      case "getState":
        sessionList();
        break;
      case "openExternal":
        // dev 环境（file://）不真的开浏览器，仅打印核验拦截链路
        console.info("[mockHost] openExternal →", msg.url);
        break;
      default:
        break; // permissionResponse / saveNote 等：M6/M7 域，mock 不处理
    }
  });

  // 宿主先发握手（模拟 browser load 事件的 init）
  window.postMessage({ type: "init" } satisfies HostMessage, "*");
}
