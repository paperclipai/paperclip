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
    const stopping = handle.stop();

    // stopInternal() sets intentionalStop before it writes the shutdown RPC.
    await vi.waitFor(() => {
      expect(handle.status).toBe("stopping");
      // ...and the shutdown must have drained out of the host before the pipe
      // is killed, or this would be testing a dropped shutdown instead.
      expect(child.stdin?.writableLength ?? 0).toBe(0);
    });

    // Kill the command channel mid-stop, while the fixture is still inside its
    // deferred-exit window. Without the intentionalStop guard this SIGKILLs a
    // worker that was already shutting down cleanly.
    child.stdin?.destroy(epipe());

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
