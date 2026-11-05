import { controlledCompanyBootstrapResult, controlledCompanyBootstrapScript } from "./helpers/recovery-deadline-bootstrap.js";
import * as legacySettlement from "../services/heartbeat/legacy-process-settlement.js";
import express, { type Request } from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { registerBudgetEnforcementWork } from "../services/budget-enforcement-worker.js";
import { hasPendingBudgetEvaluation, queueBudgetEvaluation } from "../services/budget-evaluation-work.js";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { readIdleQuotaSchedule } from "../services/heartbeat/idle-quota-schedule.js";
import { registerDeadlineWork } from "../services/deadline-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { processAdapter } from "../adapters/process/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { issueService } from "../services/issues.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, applyPendingMigrations, authUsers, companies, companyMemberships, createDb, environmentLeases, issueExecutionDecisions, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { bindIdleDeadlineOwner } from "../services/idle-deadline-owner.js";
import { readIdleRetrySchedule } from "../services/heartbeat/idle-retry-schedule.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { idleDeadlineRowLimit, type IdleDeadlineOwners } from "../services/idle-deadline-types.js";
import type { VerifiedIdleCapabilities } from "../services/idle-incoming-wake-capability.js";

const fixtureUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_DEADLINES_TEST_DATABASE_URL");
const adminUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_DEADLINES_TEST_ADMIN_DATABASE_URL");
const connectionFields = ["hostname", "port", "pathname"] as const;
if (fixtureUrl && (!adminUrl || connectionFields.some(key =>
  new URL(fixtureUrl)[key] !== new URL(adminUrl)[key]))) {
  throw new Error("Recovery deadline acceptance requires explicit admin and fixture URLs for the same dedicated test database");
}

