import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePersistedExecutionWorkspaceAvailable, inspectManagedGitWorktreeBranch } from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-inspection-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(repo);
  await exec("git", ["init", repo]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "work", worktree]);
  await fs.writeFile(path.join(worktree, "retained.txt"), "retained work\n");
  return { root, repo, worktree };
}

async function replaceListProbe(root: string, body: string) {
  const realGit = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==="worktree"&&args[1]==="list"){${body}}else{const r=require("node:child_process").spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exitCode=r.status??1;}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
}

describe("managed worktree registration inspection", () => {
  it("accepts a complete registration and rejects a genuine independent checkout", async () => {
    const { repo, worktree, root } = await fixture();
    expect(await inspectManagedGitWorktreeBranch({ repoRoot: repo, worktreePath: worktree, expectedBranchName: "work" })).toMatchObject({ valid: true, reasonCode: null });
    const other = path.join(root, "other");
    await exec("git", ["clone", repo, other]);
    expect(await inspectManagedGitWorktreeBranch({ repoRoot: repo, worktreePath: other, expectedBranchName: null })).toMatchObject({ valid: false, reasonCode: "not_registered" });
  });

  it("distinguishes a failed Git inspection from missing registration without copying stderr", async () => {
    const { root, repo, worktree } = await fixture();
    await replaceListProbe(root, 'process.stderr.write("private-token /private/repository");process.exitCode=128;');
    const result = await inspectManagedGitWorktreeBranch({ repoRoot: repo, worktreePath: worktree, expectedBranchName: "work" });
    expect(result).toMatchObject({ valid: false, reasonCode: "git_inspection_failed", inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode: 128 } });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(await fs.readFile(path.join(worktree, "retained.txt"), "utf8")).toBe("retained work\n");
  });

  it("distinguishes a missing Git executable without inventing a registration mismatch", async () => {
    const { root, repo, worktree } = await fixture();
    vi.stubEnv("PATH", root);
    expect(await inspectManagedGitWorktreeBranch({ repoRoot: repo, worktreePath: worktree, expectedBranchName: "work" })).toMatchObject({
      valid: false, reasonCode: "git_inspection_failed", inspectionDiagnostic: { command: "worktree_list", failure: "spawn_failed", errorCode: "ENOENT" },
    });
  });

  it("fails closed on truncated output even if a matching registration was captured", async () => {
    const { root, repo, worktree } = await fixture();
    await replaceListProbe(root, `process.stdout.write("x".repeat(300_000) + ${JSON.stringify(`\nworktree ${worktree}\n\n`)});`);
    expect(await inspectManagedGitWorktreeBranch({ repoRoot: repo, worktreePath: worktree, expectedBranchName: "work" })).toMatchObject({
      valid: false, reasonCode: "git_inspection_failed", inspectionDiagnostic: { command: "worktree_list", failure: "output_truncated" },
    });
  });

  it("retains the bounded probe failure in persisted-workspace validation without changing files", async () => {
    const { root, repo, worktree } = await fixture();
    await replaceListProbe(root, 'process.stderr.write("private-provider-output");process.exitCode=126;');
    await expect(ensurePersistedExecutionWorkspaceAvailable({
      base: { baseCwd: repo, source: "project_primary", projectId: "project", workspaceId: "workspace", repoUrl: null, repoRef: "HEAD" },
      workspace: { id: "execution-workspace", mode: "isolated_workspace", strategyType: "git_worktree", cwd: worktree, providerRef: worktree, projectId: "project", projectWorkspaceId: "workspace", repoUrl: null, baseRef: "HEAD", branchName: "work" },
      issue: { id: "issue", identifier: "TEST-1", title: "Preserve workspace" },
      agent: { id: "agent", name: "Agent", companyId: "company" },
    })).rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: { workspaceValidation: {
      reason: "git_worktree_not_reusable", reasonCode: "git_inspection_failed",
      inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode: 126 },
    } } });
    expect(await fs.readFile(path.join(worktree, "retained.txt"), "utf8")).toBe("retained work\n");
  });
});
