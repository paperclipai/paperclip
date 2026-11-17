import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  MAX_RUN_TEMP_SOCKET_PATH_BYTES,
  buildHeartbeatRunScratchEnv,
  classifyRunScratchDir,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  removeRunTempTree,
  runTempDirPath,
  runTempRoot,
  runTempSegment,
  runTempSocketPathBudget,
  sweepOrphanedRunScratch,
  type HeartbeatRunScratch,
  type RunScratchSweepRunState,
} from "./run-scratch.js";
import {
  bindRetainedAiCredentialHome,
  reconcileRetainedAiCleanup,
  retainAiCredentialCleanup,
} from "./retained-ai-credential-cleanup.js";

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

async function makeIsolatedTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtemp-isolated-"));
  cleanupDirs.add(root);
  return root;
}

const runId = (seed: string) => `${seed.padEnd(8, "0").slice(0, 8)}-1111-2222-3333-444444444444`;

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("run-1"),
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
        runId: runId("run-1"),
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
      runId: runId("run-1"),
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: runId("run-2"),
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
      runId: runId("run-1"),
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("keeps directories outside the runner-owned roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elsewhere-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: runId("run-1"),
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date().toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    expect(classifyRunScratchDir(dir)).toBeNull();
    expect(classifyRunScratchDir(path.join(runTempRoot(), "abcdef01"))).toBe("run_temp");
    expect(classifyRunScratchDir(runTempRoot())).toBeNull();
    expect(classifyRunScratchDir(path.join(os.tmpdir(), "paperclip-run-x"))).toBe("tmp");
    expect(classifyRunScratchDir(path.join(os.tmpdir(), "unrelated"))).toBeNull();
  });

  it("does not act on a scratch directory replaced by a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-root-"));
    cleanupDirs.add(root);
    const victim = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-victim-"));
    cleanupDirs.add(victim);
    const linkPath = path.join(root, "linked");
    await fs.symlink(victim, linkPath);
    const scratch: HeartbeatRunScratch = {
      dir: linkPath,
      markerPath: path.join(linkPath, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: runId("run-1"),
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date().toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root });

    expect(result).toEqual({ removed: false, dir: linkPath, reason: "symlink" });
    await expect(fs.stat(victim)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});

describe("per-run scratch directory placement", () => {
  it("creates a short, private, deterministic directory outside the shared temp root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const id = runId("abcdef12");
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: id,
      root,
    }));

    expect(scratch.dir).toBe(path.join(root, runTempSegment(id)));
    expect(path.dirname(scratch.dir)).toBe(root);
    expect(runTempSocketPathBudget(id, root)).toBeLessThan(MAX_RUN_TEMP_SOCKET_PATH_BYTES);
    expect(path.join("/home/u", ".pctmp", runTempSegment(id))).toHaveLength(23);
    expect(runTempDirPath(id, "/home/u/.pctmp")).toHaveLength(23);
    expect(runTempSocketPathBudget(id, "/home/u/.pctmp")).toBe(40);
    const stats = await fs.stat(scratch.dir);
    expect(stats.mode & 0o777).toBe(0o700);
    const markerStat = await fs.stat(scratch.markerPath);
    expect(markerStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(scratch.markerPath, "utf8"))).toMatchObject({ runId: id });
  });

  it("reuses the deterministic directory for another attempt of the same run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const id = runId("aaaabbbb");
    const first = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: id, root }));
    await fs.writeFile(path.join(first.dir, "leftover.txt"), "earlier attempt");
    const second = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: id, root }));

    expect(second.dir).toBe(first.dir);
    expect(JSON.parse(await fs.readFile(second.markerPath, "utf8"))).toMatchObject({ runId: id });
  });

  it("falls back to a suffixed directory when another run holds the short name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const id = runId("ccccdddd");
    const first = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: id, root }));
    const colliding = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-2", agentId: "agent-1", runId: id, root }));

    expect(colliding.dir).not.toBe(first.dir);
    expect(path.basename(colliding.dir).startsWith(`${runTempSegment(id)}-`)).toBe(true);
    expect(path.dirname(colliding.dir)).toBe(root);
  });

  it("exports TMPDIR, TMP and TEMP even when the environment already sets them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("run-1"),
      root,
    }));

    const result = buildHeartbeatRunScratchEnv(scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBe(scratch.dir);
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TMPDIR", "TEMP", "TMP"]);
  });
});

