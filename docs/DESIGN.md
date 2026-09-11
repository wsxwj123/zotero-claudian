# 设计文档（DESIGN）

> zotero-claudian 的架构与关键设计决策。接口契约见 [INTERFACE.md](INTERFACE.md)，安全模型见 [SECURITY-AUDIT.md](SECURITY-AUDIT.md)。

## 1. 总览

**一句话**：Zotero 插件（Gecko/TypeScript），把本机 Claude Code CLI 接进阅读器侧栏与独立标签页，自动注入当前文献上下文。

```
┌─ Zotero 主进程（Gecko，插件宿主层，TypeScript）─────────────┐
│ bootstrap（生命周期 + chrome:// 注册）                       │
│ ├─ sections.ts       阅读器侧栏（registerSection 嵌 browser） │
│ ├─ mainTab.ts        独立标签页 + 工具栏按钮入口              │
│ ├─ notes.ts          笔记写入（全项目唯一写 Zotero 库的模块） │
│ ├─ sessionStore.ts   会话索引 + 旁挂历史（profile 内）        │
│ ├─ contextSource.ts  PDF 上下文采集（reader API/划选钩子）   │
│ ├─ cliRunner.ts      Subprocess spawn / 流读 / kill / deny   │
│ ├─ protocol.ts       stream-json 行解析 → 标准事件            │
│ ├─ permissionMcp.ts  本地权限端点（127.0.0.1，权限卡路由）    │
│ ├─ cliDetect.ts      claude 命令发现 / 登录态检测            │
│ └─ hostBridge.ts     宿主↔UI postMessage 桥 + 会话运行时      │
└──────────────┬───────────────────────────────┬──────────────┘
               │ postMessage(JSON)              │ Subprocess.call
┌──────────────▼───────────────┐   ┌───────────▼──────────────┐
│ chat-ui（chrome:// 非 remote）│   │ claude CLI 子进程          │
│ Preact：会话列表/消息流/       │   │ 每轮一个进程，--resume 续接 │
│ 工具卡/权限卡/Markdown 渲染    │   │ 用户完整 MCP/hooks 环境    │
└──────────────────────────────┘   └──────────────────────────┘
```

## 2. 关键设计决策

### 2.1 集成路线：spawn CLI，每轮一个进程

- Agent SDK 不能在 Gecko 运行（依赖 node/bun/deno）；唯一路线是 spawn 本机 `claude` CLI（`-p --output-format stream-json --verbose --include-partial-messages`）。
- **每轮 turn 一个进程，`--resume <session_id>` 续接**——中断 = kill 进程，语义干净；不用常驻双向进程（control_request 协议未公开）。
- **不用 `--bare` / `--setting-sources` 收窄**：保留用户完整的 MCP/hooks/技能环境是项目立身之本。代价是每轮加载成本数秒（与终端直接使用 Claude Code 相同）。
- **prompt 走 stdin**：规避 argv 长度限制（Windows 8191）与 `ps` 泄露上下文。

### 2.2 UI 加载：chrome:// + 非 remote browser + 宿主先发握手

- UI 是插件自带的本地 Web bundle（Preact），经 `aomStartup.registerChrome` 注册后以 `chrome://claudian/content/chat/index.html` 加载进 `<browser type="content">`（**非 remote**）。
- file:// 直载（remote 卡死/非 remote 静默无效）已被实验排除。
- **握手方向：宿主先发**——页面是顶层 browsing context，拿不到宿主 window 引用、发不出第一条消息。宿主在 browser `load` 事件发 `{type:"init"}`（带一次性 token），页面校验后经 MessagePort 回 `{type:"hello"}`。
- 侧栏与独立标签页复用同一 bundle、同一宿主桥（多实例广播）。

### 2.3 权限模型

