// mermaidRender.ts — mermaid 代码块的页面侧渲染：懒加载 mermaid → 渲染 → 消毒 → 替换源码块。
//
// 安全边界：
// 1. 渲染产物**不进 innerHTML 前必过 svgSanitize**（allowStyle：mermaid 的 <style> 是图形配色
//    的唯一来源，逐条规则校验，选择器必须以本图 #id 打头）；消毒后为空 → 保持源码（fail-safe）。
// 2. 渲染失败（语法错、包没加载上）→ 源码块原样留着（它本来就在 DOM 里），不白屏、不吞内容。
// 3. mermaid 配置 securityLevel:'strict' + htmlLabels:false（禁 foreignObject/HTML 标签），
//    suppressErrorRendering:true（失败就抛，别在消息里插它的错误图）。
// 4. 每次渲染的 id 唯一：mermaid 的 CSS 以 `#id` 收敛作用域，id 撞车会让两份图样式串味。
import { MERMAID_BLOCK_CLASS, guardSvg } from "./markdown";
import { sanitizeSvg } from "./svgSanitize";
import { recordDiag } from "./bridgeClient";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** 懒加载包地址（与 chat.js 同目录；由 build.mjs 产出） */
const MERMAID_SCRIPT_URL = "./mermaid.js";

let apiPromise: Promise<MermaidApi> | null = null;
let seq = 0;
/** 源码 → 消毒后 SVG：同一张图重复出现（重渲染/回放）不必再算一遍 */
const cache = new Map<string, string>();
/** 渲染串行化：mermaid.render 会往 document.body 插临时容器，并发跑容易互相踩 */
let chain: Promise<void> = Promise.resolve();

export interface MermaidEnhanceOptions {
  /** 懒加载脚本地址（默认同目录 mermaid.js；测试/排障可覆盖） */
  scriptUrl?: string;
  /** 失败回调（默认写诊断日志） */
  onError?: (err: unknown) => void;
}

/** mermaid 的深色/浅色主题跟随页面配色（取不到偏好就走浅色，不影响渲染） */
function mermaidTheme(): string {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  return mq && mq.matches ? "dark" : "default";
}

function loadMermaid(scriptUrl: string): Promise<MermaidApi> {
  if (apiPromise === null) {
    apiPromise = new Promise<MermaidApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(scriptUrl, window.location.href).href;
      script.onload = () => {
        const api = (globalThis as { __claudianMermaid?: MermaidApi })
          .__claudianMermaid;
        if (!api) {
          reject(new Error("mermaid bundle loaded but global missing"));
          return;
        }
        try {
          api.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            suppressErrorRendering: true,
            theme: mermaidTheme(),
          });
          resolve(api);
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error("mermaid bundle load failed"));
      document.head.appendChild(script);
    });
    // 失败不重试：包缺失/加载不了是稳定故障，每个块都重试只会刷屏
    apiPromise.catch(() => undefined);
  }
  return apiPromise;
}

function nextId(): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `claudian-mm-${seq}-${rand}`;
}

/** 渲染成功的留痕：chrome:// 页面的 console 不进 Zotero 调试日志，这是外部唯一可读的现场 */
function reportSuccess(id: string, source: string, svg: string): void {
  recordDiag(
    `mermaid.rendered id=${id} src=${source.length}B svg=${svg.length}B`,
  );
}

async function renderOne(
  pre: HTMLElement,
  source: string,
  opts: MermaidEnhanceOptions,
): Promise<void> {
  if (!pre.isConnected) {
    return; // 元素已被下一轮重渲染换掉（流式期间常见）
  }
  let svg = cache.get(source);
  if (svg === undefined) {
    try {
      const api = await loadMermaid(opts.scriptUrl ?? MERMAID_SCRIPT_URL);
      const id = nextId();
      const { svg: raw } = await api.render(id, source);
      // 自写消毒器（主门）→ DOMPurify SVG 兜底层（同一套两层，与 markdown 段口径一致）
      svg = guardSvg(sanitizeSvg(raw, { allowStyle: true }));
      cache.set(source, svg);
      reportSuccess(id, source, svg);
    } catch (err) {
      (
        opts.onError ??
        ((e) => recordDiag(`mermaid.render failed: ${String(e)}`))
      )(err);
      return; // 源码块留着就是降级形态
    }
  }
  if (svg === "" || !pre.isConnected) {
    return;
  }
  const box = document.createElement("div");
  box.className = "mermaid-rendered";
  // 唯一落点：消毒后的 SVG（sanitizeSvg 的全部输出都是重新序列化的白名单产物）
  box.innerHTML = svg;
  pre.replaceWith(box);
}

/**
 * 把容器里所有 mermaid 源码块（`pre.mermaid-block`，见 markdown.ts 的 code renderer）替换为渲染图。
 * 异步且串行；调用方不 await（渲染完成前显示的就是源码，天然降级）。
 * 流式期间不必调用（每次 delta 都会重渲染 → 白烧 CPU），由调用方在回合结束时触发。
 */
export function enhanceMermaidBlocks(
  container: HTMLElement,
  opts: MermaidEnhanceOptions = {},
): void {
  const blocks = container.querySelectorAll(`pre.${MERMAID_BLOCK_CLASS}`);
  blocks.forEach((pre) => {
    const source = pre.textContent ?? "";
    if (source.trim() === "") {
      return;
    }
    chain = chain.then(() => renderOne(pre as HTMLElement, source, opts));
  });
}
