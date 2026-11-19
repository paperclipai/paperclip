import fs from "node:fs/promises";
import fss from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  MAX_RUN_TEMP_SOCKET_PATH_BYTES,
  RUN_SCRATCH_QUARANTINE_RECEIPT,
  buildHeartbeatRunScratchEnv,
  classifyRunScratchDir,
  cleanupHeartbeatRunScratch,
  createDefaultRunScratchWalkerOps,
  prepareHeartbeatRunScratch,
  removeRunTempTree,
  runTempDirPath,
  runTempRoot,
  runTempSegment,
  runTempSocketPathBudget,
  sweepOrphanedRunScratch,
  type HeartbeatRunScratch,
  type RunScratchSweepRunState,
  type RunScratchWalkerOpsOverride,
} from "./run-scratch.js";
import {
  acquireAiCredentialTeardownHold,
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

  // Simulates a mount point by making both the anchored lstat and the fd
  // stat of a child report a foreign device, consistently.
  function foreignDeviceOps(isMounted: () => boolean, name: string): RunScratchWalkerOpsOverride {
    return (base) => {
      const fdPaths = new Map<number, string>();
      return {
        openDir: async (p, opts) => {
          const fd = await base.openDir(p, opts);
          fdPaths.set(fd, p);
          return fd;
        },
        statDir: async (fd) => {
          const identity = await base.statDir(fd);
          return isMounted() && (fdPaths.get(fd)?.endsWith(`/${name}`) ?? false)
            ? { ...identity, dev: identity.dev + 1 }
            : identity;
        },
        lstatPath: async (p) => {
          const stats = await base.lstatPath(p);
          if (!isMounted() || !p.endsWith(`/${name}`)) return stats;
          // Node keeps Stats methods on the prototype: rebind them explicitly.
          return {
            ...stats,
            dev: stats.dev + 1,
            isDirectory: () => stats.isDirectory(),
            isSymbolicLink: () => stats.isSymbolicLink(),
          };
        },
      };
    };
  }

  it("keeps the directory when a child sits on another device", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    await fs.mkdir(path.join(dir, "mountpoint"));
    await fs.writeFile(path.join(dir, "mountpoint", "inside.txt"), "y");

    const result = await removeRunTempTree(dir, { walkerOps: foreignDeviceOps(() => true, "mountpoint") });

    expect(result).toEqual({ complete: false });
    await expect(fs.stat(path.join(dir, "mountpoint", "inside.txt"))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.stat(path.join(dir, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a kept directory through cleanup with the mount reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("bbbb2222"), root }));
    await fs.mkdir(path.join(scratch.dir, "mountpoint"));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: foreignDeviceOps(() => true, "mountpoint"),
      runTempRootOverride: root,
    });

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

    const first = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: foreignDeviceOps(() => mounted, "mountpoint"),
      runTempRootOverride: root,
    });

    // The interrupted removal must leave the ownership marker in place, or the
    // directory becomes an unmarked orphan no later sweep can act on.
    expect(first).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    await expect(fs.stat(scratch.markerPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(scratch.markerPath, "utf8")).resolves.toContain(scratch.metadata.runId);

    mounted = false;
    const second = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: foreignDeviceOps(() => mounted, "mountpoint"),
      runTempRootOverride: root,
    });

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

  it("keeps the marker and the external target when a child directory is swapped for a symlink mid-walk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("hhhh8888"), root }));
    const child = path.join(scratch.dir, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "inside.txt"), "x");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "external-precious");
    // Swap the verified child for a symlink immediately after the parent
    // listing returns: every later lookup of the name happens through the
    // anchored path, so the swap is detected and nothing below it is touched.
    let swapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      listDir: async (fd) => {
        const entries = await base.listDir(fd);
        if (!swapped) {
          swapped = true;
          await fs.rename(child, `${child}-moved`);
          await fs.symlink(outside, child);
        }
        return entries;
      },
    });

    const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "unsafe_tree" });
    await expect(fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("external-precious");
    await expect(fs.stat(scratch.markerPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(scratch.markerPath, "utf8")).resolves.toContain(scratch.metadata.runId);
    await expect(fs.lstat(child)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
  });

  it("keeps the marker and the external target when a child is swapped right after its anchored verification", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("iiii9999"), root }));
    const child = path.join(scratch.dir, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "sentinel.txt"), "x");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "external-precious");
    // Swap the child for a symlink after its anchored lstat verified the
    // directory but before the descent opens it: the anchored open refuses
    // the symlinked name (O_NOFOLLOW), so the foreign tree is never entered.
    let swapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      openDir: async (p, opts) => {
        if (!swapped && p.endsWith("/child")) {
          swapped = true;
          await fs.rename(child, `${child}-moved`);
          await fs.symlink(outside, child);
        }
        return base.openDir(p, opts);
      },
    });

    const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });

    expect(swapped).toBe(true);
    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "unsafe_tree" });
    await expect(fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("external-precious");
    await expect(fs.stat(scratch.markerPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(scratch.markerPath, "utf8")).resolves.toContain(scratch.metadata.runId);
  });

  it("keeps the external target when the marker name is recreated as a symlink before the restore", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("jjjj0000"), root }));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    const sentinel = path.join(outside, "sentinel-restore.txt");
    await fs.writeFile(sentinel, "external-precious");
    // By the final rmdir the marker is already unlinked and the directory is
    // empty: a concurrent writer recreates the marker name as a symlink to an
    // external file, so the rmdir fails with the name occupied. The restore
    // must refuse to follow or truncate the symlinked name — an exclusive
    // create neither follows nor overwrites.
    let boobyTrapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      rmdir: async (p) => {
        if (!boobyTrapped && p.endsWith(`/${path.basename(scratch.dir)}`)) {
          boobyTrapped = true;
          await fs.symlink(sentinel, scratch.markerPath);
        }
        return base.rmdir(p);
      },
    });

    const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });

    expect(boobyTrapped).toBe(true);
    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("external-precious");
    await expect(fs.lstat(scratch.markerPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("restores the marker through the anchored fd when a concurrent writer refills the directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("kkkk1111"), root }));
    // A benign concurrent writer adds a regular file after the marker was
    // unlinked: the rmdir fails, and the restore must recreate the marker
    // exclusively so the retry evidence survives the interrupted removal.
    let refilled = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      rmdir: async (p) => {
        if (!refilled && p.endsWith(`/${path.basename(scratch.dir)}`)) {
          refilled = true;
          await fs.writeFile(path.join(scratch.dir, "late.txt"), "late");
        }
        return base.rmdir(p);
      },
    });

    const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });

    expect(refilled).toBe(true);
    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    await expect(fs.lstat(scratch.markerPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(scratch.markerPath, "utf8")).resolves.toContain(scratch.metadata.runId);
    await expect(fs.readFile(path.join(scratch.dir, "late.txt"), "utf8")).resolves.toBe("late");
  });

  it("keeps the renamed directory with a restored marker instead of reporting a false removal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("llll2222"), root }));
    const moved = path.join(root, `${path.basename(scratch.dir)}-moved`);
    // Right after the walker unlinks the marker, a concurrent process renames
    // the emptied directory: the final rmdir then finds the old name missing,
    // but the inode held open survives under the new name. The cleanup must
    // not report success and must put the marker back into that inode.
    let renamed = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      unlink: async (p) => {
        await base.unlink(p);
        if (!renamed && p.endsWith(`/${HEARTBEAT_RUN_SCRATCH_MARKER}`)) {
          renamed = true;
          await fs.rename(scratch.dir, moved);
        }
      },
    });

    const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });

    expect(renamed).toBe(true);
    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "unsafe_tree" });
    await expect(fs.stat(moved)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.lstat(path.join(moved, HEARTBEAT_RUN_SCRATCH_MARKER))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(path.join(moved, HEARTBEAT_RUN_SCRATCH_MARKER), "utf8")).resolves.toContain(scratch.metadata.runId);
  });

  // VPS-786 finding 1: a concurrent writer that opened the scratch root
  // before the removal keeps acting through its held fd alone — it never
  // needs to know the random quarantine name. Swapping a child directory
  // for a symlink right after the walker verified it must never redirect a
  // deletion into the foreign tree, in either anchoring mode.
  it("keeps the external sentinel when a pre-quarantine fd holder swaps a child right after its verification", async () => {
    for (const mode of ["auto", "paths"] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
      cleanupDirs.add(root);
      const scratch = await trackScratch(await prepareHeartbeatRunScratch({
        companyId: "company-1",
        agentId: "agent-1",
        runId: runId(mode === "auto" ? "hold1111" : "hold2222"),
        root,
      }));
      const child = path.join(scratch.dir, "child");
      await fs.mkdir(child);
      await fs.writeFile(path.join(child, "sentinel.txt"), "scratch fixture");
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
      cleanupDirs.add(outside);
      await fs.writeFile(path.join(outside, "sentinel.txt"), "preserve fixture");
      const held = await fs.open(scratch.dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const base = createDefaultRunScratchWalkerOps(mode);
      let concurrentChange = false;
      const walkerOps: RunScratchWalkerOpsOverride = () => ({
        ...base,
        unlinkEntry: async (fd, name) => {
          if (!concurrentChange && name === "sentinel.txt") {
            // The writer renames the verified child and plants a symlink in
            // its place, using exclusively the fd opened before the removal:
            // the swap lands between the walker's last verification and the
            // unlink syscall.
            let retained = `/proc/self/fd/${held.fd}`;
            if (mode === "paths" || !(await fs.stat(retained).then(() => true, () => false))) {
              // macOS has no procfs. Find the moved root by the identity of
              // the fd the writer already holds, then execute the same swap.
              const identity = await held.stat();
              const candidates = await fs.readdir(root);
              let matched: string | undefined;
              for (const candidate of candidates) {
                const p = path.join(root, candidate);
                const stat = await fs.lstat(p);
                if (stat.dev === identity.dev && stat.ino === identity.ino) matched = p;
              }
              expect(matched).toBeDefined();
              retained = matched!;
            }
            await fs.rename(`${retained}/child`, `${retained}/child-saved`);
            await fs.symlink(outside, `${retained}/child`);
            concurrentChange = true;
          }
          return base.unlinkEntry(fd, name);
        },
      });
      try {
        const result = await cleanupHeartbeatRunScratch({ scratch, walkerOps, runTempRootOverride: root });
        const outsidePreserved = await fs
          .readFile(path.join(outside, "sentinel.txt"), "utf8")
          .then((s) => s === "preserve fixture", () => false);
        expect({ mode, concurrentChange, outsidePreserved, removed: result.removed }).toEqual({
          mode, concurrentChange: true, outsidePreserved: true, removed: false,
        });
      } finally {
        await held.close();
      }
    }
  });
});