describe("run scratch tree removal safety", () => {
  it("unlinks symlinks inside the tree without following them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const victimDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    cleanupDirs.add(victimDir);
    await fs.writeFile(path.join(victimDir, "precious.txt"), "keep me");
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("aaaa1111"), root }));
    await fs.mkdir(path.join(scratch.dir, "nested"));
    await fs.writeFile(path.join(scratch.dir, "nested", "cache.bin"), "x");
    await fs.symlink(victimDir, path.join(scratch.dir, "nested", "escape"));

    const result = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(victimDir, "precious.txt"), "utf8")).resolves.toBe("keep me");
  });

  it("keeps the directory when a child sits on another device", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    await fs.mkdir(path.join(dir, "mountpoint"));
    await fs.writeFile(path.join(dir, "mountpoint", "inside.txt"), "y");
    const realLstat = (p: string) => fs.lstat(p);
    const lstat = async (p: string) => {
      const stats = await realLstat(p);
      return p === path.join(dir, "mountpoint")
        ? { dev: stats.dev + 1, isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink() }
        : stats;
    };

    const result = await removeRunTempTree(dir, { lstat: lstat as typeof realLstat });

    expect(result).toEqual({ complete: false });
    await expect(fs.stat(path.join(dir, "mountpoint", "inside.txt"))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.stat(path.join(dir, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a kept directory through cleanup with the mount reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("bbbb2222"), root }));
    await fs.mkdir(path.join(scratch.dir, "mountpoint"));
    const realLstat = (p: string) => fs.lstat(p);
    const lstat = async (p: string) => {
      const stats = await realLstat(p);
      return p === path.join(scratch.dir, "mountpoint")
        ? { dev: stats.dev + 1, isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink() }
        : stats;
    };

    const result = await cleanupHeartbeatRunScratch({ scratch, lstat: lstat as typeof realLstat, runTempRootOverride: root });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    await expect(fs.stat(path.join(scratch.dir, "mountpoint"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("keeps the ownership marker while removal is blocked, and completes the removal on retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("cccc1111"), root }));
    await fs.mkdir(path.join(scratch.dir, "mountpoint"));
    await fs.writeFile(path.join(scratch.dir, "mountpoint", "inside.txt"), "y");
    let mounted = true;
    const realLstat = (p: string) => fs.lstat(p);
    const lstat = async (p: string) => {
      const stats = await realLstat(p);
      return mounted && p === path.join(scratch.dir, "mountpoint")
        ? { dev: stats.dev + 1, isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink() }
        : stats;
    };

    const first = await cleanupHeartbeatRunScratch({ scratch, lstat: lstat as typeof realLstat, runTempRootOverride: root });

    // The interrupted removal must leave the ownership marker in place, or the
    // directory becomes an unmarked orphan no later sweep can act on.
    expect(first).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    await expect(fs.stat(scratch.markerPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(scratch.markerPath, "utf8")).resolves.toContain(scratch.metadata.runId);

    mounted = false;
    const second = await cleanupHeartbeatRunScratch({ scratch, lstat: lstat as typeof realLstat, runTempRootOverride: root });

    expect(second).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the scratch directory while a retained credential home is pending write-back", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("dddd2222"),
    }));
    const providerHome = path.join(scratch.dir, "paperclip-ai-company-1-grant", "provider");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.writeFile(path.join(providerHome, "auth.json"), "fixture-credential");
    const scope = { companyId: "company-1", accountKey: "grant-dddd2222" };
    const release = bindRetainedAiCredentialHome(providerHome, scope);
    retainAiCredentialCleanup({ scope, home: providerHome, cleanup: async () => {} });
    try {
      const result = await cleanupHeartbeatRunScratch({ scratch });

      expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "ai_home_retained" });
      await expect(fs.readFile(path.join(providerHome, "auth.json"), "utf8")).resolves.toBe("fixture-credential");
    } finally {
      await reconcileRetainedAiCleanup(scope).catch(() => undefined);
      release();
    }
  });

  it("keeps a retained credential home when the scratch root is reached through a symlinked ancestor", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-real-"));
    cleanupDirs.add(realRoot);
    const alias = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-alias-"));
    await fs.rmdir(alias);
    await fs.symlink(realRoot, alias);
    cleanupDirs.add(alias);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("eeee6666"),
      root: alias,
    }));
    const providerHome = path.join(scratch.dir, "paperclip-ai-company-1-grant", "provider");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.writeFile(path.join(providerHome, "auth.json"), "fixture-credential");
    // The Antigravity runtime registers its home after realpath: the retained
    // home is canonical while the scratch directory keeps the symlinked name.
    const canonicalHome = await fs.realpath(providerHome);
    expect(canonicalHome).not.toBe(providerHome);
    const scope = { companyId: "company-1", accountKey: "grant-eeee6666" };
    const release = bindRetainedAiCredentialHome(canonicalHome, scope);
    retainAiCredentialCleanup({ scope, home: canonicalHome, cleanup: async () => {} });
    try {
      const result = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: alias });

      expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "ai_home_retained" });
      await expect(fs.readFile(path.join(providerHome, "auth.json"), "utf8")).resolves.toBe("fixture-credential");
      await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await reconcileRetainedAiCleanup(scope).catch(() => undefined);
      release();
    }
  });
});

