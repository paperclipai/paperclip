import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat/queue.js";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat/run-preparation.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { OLDEST_DISPATCH_SHARE, QUEUED_RUN_AGING_MS } from "../services/heartbeat/queued-run-dispatch-order.js";
import { createStalledQueuedRunCancel } from "../services/heartbeat/stalled-queued-run.js";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY } from "../services/chat-control-recovery-stop.js";
import { ASSIGNED_WORK_CONTINUED_ACTION, assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { CONTINUATION_CAP_WINDOW_MS } from "../services/recovery/assigned-work-invariant.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;

describe.skipIf(!support.supported)("a queued run the dispatcher keeps passing over", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stalled-queued-run-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(() => { vi.restoreAllMocks(); });

  async function seed() {
    const prefix = `S${randomUUID().slice(0, 5)}`;
    const [company] = await db.insert(companies).values({ name: "Stalled", issuePrefix: prefix }).returning();
    const companyId = company!.id;
    const [agent] = await db.insert(agents).values({ companyId, name: "Builder", adapterType: "process", status: "idle" }).returning();
    const agentId = agent!.id;
    let number = 0;
    const task = async () => {
      number += 1;
      const [row] = await db.insert(issues).values({ companyId, title: `Task ${number}`, status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "person-1",
        issueNumber: number, identifier: `${prefix}-${number}`, createdAt: new Date(Date.now() - 5 * 60 * MINUTE),
        updatedAt: new Date(Date.now() - 3 * 60 * MINUTE) }).returning();
      return row!;
    };
    const issue = await task();
    const other = await task();

    async function queuedRun(options: { ageMs?: number; person?: boolean; refused?: boolean; context?: Record<string, unknown> } = {}) {
      const createdAt = new Date(Date.now() - (options.ageMs ?? 2 * 60 * MINUTE));
      const reason = options.person ? "task_retry" : "issue_continuation_needed";
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: options.person ? "on_demand" : "automation",
        triggerDetail: options.person ? "manual" : "system", reason, payload: { issueId: issue.id }, status: "claimed",
        requestedByActorType: options.person ? "user" : "system", requestedByActorId: options.person ? "person-1" : null,
        claimedAt: createdAt, createdAt }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: options.person ? "on_demand" : "automation",
        triggerDetail: options.person ? "manual" : "system", status: "queued", wakeupRequestId: wake!.id, createdAt, updatedAt: createdAt,
        contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: reason, ...options.context } }).returning();
      if (options.refused !== false) {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]: { version: 1, phase: "lost" } } })
          .where(eq(heartbeatRuns.id, run!.id));
      }
      await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, wake!.id));
      return run!;
    }

    async function otherStarts(count: number, startedAgoMs: number, status = "succeeded") {
      for (let index = 0; index < count; index++) {
        const startedAt = new Date(Date.now() - startedAgoMs + index * 1_000);
        await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", triggerDetail: "system", status,
          createdAt: new Date(startedAt.getTime() - 1_000), startedAt, finishedAt: status === "running" ? null : new Date(startedAt.getTime() + 500),
          contextSnapshot: { issueId: other.id, taskId: other.id, wakeReason: "issue_assigned" } });
      }
    }

    const callbacks = createHeartbeatQueueTestDependencies(db);
    callbacks.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    callbacks.instanceSettings.getExperimental.mockResolvedValue({} as never);
    callbacks.setWakeupStatus.mockImplementation(async (id, status, values) => {
      if (id) await db.update(agentWakeupRequests).set({ ...values, status }).where(eq(agentWakeupRequests.id, id));
    });
    const admission = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "person-1",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: callbacks.filterZombieCoalesceTarget,
        mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    callbacks.wakeQueue.createAdmissionTransactionScope.mockImplementation(admission.createAdmissionTransactionScope);
    callbacks.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(admission.admitWakeBehindIssueExecution);
    const queue = createHeartbeatQueue(db, callbacks);
    const cancel = createStalledQueuedRunCancel(callbacks);
    const sweep = (beforeCancel?: () => Promise<void>) => assignedWorkSweep(db, {
      enqueueWakeup: (id, opts) => queue.enqueueWakeup(id, opts) as Promise<{ id: string } | null>,
      cancelStalledQueuedRun: async scope => { await beforeCancel?.(); return cancel(scope); },
    });
    async function olderRun(createdAgoMs: number, startedAgoMs: number) {
      const startedAt = new Date(Date.now() - startedAgoMs);
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
        createdAt: new Date(Date.now() - createdAgoMs), startedAt, finishedAt: new Date(startedAt.getTime() + 500),
        contextSnapshot: { issueId: other.id, taskId: other.id, wakeReason: "issue_continuation_needed" } });
    }
    const runsOfTask = async () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)).orderBy(heartbeatRuns.createdAt);
    const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const continuations = async () => db.select().from(activityLog).where(and(eq(activityLog.entityId, issue.id),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));
    return { companyId, agentId, issue, queuedRun, otherStarts, olderRun, queue, sweep, runsOfTask, readRun, continuations };
  }

  async function replacementOf(f: Awaited<ReturnType<typeof seed>>, stalledId: string) {
    const runs = await f.runsOfTask();
    return runs.filter(run => run.id !== stalledId);
  }

  it("cancels an automatic run the claim keeps refusing and queues exactly one claimable replacement", async () => {
    const f = await seed();
    const stalled = await f.queuedRun();
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    expect(await f.queue.claimQueuedRun(await f.readRun(stalled.id))).toBeNull();
    expect((await f.readRun(stalled.id)).status).toBe("queued");

    const sweep = f.sweep();
    expect((await sweep.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).toContain(f.issue.id);
    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    expect(check).toMatchObject({ verdict: { kind: "violation", reason: "queued_run_stalled", runId: stalled.id }, outcome: "replaced_stalled_run" });

    expect(await f.readRun(stalled.id)).toMatchObject({ status: "cancelled", errorCode: "queued_run_stalled" });
    const replacements = await replacementOf(f, stalled.id);
    expect(replacements).toHaveLength(1);
    const replacement = replacements[0]!;
    expect(replacement.contextSnapshot).toMatchObject({ wakeReason: "issue_continuation_needed", previousRunId: stalled.id,
      replacesStalledRunId: stalled.id });
    expect(replacement.retryOfRunId).toBeNull();
    const [entry] = await f.continuations();
    expect(entry?.details).toMatchObject({ outcome: "queued", violation: "queued_run_stalled" });
    expect(String((entry?.details as Record<string, unknown>).message)).not.toMatch(/queued_run_stalled|[0-9a-f]{8}-/);

    const current = await f.readRun(replacement.id);
    if (current.status === "queued") expect(await f.queue.claimQueuedRun(current)).not.toBeNull();
    expect((await f.readRun(replacement.id)).status).toBe("running");
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id }))
      .toMatchObject({ verdict: { kind: "ok", clause: "live_run", runId: replacement.id } });
  }, 60_000);

  it("counts only the starts that passed the run over after it became its agent's oldest queued run", async () => {
    const f = await seed();
    const waiting = await f.queuedRun();
    await f.olderRun(4 * 60 * MINUTE, 50 * MINUTE);
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 2, 55 * MINUTE);
    await f.olderRun(3 * 60 * MINUTE, 20 * MINUTE);
    const sweep = f.sweep();
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id }))
      .toMatchObject({ verdict: { kind: "ok", clause: "live_run", runId: waiting.id } });
    await f.otherStarts(OLDEST_DISPATCH_SHARE, 10 * MINUTE);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id }))
      .toMatchObject({ verdict: { kind: "ok", clause: "live_run", runId: waiting.id } });
    expect((await f.readRun(waiting.id)).status).toBe("queued");
    await f.otherStarts(1, 5 * MINUTE);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id }))
      .toMatchObject({ verdict: { reason: "queued_run_stalled", runId: waiting.id }, outcome: "replaced_stalled_run" });
  }, 60_000);

  it("keeps the run when a person's message joins it after the check", async () => {
    const f = await seed();
    const stalled = await f.queuedRun();
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    const joined = await f.sweep(async () => {
      await f.queue.enqueueWakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        payload: { issueId: f.issue.id }, requestedByActorType: "user", requestedByActorId: "person-1",
        contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "issue_commented" } });
    }).checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    expect(joined).toMatchObject({ verdict: { reason: "queued_run_stalled" }, outcome: "changed" });
    expect((await f.readRun(stalled.id)).status).toBe("queued");
    expect(await f.runsOfTask()).toHaveLength(1);
    expect(await f.continuations()).toHaveLength(0);
    const personWakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.runId, stalled.id),
      eq(agentWakeupRequests.requestedByActorType, "user")));
    expect(personWakes).toHaveLength(1);
  }, 60_000);

  it("does nothing when the run starts after the check", async () => {
    const f = await seed();
    const stalled = await f.queuedRun();
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    const started = await f.sweep(async () => {
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, stalled.id));
    }).checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    expect(started).toMatchObject({ outcome: "changed" });
    expect((await f.readRun(stalled.id)).status).toBe("running");
    expect(await f.runsOfTask()).toHaveLength(1);
    expect(await f.continuations()).toHaveLength(0);
  }, 60_000);

  it("leaves a run that waits behind a full agent", async () => {
    const f = await seed();
    const waiting = await f.queuedRun();
    await f.otherStarts(1, QUEUED_RUN_AGING_MS * 3, "running");
    const sweep = f.sweep();
    expect((await sweep.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).not.toContain(f.issue.id);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id }))
      .toMatchObject({ verdict: { kind: "ok", clause: "live_run", runId: waiting.id }, outcome: "ok" });
    expect((await f.readRun(waiting.id)).status).toBe("queued");
    expect(await f.runsOfTask()).toHaveLength(1);
    expect(await f.continuations()).toHaveLength(0);
  }, 60_000);

  it("reports a person's refused Retry and never cancels it", async () => {
    const f = await seed();
    const retry = await f.queuedRun({ person: true });
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    const warn = vi.spyOn(logger, "warn");
    const check = await f.sweep().checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    expect(check).toMatchObject({ verdict: { kind: "violation", reason: "queued_run_stalled", runId: retry.id }, outcome: "left_person_work" });
    expect((await f.readRun(retry.id)).status).toBe("queued");
    expect(await f.runsOfTask()).toHaveLength(1);
    expect(await f.continuations()).toHaveLength(0);
    expect(warn.mock.calls.filter(([payload]) => (payload as { event?: string })?.event === "assigned_work_invariant.queued_run_stalled"))
      .toHaveLength(1);
  }, 60_000);

  it("leaves a replacement that stalls again, warning once and looking again after the long backoff", async () => {
    const f = await seed();
    const original = randomUUID();
    const replacement = await f.queuedRun({ context: { previousRunId: original, replacesStalledRunId: original } });
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    const warn = vi.spyOn(logger, "warn");
    const sweep = f.sweep();
    const before = Date.now();
    const first = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    const second = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id });
    for (const check of [first, second]) {
      expect(check).toMatchObject({ verdict: { reason: "queued_run_stalled", runId: replacement.id }, outcome: "left_stalled_replacement" });
      expect(check!.retryAt!.getTime()).toBeGreaterThanOrEqual(before + CONTINUATION_CAP_WINDOW_MS);
    }
    expect((await f.readRun(replacement.id)).status).toBe("queued");
    expect(await f.runsOfTask()).toHaveLength(1);
    expect(await f.continuations()).toHaveLength(0);
    expect(warn.mock.calls.filter(([payload]) => (payload as { event?: string })?.event === "assigned_work_invariant.queued_run_stalled"))
      .toHaveLength(1);
  }, 60_000);

  it("produces one replacement when two servers sweep the task at once", async () => {
    const f = await seed();
    const stalled = await f.queuedRun();
    await f.otherStarts(OLDEST_DISPATCH_SHARE + 1, QUEUED_RUN_AGING_MS / 2);
    const checks = await Promise.all([f.sweep(), f.sweep()].map(sweep => sweep.checkIssue({ companyId: f.companyId, issueId: f.issue.id })));
    expect(checks.filter(check => check?.outcome === "replaced_stalled_run")).toHaveLength(1);
    expect((await f.readRun(stalled.id)).status).toBe("cancelled");
    expect(await replacementOf(f, stalled.id)).toHaveLength(1);
    expect((await f.continuations()).filter(entry => (entry.details as Record<string, unknown>).outcome === "queued")).toHaveLength(1);
  }, 60_000);
});
