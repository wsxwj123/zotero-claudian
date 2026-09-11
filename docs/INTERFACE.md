# 接口约定（INTERFACE）

> 本文档是插件对外接口契约（供开发者与集成方参考）。

## 4. 对外接口约定

> 每个入口都写明错误契约与错误码。

### 4.1 spawn 命令行组装规则（按 OS 参数化，win32 规则见 DESIGN.md B 段）

- **可执行文件（按 OS）**：cliDetect 解析出的 claude 绝对路径（darwin：PATH + 常驻目录；win32：PATH/注册表快照 + 常驻目录，npm `.cmd` 壳优先解析到包内 `claude.exe`，解析失败才落 `.cmd` 壳走 cmd.exe 通道）；设置项 `cliPathOverride` 非空时优先（校验失败回落自动解析）。
- **darwin 派发通道**：经 `/bin/sh -c '<ulimit 提限脚本>' <claude 路径> <原参数…>` 包装（2026-09-11 真实 Zotero 实测增补：launchd 继承 fd 软限 256 致 CLI 启动失败；提限尽力而为失败不阻断；参数独立 argv 无注入面）。
- **win32 派发通道**：解析产物为 `.exe` → argv 直接交 Subprocess；仅 `.cmd` 壳 → **绝对路径** `cmd.exe`（ComSpec/SystemRoot 解析；Gecko 不搜 PATH、裸名拒收）+ args `["/C", line]` 派发——args 2 元经 Gecko 内部 unshift(command) 后命中其 cmd.exe 特例分支，由 Gecko 对 line 原样补最外层引号（避开通用分支的 CRT 二次转义）；line 内逐参数双引号 + CRT 反斜杠规则（`"` → `\"`、引号前反斜杠翻倍，最终由 .cmd 壳透传给 node 解析）、line ≤8191 字符校验、参数含换行即拒绝该轮 spawn（回 `SPAWN_FAILED`）。prompt 不在参数内（走 stdin），不受上述限制。
- **参数序列（顺序固定）**：
  1. `-p` `--output-format` `stream-json` `--verbose` `--include-partial-messages`（恒带）
  2. `--resume <claudeSessionId>`（续接时；首轮不带）
  3. `--permission-mode <default|acceptEdits|plan>`（恒带，取会话当前档）
  4. `--add-dir <PDF所在目录绝对路径>`（当前会话关联条目有 PDF 附件才带；多个 PDF 附件取第一个；只加单篇附件所在目录，随该轮进程结束失效，不持久化）
  5. `--settings <deny 配置文件路径>`（有附件目录时恒带，2026-09-11 增补：插件生成临时 settings，`{"permissions":{"deny":["Write(//<附件目录>/**)","Edit(//<附件目录>/**)"]}}`——acceptEdits 档对 add-dir 目录的 Write/Edit 硬拒绝（实测：不弹卡直拒、Read 不受影响、PDF 字节不动）；文件写插件数据目录、每轮唯一名、0600、进程结束清理；生成失败 → 该轮不 spawn 回 `SPAWN_FAILED`。win32 路径形态 `//C:/…/**` 待 Windows 真机验证）
  6. `--allowedTools <rule…>`（session.allowedTools 非空才带，逐条独立传参；规则串生成算法见 §4.6）
  7. `--mcp-config '{"mcpServers":{"claudian-perm":{"type":"http","url":"http://127.0.0.1:<port>/mcp?token=<随机token>"}}}'` + `--permission-prompt-tool mcp__claudian-perm__permission_check`（恒带；权限卡主案，schema 见 §4.8，token 见 §4.8。**不带 `--strict-mcp-config`**，用户自有 MCP 配置照常生效；两者合并行为开发期首验，见 DESIGN.md 风险 3）
- **恒不携带**：`--bare`、`--model`、`--append-system-prompt`、`--fork-session`、prompt 的 argv 参数。
- **cwd**：工作区目录；spawn 前不存在则插件侧 mkdir，失败 → 不 spawn，桥回 `error {code:"WORKSPACE_UNAVAILABLE"}`。win32 下 cwd 为原生反斜杠绝对路径。
- **stdin**：prompt 全文（4.1.1 模板产物）写入后 `close()`。**恒走 stdin，两 OS 一致**——win32 侧这是对 cmd.exe 8191 上限 / 换行截断 / CRT 引号陷阱的整体规避（DESIGN.md B）。
- **env**：宿主进程环境原样透传，仅覆盖追加 `PATH`。darwin 取登录 shell PATH（见 DESIGN.md，源自 Z 4.2）；win32 取「进程 PATH + 常驻目录兜底」（`;` 分隔，不探登录 shell——win32 无 SHELL；注册表快照未接线为本版已知遗留，DESIGN.md A/C，Windows 真机必测），并保证 `SystemRoot`/`TEMP` 在环境内（透传用户环境天然满足，仅防用户环境残缺）。

