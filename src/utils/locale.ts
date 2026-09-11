/**
 * Fluent 本地化：插件 FTL 的加载与查询。
 *
 * 约定（构建期处理，见 zotero-plugin-scaffold）：
 *  - `addon/locale/<lang>/addon.ftl` 进包后改名 `<addonRef>-addon.ftl`；
 *  - 消息 id 实际带 `<addonRef>-` 前缀，因此源码里写不带前缀的 id，
 *    查询时由本模块补前缀（例如 getString("prefs-pane-label") 查 claudian-prefs-pane-label）。
 */
import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";

export { initLocale, getString, getLocaleID };

/** 只声明实际用到的能力（Localization 类本体未收录进 zotero-types） */
type FormattedEntry = {
  value: string | null;
  attributes: Array<{ name: string; value: string }> | null;
};
type MessageFormatter = {
  formatMessagesSync: (
    ids: Array<{ id: string; args?: L10nArgs }>,
  ) => Array<FormattedEntry | null>;
};
type LocalizationCtor = new (
  resourceIds: string[],
  sync: boolean,
) => Localization;

/** 载入后的 FTL bundle；initLocale() 之前为 null，查询时回落到 id 原文 */
let bundle: MessageFormatter | null = null;

/** 取 Localization 构造器：优先沙箱全局，取不到再从主窗口兜底（Zotero 7+ 两者都有） */
function localizationCtor(): LocalizationCtor {
  const ctor =
    typeof Localization === "undefined"
      ? (
          Zotero.getMainWindow() as unknown as {
            Localization: LocalizationCtor;
          }
        ).Localization
      : (Localization as unknown as LocalizationCtor);
  return ctor;
}

/**
 * 载入插件 FTL（onStartup 内调用一次）。
 * 第二个参数 true = 允许异步加载其它语言变体（如 zh-CN 下同时读 en-US 兜底）。
 */
function initLocale(): void {
  const l10n = new (localizationCtor())([`${config.addonRef}-addon.ftl`], true);
  bundle = l10n as unknown as MessageFormatter;
  addon.data.locale = { fluent: l10n };
}

/**
 * 查询本地化文案。
 *
 * 三种调用形态：
 *   getString(id)                         — 取消息主体
 *   getString(id, "attr")                 — 取消息的某个 attribute（FTL 的 .attr 行，如 .tooltiptext）
 *   getString(id, { args: {...} })        — 取消息主体并填入 FTL 变量
 *
 * 查询失败（消息不存在 / 未初始化）时回落到带前缀的 id 原文，绝不抛错——
 * 文案缺失不应该让功能挂掉。
 */
function getString(id: FluentMessageId): string;
function getString(
  id: FluentMessageId,
  options: { args?: Record<string, unknown> },
): string;
function getString(id: FluentMessageId, attribute: string): string;
function getString(
  id: FluentMessageId,
  arg?: string | { args?: Record<string, unknown> },
): string {
  const fullId = getLocaleID(id);
  const attribute = typeof arg === "string" ? arg : undefined;
  const args = (typeof arg === "object" ? arg.args : undefined) as
    | L10nArgs
    | undefined;

  // 未知消息 id 返回 [null]；命中时 attributes 与 value 一并返回
  const entry = bundle?.formatMessagesSync([{ id: fullId, args }])[0];

  if (attribute) {
    return (
      entry?.attributes?.find((a) => a.name === attribute)?.value ?? fullId
    );
  }
  return entry?.value ?? fullId;
}

/** 给消息 id 补构建期前缀（section 的 l10nID 等需要完整 id 的场景用） */
function getLocaleID(id: FluentMessageId): string {
  return `${config.addonRef}-${id}`;
}
