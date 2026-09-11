pref("workspacePath", "");
// R6：single = 所有会话共用一个工作区（默认）；collection = 按当前合集分子目录
pref("workspaceMode", "single");
pref("defaultPermissionMode", "acceptEdits");
pref("cliPathOverride", "");
pref("autoShowPane", true);
// R4-3：DeepSeek 余额查询用的 Key（空 = 不启用；明文存 prefs 是 PLAN-R4 §4 已批准的取舍）
pref("deepseekApiKey", "");
// R4-3：面板顶栏显示用量/余额（关掉即整行不渲染）
pref("showUsage", true);
// R7-K：置顶会话 id（JSON 数组串；不限量、不受归档影响）
pref("pinnedSessions", "");