describe("portable walker fallback (platforms without /proc/self/fd)", () => {
  // macOS has no /proc/self/fd: the walker must still finish removals there.
  const pathsOps = (): RunScratchWalkerOpsOverride => () => createDefaultRunScratchWalkerOps("paths");

  it("completes the removal of an empty scratch directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("port2222"), root }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: pathsOps(),
      runTempRootOverride: root,
    });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes the removal of a nested tree without following escaped symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const victimDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    cleanupDirs.add(victimDir);
    await fs.writeFile(path.join(victimDir, "precious.txt"), "keep me");
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("port3333"), root }));
    await fs.mkdir(path.join(scratch.dir, "nested", "deeper"), { recursive: true });
    await fs.writeFile(path.join(scratch.dir, "nested", "deeper", "cache.bin"), "x");
    await fs.symlink(victimDir, path.join(scratch.dir, "nested", "escape"));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: pathsOps(),
      runTempRootOverride: root,
    });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(victimDir, "precious.txt"), "utf8")).resolves.toBe("keep me");
  });

  it("keeps the tree through path-based ops when a listing no longer matches the held directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    // The recorded path is swapped for a symlink after the open: the listing
    // identity check must refuse to feed foreign entries into the removal.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-other-tree-"));
    cleanupDirs.add(other);
    await fs.writeFile(path.join(other, "foreign.txt"), "y");
    const paths = createDefaultRunScratchWalkerOps("paths");
    const override: RunScratchWalkerOpsOverride = () => ({
      ...paths,
      openDir: async (p, opts) => {
        const fd = await paths.openDir(p, opts);
        if (p === dir) await fs.rename(dir, `${dir}-moved`).catch(() => undefined).then(async () => {
          await fs.symlink(other, dir).catch(() => undefined);
        });
        return fd;
      },
    });

    const result = await removeRunTempTree(dir, { walkerOps: override });

    expect(result).toEqual({ complete: false });
    await expect(fs.readFile(path.join(other, "foreign.txt"), "utf8")).resolves.toBe("y");
  });

  it("refuses the portable removal when a foreign directory takes the verified name before the rename", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    const attacker = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-attacker-"));
    cleanupDirs.add(attacker);
    await fs.writeFile(path.join(attacker, "sentinel.txt"), "precious");
    // The attacker moves their own directory over the name right after the
    // identity proof: the quarantine receipt write is anchored to the fd's
    // recorded path, so the stolen name makes the anchor refuse and the
    // removal fails closed before any rename — both trees stay intact.
    const paths = createDefaultRunScratchWalkerOps("paths");
    let fired = false;
    const override: RunScratchWalkerOpsOverride = () => ({
      ...paths,
      statDir: async (fd) => {
        const identity = await paths.statDir(fd);
        if (!fired) {
          fired = true;
          await fs.rename(dir, `${dir}-moved`).catch(() => undefined);
          await fs.rename(attacker, dir).catch(() => undefined);
        }
        return identity;
      },
    });

    const result = await removeRunTempTree(dir, { walkerOps: override });

    expect(result).toEqual({ complete: false });
    // The attacker's tree survived at the stolen name, and the verified
    // original survives under the moved name: nothing was destroyed or
    // quarantined.
    await expect(fs.readFile(path.join(dir, "sentinel.txt"), "utf8")).resolves.toBe("precious");
    await expect(fs.readFile(path.join(`${dir}-moved`, "file.txt"), "utf8")).resolves.toBe("x");

    // When the steal lands between the receipt write and the rename, the
    // rename relocates the impostor: only a matching dev/ino may be
    // destroyed under the quarantine name, and the suspicious tree is
    // parked under a `-suspect-` name no retry or sweep would ever treat
    // as this directory's own quarantined remnant.
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree2-"));
    cleanupDirs.add(dir2);
    await fs.writeFile(path.join(dir2, "file.txt"), "x");
    const attacker2 = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-attacker2-"));
    cleanupDirs.add(attacker2);
    await fs.writeFile(path.join(attacker2, "sentinel.txt"), "precious");
    let stolen = false;
    const override2: RunScratchWalkerOpsOverride = () => ({
      ...paths,
      writeEntryExclusive: async (fd, name, data, mode) => {
        await paths.writeEntryExclusive(fd, name, data, mode);
        if (!stolen && name === RUN_SCRATCH_QUARANTINE_RECEIPT) {
          stolen = true;
          await fs.rename(dir2, `${dir2}-moved`).catch(() => undefined);
          await fs.rename(attacker2, dir2).catch(() => undefined);
        }
      },
    });

    const result2 = await removeRunTempTree(dir2, { walkerOps: override2 });

    expect(result2).toEqual({ complete: false });
    const suspect = (await fs.readdir(path.dirname(dir2))).find((n) => n.startsWith(`${path.basename(dir2)}-suspect-`));
    expect(suspect).toBeDefined();
    await expect(fs.readFile(path.join(path.dirname(dir2), suspect!, "sentinel.txt"), "utf8")).resolves.toBe("precious");
    const retry = await removeRunTempTree(dir2, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
    expect(retry).toEqual({ complete: true });
    await expect(fs.readFile(path.join(path.dirname(dir2), suspect!, "sentinel.txt"), "utf8")).resolves.toBe("precious");
  });

  it("keeps the foreign tree when the name is swapped between the identity proof and the portable rename", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    const victim = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    cleanupDirs.add(victim);
    await fs.writeFile(path.join(victim, "file.txt"), "precious");
    // The swap lands right after the pre-flight lstat inside the portable
    // quarantine: whatever the rename then moves must be proven to be the
    // verified directory or simply unlinked as a link — the victim is never
    // reached, and the removal refuses instead of completing.
    const paths = createDefaultRunScratchWalkerOps("paths");
    const override: RunScratchWalkerOpsOverride = () => ({
      ...paths,
      lstatPath: async (p) => {
        const stats = await paths.lstatPath(p);
        if (p === dir) {
          await fs.rename(dir, `${dir}-moved`).catch(() => undefined);
          await fs.symlink(victim, dir).catch(() => undefined);
        }
        return stats;
      },
    });

    const result = await removeRunTempTree(dir, { walkerOps: override });

    expect(result).toEqual({ complete: false });
    await expect(fs.readFile(path.join(victim, "file.txt"), "utf8")).resolves.toBe("precious");
  });

  it("completes inside the quarantine name and never operates through the original path again", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const victim = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    cleanupDirs.add(victim);
    await fs.writeFile(path.join(victim, "precious.txt"), "keep me");
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("quar5555"), root }));
    await fs.mkdir(path.join(scratch.dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(scratch.dir, "nested", "cache.bin"), "x");
    // After the quarantine rename the original name is free: an attacker
    // plants a symlink to a foreign tree there while the removal runs inside
    // the fresh quarantine name. Every operation after the rename is anchored
    // inside the quarantined tree, so nothing may resolve through the planted
    // original name: the foreign tree stays untouched and the removal of the
    // quarantined tree still completes.
    const paths = createDefaultRunScratchWalkerOps("paths");
    let quarantined = false;
    const override: RunScratchWalkerOpsOverride = () => ({
      ...paths,
      openDir: async (p: string, opts?: { follow?: boolean }) => {
        if (!quarantined && p !== scratch.dir && p.startsWith(`${scratch.dir}-rm-`)) {
          quarantined = true; // the quarantine rename completed
          await fs.symlink(victim, scratch.dir).catch(() => undefined);
        }
        return paths.openDir(p, opts);
      },
    });

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: override,
      runTempRootOverride: root,
    });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    expect(quarantined).toBe(true);
    // The planted symlink at the original name was never followed or removed:
    // resolving any post-rename operation through it would have destroyed or
    // consumed the foreign tree.
    await expect(fs.lstat(scratch.dir)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    await expect(fs.readFile(path.join(victim, "precious.txt"), "utf8")).resolves.toBe("keep me");
    // The quarantined tree is fully gone: no `-rm-` remnant is left behind.
    const remaining = await fs.readdir(root);
    expect(remaining.filter((n) => n.includes("-rm-"))).toEqual([]);
  });

  it("reports the anchoring mode the default ops resolved to", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devtree-"));
    cleanupDirs.add(dir);
    try {
      expect(createDefaultRunScratchWalkerOps("paths").anchoring).toBe("paths");
      const auto = createDefaultRunScratchWalkerOps("auto");
      expect(auto.anchoring).toBe("paths"); // unresolved until the first open
      await removeRunTempTree(dir, { walkerOps: () => auto });
      // This host supports /proc/self/fd: the probe upgrades to full anchoring.
      expect(auto.anchoring).toBe(process.platform === "linux" ? "procfd" : "paths");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // VPS-786 finding 3: the run temp root may legitimately be reached through
  // a stable symlink alias. The intentionally-followed parent open must stay
  // verifiable with follow semantics, so the portable cleanup of an alias
  // rooted scratch directory terminates instead of failing forever.
  it("completes the portable cleanup of a scratch root reached through a stable symlink alias", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-alias-parent-"));
    cleanupDirs.add(parent);
    const realRoot = path.join(parent, "real-root");
    const alias = path.join(parent, "alias");
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, alias);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("alia3333"),
      root: alias,
    }));
    await fs.mkdir(path.join(scratch.dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(scratch.dir, "nested", "cache.bin"), "x");

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: () => createDefaultRunScratchWalkerOps("paths"),
      runTempRootOverride: alias,
    });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(realRoot)).toEqual([]);
  });

  // VPS-786 finding 2: an interrupted portable removal renames the target
  // under `<base>-rm-<random>` while callers keep the original path. Absence
  // of the original must never be read as completion while the renamed tree
  // still exists, and the retry has to keep operating on the renamed tree.
  it("never completes a retry while the quarantined tree still exists, and clears it on the retry", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retry-"));
    cleanupDirs.add(parent);
    const home = path.join(parent, "paperclip-ai-fixture");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "sentinel.txt"), "fixture pending cleanup");
    const blockedUnlink = () => {
      const paths = createDefaultRunScratchWalkerOps("paths");
      return () => ({
        ...paths,
        unlinkEntry: async () => {
          throw Object.assign(new Error("fixture blocked"), { code: "EACCES" });
        },
      }) satisfies RunScratchWalkerOpsOverride;
    };

    const first = await removeRunTempTree(home, { walkerOps: blockedUnlink() });
    expect(first.complete).toBe(false);
    const remnant = (await fs.readdir(parent)).find((n) => n.startsWith("paperclip-ai-fixture-rm-"));
    expect(remnant).toBeDefined();
    await expect(fs.readFile(path.join(parent, remnant!, "sentinel.txt"), "utf8")).resolves.toBe("fixture pending cleanup");

    // Still-blocked retries keep failing closed and report the effective path.
    const second = await removeRunTempTree(home, { walkerOps: blockedUnlink() });
    expect(second).toMatchObject({ complete: false });
    expect(second.quarantinePath).toContain("paperclip-ai-fixture-rm-");
    await expect(fs.readFile(path.join(parent, remnant!, "sentinel.txt"), "utf8")).resolves.toBe("fixture pending cleanup");

    // An unblocked retry — including one whose caller merely interprets the
    // original path's ENOENT — only completes once the renamed tree is gone.
    const third = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
    expect(third).toEqual({ complete: true });
    await expect(fs.readFile(path.join(parent, remnant!, "sentinel.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(parent)).filter((n) => n.startsWith("paperclip-ai-fixture-rm-"))).toEqual([]);
  });

  it("continues a quarantined run scratch removal when the original name is already gone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("rema4444"),
      root,
    }));
    await fs.mkdir(path.join(scratch.dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(scratch.dir, "nested", "cache.bin"), "x");
    // Simulate an interrupted portable cleanup: the tree was already renamed
    // to its quarantine name when the process died.
    const quarantined = path.join(root, `${path.basename(scratch.dir)}-rm-${"a1b2c3d4e5f6a7b8"}`);
    await fs.rename(scratch.dir, quarantined);

    const result = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(quarantined)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("managed ai home teardown hold", () => {
  it("keeps the scratch directory while a runtime teardown hold is active, then removes it after release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-root-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({ companyId: "company-1", agentId: "agent-1", runId: runId("hold4444"), root }));
    const home = await fs.mkdtemp(path.join(scratch.dir, "paperclip-ai-hold-"));
    const providerHome = path.join(home, "provider");
    await fs.mkdir(providerHome, { mode: 0o700 });
    await fs.writeFile(path.join(providerHome, "auth.json"), "fixture-credential");

    const release = acquireAiCredentialTeardownHold(home);
    try {
      // Direct cleanup defers to the in-flight credential write-back.
      const direct = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root });
      expect(direct).toEqual({ removed: false, dir: scratch.dir, reason: "ai_home_retained" });

      // The orphan sweep sees a terminal run with its process group exited,
      // yet must not race the write-back: the hold keeps the directory.
      const isolated = await makeIsolatedTempRoot();
      const swept = await sweepOrphanedRunScratch({
        tmpRoot: isolated,
        runTempRootOverride: root,
        resolveRunStates: async () => new Map([[scratch.metadata.runId, "terminal" as const]]),
        isRunProcessGroupAlive: () => false,
      });
      expect(swept.removed).toEqual([]);
      expect(swept.pending).toBeGreaterThanOrEqual(1);
      await expect(fs.readFile(path.join(providerHome, "auth.json"), "utf8")).resolves.toBe("fixture-credential");

      // The runtime teardown settled: nothing protects the home anymore.
      release();
      const done = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root });
      expect(done).toEqual({ removed: true, dir: scratch.dir });
      await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
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

  it("classifies kept directories as pending obligations only while this runner owns their cleanup", async () => {
    const root = await makeRoot();
    const active = await leave(root, "run-live");
    const foreign = await leave(root, "run-other-instance");
    const exiting = await leave(root, "run-exiting");

    // Active runs own their directories until they settle: an obligation.
    const withActive = await sweepLegacy(root, {
      resolveRunStates: states({ "run-live": "active", "run-other-instance": "unknown", "run-exiting": "unknown" }),
    });
    expect(withActive.pending).toBe(1);

    // A terminal run whose process group has not exited is unfinished cleanup.
    const withExiting = await sweepLegacy(root, {
      resolveRunStates: states({ "run-live": "active", "run-other-instance": "unknown", "run-exiting": "terminal" }),
      isRunProcessGroupAlive: (id) => id === "run-exiting",
    });
    expect(withExiting.pending).toBe(2);

    // Everything this runner owns settled: no obligation keeps the sweep awake.
    const settled = await sweepLegacy(root, {
      resolveRunStates: states({ "run-live": "active", "run-other-instance": "unknown", "run-exiting": "terminal" }),
    });
    expect(settled.removed).toEqual([exiting]);
    expect(settled.pending).toBe(1); // the still-active run only
    expect(await exists(active)).toBe(true);
    expect(await exists(foreign)).toBe(true);
  });

  it("reports no pending obligation for roots that hold nothing to reclaim", async () => {
    const root = await makeRoot();
    const empty = await sweepLegacy(root, { resolveRunStates: states({}) });
    expect(empty.pending).toBe(0);
    expect(empty.kept).toBe(0);
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

  it("keeps the tree, the marker and the external target when a swept child is swapped for a symlink mid-walk", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-swap");
    const child = path.join(dir, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "inside.txt"), "x");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "external-precious");
    // Swap the swept child for a symlink immediately after the scratch
    // directory's listing returns: the anchored lookup detects the change
    // and the sweep keeps the directory instead of entering the foreign tree.
    let swapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      listDir: async (fd) => {
        const entries = await base.listDir(fd);
        if (!swapped) {
          swapped = true;
          await fs.rename(child, `${child}-moved`);
          await fs.symlink(outside, child);
        }
        return entries;
      },
    });

    const result = await sweepLegacy(root, {
      walkerOps,
      resolveRunStates: states({ "run-swap": "terminal" }),
    });

    expect(result.removed).toEqual([]);
    expect(await exists(path.join(outside, "sentinel.txt"))).toBe(true);
    expect(await exists(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER))).toBe(true);
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a legacy swept directory when its child is swapped right after the anchored verification", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-swap2");
    const child = path.join(dir, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "sentinel.txt"), "x");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "external-precious");
    // Same window as the direct-cleanup regression, proven on the legacy
    // sweep path: the anchored open of the swapped name must refuse.
    let swapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      openDir: async (p, opts) => {
        if (!swapped && p.endsWith("/child")) {
          swapped = true;
          await fs.rename(child, `${child}-moved`);
          await fs.symlink(outside, child);
        }
        return base.openDir(p, opts);
      },
    });

    const result = await sweepLegacy(root, {
      walkerOps,
      resolveRunStates: states({ "run-swap2": "terminal" }),
    });

    expect(swapped).toBe(true);
    expect(result.removed).toEqual([]);
    expect(await exists(path.join(outside, "sentinel.txt"))).toBe(true);
    expect(await exists(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER))).toBe(true);
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a swept directory when the marker name is recreated as a symlink before the restore", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-r6s");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    const sentinel = path.join(outside, "sentinel-restore.txt");
    await fs.writeFile(sentinel, "external-precious");
    // Same window as the direct-cleanup regression, proven on the legacy
    // sweep path: the restore must refuse to follow the symlinked marker
    // name, so no write can land outside the swept directory.
    let boobyTrapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      rmdir: async (p) => {
        if (!boobyTrapped && p.endsWith(`/${path.basename(dir)}`)) {
          boobyTrapped = true;
          await fs.symlink(sentinel, path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
        }
        return base.rmdir(p);
      },
    });

    const result = await sweepLegacy(root, {
      walkerOps,
      resolveRunStates: states({ "run-r6s": "terminal" }),
    });

    expect(boobyTrapped).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("external-precious");
    await expect(fs.lstat(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER))).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a swept directory that is renamed after its marker is unlinked", async () => {
    const root = await makeRoot();
    const dir = await leave(root, "run-r7s");
    const moved = `${dir}-moved`;
    // The rename lands in the window between the marker unlink and the final
    // rmdir: the old name is gone but the inode survives under the moved
    // name, so the sweep must not count it as removed and must restore the
    // marker inside the moved directory.
    let renamed = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      unlink: async (p) => {
        await base.unlink(p);
        if (!renamed && p.endsWith(`/${HEARTBEAT_RUN_SCRATCH_MARKER}`)) {
          renamed = true;
          await fs.rename(dir, moved);
        }
      },
    });

    const result = await sweepLegacy(root, {
      walkerOps,
      resolveRunStates: states({ "run-r7s": "terminal" }),
    });

    expect(renamed).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(await exists(moved)).toBe(true);
    const marker = path.join(moved, HEARTBEAT_RUN_SCRATCH_MARKER);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(marker, "utf8")).resolves.toContain("run-r7s");
    expect(await exists(dir)).toBe(false);
  });

  it("keeps legacy directories that are not provably owned and closed to other writers", async () => {
    const root = await makeRoot();
    const groupWritable = await leave(root, "run-gw");
    await fs.chmod(groupWritable, 0o770);
    const worldWritableMarker = await leave(root, "run-wm");
    await fs.chmod(path.join(worldWritableMarker, HEARTBEAT_RUN_SCRATCH_MARKER), 0o666);
    const safelyOwned = await leave(root, "run-ok");

    const result = await sweepLegacy(root, {
      resolveRunStates: states({ "run-gw": "terminal", "run-wm": "terminal", "run-ok": "terminal" }),
    });

    expect(result.removed).toEqual([safelyOwned]);
    expect(await exists(groupWritable)).toBe(true);
    expect(await exists(worldWritableMarker)).toBe(true);
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

  it("keeps a swept directory when the marker name is recreated as a symlink before the restore", async () => {
    const root = await makeTempRoot();
    const isolated = await makeIsolatedTempRoot();
    const dir = await leaveTemp(root, runId("nnnn4444"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-swap-outside-"));
    cleanupDirs.add(outside);
    const sentinel = path.join(outside, "sentinel-restore.txt");
    await fs.writeFile(sentinel, "external-precious");
    // Same booby-trapped restore as the direct-cleanup regression, proven on
    // the per-run temp root sweep: the exclusive recreate must refuse the
    // symlinked marker name and leave the external file untouched.
    let boobyTrapped = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      rmdir: async (p) => {
        if (!boobyTrapped && p.endsWith(`/${path.basename(dir)}`)) {
          boobyTrapped = true;
          await fs.symlink(sentinel, path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
        }
        return base.rmdir(p);
      },
    });

    const result = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      walkerOps,
      resolveRunStates: states({ [runId("nnnn4444")]: "terminal" }),
    });

    expect(boobyTrapped).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("external-precious");
    await expect(fs.lstat(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER))).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a swept directory that is renamed after its marker is unlinked", async () => {
    const root = await makeTempRoot();
    const isolated = await makeIsolatedTempRoot();
    const dir = await leaveTemp(root, runId("pppp6666"));
    const moved = `${dir}-moved`;
    // Same rename window as the direct-cleanup regression, proven on the
    // per-run temp root sweep: the moved directory keeps its retry marker
    // and is not counted as removed.
    let renamed = false;
    const walkerOps: RunScratchWalkerOpsOverride = (base) => ({
      unlink: async (p) => {
        await base.unlink(p);
        if (!renamed && p.endsWith(`/${HEARTBEAT_RUN_SCRATCH_MARKER}`)) {
          renamed = true;
          await fs.rename(dir, moved);
        }
      },
    });

    const result = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      walkerOps,
      resolveRunStates: states({ [runId("pppp6666")]: "terminal" }),
    });

    expect(renamed).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(await exists(moved)).toBe(true);
    const marker = path.join(moved, HEARTBEAT_RUN_SCRATCH_MARKER);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(fs.readFile(marker, "utf8")).resolves.toContain(runId("pppp6666"));
    expect(await exists(dir)).toBe(false);
  });

  // VPS-786 finding 2: a portable removal interrupted after its quarantine
  // rename leaves an unmarked `<segment>-rm-<random>` directory behind. The
  // sweep — the recovery path for crashed cleanups — must reclaim it instead
  // of keeping it forever as an unmarked orphan. VPS-787 tightened the same
  // contract: only the quarantine receipt written by this runner's own gated
  // removal authorizes the reclaim, and the gates are re-derived from it.
  it("keeps a receipt-less quarantine remnant of unknown ownership, and reclaims a receipted one after its gates resolve", async () => {
    const root = await makeTempRoot();
    const isolated = await makeIsolatedTempRoot();
    const runIdValue = runId("rema4444");
    const segment = runTempSegment(runIdValue);
    const remnant = path.join(root, `${segment}-rm-${"a1b2c3d4e5f6a7b8"}`);
    await fs.mkdir(remnant, { mode: 0o700 });
    await fs.writeFile(path.join(remnant, "cache.bin"), "leftover");
    const receipt = {
      version: 1,
      kind: "scratch",
      companyId: "c",
      agentId: "a",
      runId: runIdValue,
      originalName: segment,
      createdAt: new Date().toISOString(),
    };

    const states = (m: Record<string, RunScratchSweepRunState>) => async (ids: string[]) =>
      new Map(ids.map((id) => [id, m[id] ?? "missing"] as const));

    // Without the receipt the name shape alone is no authorization.
    const foreign = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: states({}),
    });
    expect(foreign.removed).toEqual([]);
    expect(await exists(remnant)).toBe(true);

    // With the receipt the remnant is this runner's unfinished work, but it
    // is only reclaimed once the owning run settled and exited.
    await fs.writeFile(path.join(remnant, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify(receipt));
    let aliveQueries = 0;
    const active = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: states({ [runIdValue]: "active" }),
    });
    expect(active.removed).toEqual([]);
    const alive = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: states({ [runIdValue]: "terminal" }),
      isRunProcessGroupAlive: (id) => { aliveQueries += 1; return id === runIdValue; },
    });
    expect(alive.removed).toEqual([]);
    expect(aliveQueries).toBeGreaterThanOrEqual(1);
    expect(await exists(remnant)).toBe(true);

    const settled = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: states({ [runIdValue]: "terminal" }),
      isRunProcessGroupAlive: () => false,
    });
    expect(settled.removed).toEqual([remnant]);
    expect(await exists(remnant)).toBe(false);
  });

  it("keeps a foreign home quarantine remnant with an active teardown hold, and reclaims a receipted one after release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-test-"));
    cleanupDirs.add(root);
    const isolated = await makeIsolatedTempRoot();
    const remnant = path.join(root, `paperclip-ai-fixture-rm-${"b2c3d4e5f6a7b8c9"}`);
    await fs.mkdir(remnant, { mode: 0o700 });
    const home = path.join(remnant, "provider");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "auth.json"), "held-credential");
    const receipt = {
      version: 1,
      kind: "home",
      companyId: null,
      agentId: null,
      runId: null,
      originalName: "paperclip-ai-fixture",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(remnant, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify(receipt));

    // An active teardown hold inside the remnant protects it even though the
    // receipt is present: protections survive the quarantine rename.
    const release = acquireAiCredentialTeardownHold(home);
    try {
      const held = await sweepOrphanedRunScratch({
        tmpRoot: root,
        runTempRootOverride: isolated,
        resolveRunStates: async () => new Map(),
        isRunProcessGroupAlive: () => true,
      });
      expect(held.removed).toEqual([]);
      expect(await exists(path.join(home, "auth.json"))).toBe(true);
    } finally {
      release();
    }

    const settled = await sweepOrphanedRunScratch({
      tmpRoot: root,
      runTempRootOverride: isolated,
      resolveRunStates: async () => new Map(),
    });
    expect(settled.removed).toEqual([remnant]);
    expect(await exists(remnant)).toBe(false);
  });

  it("keeps a home quarantine remnant that carries no receipt, however it is shaped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-test-"));
    cleanupDirs.add(root);
    const isolated = await makeIsolatedTempRoot();
    const remnant = path.join(root, `paperclip-ai-foreign-rm-${"c3d4e5f6a7b8c9d0"}`);
    await fs.mkdir(remnant, { mode: 0o700 });
    await fs.writeFile(path.join(remnant, "auth.json"), "leftover-credential");

    const result = await sweepOrphanedRunScratch({
      tmpRoot: root,
      runTempRootOverride: isolated,
      resolveRunStates: async () => new Map(),
    });

    expect(result.removed).toEqual([]);
    expect(await exists(path.join(remnant, "auth.json"))).toBe(true);
  });
});

