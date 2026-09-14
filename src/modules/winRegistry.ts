// winRegistry.ts — R15 F3：读 Windows 注册表里的**实时** PATH（机器级 + 用户级）。
//
// 为什么需要它（PLAN-R15 RC2）：Zotero 进程拿到的 PATH 是启动那一刻的快照——用户装完 claude
// （安装器把目录追加进 HKCU\Environment\Path）后不重启就永远看不到，表现为「装了却检测不到、
// 要重开 Zotero 才行」。直接问注册表拿最新值即可，无须重启、零 spawn。
//
// 可行性（PLAN-R15 已核实）：nsIWindowsRegKey 在 Zotero 自带 Gecko 里可用——Zotero 自己的
// 出货代码（omni.ja 的 addon manager / XPIProvider.sys.mjs）就在用同一组件；`%USERPROFILE%`
// 这类片段由 Gecko 在 readStringValue 内展开（XPCOM 的 ReadStringValue 带 ExpandEnvironment）。
//
// 只读、绝不写注册表；非 win32 / 组件缺失 / 键不存在 / 值类型不对 → 一律 [] + log（降级不抛）。

/** HKLM 机器级环境变量所在键（系统 PATH 的权威位置） */
const HKLM_SESSION_ENV =
  "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

const ROOT_KEY_CURRENT_USER = 0x80000001; // nsIWindowsRegKey.ROOT_KEY_CURRENT_USER
const ROOT_KEY_LOCAL_MACHINE = 0x80000002;
const ACCESS_READ = 0x20019; // ACCESS_QUERY_VALUE | ACCESS_ENUMERATE_SUB_KEYS | ACCESS_NOTIFY
const WOW64_64 = 0x100;

interface WinRegKeyLike {
  open(rootKey: number, relPath: string, mode: number): void;
  readStringValue(name: string): string;
  close(): void;
}

function createWinRegKey(): WinRegKeyLike | null {
  try {
    const classes = Components.classes as unknown as Record<
      string,
      { createInstance(iface: unknown): WinRegKeyLike }
    >;
    return classes["@mozilla.org/windows-registry-key;1"].createInstance(
      Components.interfaces.nsIWindowsRegKey,
    );
  } catch (err) {
    Zotero.logError(err as Error);
    return null;
  }
}

/** 读一个 REG_SZ/REG_EXPAND_SZ 值（Gecko 负责展开 %VAR%）；任何异常 → "" */
function readRegString(
  rootKey: number,
  subKey: string,
  name: string,
  wow64Flag: number,
): string {
  const key = createWinRegKey();
  if (!key) {
    return "";
  }
  try {
    key.open(rootKey, subKey, ACCESS_READ | wow64Flag);
  } catch {
    try {
      if (wow64Flag !== 0) {
        // 机器级键在个别 WOW64 视图下读不到：退到默认视图再试一次（PLAN-R15 §9 R1）
        key.open(rootKey, subKey, ACCESS_READ);
      } else {
        return "";
      }
    } catch {
      return "";
    }
  }
  try {
    return key.readStringValue(name);
  } catch {
    return "";
  } finally {
    try {
      key.close();
    } catch {
      // 关不上不影响本次读取结果
    }
  }
}

/**
 * 注册表 PATH 串 → 目录数组（纯函数，可单测）：
 * 去引号（手输 `"C:\Program Files\Foo"` 的人常这么写）、trim、丢空段、
 * 只留绝对路径（`X:\…` 或 UNC `\\server\…`）——相对路径按 cwd 解析不可预测，丢。
 */
export function splitRegPathList(raw: string): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? "").split(";")) {
    let p = part.trim();
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1).trim();
    }
    if (!p) {
      continue;
    }
    if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("\\\\")) {
      continue;
    }
    out.push(p);
  }
  return out;
}

/** 大小写不敏感去重（Windows 路径语义），保留首现顺序 */
export function dedupeWinDirsCaseInsensitive(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const key = d.toLowerCase().replace(/[\\/]+$/, "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * 实时 PATH 目录（用户级在前、机器级在后——与「用户安装优先」的解析序同向）。
 * 非 win32 / 读不到 → []。调用方据此**追加**到进程 PATH 之后，不替换（进程 PATH 的既有
 * 优先级不变，验收锁定）。
 */
export function readWinLivePathDirs(isWindows: boolean): string[] {
  if (!isWindows) {
    return [];
  }
  const userPath = readRegString(
    ROOT_KEY_CURRENT_USER,
    "Environment",
    "Path",
    0,
  );
  const machinePath = readRegString(
    ROOT_KEY_LOCAL_MACHINE,
    HKLM_SESSION_ENV,
    "Path",
    WOW64_64,
  );
  const dirs = dedupeWinDirsCaseInsensitive([
    ...splitRegPathList(userPath),
    ...splitRegPathList(machinePath),
  ]);
  if (dirs.length === 0) {
    Zotero.debug(
      "[claudian] winRegistry: live PATH empty (registry read failed)",
    );
  }
  return dirs;
}