describe("orphaned run scratch sweep", () => {
  async function makeRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-test-"));
    cleanupDirs.add(root);
    return root;
  }
  async function sweepLegacy(root: string, input: Parameters<typeof sweepOrphanedRunScratch>[0]) {
    const isolated = await makeIsolatedTempRoot();
    return sweepOrphanedRunScratch({ ...input, tmpRoot: root, runTempRootOverride: isolated });
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

    const result = await sweepLegacy(root, {
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
    await sweepLegacy(root, {
      runId: "run-a",
      resolveRunStates: states({ "run-a": "terminal", "run-b": "terminal" }),
    });
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
  });

  it("keeps dirs whose run this instance cannot see, however old", async () => {
    const root = await makeRoot();
    const foreignRun = await leave(root, "run-other-instance", new Date(Date.now() - 48 * 3600_000).toISOString());
    await sweepLegacy(root, { resolveRunStates: states({}) });
    expect(await exists(foreignRun)).toBe(true);
  });

  it("reaches orphans past the scan limit on repeated sweeps", async () => {
    const root = await makeRoot();
    const kept = [await leave(root, "run-keep1"), await leave(root, "run-keep2")];
    const orphan = await leave(root, "run-zzorphan");
    const resolveRunStates = states({ "run-keep1": "active", "run-keep2": "active", "run-zzorphan": "terminal" });
    for (let i = 0; i < 3 && (await exists(orphan)); i += 1) {
      await sweepLegacy(root, { maxScan: 2, resolveRunStates });
    }
    expect(await exists(orphan)).toBe(false);
    expect(await exists(kept[0]!)).toBe(true);
    expect(await exists(kept[1]!)).toBe(true);
  });

  it("finds a run's dirs for a per-run sweep regardless of unrelated entries", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 4; i += 1) await leave(root, `run-other${i}`);
    const target = await leave(root, "run-target");
    await sweepLegacy(root, {
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

    const result = await sweepLegacy(root, {
      maxRemove: 2,
      resolveRunStates: states({ "run-t": "terminal" }),
    });

    expect(await exists(outside)).toBe(true);
    expect(result.removed).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect((await Promise.all(dirs.map(exists))).filter(Boolean)).toHaveLength(1);
  });

  it("keeps a terminal run's directories while its process group is still alive", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-done");

    const alive = await sweepLegacy(root, {
      resolveRunStates: states({ "run-done": "terminal" }),
      isRunProcessGroupAlive: () => true,
    });

    expect(alive.removed).toEqual([]);
    expect(await exists(dir)).toBe(true);

    const exited = await sweepLegacy(root, {
      resolveRunStates: states({ "run-done": "terminal" }),
      isRunProcessGroupAlive: () => false,
    });

    expect(exited.removed).toEqual([dir]);
    expect(await exists(dir)).toBe(false);
  });

  it("keeps a terminal run's directory while a retained credential home is pending, then removes it after reconciliation", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-done");
    const providerHome = path.join(dir, "paperclip-ai-c-grant", "provider");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.writeFile(path.join(providerHome, "auth.json"), "fixture-credential");
    const scope = { companyId: "c", accountKey: "grant-run-done" };
    const release = bindRetainedAiCredentialHome(providerHome, scope);
    let writeBacks = 0;
    retainAiCredentialCleanup({ scope, home: providerHome, cleanup: async () => { writeBacks += 1; } });
    try {
      const pending = await sweepLegacy(root, {
        resolveRunStates: states({ "run-done": "terminal" }),
      });

      expect(pending.removed).toEqual([]);
      expect(await exists(path.join(providerHome, "auth.json"))).toBe(true);
      expect(await exists(dir)).toBe(true);

      // The save becomes available: reconciliation completes the write-back and
      // retires the home, so the next sweep can remove the directory.
      await reconcileRetainedAiCleanup(scope);
      expect(writeBacks).toBe(1);

      const swept = await sweepLegacy(root, {
        resolveRunStates: states({ "run-done": "terminal" }),
      });

      expect(swept.removed).toEqual([dir]);
      expect(await exists(dir)).toBe(false);
    } finally {
      await reconcileRetainedAiCleanup(scope).catch(() => undefined);
      release();
    }
  });
});