**4.1.1 prompt 模板**（上下文块在前、用户输入原样在后；通用会话无块）：

```
[Zotero context]
Title: {displayTitle}
Authors: {creators，逗号连接}
Year: {date 截取年份}
DOI: {DOI，无则省略行}
Abstract: {abstractNote，无则省略行}
PDF path: {附件绝对路径}
Current page: {当前页码}
Selected text (page {页码}): "{划选原文}"
[/Zotero context]

{用户输入原样}
```

字段缺省规则：无划选 → 省 Selected text 行；划选存在但拿不到页码 → 整行省略（不输出空括号畸形行）；无 PDF 附件 → 省 PDF path 行且不带 `--add-dir`；通用会话（无条目）→ 整块省略。**Selected text 行仅当划选所属条目 = 会话绑定条目时保留**（切文献后续接旧会话时 selection 取自当前 reader，条目不一致则省略该行，防上下文错拼）。页码统一给物理页码，pageLabel 与物理页码不同时写成 `{物理页码} (label: {pageLabel})`（Current page 行与 Selected text 行同格式）。块内值做单行化处理（换行替换为空格，Selected text 保留原文换行、长度上限 10000 字符截断）。**OS 差异**：PDF path 行保留各 OS 原生分隔符（win32 反斜杠原样，经 stdin 不经 shell 无需转义），两 OS 模板结构完全一致。

### 4.2 stream-json 事件 → UI 消息映射表

protocol.ts：字节流按 `\n` 分帧 → 逐行 `JSON.parse`（失败行进 debug log，不抛错）→ 映射为标准事件 → hostBridge 包装 `{type:"streamEvent", sessionId, event}` 推 UI。

| CLI 流事件                                                            | 标准事件 (event.kind)                                                                  | UI 行为                                                               | 错误契约                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type":"system","subtype":"init",...}`                              | `init` {claudeSessionId, model, permissionMode, tools[], mcpServers[]}                 | 更新会话头部；首轮把 claudeSessionId 落索引                           | 缺 session_id → 丢事件+log                                                                                                                                                                                                                                                          |
| `stream_event` / `message_start`                                      | `messageStart`                                                                         | 新建 assistant 气泡                                                   | —                                                                                                                                                                                                                                                                                   |
| `stream_event` / `content_block_start`(text)                          | `textBlockStart` {index}                                                               | 开始文本块                                                            | —                                                                                                                                                                                                                                                                                   |
| `stream_event` / `content_block_delta`(text_delta)                    | `textDelta` {index, text}                                                              | 追加文本流式渲染                                                      | text 非字符串 → 丢该 delta                                                                                                                                                                                                                                                          |
| `stream_event` / `content_block_delta`(thinking_delta)                | `thinkingDelta` {index, text}                                                          | thinking 折叠区追加                                                   | 同上                                                                                                                                                                                                                                                                                |
| `stream_event` / `content_block_start`(tool_use) + `input_json_delta` | `toolBlockStart` {index, toolName, toolUseId} / `toolInputDelta` {index, jsonFragment} | 工具卡（折叠）+ 参数流式（textContent 展示）                          | 未知工具名照常显示                                                                                                                                                                                                                                                                  |
| `{"type":"assistant","message":{...}}`                                | `assistantMessage` {content[]}                                                         | 校准最终块状态                                                        | —                                                                                                                                                                                                                                                                                   |
| `{"type":"user",...}`（tool_result 回流）                             | `toolResult` {toolUseId, isError, summary}                                             | 工具卡附结果；Edit/Write 类展示 diff                                  | summary 提取优先级：content 为字符串 → 原值；content 为数组 → 按序拼接其中 `type:"text"` 块；两者皆无 → `[{首块 type 名}]` 占位（如 `[image]`）。超 4KB 截断。**一条 user 消息含多个 tool_result 块（并行工具调用）时，每块各产出一条 `toolResult` 事件，UI 按 toolUseId 分别回填** |
| `{"type":"system","subtype":"api_retry",...}`                         | `apiRetry` {attempt, maxRetries, delayMs}                                              | 状态行「重试中」                                                      | —                                                                                                                                                                                                                                                                                   |
| `{"type":"result","subtype":"success",...}`                           | `result` {claudeSessionId, costUsd, durationMs, numTurns}                              | turn 完成；落索引；该轮 user/assistant 最终文本追加进旁挂历史（§4.5） | —                                                                                                                                                                                                                                                                                   |
| `{"type":"result","subtype":"error*",...}`                            | `resultError` {subtype, errors[]}                                                      | 错误横幅                                                              | —                                                                                                                                                                                                                                                                                   |
| 其他未知 type/subtype                                                 | 丢弃 + debug log                                                                       | 无 UI 影响                                                            | 前向兼容保证                                                                                                                                                                                                                                                                        |
| 进程退出非 0 且无 result                                              | `procError` {exitCode, stderrTail}                                                     | 错误卡（stderr 尾部 ≤500 字符）                                       | stderrTail 含 resume/session 失效关键字（如 `No conversation found` 及 session 不存在类报错）→ 判定 `SESSION_GONE`（§4.6 错误码表），UI 给「新建会话」按钮；其余为通用错误                                                                                                          |
| spawn ENOENT                                                          | `procError` {exitCode:null, reason:"CLAUDE_NOT_FOUND"}                                 | 安装引导卡                                                            | —                                                                                                                                                                                                                                                                                   |

