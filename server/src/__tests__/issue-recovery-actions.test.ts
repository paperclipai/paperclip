import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { routineRoutes } from "../routes/routines.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    routeOptions: Record<string, unknown> = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use("/api", issueRoutes(db, {} as any, routeOptions as any));
    app.use(errorHandler);
    return app;
  }

  function createAgentInboxApp(actor: any) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedRecoveryRun(input: {
    companyId: string;
    agentId: string;
    sourceIssueId: string;
    actionId: string;
    contextOverrides?: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        issueId: input.sourceIssueId,
        sourceIssueId: input.sourceIssueId,
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: input.actionId,
        recoveryAttempt: 1,
        ...input.contextOverrides,
      },
    });
    return runId;
  }

  async function waitForAssignmentWakeup(agentId: string, issueId: string) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows.find((row) => row.payload?.issueId === issueId && row.runId) ?? null);
      if (wakeup) {
        // The wakeup row receives runId immediately before the bounded queue
        // driver finishes. Yield once so the fire-and-forget route handoff is
        // settled before the test database is torn down.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return wakeup;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for recovery acceptance assignment wakeup");
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("does not declassify active typed routine authority through a generic upsert", async () => {
    const { companyId, managerId, coderId, sourceIssueId, sourceIssue } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const typed = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_routine_owner",
      fingerprint: `terminated_routine_owner:${companyId}:${coderId}`,
      evidence: { typedInventory: true },
      nextAction: "Disposition every typed routine and trigger.",
      wakePolicy: { type: "wake_owner", reason: "source_scoped_recovery_action" },
      maxAttempts: 1,
      timeoutAt: new Date(Date.now() + 60_000),
    });

    const generic = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded_assigned_issue:${companyId}:${sourceIssueId}`,
      evidence: { latestRunId: randomUUID() },
      nextAction: "Restore a generic execution path.",
      maxAttempts: null,
    });

    expect(generic).toEqual(typed);
    await expect(svc.getActiveForIssue(companyId, sourceIssueId)).resolves.toMatchObject({
      id: typed.id,
      cause: "terminated_routine_owner",
      fingerprint: `terminated_routine_owner:${companyId}:${coderId}`,
      evidence: { typedInventory: true },
      attemptCount: 1,
      maxAttempts: 1,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const fallbackResult = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "generic retry failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "failed",
      },
      comment: "Generic recovery must not replace typed authority.",
    });
    expect(fallbackResult).toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssueId)))
      .resolves.toEqual([expect.objectContaining({ status: "in_progress" })]);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssueId)))
      .resolves.toHaveLength(0);
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(4);

    const recoveryOwnerWakeups = enqueueWakeup.mock.calls.filter(
      (call) => call[1]?.reason === "source_scoped_recovery_action",
    );
    expect(recoveryOwnerWakeups).toHaveLength(2);
    expect(recoveryOwnerWakeups.map((call) => call[0])).toEqual([managerId, managerId]);
    expect(recoveryOwnerWakeups[0]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      recoveryCause: "stranded_assigned_issue",
    });

    const returnOwnerWakeups = enqueueWakeup.mock.calls.filter(
      (call) => call[1]?.contextSnapshot?.managerEscalationRoute === "return_owner",
    );
    expect(returnOwnerWakeups).toHaveLength(2);
    expect(returnOwnerWakeups.map((call) => call[0])).toEqual([coderId, coderId]);
    expect(returnOwnerWakeups[0]?.[1]).toMatchObject({
      reason: "issue_commented",
      payload: {
        issueId: sourceIssue.id,
        sourceIssueId: sourceIssue.id,
        managerEscalation: true,
      },
    });
    expect(new Set(enqueueWakeup.mock.calls.map((call) => call[1]?.idempotencyKey)).size).toBe(4);
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).toHaveBeenCalledTimes(4);

    const recoveryOwnerWakeups = enqueueWakeup.mock.calls.filter(
      (call) => call[1]?.reason === "source_scoped_recovery_action",
    );
    expect(recoveryOwnerWakeups).toHaveLength(2);
    expect(recoveryOwnerWakeups.map((call) => call[0])).toEqual([managerId, managerId]);
    expect(recoveryOwnerWakeups[1]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
    });

    const returnOwnerWakeups = enqueueWakeup.mock.calls.filter(
      (call) => call[1]?.contextSnapshot?.managerEscalationRoute === "return_owner",
    );
    expect(returnOwnerWakeups).toHaveLength(2);
    expect(returnOwnerWakeups.map((call) => call[0])).toEqual([coderId, coderId]);
    expect(returnOwnerWakeups[1]?.[1]?.contextSnapshot).toMatchObject({
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
      managerEscalationRoute: "return_owner",
    });
    expect(new Set(enqueueWakeup.mock.calls.map((call) => call[1]?.idempotencyKey)).size).toBe(4);
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Recovery action:");
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("includes a terminated owner's source issue in the recovery owner's agent inbox without changing source ownership", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner:${sourceIssueId}`,
      nextAction: "Accept or disposition the terminated owner's source issue.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createAgentInboxApp({
      type: "agent",
      agentId: managerId,
      companyId,
      source: "agent_jwt",
    });

    const inbox = await request(app).get("/api/agents/me/inbox-lite").expect(200);

    expect(inbox.body).toEqual([
      expect.objectContaining({
        id: sourceIssueId,
        activeRecoveryAction: expect.objectContaining({
          id: action.id,
          ownerAgentId: managerId,
          previousOwnerAgentId: coderId,
          cause: "terminated_owner",
        }),
      }),
    ]);
    const [sourceIssue] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.assigneeAgentId).toBe(coderId);
  });

  it("lets only the action owner in the matching recovery run accept a terminated-owner handoff", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const peerId = randomUUID();
    await db.insert(agents).values({
      id: peerId,
      companyId,
      name: "Peer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-accept:${sourceIssueId}`,
      nextAction: "Explicitly accept the terminated-owner handoff.",
      wakePolicy: { type: "wake_owner" },
    });
    const validRunId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });
    const mismatchedRunId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
      contextOverrides: { recoveryActionId: randomUUID() },
    });
    const peerRunId = await seedRecoveryRun({
      companyId,
      agentId: peerId,
      sourceIssueId,
      actionId: action.id,
    });

    const deniedActors = [
      { type: "agent", agentId: managerId, companyId, source: "agent_jwt" },
      { type: "agent", agentId: managerId, companyId, runId: mismatchedRunId, source: "agent_jwt" },
      { type: "agent", agentId: peerId, companyId, runId: peerRunId, source: "agent_jwt" },
    ];
    for (const actor of deniedActors) {
      await request(createApp(actor))
        .post(`/api/issues/${sourceIssueId}/recovery-actions/accept`)
        .send({ actionId: action.id })
        .expect(403);
    }

    const accepted = await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId: validRunId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/accept`)
      .send({ actionId: action.id })
      .expect(200);

    expect(accepted.body.issue).toMatchObject({
      id: sourceIssueId,
      assigneeAgentId: managerId,
      activeRecoveryAction: null,
    });
    expect(accepted.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
    });
    const [persistedAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(persistedAction).toMatchObject({ status: "resolved", outcome: "restored" });
    await waitForAssignmentWakeup(managerId, sourceIssueId);
  });

  it("does not let generic acceptance bypass a terminated-routine recovery contract", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_routine_owner",
      fingerprint: `terminated-routine-owner-accept-bypass:${sourceIssueId}`,
      nextAction: "Disposition every typed routine and trigger before resolving.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
      contextOverrides: { recoveryCause: "terminated_routine_owner" },
    });

    const response = await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/accept`)
      .send({ actionId: action.id });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("typed routine and trigger inventory");
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssueId)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: coderId })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .resolves.toEqual([expect.objectContaining({ status: "active", outcome: null })]);
  });

  it("rejects a timed-out recovery owner even before the watchdog finishes escalation", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-expired:${sourceIssueId}`,
      nextAction: "Accept the handoff before its deadline.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 1,
      timeoutAt: new Date(Date.now() - 1_000),
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });

    await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/accept`)
      .send({ actionId: action.id })
      .expect(403);

    await expect(db.select().from(issues).where(eq(issues.id, sourceIssueId)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: coderId })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .resolves.toEqual([expect.objectContaining({ status: "active", ownerAgentId: managerId })]);
  });

  it("rejects an accept request when the action generation changes after authorization", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-generation-race:${sourceIssueId}`,
      nextAction: "Accept the current generation only.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });

    const response = await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    }, {
      afterRecoveryAuthorizationBeforeMutation: async () => {
        await db
          .update(issueRecoveryActions)
          .set({ attemptCount: action.attemptCount + 1, updatedAt: new Date() })
          .where(eq(issueRecoveryActions.id, action.id));
      },
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/accept`)
      .send({ actionId: action.id });

    expect(response.status).toBe(409);
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssueId)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: coderId })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .resolves.toEqual([expect.objectContaining({ status: "active", attemptCount: 2 })]);
  });

  it("lets the matching recovery action owner resolve without general source issue ownership", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-resolve:${sourceIssueId}`,
      nextAction: "Record the final source disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "The recovery owner verified the source outcome.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
    });
  });

  it("orders recovery resolution locks before concurrent source-owner termination", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-lock-order:${sourceIssueId}`,
      nextAction: "Record the final source disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });
    let markLocksHeld!: () => void;
    const locksHeld = new Promise<void>((resolve) => {
      markLocksHeld = resolve;
    });
    let releaseResolve!: () => void;
    const resolveRelease = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const app = createApp(
      {
        type: "agent",
        agentId: managerId,
        companyId,
        runId,
        source: "agent_jwt",
      },
      {
        afterRecoveryResolveLocksBeforeMutation: async () => {
          markLocksHeld();
          await resolveRelease;
        },
      },
    );
    const resolveRequest = request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified completion.",
      })
      .then((response) => response);
    await locksHeld;

    let terminationSettled = false;
    const termination = agentService(db).terminate(coderId).finally(() => {
      terminationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminationSettled).toBe(false);
    releaseResolve();

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("resolve/termination lock order deadlocked")), 5_000);
    });
    const [resolveResponse, terminated] = await Promise.race([
      Promise.all([resolveRequest, termination]),
      timeout,
    ]);
    expect(resolveResponse.status, JSON.stringify(resolveResponse.body)).toBe(200);
    expect(terminated).toMatchObject({ id: coderId, status: "terminated" });
  });

  it("rejects a terminated-routine recovery resolution before every typed routine and trigger is dispositioned", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    const recoveryIssueId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Paused terminated-owner routine",
      status: "paused",
      assigneeAgentId: coderId,
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: false,
      cronExpression: "0 * * * *",
      timezone: "UTC",
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover terminated routines",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "harness_liveness_escalation",
      originId: `agent_termination_routine_handoff:${coderId}`,
      originFingerprint: `agent_termination_routine_handoff:${coderId}:test`,
      executionContract: {
        schemaVersion: 1,
        contractType: "routine_termination_handoff",
        taskType: "recovery_coordination",
        routineRecovery: {
          terminatedAgentId: coderId,
          terminatedAgentRole: "engineer",
          terminatedAgentCapabilities: null,
          routines: [{ id: routineId }],
          triggers: [{ id: triggerId }],
        },
      },
    });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_routine_owner",
      fingerprint: `terminated-routine-owner:${coderId}`,
      nextAction: "Disposition every routine and trigger.",
      wakePolicy: { type: "wake_owner" },
    });
    const replacementOwnerId = randomUUID();
    await db.insert(agents).values({
      id: replacementOwnerId,
      companyId,
      name: "Exact Routine Replacement",
      role: "engineer",
      capabilities: null,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const explicitDispositionAt = new Date(action.createdAt.getTime() + 1_000);
    await db
      .update(routines)
      .set({ assigneeAgentId: replacementOwnerId, updatedAt: explicitDispositionAt })
      .where(eq(routines.id, routineId));
    // Reproduce the old false-positive: containment advanced updatedAt but did
    // not record an agent/user disposition. Resolution must still reject it.
    await db
      .update(routineTriggers)
      .set({
        enabled: false,
        updatedByAgentId: null,
        updatedByUserId: null,
        updatedAt: explicitDispositionAt,
      })
      .where(eq(routineTriggers.id, triggerId));
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId: recoveryIssueId,
      actionId: action.id,
      contextOverrides: {
        recoveryCause: "terminated_routine_owner",
        routineRecoveryIssueId: recoveryIssueId,
        terminatedAgentId: coderId,
        routineIds: [routineId],
      },
    });

    const rejected = await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${recoveryIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Everything is handled.",
      })
      .expect(422);

    expect(rejected.body.error).toContain("needs an explicit restore-or-disable disposition");
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .resolves.toEqual([expect.objectContaining({ status: "active", outcome: null })]);

    const recoveryApp = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await request(recoveryApp)
      .patch(`/api/routine-triggers/${triggerId}`)
      .send({ label: "Reviewed label only" })
      .expect(200);
    const labelOnlyStillRejected = await request(recoveryApp)
      .post(`/api/issues/${recoveryIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Label review is not an enablement disposition.",
      })
      .expect(422);
    expect(labelOnlyStillRejected.body.error).toContain("needs an explicit restore-or-disable disposition");

    await request(recoveryApp)
      .patch(`/api/routine-triggers/${triggerId}`)
      .send({ enabled: false })
      .expect(200);
    await request(recoveryApp)
      .post(`/api/issues/${recoveryIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Replacement owner and disabled trigger explicitly verified.",
      })
      .expect(200);
  });

  it("rejects in_review recovery when the terminated source has no live reviewer", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const pausedReviewerId = randomUUID();
    await db.insert(agents).values({
      id: pausedReviewerId,
      companyId,
      name: "Paused Reviewer",
      role: "qa",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    await db.update(issues).set({
      status: "in_review",
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedReviewerId },
        returnAssignee: { type: "agent", agentId: coderId },
        reviewRequest: { instructions: "Review the recovered work." },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-review:${sourceIssueId}`,
      nextAction: "Restore a live review path.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });

    const rejected = await request(createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        resolutionNote: "Review is pending.",
      })
      .expect(422);

    expect(rejected.body.error).toContain("live reviewer");
  });

  it("locks and accepts an existing live reviewer while resolving terminated-owner recovery", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Live Recovery Reviewer",
      role: "qa",
      status: "idle",
      reportsTo: managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, coderId));
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
    }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "terminated_owner",
      fingerprint: `terminated-owner-live-reviewer:${sourceIssueId}`,
      nextAction: "Preserve the live review path.",
      wakePolicy: { type: "wake_owner" },
    });
    const runId = await seedRecoveryRun({
      companyId,
      agentId: managerId,
      sourceIssueId,
      actionId: action.id,
    });
    let markLocksHeld!: () => void;
    const locksHeld = new Promise<void>((resolve) => {
      markLocksHeld = resolve;
    });
    let releaseResolve!: () => void;
    const resolveRelease = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const app = createApp(
      {
        type: "agent",
        agentId: managerId,
        companyId,
        runId,
        source: "agent_jwt",
      },
      {
        afterRecoveryResolveLocksBeforeMutation: async () => {
          markLocksHeld();
          await resolveRelease;
        },
      },
    );
    const resolveRequest = request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        resolutionNote: "The existing reviewer is live and owns the next decision.",
      })
      .then((response) => response);
    await locksHeld;

    let terminationSettled = false;
    const termination = agentService(db).terminate(reviewerId).finally(() => {
      terminationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminationSettled).toBe(false);
    releaseResolve();

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("reviewer lifecycle lock deadlocked")), 5_000);
    });
    const [resolveResponse, terminatedReviewer] = await Promise.race([
      Promise.all([resolveRequest, termination]),
      timeout,
    ]);
    expect(resolveResponse.status, JSON.stringify(resolveResponse.body)).toBe(200);
    expect(resolveResponse.body.issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerId,
    });
    expect(terminatedReviewer).toMatchObject({ id: reviewerId, status: "terminated" });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .resolves.toEqual([expect.objectContaining({ status: "resolved", outcome: "restored" })]);
    const replacementAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId))
      .then((rows) => rows.find((row) => row.status === "active" || row.status === "escalated"));
    expect(replacementAction).toMatchObject({
      previousOwnerAgentId: reviewerId,
      cause: "terminated_owner",
    });
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(403);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });
});
