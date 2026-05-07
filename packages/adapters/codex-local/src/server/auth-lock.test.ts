import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetCodexAuthLockQueueForTests,
  acquireCodexAuthLock,
  resolveDefaultCodexAuthLockPath,
} from "./auth-lock.js";

let tmpDir: string;
let lockPath: string;

beforeEach(async () => {
  await __resetCodexAuthLockQueueForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-lock-"));
  lockPath = path.join(tmpDir, ".paperclip-auth-refresh.lock");
});

afterEach(async () => {
  await __resetCodexAuthLockQueueForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveDefaultCodexAuthLockPath", () => {
  it("uses CODEX_HOME when set", () => {
    expect(resolveDefaultCodexAuthLockPath({ CODEX_HOME: "/tmp/codex" })).toBe(
      "/tmp/codex/.paperclip-auth-refresh.lock",
    );
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", () => {
    expect(resolveDefaultCodexAuthLockPath({})).toBe(
      path.join(os.homedir(), ".codex", ".paperclip-auth-refresh.lock"),
    );
  });
});

describe("acquireCodexAuthLock", () => {
  it("creates a lock file while held and removes it on release", async () => {
    const handle = await acquireCodexAuthLock({ lockPath, holdTimeoutMs: 0 });
    const stat = await fs.stat(lockPath);
    expect(stat.isFile()).toBe(true);

    await handle.release();
    expect(handle.released()).toBe(true);

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent in-process acquisitions", async () => {
    const order: string[] = [];

    const first = acquireCodexAuthLock({ lockPath, holdTimeoutMs: 0 }).then(async (handle) => {
      order.push("first:acquired");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("first:releasing");
      await handle.release();
    });

    const second = acquireCodexAuthLock({ lockPath, holdTimeoutMs: 0 }).then(async (handle) => {
      order.push("second:acquired");
      await handle.release();
    });

    await Promise.all([first, second]);

    expect(order).toEqual([
      "first:acquired",
      "first:releasing",
      "second:acquired",
    ]);
  });

  it("waits for an existing on-disk lock to release before claiming", async () => {
    // Write a fresh, "owned" lock file from a fake pid that we keep alive
    // (use process.pid so pidIsAlive returns true).
    const payload = {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: Date.now(),
      acquirer: "external-test-holder",
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(payload));

    const sleeps: number[] = [];
    let cleared = false;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      // After two polls, simulate the external holder releasing the lock.
      if (!cleared && sleeps.length >= 2) {
        cleared = true;
        await fs.rm(lockPath, { force: true });
      }
    };

    const handle = await acquireCodexAuthLock({ lockPath, holdTimeoutMs: 0, sleep });
    expect(sleeps.length).toBeGreaterThan(0);
    await handle.release();
  });

  it("reclaims a lock older than staleMs", async () => {
    const stalePayload = {
      pid: 999_999, // unlikely-to-exist pid
      hostname: os.hostname(),
      startedAt: Date.now() - 10_000,
      acquirer: "external-stale",
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(stalePayload));

    const reclaimedLogs: string[] = [];
    const handle = await acquireCodexAuthLock({
      lockPath,
      holdTimeoutMs: 0,
      staleMs: 1_000,
      onLog: (m) => {
        reclaimedLogs.push(m);
      },
    });
    expect(reclaimedLogs.some((m) => m.includes("Reclaiming stale"))).toBe(true);
    await handle.release();
  });

  it("auto-releases after holdTimeoutMs even if release() is never called", async () => {
    const handle = await acquireCodexAuthLock({ lockPath, holdTimeoutMs: 25 });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(handle.released()).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent on repeated release()", async () => {
    const handle = await acquireCodexAuthLock({ lockPath, holdTimeoutMs: 0 });
    await handle.release();
    await handle.release();
    expect(handle.released()).toBe(true);
  });
});
