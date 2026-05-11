import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareCommandManagedRuntime } from "./command-managed-runtime.js";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  sandboxCallbackBridgeDirectories,
  syncSandboxCallbackBridgeEntrypoint,
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
        const command =
          input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const args = [...(input.args ?? [])];
        if (
          input.stdin != null &&
          (input.command === "sh" || input.command === "bash") &&
          (args[0] === "-c" || args[0] === "-lc") &&
          typeof args[1] === "string"
        ) {
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

  it("handles SSH queue polling failures without emitting an unhandled rejection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-ssh-failure-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const worker = await startSandboxCallbackBridgeWorker({
        client: {
          makeDir: async () => {},
          listJsonFiles: async () => {
            throw new Error(
              "list /remote/.paperclip-runtime/gemini/paperclip-bridge/queue/requests failed with exit code 255: kex_exchange_identification: read: Connection reset by peer",
            );
          },
          readTextFile: async () => {
            throw new Error("unexpected readTextFile");
          },
          writeTextFile: async () => {
            throw new Error("unexpected writeTextFile");
          },
          rename: async () => {
            throw new Error("unexpected rename");
          },
          remove: async () => {},
        },
        queueDir,
        authorizeRequest: async () => null,
        handleRequest: async () => ({
          status: 200,
          body: "ok",
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await worker.stop();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("serializes remote response writes so stop does not recreate a late orphaned response", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-response-lock-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge response lock test\n", "utf8");

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
    const seenRequestIds: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createCommandManagedSandboxCallbackBridgeQueueClient({
        runner,
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      }),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        seenRequestIds.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, id: request.id }),
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

    const responsePromise = fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    for (let attempt = 0; attempt < 50 && seenRequestIds.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(seenRequestIds).toHaveLength(1);
    await worker.stop({ drainTimeoutMs: 10 });

    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Bridge worker stopped before request could be handled.",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(readdir(directories.responsesDir)).resolves.toEqual([]);
    await expect(
      readdir(directories.responsesDir).then((entries) =>
        entries.filter((entry) => entry.endsWith(".tmp") || entry.includes(".paperclip-write.lock")),
      ),
    ).resolves.toEqual([]);
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

  it("reuses an already-uploaded bridge entrypoint when the remote file hash matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-sync-"));
    cleanupDirs.push(rootDir);

    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const remoteAssetDir = path.posix.join(
      remoteWorkspaceDir,
      ".paperclip-runtime",
      "codex",
      "paperclip-bridge",
      "server",
    );
    await mkdir(remoteWorkspaceDir, { recursive: true });

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const originalSource = await readFile(bridgeAsset.entrypoint, "utf8");
    const expandedSource = `${originalSource}\n// bridge payload padding\n`;
    await writeFile(bridgeAsset.entrypoint, expandedSource, "utf8");

    const runner = createExecRunner();

    const first = await syncSandboxCallbackBridgeEntrypoint({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: remoteAssetDir,
      bridgeAsset,
      timeoutMs: 30_000,
    });
    const second = await syncSandboxCallbackBridgeEntrypoint({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: remoteAssetDir,
      bridgeAsset,
      timeoutMs: 30_000,
    });

    expect(first.uploaded).toBe(true);
    expect(second.uploaded).toBe(false);
    await expect(readFile(path.posix.join(remoteAssetDir, "paperclip-bridge-server.mjs"), "utf8")).resolves.toBe(expandedSource);
    await expect(
      readdir(remoteAssetDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-bridge-upload.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("rejects a corrupted bridge entrypoint upload without committing a torn remote file", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-sync-corrupt-"));
    cleanupDirs.push(rootDir);

    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const remoteAssetDir = path.posix.join(
      remoteWorkspaceDir,
      ".paperclip-runtime",
      "codex",
      "paperclip-bridge",
      "server",
    );
    await mkdir(remoteWorkspaceDir, { recursive: true });

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }) =>
        await createExecRunner().execute({
          ...input,
          stdin: input.stdin != null ? "" : input.stdin,
        }),
    };

    await expect(
      syncSandboxCallbackBridgeEntrypoint({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir: remoteAssetDir,
        bridgeAsset,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/sha mismatch/i);

    await expect(readFile(path.posix.join(remoteAssetDir, "paperclip-bridge-server.mjs"), "utf8")).rejects.toThrow();
    await expect(
      readdir(remoteAssetDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-bridge-upload.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("permits the documented heartbeat surface and denies unrelated routes", () => {
    const allowed: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/api/agents/me" },
      { method: "GET", path: "/api/agents/me/inbox-lite" },
      { method: "GET", path: "/api/agents/me/inbox/mine" },
      { method: "GET", path: "/api/agents/agent-1" },
      { method: "GET", path: "/api/agents/agent-1/skills" },
      { method: "POST", path: "/api/agents/agent-1/skills/sync" },
      { method: "PATCH", path: "/api/agents/agent-1/instructions-path" },
      { method: "GET", path: "/api/companies/co-1" },
      { method: "GET", path: "/api/companies/co-1/dashboard" },
      { method: "GET", path: "/api/companies/co-1/agents" },
      { method: "GET", path: "/api/companies/co-1/issues" },
      { method: "GET", path: "/api/companies/co-1/projects" },
      { method: "GET", path: "/api/companies/co-1/goals" },
      { method: "GET", path: "/api/companies/co-1/org" },
      { method: "GET", path: "/api/companies/co-1/approvals" },
      { method: "GET", path: "/api/companies/co-1/routines" },
      { method: "GET", path: "/api/companies/co-1/skills" },
      { method: "GET", path: "/api/projects/proj-1" },
      { method: "GET", path: "/api/goals/goal-1" },
      { method: "GET", path: "/api/issues/issue-1" },
      { method: "GET", path: "/api/issues/issue-1/heartbeat-context" },
      { method: "GET", path: "/api/issues/issue-1/comments" },
      { method: "GET", path: "/api/issues/issue-1/comments/c-1" },
      { method: "POST", path: "/api/issues/issue-1/comments" },
      { method: "GET", path: "/api/issues/issue-1/documents" },
      { method: "GET", path: "/api/issues/issue-1/documents/plan" },
      { method: "GET", path: "/api/issues/issue-1/documents/plan/revisions" },
      { method: "PUT", path: "/api/issues/issue-1/documents/plan" },
      { method: "POST", path: "/api/issues/issue-1/checkout" },
      { method: "POST", path: "/api/issues/issue-1/release" },
      { method: "PATCH", path: "/api/issues/issue-1" },
      { method: "GET", path: "/api/issues/issue-1/approvals" },
      { method: "GET", path: "/api/issues/issue-1/interactions" },
      { method: "GET", path: "/api/issues/issue-1/interactions/inter-1" },
      { method: "POST", path: "/api/issues/issue-1/interactions" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/accept" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/reject" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/respond" },
      { method: "POST", path: "/api/companies/co-1/issues" },
      { method: "GET", path: "/api/approvals/ap-1" },
      { method: "GET", path: "/api/approvals/ap-1/issues" },
      { method: "GET", path: "/api/approvals/ap-1/comments" },
      { method: "POST", path: "/api/approvals/ap-1/comments" },
      { method: "POST", path: "/api/companies/co-1/approvals" },
      { method: "GET", path: "/api/execution-workspaces/ws-1" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/start" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/stop" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/restart" },
      { method: "GET", path: "/api/routines/r-1" },
      { method: "GET", path: "/api/routines/r-1/runs" },
      { method: "POST", path: "/api/companies/co-1/routines" },
      { method: "PATCH", path: "/api/routines/r-1" },
      { method: "POST", path: "/api/routines/r-1/run" },
      { method: "POST", path: "/api/routines/r-1/triggers" },
      { method: "PATCH", path: "/api/routine-triggers/t-1" },
      { method: "DELETE", path: "/api/routine-triggers/t-1" },
    ];
    for (const request of allowed) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request)).toBeNull();
    }

    const denied: Array<{ method: string; path: string }> = [
      { method: "DELETE", path: "/api/secrets" },
      // Pin the runtime-services regex to start/stop/restart only — anything
      // else (delete, reset, wipe, etc.) must stay denied even if the API
      // grows new actions later.
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/delete" },
      { method: "POST", path: "/api/companies/co-1/agents" },
      { method: "POST", path: "/api/agents/agent-1/pause" },
      { method: "POST", path: "/api/agents/agent-1/terminate" },
      { method: "POST", path: "/api/agents/agent-1/keys" },
      { method: "POST", path: "/api/companies/co-1/exports" },
      { method: "POST", path: "/api/companies/co-1/imports/apply" },
      { method: "POST", path: "/api/companies/co-1/archive" },
      { method: "DELETE", path: "/api/issues/issue-1/documents/plan" },
      { method: "DELETE", path: "/api/issues/issue-1/approvals/ap-1" },
      { method: "POST", path: "/api/approvals/ap-1/approve" },
      { method: "POST", path: "/api/approvals/ap-1/reject" },
      { method: "POST", path: "/api/companies/co-1/logo" },
      { method: "GET", path: "/api/companies/co-1/secrets" },
      { method: "PATCH", path: "/api/secrets/secret-1" },
    ];
    for (const request of denied) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request)).toBe(
        `Route not allowed: ${request.method} ${request.path}`,
      );
    }
  });

  it("marks command-managed bridge operations with the bridge execution channel", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
    });

    await client.makeDir("/workspace/.paperclip-runtime/codex/paperclip-bridge/queue");

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
    }));
  });
});
