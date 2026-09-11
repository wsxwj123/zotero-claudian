hello-section-header = Claude
    .tooltiptext = zotero-claudian 对话
hello-section-sidenav =
    .tooltiptext = zotero-claudian 对话
chrome-register-failed = zotero-claudian：chrome 注册失败，UI 无法加载。详见帮助 → 调试输出日志。
main-tab-button =
    .tooltiptext = 打开/关闭 Claude 面板
dock-fullpage-label = 全页
    .tooltiptext = 在独立标签页中打开 Claude 工作台
dock-close-label = 关闭
    .tooltiptext = 收起 Claude 面板
prefs-pane-label = zotero-claudian
prefs-pane-title = Claude 工作台
prefs-pane-intro = Claude Code 工作台设置：AI 的工作目录、新会话默认权限档、claude 可执行文件路径。改动即时生效，进行中的对话不中断。
prefs-workspace-label = 工作区目录
prefs-workspace-browse = 浏览…
prefs-workspace-hint-empty = 留空 = 使用默认目录：{ $path }
prefs-workspace-hint-ok = 目录已就绪（AI 的文件产出会落在这里）
prefs-workspace-hint-missing = 目录尚不存在，将在下次对话时自动创建
prefs-workspace-hint-relative = 需填绝对路径（如 /Users/… 或 C:\…）；相对路径不能作为 AI 的工作目录
prefs-mode-label = 新会话默认权限档
prefs-mode-hint = default = 敏感操作逐项弹卡确认；acceptEdits = 文件编辑默认放行（推荐）；plan = 只读规划不落盘；bypass = 放任，不再弹权限卡（只给完全信任的任务用）
prefs-mode-item-default = default — 逐步确认
prefs-mode-item-acceptEdits = acceptEdits — 文件编辑放行（推荐）
prefs-mode-item-plan = plan — 只读规划
prefs-mode-item-bypass = bypass — 放任（不再弹权限卡）
prefs-mode-bypass-hint = 放任档：命令执行与文件读写一律放行、不再有权限卡可拦；附件目录的 PDF 防改写仍由 deny 规则硬挡，但 AI 用脚本绕道写文件不在保护内。顶栏切换该档需两次点击确认。
prefs-autoshow-label = 打开文献时自动显示 Claude 面板
prefs-autoshow-hint = 打开 PDF 后自动切到侧栏的 Claude 面板；关掉后需自己点侧栏图标切换
prefs-cli-label = claude 可执行文件路径
prefs-cli-hint-empty = 留空 = 自动查找（PATH 与常见安装位置）
prefs-cli-hint-ok = 路径有效
prefs-cli-hint-missing = 路径不存在：将回落自动解析，并在对话页顶部给出提示
prefs-usage-label = 显示用量/余额
prefs-usage-hint = 在对话页顶栏显示 token 用量与缓存命中率；provider 为 DeepSeek 且填了 Key 时同时显示账户余额。关闭 = 不查询也不显示余额（不会向 api.deepseek.com 发请求）
prefs-deepseek-label = DeepSeek API Key
prefs-deepseek-hint-empty = 留空 = 不查询余额。仅用于向 api.deepseek.com 查询余额（明文存在 Zotero 设置里）
prefs-deepseek-hint-set = 已填写：面板顶栏将显示余额（查询失败会给出原因，不会显示 Key 本身）