### 4.3 笔记写入动作（notes.ts，宿主侧仅经桥触发）

| 动作       | 入参                                      | 出参（成功）                                              | 错误契约                   |
| ---------- | ----------------------------------------- | --------------------------------------------------------- | -------------------------- |
| 新建笔记   | `{itemKey, mode:"new", html}`             | `{ok:true, noteKey}`                                      | `{ok:false, code}`，码见下 |
| 追加笔记   | `{itemKey, mode:"append", noteKey, html}` | `{ok:true, noteKey}`                                      | 同上                       |
| 列已有笔记 | `{itemKey}`                               | `{ok:true, notes:[{noteKey, title(≤80字符), updatedAt}]}` | 同上                       |

- `html` 由前端产出（markdown 走 marked、纯文本包 `<p>`），宿主经 htmlSanitize 白名单终检后 `setNote`/`saveTx`。
- 追加语义：目标笔记 HTML 末尾追加 `<hr>` + `<p><small>zotero-claudian 追加（ISO 时间）</small></p>` + 内容段；不修改原文任何已有内容。拼接逻辑抽纯函数 `src/utils/noteAppend.ts`（node 单测）。
- 错误码：`ITEM_NOT_FOUND`（条目 key 查无）/ `NOTE_NOT_FOUND` / `EMPTY_CONTENT` / `SANITIZE_REJECTED`（消毒后为空）/ `SAVE_FAILED`（Zotero 异常，message 附原文）。
- 失败不自动重试；写入失败即回滚语义由 saveTx 事务保证。

### 4.4 设置项清单

| 键                                                 | 类型       | 默认                                                                                                                                                                                           | 生效时机                                           |
| -------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------- | ---------------- |
| `extensions.zotero-claudian.workspacePath`         | string     | darwin：`~/Documents/zotero-claudian-workspace`（`~` 展开）；win32：`%USERPROFILE%\Documents\zotero-claudian-workspace`（经系统 API 取 Documents 实际落点，兼容 OneDrive 重定向，DESIGN.md D） | 下一次 spawn 即生效，进行中会话不中断              |
| `extensions.zotero-claudian.defaultPermissionMode` | `"default" | "acceptEdits"                                                                                                                                                                                  | "plan"`                                            | `"acceptEdits"` | 新建会话的初始档 |
| `extensions.zotero-claudian.cliPathOverride`       | string     | `""`                                                                                                                                                                                           | 空=自动解析；非空校验失败 → 回落自动解析并 UI 告警 |

存储走 Zotero.Prefs；设置页经 `Zotero.PreferencePanes.register`（见 DESIGN.md，源自 Z 1）。

### 4.5 会话存储格式