// VPS-787 finding 1: the scratch retry must respect the removal's `complete`
// result — an interrupted portable removal keeps its quarantined remnant, and
// no retry may declare success while the remnant (or its content, marker or
// receipt) still exists.
describe("VPS-787 scratch retry completion", () => {
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("keeps reporting an incomplete retry while the remnant survives, and completes only when it is really gone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retry-f1-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("f1aa1111"),
      root,
    }));
    await fs.writeFile(path.join(scratch.dir, "sentinel.txt"), "pending fixture");
    const blockedUnlink = (): RunScratchWalkerOpsOverride => {
      const paths = createDefaultRunScratchWalkerOps("paths");
      return () => ({
        ...paths,
        unlinkEntry: async () => {
          throw Object.assign(new Error("fixture blocked"), { code: "EACCES" });
        },
      });
    };

    const first = await cleanupHeartbeatRunScratch({ scratch, walkerOps: blockedUnlink(), runTempRootOverride: root });
    expect(first).toMatchObject({ removed: false });
    const remnant = (await fs.readdir(root)).find((n) => n.startsWith(`${path.basename(scratch.dir)}-rm-`));
    expect(remnant).toBeDefined();
    const remnantPath = path.join(root, remnant!);
    await expect(fs.readFile(path.join(remnantPath, "sentinel.txt"), "utf8")).resolves.toBe("pending fixture");
    await expect(fs.readFile(path.join(remnantPath, HEARTBEAT_RUN_SCRATCH_MARKER), "utf8")).resolves.toContain(runId("f1aa1111"));
    await expect(fs.readFile(path.join(remnantPath, RUN_SCRATCH_QUARANTINE_RECEIPT), "utf8")).resolves.toContain("f1aa1111".slice(0, 8));

    // The still-blocked retry must not report success while the remnant,
    // its content and its retry evidence all still exist.
    const second = await cleanupHeartbeatRunScratch({ scratch, walkerOps: blockedUnlink(), runTempRootOverride: root });
    expect(second).toEqual({ removed: false, dir: scratch.dir, reason: "mount_point_present" });
    expect(await exists(path.join(remnantPath, "sentinel.txt"))).toBe(true);
    expect(await exists(path.join(remnantPath, HEARTBEAT_RUN_SCRATCH_MARKER))).toBe(true);

    // Once unblocked, completion requires the remnant to be really gone.
    const third = await cleanupHeartbeatRunScratch({
      scratch,
      walkerOps: () => createDefaultRunScratchWalkerOps("paths"),
      runTempRootOverride: root,
    });
    expect(third).toEqual({ removed: true, dir: scratch.dir });
    expect(await exists(remnantPath)).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

