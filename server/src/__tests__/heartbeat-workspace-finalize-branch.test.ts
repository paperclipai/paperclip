import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Finalization branch guard test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat workspace finalize branch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-finalize-branch-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "finalization branch guard\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForHeartbeatIdle(db: Db, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForRuntimeStateLastRun(db: Db, agentId: string, runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await db
      .select({ lastRunId: agentRuntimeState.lastRunId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    if (state?.lastRunId === runId) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForRecoveryAction(db: Db, issueId: string, status: "active" | "resolved", timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.status, status)))
      .then((rows) => rows[0] ?? null);
    if (action) return action;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function waitForRecoveryAttempt(db: Db, issueId: string, attemptCount: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.status, "active")))
      .then((rows) => rows[0] ?? null);
    if (action && action.attemptCount >= attemptCount) return action;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function readAdapterWorkspace(input: unknown) {
  const context = (input as { context?: Record<string, unknown> }).context ?? {};
  const workspace = context.paperclipWorkspace as Record<string, unknown> | undefined;
  const cwd = typeof workspace?.cwd === "string" ? workspace.cwd : null;
  const branchName = typeof workspace?.branchName === "string" ? workspace.branchName : null;
  const executionWorkspaceId =
    typeof context.executionWorkspaceId === "string" ? context.executionWorkspaceId : null;
  if (!cwd || !branchName || !executionWorkspaceId) {
    throw new Error("Adapter input is missing the realized execution workspace context");
  }
  return { cwd, branchName, executionWorkspaceId };
}

async function seedRunTarget(db: Db, repoRoot: string) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();

  await instanceSettingsService(db).updateExperimental({
    enableIsolatedWorkspaces: true,
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Workspace Finalize Branch Guard",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: repoRoot,
    isPrimary: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    permissions: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId,
    title: "Publish without drifting managed workspace",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: agentId,
    identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    executionWorkspaceSettings: {
      mode: "isolated_workspace",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { companyId, projectId, projectWorkspaceId, issueId, agentId };
}

async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}

async function listFinalizeOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize"),
    ))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

async function listRunWorkspaceOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(eq(workspaceOperations.heartbeatRunId, runId))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

