import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceLifecycleService } from "../services/execution-workspace-lifecycle.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace lifecycle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function pathExists(target: string) {
  return fs.stat(target).then(() => true).catch(() => false);
}

describeEmbeddedPostgres("execution workspace terminal issue cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let lifecycle!: ReturnType<typeof executionWorkspaceLifecycleService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-lifecycle-");
    db = createDb(tempDb.connectionString);
    lifecycle = executionWorkspaceLifecycleService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
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

  async function createFixture(statuses: Array<"done" | "in_review">) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-workspace-"));
    tempDirs.add(repoRoot);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-terminal-worktree-${randomUUID()}`);
    tempDirs.add(worktreePath);
    const branchName = `terminal-cleanup-${randomUUID()}`;
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace cleanup",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        workspaceStrategy: { type: "git_worktree" },
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "git_repo",
      isPrimary: true,
      cwd: repoRoot,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Terminal workspace",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName,
      baseRef: "main",
      metadata: { createdByRuntime: true },
    });
    const issueIds = statuses.map(() => randomUUID());
    await db.insert(issues).values(statuses.map((status, index) => ({
      id: issueIds[index],
      companyId,
      projectId,
      title: `Issue ${index + 1}`,
      status,
      priority: "medium" as const,
      executionWorkspaceId,
    })));

    return { executionWorkspaceId, issueIds, worktreePath };
  }

  const actor = {
    actorType: "system" as const,
    actorId: "terminal-workspace-cleanup-test",
    agentId: null,
    runId: null,
  };

  it("defers cleanup until the terminal heartbeat finishes, then removes the worktree", async () => {
    const fixture = await createFixture(["done"]);

    const scheduled = await lifecycle.reconcileTerminalIssueWorkspace({
      issueId: fixture.issueIds[0],
      defer: true,
      actor,
    });
    expect(scheduled.outcome).toBe("deferred");
    expect(await pathExists(fixture.worktreePath)).toBe(true);

    const cleaned = await lifecycle.finishDeferredCleanup({
      issueId: fixture.issueIds[0],
      actor,
    });
    expect(cleaned.outcome).toBe("archived");
    expect(await pathExists(fixture.worktreePath)).toBe(false);

    const workspace = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(workspace.status).toBe("archived");
    expect(workspace.cleanupEligibleAt).toBeNull();
  }, 20_000);

  it("waits until every issue linked to an inherited workspace is terminal", async () => {
    const fixture = await createFixture(["done", "in_review"]);

    const blocked = await lifecycle.finishDeferredCleanup({
      issueId: fixture.issueIds[0],
      actor,
    });
    expect(blocked.outcome).toBe("blocked");
    expect(await pathExists(fixture.worktreePath)).toBe(true);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.issueIds[1]));
    const cleaned = await lifecycle.finishDeferredCleanup({
      issueId: fixture.issueIds[1],
      actor,
    });
    expect(cleaned.outcome).toBe("archived");
    expect(await pathExists(fixture.worktreePath)).toBe(false);
  }, 20_000);

  it("claims a terminal workspace once when linked issues finish concurrently", async () => {
    const fixture = await createFixture(["done", "done"]);

    const results = await Promise.all(
      fixture.issueIds.map((issueId) => lifecycle.finishDeferredCleanup({ issueId, actor })),
    );

    expect(results.map((result) => result.outcome).sort()).toEqual([
      "archived",
      "not_applicable",
    ]);
    expect(await pathExists(fixture.worktreePath)).toBe(false);

    const workspace = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(workspace.status).toBe("archived");

    const cleanupActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "execution_workspace.terminal_issue_cleanup"));
    expect(cleanupActivities).toHaveLength(1);
  }, 20_000);

  it("keeps a dirty terminal workspace and records why automatic cleanup was skipped", async () => {
    const fixture = await createFixture(["done"]);
    await fs.writeFile(path.join(fixture.worktreePath, "untracked.txt"), "keep me\n", "utf8");

    const blocked = await lifecycle.finishDeferredCleanup({
      issueId: fixture.issueIds[0],
      actor,
    });
    expect(blocked.outcome).toBe("blocked");
    expect(await pathExists(fixture.worktreePath)).toBe(true);

    const workspace = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(workspace.status).toBe("active");
    expect(workspace.cleanupReason).toContain("uncommitted files");
  }, 20_000);
});