// VPS-787 finding 2: the quarantine rename is never accepted as proof that
// the ownership, liveness and retention gates already passed — every retry
// re-evaluates them on the remnant, and foreign evidence never authorizes
// a removal.
describe("VPS-787 quarantined retry gating", () => {
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("re-checks the process group before continuing a quarantined removal, then completes after exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retry-f2-"));
    cleanupDirs.add(root);
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("f2bb2222"),
      root,
    }));
    await fs.writeFile(path.join(scratch.dir, "sentinel.txt"), "live fixture");
    const moved = path.join(root, `${path.basename(scratch.dir)}-rm-${"f2bb2222f2bb2222"}`);
    await fs.rename(scratch.dir, moved);

    let liveGateCalls = 0;
    const live = await cleanupHeartbeatRunScratch({
      scratch,
      runTempRootOverride: root,
      processGroupId: 4242,
      isProcessGroupAlive: () => { liveGateCalls += 1; return true; },
    });
    expect(live).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    expect(liveGateCalls).toBeGreaterThanOrEqual(1);
    expect(await exists(path.join(moved, "sentinel.txt"))).toBe(true);

    const done = await cleanupHeartbeatRunScratch({
      scratch,
      runTempRootOverride: root,
      processGroupId: 4242,
      isProcessGroupAlive: () => false,
    });
    expect(done).toEqual({ removed: true, dir: scratch.dir });
    expect(await exists(moved)).toBe(false);
  });

  it("refuses a quarantined retry whose remnant carries foreign or missing evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retry-f2b-"));
    cleanupDirs.add(root);

    // Foreign marker: a valid marker naming another run never authorizes
    // this scratch's retry to destroy the renamed tree.
    const foreign = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("f2cc3333"),
      root,
    }));
    await fs.writeFile(path.join(foreign.dir, "sentinel.txt"), "foreign fixture");
    await fs.writeFile(
      path.join(foreign.dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({ version: 1, companyId: "other", agentId: "other", runId: "another-run", issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
    );
    const foreignMoved = path.join(root, `${path.basename(foreign.dir)}-rm-${"f2cc3333f2cc3333"}`);
    await fs.rename(foreign.dir, foreignMoved);
    const foreignResult = await cleanupHeartbeatRunScratch({ scratch: foreign, runTempRootOverride: root });
    expect(foreignResult).toEqual({ removed: false, dir: foreign.dir, reason: "owner_mismatch" });
    expect(await exists(path.join(foreignMoved, "sentinel.txt"))).toBe(true);

    // No evidence at all: neither marker nor receipt ties the renamed tree
    // back to this run's gated cleanup.
    const bare = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("f2dd4444"),
      root,
    }));
    await fs.writeFile(path.join(bare.dir, "sentinel.txt"), "bare fixture");
    await fs.unlink(path.join(bare.dir, HEARTBEAT_RUN_SCRATCH_MARKER));
    const bareMoved = path.join(root, `${path.basename(bare.dir)}-rm-${"f2dd4444f2dd4444"}`);
    await fs.rename(bare.dir, bareMoved);
    const bareResult = await cleanupHeartbeatRunScratch({ scratch: bare, runTempRootOverride: root });
    expect(bareResult).toEqual({ removed: false, dir: bare.dir, reason: "unmarked" });
    expect(await exists(path.join(bareMoved, "sentinel.txt"))).toBe(true);
  });
});

