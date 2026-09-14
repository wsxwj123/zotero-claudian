// 单测 — cliRunner.spawnTurn：Gecko Subprocess 注入 fake，跑通 stdin/stdout 分帧/stderr/退出/kill 全编排
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drainPipe,
  spawnTurn,
  type ProcHandleLike,
  type SubprocessLike,
  type TurnEvent,
} from "../../src/modules/cliRunner.ts";
import { DARWIN_FD_RAISE_SCRIPT } from "../../src/modules/cliDetect.ts";

/** fake 进程：stdout 文本按 chunkSize 切块模拟分片到达；wait 延迟到 finish() 才 resolve */
function makeFakeProc(
  stdoutText: string,
  opts: { chunkSize?: number; stderrText?: string } = {},
) {
  const chunks: string[] = [];
  const text = stdoutText;
  const size = opts.chunkSize ?? 7;
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  const stderrChunks = (opts.stderrText ?? "").match(/[\s\S]{1,4}/g) ?? [];
  const state = {
    stdinWrites: [] as string[],
    stdinClosed: false,
    killed: false,
    finished: false,
  };
  const deferredWait = {
    promise: null as Promise<{ exitCode: number }> | null,
    resolve: (_: { exitCode: number }) => {},
  };
  const proc: ProcHandleLike & { finish(exitCode: number): void } = {
    stdin: {
      write: (data: string) => {
        state.stdinWrites.push(data);
      },
      close: () => {
        state.stdinClosed = true;
      },
    },
    stdout: {
      readString: async () => {
        if (state.finished) {
          // stdout 已随退出关闭；剩余 chunk 读完即 EOF
          return chunks.length > 0 ? (chunks.shift() as string) : null;
        }
        if (chunks.length === 0) {
          await new Promise((r) => setTimeout(r, 1));
          return chunks.length > 0 ? (chunks.shift() as string) : null;
        }
        return chunks.shift() as string;
      },
    },
    stderr: {
      readString: async () => {
        if (state.finished) {
          return stderrChunks.length > 0
            ? (stderrChunks.shift() as string)
            : null;
        }
        if (stderrChunks.length === 0) {
          await new Promise((r) => setTimeout(r, 1));
          return stderrChunks.length > 0
            ? (stderrChunks.shift() as string)
            : null;
        }
        return stderrChunks.shift() as string;
      },
    },
    wait: () => {
      if (!deferredWait.promise) {
        deferredWait.promise = new Promise((resolve) => {
          deferredWait.resolve = resolve;
        });
      }
      return deferredWait.promise;
    },
    kill: () => {
      state.killed = true;
    },
    finish: (exitCode: number) => {
      state.finished = true;
      if (!deferredWait.promise) {
        deferredWait.promise = new Promise((resolve) => {
          deferredWait.resolve = resolve;
        });
      }
      deferredWait.resolve({ exitCode });
    },
  };
  return { proc, state };
}

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "cli-sess-1",
  model: "m",
  permissionMode: "acceptEdits",
  tools: [],
  mcp_servers: [],
});
const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "cli-sess-1",
  total_cost_usd: 0.01,
  duration_ms: 5,
  num_turns: 1,
});

test("spawnTurn: 正常一轮 → stdin 收到 prompt 并关闭、事件按序映射、无 procError", async () => {
  const { proc, state } = makeFakeProc(
    [
      INIT_LINE,
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
      }),
      RESULT_LINE,
    ].join("\n") + "\n",
  );
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "/usr/bin/claude",
    args: ["-p"],
    workdir: "/tmp/ws",
    environment: { PATH: "/usr/bin" },
    environmentAppend: true,
    prompt: "你好，检查一下",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(state.stdinWrites, ["你好，检查一下"]);
  assert.equal(state.stdinClosed, true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "messageStart", "result"],
  );
});

test("spawnTurn: 行跨 chunk 分帧 → 拼行正确、尾部无换行残留行也处理", async () => {
  const { proc } = makeFakeProc(
    INIT_LINE + "\n" + RESULT_LINE,
    { chunkSize: 3 }, // 每行被切成多个碎片
  );
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "result"],
  );
});

