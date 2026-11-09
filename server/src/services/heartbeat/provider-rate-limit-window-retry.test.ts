import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import {
  PROVIDER_RATE_LIMIT_WINDOW_RETRY_JITTER_MS,
  PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS,
  isProviderRateLimitWindowRun,
  providerRateLimitWindowRetriesSpent,
} from "../execution-recovery-attempt.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";
import { classifyAdapterFailureForRecovery } from "../recovery/service.js";
import { buildStrandedRecoveryEscalationNotice } from "../recovery/stranded-notice.js";
import { createHeartbeatRetries, BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS, boundedRetryMaxAttemptsForRun } from "./retries.js";
import type { HeartbeatRetryDependencies } from "./retries.js";
import { createHeartbeatRunState, shouldResetTaskSessionForWake } from "./run-state.js";
import { pendingCaseHandoffForRun } from "./case-handoff-lifecycle.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

const now = new Date("2026-11-09T10:00:00.000Z");
const QUARTER_HOUR_MS = 15 * 60_000;

const rateLimitWindowRun = { errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota", rateLimitWindow: true } };
const subscriptionQuotaRun = { errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota" } };
const transientRun = { errorCode: "claude_transient_upstream", resultJson: { errorFamily: "transient_upstream" } };

function accounting(failureRetries: number) {
  return { executionRetryAccounting: { version: 1, failureRetries, maxTurnContinuations: 0 } };
}

describe("the retry budget of a provider rate-limit window", () => {
  it("is its own count, above the bounded default, for the marked run alone", () => {
    expect(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS).toBeGreaterThan(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS);
    expect(boundedRetryMaxAttemptsForRun(rateLimitWindowRun as unknown as Run)).toBe(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS);
    for (const other of [subscriptionQuotaRun, transientRun, { errorCode: "adapter_failed", resultJson: null }]) {
      expect(boundedRetryMaxAttemptsForRun(other as unknown as Run)).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS);
    }
  });

  it("needs the provider_quota code and the adapter's marker together", () => {
    expect(isProviderRateLimitWindowRun(rateLimitWindowRun)).toBe(true);
    expect(isProviderRateLimitWindowRun({ errorCode: "adapter_failed", resultJson: { rateLimitWindow: true } })).toBe(false);
    expect(isProviderRateLimitWindowRun({ errorCode: "provider_quota", resultJson: { rateLimitWindow: "true" } })).toBe(false);
    expect(isProviderRateLimitWindowRun({ errorCode: "provider_quota", resultJson: null })).toBe(false);
    expect(isProviderRateLimitWindowRun(subscriptionQuotaRun)).toBe(false);
  });

  it("is spent after the last attempt and not before", () => {
    for (let used = 0; used < PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS; used += 1) {
      expect(providerRateLimitWindowRetriesSpent({ ...rateLimitWindowRun, contextSnapshot: accounting(used) })).toBe(false);
    }
    expect(providerRateLimitWindowRetriesSpent({
      ...rateLimitWindowRun, contextSnapshot: accounting(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS),
    })).toBe(true);
    expect(providerRateLimitWindowRetriesSpent({ ...subscriptionQuotaRun, contextSnapshot: accounting(9) })).toBe(false);
  });
});

describe("what recovery does with a failed rate-limit window", () => {
  const failed = (shape: { errorCode: string; resultJson: Record<string, unknown> }, failureRetries: number) => ({
    runtimeMode: "legacy", status: "failed", ...shape, contextSnapshot: accounting(failureRetries),
  }) as unknown as Parameters<typeof legacyExecutionNeedsReconciliation>[0];

  it("lets the retry run until the last attempt has failed, and holds the issue for reconciliation then", () => {
    for (let used = 0; used < PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS; used += 1) {
      expect(legacyExecutionNeedsReconciliation(failed(rateLimitWindowRun, used))).toBe(false);
    }
    expect(legacyExecutionNeedsReconciliation(failed(rateLimitWindowRun, PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS))).toBe(true);
  });

  it("holds a rate-limit window that left a background task behind", () => {
    const withTask = failed({ ...rateLimitWindowRun, resultJson: { ...rateLimitWindowRun.resultJson, unmanagedBackgroundTask: { stopped: true } } }, 0);
    expect(legacyExecutionNeedsReconciliation(withTask)).toBe(true);
  });

  it("titles the board's notice for a rate-limit window apart from a usage limit", () => {
    const notice = (rateLimitWindow: boolean) => buildStrandedRecoveryEscalationNotice({
      recoveryCause: "provider_quota", recoveryActionId: "action", recoveryOwner: null,
      sourceRun: { id: "run", status: "failed", errorCode: "provider_quota", rateLimitWindow },
    }).presentation;
    expect(notice(true)).toMatchObject({ title: "Error: model rate limit reached" });
    expect(notice(false)).toMatchObject({ title: "Error: usage limit reached" });
  });

  it("holds every other failed run as before", () => {
    expect(legacyExecutionNeedsReconciliation(failed(subscriptionQuotaRun, 0))).toBe(true);
    expect(legacyExecutionNeedsReconciliation(failed(transientRun, 0))).toBe(true);
    expect(legacyExecutionNeedsReconciliation(failed({ errorCode: "adapter_failed", resultJson: { rateLimitWindow: true } }, 0))).toBe(true);
  });

  it("waits for the quota reset while retries are left and never again after the last one", () => {
    const retryAt = new Date(now.getTime() + QUARTER_HOUR_MS).toISOString();
    const run = (failureRetries: number) => ({
      errorCode: "provider_quota", error: "rate limit", contextSnapshot: accounting(failureRetries),
      resultJson: { ...rateLimitWindowRun.resultJson, retryNotBefore: retryAt },
    });
    const last = PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS;
    expect(classifyAdapterFailureForRecovery(run(last - 1), now)).toMatchObject({ kind: "provider_quota", retryAt: new Date(retryAt) });
    expect(classifyAdapterFailureForRecovery(run(last), now)).toBeNull();
    expect(classifyAdapterFailureForRecovery({ ...run(last), resultJson: { errorFamily: "provider_quota", retryNotBefore: retryAt } }, now))
      .toMatchObject({ kind: "provider_quota" });
  });
});

function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected retry database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

function dependencies() {
  return {
    hasCaseHandoffForRun: vi.fn<HeartbeatRetryDependencies["hasCaseHandoffForRun"]>(async () => false),
    getRun: vi.fn<HeartbeatRetryDependencies["getRun"]>(async () => null),
    getAgent: vi.fn<HeartbeatRetryDependencies["getAgent"]>(async () => undefined),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    resolveResponsibleUserIdForRunContext: vi.fn(async () => "retry-user"),
    getAgentInvokability: vi.fn<HeartbeatRetryDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    appendRunEvent: vi.fn<HeartbeatRetryDependencies["appendRunEvent"]>(async () => undefined),
    escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
    recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
    setRunStatusIfRunning: vi.fn<HeartbeatRetryDependencies["setRunStatusIfRunning"]>(async () => ({ updated: false, run: null })),
    setWakeupStatus: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getWorktreeExecutionCutoff: vi.fn(async (): Promise<Date | null> => null),
    applyRunDispatchPostCommitEffects: vi.fn(),
    runDispatch: {
      nextScheduledRetryAt: vi.fn<HeartbeatRetryDependencies["runDispatch"]["nextScheduledRetryAt"]>(async () => null),
      evaluateScheduledRetryGate: vi.fn<HeartbeatRetryDependencies["runDispatch"]["evaluateScheduledRetryGate"]>(async () => ({ allowed: true })),
      promoteDueScheduledRetries: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteDueScheduledRetries"]>(async () => ({ promoted: 0, runIds: [], postCommitEffects: [] })),
      promoteScheduledRetry: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteScheduledRetry"]>(async () => ({ outcome: "not_promoted" })),
    },
  } satisfies HeartbeatRetryDependencies;
}

function failedRun(shape: { errorCode: string; resultJson: Record<string, unknown>; failureRetries: number }): Run {
  return {
    id: "run", companyId: "company", agentId: "agent", status: "failed",
    scopeKind: "issue", issueId: "issue", wakeupRequestId: "wake",
    errorCode: shape.errorCode, resultJson: shape.resultJson, scheduledRetryAttempt: shape.failureRetries,
    contextSnapshot: { issueId: "issue", ...accounting(shape.failureRetries) },
  } as unknown as Run;
}

describe("scheduling the last attempt of a rate-limit window", () => {
  // The exhaustion branch records the event and reads no row.
  it.each([
    ["a rate-limit window", rateLimitWindowRun, PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS, PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS],
    ["a Claude subscription quota", subscriptionQuotaRun, 2, BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS],
    ["a transient upstream failure", transientRun, 2, BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS],
  ])("stops %s at its own budget", async (_name, shape, used, budget) => {
    const database = guardedDatabase();
    const deps = dependencies();
    const run = failedRun({ ...shape, failureRetries: used });
    const result = await createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(run, { adapterType: "claude_local" } as Agent, { now });
    expect(result).toEqual({ outcome: "retry_exhausted", attempt: used + 1, maxAttempts: budget });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: "transient_failure", scheduledRetryAttempt: used, maxAttempts: budget },
    }));
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping rate-limit window retry PostgreSQL tests: ${support.reason ?? "unsupported host"}`);

describePostgres("scheduling a retry for a rate-limit window", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("rate-limit-window-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => { await database?.cleanup(); });

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  function boundRetries() {
    const state = createHeartbeatRunState(db);
    return createHeartbeatRetries(db, {
      ...dependencies(), getRun: state.getRun, getAgent: state.getAgent,
      hasCaseHandoffForRun: async (run: Pick<Run, "id" | "companyId">) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
      resolveSessionBeforeForWakeup: state.resolveSessionBeforeForWakeup,
      getAgentInvokability: (agent: Agent | null | undefined) => evaluateAgentInvokabilityFromDb(db, agent),
      runDispatch: createRunDispatch(db),
    });
  }

  async function failedRunWithRetries(
    failureRetries: number,
    shape: { errorCode: string; resultJson: Record<string, unknown> },
  ) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Window", issuePrefix: `W${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Window agent", adapterType: "claude_local", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Window task", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "failed", errorCode: shape.errorCode, finishedAt: now,
      scheduledRetryAttempt: failureRetries, scheduledRetryReason: failureRetries > 0 ? "transient_failure" : null,
      resultJson: shape.resultJson,
      contextSnapshot: { issueId: issue.id, taskKey: "window-task", ...accounting(failureRetries) },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, run };
  }

  const windowResult = (retryNotBefore: Date) => ({
    errorFamily: "provider_quota", rateLimitWindow: true,
    retryNotBefore: retryNotBefore.toISOString(), providerQuotaRetryNotBefore: retryNotBefore.toISOString(),
  });

  it.each([0, 1, 2, 3])("schedules attempt %i + 1 at the adapter's retryNotBefore, 15 minutes out", async (used) => {
    const { run, agent, companyId } = await failedRunWithRetries(used, {
      errorCode: "provider_quota", resultJson: windowResult(new Date(now.getTime() + QUARTER_HOUR_MS)),
    });
    const result = await boundRetries().scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 });
    expect(result).toMatchObject({ outcome: "scheduled" });
    const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run.id)));
    expect(retry).toMatchObject({
      status: "scheduled_retry", scheduledRetryAttempt: used + 1, scheduledRetryReason: "transient_failure",
    });
    expect(retry.scheduledRetryAt?.toISOString()).toBe(new Date(now.getTime() + QUARTER_HOUR_MS).toISOString());
    expect(retry.contextSnapshot).toMatchObject({
      errorFamily: "provider_quota", ...accounting(used + 1),
      providerQuotaRetryNotBefore: new Date(now.getTime() + QUARTER_HOUR_MS).toISOString(),
    });
  });

  it("adds up to a minute of jitter on top of retryNotBefore", async () => {
    const notBefore = now.getTime() + QUARTER_HOUR_MS;
    for (const [random, jitterMs] of [[0, 0], [0.5, 30_000], [0.999, 59_940]] as const) {
      const { run, agent } = await failedRunWithRetries(0, { errorCode: "provider_quota", resultJson: windowResult(new Date(notBefore)) });
      await boundRetries().scheduleBoundedRetryForRun(run, agent, { now, random: () => random });
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(retry.scheduledRetryAt?.getTime()).toBe(notBefore + jitterMs);
      expect(jitterMs).toBeLessThan(PROVIDER_RATE_LIMIT_WINDOW_RETRY_JITTER_MS);
    }
  });

  it("gives up after the last attempt and queues nothing", async () => {
    const { run, agent, companyId } = await failedRunWithRetries(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS, {
      errorCode: "provider_quota", resultJson: windowResult(new Date(now.getTime() + QUARTER_HOUR_MS)),
    });
    expect(await boundRetries().scheduleBoundedRetryForRun(run, agent, { now })).toEqual({
      outcome: "retry_exhausted",
      attempt: PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS + 1,
      maxAttempts: PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS,
    });
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run.id)))).toHaveLength(0);
  });

  it("leaves a Claude subscription quota on the bounded default", async () => {
    const { run, agent } = await failedRunWithRetries(2, {
      errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota", retryNotBefore: new Date(now.getTime() + QUARTER_HOUR_MS).toISOString() },
    });
    expect(await boundRetries().scheduleBoundedRetryForRun(run, agent, { now })).toMatchObject({ outcome: "retry_exhausted", maxAttempts: 2 });
  });

  it("resumes the session the failed run saved", async () => {
    const { run, agent, companyId } = await failedRunWithRetries(1, {
      errorCode: "provider_quota", resultJson: windowResult(new Date(now.getTime() + QUARTER_HOUR_MS)),
    });
    await db.insert(agentTaskSessions).values({
      companyId, agentId: agent.id, adapterType: "claude_local", taskKey: "window-task",
      sessionParamsJson: { sessionId: "acp-session-1" }, sessionDisplayId: "acp-session-1", lastRunId: run.id,
    });
    await boundRetries().scheduleBoundedRetryForRun(run, agent, { now });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(retry.sessionIdBefore).toBe("acp-session-1");
    expect(shouldResetTaskSessionForWake(retry.contextSnapshot)).toBe(false);
  });
});
