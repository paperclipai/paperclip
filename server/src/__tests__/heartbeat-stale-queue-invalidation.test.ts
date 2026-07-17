import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  externalOperations,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  await db.transaction(async (tx) => {
    // Heartbeat completion can write an issue-thread comment or activity row
    // shortly after the run leaves queued/running. Keep late writers outside
    // the interval between deleting child rows and their FK parents so cleanup
    // remains deterministic under the slower, highly concurrent CI runner.
    await tx.execute(sql.raw(
      'LOCK TABLE "issue_comments", "activity_log" IN ACCESS EXCLUSIVE MODE',
    ));

    await tx.delete(companySkills);
    await tx.delete(issueComments);
    await tx.delete(issueDocuments);
    await tx.delete(documentRevisions);
    await tx.delete(documents);
    await tx.delete(issueRelations);
    await tx.delete(issueTreeHolds);
    await tx.delete(issues);
    await tx.delete(heartbeatRunEvents);
    await tx.delete(activityLog);
    await tx.delete(heartbeatRuns);
    await tx.delete(agentWakeupRequests);
    await tx.delete(agentRuntimeState);
    await tx.delete(projects);
    await tx.delete(agents);
    await tx.delete(companies);
  });
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatEnabled?: boolean;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [runs, agentRows] = await Promise.all([
        db.select({ status: heartbeatRuns.status }).from(heartbeatRuns),
        db.select({ status: agents.status }).from(agents),
      ]);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      const hasRunningAgent = agentRows.some((agent) => agent.status === "running");
      if (!hasActiveRun && !hasRunningAgent) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningProcesses.clear();
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: opts.heartbeatEnabled ?? false,
          intervalSec: opts.heartbeatEnabled ? 30 : 0,
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    payloadExtras?: Record<string, unknown>;
    invocationSource?: "timer" | "assignment" | "on_demand" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId, ...(input.payloadExtras ?? {}) },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedProjectIssue(input: {
    companyId: string;
    agentId: string;
    projectStatus: "planned" | "in_progress" | "completed" | "cancelled";
  }) {
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId: input.companyId,
      name: `Project ${input.projectStatus}`,
      status: input.projectStatus,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId,
      title: "Project-gated task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
    });
    return { projectId, issueId };
  }

  async function seedProjectlessIssue(input: { companyId: string; agentId: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: null,
      title: "Projectless task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
    });
    return { issueId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it.each([
    ["on_demand", "board_question"],
    ["assignment", "issue_assigned"],
    ["automation", "issue_commented"],
  ] as const)("allows %s wakeups on inactive projects", async (source, reason) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { issueId } = await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "completed",
    });

    const run = await heartbeat.wakeup(agentId, {
      source,
      triggerDetail: source === "on_demand" ? "manual" : "system",
      reason,
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    expect(run).not.toBeNull();
    expect(await waitForCondition(async () => {
      const current = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return current?.status === "succeeded";
    })).toBe(true);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips issue-scoped timer wakeups when the project is inactive", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatEnabled: true });
    const { issueId } = await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "completed",
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    const wakeup = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(run).toBeNull();
    expect(wakeup).toMatchObject({ status: "skipped", reason: "project.timer_not_in_progress" });
    const createdRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(createdRuns).toHaveLength(0);
  });

  it("skips timer wakeups when all assigned project work is inactive", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatEnabled: true });
    await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "cancelled",
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    const wakeup = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(run).toBeNull();
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "project.timer_no_in_progress_assignments",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("allows timer wakeups when assigned work has no project", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatEnabled: true });
    await seedProjectlessIssue({ companyId, agentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(run).not.toBeNull();
    expect(await waitForCondition(async () => {
      const current = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return current?.status === "succeeded";
    })).toBe(true);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("cancels queued timer runs when the project leaves in_progress before claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { projectId, issueId } = await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "in_progress",
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "heartbeat_timer",
      invocationSource: "timer",
    });

    await db.update(projects).set({ status: "cancelled" }).where(eq(projects.id, projectId));
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run).toMatchObject({ status: "cancelled", errorCode: "project_timer_not_in_progress" });
    expect(wakeup?.status).toBe("cancelled");
    expect(wakeup?.error).toContain("scheduled heartbeat");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("allows queued automation runs after the project leaves in_progress", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { projectId, issueId } = await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "in_progress",
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
    });

    await db.update(projects).set({ status: "completed" }).where(eq(projects.id, projectId));
    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    })).toBe(true);
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("immediately cancels only queued timer work when an inactive status is applied", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { projectId, issueId } = await seedProjectIssue({
      companyId,
      agentId,
      projectStatus: "in_progress",
    });
    const { runId: timerRunId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "heartbeat_timer",
      invocationSource: "timer",
    });
    const { runId: questionRunId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
    });
    await db.update(projects).set({ status: "completed" }).where(eq(projects.id, projectId));

    const result = await heartbeat.cancelInactiveProjectTimerWork(companyId, projectId, "completed");
    expect(await waitForCondition(async () => {
      const questionRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, questionRunId))
        .then((rows) => rows[0] ?? null);
      return questionRun?.status === "succeeded";
    })).toBe(true);

    const [timerRun, questionRun] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, timerRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, questionRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(result).toMatchObject({ cancelledRuns: 1, projectStatus: "completed" });
    expect(timerRun).toMatchObject({ status: "cancelled", errorCode: "project_timer_not_in_progress" });
    expect(questionRun?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(timerRunId)).toBe(0);
    expect(countExecuteCallsForRun(questionRunId)).toBe(1);
  });

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels stale automated queue work while a bounded external operation owns progress", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { issueId } = await seedProjectlessIssue({ companyId, agentId });
    const now = new Date();
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "finish_successful_run_handoff",
      invocationSource: "automation",
    });
    const operationId = randomUUID();
    await db.insert(externalOperations).values({
      id: operationId,
      companyId,
      issueId,
      kind: "custom",
      provider: "external-test",
      stage: "deployment",
      externalId: `deployment-${operationId}`,
      state: "running",
      nextCheckAt: new Date(now.getTime() + 5 * 60_000),
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
      metadata: { paperclipController: { attemptCount: 0, maxAttempts: 3 } },
    });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);
    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_external_operation_waiting",
      error: expect.stringContaining(operationId),
    });
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);

    const explicit = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "board_question",
      invocationSource: "on_demand",
    });
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => {
      const current = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, explicit.runId))
        .then((rows) => rows[0] ?? null);
      return current?.status === "succeeded";
    })).toBe(true);
    expect(countExecuteCallsForRun(explicit.runId)).toBe(1);
  });

  it("runs an exactly authorized source-scoped recovery delivery without changing source ownership", async () => {
    const { companyId, agentId: recoveryOwnerId } = await seedCompanyAndAgent({
      agentName: "RecoveryOwner",
    });
    const terminatedOwnerId = randomUUID();
    await db.insert(agents).values({
      id: terminatedOwnerId,
      companyId,
      name: "TerminatedSourceOwner",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover terminated owner work",
      status: "todo",
      priority: "high",
      assigneeAgentId: terminatedOwnerId,
    });
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerId,
      previousOwnerAgentId: terminatedOwnerId,
      cause: "terminated_owner",
      fingerprint: `terminated_owner:${issueId}`,
      nextAction: "Accept or disposition the terminated-owner handoff.",
      wakePolicy: { type: "wake_owner", reason: "source_scoped_recovery_action" },
      attemptCount: 1,
    });
    const recoveryContext = {
      taskId: issueId,
      sourceIssueId: issueId,
      recoveryActionId: actionId,
      recoveryAttempt: 1,
      recoveryCause: "terminated_owner",
      source: "issue_recovery_action",
      skipIssueComment: true,
    };
    const { runId } = await seedQueuedRun({
      companyId,
      agentId: recoveryOwnerId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
      invocationSource: "automation",
      contextExtras: recoveryContext,
      payloadExtras: {
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
    });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    })).toBe(true);
    expect(countExecuteCallsForRun(runId)).toBe(1);
    await expect(db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ assigneeAgentId: terminatedOwnerId }]);
    await expect(db.select({ status: issueRecoveryActions.status }).from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))
      .resolves.toEqual([{ status: "active" }]);
  });

  it("revalidates the exact recovery generation in the same transaction as the run claim", async () => {
    const { companyId, agentId: recoveryOwnerId } = await seedCompanyAndAgent({
      agentName: "AtomicRecoveryOwner",
    });
    const terminatedOwnerId = randomUUID();
    await db.insert(agents).values({
      id: terminatedOwnerId,
      companyId,
      name: "AtomicTerminatedOwner",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const actionId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Atomic recovery source",
      status: "todo",
      priority: "high",
      assigneeAgentId: terminatedOwnerId,
    });
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerId,
      previousOwnerAgentId: terminatedOwnerId,
      cause: "terminated_owner",
      fingerprint: `atomic-recovery:${issueId}`,
      nextAction: "Accept the current generation only.",
      attemptCount: 1,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId: recoveryOwnerId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
      invocationSource: "automation",
      contextExtras: {
        taskId: issueId,
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
      },
      payloadExtras: {
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
    });
    const racingHeartbeat = heartbeatService(db, {
      afterSourceScopedRecoveryAuthorizationBeforeClaim: async () => {
        await db
          .update(issueRecoveryActions)
          .set({ attemptCount: 2, updatedAt: new Date() })
          .where(eq(issueRecoveryActions.id, actionId));
      },
    });

    await racingHeartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "source_scoped_recovery_action_invalid",
        }),
      ]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("rejects a recovery generation that expires while its claim is waiting", async () => {
    const { companyId, agentId: recoveryOwnerId } = await seedCompanyAndAgent({
      agentName: "ExpiringRecoveryOwner",
    });
    const terminatedOwnerId = randomUUID();
    await db.insert(agents).values({
      id: terminatedOwnerId,
      companyId,
      name: "ExpiredTerminatedOwner",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const actionId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recovery expires during claim",
      status: "todo",
      priority: "high",
      assigneeAgentId: terminatedOwnerId,
    });
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerId,
      previousOwnerAgentId: terminatedOwnerId,
      cause: "terminated_owner",
      fingerprint: `expiring-recovery:${issueId}`,
      nextAction: "Do not start after this generation expires.",
      attemptCount: 1,
      timeoutAt: null,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId: recoveryOwnerId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
      invocationSource: "automation",
      contextExtras: {
        taskId: issueId,
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
      },
      payloadExtras: {
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
    });
    const racingHeartbeat = heartbeatService(db, {
      afterSourceScopedRecoveryAuthorizationBeforeClaim: async () => {
        await db
          .update(issueRecoveryActions)
          .set({ timeoutAt: new Date(Date.now() + 50), updatedAt: new Date() })
          .where(eq(issueRecoveryActions.id, actionId));
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });

    await racingHeartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "source_scoped_recovery_action_invalid",
        }),
      ]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    { label: "unrelated agent", wrongAgent: true, corruptPayload: false, corruptAttempt: false },
    { label: "unrelated wake payload", wrongAgent: false, corruptPayload: true, corruptAttempt: false },
    { label: "stale recovery attempt", wrongAgent: false, corruptPayload: false, corruptAttempt: true },
  ])("rejects a source-scoped recovery delivery from an $label", async ({ wrongAgent, corruptPayload, corruptAttempt }) => {
    const { companyId, agentId: recoveryOwnerId } = await seedCompanyAndAgent({
      agentName: "AuthorizedRecoveryOwner",
    });
    const unrelatedAgentId = randomUUID();
    const terminatedOwnerId = randomUUID();
    await db.insert(agents).values([
      {
        id: unrelatedAgentId,
        companyId,
        name: "UnrelatedRecoveryAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: terminatedOwnerId,
        companyId,
        name: "TerminatedSourceOwner",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Protected recovery source",
      status: "todo",
      priority: "high",
      assigneeAgentId: terminatedOwnerId,
    });
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerId,
      previousOwnerAgentId: terminatedOwnerId,
      cause: "terminated_owner",
      fingerprint: `terminated_owner:${issueId}`,
      nextAction: "Accept or disposition the terminated-owner handoff.",
      attemptCount: 1,
    });
    const runAgentId = wrongAgent ? unrelatedAgentId : recoveryOwnerId;
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId: runAgentId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
      invocationSource: "automation",
      contextExtras: {
        taskId: issueId,
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryAttempt: corruptAttempt ? 2 : 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
      },
      payloadExtras: {
        sourceIssueId: issueId,
        recoveryActionId: corruptPayload ? randomUUID() : actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
    });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);
    const [run, wakeup] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "source_scoped_recovery_action_invalid",
    });
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    {
      label: "due monitor",
      wakeReason: "issue_monitor_due",
      contextExtras: {
        source: "issue.monitor",
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        monitorAttemptCount: 1,
      },
    },
    {
      label: "bounded monitor recovery",
      wakeReason: "issue_monitor_recovery",
      contextExtras: {
        source: "issue.monitor.recovery",
        monitorAttemptCount: 2,
        clearReason: "max_attempts_exhausted",
        maxAttempts: 1,
      },
    },
  ])("cancels a queued $label after issue reassignment", async ({ wakeReason, contextExtras }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalMonitor" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementMonitor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned monitored task",
      status: "blocked",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason,
      contextExtras,
      invocationSource: "automation",
    });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels a queued monitor wake when a replacement monitor generation was scheduled", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "MonitorOwner" });
    const issueId = randomUUID();
    const replacementNextCheckAt = new Date("2026-04-11T14:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Monitor generation changed",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      monitorNextCheckAt: replacementNextCheckAt,
      monitorAttemptCount: 1,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: replacementNextCheckAt.toISOString(),
          lastTriggeredAt: "2026-04-11T12:00:00.000Z",
          attemptCount: 1,
          notes: null,
          scheduledBy: "board",
          kind: null,
          serviceName: null,
          externalRef: null,
          timeoutAt: null,
          maxAttempts: 2,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_monitor_due",
      invocationSource: "automation",
      contextExtras: {
        source: "issue.monitor",
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        monitorAttemptCount: 1,
        monitorClaimToken: "2026-04-11T12:31:00.000Z",
        monitorExpectedNextCheckAt: "2026-04-11T12:30:00.000Z",
        monitorExpectedTriggeredAt: "2026-04-11T12:31:00.000Z",
        monitorExpectedAttemptCount: 1,
        monitorExpectedAssigneeAgentId: agentId,
        monitorExpectedIssueStatus: "blocked",
      },
    });

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_monitor_generation_changed",
    });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("monitor delivery generation changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels a queued run at claim when an active ancestor cancel hold covers a non-terminal issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Cancelled tree root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Historically revived child",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    const [hold] = await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "cancel",
      status: "active",
      reason: "active cancellation must win claim",
      releasePolicy: { strategy: "manual" },
      createdByActorType: "system",
    }).returning();
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId: childIssueId,
      wakeReason: "issue_tree_restored",
    });

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    })).toBe(true);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_tree_cancelled",
      error: expect.stringContaining("active subtree cancel hold"),
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("active subtree cancel hold"),
    });
    expect(countExecuteCallsForRun(runId)).toBe(0);
    expect(hold.status).toBe("active");
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("still runs comment-driven wakes on in_review issues even when the agent is no longer the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("does not let advisory continuation prose cancel queued executor work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(wakeup?.status).toBe("completed");
    expect(wakeup?.error).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