test("spawnTurn: 坏行丢弃不抛错、好事件照常流出", async () => {
  const { proc } = makeFakeProc(
    ["not json", INIT_LINE, '{"type":"unknown-kind"}', RESULT_LINE].join("\n") +
      "\n",
  );
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const logs: string[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
    logger: (m) => logs.push(m),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "result"],
  );
  assert.ok(logs.some((m) => m.includes("not JSON")));
});

test("spawnTurn: 一条 user 消息多 tool_result 块 → 各产出一条事件", async () => {
  const userLine = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          is_error: false,
          content: "ok",
        },
        {
          type: "tool_result",
          tool_use_id: "tu-2",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ],
    },
  });
  const { proc } = makeFakeProc(
    [INIT_LINE, userLine, RESULT_LINE].join("\n") + "\n",
  );
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "toolResult", "toolResult", "result"],
  );
  const tr = events[2];
  assert.equal(tr.kind === "toolResult" && tr.toolUseId, "tu-2");
});

// ---- BUG-18：空串 chunk ≠ EOF ----

/** fake 进程：stdout 按显式队列吐 chunk（"" = 暂无数据/半多字节，null = 真 EOF） */
function makeEmptyChunkProc(stdoutItems: (string | null)[]) {
  const queue = [...stdoutItems];
  const stderrQueue = ["warn: partial"] as (string | null)[];
  let finished = false;
  const deferredWait = {
    promise: null as Promise<{ exitCode: number }> | null,
    resolve: (_: { exitCode: number }) => {},
  };
  const proc: ProcHandleLike & { finish(exitCode: number): void } = {
    stdin: { write: () => {}, close: () => {} },
    stdout: {
      readString: async () => {
        if (queue.length > 0) {
          return queue.shift() as string | null;
        }
        return finished ? null : "";
      },
    },
    stderr: {
      readString: async () => {
        if (stderrQueue.length > 0) {
          return stderrQueue.shift() as string | null;
        }
        return finished ? null : "";
      },
    },
    wait: () => {
      if (!deferredWait.promise) {
        deferredWait.promise = new Promise((resolve) => {
          deferredWait.resolve = resolve;
        });
      }
      return deferredWait.promise;
    },
    kill: () => {},
    finish: (exitCode: number) => {
      finished = true;
      if (!deferredWait.promise) {
        deferredWait.promise = new Promise((resolve) => {
          deferredWait.resolve = resolve;
        });
      }
      deferredWait.resolve({ exitCode });
    },
  };
  return { proc, state: { finished } };
}

test("BUG-18: 流中途返回空串（半多字节/暂无数据）→ 不当 EOF，result 不丢", async () => {
  // 三段数据之间插空串：旧实现遇到第一个空串即 break，RESULT 段永远读不到
  const { proc } = makeEmptyChunkProc([
    INIT_LINE + "\n",
    "",
    "",
    RESULT_LINE + "\n",
    "",
  ]);
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "result"],
  );
});

test("BUG-18: 进程未退出时空串不结束读取；退出后空串才判 EOF（不挂死不误判）", async () => {
  const { proc } = makeEmptyChunkProc(["", "", INIT_LINE + "\n"]);
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  // 先让它空转几轮（进程存活），再退出
  await new Promise((r) => setTimeout(r, 60));
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "procError"],
  ); // init 读到、无 result → procError 收尾
});

// ---- N2：drainPipe 的 EOF 宽限语义（退出后的宽限从观察到退出起算，不跨存活期累计）----

/** 假管道：按脚本吐 chunk（"" = 空读），脚本耗尽后恒吐 ""；记录 readString 调用次数 */
function makeScriptedPipe(script: string[]) {
  const state = { reads: 0 };
  const pipe = {
    readString: async (): Promise<string> => {
      state.reads++;
      return script.length > 0 ? script.shift()! : "";
    },
  };
  return { pipe, state };
}

