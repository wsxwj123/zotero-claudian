/**
 * 插件 bundle 入口。
 *
 * 运行环境：addon/bootstrap.js 通过 loadSubScript 把本 bundle 载入一个以
 * `{ rootURI, _globalThis: ctx }` 为全局对象的沙箱（见 addon/bootstrap.js 注释）。
 * 本文件只做两件事：
 *  1. 在 Zotero 全局挂插件实例（约定槽位 Zotero[config.addonInstance]），
 *     供 addon/bootstrap.js 的生命周期回调转发 hooks；
 *  2. 让沙箱内其余模块能通过 `addon` 这个全局名拿到同一实例
 *     （各模块直接引用 `addon.xxx`，见 hooks.ts / utils/locale.ts）。
 */
import { config } from "../package.json";
import Addon from "./addon";

/** 载入上下文提供的沙箱全局（addon/bootstrap.js 里创建的 ctx） */
declare const _globalThis: Record<string, unknown>;

// 防重入：同一沙箱重复 loadSubScript 时只保留先建的实例
// （Zotero 命名空间未收录动态键，实例槽位这里按字符串键写入）
const zotero = Zotero as unknown as Record<string, unknown>;
if (!(config.addonInstance in zotero)) {
  const instance = new Addon();
  Object.defineProperty(_globalThis, "addon", { value: instance });
  zotero[config.addonInstance] = instance;
}