- 路径：独立数据目录 `Zotero.Profile.dir + "/claudian/"`——索引 `sessions.json`，旁挂历史 `history/<sessionId>.jsonl`（不放 `extensions/<id>/` 下，防扩展安装/更新流程波及数据文件）。**路径拼接一律 `PathUtils.join`，不手拼 `/`**（win32 分隔符为 `\`，DESIGN.md D）；profile 目录本身由 `Zotero.Profile.dir` 按平台返回（darwin `~/Zotero`，win32 `%APPDATA%\Zotero\Profiles\<xxx>`）。
- 写策略：索引写入收敛到 sessionStore **单一 writer 队列**串行执行（防并发交错）；每次状态变化全量重写；先写 `sessions.json.tmp` 再 rename（原子替换）。

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "插件侧 uuid",
      "claudeSessionId": "CLI session_id，首轮未完成时为 null",
      "title": "首条用户消息前 40 字符",
      "createdAt": 1736000000000,
      "updatedAt": 1736000000000,
      "itemKey": "父条目 key，通用会话为 null",
      "itemLibraryID": 1,
      "attachmentKey": "PDF 附件 key，无则 null",
      "permissionMode": "acceptEdits",
      "allowedTools": ["Bash(python *)"],
      "messageCount": 3,
      "lastCostUsd": 0.012
    }
  ]
}
```

- 损坏恢复：`JSON.parse` 失败 → 原文件改名 `sessions.json.bak-<时间戳>` 后新建空索引，UI 提示「会话索引已重置」。
- **旁挂历史（UI 重建消息列表用）**：`history/<sessionId>.jsonl`，每行 `{"role":"user"|"assistant","text":…,"ts":…}`。每轮 turn 结束（`result` 事件到达）时追加两行：该轮用户输入原文与最终 assistant 文本（流式中不写，按最终文本落盘）。UI 切换会话/重启 Zotero 后经桥 `getHistory` 拉取回放重建消息列表（§4.6）。
- `messageCount` 口径：按消息条数计——user 与 assistant 各计 1，工具调用卡不计。
- 删除会话：移除索引记录并删除对应 `history/<sessionId>.jsonl`；不碰 `~/.claude` 下任何文件。

### 4.6 宿主↔UI 桥协议（握手方向已实测定型：宿主先发）

- 通道：`browser.contentWindow.postMessage` 双向；宿主只接受 `event.source === 已注册实例的 contentWindow` 的消息；消息一律 JSON 对象且必含 `type`。页面侧全部回发走 `event.source.postMessage(msg, "*")`——browser 内页面是顶层 browsing context（`window.parent === window`），持有不了宿主 window 引用，无法主动发出第一条消息。
- **握手时序（三步闭环，spike 实测）**：① 宿主在 browser `load` 事件里向该实例 `contentWindow.postMessage({type:"init"})`，同时把该 contentWindow 记入 pending 集合；② 页面收到 init 后以 `event.source` 回发 `{type:"hello"}`；③ 宿主校验 `event.source` 在 pending 集合内 → 注册实例、移出 pending、回 `sessionList`，UI 收到即注册完成。
- 实例注销：section 销毁（onDestroy）与 tab 关闭（`Zotero_Tabs.add` 的 `onClose`）时移除实例引用并移出 pending 集合，此后不再向其 postMessage（防向死实例发消息）。
- 宿主发 init 后 30s 未收到 hello（页面脚本错误/加载失败）→ log error，实例保持未注册，UI 停留空态。
- **并发契约（写死）**：会话有进行中 turn（进程存活）时再收 `send` → 回 `error {code:"SESSION_BUSY"}`，**不排队**；`interrupt` 后会话进入 interrupting 态，直到进程退出（收到 result/procError）才解锁 send；索引写入收敛到单一 writer 队列（§4.5）。
- **UI 侧对称校验与重载幂等**：bridgeClient 收 init 时校验 `event.origin` 属可信集（`chrome://zotero`——init 实际发送方是 Zotero 主窗口，或 `chrome://claudian` 精确 origin，带 host 边界防止 `chrome://claudian-evil` 类前缀绕过）才回 hello；browser 重载会触发二次握手，宿主 pending 集合与注册表以 contentWindow 为键幂等去重（重复 init、重复 hello 只注册一次）。

**UI→宿主：**

