// chat-ui 前端 bundle 构建入口（M3）。
// 用法（仓库根目录执行）：node src/chat/build.mjs
// 产物：addon/content/chat/index.html + chat.js
//   宿主 scaffold 打包时 addon/** 整体拷入 XPI，chrome://claudian/content/chat/index.html 即入口。
// 说明：不接 package.json scripts（共享底座不可改），合并时由主会话统一接入；
// esbuild 为 zotero-plugin-scaffold 的既有传递依赖，未新增任何依赖。
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "addon", "content", "chat");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", "chat", "main.ts")],
  bundle: true,
  // chrome:// 文档用经典 <script>（非 module）最稳：iife 单文件，无模块限制问题
  format: "iife",
  target: "firefox115",
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
  outfile: join(outDir, "chat.js"),
});

// mermaid 单独成包（懒加载：页面首次遇到 mermaid 块才注入 <script>，见 lib/mermaidRender.ts）。
// 为什么不做 esbuild code splitting：iife 输出不支持拆包，且 chrome:// 页面拉 module chunk 是
// 未知数；「第二个 iife + 动态 script 标签」是同源加载下最稳的等价形态。
// 这里开 minify：5MB 量级的第三方包没人读，省下的体积是实打实的（未压缩约 12MB）。
await build({
  entryPoints: [join(root, "src", "chat", "mermaidEntry.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "firefox115",
  charset: "utf8",
  legalComments: "none",
  logLevel: "warning",
  outfile: join(outDir, "mermaid.js"),
});

copyFileSync(
  join(root, "src", "chat", "index.html"),
  join(outDir, "index.html"),
);
