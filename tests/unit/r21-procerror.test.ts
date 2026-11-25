// R21 白盒：被中断的进程不参与 SESSION_GONE / CLAUDE_NOT_FOUND 判定
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import {
  classifyProcError,
  isSessionGoneText,
  spawnTurn,
  startsWithSessionGoneKeyword,
  STDERR_TAIL_CHARS,
} from "../../src/modules/cliRunner.ts";
import type { TurnEvent } from "../../src/modules/cliRunner.ts";
import {
  createHostBridge,
  sanitizeStderrForLog,
} from "../../src/modules/hostBridge.ts";
import { makeStore } from "./helpers/memoryFs.ts";

const SESSION_STDERR = "Error: No conversation found with session ID: abc";
const MISSING_STDERR = "spawn claude ENOENT: no such file";

test("classifyProcError：reason=INTERRUPTED 时 stderr 含 session 失效关键字也不判 SESSION_GONE", () => {
  for (const exitCode of [null, 1, 143]) {
    assert.equal(
      classifyProcError({
        exitCode,
        stderrTail: SESSION_STDERR,
        reason: "INTERRUPTED",
      }),
      "GENERIC",
    );
  }
});

test("classifyProcError：reason=INTERRUPTED 时 stderr 含找不到可执行文件字样也不判 CLAUDE_NOT_FOUND", () => {
  assert.equal(
    classifyProcError({
      exitCode: 1,
      stderrTail: MISSING_STDERR,
      reason: "INTERRUPTED",
    }),
    "GENERIC",
  );
});

test("classifyProcError（回归）：无 reason 时 session 失效关键字仍判 SESSION_GONE", () => {
  assert.equal(
    classifyProcError({ exitCode: 1, stderrTail: SESSION_STDERR }),
    "SESSION_GONE",
  );
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function runningBridge() {
  const memory = makeStore();
  const sent: Array<{ msg: Record<string, unknown> }> = [];
  const spawned: Array<{ onEvent: (e: unknown) => void }> = [];
  const logLines: string[] = [];
  const bridge = createHostBridge({
    post: (_win: unknown, msg: Record<string, unknown>) => sent.push({ msg }),
    createChannel: () => null,
    log: (line: string) => logLines.push(line),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string) => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: text,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: { PATH: "/usr/bin" },
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 52100, token: "tok" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: { onEvent: (e: unknown) => void }) => {
      spawned.push(options);
      return { kill: () => {}, exitPromise: new Promise<void>(() => {}) };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "论文" } : null,
  } as never);
  const win = { __fakeWindow: true };
  bridge.beginHandshake(win as never, "tok-r21u");
  bridge.dispatch({
    source: win,
    data: { type: "hello", token: "tok-r21u" },
  } as never);
  await tick();
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "长任务" },
  } as never);
  await tick();
  await tick();
  const sessionId = memory.store.list()[0].id;
  return {
    bridge,
    win,
    sent,
    spawned,
    logLines,
    sessionId,
    store: memory.store,
  };
}

test("宿主桥：中断后 procError 的 stderr 含 session 关键字 → 不广播 SESSION_GONE、不清 claudeSessionId", async () => {
  const ctx = await runningBridge();
  ctx.spawned[0].onEvent({
    kind: "init",
    claudeSessionId: "cli-1",
    model: "m",
  });
  await tick();
  ctx.bridge.dispatch({
    source: ctx.win,
    data: { type: "interrupt", sessionId: ctx.sessionId },
  } as never);
  ctx.spawned[0].onEvent({
    kind: "procError",
    exitCode: 143,
    stderrTail: SESSION_STDERR,
  });
  await tick();
  await tick();
  const gone = ctx.sent.filter(
    (s) => s.msg.type === "error" && s.msg.code === "SESSION_GONE",
  );
  assert.equal(gone.length, 0);
  assert.ok(!ctx.logLines.some((l) => l.includes("classified SESSION_GONE")));
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, "cli-1");
});