test("N2: 存活期空读不计入退出后宽限——退出后仍需连续 3 次真实空读才判 EOF", async () => {
  const { pipe, state } = makeScriptedPipe(["", "", "", "", "", ""]);
  const chunks: string[] = [];
  // 「进程在第 2 次读之后退出」：旧实现 strike 跨存活期累计，第 3 次读即判 EOF
  await drainPipe(
    pipe,
    (c) => chunks.push(c),
    () => state.reads > 2,
  );
  assert.equal(state.reads, 5); // 存活 2 次 + 退出后 3 次
  assert.deepEqual(chunks, []);
});

test("N2: 数据到达重置空读计数（退出后宽限不跨数据累计）", async () => {
  const { pipe, state } = makeScriptedPipe(["", "data", "", "", ""]);
  const chunks: string[] = [];
  await drainPipe(
    pipe,
    (c) => chunks.push(c),
    () => true,
  );
  assert.deepEqual(chunks, ["data"]); // 退出后到达的数据照读（退出不立即断流）
  assert.equal(state.reads, 5); // 空、数据、空、空、空 → 第 5 次读判 EOF
});

test("spawnTurn: 退出非 0 且无 result → procError 带 stderrTail（≤500 字符）", async () => {
  const { proc } = makeFakeProc(INIT_LINE + "\n", {
    stderrText: "E".repeat(900),
  });
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(1);
  await handle.exitPromise;
  const procErr = events.find((e) => e.kind === "procError");
  assert.ok(procErr && procErr.kind === "procError");
  assert.equal(procErr.exitCode, 1);
  assert.equal(procErr.stderrTail?.length, 500);
  assert.equal(procErr.reason, undefined);
});

test("spawnTurn: 退出 0 但无 result → 也补 procError（防 UI 卡 waiting）", async () => {
  const { proc } = makeFakeProc(INIT_LINE + "\n");
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["init", "procError"],
  );
});

