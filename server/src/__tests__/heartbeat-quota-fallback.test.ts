import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const QUOTA_FALLBACK_TEST_ADAPTER = "quota_fallback_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quota fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat quota fallback reassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-quota-fallback-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: QUOTA_FALLBACK_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: {
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: QUOTA_FALLBACK_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // maybeFallbackReassign keeps writing heartbeat_run_events/activity/comments
    // after the run's terminal status is already visible (the reassignment wakes
    // the fallback agent as its last step), so a cleanup delete can race an
    // in-flight insert. Retrying just the failing table isn't enough: a fresh
    // heartbeat_run_events row can land after that table's delete already ran,
    // so re-run the whole ordered sequence from the top on any FK violation
    // (23503) instead of tightening the delete order.
    const runDeleteSequence = async () => {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(environmentLeases);
      await db.delete(issueComments);
      await db.delete(issueRelations);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(budgetPolicies);
      await db.delete(agents);
    };

    for (let attempt = 0; ; attempt++) {
      try {
        await runDeleteSequence();
        break;
      } catch (err) {
        const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
          ?? (err as { code?: string })?.code;
        if (code !== "23503" || attempt >= 20) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(QUOTA_FALLBACK_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function insertCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
  }

  async function insertAgent(input: {
    id: string;
    companyId: string;
    name: string;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    status?: string;
  }) {
    await db.insert(agents).values({
      id: input.id,
      companyId: input.companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "active",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  }

  // Fill the agent's single concurrency slot so wakes stay queued instead of
  // spawning the real local adapter binary during tests.
  async function occupyAgentSlots(companyId: string, agentId: string, now: Date) {
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation" as const,
        triggerDetail: "system" as const,
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );
  }

  async function seedFallbackFixture(input: {
    fallbackConfig?: Record<string, unknown>;
    errorFamily?: string | null;
    scheduledRetryAttempt?: number;
    issueStatus?: string;
    issueAssigneeAgentId?: string | null;
    fallbackAgent?: {
      insert?: boolean;
      companyId?: string;
      status?: string;
    };
    occupyFallbackAgentSlots?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const fallbackAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-01T12:00:00.000Z");

    await insertCompany(companyId);

    const fallbackAgentCompanyId = input.fallbackAgent?.companyId ?? companyId;
    if (fallbackAgentCompanyId !== companyId) {
      await insertCompany(fallbackAgentCompanyId);
    }

    await insertAgent({
      id: agentId,
      companyId,
      name: "PrimaryCoder",
      adapterConfig: {
        fallback: input.fallbackConfig ?? {
          enabled: true,
          agentId: fallbackAgentId,
          on: ["provider_quota"],
          when: "immediate",
        },
      },
    });

    if (input.fallbackAgent?.insert !== false) {
      await insertAgent({
        id: fallbackAgentId,
        companyId: fallbackAgentCompanyId,
        name: "FallbackCoder",
        status: input.fallbackAgent?.status ?? "active",
      });
      if (input.occupyFallbackAgentSlots !== false) {
        await occupyAgentSlots(fallbackAgentCompanyId, fallbackAgentId, now);
      }
    }

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "quota exhausted",
      errorCode: "provider_quota",
      finishedAt: now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: {
        errorFamily: input.errorFamily === undefined ? "provider_quota" : input.errorFamily,
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        transientRetryNotBefore: "2030-04-22T21:00:00.000Z",
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
      title: "Quota fallback issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: input.issueAssigneeAgentId === undefined ? agentId : input.issueAssigneeAgentId,
      executionRunId: runId,
      executionAgentNameKey: "primarycoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    return { companyId, agentId, fallbackAgentId, issueId, runId, now };
  }

  it("reassigns the issue to the fallback agent on a provider_quota failure with immediate fallback", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const fallbackAgentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await insertCompany(companyId);
    await insertAgent({
      id: agentId,
      companyId,
      name: "QuotaPrimary",
      adapterType: QUOTA_FALLBACK_TEST_ADAPTER,
      status: "idle",
      adapterConfig: {
        fallback: {
          enabled: true,
          agentId: fallbackAgentId,
          on: ["provider_quota"],
          when: "immediate",
        },
      },
    });
    await insertAgent({
      id: fallbackAgentId,
      companyId,
      name: "QuotaFallback",
      adapterType: "codex_local",
    });
    await occupyAgentSlots(companyId, fallbackAgentId, now);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Quota fallback end to end",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {
      issueId,
      wakeReason: "issue_assigned",
    }, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ assigneeAgentId: issues.assigneeAgentId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0]?.assigneeAgentId ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(fallbackAgentId);

    // maybeFallbackReassign updates issues.assigneeAgentId first and only
    // afterward writes the activity log entry, comment, and run event, so
    // wait for its last side effect (the run event) before asserting on the
    // earlier ones — otherwise the assigneeAgentId poll above can resolve
    // while the activity/comment writes are still in flight.
    await expect
      .poll(
        () =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(heartbeatRunEvents)
            .where(
              and(
                eq(heartbeatRunEvents.runId, run!.id),
                sql`${heartbeatRunEvents.message} like 'Quota fallback reassigned issue to agent%'`,
              ),
            )
            .then((rows) => rows[0]?.count ?? 0),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    // No same-agent retry is scheduled when the fallback fires.
    const sameAgentRetries = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0]?.count ?? 0);
    expect(sameAgentRetries).toBe(0);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.quota_fallback_reassigned"))
      .then((rows) => rows[0] ?? null);
    expect(activity).not.toBeNull();
    expect(activity?.entityId).toBe(issueId);
    expect(activity?.details).toMatchObject({
      fromAgentId: agentId,
      toAgentId: fallbackAgentId,
      errorFamily: "provider_quota",
      runId: run!.id,
    });

    const persistedRun = await heartbeat.getRun(run!.id, { unsafeFullResultJson: true });
    const fallbackMarker = (persistedRun?.resultJson as Record<string, unknown> | null)?.fallback as
      | Record<string, unknown>
      | undefined;
    expect(fallbackMarker).toMatchObject({ toAgentId: fallbackAgentId });
    expect(typeof fallbackMarker?.at).toBe("string");

    const comment = await db
      .select({ issueId: issueComments.issueId, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(comment).not.toBeNull();
    expect(comment?.body ?? "").toContain("fallback");
  });

  it("keeps existing parking/retry behavior when fallback is disabled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const fallbackAgentId = randomUUID();
    const issueId = randomUUID();

    await insertCompany(companyId);
    await insertAgent({
      id: agentId,
      companyId,
      name: "QuotaPrimary",
      adapterType: QUOTA_FALLBACK_TEST_ADAPTER,
      status: "idle",
      adapterConfig: {
        fallback: {
          enabled: false,
          agentId: fallbackAgentId,
          on: ["provider_quota"],
          when: "immediate",
        },
      },
    });
    await insertAgent({ id: fallbackAgentId, companyId, name: "QuotaFallback" });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Quota fallback disabled",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {
      issueId,
      wakeReason: "issue_assigned",
    }, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.agentId).toBe(agentId);
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(agentId);

    const activityCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.quota_fallback_reassigned"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(activityCount).toBe(0);
  });

  it("with when retries_exhausted, keeps normal retries until attempts run out and then reassigns", async () => {
    const notExhausted = await seedFallbackFixture({
      fallbackConfig: undefined,
      scheduledRetryAttempt: 0,
    });
    await db
      .update(agents)
      .set({
        adapterConfig: {
          fallback: {
            enabled: true,
            agentId: notExhausted.fallbackAgentId,
            on: ["provider_quota"],
            when: "retries_exhausted",
          },
        },
      })
      .where(eq(agents.id, notExhausted.agentId));

    const early = await heartbeat.maybeFallbackReassign(notExhausted.runId);
    expect(early.outcome).toBe("not_applicable");

    const issueBefore = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, notExhausted.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueBefore?.assigneeAgentId).toBe(notExhausted.agentId);

    // The normal bounded retry path still works before exhaustion.
    const scheduled = await heartbeat.scheduleBoundedRetry(notExhausted.runId, {
      now: notExhausted.now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");

    // Now a run that has already burned all bounded retry attempts.
    const exhausted = await seedFallbackFixture({
      fallbackConfig: undefined,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
    await db
      .update(agents)
      .set({
        adapterConfig: {
          fallback: {
            enabled: true,
            agentId: exhausted.fallbackAgentId,
            on: ["provider_quota"],
            when: "retries_exhausted",
          },
        },
      })
      .where(eq(agents.id, exhausted.agentId));

    const result = await heartbeat.maybeFallbackReassign(exhausted.runId);
    expect(result).toMatchObject({
      outcome: "reassigned",
      toAgentId: exhausted.fallbackAgentId,
      issueId: exhausted.issueId,
    });

    const issueAfter = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, exhausted.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueAfter?.assigneeAgentId).toBe(exhausted.fallbackAgentId);
  });

  it("falls back to existing behavior with a warning when the fallback agent is missing", async () => {
    const fixture = await seedFallbackFixture({
      fallbackAgent: { insert: false },
    });

    const result = await heartbeat.maybeFallbackReassign(fixture.runId);
    expect(result.outcome).toBe("not_applied");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(fixture.agentId);

    const warnEvent = await db
      .select({ level: heartbeatRunEvents.level, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, fixture.runId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);
    expect(warnEvent?.level).toBe("warn");
    expect(warnEvent?.message ?? "").toContain("fallback");

    // Existing retry behavior is still available.
    const scheduled = await heartbeat.scheduleBoundedRetry(fixture.runId, {
      now: fixture.now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
  });

  it("does not fall back to the same agent", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-01T13:00:00.000Z");

    await insertCompany(companyId);
    await insertAgent({
      id: agentId,
      companyId,
      name: "PrimaryCoder",
      adapterConfig: {
        fallback: { enabled: true, agentId, on: ["provider_quota"], when: "immediate" },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "quota exhausted",
      errorCode: "provider_quota",
      finishedAt: now,
      resultJson: { errorFamily: "provider_quota" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Same agent fallback",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const result = await heartbeat.maybeFallbackReassign(runId);
    expect(result.outcome).toBe("not_applied");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(agentId);
  });

  it("does not fall back to an agent in another company", async () => {
    const fixture = await seedFallbackFixture({
      fallbackAgent: { companyId: randomUUID() },
    });

    const result = await heartbeat.maybeFallbackReassign(fixture.runId);
    expect(result.outcome).toBe("not_applied");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(fixture.agentId);
  });

  it("does not fall back to a non-invokable (paused) agent", async () => {
    const fixture = await seedFallbackFixture({
      fallbackAgent: { status: "paused" },
    });

    const result = await heartbeat.maybeFallbackReassign(fixture.runId);
    expect(result.outcome).toBe("not_applied");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(fixture.agentId);
  });

  it("does not fall back for error families outside the configured triggers", async () => {
    const fixture = await seedFallbackFixture({
      errorFamily: "model_refusal",
    });

    const result = await heartbeat.maybeFallbackReassign(fixture.runId);
    expect(result.outcome).toBe("not_applicable");

    const issue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.assigneeAgentId).toBe(fixture.agentId);

    const activityCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.quota_fallback_reassigned"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(activityCount).toBe(0);
  });
});
