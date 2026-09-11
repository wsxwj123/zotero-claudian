/**
 * zotero-plugin-toolkit 实例工厂。
 *
 * 只有模块级副作用需要按环境区分（生产静音日志、开发打开元素日志）；
 * 每次调用都新建一个实例，调用方用完自行丢弃，不做全局单例缓存。
 */
import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit(): ZoteroToolkit {
  const toolkit = new ZoteroToolkit();
  const dev = __env__ === "development";

  toolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  toolkit.basicOptions.log.disableConsole = !dev;
  toolkit.UI.basicOptions.ui.enableElementJSONLog = dev;
  toolkit.UI.basicOptions.ui.enableElementDOMLog = dev;
  // 插件身份，toolkit 的 API 层用于错误归因
  toolkit.basicOptions.api.pluginID = config.addonID;
  // 通知弹窗默认图标取插件自己的 favicon（chrome:// 已注册）
  toolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.png`,
  );

  return toolkit;
}
