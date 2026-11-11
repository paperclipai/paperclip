import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  withWorktreePortRegistryLock,
  withWorktreePortRegistryLockSync,
} from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

// Answers the same one-exchange ownership probe protocol the real lock
// heartbeat serves, so a test can hold a lock's "owner is alive and
// responsive" state without a live heartbeat thread touching the lock's
// mtime in the background. This runs on its own worker thread, not the
// main thread, because the code under test blocks the calling thread
// (Atomics.wait) while it waits for a probe answer; a same-thread server
// could never respond to its own blocked caller.
// The worker posts an "owned" message back to the main thread each time it
// answers a probe with "owned". The test waits on that message instead of a
// fixed delay, so the assertion that follows only runs after the probe has
// actually answered at least one ownership check, not merely after some
// wall-clock time.
const FAKE_OWNERSHIP_PROBE_SOURCE = `
const net = require("node:net");
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const server = net.createServer((socket) => {
  socket.once("data", (candidate) => {
    const answer = candidate.toString("utf8") === workerData.token ? "owned" : "denied";
    if (answer === "owned") parentPort.postMessage("owned");
    socket.end(answer);
  });
});
server.once("error", () => {
  Atomics.store(control, 0, -1);
  Atomics.notify(control, 0);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  Atomics.store(control, 1, address.port);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
});
parentPort.once("message", () => {
  server.close(() => process.exit(0));
});
`;

function startFakeOwnershipProbe(token: string): {
  port: number;
  waitForOwnedResponse: (timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
} {
  const control = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(FAKE_OWNERSHIP_PROBE_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { control: control.buffer, token },
  });
  Atomics.wait(control, 0, 0, 5_000);
  const port = Atomics.load(control, 1);
  if (Atomics.load(control, 0) !== 1 || port <= 0) {
    void worker.terminate();
    throw new Error("The fake ownership probe failed to start.");
  }

  let ownedResponseSeen = false;
  const ownedWaiters: Array<() => void> = [];
  worker.on("message", (message: unknown) => {
    if (message !== "owned") return;
    ownedResponseSeen = true;
    for (const resolveWaiter of ownedWaiters.splice(0)) resolveWaiter();
  });

  return {
    port,
    // Resolves once the probe has answered "owned" at least once. Falls
    // straight through when that has already happened, and otherwise waits
    // for the worker's next "owned" message.
    waitForOwnedResponse: (timeoutMs = 5_000): Promise<void> => {
      if (ownedResponseSeen) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for the fake ownership probe to answer \"owned\"."));
        }, timeoutMs);
        ownedWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    close: () => new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.postMessage("stop");
    }),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree port registry lock", () => {
  it("does not reclaim a stale lock while its fallback ownership probe responds", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const token = "fixed-owner-token";
    const probe = startFakeOwnershipProbe(token);
    let probeClosed = false;
    const closeProbeOnce = async (): Promise<void> => {
      if (probeClosed) return;
      probeClosed = true;
      await probe.close();
    };
    let second: Promise<void> | undefined;

    try {
      // Build the contended state directly instead of holding the lock through
      // a real withWorktreePortRegistryLock call. A real call starts a live
      // heartbeat that rewrites the lock's mtime once a second on a worker
      // thread. That refresh runs concurrently with, and can land inside, the
      // gap between this test backdating the mtime and reading it back, which
      // made the assertion below fail at random under CPU contention. With no
      // live heartbeat, nothing touches the mtime until this test says so.
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          // Deliberately wrong, so a reclaim can only be blocked by the probe
          // answering "owned" below, not by the process-identity fallback.
          processIdentity: "mismatched-process-identity",
          probePort: probe.port,
          token,
        })}\n`,
      );
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

      // Nothing refreshes the lock after this point, so its age only grows.
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeGreaterThan(5_000);

      let secondEntered = false;
      second = withWorktreePortRegistryLock(homeDir, async () => {
        secondEntered = true;
      });
      // Wait for the fake probe to actually answer "owned" before checking
      // secondEntered. A fixed delay can fire before the probe worker gets
      // scheduled under processor contention, letting the assertion below
      // pass without proving the reclaim was blocked by a real "owned"
      // answer.
      await probe.waitForOwnedResponse();

      expect(secondEntered).toBe(false);

      // Retire the owner: the probe stops answering, so the next reclaim
      // attempt falls through to the process-identity check, which the
      // mismatched identity above fails, and the lock is reclaimed.
      await closeProbeOnce();
      await second;
      expect(secondEntered).toBe(true);
    } finally {
      // Run this unconditionally. If an assertion above throws, the fake
      // probe's worker thread must still stop, and the pending lock attempt
      // must still settle, so a failure here does not leak a worker thread
      // or leave an unawaited rejection for a later test file to report.
      await closeProbeOnce();
      await second?.catch(() => {});
    }
  }, 10_000);

  it("refreshes the lease throughout an async critical section", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");

    await withWorktreePortRegistryLock(homeDir, async () => {
      // Count refreshes instead of only checking recency. A recency check
      // alone tolerates a regressed heartbeat interval: a tick every 3000 ms
      // or 4000 ms still keeps the lock's age under the 5000 ms staleness
      // threshold at the end of this window, so it would pass. Counting the
      // distinct mtimes the lock passes through does not depend on when a
      // tick lands, only on how many land, so it still catches a regressed
      // interval.
      const observedTimestamps = new Set<number>();
      const pollDeadline = Date.now() + 5_250;
      while (Date.now() < pollDeadline) {
        observedTimestamps.add(fs.statSync(lockPath).mtimeMs);
        await delay(100);
      }
      // A 1000 ms heartbeat interval produces about 6 distinct values here
      // (the initial touch plus about 5 refreshes). A regressed 3000 ms
      // interval produces only 2, so this catches the regression that a
      // recency-only check would miss.
      expect(observedTimestamps.size).toBeGreaterThanOrEqual(3);
      // The heartbeat's other correctness job is to keep the lock's mtime
      // below the staleness threshold (5 seconds) while the lock is held.
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(5_000);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);

  it("reclaims an old lock after its owner process exits", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        probePort: 1,
        token: "dead-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an old lock when its pid belongs to a different process", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "reused-pid-owner",
        probePort: 1,
        token: "abandoned-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refreshes the lease while a synchronous critical section blocks the main thread", () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const blocker = new Int32Array(new SharedArrayBuffer(4));

    withWorktreePortRegistryLockSync(homeDir, () => {
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      Atomics.wait(blocker, 0, 0, 1_500);
      // Same reasoning as the async critical-section test above: assert
      // against the staleness threshold the heartbeat exists to defend,
      // not a tight margin coupled to one heartbeat interval.
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(5_000);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
