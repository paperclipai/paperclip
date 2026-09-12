import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS,
  sweepOrphanedRunScratchDirs,
  startRunScratchSweeper,
} from "./run-scratch-sweeper.js";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  prepareHeartbeatRunScratch,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

const track = (dir: string) => {
  cleanupDirs.add(dir);
  return dir;
};

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-sweep-test-"));
  cleanupDirs.add(root);
  return root;
}

async function prepareIn(root: string, input: {
  runId: string;
  createdAt?: Date;
}): Promise<HeartbeatRunScratch> {
  const scratch = await prepareHeartbeatRunScratch({
    companyId: "company-1",
    agentId: "agent-1",
    ...input,
  });
  // Relocate the prepared dir under the test root so the sweeper's scan finds
  // only what we control.
  const renamed = path.join(root, path.basename(scratch.dir));
  await fs.rename(scratch.dir, renamed);
  const tracked: HeartbeatRunScratch = { ...scratch, dir: renamed, markerPath: path.join(renamed, HEARTBEAT_RUN_SCRATCH_MARKER) };
  track(renamed);
  return tracked;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("sweepOrphanedRunScratchDirs", () => {
  it("removes a marked scratch dir whose run record is missing after the grace period", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-gone" });

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async () => null,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.removedDirs).toEqual([scratch.dir]);
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a marked scratch dir whose run is terminal", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-failed" });

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async (runId) =>
        runId === "run-failed" ? { status: "failed" } : null,
    });

    expect(result.removed).toBe(1);
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a marked scratch dir whose run is still running", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-live" });

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async (runId) =>
        runId === "run-live" ? { status: "running" } : null,
    });

    expect(result.removed).toBe(0);
    expect(result.skippedLiveRun).toBe(1);
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("leaves dirs younger than the grace period even when terminal", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-fresh" });

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + 1000),
      tmpRoot: root,
      loadRun: async () => ({ status: "succeeded" }),
    });

    expect(result.removed).toBe(0);
    expect(result.skippedTooYoung).toBe(1);
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("removes read-only go-module-cache style content after a best-effort chmod", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-ro" });
    const roDir = path.join(scratch.dir, "gomodcache", "example.com@v1");
    await fs.mkdir(roDir, { recursive: true });
    const roFile = path.join(roDir, "pkg.a");
    await fs.writeFile(roFile, "cached");
    await fs.chmod(roDir, 0o500);
    await fs.chmod(roFile, 0o400);

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async () => ({ status: "timed_out" }),
    });

    expect(result.removed).toBe(1);
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores directories without a valid marker", async () => {
    const root = await makeTmpRoot();
    const foreign = await fs.mkdtemp(path.join(root, "paperclip-run-unmarked-"));
    track(foreign);
    await fs.writeFile(path.join(foreign, "keep.txt"), "data");

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async () => null,
    });

    expect(result.removed).toBe(0);
    await expect(fs.stat(foreign)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips run-status lookups when the DB loader errors", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-dberror" });

    const result = await sweepOrphanedRunScratchDirs({
      now: new Date(Date.now() + DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS + 1000),
      tmpRoot: root,
      loadRun: async () => {
        throw new Error("db down");
      },
    });

    expect(result.removed).toBe(0);
    expect(result.skippedUnreadable).toBe(1);
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});

describe("startRunScratchSweeper", () => {
  it("sweeps on the startup timer and stops cleanly", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-timer" });

    const sweeper = startRunScratchSweeper({
      db: undefined as unknown as never,
      startupDelayMs: 25,
      minAgeMs: 0,
      tmpRoot: root,
      loadRun: async () => null,
    });
    try {
      // Wait for the startup timer sweep to fire.
      for (let i = 0; i < 50 && (await fs.stat(scratch.dir).then(() => true, () => false)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      sweeper.stop();
    }
    expect(() => sweeper.stop()).not.toThrow();
  });

  it("sweepOnce removes an orphan and stop() prevents further sweeps", async () => {
    const root = await makeTmpRoot();
    const scratch = await prepareIn(root, { runId: "run-once" });

    const sweeper = startRunScratchSweeper({
      db: undefined as unknown as never,
      startupDelayMs: 60_000,
      intervalMs: 60_000,
      minAgeMs: 0,
      tmpRoot: root,
      loadRun: async () => ({ status: "cancelled" }),
    });
    try {
      const result = await sweeper.sweepOnce();
      expect(result.removed).toBe(1);
      await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      sweeper.stop();
    }
  });
});