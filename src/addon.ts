/**
 * 插件实例：生命周期状态与运行时共享数据的容器。
 *
 * 可见性约定（不要随意改名，改动会波及 addon/bootstrap.js 与构建配置）：
 *  - 实例挂载于 `Zotero[config.addonInstance]`（构建期替换为 addonInstance 值）；
 *  - 沙箱内以全局名 `addon` 访问（src/index.ts 注入）；
 *  - `data.initialized` 是构建工具的启动就绪信号
 *    （zotero-plugin.config.ts 的 waitForPlugin 读这个字段）。
 *
 * 注意：hooks 必须在这里持有引用。它是全插件唯一的生命周期入口，
 * 一旦这里不再 import ./hooks，bundler 会把整个 hooks 子树判为无用代码丢掉，
 * 产物只剩空壳（插件装得上但什么也不做）。
 */
import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    /** false = 已 shutdown，后续回调不应再动 UI */
    alive: boolean;
    /** true = onStartup 全流程走完 */
    initialized: boolean;
    /** Fluent 本地化 bundle，由 utils/locale.initLocale() 填充 */
    locale: { fluent: Localization } | null;
    config: typeof config;
  };
  /** 生命周期回调表：addon/bootstrap.js 通过 Zotero[addonInstance].hooks 调用 */
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      initialized: false,
      locale: null,
      config,
    };
    this.hooks = hooks;
  }
}

export default Addon;
