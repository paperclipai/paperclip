import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  agentRuntimeState,
  authUsers,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases,
  environments,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueApprovals,
  issueThreadInteractions,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";

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
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(nativeRunFinalizations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
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

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
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

  it("enforces maxAttempts once and removes every automatic recovery path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const base = {
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      returnOwnerAgentId: managerId,
      cause: "process_lost",
      fingerprint: "run-process-lost",
      nextAction: "Resume the same run.",
      wakePolicy: { kind: "resume_native_run", runId: "run-1" },
      monitorPolicy: { kind: "watch_run", runId: "run-1" },
      maxAttempts: 3,
    };

    const first = await svc.upsertSourceScoped(base);
    const second = await svc.upsertSourceScoped(base);
    const exhausted = await svc.upsertSourceScoped(base);
    const replay = await svc.upsertSourceScoped(base);

    expect(first.attemptCount).toBe(1);
    expect(second.attemptCount).toBe(2);
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: managerId,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: "escalated",
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
        },
      },
    });
    expect(replay).toEqual(exhausted);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
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

    await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
      evidence: expect.objectContaining({
        routingPolicy: "board_escalation_no_takeover_v1",
      }),
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
    expect(updatedIssue?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count or post a second notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("origin/fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // The operator gets one notice, bound to the one action.
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(1);
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it.each([
    ["process_lost", undefined],
    ["adapter_failed", "successful_run_missing_state"],
    ["codex_output_inactivity_monitor", undefined],
    ["workspace_validation_failed", "workspace_validation_failed"],
    ["adapter_failed", undefined],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause) => {
      const { coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: coderId,
        returnOwnerAgentId: coderId,
        evidence: expect.objectContaining({
          routingPolicy: "board_escalation_no_takeover_v1",
        }),
        wakePolicy: expect.objectContaining({
          type: "board_escalation",
          preservesSourceAssignee: true,
        }),
      });
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
    })]);
  });

  it("schedules a provider-quota retry for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const concurrentResults = await Promise.all([
      recovery.reconcileStrandedAssignedIssues(),
      recovery.reconcileStrandedAssignedIssues(),
    ]);

    expect(concurrentResults.reduce((sum, result) => sum + result.providerQuotaMonitored, 0)).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
      monitorScheduledBy: null,
      monitorNotes: null,
    });
    expect(updatedIssue?.executionPolicy).toBeNull();
    const [scheduledRetry] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(scheduledRetry).toMatchObject({
      agentId: coderId,
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
      contextSnapshot: {
        issueId: sourceIssueId,
        taskId: sourceIssueId,
        wakeReason: "provider_quota_recovery",
      },
    });
    expect(scheduledRetry?.scheduledRetryAt).toBeInstanceOf(Date);
    const [wakeup] = await db.select().from(agentWakeupRequests);
    expect(wakeup).toMatchObject({
      agentId: coderId,
      reason: "provider_quota_recovery",
      status: "queued",
      runId: scheduledRetry?.id,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it.each([
    ["unclassified", null, 0],
    ["provider work started", { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } }, 0],
    ["exhausted bootstrap", { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, 2],
  ] as const)("requires reconciliation for %s quota failures without altering the business monitor", async (_label, resultJson, attempt) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const monitorAt = new Date("2099-08-25T13:00:00.000Z");
    const executionPolicy = { mode: "normal", stages: [], commentRequired: true, monitor: {
      kind: "external_service", nextCheckAt: monitorAt.toISOString(), notes: "Verify filing gate",
      scheduledBy: "assignee", maxAttempts: 3, recoveryPolicy: "wake_owner",
    } };
    await db.update(issues).set({ executionPolicy, monitorNextCheckAt: monitorAt,
      monitorAttemptCount: 1, monitorNotes: "Verify filing gate", monitorScheduledBy: "assignee",
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: coderId,
      invocationSource: "manual", status: "failed", resultJson, scheduledRetryAttempt: attempt,
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed",
      contextSnapshot: { issueId: sourceIssueId }, finishedAt: new Date(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const scheduleRecoveryRetry = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry });

    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ escalated: 1, providerQuotaMonitored: 0 });
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      ownerType: "board", returnOwnerAgentId: coderId, cause: "legacy_execution_requires_reconciliation",
      evidence: expect.objectContaining({ runId, attempt: attempt + 1 }),
    })]);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [task] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(task).toMatchObject({ assigneeAgentId: coderId, executionPolicy, monitorNextCheckAt: monitorAt,
      monitorAttemptCount: 1, monitorNotes: "Verify filing gate", monitorScheduledBy: "assignee" });
    const recordedActions = await db.select().from(issueRecoveryActions);
    // Upstream now also reconciles active recovery actions: both the task and
    // its board-owned action are skipped, with neither authority rewritten.
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ skipped: 2, escalated: 0, providerQuotaMonitored: 0 });
    expect(await db.select().from(issueRecoveryActions)).toEqual(recordedActions);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
  });

  it("carries the incident retry budget through quota retries and reconciles exhaustion", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const failure = { status: "failed", error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: new Date() };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: coderId,
      invocationSource: "manual", ...failure, contextSnapshot: { issueId: sourceIssueId } });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    for (const attempt of [1, 2]) {
      expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ providerQuotaMonitored: 1 });
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
      expect(retry).toMatchObject({ scheduledRetryAttempt: attempt, scheduledRetryReason: "provider_quota_recovery" });
      // Simulate the scheduled provider attempt failing before provider work starts.
      await db.update(heartbeatRuns).set(failure).where(eq(heartbeatRuns.id, retry!.id));
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.runId, retry!.id));
    }
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ escalated: 1, providerQuotaMonitored: 0 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"))).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      ownerType: "board", cause: "legacy_execution_requires_reconciliation", evidence: expect.objectContaining({ attempt: 3 }),
    })]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("caps conversation quota retries across service restarts without a permanent reconciliation hold", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const resultJson = { conversationContinuation: "continue_conversation_v1", errorFamily: "provider_quota" };
    const failure = { status: "failed", errorCode: "provider_quota", resultJson, finishedAt: new Date() };
    await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, ...failure,
      contextSnapshot: { issueId: sourceIssueId } });
    const enqueueWakeup = vi.fn(async () => null);
    for (const attempt of [1, 2]) {
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
      expect(retry).toMatchObject({ scheduledRetryAttempt: attempt, resultJson: { conversationContinuation: "continue_conversation_v1" } });
      await db.update(heartbeatRuns).set(failure).where(eq(heartbeatRuns.id, retry!.id));
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.runId, retry!.id));
    }
    for (let restart = 0; restart < 2; restart++) {
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"))).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    }
    expect(enqueueWakeup).not.toHaveBeenCalled();
    // Explicit new conversation has its own incident; exhausted history is not a hold.
    await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, ...failure,
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_commented" } });
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const [fresh] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    expect(fresh).toMatchObject({ scheduledRetryAttempt: 1, resultJson: { conversationContinuation: "continue_conversation_v1" } });
  });

  it.each(["clear", "interaction", "exhausted"] as const)("reconciles a historical conversation quota wait with %s admission", async (admission) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const [failure] = await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, status: "failed",
      errorCode: "provider_quota", resultJson: { conversationContinuation: "continue_conversation_v1", errorFamily: "provider_quota" },
      contextSnapshot: { issueId: sourceIssueId }, finishedAt: new Date() }).returning();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    await recovery.reconcileStrandedAssignedIssues();
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, retry!.id));
    if (admission === "interaction") await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
      kind: "ask_user_questions", payload: { version: 1, questions: [{ id: "proceed", question: "Proceed?", type: "text" }] } as any });
    if (admission === "exhausted") await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, failure!.id));
    const issueBefore = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) }).reconcileStrandedAssignedIssues();
    const [updated] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
    expect(updated).toMatchObject({ status: admission === "clear" ? "scheduled_retry" : "cancelled",
      retryOfRunId: failure!.id, scheduledRetryAt: retry!.scheduledRetryAt,
      resultJson: { conversationContinuation: "continue_conversation_v1" } });
    if (admission !== "clear") {
      expect(await createRunDispatch(db).promoteScheduledRetry({ companyId, runId: retry!.id, now: new Date("2099-01-01") }))
        .toMatchObject({ outcome: "not_promoted" });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry!.id)))
        .toEqual([expect.objectContaining({ status: "cancelled" })]);
    }
    const runsBefore = await db.select().from(heartbeatRuns);
    const eventsBefore = await db.select().from(heartbeatRunEvents);
    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) }).reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns)).toEqual(runsBefore);
    expect(await db.select().from(heartbeatRunEvents)).toEqual(eventsBefore);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(issueBefore);
  });

  it.each((["interaction", "approval", "dependency", "disabled", "reassigned"] as const).flatMap(
    (gate) => [false, true].map((historical) => ({ gate, historical })),
  ))(
    "gates conversation quota retries on $gate at scheduling and promotion (historical: $historical)", async ({ gate, historical }) => {
      const { companyId, coderId, managerId, sourceIssueId, sourceIssue } = await seedCompany();
      const failedId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: failedId, companyId, agentId: coderId, status: "failed",
        errorCode: "provider_quota", resultJson: { conversationContinuation: "continue_conversation_v1", errorFamily: "provider_quota" },
        contextSnapshot: { issueId: sourceIssueId }, finishedAt: new Date() });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
      await recovery.reconcileStrandedAssignedIssues();
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
      expect(retry).toBeDefined();
      if (historical) await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, retry!.id));
      if (gate === "interaction") {
        await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId, kind: "ask_user_questions",
          payload: { version: 1, questions: [{ id: "proceed", question: "Proceed?", type: "text" }] } as any });
      } else if (gate === "approval") {
        const [approval] = await db.insert(approvals).values({ companyId, type: "request_board_approval", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId, issueId: sourceIssueId, approvalId: approval!.id });
      } else if (gate === "dependency") {
        const [blocker] = await db.insert(issues).values({ companyId, title: "Blocker", status: "todo" }).returning();
        await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: sourceIssueId, type: "blocks" });
      } else if (gate === "disabled") {
        await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, coderId));
      } else {
        await db.update(issues).set({ assigneeAgentId: managerId }).where(eq(issues.id, sourceIssueId));
      }
      const [gatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      const promotion = await createRunDispatch(db).promoteScheduledRetry({ companyId, runId: retry!.id, now: new Date("2099-01-01") });
      expect(promotion.outcome).toBe("gate_suppressed");
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry!.id));
      expect(wake?.status).toBe("cancelled");
      // Remove only the synthetic cancelled retry so the same failure is considered for scheduling again.
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, retry!.id));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
      await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) }).reconcileStrandedAssignedIssues();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"))).toHaveLength(0);
      expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([gatedIssue]);
      expect(sourceIssue.monitorNotes).toBeNull();
    },
  );

  it("refuses exhausted historical conversation quota promotion without waiting for a sweep", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const [failure] = await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, status: "failed",
      errorCode: "provider_quota", resultJson: { conversationContinuation: "continue_conversation_v1", errorFamily: "provider_quota" },
      contextSnapshot: { issueId: sourceIssueId }, finishedAt: new Date() }).returning();
    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) }).reconcileStrandedAssignedIssues();
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    await db.update(heartbeatRuns).set({ resultJson: null, scheduledRetryAttempt: 3 }).where(eq(heartbeatRuns.id, retry!.id));
    await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, failure!.id));
    const dispatch = createRunDispatch(db);
    expect(await dispatch.promoteScheduledRetry({ companyId, runId: retry!.id, now: new Date("2099-01-01") }))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "provider_quota_retry_exhausted" });
    expect(await dispatch.promoteScheduledRetry({ companyId, runId: retry!.id, now: new Date("2099-01-01") }))
      .toMatchObject({ outcome: "not_promoted" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry!.id)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) }).reconcileStrandedAssignedIssues();
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"))).toHaveLength(0);
  });

  it.each([
    ["observed", "awaiting_evidence"],
    ["observed", "awaiting_runner_reattach"],
    ["observed", "resuming_session"],
    ["observed", "bootstrap_incomplete"],
    ["retryable_failure", null],
  ] as const)("leaves quota recovery with the native owner during %s/%s", async (phase, recoveryState) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      nativeIssueId: sourceIssueId,
      nativePhase: phase,
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      finishedAt: new Date(),
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId: sourceIssueId,
      phase,
      recoveryState,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBe(1);
    expect(result.providerQuotaMonitored).toBe(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("preserves an armed business monitor while scheduling provider-quota recovery separately", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const businessMonitorAt = new Date("2099-08-25T13:00:00.000Z");
    const businessPolicy = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: businessMonitorAt.toISOString(),
        notes: "Do not file early; verify the external stage gate before submission.",
        scheduledBy: "assignee" as const,
        kind: "external_service" as const,
        serviceName: "Utility filing gate",
        externalRef: "deal-37432",
        timeoutAt: null,
        maxAttempts: 3,
        recoveryPolicy: "wake_owner" as const,
      },
    };
    await db.update(issues).set({
      executionPolicy: businessPolicy,
      monitorNextCheckAt: businessMonitorAt,
      monitorAttemptCount: 1,
      monitorNotes: businessPolicy.monitor.notes,
      monitorScheduledBy: "assignee",
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-08-20T20:50:00.000Z"),
      finishedAt: new Date("2026-08-20T20:51:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      executionPolicy: businessPolicy,
      monitorAttemptCount: 1,
      monitorNotes: businessPolicy.monitor.notes,
      monitorScheduledBy: "assignee",
    });
    expect(updatedIssue?.monitorNextCheckAt?.getTime()).toBe(businessMonitorAt.getTime());
    const quotaRetries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(quotaRetries).toHaveLength(1);
    expect(quotaRetries[0]).toMatchObject({
      agentId: coderId,
      retryOfRunId: runId,
      status: "scheduled_retry",
    });

    expect(await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"))).toHaveLength(1);
  });

  it("repoints a pending quota retry when a later quota failure has a later reset", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const businessMonitorAt = new Date("2099-08-25T13:00:00.000Z");
    const businessNotes = "Do not file early; verify the external stage gate before submission.";
    await db.update(issues).set({
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: businessMonitorAt.toISOString(),
          notes: businessNotes,
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "Utility filing gate",
          externalRef: "deal-37432",
          timeoutAt: null,
          maxAttempts: 3,
          recoveryPolicy: "wake_owner",
        },
      },
      monitorNextCheckAt: businessMonitorAt,
      monitorAttemptCount: 1,
      monitorNotes: businessNotes,
      monitorScheduledBy: "assignee",
    }).where(eq(issues.id, sourceIssueId));
    const firstRunId = randomUUID();
    const firstResetAt = new Date("2099-01-01T14:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: firstRunId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      resultJson: { retryNotBefore: firstResetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      startedAt: new Date("2026-08-20T20:50:00.000Z"),
      finishedAt: new Date("2026-08-20T20:51:00.000Z"),
      createdAt: new Date("2026-08-20T20:51:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    expect((await recovery.reconcileStrandedAssignedIssues()).providerQuotaMonitored).toBe(1);

    const secondRunId = randomUUID();
    const secondResetAt = new Date("2099-01-01T20:01:20.000Z");
    const later = new Date(Date.now() + 5_000);
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      scheduledRetryAttempt: 1,
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      resultJson: { retryNotBefore: secondResetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      startedAt: later,
      finishedAt: later,
      createdAt: later,
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult.providerQuotaMonitored).toBe(1);

    const quotaRetries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(quotaRetries).toHaveLength(1);
    expect(quotaRetries[0]).toMatchObject({
      agentId: coderId,
      retryOfRunId: secondRunId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 2,
    });
    expect(quotaRetries[0]?.scheduledRetryAt?.getTime()).toBe(secondResetAt.getTime());
    expect(quotaRetries[0]?.contextSnapshot).toMatchObject({
      providerQuotaRetryNotBefore: secondResetAt.toISOString(),
    });

    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      reason: "provider_quota_recovery",
      status: "queued",
      runId: quotaRetries[0]?.id,
    });
    expect(wakeups[0]?.payload).toMatchObject({
      retryOfRunId: secondRunId,
      providerQuotaRetryNotBefore: secondResetAt.toISOString(),
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      monitorAttemptCount: 1,
      monitorNotes: businessNotes,
      monitorScheduledBy: "assignee",
    });
    expect(updatedIssue?.monitorNextCheckAt?.getTime()).toBe(businessMonitorAt.getTime());
  });

  it.each([
    { laterFailure: false, maxAttempt: 1, nullDeadline: false },
    { laterFailure: false, maxAttempt: 3, nullDeadline: false },
    { laterFailure: true, maxAttempt: 3, nullDeadline: false },
    { laterFailure: false, maxAttempt: 1, nullDeadline: true },
  ])("reconciles pre-existing duplicate quota retries ($laterFailure, $maxAttempt, null: $nullDeadline)", async ({ laterFailure, maxAttempt, nullDeadline }) => {
    const { companyId, coderId, managerId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const resetAt = new Date("2099-01-01T20:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed",
      resultJson: { retryNotBefore: resetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: sourceIssueId },
      startedAt: new Date("2026-08-20T20:50:00Z"), finishedAt: new Date("2026-08-20T20:51:00Z"),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    await recovery.reconcileStrandedAssignedIssues();
    const [canonical] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    const [canonicalWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, canonical!.wakeupRequestId!));
    if (nullDeadline) {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: null }).where(eq(heartbeatRuns.id, canonical!.id));
    }
    const beforeIssue = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const duplicates: Array<{ runId: string; wakeId: string }> = [];
    for (const attempt of [1, maxAttempt]) {
      const duplicateId = randomUUID();
      const wakeId = randomUUID();
      const staleReset = new Date("2099-01-01T10:00:00.000Z");
      await db.insert(agentWakeupRequests).values({
        ...canonicalWake!, id: wakeId, runId: duplicateId, idempotencyKey: null,
        payload: { ...canonicalWake!.payload, providerQuotaRetryNotBefore: staleReset.toISOString() },
      });
      await db.insert(heartbeatRuns).values({
        ...canonical!, id: duplicateId, wakeupRequestId: wakeId,
        scheduledRetryAt: staleReset, scheduledRetryAttempt: attempt,
        contextSnapshot: { ...canonical!.contextSnapshot, providerQuotaRetryNotBefore: staleReset.toISOString() },
      });
      duplicates.push({ runId: duplicateId, wakeId });
    }
    // Matching JSON alone must not widen company/agent/issue scope.
    const other = await seedCompany();
    const isolated = [
      { companyId: other.companyId, agentId: other.coderId },
      { agentId: managerId },
      { contextSnapshot: { issueId: other.sourceIssueId } },
    ];
    const isolatedIds: string[] = [];
    for (const overrides of isolated) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ ...canonical!, id, wakeupRequestId: null, createdAt: new Date("2020-01-01T00:00:00Z"), ...overrides });
      isolatedIds.push(id);
    }
    const isolatedBefore = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, isolatedIds));
    let latestRunId = runId;
    if (laterFailure) {
      latestRunId = randomUUID();
      const later = new Date(Date.now() + 5_000);
      await db.insert(heartbeatRuns).values({
        id: latestRunId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
        error: "Provider quota exceeded for this model.", errorCode: "adapter_failed",
        scheduledRetryAttempt: 1,
        resultJson: { retryNotBefore: "2099-01-01T15:00:00.000Z", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: { issueId: sourceIssueId }, createdAt: later, startedAt: later, finishedAt: later,
      });
    }
    await recovery.reconcileStrandedAssignedIssues();
    const all = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, coderId),
      eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${sourceIssueId}`,
    ));
    expect(all).toHaveLength(3);
    expect(all.filter((run) => run.status === "scheduled_retry")).toEqual([
      expect.objectContaining({ id: canonical!.id, retryOfRunId: latestRunId, scheduledRetryAttempt: maxAttempt, scheduledRetryAt: resetAt }),
    ]);
    for (const duplicate of duplicates) {
      expect(all.find((run) => run.id === duplicate.runId)).toMatchObject({
        status: "cancelled", errorCode: "provider_quota_retry_superseded", retryOfRunId: runId,
        scheduledRetryAt: new Date("2099-01-01T10:00:00.000Z"),
      });
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, duplicate.wakeId));
      expect(wake).toMatchObject({ status: "cancelled", runId: duplicate.runId, claimedAt: null });
      expect(wake!.finishedAt).not.toBeNull();
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, duplicate.runId));
      expect(events).toEqual([expect.objectContaining({
        eventType: "lifecycle", payload: expect.objectContaining({ supersededByRunId: canonical!.id }),
      })]);
      expect(await createRunDispatch(db).promoteScheduledRetry({ companyId, runId: duplicate.runId, now: new Date("2099-01-02T00:00:00Z") }))
        .toMatchObject({ outcome: "not_promoted" });
    }
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, canonicalWake!.id));
    expect(wake).toMatchObject({ status: "queued", payload: { retryOfRunId: latestRunId, providerQuotaRetryNotBefore: resetAt.toISOString() } });
    const after = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    await recovery.reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"))).toEqual(after);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(beforeIssue);
    expect(await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, isolatedIds))).toEqual(isolatedBefore);
  });

  it.each([false, true])("preserves newest failure provenance across mixed duplicate waits (stale has latest deadline: %s)", async (staleHasLatestDeadline) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const firstFailureId = randomUUID();
    const secondFailureId = randomUUID();
    const resetAt = new Date("2099-01-01T20:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: firstFailureId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed",
      resultJson: { retryNotBefore: resetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: sourceIssueId },
      createdAt: new Date("2026-08-20T20:50:00Z"),
      startedAt: new Date("2026-08-20T20:50:00Z"), finishedAt: new Date("2026-08-20T20:51:00Z"),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    await recovery.reconcileStrandedAssignedIssues();
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    const [originalWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, original!.wakeupRequestId!));
    const secondCreatedAt = new Date(original!.createdAt.getTime() + 1_000);
    await db.insert(heartbeatRuns).values({
      id: secondFailureId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed", scheduledRetryAttempt: 2,
      resultJson: { retryNotBefore: resetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: sourceIssueId },
      createdAt: secondCreatedAt, startedAt: secondCreatedAt, finishedAt: secondCreatedAt,
    });
    await db.update(heartbeatRuns).set({ retryOfRunId: secondFailureId, scheduledRetryAttempt: 3 }).where(eq(heartbeatRuns.id, original!.id));
    await db.update(agentWakeupRequests).set({ payload: { ...originalWake!.payload, retryOfRunId: secondFailureId } }).where(eq(agentWakeupRequests.id, originalWake!.id));
    const staleId = randomUUID();
    const staleWakeId = randomUUID();
    const staleResetAt = new Date(staleHasLatestDeadline ? "2099-01-01T21:00:00Z" : "2099-01-01T10:00:00Z");
    await db.insert(agentWakeupRequests).values({
      ...originalWake!, id: staleWakeId, runId: staleId, idempotencyKey: null,
      payload: { ...originalWake!.payload, retryOfRunId: firstFailureId, providerQuotaRetryNotBefore: staleResetAt.toISOString() },
    });
    await db.insert(heartbeatRuns).values({
      ...original!, id: staleId, wakeupRequestId: staleWakeId, retryOfRunId: firstFailureId,
      scheduledRetryAt: staleResetAt, scheduledRetryAttempt: 1,
      createdAt: new Date(secondCreatedAt.getTime() + 1_000),
      contextSnapshot: { ...original!.contextSnapshot, providerQuotaRetryNotBefore: staleResetAt.toISOString() },
    });
    const beforeIssue = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const survivorId = staleHasLatestDeadline ? staleId : original!.id;
    const cancelledId = staleHasLatestDeadline ? original!.id : staleId;
    const safeDeadline = staleHasLatestDeadline ? staleResetAt : resetAt;
    await recovery.reconcileStrandedAssignedIssues();
    const runsAfter = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(runsAfter.filter((run) => run.status === "scheduled_retry")).toEqual([
      expect.objectContaining({ id: survivorId, retryOfRunId: secondFailureId, scheduledRetryAttempt: 3, scheduledRetryAt: safeDeadline }),
    ]);
    expect(runsAfter.find((run) => run.id === cancelledId)).toMatchObject({
      status: "cancelled", errorCode: "provider_quota_retry_superseded",
      retryOfRunId: staleHasLatestDeadline ? secondFailureId : firstFailureId,
    });
    const wakesAfter = await db.select().from(agentWakeupRequests);
    expect(wakesAfter.filter((wake) => wake.status === "queued")).toEqual([
      expect.objectContaining({ runId: survivorId, claimedAt: null, payload: expect.objectContaining({
        retryOfRunId: secondFailureId, providerQuotaRetryNotBefore: safeDeadline.toISOString(),
      }) }),
    ]);
    expect(wakesAfter.find((wake) => wake.runId === cancelledId)).toMatchObject({ status: "cancelled", payload: {
      retryOfRunId: staleHasLatestDeadline ? secondFailureId : firstFailureId,
    } });
    const eventsAfter = await db.select().from(heartbeatRunEvents);
    expect(eventsAfter).toHaveLength(1);
    expect(await createRunDispatch(db).promoteScheduledRetry({ companyId, runId: cancelledId, now: new Date("2099-01-02T00:00:00Z") }))
      .toMatchObject({ outcome: "not_promoted" });
    await recovery.reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"))).toEqual(runsAfter);
    expect(await db.select().from(agentWakeupRequests)).toEqual(wakesAfter);
    expect(await db.select().from(heartbeatRunEvents)).toEqual(eventsAfter);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(beforeIssue);
  });

  it.each([false, true])("preserves mixed predecessor provenance for conversation quota waits (stale has latest deadline: %s)", async (staleHasLatestDeadline) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const firstFailureId = randomUUID();
    const secondFailureId = randomUUID();
    const resetAt = new Date("2099-01-01T20:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: firstFailureId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed",
      resultJson: { conversationContinuation: "continue_conversation_v1", retryNotBefore: resetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: sourceIssueId },
      createdAt: new Date("2026-08-20T20:50:00Z"),
      startedAt: new Date("2026-08-20T20:50:00Z"), finishedAt: new Date("2026-08-20T20:51:00Z"),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    await recovery.reconcileStrandedAssignedIssues();
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    const [originalWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, original!.wakeupRequestId!));
    const secondCreatedAt = new Date(original!.createdAt.getTime() + 1_000);
    await db.insert(heartbeatRuns).values({
      id: secondFailureId, companyId, agentId: coderId, invocationSource: "manual", status: "failed",
      error: "Provider quota exceeded for this model.", errorCode: "adapter_failed", scheduledRetryAttempt: 1,
      resultJson: { conversationContinuation: "continue_conversation_v1", retryNotBefore: resetAt.toISOString(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: sourceIssueId },
      createdAt: secondCreatedAt, startedAt: secondCreatedAt, finishedAt: secondCreatedAt,
    });
    await db.update(heartbeatRuns).set({ retryOfRunId: secondFailureId, scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, original!.id));
    await db.update(agentWakeupRequests).set({ payload: { ...originalWake!.payload, retryOfRunId: secondFailureId } }).where(eq(agentWakeupRequests.id, originalWake!.id));
    const staleId = randomUUID();
    const staleWakeId = randomUUID();
    const staleResetAt = new Date(staleHasLatestDeadline ? "2099-01-01T21:00:00Z" : "2099-01-01T10:00:00Z");
    await db.insert(agentWakeupRequests).values({
      ...originalWake!, id: staleWakeId, runId: staleId, idempotencyKey: null,
      payload: { ...originalWake!.payload, retryOfRunId: firstFailureId, providerQuotaRetryNotBefore: staleResetAt.toISOString() },
    });
    await db.insert(heartbeatRuns).values({
      ...original!, id: staleId, wakeupRequestId: staleWakeId, retryOfRunId: firstFailureId,
      scheduledRetryAt: staleResetAt, scheduledRetryAttempt: 1,
      createdAt: new Date(secondCreatedAt.getTime() + 1_000),
      contextSnapshot: { ...original!.contextSnapshot, providerQuotaRetryNotBefore: staleResetAt.toISOString() },
    });
    const beforeIssue = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const survivorId = staleHasLatestDeadline ? staleId : original!.id;
    const cancelledId = staleHasLatestDeadline ? original!.id : staleId;
    const safeDeadline = staleHasLatestDeadline ? staleResetAt : resetAt;
    await recovery.reconcileStrandedAssignedIssues();
    const runsAfter = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(runsAfter.filter((run) => run.status === "scheduled_retry")).toEqual([
      expect.objectContaining({ id: survivorId, retryOfRunId: secondFailureId, scheduledRetryAttempt: 2, scheduledRetryAt: safeDeadline, resultJson: { conversationContinuation: "continue_conversation_v1" } }),
    ]);
    expect(runsAfter.find((run) => run.id === cancelledId)).toMatchObject({
      status: "cancelled", errorCode: "provider_quota_retry_superseded",
      retryOfRunId: staleHasLatestDeadline ? secondFailureId : firstFailureId,
    });
    const wakesAfter = await db.select().from(agentWakeupRequests);
    expect(wakesAfter.filter((wake) => wake.status === "queued")).toEqual([
      expect.objectContaining({ runId: survivorId, claimedAt: null, payload: expect.objectContaining({
        retryOfRunId: secondFailureId, providerQuotaRetryNotBefore: safeDeadline.toISOString(),
      }) }),
    ]);
    expect(wakesAfter.find((wake) => wake.runId === cancelledId)).toMatchObject({ status: "cancelled", payload: {
      retryOfRunId: staleHasLatestDeadline ? secondFailureId : firstFailureId,
    } });
    const eventsAfter = await db.select().from(heartbeatRunEvents);
    expect(eventsAfter).toHaveLength(1);
    expect(await createRunDispatch(db).promoteScheduledRetry({ companyId, runId: cancelledId, now: new Date("2099-01-02T00:00:00Z") }))
      .toMatchObject({ outcome: "not_promoted" });
    await recovery.reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"))).toEqual(runsAfter);
    expect(await db.select().from(agentWakeupRequests)).toEqual(wakesAfter);
    expect(await db.select().from(heartbeatRunEvents)).toEqual(eventsAfter);
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual(beforeIssue);
  });

  it.each(["claimed", "queued", "running", "other_reason"])("leaves duplicate quota retries to the existing %s lifecycle", async (lifecycle) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const failedId = randomUUID();
    const createdAt = new Date("2026-08-20T20:51:00Z");
    await db.insert(heartbeatRuns).values({
      id: failedId, companyId, agentId: coderId, status: "failed", errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" }, contextSnapshot: { issueId: sourceIssueId }, createdAt,
    });
    for (let i = 0; i < 2; i += 1) {
      const id = randomUUID();
      const wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId: coderId, source: "automation", reason: "provider_quota_recovery",
        status: lifecycle === "claimed" ? "claimed" : "queued",
        claimedAt: lifecycle === "claimed" ? createdAt : null, runId: id,
        payload: { issueId: sourceIssueId, retryOfRunId: failedId },
      });
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId: coderId, status: "scheduled_retry", retryOfRunId: failedId,
        scheduledRetryAt: new Date("2099-01-01T20:00:00Z"), scheduledRetryAttempt: 1,
        scheduledRetryReason: "provider_quota_recovery", wakeupRequestId: wakeId,
        contextSnapshot: { issueId: sourceIssueId },
      });
    }
    if (lifecycle !== "claimed") {
      await db.insert(heartbeatRuns).values({
        companyId, agentId: coderId, status: lifecycle === "other_reason" ? "scheduled_retry" : lifecycle,
        scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: sourceIssueId },
        scheduledRetryAt: new Date("2099-01-01T10:00:00Z"),
      });
    }
    const runsBefore = await db.select().from(heartbeatRuns);
    const wakesBefore = await db.select().from(agentWakeupRequests);
    const enqueueWakeup = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns)).toEqual(runsBefore);
    expect(await db.select().from(agentWakeupRequests)).toEqual(wakesBefore);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules provider-quota recovery without changing prior monitor attempt history", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      executionPolicy: null,
      monitorAttemptCount: 1,
      monitorNextCheckAt: null,
    });
    const [scheduledRetry] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(scheduledRetry).toMatchObject({ retryOfRunId: runId, status: "scheduled_retry" });
  });

  it("skips provider-quota retry scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota retry cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["bootstrap", "unclassified", "exhausted"] as const)("handles %s quota failure for a cross-agent active review participant", async (evidence) => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: evidence === "unclassified" ? null : { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      scheduledRetryAttempt: evidence === "exhausted" ? 2 : 0,
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    if (evidence !== "bootstrap") {
      expect(result).toMatchObject({ escalated: 1, providerQuotaMonitored: 0, reviewParticipantRequeued: 0 });
      expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
        ownerType: "board", returnOwnerAgentId: coderId, cause: "legacy_execution_requires_reconciliation",
        evidence: expect.objectContaining({ runId, reviewParticipantAgentId: managerId }),
      })]);
      const [task] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(task).toMatchObject({ assigneeAgentId: coderId,
        executionPolicy: reviewIssueBeforeRecovery!.executionPolicy,
        executionState: reviewIssueBeforeRecovery!.executionState });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
      monitorNotes: null,
    });
    const [scheduledRetry] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(scheduledRetry).toMatchObject({
      agentId: managerId,
      retryOfRunId: runId,
      status: "scheduled_retry",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not duplicate an in_review quota retry when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [firstRetry] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    const firstNextCheckAt = firstRetry?.scheduledRetryAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(firstRetry).toMatchObject({ agentId: managerId, retryOfRunId: participantRunId });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt).toBeNull();
    const quotaRetries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(quotaRetries).toHaveLength(1);
    expect(quotaRetries[0]?.scheduledRetryAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 0, escalated: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
      evidence: expect.objectContaining({ runId: participantRunId }),
    })]);
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
      monitorNotes: null,
    });
    const [scheduledRetry] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
    expect(scheduledRetry).toMatchObject({ agentId: coderId, status: "scheduled_retry" });
    expect(scheduledRetry?.scheduledRetryAt).toBeInstanceOf(Date);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
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
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "board_escalation",
        reason: "workspace_validation_failed",
        preservesSourceAssignee: true,
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
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
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
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

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it("accepts new verified evidence after an automatic no-replay disposition without reopening on duplicate requests", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const app = createApp();
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects." } };
    // A retry without new evidence cannot clear the hold or reopen the task.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("todo");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
  });

  async function seedReconciledDelivery() {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, companyId));
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, coderId));
    const previousRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: previousRunId,
      issueId: sourceIssueId,
      status: "failed",
    });
    // Occupy the agent's only dispatch slot, independently of this issue. These
    // tests exercise real wake admission, but cannot launch a provider process.
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      status: "running",
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "restored",
        ownerType: "board",
        returnOwnerAgentId: coderId,
        cause: "uncertain_external_action",
        fingerprint: previousRunId,
        nextAction: "Continue from the verified reconciliation.",
        evidence: {
          runId: previousRunId,
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: previousRunId,
            providerStopped: true,
            actionOutcome: "not_performed",
            outcomeEvidence: "Verified absent provider effect.",
          },
        },
      })
      .returning();
    return {
      ...fixture,
      previousRunId,
      action: action!,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
    };
  }

  it("delivers a reconciled execution once across concurrent sweeps without a deferred duplicate", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake: typeof heartbeat.wakeup = async (...args) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return heartbeat.wakeup(...args);
    };
    await Promise.all([
      deliverReconciledExecutions(db, wake),
      deliverReconciledExecutions(db, wake),
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: wakes[0]!.runId,
    });
  });

  it("reconciles a lost wake acknowledgement after the exact successor has already finished", async () => {
    const { action, heartbeat, companyId, previousRunId } =
      await seedReconciledDelivery();
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      successorId = run!.id;
      expect(run!.retryOfRunId).toBe(previousRunId);
      throw new Error("fixture lost post-commit wake acknowledgement");
    });
    expect(successorId).toBeDefined();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorId!));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const [successor] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, successorId!),
        ),
      );
    expect(successor).toMatchObject({
      status: "succeeded",
      retryOfRunId: previousRunId,
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: successorId,
    });
  });

  it.each(["owner", "status", "decision"] as const)(
    "rechecks the current reconciliation %s after the sweep read",
    async (changed) => {
      const { action, heartbeat, sourceIssueId, managerId } =
        await seedReconciledDelivery();
      await deliverReconciledExecutions(db, async (...args) => {
        if (changed === "owner")
          await db
            .update(issues)
            .set({ assigneeAgentId: managerId })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "status")
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "decision")
          await db
            .update(issueRecoveryActions)
            .set({
              evidence: {
                ...action.evidence,
                executionReconciliation: {
                  ...(action.evidence.executionReconciliation as object),
                  runId: randomUUID(),
                },
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
        return heartbeat.wakeup(...args);
      });
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(
            eq(
              agentWakeupRequests.idempotencyKey,
              `execution-reconciliation:${action.id}`,
            ),
          ),
      ).toHaveLength(0);
      const [receipt] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(receipt!.evidence.continuationDelivery).toBe("pending");
    },
  );

  it("keeps reconciliation pending behind unrelated issue work without creating a second deferred outbox", async () => {
    const { action, heartbeat, sourceIssueId, companyId, coderId } =
      await seedReconciledDelivery();
    const occupiedRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: occupiedRunId,
      issueId: sourceIssueId,
      status: "queued",
    });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          eq(
            agentWakeupRequests.idempotencyKey,
            `execution-reconciliation:${action.id}`,
          ),
        ),
    ).toHaveLength(0);
    const [occupied] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, occupiedRunId));
    expect(occupied!.contextSnapshot).toEqual({ issueId: sourceIssueId });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupiedRunId));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).not.toBe(occupiedRunId);
  });

  it("does not overwrite a newer reconciliation decision after a prior wake commits", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    const newerEvidence = {
      ...action.evidence,
      continuationDelivery: "invalidated",
      operatorNote: "Do not continue after new evidence.",
    };
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      await db
        .update(issueRecoveryActions)
        .set({ evidence: newerEvidence })
        .where(eq(issueRecoveryActions.id, action.id));
      return run;
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toEqual(newerEvidence);
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
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

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

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
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
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
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

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
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

  it("keeps the named recovery owner from completing a board-owned source issue", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(403);

    expect(resolved.body.details?.code).toBe("recovery_source_authority_required");
    const [sourceAfter, actionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]),
    ]);
    expect(sourceAfter).toMatchObject({ status: "blocked", assigneeUserId: "board-user" });
    expect(actionAfter).toMatchObject({ status: "active", outcome: null });
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
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });
});
