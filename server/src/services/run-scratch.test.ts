import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER,
  HEARTBEAT_TASK_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  cleanupHeartbeatTaskScratch,
  prepareHeartbeatRunScratch,
  prepareHeartbeatTaskScratch,
  releaseHeartbeatTaskScratchLease,
  resolveHeartbeatTaskScratchRoot,
  sweepHeartbeatTaskScratchForIssue,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

/** The server process of a lease: one that is still running, and one that is not. */
const aliveProcess = () => true;
const deadProcess = () => false;

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

async function makeInstanceRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-instance-root-"));
  cleanupDirs.add(root);
  return root;
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
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });

  it("falls back to the run directory for task scratch when the run has no issue", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({}, scratch, null);

    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
  });
});

describe("heartbeat task scratch", () => {
  it("points task scratch at a durable directory outside the run directory", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
    }));
    const taskScratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      instanceRoot,
    });

    const result = buildHeartbeatRunScratchEnv({}, scratch, taskScratch);

    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(taskScratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).not.toBe(scratch.dir);
    // The run directory is an mkdtemp under the system temp root; the task
    // directory must not be inside it, or the run teardown takes it away.
    expect(path.relative(scratch.dir, taskScratch.dir).startsWith("..")).toBe(true);
    expect(taskScratch.dir).toBe(
      path.join(resolveHeartbeatTaskScratchRoot({ instanceRoot }), "company-1", "agent-1", "issue-1"),
    );
    // The run-scoped variables keep their per-run meaning.
    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
  });

  it("survives the run scratch teardown that ends a heartbeat", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
    }));
    const taskScratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    await fs.writeFile(path.join(taskScratch.dir, "corpus.txt"), "unpacked source");

    expect(await cleanupHeartbeatRunScratch({ scratch })).toEqual({ removed: true, dir: scratch.dir });

    await expect(fs.readFile(path.join(taskScratch.dir, "corpus.txt"), "utf8")).resolves.toBe(
      "unpacked source",
    );
  });

  it("resolves the same directory on every heartbeat of one task", async () => {
    const instanceRoot = await makeInstanceRoot();
    const first = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-07-08T00:00:00.000Z"),
    });
    await fs.writeFile(path.join(first.dir, "notes.md"), "heartbeat one");

    const second = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(second.dir).toBe(first.dir);
    // Adoption keeps the first heartbeat's marker, so the directory has one age.
    expect(second.metadata.createdAt).toBe("2026-07-08T00:00:00.000Z");
    await expect(fs.readFile(path.join(second.dir, "notes.md"), "utf8")).resolves.toBe("heartbeat one");
  });

  it("keeps one task's directory out of another task's reach", async () => {
    const instanceRoot = await makeInstanceRoot();
    const mine = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    const other = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-2",
      instanceRoot,
    });

    expect(other.dir).not.toBe(mine.dir);
  });

  it("refuses an identifier that would escape the task scratch root", async () => {
    const instanceRoot = await makeInstanceRoot();

    await expect(
      prepareHeartbeatTaskScratch({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "../../../etc",
        instanceRoot,
      }),
    ).rejects.toThrow(/Invalid issueId/);
  });

  it("sweeps every agent's directory for a terminal issue and leaves other issues alone", async () => {
    const instanceRoot = await makeInstanceRoot();
    const agentOne = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    const agentTwo = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-2",
      issueId: "issue-1",
      instanceRoot,
    });
    const openIssue = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-2",
      instanceRoot,
    });
    const otherCompany = await prepareHeartbeatTaskScratch({
      companyId: "company-2",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });

    const result = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
    });

    expect(result.removed.sort()).toEqual([agentOne.dir, agentTwo.dir].sort());
    expect(result.skipped).toEqual([]);
    await expect(fs.stat(agentOne.dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(agentTwo.dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(openIssue.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(otherCompany.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("sweeps an issue that no agent worked without error", async () => {
    const instanceRoot = await makeInstanceRoot();

    const result = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("preserves a directory in the task root that carries no ownership marker", async () => {
    const instanceRoot = await makeInstanceRoot();
    const stray = path.join(
      resolveHeartbeatTaskScratchRoot({ instanceRoot }),
      "company-1",
      "agent-1",
      "issue-1",
    );
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(path.join(stray, "keep.txt"), "not ours");

    const result = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ dir: stray, reason: "unmarked" }]);
    await expect(fs.readFile(path.join(stray, "keep.txt"), "utf8")).resolves.toBe("not ours");
  });

  it("preserves a directory whose marker names a different owner", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    await fs.writeFile(
      path.join(scratch.dir, HEARTBEAT_TASK_SCRATCH_MARKER),
      `${JSON.stringify({ ...scratch.metadata, issueId: "issue-9" }, null, 2)}\n`,
    );

    const result = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ dir: scratch.dir, reason: "owner_mismatch" }]);
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("refuses to remove a task scratch handle pointing outside the task root", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-not-task-scratch-"));
    cleanupDirs.add(outside);

    const result = await cleanupHeartbeatTaskScratch({
      scratch: { ...scratch, dir: outside },
      instanceRoot,
    });

    expect(result).toEqual({ removed: false, dir: outside, reason: "outside_root" });
    await expect(fs.stat(outside)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("removes the directory of one task through the task-scoped cleanup", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });

    const result = await cleanupHeartbeatTaskScratch({ scratch, instanceRoot });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("heartbeat task scratch is not removed from under a running run", () => {
  it("defers the sweep while a run holds a lease and keeps the files", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      runId: "run-1",
    });
    await fs.writeFile(path.join(scratch.dir, "corpus.txt"), "work in progress");

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      isProcessAlive: aliveProcess,
    });

    expect(sweep.removed).toEqual([]);
    expect(sweep.deferred).toEqual([scratch.dir]);
    // Deferral is not a failure, so it is not reported as one.
    expect(sweep.skipped).toEqual([]);
    await expect(fs.readFile(path.join(scratch.dir, "corpus.txt"), "utf8")).resolves.toBe(
      "work in progress",
    );
  });

  it("completes the deferred sweep when the last lease is released", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      runId: "run-1",
    });
    const closedAt = new Date();
    await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      closedAt,
      isProcessAlive: aliveProcess,
    });
    expect(await fs.readdir(scratch.dir)).toContain(HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER);

    const release = await releaseHeartbeatTaskScratchLease({
      scratch,
      instanceRoot,
      isProcessAlive: aliveProcess,
      now: new Date(closedAt.getTime() + 1000),
    });

    expect(release.released).toBe(true);
    expect(release.deferredCleanup).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the directory while another run still holds a lease", async () => {
    const instanceRoot = await makeInstanceRoot();
    const first = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      runId: "run-1",
    });
    const second = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      runId: "run-2",
    });
    const closedAt = new Date(Date.now() + 60_000);
    await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      closedAt,
      isProcessAlive: aliveProcess,
    });

    const release = await releaseHeartbeatTaskScratchLease({
      scratch: first,
      instanceRoot,
      isProcessAlive: aliveProcess,
    });

    expect(release.deferredCleanup).toEqual({
      removed: false,
      dir: second.dir,
      reason: "run_active",
    });
    await expect(fs.stat(second.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("does not let a lease from a dead server pin the directory", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      runId: "run-1",
      serverPid: 999_999,
    });

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      isProcessAlive: deadProcess,
    });

    expect(sweep.removed).toEqual([scratch.dir]);
    expect(sweep.deferred).toEqual([]);
  });
});

