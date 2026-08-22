import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktreeInstanceArtifacts,
  deriveWorktreeInstanceId,
  readManagedWorktreeInstanceOwnership,
  readWorktreeInstancePointer,
  stopEmbeddedPostgresIfRunning,
} from "../services/workspace-instance-cleanup.js";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.js";

const tempRoots = new Set<string>();

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function writeWorkspaceEnv(workspacePath: string, homeDir: string, instanceId: string): Promise<void> {
  const envDir = path.join(workspacePath, ".paperclip");
  await fs.mkdir(envDir, { recursive: true });
  await fs.writeFile(
    path.join(envDir, ".env"),
    `PAPERCLIP_HOME=${JSON.stringify(homeDir)}\nPAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}\n`,
    "utf8",
  );
}

function createRecorderDouble() {
  const operations: Array<{
    status: string;
    metadata: Record<string, unknown> | null;
    system: string | null;
  }> = [];
  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async () => {},
    recordOperation: async (input) => {
      const result = await input.run();
      operations.push({
        status: result.status ?? "succeeded",
        metadata: input.metadata ?? null,
        system: result.system ?? null,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId: null,
        heartbeatRunId: null,
        issueId: null,
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };
  return { recorder, operations };
}

afterEach(async () => {
  await Promise.all(Array.from(tempRoots, (root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.clear();
  vi.restoreAllMocks();
});

describe("worktree instance cleanup", () => {
  it("derives different instance IDs for distinct paths with the same normalized name", () => {
    const parent = path.join(os.tmpdir(), "paperclip-instance-id-collision");
    const plusPath = path.join(parent, "feature+cleanup");
    const dashPath = path.join(parent, "feature-cleanup");

    expect(deriveWorktreeInstanceId(plusPath)).not.toBe(deriveWorktreeInstanceId(dashPath));
    expect(deriveWorktreeInstanceId(plusPath)).toMatch(/^feature-cleanup-[a-f0-9]{12}$/);
    expect(deriveWorktreeInstanceId(dashPath)).toMatch(/^feature-cleanup-[a-f0-9]{12}$/);
  });
  it("removes an instance directory inside the managed worktree instances root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceId = "pap-16075";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "marker"), "remove me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);

    const pointer = await readWorktreeInstancePointer(workspacePath);
    expect(pointer).not.toBeNull();
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: instanceId,
      expectedInstanceRoot: instanceRoot,
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "removed", postgresStopped: false });
    await expect(fs.stat(instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a collision-resistant active instance when persisted ownership is absent", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceId = deriveWorktreeInstanceId(workspacePath);
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "marker"), "remove me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: instanceId,
      expectedInstanceRoot: null,
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot });
    expect((result as { warning: string }).warning).toContain("no persisted instance root");
    await expect(fs.readFile(path.join(instanceRoot, "marker"), "utf8")).resolves.toBe("remove me");
  });

  it("refuses and logs an instance pointer outside the managed worktree root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const liveHome = await makeTempRoot("paperclip-live-home-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const liveInstanceRoot = path.join(liveHome, "instances", "default");
    await fs.mkdir(liveInstanceRoot, { recursive: true });
    await fs.writeFile(path.join(liveInstanceRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, liveHome, "default");
    const { recorder, operations } = createRecorderDouble();
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "default",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "default"),
      worktreesDir,
      recorder,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: liveInstanceRoot });
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(liveInstanceRoot, "marker"), "utf8")).toBe("keep me");
    expect(operations).toEqual([
      expect.objectContaining({
        status: "skipped",
        metadata: expect.objectContaining({
          cleanupAction: "remove_worktree_instance",
          refusalReason: "outside_managed_instances_dir",
        }),
      }),
    ]);
  });

  it("treats a missing repo-local env file as a no-op", async () => {
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    await expect(readWorktreeInstancePointer(workspacePath)).resolves.toBeNull();
  });

  it("captures the managed instance root for persisted workspace ownership", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceRoot = path.join(worktreesDir, "instances", "owned-instance");
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, "owned-instance");

    await expect(
      readManagedWorktreeInstanceOwnership(workspacePath, worktreesDir),
    ).resolves.toEqual({ instanceId: "owned-instance", instanceRoot });
  });
  it("stops embedded Postgres before deleting the instance root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceRoot = path.join(worktreesDir, "instances", "ordered-cleanup");
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, "ordered-cleanup");
    const calls: string[] = [];

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "ordered-cleanup",
      expectedInstanceRoot: instanceRoot,
      worktreesDir,
      dependencies: {
        stopEmbeddedPostgres: async (dataDir) => {
          expect(dataDir).toBe(path.join(instanceRoot, "db"));
          expect(await fs.stat(instanceRoot)).toBeDefined();
          calls.push("stop");
          return true;
        },
        removeInstanceRoot: async (target) => {
          calls.push("remove");
          await fs.rm(target, { recursive: true, force: true });
        },
      },
    });

    expect(result).toMatchObject({ status: "removed", postgresStopped: true });
    expect(calls).toEqual(["stop", "remove"]);
  });

  it("refuses a pointer rewritten to another workspace's managed instance", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const siblingInstanceRoot = path.join(worktreesDir, "instances", "feature-sibling");
    await fs.mkdir(path.join(siblingInstanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(siblingInstanceRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "feature-sibling");
    const { recorder, operations } = createRecorderDouble();
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "feature-sibling",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "feature-owner"),
      worktreesDir,
      recorder,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: siblingInstanceRoot });
    expect((result as { warning: string }).warning).toContain("persisted instance root");
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(siblingInstanceRoot, "marker"), "utf8")).toBe("keep me");
    expect(operations).toEqual([
      expect.objectContaining({
        status: "skipped",
        metadata: expect.objectContaining({
          expectedInstanceRoot: path.join(worktreesDir, "instances", "feature-owner"),
          refusalReason: "instance_root_workspace_mismatch",
        }),
      }),
    ]);
  });
  it("refuses a managed-root symlink that canonically escapes the guard", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const outsideRoot = await makeTempRoot("paperclip-outside-instance-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instancesDir = path.join(worktreesDir, "instances");
    await fs.mkdir(instancesDir, { recursive: true });
    await fs.symlink(outsideRoot, path.join(instancesDir, "escaped"), "dir");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "escaped");

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "escaped",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "escaped"),
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect((result as { warning: string }).warning).toContain("canonical path");
    await expect(fs.stat(outsideRoot)).resolves.toBeDefined();
  });

  it("refuses when the managed instances directory itself is a symlink", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const liveInstancesDir = await makeTempRoot("paperclip-live-instances-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const liveInstanceRoot = path.join(liveInstancesDir, "default");
    await fs.mkdir(liveInstanceRoot, { recursive: true });
    await fs.symlink(liveInstancesDir, path.join(worktreesDir, "instances"), "dir");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "default");

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "default",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "default"),
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect((result as { warning: string }).warning).toContain("managed instances directory");
    await expect(fs.stat(liveInstanceRoot)).resolves.toBeDefined();
  });
  it("refuses an instance pointer that belongs to a sibling worktree", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const siblingRoot = path.join(worktreesDir, "instances", "sibling-worktree");
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.writeFile(path.join(siblingRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "sibling-worktree");
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "owned-worktree",
      expectedInstanceRoot: null,
      worktreesDir,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: siblingRoot });
    expect((result as { warning: string }).warning).toContain("expected workspace instance");
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(siblingRoot, "marker"), "utf8")).toBe("keep me");
  });

  it("treats an ESRCH signal race as an already-stopped PostgreSQL process", async () => {
    const instanceRoot = await makeTempRoot("paperclip-postgres-exit-race-");
    const dataDir = path.join(instanceRoot, "db");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "postmaster.pid"), `4242\n${dataDir}\n`, "utf8");
    const signalError = Object.assign(new Error("process exited"), { code: "ESRCH" });

    await expect(stopEmbeddedPostgresIfRunning(dataDir, {
      processIsAlive: () => true,
      readVerifiedPostgresCommand: async () => `postgres -D ${dataDir}`,
      signalProcess: () => { throw signalError; },
      wait: async () => {},
    })).resolves.toBe(false);
  });
});
