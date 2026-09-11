// mermaid 懒加载包入口（独立 bundle：addon/content/chat/mermaid.js）。
//
// 为什么单独成包：mermaid 全量（含全部图形类型与依赖）min 后仍有 5MB 量级，塞进 chat.js 会让
// 每个聊天页实例（多标签/多侧栏各一份）无论用不用都在启动时解析它。这里只在页面首次遇到
// mermaid 块时由 lib/mermaidRender.ts 动态插入 <script>（同源 chrome:// 资源，CSP script-src 'self' 覆盖）。
//
// 包内只做一件事：把 mermaid 挂到 globalThis 供页面取用；initialize 由取用方做（配置在页面侧一处收口）。
import mermaid from "mermaid";

(globalThis as { __claudianMermaid?: unknown }).__claudianMermaid = mermaid;
