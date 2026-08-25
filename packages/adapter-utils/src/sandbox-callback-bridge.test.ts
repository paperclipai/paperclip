import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getActiveStepContext, measureStartupStep } from "./acpx-engine/startup-timing.js";
import { prepareCommandManagedRuntime } from "./command-managed-runtime.js";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  getSandboxCallbackBridgeServerSource,
  sandboxCallbackBridgeDirectories,
  syncRemoteTextFileWithHashSkip,
  syncSandboxCallbackBridgeEntrypoint,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import type { SandboxCallbackBridgeQueueClient } from "./sandbox-callback-bridge.js";
import type { RuntimeSpanRunner } from "./acpx-engine/startup-timing.js";
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
          makeDirs: async () => {},
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

  it("recovers from transient queue polling failures and keeps relaying requests", async () => {
    // A single reset or slow sandbox exec used to unwind the poll loop into its
    // terminal catch, killing the relay for the rest of the run. The loop must
    // instead back off, retry, and still deliver requests queued after the
    // failure window.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-transient-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const baseClient = createFileSystemSandboxCallbackBridgeQueueClient();
    let listCalls = 0;
    const client: SandboxCallbackBridgeQueueClient = {
      ...baseClient,
      listJsonFiles: async (dirPath: string) => {
        listCalls += 1;
        if (listCalls <= 3) {
          throw new Error("list requests failed: kex_exchange_identification: read: Connection reset by peer");
        }
        return baseClient.listJsonFiles(dirPath);
      },
    };

    const seenPaths: string[] = [];
    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        seenPaths.push(request.path);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        };
      },
    });
    cleanupFns.push(async () => {
      await worker.stop();
    });

    const requestId = "transient-recovery-1";
    await writeFile(
      path.join(directories.requestsDir, `${requestId}.json`),
      JSON.stringify({
        id: requestId,
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
      }),
      "utf8",
    );

    const responseFile = await waitForJsonFile(directories.responsesDir, 10_000);
    const raw = await readFile(path.join(directories.responsesDir, responseFile), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ id: requestId, status: 200 });
    expect(seenPaths).toEqual(["/api/agents/me"]);
    expect(listCalls).toBeGreaterThan(3);
  });

  it("keeps the queue-directory setup on the startup step but resets the poll loop store", async () => {
    // The worker starts inside the measured `bridge.paperclip` step. Its awaited
    // queue-directory setup is startup work, so a `makeDir` `sandbox.exec` span
    // must keep the active step and its `criticalPath` flag. The long-lived poll
    // loop runs run-time execs for the whole run, so a loop `sandbox.exec` span
    // must open unparented with no stale flag. This test reads the active step in
    // both places and proves the boundary sits at the loop, not the whole worker.
    let setupStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let loopStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolveFirstPoll: () => void = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve;
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-step-store-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.posix.join(rootDir, "queue");

    const worker = await measureStartupStep(
      {},
      () => 0,
      "bridge.paperclip",
      () =>
        startSandboxCallbackBridgeWorker({
          client: {
            makeDir: async () => {
              setupStep = getActiveStepContext();
            },
            makeDirs: async () => {
              setupStep = getActiveStepContext();
            },
            listJsonFiles: async () => {
              loopStep = getActiveStepContext();
              resolveFirstPoll();
              return [];
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
          handleRequest: async () => ({ status: 200, body: "ok" }),
        }),
      { criticalPath: false },
    );

    await firstPoll;
    await worker.stop();

    // The setup ran on the active step, so its exec span parents to the step.
    expect(setupStep).not.toBe("unset");
    expect(setupStep).not.toBeNull();
    expect((setupStep as { criticalPath?: boolean }).criticalPath).toBe(false);

    // The loop ran outside that store, so its exec span opens unparented with no
    // stale `criticalPath` flag.
    expect(loopStep).toBeNull();
  });

  it("test_paperclip_loop_exec_parents_to_run_context", async () => {
    // The worker starts inside the measured `bridge.paperclip` step. Its awaited
    // queue-directory setup is startup work and keeps the active step. The poll
    // loop shell stays outside that store. But a per-request unit of work is
    // run-time work, so the worker runs each request under the current-run
    // parent context. A request `sandbox.exec` span then parents to the live run
    // span, not to the ended startup step. This test drives the worker with a
    // `getRuntimeParentContext` that returns a known token, queues one request,
    // and proves the request work reads that token from the active step store.
    const runParentToken = { marker: "run-parent-token" };
    let setupStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let requestStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let served = false;
    let resolveServed: () => void = () => {};
    const requestServed = new Promise<void>((resolve) => {
      resolveServed = resolve;
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-run-parent-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.posix.join(rootDir, "queue");

    const worker = await measureStartupStep(
      {},
      () => 0,
      "bridge.paperclip",
      () =>
        startSandboxCallbackBridgeWorker({
          client: {
            makeDir: async () => {
              setupStep = getActiveStepContext();
            },
            makeDirs: async () => {
              setupStep = getActiveStepContext();
            },
            // Return one request on the first poll, then nothing.
            listJsonFiles: async () => (served ? [] : ["000000000001.json"]),
            readTextFile: async () =>
              JSON.stringify({ id: "req-1", method: "GET", path: "/", query: "", headers: {}, body: "" }),
            writeTextFile: async () => {},
            rename: async () => {},
            remove: async () => {},
          },
          queueDir,
          authorizeRequest: async () => null,
          handleRequest: async () => {
            requestStep = getActiveStepContext();
            served = true;
            resolveServed();
            return { status: 200, body: "ok" };
          },
          getRuntimeParentContext: () => runParentToken,
        }),
      { criticalPath: false },
    );

    await requestServed;
    await worker.stop();

    // The setup ran on the active step, so its exec span parents to the step.
    expect(setupStep).not.toBe("unset");
    expect(setupStep).not.toBeNull();

    // The request work ran under the run parent context. Its exec span parents
    // to the run token, not to the ended startup step, and it carries no
    // startup `criticalPath` flag.
    expect(requestStep).not.toBe("unset");
    expect(requestStep).not.toBeNull();
    expect((requestStep as { parentContext?: unknown }).parentContext).toBe(runParentToken);
    expect((requestStep as { criticalPath?: boolean }).criticalPath).toBe(false);
  });

  it("wraps each request in a sandbox.callbackBridge.relayRequest span", async () => {
    // With a span runner injected, the worker wraps each request in one
    // `sandbox.callbackBridge.relayRequest` span, so the request's read, write,
    // and remove execs group under one named span. This test drives the worker
    // with a recording runner and proves it opens the wrapper span around the
    // request work.
    const wrapped: string[] = [];
    let served = false;
    let resolveServed: () => void = () => {};
    const requestServed = new Promise<void>((resolve) => {
      resolveServed = resolve;
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-relay-span-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.posix.join(rootDir, "queue");

    const worker = await startSandboxCallbackBridgeWorker({
      client: {
        makeDir: async () => {},
        makeDirs: async () => {},
        listJsonFiles: async () => (served ? [] : ["000000000001.json"]),
        readTextFile: async () =>
          JSON.stringify({ id: "req-1", method: "GET", path: "/", query: "", headers: {}, body: "" }),
        writeTextFile: async () => {},
        rename: async () => {},
        remove: async () => {},
      },
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async () => {
        served = true;
        resolveServed();
        return { status: 200, body: "ok" };
      },
      // Record each wrapper span name, then run the wrapped work.
      runtimeSpan: async (name, work) => {
        wrapped.push(name);
        return work();
      },
    });

    await requestServed;
    await worker.stop();

    expect(wrapped).toContain("sandbox.callbackBridge.relayRequest");
  });

  it("test_paperclip_loop_exec_stays_unparented_without_getter", async () => {
    // With no `getRuntimeParentContext`, a request runs with an empty active
    // step store, exactly like the earlier `runWithoutActiveStep` behavior. So a
    // request `sandbox.exec` span opens unparented with no stale startup flag.
    let requestStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let served = false;
    let resolveServed: () => void = () => {};
    const requestServed = new Promise<void>((resolve) => {
      resolveServed = resolve;
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-no-getter-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.posix.join(rootDir, "queue");

    const worker = await measureStartupStep(
      {},
      () => 0,
      "bridge.paperclip",
      () =>
        startSandboxCallbackBridgeWorker({
          client: {
            makeDir: async () => {},
            makeDirs: async () => {},
            listJsonFiles: async () => (served ? [] : ["000000000001.json"]),
            readTextFile: async () =>
              JSON.stringify({ id: "req-1", method: "GET", path: "/", query: "", headers: {}, body: "" }),
            writeTextFile: async () => {},
            rename: async () => {},
            remove: async () => {},
          },
          queueDir,
          authorizeRequest: async () => null,
          handleRequest: async () => {
            requestStep = getActiveStepContext();
            served = true;
            resolveServed();
            return { status: 200, body: "ok" };
          },
        }),
      { criticalPath: false },
    );

    await requestServed;
    await worker.stop();

    expect(requestStep).toBeNull();
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

  // The process-session remote script is a static, Paperclip-authored `.mjs`
  // written into the sandbox on every bridge start. `syncRemoteTextFileWithHashSkip`
  // (which now backs that write, mirroring the bridge-entrypoint sha256 gate)
  // content-hash-skips it so a warm start where the remote script already matches
  // costs ZERO write execs instead of the prior ~3 (prepare/append/finalize base64
  // upload).
  it("test_process_session_script_skipped_when_remote_hash_matches: warm start with a matching remote hash writes 0 execs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-warm-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");
    const body = "console.log('process session remote script v1');\n";

    let execCount = 0;
    const inner = createExecRunner();
    const runner = {
      execute: async (input: Parameters<typeof inner.execute>[0]) => {
        execCount += 1;
        return inner.execute(input);
      },
    };
    const args = {
      runner,
      remoteCwd: rootDir,
      remoteDir,
      remotePath,
      body,
      label: "Process session remote script",
      action: "sync process session remote script",
      lockDir,
      timeoutMs: 30_000,
    } as const;

    // Cold start: the script is uploaded (single sha-gate exec that writes).
    const first = await syncRemoteTextFileWithHashSkip(args);
    expect(first.uploaded).toBe(true);
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);

    // Warm start: the remote hash matches, so the write is skipped entirely.
    execCount = 0;
    const second = await syncRemoteTextFileWithHashSkip(args);
    expect(second.uploaded).toBe(false);
    // A single hash-gate round-trip that performed 0 writes (down from ~3 execs).
    expect(execCount).toBe(1);
    // sha is still returned on the skip path so callers get a well-formed result.
    expect(second.sha256).toBe(first.sha256);
    // The remote file is unchanged and no upload/partial/lock leftovers remain.
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);
    await expect(
      readdir(remoteDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-process-session-script.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("test_process_session_script_rewritten_on_hash_mismatch: a mismatched remote hash still rewrites the script", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-cold-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");
    const body = "console.log('process session remote script v2');\n";

    // Pre-seed the remote with a DIFFERENT script (a prior/stale build).
    await mkdir(remoteDir, { recursive: true });
    await writeFile(remotePath, "console.log('stale remote script');\n", "utf8");

    const result = await syncRemoteTextFileWithHashSkip({
      runner: createExecRunner(),
      remoteCwd: rootDir,
      remoteDir,
      remotePath,
      body,
      label: "Process session remote script",
      action: "sync process session remote script",
      lockDir,
      timeoutMs: 30_000,
    });

    expect(result.uploaded).toBe(true);
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);
  });

  it("fails loud when the hash-skip sync exec errors instead of silently re-uploading", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-fail-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");

    // A runner whose exec fails: the hash-gate cannot be evaluated. The write
    // must surface the failure, never swallow it and re-upload behind a green
    // return value.
    const runner = {
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "hash gate boom",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    };

    await expect(
      syncRemoteTextFileWithHashSkip({
        runner,
        remoteCwd: rootDir,
        remoteDir,
        remotePath,
        body: "console.log('never written');\n",
        label: "Process session remote script",
        action: "sync process session remote script",
        lockDir,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/sync process session remote script/i);

    // Nothing was written to the remote path on the failure path.
    await expect(readFile(remotePath, "utf8")).rejects.toThrow();
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
      // Hire skill (paperclip-create-agent): discovery + submit + issue linking
      { method: "GET", path: "/llms/agent-configuration.txt" },
      { method: "GET", path: "/llms/agent-configuration/claude_local.txt" },
      { method: "GET", path: "/llms/agent-icons.txt" },
      { method: "GET", path: "/api/companies/co-1/agent-configurations" },
      { method: "POST", path: "/api/companies/co-1/agent-hires" },
      { method: "POST", path: "/api/issues/issue-1/approvals" },
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
      { method: "GET", path: "/api/issues/issue-1/work-products" },
      { method: "POST", path: "/api/issues/issue-1/work-products" },
      { method: "PATCH", path: "/api/work-products/wp-1" },
      { method: "GET", path: "/api/issues/issue-1/interactions" },
      { method: "GET", path: "/api/issues/issue-1/interactions/inter-1" },
      { method: "POST", path: "/api/issues/issue-1/interactions" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/accept" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/reject" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/respond" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/verdicts" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/withdraw" },
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
      // The hire allowlist must not over-match: only the exact .txt discovery
      // files, only agent-hires (not /agents), and no sub-resources beyond it.
      { method: "GET", path: "/llms/agent-configuration" },
      { method: "GET", path: "/llms/secrets.txt" },
      { method: "POST", path: "/api/companies/co-1/agent-hires/ap-1" },
      { method: "POST", path: "/api/issues/issue-1/approvals/ap-1" },
      { method: "POST", path: "/api/agents/agent-1/pause" },
      { method: "POST", path: "/api/agents/agent-1/terminate" },
      { method: "POST", path: "/api/agents/agent-1/keys" },
      { method: "POST", path: "/api/companies/co-1/exports" },
      { method: "POST", path: "/api/companies/co-1/imports/apply" },
      { method: "POST", path: "/api/companies/co-1/archive" },
      { method: "DELETE", path: "/api/issues/issue-1/documents/plan" },
      { method: "DELETE", path: "/api/issues/issue-1/approvals/ap-1" },
      { method: "DELETE", path: "/api/work-products/wp-1" },
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

  it("creates the bridge queue directories in one directory-creation exec", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-makedirs-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const makeDir = vi.fn(async () => {});
    const makeDirs = vi.fn(async () => {});

    const worker = await startSandboxCallbackBridgeWorker({
      client: {
        makeDir,
        makeDirs,
        listJsonFiles: async () => [],
        readTextFile: async () => {
          throw new Error("unexpected readTextFile");
        },
        writeTextFile: async () => {},
        rename: async () => {},
        remove: async () => {},
      },
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    await worker.stop();

    expect(makeDir).not.toHaveBeenCalled();
    expect(makeDirs).toHaveBeenCalledTimes(1);
    expect(makeDirs).toHaveBeenCalledWith([
      directories.rootDir,
      directories.requestsDir,
      directories.responsesDir,
      directories.logsDir,
    ]);
  });

  it("falls back to sequential makeDir when the queue client omits makeDirs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-makedir-fallback-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const makeDir = vi.fn(async (_remotePath: string) => {});

    // A queue client that predates the batched makeDirs method. The worker
    // must still create every queue directory through sequential makeDir.
    const worker = await startSandboxCallbackBridgeWorker({
      client: {
        makeDir,
        listJsonFiles: async () => [],
        readTextFile: async () => {
          throw new Error("unexpected readTextFile");
        },
        writeTextFile: async () => {},
        rename: async () => {},
        remove: async () => {},
      },
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    await worker.stop();

    expect(makeDir.mock.calls.map((call) => call[0])).toEqual([
      directories.rootDir,
      directories.requestsDir,
      directories.responsesDir,
      directories.logsDir,
    ]);
  });

  it("runs one mkdir -p exec for makeDirs on the command-managed queue client", async () => {
    const runner = {
      execute: vi.fn(async (_input: { args?: string[] }) => ({
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

    // The command-managed client always provides the batched makeDirs method.
    expect(client.makeDirs).toBeDefined();
    await client.makeDirs?.(["/workspace/a", "/workspace/b", "/workspace/c"]);

    expect(runner.execute).toHaveBeenCalledTimes(1);
    const call = runner.execute.mock.calls[0][0];
    const script = call.args?.[call.args.length - 1] ?? "";
    expect(script).toContain("mkdir -p");
    expect(script).toContain("/workspace/a");
    expect(script).toContain("/workspace/b");
    expect(script).toContain("/workspace/c");
  });

  // Capture the run-level error the worker surfaces through `runtimeSpan`. The
  // worker runs a throwing function under the `sandbox.callbackBridge.workerFailed`
  // span; this double records that error and re-throws, like the real runner.
  function createWorkerErrorCapture(): {
    runtimeSpan: RuntimeSpanRunner;
    workerErrors: string[];
  } {
    const workerErrors: string[] = [];
    const runtimeSpan: RuntimeSpanRunner = async (name, work) => {
      try {
        return await work();
      } catch (error) {
        if (name === "sandbox.callbackBridge.workerFailed") {
          workerErrors.push(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    };
    return { runtimeSpan, workerErrors };
  }

  function bridgeRequestJson(id: string): string {
    return `${JSON.stringify({
      id,
      method: "GET",
      path: "/api/agents/me",
      query: "",
      headers: {},
      body: "",
      createdAt: new Date().toISOString(),
    })}\n`;
  }

  it("times out a stalled poll, surfaces a run-level error, and recovers to deliver the request", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-hang-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(directories.requestsDir, { recursive: true });
    await writeFile(path.posix.join(directories.requestsDir, "req-a.json"), bridgeRequestJson("req-a"), "utf8");

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();

    const base = createFileSystemSandboxCallbackBridgeQueueClient();
    let listCalls = 0;
    const client: SandboxCallbackBridgeQueueClient = {
      ...base,
      // The first poll never resolves — a silently unresponsive sandbox channel.
      // The per-iteration timeout must convert the hang into a caught error, and
      // the loop must then back off and retry rather than die: the request never
      // reached the handler, so the retry delivers the real response. A
      // sustained outage is the watchdog's job (proven separately below), not a
      // reason to fail a request one transient hang could still serve.
      listJsonFiles: async (dir) => {
        listCalls += 1;
        if (listCalls === 1) {
          return await new Promise<string[]>(() => {});
        }
        return await base.listJsonFiles(dir);
      },
    };

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    const responseFile = await waitForJsonFile(directories.responsesDir, 3_000);
    const responseBody = await readFile(path.posix.join(directories.responsesDir, responseFile), "utf8");
    expect(JSON.parse(responseBody).status).toBe(200);
    expect(workerErrors.length).toBeGreaterThan(0);
    expect(workerErrors[0]).toContain("timed out");

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("does not abandon an in-flight handler, so a started mutation is not applied twice", async () => {
    // Prove the completion fence for a request whose handler already started. The
    // per-iteration timeout rejects the wrapper but does not stop the handler, so
    // the host operation (a mutation) is still in flight. The recovery path must
    // not write a 503 there; a 503 makes the caller retry while the original
    // mutation still completes, applying it twice. The test proves no 503 lands
    // and the handler's real response is delivered exactly once.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-late.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    // An in-memory queue client with no file-existence guards. A response write
    // always lands here, so only the completion fence controls the outcome. The
    // real filesystem and command clients add their own existence guards; this
    // client removes them, so the test isolates the fence.
    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-late"));
    const responseWrites: Array<{ path: string; status: number }> = [];
    const requestRemovals: string[] = [];

    const handlerControl: { release: (() => void) | null } = { release: null };
    let handlerCompleted = false;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler stays pending until the test releases it, well after the
      // per-iteration timeout fires. It records that it finished, so the test
      // proves the in-flight handler truly ran.
      handleRequest: () =>
        new Promise<{ status: number; body?: string }>((resolve) => {
          handlerControl.release = () => {
            handlerCompleted = true;
            resolve({ status: 200, body: "req-late" });
          };
        }),
    });

    // Wait until the per-iteration timeout surfaced a run error and the handler
    // is pending. The recovery path ran, so it already skipped the in-flight
    // request.
    await waitFor(
      () => workerErrors.some((message) => message.includes("timed out")) && handlerControl.release !== null,
      3_000,
    );
    // The recovery path wrote no 503 for the in-flight request.
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);

    // Release the handler after the timeout. It delivers the real response.
    handlerControl.release?.();
    await waitFor(() => handlerCompleted, 3_000);
    // Give the finalize write and remove time to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handlerCompleted).toBe(true);
    // The handler committed exactly one response for the request: the real 200.
    expect(responseWrites.filter((write) => write.path === responsePath)).toEqual([
      { path: responsePath, status: 200 },
    ]);
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    // The handler removed the request file exactly once, after it finalized.
    expect(requestRemovals).toEqual([requestPath]);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("aborts an in-flight handler on timeout, so a cooperating handler finalizes instead of stranding the request", async () => {
    // A handler that threads the worker signal into its work must stop when the
    // per-iteration timeout fires. It then finalizes with its own error
    // response, so the request does not strand with no response. The recovery
    // path still writes no 503 for the handler-owned request, so a started
    // mutation is not applied twice. The abort reaches the handler after the host
    // operation started, so the handler finalizes a non-retryable 504, not a
    // retryable 502; the caller then does not retry a mutation that may have
    // committed.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-abort.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-abort"));
    const responseWrites: Array<{ path: string; status: number }> = [];
    const requestRemovals: string[] = [];

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();
    let handlerAborted = false;

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler stays pending until the worker aborts the signal. It then
      // rejects, so the request finalizes with the handler's own error response.
      handleRequest: (_request, options) =>
        new Promise<{ status: number; body?: string }>((_resolve, reject) => {
          options?.signal.addEventListener("abort", () => {
            handlerAborted = true;
            reject(new Error("aborted by worker"));
          });
        }),
    });

    // The handler finalizes only after the worker aborts it. The request gets a
    // terminal response (a 502 from the handler failure), never stranded.
    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    expect(handlerAborted).toBe(true);
    expect(workerErrors.some((message) => message.includes("timed out"))).toBe(true);
    // Exactly one response landed: the handler's non-retryable 504. The recovery
    // path wrote no competing 503, and the aborted handler wrote no retryable 502.
    expect(responseWrites.filter((write) => write.path === responsePath)).toEqual([
      { path: responsePath, status: 504 },
    ]);
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);
    // The handler removed the request file after it finalized. The recovery path
    // may issue a redundant idempotent remove for the same path when the handler
    // finalized first, so assert the removal happened rather than a fixed count.
    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("finalizes an aborted handler that ignores the signal and never settles with a non-retryable 504 backstop", async () => {
    // A handler that does not thread the worker signal into its work and never
    // settles must not strand the request. The recovery path aborts the handler,
    // waits the grace, then writes a non-retryable 504 backstop, so the request
    // gets a terminal response even when the handler ignores the abort. The 504
    // is non-retryable, so the caller does not retry a mutation that may have
    // committed.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-stuck.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-stuck"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();
    let handlerStarted = false;

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      // A short grace, so the backstop fires quickly after the abort.
      abortedHandlerGraceMs: 30,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler ignores the worker signal and never settles. Without the
      // backstop, the request would stay without a response forever.
      handleRequest: () => {
        handlerStarted = true;
        return new Promise<{ status: number; body?: string }>(() => {});
      },
    });

    // The backstop writes the terminal response after the grace.
    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    expect(handlerStarted).toBe(true);
    expect(workerErrors.some((message) => message.includes("timed out"))).toBe(true);
    // Exactly one response landed: the non-retryable 504 backstop. The recovery
    // path wrote no retryable 503 or 502 for the handler-owned request.
    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    expect(requestResponses[0]?.status).toBe(504);
    const parsed = JSON.parse(requestResponses[0]!.body.trim());
    const responseBody = JSON.parse(parsed.body);
    expect(responseBody.outcome).toBe("indeterminate");
    expect(responseBody.retryable).toBe(false);
    expect(parsed.headers?.["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);
    // The backstop removed the request file, so it does not strand in the queue.
    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("finalizes a late worker-aborted handler with a non-retryable 504, so the caller does not retry a committed mutation", async () => {
    // Prove the completion status for a mutating request that the worker aborts.
    // The per-iteration timeout aborts a handler that already started its host
    // operation, so the mutation may have committed. The bridge cannot cancel a
    // host operation that is in flight. The handler completes late, after the
    // abort. Its response must be a non-retryable 504, never a retryable 502 or
    // 503; a retry of either would apply the mutation twice.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-late-abort.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-late-abort"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();
    let handlerCompletedLate = false;

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler mirrors a mutating forward that already committed on the
      // host. It rejects only after the worker aborts it, so its completion is
      // late. The mutation stays committed; the abort cannot undo it.
      handleRequest: (_request, options) =>
        new Promise<{ status: number; body?: string }>((_resolve, reject) => {
          options?.signal.addEventListener("abort", () => {
            handlerCompletedLate = true;
            reject(new Error("aborted by worker after the mutation committed"));
          });
        }),
    });

    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    expect(handlerCompletedLate).toBe(true);
    expect(workerErrors.some((message) => message.includes("timed out"))).toBe(true);

    // Exactly one response landed for the request: the non-retryable 504.
    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    expect(requestResponses[0]?.status).toBe(504);

    // The bridge wrote no retryable status for the possibly-committed mutation.
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);

    // The response marks the outcome indeterminate and non-retryable, so the
    // caller does not retry.
    const parsed = JSON.parse(requestResponses[0]?.body ?? "{}");
    expect(parsed.status).toBe(504);
    const responseBody = JSON.parse(parsed.body);
    expect(responseBody.outcome).toBe("indeterminate");
    expect(responseBody.retryable).toBe(false);
    expect(parsed.headers?.["x-paperclip-bridge-outcome"]).toBe("indeterminate");

    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("retries a failed 504 backstop write and keeps the request until it lands, so the caller is not stranded", async () => {
    // A backstop write can fail transiently, or it can exceed the iteration
    // timeout. The recovery path must not drop the request file on that failure. A
    // dropped file leaves no terminal 504 for the caller and fences out a late
    // handler, so the caller waits to its own deadline and gets a generic 502. The
    // recovery path retries the write and removes the request file only after the
    // write lands.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-retry.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-retry"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: Array<{ path: string; afterWrites: number }> = [];
    let writeAttempts = 0;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        writeAttempts += 1;
        // The first backstop write fails; the retry then succeeds.
        if (writeAttempts === 1) {
          throw new Error("simulated transient write failure");
        }
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push({ path: remotePath, afterWrites: writeAttempts });
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      // A short grace, so the backstop fires quickly after the abort.
      abortedHandlerGraceMs: 30,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler ignores the worker signal and never settles, so only the
      // backstop can finalize the request.
      handleRequest: () => new Promise<{ status: number; body?: string }>(() => {}),
    });

    // The backstop retries the write, so the terminal 504 lands after the failure.
    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    expect(requestResponses[0]?.status).toBe(504);
    // The write failed once, so the backstop wrote on a later attempt.
    expect(writeAttempts).toBeGreaterThanOrEqual(2);
    // The recovery path removed the request file only after the write landed. The
    // failed first attempt kept the file, so the request never dropped with no
    // response.
    const requestPathRemovals = requestRemovals.filter((entry) => entry.path === requestPath);
    expect(requestPathRemovals.length).toBeGreaterThanOrEqual(1);
    for (const entry of requestPathRemovals) {
      expect(entry.afterWrites).toBeGreaterThanOrEqual(2);
    }
    // The bridge wrote no retryable status for the possibly-committed mutation.
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("retries a handler response write that fails transiently and delivers the real response, not a retryable 503", async () => {
    // A handler settles with its own response, but the terminal write fails
    // once. `finalize` must retry the write and deliver the real response. It
    // must not fence out recovery and leave the request for a retryable 503,
    // which would let the caller repeat a possibly-committed mutation.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-write-retry.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-write-retry"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];
    let writeAttempts = 0;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        writeAttempts += 1;
        // The first handler-response write fails; the retry then succeeds.
        if (writeAttempts === 1) {
          throw new Error("simulated transient response write failure");
        }
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 500,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler settles with its own 200 response.
      handleRequest: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
    });

    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    // Exactly one response landed: the handler's real 200. The retry delivered it
    // after the transient failure.
    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    expect(requestResponses[0]?.status).toBe(200);
    expect(writeAttempts).toBeGreaterThanOrEqual(2);
    // The bridge wrote no retryable status, so the caller does not repeat the
    // request.
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);
    // The handler removed the request file after the write landed.
    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("re-arms the 504 backstop when every handler response write fails, so the caller gets a terminal 504 instead of stranding", async () => {
    // A handler settles with its own response, but every terminal write fails.
    // `finalize` must roll back the fence and re-arm the 504 backstop, so the
    // recovery still delivers a non-retryable terminal response. Without the
    // re-arm, a rejected write leaves the request for a retryable 503 and a hung
    // write strands the caller until its own deadline.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-write-backstop.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-write-backstop"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];
    let writeAttempts = 0;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        writeAttempts += 1;
        // Fail every `finalize` write attempt. The re-armed 504 backstop then
        // writes on a later attempt.
        if (writeAttempts <= 3) {
          throw new Error("simulated persistent response write failure");
        }
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 500,
      watchdogTimeoutMs: 10_000,
      // A short grace, so the re-armed backstop fires quickly.
      abortedHandlerGraceMs: 30,
      runtimeSpan,
      authorizeRequest: async () => null,
      // The handler settles with its own 200 response, a committed mutation.
      handleRequest: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
    });

    // The re-armed backstop writes the terminal 504 after the finalize writes fail.
    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    // The backstop delivered a non-retryable 504 with an indeterminate outcome.
    expect(requestResponses[0]?.status).toBe(504);
    const parsed = JSON.parse(requestResponses[0]?.body ?? "{}");
    const responseBody = JSON.parse(parsed.body);
    expect(responseBody.outcome).toBe("indeterminate");
    expect(responseBody.retryable).toBe(false);
    expect(parsed.headers?.["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    // The finalize writes failed before the backstop wrote, so it took a later
    // attempt.
    expect(writeAttempts).toBeGreaterThanOrEqual(4);
    // The bridge wrote no retryable status for the possibly-committed mutation.
    expect(responseWrites.some((write) => write.status === 503)).toBe(false);
    expect(responseWrites.some((write) => write.status === 502)).toBe(false);
    // The backstop removed the request file, so it does not strand in the queue.
    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("retries a recovery 503 write that fails transiently, delivers the 503, and removes the request", async () => {
    // A request attempt times out (its first read hangs), so the loop's request
    // catch runs the recovery pass, which aborts the queued request with a 503.
    // The first 503 write fails, so the recovery must retry it inside the same
    // pass. It then delivers the 503 and removes the request. The request is
    // unclaimed, so its host mutation never ran; the 503 stays retry-safe. (A
    // hung poll no longer triggers this pass — the loop backs off and retries
    // the poll instead, and a sustained hang is the watchdog's job.)
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-503-retry.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-503-retry"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];
    let readCalls = 0;
    let writeAttempts = 0;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      // The first read never resolves — a silently unresponsive sandbox channel
      // hit mid-request, before the handler claim. The per-iteration timeout
      // converts the hang into a caught error, so the loop's request catch runs
      // the recovery pass. The recovery's own read resolves, so it can build and
      // deliver the 503.
      readTextFile: async (remotePath) => {
        readCalls += 1;
        if (readCalls === 1) {
          return await new Promise<string>(() => {});
        }
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        writeAttempts += 1;
        // The first recovery 503 write fails; the retry then succeeds.
        if (writeAttempts === 1) {
          throw new Error("simulated transient recovery 503 write failure");
        }
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status, body });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 200,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    await waitFor(() => responseWrites.some((write) => write.path === responsePath), 3_000);

    // Exactly one response landed: the retry-safe 503. The retry delivered it
    // after the transient failure.
    const requestResponses = responseWrites.filter((write) => write.path === responsePath);
    expect(requestResponses).toHaveLength(1);
    expect(requestResponses[0]?.status).toBe(503);
    expect(writeAttempts).toBeGreaterThanOrEqual(2);
    // The recovery removed the request file only after the 503 write landed.
    expect(requestRemovals).toContain(requestPath);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("keeps the queued request when every recovery 503 write fails, so a later pass can still deliver a terminal 503", async () => {
    // The poll times out, so the recovery path aborts the queued request with a
    // 503. Every 503 write fails. The recovery must keep the request file instead
    // of dropping it. Without the fix, the recovery removed the request before its
    // single write attempt, so a failed write left no queue state; a later
    // recovery pass found nothing and the caller waited until its own deadline.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-503-keep.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-503-keep"));
    const responseWrites: Array<{ path: string; status: number; body: string }> = [];
    const requestRemovals: string[] = [];
    let listCalls = 0;
    let writeAttempts = 0;

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) => {
        if (dir !== directories.requestsDir) {
          return [];
        }
        listCalls += 1;
        if (listCalls === 1) {
          return await new Promise<string[]>(() => {});
        }
        return [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort();
      },
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async () => {
        writeAttempts += 1;
        // Fail every recovery 503 write attempt.
        throw new Error("simulated persistent recovery 503 write failure");
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestRemovals.push(remotePath);
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 200,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    // Wait until the recovery pass has exhausted its bounded 503 write attempts
    // (three, the same bound as the finalize and 504 backstop writes).
    await waitFor(() => writeAttempts >= 3, 3_000);

    // The recovery could not write the 503, so it kept the request file. The
    // request still sits in the queue for a later recovery pass to deliver a
    // terminal 503. A drop here would strand the caller until its own deadline.
    expect(requestRemovals).not.toContain(requestPath);
    expect(requestBodies.has(requestPath)).toBe(true);
    // No response landed, because every write failed. The recovery wrote no
    // partial or retryable status for the possibly-committed mutation.
    expect(responseWrites).toHaveLength(0);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("maps an indeterminate host outcome to a non-retryable 409 in the in-sandbox bridge server", () => {
    // The in-sandbox server returns the host response to the sandbox caller. A 5xx
    // status is retryable by convention, so the server must not forward the
    // indeterminate 504 as a retry-safe status. It maps the indeterminate outcome
    // to a non-retryable 409, so a caller that retries 5xx does not repeat a
    // possibly-committed mutation. The outcome header and body still forward, so a
    // caller that reads them still sees the indeterminate result.
    const source = getSandboxCallbackBridgeServerSource();
    expect(source).toContain("x-paperclip-bridge-outcome");
    expect(source).toContain('=== "indeterminate"');
    expect(source).toContain("res.statusCode = 409");
  });

  it("abandons a request before its handler starts, so the mutation never runs", async () => {
    // Prove the reverse race. When the recovery path claims a request before the
    // handler starts its host operation, the handler must bail without running
    // the mutation. A retry after the 503 then applies the mutation once.
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("waitFor timed out");
    };

    const queueDir = "/virtual-bridge/queue";
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const requestFile = "req-early.json";
    const requestPath = path.posix.join(directories.requestsDir, requestFile);
    const responsePath = path.posix.join(directories.responsesDir, requestFile);

    const requestBodies = new Map<string, string>();
    requestBodies.set(requestPath, bridgeRequestJson("req-early"));
    const responseWrites: Array<{ path: string; status: number }> = [];

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async (dir) =>
        dir === directories.requestsDir
          ? [...requestBodies.keys()].map((entry) => path.posix.basename(entry)).sort()
          : [],
      readTextFile: async (remotePath) => {
        const body = requestBodies.get(remotePath);
        if (body === undefined) {
          throw new Error(`missing request ${remotePath}`);
        }
        return body;
      },
      writeTextFile: async () => {},
      writeResponseFile: async (remotePath, body) => {
        responseWrites.push({ path: remotePath, status: JSON.parse(body.trim()).status });
        return { wrote: true };
      },
      rename: async () => {},
      remove: async (remotePath) => {
        requestBodies.delete(remotePath);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();

    // The authorize step stays pending until the test releases it, so the handler
    // does not start before the per-iteration timeout fires and the recovery path
    // claims the request.
    const authorizeControl: { release: (() => void) | null } = { release: null };
    let handlerCalls = 0;

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      iterationTimeoutMs: 50,
      watchdogTimeoutMs: 10_000,
      runtimeSpan,
      authorizeRequest: () =>
        new Promise<string | null>((resolve) => {
          authorizeControl.release = () => resolve(null);
        }),
      handleRequest: async () => {
        handlerCalls += 1;
        return { status: 200, body: "req-early" };
      },
    });

    // Wait until the recovery path wrote the 503 and the authorize step is
    // pending.
    await waitFor(
      () => responseWrites.some((write) => write.status === 503) && authorizeControl.release !== null,
      3_000,
    );
    expect(responseWrites.some((write) => write.path === responsePath && write.status === 503)).toBe(true);

    // Release authorize after the 503. The handler must bail at its claim.
    authorizeControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The handler never ran, so the mutation never applied.
    expect(handlerCalls).toBe(0);
    // No competing 200 landed over the 503.
    expect(responseWrites.some((write) => write.path === responsePath && write.status === 200)).toBe(false);
    expect(workerErrors.some((message) => message.includes("timed out"))).toBe(true);

    await worker.stop({ drainTimeoutMs: 10 });
  });

  it("trips the watchdog on a stalled poll, writes a 503, and surfaces a run-level error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-watchdog-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(directories.requestsDir, { recursive: true });
    await writeFile(path.posix.join(directories.requestsDir, "req-w.json"), bridgeRequestJson("req-w"), "utf8");

    const base = createFileSystemSandboxCallbackBridgeQueueClient();
    let listCalls = 0;
    const client: SandboxCallbackBridgeQueueClient = {
      ...base,
      listJsonFiles: async (dir) => {
        listCalls += 1;
        // The first poll (the loop) never resolves — a stalled channel that the
        // per-iteration timeout does not catch soon enough. Later calls (the
        // watchdog's failPendingRequests) resolve, so it enumerates and 503s.
        if (listCalls === 1) {
          return await new Promise<string[]>(() => {});
        }
        return await base.listJsonFiles(dir);
      },
    };

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      // The per-iteration timeout is far larger than the watchdog threshold, so
      // the watchdog — not the per-iteration timeout — is the mechanism proven.
      iterationTimeoutMs: 400,
      watchdogTimeoutMs: 50,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async () => ({ status: 200, body: "ok" }),
    });

    const responseFile = await waitForJsonFile(directories.responsesDir, 3_000);
    const responseBody = await readFile(path.posix.join(directories.responsesDir, responseFile), "utf8");
    expect(JSON.parse(responseBody).status).toBe(503);
    expect(workerErrors.some((message) => message.includes("no successful poll iteration"))).toBe(true);

    await worker.stop({ drainTimeoutMs: 400 });
  });

  it("processes a fast request with no false-positive timeout and no run-level error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-fast-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(directories.requestsDir, { recursive: true });
    await writeFile(path.posix.join(directories.requestsDir, "req-ok.json"), bridgeRequestJson("req-ok"), "utf8");

    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();
    const processed: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      iterationTimeoutMs: 200,
      watchdogTimeoutMs: 1_000,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        processed.push(request.id);
        return { status: 200, body: request.id };
      },
    });

    const responseFile = await waitForJsonFile(directories.responsesDir, 3_000);
    const responseBody = await readFile(path.posix.join(directories.responsesDir, responseFile), "utf8");
    expect(JSON.parse(responseBody).status).toBe(200);
    expect(JSON.parse(responseBody).body).toBe("req-ok");

    // Let several idle poll iterations and watchdog checks pass. A healthy idle
    // loop must never trip the watchdog and never surface a run-level error.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processed).toEqual(["req-ok"]);
    expect(workerErrors).toEqual([]);

    await worker.stop({ drainTimeoutMs: 50 });
  });

  async function prepareGatewayFixture(prefix: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
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
      spec: { remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000 },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });
    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    return {
      runner,
      remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      directories: sandboxCallbackBridgeDirectories(queueDir),
      bridgeToken: createSandboxCallbackBridgeToken(),
    };
  }

  it("cleans up a timed-out request file and keeps serving after the host recovers", async () => {
    const fixture = await prepareGatewayFixture("paperclip-bridge-timeout-clean-");

    const bridge = await startSandboxCallbackBridgeServer({
      runner: fixture.runner,
      remoteCwd: fixture.remoteWorkspaceDir,
      assetRemoteDir: fixture.assetRemoteDir,
      queueDir: fixture.queueDir,
      bridgeToken: fixture.bridgeToken,
      timeoutMs: 30_000,
      responseTimeoutMs: 600,
      pollIntervalMs: 50,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    // No worker runs, so the request times out at the gateway.
    const timedOut = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${fixture.bridgeToken}` },
    });
    expect(timedOut.status).toBe(502);
    await expect(timedOut.json()).resolves.toMatchObject({
      error: expect.stringContaining("Timed out"),
    });

    // The gateway cleaned its own request file, so nothing counts toward the
    // queue-depth cap after the caller gave up.
    const leftover = (await readdir(fixture.directories.requestsDir).catch(() => [])).filter((name) =>
      name.endsWith(".json"),
    );
    expect(leftover).toEqual([]);

    // A worker that comes up afterwards serves the next request normally —
    // the timeout neither wedged nor killed the gateway.
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir: fixture.queueDir,
      authorizeRequest: async () => null,
      handleRequest: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      }),
    });
    cleanupFns.push(async () => {
      await worker.stop();
    });

    const recovered = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${fixture.bridgeToken}` },
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({ ok: true });
  }, 30_000);

  it("sweeps stale request files before rejecting at the queue-depth cap", async () => {
    const fixture = await prepareGatewayFixture("paperclip-bridge-stale-sweep-");

    const bridge = await startSandboxCallbackBridgeServer({
      runner: fixture.runner,
      remoteCwd: fixture.remoteWorkspaceDir,
      assetRemoteDir: fixture.assetRemoteDir,
      queueDir: fixture.queueDir,
      bridgeToken: fixture.bridgeToken,
      timeoutMs: 30_000,
      responseTimeoutMs: 500,
      pollIntervalMs: 50,
      maxQueueDepth: 1,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    // Plant an orphaned request file (a killed caller, or a previous gateway
    // process's leftover) and backdate it beyond the response deadline.
    const orphanPath = path.join(fixture.directories.requestsDir, "orphan.json");
    await writeFile(orphanPath, bridgeRequestJson("orphan"), "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(orphanPath, staleTime, staleTime);

    // The queue sits at the cap, but the only entry is stale: the gateway must
    // sweep it and admit the request instead of answering 503. With no worker
    // the admitted request then times out (502) — proof it entered the queue.
    const response = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${fixture.bridgeToken}` },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? "").not.toContain("queue is full");

    const leftover = (await readdir(fixture.directories.requestsDir).catch(() => [])).filter((name) =>
      name.endsWith(".json"),
    );
    expect(leftover).toEqual([]);
  }, 30_000);

  it("skips a request file that vanished before the read instead of escalating", async () => {
    // The gateway deletes a request file when its caller stops waiting. The
    // worker's read then races the deletion; a vanished file must be a quiet
    // skip, not a worker failure with a recovery pass.
    const queueDir = "/virtual-bridge/vanished";
    let listCalls = 0;
    const handled: string[] = [];
    const responseStatuses: number[] = [];
    const { runtimeSpan, workerErrors } = createWorkerErrorCapture();

    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {},
      makeDirs: async () => {},
      listJsonFiles: async () => {
        listCalls += 1;
        return listCalls === 1 ? ["ghost.json"] : [];
      },
      readTextFile: async () => {
        throw new Error("cat: ghost.json: No such file or directory");
      },
      writeTextFile: async () => {},
      writeResponseFile: async (_remotePath, body) => {
        responseStatuses.push((JSON.parse(body.trim()) as { status: number }).status);
        return { wrote: true };
      },
      rename: async () => {},
      remove: async () => {},
    };

    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      runtimeSpan,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        handled.push(request.id);
        return { status: 200, body: "ok" };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker.stop({ drainTimeoutMs: 50 });

    expect(handled).toEqual([]);
    expect(responseStatuses).toEqual([]);
    expect(workerErrors).toEqual([]);
  });

  it("embeds crash handlers and queue hygiene in the generated gateway source", () => {
    // A crashed gateway is a dead loopback port for the rest of the run, so
    // the generated source must keep its crash handlers and its stale-queue
    // sweep. The readiness gate matters too: survival applies only after the
    // gateway is adoptable, so a startup fault still fails fast. This pins
    // their presence; the behavior is proven above and below.
    const source = getSandboxCallbackBridgeServerSource();
    expect(source).toContain('process.on("uncaughtException"');
    expect(source).toContain('process.on("unhandledRejection"');
    expect(source).toContain("gatewayReady");
    expect(source).toContain("sweepStaleRequests");
  });

  it("exits fast when the gateway cannot bind its port instead of lingering un-ready", async () => {
    // Before readiness, the crash handlers must not keep the process alive: a
    // failed bind means the gateway can never serve, and surviving would only
    // leave an un-ready zombie while the host waits out its readiness poll.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-bind-fail-"));
    cleanupDirs.push(rootDir);
    const entrypoint = path.join(rootDir, "paperclip-bridge-server.mjs");
    await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
    const queueDir = path.join(rootDir, "queue");
    await mkdir(queueDir, { recursive: true });

    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    cleanupFns.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );
    const blockedPort = (blocker.address() as { port: number }).port;

    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
        PAPERCLIP_BRIDGE_TOKEN: "test-token",
        PAPERCLIP_BRIDGE_PORT: String(blockedPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("[paperclip-bridge] server error");
    expect(stderr).toContain("EADDRINUSE");
  }, 15_000);

  it("exits nonzero for the retired duplex_v1 mode instead of starting the queue gateway", async () => {
    // The closed mode allowlist rejects `duplex_v1` before the queue-directory
    // check, so a stale `duplex_v1` launch environment fails startup instead
    // of silently falling through to the queue gateway.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-mode-duplex-"));
    cleanupDirs.push(rootDir);
    const entrypoint = path.join(rootDir, "paperclip-bridge-server.mjs");
    await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
    const queueDir = path.join(rootDir, "queue");
    await mkdir(queueDir, { recursive: true });

    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        PAPERCLIP_API_BRIDGE_MODE: "duplex_v1",
        PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
        PAPERCLIP_BRIDGE_TOKEN: "test-token",
        PAPERCLIP_BRIDGE_PORT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unsupported PAPERCLIP_API_BRIDGE_MODE: duplex_v1");
  }, 15_000);

  it("exits nonzero for an unknown bridge mode instead of starting the queue gateway", async () => {
    // The closed mode allowlist rejects every value it does not name, not
    // only the retired duplex transport.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-mode-unknown-"));
    cleanupDirs.push(rootDir);
    const entrypoint = path.join(rootDir, "paperclip-bridge-server.mjs");
    await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
    const queueDir = path.join(rootDir, "queue");
    await mkdir(queueDir, { recursive: true });

    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        PAPERCLIP_API_BRIDGE_MODE: "totally_unknown_mode",
        PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
        PAPERCLIP_BRIDGE_TOKEN: "test-token",
        PAPERCLIP_BRIDGE_PORT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unsupported PAPERCLIP_API_BRIDGE_MODE: totally_unknown_mode");
  }, 15_000);

  it("test_http2_gateway_writes_no_frame_between_ready_and_the_preface", async () => {
    // Spawn the real generated gateway in http2_v1 mode and read its raw
    // stdout bytes. The only frame-codec write on this path is the READY
    // line; the very next bytes must be the HTTP/2 client connection preface
    // with nothing in between, because the gateway hands stdout to the
    // HTTP/2 client immediately after it writes READY and starts no
    // heartbeat timer and writes no envelope frame on this path.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-http2-gateway-"));
    cleanupDirs.push(rootDir);
    const entrypoint = path.join(rootDir, "paperclip-bridge-server.mjs");
    await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");

    const probe = createServer();
    const assignedPort = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not reserve a loopback port for the test."));
          return;
        }
        probe.close(() => resolve(address.port));
      });
    });

    const nonce = "test-nonce-http2";
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        PAPERCLIP_API_BRIDGE_MODE: "http2_v1",
        PAPERCLIP_BRIDGE_TOKEN: "test-token",
        PAPERCLIP_BRIDGE_PORT: String(assignedPort),
        PAPERCLIP_BRIDGE_NONCE: nonce,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanupFns.push(async () => {
      child.kill();
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const chunks: Buffer[] = [];
    const preface = Buffer.from("505249202a20485454502f322e300d0a0d0a534d0d0a0d0a", "hex");
    const firstBytes = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for the http2 gateway stdout. stderr: " + stderr)),
        5000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const total = Buffer.concat(chunks);
        const newlineIndex = total.indexOf(0x0a);
        if (newlineIndex !== -1 && total.length >= newlineIndex + 1 + preface.length) {
          clearTimeout(timer);
          resolve(total);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("The http2 gateway exited early with code " + String(code) + ". stderr: " + stderr));
      });
    });

    const newlineIndex = firstBytes.indexOf(0x0a);
    expect(newlineIndex).toBeGreaterThan(0);
    const readyLine = firstBytes.subarray(0, newlineIndex).toString("utf8");
    expect(JSON.parse(readyLine)).toMatchObject({ type: "ready", nonce });
    const afterReady = firstBytes.subarray(newlineIndex + 1, newlineIndex + 1 + preface.length);
    expect(afterReady).toEqual(preface);
  }, 15_000);
});
