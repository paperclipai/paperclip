import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  listHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  reconcileHeartbeatRunScratch,
  type HeartbeatRunScratch,
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

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while a pid-only run process is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processPid: 456,
      isPidAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("reconciles every marked scratch directory owned by the terminal run", async () => {
    const owned = await Promise.all([
      trackScratch(await prepareHeartbeatRunScratch({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
      })),
      trackScratch(await prepareHeartbeatRunScratch({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
      })),
    ]);
    const other = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-2",
    }));

    const result = await reconcileHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      processGroupId: 123,
      isProcessGroupAlive: () => false,
    });

    expect(result).toEqual({
      processGroupAlive: false,
      removedDirs: expect.arrayContaining(owned.map((scratch) => scratch.dir)),
      remainingDirs: [],
    });
    await Promise.all(owned.map((scratch) => expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" })));
    await expect(fs.stat(other.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("lists only valid marked scratch directories for post-exit reconciliation", async () => {
    const owned = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-list",
      agentId: "agent-list",
      runId: "run-list",
    }));
    const unmarked = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-list-"));
    cleanupDirs.add(unmarked);

    const listed = await listHeartbeatRunScratch();

    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dir: owned.dir,
        metadata: expect.objectContaining({ runId: "run-list" }),
      }),
    ]));
    expect(listed.some((entry) => entry.dir === unmarked)).toBe(false);
  });

  it("fails closed when a run-named scratch directory has a corrupt marker", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-corrupt-marker-123456",
    }));
    await fs.writeFile(scratch.markerPath, "not-json", "utf8");

    const result = await reconcileHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-corrupt-marker-123456",
    });

    expect(result.remainingDirs).toContain(scratch.dir);
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
