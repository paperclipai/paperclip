import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

describe("concurrent git worktree creation", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });

  /** A clone of an origin repository: each new branch from origin/main records its upstream in .git/config. */
  async function clonedRepository() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-race-"));
    roots.push(root);
    const origin = path.join(root, "origin");
    await fs.mkdir(origin);
    await git(origin, ["init", "--initial-branch", "main"]);
    await git(origin, ["config", "user.email", "paperclip@example.com"]);
    await git(origin, ["config", "user.name", "Paperclip Test"]);
    await fs.writeFile(path.join(origin, "README.md"), "hello\n");
    await git(origin, ["add", "README.md"]);
    await git(origin, ["commit", "-m", "Initial commit"]);
    await git(root, ["clone", "--quiet", origin, "repo"]);
    return path.join(root, "repo");
  }

  it("creates every worktree when several tasks start on one repository at once", async () => {
    // Several rounds of simultaneous creates make the shared .git/config race certain without serialization.
    for (let round = 0; round < 3; round += 1) await createConcurrently(await clonedRepository(), round);
  }, 120_000);

  it("waits out another process's brief config lock instead of failing the create", async () => {
    const repoRoot = await clonedRepository();
    const lock = path.join(repoRoot, ".git", "config.lock");
    await fs.writeFile(lock, "");
    const release = setTimeout(() => { void fs.rm(lock, { force: true }); }, 300);
    try {
      const workspace = await realizeExecutionWorkspace({
        base: { baseCwd: repoRoot, source: "project_primary", projectId: "project-1", workspaceId: "workspace-1",
          repoUrl: null, repoRef: "origin/main" },
        config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
        issue: { id: "issue-lock", identifier: "PAP-900", title: "Locked config" },
        agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      });
      expect(workspace).toMatchObject({ created: true, branchCreatedByRuntime: true });
      expect(await git(repoRoot, ["config", "--get", `branch.${workspace.branchName}.remote`])).toBe("origin");
    } finally {
      clearTimeout(release);
    }
  }, 60_000);

  async function createConcurrently(repoRoot: string, round: number) {
    const tasks = Array.from({ length: 10 }, (_, index) => round * 10 + index + 1);
    const workspaces = await Promise.all(tasks.map(index => realizeExecutionWorkspace({
      base: { baseCwd: repoRoot, source: "project_primary", projectId: "project-1", workspaceId: "workspace-1",
        repoUrl: null, repoRef: "origin/main" },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
      issue: { id: `issue-${index}`, identifier: `PAP-${index}`, title: `Concurrent task ${index}` },
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
    })));
    for (const [position, workspace] of workspaces.entries()) {
      // Each task got a fresh branch it owns, not a fallback attach after a failed create.
      expect(workspace).toMatchObject({ created: true, branchCreatedByRuntime: true });
      expect(await git(workspace.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(workspace.branchName);
      expect(workspace.branchName).toContain(`PAP-${tasks[position]}`);
    }
    expect(new Set(workspaces.map(workspace => workspace.cwd)).size).toBe(tasks.length);
  }
});
