import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { prepareCommandManagedRuntime } from "./command-managed-runtime.js";
import {
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

describe("sandbox callback bridge", () => {
  const cleanupDirs: string[] = [];
  const cleanupFns: Array<() => Promise<void>> = [];

  function createExecRunner() {
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }): Promise<RunProcessResult> => {
        const startedAt = new Date().toISOString();
        const env = {
          ...process.env,
          ...input.env,
        };
        const command = input.command === "sh" ? "/bin/sh" : input.command;
        const args = [...(input.args ?? [])];
        if (input.stdin != null && input.command === "sh" && args[0] === "-lc" && typeof args[1] === "string") {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' \"$PAPERCLIP_TEST_STDIN\" | (${args[1]})`;
        }
        try {
          const result = await execFile(command, args, {
            cwd: input.cwd,
            env,
            maxBuffer: 32 * 1024 * 1024,
            timeout: input.timeoutMs,
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: result.stdout,
            stderr: result.stderr,
            pid: null,
            startedAt,
          };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number | null;
            signal?: NodeJS.Signals | null;
            killed?: boolean;
          };
          return {
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: err.signal ?? null,
            timedOut: Boolean(err.killed && input.timeoutMs),
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            pid: null,
            startedAt,
          };
        }
      },
    };
  }

  async function waitForJsonFile(directory: string, timeoutMs = 2_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await readdir(directory).catch(() => []);
      const match = entries.find((entry) => entry.endsWith(".json"));
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for a JSON file in ${directory}.`);
  }

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("round-trips localhost bridge requests over the sandbox queue without forwarding the bridge token", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-runtime-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge test\n", "utf8");

    const runner = createExecRunner();

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [
        {
          key: "bridge",
          localDir: bridgeAsset.localDir,
        },
      ],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();
    const seenRequests: Array<{
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      body: string;
    }> = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async (request) =>
        request.path === "/api/agents/me" ? null : `Route not allowed: ${request.method} ${request.path}`,
      handleRequest: async (request) => {
        seenRequests.push({
          method: request.method,
          path: request.path,
          query: request.query,
          headers: request.headers,
          body: request.body,
        });
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"bridge-rev-1"',
            "last-modified": "Tue, 01 Apr 2025 00:00:00 GMT",
          },
          body: JSON.stringify({
            ok: true,
            method: request.method,
            path: request.path,
          }),
        };
      },
    });
    cleanupFns.push(async () => {
      await worker.stop();
    });

    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const okResponse = await fetch(`${bridge.baseUrl}/api/agents/me?view=compact`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        accept: "application/json",
        "if-none-match": '"client-cache-key"',
        "x-paperclip-run-id": "run-bridge-1",
        "x-bridge-debug": "drop-me",
      },
    });
    expect(okResponse.status).toBe(200);
    expect(okResponse.headers.get("content-type")).toContain("application/json");
    expect(okResponse.headers.get("etag")).toBe('"bridge-rev-1"');
    expect(okResponse.headers.get("last-modified")).toBe("Tue, 01 Apr 2025 00:00:00 GMT");
    await expect(okResponse.json()).resolves.toMatchObject({
      ok: true,
      method: "GET",
      path: "/api/agents/me",
    });

    const deniedResponse = await fetch(`${bridge.baseUrl}/api/issues/issue-1`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.json()).resolves.toMatchObject({
      error: "Route not allowed: PATCH /api/issues/issue-1",
    });

    const unauthorizedResponse = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: "Bearer wrong-token",
      },
    });
    expect(unauthorizedResponse.status).toBe(401);
    await expect(unauthorizedResponse.json()).resolves.toMatchObject({
      error: "Invalid bridge token.",
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]).toMatchObject({
      method: "GET",
      path: "/api/agents/me",
      query: "?view=compact",
      body: "",
      headers: {
        accept: "application/json",
        "if-none-match": '"client-cache-key"',
      },
    });
    expect(seenRequests[0]?.headers.authorization).toBeUndefined();
    expect(seenRequests[0]?.headers["x-paperclip-run-id"]).toBeUndefined();

  });

  it("denies non-allowlisted requests by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-default-policy-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    let handled = 0;

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      handleRequest: async () => {
        handled += 1;
        return {
          status: 200,
          body: "should not happen",
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-1.json"),
      `${JSON.stringify({
        id: "req-1",
        method: "DELETE",
        path: "/api/secrets",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await worker.stop({ drainTimeoutMs: 1_000 });

    const response = JSON.parse(
      await readFile(path.posix.join(directories.responsesDir, "req-1.json"), "utf8"),
    ) as { status: number; body: string };
    expect(handled).toBe(0);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "Route not allowed: DELETE /api/secrets",
    });
  });

  it("drains already-queued requests on stop", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-drain-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const processed: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        processed.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          status: 200,
          body: request.id,
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-a.json"),
      `${JSON.stringify({
        id: "req-a",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.posix.join(directories.requestsDir, "req-b.json"),
      `${JSON.stringify({
        id: "req-b",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await worker.stop({ drainTimeoutMs: 1_000 });

    expect(processed).toEqual(["req-a", "req-b"]);
    await expect(readFile(path.posix.join(directories.responsesDir, "req-a.json"), "utf8")).resolves.toContain("\"req-a\"");
    await expect(readFile(path.posix.join(directories.responsesDir, "req-b.json"), "utf8")).resolves.toContain("\"req-b\"");
  });

  it("writes fast 503 responses for queued requests that miss the drain deadline", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-drain-timeout-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const processed: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        processed.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          status: 200,
          body: request.id,
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-a.json"),
      `${JSON.stringify({
        id: "req-a",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.posix.join(directories.requestsDir, "req-b.json"),
      `${JSON.stringify({
        id: "req-b",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    for (let attempt = 0; attempt < 50 && processed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await worker.stop({ drainTimeoutMs: 10 });

    expect(processed).toEqual(["req-a"]);
    await expect(readFile(path.posix.join(directories.responsesDir, "req-a.json"), "utf8")).resolves.toContain("\"req-a\"");
    await expect(readFile(path.posix.join(directories.responsesDir, "req-b.json"), "utf8")).resolves.toContain(
      "Bridge worker stopped before request could be handled.",
    );
  });

  it("rejects non-JSON request bodies and full queues at the bridge server", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-server-guards-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge guard test\n", "utf8");

    const runner = createExecRunner();

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();

    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      maxQueueDepth: 1,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "existing.json"),
      `${JSON.stringify({
        id: "existing",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const queueFullResponse = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });
    expect(queueFullResponse.status).toBe(503);
    await expect(queueFullResponse.json()).resolves.toEqual({
      error: "Bridge request queue is full.",
    });

    await rm(path.posix.join(directories.requestsDir, "existing.json"), { force: true });

    const nonJsonResponse = await fetch(`${bridge.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "content-type": "text/plain",
      },
      body: "not json",
    });
    expect(nonJsonResponse.status).toBe(415);
    await expect(nonJsonResponse.json()).resolves.toEqual({
      error: "Bridge only accepts JSON request bodies.",
    });
  });

  it("returns a 502 when the host response times out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-timeout-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge timeout test\n", "utf8");

    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const bridgeToken = createSandboxCallbackBridgeToken();
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
      responseTimeoutMs: 75,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const response = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Timed out waiting for host bridge response.",
    });
  });

  it("returns a 502 for malformed host response files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-malformed-response-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge malformed response test\n", "utf8");

    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
      responseTimeoutMs: 1_000,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const responsePromise = fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    const requestFile = await waitForJsonFile(directories.requestsDir);
    await writeFile(
      path.posix.join(directories.responsesDir, requestFile),
      '{"status":200,"headers":{"content-type":"application/json"},"body"',
      "utf8",
    );

    const response = await responsePromise;
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/JSON|Unexpected|Unterminated/i),
    });
  });
});
