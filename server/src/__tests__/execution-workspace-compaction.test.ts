import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executionWorkspaceService,
  type ExecutionWorkspaceServiceOptions,
} from "../services/execution-workspaces.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import { WORKSPACE_COMPACTION_TRASH_DIR } from "../services/workspace-compaction.ts";

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace compaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function git(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim();
}

async function exists(filePath: string) {
  return fs.lstat(filePath).then(() => true, () => false);
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepo() {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-compaction-")));
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await git(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await writeFile(path.join(repoRoot, "README.md"), "# Test repo\n");
  await writeFile(
    path.join(repoRoot, ".gitignore"),
    ["node_modules/", "dist/", ".env", ".paperclip/", "local-data/", ""].join("\n"),
  );
  await git(repoRoot, ["add", "README.md", ".gitignore"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  await git(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

// Files a finished task leaves behind. The regenerable directories are the
// only paths compaction may remove; everything else is work or data.
const REGENERABLE_PATHS = ["node_modules", "packages/app/node_modules", "dist"];
const PRESERVED_PATHS = [
  "notes/findings.md",
  ".env",
  "local-data/state.json",
  ".paperclip/instances/default/db.txt",
];

async function populateWorktree(worktreePath: string) {
  await writeFile(path.join(worktreePath, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  await writeFile(path.join(worktreePath, "packages/app/node_modules/dep/index.js"), "module.exports = 2;\n");
  await writeFile(path.join(worktreePath, "dist/server.js"), "built\n");
  await writeFile(path.join(worktreePath, "notes/findings.md"), "untracked agent notes\n");
  await writeFile(path.join(worktreePath, ".env"), "TOKEN=local\n");
  await writeFile(path.join(worktreePath, "local-data/state.json"), "{}\n");
  await writeFile(path.join(worktreePath, ".paperclip/instances/default/db.txt"), "instance data\n");
  await fs.appendFile(path.join(worktreePath, "README.md"), "uncommitted edit\n");
}

describeEmbeddedPostgres("terminal workspace compaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-compaction-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null, parentId: null });
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(options: ExecutionWorkspaceServiceOptions = {}) {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      workspaceReaperCooldownDays: 0,
      workspaceCompactionDelayMs: 0,
      ...options,
    });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.slice(0, 7).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Compaction", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, projectId, agentId, issuePrefix };
  }

  async function seedWorkspace(options: {
    worktreePath?: string;
    repoRoot?: string;
    commitOnBranch?: boolean;
    populate?: boolean;
    terminalAgoMs?: number;
    mode?: "isolated_workspace" | "shared_workspace";
  } = {}) {
    const repoRoot = options.repoRoot ?? await createRepo();
    tempDirs.add(repoRoot);
    const branchName = `PAP-${Math.floor(Math.random() * 100000)}-finished-task`;
    let worktreePath = options.worktreePath;
    if (!worktreePath) {
      worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
      await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "main"]);
    }
    if (options.commitOnBranch) {
      await writeFile(path.join(worktreePath, "src/feature.ts"), "export const unmerged = true;\n");
      await git(worktreePath, ["add", "src/feature.ts"]);
      await git(worktreePath, ["commit", "-m", "Unmerged work"]);
    }
    if (options.populate !== false) await populateWorktree(worktreePath);

    const company = await seedCompany();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: company.companyId,
      projectId: company.projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: repoRoot,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: company.companyId,
      projectId: company.projectId,
      projectWorkspaceId,
      mode: options.mode ?? "isolated_workspace",
      strategyType: "git_worktree",
      name: branchName,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      baseRef: "main",
      branchName,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: company.companyId,
      projectId: company.projectId,
      identifier: `${company.issuePrefix}-1`,
      title: "Finished task",
      status: "done",
      priority: "medium",
      completedAt: new Date(Date.now() - (options.terminalAgoMs ?? 2 * HOUR_MS)),
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { ...company, repoRoot, worktreePath, branchName, executionWorkspaceId, sourceIssueId };
  }

  async function workspaceStatus(executionWorkspaceId: string) {
    const [row] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return row?.status ?? null;
  }

  async function expectRegenerablePresent(worktreePath: string, present: boolean) {
    for (const relativePath of REGENERABLE_PATHS) {
      expect(await exists(path.join(worktreePath, relativePath)), relativePath).toBe(present);
    }
  }

  async function expectWorkPreserved(worktreePath: string) {
    for (const relativePath of PRESERVED_PATHS) {
      expect(await exists(path.join(worktreePath, relativePath)), relativePath).toBe(true);
    }
    expect(await fs.readFile(path.join(worktreePath, "README.md"), "utf8")).toContain("uncommitted edit");
  }

  it.each([false, true])("compacts an undelivered workspace and preserves source with Git expiration %s", async gitCacheExpirationEnabled => {
    const seeded = await seedWorkspace({ commitOnBranch: true });
    const headBefore = await git(seeded.worktreePath, ["rev-parse", "HEAD"]);
    const statusBefore = await git(seeded.worktreePath, ["status", "--porcelain", "--untracked-files=all"]);

    const sweep = await service({ gitCacheExpirationEnabled }).sweepTerminalWorkspaces();

    // The branch carries unmerged work, so the reaper keeps the workspace.
    expect(sweep).toMatchObject({ compacted: 1, compactionFailed: 0, archived: 0 });
    if (!gitCacheExpirationEnabled) expect(sweep.skippedUndelivered).toBe(1);
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");
    await expectRegenerablePresent(seeded.worktreePath, false);
    await expectWorkPreserved(seeded.worktreePath);
    expect(await exists(path.join(seeded.worktreePath, "src/feature.ts"))).toBe(true);
    expect(await git(seeded.worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(seeded.repoRoot, ["rev-parse", `refs/heads/${seeded.branchName}`])).toBe(headBefore);
    // Removing ignored directories never changes what Git sees as work.
    expect(await git(seeded.worktreePath, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
    // The moved files are deleted, not parked.
    const trashRoot = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR);
    expect(await fs.readdir(trashRoot).catch(() => [])).toEqual([]);

    const [activity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, seeded.executionWorkspaceId),
        eq(activityLog.action, "execution_workspace.regenerable_files_removed"),
      ));
    expect((activity?.details as { removedPaths?: string[] } | undefined)?.removedPaths?.sort())
      .toEqual([...REGENERABLE_PATHS].sort());
  }, 30_000);

  it("compacts a delivered workspace that is still inside the archive cooldown", async () => {
    const seeded = await seedWorkspace();
    await git(seeded.worktreePath, ["checkout", "--", "README.md"]);

    const sweep = await service({ workspaceReaperCooldownDays: 7 }).sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 1, archived: 0, skippedCooldown: 1 });
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");
    await expectRegenerablePresent(seeded.worktreePath, false);
    expect(await exists(path.join(seeded.worktreePath, "notes/findings.md"))).toBe(true);
  }, 30_000);

  it.each([false, true])("retains skipped startup compaction for the next sweep with Git expiration %s", async gitCacheExpirationEnabled => {
    const seeded = await seedWorkspace();
    const svc = service({ workspaceReaperCooldownDays: 7, gitCacheExpirationEnabled, gitCacheExpirationDryRun: true });

    expect(await svc.sweepTerminalWorkspaces(50, undefined, { compact: false })).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    // The skipped compaction stays scheduled, so the worker wakes for it.
    const next = await svc.nextTerminalWorkspaceSweepAt();
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(Date.now());

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    await expectRegenerablePresent(seeded.worktreePath, false);
  }, 30_000);

  it("leaves leftover trash for a later sweep when a sweep skips compaction", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    // The cooldown keeps the workspace a candidate across both sweeps.
    const svc = service({ workspaceReaperCooldownDays: 7 });

    await svc.sweepTerminalWorkspaces(50, undefined, { compact: false });
    expect(await exists(trashEntry)).toBe(true);

    await svc.sweepTerminalWorkspaces();
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("purges skipped trash after a startup sweep archives the last workspace beside it", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    const svc = service();

    // No cooldown: the startup sweep archives the only workspace in this
    // directory, so no later sweep has a candidate there.
    expect(await svc.sweepTerminalWorkspaces(50, undefined, { compact: false })).toMatchObject({ archived: 1 });
    expect(await exists(trashEntry)).toBe(true);

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ checked: 0 });
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("keeps skipped trash queued when the next sweep is aborted", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    const svc = service();
    await svc.sweepTerminalWorkspaces(50, undefined, { compact: false });

    const controller = new AbortController();
    controller.abort();
    await expect(svc.sweepTerminalWorkspaces(50, controller.signal)).rejects.toThrow();
    expect(await exists(trashEntry)).toBe(true);

    await svc.sweepTerminalWorkspaces();
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("waits for the compaction delay after the issue tree becomes terminal", async () => {
    const seeded = await seedWorkspace({ terminalAgoMs: 10 * 60 * 1000 });
    const svc = service({ workspaceReaperCooldownDays: 7, workspaceCompactionDelayMs: HOUR_MS });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    // The worker wakes when the delay ends, not when the archive cooldown ends.
    const next = await svc.nextTerminalWorkspaceSweepAt();
    expect(next).not.toBeNull();
    expect(next!).toBeLessThan(Date.now() + HOUR_MS);

    await db
      .update(issues)
      .set({ completedAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(eq(issues.id, seeded.sourceIssueId));
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    await expectRegenerablePresent(seeded.worktreePath, false);
  }, 30_000);

  it("leaves files alone while a run is active on the task", async () => {
    const seeded = await seedWorkspace();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, seeded.sourceIssueId));

    const sweep = await service().sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a queued run targets the task through its context", async () => {
    const seeded = await seedWorkspace();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
      contextSnapshot: { issueId: seeded.sourceIssueId },
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a child issue is unfinished", async () => {
    const seeded = await seedWorkspace();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      parentId: seeded.sourceIssueId,
      identifier: `${seeded.issuePrefix}-2`,
      title: "Follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, skippedNonTerminalTree: 1 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a runtime service runs from the worktree", async () => {
    const seeded = await seedWorkspace();
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      executionWorkspaceId: seeded.executionWorkspaceId,
      issueId: seeded.sourceIssueId,
      scopeType: "execution_workspace",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: seeded.worktreePath,
      provider: "local_process",
      healthStatus: "healthy",
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("restores the files when the task reopens while they are being moved", async () => {
    const seeded = await seedWorkspace();
    const svc = service({
      afterWorkspaceCompactionMove: async () => {
        await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, seeded.sourceIssueId));
      },
    });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, compactionFailed: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    expect(await fs.readFile(path.join(seeded.worktreePath, "node_modules/left-pad/index.js"), "utf8"))
      .toBe("module.exports = 1;\n");
    const trashRoot = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR);
    expect(await fs.readdir(trashRoot).catch(() => [])).toEqual([]);
  }, 30_000);

  it("restores the files when a run starts while they are being moved", async () => {
    const seeded = await seedWorkspace();
    const svc = service({
      afterWorkspaceCompactionMove: async () => {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          status: "queued",
          contextSnapshot: { issueId: seeded.sourceIssueId },
        });
      },
    });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("never compacts a shared workspace or a main checkout", async () => {
    const shared = await seedWorkspace({ mode: "shared_workspace" });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(shared.worktreePath, true);

    // A workspace row that points at the repository's main checkout (its .git
    // is a directory) is never compacted, whatever its strategy says.
    const repoRoot = await createRepo();
    await populateWorktree(repoRoot);
    await seedWorkspace({ repoRoot, worktreePath: repoRoot, populate: false });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(repoRoot, true);
  }, 30_000);

  it("compacts once per terminal cycle and again after the task finishes a later cycle", async () => {
    const seeded = await seedWorkspace();
    const svc = service({ workspaceReaperCooldownDays: 7 });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    // A resumed run regenerates dependencies, and the task finishes again.
    await writeFile(path.join(seeded.worktreePath, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    expect(await exists(path.join(seeded.worktreePath, "node_modules"))).toBe(true);

    await db
      .update(issues)
      .set({ completedAt: new Date(Date.now() - HOUR_MS) })
      .where(eq(issues.id, seeded.sourceIssueId));
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    expect(await exists(path.join(seeded.worktreePath, "node_modules"))).toBe(false);
  }, 30_000);

  it("regenerates removed files when the task resumes in the compacted worktree", async () => {
    const repoRoot = await createRepo();
    tempDirs.add(repoRoot);
    const provisionCommand = "mkdir -p node_modules/left-pad && echo regenerated > node_modules/left-pad/index.js";
    const realizationInput = {
      base: {
        baseCwd: repoRoot,
        source: "project_primary" as const,
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "main", provisionCommand } },
      issue: { id: "issue-1", identifier: "PAP-9", title: "Resume after compaction" },
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
    } satisfies Parameters<typeof realizeExecutionWorkspace>[0];
    const first = await realizeExecutionWorkspace(realizationInput);
    expect(first.created).toBe(true);
    await writeFile(path.join(first.cwd, "notes/findings.md"), "untracked agent notes\n");
    await writeFile(path.join(first.cwd, "src/feature.ts"), "export const unmerged = true;\n");
    await git(first.cwd, ["add", "src/feature.ts"]);
    await git(first.cwd, ["commit", "-m", "Unmerged work"]);
    const head = await git(first.cwd, ["rev-parse", "HEAD"]);

    const seeded = await seedWorkspace({ repoRoot, worktreePath: first.cwd, populate: false });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    expect(await exists(path.join(first.cwd, "node_modules"))).toBe(false);
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");

    const resumed = await realizeExecutionWorkspace({
      ...realizationInput,
      recordedBranchOwnership: { branchName: first.branchName!, createdByRuntime: true },
    });

    expect(resumed.created).toBe(false);
    expect(resumed.cwd).toBe(first.cwd);
    expect(await fs.readFile(path.join(first.cwd, "node_modules/left-pad/index.js"), "utf8")).toBe("regenerated\n");
    expect(await fs.readFile(path.join(first.cwd, "notes/findings.md"), "utf8")).toBe("untracked agent notes\n");
    expect(await git(first.cwd, ["rev-parse", "HEAD"])).toBe(head);
  }, 60_000);

  it("purges leftover trash even when the workspace has nothing left to compact", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);

    const sweep = await service().sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 0, compactionFailed: 0 });
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("does not compact when compaction is disabled", async () => {
    const seeded = await seedWorkspace();
    expect(await service({ workspaceCompactionDelayMs: null }).sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);
});