test("宿主桥：procError 日志把 stderr 换行写成字面 \\n 且只留末尾 500 字", async () => {
  const ctx = await runningBridge();
  const tail = "a\nb\r\n" + "x".repeat(600);
  ctx.spawned[0].onEvent({ kind: "procError", exitCode: 2, stderrTail: tail });
  await tick();
  const line = ctx.logLines.find((l) =>
    l.startsWith("[bridge] procError exit=2 "),
  );
  assert.ok(line, "应有 procError 日志行");
  const stderrPart = line.slice(line.indexOf("stderr=") + "stderr=".length);
  assert.equal(stderrPart, "x".repeat(500));
  assert.ok(!line.includes("\n"));
  const ctx2 = await runningBridge();
  ctx2.spawned[0].onEvent({
    kind: "procError",
    exitCode: 2,
    stderrTail: "a\r\nb\nc",
  });
  await tick();
  const line2 = ctx2.logLines.find((l) =>
    l.startsWith("[bridge] procError exit=2 "),
  );
  assert.ok(line2?.endsWith("stderr=a\\nb\\nc"), String(line2));
});

// ---------- spawnTurn：kill 早于进程拉起 ----------

/** 假进程：kill() 记次数并让进程以 null 退出；finish(code) 让进程自行退出 */
function makeKillableProc(stdoutText = "") {
  const chunks = stdoutText ? [stdoutText] : [];
  let finished = false;
  let resolveWait: (v: { exitCode: number | null }) => void = () => {};
  const waitPromise = new Promise<{ exitCode: number | null }>((r) => {
    resolveWait = r;
  });
  const stdinWrites: string[] = [];
  let killCount = 0;
  const finish = (exitCode: number | null) => {
    if (finished) return;
    finished = true;
    resolveWait({ exitCode });
  };
  const reader = (list: string[]) => async () => {
    if (list.length > 0) return list.shift() as string;
    if (finished) return null;
    await new Promise((r) => setTimeout(r, 1));
    return list.length > 0 ? (list.shift() as string) : finished ? null : "";
  };
  const proc = {
    stdin: { write: (t: string) => void stdinWrites.push(t), close: () => {} },
    stdout: { readString: reader(chunks) },
    stderr: { readString: reader([]) },
    wait: () => waitPromise,
    kill: () => {
      killCount += 1;
      finish(null);
    },
  };
  return { proc, finish, stdinWrites, killCount: () => killCount };
}

const RESULT_LINE =
  '{"type":"result","subtype":"success","session_id":"c1","total_cost_usd":0,"duration_ms":1,"num_turns":1}\n';

test(
  "spawnTurn：kill 先于进程拉起返回 → 拉起后立即终止该进程，事件以恰好 1 条 procError 收尾",
  { timeout: 5000 },
  async () => {
    const fake = makeKillableProc();
    let releaseCall: () => void = () => {};
    const callGate = new Promise<void>((r) => {
      releaseCall = r;
    });
    const events: TurnEvent[] = [];
    const handle = spawnTurn(
      {
        call: async () => {
          await callGate;
          return fake.proc as never;
        },
      },
      {
        command: "/usr/bin/claude",
        args: ["-p"],
        workdir: "/w",
        prompt: "x",
        onEvent: (e) => events.push(e),
      },
    );
    handle.kill(); // 此刻 callCli 仍在 await，proc 为 null
    assert.equal(fake.killCount(), 0);
    releaseCall();
    await handle.exitPromise;
    assert.equal(fake.killCount(), 1);
    assert.deepEqual(fake.stdinWrites, [], "已终止的进程不应再被喂 prompt");
    assert.equal(events[events.length - 1]?.kind, "procError");
    assert.equal(events.filter((e) => e.kind === "procError").length, 1);
  },
);

