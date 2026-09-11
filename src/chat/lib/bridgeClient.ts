// 桥客户端（UI 侧）— INTERFACE §4.6。
// 握手方向（已实测定型）：宿主在 browser load 事件先发 {type:"init"}，
// 页面收不到宿主 window 引用（顶层 browsing context），回发 hello 需要一个通道。
//
// 信任依据（BUG-16 修订）：chrome 作用域下 postMessage 的 event.origin 恒为空串，
// origin 白名单在真机上永不命中且不可作为信任依据 → 改为**一次性 token**：
// 宿主 loadURI 时把随机 token 拼进 URL（页面可读自己 URL），init 消息携带同值 token，
// 页面校验一致才回 hello；宿主对 hello 再做一次 token 校验才注册实例。
// 回发通道优先取 init 事件附带的 MessagePort（宿主转移，能力型通道，不依赖 event.source
// 语义）；无端口时回退 event.source。选取结果记入页面 diag（window.__claudianDiag）。
//
// 后续入站消息仅接受与已握手来源同源（event.source === hostSource）的消息；
// 页面自身重载即全新状态，宿主以 contentWindow 为键幂等去重（宿主侧职责）。
//
// mock 可切换（BUG-11）：仅非 chrome:// 环境（file:// / http dev server）由 mockHost
// 在页面内模拟宿主（init→hello→sessionList→脚本化流式回包），页面独立可跑；
// 生产 chrome:// 页面永不触发 mock。mock 宿主工厂由调用方注入（见 start）。
import type { HostMessage, UiMessage } from "./types";

/** 页面自己的握手 token（宿主 loadURI 时拼在查询参数上）；无/空 → null */
export function readOwnToken(search: string): string | null {
  try {
    const token = new URLSearchParams(search).get("token");
    return token ? token : null;
  } catch {
    return null;
  }
}

/** init 可信判定：token 非空且与页面 URL 上的一次性 token 完全一致（BUG-16 的唯一信任依据） */
export function isTrustedInitToken(
  initToken: unknown,
  ownToken: string | null,
): boolean {
  return (
    typeof initToken === "string" &&
    initToken.length > 0 &&
    ownToken !== null &&
    initToken === ownToken
  );
}

/** 真机排障用事件快照：chrome:// 页面的 console 不进 Zotero 调试日志，靠外部探针读 window.__claudianDiag。
 * ev.source 可能是 revoked proxy 等病态对象——读它的原型/属性即抛 TypeError（死窗口来源出现过该形态）。
 * 整段包 try/catch：排障信息收集失败绝不能反噬协议（这里抛错会中断 handleMessage 对当前消息的处理）。 */
function diagEvent(ev: MessageEvent): string {
  try {
    const source =
      ev.source === null ? "null" : Object.prototype.toString.call(ev.source);
    const sourceIsSelf = ev.source === window;
    return `origin=${JSON.stringify(ev.origin ?? null)} source=${source} sourceIsSelf=${sourceIsSelf} ports=${ev.ports ? ev.ports.length : 0}`;
  } catch (err) {
    return `diagEvent failed: ${String(err)}`;
  }
}

/** 真机排障留痕（chrome:// 页面 console 不进 Zotero 日志）：window.__claudianDiag 供外部探针读取。
 * 页面寿命 = 整个 Zotero 会话，故设上限防无界增长（诊断场景只关心最近的痕迹）；写入失败不影响协议。 */
export const DIAG_MAX = 200;

export function recordDiag(entry: string): void {
  try {
    const w = window as Window & { __claudianDiag?: string[] };
    const arr = (w.__claudianDiag ??= []);
    arr.push(entry);
    if (arr.length > DIAG_MAX) {
      arr.splice(0, arr.length - DIAG_MAX);
    }
  } catch {
    // 排障信息失败不影响协议
  }
}

/** 非 JSON 对象或缺 type 字段 → null（§4.6：消息一律 JSON 对象且必含 type）。
 * 返回原对象（仅校验，不重建——重建会丢掉 type 以外的全部字段） */
export function parseBridgeMessage(data: unknown): { type: string } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  return typeof (data as { type?: unknown }).type === "string"
    ? (data as { type: string })
    : null;
}

export interface BridgeClientOptions {
  mock?: boolean;
}

export class BridgeClient {
  /** 入站消息来源基准（= init 事件的 ev.source；chrome 作用域下可能为 null） */
  private hostSource: MessageEventSource | null = null;
  /** 出站通道（init 附带的 MessagePort 优先，回退 event.source）；null = 未握手 */
  private replyTo: ((msg: UiMessage) => void) | null = null;
  private outbox: UiMessage[] = [];
  private disposed = false;
  // 显式字段而非构造器参数属性：参数属性是不可擦除 TS 语法，node:test 跑不了
  private onHostMessage: (msg: HostMessage) => void;
  private opts: BridgeClientOptions;