// VPS-787 finding 3: the portable entry-op anchor must never mutate the
// shared server process's working directory — a relative filesystem
// operation another part of the process already queued would otherwise
// execute inside the scratch tree.
describe("VPS-787 portable anchor process isolation", () => {
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("runs the full portable entry-op cycle without changing the process working directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-f3-"));
    cleanupDirs.add(root);
    const scratch = path.join(root, "scratch");
    await fs.mkdir(path.join(scratch, "sub"), { recursive: true });
    await fs.writeFile(path.join(scratch, "file.txt"), "x");
    const ops = createDefaultRunScratchWalkerOps("paths");
    const fd = await ops.openDir(scratch);
    const original = process.cwd();
    const originalChdir = process.chdir;
    (process as unknown as { chdir: (d: string) => void }).chdir = () => {
      throw new Error("the shared process working directory must never change");
    };
    try {
      await ops.listDir(fd);
      await ops.lstatEntry(fd, "file.txt");
      await ops.writeEntryExclusive(fd, "exclusive.txt", "{}\n", 0o600);
      await ops.unlinkEntry(fd, "file.txt");
      const subFd = await ops.openEntry(fd, "sub");
      await ops.statDir(subFd);
      await ops.closeDir(subFd);
      await ops.rmdirEntry(fd, "sub");
      expect(process.cwd()).toBe(original);
    } finally {
      (process as unknown as { chdir: (d: string) => void }).chdir = originalChdir;
      await ops.closeDir(fd).catch(() => undefined);
    }
  });

  it("lets a queued relative unlink of other code hit only the caller directory", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pool-f3-"));
    cleanupDirs.add(parent);
    const caller = path.join(parent, "caller");
    const scratch = path.join(parent, "scratch");
    await fs.mkdir(caller);
    await fs.mkdir(scratch);
    await fs.writeFile(path.join(caller, "victim"), "caller fixture");
    await fs.writeFile(path.join(scratch, "victim"), "scratch fixture");
    const workers = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? "4", 10) || 4;
    const fifos = Array.from({ length: workers }, (_, index) => path.join(parent, `barrier-${index}`));
    try {
      for (const fifo of fifos) execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform: nothing to prove here.
    }
    const ops = createDefaultRunScratchWalkerOps("paths");
    const fd = await ops.openDir(scratch);
    // Every threadpool worker blocks on a FIFO open, so the relative unlink
    // queued next cannot execute until one barrier is released.
    const opens = fifos.map((fifo) => fs.open(fifo, fss.constants.O_RDONLY));
    const previousCwd = process.cwd();
    let hookFired = false;
    const statSync = fss.statSync;
    const releaseBarrier = (index: number) => {
      // O_NONBLOCK: the handshake with a blocked reader completes
      // immediately, and an already-consumed barrier fails with ENXIO
      // instead of blocking the main thread forever.
      const writer = fss.openSync(fifos[index]!, fss.constants.O_WRONLY | fss.constants.O_NONBLOCK);
      fss.closeSync(writer);
    };
    try {
      process.chdir(caller);
      const pendingUnlink = fs.unlink("victim");
      (fss as unknown as { statSync: typeof statSync }).statSync = ((...args: unknown[]) => {
        if (!hookFired && args[0] === ".") {
          hookFired = true;
          releaseBarrier(0);
          // With a pre-fix in-process chdir anchor, the freed worker ran the
          // queued unlink against the scratch working directory: wait for
          // that misdirected deletion so the defect fails deterministically.
          const deadline = Date.now() + 2000;
          while (fss.existsSync(path.join(scratch, "victim")) && Date.now() < deadline) {}
        }
        return (statSync as (...a: unknown[]) => ReturnType<typeof statSync>)(...args);
      }) as typeof statSync;
      try {
        await ops.lstatEntry(fd, "victim");
      } finally {
        (fss as unknown as { statSync: typeof statSync }).statSync = statSync;
      }
      if (!hookFired) releaseBarrier(0);
      await pendingUnlink;
      // Free every remaining barrier before awaiting their opens, or the
      // blocked readers keep their workers forever.
      for (let index = 1; index < fifos.length; index += 1) {
        try { releaseBarrier(index); } catch {}
      }
      for (const open of opens) await open.then((handle) => handle.close(), () => undefined);
      // The caller's relative unlink removed the caller file only; the
      // scratch file was merely lstat through the isolated anchor.
      expect(fss.existsSync(path.join(caller, "victim"))).toBe(false);
      expect(fss.existsSync(path.join(scratch, "victim"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      await ops.closeDir(fd).catch(() => undefined);
      for (let index = 0; index < fifos.length; index += 1) {
        try { releaseBarrier(index); } catch {}
      }
      await Promise.allSettled(opens.map((open) => open.then((handle) => handle.close(), () => undefined)));
    }
  });
});

