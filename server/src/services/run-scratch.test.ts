import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  sweepOrphanedRunScratch,
  type HeartbeatRunScratch,
  type RunScratchSweepRunState,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });
});

describe("orphaned run scratch sweep", () => {
  async function makeRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-test-"));
    cleanupDirs.add(root);
    return root;
  }
  async function leave(root: string, runId: string, createdAt = new Date().toISOString()) {
    const dir = await fs.mkdtemp(path.join(root, `paperclip-run-x-${runId}-`));
    await fs.writeFile(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId, issueId: null, issueIdentifier: null, createdAt }),
    );
    return dir;
  }
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  const states = (m: Record<string, RunScratchSweepRunState>) => async (ids: string[]) =>
    new Map(ids.map((id) => [id, m[id] ?? "missing"] as const));

  it("removes leftover attempt dirs of a terminal run, keeps active and unmarked dirs", async () => {
    const root = await makeRoot();
    const killedA = await leave(root, "run-done");
    const killedB = await leave(root, "run-done");
    const active = await leave(root, "run-live");
    const unmarked = await fs.mkdtemp(path.join(root, "paperclip-run-x-nomarker-"));
    const foreign = await fs.mkdtemp(path.join(root, "other-"));

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      resolveRunStates: states({ "run-done": "terminal", "run-live": "active" }),
    });

    expect(result.removed.sort()).toEqual([killedA, killedB].sort());
    expect(await exists(killedA)).toBe(false);
    expect(await exists(killedB)).toBe(false);
    expect(await exists(active)).toBe(true);
    expect(await exists(unmarked)).toBe(true);
    expect(await exists(foreign)).toBe(true);
  });

  it("limits a per-run sweep to that run", async () => {
    const root = await makeRoot();
    const a = await leave(root, "run-a");
    const b = await leave(root, "run-b");
    await sweepOrphanedRunScratch({
      tmpRoot: root,
      runId: "run-a",
      resolveRunStates: states({ "run-a": "terminal", "run-b": "terminal" }),
    });
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
  });

  it("keeps dirs whose run this instance cannot see, however old", async () => {
    const root = await makeRoot();
    const foreignRun = await leave(root, "run-other-instance", new Date(Date.now() - 48 * 3600_000).toISOString());
    await sweepOrphanedRunScratch({ tmpRoot: root, resolveRunStates: states({}) });
    expect(await exists(foreignRun)).toBe(true);
  });

  it("reaches orphans past the scan limit on repeated sweeps", async () => {
    const root = await makeRoot();
    const kept = [await leave(root, "run-keep1"), await leave(root, "run-keep2")];
    const orphan = await leave(root, "run-zzorphan");
    const resolveRunStates = states({ "run-keep1": "active", "run-keep2": "active", "run-zzorphan": "terminal" });
    for (let i = 0; i < 3 && (await exists(orphan)); i += 1) {
      await sweepOrphanedRunScratch({ tmpRoot: root, maxScan: 2, resolveRunStates });
    }
    expect(await exists(orphan)).toBe(false);
    expect(await exists(kept[0]!)).toBe(true);
    expect(await exists(kept[1]!)).toBe(true);
  });

  it("finds a run's dirs for a per-run sweep regardless of unrelated entries", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 4; i += 1) await leave(root, `run-other${i}`);
    const target = await leave(root, "run-target");
    await sweepOrphanedRunScratch({
      tmpRoot: root,
      runId: "run-target",
      maxScan: 1,
      resolveRunStates: states({ "run-target": "terminal" }),
    });
    expect(await exists(target)).toBe(false);
  });

  it("does not follow symlinks and bounds removals per sweep", async () => {
    const root = await makeRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-outside-"));
    cleanupDirs.add(outside);
    await fs.writeFile(
      path.join(outside, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId: "run-t", createdAt: new Date().toISOString() }),
    );
    await fs.symlink(outside, path.join(root, "paperclip-run-x-link"));
    const dirs = [await leave(root, "run-t"), await leave(root, "run-t"), await leave(root, "run-t")];

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      maxRemove: 2,
      resolveRunStates: states({ "run-t": "terminal" }),
    });

    expect(await exists(outside)).toBe(true);
    expect(result.removed).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect((await Promise.all(dirs.map(exists))).filter(Boolean)).toHaveLength(1);
  });
});