| type                 | 字段                       | 宿主行为                                                                                            | 非法输入契约                                                   |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `hello`              | —                          | 校验来源在 pending 集合 → 注册实例，回 `sessionList`                                                | 来源不在 pending（未收到过 init 或已注册）→ 忽略               |
| `send`               | sessionId?, text           | 会话有进行中 turn → `error {code:"SESSION_BUSY"}`（不排队，§4.6 并发契约）；否则组装 prompt → spawn | text 空白/非字符串 → **忽略**（UI 侧发送按钮对空文本本就禁用） |
| `interrupt`          | sessionId                  | kill 当前进程，会话进入 interrupting 态至进程退出                                                   | 无进行中进程 → 忽略                                            |
| `permissionResponse` | requestId, allow, remember | 回写 MCP 端点；remember=true 按下方确定性算法追加 allowedTools                                      | 未知 requestId → 忽略                                          |
| `saveNote`           | 见 4.3                     | 调 notes.ts                                                                                         | 回对应错误码                                                   |
| `listNotes`          | itemKey                    | 回笔记清单                                                                                          | 回错误码                                                       |
| `createSession`      | itemKey?                   | 建索引记录（claudeSessionId=null）                                                                  | itemKey 查无 → `error ITEM_NOT_FOUND`                          |
| `deleteSession`      | sessionId                  | 移除索引记录 + 删旁挂历史文件                                                                       | 未知 id → 忽略                                                 |
| `getHistory`         | sessionId                  | 读 `history/<sessionId>.jsonl` → 回 `history` 事件                                                  | 未知 id 或无文件 → 回空消息数组                                |
| `openExternal`       | url                        | 校验 http/https 后 `Zotero.launchURL` 外部打开（chrome:// 页面内链接一律由此出，§4.7）              | 非 http(s) → 忽略 + log                                        |
| `setPermissionMode`  | sessionId, mode            | 更新索引，下轮 spawn 生效                                                                           | mode 非三档之一 → 忽略+log                                     |
| `getState`           | —                          | 回 `sessionList`                                                                                    | —                                                              |

**remember 规则串生成算法（确定性）**——`allow && remember=true` 时：

- `Bash` → `Bash(<input.command 首个词> *)`（如 `python -V` → `Bash(python *)`；command 非字符串或为空 → 记整名 `Bash`）；
- Edit/Write/NotebookEdit → acceptEdits 档不追加（已默认放行）；default 档记整名（`Edit` 等）；
- MCP 工具 → `mcp__<server>__<tool>` 整名；
- 其余工具（Read/Glob/Grep/WebFetch/WebSearch 等）→ 记整名，不记参数前缀（路径类前缀无泛化价值且泄露文件路径）。
  生成结果 debug log 一条；规则串最终语法以 §4.8 实测项实测为准，不符则修正本算法。

**宿主→UI：**

| type                     | 说明                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `init`                   | 握手首条：宿主在 browser `load` 事件发出 `{type:"init"}`，触发页面回发 hello                   |
| `sessionList`            | 全量会话索引 + 条目标题解析结果                                                                |
| `streamEvent`            | `{sessionId, event}`（映射见 4.2）                                                             |
| `history`                | `{sessionId, messages:[{role, text, ts}]}` —— 会话历史回显，UI 重建消息列表用（§4.5 旁挂历史） |
| `permissionRequest`      | `{requestId, tool, inputSummary, rawInput}`                                                    |
| `noteSaved` / `noteList` | 对应 4.3 出参                                                                                  |
| `error`                  | `{code, message}`                                                                              |
| `readerContext`          | `{itemKey, title, page, selection}` —— UI 顶栏显示当前关联文献                                 |

**错误码总表**（桥 error 事件与函数出参共用）：
`CLAUDE_NOT_FOUND` / `CLAUDE_AUTH_FAILED` / `WORKSPACE_UNAVAILABLE` / `SPAWN_FAILED`（含端点故障不 spawn，§4.8）/ `SESSION_BUSY`（会话有进行中 turn，send 拒绝，不排队）/ `ITEM_NOT_FOUND` / `NOTE_NOT_FOUND` / `EMPTY_CONTENT` / `SANITIZE_REJECTED` / `SAVE_FAILED` / `SESSION_GONE`（resume 失效：进程退出非 0 且无 result，stderrTail 含 resume/session 失效关键字——如 `No conversation found`、session 不存在类报错；UI 同时给「新建会话」按钮）。

### 4.7 UI 加载契约（已实测定型）

