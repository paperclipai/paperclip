import { createServer } from "node:http";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetProcessSessionBridge,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import {
  createRuntimeSpanRunner,
  getActiveStepContext,
  type StartupSpan,
  type StartupTraceContext,
  type StartupTracer,
} from "./acpx-engine/startup-timing.js";
import { createSandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import { runChildProcess } from "./server-utils.js";
import { shellQuote } from "./ssh.js";

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

  async function runProxyWithInput(command: string, input: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
    return { stdout, stderr, code };
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
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("out:hello\n");
      expect(result.stderr).toBe("err:hello\n");
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
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("out:hello\n");
        expect(result.stderr).toBe("err:hello\n");
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
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("out:hello\n");
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
        expect(result.stdout).toBe("out:hello\n");

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

  it("fails oversized host responses with a 502 before returning them to the sandbox client", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const largeBody = "x".repeat(64);
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
      runId: "run-bridge-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 32,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 32 bytes.",
      });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-limit",
      }]);
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
});
