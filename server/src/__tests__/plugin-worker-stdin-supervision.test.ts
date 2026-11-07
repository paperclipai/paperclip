/**
 * Supervision of the host→worker command channel (child stdin).
 *
 * A worker can lose its stdin pipe (EPIPE, or the pipe closing) while the
 * process itself is still alive. `child.on("exit")` never fires, so the normal
 * crash-recovery path is never reached and the worker zombies: alive, holding
 * its slot, and rejecting every host→worker RPC with "not writable" forever.
 * These tests cover the supervision that turns that into a real exit so the
 * existing handleProcessExit() → scheduleRestart() recovery runs.
 *
 * This lives in its own file rather than in plugin-worker-manager.test.ts
 * because it needs to mock `node:child_process` to capture the spawned child,
 * and vi.mock is file-scoped — the sibling suite keeps an unmocked fork.
 */

import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

// Hoisted so the vi.mock factory (which is hoisted above the imports) can see
// it. The fork itself is the real one — only the reference is captured.
const { forkedChildren } = vi.hoisted(() => ({
  forkedChildren: [] as ChildProcess[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>): ChildProcess => {
      const child = actual.fork(...args);
      forkedChildren.push(child);
      return child;
    },
  };
});

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PERSISTENT_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-persistent.cjs");

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

/** An EPIPE the way Node surfaces one on a dead pipe. */
function epipe(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("write EPIPE");
  err.code = "EPIPE";
  err.syscall = "write";
  return err;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

function nextExit(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Resolve to the child's exit, or to `null` if it is still alive after
 * `timeoutMs`. Reporting "still alive" as a value rather than letting the test
 * time out is deliberate: an unsupervised worker zombies forever, and the
 * assertion below should name that rather than surface as a bare timeout.
 */
function exitWithin(child: ChildProcess, timeoutMs: number): Promise<Exit | null> {
  return Promise.race([
    nextExit(child),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Destroy the command channel at the instant the host's `shutdown` RPC has
 * been flushed to the worker.
 *
 * This is hooked rather than polled on purpose. Waiting for status
 * `"stopping"` via vi.waitFor puts the destroy an unbounded number of
 * milliseconds after the ack, which then has to beat the fixture's own
 * deferred exit — and the fixture in turn has to beat the host's 500ms
 * post-ack SIGTERM escalation. Those two deadlines squeeze from opposite
 * sides, and on a loaded runner one of them eventually loses. Hooking the
 * write removes both races: the destroy lands immediately after the shutdown
 * reaches the worker, so the fixture still has its whole exit window left.
 *
 * It is also a stronger precondition than polling for status. `sendMessage`
 * is only reached for `shutdown` from inside stopInternal(), which sets
 * `intentionalStop` before it writes — so firing here proves we are inside the
 * intentional-stop window rather than inferring it from an observable status.
 *
 * Resolves with whether the child was still alive when the pipe was killed.
 * If it had already exited, the test never exercised the guard at all, and the
 * assertion on this value turns that vacuous pass into a failure.
 */
function destroyStdinOnShutdown(child: ChildProcess): Promise<{ aliveAtDestroy: boolean }> {
  const stdin = child.stdin;
  if (!stdin) throw new Error("expected the forked child to have a stdin pipe");

  return new Promise((resolve) => {
    const originalWrite = stdin.write.bind(stdin) as typeof stdin.write;
    let fired = false;

    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      const accepted = (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);

      if (!fired && typeof chunk === "string" && chunk.includes('"shutdown"')) {
        fired = true;
        // Let the manager's own write callback run first, so the shutdown is
        // fully handed off before the pipe dies.
        setImmediate(() => {
          const aliveAtDestroy = child.exitCode === null && child.signalCode === null;
          stdin.destroy(epipe());
          resolve({ aliveAtDestroy });
        });
      }

      return accepted;
    }) as typeof stdin.write;
  });
}

async function startPersistentWorker() {
  const before = forkedChildren.length;
  const handle = createPluginWorkerHandle("test.plugin", {
    entrypointPath: PERSISTENT_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    hostHandlers: {},
    rpcTimeoutMs: 5_000,
  });

  await handle.start();

  const child = forkedChildren[before];
  expect(child, "expected the handle to have forked exactly one child").toBeDefined();
  expect(handle.status).toBe("running");
  // Precondition for both tests: the process is alive and the command channel
  // is usable. Without this the assertions below could pass vacuously.
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(child.stdin?.destroyed ?? true).toBe(false);

  return { handle, child };
}

afterEach(() => {
  for (const child of forkedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

describe("plugin worker stdin command-channel supervision", () => {
  it("kills the worker and schedules a restart when stdin dies while the process is alive", async () => {
    const { handle, child } = await startPersistentWorker();

    try {
      const crashes: Array<{ signal: NodeJS.Signals | null; willRestart: boolean }> = [];
      handle.on("crash", (payload) => {
        crashes.push({ signal: payload.signal, willRestart: payload.willRestart });
      });

      const exited = exitWithin(child, 2_000);

      // The failure shape from the field: the command pipe dies, the worker
      // process does not. This fixture deliberately survives stdin EOF, so
      // nothing but the host supervision can end it.
      child.stdin?.destroy(epipe());

      const exit = await exited;

      expect(
        exit,
        "worker was left alive and uncommandable after its command channel died",
      ).not.toBeNull();
      // SIGKILL is the discriminator: the fixture never exits on its own
      // within the test window, and it exits 0 when asked politely. Only the
      // supervision path produces a signalled exit here.
      expect(exit!.signal).toBe("SIGKILL");

      await vi.waitFor(() => {
        expect(crashes).toHaveLength(1);
      });
      expect(crashes[0]?.willRestart).toBe(true);

      // The recovery that matters is the restart, not the kill: a worker that
      // is killed and not rescheduled is still gone.
      expect(handle.status).toBe("backoff");
      const diagnostics = handle.diagnostics();
      expect(diagnostics.consecutiveCrashes).toBe(1);
      expect(diagnostics.nextRestartAt).not.toBeNull();
      expect(diagnostics.nextRestartAt!).toBeGreaterThan(Date.now());
    } finally {
      // stop() cancels the pending backoff timer, so no restart escapes.
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not force-kill or restart when stdin dies during an intentional stop", async () => {
    // The risky arm of the change: a graceful stop closes the command channel
    // as a matter of course, and must not be mistaken for the failure above.
    const { handle, child } = await startPersistentWorker();

    const crashes: unknown[] = [];
    handle.on("crash", (payload) => crashes.push(payload));

    const exited = nextExit(child);

    // Kill the command channel mid-stop, while the fixture is still inside its
    // deferred-exit window. Without the intentionalStop guard this SIGKILLs a
    // worker that was already shutting down cleanly.
    const destroyed = destroyStdinOnShutdown(child);
    const stopping = handle.stop();

    const { aliveAtDestroy } = await destroyed;
    expect(
      aliveAtDestroy,
      "fixture exited before the command channel was killed — the guard was never exercised",
    ).toBe(true);

    await stopping;
    const { code, signal } = await exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(crashes).toHaveLength(0);
    expect(handle.status).toBe("stopped");

    const diagnostics = handle.diagnostics();
    expect(diagnostics.totalCrashes).toBe(0);
    expect(diagnostics.nextRestartAt).toBeNull();
  });
});
