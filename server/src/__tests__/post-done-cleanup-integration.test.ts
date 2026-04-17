/**
 * Integration tests for runPostDoneCleanup.
 *
 * Uses:
 *  - A real embedded PostgreSQL database (same migration stack as production)
 *  - Real temporary git repositories on disk
 *
 * Tests verify that branch deletion and workspace-row updates work end-to-end
 * without any mocks for child_process or the ORM.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, issues, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runPostDoneCleanup } from "../services/post-done-cleanup.js";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping post-done-cleanup integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runGit(cwd: string, args: string[]) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

/**
 * Creates a temp git repo with an initial commit on `main`,
 * plus a feature branch that is already merged into `main`.
 * Returns the repo root and the merged branch name.
 */
async function createTempRepoWithMergedBranch(branchName: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-integration-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);

  // Initial commit on main
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);

  // Feature branch commit
  await runGit(repoRoot, ["checkout", "-b", branchName]);
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "done\n", "utf8");
  await runGit(repoRoot, ["add", "feature.txt"]);
  await runGit(repoRoot, ["commit", "-m", "Feature work"]);

  // Merge back into main so -d will succeed
  await runGit(repoRoot, ["checkout", "main"]);
  await runGit(repoRoot, ["merge", "--no-ff", branchName, "-m", `Merge ${branchName}`]);

  return repoRoot;
}

async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(repoRoot, ["branch", "--list", branchName]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integration tests with real embedded postgres + real git
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("runPostDoneCleanup — integration (real git + real db)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-post-done-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes a merged branch and marks the workspace row as closed", async () => {
    const branchName = "agent/feature/backenddev/test-cleanup";
    const repoRoot = await createTempRepoWithMergedBranch(branchName);
    tempDirs.add(repoRoot);

    // Sanity: branch exists before cleanup
    expect(await branchExists(repoRoot, branchName)).toBe(true);

    // Insert minimal DB rows
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cleanup test issue",
      status: "done",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "Test workspace",
      status: "active",
      providerType: "local_fs",
      sourceIssueId: issueId,
      cwd: repoRoot,
      branchName,
    });

    // Allow the temp dir as an allowed root for this test
    const allowedRoots = [os.tmpdir() + "/"];

    await runPostDoneCleanup({
      db,
      issueId,
      issueIdentifier: "TC-1",
      allowedRoots,
    });

    // Branch must be gone
    expect(await branchExists(repoRoot, branchName)).toBe(false);

    // Workspace row must be closed
    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws).toBeDefined();
    expect(ws!.status).toBe("closed");
    expect(ws!.closedAt).toBeInstanceOf(Date);
    expect(ws!.cleanupReason).toBe("cleanup_completed");
    expect(ws!.metadata?.cleanup).toMatchObject({
      branchDeleted: true,
      worktreeRemoved: false,
    });
  });

  it("sets cleanupReason=branch_not_merged when branch has unmerged commits", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-unmerged-"));
    tempDirs.add(repoRoot);

    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);

    // Initial commit on main (no merge of the branch)
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const branchName = "agent/feature/unmerged-work";
    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "unmerged.txt"), "not merged\n", "utf8");
    await runGit(repoRoot, ["add", "unmerged.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Unmerged commit"]);
    await runGit(repoRoot, ["checkout", "main"]);
    // Branch is NOT merged

    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unmerged branch issue",
      status: "done",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "Unmerged workspace",
      status: "active",
      providerType: "local_fs",
      sourceIssueId: issueId,
      cwd: repoRoot,
      branchName,
    });

    await runPostDoneCleanup({
      db,
      issueId,
      issueIdentifier: "TC-2",
      allowedRoots: [os.tmpdir() + "/"],
    });

    // Branch still exists (was not force-deleted)
    expect(await branchExists(repoRoot, branchName)).toBe(true);

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws!.status).toBe("closed");
    expect(ws!.cleanupReason).toBe("branch_not_merged");
    expect(ws!.metadata?.cleanup).toMatchObject({
      branchDeleted: false,
    });
  });

  it("skips git ops and marks workspace closed when providerType is not local_fs", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cloud workspace issue",
      status: "done",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Cloud workspace",
      status: "active",
      providerType: "cloud_sandbox", // non-local_fs
      sourceIssueId: issueId,
      cwd: "/some/remote/path",
      branchName: "agent/feature/remote-branch",
    });

    await runPostDoneCleanup({
      db,
      issueId,
      issueIdentifier: "TC-3",
      allowedRoots: [os.tmpdir() + "/"],
    });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws!.status).toBe("closed");
    expect(ws!.cleanupReason).toBe("non_local_provider_skipped");
    expect(ws!.metadata?.cleanup).toMatchObject({
      branchDeleted: false,
      worktreeRemoved: false,
      skippedReason: "non_local_provider",
    });
  });
});
