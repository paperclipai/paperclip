import { randomUUID } from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate as immediate, setTimeout as realDelay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, closeLivenessDb, closeCheckpointDb,
  heartbeatRuns, heartbeatRunEvents, nativeRunFinalizations, environmentLeases, issueThreadInteractions, applyPendingMigrations,
  issueRecoveryActions, issues, activityLog, agentWakeupRequests } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { notifyLiveRunRecovery, notifyLiveResourceRecovery, notifyStrandedAgentStatus } from "../services/live-run-recovery-notifications.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { writeEnvironmentCleanup } from "../services/environment-cleanup-notifications.js";
import { beginLegacyShutdownWorkspaceSettlement } from "../services/legacy-shutdown-workspace-settlement.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { createHeartbeatRunOutput } from "../services/heartbeat/run-output.js";
import { recoveryService } from "../services/recovery/service.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { persistActivity } from "../services/activity-log.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { createHeartbeatLifecycle } from "../services/heartbeat/run-lifecycle.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { issueService } from "../services/issues.js";
import { logger } from "../middleware/logger.js";

vi.setConfig({ testTimeout: 90_000 });
describe("residual recovery production matrix", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let draining = false, standby = false;
  const errors: unknown[] = [], passes = new Set<Promise<unknown>>();
  const deadlines = new Map<string, () => number | null>();
  const timeline: unknown[] = [];
  const extraStops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LIVE_RECOVERY_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("live-recovery-");
    else await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`); errors.length = 0; deadlines.clear(); timeline.length = 0; draining = false; standby = false;
    heartbeat = heartbeatService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !standby, canReconcile: () => !standby,
      onError: error => errors.push(error) });
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => { deadlines.set(queue, () => task.nextRunAt?.() ?? null); return register(queue, { ...task, onSettled: hints => { timeline.push(["settled", queue, Date.now(), [...hints ?? []]]); task.onSettled?.(hints); }, run: signal => {
      timeline.push(["pass", queue, Date.now()]);
      const pass = Promise.resolve(task.run(signal)); passes.add(pass);
      void pass.then(() => { timeline.push(["finished", queue, Date.now()]); passes.delete(pass); }, () => passes.delete(pass)); return pass;
    } }); };
  });
  afterEach(async () => {
    for (const stop of extraStops.splice(0)) await stop();
    await coordinator.stop(); await heartbeat.drainActiveRunExecutions();
    vi.useRealTimers(); vi.restoreAllMocks(); expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await closeLivenessDb(db, 1); await closeCheckpointDb(db, 1);
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
  });
  async function fixture() {
    const companyId = randomUUID(), actorId = "live-recovery-user";
    await db.insert(authUsers).values({ id: actorId, name: "Recovery owner", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Live recovery", issuePrefix: `LR${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: actorId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
      status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Recovery process", status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('live-recovery-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Recovered work", status: "done", assigneeAgentId: agent.id }).returning();
    return { companyId, agent, issue, actorId };
  }
  async function start(realClock = false) {
    if (!realClock && !vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted = () => !draining && !standby;
    await heartbeat.registerResidualRecoveryWork(coordinator, admitted).ready;
    await heartbeat.registerActiveRunSilenceWork(coordinator, admitted).ready;
    await heartbeat.registerIssueStateRecoveryWork(coordinator, admitted).ready;
    await heartbeat.registerDeferredReceiptWork(coordinator, admitted).ready;
    await heartbeat.registerRunDispatchWork(coordinator, admitted).ready;
    await heartbeat.registerScheduledRetryCancellationWork(coordinator, admitted).ready;
  }
  async function advance(ms: number) {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(500, until - Date.now()));
      await Promise.allSettled([...passes]); await immediate();
    }
  }
  async function quiet() {
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`)).toHaveLength(0);
    const quietAt = Date.now();
    if (vi.isFakeTimers()) await advance(31_000);
    else await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 35_000 });
    console.info("quiet-drain", JSON.stringify({ quietAt, now: Date.now(), active: idleWorkSnapshot().active, next: [...deadlines].map(([q, at]) => [q, at()]), passes: Object.fromEntries([...deadlines.keys()].map(queue => [queue, timeline.filter(event => Array.isArray(event) && event[0] === "pass" && event[1] === queue).length])), settled: timeline.filter(event => Array.isArray(event) && event[0] === "settled") }));
    await vi.waitFor(() => { expect(coordinator.nextWakeAt(), JSON.stringify([...deadlines].map(([name, at]) => [name, at()]))).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
    const queries: string[] = [], prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    try { if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); await vi.advanceTimersByTimeAsync(20 * 60_000); await immediate(); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = prior; }
  }
  async function getRun(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]; }
  async function getLease(id: string) { return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]; }
  it("leaves configured idle and completed native history without a timer or SQL", async () => {
    const f = await fixture();
    const runs = await db.insert(heartbeatRuns).values(Array.from({ length: 150 }, () => ({ companyId: f.companyId,
      agentId: f.agent.id, status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id, finishedAt: new Date() }))).returning();
    await db.insert(nativeRunFinalizations).values(runs.map(run => ({ companyId: f.companyId, issueId: f.issue.id, runId: run.id, phase: "committed" })));
    await start(); await quiet();
  });
  it("catches up native resultless retry debt through its real claim owner without replaying missing state", async () => {
    const f = await fixture(); await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issue.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id, contextSnapshot: { issueId: f.issue.id },
      finishedAt: new Date(), errorCode: "original_native_failure" }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: run.id,
      phase: "retryable_failure", nextAttemptAt: new Date(Date.now() - 1_000) });
    await start();
    await vi.waitFor(async () => {
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0])
        .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, leaseOwner: null });
    });
    expect((await getRun(run.id)).errorCode).toBe("original_native_failure");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issue.id)))
      .toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    await quiet();
  });
  it("consumes the durable native question cancellation from ordinary task completion", async () => {
    const f = await fixture(); await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "running",
      runtimeMode: "native", nativeIssueId: f.issue.id, contextSnapshot: { issueId: f.issue.id }, nativePhase: "awaiting_input" }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: run.id,
      phase: "observed", recoveryState: "awaiting_evidence", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id, kind: "ask_user_questions",
      sourceRunId: run.id, status: "pending", continuationPolicy: "none",
      idempotencyKey: `paperclip-runner-question:${run.id}:question-1`, payload: {
        version: 1, questions: [{ id: "continue", prompt: "Continue?", selectionMode: "single", required: true, allowOther: false, options: [{ id: "yes", label: "Yes" }] }],
        questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "continue", prompt: "Continue?", required: true, answerMode: "single_select", options: [{ id: "yes", label: "Yes" }] }] }, runtimeRequestId: "question-1",
      } });
    await start(); await issueService(db).update(f.issue.id, { status: "done" });
    await vi.waitFor(async () => expect((await getRun(run.id)).status).toBe("cancelled"), { timeout: 15_000 });
    expect((await getRun(run.id)).resultJson).toMatchObject({ cancelledByIssueStatus: "done", cancelledIssueId: f.issue.id });
    await quiet();
  });
  it("preserves a fresh foreign controller until exact expiry and admits one process retry across two owners", async () => {
    const f = await fixture(), expiry = new Date(Date.now() + 3_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "running",
      runtimeMode: "legacy", responsibleUserId: f.actorId, controllerBootId: randomUUID(), controllerLeaseExpiresAt: expiry,
      executionStage: "preparing", updatedAt: new Date(Date.now() - 6 * 60_000), startedAt: new Date(Date.now() - 6 * 60_000) }).returning();
    await start(true);
    const other = heartbeatService(db), competing = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await other.registerResidualRecoveryWork(competing, () => true).ready; extraStops.push(() => competing.stop());
    expect((await getRun(run.id)).status).toBe("running"); expect(coordinator.nextWakeAt()).toBeLessThanOrEqual(expiry.getTime());
    await vi.waitFor(async () => expect((await getRun(run.id)).status).toBe("failed"), { timeout: 10_000 });
    let retryId: string;
    await vi.waitFor(async () => {
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(retries).toHaveLength(1); retryId = retries[0].id;
      await heartbeat.drainActiveRunExecutions(); await other.drainActiveRunExecutions();
      expect((await getRun(retryId)).status).toBe("succeeded");
      expect((await getRun(retryId)).stdoutExcerpt).toContain("live-recovery-proof");
    }, { timeout: 45_000 });
    await competing.stop(); extraStops.pop(); await quiet();
  });
  it("releases a settled native process only after matching host and birth evidence arrives", async () => {
    const f = await fixture(), startedAt = new Date();
    const child = spawn(process.execPath, ["-e", "console.log('identity-proof')"], { stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit");
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, runtimeMode: "native",
      nativeIssueId: f.issue.id, status: "failed", finishedAt: new Date(), processPid: pid, processStartedAt: startedAt,
      runnerProfileJson: { sessionCheckpoint: { sessionId: "preserved-native-session" } } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: run.id, phase: "committed" });
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: f.agent.id, runId: run.id,
      eventType: "native.process_identity_recorded", payload: { targetKind: "local", hostname: os.hostname(),
        processPid: pid, processGroupId: null, processStartedAt: new Date(startedAt.getTime() - 1).toISOString() } });
    await start(); expect((await getRun(run.id)).processPid).toBe(pid);
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: f.agent.id, runId: run.id,
      eventType: "native.process_identity_recorded", payload: { targetKind: "local", hostname: os.hostname(),
        processPid: pid, processGroupId: null, processStartedAt: startedAt.toISOString() } });
    await vi.waitFor(async () => expect((await getRun(run.id)).processPid).toBeNull(), { timeout: 40_000 });
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "native.local_process_stopped")))).toHaveLength(1);
    await quiet();
  });
  it("recovers orphan active leases after restart, including a deleted heartbeat reference, without starving behind 100 guarded rows", async () => {
    const f = await fixture(), foreign = await fixture(), resource = randomUUID(), old = new Date(Date.now() - 6 * 60_000);
    await db.insert(environmentLeases).values({ companyId: foreign.companyId, status: "retained", provider: "fixture", providerLeaseId: resource, updatedAt: old });
    const guarded = await db.insert(environmentLeases).values(Array.from({ length: 105 }, () => ({ companyId: f.companyId,
      status: "active", provider: "fixture", providerLeaseId: resource, updatedAt: old }))).returning();
    const [deleted] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "succeeded", finishedAt: old }).returning();
    const [orphan] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: deleted.id,
      status: "active", provider: "local", updatedAt: old }).returning();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, deleted.id));
    expect((await getLease(orphan.id)).heartbeatRunId).toBeNull(); await start();
    await vi.waitFor(async () => expect((await getLease(orphan.id)).status).toBe("pending_cleanup"), { timeout: 15_000 });
    expect(await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId),
      eq(environmentLeases.status, "pending_cleanup")))).toHaveLength(1);
    for (const row of guarded) expect((await getLease(row.id)).status).toBe("active");
    await quiet();
  });
  it("reactivates an orphan when a different company's physical resource owner releases it", async () => {
    const f = await fixture(), other = await fixture(), old = new Date(Date.now() - 6 * 60_000), resource = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: other.companyId, agentId: other.agent.id, status: "succeeded", finishedAt: old }).returning();
    const [owner] = await db.insert(environmentLeases).values({ companyId: other.companyId, heartbeatRunId: run.id,
      status: "retained", provider: "fixture", providerLeaseId: resource, updatedAt: old }).returning();
    const [orphan] = await db.insert(environmentLeases).values({ companyId: f.companyId, status: "active",
      provider: "fixture", providerLeaseId: resource, updatedAt: old }).returning();
    await start(); expect((await getLease(orphan.id)).status).toBe("active");
    await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, owner.id)), { companyId: other.companyId, runId: run.id, leaseId: owner.id });
    await vi.waitFor(async () => expect((await getLease(orphan.id)).status).toBe("pending_cleanup"), { timeout: 40_000 });
    await quiet();
  });
  it("expires the exact shutdown settlement marker into preserved recovery instead of inferring file export", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id,
      status: "failed", runtimeMode: "legacy", contextSnapshot: { issueId: f.issue.id }, finishedAt: old }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run.id,
      issueId: f.issue.id, status: "active", provider: "fixture", providerLeaseId: randomUUID(), updatedAt: old,
      metadata: { driver: "sandbox" } }).returning();
    await beginLegacyShutdownWorkspaceSettlement(db, run, new Date(Date.now() + 1_500)); await start();
    expect((await getLease(lease.id)).metadata?.legacyShutdownWorkspaceSettlement).toMatchObject({ state: "pending" });
    await vi.waitFor(async () => expect((await getLease(lease.id)).metadata?.legacyShutdownWorkspaceSettlement)
      .toMatchObject({ state: "expired" }), { timeout: 10_000 });
    expect((await getLease(lease.id)).leasePolicy).toBe("retain_on_failure");
    expect((await getLease(lease.id)).metadata?.workspaceRestoreRecovery).toBeTruthy();
    expect((await getLease(lease.id)).providerLeaseId).toBe(lease.providerLeaseId);
    expect((await getLease(lease.id)).metadata).toMatchObject({ workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", runId: run.id } });
    await quiet();
  });
  it("settles stranded agent status at its saved grace", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "succeeded", finishedAt: old });
    await db.transaction(async tx => {
      await notifyStrandedAgentStatus(tx, { companyId: f.companyId, agentId: f.agent.id });
      await tx.update(agents).set({ status: "running", updatedAt: old }).where(eq(agents.id, f.agent.id));
    });
    await start(); await vi.waitFor(async () => expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("idle"));
    await quiet();
  });
  it("moves the silence threshold on actual output and folds same-run completion only at strict snooze expiry", async () => {
    const f = await fixture(), now = new Date(), old = new Date(now.getTime() - 10 * 60_000);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agent.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issue.id },
      responsibleUserId: f.actorId, startedAt: old, processStartedAt: old, updatedAt: old,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(now.getTime() + 60 * 60_000) }).returning();
    const output = createHeartbeatRunOutput(db, { run, runId: run.id, issueId: f.issue.id,
      runLogStore: { begin: async () => ({ store: "local_file", logRef: "fixture-output.ndjson" }), append: async (_handle, event) => Buffer.byteLength(event.chunk) },
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: value => value }, secretKeys: new Set(),
      appendRunEvent: async (_run, event) => { await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: f.agent.id, runId: run.id, ...event }); },
      getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    await (await output.begin(run)).onLog("stdout", "fresh actual output");
    const progressed = await getRun(run.id), snoozedUntil = new Date(progressed.lastOutputAt!.getTime() + 5 * 60_000 + 2_000);
    expect(progressed.lastOutputSeq).toBe(1); expect(progressed.lastOutputAt!.getTime()).toBeGreaterThan(old.getTime());
    await issueService(db).update(f.issue.id, { status: "done" });
    await persistActivity(db, { companyId: f.companyId, actorType: "agent", actorId: f.agent.id, agentId: f.agent.id,
      runId: run.id, entityType: "issue", entityId: f.issue.id, action: "issue.updated", details: { status: "done" } });
    await recoveryService(db, { enqueueWakeup: heartbeat.wakeup }).recordWatchdogDecision({ runId: run.id,
      actor: { type: "board" }, decision: "snooze", snoozedUntil, reason: "Wait for the exact saved deadline" });
    await start();
    await advance(snoozedUntil.getTime() - Date.now() - 1);
    expect((await getRun(run.id)).status).toBe("running");
    await advance(1);
    await vi.waitFor(async () => expect((await getRun(run.id)).status).toBe("succeeded"));
    expect((await getRun(run.id)).resultJson).toMatchObject({ sourceResolvedWatchdogFold: { sourceIssueStatus: "done", sameRunEvidenceKind: "activity" } });
    await quiet();
  });
  it("re-reads a concurrently moved stranded-agent grace before settlement", async () => {
    const f = await fixture(), initialAt = new Date();
    await db.update(agents).set({ status: "running", updatedAt: initialAt }).where(eq(agents.id, f.agent.id));
    await start(); await advance(60_000);
    const moved = new Date();
    await db.update(agents).set({ updatedAt: moved }).where(eq(agents.id, f.agent.id));
    await advance(initialAt.getTime() + 5 * 60_000 - Date.now());
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("running");
    await advance(moved.getTime() + 5 * 60_000 - Date.now());
    await vi.waitFor(async () => expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("idle"));
    await quiet();
  });
  it("reaches a silent run behind more than 100 suppressed live runs and leaves only real controller deadlines", async () => {
    const f = await fixture(), now = new Date(), old = new Date(now.getTime() - 20 * 60_000);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issue.id));
    const expiry = new Date(now.getTime() + 60 * 60_000);
    const suppressed = await db.insert(heartbeatRuns).values(Array.from({ length: 105 }, () => ({ companyId: f.companyId,
      agentId: f.agent.id, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issue.id },
      startedAt: old, updatedAt: old, controllerBootId: randomUUID(), controllerLeaseExpiresAt: expiry }))).returning();
    const [source] = await db.insert(issues).values({ companyId: f.companyId, status: "done", title: "Actual completed source", assigneeAgentId: f.agent.id }).returning();
    const [target] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: source.id },
      startedAt: new Date(old.getTime() + 60_000), updatedAt: old,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: expiry }).returning();
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agent.id,
      agentId: f.agent.id, runId: target.id, entityType: "issue", entityId: source.id, action: "issue.updated", details: { status: "done" } });
    const broad = await recoveryService(db, { enqueueWakeup: heartbeat.wakeup }).scanSilentActiveRuns({ companyId: f.companyId });
    expect(broad.scanned).toBe(100); expect((await getRun(target.id)).status).toBe("running");
    await start(); await advance(31_000);
    await vi.waitFor(async () => expect((await getRun(target.id)).status).toBe("succeeded"));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"))).toHaveLength(suppressed.length);
    expect(deadlines.get("active-run-silence")!()).toBeNull();
    const [agentState] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    const grace = agentState.updatedAt.getTime() + 5 * 60_000;
    expect(agentState.status).toBe("running");
    expect(deadlines.get("stranded-agent-status")!()).toBe(grace);
    await advance(grace - Date.now() + 1);
    expect(deadlines.get("stranded-agent-status")!()).toBe(expiry.getTime());
    expect(coordinator.nextWakeAt(), JSON.stringify([...deadlines].map(([name, at]) => [name, at()]))).toBe(expiry.getTime());
    const queries: string[] = [], prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    try { await advance(20 * 60_000); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = prior; }
  });
  it("reconciles nested rollback and dispatches only the outer committed orphan producer", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000), rolledBack = randomUUID();
    await start(); await quiet();
    await expect(db.transaction(async outer => {
      await outer.transaction(async inner => {
        await notifyLiveResourceRecovery(inner, { companyId: f.companyId, leaseId: rolledBack });
        await inner.insert(environmentLeases).values({ id: rolledBack, companyId: f.companyId, status: "active", provider: "local", updatedAt: old });
      });
      throw new Error("abort outer producer");
    })).rejects.toThrow("abort outer producer");
    await advance(31_000); expect(await getLease(rolledBack)).toBeUndefined(); await quiet();
    const committed = randomUUID();
    await db.transaction(async outer => {
      await outer.transaction(async inner => {
        await notifyLiveResourceRecovery(inner, { companyId: f.companyId, leaseId: committed });
        await inner.insert(environmentLeases).values({ id: committed, companyId: f.companyId, status: "active", provider: "local", updatedAt: old });
      });
      expect(await getLease(committed)).toBeUndefined();
    });
    await advance(1_000);
    await vi.waitFor(async () => expect((await getLease(committed)).status).toBe("pending_cleanup"));
    await quiet();
  });
  it("retains and re-reads a moved native controller deadline while awaiting recovery evidence", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000), expiry = new Date(Date.now() + 3_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", runtimeMode: "native", nativeIssueId: f.issue.id, contextSnapshot: { issueId: f.issue.id },
      startedAt: old, updatedAt: old }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: run.id,
      phase: "observed", recoveryState: "awaiting_evidence", controllerBootId: randomUUID(), controllerPid: process.pid + 100_000,
      controllerProcessStartedAt: old, leaseExpiresAt: expiry });
    await start(); expect(deadlines.get("active-execution-recovery")!()).toBe(expiry.getTime());
    const moved = new Date(expiry.getTime() + 10_000);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: moved }).where(eq(nativeRunFinalizations.runId, run.id));
    await advance(expiry.getTime() - Date.now());
    expect((await getRun(run.id)).status).toBe("running"); expect((await getRun(run.id)).errorCode).toBeNull();
    expect(deadlines.get("active-execution-recovery")!()).toBe(moved.getTime());
    await db.transaction(async tx => {
      await notifyExecutionRunWork(tx, { companyId: f.companyId, runId: run.id, agentId: f.agent.id });
      await tx.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", recoveryState: "blocked", leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, run.id));
    });
    await quiet();
  });
  async function preparedOrphan() {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id, issueId: f.issue.id,
      finishedAt: old, updatedAt: old }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: run.id, issueId: f.issue.id, status: "active", provider: "daytona",
      providerLeaseId: `sandbox-${run.id}`, metadata: { driver: "sandbox", remoteCwd: "/workspace" }, updatedAt: old }).returning();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId: lease.id,
      providerLeaseId: lease.providerLeaseId, remoteCwd: "/workspace", resourceDisposition: "destroy",
    } } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id,
      runId: run.id, phase: "terminal_failure", recoveryState: "blocked" });
    return { f, run, lease };
  }
  it.each(["task lock", "statement timeout"])("retries workspace preservation after real PostgreSQL %s without a producer mutation", async kind => {
    const { f, run, lease } = await preparedOrphan();
    const warnings = vi.spyOn(logger, "warn");
    let retryAt = 0;
    if (kind === "statement timeout") {
      await db.execute(sql`create sequence live_preservation_slow_once`);
      await db.execute(sql.raw(`create function live_preservation_slow_once() returns trigger language plpgsql as $$
        begin if new.id = '${run.id}'::uuid and new.result_json->>'workspaceRestoreFailure' = 'restore_failed'
          and nextval('live_preservation_slow_once') = 1 then perform pg_sleep(16); end if; return new; end $$`));
      await db.execute(sql`create trigger live_preservation_slow_once before update on heartbeat_runs for each row execute function live_preservation_slow_once()`);
      extraStops.push(async () => {
        await db.execute(sql`drop trigger if exists live_preservation_slow_once on heartbeat_runs`);
        await db.execute(sql`drop function if exists live_preservation_slow_once()`);
        await db.execute(sql`drop sequence if exists live_preservation_slow_once`);
      });
    }
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const lock = kind === "task lock" ? db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issue.id)).for("update");
      locked(); await held;
    }) : Promise.resolve();
    if (kind !== "task lock") locked();
    try {
      await ready; await start();
      expect((await getRun(run.id)).resultJson).toBeNull();
      expect((await getLease(lease.id)).status).toBe("active");
      expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id,
        code: kind === "task lock" ? "55P03" : "57014" }), expect.any(String));
      retryAt = deadlines.get("orphan-active-leases")!()!;
      expect(retryAt).toBeGreaterThan(Date.now());
      expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
      if (kind === "task lock") expect(retryAt).toBe(Date.now() + 30_000);
    } finally { release(); await lock; }
    await advance(retryAt - Date.now() - 1); expect((await getRun(run.id)).resultJson).toBeNull();
    await advance(1);
    await vi.waitFor(async () => expect((await getRun(run.id)).resultJson).toMatchObject({
      workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [lease.id] },
    }));
    expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, run.id),
      eq(activityLog.action, "issue.workspace_recovery_required")))).toHaveLength(1);
    expect(await getLease(lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    await quiet();
    expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, run.id),
      eq(activityLog.action, "issue.workspace_recovery_required")))).toHaveLength(1);
  });
  it.each(["company", "claim", "manual"])("parks workspace preservation authority gates without timeout retries: %s", async gate => {
    const { f, run, lease } = await preparedOrphan();
    if (gate === "company") {
      const other = await fixture();
      await db.update(environmentLeases).set({ companyId: other.companyId }).where(eq(environmentLeases.id, lease.id));
    } else if (gate === "claim") {
      await db.update(nativeRunFinalizations).set({ leaseOwner: "another-workspace-owner",
        leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, run.id));
    } else {
      await db.update(nativeRunFinalizations).set({ phase: "observed", recoveryState: "blocked" })
        .where(eq(nativeRunFinalizations.runId, run.id));
    }
    await start();
    expect((await getRun(run.id)).resultJson).toBeNull();
    expect((await getLease(lease.id)).status).toBe("active");
    expect(deadlines.get("orphan-active-leases")!()).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.workspace_recovery_required"))).toEqual([]);
    await quiet();
  });
  it("retains failed orphan work with bounded backoff after a real PostgreSQL write failure", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, status: "active", provider: "local", updatedAt: old }).returning();
    await db.execute(sql`create sequence live_recovery_failure_once`);
    await db.execute(sql.raw(`create function live_recovery_failure_once() returns trigger language plpgsql as $$
      begin if new.id = '${lease.id}'::uuid and new.status = 'pending_cleanup' and nextval('live_recovery_failure_once') = 1
        then raise exception 'fixture cleanup persistence unavailable'; end if; return new; end $$`));
    await db.execute(sql`create trigger live_recovery_failure_once before update on environment_leases for each row execute function live_recovery_failure_once()`);
    extraStops.push(async () => {
      await db.execute(sql`drop trigger if exists live_recovery_failure_once on environment_leases`);
      await db.execute(sql`drop function if exists live_recovery_failure_once()`);
      await db.execute(sql`drop sequence if exists live_recovery_failure_once`);
    });
    await start();
    expect(errors).toHaveLength(1); expect(errors.shift()).toBeInstanceOf(AggregateError);
    expect((await getLease(lease.id)).status).toBe("active");
    await advance(29_000); expect((await getLease(lease.id)).status).toBe("active");
    await advance(1_000);
    await vi.waitFor(async () => expect((await getLease(lease.id)).status).toBe("pending_cleanup"));
    await quiet();
  });
  it("parks suppressed worktree recovery without probes and reconstructs it on the committed feature change", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "live-recovery-worktree" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    await settings.updateExperimental({ enableWorktreeRunExecution: false });
    heartbeat = heartbeatService(db, { runtimeEnv });
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, status: "active", provider: "local", updatedAt: old }).returning();
    await start(); expect((await getLease(lease.id)).status).toBe("active"); await quiet();
    try {
      await settings.updateExperimental({ enableWorktreeRunExecution: true });
      await advance(1_000);
      await vi.waitFor(async () => expect((await getLease(lease.id)).status).toBe("pending_cleanup"));
    } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    await quiet();
  });
  it.each(["agent", "hold"] as const)("revalidates parked native session work on ordinary %s eligibility", async gate => {
    const f = await fixture(), tree = issueTreeControlService(db);
    const lifecycleWorker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" });
    extraStops.push(() => lifecycleWorker.stop());
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
    const actor = { actorType: "user" as const, actorId: f.actorId, userId: f.actorId };
    const hold = gate === "hold" ? await tree.createHold(f.companyId, f.issue.id, { mode: "pause", actor }) : null;
    if (gate === "agent") { await createAgentLifecycle(db).pauseAgent(f.agent.id); await lifecycleWorker.process(f.agent.id); }
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id, contextSnapshot: { issueId: f.issue.id },
      finishedAt: new Date(), errorCode: "saved_native_failure" }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issue.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: run.id,
      phase: "retryable_failure", nextAttemptAt: new Date(Date.now() - 1_000) });
    await start(); await quiet();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0].phase).toBe("retryable_failure");
    const before = timeline.filter(event => Array.isArray(event) && event[0] === "finished" && event[1] === "native-process-sessions").length;
    if (gate === "agent") { await createAgentLifecycle(db).resumeAgent(f.agent.id); await lifecycleWorker.process(f.agent.id); }
    else await tree.releaseHold(f.companyId, f.issue.id, hold!.hold.id, { actor, reason: "Resume native recovery" });
    await advance(1_000);
    const deadline = performance.now() + 5_000;
    while (timeline.filter(event => Array.isArray(event) && event[0] === "finished" && event[1] === "native-process-sessions").length <= before && performance.now() < deadline)
      await realDelay(5);
    expect(timeline.filter(event => Array.isArray(event) && event[0] === "finished" && event[1] === "native-process-sessions").length).toBeGreaterThan(before);
    const expectedPhase = gate === "agent" ? "retryable_failure" : "terminal_failure";
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0].phase).toBe(expectedPhase);
    if (gate === "agent") expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("blocked");
    expect((await getRun(run.id)).errorCode).toBe("saved_native_failure");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    await quiet();
  });
  it("discovers an active lease from the ordinary terminal run commit before any lease write", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", runtimeMode: "legacy", startedAt: new Date(), updatedAt: new Date(),
      controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 60 * 60_000) }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run.id,
      status: "active", provider: "local", updatedAt: old }).returning();
    await start(); expect(deadlines.get("orphan-active-leases")!()).toBeNull();
    const ended = await terminalizeLegacyExecution({ db, run, status: "failed", patch: { finishedAt: new Date(), errorCode: "owner_process_failure" } });
    expect(ended?.status).toBe("failed"); expect((await getLease(lease.id)).status).toBe("active");
    await advance(1_000);
    await vi.waitFor(async () => expect((await getLease(lease.id)).status).toBe("pending_cleanup"));
    await quiet();
  });
  it.each(["accounting", "wake", "assignment_cancel"] as const)("settles parked agent status when its last %s receipt commits", async receipt => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    await db.update(agents).set({ status: "running", updatedAt: old }).where(eq(agents.id, f.agent.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "succeeded", finishedAt: old, costAccountingPending: receipt === "accounting",
      usageJson: { accountingProviderWorkStarted: false } }).returning();
    const [wake] = receipt !== "accounting" ? await db.insert(agentWakeupRequests).values({ companyId: f.companyId,
      agentId: f.agent.id, runId: run.id, status: "claimed", source: "automation", reason: "fixture-last-receipt",
      requestedByActorType: receipt === "assignment_cancel" ? "user" : "system", requestedByActorId: f.actorId, payload: { issueId: f.issue.id } }).returning() : [];
    await start(); await quiet();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("running");
    if (receipt === "accounting") expect(await accountRunCost(db, run.id)).toBe(true);
    else if (receipt === "assignment_cancel") await issueService(db).update(f.issue.id, { assigneeAgentId: null, assigneeUserId: f.actorId });
    else await createHeartbeatLifecycle(db, {} as Parameters<typeof createHeartbeatLifecycle>[1])
      .setWakeupStatus(wake.id, "completed", { finishedAt: new Date() });
    await advance(1_000);
    await vi.waitFor(async () => expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("idle"));
    await quiet();
  });
  it("retains first producer debt during drain and warm standby, then resumes without duplicate cleanup", async () => {
    const f = await fixture(), old = new Date(Date.now() - 6 * 60_000);
    draining = true; await start();
    const [lease] = await writeEnvironmentCleanup(db, tx => tx.insert(environmentLeases).values({ companyId: f.companyId,
      status: "active", provider: "local", updatedAt: old }).returning(), { companyId: f.companyId });
    await advance(1_000); await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect((await getLease(lease.id)).status).toBe("active");
    standby = true; draining = false; await advance(60_000); expect((await getLease(lease.id)).status).toBe("active");
    standby = false; await advance(30_000);
    await vi.waitFor(async () => expect((await getLease(lease.id)).status).toBe("pending_cleanup")); await quiet();
  });
});
