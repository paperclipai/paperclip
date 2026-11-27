import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  subscribeDatabaseWork,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { parseIssueExecutionState } from "../services/issue-execution-policy.ts";

vi.mock("../services/company-skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/company-skills.js")>();
  return {
    ...actual,
    companySkillService: (...args: Parameters<typeof actual.companySkillService>) => {
      const service = actual.companySkillService(...args);
      return {
        ...service,
        withRuntimeSkillEntries: async <T>(
          _companyId: string,
          options: Parameters<typeof service.withRuntimeSkillEntries>[1],
          consume: (entries: Awaited<ReturnType<typeof service.listRuntimeSkillEntries>>) => T | Promise<T>,
        ) => {
          await options.selectVersions?.([]);
          return consume([]);
        },
      };
    },
  };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_MONITOR_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue monitor deferral parking", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-deferral-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) {
      await heartbeat.cancelRun(run.id, "Monitor deferral teardown", { suppressImmediateRecovery: true });
    }
    await heartbeat.drainActiveRunExecutions();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: { monitor?: Record<string, unknown> }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const monitor: Record<string, unknown> = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
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
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: 0,
          notes: "Check deploy",
          scheduledBy: "assignee",
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 0,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it.each([
    { cause: "provider_failure_meaning_unverified" as const, runtimeMode: "native" as const, status: "failed" as const },
    { cause: "legacy_execution_requires_reconciliation" as const, runtimeMode: "legacy" as const, status: "interrupted" as const },
  ])("parks a monitor deferred by $cause without bumping updatedAt or spamming activity_log, and fires once reconciliation clears", async ({ cause, runtimeMode, status }) => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      nativeIssueId: runtimeMode === "native" ? issueId : null,
      runtimeMode,
      status,
      errorCode: "permission_denied",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause,
      fingerprint: `${cause}:${sourceRunId}`,
      evidence: { runId: sourceRunId },
      nextAction: "Inspect the failed execution before continuing.",
    }).returning();
    const seededUpdatedAt = new Date("2026-04-11T12:00:00.000Z");
    await db.update(issues).set({ updatedAt: seededUpdatedAt }).where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const firstTickAt = new Date(nextCheckAt.getTime() + 39 * 60 * 60_000);
    expect(await heartbeat.tickTimers(firstTickAt)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });

    const [parked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(parked!.updatedAt).toEqual(seededUpdatedAt);
    expect(parked!.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(parked!.monitorWakeRequestedAt).toBeNull();
    expect(parked!.monitorAttemptCount).toBe(0);
    expect(await heartbeat.nextIssueMonitorAt()).toBeNull();

    const firstEvents = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
      .filter((row) => row.action === "issue.monitor_deferred");
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]!.details).toMatchObject({
      reason: "execution_reconciliation_required",
      blockerCause: cause,
      nextCheckAt: nextCheckAt.toISOString(),
    });

    await db.update(activityLog)
      .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(activityLog.entityId, issueId));

    for (const offsetMs of [5 * 60_000, 10 * 60_000, 30 * 60_000, 6 * 60 * 60_000]) {
      expect(await heartbeat.tickTimers(new Date(firstTickAt.getTime() + offsetMs))).toEqual({
        checked: 0,
        enqueued: 0,
        skipped: 0,
      });
    }

    const [stillParked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stillParked!.updatedAt).toEqual(seededUpdatedAt);
    expect(stillParked!.monitorAttemptCount).toBe(0);
    const deferredEventsAfterHours = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
      .filter((row) => row.action === "issue.monitor_deferred");
    expect(deferredEventsAfterHours).toHaveLength(1);

    const notified: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.issueMonitors, (event) => {
      notified.push(event);
    });
    try {
      await issueRecoveryActionService(db).resolveActiveForIssue({
        companyId,
        sourceIssueId: issueId,
        actionId: hold!.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote: "Operator reconciled execution.",
      });
      await db.update(issueRecoveryActions)
        .set({ evidence: { runId: sourceRunId, executionReconciliation: { action: "continue" } } })
        .where(eq(issueRecoveryActions.id, hold!.id));
    } finally {
      unsubscribe();
    }
    expect(notified).toContain("settled");
    expect(await heartbeat.nextIssueMonitorAt()).toBe(nextCheckAt.getTime());

    const afterClearAt = new Date(firstTickAt.getTime() + 6 * 60 * 60_000 + 60_000);
    expect(await heartbeat.tickTimers(afterClearAt)).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });

    const [dispatched] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(dispatched!.monitorNextCheckAt).toBeNull();
    expect(dispatched!.monitorAttemptCount).toBe(1);
    expect(dispatched!.updatedAt.getTime()).toBeGreaterThan(seededUpdatedAt.getTime());
  });

  it("parks a monitor deferred by a resolved no-replay hold until its blocking evidence is retired", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      runtimeMode: "legacy",
      status: "interrupted",
      errorCode: "permission_denied",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `no-replay:${sourceRunId}`,
      evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" } },
      nextAction: "Inspect the interrupted execution before continuing.",
      resolvedAt: new Date("2026-04-11T12:05:00.000Z"),
    }).returning();
    const seededUpdatedAt = new Date("2026-04-11T12:00:00.000Z");
    await db.update(issues).set({ updatedAt: seededUpdatedAt }).where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const firstTickAt = new Date(nextCheckAt.getTime() + 60_000);
    expect(await heartbeat.tickTimers(firstTickAt)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await heartbeat.nextIssueMonitorAt()).toBeNull();

    // Even after hours, the resolved no-replay hold stays parked with zero retries or updatedAt churn.
    expect(await heartbeat.tickTimers(new Date(firstTickAt.getTime() + 2 * 60 * 60_000))).toEqual({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });
    const [parked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(parked!.updatedAt).toEqual(seededUpdatedAt);
    expect(
      (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
        .filter((row) => row.action === "issue.monitor_deferred"),
    ).toHaveLength(1);

    // Retiring the blocking evidence immediately unparks and dispatches the monitor.
    await db.update(issueRecoveryActions).set({
      evidence: { runId: sourceRunId, executionReconciliation: { action: "continue" } },
      updatedAt: new Date(hold!.updatedAt.getTime() + 1_000),
    }).where(eq(issueRecoveryActions.id, hold!.id));

    expect(await heartbeat.nextIssueMonitorAt()).toBe(nextCheckAt.getTime());
    expect(await heartbeat.tickTimers(new Date(firstTickAt.getTime() + 2 * 60 * 60_000 + 60_000)))
      .toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });
  });

  it("respects timeoutAt on a parked escalate_to_board monitor and keeps wake_owner parked until reconciliation clears", async () => {
    const timeoutAt = new Date("2026-04-11T14:30:00.000Z");
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({
      monitor: { timeoutAt: timeoutAt.toISOString(), recoveryPolicy: "escalate_to_board" },
    });
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      runtimeMode: "native",
      status: "failed",
      errorCode: "permission_denied",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "provider_failure_meaning_unverified",
      fingerprint: `escalate:${sourceRunId}`,
      evidence: { runId: sourceRunId },
      nextAction: "Inspect the failed execution before continuing.",
    });

    const heartbeat = heartbeatService(db);
    const firstTickAt = new Date(nextCheckAt.getTime() + 60_000);
    expect(await heartbeat.tickTimers(firstTickAt)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await heartbeat.nextIssueMonitorAt()).toBe(timeoutAt.getTime());
    expect(await heartbeat.tickTimers(new Date(timeoutAt.getTime() - 1_000))).toEqual({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });

    expect(await heartbeat.tickTimers(timeoutAt)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    const [escalated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(escalated!.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(escalated!.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const wakeOwnerFixture = await seedFixture({
      monitor: { timeoutAt: timeoutAt.toISOString(), recoveryPolicy: "wake_owner" },
    });
    const wakeSourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: wakeSourceRunId,
      companyId: wakeOwnerFixture.companyId,
      agentId: wakeOwnerFixture.agentId,
      nativeIssueId: wakeOwnerFixture.issueId,
      runtimeMode: "native",
      status: "failed",
      errorCode: "permission_denied",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId: wakeOwnerFixture.issueId },
    });
    const [wakeHold] = await db.insert(issueRecoveryActions).values({
      companyId: wakeOwnerFixture.companyId,
      sourceIssueId: wakeOwnerFixture.issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "provider_failure_meaning_unverified",
      fingerprint: `wake-owner:${wakeSourceRunId}`,
      evidence: { runId: wakeSourceRunId },
      nextAction: "Inspect the failed execution before continuing.",
    }).returning();
    const wakeSeededUpdatedAt = new Date("2026-04-11T12:00:00.000Z");
    await db.update(issues).set({ updatedAt: wakeSeededUpdatedAt }).where(eq(issues.id, wakeOwnerFixture.issueId));

    const pastTimeout = new Date(timeoutAt.getTime() + 60_000);
    expect(await heartbeat.tickTimers(pastTimeout)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await heartbeat.nextIssueMonitorAt()).toBeNull();
    expect(await heartbeat.tickTimers(new Date(pastTimeout.getTime() + 30 * 60_000))).toEqual({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });
    const [parkedWakeOwner] = await db.select().from(issues).where(eq(issues.id, wakeOwnerFixture.issueId));
    expect(parkedWakeOwner!.updatedAt).toEqual(wakeSeededUpdatedAt);
    expect(parkedWakeOwner!.monitorNextCheckAt).toEqual(wakeOwnerFixture.nextCheckAt);

    await issueRecoveryActionService(db).resolveActiveForIssue({
      companyId: wakeOwnerFixture.companyId,
      sourceIssueId: wakeOwnerFixture.issueId,
      actionId: wakeHold!.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Reconciled.",
    });
    await db.update(issueRecoveryActions)
      .set({ evidence: { runId: wakeSourceRunId, executionReconciliation: { action: "continue" } } })
      .where(eq(issueRecoveryActions.id, wakeHold!.id));

    expect(await heartbeat.nextIssueMonitorAt()).toBe(wakeOwnerFixture.nextCheckAt.getTime());
    expect(await heartbeat.tickTimers(new Date(pastTimeout.getTime() + 31 * 60_000))).toMatchObject({
      checked: 1,
      skipped: 1,
    });
    const [clearedWakeOwner] = await db.select().from(issues).where(eq(issues.id, wakeOwnerFixture.issueId));
    expect(clearedWakeOwner!.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(clearedWakeOwner!.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });
  });
});
