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
import { agents, agentWakeupRequests, applyPendingMigrations, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { bindIdleDeadlineOwner } from "../services/idle-deadline-owner.js";
import { readIdleRetrySchedule } from "../services/heartbeat/idle-retry-schedule.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import type { IdleDeadlineOwners } from "../services/idle-deadline-types.js";
import type { VerifiedIdleCapabilities } from "../services/idle-incoming-wake-capability.js";

// External-only: this suite must never silently start an embedded cluster.
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
    // Controlled agent: run the real local process, then use the ordinary task
    // comment/completion services under that admitted run's identity. Stdout
    // alone is not a task disposition and correctly triggers repair work.
    registerServerAdapter({ ...processAdapter, type: "recovery_deadline_process", execute: async context => {
      const result = await processAdapter.execute(context);
      if (result.exitCode === 0 && !result.timedOut && !result.errorCode) {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
        if (!current?.issueId) throw new Error("Controlled agent requires its admitted task");
        const tasks = issueService(db);
        await tasks.addComment(current.issueId, "The controlled local process produced recovery-deadline-result; task completed.",
          { agentId: context.agent.id, runId: context.runId });
        await tasks.update(current.issueId, { status: "done", companyGuard: current.companyId,
          actorAgentId: context.agent.id, actorRunId: context.runId });
      }
      return result;
    } });
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db);
    owners = {}; draining = false; errors.length = 0;
    holdStartedAt = new Date(Date.now() - 1000); holdExpiresAt = new Date(Date.now() + 300_000);
  });
  afterEach(async () => {
    await monitorWorker?.stop(); await recoveryWorker?.stop();
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
    worker = undefined; coordinator = undefined; monitorWorker = undefined; recoveryWorker = undefined;
    vi.useRealTimers();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { unregisterServerAdapter("recovery_deadline_process"); await db?.$client.end({ timeout: 1 }); });

  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
      canReconcile: () => true, onError: error => errors.push(error) });
    worker = heartbeat.registerRunDispatchWork(coordinator, () => !draining);
    owners.retries = bindIdleDeadlineOwner(worker.retries.reconciliationSnapshot, readIdleRetrySchedule,
      snapshot => ({ coverage: { kind: "scheduled_retries", runIds: snapshot.runIds, wakeIds: snapshot.wakeIds }, issueWaits: snapshot.issueWaits }));
    await worker.ready;
  }
  async function settled() {
    await vi.waitFor(() => {
      expect(worker!.retries.reconciliationSnapshot().reconciled).toBe(true);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5_000 });
  }
  async function fixture(options: { retainedSourceLock?: boolean; quotaResetAt?: Date } = {}) {
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
    const [issue] = await db.insert(issues).values({ companyId, title: "Retry producer acceptance", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "failed", responsibleUserId: "recovery-test-user", errorCode: options.quotaResetAt ? "provider_quota" : "codex_transient_upstream", finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, ...(options.quotaResetAt ? {
        errorFamily: "provider_quota", retryNotBefore: options.quotaResetAt.toISOString(), providerQuotaRetryNotBefore: options.quotaResetAt.toISOString(),
      } : {}) }, contextSnapshot: { issueId: issue.id },
    }).returning();
    if (options.retainedSourceLock !== false)
      await db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, source };
  }
  async function schedule(sourceId: string, delayMs = 600_000) {
    const result = await heartbeat.scheduleBoundedRetry(sourceId, { delayMs, random: () => 0 });
    if (result.outcome !== "scheduled") throw new Error(`Retry producer failed: ${result.outcome}`);
    return result;
  }
  const run = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
  async function proof() {
    const at = Date.now();
    const before = { local: idleWorkSnapshot(), retry: worker?.retries.reconciliationSnapshot(),
      monitor: monitorWorker?.reconciliationSnapshot(), watchdog: recoveryWorker?.watchdogs.reconciliationSnapshot(), next: coordinator?.nextWakeAt() };
    const report = await readIdleSleepSafety(db, () => ({ ownerId, draining: true, startedAt: holdStartedAt,
      expiresAt: holdExpiresAt, activeRuns: 0, pendingWakes: 0 }), () => at, ownerId,
    // This is a domain/DB proof test, not filesystem or deployed host qualification.
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
    // The real-clock worker restores the exact saved deadline. PostgreSQL's
    // controller lease and local process therefore share the same wall clock.
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
    // The producer also wakes queued-run reconciliation. A ready monitor is
    // not proof that its admitted coalesced sibling has released its hold.
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
    // Fault states stay blocked independently of the global run/wake checks.
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
    // Company invalidations are intentionally throttled by the existing 30s
    // scoped reconstruction duty. It must finish, not be exported as a timer
    // certificate or confused with the separate 15s first-run grace.
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

});