describe("heartbeat task scratch survives a reopened issue", () => {
  it("refuses a sweep whose issue was adopted again after the close", async () => {
    const instanceRoot = await makeInstanceRoot();
    const closedAt = new Date("2026-10-05T12:00:00.000Z");
    const first = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-10-05T11:00:00.000Z"),
    });
    await fs.writeFile(path.join(first.dir, "corpus.txt"), "work of the reopened task");
    // The issue is reopened and a new heartbeat adopts the directory before the
    // sweep queued by the close gets to run.
    await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-10-05T12:00:01.000Z"),
    });

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      closedAt,
      isProcessAlive: deadProcess,
    });

    expect(sweep.removed).toEqual([]);
    expect(sweep.skipped).toEqual([{ dir: first.dir, reason: "reopened" }]);
    await expect(fs.readFile(path.join(first.dir, "corpus.txt"), "utf8")).resolves.toBe(
      "work of the reopened task",
    );
  });

  it("sweeps a task no heartbeat adopted after the close", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-10-05T11:00:00.000Z"),
    });

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      closedAt: new Date("2026-10-05T12:00:00.000Z"),
      isProcessAlive: deadProcess,
    });

    expect(sweep.removed).toEqual([scratch.dir]);
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the original creation time when a later heartbeat adopts the directory", async () => {
    const instanceRoot = await makeInstanceRoot();
    const first = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-10-05T11:00:00.000Z"),
    });
    const second = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
      now: new Date("2026-10-05T13:00:00.000Z"),
    });

    expect(second.metadata.createdAt).toBe(first.metadata.createdAt);
    expect(second.metadata.lastPreparedAt).toBe("2026-10-05T13:00:00.000Z");
  });
});

