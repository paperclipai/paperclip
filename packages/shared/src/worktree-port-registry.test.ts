import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  withWorktreePortRegistryLock,
  withWorktreePortRegistryLockSync,
} from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];
const supportsLoopbackListen = (() => {
  try {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import net from 'node:net'; const server = net.createServer(); server.once('error', () => process.exit(1)); server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));",
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await delay(25);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The registry heartbeat depends on opening a loopback probe socket. Some
// sandboxes deny local binds entirely, so this suite can only run when that
// capability is present.
describe.skipIf(!supportsLoopbackListen)("worktree port registry lock", () => {
  it("does not reclaim a stale lock while its fallback ownership probe responds", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    let secondEntered = false;
    let second: Promise<void> | null = null;

    const first = withWorktreePortRegistryLock(homeDir, async () => {
      const leaseHeartbeatMtime = fs.statSync(lockPath).mtimeMs;
      await waitForCondition(() => fs.statSync(lockPath).mtimeMs > leaseHeartbeatMtime);
      fs.renameSync(path.join(lockPath, "owner.json"), path.join(lockPath, "owner.unavailable.json"));
      const backupOwnerPath = path.join(lockPath, "owner.backup.json");
      const owner = JSON.parse(fs.readFileSync(backupOwnerPath, "utf8"));
      fs.writeFileSync(backupOwnerPath, `${JSON.stringify({
        ...owner,
        processIdentity: "unavailable-process-identity",
      })}\n`);
      // Backdate immediately after a heartbeat tick so the contender sees a
      // stale lease before the next background refresh can run.
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeGreaterThan(5_000);

      // Start the contender before yielding so it races the stale lease, not a
      // later heartbeat refresh.
      const contender = withWorktreePortRegistryLock(homeDir, async () => {
        secondEntered = true;
      });
      contender.catch(() => {});
      second = contender;
      await delay(100);

      expect(secondEntered).toBe(false);
    });
    await first;
    if (!second) {
      throw new Error("Expected the contender to start while the first lock holder was active");
    }
    await second;
    expect(secondEntered).toBe(true);
  }, 10_000);

  it("refreshes the lease throughout an async critical section", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");

    await withWorktreePortRegistryLock(homeDir, async () => {
      await delay(5_250);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(2_000);
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
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(1_250);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
