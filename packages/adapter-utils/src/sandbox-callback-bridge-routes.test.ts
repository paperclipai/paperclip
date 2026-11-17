import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSandboxCallbackBridgeEnv,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  resolveSandboxCallbackBridgeRouteTimings,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import type {
  SandboxCallbackBridgeQueueClient,
  SandboxCallbackBridgeRoutePolicy,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

const QUEUE_DIR = "/queue";
const directories = sandboxCallbackBridgeDirectories(QUEUE_DIR);
const MEMORY_ROUTE: SandboxCallbackBridgeRoutePolicy = {
  method: "POST",
  path: /^\/memory\/add$/,
  deadlineMs: 40_000,
  maxConcurrent: 2,
};

// An in-memory queue client, so fake timers drive the worker deterministically.
function createMemoryQueue() {
  const files = new Map<string, string>();
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => undefined,
    listJsonFiles: async (dir) =>
      [...files.keys()]
        .filter((file) => path.posix.dirname(file) === dir && file.endsWith(".json"))
        .map((file) => path.posix.basename(file)),
    fileSize: async (file) => Buffer.byteLength(files.get(file) ?? ""),
    readTextFile: async (file) => {
      const body = files.get(file);
      if (body === undefined) throw new Error(`ENOENT ${file}`);
      return body;
    },
    writeTextFile: async (file, body) => {
      files.set(file, body);
    },
    rename: async (from, to) => {
      const body = files.get(from);
      if (body === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, body);
    },
    remove: async (file) => {
      files.delete(file);
    },
  };
  const enqueue = (id: string, method: string, requestPath: string) => {
    files.set(
      path.posix.join(directories.requestsDir, `${id}.json`),
      JSON.stringify({ id, method, path: requestPath, query: "", headers: {}, body: "", createdAt: "" }),
    );
  };
  const response = (id: string) => {
    const body = files.get(path.posix.join(directories.responsesDir, `${id}.json`));
    return body === undefined ? null : (JSON.parse(body) as { status: number; headers: Record<string, string>; body: string });
  };
  const requestPending = (id: string) => files.has(path.posix.join(directories.requestsDir, `${id}.json`));
  return { client, enqueue, response, requestPending };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function stopAndAdvance(worker: { stop(options?: { drainTimeoutMs?: number }): Promise<void> }) {
  const stopping = worker.stop({ drainTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(500);
  await stopping;
}

describe("sandbox callback bridge route policies", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the gateway env unchanged when no route policy is set", () => {
    const base = { queueDir: "/q", bridgeToken: "t" };
    expect(buildSandboxCallbackBridgeEnv(base)).toEqual(buildSandboxCallbackBridgeEnv({ ...base, routePolicies: [] }));
    expect(buildSandboxCallbackBridgeEnv(base)).not.toHaveProperty("PAPERCLIP_BRIDGE_ROUTE_DEADLINES");
    expect(JSON.parse(buildSandboxCallbackBridgeEnv({ ...base, routePolicies: [MEMORY_ROUTE] })
      .PAPERCLIP_BRIDGE_ROUTE_DEADLINES!)).toEqual([
      { method: "POST", source: "^\\/memory\\/add$", flags: "", deadlineMs: 40_000 },
    ]);
  });

  it("derives every host budget inside the route's in-pod deadline", () => {
    expect(resolveSandboxCallbackBridgeRouteTimings(30_000)).toEqual({
      responseDeadlineMs: 30_000,
      requestTimeoutMs: 28_000,
      forwardTimeoutMs: 29_000,
      backstopGraceMs: 500,
    });
    for (const deadline of [200, 5_000, 35_000, 120_000]) {
      const timings = resolveSandboxCallbackBridgeRouteTimings(deadline);
      expect(timings.requestTimeoutMs).toBeLessThan(timings.forwardTimeoutMs);
      expect(timings.forwardTimeoutMs).toBeLessThan(timings.responseDeadlineMs);
      expect(timings.requestTimeoutMs + timings.backstopGraceMs).toBeLessThan(timings.responseDeadlineMs);
    }
  });

  it("rejects a route policy that cannot run", async () => {
    const { client } = createMemoryQueue();
    await expect(startSandboxCallbackBridgeWorker({
      client, queueDir: QUEUE_DIR, handleRequest: async () => ({ status: 200 }),
      routePolicies: [{ path: /^\/x$/g, deadlineMs: 1000 }],
    })).rejects.toThrow(/g or y flag/);
    await expect(startSandboxCallbackBridgeWorker({
      client, queueDir: QUEUE_DIR, handleRequest: async () => ({ status: 200 }),
      routePolicies: [{ path: /^\/x$/, deadlineMs: 0 }],
    })).rejects.toThrow(/positive deadlineMs/);
  });

  it("does not delay or fail other routes while a 35 s relayed call runs", async () => {
    vi.useFakeTimers();
    const queue = createMemoryQueue();
    const slow = deferred<void>();
    const handled: string[] = [];
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 100,
      routePolicies: [MEMORY_ROUTE],
      handleRequest: async (request, options) => {
        handled.push(request.path);
        if (request.path === "/memory/add") {
          expect(options?.route?.responseDeadlineMs).toBe(40_000);
          await slow.promise;
          return { status: 200, body: "memory saved" };
        }
        expect(options?.route).toBeUndefined();
        return { status: 200, body: `ok ${request.path}` };
      },
    });
    queue.enqueue("slow", "POST", "/memory/add");
    await vi.advanceTimersByTimeAsync(500);
    expect(handled).toEqual(["/memory/add"]);

    // Ordinary calls on other routes keep completing for the whole 35 s, past
    // the 10 s per-request timeout and the 20 s watchdog.
    for (let second = 1; second <= 35; second += 1) {
      const id = `api-${second}`;
      queue.enqueue(id, "GET", `/api/agents/me/${second}`);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(queue.response(id), `api call ${second}`).toMatchObject({ status: 200, body: `ok /api/agents/me/${second}` });
    }
    expect(queue.response("slow")).toBeNull();

    slow.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(queue.response("slow")).toMatchObject({ status: 200, body: "memory saved" });
    await stopAndAdvance(worker);
  });

  it("enforces the per-route concurrency limit and starts the next request when a slot frees", async () => {
    vi.useFakeTimers();
    const queue = createMemoryQueue();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let running = 0;
    let peak = 0;
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      routePolicies: [{ path: /^\/mcp\/[^/]+$/, deadlineMs: 40_000, maxConcurrent: 2 }],
      handleRequest: async (request) => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred<void>();
        gates.set(request.path, gate);
        await gate.promise;
        running -= 1;
        return { status: 200, body: request.path };
      },
    });
    for (const name of ["a", "b", "c"]) queue.enqueue(name, "POST", `/mcp/${name}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(gates.size).toBe(2);
    expect(running).toBe(2);
    gates.values().next().value!.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(gates.size).toBe(3);
    expect(peak).toBe(2);
    for (const gate of gates.values()) gate.resolve();
    await vi.advanceTimersByTimeAsync(500);
    for (const name of ["a", "b", "c"]) expect(queue.response(name)).toMatchObject({ status: 200 });
    await stopAndAdvance(worker);
  });

  it("aborts a route handler at its own deadline with a non-retryable 504, and leaves other routes alone", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createMemoryQueue();
    const route: SandboxCallbackBridgeRoutePolicy = { method: "POST", path: /^\/mcp\/call$/, deadlineMs: 5_000 };
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      routePolicies: [route],
      handleRequest: async (request, options) => {
        if (request.path !== "/mcp/call") return { status: 200, body: "ok" };
        await new Promise<void>((_resolve, reject) => {
          options!.signal.addEventListener("abort", () => reject(options!.signal.reason), { once: true });
        });
        return { status: 200 };
      },
    });
    queue.enqueue("call", "POST", "/mcp/call");
    await vi.advanceTimersByTimeAsync(1_000);
    queue.enqueue("other", "GET", "/api/agents/me");
    await vi.advanceTimersByTimeAsync(500);
    expect(queue.response("other")).toMatchObject({ status: 200 });
    // 5 s deadline: abort at 4.5 s, so nothing lands before then.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(queue.response("call")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    const response = queue.response("call");
    expect(response).toMatchObject({ status: 504, headers: { "x-paperclip-bridge-outcome": "indeterminate" } });
    expect(JSON.parse(response!.body)).toMatchObject({ retryable: false, outcome: "indeterminate" });
    expect(queue.requestPending("call")).toBe(false);
    await stopAndAdvance(worker);
  });

  it("writes the 504 backstop for a route handler that ignores the abort, still inside the deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createMemoryQueue();
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      routePolicies: [{ path: /^\/mcp\/hang$/, deadlineMs: 10_000 }],
      handleRequest: async () => new Promise(() => {}),
    });
    queue.enqueue("hang", "POST", "/mcp/hang");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(queue.response("hang")).toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    expect(queue.response("hang")?.status).toBe(504);
    await stopAndAdvance(worker);
  });

  it("does not let the sequential watchdog or per-request timeout touch a running route request", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createMemoryQueue();
    const slow = deferred<void>();
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      iterationTimeoutMs: 200,
      watchdogTimeoutMs: 400,
      routePolicies: [MEMORY_ROUTE],
      handleRequest: async (request) => {
        if (request.path === "/memory/add") await slow.promise;
        return { status: 200, body: "done" };
      },
    });
    queue.enqueue("slow", "POST", "/memory/add");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queue.response("slow")).toBeNull();
    slow.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(queue.response("slow")).toMatchObject({ status: 200, body: "done" });
    expect(warn).not.toHaveBeenCalled();
    await stopAndAdvance(worker);
  });

  it("frees a route slot at the deadline even when the handler ignores the abort", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createMemoryQueue();
    const started: string[] = [];
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      routePolicies: [{ path: /^\/memory\/add$/, deadlineMs: 3_000, maxConcurrent: 1 }],
      handleRequest: async (request) => {
        started.push(request.path);
        if (started.length === 1) return new Promise(() => {});
        return { status: 200, body: "second ok" };
      },
    });
    queue.enqueue("first", "POST", "/memory/add");
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueue("second", "POST", "/memory/add");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toHaveLength(1);
    expect(queue.response("second")).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.response("first")?.status).toBe(504);
    expect(queue.response("second")).toMatchObject({ status: 200, body: "second ok" });
    await stopAndAdvance(worker);
  });

  it("serves ordinary requests on one sequential lane, as before", async () => {
    vi.useFakeTimers();
    const queue = createMemoryQueue();
    let running = 0;
    let peak = 0;
    const worker = await startSandboxCallbackBridgeWorker({
      client: queue.client,
      queueDir: QUEUE_DIR,
      authorizeRequest: async () => null,
      pollIntervalMs: 50,
      routePolicies: [MEMORY_ROUTE],
      handleRequest: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 300));
        running -= 1;
        return { status: 200 };
      },
    });
    for (const id of ["a", "b", "c"]) queue.enqueue(id, "GET", `/api/issues/${id}`);
    await vi.advanceTimersByTimeAsync(3_000);
    for (const id of ["a", "b", "c"]) expect(queue.response(id)).toMatchObject({ status: 200 });
    expect(peak).toBe(1);
    await stopAndAdvance(worker);
  });

  describe("teardown drain", () => {
    it("lets a running route request and a queued one finish before stop resolves", async () => {
      vi.useFakeTimers();
      const queue = createMemoryQueue();
      const worker = await startSandboxCallbackBridgeWorker({
        client: queue.client,
        queueDir: QUEUE_DIR,
        authorizeRequest: async () => null,
        pollIntervalMs: 50,
        routePolicies: [MEMORY_ROUTE],
        handleRequest: async (request) => {
          // The last turn's memory save takes 20 s.
          await new Promise((resolve) => setTimeout(resolve, request.path === "/memory/add" ? 20_000 : 10));
          return { status: 200, body: `saved ${request.path}` };
        },
      });
      queue.enqueue("save", "POST", "/memory/add");
      await vi.advanceTimersByTimeAsync(200);
      queue.enqueue("late", "GET", "/api/agents/me");
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(11_000);
      await stopping;
      expect(queue.response("save")).toMatchObject({ status: 200, body: "saved /memory/add" });
      expect(queue.response("late")).toMatchObject({ status: 200 });
    });

    it("answers a terminal 504 for a started route request still running at the drain deadline", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const queue = createMemoryQueue();
      const worker = await startSandboxCallbackBridgeWorker({
        client: queue.client,
        queueDir: QUEUE_DIR,
        authorizeRequest: async () => null,
        pollIntervalMs: 50,
        routePolicies: [MEMORY_ROUTE],
        handleRequest: async () => new Promise(() => {}),
      });
      queue.enqueue("stuck", "POST", "/memory/add");
      await vi.advanceTimersByTimeAsync(200);
      const stopping = worker.stop({ drainTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_500);
      await stopping;
      expect(queue.response("stuck")?.status).toBe(504);
      expect(queue.requestPending("stuck")).toBe(false);
    });

    it("settles ordinary requests too: a waiting one is answered 503 and never runs after stop", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const queue = createMemoryQueue();
      const started: string[] = [];
      const worker = await startSandboxCallbackBridgeWorker({
        client: queue.client,
        queueDir: QUEUE_DIR,
        authorizeRequest: async () => null,
        pollIntervalMs: 50,
        routePolicies: [MEMORY_ROUTE],
        handleRequest: async (request) => {
          started.push(request.path);
          return new Promise(() => {});
        },
      });
      queue.enqueue("a", "PATCH", "/api/issues/a");
      await vi.advanceTimersByTimeAsync(200);
      queue.enqueue("b", "PATCH", "/api/issues/b");
      await vi.advanceTimersByTimeAsync(300);
      const stopping = worker.stop({ drainTimeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(started).toEqual(["/api/issues/a"]);
      expect(queue.response("a")?.status).toBe(504);
      expect(queue.response("b")?.status).toBe(503);
    });

    it("answers a retry-safe 503 for a route request that never started, and never runs it after stop", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const queue = createMemoryQueue();
      const started: string[] = [];
      const worker = await startSandboxCallbackBridgeWorker({
        client: queue.client,
        queueDir: QUEUE_DIR,
        authorizeRequest: async () => null,
        pollIntervalMs: 50,
        routePolicies: [{ path: /^\/memory\/add$/, deadlineMs: 40_000, maxConcurrent: 1 }],
        handleRequest: async (request) => {
          started.push(request.path);
          return new Promise(() => {});
        },
      });
      queue.enqueue("one", "POST", "/memory/add");
      await vi.advanceTimersByTimeAsync(200);
      queue.enqueue("two", "POST", "/memory/add");
      await vi.advanceTimersByTimeAsync(300);
      const stopping = worker.stop({ drainTimeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      expect(started).toHaveLength(1);
      expect(queue.response("two")?.status).toBe(503);
      expect(queue.response("one")?.status).toBe(504);
    });
  });
});

// A real gateway and worker over the filesystem queue: the gateway must wait the
// route's own deadline, not the global response deadline.
describe("sandbox callback bridge gateway per-route response deadline", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
  });

  function createExecRunner() {
    return {
      execute: async (input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunProcessResult> => {
        const startedAt = new Date().toISOString();
        const command = input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        try {
          const result = await execFile(command, input.args ?? [], {
            cwd: input.cwd, env: { ...process.env, ...input.env }, maxBuffer: 32 * 1024 * 1024, timeout: input.timeoutMs,
          });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const err = error as { code?: number | string; stdout?: string; stderr?: string };
          return {
            exitCode: typeof err.code === "number" ? err.code : null, signal: null, timedOut: false,
            stdout: err.stdout ?? "", stderr: err.stderr ?? "", pid: null, startedAt,
          };
        }
      },
    };
  }

  it("waits a registered route's deadline while other routes keep the global deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-route-deadline-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const asset = await createSandboxCallbackBridgeAsset();
    cleanups.push(asset.cleanup);
    const queueDir = path.join(root, "queue");
    const bridgeToken = createSandboxCallbackBridgeToken();
    const routePolicies: SandboxCallbackBridgeRoutePolicy[] = [
      { method: "POST", path: /^\/memory\/add$/, deadlineMs: 6_000, maxConcurrent: 2 },
    ];
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async () => null,
      pollIntervalMs: 10,
      routePolicies,
      handleRequest: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return { status: 200, body: JSON.stringify({ path: request.path }) };
      },
    });
    const gateway = await startSandboxCallbackBridgeServer({
      runner: createExecRunner(), remoteCwd: root, assetRemoteDir: asset.localDir, queueDir, bridgeToken,
      pollIntervalMs: 10, responseTimeoutMs: 600, routePolicies,
    });
    cleanups.push(() => gateway.stop());
    // Cleanups run last in, first out: the worker stops before the gateway.
    cleanups.push(() => worker.stop({ drainTimeoutMs: 500 }));
    const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" };

    const [memory, ordinary] = await Promise.all([
      fetch(`${gateway.baseUrl}/memory/add`, { method: "POST", headers, body: "{}" }),
      fetch(`${gateway.baseUrl}/api/agents/me`, { headers }),
    ]);
    // The route waited past the 600 ms global deadline; the ordinary route did not.
    expect(memory.status).toBe(200);
    await expect(memory.json()).resolves.toEqual({ path: "/memory/add" });
    expect(ordinary.status).toBeGreaterThanOrEqual(500);
  }, 20_000);
});
