import { createServer } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { duplexPair, type Duplex } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSandboxDuplexGatewayCodecSource } from "./sandbox-callback-bridge.js";

import {
  __duplexReadinessTesting,
  __http2PrefaceScanTesting,
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  parseAdapterExecutionTarget,
  postedIssueCommentLogMarker,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetProcessSessionBridge,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
  type EffectiveExecutionCapabilities,
  type EffectiveSandboxCapabilities,
} from "./execution-target.js";
import {
  createRuntimeSpanRunner,
  getActiveStepContext,
  type StartupSpan,
  type StartupTraceContext,
  type StartupTracer,
} from "./acpx-engine/startup-timing.js";
import { createSandboxRunLogTailFactory, type SandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import { runChildProcess } from "./server-utils.js";
import { shellQuote } from "./ssh.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import {
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DUPLEX_FRAME_VERSION,
  decodeDuplexLine,
  encodeDuplexFrame,
} from "./duplex-frame-codec.js";
import { DUPLEX_CHANNEL_LOST_ERROR_CODE } from "./bridge-transport-contract.js";
import {
  DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL,
  DUPLEX_COUNTER_FALLBACK_TOTAL,
  DUPLEX_COUNTER_LOSS_TOTAL,
  DUPLEX_DIMENSION_KEYS,
  DUPLEX_SPAN_CHANNEL_OPEN,
  DUPLEX_SPAN_REQUEST,
  DUPLEX_TRANSPORT_EVENT,
  type DuplexLossReason,
  type DuplexObservabilityCounterRecord,
  type DuplexObservabilityDimensions,
  type DuplexObservabilityEventRecord,
  type DuplexObservabilityRecorder,
  type DuplexObservabilitySpanRecord,
} from "./duplex-observability.js";

const execFileAsync = promisify(execFile);

type RecordedSpan = { name: string; parentName: string | null; ended: boolean };

/**
 * A structural tracer that records each opened span's name, parent, and end
 * state, so a test can assert the trace shape a runtime span runner produces.
 * Mirrors the recorder used for the `pack`/`stage.sync` nesting tests.
 */
function createRecordingTraceContext(): {
  traceContext: StartupTraceContext;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const byHandle = new WeakMap<StartupSpan, RecordedSpan>();
  const tracer: StartupTracer = {
    startSpan(name, _options, context) {
      const parent = context as RecordedSpan | undefined;
      const record: RecordedSpan = { name, parentName: parent?.name ?? null, ended: false };
      spans.push(record);
      const handle: StartupSpan = {
        setAttribute() {},
        setStatus() {},
        end() {
          record.ended = true;
        },
      };
      byHandle.set(handle, record);
      return handle;
    },
  };
  const traceContext: StartupTraceContext = {
    tracer,
    contextWithSpan: (span) => byHandle.get(span),
  };
  return { traceContext, spans };
}

