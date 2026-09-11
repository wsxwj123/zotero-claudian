# zotero-claudian

**在 Zotero 里内置一个 Claude Code 工作台**：读文献时直接在阅读器右侧浮层（或侧栏、独立标签页）里和 Claude 对话——它自动知道你在读哪篇、哪页、划了什么，能调用你本机 Claude Code 的全部工具与技能分析文献，回答可一键存进 Zotero 笔记。

> 本插件把本机已安装的 [Claude Code](https://claude.com/claude-code) CLI 接进 Zotero。它**不是**又一个"填 API key 聊天"的插件：对话跑在你本机的 `claude` 进程里，用你已配置好的模型服务商、MCP、技能与权限体系。

## 能做什么

- **顶部按钮 + 右侧浮层（推荐）**：点工具栏「Claude」按钮，阅读器右侧滑出对话浮层——PDF 保持可见，宽度可拖、状态记忆；关掉浮层 PDF 恢复全宽
- **阅读器侧栏**：看 PDF 时也可在右侧栏直接提问，不用切换应用
- **自动文献上下文**：提问自动带上当前文献的标题/作者/年份/摘要/DOI、PDF 路径、当前页码、划选文字——你只管问
- **切文献自动跟随会话**：切换到另一篇 PDF，面板自动显示该文献的最近会话（不新建、不串台）
- **用量与余额**：顶栏显示本轮/累计 token 与**缓存命中率**；provider 为 DeepSeek 时（需在设置页填一次 API Key）额外显示账户余额
- **划选提问**：PDF 里选中一段 → 「解释这段」「这个方法有什么问题」
- **流式回答**：逐字渲染、Markdown/代码高亮、mermaid 图与 SVG、工具调用卡片（可折叠）、thinking 折叠区
- **图形化权限卡**：AI 要跑命令时弹出卡片——允许 / 拒绝 / 本会话记住；文件编辑按权限档自动放行，也可切「放任」档完全不打断
- **输入历史**：输入框按 ↑/↓ 翻回上一条发过的消息（未发送的草稿会先存着，翻回底部还原）
- **会话管理**：会话按文献条目分组 + 通用会话；支持新建、切换、删除、重启 Zotero 后续接（`--resume`，AI 记得之前聊的内容）
- **一键存笔记**：AI 回答旁「存为笔记」创建新笔记或追加到已有笔记；划选文字同样可以
- **独立标签页**：浮层顶部「全页」按钮打开全页工作台，与浮层共享同一份会话
- **工作区设置**：AI 的文件产出落在你指定的工作目录（放一份 `CLAUDE.md` 进去就是你的项目级指令）；工作目录、默认权限档、CLI 路径都可在设置页调整

## 前置要求

- **Zotero 7 或更高**（macOS 与 Windows；**兼容区间已放宽到 `6.999 – 99.*`，Zotero 后续版本升级不会再把你挡在门外**）。Zotero 9 经完整真机验证，Zotero 10 经真机加载与全链路自验，7/8 未真机验证
- **本机已安装并登录 Claude Code CLI**（`claude` 命令可用、`claude auth status` 显示已登录）。
  安装见 [Claude Code 官方文档](https://claude.com/claude-code)。插件不代装、不管理账号。

## 安装

1. 从 [Releases](../../releases) 下载最新 `zotero-claudian.xpi`
2. Zotero 菜单：**工具 → 插件**
3. 插件面板右上角齿轮 → **Install Plugin From File…** → 选刚下载的 `.xpi`
4. 重启 Zotero。工具栏出现「Claude」按钮即安装成功——点它会在阅读器右侧滑出对话浮层（阅读器右侧栏里也有同名面板可选）

> 未签名 XPI 的安装提示属正常（本插件不申请 Zotero 官方签名）。

## 使用

### 边读边问

1. 打开一篇 PDF → 点工具栏「Claude」按钮（或展开右侧栏的 Claude 面板）
2. 输入问题（例：_这篇的结论是什么？方法部分有什么局限？_）→ 回车
3. AI 自动获得当前文献上下文；需要引用原文时它自己读 PDF；换到另一篇 PDF 时面板会自动切到那篇的最近会话
4. 输入框按 **↑/↓** 可翻回你之前发过的消息（正在打但没发的草稿会先存住，翻回底部自动还原）

首次回答可能需要几十秒（每轮对话会启动一次 Claude Code 进程，与你直接使用 Claude Code 的加载成本相同）。

### 划选提问 / 存笔记

- PDF 里选中文字 → 弹窗点「Claude」→ 问题自动带上划选原文与页码
- 回答旁「存为笔记」→ 选择新建或追加到已有笔记
- 划选文字也可直接「存为笔记」

### 权限卡

- AI 请求执行命令（如运行一个 Python 脚本分析数据）→ 弹出权限卡
- **允许**执行一次；**允许并记住**本会话内同类命令不再询问；**拒绝**后 AI 会收到拒绝并停止该操作
- 权限档可在对话页顶栏或设置页切换：`默认`（文件编辑也弹卡）/ `接受编辑`（文件编辑自动放行，出厂默认）/ `计划`（只读规划，不落改动）/ **`放任`（不再弹权限卡，命令与文件读写一律放行）**
- 切到「放任」要**点两次**（第一次点亮提示「再点一次确认放任（5 秒内）」，5 秒内再点一次才生效，超时自动复原）；生效后顶栏控件变红并带后果说明。适合连续分析文献这类不想被卡打断的场景
- 注意设置页的「新会话默认权限档」：把它选成 `放任`是**一次点击、没有二次确认**，且对此后**所有新会话**生效（已在进行的会话不受影响，各自仍按自己的档位跑）——影响面比顶栏那次两步切换更大，改之前想清楚
- 「放任」档的风险边界（真机实测）：附件目录的防改写仍生效——Write/Edit 工具与 shell 重定向（如 `printf > 文件`）会被 deny 硬拒；但该档**没有权限卡兜底**，AI 若用脚本（如 `python3 -c "open(...,'w')"`）写附件目录不会被拦。只在你信任本轮任务时使用

### 会话与工作区

- 会话按文献条目自动分组；也支持不绑定文献的通用会话
- 重启 Zotero 后会话仍在，直接续聊
- 设置页可改**工作区目录**（AI 文件产出的落点，默认 `~/zotero-claudian-workspace`）

## 数据与安全

**数据流向**：你的提问、文献元数据、以及 AI 按需读取的 PDF 内容，会经本机 `claude` 进程发往**你自己配置的模型服务商**（官方或你自设的网关）。发送什么、发给谁，由你的 Claude Code 配置决定——与本插件无关。

本插件自身的边界（发布版经过对权限端点、消毒器、注入面的独立安全审计）：

- **默认不碰任何 API key**：认证完全依赖本机 CLI 登录态。**唯一例外**是你主动在设置页填入 DeepSeek API Key（可留空）——它只用于查询账户余额，明文存在 Zotero 设置里，插件只把它发给 `api.deepseek.com`
- **无遥测**；除上面那条 DeepSeek 余额查询（仅在你填了 Key 且当前 provider 判定为 deepseek 时发生）外，插件自身不直连任何外部地址
- **Zotero 库只读**：AI 经官方 API 读条目元数据/PDF/已有笔记；写库仅发生在你点击「存为笔记」时
- **PDF 原文受硬保护**：AI 读取 PDF 所在的附件目录用于引用原文，但该目录的写入被权限系统硬拒绝（经 `--settings` deny 规则实现，**macOS 真机验证** PDF 字节不会被改动；Windows 的同形态规则待真机验证）。该保护在前三个权限档与**放任档**下都生效（macOS 放任档实测：Write/Edit 工具与 shell 重定向均被拒）
- 命令执行经权限卡把关：`默认`/`接受编辑`/`计划` 档下都要过卡（或档位默认放行）；**`放任`档不弹卡**（需两次点击确认才生效，且脚本类写入不受附件目录 deny 覆盖，见上）——AI 不能自行切换档位

## 已知限制

- **Zotero 7/8 未真机验证**（API 对齐 + 兼容区间声明；欢迎反馈）
- **Windows 版**：代码与 CI 已按 Windows 适配（含 `claude.cmd` 通道与路径处理），真机验收进行中
- 首轮响应延迟：Claude Code 每轮加载你的 hooks/MCP 配置需要数秒（与终端使用同成本）
- LaTeX 公式渲染 v1 不支持（原文保留，v2 计划）；**mermaid 图与 SVG 已支持渲染**（HTML 保持源码显示——安全考虑）
- Linux 未支持

## 常见问题

**面板显示 CLI 未找到？** 检查终端里 `claude` 是否可用；若用了自定义安装路径，可在插件设置页「CLI 路径」里指定。

**为什么首答很慢？** 每轮对话会启动一个 Claude Code 进程并加载你的完整配置（MCP/hooks/技能）。这是"用你完整的 Claude Code 环境"的代价——换来的是你装的所有能力在 Zotero 里直接可用。

**会泄露我的文献吗？** 文献内容只发给你自己配置的模型服务商（见上「数据流向」）。插件本身不收集任何数据。

**会话存在哪？** Zotero 配置目录下 `claudian/`（插件自管）；会话正文同时存在于你本机 Claude Code 的会话目录中。删除插件内会话不会删除 Claude Code 的会话文件。

**怎么切换模型 / Provider（第三方中转）？** 插件不管理模型与 Provider——对话完全使用你本机 `claude` CLI 的配置，改 CLI 配置即可（**下一轮对话生效**，进行中的会话不中断）：

- **换模型**：设置环境变量 `ANTHROPIC_MODEL`（如 `claude-opus-5`），或改 Claude Code 的 settings（`~/.claude/settings.json` 的 `env`/`model`）。
- **换 Provider（中转站）**：设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 到你的中转地址（同样放在 shell 环境或 Claude Code settings 的 `env` 里）。
- 示例（写进 `~/.claude/settings.json` 的 `env` 对象，或你的 shell profile）：
  ```json
  { "env": { "ANTHROPIC_BASE_URL": "https://your-gateway.example", "ANTHROPIC_AUTH_TOKEN": "<你的令牌>", "ANTHROPIC_MODEL": "deepseek-flash" } }
  ```
- 修改后在本机终端跑一次 `claude -p "hi"` 验证生效，再回到 Zotero 继续对话。
- 插件不读取、不存储这些凭证；它们始终在你自己的 CLI 配置里。

**工作区目录可以放哪？** 默认 `~/zotero-claudian-workspace`（主目录下，不触发 macOS 文件夹授权）。若你手动把工作区改到 `~/Documents`、`~/Desktop`、`~/Downloads` 等受保护目录，macOS 会弹一次文件夹授权——拒绝后工作区将不可用（界面会明确报「工作区不可用」）。

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
