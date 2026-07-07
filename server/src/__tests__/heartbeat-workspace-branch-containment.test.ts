import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
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

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Branch-containment test run.",
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
    `Skipping embedded Postgres heartbeat workspace branch containment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type BranchContainmentCallSite = "fresh_realize" | "persisted_restore" | "finalize";

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-branch-containment-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "branch containment\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function createForwardBranchMismatch(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string;
}) {
  await mkdir(path.dirname(input.worktreePath), { recursive: true });
  await runGit(input.repoRoot, ["branch", input.expectedBranch]);
  await runGit(input.repoRoot, ["worktree", "add", "-b", input.actualBranch, input.worktreePath, input.expectedBranch]);
  await writeFile(path.join(input.worktreePath, "actual-branch.txt"), "actual branch work\n", "utf8");
  await runGit(input.worktreePath, ["add", "actual-branch.txt"]);
  await runGit(input.worktreePath, ["commit", "-m", "Add actual branch work"]);
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

async function waitForContainmentSideEffects(input: {
  db: Db;
  companyId: string;
  sourceIssueId: string;
  sameWorkspaceSiblingId: string;
  otherWorkspaceSiblingId: string;
  timeoutMs?: number;
}) {
  const issueIds = [
    input.sourceIssueId,
    input.sameWorkspaceSiblingId,
    input.otherWorkspaceSiblingId,
  ];
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  let latest: {
    issueRows: Awaited<ReturnType<typeof readContainmentIssueRows>>;
    actionRows: Awaited<ReturnType<typeof readContainmentActionRows>>;
    comments: Awaited<ReturnType<typeof readContainmentComments>>;
  } | null = null;
  while (Date.now() < deadline) {
    const [issueRows, actionRows, comments] = await Promise.all([
      readContainmentIssueRows(input.db, issueIds),
      readContainmentActionRows(input.db, input.companyId, issueIds),
      readContainmentComments(input.db, issueIds),
    ]);
    latest = { issueRows, actionRows, comments };
    const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
    const source = issueById.get(input.sourceIssueId);
    const sameWorkspaceSibling = issueById.get(input.sameWorkspaceSiblingId);
    const otherWorkspaceSibling = issueById.get(input.otherWorkspaceSiblingId);
    const recoveryActionId = actionRows.length === 1 ? actionRows[0]?.id : null;
    const hasRecoveryActionComment = recoveryActionId
      ? comments.some((comment) =>
          comment.issueId === input.sourceIssueId &&
          comment.body.includes(`Recovery action: \`${recoveryActionId}\``))
      : false;
    if (
      source?.status === "blocked" &&
      source.executionRunId === null &&
      source.checkoutRunId === null &&
      sameWorkspaceSibling?.status === "in_progress" &&
      sameWorkspaceSibling.executionRunId === null &&
      sameWorkspaceSibling.checkoutRunId === null &&
      otherWorkspaceSibling?.status === "in_progress" &&
      otherWorkspaceSibling.executionRunId === null &&
      otherWorkspaceSibling.checkoutRunId === null &&
      actionRows.length === 1 &&
      hasRecoveryActionComment
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? {
    issueRows: await readContainmentIssueRows(input.db, issueIds),
    actionRows: await readContainmentActionRows(input.db, input.companyId, issueIds),
    comments: await readContainmentComments(input.db, issueIds),
  };
}

function readContainmentIssueRows(db: Db, issueIds: string[]) {
  return db
    .select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
      executionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

function readContainmentActionRows(db: Db, companyId: string, issueIds: string[]) {
  return db
    .select()
    .from(issueRecoveryActions)
    .where(and(
      eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.sourceIssueId, issueIds),
    ));
}

function readContainmentComments(db: Db, issueIds: string[]) {
  return db
    .select()
    .from(issueComments)
    .where(inArray(issueComments.issueId, issueIds));
}

function readAdapterWorkspace(input: unknown) {
  const context = (input as { context?: Record<string, unknown> }).context ?? {};
  const workspace = context.paperclipWorkspace as Record<string, unknown> | undefined;
  const cwd = typeof workspace?.cwd === "string" ? workspace.cwd : null;
  const branchName = typeof workspace?.branchName === "string" ? workspace.branchName : null;
  const executionWorkspaceId =
    typeof context.executionWorkspaceId === "string" ? context.executionWorkspaceId : null;
  if (!cwd || !branchName || !executionWorkspaceId) {
    throw new Error("Adapter input is missing execution workspace context");
  }
  return { cwd, branchName, executionWorkspaceId };
}

