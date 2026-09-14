// 单测 — 附件安全修（2026-09-11 独立复查）：**宿主不接受任何客户端提供的路径**。
//
// 锁定的契约点：
//   1) 凭据表（每窗口一个 Map）：宿主原生选择器选中文件 → 登记 `{path, name, sizeBytes}`，
//      回执只给 `{token, name, sizeBytes}`（**没有路径**）；同名多选各得独立 token；
//      一次性：解析一次即删；未知/已用 token → 该条按拒绝处理；窗口注销 → 该窗口清空。
//   2) 载荷归一：客户端条目里**任何路径字段（sourcePath）都不读**；只有 base64 可独立过；
//      既无 token 又无 base64 → 拒绝该条并给人话原因。
//   3) 落盘编排：token 换回路径后**仍走既有净化/上限/落点**（utils/attachments）；
//      落盘回执给已落盘文件**再发一枚新 token**（编辑重发用），旧 token 已作废。
//
// 被测面 = createHostBridge 的真实消息路径（hello → pickAttachments / send），
// 落盘侧用 utils/attachments 的真实纯逻辑 + 内存 fs（与宿主 sections.ts 同编排）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  type HostBridgeDeps,
  type PickedFile,
  type TurnPromptInput,
} from "../../src/modules/hostBridge.ts";
import type { HostMessage } from "../../src/chat/lib/types.ts";
import type {
  SpawnTurnOptions,
  TurnHandle,
} from "../../src/modules/cliRunner.ts";
import type { AttachmentInput } from "../../src/utils/attachments.ts";
import { saveAttachments } from "../../src/utils/attachments.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const HOST_TOKEN = "tok-abc123";
const CWD = "/ws";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** 桥里有多段 await（会话读取/落盘），跑完再断言 */
const settle = async (): Promise<void> => {
  await tick();
  await tick();
  await tick();
};

/** 落盘 fs（AttachmentsFs 同形；copyFile 记录调用，供「没被复制」类断言） */
function makeSaveFs(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const copied: { from: string; to: string }[] = [];
  return {
    store,
    copied,
    async exists(p: string) {
      return store.has(p);
    },
    async copyFile(from: string, to: string) {
      copied.push({ from, to });
      store.set(to, store.get(from) ?? "");
    },
    async makeDir() {},
    async listNames(dir: string) {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
    join: (...seg: string[]) => seg.join("/"),
  };
}

interface PromptCall {
  text: string;
  attach: { files: AttachmentInput[]; sessionId: string; turn: number } | null;
}

function makeDeps() {
  const sent: { win: object; msg: HostMessage }[] = [];
  const prompts: PromptCall[] = [];
  const picked: PickedFile[] = [];
  const saveFs = makeSaveFs();
  const memory = makeStore();
  /** 选择器桩：返回当前排队的 picked（宿主真实实现是 nsIFilePicker） */
  const pickFiles: NonNullable<HostBridgeDeps["pickFiles"]> = async () => {
    const out = picked.splice(0, picked.length);
    for (const f of out) {
      saveFs.store.set(f.path, "picked-bytes"); // 源文件真的存在
    }
    return out;
  };
  const deps: HostBridgeDeps = {
    post: (win, msg) => sent.push({ win, msg }),
    createChannel: () => null,
    log: () => {},
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    // 宿主落盘编排的等价物：cwd 现算 + utils/attachments 纯逻辑（sections.ts 的接线）
    buildTurnPrompt: async (
      text: string,
      _refs?: string[],
      _scope?: unknown,
      attach?: PromptCall["attach"],
    ): Promise<TurnPromptInput> => {
      prompts.push({ text, attach: attach ?? null });
      const attachmentSaved = attach
        ? await saveAttachments(
            {
              cwd: CWD,
              sessionId: attach.sessionId,
              turn: attach.turn,
              files: attach.files,
            },
            { fs: saveFs },
          )
        : undefined;
      return {
        itemKey: "ITEM1",
        attachmentKey: "ATT1",
        prompt: text,
        addDir: "/papers",
        ...(attachmentSaved ? { attachmentSaved } : {}),
      };
    },
    ensureWorkspace: async () => CWD,
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: {},
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 52100, token: "mcp-tok" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (_options: SpawnTurnOptions): TurnHandle => ({
      kill: () => {},
      exitPromise: Promise.resolve(),
    }),
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "一篇论文" } : null,
    pickFiles,
  };
  return { deps, sent, prompts, picked, saveFs };
}

