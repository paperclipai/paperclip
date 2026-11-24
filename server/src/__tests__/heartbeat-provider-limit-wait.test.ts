import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, connectionGrants, createDb, heartbeatRunEvents, heartbeatRuns, issues,
  aiProviderDefaults, toolApplications, toolConnectionInstalls, toolConnections,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createProviderLimitWait, releaseProviderLimitWaits } from "../services/heartbeat/provider-limit-wait.js";
import { agentService } from "../services/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const providerLimitCancellation = vi.hoisted(() => ({ after: null as null | (() => Promise<unknown>) }));
vi.mock("../services/heartbeat/provider-limit-wait.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/provider-limit-wait.js")>();
  return {
    ...actual,
    createProviderLimitWait: (...[database, deps]: Parameters<typeof actual.createProviderLimitWait>) =>
      actual.createProviderLimitWait(database, {
        ...deps,
        setRunStatusIfRunning: async (...args) => {
          const result = await deps.setRunStatusIfRunning(...args);
          await providerLimitCancellation.after?.();
          return result;
        },
      }),
  };
});

const retryDispatchNotice = vi.hoisted(() => ({ before: null as null | ((transaction: object) => Promise<unknown>) }));
vi.mock("../services/run-dispatch-notifications.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/run-dispatch-notifications.js")>();
  return {
    ...actual,
    notifyScheduledRetryDispatch: async (...args: Parameters<typeof actual.notifyScheduledRetryDispatch>) => {
      await retryDispatchNotice.before?.(args[0]);
      return actual.notifyScheduledRetryDispatch(...args);
    },
  };
});

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

  it("defers new work to a recheck without claiming an unreported reset", async () => {
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
    expect(finished.error).toContain("recheck");
    expect(finished.error).not.toMatch(/expected to reset|start this work then/);
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
      label: "Waiting for provider usage", phase: "retry_scheduled",
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

  it("keeps the task lock for its retry when recovery sweeps the task right after the cancellation", async () => {
    const f = await seed([rateLimited(16)]);
    const sweeps: Array<Awaited<ReturnType<typeof heartbeat.sweepStaleIssueLocks>>> = [];
    providerLimitCancellation.after = async () => {
      sweeps.push(await heartbeat.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }));
    };
    try {
      const finished = await wake(f);
      expect(finished).toMatchObject({ status: "cancelled", errorCode: "provider_limit_wait" });
      expect(sweeps).toEqual([expect.objectContaining({ cleared: 0 })]);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, finished.id));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_pool_wait" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.executionRunId).toBe(retry.id);
    } finally {
      providerLimitCancellation.after = null;
    }
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

  /**
   * A usage limit belongs to the account it was reported on. Connecting a
   * different account, or revoking the limited one, ends the hold; the same
   * account stays held.
   */
  describe("account-scoped holds", () => {
    type Account = { connectionId: string; grantId: string };

    async function accounts(companyId: string, count: number): Promise<Account[]> {
      const [application] = await db.insert(toolApplications)
        .values({ companyId, name: `AI accounts ${randomUUID()}`, type: "mcp_http" }).returning();
      const created: Account[] = [];
      for (let index = 0; index < count; index += 1) {
        const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, uid: randomUUID(),
          name: `AI account ${index}`, connectionPurpose: "ai", transport: "runtime_auth", authKind: "none" }).returning();
        const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "organization" }).returning();
        created.push({ connectionId: connection.id, grantId: grant.id });
      }
      return created;
    }

    const binding = (account: Account) => ({ mode: "shared", provider: "google", method: "subscription", ...account });

    /** A turn on `account` that the provider refused with a quota reset days away. */
    const quotaOn = (account: Account) => ({
      status: "failed",
      startedAt: new Date(Date.now() - 7 * 60_000),
      finishedAt: new Date(Date.now() - 5 * 60_000),
      errorCode: "native_provider_usage_limit",
      contextSnapshot: { aiConnection: { mode: "shared", provider: "google", method: "subscription", ...account } },
      resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn",
        category: "quota_exhausted", httpStatus: 429, providerCode: "RESOURCE_EXHAUSTED", retryability: "requires_action",
        retryAt: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(), message: "Usage limit reached for this account." } },
    });

    /** An agent bound to `bound`, whose earlier turn hit the quota on `limited`. */
    async function heldFixture(options: { count?: number } = {}) {
      const f = await seed([]);
      const list = await accounts(f.companyId, options.count ?? 2);
      await db.update(agents).set({ runtimeConfig: { aiConnection: binding(list[0]) } }).where(eq(agents.id, f.agentId));
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...quotaOn(list[0]) });
      return { ...f, accounts: list };
    }

    async function deferDirect(f: { companyId: string; agentId: string; issueId: string }) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
        invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } }).returning();
      const deps = {
        setRunStatusIfRunning: vi.fn(async () => ({ updated: true, run: { ...run, status: "cancelled" } })),
        setWakeupStatus: vi.fn(async () => undefined),
        appendRunEvent: vi.fn(async () => undefined),
        scheduleBoundedRetryForRun: vi.fn(async () => ({ outcome: "scheduled" })),
        releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
        finalizeAgentStatus: vi.fn(async () => undefined),
      };
      const deferred = await createProviderLimitWait(db, deps as never)
        .deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false });
      return { deferred, deps };
    }

    async function scheduledRetry(agentId: string) {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find(row => row.status === "scheduled_retry") ?? null;
    }

    it("keeps holding the account that reported the limit, with the plain message", async () => {
      const f = await heldFixture();
      const finished = await wake(f);
      expect(dispatched.has(finished.id)).toBe(false);
      expect(finished).toMatchObject({ status: "cancelled", errorCode: "provider_limit_wait",
        resultJson: { providerLimitWait: { resetReported: true, category: "quota_exhausted", grantId: f.accounts[0].grantId } } });
      expect(finished.error).toMatch(/^This agent's provider usage limit has a reported reset at .+ Work is held/);
    }, 60_000);

    it("starts a run whose agent now uses a different connected account", async () => {
      const f = await heldFixture();
      await db.update(agents).set({ runtimeConfig: { aiConnection: binding(f.accounts[1]) } }).where(eq(agents.id, f.agentId));
      const { deferred, deps } = await deferDirect(f);
      expect(deferred).toBe(false);
      expect(deps.setRunStatusIfRunning).not.toHaveBeenCalled();
    });

    it("follows the user's default account when the agent uses its responsible user's default", async () => {
      const f = await seed([]);
      const userId = `limit-user-${f.companyId}`;
      const [application] = await db.insert(toolApplications)
        .values({ companyId: f.companyId, name: `Personal AI ${randomUUID()}`, type: "mcp_http" }).returning();
      const personal: Account[] = [];
      for (const name of ["Personal A", "Personal B"]) {
        const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
          uid: randomUUID(), name, connectionPurpose: "ai", transport: "runtime_auth", authKind: "none", enabled: true,
          status: "active", healthStatus: "ok", config: { ai: { provider: "google", method: "subscription" }, aiIsolatedSubscription: true } }).returning();
        const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection.id,
          kind: "user", subjectUserId: userId }).returning();
        await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id,
          targetType: "company", targetId: f.companyId });
        personal.push({ connectionId: connection.id, grantId: grant.id });
      }
      // The agent names no account; each run uses its responsible user's default.
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity" },
        runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "google", method: "subscription" } } })
        .where(eq(agents.id, f.agentId));
      await db.insert(aiProviderDefaults).values({ companyId: f.companyId, userId, provider: "google", grantId: personal[0].grantId });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...quotaOn(personal[0]) });
      const deferAs = async () => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
          invocationSource: "automation", triggerDetail: "system", responsibleUserId: userId,
          contextSnapshot: { issueId: f.issueId } }).returning();
        return createProviderLimitWait(db, {
          setRunStatusIfRunning: async () => ({ updated: true, run: { ...run, status: "cancelled" } }),
          setWakeupStatus: async () => undefined, appendRunEvent: async () => undefined,
          scheduleBoundedRetryForRun: async () => ({ outcome: "scheduled" }),
          releaseIssueExecutionAndPromote: async () => undefined, finalizeAgentStatus: async () => undefined,
        } as never).deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false });
      };
      expect(await deferAs()).toBe(true);
      // A task already waiting on account A, saved by an earlier hold.
      const [wait] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "cancelled",
        invocationSource: "automation", triggerDetail: "system", errorCode: "provider_limit_wait",
        startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 60_000),
        resultJson: { providerLimitWait: { grantId: personal[0].grantId } }, contextSnapshot: { issueId: f.issueId } }).returning();
      const [waiting] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "scheduled_retry",
        invocationSource: "automation", triggerDetail: "system", retryOfRunId: wait.id, scheduledRetryAttempt: 1,
        scheduledRetryReason: "ai_connection_pool_wait", scheduledRetryAt: new Date(Date.now() + 24 * 60 * 60_000),
        contextSnapshot: { issueId: f.issueId } }).returning();

      // The user picks account B as their default.
      await aiConnectionService(db).setDefault(f.companyId, userId, personal[1].grantId);
      expect(await deferAs()).toBe(false);
      const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting.id));
      expect(released.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("ignores a limit on an account that expired or needs a new sign-in", async () => {
      for (const status of ["expired", "needs_reauthorization"] as const) {
        const f = await heldFixture();
        await db.update(connectionGrants).set({ status }).where(eq(connectionGrants.id, f.accounts[0].grantId));
        expect((await deferDirect(f)).deferred).toBe(false);
      }
    });

    it("keeps holding the bound account when another account later reports a billing refusal", async () => {
      const f = await heldFixture();
      // Account B's newer refusal needs billing action and names no reset.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...quotaOn(f.accounts[1]), startedAt: new Date(Date.now() - 2 * 60_000), finishedAt: new Date(Date.now() - 60_000),
        resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn",
          category: "quota_exhausted", retryability: "requires_action", message: "Check your plan and billing details." } } });
      expect((await deferDirect(f)).deferred).toBe(true);
    });

    it("checks the host's own account when the harness signs in with a preconfigured home", async () => {
      const f = await heldFixture();
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity", homeMode: "preconfigured" } })
        .where(eq(agents.id, f.agentId));
      // The saved account's limit does not hold a run that will use the host sign-in.
      expect((await deferDirect(f)).deferred).toBe(false);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...quotaOn(f.accounts[0]), contextSnapshot: {} });
      // A limit reported on the host sign-in does.
      expect((await deferDirect(f)).deferred).toBe(true);
    });

    it("clears a limit only after a success on the same account", async () => {
      const f = await heldFixture();
      const succeededOn = (account: Account) => ({ status: "succeeded", startedAt: new Date(Date.now() - 2 * 60_000),
        finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { aiConnection: { grantId: account.grantId } } });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...succeededOn(f.accounts[1]) });
      expect((await deferDirect(f)).deferred).toBe(true);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
        triggerDetail: "system", ...succeededOn(f.accounts[0]) });
      expect((await deferDirect(f)).deferred).toBe(false);
    });

    it("stops holding work once the limited account is revoked", async () => {
      const f = await heldFixture();
      expect((await deferDirect(f)).deferred).toBe(true);
      await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() })
        .where(eq(connectionGrants.id, f.accounts[0].grantId));
      expect((await deferDirect(f)).deferred).toBe(false);
    });

    it("releases the waiting retry when the agent is moved to another account", async () => {
      const f = await heldFixture();
      const held = await wake(f);
      expect(held.errorCode).toBe("provider_limit_wait");
      const retry = await scheduledRetry(f.agentId);
      expect(retry!.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);

      // Dispatch hears of the due retry before the write that makes it due.
      const seenAtNotice: number[] = [];
      retryDispatchNotice.before = async transaction => {
        const [row] = await (transaction as typeof db).select({ at: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, retry!.id));
        seenAtNotice.push(row!.at!.getTime());
      };
      try {
        await agentService(db).update(f.agentId, { runtimeConfig: { aiConnection: binding(f.accounts[1]) } });
      } finally {
        retryDispatchNotice.before = null;
      }
      expect(seenAtNotice).toEqual([retry!.scheduledRetryAt!.getTime()]);
      const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
      expect(released.status).toBe("scheduled_retry");
      expect(released.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await heartbeat.promoteDueScheduledRetries(new Date())).runIds).toContain(retry!.id);
      const activity = await db.select().from(activityLog).where(eq(activityLog.runId, retry!.id));
      expect(activity).toContainEqual(expect.objectContaining({ action: "issue.scheduled_retry_retry_now", entityId: f.issueId,
        details: expect.objectContaining({ reason: "ai_connection_changed" }) }));
    }, 60_000);

    it("releases a wait saved before the account was recorded on it when that account is revoked", async () => {
      const f = await heldFixture();
      const held = await wake(f);
      // Waits saved by the previous release name only the run that reported the limit.
      const { grantId: _recorded, ...previousShape } = (held.resultJson as { providerLimitWait: Record<string, unknown> }).providerLimitWait;
      await db.update(heartbeatRuns).set({ resultJson: { ...held.resultJson, providerLimitWait: previousShape } })
        .where(eq(heartbeatRuns.id, held.id));
      const retry = await scheduledRetry(f.agentId);

      // Another account's revocation leaves the wait alone.
      expect(await releaseProviderLimitWaits(db, { companyId: f.companyId, reason: "ai_connection_revoked",
        grantIds: [f.accounts[1].grantId] })).toEqual([]);
      await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() })
        .where(eq(connectionGrants.id, f.accounts[0].grantId));
      expect(await releaseProviderLimitWaits(db, { companyId: f.companyId, reason: "ai_connection_revoked",
        grantIds: [f.accounts[0].grantId] })).toEqual([retry!.id]);
      expect((await heartbeat.promoteDueScheduledRetries(new Date())).runIds).toContain(retry!.id);
    }, 60_000);

    it("keeps holding every agent that still shares the limited account", async () => {
      const first = await heldFixture();
      // Two agents in one company share account A; both reported its limit.
      const sharedCompany = first.companyId;
      const [secondAgent] = await db.insert(agents).values({ id: randomUUID(), companyId: sharedCompany, name: "Second shared agent",
        adapterType, status: "idle", adapterConfig: {}, runtimeConfig: { aiConnection: binding(first.accounts[0]) } }).returning();
      const [secondIssue] = await db.insert(issues).values({ id: randomUUID(), companyId: sharedCompany, title: "Second task",
        status: "todo", assigneeAgentId: secondAgent.id, issueNumber: 2 }).returning();
      await db.insert(heartbeatRuns).values({ companyId: sharedCompany, agentId: secondAgent.id, invocationSource: "automation",
        triggerDetail: "system", ...quotaOn(first.accounts[0]) });
      const shared = { companyId: sharedCompany, agentId: secondAgent.id as typeof first.agentId, issueId: secondIssue.id as typeof first.issueId };
      expect((await wake(first)).errorCode).toBe("provider_limit_wait");
      expect((await wake(shared)).errorCode).toBe("provider_limit_wait");
      const sharedRetry = await scheduledRetry(secondAgent.id);

      // Moving one agent to account B leaves the other's account A hold intact.
      await agentService(db).update(first.agentId, { runtimeConfig: { aiConnection: binding(first.accounts[1]) } });
      const [stillWaiting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sharedRetry!.id));
      expect(stillWaiting.scheduledRetryAt!.getTime()).toBe(sharedRetry!.scheduledRetryAt!.getTime());
      expect((await deferDirect(shared)).deferred).toBe(true);
    }, 60_000);

    it("starts the waiting work on Check now once the agent already uses another account", async () => {
      // The state saved before this fix: the task is todo, its run was held
      // for account A, its recheck is a day away, and the agent was moved to
      // account B without releasing the wait.
      const f = await heldFixture();
      const held = await wake(f);
      expect(held.errorCode).toBe("provider_limit_wait");
      const retry = await scheduledRetry(f.agentId);
      await db.update(agents).set({ runtimeConfig: { aiConnection: binding(f.accounts[1]) } }).where(eq(agents.id, f.agentId));
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task).toMatchObject({ status: "todo", monitorNextCheckAt: null, executionRunId: retry!.id });

      // "Check now" on this task starts its waiting retry.
      const checked = await heartbeat.retryScheduledRetryNow({ issueId: f.issueId, actor: { actorType: "user", actorId: `limit-user-${f.companyId}` } });
      expect(checked.outcome).toBe("promoted");
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const [started] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
      // Account A's limit no longer holds the run. This fixture has no stored
      // credential for account B, so the run goes on to that setup check.
      expect(started.status).not.toBe("scheduled_retry");
      expect(started.errorCode).not.toBe("provider_limit_wait");
      const waits = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry!.id));
      expect(waits.filter(run => run.scheduledRetryReason === "ai_connection_pool_wait")).toEqual([]);
    }, 60_000);

    it("rechecks the wait at once when the user replies, and holds again while the account is still limited", async () => {
      const f = await heldFixture();
      await wake(f);
      const retry = await scheduledRetry(f.agentId);
      const userId = `limit-user-${f.companyId}`;
      const commentId = randomUUID();

      // Another agent's comment keeps the scheduled recheck.
      await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: randomUUID() }, requestedByActorType: "agent", requestedByActorId: randomUUID(),
        contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" } });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id)))[0].scheduledRetryAt!.getTime())
        .toBe(retry!.scheduledRetryAt!.getTime());

      await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId }, requestedByActorType: "user", requestedByActorId: userId,
        contextSnapshot: { issueId: f.issueId, commentId, wakeCommentId: commentId, wakeReason: "issue_commented" } });
      const [rechecking] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
      expect(rechecking.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await heartbeat.promoteDueScheduledRetries(new Date())).runIds).toContain(retry!.id);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const [rechecked] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
      expect(dispatched.has(retry!.id)).toBe(false);
      expect(rechecked).toMatchObject({ status: "cancelled", errorCode: "provider_limit_wait" });
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry!.id));
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_pool_wait" });
      expect(successor.contextSnapshot).toMatchObject({ wakeCommentId: commentId });
    }, 60_000);
  });
});