test(
  "spawnTurn：channel=sh 包装失败回退再拉起的路径上，先到的 kill 同样生效",
  { timeout: 5000 },
  async () => {
    const fake = makeKillableProc();
    let releaseFallback: () => void = () => {};
    const fallbackGate = new Promise<void>((r) => {
      releaseFallback = r;
    });
    const calls: string[] = [];
    const events: TurnEvent[] = [];
    const handle = spawnTurn(
      {
        call: async (o: { command: string }) => {
          calls.push(o.command);
          if (calls.length === 1) {
            throw new Error(
              'File at path "/bin/sh" does not exist, or is not executable',
            );
          }
          await fallbackGate;
          return fake.proc as never;
        },
      },
      {
        command: "/usr/bin/claude",
        channel: "sh",
        args: ["-p"],
        workdir: "/w",
        prompt: "x",
        onEvent: (e) => events.push(e),
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    handle.kill();
    releaseFallback();
    await handle.exitPromise;
    assert.deepEqual(calls, ["/bin/sh", "/usr/bin/claude"]);
    assert.equal(fake.killCount(), 1);
    assert.equal(events[events.length - 1]?.kind, "procError");
    assert.equal(events.filter((e) => e.kind === "procError").length, 1);
  },
);

test("spawnTurn（回归）：未请求终止时进程不被 kill，正常收尾", async () => {
  const fake = makeKillableProc(RESULT_LINE);
  const events: TurnEvent[] = [];
  const handle = spawnTurn(
    { call: async () => fake.proc as never },
    {
      command: "/usr/bin/claude",
      args: ["-p"],
      workdir: "/w",
      prompt: "x",
      onEvent: (e) => events.push(e),
    },
  );
  await new Promise((r) => setTimeout(r, 5));
  fake.finish(0);
  await handle.exitPromise;
  assert.equal(fake.killCount(), 0);
  assert.deepEqual(fake.stdinWrites, ["x"]);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["result"],
  );
});

test("宿主桥：procError 日志 stderr 中单独的 \\r 也写成字面 \\n", async () => {
  const ctx = await runningBridge();
  ctx.spawned[0].onEvent({
    kind: "procError",
    exitCode: 3,
    stderrTail: "a\rb\r\nc\nd",
  });
  await tick();
  const line = ctx.logLines.find((l) =>
    l.startsWith("[bridge] procError exit=3 "),
  );
  assert.ok(line?.endsWith("stderr=a\\nb\\nc\\nd"), String(line));
  assert.ok(!line.includes("\r"));
});

test("宿主桥：中断后 procError 不再写旧格式 reason=INTERRUPTED 日志", async () => {
  const ctx = await runningBridge();
  ctx.bridge.dispatch({
    source: ctx.win,
    data: { type: "interrupt", sessionId: ctx.sessionId },
  } as never);
  ctx.spawned[0].onEvent({ kind: "procError", exitCode: null });
  await tick();
  assert.ok(
    ctx.logLines.some((l) =>
      l.startsWith("[bridge] procError exit=null interrupted=true "),
    ),
  );
  assert.ok(
    !ctx.logLines.some((l) => l.includes("procError reason=INTERRUPTED")),
  );
});

test(
  "spawnTurn：先 kill，随后直接拉起与回退拉起都失败 → 只有 1 条 procError",
  { timeout: 5000 },
  async () => {
    let releaseCalls: () => void = () => {};
    const callGate = new Promise<void>((r) => {
      releaseCalls = r;
    });
    const calls: string[] = [];
    const events: TurnEvent[] = [];
    const handle = spawnTurn(
      {
        call: async (o: { command: string }) => {
          calls.push(o.command);
          await callGate;
          const err = new Error("spawn ENOENT") as Error & { errno: number };
          err.errno = 2;
          throw err;
        },
      },
      {
        command: "/usr/bin/claude",
        channel: "sh",
        args: ["-p"],
        workdir: "/w",
        prompt: "x",
        onEvent: (e) => events.push(e),
      },
    );
    handle.kill(); // 两次拉起都还在 await
    releaseCalls();
    await handle.exitPromise;
    assert.deepEqual(calls, ["/bin/sh", "/usr/bin/claude"]);
    assert.equal(events.filter((e) => e.kind === "procError").length, 1);
    assert.equal(events.length, 1);
  },
);

// ---------- 修法 E：resultError.errors 识别 SESSION_GONE ----------

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

/** 可控轮次的宿主桥：每轮可手动放事件、手动放行退出；返回已带 CLI 会话编号、续接轮在跑的上下文 */
async function resumedBridge() {
  const memory = makeStore();
  const sent: Array<{ msg: Record<string, unknown> }> = [];
  const logLines: string[] = [];
  const turns: Array<{
    options: { args: string[]; onEvent: (e: unknown) => void };
    emit: (e: unknown) => void;
    releaseExit: () => void;
  }> = [];
  const bridge = createHostBridge({
    post: (_win: unknown, msg: Record<string, unknown>) => sent.push({ msg }),
    createChannel: () => null,
    log: (line: string) => logLines.push(line),
    now: () => 1_700_000_000_000,
    launchURL: () => {},
    buildTurnPrompt: async (text: string) => ({
      itemKey: "ITEM1",
      attachmentKey: "ATT1",
      prompt: text,
      addDir: "/papers",
    }),
    ensureWorkspace: async () => "/workspace",
    getSpawnBase: async () => ({
      command: "/usr/bin/claude",
      channel: "direct",
      environment: { PATH: "/usr/bin" },
      environmentAppend: true,
    }),
    getMcpEndpoint: () => ({ port: 52100, token: "tok" }),
    getDefaultPermissionMode: () => "acceptEdits",
    spawnTurn: (options: { args: string[]; onEvent: (e: unknown) => void }) => {
      let releaseExit = () => {};
      const exitPromise = new Promise<void>((r) => {
        releaseExit = () => r();
      });
      turns.push({ options, emit: (e) => options.onEvent(e), releaseExit });
      return { kill: () => {}, exitPromise };
    },
    buildReaderContext: async () => null,
    sessions: memory.store,
    lookupItem: async (itemKey: string) =>
      itemKey === "ITEM1" ? { libraryID: 1, title: "论文" } : null,
  } as never);
  const win = { __fakeWindow: true };
  bridge.beginHandshake(win as never, "tok-r21e");
  bridge.dispatch({
    source: win,
    data: { type: "hello", token: "tok-r21e" },
  } as never);
  await settle();
  bridge.dispatch({
    source: win,
    data: { type: "send", text: "首轮" },
  } as never);
  await settle();
  const sessionId = memory.store.list()[0].id;
  turns[0].emit({
    kind: "result",
    claudeSessionId: "live-1",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
  });
  turns[0].releaseExit();
  await settle();
  assert.equal(memory.store.get(sessionId)?.claudeSessionId, "live-1");
  sent.length = 0;
  const send = async (text: string) => {
    bridge.dispatch({
      source: win,
      data: { type: "send", text, sessionId },
    } as never);
    await settle();
  };
  await send("续接");
  assert.equal(turns.length, 2);
  return {
    bridge,
    win,
    sent,
    logLines,
    turns,
    sessionId,
    store: memory.store,
    send,
  };
}

const goneCount = (sent: Array<{ msg: Record<string, unknown> }>) =>
  sent.filter((s) => s.msg.type === "error" && s.msg.code === "SESSION_GONE")
    .length;

test("isSessionGoneText：四个关键字均识别且不区分大小写，普通报错不识别", () => {
  for (const t of [
    "No Conversation Found with session ID: x",
    "SESSION NOT FOUND",
    "error: No Such Session",
    "Session Does Not Exist",
  ]) {
    assert.equal(isSessionGoneText(t), true, t);
  }
  assert.equal(isSessionGoneText("API Error: 502"), false);
  assert.equal(isSessionGoneText(""), false);
});

for (const text of [
  "NO CONVERSATION FOUND with session ID: abc",
  "Session Not Found: abc",
  "no SUCH session: abc",
  "  session DOES NOT EXIST (abc)",
]) {
  test(`宿主桥：resultError.errors 含「${text}」→ 广播一次 SESSION_GONE 并清编号`, async () => {
    const ctx = await resumedBridge();
    ctx.turns[1].emit({
      kind: "resultError",
      subtype: "error_during_execution",
      errors: ["前一条无关", text],
    });
    await settle();
    assert.equal(goneCount(ctx.sent), 1);
    assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, null);
  });
}