function makeWin(tag: string): object {
  return { __fakeWindow: tag };
}

/** 握手 + 注册（与其他 hostBridge 单测同款） */
function register(
  bridge: ReturnType<typeof createHostBridge>,
  win: object,
): void {
  bridge.beginHandshake(win, HOST_TOKEN);
  bridge.dispatch({ source: win, data: { type: "hello", token: HOST_TOKEN } });
}

function lastOf(
  sent: { msg: HostMessage }[],
  type: HostMessage["type"],
): HostMessage | undefined {
  return sent.filter((s) => s.msg.type === type).pop()?.msg;
}

// ---- ① 凭据表生命周期 ----

test("安全修：选择器回执只有 {token,name,sizeBytes}——没有路径；同名多选各得独立 token", async () => {
  const { deps, sent, picked } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push(
    { path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 1024 },
    { path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 1024 }, // 同一个文件选两次
  );
  bridge.dispatch({
    source: win,
    data: { type: "pickAttachments", multiple: true },
  });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  assert.equal(reply.files.length, 2);
  for (const f of reply.files) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ["name", "sizeBytes", "token"],
      "回执字段只能是 token/name/sizeBytes",
    );
    assert.equal((f as { path?: unknown }).path, undefined, "回执不许带路径");
    assert.match(
      f.token,
      /^[0-9a-f]{32}$/,
      "token 是 16 字节 CSPRNG 的十六进制",
    );
  }
  assert.notEqual(
    reply.files[0].token,
    reply.files[1].token,
    "同名两枚各得独立 token",
  );
});

// ---- ② 载荷归一：客户端路径一律不认 ----

test("安全修：带 sourcePath 的客户端条目被忽略——该条按拒绝处理，路径不进宿主", async () => {
  const { deps, sent, prompts, saveFs } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "看看这个",
      attachments: [
        { name: "hosts.txt", sizeBytes: 11, sourcePath: "/etc/hosts" },
      ],
    },
  });
  await settle();
  // 宿主完全没把它当附件：没有落盘编排（attach = null）、没有任何 copy
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].attach, null, "无来源条目不该进落盘编排");
  assert.deepEqual(saveFs.copied, [], "客户端给的路径不许触发任何复制");
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  assert.deepEqual(receipt.saved, []);
  assert.equal(receipt.rejected.length, 1);
  assert.equal(receipt.rejected[0].name, "hosts.txt");
  assert.ok(
    /路径|内容/.test(receipt.rejected[0].reason),
    `拒绝原因要是人话：${receipt.rejected[0].reason}`,
  );
});

test("安全修：只有 base64 的条目通过（粘贴场景；字节真的到落盘侧）", async () => {
  const { deps, prompts } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  const base64 = Buffer.from("PNG-BYTES").toString("base64");
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "贴图",
      attachments: [{ name: "截图.png", sizeBytes: 9, base64 }],
    },
  });
  await settle();
  assert.ok(prompts[0].attach, "有字节的条目要进落盘编排");
  assert.equal(prompts[0].attach?.files.length, 1);
  assert.equal(prompts[0].attach?.files[0].base64, base64);
  assert.equal(prompts[0].attach?.files[0].sourcePath, undefined);
});