- **权限卡主案**：`--permission-prompt-tool` 指向插件内置的本地 MCP 端点（127.0.0.1 回环 HTTP）。AI 请求执行命令 → CLI 调该端点 → 插件弹图形卡 → 用户允许/拒绝/记住 → 端点回包。实测 deny 后 AI 收到拒绝且不会换工具绕过。
- 端点安全：一次性随机 token（CSPRNG，缺失即 fail-closed）、403 拒绝无凭据请求、120s 超时按 deny、请求体/头大小上限、连接寿命有界。
- 权限档四档：`default` / `acceptEdits`（出厂默认，文件编辑自动放行）/ `plan`（只读规划）/ `bypass`（放任，R5 增补，映射 CLI 的 `bypassPermissions`；不弹权限卡，顶栏切换需两次点击确认）。
- **附件目录写保护**：AI 读取当前 PDF 所在目录用于引用原文，但对该目录的 Write/Edit 经 `--settings` 的 `permissions.deny` 规则硬拒绝（实测：AI 收到 tool_use_error、PDF 字节不动、Read 不受影响）。

### 2.4 上下文注入

- 每次发送在消息体内注入结构化上下文块：文献元数据（标题/作者/年份/摘要/DOI）、PDF 绝对路径、当前页码、划选原文。
- **不预提取全文**：AI 用自身 Read 工具按需读取 PDF（`--add-dir` 提供访问）。
- 划选所属条目与会话条目不一致时省略划选行（防切文献错拼）；通用会话整块省略。

### 2.5 会话与存储

- 会话索引 `sessions.json` + 旁挂历史 `history/<id>.jsonl`，存于 Zotero profile 的插件数据目录（独立数据目录，不放扩展安装目录）。
- 单一 writer 队列串行化写入；`.tmp → rename` 原子替换；读失败与「文件不存在」严格区分（读失败绝不触发覆盖写）。
- **删除插件会话不触碰 Claude Code 自身的会话文件**（`~/.claude` 由 CLI 管理）。

### 2.6 流式渲染安全（XSS 边界）

- AI 输出 → marked 渲染 → **DOMPurify 白名单制消毒**（img/video/form/style 等可自动外发元素不进 DOM）→ innerHTML。
- chrome:// 特权页内全部链接点击被拦截，经宿主 `Zotero.launchURL` 外部打开；页面附加 CSP（`default-src 'none'`）。
- 笔记落库前再过一道宿主侧白名单终检（`htmlSanitize`，流式扫描器、无 DOM 依赖、fail-closed）。

## 3. 跨平台（macOS / Windows）

- **命令发现**：darwin 走 PATH + 常驻目录；win32 走进程 PATH + 常驻目录（npm `.cmd` 壳优先解析包内 `claude.exe`）。
- **win32 派发通道**：`.exe` 直传 Subprocess；`.cmd` 壳经绝对路径 `cmd.exe` + `["/C", line]`（命中 Gecko 的 cmd.exe 特例分支，外壳引号由 Gecko 补）+ 双引号 + CRT 反斜杠规则，line ≤8191 校验、含换行参数拒绝该轮。
- **路径**：一律 `PathUtils.join`；工作区默认值经系统 API 取 Documents（兼容 OneDrive 重定向）。
- **环境**：darwin 取登录 shell PATH；win32 用进程 PATH + 常驻目录兜底（不探 SHELL）。
- win32 的 deny 规则路径形态（`//C:/…/**`）以 Windows 真机验证为准。

## 4. 构建与测试

```bash
npm install
npm run build    # 构建 XPI（含 chat bundle 打包）
npm start        # 开发模式（Zotero 热重载）
```

- **验收契约测试**：`npx tsx --test "tests/acceptance/*.test.mjs"`（161 条，锁定验收；黑盒设计只依据 BRIEF + INTERFACE）。
- **单元测试**：`npx tsx --test "tests/unit/*.ts"` 与 `npx tsx --test "tests/unit/*.test.mjs"`。
- **CI**：GitHub Actions 双矩阵（macos + windows）跑 typecheck + 全部测试 + 构建 + `npm audit`。
