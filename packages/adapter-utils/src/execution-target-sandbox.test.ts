import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";

describe("sandbox adapter execution targets", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
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
      args: ["-lc", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
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
      args: ["-lc", 'printf %s "$HOME"'],
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
