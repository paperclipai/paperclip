import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceGitOperationScheduler,
  WORKSPACE_GIT_SCAN_ERROR_CODES,
  WorkspaceGitScanError,
  workspaceGitSchedulerOptionsFromEnv,
  type WorkspaceGitRunner,
} from "./workspace-git-operation-scheduler.js";

const tempPaths: string[] = [];

async function makeWorkspace(name = "workspace"): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-scheduler-"));
  tempPaths.push(parent);
  const workspace = path.join(parent, name);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scanInput(workspacePath: string, suffix: string, fairnessKeys: string[] = []) {
  return {
    workspacePath,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", suffix],
    operation: "test.changed_files",
    fairnessKeys,
    cacheTtlMs: 0,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempPaths.splice(0).map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
});

describe("WorkspaceGitOperationScheduler", () => {
  it("loads bounded process defaults and overrides from the environment", () => {
    expect(workspaceGitSchedulerOptionsFromEnv({})).toEqual({
      concurrency: 2,
      queueCapacity: 32,
      maxTotalDemand: 128,
      maxWaitersPerKey: 16,
      timeoutMs: 8_000,
      queueTimeoutMs: 1_000,
      killGraceMs: 250,
      negativeBackoffMs: 500,
      defaultCacheTtlMs: 10_000,
    });
    expect(workspaceGitSchedulerOptionsFromEnv({
      PAPERCLIP_WORKSPACE_GIT_SCAN_CONCURRENCY: "4",
      PAPERCLIP_WORKSPACE_GIT_SCAN_QUEUE_CAPACITY: "12",
      PAPERCLIP_WORKSPACE_GIT_SCAN_TOTAL_DEMAND_CAP: "40",
      PAPERCLIP_WORKSPACE_GIT_SCAN_PER_KEY_WAITER_CAP: "7",
      PAPERCLIP_WORKSPACE_GIT_SCAN_TIMEOUT_MS: "5000",
      PAPERCLIP_WORKSPACE_GIT_SCAN_QUEUE_TIMEOUT_MS: "300",
      PAPERCLIP_WORKSPACE_GIT_SCAN_KILL_GRACE_MS: "75",
      PAPERCLIP_WORKSPACE_GIT_SCAN_NEGATIVE_BACKOFF_MS: "250",
      PAPERCLIP_WORKSPACE_GIT_SCAN_CACHE_TTL_MS: "7000",
    })).toEqual({
      concurrency: 4,
      queueCapacity: 12,
      maxTotalDemand: 40,
      maxWaitersPerKey: 7,
      timeoutMs: 5_000,
      queueTimeoutMs: 300,
      killGraceMs: 75,
      negativeBackoffMs: 250,
      defaultCacheTtlMs: 7_000,
    });
  });

  it("enforces process-wide concurrency across unrelated fairness keys", async () => {
    const workspace = await makeWorkspace();
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    const runner: WorkspaceGitRunner = () => new Promise((resolve) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      releases.push(() => {
        active -= 1;
        resolve({ stdout: "", stderr: "" });
      });
    });
    const scheduler = createWorkspaceGitOperationScheduler({ concurrency: 2, queueCapacity: 8, runner });

    const requests = Array.from({ length: 6 }, (_, index) => scheduler.run(scanInput(
      workspace,
      String(index),
      [`company:${index}`, `actor:${index}`, `issue:${index}`],
    )));

    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ activeCount: 2, queuedCount: 4 }));
    for (let completed = 0; completed < requests.length; completed += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()?.();
    }
    await Promise.all(requests);

    expect(peakActive).toBe(2);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, inFlightCount: 0 });
  });

  it("honors per-operation deadlines and keeps different execution bounds out of one flight", async () => {
    const workspace = await makeWorkspace();
    const observedTimeouts: number[] = [];
    const runner: WorkspaceGitRunner = async (input) => {
      observedTimeouts.push(input.timeoutMs);
      return { stdout: "", stderr: "" };
    };
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 2,
      timeoutMs: 8_000,
      runner,
    });
    const input = scanInput(workspace, "same");

    await Promise.all([
      scheduler.run({ ...input, timeoutMs: 10_000, maxStdoutBytes: 1024 }),
      scheduler.run({ ...input, timeoutMs: 12_000, maxStdoutBytes: 1024 }),
    ]);

    expect(observedTimeouts.sort((a, b) => a - b)).toEqual([10_000, 12_000]);
    expect(scheduler.snapshot().totals.singleFlightJoins).toBe(0);
  });

  it("bounds the queue and fails excess work immediately with a typed retryable error", async () => {
    const workspace = await makeWorkspace();
    const releases: Array<() => void> = [];
    const runner: WorkspaceGitRunner = () => new Promise((resolve) => {
      releases.push(() => resolve({ stdout: "", stderr: "" }));
    });
    const scheduler = createWorkspaceGitOperationScheduler({ concurrency: 1, queueCapacity: 1, runner });

    const active = scheduler.run(scanInput(workspace, "active"));
    await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(1));
    const queued = scheduler.run(scanInput(workspace, "queued"));
    await vi.waitFor(() => expect(scheduler.snapshot().queuedCount).toBe(1));

    await expect(scheduler.run(scanInput(workspace, "rejected"))).rejects.toMatchObject({
      status: 503,
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.saturated,
      details: expect.objectContaining({ retryable: true }),
    });
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 });

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await Promise.all([active, queued]);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, inFlightCount: 0 });
  });

  it("expires queued work, reuses a brief negative backoff, and releases every waiter", async () => {
    const workspace = await makeWorkspace();
    const gate = deferred<void>();
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 1,
      queueCapacity: 2,
      queueTimeoutMs: 25,
      negativeBackoffMs: 250,
      runner: async () => {
        await gate.promise;
        return { stdout: "", stderr: "" };
      },
    });
    const active = scheduler.run(scanInput(workspace, "active"));
    await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(1));
    const queuedInput = scanInput(workspace, "queued");

    await expect(scheduler.run(queuedInput)).rejects.toMatchObject({
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.timeout,
      details: expect.objectContaining({ phase: "queue" }),
    });
    await expect(scheduler.run(queuedInput)).rejects.toMatchObject({
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.timeout,
    });
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
      waiterCount: 1,
      totals: { negativeBackoffHits: 1 },
    });

    gate.resolve();
    await active;
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      waiterCount: 0,
      inFlightCount: 0,
    });
  });

  it("coalesces the same canonical key and cleans single-flight state after success and failure", async () => {
    const workspace = await makeWorkspace();
    const alias = `${workspace}-alias`;
    await fs.symlink(workspace, alias, "dir");
    tempPaths.push(alias);
    const gate = deferred<void>();
    let calls = 0;
    let shouldFail = false;
    const runner: WorkspaceGitRunner = async () => {
      calls += 1;
      await gate.promise;
      if (shouldFail) throw new Error("synthetic failure");
      return { stdout: "shared", stderr: "" };
    };
    const scheduler = createWorkspaceGitOperationScheduler({ runner, defaultCacheTtlMs: 0 });

    const first = scheduler.run(scanInput(workspace, "same"));
    // Wait for the first request to register as the single-flight leader before
    // the alias request starts. Both requests call fs.realpath concurrently, so
    // without this barrier the symlink alias can resolve first and become the
    // leader. That race makes the leader and joiner order non-deterministic.
    await vi.waitFor(() => expect(scheduler.snapshot().inFlightCount).toBe(1));
    const joined = scheduler.run(scanInput(alias, "same"));
    await vi.waitFor(() => expect(scheduler.snapshot().totals.singleFlightJoins).toBe(1));
    expect(calls).toBe(1);
    gate.resolve();
    const results = await Promise.all([first, joined]);
    expect(results).toEqual([
      expect.objectContaining({ stdout: "shared" }),
      expect.objectContaining({ stdout: "shared" }),
    ]);
    expect(results.map((result) => result.singleFlightJoined).sort()).toEqual([false, true]);

    shouldFail = true;
    await expect(scheduler.run(scanInput(workspace, "failure"))).rejects.toMatchObject({
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.failed,
    });
    shouldFail = false;
    await expect(scheduler.run(scanInput(workspace, "failure"))).resolves.toMatchObject({ stdout: "shared" });
    expect(calls).toBe(3);
    expect(scheduler.snapshot().inFlightCount).toBe(0);
  });

  it("serves cached results until TTL expiry and evicts least-recently-used entries", async () => {
    const firstWorkspace = await makeWorkspace("same-name");
    const secondWorkspace = await makeWorkspace("same-name");
    const thirdWorkspace = await makeWorkspace("same-name");
    let now = 1_000;
    let calls = 0;
    const runner: WorkspaceGitRunner = async ({ canonicalWorkspacePath }) => {
      calls += 1;
      return { stdout: `${canonicalWorkspacePath}:${calls}`, stderr: "" };
    };
    const scheduler = createWorkspaceGitOperationScheduler({
      runner,
      now: () => now,
      defaultCacheTtlMs: 100,
      maxCacheEntries: 2,
    });
    const cacheable = (workspacePath: string) => ({
      ...scanInput(workspacePath, "same"),
      cacheTtlMs: 100,
    });

    const first = await scheduler.run(cacheable(firstWorkspace));
    const cacheHit = await scheduler.run(cacheable(firstWorkspace));
    expect(cacheHit).toMatchObject({ stdout: first.stdout, cacheHit: true });
    expect(calls).toBe(1);

    const bypass = await scheduler.run({ ...cacheable(firstWorkspace), cacheTtlMs: 0 });
    expect(bypass.cacheHit).toBe(false);
    expect(calls).toBe(2);

    now += 101;
    await scheduler.run(cacheable(firstWorkspace));
    expect(calls).toBe(3);
    await scheduler.run(cacheable(secondWorkspace));
    // Touch the first entry, then force the second (the LRU) out.
    await scheduler.run(cacheable(firstWorkspace));
    await scheduler.run(cacheable(thirdWorkspace));
    expect(scheduler.snapshot().cacheEntryCount).toBe(2);
    await scheduler.run(cacheable(secondWorkspace));
    expect(calls).toBe(6);
  });

  it("keeps identical display paths in different canonical workspaces isolated", async () => {
    const firstWorkspace = await makeWorkspace("repo");
    const secondWorkspace = await makeWorkspace("repo");
    let calls = 0;
    const scheduler = createWorkspaceGitOperationScheduler({
      runner: async ({ canonicalWorkspacePath }) => {
        calls += 1;
        return { stdout: canonicalWorkspacePath, stderr: "" };
      },
      defaultCacheTtlMs: 1_000,
    });

    const [first, second] = await Promise.all([
      scheduler.run({ ...scanInput(firstWorkspace, "same"), cacheTtlMs: 1_000 }),
      scheduler.run({ ...scanInput(secondWorkspace, "same"), cacheTtlMs: 1_000 }),
    ]);

    expect(first.stdout).not.toBe(second.stdout);
    expect(first.workspaceHash).not.toBe(second.workspaceHash);
    expect(calls).toBe(2);
  });

  it("does not let a repeatedly served fairness group monopolize the next slot", async () => {
    const workspace = await makeWorkspace();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const runner: WorkspaceGitRunner = ({ args }) => new Promise((resolve) => {
      const name = args.at(-1)!;
      order.push(name);
      releases.push(() => resolve({ stdout: name, stderr: "" }));
    });
    const scheduler = createWorkspaceGitOperationScheduler({ concurrency: 1, queueCapacity: 4, runner });

    const firstA = scheduler.run(scanInput(workspace, "a-1", ["company:a", "actor:a"]));
    await vi.waitFor(() => expect(order).toEqual(["a-1"]));
    const secondA = scheduler.run(scanInput(workspace, "a-2", ["company:a", "actor:a"]));
    const firstB = scheduler.run(scanInput(workspace, "b-1", ["company:b", "actor:b"]));
    await vi.waitFor(() => expect(scheduler.snapshot().queuedCount).toBe(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(order).toEqual(["a-1", "b-1"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(order).toEqual(["a-1", "b-1", "a-2"]));
    releases.shift()?.();

    await Promise.all([firstA, secondA, firstB]);
  });

  it("keeps a shared scan alive for remaining waiters and cancels it after the last disconnect", async () => {
    const workspace = await makeWorkspace();
    let underlyingAborted = false;
    const runner: WorkspaceGitRunner = ({ signal, canonicalWorkspacePath }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        underlyingAborted = true;
        reject(new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled,
          "cancelled",
          { canonicalWorkspacePath },
        ));
      }, { once: true });
    });
    const scheduler = createWorkspaceGitOperationScheduler({ runner });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = scheduler.run({ ...scanInput(workspace, "same"), signal: firstController.signal }).catch((error) => error);
    const second = scheduler.run({ ...scanInput(workspace, "same"), signal: secondController.signal }).catch((error) => error);
    await vi.waitFor(() => expect(scheduler.snapshot().totals.singleFlightJoins).toBe(1));

    firstController.abort();
    await expect(first).resolves.toMatchObject({ code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled });
    expect(underlyingAborted).toBe(false);
    expect(scheduler.snapshot().activeCount).toBe(1);

    secondController.abort();
    await expect(second).resolves.toMatchObject({ code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled });
    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, inFlightCount: 0 }));
    expect(underlyingAborted).toBe(true);
  });

  it("removes an abandoned queued scan without consuming a scheduler slot", async () => {
    const workspace = await makeWorkspace();
    const gate = deferred<void>();
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 1,
      queueCapacity: 2,
      runner: async () => {
        await gate.promise;
        return { stdout: "", stderr: "" };
      },
    });
    const active = scheduler.run(scanInput(workspace, "active"));
    await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(1));
    const controller = new AbortController();
    const queued = scheduler.run({
      ...scanInput(workspace, "queued"),
      signal: controller.signal,
    }).catch((error) => error);
    await vi.waitFor(() => expect(scheduler.snapshot().queuedCount).toBe(1));

    controller.abort();
    await expect(queued).resolves.toMatchObject({ code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled });
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0, inFlightCount: 1 });

    gate.resolve();
    await active;
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, inFlightCount: 0 });
  });

  it("kills a hung subprocess after the hard timeout and releases the slot for the next scan", async () => {
    const workspace = await makeWorkspace();
    const scriptPath = path.join(path.dirname(workspace), "fake-git.mjs");
    const pidPath = path.join(path.dirname(workspace), "fake-git.pid");
    await fs.writeFile(scriptPath, [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.PAPERCLIP_FAKE_GIT_PID_PATH, String(process.pid));',
      'if (process.argv.includes("hang")) {',
      '  process.on("SIGTERM", () => {});',
      '  setInterval(() => {}, 1000);',
      '} else if (process.argv.includes("flood")) {',
      '  process.on("SIGTERM", () => {});',
      '  setInterval(() => fs.writeSync(1, "x".repeat(1024)), 10);',
      '} else {',
      '  process.stdout.write("ok");',
      '}',
    ].join("\n"), "utf8");
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 1,
      timeoutMs: 500,
      killGraceMs: 50,
      gitBinary: process.execPath,
      gitArgsPrefix: [scriptPath],
    });
    const env = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PAPERCLIP_FAKE_GIT_PID_PATH: pidPath,
    };

    const timeoutStartedAt = Date.now();
    await expect(scheduler.run({ ...scanInput(workspace, "hang"), env })).rejects.toMatchObject({
      status: 504,
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.timeout,
    });
    expect(Date.now() - timeoutStartedAt).toBeLessThan(1_000);
    const killedPid = Number(await fs.readFile(pidPath, "utf8"));
    expect(() => process.kill(killedPid, 0)).toThrow();
    expect(scheduler.snapshot().totals.forcedKilled).toBe(1);
    const outputScheduler = createWorkspaceGitOperationScheduler({
      concurrency: 1,
      // Process startup can be slow in a loaded serialized CI shard. This
      // fixture verifies output-limit termination, not the execution deadline.
      timeoutMs: 5_000,
      killGraceMs: 50,
      gitBinary: process.execPath,
      gitArgsPrefix: [scriptPath],
    });
    await expect(outputScheduler.run({
      ...scanInput(workspace, "flood"),
      env,
      maxStdoutBytes: 32,
    })).rejects.toMatchObject({
      status: 503,
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.outputLimit,
    });
    const outputLimitedPid = Number(await fs.readFile(pidPath, "utf8"));
    expect(() => process.kill(outputLimitedPid, 0)).toThrow();
    expect(outputScheduler.snapshot()).toMatchObject({ activeCount: 0, inFlightCount: 0 });
    await expect(scheduler.run({ ...scanInput(workspace, "ok"), env })).resolves.toMatchObject({
      cacheHit: false,
      singleFlightJoined: false,
    });
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, inFlightCount: 0 });
  }, 10_000);

  it("reaps a SIGTERM-resistant child before scheduler shutdown completes", async () => {
    const workspace = await makeWorkspace();
    const scriptPath = path.join(path.dirname(workspace), "fake-git-shutdown.mjs");
    const pidPath = path.join(path.dirname(workspace), "fake-git-shutdown.pid");
    await fs.writeFile(scriptPath, [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.PAPERCLIP_FAKE_GIT_PID_PATH, String(process.pid));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
    ].join("\n"), "utf8");
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 1,
      timeoutMs: 5_000,
      killGraceMs: 50,
      gitBinary: process.execPath,
      gitArgsPrefix: [scriptPath],
    });
    const env = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PAPERCLIP_FAKE_GIT_PID_PATH: pidPath,
    };
    const scan = scheduler.run({ ...scanInput(workspace, "hang"), env }).catch((error) => error);
    let childPid = 0;
    await vi.waitFor(async () => {
      childPid = Number(await fs.readFile(pidPath, "utf8"));
      expect(childPid).toBeGreaterThan(0);
    });

    await scheduler.shutdown();
    await expect(scan).resolves.toMatchObject({ code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled });
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      waiterCount: 0,
      totalDemandCount: 0,
      totals: { forcedKilled: 1 },
    });
  });

  it("closes admission and waits for canonical-path resolution during shutdown", async () => {
    const workspace = await makeWorkspace();
    const realpathGate = deferred<string>();
    vi.spyOn(fs, "realpath").mockImplementationOnce(() => realpathGate.promise);
    const runner = vi.fn<WorkspaceGitRunner>(async () => ({ stdout: "", stderr: "" }));
    const scheduler = createWorkspaceGitOperationScheduler({ runner });

    const resolvingScan = scheduler.run(scanInput(workspace, "resolving")).catch((error) => error);
    await vi.waitFor(() => expect(scheduler.snapshot().resolvingCount).toBe(1));

    let shutdownSettled = false;
    const shutdown = scheduler.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(scheduler.run(scanInput(workspace, "late"))).rejects.toMatchObject({
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled,
      details: expect.objectContaining({ reason: "scheduler_shutdown" }),
    });

    realpathGate.resolve(workspace);
    await shutdown;
    await expect(resolvingScan).resolves.toMatchObject({
      code: WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled,
      details: expect.objectContaining({ reason: "scheduler_shutdown" }),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      waiterCount: 0,
      resolvingCount: 0,
      inFlightCount: 0,
      totalDemandCount: 0,
    });
  });

  it("keeps a 10,000-request storm, including 5,000 hot-key callers, within hard caps", async () => {
    const baselineMemory = process.memoryUsage();
    const root = await makeWorkspace("repos");
    const workspaces = Array.from({ length: 80 }, (_, index) => path.join(root, `repo-${index}`));
    await Promise.all(workspaces.map((workspace) => fs.mkdir(workspace)));
    const gate = deferred<void>();
    let active = 0;
    let peakActive = 0;
    let calls = 0;
    const scheduler = createWorkspaceGitOperationScheduler({
      concurrency: 2,
      queueCapacity: 32,
      maxTotalDemand: 64,
      maxWaitersPerKey: 8,
      queueTimeoutMs: 5_000,
      runner: async () => {
        calls += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        await gate.promise;
        active -= 1;
        return { stdout: "", stderr: "" };
      },
    });
    const requests = Array.from({ length: 10_000 }, (_, index) => {
      const hot = index < 5_000;
      return scheduler.run(scanInput(
        hot ? workspaces[0]! : workspaces[1 + (index % (workspaces.length - 1))]!,
        "same",
        [`company:${index % 17}`, `actor:${index % 73}`, `issue:${index}`],
      )).then(
        () => "completed" as const,
        (error: unknown) => error instanceof WorkspaceGitScanError ? error.code : "unexpected",
      );
    });

    await vi.waitFor(() => expect(scheduler.snapshot().resolvingCount).toBe(0));
    const duringStorm = scheduler.snapshot();
    expect(duringStorm.activeCount).toBeLessThanOrEqual(2);
    expect(duringStorm.queuedCount).toBeLessThanOrEqual(32);
    expect(duringStorm.waiterCount).toBeLessThanOrEqual(64);
    expect(duringStorm.totalDemandCount).toBeLessThanOrEqual(64);
    expect(duringStorm.peaks).toMatchObject({
      active: 2,
      perKeyWaiters: 8,
    });
    expect(duringStorm.peaks.queued).toBeLessThanOrEqual(32);
    expect(duringStorm.peaks.waiters).toBeLessThanOrEqual(64);
    expect(duringStorm.peaks.totalDemand).toBeLessThanOrEqual(64);
    const peakMemory = process.memoryUsage();
    gate.resolve();
    const outcomes = await Promise.all(requests);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledMemory = process.memoryUsage();
    const finalSnapshot = scheduler.snapshot();
    const rejected = outcomes.filter(
      (outcome) => outcome === WORKSPACE_GIT_SCAN_ERROR_CODES.saturated,
    ).length;
    const mib = 1024 * 1024;

    expect(rejected).toBeGreaterThan(9_000);
    expect(outcomes).not.toContain("unexpected");
    expect({ peakActive }).toEqual({ peakActive: 2 });
    expect(calls).toBeLessThanOrEqual(34);
    expect(finalSnapshot).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      waiterCount: 0,
      resolvingCount: 0,
      inFlightCount: 0,
      totalDemandCount: 0,
    });
    console.info("close-readiness scheduler stress evidence", {
      requests: requests.length,
      hotKeyRequests: 5_000,
      completed: outcomes.length - rejected,
      rejected,
      peakActiveChildren: peakActive,
      peakQueueDepth: duringStorm.peaks.queued,
      peakWaiters: duringStorm.peaks.waiters,
      peakPerKeyWaiters: duringStorm.peaks.perKeyWaiters,
      peakTotalDemand: duringStorm.peaks.totalDemand,
      heapPeakDeltaMiB: Number(((peakMemory.heapUsed - baselineMemory.heapUsed) / mib).toFixed(1)),
      rssPeakDeltaMiB: Number(((peakMemory.rss - baselineMemory.rss) / mib).toFixed(1)),
      heapSettledDeltaMiB: Number(((settledMemory.heapUsed - baselineMemory.heapUsed) / mib).toFixed(1)),
      rssSettledDeltaMiB: Number(((settledMemory.rss - baselineMemory.rss) / mib).toFixed(1)),
      terminalDemand: finalSnapshot.totalDemandCount,
    });
  });
});
