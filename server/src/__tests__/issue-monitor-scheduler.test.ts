import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
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
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue monitor scheduler test run.",
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

  function createHeartbeat() {
    return heartbeatService(db);
  }

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

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 15_000, quietMs = 500) {
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

  async function waitForIssueRunTerminalState(issueId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
        .orderBy(sql`${heartbeatRuns.createdAt} desc`)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (run && !["queued", "running", "scheduled_retry"].includes(run.status)) {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor run to finish");
  }

  async function waitForMonitorRearm(issueId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
      if (issue?.monitorNextCheckAt) return issue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor rearm");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
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
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Issue monitor scheduler test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
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
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
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
      defaultResponsibleUserId: "responsible-user",
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
          wakeOnDemand: true,
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

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

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

  it("re-arms a scheduled monitor when the wake coalesces onto a foreign issue run", async () => {
    const { companyId, agentId, issueId: monitorIssueId } = await seedFixture();
    const activeIssueId = randomUUID();
    const activeRunId = randomUUID();
    await db.insert(issues).values({
      id: activeIssueId,
      companyId,
      title: "Currently running work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: {
        issueId: activeIssueId,
        wakeReason: "issue_assigned",
      },
      startedAt: new Date(),
    });
    const heartbeat = createHeartbeat();

    // Reproduce the stale foreign execution lock carrier using the live dispatch path
    // for the monitor wake itself.
    await db.update(issues).set({
      executionRunId: activeRunId,
      executionAgentNameKey: "monitorbot",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, monitorIssueId));

    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, monitorIssueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).not.toBeNull();
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
    expect(issue.monitorAttemptCount).toBe(0);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor?.nextCheckAt).toBe(
      issue.monitorNextCheckAt?.toISOString(),
    );
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      attemptCount: 0,
      nextCheckAt: issue.monitorNextCheckAt?.toISOString(),
    });

    const coalescedWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "coalesced"))
      .then((rows) => rows[0] ?? null);
    expect(coalescedWake?.reason).toBe("issue_execution_same_name");
    await db.update(heartbeatRuns).set({
      status: "failed",
      errorCode: "test_cleanup",
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, activeRunId));
  }, 20_000);

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
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
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    const heartbeat = createHeartbeat();

    const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    expect(result.enqueued).toBe(1);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, participantAgentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = createHeartbeat();
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

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = createHeartbeat();
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
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("reconciles a triggered monitor back onto a timer when dispatch created no run", async () => {
    const { issueId, agentId } = await seedFixture();
    await db.update(agents).set({
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
          maxDailyRuns: 0,
        },
      },
    }).where(eq(agents.id, agentId));
    const heartbeat = createHeartbeat();
    const firstTickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(firstTickAt);

    const strandedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(strandedIssue.monitorNextCheckAt).toBeNull();
    expect(strandedIssue.monitorAttemptCount).toBe(1);
    expect(strandedIssue.monitorLastTriggeredAt?.toISOString()).toBe(firstTickAt.toISOString());
    expect(parseIssueExecutionState(strandedIssue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      attemptCount: 1,
    });
    const initialRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, strandedIssue.companyId));
    expect(initialRuns).toHaveLength(0);

    const reconcileTickAt = new Date("2026-04-11T12:37:00.000Z");
    await heartbeat.tickTimers(reconcileTickAt);

    const repairedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(repairedIssue.monitorNextCheckAt).not.toBeNull();
    expect(repairedIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(reconcileTickAt.getTime());
    expect(repairedIssue.monitorAttemptCount).toBe(0);
    expect(parseIssueExecutionState(repairedIssue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      attemptCount: 0,
      nextCheckAt: repairedIssue.monitorNextCheckAt?.toISOString(),
    });
  });

  it("backs off monitor claim failures instead of leaving the wake path destroyed", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const heartbeat = createHeartbeat();
    const conflictingRunId = randomUUID();
    const conflictingIssueId = randomUUID();
    const conflictOriginId = randomUUID();
    const conflictOriginFingerprint = "dispatch-fingerprint-1";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(heartbeatRuns).values({
      id: conflictingRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        issueId: conflictingIssueId,
        wakeReason: "issue_assigned",
      },
      startedAt: new Date("2026-04-11T12:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: conflictingIssueId,
      companyId,
      title: "Conflicting routine execution",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "routine_execution",
      originId: conflictOriginId,
      originFingerprint: conflictOriginFingerprint,
      executionRunId: conflictingRunId,
      executionAgentNameKey: "monitorbot",
      executionLockedAt: new Date("2026-04-11T12:00:00.000Z"),
    });
    await db.update(issues).set({
      originKind: "routine_execution",
      originId: conflictOriginId,
      originFingerprint: conflictOriginFingerprint,
    }).where(eq(issues.id, issueId));

    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    await heartbeat.tickTimers(tickAt);
    const run = await waitForIssueRunTerminalState(issueId);
    await db.update(heartbeatRuns).set({
      status: "failed",
      errorCode: "test_cleanup",
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, conflictingRunId));

    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("issue_monitor_claim_failed");

    const repairedIssue = await waitForMonitorRearm(issueId);

    expect(repairedIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
    expect(repairedIssue.monitorAttemptCount).toBe(0);
    expect(parseIssueExecutionState(repairedIssue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      attemptCount: 0,
      nextCheckAt: repairedIssue.monitorNextCheckAt?.toISOString(),
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_rearmed");
  }, 20_000);

  it("re-arms provider quota monitor failures at the reported reset time and keeps the monitor visible", async () => {
    const { issueId } = await seedFixture();
    const heartbeat = createHeartbeat();
    const retryNotBefore = new Date("2026-08-03T09:00:00.000Z");

    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "You've hit your weekly limit · resets Aug 3 at 11am (Europe/Zurich)",
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: retryNotBefore.toISOString(),
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: retryNotBefore.toISOString(),
        transientRetryNotBefore: retryNotBefore.toISOString(),
        providerQuotaRetryNotBefore: retryNotBefore.toISOString(),
      },
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.tickTimers(new Date("2026-07-29T18:31:00.000Z"));
    const run = await waitForIssueRunTerminalState(issueId);
    const repairedIssue = await waitForMonitorRearm(issueId);

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("provider_quota");
    expect(repairedIssue.monitorNextCheckAt?.toISOString()).toBe(retryNotBefore.toISOString());
    expect(normalizeIssueExecutionPolicy(repairedIssue.executionPolicy ?? null)?.monitor?.nextCheckAt).toBe(
      retryNotBefore.toISOString(),
    );
    expect(parseIssueExecutionState(repairedIssue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      nextCheckAt: retryNotBefore.toISOString(),
      attemptCount: 0,
    });
  }, 20_000);

  it("backs off repeated failed monitor wakes for the same issue", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const heartbeat = createHeartbeat();

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      invocationSource: "automation",
      triggerDetail: "system",
      error: "temporary upstream error",
      errorCode: "adapter_failed",
      contextSnapshot: {
        issueId,
        wakeReason: "issue_monitor_due",
      },
      createdAt: new Date("2026-07-29T18:20:00.000Z"),
      updatedAt: new Date("2026-07-29T18:21:00.000Z"),
      startedAt: new Date("2026-07-29T18:20:00.000Z"),
      finishedAt: new Date("2026-07-29T18:21:00.000Z"),
    });

    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "temporary upstream error",
      errorCode: "adapter_failed",
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.tickTimers(new Date("2026-07-29T18:31:00.000Z"));
    const run = await waitForIssueRunTerminalState(issueId);
    const repairedIssue = await waitForMonitorRearm(issueId);
    const backoffMs = repairedIssue.monitorNextCheckAt!.getTime() - run.finishedAt!.getTime();

    expect(run.status).toBe("failed");
    expect(backoffMs).toBeGreaterThanOrEqual(300_000 - 5_000);
    expect(backoffMs).toBeLessThanOrEqual(300_000 + 5_000);
    expect(normalizeIssueExecutionPolicy(repairedIssue.executionPolicy ?? null)?.monitor?.nextCheckAt).toBe(
      repairedIssue.monitorNextCheckAt?.toISOString(),
    );
  }, 20_000);

  it("resets monitor failure backoff after a successful monitor wake", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const heartbeat = createHeartbeat();

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed",
        invocationSource: "automation",
        triggerDetail: "system",
        error: "temporary upstream error",
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId,
          wakeReason: "issue_monitor_due",
        },
        createdAt: new Date("2026-07-29T18:10:00.000Z"),
        updatedAt: new Date("2026-07-29T18:11:00.000Z"),
        startedAt: new Date("2026-07-29T18:10:00.000Z"),
        finishedAt: new Date("2026-07-29T18:11:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: {
          issueId,
          wakeReason: "issue_monitor_due",
        },
        createdAt: new Date("2026-07-29T18:20:00.000Z"),
        updatedAt: new Date("2026-07-29T18:21:00.000Z"),
        startedAt: new Date("2026-07-29T18:20:00.000Z"),
        finishedAt: new Date("2026-07-29T18:21:00.000Z"),
      },
    ]);

    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "temporary upstream error",
      errorCode: "adapter_failed",
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.tickTimers(new Date("2026-07-29T18:31:00.000Z"));
    const run = await waitForIssueRunTerminalState(issueId);
    const repairedIssue = await waitForMonitorRearm(issueId);
    const backoffMs = repairedIssue.monitorNextCheckAt!.getTime() - run.finishedAt!.getTime();

    expect(run.status).toBe("failed");
    expect(backoffMs).toBeGreaterThanOrEqual(150_000 - 5_000);
    expect(backoffMs).toBeLessThanOrEqual(150_000 + 5_000);
  }, 20_000);

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = createHeartbeat();
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

  }, 20_000);

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = createHeartbeat();
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

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = createHeartbeat();
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