test("宿主桥：resultError 命中后同轮再来含同样关键字的 procError → 不重复广播", async () => {
  const ctx = await resumedBridge();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: ["No conversation found with session ID: abc"],
  });
  ctx.turns[1].emit({
    kind: "procError",
    exitCode: 1,
    stderrTail: "No conversation found with session ID: abc",
  });
  await settle();
  ctx.turns[1].releaseExit();
  await settle();
  assert.equal(goneCount(ctx.sent), 1);
});

test("宿主桥：中断中（interrupting）收到含关键字的 resultError → 不判 SESSION_GONE、编号保留（与 procError 的 INTERRUPTED 豁免一致）", async () => {
  const ctx = await resumedBridge();
  ctx.bridge.dispatch({
    source: ctx.win,
    data: { type: "interrupt", sessionId: ctx.sessionId },
  } as never);
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: ["No conversation found with session ID: abc"],
  });
  await settle();
  assert.equal(goneCount(ctx.sent), 0);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, "live-1");
});

test("宿主桥：resultError 清编号后同会话再发一轮不再带 --resume", async () => {
  const ctx = await resumedBridge();
  const resumeArg = (args: string[]) => {
    const i = args.indexOf("--resume");
    return i >= 0 ? args[i + 1] : null;
  };
  assert.equal(
    resumeArg(ctx.turns[1].options.args),
    "live-1",
    "搭台：续接轮应带 --resume",
  );
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: ["No conversation found with session ID: live-1"],
  });
  ctx.turns[1].releaseExit();
  await settle();
  await ctx.send("再试一次");
  assert.equal(ctx.turns.length, 3);
  assert.equal(resumeArg(ctx.turns[2].options.args), null);
});