describe("sandbox adapter execution targets", () => {
  const cleanupDirs: string[] = [];

  it("records successful issue comment ids for attribution recovery", () => {
    expect(postedIssueCommentLogMarker("POST", "/api/issues/issue-1/comments", 201, '{"id":"comment-1"}'))
      .toBe("comment id: comment-1\n");
    expect(postedIssueCommentLogMarker("POST", "/api/issues/issue-1/comments", 401, '{"id":"comment-1"}'))
      .toBeNull();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createLocalSandboxRunner() {
    let counter = 0;
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
      }) => {
        counter += 1;
        const command = input.command === "bash" ? "/bin/bash" : input.command;
        return runChildProcess(`sandbox-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        });
      },
    };
  }

  async function readRuntimeTextFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const contents: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        contents.push(...await readRuntimeTextFiles(entryPath));
      } else if (entry.isFile()) {
        contents.push(await readFile(entryPath, "utf8").catch(() => ""));
      }
    }
    return contents;
  }

  function encodeTailTick(stdout: Buffer, stderr: Buffer): string {
    return [
      "__PAPERCLIP_RUN_LOG_STDOUT__",
      stdout.toString("base64"),
      "__PAPERCLIP_RUN_LOG_STDERR__",
      stderr.toString("base64"),
      "__PAPERCLIP_RUN_LOG_END__",
      "",
    ].join("\n");
  }

  async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
  }

  type ProxyRunResult = {
    stdout: string;
    stderr: string;
    code: number | null;
    /**
     * How long the exchange took. The bridge and the proxy both run on 5s
     * budgets, which is generous locally and tight on a CI runner sharing a
     * box with 19 other lanes. A run that returns fast and empty is a
     * different fault from one that nearly hit the ceiling, and the numbers
     * are the only way to tell them apart after the fact.
     */
    elapsedMs: number;
  };

  async function runProxyWithInput(command: string, input: string): Promise<ProxyRunResult> {
    const startedAt = performance.now();
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for process session proxy."));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    return { stdout, stderr, code, elapsedMs: Math.round(performance.now() - startedAt) };
  }

  /**
   * A failure report for a proxy exchange, attached to the assertions below.
   *
   * `execution-target-sandbox` has failed twice in CI and never once in a few
   * hundred local runs, so the next occurrence has to carry its own evidence -
   * a second unreproducible failure teaches nothing. The observed signature was
   * an empty stdout with exit code 0, meaning the child exited cleanly having
   * produced nothing, which is what a lost stdin frame looks like from here.
   *
   * The runtime tree is the part that discriminates. The stdin queue files are
   * written by the host and deleted by the wrapper once parsed, so what remains
   * says whether the frame was never written, written and never consumed, or
   * consumed normally and the reply lost on the way back.
   */
  async function describeProxyRun(result: ProxyRunResult, runtimeRootDir: string): Promise<string> {
    const lines = [
      `proxy exit=${result.code} elapsedMs=${result.elapsedMs}`,
      `proxy stdout=${JSON.stringify(result.stdout)}`,
      `proxy stderr=${JSON.stringify(result.stderr)}`,
    ];
    const walk = async (dir: string, depth: number): Promise<void> => {
      // Deep enough to reach the queue frames, which are the point. They sit
      // at process-sessions/<id>/stdin/<seq>.json — depth 4 from the runtime
      // root — so a cap of 3 listed the `stdin/` directory and stopped, making
      // "the queue is empty" and "the walk never looked" print identically.
      if (depth > 5) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        lines.push(`${"  ".repeat(depth)}<unreadable ${dir}: ${(error as Error).message}>`);
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${"  ".repeat(depth)}${entry.name}/`);
          await walk(full, depth + 1);
          continue;
        }
        // Small files are the queue and event frames, and their contents are
        // the point. Anything larger is a child script or a log; the size is
        // enough to say it exists.
        let detail = "";
        try {
          const raw = await readFile(full, "utf8");
          detail = raw.length <= 400 ? ` ${JSON.stringify(raw)}` : ` <${raw.length}B>`;
        } catch (error) {
          detail = ` <unreadable: ${(error as Error).message}>`;
        }
        lines.push(`${"  ".repeat(depth)}${entry.name}${detail}`);
      }
    };
    lines.push(`runtime tree under ${runtimeRootDir}:`);
    await walk(runtimeRootDir, 1);
    return lines.join("\n");
  }

  function combinedStream(
    events: Array<{ stream: "stdout" | "stderr"; chunk: string }>,
    stream: "stdout" | "stderr",
  ): string {
    return events.filter((event) => event.stream === stream).map((event) => event.chunk).join("");
  }

  it("executes through the provider-neutral runner without a remote spec", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
      runner,
    };

    expect(adapterExecutionTargetToRemoteSpec(target)).toBeNull();

    const result = await runAdapterExecutionTargetProcess("run-1", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(result.stdout).toBe("ok\n");
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "agent-cli",
      args: ["--json"],
      cwd: "/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutMs: 5000,
    }));
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
    });
  });

  it("preserves stdin when wrapping sandbox adapter commands for run-log streaming", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-stdin-"));
    cleanupDirs.push(rootDir);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      streamRunLogs: true,
      runner: createLocalSandboxRunner(),
    };
    const logsDir = path.posix.join(rootDir, ".paperclip-runtime", "bridge", "logs");
    const runLogTail = createSandboxRunLogTailFactory({
      runner: target.runner!,
      remoteCwd: rootDir,
      logsDir,
      shellCommand: "bash",
    }).create();
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const result = await runAdapterExecutionTargetProcess(
      "run-log-stdin",
      target,
      process.execPath,
      ["-e", "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write('stdin=' + s));"],
      {
        cwd: rootDir,
        env: {},
        stdin: "hello-through-wrapper",
        timeoutSec: 5,
        graceSec: 1,
        runLogTail: { create: () => runLogTail },
        onLog: async (stream, chunk) => { events.push({ stream, chunk }); },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("stdin=hello-through-wrapper");
    expect(combinedStream(events, "stdout")).toContain("stdin=hello-through-wrapper");
  });

  it("creates the process session directories only in the launch exec, not in upfront makeDir execs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-makedir-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const delegate = createLocalSandboxRunner();
    const execScripts: string[] = [];
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        execScripts.push(input.args?.[1] ?? "");
        return delegate.execute(input);
      }),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-makedir",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      // No standalone `mkdir -p '<dir>/stdin'` or `.../events` exec runs before launch.
      const standaloneSessionDirExecs = execScripts.filter((script) =>
        /^mkdir -p '[^']*\/(stdin|events)'\s*$/.test(script),
      );
      expect(standaloneSessionDirExecs).toEqual([]);

      // The launch exec creates both directories in one `mkdir -p` line.
      const launchExecs = execScripts.filter(
        (script) => script.includes("nohup") && /mkdir -p [^\n]*\/stdin[^\n]*\/events/.test(script),
      );
      expect(launchExecs.length).toBe(1);
    } finally {
      await bridge?.stop();
    }
  });

  it("test_process_session_poll_exec_parents_to_run_context", async () => {
    // The poll timer runs run-time execs for the whole run. Its `sandbox.exec`
    // span must parent to the live run span, not to the ended startup step. The
    // bridge reads `getRuntimeParentContext` per tick and runs the poll under
    // that token. This test drives the bridge with a getter that returns a known
    // token, lets the first poll tick fire, and proves the poll exec reads that
    // token from the active step store.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-parent-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const runParentToken = { marker: "process-session-run-parent" };
    let bridgeStarted = false;
    let pollStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        // Record the active step for the first exec that runs after the bridge
        // start resolves. The setup execs run during the measured start; the
        // poll timer fires later, under the run parent context.
        if (bridgeStarted && pollStep === "unset") {
          pollStep = getActiveStepContext();
          resolvePoll();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-parent",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      getRuntimeParentContext: () => runParentToken,
    });
    expect(bridge).not.toBeNull();
    bridgeStarted = true;

    try {
      await pollObserved;
      // The poll exec ran under the run parent context, so its exec span parents
      // to the run token, not to a detached root or an ended startup step.
      expect(pollStep).not.toBe("unset");
      expect(pollStep).not.toBeNull();
      expect((pollStep as { parentContext?: unknown }).parentContext).toBe(runParentToken);
      expect((pollStep as { criticalPath?: boolean }).criticalPath).toBe(false);
    } finally {
      await bridge?.stop();
    }
  });

  it("test_process_session_poll_exec_stays_unparented_without_getter", async () => {
    // With no `getRuntimeParentContext`, the poll tick runs with an empty active
    // step store, exactly like the earlier `runWithoutActiveStep` behavior. So a
    // poll `sandbox.exec` span opens unparented with no stale startup flag.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-nogetter-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    let bridgeStarted = false;
    let pollStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        if (bridgeStarted && pollStep === "unset") {
          pollStep = getActiveStepContext();
          resolvePoll();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-nogetter",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();
    bridgeStarted = true;

    try {
      await pollObserved;
      expect(pollStep).toBeNull();
    } finally {
      await bridge?.stop();
    }
  });

  it("test_process_session_stdin_exec_reads_send_time_run_parent", async () => {
    // A persistent socket can open under one run parent and receive stdin later,
    // under a different parent. The stdin-write `sandbox.exec` span must parent
    // to the parent that is live at send time, not to the parent that was live
    // when the socket opened. The bridge reads `getRuntimeParentContext` per
    // message in the `data` handler, not once at connect time. This test opens a
    // socket while `connectParent` is live, switches the getter to `turnParent`,
    // sends one stdin line, and proves the stdin write ran under `turnParent`.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stdin-parent-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const connectParent = { marker: "process-session-connect-parent" };
    const turnParent = { marker: "process-session-turn-parent" };
    let currentParent: unknown = connectParent;

    let stdinWriteStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolveStdinWrite: () => void = () => {};
    const stdinWriteObserved = new Promise<void>((resolve) => {
      resolveStdinWrite = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        // Record the active step for the first exec that writes the stdin file.
        // The `.paperclip-upload` temp path under the `stdin` directory is unique
        // to the stdin-write path; the poll loop reads the `events` directory.
        const script = (input.args ?? []).join("\n");
        if (stdinWriteStep === "unset" && /\/stdin\/[^\s']*paperclip-upload/.test(script)) {
          stdinWriteStep = getActiveStepContext();
          resolveStdinWrite();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stdin-parent",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      getRuntimeParentContext: () => currentParent as never,
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      expect(Number.isFinite(port)).toBe(true);
      expect(typeof tokenLiteral).toBe("string");
      const token = JSON.parse(tokenLiteral as string) as string;

      // Open the socket while `connectParent` is the live run parent.
      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });
      // Let the server accept the connection and register the `data` handler
      // under the connect-time parent before the getter switches.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The run enters an agent turn: the live run parent switches.
      currentParent = turnParent;

      // Send one stdin line. The first token-bearing message authenticates and
      // writes the stdin file. That write must read `turnParent` at send time.
      peerSocket.write(`${JSON.stringify({ token, type: "stdin", data: Buffer.from("hi").toString("base64") })}\n`);

      await stdinWriteObserved;
      // The stdin write ran under the send-time parent, not the connect-time
      // parent captured when the socket opened.
      expect(stdinWriteStep).not.toBe("unset");
      expect(stdinWriteStep).not.toBeNull();
      expect((stdinWriteStep as { parentContext?: unknown }).parentContext).toBe(turnParent);
      expect((stdinWriteStep as { parentContext?: unknown }).parentContext).not.toBe(connectParent);
      expect((stdinWriteStep as { criticalPath?: boolean }).criticalPath).toBe(false);
    } finally {
      peer?.destroy();
      await bridge?.stop();
    }
  });

  it("wraps a stdin write in a sandbox.agentSession.sendInput span", async () => {
    // With a span runner injected, the socket handler wraps one outbound ACP
    // message to the agent in a `sandbox.agentSession.sendInput` span. This test
    // connects a socket, sends one stdin line, and proves the handler opens that
    // wrapper span around the write.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-sendinput-span-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const spanNames: string[] = [];
    let resolveSendInput: () => void = () => {};
    const sendInputObserved = new Promise<void>((resolve) => {
      resolveSendInput = resolve;
    });

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-sendinput-span",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      // Record each wrapper span name, then run the wrapped work.
      runtimeSpan: async (name, work) => {
        spanNames.push(name);
        if (name === "sandbox.agentSession.sendInput") resolveSendInput();
        return work();
      },
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      const token = JSON.parse(tokenLiteral as string) as string;

      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });

      // The first token-bearing message authenticates and writes the stdin file.
      peerSocket.write(
        `${JSON.stringify({ token, type: "stdin", data: Buffer.from("hi").toString("base64") })}\n`,
      );

      await sendInputObserved;
      expect(spanNames).toContain("sandbox.agentSession.sendInput");
    } finally {
      peer?.destroy();
      await bridge?.stop();
    }
  });

  it("wraps each poll tick in a sandbox.agentSession.pollOutput span", async () => {
    // With a span runner injected, the poll timer wraps each 100 ms poll tick in
    // a `sandbox.agentSession.pollOutput` span. This test lets the first poll tick
    // fire and proves the timer opens that wrapper span.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-span-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const spanNames: string[] = [];
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-span",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      // Record each wrapper span name, then run the wrapped work.
      runtimeSpan: async (name, work) => {
        spanNames.push(name);
        if (name === "sandbox.agentSession.pollOutput") resolvePoll();
        return work();
      },
    });
    expect(bridge).not.toBeNull();

    try {
      await pollObserved;
      expect(spanNames).toContain("sandbox.agentSession.pollOutput");
    } finally {
      await bridge?.stop();
    }
  });

  it("bridges bidirectional sandbox process sessions through a local ACPX-spawnable proxy", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fake-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('out:' + chunk.toString());",
        "  process.stderr.write('err:' + chunk.toString());",
        "});",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
      const report = await describeProxyRun(result, path.posix.join(rootDir, ".paperclip-runtime", "acpx"));
      expect(result.code, report).toBe(0);
      expect(result.stdout, report).toBe("out:hello\n");
      expect(result.stderr, report).toBe("err:hello\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("buffers sandbox process session output until the local proxy connects", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-buffer-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('early-out\\n');",
        "process.stderr.write('early-err\\n');",
        "setTimeout(() => process.exit(0), 20);",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-buffer",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("early-out\n");
      expect(result.stderr).toBe("early-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("delivers full output when the sandbox child exits immediately after writing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-fast-exit-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "instant-exit-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('final-out\\n');",
        "process.stderr.write('final-err\\n');",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-fast-exit",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("final-out\n");
      expect(result.stderr).toBe("final-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("ignores unauthenticated connections to the process session bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-auth-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "guarded-acp-child.mjs");
    await writeFile(childPath, "process.stdout.write('guarded-out\\n');", "utf8");
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-auth",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    let squatter: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      expect(Number.isFinite(port)).toBe(true);

      // An idle local connection must not claim the session or see buffered output.
      const squatterSocket = net.createConnection({ host: "127.0.0.1", port });
      squatter = squatterSocket;
      let squatterReceived = "";
      squatterSocket.setEncoding("utf8");
      squatterSocket.on("data", (chunk: string) => {
        squatterReceived += chunk;
      });
      squatterSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        squatterSocket.once("connect", () => resolve());
        squatterSocket.once("error", reject);
      });

      // A peer presenting the wrong token is disconnected outright.
      const badPeer = net.createConnection({ host: "127.0.0.1", port });
      badPeer.on("error", () => undefined);
      const badPeerClosed = new Promise<void>((resolve) => badPeer.once("close", () => resolve()));
      badPeer.once("connect", () => badPeer.write(`${JSON.stringify({ token: "wrong-token", type: "stdinEnd" })}\n`));
      await badPeerClosed;

      // The authenticated proxy still attaches and receives the buffered output.
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("guarded-out\n");
      expect(squatterReceived).toBe("");
    } finally {
      squatter?.destroy();
      await bridge?.stop();
    }
  });

  it("streams sandbox process session output before the remote child exits", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "streaming-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  if (chunk.includes('ping')) {",
        "    process.stdout.write('delta:ping\\n');",
        "    process.stderr.write('trace:ping\\n');",
        "  }",
        "  if (chunk.includes('finish')) process.exit(0);",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stream",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    const child = spawn(bridge!.agentCommand, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exited = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for streaming process session proxy."));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        exited = true;
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    try {
      child.stdin.write("ping\n");
      await waitForCondition(
        () => stdout.includes("delta:ping\n") && stderr.includes("trace:ping\n"),
        "Timed out waiting for live process session output.",
        3000,
      );
      expect(exited).toBe(false);

      child.stdin.end("finish\n");
      await expect(exitPromise).resolves.toBe(0);
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await exitPromise.catch(() => undefined);
      }
      await bridge?.stop();
    }
  });

  describe("streamed output (streamOutputViaSession)", () => {
    it("bridges bidirectional sessions when the wrapper streams output to stdout", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-echo-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "echo-acp-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('out:' + chunk.toString());",
          "  process.stderr.write('err:' + chunk.toString());",
          "});",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-echo",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
      });
      expect(bridge).not.toBeNull();

      try {
        const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
        const report = await describeProxyRun(result, path.posix.join(rootDir, ".paperclip-runtime", "acpx"));
        expect(result.code, report).toBe(0);
        expect(result.stdout, report).toBe("out:hello\n");
        expect(result.stderr, report).toBe("err:hello\n");
      } finally {
        await bridge?.stop();
      }
    });

    it("wraps the long-lived streamed launch in a sandbox.agentProcess span", async () => {
      // The streamed launch is fire-and-forget and lives for the whole run, so
      // its span must open under the live run root (not the ephemeral bring-up
      // step) and stay open around the launch. Record the opened span names and
      // prove `sandbox.agentProcess` is among them, and that a normal exchange
      // still works through the wrap.
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-span-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "echo-acp-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('out:' + chunk.toString());",
          "});",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const spanNames: string[] = [];
      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-span",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
        // Record each wrapper span name, then run the wrapped work.
        runtimeSpan: async (name, work) => {
          spanNames.push(name);
          return work();
        },
      });
      expect(bridge).not.toBeNull();

      try {
        // The launch span opens synchronously as the bridge starts, before any
        // frame flows, so it is observable as soon as the handle resolves.
        expect(spanNames).toContain("sandbox.agentProcess");
        const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
        const report = await describeProxyRun(result, path.posix.join(rootDir, ".paperclip-runtime", "acpx"));
        expect(result.code, report).toBe(0);
        expect(result.stdout, report).toBe("out:hello\n");
      } finally {
        await bridge?.stop();
      }
    });

    it("parents the sandbox.agentProcess span to the live run root, not the bring-up step", async () => {
      // The launch runs for the whole run, so its span must parent to the live
      // run root (here a stand-in `task.run`) rather than the ephemeral
      // `bridge.process-session` bring-up step — otherwise it dangles past its
      // parent and overlaps `agent.turn`. Build the real run-rooted runner from a
      // recording trace context and assert the recorded parent.
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-parent-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "noop-acp-child.mjs");
      await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const { traceContext, spans } = createRecordingTraceContext();
      // The run root stands in for `task.run` — the parent the run-rooted runner
      // resolves at launch time, since no turn has started yet.
      const runRoot = traceContext.tracer.startSpan("task.run", undefined, undefined);
      const runRootContext = traceContext.contextWithSpan(runRoot);
      const runtimeSpan = createRuntimeSpanRunner(traceContext, () => runRootContext);

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-parent",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
        runtimeSpan,
      });
      expect(bridge).not.toBeNull();

      try {
        const agentProcess = spans.find((span) => span.name === "sandbox.agentProcess");
        expect(agentProcess).toBeDefined();
        expect(agentProcess!.parentName).toBe("task.run");
      } finally {
        await bridge?.stop();
      }
    });

    it("ends the sandbox.agentProcess span at stop() even when the process lingers", async () => {
      // The span must not outlive the run root. When the remote process lingers
      // past bridge teardown (`execute` has no cancel), the span still has to end
      // at `stop()`, which the caller awaits before it ends `task.run`. Use a
      // child that ignores stdin and never exits on its own, so the launch
      // command stays pending across `stop()`, and prove the span ends anyway.
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-linger-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "linger-acp-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdin.on('data', () => {});",
          // Stay alive well past the assertions, then self-exit so the test
          // leaves no lingering process.
          "setTimeout(() => process.exit(0), 3000);",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      // Track when each wrapper span's work settles (i.e. when its span ends).
      const spanRecords: Array<{ name: string; ended: boolean }> = [];
      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-linger",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 10,
        onLog: async () => {},
        streamOutputViaSession: true,
        runtimeSpan: (name, work) => {
          const record = { name, ended: false };
          spanRecords.push(record);
          const promise = work();
          void promise.then(
            () => {
              record.ended = true;
            },
            () => {
              record.ended = true;
            },
          );
          return promise;
        },
      });
      expect(bridge).not.toBeNull();

      const record = spanRecords.find((span) => span.name === "sandbox.agentProcess");
      expect(record).toBeDefined();
      // The launch command is still running, so the span is still open.
      expect(record!.ended).toBe(false);

      // Teardown ends the span promptly, without waiting for the lingering command.
      await bridge!.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(record!.ended).toBe(true);
    });

    it("buffers streamed output until the local proxy connects", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-buffer-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "fast-stream-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdout.write('early-out\\n');",
          "process.stderr.write('early-err\\n');",
          "setTimeout(() => process.exit(0), 20);",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-buffer",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
      });
      expect(bridge).not.toBeNull();

      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = await runProxyWithInput(bridge!.agentCommand, "");
        expect(result.code).toBe(0);
        // The seq guard delivers the early output exactly once even though the
        // live stream and the terminal result both carry it.
        expect(result.stdout).toBe("early-out\n");
        expect(result.stderr).toBe("early-err\n");
      } finally {
        await bridge?.stop();
      }
    });

    it("delivers full streamed output when the sandbox child exits immediately", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-fast-exit-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "instant-stream-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdout.write('final-out\\n');",
          "process.stderr.write('final-err\\n');",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-fast-exit",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
      });
      expect(bridge).not.toBeNull();

      try {
        const result = await runProxyWithInput(bridge!.agentCommand, "");
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("final-out\n");
        expect(result.stderr).toBe("final-err\n");
      } finally {
        await bridge?.stop();
      }
    });

    it("streams live output before the child exits and never writes output event files", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-live-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "live-stream-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => {",
          "  if (chunk.includes('ping')) {",
          "    process.stdout.write('delta:ping\\n');",
          "    process.stderr.write('trace:ping\\n');",
          "  }",
          "  if (chunk.includes('finish')) process.exit(0);",
          "});",
          "process.stdin.resume();",
        ].join("\n"),
        "utf8",
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-live",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
      });
      expect(bridge).not.toBeNull();

      const child = spawn(bridge!.agentCommand, [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let exited = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Timed out waiting for streamed process session proxy."));
        }, 5000);
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("exit", (exitCode) => {
          exited = true;
          clearTimeout(timeout);
          resolve(exitCode);
        });
      });

      try {
        child.stdin.write("ping\n");
        await waitForCondition(
          () => stdout.includes("delta:ping\n") && stderr.includes("trace:ping\n"),
          "Timed out waiting for live streamed process session output.",
          3000,
        );
        expect(exited).toBe(false);

        child.stdin.end("finish\n");
        await expect(exitPromise).resolves.toBe(0);

        // The streamed path uses the stdout wrapper, not the output-file poll, so
        // no `events` directory is ever created under the session runtime tree.
        const hasEventsDir = await readdir(
          path.posix.join(rootDir, ".paperclip-runtime", "acpx", "process-sessions"),
          { withFileTypes: true, recursive: true },
        )
          .then((entries) => entries.some((entry) => entry.isDirectory() && entry.name === "events"))
          .catch(() => false);
        expect(hasEventsDir).toBe(false);
      } finally {
        if (!exited) {
          child.kill("SIGKILL");
          await exitPromise.catch(() => undefined);
        }
        await bridge?.stop();
      }
    });

    it("keeps the agent command on the persistent session and forces bridge control execs off it", async () => {
      // Regression guard for the streamed-mode startup deadlock. The persistent
      // session is one serialized shell. In streamed mode the agent runs as a
      // long-lived foreground session command that holds the session for the
      // whole run. The bridge control-plane execs (script sync, stdin delivery,
      // teardown) must run concurrently with the agent, so each must force
      // itself off the session. On the session they queue behind the agent
      // command that never returns, and the first handshake write never drains.
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-isolation-"));
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "echo-acp-child.mjs");
      await writeFile(
        childPath,
        [
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('out:' + chunk.toString());",
          "});",
        ].join("\n"),
        "utf8",
      );

      const delegate = createLocalSandboxRunner();
      const execs: Array<{ useSession?: boolean; bypassSession?: boolean; script: string }> = [];
      const runner = {
        execute: vi.fn(
          async (
            input: Parameters<typeof delegate.execute>[0] & {
              useSession?: boolean;
              bypassSession?: boolean;
            },
          ) => {
            execs.push({
              useSession: input.useSession,
              bypassSession: input.bypassSession,
              script: input.args?.[1] ?? "",
            });
            return delegate.execute(input);
          },
        ),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-stream-isolation",
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession: true,
      });
      expect(bridge).not.toBeNull();

      try {
        // Round-trip one input so a stdin-delivery control exec runs and gets
        // recorded before the assertions below.
        const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
        expect(
          result.stdout,
          await describeProxyRun(result, path.posix.join(rootDir, ".paperclip-runtime", "acpx")),
        ).toBe("out:hello\n");

        // Exactly one exec runs on the persistent session: the long-lived agent
        // command. It streams its output through the session log stream, so it
        // must not also bypass the session.
        const sessionExecs = execs.filter((exec) => exec.useSession === true);
        expect(sessionExecs).toHaveLength(1);
        expect(sessionExecs[0]!.bypassSession).not.toBe(true);
        expect(sessionExecs[0]!.script).toContain("node ");

        // Every other exec is bridge control-plane plumbing. Each must force
        // itself off the persistent session so it never queues behind the agent
        // command that holds it.
        const controlExecs = execs.filter((exec) => exec.useSession !== true);
        expect(controlExecs.length).toBeGreaterThan(0);
        for (const exec of controlExecs) {
          expect(exec.bypassSession).toBe(true);
        }
      } finally {
        await bridge?.stop();
      }
    });
  });

  it("applies the remote sandbox fallback when adapter timeoutSec is unset", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    // The sandbox default is a 4h wall-clock backstop matching the recovery
    // watchdog critical threshold (ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);
    // the output-inactivity monitor remains the primary hang detector.
    expect(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC).toBe(4 * 60 * 60);
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 0)).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
    );
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 90)).toBe(90);
    expect(resolveAdapterExecutionTargetTimeoutSec({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: "KEY",
        knownHosts: "host key",
        strictHostKeyChecking: true,
      },
    }, 0)).toBe(0);
    expect(resolveAdapterExecutionTargetTimeoutSec({ kind: "local" }, 0)).toBe(0);
  });

  it("reports which knob produced the resolved timeout", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 90)).toEqual({
      timeoutSec: 90,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
    // Fractional (sub-second) configured timeouts are preserved rather than
    // floored to 0, which would silently mean "no timeout".
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0.01)).toEqual({
      timeoutSec: 0.01,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0.5)).toEqual({
      timeoutSec: 0.5,
      source: "configured",
    });
  });

  it("treats a negative timeoutSec as the explicit no-timeout opt-out, even on sandbox targets", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, -1)).toBe(0);

    // Explicit zero intentionally does NOT opt out: the adapter config UI
    // persists the schema default of 0 for untouched fields, so a stored
    // timeoutSec=0 cannot be read as operator intent. It keeps the sandbox
    // backstop; the documented opt-out is a negative value.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    // Unset behaves like zero.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, undefined)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, undefined)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
  });

  it("formats self-describing timeout errors naming the timer and knob", () => {
    expect(
      formatAdapterExecutionTimeoutErrorMessage({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=14400, sandbox default). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
    expect(
      formatAdapterExecutionTimeoutErrorMessage({ timeoutSec: 1800, source: "configured" }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=1800, configured via adapterConfig.timeoutSec). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
  });

  it("formats the start-of-run timeout log line with the resolved value and source", () => {
    expect(
      formatAdapterExecutionTimeoutStartLogLine({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=14400 (sandbox default; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 900, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=900 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "unlimited" }),
    ).toBe(
      "Adapter execution timeout: none (no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one).",
    );
    // Negative opt-out resolves to { timeoutSec: 0, source: "configured" }.
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one).",
    );
  });

  it("uses the caller timeout override when installing a missing sandbox command", async () => {
    const runner = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "/usr/bin/opencode\n",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      timeoutMs: 300_000,
      runner,
    };

    await ensureAdapterExecutionTargetCommandResolvable(
      "opencode",
      target,
      "/local/workspace",
      {},
      { installCommand: "npm install -g opencode", timeoutSec: 1800 },
    );

    expect(runner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g opencode"],
      timeoutMs: 1_800_000,
    }));
  });

  it("runs shell commands through the same runner", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("strips inherited host identity env before sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");
    vi.stubEnv("TMPDIR", "/var/folders/local/T");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1b", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/host/bin:/usr/bin",
        HOME: "/Users/local",
        TMPDIR: "/var/folders/local/T",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("preserves explicit remote identity env overrides for sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1c", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("treats SSH targets as bridge-only", () => {
    const target = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };

    expect(adapterExecutionTargetUsesPaperclipBridge(target)).toBe(true);
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "paperclip",
      remoteCwd: "/workspace",
    });
  });

  it("uses the provider-declared shell for sandbox helper commands", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "custom-provider",
      shellCommand: "bash",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2b", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("starts a localhost Paperclip bridge for sandbox targets in bridge mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(bridge?.env.PAPERCLIP_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bridge?.env.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");

      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("creates a sandbox run log tail factory when bridge streaming is enabled", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      streamRunLogs: true,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    try {
      expect(bridge?.runLogTail).toBeTruthy();
      expect(combinedStream(logs, "stdout")).toContain("Sandbox run log streaming enabled");

      const wrapped = bridge!.runLogTail!.create().wrapCommand("agent-cli", ["--message", "hello world"]);
      expect(wrapped.command).toBe("sh");
      expect(wrapped.args.join("\n")).toContain("tee -a");
      expect(wrapped.args.join("\n")).toContain("agent-cli");
    } finally {
      await bridge?.stop();
    }
  });

  it("defaults sandbox run log streaming on and honors the explicit opt-out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-default-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const baseTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const defaultBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-default",
      target: baseTarget,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(defaultBridge?.runLogTail).toBeTruthy();
    } finally {
      await defaultBridge?.stop();
    }

    const optOutBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-opt-out",
      target: { ...baseTarget, streamRunLogs: false },
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(optOutBridge?.runLogTail ?? null).toBeNull();
    } finally {
      await optOutBridge?.stop();
    }
  });

  it("tails sandbox run log chunks with byte offsets and dedupes the final batch", async () => {
    const stdoutText = "stdout-abc\n";
    const stderrText = "stderr-xyz\n";
    const stdoutBytes = Buffer.from(stdoutText, "utf8");
    const stderrBytes = Buffer.from(stderrText, "utf8");
    const stdoutOffsets: number[] = [];
    const stderrOffsets: number[] = [];
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        const stderrStart = Math.max(0, (offsets[1] ?? 1) - 1);
        stdoutOffsets.push(stdoutStart + 1);
        stderrOffsets.push(stderrStart + 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(
            stdoutBytes.subarray(stdoutStart, stdoutStart + 4),
            stderrBytes.subarray(stderrStart, stderrStart + 4),
          ),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 4,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });

    await waitForCondition(
      () => combinedStream(events, "stdout") === stdoutText && combinedStream(events, "stderr") === stderrText,
      "run log tail did not stream expected stdout/stderr chunks",
    );

    await tail.finish({ stdout: stdoutText, stderr: stderrText });

    expect(combinedStream(events, "stdout")).toBe(stdoutText);
    expect(combinedStream(events, "stderr")).toBe(stderrText);
    expect(stdoutOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(stderrOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      cwd: "/workspace",
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      timeoutMs: 50,
    }));
  });

  it("emits only the unstreamed final suffix when the tail loop stops early", async () => {
    const finalStdout = "prefix suffix\n";
    const finalBytes = Buffer.from(finalStdout, "utf8");
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: { args?: string[] }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(finalBytes.subarray(stdoutStart, stdoutStart + 7), Buffer.alloc(0)),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 7,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => combinedStream(events, "stdout").length >= 7, "run log tail did not emit prefix");
    await tail.finish({ stdout: finalStdout, stderr: "" });

    expect(combinedStream(events, "stdout")).toBe(finalStdout);
    expect(events.filter((event) => event.stream === "stdout").map((event) => event.chunk).join("|"))
      .toBe("prefix |suffix\n");
  });

  it("delivers the final batch and a warning when run log polling degrades", async () => {
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "tail failed",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      tickTimeoutMs: 50,
      maxConsecutiveFailures: 1,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => runner.execute.mock.calls.length >= 1, "run log tail did not poll before finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tail.finish({ stdout: "final out\n", stderr: "final err\n" });

    expect(combinedStream(events, "stdout")).toBe("final out\n");
    expect(combinedStream(events, "stderr")).toBe(
      "final err\n[paperclip] Run log streaming degraded during the run; remaining output was delivered at completion.\n",
    );
  });

  it("exposes the Paperclip bridge to the sandbox shell surface", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-shell-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge shell test API server to listen on a TCP port.");
    }

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-shell",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      const shellProbe = [
        "const url = `${process.env.PAPERCLIP_API_URL}/api/agents/me`;",
        "fetch(url, { headers: { authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, accept: 'application/json' } })",
        "  .then(async (response) => {",
        "    const body = await response.json();",
        "    process.stdout.write(JSON.stringify({",
        "      status: response.status,",
        "      body,",
        "      bridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE,",
        "    }));",
        "  })",
        "  .catch((error) => {",
        "    console.error(error instanceof Error ? error.stack : String(error));",
        "    process.exit(1);",
        "  });",
      ].join("\n");

      const result = await runAdapterExecutionTargetShellCommand(
        "run-bridge-shell",
        target,
        `${shellQuote(process.execPath)} -e ${shellQuote(shellProbe)}`,
        {
          cwd: remoteCwd,
          env: bridge!.env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: 200,
        body: { ok: true },
        bridgeMode: "queue_v1",
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("real-run-jwt");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runnerCommandText = JSON.stringify(
        runner.execute.mock.calls.map(([call]) => ({
          command: call.command,
          args: call.args,
        })),
      );
      expect(runnerCommandText).not.toContain("real-run-jwt");
      expect(runnerCommandText).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runtimeFiles = (await readRuntimeTextFiles(runtimeRootDir)).join("\n");
      expect(runtimeFiles).not.toContain("real-run-jwt");
      expect(runtimeFiles).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-shell",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("uses the effective adapter timeout when starting the sandbox callback bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-timeout-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const apiServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge timeout test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-timeout",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(runner.execute).toHaveBeenCalled();
      expect(
        runner.execute.mock.calls.some(([input]) => input.timeoutMs === DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000),
      ).toBe(true);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("fails an oversized host response with a non-retryable 409 so a committed mutation never repeats", async () => {
    // The host receives the request and commits the mutation, then sends a
    // response body over the size limit. The forward reads the body after the
    // fetch resolves, so the read failure happens after the host commit. The
    // forward must return a non-retryable 504 with the indeterminate outcome, not
    // a retryable 502. The in-sandbox server maps the indeterminate 504 to a
    // non-retryable 409. A retryable status would repeat the mutation with a new
    // request id outside the broker deduplication set.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    // The host body sits over the size limit, so the forward read fails. The
    // limit stays above the small indeterminate marker the forward returns, so the
    // marker still reaches the server for the 504-to-409 map.
    const largeBody = "x".repeat(1024);
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(201, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
      });
      res.end(largeBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 512,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Status update." }),
      });

      // The indeterminate 504 maps to a non-retryable 409, so the caller does not
      // retry the committed mutation.
      expect(response.status).toBe(409);
      expect(response.headers.get("x-paperclip-bridge-outcome")).toBe("indeterminate");
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 512 bytes.",
        outcome: "indeterminate",
        retryable: false,
      });
      // The host ran the mutation exactly once. It never receives a retry.
      expect(requests).toEqual([{
        method: "POST",
        url: "/api/issues/issue-1/comments",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-limit",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("keeps an oversized host response for a safe method retryable so the read failure does not turn terminal", async () => {
    // A GET never changes host state, so a retry cannot double-apply a mutation.
    // The host sends a response body over the size limit, so the forward read
    // fails after the fetch resolves. For a safe method the forward must return a
    // retryable 502 with no indeterminate marker, not the non-retryable 504 the
    // forward returns for a mutating method. The in-sandbox server passes the 502
    // through, so the caller can retry the safe read.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-safe-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const largeBody = "x".repeat(1024);
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
      });
      res.end(largeBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-safe-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 512,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
        },
      });

      // The forward returns a retryable 502 with no indeterminate marker, so the
      // server passes it through instead of mapping it to a terminal 409.
      expect(response.status).toBe(502);
      expect(response.headers.get("x-paperclip-bridge-outcome")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 512 bytes.",
      });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/issues/issue-1",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-safe-limit",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("forwards the host indeterminate-outcome header so the sandbox server maps the 504 to a non-retryable 409", async () => {
    // The host marks a possibly-committed mutation with a 504 and the
    // `x-paperclip-bridge-outcome: indeterminate` header. The forward must keep
    // that header, so the in-sandbox server maps the 504 to a non-retryable 409.
    // If the forward drops the header, the client sees a retryable 504 and a
    // retry repeats a mutation that already committed.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-outcome-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const responseBody = JSON.stringify({ error: "Mutation outcome is indeterminate.", outcome: "indeterminate", retryable: false });
    const apiServer = createServer((_req, res) => {
      res.writeHead(504, {
        "content-type": "application/json",
        "x-paperclip-bridge-outcome": "indeterminate",
      });
      res.end(responseBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge outcome test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-outcome",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Status update." }),
      });

      // The sandbox server maps the indeterminate 504 to a non-retryable 409.
      expect(response.status).toBe(409);
      // The outcome header and body still reach the client, so a caller that
      // reads them still sees the indeterminate result.
      expect(response.headers.get("x-paperclip-bridge-outcome")).toBe("indeterminate");
      await expect(response.json()).resolves.toEqual({
        error: "Mutation outcome is indeterminate.",
        outcome: "indeterminate",
        retryable: false,
      });
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("forwards bridge traffic to the local listen origin even when public API URLs are configured", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-local-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge local-origin test API server to listen on a TCP port.");
    }

    // Simulate a deployment where a public base URL is configured: server boot
    // exports the public origin via PAPERCLIP_RUNTIME_API_URL / PAPERCLIP_API_URL
    // and the local listen host/port via PAPERCLIP_LISTEN_HOST / PAPERCLIP_LISTEN_PORT.
    // The wildcard listen host must map to the loopback address of the same
    // family (0.0.0.0 -> 127.0.0.1), where the test API server is bound.
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "0.0.0.0");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-local",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
    });
    try {
      expect(bridge).not.toBeNull();
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-local",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("lets an explicit hostApiUrl input override the bridge forward target", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-override-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: string[] = [];
    const apiServer = createServer((req, res) => {
      requests.push(req.url ?? "/");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge override test API server to listen on a TCP port.");
    }

    // Neither the public URL envs nor the listen host/port should matter when
    // the caller passes an explicit hostApiUrl.
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "203.0.113.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "9");

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-override",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      expect(requests).toEqual(["/api/agents/me"]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  // The full effective-capability snapshot with one flag set. The two strict
  // gates read `duplexCommandStream`; the other flags stay false.
  function duplexCapabilities(duplexCommandStream: boolean): EffectiveExecutionCapabilities {
    return {
      reusableLeases: false,
      nativeSyncIn: false,
      nativeSyncOut: false,
      persistentProcessSessions: false,
      independentControlCommands: false,
      incrementalSessionOutput: false,
      concurrentSyncOperations: false,
      duplexCommandStream,
    };
  }

  // The control surface a test uses to drive one fake duplex channel and read
  // what the broker wrote back through it.
  interface DuplexSelectionControl {
    openCount: number;
    writtenTypes: string[];
    stopCount: number;
    closeCount: number;
    emitData: (chunk: string) => void;
  }

  // The hook a test supplies to script the first frames the fake gateway sends
  // after the host binds the readiness gate. The default hook echoes a valid
  // READY frame with the launch nonce, so the happy path needs no hook.
  interface DuplexOpenContext {
    nonce: string;
    port: string;
    emitRaw: (text: string) => void;
    emitFrame: (frame: Record<string, unknown>) => void;
    emitExit: (exit: { exitCode: number | null }) => void;
  }

  // Build a runner that runs real shell commands for the asset upload and the
  // file bridge, and a fake `openDuplexChannel`. The fake parses the nonce and
  // the port out of the launch command, so the test proves the host passes both
  // only through the launch environment.
  function makeDuplexSelectionRunner(onOpen?: (ctx: DuplexOpenContext) => void): {
    runner: ReturnType<typeof createLocalSandboxRunner> & {
      openDuplexChannel: (openInput: { command: readonly string[] }) => Promise<CommandManagedDuplexChannel>;
    };
    control: DuplexSelectionControl;
  } {
    const base = createLocalSandboxRunner();
    const control: DuplexSelectionControl = {
      openCount: 0,
      writtenTypes: [],
      stopCount: 0,
      closeCount: 0,
      emitData: () => {},
    };
    const openDuplexChannel = async (openInput: {
      command: readonly string[];
    }): Promise<CommandManagedDuplexChannel> => {
      control.openCount += 1;
      const joined = openInput.command.join(" ");
      const nonce = /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(joined)?.[1] ?? "";
      const port = /PAPERCLIP_BRIDGE_PORT='([^']*)'/.exec(joined)?.[1] ?? "";
      let dataListener: ((chunk: Uint8Array) => void) | null = null;
      let exitListener: ((exit: { exitCode: number | null }) => void) | null = null;
      const channel: CommandManagedDuplexChannel = {
        write(data: Uint8Array): void {
          const decoded = decodeDuplexLine(Buffer.from(data).toString("utf8").replace(/\n$/, ""));
          if (decoded.ok) {
            control.writtenTypes.push(decoded.frame.type);
          }
        },
        onData(listener: (chunk: Uint8Array) => void): void {
          dataListener = listener;
          control.emitData = (chunk) => dataListener?.(new TextEncoder().encode(chunk));
          // Drive the readiness emission on the next tick, after the gate also
          // registers its exit listener.
          setImmediate(() => {
            const emitRaw = (text: string) => dataListener?.(new TextEncoder().encode(text));
            const emitFrame = (frame: Record<string, unknown>) =>
              dataListener?.(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
            const emitExit = (exit: { exitCode: number | null }) => exitListener?.(exit);
            if (onOpen) {
              onOpen({ nonce, port, emitRaw, emitFrame, emitExit });
            } else {
              emitFrame({ version: 2, type: "ready", nonce });
            }
          });
        },
        onExit(listener: (exit: { exitCode: number | null }) => void): void {
          exitListener = listener;
        },
        stop(): void {
          control.stopCount += 1;
        },
        close(): Promise<void> {
          control.closeCount += 1;
          return Promise.resolve();
        },
      };
      return channel;
    };
    return { runner: { ...base, openDuplexChannel }, control };
  }

  // The HTTP/2 client connection preface, 24 octets (RFC 9113, Section 3.4).
  // A test writes this literal to script a preface look-alike; it does not
  // import the production constant, so the test proves the real wire bytes
  // match, not only that the two source files agree on a name.
  const HTTP2_TEST_CLIENT_PREFACE = Buffer.from("505249202a20485454502f322e300d0a0d0a534d0d0a0d0a", "hex");

  interface Http2SelectionControl {
    openCount: number;
    stopCount: number;
    closeCount: number;
  }

  // The hook a test supplies to script the bytes a fake sandbox gateway sends
  // after the host binds the readiness gate, and to open a real HTTP/2 client
  // session on the same channel. The default hook sends one valid READY line,
  // then opens the client session and leaves it idle — the happy path needs
  // no hook.
  interface Http2OpenContext {
    nonce: string;
    port: string;
    /** The real per-run bridge token the host generated for this open. A
     * test attaches it as the `authorization` header on every real HTTP/2
     * request it dispatches, the same way the sandbox gateway does. */
    bridgeToken: string;
    /** Write raw bytes onto the channel, ahead of or instead of a READY line
     * or the client preface. */
    emitRaw: (bytes: Buffer | string) => void;
    /** Write one READY line. Echoes the launch nonce by default. */
    emitReady: (nonce?: string) => void;
    /** Open a real HTTP/2 client session on the channel and return it, the
     * same session type the generated sandbox gateway opens in production. */
    connectHttp2: () => http2.ClientHttp2Session;
    /** End the channel from the sandbox side, simulating a provider process exit. */
    emitExit: () => void;
  }

  // Build a runner whose fake `openDuplexChannel` returns one side of a real
  // paired in-memory `Duplex` (`node:stream`'s `duplexPair`). A test drives
  // the other side directly, including opening a real `http2.connect()`
  // client session on it, so the host's HTTP/2 server under test speaks one
  // real, wire-compatible HTTP/2 session — the same proof
  // `http2-bridge-server.test.ts` uses for the server and the gateway in
  // isolation, exercised here through the full transport-selection path.
  function makeHttp2SelectionRunner(onOpen?: (ctx: Http2OpenContext) => void): {
    runner: ReturnType<typeof createLocalSandboxRunner> & {
      openDuplexChannel: (openInput: { command: readonly string[] }) => Promise<CommandManagedDuplexChannel>;
    };
    control: Http2SelectionControl;
  } {
    const base = createLocalSandboxRunner();
    const control: Http2SelectionControl = { openCount: 0, stopCount: 0, closeCount: 0 };
    const openDuplexChannel = async (openInput: {
      command: readonly string[];
    }): Promise<CommandManagedDuplexChannel> => {
      control.openCount += 1;
      const joined = openInput.command.join(" ");
      const nonce = /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(joined)?.[1] ?? "";
      const port = /PAPERCLIP_BRIDGE_PORT='([^']*)'/.exec(joined)?.[1] ?? "";
      const bridgeToken = /PAPERCLIP_BRIDGE_TOKEN='([^']*)'/.exec(joined)?.[1] ?? "";
      const [hostSide, sandboxSide] = duplexPair();
      const dataListeners: Array<(chunk: Uint8Array) => void> = [];
      const exitListeners: Array<(exit: { exitCode: number | null }) => void> = [];
      hostSide.on("data", (chunk: Buffer) => {
        for (const listener of dataListeners) listener(chunk);
      });
      hostSide.on("end", () => {
        for (const listener of exitListeners) listener({ exitCode: 0 });
      });
      const channel: CommandManagedDuplexChannel = {
        write: (data: Uint8Array) => {
          hostSide.write(Buffer.from(data));
        },
        onData: (listener: (chunk: Uint8Array) => void) => {
          dataListeners.push(listener);
        },
        onExit: (listener: (exit: { exitCode: number | null }) => void) => {
          exitListeners.push(listener);
        },
        stop: () => {
          control.stopCount += 1;
          hostSide.destroy();
        },
        close: async () => {
          control.closeCount += 1;
          hostSide.end();
        },
      };
      setImmediate(() => {
        const ctx: Http2OpenContext = {
          nonce,
          port,
          bridgeToken,
          emitRaw: (bytes) => sandboxSide.write(typeof bytes === "string" ? Buffer.from(bytes) : bytes),
          emitReady: (readyNonce = nonce) =>
            sandboxSide.write(
              encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "ready", nonce: readyNonce }),
            ),
          connectHttp2: () => http2.connect("http://bridge.internal", { createConnection: () => sandboxSide }),
          emitExit: () => sandboxSide.end(),
        };
        if (onOpen) {
          onOpen(ctx);
        } else {
          ctx.emitReady();
          ctx.connectHttp2();
        }
      });
      return channel;
    };
    return { runner: { ...base, openDuplexChannel }, control };
  }

  /**
   * Forward one request over a real HTTP/2 client session and resolve with
   * the response the host sends back. Mirrors the shape of the sandbox
   * gateway's own request forward, so a test drives the transport exactly
   * like production does.
   */
  function http2TestRequest(
    session: http2.ClientHttp2Session,
    request: { method: string; path: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(request.body ?? "", "utf8");
      const stream = session.request(
        { ":method": request.method, ":path": request.path, ...request.headers },
        { endStream: body.length === 0 },
      );
      const chunks: Buffer[] = [];
      let status = 502;
      let headers: Record<string, string> = {};
      stream.on("response", (h) => {
        status = Number(h[":status"]) || 502;
        headers = {};
        for (const [key, value] of Object.entries(h)) {
          if (key.startsWith(":") || value == null) continue;
          headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") }));
      stream.once("error", (error) => reject(error));
      if (body.length > 0) stream.end(body);
      else if (!stream.writableEnded) stream.end();
    });
  }

  // Start a host API server that records each forwarded request, so a test can
  // assert the real token and the run id reach the host, or that a rejected
  // request never forwards.
  async function startRecordingApiServer(): Promise<{
    origin: string;
    requests: Array<{
      method: string;
      url: string;
      auth: string | null;
      runId: string | null;
      headers: Record<string, string>;
    }>;
    close: () => Promise<void>;
  }> {
    const requests: Array<{
      method: string;
      url: string;
      auth: string | null;
      runId: string | null;
      headers: Record<string, string>;
    }> = [];
    const server = createServer((req, res) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
        headers,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the recording API server to listen on a TCP port.");
    }
    return {
      origin: `http://127.0.0.1:${address.port}`,
      requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("test_startup_failure_falls_back_to_queue_v1", async () => {
    // The channel open itself fails (a provider startup fault, before any
    // READY line or preface is possible). The host must fall back to the
    // file bridge and record the typed open-failure reason, never hang.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-startup-fail-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const base = createLocalSandboxRunner();
    let openCount = 0;
    const openDuplexChannel = async (): Promise<CommandManagedDuplexChannel> => {
      openCount += 1;
      throw new Error("provider could not start the sandbox process");
    };
    const runner = { ...base, openDuplexChannel };
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-startup-fail",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(openCount).toBe(1);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("channel_open_failed");
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_daytona_selects_http2_v1", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-select-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-http2",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      // The host builds the origin from the port it assigned, never from a frame.
      expect(bridge?.env.PAPERCLIP_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bridge?.env.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");

      // The sandbox gateway forwards one agent request as one real HTTP/2
      // stream, over the one session that runs directly on the sandbox
      // channel. The host serves it with the real token and the run id.
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-http2",
      });
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
    // Teardown closed the channel before lease release, then stopped the child.
    expect(control.closeCount).toBeGreaterThanOrEqual(1);
    expect(control.stopCount).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("streams run logs on the http2 path under the same gate and log line as the file path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-runlog-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner } = makeHttp2SelectionRunner();
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      streamRunLogs: true,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-duplex-log",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    try {
      // The http2 transport served, and it still streams run logs with the same
      // gate and the same log line as the file path.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      expect(bridge?.runLogTail).toBeTruthy();
      expect(combinedStream(logs, "stdout")).toContain("Sandbox run log streaming enabled");
      const wrapped = bridge!.runLogTail!.create().wrapCommand("agent-cli", ["--message", "hello world"]);
      expect(wrapped.args.join("\n")).toContain("tee -a");
      expect(wrapped.args.join("\n")).toContain("agent-cli");
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("returns no run-log tail on the http2 path when streaming is opted out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-runlog-off-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner } = makeHttp2SelectionRunner();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      streamRunLogs: false,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-http2-log-off",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      expect(bridge?.runLogTail ?? null).toBeNull();
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("routes http2 channel-open and fallback records to a recorder attached on the server seam", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-recorder-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();

    const counters: DuplexObservabilityCounterRecord[] = [];
    const recorder: DuplexObservabilityRecorder = {
      recordSpan() {},
      incrementCounter(record) {
        counters.push(record);
      },
      emitEvent() {},
    };

    // A channel open reaches the recorder on the http2 success path. The host
    // attaches the recorder to the sandbox target on the same seam as the
    // runner; the caller reads it with the accessor and passes it to the bridge.
    const openTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner: makeHttp2SelectionRunner().runner,
      effectiveCapabilities: duplexCapabilities(true),
      duplexObservabilityRecorder: recorder,
    };
    const openBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-http2-open",
      target: openTarget,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(openTarget),
    });
    try {
      expect(openBridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      const open = counters.find((record) => record.metric === DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL);
      expect(open?.dimensions.transport).toBe("http2");
      expect(open?.dimensions.provider).toBe("daytona");
    } finally {
      await openBridge?.stop();
    }

    // A fallback reaches the same recorder. The kill switch off records a
    // gate_off fallback with the file transport.
    counters.length = 0;
    const fallbackTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner: makeDuplexSelectionRunner().runner,
      effectiveCapabilities: duplexCapabilities(true),
      duplexObservabilityRecorder: recorder,
    };
    const fallbackBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-duplex-fallback",
      target: fallbackTarget,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: false,
      duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(fallbackTarget),
    });
    try {
      expect(fallbackBridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((record) => record.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("gate_off");
      expect(fallback?.dimensions.transport).toBe("file");
    } finally {
      await fallbackBridge?.stop();
      await api.close();
    }
  }, 20000);

  it.each([
    { name: "the kill switch is off with the capability granted", enable: false, capability: true },
    { name: "the capability is absent with the kill switch on", enable: true, capability: false },
  ])("selects the file bridge when $name", async ({ enable, capability }) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-gate-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner, control } = makeDuplexSelectionRunner();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(capability),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-gate",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: enable,
    });
    try {
      expect(bridge).not.toBeNull();
      // Neither gate combination opened a duplex channel; the file bridge serves.
      expect(control.openCount).toBe(0);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it.each([
    {
      name: "a mismatched nonce",
      onOpen: (ctx: DuplexOpenContext) =>
        ctx.emitFrame({ version: 2, type: "ready", nonce: "00000000000000000000000000000000" }),
    },
    {
      name: "an incomplete READY frame",
      onOpen: (ctx: DuplexOpenContext) => ctx.emitRaw('{"version":2,"type":"ready"}\n'),
    },
    {
      name: "protocol contamination before READY",
      onOpen: (ctx: DuplexOpenContext) => ctx.emitFrame({ version: 2, type: "heartbeat" }),
    },
    {
      name: "a gateway bind failure with no READY frame",
      onOpen: (ctx: DuplexOpenContext) => ctx.emitExit({ exitCode: 1 }),
    },
    {
      name: "a readiness timeout with no frame at all",
      onOpen: () => {},
    },
  ])("fails closed to the file bridge on $name and leaves no live session", async ({ onOpen }) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-fail-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner, control } = makeDuplexSelectionRunner(onOpen);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-fail",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 400,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // Fail closed: the file bridge serves after the bounded cleanup.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      // The bounded cleanup left no live provider session.
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it.each([
    {
      name: "an attacker-owned numeric local port",
      buildReady: (nonce: string, attackerPort: number) =>
        `{"version":2,"type":"ready","nonce":"${nonce}","port":${attackerPort}}\n`,
    },
    {
      name: "a channel-supplied host URL",
      buildReady: (nonce: string, attackerPort: number) =>
        `{"version":2,"type":"ready","nonce":"${nonce}","address":"http://127.0.0.1:${attackerPort}"}\n`,
    },
  ])(
    "rejects a READY frame that carries $name and never sends the bridge token there",
    async ({ buildReady }) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-addr-"));
      cleanupDirs.push(rootDir);
      const remoteCwd = path.join(rootDir, "workspace");
      await mkdir(remoteCwd, { recursive: true });

      // An endpoint an attacker controls. No request that carries the bridge
      // token may reach it, because the host never derives the endpoint from a
      // channel frame.
      const attackerHits: string[] = [];
      const attacker = createServer((req, res) => {
        attackerHits.push(req.headers.authorization ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve, reject) => {
        attacker.once("error", reject);
        attacker.listen(0, "127.0.0.1", () => resolve());
      });
      const attackerAddress = attacker.address();
      if (!attackerAddress || typeof attackerAddress === "string") {
        throw new Error("Expected the attacker server to listen on a TCP port.");
      }
      const attackerPort = attackerAddress.port;

      const api = await startRecordingApiServer();
      const { runner, control } = makeDuplexSelectionRunner((ctx) =>
        ctx.emitRaw(buildReady(ctx.nonce, attackerPort)),
      );
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "e2b",
        remoteCwd,
        timeoutMs: 30_000,
        runner,
        effectiveCapabilities: duplexCapabilities(true),
      };

      const bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: "run-addr",
        target,
        runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
        adapterKey: "codex",
        hostApiToken: "real-run-jwt",
        hostApiUrl: api.origin,
        enableSandboxDuplexBridge: true,
        duplexReadinessTimeoutMs: 400,
      });
      try {
        expect(bridge).not.toBeNull();
        // The address-bearing READY frame failed the strict schema, so the host
        // fell closed to the file bridge and built no channel-supplied endpoint.
        expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
        expect(bridge?.env.PAPERCLIP_API_URL).not.toContain(String(attackerPort));
        expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
        // Give any stray forward a moment, then assert the attacker got nothing.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(attackerHits).toEqual([]);
      } finally {
        await bridge?.stop();
        await api.close();
        await new Promise<void>((resolve) => attacker.close(() => resolve()));
      }
    },
    20000,
  );

  it("test_route_allowlist_header_cleanup_and_token_replacement_hold_on_http2", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-403-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-http2-403",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);

      // An unlisted route answers 403 over the real HTTP/2 stream and never
      // reaches the host API — the route allowlist holds on the http2 path.
      const forbidden = await http2TestRequest(sessionRef.current!, {
        method: "POST",
        path: "/api/secret-admin-route",
        headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ escalate: true }),
      });
      expect(forbidden.status).toBe(403);
      expect(api.requests).toHaveLength(0);

      // An allowed route forwards with the real host token and the run id —
      // the token replacement and the run-id injection hold on the http2 path.
      // A header outside the allowlist (`x-not-allowed`) never reaches the host.
      const allowed = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}`, "x-not-allowed": "should-be-dropped" },
      });
      expect(allowed.status).toBe(200);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-http2-403",
      });
      expect(api.requests[0].headers["x-not-allowed"]).toBeUndefined();
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  // One recording telemetry recorder. It captures every span, counter, and event
  // the fixed duplex surface produces, so a test asserts the exact names,
  // dimensions, and values. An optional `failEvery` flag makes every method throw,
  // so a test proves a telemetry failure never breaks the request path.
  function createRecordingDuplexRecorder(options: { failEvery?: boolean } = {}): {
    recorder: DuplexObservabilityRecorder;
    spans: DuplexObservabilitySpanRecord[];
    counters: DuplexObservabilityCounterRecord[];
    events: DuplexObservabilityEventRecord[];
  } {
    const spans: DuplexObservabilitySpanRecord[] = [];
    const counters: DuplexObservabilityCounterRecord[] = [];
    const events: DuplexObservabilityEventRecord[] = [];
    const recorder: DuplexObservabilityRecorder = {
      recordSpan(record) {
        if (options.failEvery) throw new Error("telemetry sink down");
        spans.push(record);
      },
      incrementCounter(record) {
        if (options.failEvery) throw new Error("telemetry sink down");
        counters.push(record);
      },
      emitEvent(record) {
        if (options.failEvery) throw new Error("telemetry sink down");
        events.push(record);
      },
    };
    return { recorder, spans, counters, events };
  }

  // Every dimension key a record carries must be one of the fixed keys. The set is
  // closed, so a new key never reaches a sink by accident.
  function assertOnlyFixedDimensionKeys(dimensions: DuplexObservabilityDimensions | undefined): void {
    expect(dimensions).toBeDefined();
    for (const key of Object.keys(dimensions ?? {})) {
      expect(DUPLEX_DIMENSION_KEYS).toContain(key as (typeof DUPLEX_DIMENSION_KEYS)[number]);
    }
  }

  it("pins the exact fixed duplex dimension-key set", () => {
    // The dimension-key set is closed. This test locks the exact contract, so a
    // new key never reaches a sink without an explicit change here.
    expect([...DUPLEX_DIMENSION_KEYS]).toEqual([
      "provider",
      "transport",
      "outcome",
      "fallback_reason",
      "loss_class",
      "loss_reason",
    ]);
  });

  it("records an http2 request span with latency and the fixed dimension keys", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-obs-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const { recorder, spans, counters, events } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-obs",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);

      // The channel-open surface: the span, the counter, and the transport event.
      const openSpan = spans.find((span) => span.name === DUPLEX_SPAN_CHANNEL_OPEN);
      expect(openSpan).toBeDefined();
      expect(openSpan?.dimensions).toMatchObject({ provider: "daytona", transport: "http2", outcome: "ok" });
      expect(counters.some((c) => c.metric === DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL)).toBe(true);
      expect(
        events.some(
          (e) =>
            e.name === DUPLEX_TRANSPORT_EVENT &&
            e.dimensions.transport === "http2" &&
            e.dimensions.outcome === "ok",
        ),
      ).toBe(true);

      // The request span carries a numeric latency and only the fixed keys.
      const requestSpan = spans.find((span) => span.name === DUPLEX_SPAN_REQUEST);
      expect(requestSpan).toBeDefined();
      expect(typeof requestSpan?.latencyMs).toBe("number");
      expect(requestSpan?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(requestSpan?.dimensions).toMatchObject({ provider: "daytona", transport: "http2", outcome: "ok" });
      assertOnlyFixedDimensionKeys(requestSpan?.dimensions);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("increments the fallback counter with an approved reason when the capability is absent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-fb-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner } = makeDuplexSelectionRunner();
    const { recorder, counters, events } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(false),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-fb",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback).toBeDefined();
      const approvedReasons = [
        "gate_off",
        "capability_absent",
        "route_busy",
        "entrypoint_sync_failed",
        "broker_construction_failed",
        "channel_open_failed",
        "ready_invalid",
        "ready_nonce_mismatch",
        "ready_timeout",
        "contaminated",
      ];
      expect(approvedReasons).toContain(fallback?.dimensions.fallback_reason);
      expect(fallback?.dimensions).toMatchObject({ transport: "file", outcome: "error" });
      assertOnlyFixedDimensionKeys(fallback?.dimensions);
      // The transport event mirrors the fallback.
      expect(
        events.some(
          (e) => e.name === DUPLEX_TRANSPORT_EVENT && e.dimensions.transport === "file",
        ),
      ).toBe(true);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it.each([
    {
      name: "a full process-scoped route ceiling",
      error: new Error("worker route rejected: DUPLEX_CHANNEL_ROUTE_BUSY"),
      expectedReason: "route_busy",
    },
    {
      name: "a generic channel-open failure",
      error: new Error("provider channel open failed"),
      expectedReason: "channel_open_failed",
    },
  ])(
    "names the open-failure stage $expectedReason and falls back to the file bridge on $name",
    async ({ error, expectedReason }) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-stage-"));
      cleanupDirs.push(rootDir);
      const remoteCwd = path.join(rootDir, "workspace");
      await mkdir(remoteCwd, { recursive: true });
      const api = await startRecordingApiServer();
      // A runner whose duplex open rejects. The host binds the caught error and
      // names the exact open-failure stage.
      const base = createLocalSandboxRunner();
      const openDuplexChannel = async (): Promise<CommandManagedDuplexChannel> => {
        throw error;
      };
      const runner = { ...base, openDuplexChannel };
      const { recorder, spans, counters, events } = createRecordingDuplexRecorder();
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "daytona",
        remoteCwd,
        timeoutMs: 30_000,
        runner,
        effectiveCapabilities: duplexCapabilities(true),
      };

      const bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: "run-stage",
        target,
        runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
        adapterKey: "codex",
        hostApiToken: "real-run-jwt",
        hostApiUrl: api.origin,
        enableSandboxDuplexBridge: true,
        duplexObservabilityRecorder: recorder,
      });
      try {
        // The channel never opened, so the host serves the file bridge.
        expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
        // The channel-open span and the fallback counter name the exact stage.
        const openSpan = spans.find(
          (s) => s.name === DUPLEX_SPAN_CHANNEL_OPEN && s.dimensions.outcome === "error",
        );
        expect(openSpan?.dimensions.fallback_reason).toBe(expectedReason);
        const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
        expect(fallback?.dimensions.fallback_reason).toBe(expectedReason);
        assertOnlyFixedDimensionKeys(fallback?.dimensions);
        expect(
          events.some(
            (e) => e.name === DUPLEX_TRANSPORT_EVENT && e.dimensions.transport === "file",
          ),
        ).toBe(true);
      } finally {
        await bridge?.stop();
        await api.close();
      }
    },
    20000,
  );

  it.each([
    { name: "before any dispatch", dispatchFirst: false, expectedClass: "pre_dispatch" },
    { name: "after a dispatch", dispatchFirst: true, expectedClass: "post_dispatch" },
  ])("increments the loss counter with the loss class $name", async ({ dispatchFirst, expectedClass }) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-loss-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    let emitExit: (() => void) | null = null;
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      emitExit = ctx.emitExit;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-loss",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      if (dispatchFirst) {
        const response = await http2TestRequest(sessionRef.current!, {
          method: "GET",
          path: "/api/agents/me",
          headers: { authorization: `Bearer ${bridgeToken}` },
        });
        expect(response.status).toBe(200);
      }
      // The pseudo-terminal channel exits. The host records a terminal loss.
      emitExit!();
      await waitForCondition(
        () => counters.some((c) => c.metric === DUPLEX_COUNTER_LOSS_TOTAL),
        "the host to record a loss counter",
        4000,
      );
      const loss = counters.find((c) => c.metric === DUPLEX_COUNTER_LOSS_TOTAL);
      expect(loss?.dimensions.loss_class).toBe(expectedClass);
      expect(loss?.dimensions).toMatchObject({ transport: "http2", outcome: "error", loss_reason: "provider_exit" });
      assertOnlyFixedDimensionKeys(loss?.dimensions);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("keeps serving the request path when the telemetry recorder throws", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-guard-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const { recorder } = createRecordingDuplexRecorder({ failEvery: true });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-guard",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      // The throwing recorder never blocked the http2 selection.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      // The request path still delivered a real host response.
      expect(response.status).toBe(200);
      expect(api.requests).toHaveLength(1);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("keeps sentinel route, query, body, and tokens off the http2 telemetry and logs", async () => {
    // `recordHttp2Loss` (execution-target.ts) never accepts a raw error
    // message: it maps every host-observed HTTP/2 event to one fixed, closed
    // `DuplexLossReason` value before any sink reads it (accepted security
    // fix 7, `duplex-observability.test.ts` pins the closed map). A raw provider
    // error string has no code path into a sink on the http2_v1 transport, so
    // this test proves the property that does need a live run: the route,
    // the query, the body, and both tokens never ride a sink either.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-redact-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();

    const ROUTE_SENTINEL = "sentinelroute8f21";
    const QUERY_SENTINEL = "sentinelquery3d90";
    const BODY_SENTINEL = "sentinelbodya17c";
    const AGENT_TOKEN_SENTINEL = "sentinelagenttoke91b4";
    const sentinels = [ROUTE_SENTINEL, QUERY_SENTINEL, BODY_SENTINEL, AGENT_TOKEN_SENTINEL];

    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });

    const logLines: string[] = [];
    const { recorder, spans, counters, events } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const previousDebug = process.env.PAPERCLIP_BRIDGE_DEBUG;
    process.env.PAPERCLIP_BRIDGE_DEBUG = "1";
    let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
    try {
      bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: "run-redact",
        target,
        runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
        adapterKey: "codex",
        hostApiToken: AGENT_TOKEN_SENTINEL,
        hostApiUrl: api.origin,
        enableSandboxDuplexBridge: true,
        duplexObservabilityRecorder: recorder,
        onLog: async (_stream, chunk) => {
          logLines.push(chunk);
        },
      });
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);

      // Dispatch one real HTTP/2 stream that carries the sentinel route,
      // query, and body. The route allowlist accepts an arbitrary issue id
      // segment, so the sentinel rides an allowed route. The real agent
      // token (also a sentinel) never leaves the host.
      const response = await http2TestRequest(sessionRef.current!, {
        method: "POST",
        path: `/api/issues/${ROUTE_SENTINEL}/comments?secret=${QUERY_SENTINEL}`,
        headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ body: BODY_SENTINEL }),
      });
      expect(response.status).toBe(200);
      await waitForCondition(
        () => spans.some((s) => s.name === DUPLEX_SPAN_REQUEST),
        "the host to record a request span",
        4000,
      );

      // Serialize every telemetry record and every log line, then assert that no
      // sentinel reaches any of them on the http2 path.
      const telemetryDump = JSON.stringify({ spans, counters, events });
      const logDump = logLines.join("");
      for (const sentinel of sentinels) {
        expect(telemetryDump).not.toContain(sentinel);
        expect(logDump).not.toContain(sentinel);
      }
      // The real agent token replaced the bridge token on the forward; the
      // recording API server saw only the real token, never the bridge token.
      expect(api.requests[0]?.auth).toBe(`Bearer ${AGENT_TOKEN_SENTINEL}`);
    } finally {
      if (previousDebug === undefined) delete process.env.PAPERCLIP_BRIDGE_DEBUG;
      else process.env.PAPERCLIP_BRIDGE_DEBUG = previousDebug;
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("maps a sentinel provider key to the constant other across every sink", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-prov-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const { recorder, spans, counters, events } = createRecordingDuplexRecorder();
    const PROVIDER_SENTINEL = "sentinel-plugin-provider-key-9c2a";
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: PROVIDER_SENTINEL,
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-prov",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);
      await waitForCondition(
        () => spans.some((s) => s.name === DUPLEX_SPAN_REQUEST),
        "the host to record a request span",
        4000,
      );

      // Every recorded provider dimension is the constant `other`, never the key.
      const allDimensions = [
        ...spans.map((s) => s.dimensions),
        ...counters.map((c) => c.dimensions),
        ...events.map((e) => e.dimensions),
      ];
      expect(allDimensions.length).toBeGreaterThan(0);
      for (const dimensions of allDimensions) {
        expect(dimensions.provider).toBe("other");
      }
      // The raw key reaches no sink.
      const telemetryDump = JSON.stringify({ spans, counters, events });
      expect(telemetryDump).not.toContain(PROVIDER_SENTINEL);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("caps the pre-READY readiness buffer and falls back with a contaminated reason", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-cap-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // The fake gateway sends a large pre-READY blob with no newline, then one
    // more blob after the gate settles. The gate must cap the buffer, finish with
    // protocol contamination, and drop the later blob. The blob is larger than
    // the codec frame-size bound, so it passes the readiness buffer cap.
    const oversizedBlob = "x".repeat(DEFAULT_MAX_DUPLEX_FRAME_BYTES * 2);
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      ctx.emitRaw(oversizedBlob);
      ctx.emitRaw(oversizedBlob);
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-cap",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      // A long readiness timeout, so the buffer cap, not the timeout, drives the
      // failure.
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The cap drove the failure, so the file bridge serves after the bounded cleanup.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("contaminated");
      // The bounded cleanup left no live provider session.
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("caps the pre-READY buffer under many small newline-less chunks", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-cap-small-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // An adversarial provider controls the chunk size. It sends many small
    // newline-less chunks that together pass the cap. The gate must scan each
    // chunk in O(1) of the buffer length, so the pre-READY window stays bounded.
    // The gate caps the buffer, finishes with protocol contamination, and falls
    // back to the file bridge.
    const readinessBufferCapBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;
    const smallChunk = "x".repeat(64);
    const chunkCount = Math.ceil(readinessBufferCapBytes / smallChunk.length) + 1;
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      for (let i = 0; i < chunkCount; i += 1) {
        ctx.emitRaw(smallChunk);
      }
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-cap-small",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      // A long readiness timeout, so the buffer cap, not the timeout, drives the
      // failure.
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The cap drove the failure, so the file bridge serves after the bounded cleanup.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("contaminated");
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("bounds the pre-READY newline-scan work by the bytes received", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-scan-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // An adversarial provider sends many small newline-less chunks before the
    // cap fires. Each chunk must scan only the new bytes, not the whole buffer,
    // so the total newline-scan work stays linear in the bytes received. A
    // per-chunk full rescan makes the work quadratic.
    const readinessBufferCapBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;
    const smallChunk = "x".repeat(64);
    const chunkCount = Math.ceil(readinessBufferCapBytes / smallChunk.length) + 1;
    const totalBytes = chunkCount * smallChunk.length;
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      for (let i = 0; i < chunkCount; i += 1) {
        ctx.emitRaw(smallChunk);
      }
    });
    const { recorder } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    __duplexReadinessTesting.resetNewlineScanUnits();
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-scan-bound",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      const scanUnits = __duplexReadinessTesting.readNewlineScanUnits();
      // Linear scan work reads each byte one time, so the count stays near
      // totalBytes. A per-chunk full rescan is quadratic (about
      // totalBytes^2 / (2 * chunkSize)), far above this bound.
      expect(scanUnits).toBeLessThanOrEqual(4 * totalBytes);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("bounds the pre-READY buffer growth-copy work by the bytes received", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-growth-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // An adversarial provider sends many small newline-less fragments before the
    // cap fires. A one-copy-per-fragment append copies the whole retained buffer
    // on every fragment, so the total copy work is quadratic in the number of
    // fragments. The gate must instead grow its backing storage by doubling, so
    // the total copy work stays linear in the bytes received.
    const readinessBufferCapBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;
    const smallChunk = "x".repeat(64);
    const chunkCount = Math.ceil(readinessBufferCapBytes / smallChunk.length) + 1;
    const totalBytes = chunkCount * smallChunk.length;
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      for (let i = 0; i < chunkCount; i += 1) {
        ctx.emitRaw(smallChunk);
      }
    });
    const { recorder } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    __duplexReadinessTesting.resetBufferGrowthCopyUnits();
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-growth-bound",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      const copyUnits = __duplexReadinessTesting.readBufferGrowthCopyUnits();
      // Doubling growth copies a logarithmic number of times, each at most the
      // current buffer length, so the total stays within a small multiple of
      // totalBytes. A per-fragment full-buffer copy is quadratic (about
      // totalBytes^2 / (2 * chunkSize)), far above this bound.
      expect(copyUnits).toBeLessThanOrEqual(4 * totalBytes);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("bounds the pre-READY skip scan work by the bytes received", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-blank-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // An adversarial provider sends one pre-READY chunk of many blank lines and a
    // noise line, then a valid READY frame. The gate must skip each blank line and
    // the noise line in O(1), so the total newline-scan work stays linear in the
    // bytes received. A per-line full rescan or a per-line buffer copy makes the
    // work quadratic. The READY frame then settles the gate ready.
    const blankLineCount = 15_000;
    const noisePrefix = "\n".repeat(blankLineCount) + "a non-frame echo line\n";
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      ctx.emitRaw(noisePrefix);
      ctx.emitReady();
      ctx.connectHttp2();
    });
    const readyLine = '{"version":2,"type":"ready","nonce":"<nonce>"}\n';
    const totalBytes = noisePrefix.length + readyLine.length;
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    __duplexReadinessTesting.resetNewlineScanUnits();
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-blank-scan",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      const scanUnits = __duplexReadinessTesting.readNewlineScanUnits();
      // Incremental skip handling reads each byte one time, so the count stays
      // near totalBytes. A per-line full rescan is quadratic (about
      // blankLineCount^2 / 2), far above this bound.
      expect(scanUnits).toBeLessThanOrEqual(4 * totalBytes);
      // The gate skipped the noise and accepted the READY frame, so the http2
      // transport serves and no fallback fired.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback).toBeUndefined();
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_a_prologue_of_any_length_before_the_ready_line_is_discarded", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-noise-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // A PTY channel echoes the launch wrapper line before it sets raw mode, so the
    // first line the host reads is a non-frame echo, not the READY frame. The gate
    // must skip the echo line and a partial-JSON line, then accept the READY
    // frame — no matter how long the prologue is, and with no length held anywhere
    // in the code. The preface scan then starts only on the bytes the gate
    // retained after that accepted line.
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      ctx.emitRaw("sh -c exec env PAPERCLIP_BRIDGE_NONCE=... node gateway.mjs\n");
      ctx.emitRaw('{"version":2,"type":"ready"}\n');
      ctx.emitRaw("x".repeat(50_000)); // an arbitrarily long prologue, no fixed length
      ctx.emitReady();
      ctx.connectHttp2();
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-noise-ready",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The gate skipped the echo, the partial frame, and the long prologue,
      // then accepted the READY frame, so the http2 transport serves and no
      // fallback fired.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback).toBeUndefined();
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("settles a wrong-nonce READY frame as a nonce mismatch, even after a noise line", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-noise-nonce-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // The gate skips the echo line, then reads a READY frame that decodes cleanly
    // but carries a wrong nonce. A wrong-nonce READY authenticates as a failure,
    // not as noise, so the gate settles the handshake failed and falls back with
    // the `ready_nonce_mismatch` reason.
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      ctx.emitRaw("a non-frame echo line\n");
      ctx.emitFrame({ version: 2, type: "ready", nonce: "00000000000000000000000000000000" });
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-noise-nonce",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The wrong nonce failed the handshake, so the file bridge serves.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("ready_nonce_mismatch");
      // The bounded cleanup left no live provider session.
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("enforces the buffer cap on an over-cap blank prefix before it accepts a valid READY frame", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-capbypass-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // The cap must bound every pre-READY path, including a skipped blank line. An
    // adversarial provider sends one chunk: an over-cap blank prefix followed by a
    // valid nonce-bound READY frame. The gate must reject on the cap before READY
    // acceptance, so it falls back to the file bridge with the contaminated reason
    // and the bounded cleanup. Without the per-skip cap check the blank prefix
    // reaches the valid READY line in the same chunk, and the duplex transport
    // opens, which is the cap bypass. A single chunk keeps the trailing READY
    // newline in the buffer, so the no-newline cap check never fires here; only the
    // per-skip cap check stops the bypass.
    const readinessBufferCapBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;
    const { runner, control } = makeDuplexSelectionRunner((ctx) => {
      const readyLine = `${JSON.stringify({ version: 2, type: "ready", nonce: ctx.nonce })}\n`;
      ctx.emitRaw("\n".repeat(readinessBufferCapBytes + 1) + readyLine);
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-cap-bypass",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      // A long readiness timeout, so the cap, not the timeout, drives the failure.
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The cap drove the failure before READY acceptance, so the file bridge serves.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("contaminated");
      // The bounded cleanup left no live provider session.
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("records the channel-open span with the fallback_reason dimension on the fallback path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-openspan-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // A wrong-nonce READY frame fails the handshake, so the gate falls back. The
    // channel-open span records the failed attempt on the duplex transport and now
    // carries the closed `fallback_reason` dimension, so a reader can group the
    // failed opens by reason.
    const { runner } = makeDuplexSelectionRunner((ctx) =>
      ctx.emitFrame({ version: 2, type: "ready", nonce: "00000000000000000000000000000000" }),
    );
    const { recorder, spans } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-open-span",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 5_000,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const openSpan = spans.find((span) => span.name === DUPLEX_SPAN_CHANNEL_OPEN);
      expect(openSpan).toBeDefined();
      expect(openSpan?.dimensions).toMatchObject({
        provider: "daytona",
        transport: "http2",
        outcome: "error",
        fallback_reason: "ready_nonce_mismatch",
      });
      // The span carries only closed dimension keys.
      assertOnlyFixedDimensionKeys(openSpan?.dimensions);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("drops a header outside the allowlist on the host http2 forward path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-hdr-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-hdr",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: {
          authorization: `Bearer ${bridgeToken}`,
          // An allowlisted header the host must keep.
          accept: "application/json",
          // A header outside the allowlist the host must drop.
          "x-injected-header": "attacker",
        },
      });
      expect(response.status).toBe(200);
      await waitForCondition(() => api.requests.length >= 1, "the host to forward the http2 request", 4000);
      const forwarded = api.requests[0];
      // The allowlisted header reaches the host.
      expect(forwarded.headers.accept).toBe("application/json");
      // The header outside the allowlist never reaches the authenticated fetch.
      expect(forwarded.headers["x-injected-header"]).toBeUndefined();
      // The host applied the real token and the run id in place of the frame values.
      expect(forwarded.auth).toBe("Bearer real-run-jwt");
      expect(forwarded.runId).toBe("run-hdr");
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("selects the http2 transport for a large forward budget", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-budget-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    // A forward budget past the default response budget (32 s). The http2 path
    // holds no nested-budget derivation (that budget set belonged to the retired
    // duplex_v1 broker only), so a large forward budget must still select and
    // serve normally.
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-budget",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      forwardTimeoutMs: 60_000,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_a_missing_preface_aborts_the_open_and_falls_back_to_queue_v1", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-no-preface-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    // The gateway sends a valid READY line, but no HTTP/2 client preface ever
    // follows (a suppressed or a stalled sandbox client). Readiness passes,
    // then the bounded preface scan finds nothing before its bound; the host
    // must abort the open and select the file bridge instead of hanging or
    // leaking the channel.
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      ctx.emitReady();
      // No connectHttp2() call: the client preface never arrives.
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-no-preface",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      // A short readiness timeout, so the preface-missing bound (which reapplies
      // this same value) fires quickly in the test.
      duplexReadinessTimeoutMs: 500,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      // The missing preface aborted the open; the file bridge serves.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("preface_missing");
      // The bounded cleanup left no live provider session.
      expect(control.closeCount + control.stopCount).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_disabled_flag_selects_queue_v1", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-disabled-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner, control } = makeHttp2SelectionRunner();
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    // The kill switch is off. The host must never open the channel at all.
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-disabled",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: false,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(0);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      const fallback = counters.find((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallback?.dimensions.fallback_reason).toBe("gate_off");
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_fallback_to_queue_v1_happens_at_most_once_per_run", async () => {
    // The open attempt runs once per run, with no retry loop: a preface
    // failure falls through to the file bridge exactly one time, and the
    // host never re-attempts http2_v1 afterward in the same run.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-one-way-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      ctx.emitReady();
      // No connectHttp2() call: the preface never arrives, so the open fails.
    });
    const { recorder, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-one-way",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 500,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge).not.toBeNull();
      // The host opened the channel exactly once for the whole run — no retry
      // loop re-attempted http2_v1 after the fallback.
      expect(control.openCount).toBe(1);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      // Exactly one fallback record — the transition never repeats.
      const fallbacks = counters.filter((c) => c.metric === DUPLEX_COUNTER_FALLBACK_TOTAL);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.dimensions.fallback_reason).toBe("preface_missing");
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_the_host_writes_no_byte_before_the_ready_line_is_accepted", async () => {
    // The launch wrapper gives the gateway no start acknowledgment (accepted
    // fact from PAP-5065): a host byte written before the READY line is
    // accepted can reach the shell instead of the child. This test proves
    // the host writes nothing to the channel until well after it accepted
    // READY: it holds the channel open, with no client preface arriving
    // (so the http2 server, if bound, would try to write its own SETTINGS
    // frame), and asserts zero bytes crossed the channel the whole time.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-no-early-write-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const base = createLocalSandboxRunner();
    const hostWrites: Buffer[] = [];
    let readyLineSent = false;
    const readySentAtMs = { value: 0 };
    const openDuplexChannel = async (openInput: {
      command: readonly string[];
    }): Promise<CommandManagedDuplexChannel> => {
      const joined = openInput.command.join(" ");
      const nonce = /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(joined)?.[1] ?? "";
      let dataListener: ((chunk: Uint8Array) => void) | null = null;
      const channel: CommandManagedDuplexChannel = {
        write: (data: Uint8Array) => {
          // Any host write before READY is accepted is exactly the fault
          // this test guards against.
          hostWrites.push(Buffer.from(data));
        },
        onData: (listener: (chunk: Uint8Array) => void) => {
          dataListener = listener;
          setImmediate(() => {
            readySentAtMs.value = Date.now();
            readyLineSent = true;
            dataListener?.(
              new TextEncoder().encode(`${JSON.stringify({ version: 2, type: "ready", nonce })}\n`),
            );
            // No client preface follows: the host must still write nothing
            // while it waits out the preface bound, proving the READY-accept
            // gate — not a timer — is what would unlock a host write.
          });
        },
        onExit: (_listener: (exit: { exitCode: number | null }) => void) => {},
        stop: () => {},
        close: async () => Promise.resolve(),
      };
      return channel;
    };
    const runner = { ...base, openDuplexChannel };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-no-early-write",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 300,
    });
    try {
      expect(readyLineSent).toBe(true);
      // The preface never arrived, so the open fell back to the file bridge —
      // and across the whole open attempt, including the wait after READY,
      // the host wrote zero bytes to the channel.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      expect(hostWrites).toHaveLength(0);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_invalid_ready_line_bytes_do_not_reach_a_log_line", async () => {
    // Fix 5: decode only the bounded READY line as strict protocol text, and
    // never log raw channel bytes. This test sends a pre-READY line whose
    // bytes are deliberately sentinel-marked and syntactically invalid (not
    // valid UTF-8 JSON), then a valid READY frame. No log line — on any
    // stream — may contain the sentinel bytes.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-invalid-ready-bytes-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const INVALID_LINE_SENTINEL = "sentinelinvalidreadyline62fa";
    const logLines: string[] = [];
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      // Invalid bytes: not valid UTF-8 (a lone continuation byte), immediately
      // followed by a sentinel and a newline — an invalid candidate line.
      ctx.emitRaw(Buffer.concat([Buffer.from([0x80]), Buffer.from(INVALID_LINE_SENTINEL), Buffer.from("\n")]));
      ctx.emitReady();
      ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-invalid-ready-bytes",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      onLog: async (_stream, chunk) => {
        logLines.push(chunk);
      },
    });
    try {
      // The invalid line was skipped as noise, and READY still passed.
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      const logDump = logLines.join("");
      expect(logDump).not.toContain(INVALID_LINE_SENTINEL);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_close_after_orderly_completion_keeps_the_run_result", async () => {
    // A loss ordered after a host-observed orderly completion is a normal
    // teardown, not a failure: the run already completed. The disposition
    // latch must keep the success and emit no loss event for it.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-orderly-close-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    let emitExit: (() => void) | null = null;
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      emitExit = ctx.emitExit;
      ctx.emitReady();
      ctx.connectHttp2();
    });
    const { recorder, events, counters } = createRecordingDuplexRecorder();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-orderly-close",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexObservabilityRecorder: recorder,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      // The agent turn completes cleanly before the channel ends.
      expect(bridge?.settleRunDisposition?.()).toEqual({ failed: false, lossReason: null });
      emitExit!();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The disposition still reports success after the teardown loss.
      expect(bridge?.readRunDisposition?.()).toEqual({ failed: false, lossReason: null });
      // A normal teardown after completion is not a loss: no loss event, no
      // loss counter.
      expect(events.some((e) => e.dimensions.loss_reason !== undefined)).toBe(false);
      expect(counters.some((c) => c.metric === DUPLEX_COUNTER_LOSS_TOTAL)).toBe(false);
    } finally {
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_safe_request_during_channel_loss_stays_retryable", async () => {
    // A GET never changes host state, so a response-body read failure stays
    // retryable: the host answers 502 with no indeterminate marker, the same
    // rule `forwardBridgeRequest` already applies on every transport. This
    // proves the http2_v1 forward handler reuses that one function unchanged.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-safe-retry-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-safe-retry",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      // A ceiling far under any real response, so every response-body read
      // fails the size check deterministically.
      maxBodyBytes: 1,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(502);
      expect(response.headers["x-paperclip-bridge-outcome"]).toBeUndefined();
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_unsafe_request_during_channel_loss_is_indeterminate", async () => {
    // A POST may have committed on the host before the response-body read
    // failed, so a retry could double-apply it. The host answers a
    // non-retryable 504 with the indeterminate marker instead — the same
    // rule `forwardBridgeRequest` already applies on every transport.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-unsafe-indeterminate-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-unsafe-indeterminate",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      maxBodyBytes: 1,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "POST",
        path: "/api/issues/issue-1/comments",
        headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      expect(response.status).toBe(504);
      expect(response.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("aborts the host forward and its response-body read when the sandbox stream closes", async () => {
    // The mock host answers with headers at once, then holds the response
    // body open with no further chunk and no end. The read stays pending
    // until the outbound fetch itself aborts. If the abort never reaches
    // this connection, `hostConnectionClosed` never resolves and the test
    // times out instead of failing fast — the assertion is: it does resolve,
    // quickly, once the sandbox stream closes.
    let sawRequest = false;
    let resolveHostConnectionClosed: (() => void) | undefined;
    const hostConnectionClosed = new Promise<void>((resolve) => {
      resolveHostConnectionClosed = resolve;
    });
    const api = createServer((req, res) => {
      sawRequest = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.on("close", () => resolveHostConnectionClosed!());
    });
    await new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(0, "127.0.0.1", () => resolve());
    });
    const apiAddress = api.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Expected the mock host server to listen on a TCP port.");
    }
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-abort-forward-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-abort-forward",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: apiOrigin,
      enableSandboxDuplexBridge: true,
      // Far longer than this test waits, so only the sandbox-side stream
      // close — not this ceiling — can end the forward here.
      forwardTimeoutMs: 60_000,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const clientStream = sessionRef.current!.request({
        ":method": "GET",
        ":path": "/api/agents/me",
        authorization: `Bearer ${bridgeToken}`,
      });
      clientStream.end();
      await waitForCondition(() => sawRequest, "the mock host to receive the forwarded request", 4000);
      // The sandbox side closes its stream while the host forward and its
      // response-body read are both still in flight.
      clientStream.close(http2.constants.NGHTTP2_CANCEL);
      await hostConnectionClosed;
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  }, 20000);

  // ---------------------------------------------------------------------------
  // Real-PTY replay.
  //
  // The earlier PTY-echo defect shipped because a fake PTY does not echo the way
  // a real terminal does. These cases replay byte sequences captured from an
  // actual `pty.fork()` + bash session driven through the same launch wrapper the
  // Daytona plugin builds, so the gate is exercised against terminal output
  // rather than against synthetic frames.
  // ---------------------------------------------------------------------------

  async function runReadinessReplay(emit: (ctx: Http2OpenContext) => void) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pty-replay-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const { runner, control } = makeHttp2SelectionRunner(emit);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-pty-replay",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
      duplexReadinessTimeoutMs: 2_000,
    });
    const mode = bridge?.env.PAPERCLIP_API_BRIDGE_MODE;
    await bridge?.stop();
    await api.close();
    return { mode, control };
  }

  // Case 1: the shape observed on a real Daytona PTY. bash echoes its prompt and
  // the wrapper line, terminated by CRLF, then the gateway's READY frame follows
  // on its own clean line.
  it("PTY replay: accepts READY after an echoed prompt and wrapper line", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      ctx.emitRaw(
        "daytona@212487a7f3c9:~$ exec 2>'/tmp/paperclip-duplex-x.log'; stty raw -echo; " +
          "exec 'bash' '-c' 'exec env PAPERCLIP_BRIDGE_NONCE=" + ctx.nonce + " node gateway.mjs'\r\n",
      );
      ctx.emitRaw('{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n');
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  // Case 2: captured from a local pty.fork() + bash on a host whose bash enables
  // bracketed paste. The disable sequence and a bare CR land immediately before
  // the READY frame, on the same line with no newline between them, so the whole
  // line does not decode. The Daytona image in use today does not do this; another
  // image or another provider can, and the gate must not depend on it.
  it("PTY replay: accepts READY prefixed by a bracketed-paste disable sequence", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      ctx.emitRaw(
        "\x1b[?2004h\x1b]0;user@host: /srv\x07user@host:/srv$ exec 2>'/tmp/d.log'; " +
          "stty raw -echo; exec 'bash' '-c' 'exec env node gateway.mjs'\r\n",
      );
      // No newline between the escape sequence and the frame: same line.
      ctx.emitRaw('\x1b[?2004l\r{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n');
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  // Case 3: the READY frame split across two chunk deliveries.
  it("PTY replay: accepts READY split across chunk boundaries", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      ctx.emitRaw("prompt$ wrapper-line\r\n");
      const frame = '{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n';
      ctx.emitRaw(frame.slice(0, 12));
      ctx.emitRaw(frame.slice(12));
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  // Case 4: a multibyte character split across two chunks in the pre-READY noise.
  it("PTY replay: accepts READY when a multibyte char splits across chunks", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      const noise = Buffer.from("prompt ✓ done\r\n", "utf8");
      ctx.emitRaw(noise.slice(0, 8).toString("utf8"));
      ctx.emitRaw(noise.slice(8).toString("utf8"));
      ctx.emitRaw('{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n');
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  // Case 5: a version-2 line that once decoded as a `request` envelope frame
  // now decodes as `unknown_type`, because the codec no longer validates that
  // frame type. The gate treats it the same as any other non-READY line: skip
  // it and keep scanning. This holds for both a bare line (the frame starts at
  // offset 0, so the leading-prefix retry never runs) and a line where noise
  // comes before the frame on the same line (the retry runs, decodes the frame
  // part, and still does not find a READY type). Either way the valid READY
  // line that follows still authenticates.
  it("PTY replay: accepts READY after a bare and a prefixed former-frame line", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      const formerFrame =
        '{"version":2,"type":"request","id":"r-1","method":"GET","path":"/","query":"","headers":{},"bodyByteCount":0}';
      ctx.emitRaw(`${formerFrame}\n`);
      // No newline between the prompt prefix and the former-frame line: same line.
      ctx.emitRaw(`prompt$ ${formerFrame}\n`);
      ctx.emitRaw('{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n');
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  // Case 6: three lines the gate must reject without ending the handshake — a
  // wrong-version READY-shaped line, a READY line with a smuggled extra field,
  // and a same-line second-frame smuggling attempt (no newline between the two
  // JSON values, so the whole line fails to parse as one JSON value). Each one
  // fails the strict decode and the gate skips it, the same as any other
  // pre-READY noise; the valid READY line that follows still authenticates.
  it("PTY replay: accepts READY after a wrong-version, an extra-field, and a same-line smuggling attempt", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      ctx.emitRaw(`{"version":1,"type":"ready","nonce":"${ctx.nonce}"}\n`);
      ctx.emitRaw(`{"version":2,"type":"ready","nonce":"${ctx.nonce}","address":"http://127.0.0.1:1"}\n`);
      ctx.emitRaw(
        `{"version":2,"type":"ready","nonce":"${ctx.nonce}"}{"version":2,"type":"ready","nonce":"${ctx.nonce}"}\n`,
      );
      ctx.emitRaw(`{"version":2,"type":"ready","nonce":"${ctx.nonce}"}\n`);
      ctx.connectHttp2();
    });
    expect(mode).toBe("http2_v1");
  }, 20000);

  it("test_the_session_starts_at_the_client_preface_after_the_ready_line", async () => {
    // The gate retains every byte after the accepted READY line, and the host
    // starts the HTTP/2 session at the client preface offset inside that
    // retained suffix, inclusive — no byte before the preface reaches the
    // HTTP/2 server. A pre-preface byte would make the server report a
    // `PROTOCOL_ERROR`; this test proves the real session opens cleanly
    // instead, which only holds when the offset is exact.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-preface-offset-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      // The READY line and the client preface arrive in the same chunk, back
      // to back, with no gap — the exact production shape.
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-preface-offset",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  it("test_a_preface_pattern_before_the_ready_line_does_not_start_a_session", async () => {
    // The scan window opens only after the gate accepts the READY line. A
    // banner byte can carry the same 24 octets before that line; a scan that
    // started earlier could match those bytes and start a session against
    // the shell. This test embeds the exact preface bytes in the pre-READY
    // noise, then proves a session still starts only at the REAL preface
    // that follows READY.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-http2-preface-lookalike-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    await mkdir(remoteCwd, { recursive: true });
    const api = await startRecordingApiServer();
    const sessionRef: { current: http2.ClientHttp2Session | null } = { current: null };
    let bridgeToken = "";
    const { runner, control } = makeHttp2SelectionRunner((ctx) => {
      bridgeToken = ctx.bridgeToken;
      // A pre-READY banner that happens to carry the literal preface bytes.
      ctx.emitRaw(Buffer.concat([Buffer.from("prompt$ "), HTTP2_TEST_CLIENT_PREFACE, Buffer.from("\r\n")]));
      ctx.emitReady();
      sessionRef.current = ctx.connectHttp2();
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd,
      timeoutMs: 30_000,
      runner,
      effectiveCapabilities: duplexCapabilities(true),
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-preface-lookalike",
      target,
      runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: api.origin,
      enableSandboxDuplexBridge: true,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(control.openCount).toBe(1);
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
      await waitForCondition(() => sessionRef.current !== null, "the http2 client session to open", 4000);
      const response = await http2TestRequest(sessionRef.current!, {
        method: "GET",
        path: "/api/agents/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      sessionRef.current?.close();
      await bridge?.stop();
      await api.close();
    }
  }, 20000);

  // Case 5: a flood of short noise lines must fail closed at the cap rather than
  // scanning forever. This is the hole the cursor-based scan closes.
  it("PTY replay: fails closed on a pre-READY noise flood", async () => {
    const { mode } = await runReadinessReplay((ctx) => {
      const line = "x".repeat(64) + "\n";
      for (let i = 0; i < 80_000; i += 1) ctx.emitRaw(line);
      ctx.emitRaw('{"version":2,"type":"ready","nonce":"' + ctx.nonce + '"}\n');
    });
    expect(mode).toBe("queue_v1");
  }, 30000);

});

// The names the embedded codec source declares. A test wraps the source and
// reads these names back. The generated gateway never decodes, so the embedded
// copy declares only the frame version and the encode function.
interface EmbeddedCodec {
  encodeDuplexFrame: (frame: unknown) => string;
  DUPLEX_FRAME_VERSION: number;
}

// This describe block covers the zero-dependency codec every generated
// gateway embeds (`DUPLEX_GATEWAY_CODEC_SOURCE`). The `http2_v1` gateway
// embeds this same codec source to send its one READY line, so this coverage
// stays live for the active transport.
describe("embedded sandbox gateway codec", () => {
  it("encodes the READY frame to the exact byte-for-byte wire format", () => {
    // `JSON.stringify` writes object keys in insertion order, so this pins the
    // exact key order the gateway writes: version, then type, then nonce. A
    // reordered or reformatted call site would change the bytes on the wire
    // without failing a looser, parse-then-compare assertion.
    const codecFactory = new Function(
      `${getSandboxDuplexGatewayCodecSource()}\nreturn { encodeDuplexFrame, DUPLEX_FRAME_VERSION };`,
    ) as unknown as () => EmbeddedCodec;
    const codec = codecFactory();

    expect(codec.DUPLEX_FRAME_VERSION).toBe(DUPLEX_FRAME_VERSION);
    const nonce = "fixed-test-nonce";
    const encoded = codec.encodeDuplexFrame({ version: codec.DUPLEX_FRAME_VERSION, type: "ready", nonce });
    expect(encoded).toBe(`{"version":2,"type":"ready","nonce":"${nonce}"}\n`);

    // The host encode side produces the same bytes for the same frame, so the
    // two copies stay wire compatible on the one frame the gateway still sends.
    expect(encoded).toBe(encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "ready", nonce }));
  });
});

/** Wait for the pending microtasks and macrotasks to settle. */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
describe("sandbox target spec parse: enableSandboxDuplexBridge", () => {
  // The minimal serialized sandbox target the host stamps and the adapter parses.
  // A test overrides one field per case to prove the fail-closed parse.
  function serializedSandboxTarget(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/work",
      ...overrides,
    };
  }

  it("reads the kill switch as a grant when the stamped field is true", () => {
    const parsed = parseAdapterExecutionTarget(serializedSandboxTarget({ enableSandboxDuplexBridge: true }));
    expect(parsed?.kind).toBe("remote");
    if (parsed?.kind !== "remote" || parsed.transport !== "sandbox") {
      throw new Error("expected a sandbox execution target");
    }
    expect(parsed.enableSandboxDuplexBridge).toBe(true);
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(parsed)).toBe(true);
  });

  it("parses an absent field as no grant", () => {
    const parsed = parseAdapterExecutionTarget(serializedSandboxTarget({}));
    if (parsed?.kind !== "remote" || parsed.transport !== "sandbox") {
      throw new Error("expected a sandbox execution target");
    }
    expect(parsed.enableSandboxDuplexBridge).toBe(false);
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(parsed)).toBe(false);
  });

  it("parses a false field as no grant", () => {
    const parsed = parseAdapterExecutionTarget(serializedSandboxTarget({ enableSandboxDuplexBridge: false }));
    if (parsed?.kind !== "remote" || parsed.transport !== "sandbox") {
      throw new Error("expected a sandbox execution target");
    }
    expect(parsed.enableSandboxDuplexBridge).toBe(false);
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(parsed)).toBe(false);
  });

  it("fails closed on a non-boolean field", () => {
    // A string "true" is not the literal boolean true, so the parse never reads
    // it as a grant. This keeps a malformed round-trip on the file bridge.
    const parsed = parseAdapterExecutionTarget(serializedSandboxTarget({ enableSandboxDuplexBridge: "true" }));
    if (parsed?.kind !== "remote" || parsed.transport !== "sandbox") {
      throw new Error("expected a sandbox execution target");
    }
    expect(parsed.enableSandboxDuplexBridge).toBe(false);
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(parsed)).toBe(false);
  });

  it("returns false from the reader for a non-sandbox target", () => {
    const localTarget = parseAdapterExecutionTarget({ kind: "local", environmentId: "env-1", leaseId: "lease-1" });
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(localTarget)).toBe(false);
    expect(adapterExecutionTargetEnablesSandboxDuplexBridge(null)).toBe(false);
  });
});

/**
 * A minimal run-disposition latch for the seam tests below. It reproduces the
 * same ordering rule the real bridge transport applies: the first ordered
 * loss or orderly completion latches the terminal disposition, and a later
 * call never overrides it. `emitExit` stands in for a transport-level channel
 * exit — the real transport treats every channel exit as a loss candidate,
 * mapped to the typed `provider_exit` reason.
 */
function createFakeBridgeTransport() {
  let lossOrdered = false;
  let lossReason: DuplexLossReason | null = null;
  let completionOrdered = false;
  const markOrderlyCompletion = (): void => {
    if (completionOrdered || lossOrdered) return;
    completionOrdered = true;
  };
  return {
    get runDisposition() {
      return { failed: lossOrdered, lossReason };
    },
    settleRunDisposition() {
      markOrderlyCompletion();
      return { failed: lossOrdered, lossReason };
    },
    markOrderlyCompletion,
    emitExit(): void {
      if (lossOrdered || completionOrdered) return;
      lossOrdered = true;
      lossReason = "provider_exit";
    },
  };
}

describe("settleRunDisposition atomic read and mark", () => {
  it("marks the orderly completion and reports a success for a healthy channel", async () => {
    const broker = createFakeBridgeTransport();

    // The one atomic step marks the orderly completion and reads the success.
    expect(broker.settleRunDisposition()).toEqual({ failed: false, lossReason: null });
    // A later teardown loss orders after the mark, so it stays a normal teardown.
    broker.emitExit();
    await flushMacrotasks();
    expect(broker.runDisposition).toEqual({ failed: false, lossReason: null });
  });

  it("reports the failure and does not mark for a latched loss", async () => {
    const broker = createFakeBridgeTransport();

    // A loss ordered before any orderly completion latches the failure.
    broker.emitExit();
    await flushMacrotasks();
    // The atomic step reads the failure and no-ops the mark, so a later
    // completion cannot clear the latch.
    expect(broker.settleRunDisposition()).toEqual({ failed: true, lossReason: "provider_exit" });
    broker.markOrderlyCompletion();
    expect(broker.runDisposition).toEqual({ failed: true, lossReason: "provider_exit" });
  });
});

describe("CLI-lane run-disposition seam", () => {
  const CLEAN_RESULT = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok\n",
    stderr: "",
    pid: null,
    startedAt: "2026-08-22T00:00:00.000Z",
  } as const;

  function mockRunner(result: Record<string, unknown>) {
    return { execute: vi.fn(async () => result) };
  }

  function sandboxTarget(runner: unknown): AdapterSandboxExecutionTarget {
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
      runner,
    } as AdapterSandboxExecutionTarget;
  }

  it("fails a clean CLI completion closed when the bridge channel was lost mid-turn", async () => {
    const broker = createFakeBridgeTransport();
    // The control channel dies mid-turn, before the CLI process exits.
    broker.emitExit();
    await flushMacrotasks();

    const runner = mockRunner({ ...CLEAN_RESULT });
    const result = await runAdapterExecutionTargetProcess("run-cli-lost", sandboxTarget(runner), "agent-cli", [], {
      cwd: "/local",
      env: {},
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      settleRunDisposition: () => broker.settleRunDisposition(),
    });

    // The lost channel overrides the clean exit to a failure with the typed code.
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(DUPLEX_CHANNEL_LOST_ERROR_CODE);
    // The note names only the typed loss reason, not raw provider text.
    expect(result.stderr).toContain("provider_exit");
  });

  it("keeps a clean CLI completion a success when the channel stays healthy, and a teardown loss stays benign", async () => {
    const broker = createFakeBridgeTransport();

    const runner = mockRunner({ ...CLEAN_RESULT });
    const result = await runAdapterExecutionTargetProcess("run-cli-ok", sandboxTarget(runner), "agent-cli", [], {
      cwd: "/local",
      env: {},
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      settleRunDisposition: () => broker.settleRunDisposition(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode ?? null).toBeNull();
    // The seam's atomic settle marked the orderly completion at agent
    // completion. A teardown loss ordered after it is a normal teardown, so the
    // run stays a success without any manual mark here.
    broker.emitExit();
    await flushMacrotasks();
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("keeps a clean CLI completion a success when the gateway exits during the run-log tail finish", async () => {
    const broker = createFakeBridgeTransport();

    // A run-log tail whose finish emits a gateway exit. This reproduces the
    // race where the bridge gateway dies after the clean process completion but
    // before the host reads the disposition. The seam settles the disposition
    // synchronously before this finish await, so the mark orders first and the
    // teardown exit stays benign.
    const runLogTail: SandboxRunLogTailFactory = {
      create: () => ({
        wrapCommand: (command, args) => ({ command, args }),
        start: () => {},
        finish: async () => {
          broker.emitExit();
          await flushMacrotasks();
        },
        abort: async () => {},
      }),
    };

    const runner = mockRunner({ ...CLEAN_RESULT });
    const result = await runAdapterExecutionTargetProcess("run-cli-race", sandboxTarget(runner), "agent-cli", [], {
      cwd: "/local",
      env: {},
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      runLogTail,
      settleRunDisposition: () => broker.settleRunDisposition(),
    });

    // The atomic settle at the completion boundary marked the orderly
    // completion before the finish await, so the gateway exit never latches a
    // false loss and the run stays a clean success.
    expect(result.exitCode).toBe(0);
    expect(result.errorCode ?? null).toBeNull();
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("cannot clear the loss latch with a later completion", async () => {
    const broker = createFakeBridgeTransport();
    // The loss latches before the CLI process exits.
    broker.emitExit();
    await flushMacrotasks();
    // A later orderly completion cannot clear the latch.
    broker.markOrderlyCompletion();

    const runner = mockRunner({ ...CLEAN_RESULT });
    const result = await runAdapterExecutionTargetProcess("run-cli-latch", sandboxTarget(runner), "agent-cli", [], {
      cwd: "/local",
      env: {},
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      settleRunDisposition: () => broker.settleRunDisposition(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(DUPLEX_CHANNEL_LOST_ERROR_CODE);
  });

  it("leaves an already-failed CLI result unchanged and never settles the disposition", async () => {
    const broker = createFakeBridgeTransport();
    // The control channel is lost, but the process itself also exited non-zero.
    broker.emitExit();
    await flushMacrotasks();

    let settleCalls = 0;
    const runner = mockRunner({ ...CLEAN_RESULT, exitCode: 2, stderr: "boom\n" });
    const result = await runAdapterExecutionTargetProcess("run-cli-failed", sandboxTarget(runner), "agent-cli", [], {
      cwd: "/local",
      env: {},
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      settleRunDisposition: () => {
        settleCalls += 1;
        return broker.settleRunDisposition();
      },
    });

    // A non-zero exit is already a failure, so the seam leaves it unchanged and
    // reports no transport-level code. This is the same success-eligibility rule
    // the ACP lane applies.
    expect(result.exitCode).toBe(2);
    expect(result.errorCode ?? null).toBeNull();
    expect(settleCalls).toBe(0);
  });
});

describe("duplex readiness gate replay-buffer reservation", () => {
  const READY_NONCE = "0123456789abcdef0123456789abcdef";

  // A fake duplex channel the test drives directly. `control.emitData` re-enters
  // the data listener the gate bound at construction. `control.emitExit` re-enters
  // the exit listener. The fake records the stop and the close calls.
  function makeFakeReadinessChannel(): {
    channel: CommandManagedDuplexChannel;
    control: {
      stopCount: number;
      closeCount: number;
      written: string[];
      emitData: (chunk: string) => void;
      emitExit: (exit: { exitCode: number | null }) => void;
    };
  } {
    let dataListener: ((chunk: Uint8Array) => void) | null = null;
    let exitListener: ((exit: { exitCode: number | null }) => void) | null = null;
    const control = {
      stopCount: 0,
      closeCount: 0,
      written: [] as string[],
      emitData: (chunk: string): void => dataListener?.(new TextEncoder().encode(chunk)),
      emitExit: (exit: { exitCode: number | null }): void => exitListener?.(exit),
    };
    const channel: CommandManagedDuplexChannel = {
      write(data: Uint8Array): void {
        control.written.push(Buffer.from(data).toString("utf8"));
      },
      onData(listener: (chunk: Uint8Array) => void): void {
        dataListener = listener;
      },
      onExit(listener: (exit: { exitCode: number | null }) => void): void {
        exitListener = listener;
      },
      stop(): void {
        control.stopCount += 1;
      },
      close(): Promise<void> {
        control.closeCount += 1;
        return Promise.resolve();
      },
    };
    return { channel, control };
  }

  function readyLine(): string {
    return `${JSON.stringify({ version: 2, type: "ready", nonce: READY_NONCE })}\n`;
  }

  it("drops the retained pre-READY buffer on READY acceptance", async () => {
    const { channel, control } = makeFakeReadinessChannel();
    const gate = __duplexReadinessTesting.createReadinessGate(channel, {
      nonce: READY_NONCE,
      timeoutMs: 5_000,
    });
    // A large pre-READY noise line and a large suffix arrive with the READY line
    // in one chunk. A sandbox controls every byte here.
    const noise = `${"n".repeat(4096)}\n`;
    const suffix = "s".repeat(2048);
    control.emitData(`${noise}${readyLine()}${suffix}`);
    expect((await gate.ready).ok).toBe(true);
    // The gate drops the pre-READY buffer, so the process no longer retains the
    // noise prefix.
    expect(gate.retainedReadinessBufferLength()).toBe(0);
    // The broker binds and replays the retained suffix.
    const replayed: string[] = [];
    gate.brokerChannel.onData((chunk) => replayed.push(Buffer.from(chunk).toString("utf8")));
    expect(replayed).toEqual([suffix]);
    expect(gate.retainedReadinessBufferLength()).toBe(0);
  });

  it("caps the post-READY replay buffer without the aggregate ledger", async () => {
    const { channel, control } = makeFakeReadinessChannel();
    const readinessBufferCapBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;
    // No ledger: only the buffer's own direct byte cap can end the channel
    // here. This proves the cap holds even when no aggregate ledger is
    // present, unlike the ledger-only check this replaces.
    const gate = __duplexReadinessTesting.createReadinessGate(channel, {
      nonce: READY_NONCE,
      timeoutMs: 5_000,
    });
    // The READY line arrives alone, so the pending suffix starts empty.
    control.emitData(readyLine());
    expect((await gate.ready).ok).toBe(true);
    // A post-READY chunk one byte over the cap floods the replay buffer
    // before the broker binds.
    control.emitData("x".repeat(readinessBufferCapBytes + 1));
    expect(gate.replayOverflowed()).toBe(true);
    expect(control.stopCount).toBe(1);
    // Binding the broker replays nothing, because the gate dropped the buffer.
    const replayed: string[] = [];
    gate.brokerChannel.onData((chunk) => replayed.push(Buffer.from(chunk).toString("utf8")));
    expect(replayed).toEqual([]);
  });
});

describe("http2 preface scan post-preface replay buffer", () => {
  // The HTTP/2 client connection preface, 24 octets (RFC 9113, Section 3.4).
  // A test writes this literal, not the production constant, so the test
  // proves the real wire bytes match, not only that the two source files
  // agree on a name.
  const PREFACE = Buffer.from("505249202a20485454502f322e300d0a0d0a534d0d0a0d0a", "hex");

  // A fake duplex channel the test drives directly. `control.emitData`
  // re-enters the data listener the scan bound at construction. The fake
  // records the stop call, so a test proves an overflow fails closed.
  function makeFakeChannel(): {
    channel: CommandManagedDuplexChannel;
    control: { stopCount: number; emitData: (chunk: Buffer) => void };
  } {
    let dataListener: ((chunk: Uint8Array) => void) | null = null;
    const control = {
      stopCount: 0,
      emitData: (chunk: Buffer): void => dataListener?.(chunk),
    };
    const channel: CommandManagedDuplexChannel = {
      write(): void {},
      onData(listener: (chunk: Uint8Array) => void): void {
        dataListener = listener;
      },
      onExit(): void {},
      stop(): void {
        control.stopCount += 1;
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    return { channel, control };
  }

  it("rejects a single pre-preface chunk over the cap without reserving or concatenating it", async () => {
    const { channel, control } = makeFakeChannel();
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes: 64,
      timeoutMs: 5_000,
    });
    // One chunk, larger than the cap on its own, with no preface inside it.
    // The scan must reject it on its prospective length before the
    // `Buffer.concat` allocation.
    control.emitData(Buffer.from("x".repeat(128)));
    expect(await scan.settled).toBe("missing");
    expect(scan.replayOverflowed()).toBe(false);
  });

  it("rejects a pre-preface chunk that tips an already-buffered scan past the cap", async () => {
    const { channel, control } = makeFakeChannel();
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes: 64,
      timeoutMs: 5_000,
    });
    // The first chunk stays under the cap on its own, so the scan buffers it
    // while it keeps searching.
    const firstChunk = "n".repeat(40);
    control.emitData(Buffer.from(firstChunk));
    // The second chunk, added to the first, passes the cap. The scan must
    // reject it before the concat that would grow the buffer past the cap,
    // and it must drop the already-buffered first chunk too.
    control.emitData(Buffer.from("n".repeat(40)));
    expect(await scan.settled).toBe("missing");
    expect(scan.replayOverflowed()).toBe(false);
  });

  it("fails closed and stops the channel when the post-preface buffer floods past the cap", async () => {
    const { channel, control } = makeFakeChannel();
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes: 64,
      timeoutMs: 5_000,
    });
    // The preface arrives alone, so the pending buffer starts empty.
    control.emitData(PREFACE);
    expect(await scan.settled).toBe("found");
    expect(scan.replayOverflowed()).toBe(false);
    // A post-preface chunk larger than the cap floods the buffer before the
    // HTTP/2 server binds. The scan drops the buffer, stops the channel, and
    // fails closed — the same shape a missing preface fails closed.
    control.emitData(Buffer.from("x".repeat(128)));
    expect(scan.replayOverflowed()).toBe(true);
    expect(control.stopCount).toBe(1);
    // Binding the downstream listener replays nothing: the scan dropped the
    // buffer on the overflow.
    const replayed: string[] = [];
    scan.scanned.onData((chunk) => replayed.push(Buffer.from(chunk).toString("utf8")));
    expect(replayed).toEqual([]);
  });

  it("settles missing when the readiness timeout elapses with no preface found", async () => {
    const { channel, control } = makeFakeChannel();
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes: 4_096,
      // A short bound, so the test does not wait out a production-sized one.
      timeoutMs: 20,
    });
    // Partial, non-matching data arrives and the scan keeps searching. No
    // preface ever completes, so only the bound timeout settles the scan.
    const partial = "not-a-preface-and-never-will-be";
    control.emitData(Buffer.from(partial));
    expect(await scan.settled).toBe("missing");
  });

  it("finds a preface fragmented into many one-byte chunks", async () => {
    const { channel, control } = makeFakeChannel();
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes: 4_096,
      timeoutMs: 5_000,
    });
    // A slow sandbox socket can deliver the preface one byte at a time. The
    // scan must still find it and deliver the exact octets, the same as it
    // does for a preface that arrives in one chunk.
    for (const byte of PREFACE) {
      control.emitData(Buffer.from([byte]));
    }
    expect(await scan.settled).toBe("found");
    expect(scan.replayOverflowed()).toBe(false);
    const replayed: string[] = [];
    scan.scanned.onData((chunk) => replayed.push(Buffer.from(chunk).toString("utf8")));
    expect(replayed).toEqual([PREFACE.toString("utf8")]);
  });

  it("bounds the pre-preface scan search and growth-copy work by the bytes received, across many one-byte fragments", async () => {
    const { channel, control } = makeFakeChannel();
    __http2PrefaceScanTesting.resetScanSearchUnits();
    __http2PrefaceScanTesting.resetScanBufferGrowthCopyUnits();
    // An adversarial sandbox sends many one-byte fragments, none of them the
    // preface, right up to the cap boundary. A search that always restarts
    // from the beginning of the retained buffer re-examines the whole
    // buffer on every fragment; a one-copy-per-fragment append copies the
    // whole retained buffer on every fragment. Both are quadratic in the
    // fragment count.
    const capBytes = 2_048;
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes,
      timeoutMs: 5_000,
    });
    for (let i = 0; i < capBytes; i += 1) {
      control.emitData(Buffer.from([0x2e])); // '.', never part of the preface
    }
    // One more one-byte fragment tips the retained buffer past the cap, so
    // the scan settles and this test can read the final work counts.
    control.emitData(Buffer.from([0x2e]));
    expect(await scan.settled).toBe("missing");
    const searchUnits = __http2PrefaceScanTesting.readScanSearchUnits();
    const growthCopyUnits = __http2PrefaceScanTesting.readScanBufferGrowthCopyUnits();
    // Each one-byte fragment can re-examine at most the preface's 24 octets
    // of overlap (RFC 9113, Section 3.4), so the search work stays within a
    // small multiple of capBytes. Doubling growth copies a logarithmic
    // number of times, each at most the current buffer length, so the
    // growth-copy work stays within a small multiple of capBytes too. A
    // per-fragment full rescan or full copy is quadratic (about
    // capBytes^2 / 2), far above either bound.
    expect(searchUnits).toBeLessThanOrEqual(50 * capBytes);
    expect(growthCopyUnits).toBeLessThanOrEqual(4 * capBytes);
  });

  it("bounds the post-preface replay buffer growth-copy work by the bytes received, across many one-byte fragments, and still enforces the cap", async () => {
    const { channel, control } = makeFakeChannel();
    __http2PrefaceScanTesting.resetReplayBufferGrowthCopyUnits();
    const capBytes = 2_048;
    const scan = __http2PrefaceScanTesting.scanForHttp2ClientPreface(channel, {
      capBytes,
      timeoutMs: 5_000,
    });
    control.emitData(PREFACE);
    expect(await scan.settled).toBe("found");
    // Many one-byte post-preface fragments arrive before the HTTP/2 server
    // binds, right up to the cap boundary. A one-copy-per-fragment append
    // copies the whole retained buffer on every fragment; the fix must
    // instead grow by doubling.
    const postPrefaceBytes = capBytes - PREFACE.byteLength;
    for (let i = 0; i < postPrefaceBytes; i += 1) {
      control.emitData(Buffer.from([0x2e]));
    }
    const growthCopyUnits = __http2PrefaceScanTesting.readReplayBufferGrowthCopyUnits();
    expect(growthCopyUnits).toBeLessThanOrEqual(4 * capBytes);
    // One more one-byte fragment tips the retained buffer past the cap. The
    // scan drops the buffer, stops the channel, and fails closed — the same
    // shape a missing preface fails closed.
    control.emitData(Buffer.from([0x2e]));
    expect(scan.replayOverflowed()).toBe(true);
    expect(control.stopCount).toBe(1);
  });
});

describe("EffectiveSandboxCapabilities deprecated alias", () => {
  it("still type-checks as EffectiveExecutionCapabilities", () => {
    // A type-level check, not a runtime one: this assignment fails to compile
    // if the alias drifts from the renamed interface. Keep it here so a later
    // removal of the alias is a deliberate act, not an accident.
    const snapshot: EffectiveExecutionCapabilities = {
      reusableLeases: false,
      nativeSyncIn: false,
      nativeSyncOut: false,
      persistentProcessSessions: false,
      independentControlCommands: false,
      incrementalSessionOutput: false,
      concurrentSyncOperations: false,
      duplexCommandStream: false,
    };
    const aliased: EffectiveSandboxCapabilities = snapshot;
    expect(aliased).toEqual(snapshot);
  });
});
