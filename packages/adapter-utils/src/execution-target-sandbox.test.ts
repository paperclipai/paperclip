import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import { createSandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import { runChildProcess } from "./server-utils.js";
import { shellQuote } from "./ssh.js";

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

  async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
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

  it("applies the remote sandbox fallback when adapter timeoutSec is unset", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

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
      expect(runner.execute.mock.calls.some(([input]) => input.timeoutMs === 1_800_000)).toBe(true);
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
});