test("安全修：既无 token 又无 base64 → 拒绝并给人话原因；带 token 的同一批照常落", async () => {
  const { deps, sent, picked } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push({ path: "/tmp/选择/好.png", name: "好.png", sizeBytes: 3 });
  bridge.dispatch({ source: win, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  const token = reply.files[0].token;
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "混批",
      attachments: [
        { name: "好.png", sizeBytes: 3, token },
        { name: "坏条目", sizeBytes: 1 }, // 什么都没有
      ],
    },
  });
  await settle();
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  assert.deepEqual(
    receipt.saved.map((s) => s.name),
    ["好.png"],
    "有凭据的照落",
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.name),
    ["坏条目"],
    "无来源的只拒那一条",
  );
});

// ---- ③ 凭据一次性 / 未知 / 窗口关闭 ----

test("安全修：token 换出路径即作废——同一 token 再用 → 拒绝，且不再复制", async () => {
  const { deps, sent, picked, saveFs } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push({ path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 10 });
  bridge.dispatch({ source: win, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  const token = reply.files[0].token;
  const send = (t: string, label: string) =>
    bridge.dispatch({
      source: win,
      data: {
        type: "send",
        text: label,
        attachments: [{ name: "图.png", sizeBytes: 10, token: t }],
      },
    });
  send(token, "第一次");
  await settle();
  const copiedAfterFirst = saveFs.copied.length;
  assert.equal(copiedAfterFirst, 1, "第一次要真的复制");
  send(token, "第二次");
  await settle();
  assert.equal(saveFs.copied.length, copiedAfterFirst, "作废凭据不许再复制");
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  assert.deepEqual(receipt.saved, []);
  assert.equal(receipt.rejected.length, 1);
  assert.ok(
    /凭据|重新/.test(receipt.rejected[0].reason),
    receipt.rejected[0].reason,
  );
});

test("安全修：未知 token / 别的窗口的 token → 拒绝（凭据按窗口隔离）", async () => {
  const { deps, sent, picked, saveFs } = makeDeps();
  const bridge = createHostBridge(deps);
  const winA = makeWin("A");
  const winB = makeWin("B");
  register(bridge, winA);
  register(bridge, winB);
  await settle();
  picked.push({ path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 10 });
  bridge.dispatch({ source: winA, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  const tokenA = reply.files[0].token;
  for (const [win, t, label] of [
    [winB, tokenA, "偷窗口 A 的凭据"],
    [winA, "deadbeef".repeat(4), "编一个 token"],
  ] as const) {
    bridge.dispatch({
      source: win,
      data: {
        type: "send",
        text: label,
        attachments: [{ name: "图.png", sizeBytes: 10, token: t }],
      },
    });
    await settle();
    const receipt = lastOf(sent, "attachmentSaved");
    assert.ok(receipt && receipt.type === "attachmentSaved");
    assert.deepEqual(receipt.saved, [], `${label}：不该落盘`);
    assert.equal(receipt.rejected.length, 1, `${label}：要回拒绝`);
  }
  assert.deepEqual(saveFs.copied, [], "两条都不得复制");
});

test("安全修：窗口关闭（unregister）→ 该窗口凭据全部清空", async () => {
  const { deps, sent, picked, saveFs } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push({ path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 10 });
  bridge.dispatch({ source: win, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  const token = reply.files[0].token;
  bridge.unregister(win);
  // 注销后再注册一次（同款页面重载形态），用旧凭据发：必须拒绝
  register(bridge, win);
  await settle();
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "关窗后重开",
      attachments: [{ name: "图.png", sizeBytes: 10, token }],
    },
  });
  await settle();
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  assert.deepEqual(receipt.saved, []);
  assert.equal(receipt.rejected.length, 1);
  assert.deepEqual(saveFs.copied, []);
});

// ---- ④ 落盘编排：换回路径后仍走既有净化/上限 ----

test("安全修：token 换回的路径走既有净化/上限（穿越名净化、20MB 拒、重名加序号）", async () => {
  const { deps, sent, picked } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push(
    { path: "/tmp/选择/evil.png", name: "../../evil.png", sizeBytes: 5 },
    { path: "/tmp/选择/大.png", name: "大.png", sizeBytes: 21 * 1024 * 1024 },
    { path: "/tmp/选择/a.png", name: "a.png", sizeBytes: 5 },
    { path: "/tmp/选择/a-2.png", name: "a.png", sizeBytes: 5 },
  );
  bridge.dispatch({ source: win, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  assert.equal(reply.files.length, 4);
  // 名字在选择器登记时就净化过了（chip 上不会出现穿越形态）
  assert.equal(reply.files[0].name, "evil.png");
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "落盘",
      attachments: reply.files.map((f) => ({
        name: f.name,
        sizeBytes: f.sizeBytes,
        token: f.token,
      })),
    },
  });
  await settle();
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  // 体积以**登记记录**为准：客户端字段说了不算（21MB 那枚照拒）
  assert.deepEqual(
    receipt.saved.map((s) => s.path),
    [
      `${CWD}/attachments/${receipt.sessionId}/0/evil.png`,
      `${CWD}/attachments/${receipt.sessionId}/0/a.png`,
      `${CWD}/attachments/${receipt.sessionId}/0/a-2.png`,
    ],
  );
  for (const s of receipt.saved) {
    assert.ok(s.path.includes(`${CWD}/attachments/`), "落点必须在本轮 cwd 内");
    assert.ok(!s.path.includes(".."), "净化后的路径不许有穿越形态");
  }
  assert.deepEqual(
    receipt.rejected.map((r) => r.name),
    ["大.png"],
  );
  assert.ok(/20/.test(receipt.rejected[0].reason), receipt.rejected[0].reason);
});

test("安全修：落盘回执给已落盘文件再发一枚新 token（编辑重发可用），旧 token 已作废", async () => {
  const { deps, sent, picked, saveFs } = makeDeps();
  const bridge = createHostBridge(deps);
  const win = makeWin("A");
  register(bridge, win);
  await settle();
  picked.push({ path: "/tmp/选择/图.png", name: "图.png", sizeBytes: 10 });
  bridge.dispatch({ source: win, data: { type: "pickAttachments" } });
  await settle();
  const reply = lastOf(sent, "attachmentsPicked");
  assert.ok(reply && reply.type === "attachmentsPicked");
  const oldToken = reply.files[0].token;
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "首轮",
      attachments: [{ name: "图.png", sizeBytes: 10, token: oldToken }],
    },
  });
  await settle();
  const receipt = lastOf(sent, "attachmentSaved");
  assert.ok(receipt && receipt.type === "attachmentSaved");
  assert.equal(receipt.saved.length, 1);
  const fresh = receipt.saved[0].token;
  assert.ok(fresh && fresh !== oldToken, "回执要给新的可用凭据");
  const landed = receipt.saved[0].path;
  saveFs.store.set(landed, "picked-bytes"); // 落盘文件真的在（编辑重发从它复制）
  // 编辑重发：用回执给的新 token（UI 手里没有路径，只能回传这个）
  bridge.dispatch({
    source: win,
    data: {
      type: "send",
      text: "编辑重发",
      attachments: [{ name: "图.png", sizeBytes: 10, token: fresh }],
    },
  });
  await settle();
  const second = sent
    .filter((s) => s.msg.type === "attachmentSaved")
    .pop()?.msg;
  assert.ok(second && second.type === "attachmentSaved");
  assert.equal(second.saved.length, 1, "新凭据可用");
  // 本轮 stub 的历史里没有落过用户轮 → 轮序号仍是 0，重名序号接管（真实宿主按轮数递增）
  assert.equal(
    second.saved[0].path,
    `${CWD}/attachments/${second.sessionId}/0/图-2.png`,
  );
  assert.ok(
    second.saved[0].path.includes(`${CWD}/attachments/`),
    "重发也落在工作区内",
  );
  assert.ok(saveFs.store.has(landed), "旧附件文件仍在盘上（一个都不删）");
});