describeEmbeddedPostgres("heartbeat workspace finalization branch guard", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-finalize-branch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await waitForHeartbeatIdle(db);
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Finalization branch guard test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issuePlanDecompositions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(workspaceOperations);
    await deleteHeartbeatRowsAfterActivityLogDrains(db);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("repairs clean unrecorded branch drift before recording workspace finalization", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let recordedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;
    let workspaceCwd: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      workspaceCwd = workspace.cwd;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after switching to a publish branch.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    await expect(execFileAsync("git", ["branch", "--show-current"], { cwd: workspaceCwd! }))
      .resolves.toMatchObject({ stdout: `${recordedBranch}\n` });

    const operations = await listRunWorkspaceOperations(db, run!.id);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: `git checkout ${recordedBranch}`,
          status: "succeeded",
          executionWorkspaceId,
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: recordedBranch,
            actualBranchName: publishBranch,
            executionWorkspaceId,
            sourceIssueId: issueId,
          }),
        }),
      ]),
    );

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: {
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: recordedBranch,
        actualBranchName: recordedBranch,
      },
      managedGitWorktreeBranchRepair: {
        attempted: true,
        succeeded: true,
        initial: expect.objectContaining({
          valid: false,
          reasonCode: "branch_mismatch",
          expectedBranchName: recordedBranch,
          actualBranchName: publishBranch,
        }),
      },
    });
  }, 20_000);

  it("adopts unrecorded forward branch drift for finalization without persisting it", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let recordedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await writeFile(path.join(workspace.cwd, "publish.txt"), "publish branch work\n", "utf8");
      await runGit(workspace.cwd, ["add", "publish.txt"]);
      await runGit(workspace.cwd, ["commit", "-m", "Add publish branch work"]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after switching to a publish branch with commits.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const finalizedWorkspace = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(finalizedWorkspace?.branchName).toBe(recordedBranch);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: expect.objectContaining({
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: publishBranch,
        actualBranchName: publishBranch,
      }),
      managedGitWorktreeBranchRepair: expect.objectContaining({
        attempted: true,
        succeeded: true,
      }),
    });
    expect(recordedBranch).not.toBe(publishBranch);
  }, 20_000);

  it("allows a successful adapter run when the branch transition is recorded before finalization", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let executionWorkspaceId: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      executionWorkspaceId = workspace.executionWorkspaceId;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      await db
        .update(executionWorkspaces)
        .set({
          branchName: publishBranch,
          updatedAt: new Date(),
        })
        .where(eq(executionWorkspaces.id, workspace.executionWorkspaceId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after recording a branch transition.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const finalizedWorkspace = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(finalizedWorkspace?.branchName).toBe(publishBranch);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: {
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: publishBranch,
        actualBranchName: publishBranch,
      },
    });
  }, 20_000);

  it("keeps failed terminal workspace finalization visible until a successful re-finalize", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { companyId, agentId, issueId } = await seedRunTarget(db, repoRoot);
    const dependentId = randomUUID();
    let workspaceCwd: string | null = null;
    let expectedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;

    await db.insert(issues).values({
      id: dependentId,
      companyId,
      title: "Wait for finalized workspace output",
      status: "blocked",
      workMode: "standard",
      priority: "medium",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await issueService(db).update(dependentId, { blockedByIssueIds: [issueId] });

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      workspaceCwd = workspace.cwd;
      expectedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId: workspace.executionWorkspaceId,
        issueId,
        phase: "workspace_prepare",
        status: "succeeded",
        startedAt: new Date(Date.now() + 500),
        finishedAt: new Date(Date.now() + 500),
      });
      await rm(workspace.cwd, { recursive: true, force: true });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Issue was marked done before workspace finalization failed.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const failedRun = await wakeIssue(heartbeat, agentId, issueId);
    expect(failedRun).not.toBeNull();
    await expect(waitForRunToFinish(heartbeat, failedRun!.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
    });

    const activeRecovery = await waitForRecoveryAction(db, issueId, "active");
    expect(activeRecovery).toMatchObject({
      kind: "workspace_validation",
      cause: "workspace_finalize_failed",
      status: "active",
      attemptCount: 1,
      maxAttempts: null,
      timeoutAt: null,
    });
    const overlappingOperations = await db
      .select({ phase: workspaceOperations.phase, startedAt: workspaceOperations.startedAt })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.issueId, issueId),
        eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId!),
      ));
    const newerPrepare = overlappingOperations.find((operation) => operation.phase === "workspace_prepare");
    const failedFinalize = overlappingOperations.find((operation) => operation.phase === "workspace_finalize");
    expect(newerPrepare?.startedAt.getTime()).toBeGreaterThan(failedFinalize!.startedAt.getTime());
    await expect(issueService(db).getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [issueId],
      unresolvedBlockerIssueIds: [issueId],
    });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ status: "done" }]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await runGit(repoRoot, ["worktree", "prune"]);
    await runGit(repoRoot, ["worktree", "add", workspaceCwd!, expectedBranch!]);
    await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      await rm(workspaceCwd!, { recursive: true, force: true });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "The first repair attempt still failed finalization.",
        provider: "test",
        model: "test-model",
      };
    });

    const repeatedFailureRun = await wakeIssue(heartbeat, agentId, issueId);
    expect(repeatedFailureRun).not.toBeNull();
    await expect(waitForRunToFinish(heartbeat, repeatedFailureRun!.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
    });
    await expect(waitForRecoveryAttempt(db, issueId, 2)).resolves.toMatchObject({
      id: activeRecovery?.id,
      status: "active",
      attemptCount: 2,
    });

    await runGit(repoRoot, ["worktree", "prune"]);
    await runGit(repoRoot, ["worktree", "add", workspaceCwd!, expectedBranch!]);
    await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Workspace repair was finalized successfully.",
        provider: "test",
        model: "test-model",
      };
    });

    const repairedRun = await wakeIssue(heartbeat, agentId, issueId);
    expect(repairedRun).not.toBeNull();
    await expect(waitForRunToFinish(heartbeat, repairedRun!.id)).resolves.toMatchObject({
      status: "succeeded",
      errorCode: null,
    });

    const resolvedRecovery = await waitForRecoveryAction(db, issueId, "resolved");
    expect(resolvedRecovery).toMatchObject({
      id: activeRecovery?.id,
      cause: "workspace_finalize_failed",
      status: "resolved",
      outcome: "restored",
    });
    await expect(issueService(db).getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
    });
  }, 45_000);

  it("does not create terminal-finalize recovery after cancellation commits before stale promotion", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      await db.update(issues).set({ status: "cancelled", updatedAt: new Date() }).where(eq(issues.id, issueId));
      await rm(workspace.cwd, { recursive: true, force: true });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Cancellation completed before stale finalization failure promotion.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const failedRun = await wakeIssue(heartbeat, agentId, issueId);
    expect(failedRun).not.toBeNull();
    await expect(waitForRunToFinish(heartbeat, failedRun!.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
    });

    await expect(waitForRecoveryAction(db, issueId, "active", 250)).resolves.toBeNull();
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ status: "cancelled" }]);
  }, 20_000);
});