// ---------- 修法 F：日志 stderr 净化 ----------

test("sanitizeStderrForLog：四类密钥形态打码，非密钥部分保留", () => {
  const out = sanitizeStderrForLog(
    "k=sk-ant-api03-AbC_d-9 u=https://alice:p%40ss@example.com:8443/x q=/a?token=t0k3n&z=1 h=Authorization: bearer abc.def",
  );
  assert.ok(!out.includes("sk-ant-"), out);
  assert.ok(!out.includes("AbC_d-9"), out);
  assert.ok(!out.includes("alice"), out);
  assert.ok(!out.includes("p%40ss"), out);
  assert.ok(!out.includes("t0k3n"), out);
  assert.ok(!out.includes("abc.def"), out);
  assert.ok(out.includes("https://***@example.com:8443/x"), out);
  assert.ok(out.includes("token=***&z=1"), out);
  assert.ok(out.includes("bearer ***"), out);
  assert.ok(out.startsWith("k=*** "), out);
});

test("sanitizeStderrForLog：\\r\\n、\\r、\\n 各写成一个字面 \\n", () => {
  assert.equal(sanitizeStderrForLog("a\r\nb\rc\nd"), "a\\nb\\nc\\nd");
});

test("sanitizeStderrForLog：其余控制字符各区间端点写成 \\u{hex}，原字符不出现", () => {
  const codes = [
    0x00, 0x09, 0x1b, 0x1f, 0x7f, 0x80, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e,
    0x2066, 0x2069,
  ];
  const raw = codes.map((c) => "x" + String.fromCharCode(c)).join("") + "x";
  const out = sanitizeStderrForLog(raw);
  for (const c of codes) {
    assert.ok(!out.includes(String.fromCharCode(c)), c.toString(16));
    assert.ok(out.includes(`\\u{${c.toString(16)}}`), c.toString(16));
  }
  // 区间外的相邻字符原样保留
  assert.equal(
    sanitizeStderrForLog("\u00a0\u2027\u202f\u2065\u206a中"),
    "\u00a0\u2027\u202f\u2065\u206a中",
  );
});

