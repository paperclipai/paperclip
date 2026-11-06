import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createProviderLimitWait } from "../services/heartbeat/provider-limit-wait.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping provider limit wait tests: ${recoveryPostgresSupport.reason}`);

/**
 * An agent whose provider account is out of allowance must not start new work
 * that will fail the same way. The wake waits for the reported reset instead.
 */
describePostgres("heartbeat provider usage limit wait", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched = new Set<string>();
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-provider-limit-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-provider-limit-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.add(input.runId);
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(prior: Array<Partial<typeof heartbeatRuns.$inferInsert>>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `limit-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Limit user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Provider limit fixture", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Limited agent", adapterType, status: "idle", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Triage the next alert", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    for (const values of prior) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system", ...values });
    }
    return { companyId, agentId, issueId };
  }

  async function wake(f: Awaited<ReturnType<typeof seed>>, manual = false) {
    const run = await heartbeat.wakeup(f.agentId, manual
      ? { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } }
      : { source: "automation", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    return finished;
  }

  const rateLimited = (minutesAgo: number, overrides: Record<string, unknown> = {}) => ({
    status: "failed",
    startedAt: new Date(Date.now() - (minutesAgo + 2) * 60_000),
    finishedAt: new Date(Date.now() - minutesAgo * 60_000),
    errorCode: "provider_session_open_rejected",
    resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
      category: "rate_limit", httpStatus: 429, retryability: "unknown",
      message: "API error: 429 This request would exceed your account's rate limit. Please try again later", ...overrides } },
  });

  it("defers new work until the reported reset instead of dispatching a doomed run", async () => {
    const limited = rateLimited(16);
    const f = await seed([limited]);
    const resetAt = new Date(limited.finishedAt.getTime() + 60 * 60_000);
    const finished = await wake(f);

    expect(dispatched.has(finished.id)).toBe(false);
    expect(finished).toMatchObject({
      status: "cancelled",
      errorCode: "provider_limit_wait",
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        providerLimitWait: { resetAt: resetAt.toISOString(), resetReported: false, category: "rate_limit" },
      },
    });
    expect(finished.error).toContain(resetAt.toISOString());
    const successors = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.agentId));
    const retry = successors.find(run => run.status === "scheduled_retry");
    expect(retry).toMatchObject({ scheduledRetryReason: "ai_connection_pool_wait" });
    expect(retry!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(resetAt.getTime());
    expect(retry!.scheduledRetryAt!.getTime()).toBeLessThan(resetAt.getTime() + 5 * 60_000);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finished.id));
    expect(events.some(event => event.message?.includes("provider usage limit"))).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).not.toBe("blocked");
    // The persisted projection names the wait and its reset.
    expect((await executionProjectionsForRuns(db, f.companyId, [retry!.id])).get(retry!.id)).toMatchObject({
      label: "Waiting for usage limit reset", phase: "retry_scheduled",
      nextAction: expect.stringContaining(retry!.scheduledRetryAt!.toISOString()),
    });

    // Nothing is dropped: the wait starts the work once the reset has passed.
    expect((await heartbeat.promoteDueScheduledRetries(new Date())).runIds).not.toContain(retry!.id);
    // Model the hour passing by moving the limit evidence back past its reset.
    await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 3 * 60 * 60_000), finishedAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(eq(heartbeatRuns.errorCode, "provider_session_open_rejected"));
    expect((await heartbeat.promoteDueScheduledRetries(new Date(retry!.scheduledRetryAt!.getTime() + 1))).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(dispatched.has(retry!.id)).toBe(true);
    const [resumed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
    expect(resumed.status).toBe("succeeded");
  }, 60_000);

  it("releases the task when its retry cannot be scheduled, even if diagnostics fail", async () => {
    const f = await seed([rateLimited(16)]);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } }).returning();
    const deps = {
      setRunStatusIfRunning: vi.fn(async () => ({ updated: true, run: { ...run, status: "cancelled" } })),
      setWakeupStatus: vi.fn(async () => { throw new Error("wakeup write failed"); }),
      appendRunEvent: vi.fn(async () => { throw new Error("event write failed"); }),
      scheduleBoundedRetryForRun: vi.fn(async () => { throw new Error("retry write failed"); }),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
    };
    const { deferRunForProviderLimit } = createProviderLimitWait(db, deps as never);
    await expect(deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false })).resolves.toBe(true);
    expect(deps.scheduleBoundedRetryForRun).toHaveBeenCalledTimes(2);
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(deps.finalizeAgentStatus).toHaveBeenCalledOnce();

    // A scheduled retry keeps the task lock for its successor.
    deps.scheduleBoundedRetryForRun.mockReset().mockResolvedValue({ outcome: "scheduled" } as never);
    deps.releaseIssueExecutionAndPromote.mockClear();
    await expect(deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false })).resolves.toBe(true);
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
  });

  it("recovers a wait whose retry was lost to a crash after its cancellation committed", async () => {
    const f = await seed([]);
    const [lost] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "cancelled",
      invocationSource: "automation", triggerDetail: "system", issueId: f.issueId, scopeKind: "issue",
      startedAt: new Date(Date.now() - 10 * 60_000), finishedAt: new Date(Date.now() - 9 * 60_000), errorCode: "provider_limit_wait",
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
      contextSnapshot: { issueId: f.issueId } }).returning();
    await db.update(issues).set({ status: "in_progress", executionRunId: lost.id, executionLockedAt: new Date(Date.now() - 9 * 60_000) })
      .where(eq(issues.id, f.issueId));
    await heartbeat.sweepStaleIssueLocks();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    // Existing stranded-work recovery gives the wake a bounded successor; the gate re-checks the limit when it runs.
    expect(runs.find(run => run.id !== lost.id)).toMatchObject({ status: "scheduled_retry", retryOfRunId: lost.id });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "in_progress", executionRunId: null });
  }, 60_000);

  it("still dispatches a manual run, and work after a later success or an expired reset", async () => {
    const manual = await seed([rateLimited(16)]);
    expect(dispatched.has((await wake(manual, true)).id)).toBe(true);

    const recovered = await seed([rateLimited(30), {
      status: "succeeded", startedAt: new Date(Date.now() - 10 * 60_000), finishedAt: new Date(Date.now() - 9 * 60_000),
    }]);
    expect(dispatched.has((await wake(recovered)).id)).toBe(true);

    const expired = await seed([rateLimited(90)]);
    expect(dispatched.has((await wake(expired)).id)).toBe(true);

    const unrelated = await seed([{ ...rateLimited(5), resultJson: { providerFailure: {
      schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "turn", category: "unknown",
      retryability: "unknown", message: "ACP agent reported a terminal limit failure." } } }]);
    expect(dispatched.has((await wake(unrelated)).id)).toBe(true);
  }, 60_000);
});
