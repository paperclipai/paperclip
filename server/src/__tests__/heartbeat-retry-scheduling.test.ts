import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: "codex_local" | "claude_local";
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? {
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: {
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: expect.objectContaining({ modelProfile: "cheap" }),
    });
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date("2026-04-20T12:01:59.000Z"));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("schedules max-turn continuations with distinct retry metadata", async () => {
    const { runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(new Date(now.getTime() + 1_000).toISOString());

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      retryOfRunId: runId,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
  });

  it("coalesces duplicate max-turn continuation schedules for the same source run and attempt", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture();
    const retryOptions = {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    };

    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, runId),
          eq(heartbeatRuns.scheduledRetryReason, MAX_TURN_CONTINUATION_RETRY_REASON),
          eq(heartbeatRuns.scheduledRetryAttempt, 1),
        ),
      );
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it("does not promote a duplicate max-turn continuation that does not own the issue lock", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const duplicateWakeupId = randomUUID();
    const duplicateRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: MAX_TURN_CONTINUATION_WAKE_REASON,
      payload: {
        issueId,
        retryOfRunId: runId,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: duplicateWakeupId,
      retryOfRunId: runId,
      scheduledRetryAt: scheduled.dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: duplicateRunId })
      .where(eq(agentWakeupRequests.id, duplicateWakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const duplicate = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, duplicateRunId))
      .then((rows) => rows[0] ?? null);
    expect(duplicate).toEqual({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
    });

    const duplicateWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("cancelled");
  });

  it.each(["blocked", "todo", "backlog"] as const)(
    "does not schedule a max-turn continuation when the issue is already %s",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });

      expect(scheduled).toMatchObject({
        outcome: "not_scheduled",
        errorCode: "issue_not_in_progress",
        issueId,
      });

      const retryRuns = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0]?.count ?? 0);
      expect(retryRuns).toBe(0);
    },
  );

  it.each(["blocked", "todo", "backlog"] as const)(
    "cancels a due max-turn continuation when the issue moves to %s before retry promotion",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture();

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      await db.update(issues).set({
        status: issueStatus,
        updatedAt: new Date(now.getTime() + 500),
      }).where(eq(issues.id, issueId));

      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(promotion).toEqual({ promoted: 0, runIds: [] });

      const retryRun = await db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "cancelled",
        errorCode: "issue_not_in_progress",
      });

      const wakeupRequest = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect(wakeupRequest?.status).toBe("cancelled");

      const issue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      const event = await db
        .select({
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, scheduled.run.id))
        .orderBy(sql`${heartbeatRunEvents.seq} desc`)
        .then((rows) => rows[0] ?? null);
      expect(event?.message).toContain("no longer in_progress");
      expect(event?.payload).toMatchObject({
        currentStatus: issueStatus,
        requiredStatus: "in_progress",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      });
    },
  );

  it("does not queue max-turn continuations after the configured cap", async () => {
    const { runId, now } = await seedMaxTurnFixture({ scheduledRetryAttempt: 2 });

    const exhausted = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: 3,
      maxAttempts: 2,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);
    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      maxAttempts: 2,
    });
  });

  it("suppresses max-turn continuation scheduling when budget or dependencies block the issue", async () => {
    const budgetBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T16:00:00.000Z") });
    await db.insert(budgetPolicies).values({
      companyId: budgetBlocked.companyId,
      scopeType: "agent",
      scopeId: budgetBlocked.agentId,
      windowKind: "monthly",
      metric: "billed_cents",
      amount: 0,
      hardStopEnabled: true,
      isActive: true,
    });
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget" })
      .where(eq(agents.id, budgetBlocked.agentId));

    const budgetResult = await heartbeat.scheduleBoundedRetry(budgetBlocked.runId, {
      now: budgetBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(budgetResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "budget_blocked",
      issueId: budgetBlocked.issueId,
    });

    await db.delete(budgetPolicies);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);

    const dependencyBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T17:00:00.000Z") });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: dependencyBlocked.companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
      identifier: `T${dependencyBlocked.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });
    await db.insert(issueRelations).values({
      companyId: dependencyBlocked.companyId,
      issueId: blockerId,
      relatedIssueId: dependencyBlocked.issueId,
      type: "blocks",
    });

    const dependencyResult = await heartbeat.scheduleBoundedRetry(dependencyBlocked.runId, {
      now: dependencyBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(dependencyResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_dependencies_blocked",
      issueId: dependencyBlocked.issueId,
    });

    const retryRuns = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, dependencyBlocked.runId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(retryRuns).toBe(0);
  });

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
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
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);
  });

  it("does not promote a scheduled retry after issue ownership changes", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
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
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion reassignment",
      status: "todo",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not promote a scheduled retry after the issue is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T15:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion cancellation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      status: "cancelled",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_cancelled",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
      "fresh_session",
      "fresh_session_safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agents);
      await db.delete(companies);
    }
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });
});
