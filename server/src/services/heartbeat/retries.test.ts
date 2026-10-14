import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch, type PostCommitEffect } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import * as legacy from "../heartbeat.js";
import { createHeartbeatRunState } from "./run-state.js";
import * as extracted from "./retries.js";
import type { HeartbeatRetryDependencies } from "./retries.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

function callbacks() {
  return {
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
    applyRunDispatchPostCommitEffects: vi.fn<(effects: PostCommitEffect[]) => void>(),
    runDispatch: {
      evaluateScheduledRetryGate: vi.fn<HeartbeatRetryDependencies["runDispatch"]["evaluateScheduledRetryGate"]>(async () => ({ allowed: true })),
      promoteDueScheduledRetries: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteDueScheduledRetries"]>(async () => ({ promoted: 0, runIds: [], postCommitEffects: [] })),
      promoteScheduledRetry: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteScheduledRetry"]>(async () => ({ outcome: "not_promoted" })),
    },
  } satisfies HeartbeatRetryDependencies;
}

// These tests must never query: only the injected lifecycle callbacks may run.
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected retry database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

function unitRun(): Run {
  const run: Partial<Run> = {
    id: "run", companyId: "company", agentId: "agent", status: "running",
    scopeKind: "issue", issueId: "issue",
    wakeupRequestId: "wake", scheduledRetryAttempt: 0,
    contextSnapshot: { issueId: "issue", timerClaimWasFirstHeartbeat: true },
  };
  return run as Run;
}

function deferral() {
  return new extracted.WorkspaceBusyDeferral({
    holder: { runId: "holder", agentId: "other-agent", issueId: "other-issue", issueIdentifier: "T-2" },
    projectWorkspaceId: "workspace", deferralAttempt: 0, wasIssueAssignee: true,
  });
}

