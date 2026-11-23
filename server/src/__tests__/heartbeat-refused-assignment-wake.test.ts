import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, budgetPolicies, companies, companyMemberships, createDb, heartbeatRuns,
  issues, projects } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping refused assignment wake tests: ${recoveryPostgresSupport.reason}`);

/**
 * A temporary budget hold can refuse a new task's assignment wake. Since Phase
 * 3 another run's accounting never holds admission (invariant 3); the hold
 * left is a budget-owned pause that is not a reached hard stop. The task must wait
 * honestly and start once the hold clears, instead of resting `blocked` with no run.
 */
describePostgres("refused assignment wake during a temporary admission hold", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched: string[] = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-refused-assignment-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-refused-assignment-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push(input.runId);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A company with a hard-stop budget whose task's project carries a
   * budget-owned pause that no project policy justifies: admission refuses the
   * task's work until the pause lifts. A completed run with pending
   * accounting is present too; it must not hold anything (invariant 3). */
  async function seedHeldCompany() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    const userId = `hold-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Hold user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Accounting hold fixture", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assignee", adapterType, status: "idle", adapterConfig: {} },
      { id: otherAgentId, companyId, name: "Earlier worker", adapterType, status: "idle", adapterConfig: {} },
    ]);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, windowKind: "calendar_month_utc",
      amount: 2_000, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    const [pending] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      costAccountingPending: true, contextSnapshot: {} }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Budget-paused project", status: "in_progress",
      pauseReason: "budget", pausedAt: new Date() }).returning();
    await db.insert(issues).values({ id: issueId, companyId, projectId: project.id, title: "New task created during the hold", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId, projectId: project.id, pendingRunId: pending.id };
  }

  async function liftHold(f: { projectId: string }) {
    await db.update(projects).set({ pauseReason: null, pausedAt: null }).where(eq(projects.id, f.projectId));
  }

  async function assign(f: Awaited<ReturnType<typeof seedHeldCompany>>) {
    return queueIssueAssignmentWakeup({ heartbeat, issue: { id: f.issueId, assigneeAgentId: f.agentId, status: "todo" },
      reason: "issue_assigned", mutation: "create", contextSource: "issue.create",
      requestedByActorType: "user", requestedByActorId: f.userId, rethrowOnError: true });
  }

  const issueRuns = (f: { companyId: string; agentId: string }) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));

  it("keeps the task waiting during the hold and starts exactly one run once it clears", async () => {
    const f = await seedHeldCompany();
    await expect(assign(f)).rejects.toMatchObject({ status: 409 });
    const [refused] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.agentId)));
    expect(refused).toMatchObject({ status: "skipped", reason: "budget.blocked" });

    // Recovery sweeps while the hold lasts must not turn the wait into a dead `blocked` task.
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).toBe("todo");
    expect(await issueRuns(f)).toHaveLength(0);
    // This pause needs an operator resume, so the task asks the user; it does
    // not offer a Retry that cannot start either.
    expect(await taskInterruptionPresentation(db, waiting)).toMatchObject({ responsibility: "user", state: "waiting_for_user",
      canRetry: false });

    // The budget pause lifts: the hold clears.
    await liftHold(f);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    // Exactly one provider turn starts the task. (A post-run continuation the
    // adapter fixture leaves behind is cancelled unstarted once the task is done.)
    const providerTurns = async () => {
      const ids = new Set((await issueRuns(f)).map(run => run.id));
      return dispatched.filter(id => ids.has(id));
    };
    expect(await providerTurns()).toHaveLength(1);
    const [started] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, (await providerTurns())[0]));
    expect(started).toMatchObject({ status: "succeeded", contextSnapshot: expect.objectContaining({
      source: "issue.assigned_todo_liveness_dispatch" }) });
    const [finished] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(finished.status).toBe("done");

    // A later sweep does not start a duplicate.
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(await providerTurns()).toHaveLength(1);
  }, 180_000);

  it("does not wake a task whose assignee was removed while the hold lasted", async () => {
    const f = await seedHeldCompany();
    await expect(assign(f)).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
    await liftHold(f);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(await issueRuns(f)).toHaveLength(0);
  }, 180_000);

  it("does not wake a task cancelled while the hold lasted", async () => {
    const f = await seedHeldCompany();
    await expect(assign(f)).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    await liftHold(f);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(await issueRuns(f)).toHaveLength(0);
    const [cancelled] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(await taskInterruptionPresentation(db, cancelled)).toBeNull();
  }, 180_000);
});
