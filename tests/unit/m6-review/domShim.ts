// 复核轮（m6-review）自写的最小 DOM 仿真 —— 只为在 Node 里跑**真实**的 Preact 渲染路径：
// 真组件（MessageList / App）+ 真 hooks（useLayoutEffect 写 innerHTML / useState 重渲染）。
// 独立性声明：本文件不复用被测方（dev-chatui / test-m6）的任何测试假件；
// 覆盖的 DOM API 面按 node_modules/preact 的实际调用面裁剪（createElementNS/createTextNode/
// childNodes/insertBefore/removeChild/addEventListener/style/className/value/innerHTML）。
// 用途边界：这是「无头 DOM」，不是浏览器——事件派发只覆盖本批测试需要的 click/input/keydown。

export class ShimText {
  nodeType = 3;
  nodeName = "#text";
  data: string;
  parentNode: ShimElement | null = null;
  constructor(data: string) {
    this.data = data;
  }
  get nextSibling(): ShimElement | null {
    return siblingOf(this as unknown as ShimElement);
  }
  get textContent(): string {
    return this.data;
  }
}

export class ShimElement {
  nodeType = 1;
  nodeName: string;
  localName: string;
  childNodes: Array<ShimElement | ShimText> = [];
  parentNode: ShimElement | null = null;
  style: Record<string, unknown> = {};
  className = "";
  value: any = undefined;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** MarkdownBlock 在 layout effect 里写 innerHTML —— 仿真里按「字符串子渲染产物」保存 */
  innerHTML = "";
  // 真 DOM 元素自带的标准 on* 句柄属性（GlobalEventHandlers）。
  // 必须存在：Preact 用 `"oninput" in node` 决定监听器注册名是小写 "input" 还是原样 "Input"，
  // 缺了就会注册成 "Input"，与真实浏览器行为分叉（事件派发对不上）。
  onclick: unknown = null;
  oninput: unknown = null;
  onkeydown: unknown = null;
  onkeyup: unknown = null;
  onscroll: unknown = null;
  onchange: unknown = null;
  onfocus: unknown = null;
  onblur: unknown = null;
  onfocusin: unknown = null;
  onfocusout: unknown = null;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<(ev: any) => void>>();
  constructor(nodeName: string) {
    this.nodeName = nodeName;
    this.localName = nodeName.toLowerCase();
  }
  get firstChild(): ShimElement | ShimText | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): ShimElement | ShimText | null {
    return siblingOf(this);
  }
  get textContent(): string {
    return collectText(this);
  }
  appendChild(child: ShimElement | ShimText): ShimElement | ShimText {
    detach(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(
    child: ShimElement | ShimText,
    ref: ShimElement | ShimText | null,
  ): ShimElement | ShimText {
    detach(child);
    child.parentNode = this;
    if (ref == null) {
      this.childNodes.push(child);
      return child;
    }
    const i = this.childNodes.indexOf(ref);
    if (i < 0) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(i, 0, child);
    }
    return child;
  }
  removeChild(child: ShimElement | ShimText): ShimElement | ShimText {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  setAttribute(name: string, value: unknown): void {
    const s = String(value);
    this.attrs.set(name, s);
    if (name === "class") {
      this.className = s;
    }
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, fn: (ev: any) => void, _opts?: unknown): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** 测试用：派发一个事件到该节点（覆盖 Preact 注册的监听器，以节点为 this） */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const ev = { type, target: this, preventDefault() {}, ...event };
    for (const fn of this.listeners.get(type) ?? []) {
      fn.call(this, ev);
    }
  }
}

function detach(child: ShimElement | ShimText): void {
  child.parentNode?.removeChild(child);
}

function siblingOf(node: ShimElement | ShimText): any {
  const p = node.parentNode;
  if (!p) {
    return null;
  }
  const i = p.childNodes.indexOf(node);
  return i >= 0 ? (p.childNodes[i + 1] ?? null) : null;
}

/** 近似 DOM textContent：递归子节点 + 本节点 innerHTML 的纯文本 */
export function collectText(node: any): string {
  if (node == null) {
    return "";
  }
  if (node.nodeType === 3) {
    return node.data;
  }
  let out = "";
  for (const c of node.childNodes ?? []) {
    out += collectText(c);
  }
  if (node.innerHTML) {
    out += stripTags(node.innerHTML);
  }
  return out;
}

/** 只用于本仿真的 innerHTML 纯文本近似（标签剥除 + 实体最小还原） */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** 深度优先收集满足条件的元素 */
export function queryAll(
  root: ShimElement,
  pred: (el: ShimElement) => boolean,
  out: ShimElement[] = [],
): ShimElement[] {
  for (const c of root.childNodes) {
    if (c instanceof ShimElement) {
      if (pred(c)) {
        out.push(c);
      }
      queryAll(c, pred, out);
    }
  }
  return out;
}

/** 按 class 名（空格分词包含）找元素 */
export function byClass(root: ShimElement, cls: string): ShimElement[] {
  return queryAll(root, (el) =>
    el.className.split(/\s+/).filter(Boolean).includes(cls),
  );
}

const root = new ShimElement("html");
const shimDocument = {
  createElementNS: (_ns: string, name: string) => new ShimElement(String(name)),
  createTextNode: (text: string) => new ShimText(String(text)),
  documentElement: root,
  createElement: (name: string) => new ShimElement(String(name)),
};

// 注意：globalThis.document / window 只在**本测试进程**里存在（node:test 每文件一条进程）
(globalThis as any).document = shimDocument;
(globalThis as any).window = (globalThis as any).window ?? {};

/** 造一个可当 render 容器的挂载点（挂在 documentElement 下） */
export function mountPoint(): ShimElement {
  const el = new ShimElement("div");
  root.appendChild(el);
  return el;
}