describe("heartbeat task scratch refuses links and unverifiable markers", () => {
  it("refuses to prepare a task directory whose agent component is a link", async () => {
    const instanceRoot = await makeInstanceRoot();
    const root = resolveHeartbeatTaskScratchRoot({ instanceRoot });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-outside-task-scratch-"));
    cleanupDirs.add(outside);
    await fs.mkdir(path.join(root, "company-1"), { recursive: true });
    await fs.symlink(outside, path.join(root, "company-1", "agent-1"), "dir");

    await expect(
      prepareHeartbeatTaskScratch({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        instanceRoot,
      }),
    ).rejects.toThrow(/is a link/);
    // Nothing was written through the link, so nothing outside the root can
    // later be removed as though it were ours.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses to remove through a linked path component", async () => {
    const instanceRoot = await makeInstanceRoot();
    const root = resolveHeartbeatTaskScratchRoot({ instanceRoot });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-outside-task-scratch-"));
    cleanupDirs.add(outside);
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    // Swap the real agent directory for a link to a tree that is not ours,
    // carrying a marker that would otherwise pass the ownership check.
    await fs.rm(path.join(root, "company-1", "agent-1"), { recursive: true, force: true });
    const decoy = path.join(outside, "issue-1");
    await fs.mkdir(decoy, { recursive: true });
    await fs.writeFile(path.join(decoy, "keep-me.txt"), "not ours to delete");
    await fs.writeFile(
      path.join(decoy, HEARTBEAT_TASK_SCRATCH_MARKER),
      JSON.stringify({ ...scratch.metadata }),
    );
    await fs.symlink(outside, path.join(root, "company-1", "agent-1"), "dir");

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      isProcessAlive: deadProcess,
    });

    expect(sweep.removed).toEqual([]);
    expect(sweep.skipped).toEqual([
      { dir: path.join(root, "company-1", "agent-1", "issue-1"), reason: "outside_root" },
    ]);
    await expect(fs.readFile(path.join(decoy, "keep-me.txt"), "utf8")).resolves.toBe(
      "not ours to delete",
    );
  });

  it("refuses to adopt a directory whose marker cannot be verified", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    await fs.writeFile(path.join(scratch.dir, HEARTBEAT_TASK_SCRATCH_MARKER), "{ not json");

    await expect(
      prepareHeartbeatTaskScratch({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        instanceRoot,
      }),
    ).rejects.toThrow(/cannot be verified/);
    // The damaged marker is left as it was rather than replaced by one that
    // would make this run the recorded owner.
    await expect(
      fs.readFile(path.join(scratch.dir, HEARTBEAT_TASK_SCRATCH_MARKER), "utf8"),
    ).resolves.toBe("{ not json");
  });

  it("refuses to sweep a directory whose marker cannot be verified", async () => {
    const instanceRoot = await makeInstanceRoot();
    const scratch = await prepareHeartbeatTaskScratch({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      instanceRoot,
    });
    await fs.writeFile(
      path.join(scratch.dir, HEARTBEAT_TASK_SCRATCH_MARKER),
      JSON.stringify({ version: 2, companyId: "company-1", agentId: "agent-1", issueId: "issue-1" }),
    );

    const sweep = await sweepHeartbeatTaskScratchForIssue({
      companyId: "company-1",
      issueId: "issue-1",
      instanceRoot,
      isProcessAlive: deadProcess,
    });

    expect(sweep.removed).toEqual([]);
    expect(sweep.skipped).toEqual([{ dir: scratch.dir, reason: "marker_unverifiable" }]);
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});
