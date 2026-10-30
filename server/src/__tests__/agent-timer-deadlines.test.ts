import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, activityLog, approvals, authUsers, applyPendingMigrations, companies, companyMemberships, companySkills, companySkillVersions, companySkillTestRuns, issueRecoveryActions, chatEndpoints, chatConversations, toolApplications, toolConnections, costEvents, createDb, heartbeatRuns, issues, issueComments, reconcileDatabaseWork, subscribeDatabaseWork, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatScheduling } from "../services/heartbeat/scheduling.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { registerScheduledWork } from "../services/scheduled-work.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { companySkillService } from "../services/company-skills.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { createPostgresWatchdogAdapter } from "../modules/active-run-watchdog/adapters/postgres.js";
import { prepareConversationTurn, settleConversationTurn } from "../services/agent-conversations.js";
import { approvalService } from "../services/approvals.js";
import { budgetService } from "../services/budgets.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { accessService } from "../services/access.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createAgentLifecycle, startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createHeartbeatAgentStatus } from "../services/heartbeat/agent-status.js";
import { issueService } from "../services/issues.js";
import { resumeExternalConversation } from "../services/slack-conversation-state.js";
import { idleWorkSnapshot, readTaskDrain, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_TIMER_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const now = new Date("2026-10-27T12:00:00Z");

describe.skipIf(!support.supported)("agent timer owned deadlines", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("agent-timer-deadlines-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {


    await reconcileDatabaseWork(db, DELIVERY_QUEUES.agentTimers);
    await db.execute(sql`truncate companies cascade`);
    errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    vi.setSystemTime(now);
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    stopTaskDrain(); vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(heartbeat: Record<string, unknown> = { enabled: true, intervalSec: 600 }) {
    const [company] = await db.insert(companies).values({ name: "Timer company", issuePrefix: "TMR",
      defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Timer agent", status: "idle",
      lifecycleState: "ready", adapterType: "process", createdAt: now, runtimeConfig: { heartbeat } }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    const preparation = createHeartbeatRunPreparation(db);
    const queue = createHeartbeatQueue(db, deps);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as typeof heartbeatRuns.$inferSelect);
    const scheduling = createHeartbeatScheduling(db, {
      getRun: deps.getRun, getAgent: deps.getAgent, getWorktreeExecutionCutoff: deps.getWorktreeExecutionCutoff,
      getSchedulingSuppression: deps.getSchedulingSuppression, toAgentOrgRow: preparation.toAgentOrgRow,
      groupAgentOrgRowsByCompany: preparation.groupAgentOrgRowsByCompany, issuesSvc: issueService(db),
      scheduleBoundedRetryForRun: vi.fn(), enqueueWakeup,
      parseHeartbeatPolicy: queue.parseHeartbeatPolicy, nextTimerHeartbeatAt: queue.nextTimerHeartbeatAt,
      claimDueTimerHeartbeat: queue.claimDueTimerHeartbeat,
    });
    return { company, agent, queue, scheduling, enqueueWakeup, deps };
  }
  async function start(f: Awaited<ReturnType<typeof fixture>>, retryMs = 1000) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const workers = registerScheduledWork(coordinator, { retryMs, canRun: () => true,
      tickAgentTimers: signal => f.scheduling.tickAgentTimers(new Date(), () => !signal.aborted && readTaskDrain(new Date()) === null),
      nextAgentTimerAt: () => f.scheduling.nextAgentTimerAt(),
      tickIssueMonitors: async () => {}, nextIssueMonitorAt: async () => null,
      tickRoutines: async () => {}, nextRoutineRunAt: async () => null,
    });
    await Promise.all([workers.timers.ready, workers.monitors.ready, workers.routines.ready]);
  }
  async function quiet() {
    await vi.waitFor(() => { expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull(); }, { timeout: 3000 });
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute"), transaction = vi.spyOn(db, "transaction");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    } finally { select.mockRestore(); execute.mockRestore(); transaction.mockRestore(); }
  }

  it("preserves the instance scan floor for short intervals and repeated policy writes", async () => {
    const policy = { enabled: true, intervalSec: 1 };
    const f = await fixture(policy);
    const tick = vi.spyOn(f.scheduling, "tickAgentTimers");
    const inspect = vi.spyOn(f.scheduling, "nextAgentTimerAt");
    const beforeStart = Date.now();
    await start(f, 30_000);
    expect(tick).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    const firstScan = coordinator!.nextWakeAt()!;
    expect(firstScan).toBeGreaterThanOrEqual(beforeStart + 30_000);
    const initialEnqueues = f.enqueueWakeup.mock.calls.length;
    for (let update = 0; update < 10; update++) {
      await agentService(db).update(f.agent.id, { runtimeConfig: { heartbeat: policy } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(tick).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(initialEnqueues);

    await vi.advanceTimersByTimeAsync(Math.max(0, firstScan - Date.now()));
    await vi.waitFor(() => expect(f.enqueueWakeup).toHaveBeenCalledTimes(initialEnqueues + 1));
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeGreaterThanOrEqual(firstScan + 30_000));
    expect(tick).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledTimes(2);
    await agentService(db).update(f.agent.id, { runtimeConfig: { heartbeat: { ...policy, enabled: false } } });
    await vi.advanceTimersByTimeAsync(31_000);
    await quiet();
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(initialEnqueues + 1);
  });

  it("derives a real interval deadline from the last checked heartbeat", async () => {
    const f = await fixture();
    expect(await f.queue.nextTimerHeartbeatAt(f.agent, now)).toBe(now.getTime() + 600_000);
    expect(await f.queue.nextTimerHeartbeatAt({ ...f.agent, lastHeartbeatAt: new Date(now.getTime() + 2000) }, now))
      .toBe(now.getTime() + 602_000);
  });

  it.each([{ enabled: false, intervalSec: 600 }, { enabled: true, intervalSec: 0 },
    { enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true }])("is quiet for inactive timer policy %j", async policy => {
    const f = await fixture(policy);
    await db.insert(issues).values({ companyId: f.company.id, title: "Completed history", status: "done", assigneeAgentId: f.agent.id });
    await start(f); await quiet();
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(saved.lastHeartbeatAt).toBeNull();
  });

  it("uses the next UTC day for a reached daily run cap, and no deadline for a zero cap", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, maxDailyRuns: 1 });
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "succeeded", startedAt: now, finishedAt: now });
    expect(await f.queue.nextTimerHeartbeatAt(f.agent, now)).toBe(Date.parse("2026-10-28T00:00:00Z"));
    expect(await f.queue.nextTimerHeartbeatAt({ ...f.agent, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600, maxDailyRuns: 0 } } }, now)).toBeNull();
    expect(await f.queue.nextTimerHeartbeatAt(f.agent, new Date("2026-10-28T00:00:00Z"))).toBe(now.getTime() + 600_000);
  });

  it("defers a reached daily cost cap until UTC midnight", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, maxDailyCostCents: 10 });
    await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.agent.id,
      provider: "test", model: "test", costCents: 10, occurredAt: now });
    expect(await f.queue.nextTimerHeartbeatAt(f.agent, now)).toBe(Date.parse("2026-10-28T00:00:00Z"));
  });

  it("rearms before midnight when an accounting correction lowers today's cost", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, maxDailyCostCents: 10 });
    const [charge] = await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.agent.id,
      provider: "test", model: "test", costCents: 10, occurredAt: now }).returning();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-10-28T00:00:00Z"));
    await billingReconciliationService(db).adjust(f.company.id, charge.id, {
      idempotencyKey: randomUUID(), expectedCents: 10, correctedCents: 5,
      reason: "Correct provider charge", pricing: { source: "operator" },
    }, "timer-test-operator");
    expect((await db.select().from(costEvents).where(eq(costEvents.id, charge.id)))[0].costCents).toBe(5);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("disarms on company archive even when no agent has a live run", async () => {
    const f = await fixture();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    await companyService(db).archive(f.company.id);
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].status).toBe("archived");
    await quiet();
  });

  it.each(["pause", "resume"] as const)("updates timer eligibility after company budget %s", async operation => {
    const f = await fixture();
    const budgets = budgetService(db);
    const policy = { scopeType: "company" as const, scopeId: f.company.id,
      amount: 10, hardStopEnabled: true, notifyEnabled: false };
    await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.agent.id,
      provider: "test", model: "test", costCents: 15, occurredAt: now });
    if (operation === "resume") await budgets.upsertPolicy(f.company.id, policy, null);
    await start(f);
    if (operation === "pause") {
      expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
      await budgets.upsertPolicy(f.company.id, policy, null);
      expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].status).toBe("paused");
      await quiet();
    } else {
      await quiet();
      await budgets.upsertPolicy(f.company.id, { ...policy, amount: 20 }, null);
      expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].status).toBe("active");
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    }
  });

  it("stays quiet when company deletion follows required agent termination", async () => {
    const f = await fixture();
    const lifecycle = startAgentLifecycle(db, {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    }, () => true);
    try {
      await start(f);
      expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
      await createAgentLifecycle(db).terminateAgent(f.agent.id);
      await lifecycle.sweep();
      await quiet();
      await companyService(db).remove(f.company.id);
      expect(await db.select().from(companies).where(eq(companies.id, f.company.id))).toEqual([]);
      await quiet();
    } finally { await lifecycle.stop(); }
  });

  it("disarms a descendant timer when its manager hire approval is rejected", async () => {
    const f = await fixture();
    const [manager] = await db.insert(agents).values({ companyId: f.company.id, name: "Pending manager",
      status: "pending_approval", lifecycleState: "pending_approval", adapterType: "process" }).returning();
    await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, f.agent.id));
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "hire_agent",
      payload: { agentId: manager.id }, status: "pending" }).returning();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    await approvalService(db).reject(approval.id, "timer-test-operator");
    expect((await db.select().from(agents).where(eq(agents.id, manager.id)))[0].status).toBe("terminated");
    await quiet();
  });

  it.each(["prepare", "settle"] as const)("updates the worktree timer gate when a conversation turn does %s", async operation => {
    const f = await fixture();
    f.deps.getWorktreeExecutionCutoff.mockResolvedValue(now);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Worktree conversation",
      status: operation === "prepare" ? "in_review" : "in_progress", assigneeAgentId: f.agent.id,
      conversationAgentId: f.agent.id, conversationUserId: "timer-test-operator", conversationSessionGeneration: 0,
      conversationState: operation === "prepare" ? "waiting" : "active", createdAt: now }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: operation === "prepare" ? "running" : "succeeded",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).returning();
    await start(f);
    if (operation === "prepare") {
      await quiet();
      expect((await prepareConversationTurn(db, run)).conversation).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("in_progress");
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    } else {
      expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
      await db.insert(issueComments).values({ companyId: f.company.id, issueId: issue.id,
        authorAgentId: f.agent.id, createdByRunId: run.id, body: "Turn completed" });
      expect(await settleConversationTurn(db, run)).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("in_review");
      await quiet();
    }
  });

  it("reschedules after the watchdog folds a completed source run", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Finished work",
      status: "done", assigneeAgentId: f.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "running", startedAt: now, contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(activityLog).values({ companyId: f.company.id, actorType: "agent", actorId: f.agent.id,
      runId: run.id, action: "issue.updated", entityType: "issue", entityId: issue.id,
      details: { status: "done" }, createdAt: now });
    await start(f);
    await vi.advanceTimersByTimeAsync(60_000);
    const adapter = createPostgresWatchdogAdapter(db);
    const snapshot = await adapter.findRunForCompany(f.company.id, run.id);
    const sourceIssue = await adapter.findSourceIssue(f.company.id, issue.id);
    const evidence = await adapter.findLatestSameRunTerminalEvidence(f.company.id, {
      runId: run.id, sourceIssueId: issue.id, sourceIssueStatus: "done", evidenceAfter: now,
    });
    expect(snapshot).not.toBeNull(); expect(sourceIssue).not.toBeNull(); expect(evidence).not.toBeNull();
    expect(await adapter.foldSourceResolvedRun(f.company.id, { run: snapshot!, sourceIssue: sourceIssue!, evidence: evidence!,
      existingEvaluation: null, silenceStartedAt: now, silenceAgeMs: 60_000,
      cleanup: { attempted: false, outcome: "no_process_metadata", adapterType: "process" }, now: new Date(),
    })).toMatchObject({ kind: "folded" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    const deadline = saved.lastHeartbeatAt!.getTime() + 600_000;
    expect(deadline).toBeGreaterThan(now.getTime() + 600_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(deadline), { timeout: 3000 });
  });

  it("disarms when an expired skill harness hides the last actionable task", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Expired harness",
      status: "in_progress", assigneeAgentId: f.agent.id, harnessKind: "skill_test" }).returning();
    const [skill] = await db.insert(companySkills).values({ companyId: f.company.id,
      key: "timer-test", slug: "timer-test", name: "Timer test", markdown: "Test" }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId: f.company.id,
      companySkillId: skill.id, revisionNumber: 1 }).returning();
    await db.insert(companySkillTestRuns).values({ companyId: f.company.id, skillId: skill.id,
      skillVersionId: version.id, agentId: f.agent.id, issueId: issue.id, inputSnapshot: "Test",
      harnessIssueExpiresAt: new Date(now.getTime() - 1000) });
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    expect(await companySkillService(db).pruneExpiredTestHarnessIssues(f.company.id, now)).toEqual({ pruned: 1 });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].hiddenAt).toEqual(now);
    await quiet();
  });

  it("disarms when execution disposition blocks the last actionable task", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Unrecoverable task",
      status: "in_progress", assigneeAgentId: f.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "failed", contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: f.agent.id,
      cause: "legacy_execution_requires_reconciliation", fingerprint: run.id, evidence: { runId: run.id },
      nextAction: "Verify execution outcome" });
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    await settleUnrecoverableExecutions(db, now);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("blocked");
    await quiet();
  });

  it("disarms when queue admission blocks a projectless isolated worktree task", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    f.deps.instanceSettings.getExperimental.mockImplementation(() => settings.getExperimental());
    f.deps.getAgent.mockResolvedValue(f.agent);
    const userId = f.company.defaultResponsibleUserId!;
    await db.insert(authUsers).values({ id: userId, name: "Timer operator", email: `${userId}@example.test`,
      createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user",
      principalId: userId, status: "active", membershipRole: "member" });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Projectless isolated task",
      status: "todo", assigneeAgentId: f.agent.id, responsibleUserId: userId,
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } }).returning();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    expect(await f.queue.enqueueWakeup(f.agent.id, { source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned" },
    })).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("blocked");
    await quiet();
  });

  it("reactivates after checkout adopts an execution that finished between its two write attempts", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [oldRun, newRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.agent.id, status: "running" },
      { companyId: f.company.id, agentId: f.agent.id, status: "queued" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Checkout race",
      status: "backlog", assigneeAgentId: f.agent.id, executionRunId: oldRun.id }).returning();
    await start(f); await quiet();
    const transaction = db.transaction.bind(db);
    let firstAttemptSettled = false;
    const intercepted = vi.spyOn(db, "transaction").mockImplementation(async (work, config) => {
      const result = await transaction(work, config);
      if (result === null && !firstAttemptSettled) {
        firstAttemptSettled = true;
        intercepted.mockRestore();


        await quiet();
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, oldRun.id));
      }
      return result;
    });
    try {
      expect(await issueService(db).checkout(issue.id, f.agent.id, ["backlog"], newRun.id))
        .toMatchObject({ status: "in_progress", executionRunId: newRun.id });
      expect(firstAttemptSettled).toBe(true);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    } finally { intercepted.mockRestore(); }
  });

  it("keeps a zero cost cap quiet even when today's positive run cap was also reached", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, maxDailyRuns: 1, maxDailyCostCents: 0 });
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "succeeded", startedAt: now, finishedAt: now });
    await start(f); await quiet();
  });

  it("leaves an empty instance quiet after discovery", async () => {
    const f = await fixture();
    await db.execute(sql`truncate companies cascade`);
    await start(f); await quiet();
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stops admission between due agents without consuming the remaining deadline", async () => {
    const f = await fixture();
    await db.insert(agents).values({ companyId: f.company.id, name: "Second timer", status: "idle",
      lifecycleState: "ready", adapterType: "process", createdAt: now,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } } });
    let canContinue = true;
    f.enqueueWakeup.mockImplementation(async () => {
      canContinue = false;
      return { id: randomUUID() } as typeof heartbeatRuns.$inferSelect;
    });
    const due = new Date(now.getTime() + 600_000);
    expect(await f.scheduling.tickAgentTimers(due, () => canContinue)).toMatchObject({ checked: 1, enqueued: 1 });
    expect(f.enqueueWakeup).toHaveBeenCalledOnce();
    expect((await db.select().from(agents)).filter(agent => agent.lastHeartbeatAt === null)).toHaveLength(1);
    expect(await f.scheduling.nextAgentTimerAt(due)).toBe(due.getTime());
    canContinue = true;
    expect(await f.scheduling.tickAgentTimers(due, () => canContinue)).toMatchObject({ enqueued: 1 });
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(await f.scheduling.nextAgentTimerAt(due)).toBe(due.getTime() + 600_000);
  });

  it.each([false, true])("honors the supported caller-owned configuration transaction, rollback=%s", async rollback => {
    const f = await fixture({ enabled: false, intervalSec: 600 });
    await start(f); await quiet();
    const mutation = db.transaction(async tx => {
      await updateAgentConfigurationInTransaction(tx as unknown as Db, f.agent.id,
        { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } } });
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].runtimeConfig.heartbeat)
        .toEqual({ enabled: false, intervalSec: 600 });
      if (rollback) throw new Error("rollback caller-owned configuration");
    });
    if (rollback) {
      await expect(mutation).rejects.toThrow("rollback caller-owned configuration");
      await quiet();
    } else {
      await mutation;
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    }
  });

  it("reactivates from creation of the first actionable issue", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    await start(f); await quiet();
    await issueService(db).create(f.company.id, { title: "First task", status: "todo", assigneeAgentId: f.agent.id });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it.each([false, true])("keeps agent configuration invisible until its outer transaction ends, rollback=%s", async rollback => {
    const f = await fixture({ enabled: false, intervalSec: 600 });
    await start(f); await quiet();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), written = new Promise<void>(r => { entered = r; });
    const transaction = db.transaction.bind(db);
    const heldTransaction = vi.spyOn(db, "transaction").mockImplementationOnce((work, config) =>
      transaction(async tx => {
        const result = await work(tx);
        entered();
        await held;
        if (rollback) throw new Error("rollback timer config");
        return result;
      }, config));
    const mutation = agentService(db).update(f.agent.id, {
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } },
    }).then(() => null, error => error as Error);
    try {

      const earlyError = await Promise.race([written.then(() => null), mutation]);
      expect(earlyError).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].runtimeConfig.heartbeat).toEqual({ enabled: false, intervalSec: 600 });
    } finally {
      release();
      const error = await mutation;
      heldTransaction.mockRestore();
      if (rollback) expect(error?.message).toBe("rollback timer config");
      else expect(error).toBeNull();
    }
    if (rollback) await quiet();
    else await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("claims a due timer only once and publishes its timestamp change at outer commit", async () => {
    const f = await fixture();
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.agentTimers, event => events.push(event));
    const due = new Date(now.getTime() + 600_000);
    try {
      await db.transaction(async tx => {
        const owner = tx as unknown as Db;
        const queue = createHeartbeatQueue(owner, createHeartbeatQueueTestDependencies(owner));
        expect(await queue.claimDueTimerHeartbeat(f.agent, due, 600)).toEqual({ wasFirstHeartbeat: true });
        expect(events).toContain("intent");
        expect(events).not.toContain("settled");
        expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lastHeartbeatAt).toBeNull();
      });
      expect(events).toContain("settled");
      expect(await f.queue.claimDueTimerHeartbeat(f.agent, due, 600)).toBeNull();
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lastHeartbeatAt).toEqual(due);
    } finally { unsubscribe(); }
  });

  it("disarms on pause and reactivates only after lifecycle resume completes", async () => {
    const f = await fixture();
    const lifecycle = startAgentLifecycle(db, {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    }, () => true);
    try {
      await start(f);
      expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
      await createAgentLifecycle(db).pauseAgent(f.agent.id);
      await lifecycle.sweep();
      await quiet();
      await createAgentLifecycle(db).resumeAgent(f.agent.id);
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("paused");
      await lifecycle.sweep();
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    } finally { await lifecycle.stop(); }
  });

  it("reactivates when the company becomes active", async () => {
    const f = await fixture();
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    await start(f); await quiet();
    await companyService(db).update(f.company.id, { status: "active" });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("reschedules after a real heartbeat completion changes the last heartbeat", async () => {
    const f = await fixture();
    await start(f);
    await vi.advanceTimersByTimeAsync(60_000);
    await createHeartbeatAgentStatus(db).finalizeAgentStatus(f.agent.id, "succeeded");
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    const deadline = saved.lastHeartbeatAt!.getTime() + 600_000;
    expect(deadline).toBeGreaterThan(now.getTime() + 600_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(deadline), { timeout: 3000 });
  });

  it("reactivates when checkout assigns the first actionable issue", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Unclaimed", status: "backlog" }).returning();
    await start(f); await quiet();
    await issueService(db).checkout(issue.id, f.agent.id, ["backlog"], null);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it.each(["release", "adminForceRelease", "remove"] as const)("disarms when %s removes the last actionable assignment", async operation => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Only task", status: "in_progress", assigneeAgentId: f.agent.id }).returning();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000);
    const service = issueService(db);
    if (operation === "adminForceRelease") await service.adminForceRelease(issue.id, { clearAssignee: true });
    else await service[operation](issue.id);
    await quiet();
  });

  it("reactivates a descendant after its terminated manager is purged", async () => {
    const f = await fixture();
    const [manager] = await db.insert(agents).values({ companyId: f.company.id, name: "Former manager",
      status: "terminated", lifecycleState: "terminated", adapterType: "process" }).returning();
    await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, f.agent.id));
    await start(f); await quiet();
    await createAgentLifecycle(db).purgeAgent(manager.id);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("dispatches at the saved deadline and reconstructs the following deadline after restart", async () => {
    const f = await fixture();
    await start(f);
    await vi.advanceTimersByTimeAsync(599_000);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.enqueueWakeup).toHaveBeenCalledOnce());
    expect(f.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({
      source: "timer", reason: "heartbeat_timer",
    }));
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(saved.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 600_000);
    const next = saved.lastHeartbeatAt!.getTime() + 600_000;
    await coordinator!.stop(); coordinator = undefined;
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(next);
    expect(f.enqueueWakeup).toHaveBeenCalledOnce();
    await agentService(db).update(f.agent.id, { runtimeConfig: { heartbeat: { enabled: false } } });
    await quiet();
  });

  it.each(["idle", "maintenance"] as const)("retains first work committed during %s drain without polling the database", async purpose => {
    const f = await fixture({ enabled: false, intervalSec: 600 });
    await start(f); await quiet();
    startTaskDrain(purpose === "idle" ? { purpose } : {});
    await agentService(db).update(f.agent.id, { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } } });
    await vi.advanceTimersByTimeAsync(2000);


    expect(idleWorkSnapshot().active).toBe(1);
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute"), transaction = vi.spyOn(db, "transaction");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
    } finally { select.mockRestore(); execute.mockRestore(); transaction.mockRestore(); }
    stopTaskDrain();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("does not inspect timer rows during startup drain, then reconstructs them on resume", async () => {
    const f = await fixture();
    startTaskDrain();
    const select = vi.spyOn(db, "select");
    try {
      await start(f);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
    stopTaskDrain();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("retains a failed deadline inspection until a successful bounded retry", async () => {
    const f = await fixture();
    const next = vi.spyOn(f.scheduling, "nextAgentTimerAt").mockRejectedValueOnce(new Error("deadline unavailable"));
    await start(f);
    expect(errors).toHaveLength(1); errors.length = 0;
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("releases a rolled-back timer claim so another claimant can own it", async () => {
    const f = await fixture();
    const due = new Date(now.getTime() + 600_000);
    await expect(db.transaction(async tx => {
      const owner = tx as unknown as Db;
      const queue = createHeartbeatQueue(owner, createHeartbeatQueueTestDependencies(owner));
      expect(await queue.claimDueTimerHeartbeat(f.agent, due, 600)).not.toBeNull();
      throw new Error("rollback claim");
    })).rejects.toThrow("rollback claim");
    const claims = await Promise.all([f.queue.claimDueTimerHeartbeat(f.agent, due, 600), f.queue.claimDueTimerHeartbeat(f.agent, due, 600)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it.each(["no work", "daily cap", "issue daily cap"] as const)("notifies a timestamp change from manual timer admission skipped for %s", async reason => {
    const f = await fixture({ enabled: true, intervalSec: 600,
      ...(reason === "no work" ? { skipTimerWhenNoActionableWork: true } : { maxDailyRuns: 0 }) });
    f.deps.getAgent.mockResolvedValue(f.agent);
    const [issue] = reason === "issue daily cap" ? await db.insert(issues).values({
      companyId: f.company.id, title: "Capped task", status: "todo", assigneeAgentId: f.agent.id,
    }).returning() : [];
    if (issue) f.deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false } as never);
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.agentTimers, event => events.push(event));
    try {
      expect(await f.queue.enqueueWakeup(f.agent.id, { source: "timer", reason: "heartbeat_timer",
        ...(issue ? { contextSnapshot: { issueId: issue.id } } : {}),
      })).toBeNull();
      expect(events).toContain("settled");
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lastHeartbeatAt).not.toBeNull();
    } finally { unsubscribe(); }
  });

  it("moves the deadline back from midnight when suppression releases a counted run claim", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, maxDailyRuns: 1 });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "running", startedAt: now }).returning();
    await start(f);
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-10-28T00:00:00Z"));
    await f.queue.releaseRunClaimedJustBeforeSuppression(run.id);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
  });

  it("reactivates when a cancelled issue tree is restored", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Restorable", status: "todo", assigneeAgentId: f.agent.id }).returning();
    const tree = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const cancel = await tree.createHold(f.company.id, issue.id, { mode: "cancel", actor });
    await tree.cancelIssueStatusesForHold(f.company.id, issue.id, cancel.hold.id);
    await start(f); await quiet();
    const restore = await tree.createHold(f.company.id, issue.id, { mode: "restore", actor });
    const result = await tree.restoreIssueStatusesForHold(f.company.id, issue.id, restore.hold.id, { actor });
    expect(result.updatedIssueIds).toEqual([issue.id]);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("reactivates when member archival reassigns work to the agent", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [member] = await db.insert(companyMemberships).values({ companyId: f.company.id,
      principalType: "user", principalId: randomUUID(), status: "active", membershipRole: "operator" }).returning();
    await db.insert(issues).values({ companyId: f.company.id, title: "Reassigned", status: "in_progress", assigneeUserId: member.principalId });
    await start(f); await quiet();
    await accessService(db).archiveMember(f.company.id, member.id, { reassignment: { assigneeAgentId: f.agent.id } });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("reads fresh worktree activation before deciding that no timer is due", async () => {
    const f = await fixture();
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "timer-fixture" };
    const settings = instanceSettingsService(db, { runtimeEnv, now: () => now });
    await settings.updateExperimental({ enableWorktreeRunExecution: false });
    const heartbeat = heartbeatService(db, { runtimeEnv });
    expect((await heartbeat.resolveSchedulingSuppression(true)).suppressed).toBe(true);
    await settings.updateExperimental({ enableWorktreeRunExecution: true });
    await db.insert(issues).values({ companyId: f.company.id, title: "New worktree work", status: "todo",
      assigneeAgentId: f.agent.id, createdAt: now });
    expect(await heartbeat.nextAgentTimerAt()).toBe(now.getTime() + 600_000);
    await settings.updateExperimental({ enableWorktreeRunExecution: false });
    expect(await heartbeat.nextAgentTimerAt()).toBeNull();
  });

  it("publishes a timer wake when the worktree activation setting changes", async () => {
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "timer-fixture" };
    const settings = instanceSettingsService(db, { runtimeEnv, now: () => now });
    await settings.updateExperimental({ enableWorktreeRunExecution: false });
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.agentTimers, event => events.push(event));
    try {
      await settings.updateExperimental({ enableWorktreeRunExecution: true });
      expect(events).toContain("settled");
    } finally { unsubscribe(); }
  });

  it("reactivates when an incoming message resumes an idle external conversation", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Conversation", status: "in_review", assigneeAgentId: f.agent.id }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id,
      name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id,
      provider: "slack", publicId: randomUUID(), assignedAgentId: f.agent.id, status: "active" }).returning();
    await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint.id, issueId: issue.id,
      externalConversationId: "channel", externalThreadId: "thread", externalLabel: "#timer-test", state: "waiting" });
    await start(f); await quiet();
    await db.transaction(tx => resumeExternalConversation(tx as unknown as Db, f.company.id, issue.id));
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("todo");
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("reactivates through the real agent configuration producer", async () => {
    const f = await fixture({ enabled: false, intervalSec: 600 });
    await start(f); await quiet();
    await agentService(db).update(f.agent.id, { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } } });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });

  it("reactivates when the real issue producer creates actionable work", async () => {
    const f = await fixture({ enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true });
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Upcoming task", status: "backlog", assigneeAgentId: f.agent.id }).returning();
    await start(f); await quiet();
    await issueService(db).update(issue.id, { status: "todo" });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(now.getTime() + 600_000), { timeout: 3000 });
  });
});