describe("heartbeat retry module callbacks", () => {
  it("preserves legacy helper and error-class identity", () => {
    expect(legacy.computeBoundedTransientHeartbeatRetrySchedule).toBe(extracted.computeBoundedTransientHeartbeatRetrySchedule);
    expect(legacy.computeWorkspaceBusyRetryDelayMs).toBe(extracted.computeWorkspaceBusyRetryDelayMs);
    expect(legacy.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS).toBe(extracted.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS);
    expect(legacy.WorkspaceBusyDeferral).toBe(extracted.WorkspaceBusyDeferral);
    expect(deferral()).toBeInstanceOf(legacy.WorkspaceBusyDeferral);
  });

  it("constructs without database access or lifecycle effects", () => {
    const database = guardedDatabase();
    const deps = callbacks();
    extracted.createHeartbeatRetries(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) {
      if (typeof callback === "function") expect(callback).not.toHaveBeenCalled();
    }
    for (const callback of Object.values(deps.runDispatch)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["missing_run", "missing_agent"] as const)("keeps %s lookup behavior and requests the full source result", async (outcome) => {
    const database = guardedDatabase();
    const deps = callbacks();
    if (outcome === "missing_agent") deps.getRun.mockResolvedValue(unitRun());
    expect(await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetry("run")).toEqual({ outcome });
    expect(deps.getRun).toHaveBeenCalledWith("run", { unsafeFullResultJson: true });
    expect(deps.getAgent).toHaveBeenCalledTimes(outcome === "missing_agent" ? 1 : 0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("records exhaustion before escalating a plan-resume failure", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = unitRun();
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(
      run, { adapterType: "codex_local" } as Agent,
      { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 0 },
    );
    expect(retry).toMatchObject({ outcome: "retry_exhausted", attempt: 1, maxAttempts: 0 });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, scheduledRetryAttempt: 0, maxAttempts: 0 },
    }));
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledAfter(deps.appendRunEvent);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("passes the service's worktree cutoff and publishes only returned effects", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const now = new Date("2026-10-08T12:00:00Z");
    const cutoff = new Date("2026-10-08T11:00:00Z");
    const effect: PostCommitEffect = {
      kind: "run_queued", runId: "retry", companyId: "company", agentId: "agent",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: "wake",
    };
    deps.getWorktreeExecutionCutoff.mockResolvedValue(cutoff);
    deps.runDispatch.promoteDueScheduledRetries.mockResolvedValue({ promoted: 1, runIds: ["retry"], postCommitEffects: [effect] });
    expect(await extracted.createHeartbeatRetries(database.db, deps).promoteDueScheduledRetries(now)).toEqual({ promoted: 1, runIds: ["retry"] });
    expect(deps.runDispatch.promoteDueScheduledRetries).toHaveBeenCalledWith({ now, cutoff });
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([effect]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledAfter(deps.runDispatch.promoteDueScheduledRetries);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not publish effects when promotion rejects", async () => {
    const deps = callbacks();
    deps.runDispatch.promoteDueScheduledRetries.mockRejectedValue(new Error("promotion failed"));
    await expect(extracted.createHeartbeatRetries(guardedDatabase().db, deps).promoteDueScheduledRetries()).rejects.toThrow("promotion failed");
    expect(deps.applyRunDispatchPostCommitEffects).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("leaves a %s cancellation race winner alone", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(unitRun(), deferral());
    else await retries.finalizeAiConnectionBusyDeferral(unitRun(), new HttpError(409, "busy"), true);
    expect(deps.setRunStatusIfRunning).toHaveBeenCalledTimes(1);
    expect(deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("settles the agent after a %s deferral cannot keep its issue lock", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "cancelled" };
    deps.setRunStatusIfRunning.mockResolvedValue({ updated: true, run });
    deps.releaseIssueExecutionAndPromote.mockRejectedValue(new Error("release failed"));
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(run, deferral());
    else await expect(retries.finalizeAiConnectionBusyDeferral(run, new HttpError(409, "busy"), true)).rejects.toThrow("release failed");
    expect(deps.setWakeupStatus).toHaveBeenCalledWith("wake", "cancelled", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(run);
    expect(deps.finalizeAgentStatus).toHaveBeenCalledWith("agent", "cancelled", null, { wasFirstHeartbeat: true });
    expect(deps.finalizeAgentStatus).toHaveBeenCalledAfter(deps.releaseIssueExecutionAndPromote);
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping retry PostgreSQL tests: ${support.reason ?? "unsupported host"}`);

describePostgres("heartbeat retry module database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const now = new Date("2026-10-08T12:00:00Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-retries-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => { await database?.cleanup(); });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  function boundRetries() {
    const state = createHeartbeatRunState(db);
    const deps = {
      ...callbacks(), getRun: state.getRun, getAgent: state.getAgent,
      resolveSessionBeforeForWakeup: state.resolveSessionBeforeForWakeup,
      getAgentInvokability: (agent: Agent | null | undefined) => evaluateAgentInvokabilityFromDb(db, agent),
      runDispatch: createRunDispatch(db),
    };
    return { retries: extracted.createHeartbeatRetries(db, deps), deps };
  }

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retries", issuePrefix: `R${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Retry agent", adapterType: "codex_local", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Retry task", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "failed", errorCode: "codex_transient_upstream", finishedAt: now,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, run };
  }

  it("reuses one successor across concurrent factories and keeps writes committed before callbacks", async () => {
    const { run, agent, issue, companyId } = await fixture();
    const first = boundRetries(), second = boundRetries();
    for (const binding of [first, second]) {
      binding.deps.appendRunEvent.mockImplementation(async (_source, event) => {
        const retryId = event.payload?.retryRunId;
        expect(typeof retryId).toBe("string");
        expect(await binding.deps.getRun(retryId as string)).toMatchObject({ retryOfRunId: run.id });
      });
    }
    const results = await Promise.all([
      first.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
      second.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
    ]);
    expect(results.every((result) => result.outcome === "scheduled")).toBe(true);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run.id)));
    expect(successors).toHaveLength(1);
    const successor = successors[0];
    expect(successor).toMatchObject({
      status: "scheduled_retry", issueId: issue.id, responsibleUserId: "retry-user",
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
    });
    expect(successor.contextSnapshot).toMatchObject({ retryOfRunId: run.id, codexTransientFallbackMode: "same_session" });
    expect(first.deps.resolveResponsibleUserIdForRunContext).toHaveBeenCalledWith(run, expect.objectContaining({ retryOfRunId: run.id }));
    const [locked] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(locked).toMatchObject({ executionRunId: successor.id, checkoutRunId: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successor.id))).toHaveLength(1);
    expect(await boundRetries().retries.scheduleBoundedRetry(run.id, { now })).toMatchObject({ outcome: "scheduled", run: { id: successor.id }, reusedExisting: true });
    expect(first.deps.appendRunEvent).toHaveBeenCalledTimes(1);
    expect(second.deps.appendRunEvent).toHaveBeenCalledTimes(1);
  });

  it("promotes only due retries and publishes after commit", async () => {
    const { run } = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(run.id, { now, delayMs: 60_000 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry");
    expect(await retries.promoteDueScheduledRetries(now)).toEqual({ promoted: 0, runIds: [] });
    deps.applyRunDispatchPostCommitEffects.mockClear();
    const committedStatuses: string[] = [];
    const reads: Promise<void>[] = [];
    deps.applyRunDispatchPostCommitEffects.mockImplementation(() => {
      // Read outside the dispatch transaction after the callback is invoked.
      // The assertion below waits for that read without making publication async.
      reads.push(deps.getRun(scheduled.run.id).then((row) => { committedStatuses.push(row!.status); }));
    });
    expect(await retries.promoteDueScheduledRetries(scheduled.dueAt)).toEqual({ promoted: 1, runIds: [scheduled.run.id] });
    await Promise.all(reads);
    expect(committedStatuses).toEqual(["queued"]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([expect.objectContaining({ kind: "run_queued", runId: scheduled.run.id })]);
  });

  it("binds retry-now to the requested issue and persists its actor before promotion", async () => {
    const selected = await fixture(), other = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(selected.run.id, { now, delayMs: 60_000 });
    const foreign = await retries.scheduleBoundedRetry(other.run.id, { now, delayMs: 60_000 });
    if (scheduled.outcome !== "scheduled" || foreign.outcome !== "scheduled") throw new Error("Expected retries");
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, actor: { actorType: "user", actorId: "retry-user" }, now })).toMatchObject({
      outcome: "promoted", scheduledRetry: { runId: scheduled.run.id, status: "queued" },
    });
    expect(await deps.getRun(scheduled.run.id)).toMatchObject({ contextSnapshot: {
      retryNowRequestedByActorType: "user", retryNowRequestedByActorId: "retry-user", retryNowRequestedAt: now.toISOString(),
    } });
    expect(await deps.getRun(foreign.run.id)).toMatchObject({ status: "scheduled_retry", scheduledRetryAt: foreign.dueAt });
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, now })).toMatchObject({ outcome: "already_promoted" });
  });
});