// VPS-789 finding 1: a receipt written before a quarantine rename that then
// failed (transient error, or a crash between write and rename) must not
// permanently block the retry and the sweep — the exclusive write sees
// EEXIST forever. Recovery accepts exactly this removal's own prior
// receipt; foreign evidence still refuses.
describe("VPS-789 quarantine receipt recovery", () => {
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  async function faultFirstRenameOf(target: string, run: () => Promise<void>): Promise<void> {
    const original = fs.rename;
    let injected = false;
    (fs as { rename: (oldPath: string, newPath: string) => Promise<void> }).rename = async (oldPath: string, newPath: string) => {
      if (oldPath === target && !injected) {
        injected = true;
        throw Object.assign(new Error("fixture transient rename failure"), { code: "EACCES" });
      }
      return original(oldPath, newPath);
    };
    try {
      await run();
    } finally {
      (fs as { rename: (oldPath: string, newPath: string) => Promise<void> }).rename = original;
    }
  }

  it("refuses a receipt replaced by a symlink between verification and opening", async () => {
    const root = await makeIsolatedTempRoot();
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1", agentId: "agent-1", runId: runId("race791"), root,
    }));
    const receipt = path.join(scratch.dir, RUN_SCRATCH_QUARANTINE_RECEIPT);
    const outside = path.join(root, "outside.json");
    const data = JSON.stringify({ version: 1, kind: "scratch", companyId: "company-1",
      agentId: "agent-1", runId: scratch.metadata.runId, originalName: path.basename(scratch.dir),
      createdAt: new Date().toISOString() });
    await fs.writeFile(receipt, data);
    await fs.writeFile(outside, data);
    await fs.writeFile(path.join(scratch.dir, "sentinel"), "preserve");
    let swapped = false;
    const swap = async () => {
      if (swapped) return;
      await fs.unlink(receipt);
      await fs.symlink(outside, receipt);
      swapped = true;
    };
    const originalLstat = fs.lstat;
    const spy = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await originalLstat(...args);
      if (args[0] === receipt) await swap();
      return stat;
    });
    const base = createDefaultRunScratchWalkerOps("paths");
    try {
      const result = await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: root,
        walkerOps: () => ({ ...base, lstatEntry: async (fd, name) => {
          const stat = await base.lstatEntry(fd, name);
          if (name === RUN_SCRATCH_QUARANTINE_RECEIPT) await swap();
          return stat;
        } }),
      });
      expect(swapped).toBe(true);
      expect(result.removed).toBe(false);
      expect(await fs.readFile(path.join(scratch.dir, "sentinel"), "utf8")).toBe("preserve");
      expect((await originalLstat(receipt)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outside, "utf8")).toBe(data);
    } finally { spy.mockRestore(); }
  });

  it("does not recover existing evidence after an exclusive-write error other than EEXIST", async () => {
    const root = await makeIsolatedTempRoot();
    const home = path.join(root, "paperclip-ai-fixture");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "sentinel"), "preserve");
    await fs.writeFile(path.join(home, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify({
      version: 1, kind: "home", companyId: null, agentId: null, runId: null,
      originalName: path.basename(home), createdAt: new Date().toISOString(),
    }));
    const base = createDefaultRunScratchWalkerOps("paths");
    const result = await removeRunTempTree(home, { walkerOps: () => ({ ...base,
      writeEntryExclusive: async () => { throw Object.assign(new Error("fixture access failure"), { code: "EACCES" }); },
    }) });
    expect(result.complete).toBe(false);
    expect(await fs.readFile(path.join(home, "sentinel"), "utf8")).toBe("preserve");
  });

  it("recovers a scratch quarantine whose rename failed after the receipt write, on retry and sweep", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-receipt-g1-"));
    cleanupDirs.add(root);
    const isolated = await makeIsolatedTempRoot();
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("g1aa1111"),
      root,
    }));
    await fs.writeFile(path.join(scratch.dir, "sentinel.txt"), "fixture");

    // The transient rename failure leaves this removal's own receipt on the
    // original name: the directory keeps its marker and its receipt.
    await faultFirstRenameOf(scratch.dir, async () => {
      const first = await cleanupHeartbeatRunScratch({
        scratch,
        walkerOps: () => createDefaultRunScratchWalkerOps("paths"),
        runTempRootOverride: root,
      });
      expect(first).toEqual({ removed: false, dir: scratch.dir, reason: "unsafe_tree" });
    });
    expect(await exists(path.join(scratch.dir, RUN_SCRATCH_QUARANTINE_RECEIPT))).toBe(true);
    expect(await exists(path.join(scratch.dir, "sentinel.txt"))).toBe(true);

    // The sweep reclaims the still-named terminal directory instead of
    // retrying the refused quarantine forever.
    const swept = await sweepOrphanedRunScratch({
      tmpRoot: isolated,
      runTempRootOverride: root,
      resolveRunStates: async () => new Map([[runId("g1aa1111"), "terminal" as const]]),
      isRunProcessGroupAlive: () => false,
    });
    expect(swept.removed).toEqual([scratch.dir]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("recovers a home quarantine whose rename failed after the receipt write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-receipt-g1b-"));
    cleanupDirs.add(root);
    const home = path.join(root, "paperclip-ai-fixture");
    await fs.mkdir(path.join(home, "provider"), { recursive: true });
    await fs.writeFile(path.join(home, "provider", "auth.json"), "credential");

    await faultFirstRenameOf(home, async () => {
      const first = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
      expect(first).toEqual({ complete: false });
    });
    expect(await exists(home)).toBe(true);
    expect(await exists(path.join(home, RUN_SCRATCH_QUARANTINE_RECEIPT))).toBe(true);

    const second = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
    expect(second).toEqual({ complete: true });
    expect(await exists(home)).toBe(false);
  });

  it("accepts a receipt left by a crash between the write and the rename, and still refuses a foreign one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-receipt-g1c-"));
    cleanupDirs.add(root);

    // Crash simulation: the receipt is exactly what this run's own removal
    // would have written, but no rename ever happened.
    const crash = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("g1cc3333"),
      root,
    }));
    await fs.writeFile(path.join(crash.dir, "sentinel.txt"), "fixture");
    await fs.writeFile(path.join(crash.dir, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify({
      version: 1,
      kind: "scratch",
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("g1cc3333"),
      originalName: path.basename(crash.dir),
      createdAt: new Date("2026-11-19T00:00:00.000Z").toISOString(),
    }));
    const recovered = await cleanupHeartbeatRunScratch({
      scratch: crash,
      walkerOps: () => createDefaultRunScratchWalkerOps("paths"),
      runTempRootOverride: root,
    });
    expect(recovered).toEqual({ removed: true, dir: crash.dir });

    // Foreign evidence under the receipt name never authorizes the rename.
    const foreign = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: runId("g1dd4444"),
      root,
    }));
    await fs.writeFile(path.join(foreign.dir, "sentinel.txt"), "fixture");
    await fs.writeFile(path.join(foreign.dir, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify({
      version: 1,
      kind: "scratch",
      companyId: "someone-else",
      agentId: "someone-else",
      runId: "another-run",
      originalName: path.basename(foreign.dir),
      createdAt: new Date().toISOString(),
    }));
    const refused = await cleanupHeartbeatRunScratch({
      scratch: foreign,
      walkerOps: () => createDefaultRunScratchWalkerOps("paths"),
      runTempRootOverride: root,
    });
    expect(refused).toEqual({ removed: false, dir: foreign.dir, reason: "unsafe_tree" });
    expect(await exists(path.join(foreign.dir, "sentinel.txt"))).toBe(true);
  });
});

