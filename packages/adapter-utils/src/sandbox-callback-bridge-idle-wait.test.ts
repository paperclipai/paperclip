// TECH-9007: the file bridge waits inside the sandbox instead of polling the
// queue from the host every 100 ms, and the run-log tail waits for new output.
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  sandboxCallbackBridgeDirectories,
  sandboxProviderSupportsBlockingBridgeWait,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import type {
  SandboxCallbackBridgeQueueClient,
  SandboxCallbackBridgeRoutePolicy,
  SandboxCallbackBridgeWorkerHandle,
} from "./sandbox-callback-bridge.js";
import { createSandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

type ExecInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};

// Runs each sandbox command as a local shell, like a pod exec, and records it.
function createLocalRunner(extraEnv: Record<string, string> = {}) {
  const scripts: string[] = [];
  const runner = {
    scripts,
    execute: async (input: ExecInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const args = [...(input.args ?? [])];
      scripts.push(args[1] ?? "");
      const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, ...input.env };
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
  return runner;
}

const isWait = (script: string) => script.includes("ignore=");
const isPlainList = (script: string) => !isWait(script) && script.includes("/*.json; do") && script.includes("basename");

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sandbox callback bridge blocking wait (TECH-9007)", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
  });

  async function setup(options: {
    routePolicies?: SandboxCallbackBridgeRoutePolicy[];
    handle?: (request: { id: string; path: string }) => Promise<void>;
    wrapClient?: (client: SandboxCallbackBridgeQueueClient) => SandboxCallbackBridgeQueueClient;
    runnerEnv?: Record<string, string>;
  } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-wait-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const queueDir = path.join(root, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const runner = createLocalRunner(options.runnerEnv);
    const baseClient = createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: root, timeoutMs: 30_000, waitInSandbox: true });
    const client = options.wrapClient ? options.wrapClient(baseClient) : baseClient;
    const handled: Array<{ id: string; at: number }> = [];
    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      routePolicies: options.routePolicies,
      authorizeRequest: () => null,
      handleRequest: async (request) => {
        handled.push({ id: request.id, at: Date.now() });
        await options.handle?.({ id: request.id, path: request.path });
        return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: request.id }) };
      },
    });
    let stopped = false;
    const stop = async (drainTimeoutMs?: number) => {
      if (stopped) return;
      stopped = true;
      await worker.stop(drainTimeoutMs === undefined ? {} : { drainTimeoutMs });
    };
    cleanups.push(() => stop(10));
    const enqueue = async (id: string, requestPath = "/api/agents/me", method = "GET") => {
      const file = path.join(directories.requestsDir, `${id}.json`);
      const payload = { id, method, path: requestPath, query: "", headers: {}, body: "", createdAt: new Date().toISOString() };
      await writeFile(`${file}.tmp`, `${JSON.stringify(payload)}\n`, "utf8");
      await import("node:fs/promises").then((fsp) => fsp.rename(`${file}.tmp`, file));
    };
    const response = async (id: string) => {
      const raw = await readFile(path.join(directories.responsesDir, `${id}.json`), "utf8").catch(() => null);
      return raw === null ? null : (JSON.parse(raw) as { status: number; body?: string });
    };
    const pendingRequests = async () =>
      (await readdir(directories.requestsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    return { runner, worker: worker as SandboxCallbackBridgeWorkerHandle, stop, enqueue, response, pendingRequests, handled, directories, root };
  }

  it("an idle run holds one waiting exec per 5 s window instead of polling", async () => {
    const waitOptions: Array<{ waitMs: number; ignore?: readonly string[] }> = [];
    const bridge = await setup({
      wrapClient: (client) => ({
        ...client,
        waitForJsonFiles: async (dir, options) => {
          waitOptions.push(options);
          return client.waitForJsonFiles!(dir, options);
        },
      }),
    });
    await sleep(1_500);
    // The old loop listed about every 100 ms plus the exec time: 10+ execs here.
    expect(bridge.runner.scripts.filter(isWait)).toHaveLength(1);
    expect(bridge.runner.scripts.filter(isPlainList)).toHaveLength(0);
    // One exec per 5 s window bounds an idle run at 12 queue execs per minute.
    expect(waitOptions[0]?.waitMs).toBe(5_000);
  });

  it("serves a request that arrives while idle within a few hundred ms", async () => {
    const bridge = await setup();
    await sleep(400);
    const enqueuedAt = Date.now();
    await bridge.enqueue("req-idle");
    await waitFor(async () => (await bridge.response("req-idle")) !== null, 3_000, "idle request response");
    const handledAt = bridge.handled.find((entry) => entry.id === "req-idle")!.at;
    // The in-sandbox check runs every 50 ms, so a request does not wait for the
    // 5 s window (about 60-150 ms on an unloaded machine; the bound leaves room
    // for a loaded CI host).
    expect(handledAt - enqueuedAt).toBeLessThan(1_000);
    expect((await bridge.response("req-idle"))?.status).toBe(200);
  });

  it("serves a burst of requests in order with none lost", async () => {
    const bridge = await setup();
    await sleep(200);
    const ids = Array.from({ length: 20 }, (_, index) => `req-${String(index).padStart(2, "0")}`);
    await Promise.all(ids.map((id) => bridge.enqueue(id)));
    await waitFor(async () => (await bridge.pendingRequests()).length === 0 && bridge.handled.length === ids.length, 15_000, "burst drained");
    expect(bridge.handled.map((entry) => entry.id)).toEqual(ids);
    for (const id of ids) {
      expect((await bridge.response(id))?.status).toBe(200);
    }
  });

  it("keeps route policies concurrent and does not spin on in-flight request files", async () => {
    const releaseSlow: Array<() => void> = [];
    const bridge = await setup({
      routePolicies: [{ method: "POST", path: /^\/memory\/add$/, deadlineMs: 5_000, maxConcurrent: 2 }],
      handle: async (request) => {
        if (request.path === "/memory/add") {
          await new Promise<void>((resolve) => releaseSlow.push(resolve));
        }
      },
    });
    await sleep(200);
    await bridge.enqueue("a-slow", "/memory/add", "POST");
    await waitFor(() => releaseSlow.length === 1, 3_000, "slow route started");
    const waitsBefore = bridge.runner.scripts.filter(isWait).length;
    // The slow request file stays in the queue while its handler runs. An
    // ordinary request still gets served next to it.
    await bridge.enqueue("b-fast");
    await waitFor(async () => (await bridge.response("b-fast")) !== null, 3_000, "ordinary request served beside slow route");
    await sleep(600);
    // The in-flight file is ignored by the wait, so the loop does not re-list
    // in a tight loop while the slow route runs.
    expect(bridge.runner.scripts.filter(isWait).length - waitsBefore).toBeLessThanOrEqual(4);
    expect(await bridge.response("a-slow")).toBeNull();
    releaseSlow[0]!();
    await waitFor(async () => (await bridge.response("a-slow")) !== null, 3_000, "slow route response");
  });

  it("stops promptly while idle and still drains a slow route at teardown", async () => {
    let releaseSlow: (() => void) | null = null;
    const bridge = await setup({
      routePolicies: [{ method: "POST", path: /^\/memory\/add$/, deadlineMs: 5_000, maxConcurrent: 1 }],
      handle: async (request) => {
        if (request.path === "/memory/add") {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
      },
    });
    await sleep(200);
    await bridge.enqueue("slow", "/memory/add", "POST");
    await waitFor(() => releaseSlow !== null, 3_000, "slow route started");
    setTimeout(() => releaseSlow?.(), 700);
    const stopStartedAt = Date.now();
    await bridge.stop();
    // The drain waited for the slow route (TECH-8907) and delivered its response.
    expect((await bridge.response("slow"))?.status).toBe(200);
    expect(Date.now() - stopStartedAt).toBeLessThan(3_000);
  });

  it("does not hold stop for the idle wait window", async () => {
    const bridge = await setup();
    await sleep(300);
    const stopStartedAt = Date.now();
    await bridge.stop();
    expect(Date.now() - stopStartedAt).toBeLessThan(1_500);
  });

  it("recovers after a failed wait exec and loses no request", async () => {
    let failures = 1;
    const calls: string[] = [];
    const bridge = await setup({
      wrapClient: (client) => ({
        ...client,
        listJsonFiles: async (dir) => {
          calls.push("list");
          return client.listJsonFiles(dir);
        },
        waitForJsonFiles: async (dir, options) => {
          calls.push("wait");
          if (failures > 0) {
            failures -= 1;
            throw new Error("exec websocket dropped");
          }
          return client.waitForJsonFiles!(dir, options);
        },
      }),
    });
    await bridge.enqueue("after-failure");
    await waitFor(async () => (await bridge.response("after-failure")) !== null, 5_000, "request after wait failures");
    expect((await bridge.response("after-failure"))?.status).toBe(200);
    // One failed wait, then plain listings probe until one succeeds (the old
    // recovery path), then the loop goes back to waiting.
    expect(calls[0]).toBe("wait");
    expect(calls[1]).toBe("list");
    await waitFor(() => calls.lastIndexOf("wait") > 0, 3_000, "back to waiting after recovery");
    expect(failures).toBe(0);
  });

  it("bounds the wait loop when the sandbox sleep rejects fractions", async () => {
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sleep-shim-"));
    cleanups.push(() => rm(shimDir, { recursive: true, force: true }));
    const counter = path.join(shimDir, "count");
    await writeFile(
      path.join(shimDir, "sleep"),
      `#!/bin/sh\necho x >> ${JSON.stringify(counter)}\ncase "$1" in *.*) exit 1 ;; esac\nexec /bin/sleep "$1"\n`,
      "utf8",
    );
    await chmod(path.join(shimDir, "sleep"), 0o755);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-wait-shim-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const requestsDir = path.join(root, "requests");
    await mkdir(requestsDir, { recursive: true });
    const runner = createLocalRunner({ PATH: `${shimDir}:${process.env.PATH ?? ""}` });
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: root, timeoutMs: 30_000, waitInSandbox: true });
    const startedAt = Date.now();
    expect(await client.waitForJsonFiles!(requestsDir, { waitMs: 2_000 })).toEqual([]);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_000);
    // Two rounds of (failed fractional sleep, then sleep 1): no spin.
    expect((await readFile(counter, "utf8")).trim().split("\n").length).toBeLessThanOrEqual(4);
  });

  it("returns at once for a file that is not ignored and waits past ignored ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-wait-client-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runner = createLocalRunner();
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: root, timeoutMs: 30_000, waitInSandbox: true });
    await writeFile(path.join(root, "known.json"), "{}", "utf8");
    let startedAt = Date.now();
    expect(await client.waitForJsonFiles!(root, { waitMs: 400, ignore: ["known.json"] })).toEqual(["known.json"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    startedAt = Date.now();
    setTimeout(() => void writeFile(path.join(root, "new.json"), "{}", "utf8"), 150);
    expect(await client.waitForJsonFiles!(root, { waitMs: 3_000, ignore: ["known.json"] })).toEqual(["known.json", "new.json"]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("blocking wait gating (TECH-9007)", () => {
  it("is enabled for Kubernetes only", () => {
    expect(sandboxProviderSupportsBlockingBridgeWait("kubernetes")).toBe(true);
    // Cloudflare runs every bridge command in one named session.
    expect(sandboxProviderSupportsBlockingBridgeWait("cloudflare")).toBe(false);
    expect(sandboxProviderSupportsBlockingBridgeWait("daytona")).toBe(false);
    expect(sandboxProviderSupportsBlockingBridgeWait(null)).toBe(false);
    expect(sandboxProviderSupportsBlockingBridgeWait(undefined)).toBe(false);
  });

  it("the command-managed client waits only when asked", () => {
    const runner = createLocalRunner();
    expect(createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: "/" }).waitForJsonFiles).toBeUndefined();
    expect(typeof createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: "/", waitInSandbox: true }).waitForJsonFiles)
      .toBe("function");
  });

  it("the run-log tail keeps the plain poll without idleWaitMs and clamps the window", async () => {
    const scripts: string[] = [];
    const runner = {
      execute: async (input: ExecInput): Promise<RunProcessResult> => {
        scripts.push(input.args?.[1] ?? "");
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
      },
    };
    const plain = createSandboxRunLogTailFactory({ runner, remoteCwd: "/", logsDir: "/logs", pollIntervalMs: 1, maxConsecutiveFailures: 1 }).create();
    plain.start(async () => undefined);
    await waitFor(() => scripts.length >= 1, 2_000, "plain tick");
    await plain.abort();
    expect(scripts[0]).not.toContain("while [");
    const clamped = createSandboxRunLogTailFactory({
      runner, remoteCwd: "/", logsDir: "/logs", pollIntervalMs: 1, maxConsecutiveFailures: 1, idleWaitMs: 60_000, tickTimeoutMs: 3_000,
    }).create();
    clamped.start(async () => undefined);
    await waitFor(() => scripts.length >= 2, 2_000, "clamped tick");
    await clamped.abort();
    // 1 s (a third of the 3 s tick timeout) at 200 ms per round.
    expect(scripts[1]).toContain(`while [ "$n" -lt 5 ]`);
  });
});

