// chat-ui 页面入口：装消毒器 → 起桥（mock 可切换）→ 挂载 Preact。
import { render } from "preact";
import { h } from "preact";
import { App, ChatStore } from "./App";
import { BridgeClient, recordDiag, shouldUseMock } from "./lib/bridgeClient";
import { needsSessionListRefresh, reduceHostMessage } from "./lib/chatModel";
import {
  createBridgeHistoryStorage,
  setDefaultHistoryStorage,
} from "./lib/inputHistory";
import {
  createDomPurifySanitizer,
  createDomPurifySvgGuard,
  setSanitizer,
  setSvgGuard,
} from "./lib/markdown";
import { startMockHost } from "./lib/mockHost";

// 页面级错误探针：chrome:// 页面的 console 不进 Zotero 调试日志，未捕获错误是排障盲区。
// 写进 window.__claudianDiag（外部探针可读），不影响任何运行时行为。
function installErrorProbes(): void {
  window.addEventListener("error", (ev: ErrorEvent) => {
    const stack =
      ev.error instanceof Error && ev.error.stack ? `\n${ev.error.stack}` : "";
    recordDiag(
      `page error: ${ev.message} @${ev.filename}:${ev.lineno}${stack}`,
    );
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const reason = ev.reason as { stack?: unknown } | null | undefined;
    recordDiag(`page rejection: ${String(reason?.stack ?? reason)}`);
  });
}
installErrorProbes();

// 安全边界第一步：任何 Markdown 渲染前必须就位（renderMarkdown 未就位时 fail-closed 抛错）
setSanitizer(createDomPurifySanitizer());
// 第二道防线（纵深）：svg 段在自写消毒器之后再过一道 DOMPurify 兜底（见 markdown.ts 的 SVG_GUARD_CONFIG）
setSvgGuard(createDomPurifySvgGuard());

const store = new ChatStore();
const mock = shouldUseMock();
// 排障留痕：connected 每次翻转记一条——用于区分「reduce 没跑到」「DOM 没跟上」两类故障
let lastConnected: boolean | null = null;
/** R17 P1-c：上次主动 getState 用的 itemKey（每个 itemKey 最多请求一次，判定在 chatModel 里） */
let lastStateReqKey: string | null = null;
const bridge = new BridgeClient(
  (msg) => {
    const prev = store.get();
    const next = reduceHostMessage(prev, msg);
    store.set(next);
    // 排障留痕：readerContext 的四个值（chrome:// 页面 console 不进 Zotero 日志，
    // 顶栏标题/页码/划选出问题时这是唯一可外部读取的现场）
    if (msg.type === "readerContext") {
      recordDiag(
        `readerContext itemKey=${String(msg.itemKey)} title=${String(msg.title)} ` +
          `page=${String(msg.page)} selection=${msg.selection ? msg.selection.slice(0, 40) : "null"}`,
      );
    }
    // 会话绑定变化（重启后自动绑定最新会话 / 用户切换 / 新建）→ 拉旁挂历史回放。
    // 唯一的 getHistory 发起点：绑定变了才拉，避免重复请求。
    if (next.sessionId && next.sessionId !== prev.sessionId) {
      recordDiag(`ui.session bound ${next.sessionId}`);
      bridge.send({ type: "getHistory", sessionId: next.sessionId });
      // 输入历史（↑/↓ 翻已发送消息）同一时机拉：宿主落盘的那份由 inputHistory 消息推回，
      // InputBox 并入本会话桶（面板重载后 ↑ 还能翻到旧消息，走的就是这条）
      bridge.send({ type: "getInputHistory", sessionId: next.sessionId });
    }
    // R17 P1-c：空绑定态回填——切到「还没有会话」的文献时，本地列表里没有该 itemKey 的会话
    // （可能是宿主抛过旧快照 / 索引变更的推送丢过），主动要一次 getState（每个 itemKey 一次）。
    // 判定不在这里：needsSessionListRefresh 是具名纯函数（有单测）。
    const wantState = needsSessionListRefresh(next, lastStateReqKey);
    if (wantState) {
      lastStateReqKey = wantState;
      recordDiag(`ui.sessionList refresh requested for ${wantState}`);
      bridge.send({ type: "getState" });
    }
    if (next.connected !== lastConnected) {
      lastConnected = next.connected;
      recordDiag(`ui.connected=${String(next.connected)} (after ${msg.type})`);
    }
  },
  { mock },
);
// 输入历史的存储层：写经桥交给宿主落盘（chrome:// 特权页面没有 localStorage，见
// lib/inputHistory.ts 文件头）。必须在 render 之前装配——InputBox 首次渲染就要用它。
setDefaultHistoryStorage(createBridgeHistoryStorage((msg) => bridge.send(msg)));
bridge.start(mock ? startMockHost : undefined);

const root = document.getElementById("app");
if (root) {
  render(h(App, { bridge, store }), root);
} else {
  console.error("[chat-ui] #app root not found");
}