async function seedBranchContainmentRun(db: Db, repoRoot: string, callSite: BranchContainmentCallSite) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  const sourceIssueId = randomUUID();
  const sameWorkspaceSiblingId = randomUUID();
  const otherWorkspaceSiblingId = randomUUID();
  const sourceExecutionWorkspaceId = randomUUID();
  const otherExecutionWorkspaceId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const sourceIdentifier = `${issuePrefix}-1`;
  const sameSiblingIdentifier = `${issuePrefix}-2`;
  const otherSiblingIdentifier = `${issuePrefix}-3`;
  const expectedBranch = `${sourceIdentifier}-recorded`;
  const actualBranch = `${sourceIdentifier}-actual`;
  const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
  const now = new Date("2026-07-07T00:00:00.000Z");

  await instanceSettingsService(db).updateExperimental({
    enableIsolatedWorkspaces: true,
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Branch containment",
    status: "active",
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "HEAD",
        branchTemplate: "{{issue.identifier}}-recorded",
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: repoRoot,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
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
    createdAt: now,
    updatedAt: now,
  });

  if (callSite === "fresh_realize" || callSite === "persisted_restore") {
    await createForwardBranchMismatch({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
    });
  }

  await db.insert(executionWorkspaces).values([
    {
      id: sourceExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: expectedBranch,
      status: "active",
      cwd: worktreePath,
      repoUrl: null,
      baseRef: "HEAD",
      branchName: expectedBranch,
      providerType: "git_worktree",
      providerRef: worktreePath,
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "other-workspace",
      status: "active",
      cwd: path.join(repoRoot, ".paperclip", "worktrees", "other-workspace"),
      repoUrl: null,
      baseRef: "HEAD",
      branchName: "other-workspace",
      providerType: "git_worktree",
      providerRef: path.join(repoRoot, ".paperclip", "worktrees", "other-workspace"),
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId,
    agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    payload: { issueId: sourceIssueId },
    status: "queued",
    runId,
    requestedAt: now,
    updatedAt: now,
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "queued",
    wakeupRequestId,
    contextSnapshot: {
      issueId: sourceIssueId,
      taskId: sourceIssueId,
      wakeReason: "issue_assigned",
    },
    responsibleUserId: "responsible-user",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(issues).values([
    {
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: `Source ${callSite}`,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: sourceIdentifier,
      executionWorkspaceId: callSite === "fresh_realize" ? sourceExecutionWorkspaceId : callSite === "persisted_restore" ? sourceExecutionWorkspaceId : null,
      executionWorkspacePreference: callSite === "persisted_restore" ? "reuse_existing" : null,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: sameWorkspaceSiblingId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Same-workspace sibling",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: sameSiblingIdentifier,
      executionWorkspaceId: callSite === "finalize" ? null : sourceExecutionWorkspaceId,
      executionWorkspacePreference: callSite === "finalize" ? null : "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherWorkspaceSiblingId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Other-workspace sibling",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 3,
      identifier: otherSiblingIdentifier,
      executionWorkspaceId: otherExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return {
    companyId,
    agentId,
    runId,
    sourceIssueId,
    sameWorkspaceSiblingId,
    otherWorkspaceSiblingId,
    sourceExecutionWorkspaceId,
    otherExecutionWorkspaceId,
    expectedBranch,
    actualBranch,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function expectContainedWorkspaceBranchFailure(input: {
  db: Db;
  heartbeat: Heartbeat;
  runId: string;
  companyId: string;
  sourceIssueId: string;
  sameWorkspaceSiblingId: string;
  otherWorkspaceSiblingId: string;
  sourceExecutionWorkspaceId?: string | null;
  expectedBranch: string;
  actualBranch: string;
}) {
  const finishedRun = await waitForRunToFinish(input.heartbeat, input.runId, 10_000);
  expect(finishedRun).toMatchObject({
    status: "failed",
    errorCode: "workspace_validation_failed",
  });

  const workspaceValidation = asRecord(asRecord(finishedRun?.resultJson).workspaceValidation);
  const provenance = asRecord(workspaceValidation.provenance);
  expect(workspaceValidation).toMatchObject({
    reason: "git_worktree_branch_incoherence",
    sourceIssueId: input.sourceIssueId,
    expectedBranch: input.expectedBranch,
    actualBranch: input.actualBranch,
    cleanliness: "clean",
    safeRepair: expect.objectContaining({
      eligible: false,
      attempted: false,
      succeeded: false,
      reason: "expected branch and current HEAD differ",
    }),
  });
  if (input.sourceExecutionWorkspaceId !== undefined) {
    expect(workspaceValidation.executionWorkspaceId).toBe(input.sourceExecutionWorkspaceId);
  }
  expect(workspaceValidation.fingerprint).toEqual(expect.stringMatching(/^workspace_incoherence:v1:sha256:[a-f0-9]{64}$/));
  expect(provenance).toMatchObject({
    expectedBranchRef: `refs/heads/${input.expectedBranch}`,
    actualBranchRef: `refs/heads/${input.actualBranch}`,
    expectedBranchExists: true,
    actualBranchExists: true,
    sameHead: false,
    ancestryVerdict: "ancestor",
  });
  expect(provenance.expectedHeadSha).toEqual(expect.stringMatching(/^[a-f0-9]{40}$/));
  expect(provenance.actualHeadSha).toEqual(expect.stringMatching(/^[a-f0-9]{40}$/));
  expect(provenance.expectedHeadSha).not.toBe(provenance.actualHeadSha);
  expect(provenance.plainLanguageReason).toEqual(expect.stringContaining("forward of the recorded branch"));

  const { issueRows, actionRows, comments } = await waitForContainmentSideEffects({
    db: input.db,
    companyId: input.companyId,
    sourceIssueId: input.sourceIssueId,
    sameWorkspaceSiblingId: input.sameWorkspaceSiblingId,
    otherWorkspaceSiblingId: input.otherWorkspaceSiblingId,
  });
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  expect(issueById.get(input.sourceIssueId)).toMatchObject({
    status: "blocked",
    executionRunId: null,
    checkoutRunId: null,
  });
  expect(issueById.get(input.sameWorkspaceSiblingId)).toMatchObject({
    status: "in_progress",
    executionRunId: null,
    checkoutRunId: null,
  });
  expect(issueById.get(input.otherWorkspaceSiblingId)).toMatchObject({
    status: "in_progress",
    executionRunId: null,
    checkoutRunId: null,
  });

  expect(actionRows).toHaveLength(1);
  const action = actionRows[0]!;
  expect(action).toMatchObject({
    sourceIssueId: input.sourceIssueId,
    kind: "workspace_validation",
    cause: "workspace_validation_failed",
    status: "active",
    fingerprint: expect.stringContaining(String(workspaceValidation.fingerprint)),
    attemptCount: 1,
    evidence: expect.objectContaining({
      sourceIssueId: input.sourceIssueId,
      latestRunId: input.runId,
      latestRunErrorCode: "workspace_validation_failed",
      recoveryCause: "workspace_validation_failed",
      workspaceValidation: expect.objectContaining({
        fingerprint: workspaceValidation.fingerprint,
        expectedBranch: input.expectedBranch,
        actualBranch: input.actualBranch,
        cleanliness: "clean",
        provenance: expect.objectContaining({
          expectedHeadSha: provenance.expectedHeadSha,
          actualHeadSha: provenance.actualHeadSha,
          ancestryVerdict: "ancestor",
          plainLanguageReason: provenance.plainLanguageReason,
        }),
      }),
    }),
    nextAction: expect.stringContaining("choose a new execution workspace"),
    wakePolicy: expect.objectContaining({
      type: "manual_repair_required",
      reason: "workspace_validation_failed",
    }),
  });

  expect(comments.filter((comment) => comment.issueId === input.sourceIssueId && comment.body.includes(`Recovery action: \`${action.id}\``))).toHaveLength(1);
  expect(comments.filter((comment) => comment.issueId === input.sameWorkspaceSiblingId)).toHaveLength(0);
  expect(comments.filter((comment) => comment.issueId === input.otherWorkspaceSiblingId)).toHaveLength(0);
}

describeEmbeddedPostgres("heartbeat workspace branch containment", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-branch-containment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await waitForHeartbeatIdle(db);
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Branch-containment test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issuePlanDecompositions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
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

  it.each([
    ["workspace-runtime fresh worktree reuse", "fresh_realize" as const, null],
    ["workspace-runtime persisted restore", "persisted_restore" as const, "source-workspace"],
    ["heartbeat finalization", "finalize" as const, "runtime-workspace"],
  ])("contains mid-change branch divergence at %s", async (_name, callSite, expectedWorkspaceId) => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const seeded = await seedBranchContainmentRun(db, repoRoot, callSite);

    if (callSite === "finalize") {
      adapterExecute.mockImplementationOnce(async (adapterInput) => {
        const workspace = readAdapterWorkspace(adapterInput);
        const actualBranch = `${workspace.branchName.replace(/-recorded$/, "")}-actual`;
        await db
          .update(issues)
          .set({
            executionWorkspaceId: workspace.executionWorkspaceId,
            executionWorkspacePreference: "reuse_existing",
            executionWorkspaceSettings: { mode: "isolated_workspace" },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, seeded.sameWorkspaceSiblingId));
        await runGit(workspace.cwd, ["checkout", "-b", actualBranch]);
        await writeFile(path.join(workspace.cwd, "actual-branch.txt"), "actual branch work\n", "utf8");
        await runGit(workspace.cwd, ["add", "actual-branch.txt"]);
        await runGit(workspace.cwd, ["commit", "-m", "Add actual branch work"]);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: "Adapter completed after switching to an unrecorded branch.",
          provider: "test",
          model: "test-model",
        };
      });
    }

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await expectContainedWorkspaceBranchFailure({
      db,
      heartbeat,
      runId: seeded.runId,
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      sameWorkspaceSiblingId: seeded.sameWorkspaceSiblingId,
      otherWorkspaceSiblingId: seeded.otherWorkspaceSiblingId,
      sourceExecutionWorkspaceId:
        expectedWorkspaceId === "source-workspace"
          ? seeded.sourceExecutionWorkspaceId
          : expectedWorkspaceId === "runtime-workspace"
            ? undefined
            : null,
      expectedBranch: seeded.expectedBranch,
      actualBranch: seeded.actualBranch,
    });
    expect(adapterExecute).toHaveBeenCalledTimes(callSite === "finalize" ? 1 : 0);
  }, 30_000);
});