test("sanitizeStderrForLog：密钥跨 500 字截断边界也不漏出后半段", () => {
  const raw = "sk-ant-SECRETVALUE123" + "x".repeat(490);
  // 若先截断：末尾 500 字会切掉 sk-ant- 前缀，剩下 …VALUE123 逃过打码
  assert.ok(raw.slice(-500).includes("VALUE123"), "搭台：边界确实切在密钥中间");
  const out = sanitizeStderrForLog(raw);
  assert.ok(!out.includes("VALUE123"), out.slice(0, 40));
  assert.ok(out.length <= 500);
  assert.ok(out.startsWith("***"));
  const long = sanitizeStderrForLog("y".repeat(800));
  assert.equal(long, "y".repeat(500));
});

// ---------- 收紧（复判）：resultError 路径的 SESSION_GONE 判定 ----------

test("startsWithSessionGoneKeyword：去首尾空白后以关键字开头才算，句中包含不算", () => {
  assert.equal(
    startsWithSessionGoneKeyword("  No Conversation Found with session ID: x"),
    true,
  );
  assert.equal(startsWithSessionGoneKeyword("SESSION NOT FOUND"), true);
  assert.equal(
    startsWithSessionGoneKeyword("MCP server x: Session not found"),
    false,
  );
  assert.equal(
    startsWithSessionGoneKeyword(
      'API Error: 404 {"error":{"message":"Session not found"}}',
    ),
    false,
  );
});

test("宿主桥：续接轮 api_error 正文含 Session not found → 不触发、编号保留", async () => {
  const ctx = await resumedBridge();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "api_error",
    errors: ['API Error: 404 {"error":{"message":"Session not found"}}'],
  });
  await settle();
  assert.equal(goneCount(ctx.sent), 0);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, "live-1");
});

test("宿主桥：续接轮 api_error 即便以关键字开头也不触发（subtype 须为 error_during_execution）", async () => {
  const ctx = await resumedBridge();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "api_error",
    errors: ["Session not found"],
  });
  await settle();
  assert.equal(goneCount(ctx.sent), 0);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, "live-1");
});

test("宿主桥：续接轮 error_during_execution 但关键字只在句中（MCP 报错）→ 不触发", async () => {
  const ctx = await resumedBridge();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: ["MCP server x: Session not found"],
  });
  await settle();
  assert.equal(goneCount(ctx.sent), 0);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, "live-1");
});

test("宿主桥：续接轮 error_during_execution 且某条以关键字开头 → 触发一次并清编号", async () => {
  const ctx = await resumedBridge();
  ctx.turns[1].emit({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: [
      "MCP server x: Session not found",
      "  no conversation found with session ID: live-1",
    ],
  });
  await settle();
  assert.equal(goneCount(ctx.sent), 1);
  assert.equal(ctx.store.get(ctx.sessionId)?.claudeSessionId, null);
});

// runningBridge 的会话是新建首轮：尚无 CLI 会话编号，不带 --resume
test("宿主桥：非续接轮（首轮）resultError 以关键字开头 → 不触发", async () => {
  const ctx = await runningBridge();
  ctx.spawned[0].onEvent({
    kind: "resultError",
    subtype: "error_during_execution",
    errors: ["No conversation found with session ID: abc"],
  });
  await tick();
  await tick();
  assert.equal(
    ctx.sent.filter(
      (s) => s.msg.type === "error" && s.msg.code === "SESSION_GONE",
    ).length,
    0,
  );
});

