import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    wakeOnDemand?: boolean;
    issueStatus?: "in_progress" | "in_review" | "blocked";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
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
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: input?.wakeOnDemand ?? true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
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
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("does not enqueue a generic timer heartbeat while the agent already has a live run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const staleAt = new Date("2026-04-11T12:00:00.000Z");
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Busy CEO",
      role: "ceo",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      lastHeartbeatAt: staleAt,
      createdAt: staleAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date("2026-04-11T12:30:00.000Z"),
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
    });

    const result = await heartbeatService(db).tickTimers(tickAt);

    expect(result).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: tickAt })
      .where(eq(heartbeatRuns.id, runId));
  });

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    expect(result.monitorDeliveries).toEqual({
      queued: 1,
      coalesced: 0,
      deferred: 0,
      skipped: 0,
    });

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it("runs a bounded monitor for blocked work without reopening the issue", async () => {
    const { companyId, issueId, agentId } = await seedFixture({
      issueStatus: "blocked",
      monitor: { maxAttempts: 1 },
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "External blocker",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    await waitForHeartbeatIdle();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.status).toBe("blocked");
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.status).toBe("completed");

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeup!.runId!))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "issue_monitor_due",
      source: "issue.monitor",
      dependencyBlockedInteraction: true,
    });
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("preserves a due monitor as a deferred follow-up while the same owner is already running", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const activeWakeupId = randomUUID();
    const activeRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: activeWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: activeRunId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: activeWakeupId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
    });
    await db
      .update(issues)
      .set({
        executionRunId: activeRunId,
        executionAgentNameKey: "monitor bot",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: new Date("2026-04-11T12:00:00.000Z"),
      actorType: "user",
      actorId: "local-board",
    });

    expect(result).toMatchObject({
      outcome: "triggered",
      deliveryDisposition: "deferred",
      runId: null,
    });
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0] ?? null);
    expect(deferred?.id).toBe(result.wakeupRequestId);
    expect(deferred?.payload).toMatchObject({
      issueId,
      _paperclipWakeContext: {
        issueId,
        wakeReason: "issue_monitor_due",
      },
    });

    const triggerActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((row) => row.action === "issue.monitor_triggered") ?? null);
    expect(triggerActivity?.details).toMatchObject({ deliveryDisposition: "deferred" });

    await heartbeat.cancelRun(activeRunId, {
      suppressImmediateRecovery: true,
      reason: "Complete active run for monitor follow-up test",
    });
    await waitForHeartbeatIdle();

    const promotedWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferred!.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedWake?.status).toBe("completed");
    const promotedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.runId!))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("succeeded");
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "issue_monitor_due",
    });
  });

  it("keeps a human deferred comment separate when a later monitor generation becomes stale", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const activeWakeupId = randomUUID();
    const activeRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: activeWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: activeRunId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: activeWakeupId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
    });
    await db
      .update(issues)
      .set({
        executionRunId: activeRunId,
        executionAgentNameKey: "monitor bot",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    const comment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        body: "Please preserve this human follow-up.",
        authorType: "user",
        authorUserId: "local-board",
      })
      .returning()
      .then((rows) => rows[0]);

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: comment.id },
      contextSnapshot: {
        issueId,
        commentId: comment.id,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    })).toBeNull();
    const humanDeferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]);

    const monitorResult = await heartbeat.triggerIssueMonitor(issueId, {
      now: new Date("2026-04-11T12:00:00.000Z"),
      actorType: "user",
      actorId: "local-board",
    });
    expect(monitorResult).toMatchObject({ deliveryDisposition: "deferred" });
    const deferredBeforeReschedule = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
    expect(deferredBeforeReschedule).toHaveLength(2);
    expect(monitorResult.wakeupRequestId).not.toBe(humanDeferred.id);

    const replacementCheckAt = new Date("2026-04-11T14:30:00.000Z");
    const source = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    await db
      .update(issues)
      .set({
        monitorNextCheckAt: replacementCheckAt,
        monitorWakeRequestedAt: null,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            nextCheckAt: replacementCheckAt.toISOString(),
            notes: "Replacement generation",
            scheduledBy: "board",
          },
        },
        executionState: {
          ...parseIssueExecutionState(source.executionState),
          monitor: {
            status: "scheduled",
            nextCheckAt: replacementCheckAt.toISOString(),
            lastTriggeredAt: source.monitorLastTriggeredAt?.toISOString() ?? null,
            attemptCount: source.monitorAttemptCount ?? 0,
            notes: "Replacement generation",
            scheduledBy: "board",
            kind: null,
            serviceName: null,
            externalRef: null,
            timeoutAt: null,
            maxAttempts: null,
            recoveryPolicy: null,
            clearedAt: null,
            clearReason: null,
          },
        },
      })
      .where(eq(issues.id, issueId));

    await heartbeat.cancelRun(activeRunId, {
      suppressImmediateRecovery: true,
      reason: "Release deferred signal isolation test",
    });
    await waitForHeartbeatIdle();

    const deferredDeadline = Date.now() + 3_000;
    while (Date.now() < deferredDeadline) {
      const monitorStatus = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, monitorResult.wakeupRequestId!))
        .then((rows) => rows[0]?.status ?? null);
      if (monitorStatus !== "deferred_issue_execution") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const [humanAfter, monitorAfter] = await Promise.all([
      db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, humanDeferred.id))
        .then((rows) => rows[0]),
      db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, monitorResult.wakeupRequestId!))
        .then((rows) => rows[0]),
    ]);
    expect(humanAfter.status).toBe("completed");
    expect(humanAfter.runId).not.toBeNull();
    expect(monitorAfter).toMatchObject({
      status: "cancelled",
      runId: null,
    });
    expect(monitorAfter.error).toContain("generation changed");
    const humanRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, humanAfter.runId!))
      .then((rows) => rows[0]);
    expect(humanRun.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "issue_commented",
    });
  });

  it("does not dispatch or overwrite a claimed monitor after reassignment", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "Replacement Monitor",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    seededAgentIds.add(replacementAgentId);

    let releaseClaim!: () => void;
    let claimObserved!: () => void;
    const observed = new Promise<void>((resolve) => { claimObserved = resolve; });
    const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const heartbeat = heartbeatService(db, {
      afterIssueMonitorClaim: async () => {
        claimObserved();
        await release;
      },
    });

    const dispatch = heartbeat.triggerIssueMonitor(issueId, {
      now: new Date("2026-04-11T12:00:00.000Z"),
      actorType: "user",
      actorId: "local-board",
    });
    await observed;
    await db
      .update(issues)
      .set({
        assigneeAgentId: replacementAgentId,
        monitorNextCheckAt: null,
        monitorWakeRequestedAt: null,
        executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
      })
      .where(eq(issues.id, issueId));
    releaseClaim();

    await expect(dispatch).resolves.toMatchObject({
      outcome: "skipped",
      reason: "issue_monitor_claim_stale",
    });
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(issue.assigneeAgentId).toBe(replacementAgentId);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorWakeRequestedAt).toBeNull();
    const oldOwnerRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(oldOwnerRuns).toHaveLength(0);
  });

  it("does not consume a replacement schedule installed after the old monitor was claimed", async () => {
    const { issueId, agentId } = await seedFixture();
    const replacementCheckAt = new Date("2026-04-11T13:30:00.000Z");

    let releaseClaim!: () => void;
    let claimObserved!: () => void;
    const observed = new Promise<void>((resolve) => { claimObserved = resolve; });
    const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const heartbeat = heartbeatService(db, {
      afterIssueMonitorClaim: async () => {
        claimObserved();
        await release;
      },
    });

    const dispatch = heartbeat.triggerIssueMonitor(issueId, {
      now: new Date("2026-04-11T12:00:00.000Z"),
      actorType: "user",
      actorId: "local-board",
    });
    await observed;
    const current = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    await db
      .update(issues)
      .set({
        monitorNextCheckAt: replacementCheckAt,
        monitorWakeRequestedAt: null,
        monitorNotes: "Replacement schedule",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            nextCheckAt: replacementCheckAt.toISOString(),
            notes: "Replacement schedule",
            scheduledBy: "board",
          },
        },
        executionState: {
          ...parseIssueExecutionState(current.executionState),
          monitor: {
            status: "scheduled",
            nextCheckAt: replacementCheckAt.toISOString(),
            lastTriggeredAt: null,
            attemptCount: 0,
            notes: "Replacement schedule",
            scheduledBy: "board",
            kind: null,
            serviceName: null,
            externalRef: null,
            timeoutAt: null,
            maxAttempts: null,
            recoveryPolicy: null,
            clearedAt: null,
            clearReason: null,
          },
        },
      })
      .where(eq(issues.id, issueId));
    releaseClaim();

    await expect(dispatch).resolves.toMatchObject({
      outcome: "skipped",
      reason: "issue_monitor_claim_stale",
    });
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(replacementCheckAt.toISOString());
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(issue.monitorNotes).toBe("Replacement schedule");
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt)
      .toBe(replacementCheckAt.toISOString());
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("clears a permanently unavailable owner only after creating a durable board recovery path", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_recovery_board_path_created");
    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(action).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      cause: "issue_monitor_dispatch_skipped",
    });
  });

  it("treats wake-on-demand disablement as permanent and creates a typed recovery path", async () => {
    const { issueId } = await seedFixture({ wakeOnDemand: false });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    expect(result.skipped).toBe(1);
    const [issue, action] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!),
      db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(action).toMatchObject({
      status: "escalated",
      ownerType: "board",
      cause: "issue_monitor_dispatch_skipped",
    });
  });

  it("rearms transient monitor admission failures instead of clearing the only waiting path", async () => {
    const { companyId, issueId } = await seedFixture();
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:36:00.000Z");
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt)
      .toBe("2026-04-11T12:36:00.000Z");
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor).toMatchObject({
      maxAttempts: 3,
      timeoutAt: "2026-04-12T12:31:00.000Z",
    });
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      nextCheckAt: "2026-04-11T12:36:00.000Z",
      attemptCount: 1,
      maxAttempts: 3,
      timeoutAt: "2026-04-12T12:31:00.000Z",
    });
    expect(issue.monitorAttemptCount).toBe(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_rearmed");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
      modelProfile: "cheap",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it.each([
    {
      label: "exhausted",
      monitorAttemptCount: 1,
      monitor: { maxAttempts: 1, recoveryPolicy: "wake_owner" },
      clearReason: "max_attempts_exhausted",
      expectedAttemptCount: 2,
    },
    {
      label: "timed-out",
      monitorAttemptCount: 0,
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "wake_owner",
      },
      clearReason: "timeout_exceeded",
      expectedAttemptCount: 1,
    },
  ])(
    "runs $label owner recovery as a bounded interaction without reopening dependency-blocked work",
    async ({ monitorAttemptCount, monitor, clearReason, expectedAttemptCount }) => {
      const { companyId, issueId, agentId } = await seedFixture({
        issueStatus: "blocked",
        monitorAttemptCount,
        monitor,
      });
      const blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        title: "External dependency",
        status: "in_progress",
        priority: "medium",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      await waitForHeartbeatIdle();

      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);
      expect(issue.status).toBe("blocked");
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "cleared",
        clearReason,
      });

      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows.find((row) => row.reason === "issue_monitor_recovery") ?? null);
      expect(wakeup?.status).toBe("completed");

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeup!.runId!))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("succeeded");
      expect(run?.contextSnapshot).toMatchObject({
        issueId,
        source: "issue.monitor.recovery",
        wakeReason: "issue_monitor_recovery",
        monitorAttemptCount: expectedAttemptCount,
        clearReason,
        dependencyBlockedInteraction: true,
      });

      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
      expect(activity).toContain("issue.monitor_recovery_wake_queued");
      expect(activity).not.toContain("issue.monitor_recovery_wake_skipped");
    },
  );

  it("creates a durable board path when the configured recovery owner cannot be woken", async () => {
    const { issueId } = await seedFixture({
      wakeOnDemand: false,
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_recovery_board_path_created");
    expect(activity).not.toContain("issue.monitor_recovery_wake_queued");
    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(action).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      cause: "issue_monitor_max_attempts_exhausted",
    });
  });

  it.each([
    "wake_owner",
    "create_recovery_issue",
  ] as const)(
    "routes %s exhaustion to a durable board action when the owner terminates after monitor claim",
    async (recoveryPolicy) => {
      const { issueId, agentId } = await seedFixture({
        monitorAttemptCount: 1,
        monitor: { maxAttempts: 1, recoveryPolicy },
      });
      let releaseClaim!: () => void;
      let claimObserved!: () => void;
      const observed = new Promise<void>((resolve) => { claimObserved = resolve; });
      const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
      const heartbeat = heartbeatService(db, {
        afterIssueMonitorClaim: async ({ issueId: claimedIssueId }) => {
          if (claimedIssueId !== issueId) return;
          claimObserved();
          await release;
        },
      });

      const tick = heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
      await observed;
      await db
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));
      releaseClaim();
      await tick;

      const [source, action, recoveryIssue, monitorWake] = await Promise.all([
        db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0]!),
        db
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.sourceIssueId, issueId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(issues)
          .where(eq(issues.originId, issueId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.reason, "issue_monitor_recovery"))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(source).toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
      expect(action).toMatchObject({
        status: "escalated",
        ownerType: "board",
        ownerAgentId: null,
        cause: "issue_monitor_max_attempts_exhausted",
      });
      expect(monitorWake).toBeNull();
      if (recoveryPolicy === "create_recovery_issue") {
        expect(recoveryIssue).toMatchObject({ assigneeAgentId: null });
        expect(action?.recoveryIssueId).toBe(recoveryIssue?.id);
      } else {
        expect(recoveryIssue).toBeNull();
      }
    },
  );

  it("atomically assigns a bounded recovery action to an invokable manager without mutating source ownership", async () => {
    const { companyId, issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: { maxAttempts: 1, recoveryPolicy: "wake_owner" },
    });
    const managerAgentId = randomUUID();
    await db.insert(agents).values({
      id: managerAgentId,
      companyId,
      name: "Monitor Recovery Manager",
      role: "manager",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    seededAgentIds.add(managerAgentId);
    await db.update(agents).set({ reportsTo: managerAgentId }).where(eq(agents.id, agentId));

    let releaseClaim!: () => void;
    let claimObserved!: () => void;
    const observed = new Promise<void>((resolve) => { claimObserved = resolve; });
    const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const heartbeat = heartbeatService(db, {
      afterIssueMonitorClaim: async ({ issueId: claimedIssueId }) => {
        if (claimedIssueId !== issueId) return;
        claimObserved();
        await release;
      },
    });

    const tick = heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    await observed;
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
    releaseClaim();
    await tick;
    await waitForHeartbeatIdle();

    const [source, action] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!),
      db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(source).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    expect(action).toMatchObject({
      status: "active",
      ownerType: "agent",
      ownerAgentId: managerAgentId,
      maxAttempts: 1,
    });
  });

  it("does not admit an unbounded monitor recovery through the dependency interaction gate", async () => {
    const { companyId, issueId, agentId } = await seedFixture({ issueStatus: "blocked" });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unresolved external dependency",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_recovery",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        source: "issue.monitor.recovery",
        wakeReason: "issue_monitor_recovery",
        monitorAttemptCount: 1,
        clearReason: "timeout_exceeded",
        timeoutAt: "2099-01-01T00:00:00.000Z",
      },
    });

    expect(run).toBeNull();
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "issue_dependencies_blocked",
    });
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it.each([
    { recoveryPolicy: "create_recovery_issue" as const, concurrentChange: "reassign" as const },
    { recoveryPolicy: "escalate_to_board" as const, concurrentChange: "reschedule" as const },
  ])(
    "serializes $recoveryPolicy recovery with a concurrent source $concurrentChange",
    async ({ recoveryPolicy, concurrentChange }) => {
      const { companyId, issueId, agentId } = await seedFixture({
        monitorAttemptCount: 1,
        monitor: { maxAttempts: 1, recoveryPolicy },
      });
      let replacementAgentId: string | null = null;
      if (concurrentChange === "reassign") {
        replacementAgentId = randomUUID();
        await db.insert(agents).values({
          id: replacementAgentId,
          companyId,
          name: "Concurrent Replacement",
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
          permissions: {},
        });
        seededAgentIds.add(replacementAgentId);
      }

      let releaseRecovery!: () => void;
      let clearObserved!: () => void;
      const observed = new Promise<void>((resolve) => { clearObserved = resolve; });
      const release = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      const heartbeat = heartbeatService(db, {
        afterIssueMonitorClearBeforeRecovery: async ({ issueId: lockedIssueId }) => {
          if (lockedIssueId !== issueId) return;
          clearObserved();
          await release;
        },
      });

      const tick = heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
      await observed;

      const replacementCheckAt = new Date("2026-04-11T14:00:00.000Z");
      let sourceUpdateSettled = false;
      const sourceUpdate = (concurrentChange === "reassign"
        ? db
            .update(issues)
            .set({ assigneeAgentId: replacementAgentId })
            .where(eq(issues.id, issueId))
        : db
            .update(issues)
            .set({
              monitorNextCheckAt: replacementCheckAt,
              monitorWakeRequestedAt: null,
              executionPolicy: {
                mode: "normal",
                commentRequired: true,
                stages: [],
                monitor: {
                  nextCheckAt: replacementCheckAt.toISOString(),
                  scheduledBy: "board",
                  notes: "Concurrent replacement schedule",
                  maxAttempts: 1,
                  recoveryPolicy,
                },
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
                  nextCheckAt: replacementCheckAt.toISOString(),
                  lastTriggeredAt: null,
                  attemptCount: 0,
                  notes: "Concurrent replacement schedule",
                  scheduledBy: "board",
                  kind: null,
                  serviceName: null,
                  externalRef: null,
                  timeoutAt: null,
                  maxAttempts: 1,
                  recoveryPolicy,
                  clearedAt: null,
                  clearReason: null,
                },
              },
            })
            .where(eq(issues.id, issueId)))
        .then(() => { sourceUpdateSettled = true; });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sourceUpdateSettled).toBe(false);
      releaseRecovery();
      await Promise.all([tick, sourceUpdate]);

      if (recoveryPolicy === "create_recovery_issue") {
        const recoveryIssues = await db
          .select()
          .from(issues)
          .where(eq(issues.originId, issueId));
        expect(recoveryIssues).toHaveLength(1);
        expect(recoveryIssues[0]).toMatchObject({
          originKind: "stranded_issue_recovery",
          assigneeAgentId: agentId,
        });
      } else {
        const escalationComments = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));
        expect(escalationComments.filter((comment) =>
          comment.body.includes("Paperclip cleared the scheduled external-service monitor"),
        )).toHaveLength(1);
        const source = await db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0]!);
        expect(source.monitorNextCheckAt?.toISOString()).toBe(replacementCheckAt.toISOString());
        const recoveryAction = await db
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.sourceIssueId, issueId))
          .then((rows) => rows[0] ?? null);
        expect(recoveryAction).toMatchObject({
          status: "escalated",
          ownerType: "board",
          ownerAgentId: null,
          cause: "issue_monitor_max_attempts_exhausted",
        });
      }
    },
  );

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});