  constructor(
    onHostMessage: (msg: HostMessage) => void,
    opts: BridgeClientOptions = {},
  ) {
    this.onHostMessage = onHostMessage;
    this.opts = opts;
  }

  /** 启动监听。mockHostFactory 由调用方注入（仅开发期 mock 模式），
   * 本模块不直接依赖 mockHost——保持 node:test 可导入（无运行时相对导入） */
  start(mockHostFactory?: () => void): void {
    window.addEventListener("message", this.handleMessage);
    if (this.opts.mock && mockHostFactory) {
      // 页面内 mock 宿主：经同一 postMessage 通道模拟宿主行为
      mockHostFactory();
    }
    // 非 mock：宿主先发 init（browser load 事件），页面静候即可
  }

  destroy(): void {
    this.disposed = true;
    window.removeEventListener("message", this.handleMessage);
    this.outbox = [];
    this.replyTo = null;
    this.hostSource = null;
  }

  /** UI→宿主发送；握手未完成先缓冲，握手后直发 */
  send(msg: UiMessage): void {
    if (this.disposed) {
      return;
    }
    if (this.replyTo) {
      this.replyTo(msg);
    } else {
      this.outbox.push(msg);
    }
  }

  get connected(): boolean {
    return this.replyTo !== null;
  }

  private handleMessage = (ev: MessageEvent): void => {
    if (this.disposed) {
      return;
    }
    const msg = parseBridgeMessage(ev.data);
    if (!msg) {
      return; // 非对象/无 type → 忽略
    }
    if (msg.type === "init") {
      const ownToken = readOwnToken(window.location.search);
      if (
        !this.opts.mock &&
        !isTrustedInitToken((msg as { token?: unknown }).token, ownToken)
      ) {
        // 校验失败：拒绝（不回 hello）+ 留痕，绝不静默放行
        recordDiag(`init REJECTED: token mismatch; ${diagEvent(ev)}`);
        return;
      }
      // 回发通道：init 附带的 MessagePort 优先（能力型，与 event.source 语义无关），
      // 无端口回退 event.source（spike 期形态；chrome 作用域下需实测确认可用）
      const port = ev.ports && ev.ports.length > 0 ? ev.ports[0] : null;
      const source = ev.source ?? null;
      if (!port && !source) {
        recordDiag(`init without reply channel; ${diagEvent(ev)}`);
        return;
      }
      // 浏览器重载触发二次握手：重复 init 幂等——更新通道并再次回 hello
      //（宿主以 contentWindow 为键去重，只注册一次）
      this.hostSource = source;
      this.replyTo = port
        ? (m) => port.postMessage(m)
        : (m) => {
            // source 回退路径：窗口可能已死（browser 销毁/跨文档导航），postMessage 抛错若冒出去，
            // 本次 init 会在 hello 处中断（走不到 flushOutbox），outbox 全丢——兜底记 diag 不抛。
            try {
              (source as Window).postMessage(m, "*");
            } catch (err) {
              recordDiag(
                `ui→host send FAILED via source (${m.type}): ${String(err)}`,
              );
            }
          };
      this.replyTo({
        type: "hello",
        token: ownToken ?? undefined,
      } satisfies UiMessage);
      recordDiag(
        `hello sent via ${port ? "port" : "source"}; ${diagEvent(ev)}`,
      );
      this.flushOutbox();
      return;
    }
    // 其余宿主消息：仅接受已握手来源（mock 下 hello 等自身回声经 reducer 兜底忽略）
    if (!this.replyTo || ev.source !== this.hostSource) {
      if (msg.type !== "streamEvent") {
        recordDiag(
          `drop ${msg.type}: not handshaked / source mismatch; ${diagEvent(ev)}`,
        );
      }
      return;
    }
    if (msg.type !== "streamEvent") {
      // 排障留痕：非流事件（init/sessionList/error/readerContext…）记一条，流事件量太大不记
      recordDiag(`host→ui: ${msg.type}`);
    }
    this.onHostMessage(msg as HostMessage);
  };

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (const msg of pending) {
      this.replyTo?.(msg);
    }
  }
}

/** 开发期 mock 判定（BUG-11）：chrome://（生产页）永不 mock，?mock=1 也不生效；
 * 非 chrome://（file:///http dev server）自动 mock，供脱离 Zotero 独立开发 */
export function shouldUseMock(loc: Location = window.location): boolean {
  if (loc.protocol === "chrome:") {
    return false;
  }
  return loc.search.includes("mock=1") || loc.protocol !== "chrome:";
}