test("spawnTurn: spawn ENOENT → procError {exitCode:null, reason:'CLAUDE_NOT_FOUND'}", async () => {
  const subprocess: SubprocessLike = {
    call: async () => {
      const e: Error & { errno?: number } = new Error(
        "ENOENT: no such file or directory",
      );
      throw e;
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "missing",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  const procErr = events[0];
  assert.equal(procErr.kind, "procError");
  assert.equal(procErr.kind === "procError" && procErr.exitCode, null);
  assert.equal(
    procErr.kind === "procError" && procErr.reason,
    "CLAUDE_NOT_FOUND",
  );
});

test("spawnTurn: Gecko 拒收可执行文件（win32 原文）→ 同样归 CLAUDE_NOT_FOUND", async () => {
  const subprocess: SubprocessLike = {
    call: async () => {
      throw new Error(
        'File at path "cmd.exe" does not exist, or is not executable',
      );
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "cmd.exe",
    args: [],
    workdir: "C:\\ws",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  assert.equal(
    events[0].kind === "procError" && events[0].reason,
    "CLAUDE_NOT_FOUND",
  );
});

test("spawnTurn: spawn 其他失败 → procError 无 CLAUDE_NOT_FOUND reason", async () => {
  const subprocess: SubprocessLike = {
    call: async () => {
      throw new Error("workdir does not exist");
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/nope",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  assert.equal(events[0].kind, "procError");
  assert.equal(events[0].kind === "procError" && events[0].reason, undefined);
});

test("spawnTurn: kill → proc.kill 被调、退出无 result → procError 解锁", async () => {
  const { proc, state } = makeFakeProc(INIT_LINE + "\n");
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  // 等首轮读循环起来再杀
  await new Promise((r) => setTimeout(r, 5));
  handle.kill();
  assert.equal(state.killed, true);
  proc.finish(-15); // SIGTERM
  await handle.exitPromise;
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["init", "procError"]);
});

test("spawnTurn: stdin write 抛错不阻断流程", async () => {
  const { proc } = makeFakeProc(RESULT_LINE + "\n");
  proc.stdin.write = () => {
    throw new Error("pipe closed");
  };
  const subprocess: SubprocessLike = { call: async () => proc };
  const events: TurnEvent[] = [];
  const logs: string[] = [];
  const handle = spawnTurn(subprocess, {
    command: "c",
    args: [],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
    logger: (m) => logs.push(m),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["result"],
  );
  assert.ok(logs.some((m) => m.includes("stdin write failed")));
});

// ---- win32 .cmd 派发通道接线（BRIEF §2.10 B：探测与对话共用 buildCliInvocation）----

/** 记录 Subprocess.call 入参的 fake（不看流，进程立刻正常退出） */
function makeRecordingSubprocess() {
  const calls: {
    command: string;
    arguments: string[];
    workdir?: string;
  }[] = [];
  const subprocess: SubprocessLike = {
    call: async (options) => {
      calls.push({
        command: options.command,
        arguments: options.arguments,
        workdir: options.workdir,
      });
      const { proc } = makeFakeProc("");
      proc.finish(0);
      return proc;
    },
  };
  return { subprocess, calls };
}

test("spawnTurn channel=cmd: 命令经绝对 cmd.exe + ['/C', 整行] 派发（命中 Gecko cmd 特例）", async () => {
  const { subprocess, calls } = makeRecordingSubprocess();
  const handle = spawnTurn(subprocess, {
    command: "C:\\npm\\claude.cmd",
    channel: "cmd",
    cmdExePath: "C:\\Windows\\System32\\cmd.exe",
    args: ["--permission-mode", "acceptEdits", "--add-dir", "C:\\My Papers"],
    workdir: "C:\\ws",
    prompt: "x",
    onEvent: () => {},
  });
  await handle.exitPromise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0].arguments, [
    "/C",
    '"C:\\npm\\claude.cmd" "--permission-mode" "acceptEdits" "--add-dir" "C:\\My Papers"',
  ]);
  // worker 视角（Subprocess.call 前插 command）：3 个参数 + args[1] 命中 /C → 走 cmd 特例
  const workerArgs = [calls[0].command, ...calls[0].arguments];
  assert.equal(workerArgs.length, 3);
  assert.match(workerArgs[1], /^(\/S)?\/C$/i);
});

test("spawnTurn channel=cmd 未注入 cmdExePath: 回落 resolveCmdExePath 兜底（非裸名）", async () => {
  const { subprocess, calls } = makeRecordingSubprocess();
  const handle = spawnTurn(subprocess, {
    command: "C:\\npm\\claude.cmd",
    channel: "cmd",
    args: ["-p"],
    workdir: "C:\\ws",
    prompt: "x",
    onEvent: () => {},
  });
  await handle.exitPromise;
  assert.equal(calls[0].command, "C:\\Windows\\System32\\cmd.exe");
});

test("spawnTurn channel=direct/缺省: command 与 argv 原样直传（darwin 零回归）", async () => {
  const { subprocess, calls } = makeRecordingSubprocess();
  const handle = spawnTurn(subprocess, {
    command: "/usr/bin/claude",
    channel: "direct",
    args: ["-p", "--verbose"],
    workdir: "/w",
    prompt: "x",
    onEvent: () => {},
  });
  await handle.exitPromise;
  assert.deepEqual(calls, [
    {
      command: "/usr/bin/claude",
      arguments: ["-p", "--verbose"],
      workdir: "/w",
    },
  ]);
  // 缺省 channel 与显式 direct 等价
  const { subprocess: sub2, calls: calls2 } = makeRecordingSubprocess();
  const h2 = spawnTurn(sub2, {
    command: "/usr/bin/claude",
    args: ["-p"],
    workdir: "/w",
    prompt: "x",
    onEvent: () => {},
  });
  await h2.exitPromise;
  assert.deepEqual(calls2[0].arguments, ["-p"]);
});

// ---- darwin sh 提限通道接线（真实实测 2026-09-11：launchd 继承低 fd limit → CLI 启动即 exit 1）----

test("spawnTurn channel=sh: 经 /bin/sh -c 提限脚本派发（claude 路径在 $0、原参数在其后）", async () => {
  const { subprocess, calls } = makeRecordingSubprocess();
  const handle = spawnTurn(subprocess, {
    command: "/Users/x/.local/bin/claude",
    channel: "sh",
    args: ["-p", "--add-dir", "/Users/x/My Papers"],
    workdir: "/w",
    prompt: "x",
    onEvent: () => {},
  });
  await handle.exitPromise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.deepEqual(calls[0].arguments, [
    "-c",
    DARWIN_FD_RAISE_SCRIPT,
    "/Users/x/.local/bin/claude",
    "-p",
    "--add-dir",
    "/Users/x/My Papers",
  ]);
});

test("spawnTurn channel=sh 包装起不来（/bin/sh 缺失）→ 回退直接 spawn claude，该轮照常出结果", async () => {
  const calls: string[] = [];
  const { proc } = makeFakeProc(RESULT_LINE + "\n");
  const subprocess: SubprocessLike = {
    call: async (options) => {
      calls.push(options.command);
      if (options.command === "/bin/sh") {
        throw new Error(
          'File at path "/bin/sh" does not exist, or is not executable',
        );
      }
      return proc;
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "/usr/bin/claude",
    channel: "sh",
    args: ["-p"],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  proc.finish(0);
  await handle.exitPromise;
  assert.deepEqual(calls, ["/bin/sh", "/usr/bin/claude"]);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["result"],
  );
});

test("spawnTurn channel=sh 包装与回退都起不来 → 单条 procError（按回退失败归因 ENOENT）", async () => {
  let calls = 0;
  const subprocess: SubprocessLike = {
    call: async () => {
      calls += 1;
      const err = new Error("spawn ENOENT") as Error & { errno: number };
      err.errno = 2;
      throw err;
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "/usr/bin/claude",
    channel: "sh",
    args: ["-p"],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  assert.equal(calls, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "procError");
  assert.equal(
    events[0].kind === "procError" && events[0].reason,
    "CLAUDE_NOT_FOUND",
  );
});

test("spawnTurn channel=direct: spawn 失败不重试（非 sh 通道行为不变）", async () => {
  let calls = 0;
  const subprocess: SubprocessLike = {
    call: async () => {
      calls += 1;
      throw new Error("boom");
    },
  };
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "/usr/bin/claude",
    channel: "direct",
    args: ["-p"],
    workdir: "/w",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "procError");
});

test("spawnTurn channel=cmd 组装失败（8191 超限）→ procError SPAWN_FAILED 且不 spawn", async () => {
  const { subprocess, calls } = makeRecordingSubprocess();
  const events: TurnEvent[] = [];
  const handle = spawnTurn(subprocess, {
    command: "C:\\npm\\claude.cmd",
    channel: "cmd",
    args: ["--pad", "x".repeat(9000)],
    workdir: "C:\\ws",
    prompt: "x",
    onEvent: (e) => events.push(e),
  });
  await handle.exitPromise;
  assert.equal(calls.length, 0, "组装失败不得调用 Subprocess.call");
  assert.equal(events.length, 1);
  const err = events[0];
  assert.equal(err.kind, "procError");
  assert.equal(err.kind === "procError" && err.exitCode, null);
  assert.equal(err.kind === "procError" && err.reason, "CMD_LINE_TOO_LONG");
});

test("spawnTurn channel=cmd 组装失败（含 % / 换行）→ 各自原因，均不 spawn", async () => {
  for (const [args, reason] of [
    [["--%x"], "ARG_HAS_PERCENT"],
    [["a\nb"], "ARG_HAS_NEWLINE"],
  ] as const) {
    const { subprocess, calls } = makeRecordingSubprocess();
    const events: TurnEvent[] = [];
    const handle = spawnTurn(subprocess, {
      command: "C:\\npm\\claude.cmd",
      channel: "cmd",
      args: [...args],
      workdir: "C:\\ws",
      prompt: "x",
      onEvent: (e) => events.push(e),
    });
    await handle.exitPromise;
    assert.equal(calls.length, 0, `${reason}: 不得调用 Subprocess.call`);
    assert.equal(events[0].kind === "procError" && events[0].reason, reason);
  }
});