describe("sandbox run-log tail blocking wait (TECH-9007)", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
  });

  async function setupTail() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-wait-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const logsDir = path.join(root, "logs");
    await mkdir(logsDir, { recursive: true });
    const runner = createLocalRunner();
    const tail = createSandboxRunLogTailFactory({ runner, remoteCwd: root, logsDir, idleWaitMs: 5_000, pollIntervalMs: 500 }).create();
    const events: Array<{ stream: string; chunk: string; at: number }> = [];
    const stdoutLog = path.join(logsDir, "run-1-stdout.log");
    await writeFile(stdoutLog, "", "utf8");
    await writeFile(path.join(logsDir, "run-1-stderr.log"), "", "utf8");
    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk, at: Date.now() });
    });
    cleanups.push(() => tail.abort());
    return { runner, tail, events, stdoutLog, logsDir };
  }

  it("an idle run holds one tail exec per 5 s window", async () => {
    const { runner } = await setupTail();
    await sleep(1_800);
    // The old loop ran a tail exec every 250 ms: about 7 here.
    expect(runner.scripts).toHaveLength(1);
  });

  it("streams output that appears while idle within about half a second", async () => {
    const { events, stdoutLog } = await setupTail();
    await sleep(800);
    const writtenAt = Date.now();
    await appendFile(stdoutLog, "hello\n", "utf8");
    await waitFor(() => events.some((event) => event.chunk.includes("hello")), 3_000, "streamed chunk");
    // The 200 ms in-sandbox check plus the exec, not the 5 s window.
    expect(events[0]!.at - writtenAt).toBeLessThan(1_500);
  });

  it("finish does not wait for the pending tail exec and emits the suffix once", async () => {
    const { tail, events, stdoutLog } = await setupTail();
    await appendFile(stdoutLog, "first\n", "utf8");
    await waitFor(() => events.some((event) => event.chunk.includes("first")), 3_000, "first chunk");
    await sleep(700);
    const finishStartedAt = Date.now();
    await tail.finish({ stdout: "first\nsecond\n", stderr: "" });
    expect(Date.now() - finishStartedAt).toBeLessThan(1_000);
    expect(events.filter((event) => event.stream === "stdout").map((event) => event.chunk).join("")).toBe("first\nsecond\n");
  });

  it("returns at once when the command already ended", async () => {
    const { runner, events, logsDir } = await setupTail();
    await sleep(300);
    await writeFile(path.join(logsDir, "run-1-status"), "0", "utf8");
    // The pending wait sees the status file and returns; the next tick starts
    // after the 500 ms spacing and returns at once too.
    await waitFor(() => runner.scripts.length >= 3, 2_500, "ticks after status file");
    expect(events).toHaveLength(0);
  });
});