describe("orphaned run temp sweep", () => {
  async function makeTempRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtemp-sweep-"));
    cleanupDirs.add(root);
    return root;
  }
  async function leaveTemp(root: string, id: string) {
    const dir = path.join(root, runTempSegment(id));
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId: id, issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
    );
    return dir;
  }
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  const states = (m: Record<string, RunScratchSweepRunState>) => async (ids: string[]) =>
    new Map(ids.map((id) => [id, m[id] ?? "missing"] as const));

  it("keeps a terminal run's directory behind a symlinked temp root until the retained home retires", async () => {
    const realRoot = await makeTempRoot();
    const alias = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtemp-alias-"));
    await fs.rmdir(alias);
    await fs.symlink(realRoot, alias);
    cleanupDirs.add(alias);
    const isolated = await makeIsolatedTempRoot();
    const dir = await leaveTemp(alias, runId("gggg7777"));
    const providerHome = path.join(dir, "paperclip-ai-c-grant", "provider");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.writeFile(path.join(providerHome, "auth.json"), "fixture-credential");
    // The retained home is registered canonically (realpath) while the sweep
    // sees the run's directory through the symlinked temp root.
    const canonicalHome = await fs.realpath(providerHome);
    expect(canonicalHome).not.toBe(providerHome);
    const scope = { companyId: "c", accountKey: "grant-gggg7777" };
    const release = bindRetainedAiCredentialHome(canonicalHome, scope);
    retainAiCredentialCleanup({ scope, home: canonicalHome, cleanup: async () => {} });
    try {
      const pending = await sweepOrphanedRunScratch({
        tmpRoot: isolated,
        runTempRootOverride: alias,
        resolveRunStates: states({ [runId("gggg7777")]: "terminal" }),
      });

      expect(pending.removed).toEqual([]);
      expect(await exists(path.join(providerHome, "auth.json"))).toBe(true);
      expect(await exists(dir)).toBe(true);

      // Once the write-back retires the home, the canonical match disappears
      // and the sweep completes the removal through the symlinked root.
      await reconcileRetainedAiCleanup(scope);

      const swept = await sweepOrphanedRunScratch({
        tmpRoot: isolated,
        runTempRootOverride: alias,
        resolveRunStates: states({ [runId("gggg7777")]: "terminal" }),
      });

      expect(swept.removed).toEqual([dir]);
      expect(await exists(dir)).toBe(false);
    } finally {
      await reconcileRetainedAiCleanup(scope).catch(() => undefined);
      release();
    }
  });

  it("sweeps terminal-run directories that carry no paperclip-run prefix", async () => {
    const root = await makeTempRoot();
    const isolated = await makeIsolatedTempRoot();
    const terminal = await leaveTemp(root, runId("dddd3333"));
    const active = await leaveTemp(root, runId("eeee4444"));
    await fs.mkdir(path.join(root, "stranger"), { mode: 0o700 });

    const result = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: states({ [runId("dddd3333")]: "terminal", [runId("eeee4444")]: "active" }),
    });

    expect(result.removed).toEqual([terminal]);
    expect(await exists(terminal)).toBe(false);
    expect(await exists(active)).toBe(true);
    expect(await exists(path.join(root, "stranger"))).toBe(true);
  });

  it("limits a per-run sweep to the deterministic name and its fallbacks", async () => {
    const root = await makeTempRoot();
    const isolated = await makeIsolatedTempRoot();
    const id = runId("ffff5555");
    const main = await leaveTemp(root, id);
    const fallback = path.join(root, `${runTempSegment(id)}-extra`);
    await fs.mkdir(fallback, { mode: 0o700 });
    await fs.writeFile(
      path.join(fallback, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId: id, issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
    );
    await leaveTemp(root, runId("0f0f0f0f"));

    await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      runId: id,
      resolveRunStates: states({ [id]: "terminal", [runId("0f0f0f0f")]: "terminal" }),
    });

    expect(await exists(main)).toBe(false);
    expect(await exists(fallback)).toBe(false);
    expect(await exists(path.join(root, runTempSegment(runId("0f0f0f0f"))))).toBe(true);
  });
});
