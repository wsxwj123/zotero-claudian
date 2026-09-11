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

mermaid 块（回合结束后渲染成图；语法错则保留下面这段源码）：

\`\`\`mermaid
graph LR
    A[抓取] --> B{重复?}
    B -->|是| C[丢弃]
    B -->|否| D[入库]
\`\`\`

原生 svg 块（消毒后渲染；onload/script 一律剥掉）：

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60" width="200" height="60" onload="alert('svg-onload')">
  <script>alert('svg-script')</script>
  <rect x="1" y="1" width="198" height="58" rx="8" fill="#eef4ff" stroke="#3b6ea5" stroke-width="2"/>
  <text x="100" y="36" text-anchor="middle" font-size="14" fill="#1c3d5a">SVG 自检样本</text>
</svg>

围栏里的 svg（AI 的真实习惯：包在 \`\`\`html 里。整块只有一幅 svg → 同样渲染）：

\`\`\`html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40" width="200" height="40">
  <rect x="1" y="1" width="198" height="38" rx="6" fill="#eaf7ee" stroke="#2f8f4e" stroke-width="2"/>
  <text x="100" y="26" text-anchor="middle" font-size="13" fill="#1c5a33">围栏内 SVG 样本</text>
</svg>
\`\`\`
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
      case "pickAttachments":
        // R7-J 安全修：真实宿主弹原生选择器（路径只在宿主侧）；mock 没有文件系统访问
        // → 回空列表，UI 收起等待态（不悬挂、也没有假路径可编）
        console.info(
          "[mockHost] pickAttachments → 原生选择器（mock 无文件访问，回空列表）",
        );
        post({ type: "attachmentsPicked", files: [] });
        break;
      case "openExternal":
        // dev 环境（file://）不真的开浏览器，仅打印核验拦截链路
        console.info("[mockHost] openExternal →", msg.url);
        break;
      // R7-A/R7-B：脱离 Zotero 开发时的最小假响应（真实实现全在宿主侧 Zotero 取数）
      case "readInstructions":
        post({
          type: "instructions",
          scope: msg.scope === "collection" ? "collection" : "global",
          path: "/mock/workspace/CLAUDE.md",
          text: "# mock 指令\n- 用中文回答\n",
          exists: true,
        });
        break;
      case "saveInstructions":
        post({
          type: "instructionsSaved",
          scope: msg.scope === "collection" ? "collection" : "global",
          ok: true,
          path: "/mock/workspace/CLAUDE.md",
        });
        break;
      case "searchItems":
        post({
          type: "itemSearchResult",
          query: typeof msg.query === "string" ? msg.query : "",
          items: [
            {
              itemKey: "MOCK1",
              title: "（mock）Attention Is All You Need",
              creators: ["Vaswani, Ashish"],
              year: "2017",
              publication: "NeurIPS",
              itemType: "conferencePaper",
            },
          ],
        });
        break;
      case "resolveRefs":
        post({
          type: "refsResolved",
          refs: (Array.isArray(msg.itemKeys) ? msg.itemKeys : []).map(
            (key: string) => ({
              itemKey: key,
              title: "（mock）Attention Is All You Need",
              creators: ["Vaswani, Ashish"],
              year: "2017",
              publication: "NeurIPS",
              doi: null,
              abstract: "mock 摘要",
              pdfPath: "/mock/storage/AAAA/paper.pdf",
              pdfDir: "/mock/storage/AAAA",
              attachmentKey: "AAAA",
            }),
          ),
        });
        break;
      // R7-C/R7-D：命令清单 / 工作区 / 导出 / 范围（mock 只回最小假数据）
      case "listCommands":
        post({
          type: "commandList",
          commands: [
            { name: "new", description: "新建会话", source: "local" },
            {
              name: "summarize",
              description: "（mock）总结当前文献",
              source: "project",
            },
          ],
        });
        break;
      case "resolveScope":
        post({
          type: "scopeResolved",
          kind: msg.kind === "collection" ? "collection" : "selection",
          label:
            msg.kind === "collection"
              ? "（mock）科学前言"
              : "（mock）我在书库选中的",
          items: [
            {
              itemKey: "MOCK1",
              title: "（mock）Attention Is All You Need",
              creators: ["Vaswani, Ashish"],
              year: "2017",
              publication: "NeurIPS",
              doi: null,
              abstract: "mock 摘要",
              pdfPath: "/mock/storage/AAAA/paper.pdf",
              pdfDir: "/mock/storage/AAAA",
              attachmentKey: "AAAA",
            },
          ],
          truncated: false,
        });
        break;
      case "openWorkspace":
        console.info("[mockHost] openWorkspace → /mock/workspace");
        break;
      case "openFullPage":
        console.info("[mockHost] openFullPage → 打开独立工作台标签页");
        break;
      case "exportSession":
        post({
          type: "sessionExported",
          ok: true,
          path: "/mock/workspace/exports/session.md",
        });
        break;
      default:
        break; // permissionResponse / saveNote 等：M6/M7 域，mock 不处理
    }
  });

  // 宿主先发握手（模拟 browser load 事件的 init）
  window.postMessage({ type: "init" } satisfies HostMessage, "*");
}
