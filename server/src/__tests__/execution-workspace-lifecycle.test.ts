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
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceLifecycleService } from "../services/execution-workspace-lifecycle.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import {
  ensureRuntimeServicesForRun,
  releaseRuntimeServicesForRun,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";

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

describeEmbeddedPostgres("shared execution workspace session lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let lifecycle!: ReturnType<typeof executionWorkspaceLifecycleService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();
  const startedServiceWorkspaces = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-lifecycle-");
    db = createDb(tempDb.connectionString);
    lifecycle = executionWorkspaceLifecycleService(db);
  }, 20_000);

  afterEach(async () => {
    for (const executionWorkspaceId of startedServiceWorkspaces) {
      await stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId });
    }
    startedServiceWorkspaces.clear();
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture(
    statuses: Array<"done" | "in_review" | "todo">,
    mode: "isolated_workspace" | "shared_workspace" = "isolated_workspace",
  ) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-workspace-"));
    tempDirs.add(repoRoot);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const worktreePath = mode === "shared_workspace"
      ? repoRoot
      : path.join(path.dirname(repoRoot), `paperclip-terminal-worktree-${randomUUID()}`);
    const branchName = mode === "shared_workspace" ? null : `terminal-cleanup-${randomUUID()}`;
    if (branchName) {
      tempDirs.add(worktreePath);
      await runGit(repoRoot, ["branch", branchName]);
      await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    }

    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace lifecycle agent",
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
      mode,
      strategyType: mode === "shared_workspace" ? "project_primary" : "git_worktree",
      name: "Terminal workspace",
      status: "active",
      cwd: worktreePath,
      providerType: mode === "shared_workspace" ? "local_fs" : "git_worktree",
      providerRef: mode === "shared_workspace" ? null : worktreePath,
      branchName,
      baseRef: "main",
      metadata: { createdByRuntime: mode !== "shared_workspace" },
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

    return { companyId, agentId, projectId, projectWorkspaceId, executionWorkspaceId, issueIds, worktreePath };
  }

  /** A shared session from an earlier run: same issue, own id, not referenced by the issue. */
  async function insertPriorSharedSession(
    fixture: { companyId: string; projectId: string; projectWorkspaceId: string; worktreePath: string },
    sourceIssueId: string,
    options?: { lastUsedAt?: Date },
  ) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      projectWorkspaceId: fixture.projectWorkspaceId,
      sourceIssueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Prior run session",
      status: "active",
      cwd: fixture.worktreePath,
      providerType: "local_fs",
      providerRef: null,
      baseRef: "main",
      metadata: { createdByRuntime: false },
      // Sessions of earlier runs are aged by default: fresh ones are held by the grace window.
      lastUsedAt: options?.lastUsedAt ?? new Date(Date.now() - 60 * 60_000),
    });
    return id;
  }

  async function statusOf(executionWorkspaceId: string) {
    return db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0]?.status ?? null);
  }

  const actor = {
    actorType: "system" as const,
    actorId: "terminal-workspace-cleanup-test",
    agentId: null,
    runId: null,
  };

  it("lets the terminal workspace reaper archive a shared session without git or merge checks", async () => {
    const fixture = await createFixture(["done"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]);
    // A dirty project workspace must not block the archive of a shared session record.
    await fs.writeFile(path.join(fixture.worktreePath, "untracked.txt"), "keep me\n", "utf8");
    const reaper = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });

    const result = await reaper.sweepTerminalWorkspaces();

    expect(result.cleanupFailed).toBe(0);
    expect(await statusOf(prior)).toBe("archived");
    expect(await pathExists(fixture.worktreePath)).toBe(true);
    expect(await pathExists(path.join(fixture.worktreePath, "untracked.txt"))).toBe(true);
  }, 20_000);

  it("keeps git checks for a shared session that owns a git worktree", async () => {
    const fixture = await createFixture(["done"]);
    // Agent-level git_worktree strategy: the recorded mode defaults to shared_workspace.
    await db.update(executionWorkspaces).set({ mode: "shared_workspace", sourceIssueId: fixture.issueIds[0] })
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));
    await fs.writeFile(path.join(fixture.worktreePath, "untracked.txt"), "keep me\n", "utf8");
    const reaper = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });

    const result = await reaper.sweepTerminalWorkspaces();

    expect(result.cleanupFailed).toBe(0);
    expect(result.skippedUndelivered).toBe(1);
    expect(await statusOf(fixture.executionWorkspaceId)).toBe("active");
    expect(await pathExists(path.join(fixture.worktreePath, "untracked.txt"))).toBe(true);
  }, 20_000);

  it("cleans up a delivered git worktree of a shared session", async () => {
    const fixture = await createFixture(["done"]);
    await db.update(executionWorkspaces).set({ mode: "shared_workspace", sourceIssueId: fixture.issueIds[0] })
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));
    const reaper = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });

    const result = await reaper.sweepTerminalWorkspaces();

    expect(result.cleanupFailed).toBe(0);
    expect(await statusOf(fixture.executionWorkspaceId)).toBe("archived");
  }, 20_000);

  it("lets the reaper keep a shared session that another open issue still uses", async () => {
    const fixture = await createFixture(["done", "todo"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]);
    await db.update(issues).set({ executionWorkspaceId: prior }).where(eq(issues.id, fixture.issueIds[1]));
    const reaper = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });

    await reaper.sweepTerminalWorkspaces();

    expect(await statusOf(prior)).toBe("active");
    const other = await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
      .where(eq(issues.id, fixture.issueIds[1])).then((rows) => rows[0]);
    expect(other.executionWorkspaceId).toBe(prior);
  }, 20_000);

  it("keeps a superseded session that another open issue has bound", async () => {
    const fixture = await createFixture(["in_review", "todo"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]);
    // Another issue reuses the old session before the archive decision is made.
    await db.update(issues).set({ executionWorkspaceId: prior }).where(eq(issues.id, fixture.issueIds[1]));

    const archived = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0],
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(archived).toEqual([]);
    expect(await statusOf(prior)).toBe("active");
    const other = await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
      .where(eq(issues.id, fixture.issueIds[1])).then((rows) => rows[0]);
    expect(other.executionWorkspaceId).toBe(prior);
  }, 20_000);

  it("archives shared sessions of previous runs and keeps the current one", async () => {
    const fixture = await createFixture(["in_review"], "shared_workspace");
    const priorA = await insertPriorSharedSession(fixture, fixture.issueIds[0]);
    const priorB = await insertPriorSharedSession(fixture, fixture.issueIds[0]);

    const archived = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0],
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(archived.sort()).toEqual([priorA, priorB].sort());
    expect(await statusOf(priorA)).toBe("archived");
    expect(await statusOf(priorB)).toBe("archived");
    expect(await statusOf(fixture.executionWorkspaceId)).toBe("active");
    expect(await pathExists(fixture.worktreePath)).toBe(true);

    const issue = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, fixture.issueIds[0]))
      .then((rows) => rows[0]);
    expect(issue.executionWorkspaceId).toBe(fixture.executionWorkspaceId);
  }, 20_000);

  /**
   * Starts a real long-running service for a session and returns its pid. The
   * service writes its own pid, because the runtime starts it through a shell.
   */
  async function startSessionService(input: {
    fixture: { companyId: string; agentId: string; projectId: string; projectWorkspaceId: string; worktreePath: string; issueIds: string[] };
    executionWorkspaceId: string;
    name: string;
    reuseScope: "execution_workspace" | "project_workspace";
    keepLease?: boolean;
  }) {
    const pidFile = path.join(input.fixture.worktreePath, `${input.name}.pid`);
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const runId = randomUUID();
    // A finished run started the service; it does not keep the session alive.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.fixture.companyId,
      agentId: input.fixture.agentId,
      status: "succeeded",
      startedAt: new Date(Date.now() - 60 * 60_000),
      finishedAt: new Date(Date.now() - 59 * 60_000),
      contextSnapshot: { issueId: input.fixture.issueIds[0] },
    });
    startedServiceWorkspaces.add(input.executionWorkspaceId);
    const [service] = await ensureRuntimeServicesForRun({
      db,
      runId,
      agent: { id: input.fixture.agentId, name: "Workspace lifecycle agent", companyId: input.fixture.companyId },
      issue: { id: input.fixture.issueIds[0]!, identifier: "PAP-1", title: "Issue 1" },
      workspace: {
        baseCwd: input.fixture.worktreePath,
        source: "project_primary",
        projectId: input.fixture.projectId,
        workspaceId: input.fixture.projectWorkspaceId,
        repoUrl: null,
        repoRef: "HEAD",
        strategy: "project_primary",
        cwd: input.fixture.worktreePath,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      executionWorkspaceId: input.executionWorkspaceId,
      config: {
        workspaceRuntime: {
          services: [{
            name: input.name,
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            lifecycle: "shared",
            reuseScope: input.reuseScope,
            stopPolicy: { type: "manual" },
          }],
        },
      },
      adapterEnv: {},
    });
    if (!input.keepLease) await releaseRuntimeServicesForRun(runId);
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt += 1) {
      pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pid).toBeGreaterThan(0);
    return { id: service!.id, pid, runId };
  }

  function processAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForExit(pid: number) {
    for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !processAlive(pid);
  }

  async function serviceStatus(id: string) {
    return db
      .select({ status: workspaceRuntimeServices.status })
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, id))
      .then((rows) => rows[0]?.status ?? null);
  }

  it("stops an idle session service and keeps leased and project-owned services running", async () => {
    const fixture = await createFixture(["in_review"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]!);
    const idle = await startSessionService({ fixture, executionWorkspaceId: prior, name: "idle", reuseScope: "execution_workspace" });
    const leased = await startSessionService({
      fixture, executionWorkspaceId: prior, name: "leased", reuseScope: "execution_workspace", keepLease: true,
    });
    const projectOwned = await startSessionService({ fixture, executionWorkspaceId: prior, name: "project", reuseScope: "project_workspace" });

    const archived = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0]!,
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(archived).toEqual([prior]);
    expect(await waitForExit(idle.pid)).toBe(true);
    expect(await serviceStatus(idle.id)).toBe("stopped");
    expect(processAlive(leased.pid)).toBe(true);
    expect(await serviceStatus(leased.id)).toBe("running");
    expect(processAlive(projectOwned.pid)).toBe(true);
    expect(await serviceStatus(projectOwned.id)).toBe("running");
    await releaseRuntimeServicesForRun(leased.runId);
  }, 30_000);

  it("lets the reaper stop only idle session services when it archives a shared session", async () => {
    const fixture = await createFixture(["done"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]!);
    const idle = await startSessionService({ fixture, executionWorkspaceId: prior, name: "idle", reuseScope: "execution_workspace" });
    const leased = await startSessionService({
      fixture, executionWorkspaceId: prior, name: "leased", reuseScope: "execution_workspace", keepLease: true,
    });
    const projectOwned = await startSessionService({ fixture, executionWorkspaceId: prior, name: "project", reuseScope: "project_workspace" });
    const reaper = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });

    const result = await reaper.sweepTerminalWorkspaces();

    expect(result.cleanupFailed).toBe(0);
    expect(await statusOf(prior)).toBe("archived");
    expect(await waitForExit(idle.pid)).toBe(true);
    expect(await serviceStatus(idle.id)).toBe("stopped");
    expect(processAlive(leased.pid)).toBe(true);
    expect(await serviceStatus(leased.id)).toBe("running");
    expect(processAlive(projectOwned.pid)).toBe(true);
    expect(await serviceStatus(projectOwned.id)).toBe("running");
    await releaseRuntimeServicesForRun(leased.runId);
  }, 30_000);

  it("archives the session and records the warning when stopping a service fails", async () => {
    const fixture = await createFixture(["in_review"], "shared_workspace");
    const prior = await insertPriorSharedSession(fixture, fixture.issueIds[0]!);
    const idle = await startSessionService({ fixture, executionWorkspaceId: prior, name: "idle", reuseScope: "execution_workspace" });
    // Controlled fault: the stopped-state write for runtime services fails once.
    let failNextServiceWrite = true;
    const faultyDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: unknown) => {
            if (table === workspaceRuntimeServices && failNextServiceWrite) {
              failNextServiceWrite = false;
              throw new Error("runtime service store unavailable");
            }
            return target.update(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const archived = await executionWorkspaceLifecycleService(faultyDb).archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0]!,
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(failNextServiceWrite).toBe(false);
    expect(archived).toEqual([prior]);
    expect(await statusOf(prior)).toBe("archived");
    const [session] = await db
      .select({ cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, prior));
    expect(session?.cleanupReason).toContain("runtime service store unavailable");
    const [activity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, prior));
    expect(activity?.details).toMatchObject({ warnings: ["runtime service store unavailable"] });
    // The process stop ran before the failing write, so nothing keeps running.
    expect(await waitForExit(idle.pid)).toBe(true);
  }, 30_000);

  it("keeps a concurrently opened shared session that another live run still owns", async () => {
    const fixture = await createFixture(["in_review"], "shared_workspace");
    const stalePrior = await insertPriorSharedSession(fixture, fixture.issueIds[0]);
    // Overlapping run: its session was just created, so it must not be archived.
    const concurrent = await insertPriorSharedSession(fixture, fixture.issueIds[0], {
      lastUsedAt: new Date(),
    });

    const archived = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0],
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(archived).toEqual([stalePrior]);
    expect(await statusOf(stalePrior)).toBe("archived");
    expect(await statusOf(concurrent)).toBe("active");
    expect(await statusOf(fixture.executionWorkspaceId)).toBe("active");
  }, 20_000);

  it("keeps an aged shared session while a running heartbeat still references it", async () => {
    const fixture = await createFixture(["in_review"], "shared_workspace");
    const liveWorkspace = await insertPriorSharedSession(fixture, fixture.issueIds[0], {
      lastUsedAt: new Date(Date.now() - 60 * 60_000),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60_000),
      contextSnapshot: {
        issueId: fixture.issueIds[0],
        executionWorkspaceId: liveWorkspace,
      },
    });

    const whileRunning = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0],
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(whileRunning).toEqual([]);
    expect(await statusOf(liveWorkspace)).toBe("active");

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const afterFinish = await lifecycle.archiveSupersededSharedSessionsForIssue({
      companyId: fixture.companyId,
      issueId: fixture.issueIds[0],
      keepWorkspaceId: fixture.executionWorkspaceId,
      actor,
    });

    expect(afterFinish).toEqual([liveWorkspace]);
    expect(await statusOf(liveWorkspace)).toBe("archived");
  }, 20_000);
});
