import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { inspectExecutionWorkspaceDirtyForDoneTransition } from "../services/execution-workspaces.js";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dirty-done-"));
  tempDirs.add(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# seed\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "seed"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

function makeWorkspace(overrides: Partial<ExecutionWorkspace> & { cwd: string | null }): ExecutionWorkspace {
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: randomUUID(),
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "test-workspace",
    status: "active",
    cwd: overrides.cwd,
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "git_worktree",
    providerRef: overrides.cwd,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("inspectExecutionWorkspaceDirtyForDoneTransition", () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("reports clean when the worktree has no uncommitted changes", async () => {
    const repoRoot = await createTempRepo();
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("clean");
    expect(result.totalRelevantEntries).toBe(0);
    expect(result.dirtyEntries).toEqual([]);
    expect(result.untrackedEntries).toEqual([]);
  });

  it("reports dirty when there is a modified tracked file", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "README.md"), "# changed\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("dirty");
    expect(result.dirtyEntries).toEqual([{ path: "README.md", statusCode: " M" }]);
    expect(result.untrackedEntries).toEqual([]);
    expect(result.totalRelevantEntries).toBe(1);
    expect(result.workspacePath).toBe(repoRoot);
  });

  it("reports dirty when there is an untracked file", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "scratch\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("dirty");
    expect(result.untrackedEntries).toEqual([{ path: "scratch.txt" }]);
    expect(result.dirtyEntries).toEqual([]);
    expect(result.totalRelevantEntries).toBe(1);
  });

  it("ignores files under .paperclip/worktrees/", async () => {
    const repoRoot = await createTempRepo();
    const ignoredDir = path.join(repoRoot, ".paperclip", "worktrees", "abc123");
    await fs.mkdir(ignoredDir, { recursive: true });
    await fs.writeFile(path.join(ignoredDir, "internal.json"), "{}\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("clean");
    expect(result.totalRelevantEntries).toBe(0);
  });

  it("still reports dirty when the only relevant change is alongside ignored worktree files", async () => {
    const repoRoot = await createTempRepo();
    const ignoredDir = path.join(repoRoot, ".paperclip", "worktrees", "abc123");
    await fs.mkdir(ignoredDir, { recursive: true });
    await fs.writeFile(path.join(ignoredDir, "internal.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "feature.ts"), "export {};\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("dirty");
    expect(result.untrackedEntries).toEqual([{ path: "feature.ts" }]);
    expect(result.totalRelevantEntries).toBe(1);
  });

  it("skips workspaces with no local path", async () => {
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(
      makeWorkspace({ cwd: null, providerRef: null }),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_local_path");
  });

  it("skips workspaces whose path no longer exists", async () => {
    const missing = path.join(os.tmpdir(), `paperclip-missing-${randomUUID()}`);
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: missing }));
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("path_missing");
  });

  it("skips workspaces in shared_workspace mode (dirty files may belong to other issues)", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "scratch\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(
      makeWorkspace({ cwd: repoRoot, mode: "shared_workspace" }),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("shared_workspace");
  });

  it("skips workspaces that are not local-fs / git_worktree providers", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "scratch\n", "utf8");
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(
      makeWorkspace({ cwd: repoRoot, providerType: "cloud_sandbox" }),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("provider_unsupported");
  });

  it("caps the reported sample of dirty entries", async () => {
    const repoRoot = await createTempRepo();
    for (let index = 0; index < 25; index += 1) {
      await fs.writeFile(path.join(repoRoot, `file-${index}.txt`), `${index}\n`, "utf8");
    }
    const result = await inspectExecutionWorkspaceDirtyForDoneTransition(makeWorkspace({ cwd: repoRoot }));
    expect(result.status).toBe("dirty");
    expect(result.totalRelevantEntries).toBe(25);
    expect(result.untrackedEntries.length).toBeLessThanOrEqual(10);
    expect(result.dirtyEntries.length).toBe(0);
  });
});
