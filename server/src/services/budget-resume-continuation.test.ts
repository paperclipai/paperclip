import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, budgetIncidents, budgetPolicies, budgetResumeClaims, companies, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { budgetService } from "./budgets.js";
import { heartbeatService } from "./heartbeat.js";
import {
  deliverBudgetResumeContinuations, hasPendingBudgetResume, markBudgetCancelledWorkForResume,
} from "./budget-resume-continuation.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("./activity-log.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./activity-log.js")>(),
  logActivity: mockLogActivity,
}));

const support = await getEmbeddedPostgresTestSupport();

// H1 (restart chaos): a budget hard stop cancelled a run mid-task. After the
// board raised the budget and resumed, the task stayed stopped until someone
// clicked Retry. Resuming must continue that work, exactly once.
describe.skipIf(!support.supported)("resuming after a budget hard stop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("./agent-lifecycle.js");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-resume-continuation-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedScope(label: string) {
    const [company] = await db.insert(companies).values({ name: `Budget ${label}`,
      issuePrefix: `B${randomUUID().slice(0, 4).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker" }).returning();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company",
      scopeId: company.id, windowKind: "calendar_month_utc", amount: 1, hardStopEnabled: true, isActive: true }).returning();
    const [incident] = await db.insert(budgetIncidents).values({ companyId: company.id, policyId: policy.id,
      scopeType: "company", scopeId: company.id, metric: "billed_cents", windowKind: "calendar_month_utc",
      windowStart: new Date(Date.now() - 86_400_000), windowEnd: new Date(Date.now() + 86_400_000),
      thresholdType: "hard", amountLimit: 1, amountObserved: 0, createdAt: new Date(Date.now() - 60_000) }).returning();
    return { company, agent, policy, incident };
  }

  async function seedTask(scope: Awaited<ReturnType<typeof seedScope>>, options: {
    budgetStop?: boolean; lifecycleStop?: "budget" | "manual"; issueStatus?: string; runStatus?: string; laterRun?: boolean;
  } = {}) {
    const { company, agent, policy } = scope;
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Long task",
      status: options.issueStatus ?? "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, status: options.runStatus ?? "cancelled", runtimeMode: "legacy",
      contextSnapshot: { issueId: issue.id }, createdAt: new Date(Date.now() - 50_000),
      resultJson: options.lifecycleStop ? {
        // H1: the agent's budget hold paused it, and the lifecycle stop cancelled the run.
        cancellation: { reason: "Agent lifecycle stop requested", source: "control_plane", expected: true,
          initiator: { type: "system" } },
        pauseStop: options.lifecycleStop === "budget" ? { holds: ["company_paused"], companyPauseReason: "budget" }
          : { holds: ["manual"], companyPauseReason: null },
        startupCancellation: { requestedAt: new Date(Date.now() - 40_000).toISOString(), errorCode: "cancelled" },
      } : options.budgetStop === false ? { stopReason: "cancelled" } : { startupCancellation: {
        requestedAt: new Date(Date.now() - 40_000).toISOString(), errorCode: "cancelled",
        budgetEnforcement: { companyId: company.id, scopeType: "company", scopeId: company.id,
          policyId: policy.id, version: 1 } } },
    }).returning();
    if (options.laterRun) await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: issue.id },
      createdAt: new Date(Date.now() - 20_000) });
    return { issue, run };
  }

  const resume = (scope: Awaited<ReturnType<typeof seedScope>>) => budgetService(db).resolveIncident(
    scope.company.id, scope.incident.id, { action: "raise_budget_and_resume", amount: 500 }, "local-board",
    "local_implicit");
  const continuations = (companyId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), like(agentWakeupRequests.idempotencyKey, "task-retry:budget-resume:%")));
  const claimOf = async (runId: string) => (await db.select().from(budgetResumeClaims)
    .where(eq(budgetResumeClaims.runId, runId)))[0] as Record<string, unknown> | undefined;

  it("continues each task the stop cancelled exactly once, through one continuation wake", async () => {
    const scope = await seedScope("continue");
    const working = await seedTask(scope);
    const blocked = await seedTask(scope, { issueStatus: "blocked" });
    await resume(scope);
    expect(await claimOf(working.run.id)).toMatchObject({ state: "pending", incidentId: scope.incident.id,
      actorUserId: "local-board", actorSource: "local_implicit" });
    expect(await hasPendingBudgetResume(db)).toBe(true);
    await deliverBudgetResumeContinuations(db);
    const saved = await continuations(scope.company.id);
    expect(saved.map(wake => wake.payload?.issueId).sort()).toEqual([working.issue.id, blocked.issue.id].sort());
    expect(saved.every(wake => wake.reason === "task_retry" && wake.requestedByActorId === "local-board")).toBe(true);
    expect(await claimOf(working.run.id)).toMatchObject({ state: "delivered", requestId: expect.any(String) });
    expect(await hasPendingBudgetResume(db)).toBe(false);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "budget.cancelled_work_continued", entityId: working.issue.id, actorId: "local-board" }), expect.anything());
    // Delivering or resolving again files nothing new.
    await deliverBudgetResumeContinuations(db);
    await markBudgetCancelledWorkForResume(db, { companyId: scope.company.id, scopeType: "company",
      scopeId: scope.company.id, incidentId: scope.incident.id, incidentOpenedAt: scope.incident.createdAt,
      actorUserId: "local-board" });
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toHaveLength(2);
  });

  it("continues a run whose stop was still being delivered when the board resumed", async () => {
    const scope = await seedScope("in-flight");
    const task = await seedTask(scope, { runStatus: "running" });
    await resume(scope);
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toEqual([]);
    expect(await claimOf(task.run.id)).toMatchObject({ state: "pending" });
    // The committed Stop lands after the resume. Its terminal write replaces
    // the run's result JSON with a copy built before the claim was saved; the
    // claim lives outside that JSON, so it survives.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { ...(task.run.resultJson ?? {}), stopReason: "cancelled" } }).where(eq(heartbeatRuns.id, task.run.id));
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ issueId: task.issue.id }) })]);
  });

  it("dispatches the continuation through the real Retry path into a queued run", async () => {
    const scope = await seedScope("dispatch");
    const task = await seedTask(scope, { issueStatus: "blocked" });
    // Keep the new run queued: one run slot, already taken.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, scope.agent.id));
    await db.insert(heartbeatRuns).values({ companyId: scope.company.id, agentId: scope.agent.id, status: "running" });
    await resume(scope);
    const heartbeat = heartbeatService(db);
    await deliverBudgetResumeContinuations(db, {
      resumeTaskRetry: (companyId, requestId) => heartbeat.resumeTaskRetry(companyId, requestId) });
    const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.company.id),
      eq(heartbeatRuns.status, "queued")));
    expect(queued, JSON.stringify(await db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error,
      reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, scope.company.id)))).toHaveLength(1);
    expect(queued[0]).toMatchObject({ agentId: scope.agent.id });
    expect(queued[0].contextSnapshot).toMatchObject({ issueId: task.issue.id });
  });

  it("continues every task of a large scope", async () => {
    const scope = await seedScope("large");
    for (let index = 0; index < 30; index += 1) await seedTask(scope);
    await resume(scope);
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toHaveLength(30);
  });

  it.each([
    ["work that already continued", { laterRun: true }, "work_continued_or_task_changed"],
    ["a task that is now done", { issueStatus: "done" }, "work_continued_or_task_changed"],
  ] as const)("does not continue %s", async (label, options, reason) => {
    const scope = await seedScope(label.replace(/\W+/g, "-"));
    const task = await seedTask(scope, options);
    await resume(scope);
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toEqual([]);
    expect(await claimOf(task.run.id)).toMatchObject({ state: "abandoned", reason });
  });

  it("abandons a claim whose run finished before its stop landed", async () => {
    const scope = await seedScope("finished-first");
    const task = await seedTask(scope, { runStatus: "running" });
    await resume(scope);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, task.run.id));
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toEqual([]);
    expect(await claimOf(task.run.id)).toMatchObject({ state: "abandoned", reason: "run_not_cancelled" });
  });

  it("continues a run the agent's budget pause stopped through the lifecycle stop", async () => {
    const scope = await seedScope("lifecycle-stop");
    const task = await seedTask(scope, { lifecycleStop: "budget", issueStatus: "in_progress" });
    await resume(scope);
    expect(await claimOf(task.run.id)).toMatchObject({ state: "pending" });
    await deliverBudgetResumeContinuations(db);
    expect(await continuations(scope.company.id)).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ issueId: task.issue.id }) })]);
  });

  it("never claims a run a manual agent pause stopped", async () => {
    const scope = await seedScope("manual-pause");
    const task = await seedTask(scope, { lifecycleStop: "manual" });
    await resume(scope);
    expect(await claimOf(task.run.id)).toBeUndefined();
  });

  it("never claims a run a person stopped while budget enforcement also fenced it", async () => {
    const scope = await seedScope("person-and-budget");
    const task = await seedTask(scope);
    await db.update(heartbeatRuns).set({ resultJson: { ...(task.run.resultJson ?? {}),
      cancellation: { reason: "Stopped by board", source: "operator", expected: true, initiator: { type: "user", id: "board-user" } },
      cancelledByActorType: "user" } }).where(eq(heartbeatRuns.id, task.run.id));
    await resume(scope);
    expect(await claimOf(task.run.id)).toBeUndefined();
  });

  it("never claims a run a person stopped", async () => {
    const scope = await seedScope("person-stop");
    const task = await seedTask(scope, { budgetStop: false });
    await resume(scope);
    expect(await claimOf(task.run.id)).toBeUndefined();
  });
});
