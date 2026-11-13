import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS, RECOVERY_CONTINUATION_MAX_HOLD_MS, deliverReconciledExecutions,
} from "../services/execution-recovery-resolution.js";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { evaluateAssignedWork } from "../services/recovery/assigned-work-invariant.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { executionControlSchedule } from "../services/execution-control-work.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("recovery wake herd", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-recovery-wake-herd-");
    db = createDb(temporary.connectionString);
    userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`truncate table company_memberships, issue_recovery_actions, activity_log, agent_wakeup_requests, heartbeat_runs, issues, agents, companies cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seedCompany(maxConcurrentRuns = 1) {
    companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Herd", issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ponytail", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function addAgent(maxConcurrentRuns = 1) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Worker ${agentId.slice(0, 4)}`, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function task(agentId: string, status: "todo" | "in_progress" = "in_progress") {
    const [row] = await db.insert(issues).values({ companyId, title: "Continue the work", status, assigneeAgentId: agentId }).returning();
    return row!;
  }

  async function sourceRun(agentId: string, issueId: string, endedMinutesAgo: number) {
    const finishedAt = new Date(Date.now() - endedMinutesAgo * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment",
      status: "failed", errorCode: "server_shutdown_interrupted", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 120_000), contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return row!;
  }

  async function queuedRecoveryRun(agentId: string, createdMinutesAgo: number, endedMinutesAgo = 180) {
    const issue = await task(agentId);
    const source = await sourceRun(agentId, issue.id, endedMinutesAgo);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "automation",
      triggerDetail: "system", status: "queued", retryOfRunId: source.id, createdAt: new Date(Date.now() - createdMinutesAgo * 60_000),
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_recovery_action_restored", previousRunId: source.id,
        source: "execution.reconciled", forceFreshSession: true } }).returning();
    return row!;
  }

  async function queuedPersonRetry(agentId: string) {
    const issue = await task(agentId);
    const [request] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: issue.id } }).returning();
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
      triggerDetail: "manual", status: "queued", wakeupRequestId: request!.id, responsibleUserId: userId,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_commented" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: row!.id }).where(eq(agentWakeupRequests.id, request!.id));
    return row!;
  }

  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("starts a person's request ahead of a burst of recovery wakes, then runs every recovery wake", async () => {
    const agentId = await seedCompany(1);
    const burst: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 6; index += 1) burst.push(await queuedRecoveryRun(agentId, 60 - index));
    const person = await queuedPersonRetry(agentId);
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(person.id)).startedAt).not.toBeNull();
      for (const run of burst) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
      await expect.poll(async () => {
        await heartbeat.resumeQueuedRuns();
        const states = await Promise.all(burst.map(run => readRun(run.id)));
        return states.filter(run => run.startedAt === null).length;
      }, { timeout: 60_000, interval: 250 }).toBe(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  async function pendingContinuation(agentId: string, endedMinutesAgo: number) {
    const issue = await task(agentId, "todo");
    const source = await sourceRun(agentId, issue.id, endedMinutesAgo);
    const recordedAt = new Date().toISOString();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
      status: "resolved", outcome: "handed_back", resolvedAt: new Date(), ownerType: "board", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${source.id}`,
      nextAction: "Continue the task.", attemptCount: 1,
      evidence: { runId: source.id, originalFailureCode: "server_shutdown_interrupted", continuationDelivery: "pending",
        freshContinuation: { schema: "paperclip.fresh-continuation.v1", reason: "exact_resumption_unavailable", recordedAt },
        freshContinuationSettlement: { recordedAt },
        executionReconciliation: { runId: source.id, observedOutcome: "unknown", disposition: "continue_fresh",
          actorId: "execution-recovery", recordedAt } } }).returning();
    return { issue, source, action: action! };
  }

  function fakeWake() {
    return vi.fn(async (agentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      const issueId = String(opts.contextSnapshot.issueId);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
  }
  const deliveryOf = async (id: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!.evidence.continuationDelivery;
  const finishQueued = async (agentId: string) => db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));

  it("delivers one recovery continuation per agent at a time and drains the rest on later passes", async () => {
    const agentId = await seedCompany(1);
    const records: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < 4; index += 1) records.push(await pendingContinuation(agentId, 120 + index));
    const wake = fakeWake();

    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await Promise.all(records.map(record => deliveryOf(record.action.id)))).filter(state => state === "pending")).toHaveLength(3);
    expect(await executionControlSchedule(db).continuation()).not.toBeNull();

    for (let pass = 0; pass < 10 && wake.mock.calls.length < records.length; pass += 1) {
      await finishQueued(agentId);
      await deliverReconciledExecutions(db, wake as never);
    }
    expect(wake).toHaveBeenCalledTimes(records.length);
    expect(await Promise.all(records.map(record => deliveryOf(record.action.id)))).toEqual(records.map(() => "delivered"));
    expect(await executionControlSchedule(db).continuation()).toBeNull();
  }, 60_000);

  it("leaves a continuation pending while the agent's queue is at its concurrency limit", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
    const record = await pendingContinuation(agentId, 5);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await deliveryOf(record.action.id)).toBe("pending");
    await finishQueued(agentId);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("admits a continuation held past the bound even while ordinary work keeps the queue full", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const record = await pendingContinuation(agentId, 30);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - 1_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: { ...record.action.evidence,
      freshContinuation: { ...(record.action.evidence.freshContinuation as object), recordedAt: heldSince } } })
      .where(eq(issueRecoveryActions.id, record.action.id));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
  }, 60_000);

  it("does not let a fresh interruption keep an older held continuation out of a full queue", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const held = await pendingContinuation(agentId, 90);
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - 1_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: { ...held.action.evidence,
      freshContinuation: { ...(held.action.evidence.freshContinuation as object), recordedAt: heldSince } } })
      .where(eq(issueRecoveryActions.id, held.action.id));
    const fresh = await pendingContinuation(agentId, 1);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(held.action.id)).toBe("delivered");
    expect(await deliveryOf(fresh.action.id)).toBe("pending");
  }, 60_000);

  it("admits an older continuation within a bounded number of passes while fresh interruptions keep arriving", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start - 1_000 });
    try {
      const old = await pendingContinuation(agentId, 120);
      const wake = fakeWake();
      const passInterval = 15_000;
      const bound = Math.ceil(RECOVERY_CONTINUATION_MAX_HOLD_MS / passInterval) + 1;
      let admittedAt = -1;
      for (let pass = 0; pass <= bound && admittedAt < 0; pass += 1) {
        vi.setSystemTime(start + pass * passInterval);
        await pendingContinuation(agentId, 1);
        await deliverReconciledExecutions(db, wake as never);
        if (await deliveryOf(old.action.id) === "delivered") admittedAt = pass;
      }
      expect(admittedAt).toBeGreaterThan(0);
      expect(admittedAt).toBeLessThanOrEqual(bound);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("does not let continuations for busy agents hide other agents' continuations", async () => {
    const busyAgents = [await seedCompany(1)];
    for (let index = 1; index < 4; index += 1) busyAgents.push(await addAgent(1));
    for (const agentId of busyAgents) {
      const busy = await task(agentId);
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
        contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
      for (let index = 0; index < 8; index += 1) await pendingContinuation(agentId, 2 + index);
    }
    const idleAgent = await addAgent(1);
    const idle = await pendingContinuation(idleAgent, 600);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake.mock.calls.map(call => call[0])).toEqual([idleAgent]);
    expect(await deliveryOf(idle.action.id)).toBe("delivered");
  }, 60_000);

  it("caps the continuations one pass delivers per company and delivers the freshest interruption first", async () => {
    const agentIds = [await seedCompany(1)];
    for (let index = 1; index < RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS + 3; index += 1) agentIds.push(await addAgent(1));
    const old: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (const agentId of agentIds.slice(1)) old.push(await pendingContinuation(agentId, 240));
    const fresh = await pendingContinuation(agentIds[0]!, 2);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS);
    expect(wake.mock.calls[0]![0]).toBe(agentIds[0]);
    expect(await deliveryOf(fresh.action.id)).toBe("delivered");
    for (let pass = 0; pass < 5; pass += 1) await deliverReconciledExecutions(db, wake as never);
    expect(await Promise.all(old.map(record => deliveryOf(record.action.id)))).toEqual(old.map(() => "delivered"));
  }, 60_000);

  it("reads a task whose continuation is held back as waiting for its agent, not idle and not needing Retry", async () => {
    const agentId = await seedCompany(1);
    const queued = await queuedRecoveryRun(agentId, 1);
    const held = await pendingContinuation(agentId, 30);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await deliveryOf(held.action.id)).toBe("pending");
    expect(queued.status).toBe("queued");

    const sweep = assignedWorkSweep(db, { enqueueWakeup: vi.fn(async () => null) });
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, held.issue.id));
    const facts = (await sweep.loadFacts(companyId, [issueRow!])).get(held.issue.id)!;
    expect(facts.pendingWakes).toBeGreaterThan(0);
    expect(evaluateAssignedWork(facts)).toMatchObject({ kind: "ok", clause: "pending_intent", intent: "queued_wake" });

    const presentation = await taskInterruptionPresentation(db, issueRow!);
    expect(presentation).toMatchObject({ canRetry: false, state: "working", responsibility: "system" });
  }, 60_000);
});
