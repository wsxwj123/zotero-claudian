/**
 * Zotero 插件引导脚本（非模块脚本：Zotero 读本文件并直接调用下列顶层函数）。
 *
 * 职责边界：
 *  - 本文件只做「把插件主体加载进沙箱 + 把 Zotero 生命周期事件转发给主体 hooks」；
 *  - 业务逻辑一律在 src/ 编译产物 content/scripts/claudian.js 里，本文件不含功能实现；
 *  - chrome:// 注册由主体侧 src/bootstrap.ts 负责（需失败上报，见该文件注释）。
 *
 * 沙箱约定：主体 bundle 用 loadSubScript 加载到以 _globalThis 为全局根的上下文里，
 * 主体通过该全局名读写沙箱全局（如 _globalThis.addon）。
 */

/** 取插件主体实例（主体启动后挂在 Zotero[<addonInstance>]；未加载成功时返回 null） */
function getAddonInstance() {
  return Zotero.__addonInstance__ ?? null;
}

/** 加载插件主体并启动它。重复调用安全：bundle 自带防重入。 */
async function loadAddon(rootURI) {
  const context = { rootURI };
  // 沙箱全局根：主体运行时以 _globalThis 为全局对象（本行不可省）
  context._globalThis = context;
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    context,
  );
  await getAddonInstance()?.hooks.onStartup();
}

/** 首次安装。本轮无需做任何事（数据目录在被访问时才创建）。 */
async function install(data, reason) {}

/** Zotero 启动完成、插件被启用：加载并启动主体。 */
async function startup({ rootURI }, reason) {
  await loadAddon(rootURI);
}

/** 生命周期结束：非应用级退出（重载/禁用/卸载）时让主体自己清理。 */
async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  await getAddonInstance()?.hooks.onShutdown();
}

/** 主窗口就绪/关闭：转发给主体，由主体决定挂载与卸载哪些 UI。 */
async function onMainWindowLoad({ window }, reason) {
  await getAddonInstance()?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await getAddonInstance()?.hooks.onMainWindowUnload(window);
}

/** 卸载。清理在 shutdown 完成，这里无需重复。 */
async function uninstall(data, reason) {}