describe.skipIf(!fixtureUrl)("recovery deadline producer, proof and resumed execution (real PostgreSQL/local process)", () => {
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]> | undefined;
  let owners: IdleDeadlineOwners;
  let budgetWorker: ReturnType<typeof registerBudgetEnforcementWork> | undefined;
  let monitorWorker: ReturnType<typeof registerDeadlineWork> | undefined;
  let recoveryWorker: ReturnType<ReturnType<typeof heartbeatService>["registerIssueStateRecoveryWork"]> | undefined;
  let draining = false;
  let holdStartedAt: Date;
  let holdExpiresAt: Date;
  const ownerId = randomUUID();
  const errors: unknown[] = [];

  beforeAll(async () => {
    await applyPendingMigrations(adminUrl!);
    db = createDb(fixtureUrl!, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    registerServerAdapter({ ...processAdapter, type: "recovery_deadline_process", execute: async context => {
      const result = controlledCompanyBootstrapResult(context.config, await processAdapter.execute(context));
      if (result.exitCode === 0 && !result.timedOut && !result.errorCode) {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
        if (!current) throw new Error("Controlled agent requires its admitted run");
        if (current.scopeKind === "company" && current.issueId === null) return result;
        if (!current.issueId) throw new Error("Controlled agent requires its admitted task");
        const tasks = issueService(db);
        await tasks.addComment(current.issueId, "The controlled local process produced recovery-deadline-result; task completed.",
          { agentId: context.agent.id, runId: context.runId });
        await tasks.update(current.issueId, { status: "done", companyGuard: current.companyId,
          actorAgentId: context.agent.id, actorRunId: context.runId });
      }
      return result;
    } });
  }, 90_000);
  beforeAll(() => {
    registerServerAdapter({ ...processAdapter, type: "recovery_review_process", execute: async context => {
      const result = await processAdapter.execute(context);
      if (result.exitCode === 75) return { ...result,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
      if (result.exitCode === 0 && !result.timedOut && !result.errorCode) {
        const current = await run(context.runId);
        if (!current.issueId) throw new Error("Review agent requires its admitted issue");
        const response = await patchIssue(current.issueId, { type: "agent", agentId: context.agent.id,
          companyId: current.companyId, runId: context.runId },
        { status: "done", comment: "Reviewed the controlled local process result; approved." });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      return result;
    } });
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db);
    owners = {}; draining = false; errors.length = 0;
    holdStartedAt = new Date(Date.now() - 1000); holdExpiresAt = new Date(Date.now() + 300_000);
  });
  afterEach(async () => {
    await monitorWorker?.stop(); await recoveryWorker?.stop(); await budgetWorker?.stop();
    await worker?.stop(); await coordinator?.stop();
    await heartbeat.drainActiveRunExecutions();
    const auditRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, retryOfRunId: heartbeatRuns.retryOfRunId,
      reason: heartbeatRuns.scheduledRetryReason, dueAt: heartbeatRuns.scheduledRetryAt, errorCode: heartbeatRuns.errorCode,
      startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      source: sql<unknown>`${heartbeatRuns.contextSnapshot}->'source'`, wakeReason: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeReason'`,
      retryContext: sql<unknown>`${heartbeatRuns.contextSnapshot}->'retryOfRunId'` }).from(heartbeatRuns);
    const auditWakes = await db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId,
      reason: agentWakeupRequests.reason, source: agentWakeupRequests.source, status: agentWakeupRequests.status }).from(agentWakeupRequests);
    process.stderr.write(`recovery teardown causal audit ${JSON.stringify({ runs: auditRuns, wakes: auditWakes })}\n`);
    worker = undefined; coordinator = undefined; monitorWorker = undefined; recoveryWorker = undefined; budgetWorker = undefined;
    vi.useRealTimers();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { unregisterServerAdapter("recovery_deadline_process"); unregisterServerAdapter("recovery_review_process"); await db?.$client.end({ timeout: 1 }); });

  async function start(options: { budgets?: boolean } = {}) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
      canReconcile: () => true, onError: error => errors.push(error) });
    worker = heartbeat.registerRunDispatchWork(coordinator, () => !draining);
    owners.retries = bindIdleDeadlineOwner(worker.retries.reconciliationSnapshot, readIdleRetrySchedule,
      snapshot => ({ coverage: { kind: "scheduled_retries", runIds: snapshot.runIds, wakeIds: snapshot.wakeIds }, issueWaits: snapshot.issueWaits }));
    if (options.budgets !== false) {
      budgetWorker = registerBudgetEnforcementWork(db, coordinator, { cancelWorkForScope: heartbeat.cancelBudgetScopeWork });
      await budgetWorker.ready;
    }
    await worker.ready;
  }
  async function settled() {
    await vi.waitFor(() => {
      expect(worker!.retries.reconciliationSnapshot().reconciled).toBe(true);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5_000 });
  }
  async function fixture(options: { retainedSourceLock?: boolean; quotaResetAt?: Date; companyScope?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(authUsers).values({ id: "recovery-test-user", name: "Recovery test owner", email: "recovery-owner@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Recovery deadline acceptance",
      issuePrefix: `R${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "recovery-test-user" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Controlled process", role: "engineer", status: "idle",
      adapterType: "recovery_deadline_process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('recovery-deadline-result')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
    }).returning();
    await db.insert(companyMemberships).values([
      { companyId, principalId: "recovery-test-user", principalType: "user", status: "active", membershipRole: "owner" },
      { companyId, principalId: agent.id, principalType: "agent", status: "active", membershipRole: "member" },
    ]);
    const [issue] = await db.insert(issues).values({ companyId, title: "Retry producer acceptance", status: options.companyScope ? "done" : "in_progress", assigneeAgentId: agent.id }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: options.companyScope ? "company" : "issue", issueId: options.companyScope ? null : issue.id,
      status: "failed", responsibleUserId: "recovery-test-user", errorCode: options.quotaResetAt ? "provider_quota" : "codex_transient_upstream", finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, ...(options.quotaResetAt ? {
        errorFamily: "provider_quota", retryNotBefore: options.quotaResetAt.toISOString(), providerQuotaRetryNotBefore: options.quotaResetAt.toISOString(),
      } : {}) }, contextSnapshot: options.companyScope ? {} : { issueId: issue.id },
    }).returning();
    if (!options.companyScope && options.retainedSourceLock !== false)
      await db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, source };
  }
  async function schedule(sourceId: string, delayMs = 600_000) {
    const result = await heartbeat.scheduleBoundedRetry(sourceId, { delayMs, random: () => 0 });
    if (result.outcome !== "scheduled") throw new Error(`Retry producer failed: ${JSON.stringify(result)}`);
    return result;
  }
  async function patchIssue(issueId: string, actor: Request["actor"], body: Record<string, unknown>) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1])); app.use(errorHandler);
    return request(app).patch(`/api/issues/${issueId}`).send(body);
  }
  async function reviewFailure(quota: boolean) {
    const f = await fixture({ retainedSourceLock: false });
    const reset = new Date(Math.ceil((Date.now() + 40_000) / 60_000) * 60_000);
    const resetClock = `${reset.getUTCHours()}:${String(reset.getUTCMinutes()).padStart(2, "0")}`;
    const message = quota ? `You've hit your usage limit. Try again at ${resetClock} (UTC).` : "Controlled review bootstrap unavailable";
    const [reviewer] = await db.insert(agents).values({ companyId: f.companyId, name: "Controlled reviewer", role: "qa",
      status: "paused", adapterType: "recovery_review_process",
      adapterConfig: { command: process.execPath, args: ["-e", `console.error(${JSON.stringify(message)});process.exit(75)`], cwd: process.cwd() },
      runtimeConfig: f.agent.runtimeConfig,
    }).returning();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: reviewer.id,
      principalType: "agent", status: "active", membershipRole: "member" });
    const stageId = randomUUID();
    const response = await patchIssue(f.issue.id, { type: "board", userId: "recovery-test-user",
      companyIds: [f.companyId], isInstanceAdmin: true, source: "local_implicit" },
    { status: "in_review", comment: "Implementation ready for controlled review.", executionPolicy: {
      stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }],
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [pending] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(pending).toMatchObject({ status: "in_review", executionState: { status: "pending", currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: reviewer.id } } });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewer.id));
    await start(); await settled();
    const source = await heartbeat.wakeup(reviewer.id, { source: "on_demand", reason: "execution_review_participant_recovery",
      requestedByActorType: "system", contextSnapshot: { issueId: f.issue.id, currentStageId: stageId } });
    if (!source) throw new Error("Current reviewer was not admitted");
    await vi.waitFor(async () => expect((await run(source.id)).status).toBe("failed"), { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();
    const saved = await run(source.id);
    expect(saved.stderrExcerpt).toContain(message);
    expect(saved.resultJson?.executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
    await db.update(agents).set({ status: "idle", adapterConfig: { command: process.execPath,
      args: ["-e", "console.log('recovery-review-result')"], cwd: process.cwd() } }).where(eq(agents.id, reviewer.id));
    return { ...f, reviewer, stageId, reviewSource: saved, reset };
  }
  async function actualCompanyFailure(expectReceipt = true) {
    const f = await fixture({ companyScope: true });
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", controlledCompanyBootstrapScript],
      cwd: process.cwd() } }).where(eq(agents.id, f.agent.id));
    await start(); await settled();
    const admitted = await heartbeat.wakeup(f.agent.id, { source: "on_demand", reason: "manual",
      requestedByActorType: "system", contextSnapshot: {} });
    if (!admitted) throw new Error("Company failure source was not admitted");
    await vi.waitFor(async () => expect((await run(admitted.id)).status).toBe("failed"), { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();
    const failed = await run(admitted.id);
    expect(failed).toMatchObject({ scopeKind: "company", issueId: null, status: "failed", errorCode: "adapter_failed" });
    expect(failed.stderrExcerpt).toContain("Controlled review bootstrap unavailable");
    expect(failed.processPid).toBeGreaterThan(1); expect(failed.processGroupId).toBeGreaterThan(1);
    expect(failed.processStartedAt).toBeInstanceOf(Date); expect(failed.controllerBootId).toEqual(expect.any(String));
    expect(failed.controllerLeaseExpiresAt).toBeNull();
    if (expectReceipt) expect(legacySettlement.legacySourceProcessSettled(failed)).toBe(true);
    else expect(failed.legacyProcessSettlement).toBeNull();
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", "console.log('recovery-deadline-result')"], cwd: process.cwd() } }).where(eq(agents.id, f.agent.id));
    return { ...f, actualSource: failed };
  }
  async function assertReviewResult(f: Awaited<ReturnType<typeof reviewFailure>>, retryId: string) {
    await vi.waitFor(async () => expect((await run(retryId)).status).toBe("succeeded"), { timeout: 45_000 });
    await heartbeat.drainActiveRunExecutions();
    expect((await run(retryId)).stdoutExcerpt).toContain("recovery-review-result");
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(task.status).toBe("done");
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ stageId: f.stageId, actorAgentId: f.reviewer.id, createdByRunId: retryId, outcome: "approved" });
    const starts = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, retryId),
      eq(heartbeatRunEvents.message, "run started")));
    expect(starts).toHaveLength(1);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.reviewSource.id));
    expect(successors.map(row => row.id)).toEqual([retryId]);
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
  }
  const run = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
  async function proof() {
    const at = Date.now();
    const before = { local: idleWorkSnapshot(), retry: worker?.retries.reconciliationSnapshot(),
      monitor: monitorWorker?.reconciliationSnapshot(), watchdog: recoveryWorker?.watchdogs.reconciliationSnapshot(), next: coordinator?.nextWakeAt() };
    const report = await readIdleSleepSafety(db, () => ({ ownerId, draining: true, startedAt: holdStartedAt,
      expiresAt: holdExpiresAt, activeRuns: 0, pendingWakes: 0 }), () => at, ownerId,
    async () => "none", undefined, undefined, true, true,
    { deadlineCapability: { deadlineCatalog: "domain_deadlines_v1" } as VerifiedIdleCapabilities, deadlineOwners: owners,
      collectDiagnostics: true });
    const after = { local: idleWorkSnapshot(), retry: worker?.retries.reconciliationSnapshot(),
      monitor: monitorWorker?.reconciliationSnapshot(), watchdog: recoveryWorker?.watchdogs.reconciliationSnapshot(), next: coordinator?.nextWakeAt() };
    process.stderr.write(`proof revision audit ${JSON.stringify({ at, before, after, result: report.backgroundWork })}\n`);
    return report;
  }
  async function finish(id: string) {
    await vi.waitFor(async () => expect(["running", "succeeded"]).toContain((await run(id))?.status), { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();
    const saved = await run(id);
    expect(saved.status, JSON.stringify({ errorCode: saved.errorCode, error: saved.error, result: saved.resultJson })).toBe("succeeded");
    expect(saved.stdoutExcerpt).toContain("recovery-deadline-result");
    return saved;
  }

  it("hands off the real paired successor and cold-reconstructs one admitted useful execution", async () => {
    const f = await fixture(); await start(); await settled();
    const scheduled = await schedule(f.source.id, 8_000); await settled();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, scheduled.run.wakeupRequestId!));
    expect(wake).toMatchObject({ runId: scheduled.run.id, agentId: f.agent.id, companyId: f.companyId, status: "queued" });
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(scheduled.dueAt.toISOString());
    await worker!.stop(); await coordinator!.stop();
    expect(worker!.retries.reconciliationSnapshot().reconciled).toBe(false);
    expect((await proof()).backgroundWork).not.toBe("none");
    heartbeat = heartbeatService(db);
    await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime());
    expect(Date.now()).toBeLessThan(scheduled.dueAt.getTime());
    await finish(scheduled.run.id);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.retryOfRunId, f.source.id)));
    expect(successors).toHaveLength(1);
    const starts = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, scheduled.run.id), eq(heartbeatRunEvents.message, "run started")));
    expect(starts).toHaveLength(1);
    await vi.waitFor(() => {
      expect(coordinator!.nextWakeAt()).toBeNull();
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5_000 });
    await heartbeat.drainActiveRunExecutions();
    const executions = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      retryOfRunId: heartbeatRuns.retryOfRunId, wakeupRequestId: heartbeatRuns.wakeupRequestId, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    const [completedTask] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.issue.id));
    expect(completedTask.status).toBe("done");
    const additional = executions.filter(row => ![f.source.id, scheduled.run.id].includes(row.id));
    const audit = additional.map(row => ({ id: row.id, status: row.status, retryOfRunId: row.retryOfRunId,
      retryContext: row.context?.retryOfRunId, source: row.context?.source, wakeReason: row.context?.wakeReason }));
    const wakes = await db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId,
      status: agentWakeupRequests.status, source: agentWakeupRequests.source, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    process.stderr.write(`retry execution lineage audit ${JSON.stringify({ sourceRunId: f.source.id, scheduledRunId: scheduled.run.id,
      starts: starts.length, additional: audit, wakes })}\n`);
    expect(additional, JSON.stringify(audit)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, scheduled.run.id)))).toHaveLength(1);
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
  }, 30_000);

  it.each([false, true])("cold-reconstructs a real company retry with represented coalescence=%s exactly once", async coalesce => {
    const f = await fixture({ companyScope: true }); await start(); await settled();
    const scheduled = await schedule(f.source.id, 30_000); await settled();
    expect(scheduled.dueAt.getTime() - scheduled.run.createdAt.getTime()).toBeGreaterThanOrEqual(29_000);
    expect(scheduled.run).toMatchObject({ scopeKind: "company", issueId: null, retryOfRunId: f.source.id });
    if (coalesce) {
      const accepted = await heartbeat.wakeup(f.agent.id, { source: "on_demand", reason: "company_retry_followup",
        contextSnapshot: { companyRetryInput: "retained-input" }, requestedByActorType: "system" });
      expect(accepted?.id).toBe(scheduled.run.id);
      const receipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.runId, scheduled.run.id), eq(agentWakeupRequests.status, "coalesced")));
      expect(receipts).toHaveLength(1); const coalescedId = receipts[0].id;
      expect(receipts[0].finishedAt).not.toBeNull();
      expect((await run(scheduled.run.id)).contextSnapshot?.companyRetryInput).toBe("retained-input");
      const payload = receipts[0].payload;
      const foreign = await fixture({ companyScope: true });
      for (const patch of [{ companyId: foreign.companyId }, { agentId: foreign.agent.id }, { runId: null },
        { finishedAt: null }, { payload: { ...payload, unrepresentedInput: "lost" } }]) {
        await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, coalescedId));
        expect((await proof()).backgroundWork).not.toBe("none");
        await db.update(agentWakeupRequests).set({ payload, finishedAt: receipts[0].finishedAt, companyId: f.companyId, agentId: f.agent.id, runId: scheduled.run.id }).where(eq(agentWakeupRequests.id, coalescedId));
      }
    }
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(scheduled.dueAt.toISOString());
    await worker!.stop(); await coordinator!.stop();
    expect((await proof()).backgroundWork).not.toBe("none");
    heartbeat = heartbeatService(db); await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime());
    await vi.waitFor(async () => expect((await run(scheduled.run.id)).status).toBe("succeeded"), { timeout: 40_000 });
    await heartbeat.drainActiveRunExecutions();
    const saved = await run(scheduled.run.id);
    expect(saved.stdoutExcerpt).toContain("recovery-deadline-result");
    if (coalesce) expect(saved.contextSnapshot?.companyRetryInput).toBe("retained-input");
    const all = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(all.map(row => row.id).sort()).toEqual([f.source.id, scheduled.run.id].sort());
    const starts = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, scheduled.run.id),
      eq(heartbeatRunEvents.message, "run started")));
    expect(starts).toHaveLength(1);
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
  }, 60_000);

  it("cold-reconstructs an actual failed company process history without erasing its identity", async () => {
    const f = await actualCompanyFailure();
    const scheduled = await schedule(f.actualSource.id, 30_000); await settled();
    const report = await proof(); expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(scheduled.dueAt.toISOString());
    const receipt = f.actualSource.legacyProcessSettlement;
    for (const patch of [{ legacyProcessSettlement: null }, { legacyProcessSettlement: {} },
      { legacyProcessSettlement: { ...receipt, processPid: "malformed" } },
      { legacyProcessSettlement: { ...receipt, companyId: randomUUID() } },
      { processPid: f.actualSource.processPid! + 1 }, { controllerBootId: randomUUID() },
      { controllerLeaseExpiresAt: new Date(0) }, { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }, { processStartedAt: null },
      { resultJson: { ...f.actualSource.resultJson, cancellation: {} } }]) {
      const rollback = new Error("changed historical company settlement rollback");
      await expect(db.transaction(async tx => {
        await tx.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.actualSource.id));
        expect((await readIdleRetrySchedule(tx, Date.now(), worker!.retries.reconciliationSnapshot)).blocked).toBe(true);
        if ("controllerBootId" in patch || "processPid" in patch || "controllerLeaseExpiresAt" in patch ||
            "processStartedAt" in patch || "resultJson" in patch) {
          expect(await legacySettlement.recordLegacyProcessSettlement(tx as unknown as Db, f.actualSource, () => true)).toBe(false);
        }
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
    const pendingCleanupRollback = new Error("pending source cleanup rollback");
    await expect(db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ legacyProcessSettlement: null }).where(eq(heartbeatRuns.id, f.actualSource.id));
      await tx.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.actualSource.id,
        provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
      expect(await legacySettlement.recordLegacyProcessSettlement(tx as unknown as Db, f.actualSource, () => true)).toBe(false);
      const [held] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.actualSource.id));
      expect(held.legacyProcessSettlement).toBeNull();
      expect((await readIdleRetrySchedule(tx, Date.now(), worker!.retries.reconciliationSnapshot)).blocked).toBe(true);
      throw pendingCleanupRollback;
    })).rejects.toThrow(pendingCleanupRollback.message);
    await worker!.stop(); await coordinator!.stop();
    expect((await proof()).backgroundWork).not.toBe("none");
    heartbeat = heartbeatService(db); await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime());
    await vi.waitFor(async () => expect((await run(scheduled.run.id)).status).toBe("succeeded"), { timeout: 45_000 });
    await heartbeat.drainActiveRunExecutions();
    expect((await run(scheduled.run.id)).stdoutExcerpt).toContain("recovery-deadline-result");
    expect((await run(f.actualSource.id)).processPid).toBe(f.actualSource.processPid);
    const starts = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, scheduled.run.id), eq(heartbeatRunEvents.message, "run started")));
    expect(starts).toHaveLength(1);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.actualSource.id));
    expect(successors).toHaveLength(1);
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
  }, 60_000);

  it("keeps failed optional settlement persistence blocked while normal execution cleanup continues", async () => {
    const failedWrite = vi.spyOn(legacySettlement, "recordLegacyProcessSettlement")
      .mockRejectedValue(new Error("controlled optional settlement write failure"));
    try {
      const f = await actualCompanyFailure(false);
      expect(failedWrite).toHaveBeenCalledTimes(1);
      const scheduled = await schedule(f.actualSource.id, 30_000); await settled();
      expect((await proof()).backgroundWork).not.toBe("none");
      expect((await run(f.actualSource.id)).status).toBe("failed");
      await heartbeat.cancelRun(scheduled.run.id, "controlled receipt failure cleanup", { suppressImmediateRecovery: true });
      await heartbeat.drainActiveRunExecutions();
      expect((await run(scheduled.run.id)).status).toBe("cancelled");
    } finally { failedWrite.mockRestore(); }
  }, 30_000);

  it("keeps company cancellation and first producer during drain fenced", async () => {
    const f = await fixture({ companyScope: true }); await start(); await settled();
    const old = await owners.retries!(db, Date.now(), () => {});
    draining = true;
    const scheduled = await schedule(f.source.id, 30_000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5_000 });
    expect(old.current()).toBe(false);
    expect((await proof()).backgroundWork).not.toBe("none");
    draining = false; worker!.wake(); await settled();
    expect((await proof()).backgroundWork).toBe("none");
    for (const principalId of [f.agent.id, "recovery-test-user"]) {
      await db.update(companyMemberships).set({ status: "inactive" }).where(and(
        eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, principalId)));
      expect((await proof()).backgroundWork).not.toBe("none");
      await db.update(companyMemberships).set({ status: "active" }).where(and(
        eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, principalId)));
    }
    await heartbeat.cancelRun(scheduled.run.id, "company operator stop", { suppressImmediateRecovery: true });
    await worker!.stop(); await coordinator!.stop(); heartbeat = heartbeatService(db);
    await start(); await settled();
    expect(await heartbeat.promoteDueScheduledRetries(new Date(scheduled.dueAt.getTime() + 1))).toEqual({ promoted: 0, runIds: [] });
    expect(await run(scheduled.run.id)).toMatchObject({ status: "cancelled", startedAt: null });
  }, 20_000);

  it("cancellation before the deadline invalidates its alarm and prevents resumed execution", async () => {
    const f = await fixture(); await start(); await settled();
    const scheduled = await schedule(f.source.id); await settled();
    const before = await proof(); expect(before.backgroundWork).toBe("none");
    await heartbeat.cancelRun(scheduled.run.id, "operator stop", { suppressImmediateRecovery: true });
    await settled();
    const after = await proof();
    expect(after.deadlineProof?.generation).not.toBe(before.deadlineProof?.generation);
    expect(after.scheduledWake).toBeUndefined();
    await worker!.stop(); await coordinator!.stop(); heartbeat = heartbeatService(db);
    await start();
    expect(await heartbeat.promoteDueScheduledRetries(new Date(scheduled.dueAt.getTime() + 1))).toEqual({ promoted: 0, runIds: [] });
    expect(await run(scheduled.run.id)).toMatchObject({ status: "cancelled", startedAt: null });
  }, 20_000);

  it("retains the first real producer during drain until successful resume reconstruction", async () => {
    const f = await fixture(); await start(); await settled();
    const old = await owners.retries!(db, Date.now(), () => {});
    draining = true;
    const scheduled = await schedule(f.source.id);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5_000 });
    expect(old.current()).toBe(false);
    expect(worker!.retries.reconciliationSnapshot().reconciled).toBe(false);
    expect((await proof()).backgroundWork).not.toBe("none");
    expect((await run(scheduled.run.id)).status).toBe("scheduled_retry");
    draining = false; worker!.wake(); await settled();
    const resumed = await proof();
    expect(resumed.backgroundWork, JSON.stringify(resumed.diagnostics)).toBe("none");
    expect(resumed.scheduledWake?.nextWakeAt).toBe(scheduled.dueAt.toISOString());
    await heartbeat.cancelRun(scheduled.run.id, "fixture cleanup", { suppressImmediateRecovery: true });
  }, 20_000);

  it("cold-reconstructs the current reviewer retry and persists one ordinary review decision", async () => {
    const f = await reviewFailure(false);
    const scheduled = await heartbeat.scheduleBoundedRetry(f.reviewSource.id, { delayMs: 30_000, random: () => 0,
      retryReason: "execution_review_participant_recovery", wakeReason: "execution_review_participant_recovery" });
    if (scheduled.outcome !== "scheduled") throw new Error(`Review retry not scheduled: ${scheduled.outcome}`);
    await settled();
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(scheduled.dueAt.toISOString());
    const [pending] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    for (const state of [{ ...pending.executionState, currentStageId: randomUUID() },
      { ...pending.executionState, currentParticipant: { type: "user", userId: "recovery-test-user" } }]) {
      const rollback = new Error("review retry changed participant rollback");
      await expect(db.transaction(async tx => {
        await tx.update(issues).set({ executionState: state }).where(eq(issues.id, f.issue.id));
        expect((await readIdleRetrySchedule(tx, Date.now(), worker!.retries.reconciliationSnapshot)).blocked).toBe(true);
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
    await worker!.stop(); await coordinator!.stop(); heartbeat = heartbeatService(db);
    expect((await proof()).backgroundWork).not.toBe("none");
    await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime());
    await assertReviewResult(f, scheduled.run.id);
  }, 60_000);

  it("carries actual reviewer quota failure through monitor cold reconstruction, due claim and useful review", async () => {
    const f = await reviewFailure(true);
    const monitor = () => registerDeadlineWork(coordinator!, DELIVERY_QUEUES.issueMonitors, {
      retryMs: 1000, canRun: () => !draining,
      run: signal => heartbeat.tickIssueMonitors(new Date(), () => !signal.aborted && !draining),
      next: () => heartbeat.nextIssueMonitorAt(),
    });
    monitorWorker = monitor(); await monitorWorker.ready;
    owners.quota = bindIdleDeadlineOwner(monitorWorker.reconciliationSnapshot, readIdleQuotaSchedule,
      snapshot => ({ issueWaits: snapshot.issueWaits }));
    const recovery = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    expect(recovery.providerQuotaMonitored).toBe(1);
    await vi.waitFor(() => expect(monitorWorker!.reconciliationSnapshot().reconciled).toBe(true)); await settled();
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(saved.monitorNextCheckAt).toEqual(f.reset);
    expect(saved.executionPolicy?.monitor).toMatchObject({ externalRef: f.reviewSource.id,
      serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME });
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(f.reset.toISOString());
    for (const state of [{ ...saved.executionState, currentStageId: randomUUID() },
      { ...saved.executionState, currentParticipant: { type: "user", userId: "recovery-test-user" } }]) {
      const rollback = new Error("review quota changed authority rollback");
      await expect(db.transaction(async tx => {
        await tx.update(issues).set({ executionState: state }).where(eq(issues.id, f.issue.id));
        expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
    const paused = new Error("review quota revoked current authority rollback");
    await expect(db.transaction(async tx => {
      await tx.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewer.id));
      expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
      throw paused;
    })).rejects.toThrow(paused.message);
    const rollback = new Error("native review quota source rollback");
    await expect(db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.reviewSource.id));
      expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
      throw rollback;
    })).rejects.toThrow(rollback.message);
    await monitorWorker.stop(); await worker!.stop(); await coordinator!.stop();
    heartbeat = heartbeatService(db); await start(); monitorWorker = monitor(); await monitorWorker.ready;
    owners.quota = bindIdleDeadlineOwner(monitorWorker.reconciliationSnapshot, readIdleQuotaSchedule,
      snapshot => ({ issueWaits: snapshot.issueWaits }));
    expect(coordinator!.nextWakeAt()).toBe(f.reset.getTime());
    let retryId = "";
    await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.reviewSource.id));
      expect(rows).toHaveLength(1); retryId = rows[0].id;
      expect(rows[0].scheduledRetryReason).toBe("execution_review_participant_recovery");
    }, { timeout: Math.max(0, f.reset.getTime() - Date.now()) + 10_000 });
    await settled();
    const retry = await run(retryId);
    expect(retry.agentId).toBe(f.reviewer.id);
    expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThan(f.reset.getTime());
    const retryDelay = retry.scheduledRetryAt!.getTime() - retry.createdAt.getTime();
    expect(retryDelay).toBeGreaterThanOrEqual(23_900);
    expect(retryDelay).toBeLessThanOrEqual(36_100);
    const retryProof = await proof();
    expect(retryProof.backgroundWork, JSON.stringify(retryProof.diagnostics)).toBe("none");
    await assertReviewResult(f, retryId);
  }, 170_000);

  it("the quota recovery producer saves an exact future monitor inspected by its registered owner", async () => {
    const reset = new Date(Date.now() + 600_000);
    const f = await fixture({ retainedSourceLock: false, quotaResetAt: reset });
    await start(); await settled();
    monitorWorker = registerDeadlineWork(coordinator!, DELIVERY_QUEUES.issueMonitors, {
      retryMs: 1000, canRun: () => !draining,
      run: signal => heartbeat.tickIssueMonitors(new Date(), () => !signal.aborted && !draining),
      next: () => heartbeat.nextIssueMonitorAt(),
    });
    owners.quota = bindIdleDeadlineOwner(monitorWorker.reconciliationSnapshot, readIdleQuotaSchedule,
      snapshot => ({ issueWaits: snapshot.issueWaits }));
    await monitorWorker.ready;
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    expect(result.providerQuotaMonitored).toBe(1);
    await vi.waitFor(() => expect(monitorWorker!.reconciliationSnapshot().reconciled).toBe(true));
    const [saved] = await db.select({ policy: issues.executionPolicy, at: issues.monitorNextCheckAt }).from(issues).where(eq(issues.id, f.issue.id));
    expect(saved.at).toEqual(reset);
    expect(saved.policy?.monitor).toMatchObject({ serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: f.source.id });
    await settled();
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake?.nextWakeAt).toBe(reset.toISOString());
    await issueService(db).update(f.issue.id, { status: "done", actorUserId: "recovery-test-user", companyGuard: f.companyId });
    await vi.waitFor(() => expect(monitorWorker!.reconciliationSnapshot().reconciled).toBe(true));
    await settled();
    const [completed] = await db.select({ status: issues.status, policy: issues.executionPolicy, at: issues.monitorNextCheckAt,
      claim: issues.monitorWakeRequestedAt, execution: issues.executionRunId, checkout: issues.checkoutRunId, state: issues.executionState })
      .from(issues).where(eq(issues.id, f.issue.id));
    process.stderr.write(`quota completed history audit ${JSON.stringify(completed)}\n`);
    expect(completed).toMatchObject({ status: "done", at: reset, claim: null, execution: null, checkout: null, state: { status: "idle" } });
    expect(completed.policy?.monitor).toMatchObject({ serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: f.source.id });
    const final = await proof();
    expect(final.backgroundWork, JSON.stringify(final.diagnostics)).toBe("none");
    expect(final.scheduledWake).toBeUndefined();
    const afterReset = await readIdleQuotaSchedule(db, reset.getTime() + 1, monitorWorker!.reconciliationSnapshot);
    expect(afterReset).toMatchObject({ blocked: false, deadlines: [] });
    for (const kind of ["run", "wake"] as const) {
      const rollback = new Error(`terminal quota ${kind} rollback`);
      await expect(db.transaction(async tx => {
        if (kind === "run") await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
          scopeKind: "issue", issueId: f.issue.id, status: "queued", contextSnapshot: { issueId: f.issue.id } });
        else await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
          source: "automation", status: "queued", payload: { issueId: f.issue.id } });
        expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
    const foreign = await fixture({ retainedSourceLock: false });
    for (const reference of [foreign.source.id, `{${f.source.id}}`, "not-a-uuid"]) {
      const rollback = new Error("terminal quota foreign or malformed reference rollback");
      await expect(db.transaction(async tx => {
        await tx.execute(sql`UPDATE issues SET execution_policy = jsonb_set(execution_policy,
          '{monitor,externalRef}', to_jsonb(${reference}::text)) WHERE id = ${f.issue.id}::uuid`);
        expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
  }, 20_000);

  it("reconciles a configured watchdog through real review completion and retains quiet reviewed history", async () => {
    const f = await fixture({ retainedSourceLock: false });
    await issueService(db).update(f.issue.id, { status: "done", actorUserId: "recovery-test-user", companyGuard: f.companyId });
    await start(); await settled();
    const configuration = await taskWatchdogService(db).upsertForIssue(f.companyId, f.issue.id, { agentId: f.agent.id });
    const registeredAt = Date.now();
    recoveryWorker = heartbeat.registerIssueStateRecoveryWork(coordinator!, () => !draining);
    owners.watchdogs = bindIdleDeadlineOwner(recoveryWorker.watchdogs.reconciliationSnapshot, heartbeat.readIdleWatchdogSchedule,
      () => ({ coverage: { kind: "watchdogs" } }));
    await recoveryWorker.ready;
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const current = await taskWatchdogService(db).getActiveForIssue(f.companyId, f.issue.id);
      expect(current?.watchdogIssueId).toBeTruthy();
      const [review] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, current!.watchdogIssueId!));
      expect(review.status).toBe("done");
    }, { timeout: 15_000 });
    const pending = recoveryWorker.watchdogs.reconciliationSnapshot();
    process.stderr.write(`watchdog review settlement audit ${JSON.stringify({ registeredAt, now: Date.now(), pending,
      next: coordinator!.nextWakeAt(), local: idleWorkSnapshot() })}\n`);
    if (!pending.reconciled) expect((await proof()).backgroundWork).not.toBe("none");
    await vi.waitFor(() => {
      expect(recoveryWorker!.watchdogs.reconciliationSnapshot().reconciled).toBe(true);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: Math.max(0, registeredAt + 35_000 - Date.now()) + 5_000 });
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    const retained = await taskWatchdogService(db).getActiveForIssue(f.companyId, f.issue.id);
    expect(retained?.id).toBe(configuration.watchdog.id);
    expect(retained?.lastReviewedFingerprint).toBeTruthy();
    expect((await proof()).scheduledWake).toBeUndefined();
  }, 50_000);


  it("batches seven settled watchdogs within the composed proof budget and rejects live or changed owners", async () => {
    const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
    for (let index = 0; index < 7; index++) {
      const f = await fixture({ retainedSourceLock: false });
      await issueService(db).update(f.issue.id, { status: "done", actorUserId: "recovery-test-user", companyGuard: f.companyId });
      await taskWatchdogService(db).upsertForIssue(f.companyId, f.issue.id, { agentId: f.agent.id });
      fixtures.push(f);
    }
    await start(); await settled();
    recoveryWorker = heartbeat.registerIssueStateRecoveryWork(coordinator!, () => !draining);
    const readWatchdogs = bindIdleDeadlineOwner(recoveryWorker.watchdogs.reconciliationSnapshot, heartbeat.readIdleWatchdogSchedule,
      () => ({ coverage: { kind: "watchdogs" } }));
    owners.watchdogs = readWatchdogs;
    await recoveryWorker.ready;
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      for (const f of fixtures) {
        const current = await taskWatchdogService(db).getActiveForIssue(f.companyId, f.issue.id);
        expect(current?.lastReviewedFingerprint).toBeTruthy();
        expect(current?.watchdogIssueId).toBeTruthy();
        const [review] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, current!.watchdogIssueId!));
        expect(review.status).toBe("done");
      }
      expect(recoveryWorker!.watchdogs.reconciliationSnapshot().reconciled).toBe(true);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 65_000 });
    const report = await proof();
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake).toBeUndefined();
    draining = true;
    const f = fixtures[0];
    const [pending] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      issueId: f.issue.id, status: "queued", contextSnapshot: { issueId: f.issue.id } }).returning();
    expect((await proof()).backgroundWork).not.toBe("none");
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, pending.id));
    expect((await proof()).backgroundWork).toBe("none");
    owners.watchdogs = async (...args) => {
      const snapshot = await readWatchdogs(...args);
      await recoveryWorker!.watchdogs.stop();
      return snapshot;
    };
    expect((await proof()).backgroundWork).not.toBe("none");
  }, 80_000);

  it("retains ten thousand completed quota histories within bounded proof and rejects overflow or unfinished work", async () => {
    expect(idleDeadlineRowLimit).toBe(10_000);
    const reset = new Date(Date.now() + 600_000);
    const f = await fixture({ retainedSourceLock: false, quotaResetAt: reset });
    const produced = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    expect(produced.providerQuotaMonitored).toBe(1);
    await issueService(db).update(f.issue.id, { status: "done", actorUserId: "recovery-test-user", companyGuard: f.companyId });
    const growHistory = async (count: number) => {
      await db.execute(sql`
        WITH bindings AS MATERIALIZED (
          SELECT gen_random_uuid() AS issue_id, gen_random_uuid() AS source_id FROM generate_series(1, ${count})
        ), written_issues AS (
          INSERT INTO issues (id, company_id, title, status, assignee_agent_id,
            execution_policy, execution_state, monitor_next_check_at, monitor_attempt_count)
          SELECT b.issue_id, template.company_id, 'Completed quota history', template.status, template.assignee_agent_id,
            jsonb_set(template.execution_policy, '{monitor,externalRef}', to_jsonb(b.source_id::text)),
            jsonb_set(template.execution_state, '{monitor,externalRef}', to_jsonb(b.source_id::text)),
            template.monitor_next_check_at, template.monitor_attempt_count
          FROM bindings b CROSS JOIN issues template WHERE template.id = ${f.issue.id}::uuid
          RETURNING id, company_id, execution_policy
        )
        INSERT INTO heartbeat_runs (id, company_id, agent_id, issue_id, status, finished_at,
          runtime_mode, error_code, result_json, context_snapshot, responsible_user_id)
        SELECT (written.execution_policy#>>'{monitor,externalRef}')::uuid, written.company_id, source.agent_id,
          written.id, source.status, source.finished_at, source.runtime_mode, source.error_code, source.result_json,
          jsonb_build_object('issueId', written.id), source.responsible_user_id
        FROM written_issues written CROSS JOIN heartbeat_runs source WHERE source.id = ${f.source.id}::uuid
      `);
    };
    const [template] = await db.select({ status: issues.status, policy: issues.executionPolicy,
      state: issues.executionState, at: issues.monitorNextCheckAt }).from(issues).where(eq(issues.id, f.issue.id));
    expect(template).toMatchObject({ status: "done", at: reset, state: { status: "idle" } });
    expect(template.policy?.monitor).toMatchObject({ serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: f.source.id });
    await growHistory(9_999);
    const [count] = await db.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM issues WHERE company_id = ${f.companyId}::uuid`);
    expect(count.count).toBe(10_000);
    const [sources] = await db.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM heartbeat_runs WHERE company_id = ${f.companyId}::uuid`);
    expect(sources.count).toBe(10_000);
    await start(); await settled();
    monitorWorker = registerDeadlineWork(coordinator!, DELIVERY_QUEUES.issueMonitors, {
      retryMs: 1000, canRun: () => !draining,
      run: signal => heartbeat.tickIssueMonitors(new Date(), () => !signal.aborted && !draining),
      next: () => heartbeat.nextIssueMonitorAt(),
    });
    const recordScaleFailure = (error: unknown, phase: string) => {
      const failure = error as { name?: string; code?: string; params?: unknown[];
        cause?: { name?: string; code?: string; message?: string } };
      process.stderr.write(`quota scale owner failure ${JSON.stringify({ phase, name: failure.name, code: failure.code,
        parameters: failure.params?.length, cause: failure.cause?.name, causeCode: failure.cause?.code,
        causeMessage: failure.cause?.message?.slice(0, 240) })}\n`);
    };
    owners.quota = bindIdleDeadlineOwner(monitorWorker.reconciliationSnapshot, async (tx, at, owner) => {
      try { return await readIdleQuotaSchedule(tx, at, owner); }
      catch (error) { recordScaleFailure(error, "composed"); throw error; }
    }, snapshot => ({ issueWaits: snapshot.issueWaits }));
    await monitorWorker.ready; await settled();
    const report = await proof();
    if (report.backgroundWork !== "none") {
      try { await readIdleQuotaSchedule(db, Date.now(), monitorWorker.reconciliationSnapshot); }
      catch (error) { recordScaleFailure(error, "direct-owner-diagnostic"); }
    }
    expect(report.backgroundWork, JSON.stringify(report.diagnostics)).toBe("none");
    expect(report.scheduledWake).toBeUndefined();
    for (const kind of ["run", "wake"] as const) {
      const rollback = new Error(`large terminal quota ${kind} rollback`);
      await expect(db.transaction(async tx => {
        if (kind === "run") await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
          issueId: f.issue.id, status: "queued", contextSnapshot: { issueId: f.issue.id } });
        else await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
          source: "automation", status: "queued", payload: { issueId: f.issue.id } });
        expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
        throw rollback;
      })).rejects.toThrow(rollback.message);
    }
    const rollback = new Error("large terminal quota malformed reference rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`UPDATE issues SET execution_policy = jsonb_set(execution_policy,
        '{monitor,externalRef}', to_jsonb('not-a-uuid'::text)) WHERE id = ${f.issue.id}::uuid`);
      expect((await readIdleQuotaSchedule(tx, Date.now(), monitorWorker!.reconciliationSnapshot)).blocked).toBe(true);
      throw rollback;
    })).rejects.toThrow(rollback.message);
    await growHistory(1);
    expect((await readIdleQuotaSchedule(db, Date.now(), monitorWorker.reconciliationSnapshot)).blocked).toBe(true);
  }, 40_000);

  it("blocks unconsumed budget inputs without a live owner and permits sleep only after normal settlement", async () => {
    const f = await fixture({ retainedSourceLock: false });
    await issueService(db).update(f.issue.id, { status: "done", actorUserId: "recovery-test-user", companyGuard: f.companyId });
    await start({ budgets: false }); await settled();
    expect(await hasPendingBudgetEvaluation(db)).toBe(false);
    expect((await proof()).backgroundWork).toBe("none");
    await db.transaction(tx => queueBudgetEvaluation(tx as unknown as Db, { companyId: f.companyId, agentId: f.agent.id }));
    expect(await hasPendingBudgetEvaluation(db)).toBe(true);
    const pending = await proof();
    expect(pending.backgroundWork).toBe("present");
    expect(pending.diagnostics?.checks).toContainEqual({ reason: "budget_evaluation_work", state: "present" });
    budgetWorker = registerBudgetEnforcementWork(db, coordinator!, { cancelWorkForScope: heartbeat.cancelBudgetScopeWork });
    await budgetWorker.ready; await settled();
    expect(await hasPendingBudgetEvaluation(db)).toBe(false);
    const consumed = await proof();
    expect(consumed.backgroundWork, JSON.stringify(consumed.diagnostics)).toBe("none");
  }, 15_000);

});
