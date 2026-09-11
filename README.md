# zotero-claudian

**在 Zotero 里内置一个 Claude Code 工作台**：读文献时直接在阅读器侧栏或独立标签页里和 Claude 对话——它自动知道你在读哪篇、哪页、划了什么，能调用你本机 Claude Code 的全部工具与技能分析文献，回答可一键存进 Zotero 笔记。

> 本插件把本机已安装的 [Claude Code](https://claude.com/claude-code) CLI 接进 Zotero。它**不是**又一个"填 API key 聊天"的插件：对话跑在你本机的 `claude` 进程里，用你已配置好的模型服务商、MCP、技能与权限体系。

## 能做什么

- **阅读器侧栏**：看 PDF 时在侧栏直接提问，不用切换应用
- **自动文献上下文**：提问自动带上当前文献的标题/作者/年份/摘要/DOI、PDF 路径、当前页码、划选文字——你只管问
- **划选提问**：PDF 里选中一段 → 「解释这段」「这个方法有什么问题」
- **流式回答**：逐字渲染、Markdown/代码高亮、工具调用卡片（可折叠）、thinking 折叠区
- **图形化权限卡**：AI 要跑命令时弹出卡片——允许 / 拒绝 / 本会话记住；文件编辑按权限档自动放行
- **会话管理**：会话按文献条目分组 + 通用会话；支持新建、切换、删除、重启 Zotero 后续接（`--resume`，AI 记得之前聊的内容）
- **一键存笔记**：AI 回答旁「存为笔记」创建新笔记或追加到已有笔记；划选文字同样可以
- **独立标签页**：工具栏「Claude」按钮打开全页工作台，与侧栏共享同一份会话
- **工作区设置**：AI 的文件产出落在你指定的工作目录；工作目录、默认权限档、CLI 路径都可在设置页调整

## 前置要求

- **Zotero 7 或更高**（macOS 与 Windows；Zotero 9 经完整真机验证，7/8 未真机验证）
- **本机已安装并登录 Claude Code CLI**（`claude` 命令可用、`claude auth status` 显示已登录）。
  安装见 [Claude Code 官方文档](https://claude.com/claude-code)。插件不代装、不管理账号。

## 安装

1. 从 [Releases](../../releases) 下载最新 `zotero-claudian.xpi`
2. Zotero 菜单：**工具 → 插件**
3. 插件面板右上角齿轮 → **Install Plugin From File…** → 选刚下载的 `.xpi`
4. 重启 Zotero。阅读器右侧栏出现「Claude」面板即安装成功；工具栏也有「Claude」按钮可开独立标签页

> 未签名 XPI 的安装提示属正常（本插件不申请 Zotero 官方签名）。

## 使用

### 边读边问

1. 打开一篇 PDF → 展开右侧「Claude」面板
2. 输入问题（例：_这篇的结论是什么？方法部分有什么局限？_）→ 回车
3. AI 自动获得当前文献上下文；需要引用原文时它自己读 PDF

首次回答可能需要几十秒（每轮对话会启动一次 Claude Code 进程，与你直接使用 Claude Code 的加载成本相同）。

### 划选提问 / 存笔记

- PDF 里选中文字 → 弹窗点「Claude」→ 问题自动带上划选原文与页码
- 回答旁「存为笔记」→ 选择新建或追加到已有笔记
- 划选文字也可直接「存为笔记」

### 权限卡

- AI 请求执行命令（如运行一个 Python 脚本分析数据）→ 弹出权限卡
- **允许**执行一次；**允许并记住**本会话内同类命令不再询问；**拒绝**后 AI 会收到拒绝并停止该操作
- 权限档可在对话页顶栏或设置页切换：`默认`（文件编辑也弹卡）/ `接受编辑`（文件编辑自动放行，出厂默认）/ `计划`（只读规划，不落改动）

### 会话与工作区

- 会话按文献条目自动分组；也支持不绑定文献的通用会话
- 重启 Zotero 后会话仍在，直接续聊
- 设置页可改**工作区目录**（AI 文件产出的落点，默认 `~/Documents/zotero-claudian-workspace`）

## 数据与安全

**数据流向**：你的提问、文献元数据、以及 AI 按需读取的 PDF 内容，会经本机 `claude` 进程发往**你自己配置的模型服务商**（官方或你自设的网关）。发送什么、发给谁，由你的 Claude Code 配置决定——与本插件无关。

本插件自身的边界（发布版经过对权限端点、消毒器、注入面的独立安全审计）：

- **不管理、不读取、不存储任何 API key**；认证完全依赖本机 CLI 登录态
- **无遥测、插件自身不直连任何外部地址**
- **Zotero 库只读**：AI 经官方 API 读条目元数据/PDF/已有笔记；写库仅发生在你点击「存为笔记」时
- **PDF 原文受硬保护**：AI 读取 PDF 所在的附件目录用于引用原文，但该目录的写入被权限系统硬拒绝（经 `--settings` deny 规则实现，真机验证 PDF 字节不会被改动）
- 所有命令执行都要过权限卡（或你显式选择的权限档）；AI 不能绕过

## 已知限制

- **Zotero 7/8 未真机验证**（API 对齐 + 兼容区间声明；欢迎反馈）
- **Windows 版**：代码与 CI 已按 Windows 适配（含 `claude.cmd` 通道与路径处理），真机验收进行中
- 首轮响应延迟：Claude Code 每轮加载你的 hooks/MCP 配置需要数秒（与终端使用同成本）
- LaTeX 公式渲染 v1 不支持（原文保留，v2 计划）
- Linux 未支持

## 常见问题

**面板显示 CLI 未找到？** 检查终端里 `claude` 是否可用；若用了自定义安装路径，可在插件设置页「CLI 路径」里指定。

**为什么首答很慢？** 每轮对话会启动一个 Claude Code 进程并加载你的完整配置（MCP/hooks/技能）。这是"用你完整的 Claude Code 环境"的代价——换来的是你装的所有能力在 Zotero 里直接可用。

**会泄露我的文献吗？** 文献内容只发给你自己配置的模型服务商（见上「数据流向」）。插件本身不收集任何数据。

**会话存在哪？** Zotero 配置目录下 `claudian/`（插件自管）；会话正文同时存在于你本机 Claude Code 的会话目录中。删除插件内会话不会删除 Claude Code 的会话文件。

**首次使用时弹出「Zotero 想访问文稿文件夹」？** 这是 macOS 的文件夹授权提示——AI 的工作区默认在 `~/Documents/zotero-claudian-workspace`，点「允许」即可；也可以在设置页把工作区改到其他位置（比如 `~/zotero-claudian-workspace`）避免该提示。

## 开发

```bash
npm install
npm start          # 开发模式（Zotero 热重载）
npm run build      # 构建 XPI
```

开发文档与接口约定见 `docs/`（架构、IPC 协议、构建与验收说明）。

## 致谢

- [llm-for-zotero](https://github.com/yilewang/llm-for-zotero) 等 Zotero AI 插件先例——行为范式参考（代码零复用）
- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) / [zotero-plugin-scaffold](https://github.com/windingwind/zotero-plugin-scaffold)——工具链（构建产物不含模板代码）
- [Preact](https://preactjs.com/) / [marked](https://marked.js.org/) / [DOMPurify](https://github.com/cure53/DOMPurify) / [highlight.js](https://highlightjs.org/)

## License

[MIT](LICENSE)