- **chrome 注册**：bootstrap 启动时 `Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup).registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "claudian", "content/"]])`；shutdown 里 `chromeHandle.destruct()` 注销。注册失败 → log error + Zotero 通知区提示，不静默（chrome:// 是唯一可用加载路径，无 file:// 回退，见 DESIGN.md 风险 1）。
- **入口 URL**：`chrome://claudian/content/chat/index.html`。file:// 直载已实测不可用：`remote="true"` 加载永久卡死（contentWindow 恒 null），非 remote 静默无效，两者均排除。
- **loadURI 形态**：`browser.loadURI(Services.io.newURI(url), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()})`（FF 140 直接传字符串报 CancelContentJSOptions）。
- **browser 属性**：`type="content" disableglobalhistory="true" flex="1"`，**不加 remote**。
- **主窗口兜底**：bootstrap 对主窗口做轮询兜底（sideload 首启时 `onMainWindowLoad` 可能不触发——wm listener 只覆盖之后新开的窗口；template 正常安装无此问题）。
- bundle 纯本地：无外链脚本/字体/CDN（敏感面「无直连外网」）。
- AI 产出的 markdown 必经 DOMPurify 消毒再 innerHTML；DOMPurify hook 强制剥离 `a` 的 `target` 属性；工具入参 JSON 用 textContent 渲染。
- **链接导航拦截（chrome:// 特权页面）**：渲染层在 capture 阶段拦截渲染产物内所有 `a` 点击（preventDefault），经桥发 `openExternal {url}`，宿主校验 http/https 后 `Zotero.launchURL` 用外部浏览器打开（§4.6 桥消息）。特权页面内绝不发生到远程内容的导航——防特权上下文（systemPrincipal）加载远程 JS。

### 4.8 权限 MCP 端点契约（permissionMcp.ts，spike 假设 4 实测定型）

端点：`nsIServerSocket` 监听 127.0.0.1 随机端口，路径 `/mcp`，streamable-HTTP MCP（JSON-RPC 2.0），仅接受本机连接。

实测握手序列（按到达顺序处理）：

| CLI 请求                     | 端点响应                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| `server/discover` probe      | `{}`                                                                     |
| `initialize`                 | 回显 protocolVersion；**响应头带 `Mcp-Session-Id`**                      |
| `notifications/initialized`  | 202（空体）                                                              |
| `GET /mcp`（SSE 长连接探测） | 405（不影响后续流程）                                                    |
| `tools/list`                 | 清单含 `permission_check`，入参 schema `{tool_name, input, tool_use_id}` |
| `tools/call`                 | 见下                                                                     |

- `tools/call.params.arguments` 实测形态：`{"tool_name":"Bash","input":{…},"tool_use_id":"call_…"}`，`_meta` 含 `claudecode/toolUseId` 与 progressToken。
- 宿主行为：收到 tools/call → 经桥发 `permissionRequest {requestId, tool, inputSummary, rawInput}` → 等 `permissionResponse`（用户 120s 未响应按 deny 处理）→ 回 JSON-RPC 结果，`content` 为 `[{type:"text", text:<下述 JSON 字符串>}]`：
  - **允许**：`{"behavior":"allow","updatedInput":<原 input>}`（最简格式即可，无需 structuredContent）→ 命令真实执行
  - **拒绝**：`{"behavior":"deny","message":"User denied this action on the permission card."}` → CLI 侧 tool_result `is_error:true`、message 原样传达给 AI，`result.permission_denials` 记录完整入参
- 错误契约：端点启动失败/端口占用/响应异常 → 该轮**不 spawn**，桥回 `error {code:"SPAWN_FAILED"}` 报错横幅，用户重试即重试主案（无后备路径，DESIGN.md）。
- **URL token**：spawn 时生成一次性随机 token，mcp-config url 写作 `http://127.0.0.1:<port>/mcp?token=<random>`；端点对每个请求校验 query token，不合法 → 403。防本机其他无鉴权进程触发权限卡；token 仅存在于该轮 spawn 参数与端点内存，随进程结束作废。
- **开发期实测项**：allow+remember 生成的规则串（如 `Bash(python *)`）在下一轮 spawn 携带 `--allowedTools` 后是否免卡生效；规则串语法错误时 CLI 的行为（报错 or 静默失效）；以实测结果回填/修正 §4.6 生成算法。