// VPS-789 finding 3: retained-home holds are registered by path, so the
// quarantine rename must never orphan them. A protected tree is not renamed
// at all, and a remnant stays protected also while the hold is still
// registered under the pre-quarantine name.
describe("VPS-789 hold survives the quarantine rename", () => {
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("lets an active retained cleanup retire its own home while preserving a separate owner's hold", async () => {
    const root = await makeIsolatedTempRoot();
    const home = path.join(root, "paperclip-ai-retained");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "sentinel"), "preserve");
    const scope = { companyId: "fixture", accountKey: root };
    const release = acquireAiCredentialTeardownHold(home);
    retainAiCredentialCleanup({ scope, home, cleanup: async () => {
      const result = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
      if (!result.complete) throw new Error("still protected");
    } });
    try {
      await expect(reconcileRetainedAiCleanup(scope)).rejects.toBeDefined();
      expect(await fs.readFile(path.join(home, "sentinel"), "utf8")).toBe("preserve");
    } finally { release(); }
    await reconcileRetainedAiCleanup(scope);
    expect(await exists(home)).toBe(false);
  });

  it("refuses the quarantine while a teardown hold is active, and completes it after release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hold-g3-"));
    cleanupDirs.add(root);
    const isolated = await makeIsolatedTempRoot();
    const home = path.join(root, "paperclip-ai-fixture");
    const provider = path.join(home, "provider");
    await fs.mkdir(provider, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(provider, "auth.json"), "synthetic credential");

    const release = acquireAiCredentialTeardownHold(provider);
    try {
      const blockedUnlink = (): RunScratchWalkerOpsOverride => {
        const paths = createDefaultRunScratchWalkerOps("paths");
        return () => ({
          ...paths,
          unlinkEntry: async () => {
            throw Object.assign(new Error("fixture blocked"), { code: "EACCES" });
          },
        });
      };
      const partial = await removeRunTempTree(home, { walkerOps: blockedUnlink() });
      // The hold was acquired before the quarantine: the tree is never
      // renamed out from under the registry, so no remnant appears.
      expect(partial).toEqual({ complete: false });
      expect(await exists(home)).toBe(true);
      expect(await exists(path.join(provider, "auth.json"))).toBe(true);

      const swept = await sweepOrphanedRunScratch({
        tmpRoot: root,
        runTempRootOverride: isolated,
        resolveRunStates: async () => new Map(),
      });
      expect(swept.removed).toEqual([]);
      expect(await exists(path.join(provider, "auth.json"))).toBe(true);
    } finally {
      release();
    }

    const done = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
    expect(done).toEqual({ complete: true });
    expect(await exists(home)).toBe(false);
  });

  it("keeps a quarantine remnant while the hold is still registered under the original name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hold-g3b-"));
    cleanupDirs.add(root);
    const isolated = await makeIsolatedTempRoot();
    const home = path.join(root, "paperclip-ai-fixture");
    const provider = path.join(home, "provider");
    await fs.mkdir(provider, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(provider, "auth.json"), "synthetic credential");
    await fs.writeFile(path.join(home, RUN_SCRATCH_QUARANTINE_RECEIPT), JSON.stringify({
      version: 1,
      kind: "home",
      companyId: null,
      agentId: null,
      runId: null,
      originalName: "paperclip-ai-fixture",
      createdAt: new Date().toISOString(),
    }));
    // The quarantine rename already happened (a pre-fix remnant); the hold
    // is registered under the original, now-gone provider path.
    const remnant = path.join(root, `paperclip-ai-fixture-rm-${"d4e5f6a7b8c9d0e1"}`);
    await fs.rename(home, remnant);

    const release = acquireAiCredentialTeardownHold(provider);
    try {
      const retry = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
      expect(retry).toEqual({ complete: false, quarantinePath: remnant });
      expect(await exists(path.join(remnant, "provider", "auth.json"))).toBe(true);

      const swept = await sweepOrphanedRunScratch({
        tmpRoot: root,
        runTempRootOverride: isolated,
        resolveRunStates: async () => new Map(),
      });
      expect(swept.removed).toEqual([]);
      expect(await exists(path.join(remnant, "provider", "auth.json"))).toBe(true);
    } finally {
      release();
    }

    const done = await removeRunTempTree(home, { walkerOps: () => createDefaultRunScratchWalkerOps("paths") });
    expect(done).toEqual({ complete: true });
    expect(await exists(remnant)).toBe(false);
  });
});