test("宿主桥（回归）：非续接轮（首轮）procError 含失效关键字仍按旧条件触发 SESSION_GONE", async () => {
  const ctx = await runningBridge();
  ctx.spawned[0].onEvent({
    kind: "procError",
    exitCode: 1,
    stderrTail: "Error: No conversation found with session ID: abc",
  });
  await tick();
  await tick();
  assert.equal(
    ctx.sent.filter(
      (s) => s.msg.type === "error" && s.msg.code === "SESSION_GONE",
    ).length,
    1,
  );
});

// ---------- 收紧：日志净化 ----------

test("sanitizeStderrForLog：达到截断上限时丢弃首个空白前的残段，跨边界密钥不留任何片段", () => {
  const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  // 模拟 cliRunner 截断：末尾 STDERR_TAIL_CHARS 字，切在密钥中间
  const tail = (key + " " + "z".repeat(STDERR_TAIL_CHARS - 20)).slice(
    -STDERR_TAIL_CHARS,
  );
  assert.equal(tail.length, STDERR_TAIL_CHARS);
  assert.ok(!tail.startsWith("sk-"), "搭台：截断后开头应是失去前缀的密钥残段");
  const residue = tail.slice(0, tail.indexOf(" "));
  assert.ok(
    residue.length > 0 && key.endsWith(residue),
    "搭台：残段是密钥后半段",
  );
  const out = sanitizeStderrForLog(tail);
  for (let i = 0; i + 6 <= residue.length; i++) {
    assert.ok(
      !out.includes(residue.slice(i, i + 6)),
      `漏出密钥片段：${residue.slice(i, i + 6)}`,
    );
  }
  assert.ok(out.includes("zzz"));
  // 未达上限：不丢弃开头
  assert.equal(sanitizeStderrForLog("head rest"), "head rest");
  // 达到上限但无空白：整段照常净化
  assert.equal(
    sanitizeStderrForLog("q".repeat(STDERR_TAIL_CHARS)),
    "q".repeat(STDERR_TAIL_CHARS),
  );
});

test("sanitizeStderrForLog：新增三类打码（sk- 长串、x-api-key:、XXX_KEY/TOKEN/SECRET=）", () => {
  const out = sanitizeStderrForLog(
    "a sk-abcdefghijklmnopqrstuvwxyz012 b sk-short c X-Api-Key: kv123;tail d OPENAI_API_KEY=ok1 e GH_TOKEN=gt2&n=1 f MY_SECRET=ms3,x g _KEY=keep1 h KEYS=keep2 i API_KEY_ID=keep3",
  );
  for (const leaked of [
    "abcdefghijklmnopqrstuvwxyz012",
    "kv123",
    "ok1",
    "gt2",
    "ms3",
  ]) {
    assert.ok(!out.includes(leaked), `${leaked} 未打码：${out}`);
  }
  assert.ok(out.includes("a *** b"), out);
  assert.ok(out.includes("sk-short"), out);
  assert.ok(out.includes("X-Api-Key: ***;tail"), out);
  assert.ok(out.includes("OPENAI_API_KEY=*** "), out);
  assert.ok(out.includes("GH_TOKEN=***&n=1"), out);
  assert.ok(out.includes("MY_SECRET=***,x"), out);
  assert.ok(out.includes("_KEY=keep1"), out);
  assert.ok(out.includes("KEYS=keep2"), out);
  assert.ok(out.includes("API_KEY_ID=keep3"), out);
});

test("sanitizeStderrForLog：值前带开引号同样打码", () => {
  const out = sanitizeStderrForLog(
    `OPENAI_API_KEY="q1v" token='t2v' x-api-key: "x3v"`,
  );
  assert.ok(!/q1v|t2v|x3v/.test(out), out);
  assert.ok(out.includes('OPENAI_API_KEY="***"'), out);
  assert.ok(out.includes("token='***'"), out);
  assert.ok(out.includes('x-api-key: "***"'), out);
});

test("sanitizeStderrForLog：token=abc;keep=1,next 只打码 abc", () => {
  assert.equal(
    sanitizeStderrForLog("token=abc;keep=1,next"),
    "token=***;keep=1,next",
  );
});
