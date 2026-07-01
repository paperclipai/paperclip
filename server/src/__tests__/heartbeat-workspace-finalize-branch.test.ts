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
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("fails a successful adapter run when the managed worktree branch drift was not recorded", async () => {
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
      status: "failed",
      errorCode: "workspace_validation_failed",
      error: expect.stringContaining("Record a sanctioned execution-workspace branch transition"),
    });
    const workspaceValidation = (finishedRun?.resultJson as Record<string, unknown> | null)?.workspaceValidation;
    expect(workspaceValidation).toMatchObject({
      reason: "git_worktree_branch_mismatch_after_run",
      fingerprint: expect.stringMatching(/^workspace_finalize_branch_mismatch:v1:sha256:/),
      issueId,
      persistedExecutionWorkspaceId: executionWorkspaceId,
      managedGitWorktreeBranch: expect.objectContaining({
        executionWorkspaceId,
        reasonCode: "branch_mismatch",
        expectedBranchName: recordedBranch,
        actualBranchName: publishBranch,
      }),
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "failed",
      executionWorkspaceId,
      stderrExcerpt: expect.stringContaining("Managed git worktree branch check failed"),
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: {
        executionWorkspaceId,
        valid: false,
        reasonCode: "branch_mismatch",
        expectedBranchName: recordedBranch,
        actualBranchName: publishBranch,
      },
    });
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
});
