// TECH-8174: on Kubernetes the file bridge starts with fewer pod execs. The
// worker skips its queue mkdir (the server start creates the same directories)
// and the server start runs the readiness wait in the same exec. Other
// providers keep the earlier exec sequence. Commands run in a real local shell.
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { startAdapterExecutionTargetPaperclipBridge, type AdapterSandboxExecutionTarget } from "./execution-target.js";
import { startSandboxCallbackBridgeServer } from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

type ExecInput = { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number };

function createLocalRunner() {
  const scripts: string[] = [];
  return {
    scripts,
    execute: async (input: ExecInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const args = [...(input.args ?? [])];
      scripts.push(args[1] ?? "");
      const env: Record<string, string | undefined> = { ...process.env, ...input.env };
      if (input.stdin != null && args[0] === "-c") {
        env.PAPERCLIP_TEST_STDIN = input.stdin;
        args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
      }
      try {
        const result = await execFile(input.command === "bash" ? "/bin/bash" : "/bin/sh", args, {
          cwd: input.cwd,
          env,
          maxBuffer: 32 * 1024 * 1024,
          timeout: input.timeoutMs,
        });
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
      } catch (error) {
        const failed = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failed.code === "number" ? failed.code : 1,
          signal: null,
          timedOut: failed.killed === true,
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? "",
          pid: null,
          startedAt,
        };
      }
    },
  };
}

const isStart = (script: string) => script.includes("nohup ");
const isReadinessOnly = (script: string) => !isStart(script) && script.includes("Timed out waiting for bridge readiness.");
const isQueueMkdirOnly = (script: string) => /^mkdir -p '[^']*queue'/.test(script) && !isStart(script);

describe("sandbox file bridge startup execs (TECH-8174)", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
  });

  async function startBridge(providerKey: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-fold-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const remoteCwd = path.join(root, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "hermes");
    await mkdir(runtimeRootDir, { recursive: true });
    const requests: string[] = [];
    const api = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => api.close(() => resolve())));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const runner = createLocalRunner();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey,
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
      streamRunLogs: false,
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-fold",
      target,
      runtimeRootDir,
      adapterKey: "hermes",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    cleanups.push(async () => {
      await bridge?.stop();
    });
    // Snapshot the startup execs before any request traffic.
    const startupScripts = [...runner.scripts];
    const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`, accept: "application/json" },
    });
    return { startupScripts, response, requests };
  }

  it("Kubernetes: no separate queue mkdir exec and readiness inside the start exec, and the bridge serves requests", async () => {
    const { startupScripts, response, requests } = await startBridge("kubernetes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toEqual(["GET /api/agents/me Bearer real-run-jwt"]);

    expect(startupScripts.filter(isQueueMkdirOnly)).toHaveLength(0);
    const starts = startupScripts.filter(isStart);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("Timed out waiting for bridge readiness.");
    expect(startupScripts.filter(isReadinessOnly)).toHaveLength(0);
    // The bridge token never rides the exec command.
    expect(starts[0]).not.toContain("real-run-jwt");
  });

  it("other providers keep the separate queue mkdir, start and readiness execs", async () => {
    const { startupScripts, response } = await startBridge("e2b");
    expect(response.status).toBe(200);
    expect(startupScripts.filter(isQueueMkdirOnly)).toHaveLength(1);
    const starts = startupScripts.filter(isStart);
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toContain("Timed out waiting for bridge readiness.");
    expect(startupScripts.filter(isReadinessOnly)).toHaveLength(1);
  });

  async function serverDirs() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-fold-fail-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    return { root, queueDir: path.join(root, "queue"), assetRemoteDir: path.join(root, "server") };
  }

  for (const fold of [true, false]) {
    it(`reports a bridge that dies at startup as a readiness failure with its log (fold=${fold})`, async () => {
      const { root, queueDir, assetRemoteDir } = await serverDirs();
      const runner = createLocalRunner();
      // `sh <missing entrypoint>` exits at once and writes its error to the bridge log.
      const failure = await startSandboxCallbackBridgeServer({
        runner,
        remoteCwd: root,
        assetRemoteDir,
        queueDir,
        bridgeToken: "bridge-token",
        nodeCommand: "sh",
        timeoutMs: 20_000,
        foldReadinessIntoStart: fold,
      }).then(() => null, (error: Error) => error);
      expect(failure?.message).toMatch(/^wait for sandbox callback bridge readiness failed with exit code 1: /);
      expect(failure?.message).toMatch(/entrypoint|No such file|not found|can't open/i);
      expect(failure?.message).not.toContain("__PAPERCLIP_BRIDGE_STARTED_");
      expect(runner.scripts).toHaveLength(fold ? 1 : 2);
    });
  }

  it("reports a failed start exec as a start failure, not a readiness failure (fold)", async () => {
    const { root, queueDir, assetRemoteDir } = await serverDirs();
    const scripts: string[] = [];
    const runner = {
      execute: async (input: ExecInput): Promise<RunProcessResult> => {
        scripts.push(input.args?.[1] ?? "");
        return { exitCode: 2, signal: null, timedOut: false, stdout: "", stderr: "sh: cannot create queue", pid: null, startedAt: new Date().toISOString() };
      },
    };
    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: root,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      timeoutMs: 20_000,
      foldReadinessIntoStart: true,
    })).rejects.toThrow(/^start sandbox callback bridge failed with exit code 2: sh: cannot create queue$/);
    expect(scripts).toHaveLength(1);
  });
});
