import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, automaticRunBrakes, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { AUTOMATIC_RUN_BRAKE, automaticRunBrake, takeDueAutomaticRunWakes } from "../services/recovery/automatic-run-brake.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerRunDispatchWork } from "../services/heartbeat/dispatch-work.js";

const gate = vi.hoisted(() => ({ open: false, releases: [] as Array<() => void> }));

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => {
  if (!gate.open) await new Promise<void>(resolve => gate.releases.push(resolve));
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Start gate test run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;

suite("automatic-run start gate in the dispatch pass", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  const userId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-automatic-run-start-gate-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    gate.open = true;
    for (const release of gate.releases.splice(0)) release();
    await heartbeat.drainActiveRunExecutions();
    gate.open = false;
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    automaticRunBrake.reset();
    await db.execute(sql`truncate table ${companies} cascade`);
  }, 180_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); }, 120_000);

  async function seedCompany(agentCount: number, maxConcurrentRuns: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Start gate", status: "active",
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const agentIds: string[] = [];
    for (let index = 0; index < agentCount; index += 1) {
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: `Gate ${index}`, role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns } } });
      agentIds.push(agentId);
    }
    return { companyId, agentIds };
  }

  async function queued(companyId: string, agentId: string, count: number, context: (index: number) => Record<string, unknown>,
    ageMs = 30 * MINUTE) {
    if (count === 0) return [];
    const tasks = await db.insert(issues).values(Array.from({ length: count }, (_, index) => ({ companyId, title: `Task ${index}`,
      status: "todo", assigneeAgentId: agentId }))).returning({ id: issues.id });
    return db.insert(heartbeatRuns).values(tasks.map((task, index) => ({ companyId, agentId, issueId: task.id, scopeKind: "issue" as const,
      invocationSource: "automation", triggerDetail: "system", status: "queued", createdAt: new Date(Date.now() - ageMs + index),
      contextSnapshot: { ...context(index), issueId: task.id, taskId: task.id } }))).returning();
  }

  const automatic = () => ({ wakeReason: "issue_continuation_needed", previousRunId: randomUUID() });

  async function openBrake(companyId: string, agentId: string, options: { probeAllowed: boolean }) {
    await db.insert(heartbeatRuns).values(Array.from({ length: 20 }, (_, index) => ({ companyId, agentId, invocationSource: "automation",
      triggerDetail: "system", runtimeMode: "legacy", status: "failed", errorCode: "environment_provider_unavailable",
      executionStage: "preparing", createdAt: new Date(Date.now() - 4 * MINUTE), startedAt: new Date(Date.now() - 3 * MINUTE),
      finishedAt: new Date(Date.now() - MINUTE + index * 100), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { wakeReason: "transient_failure_retry" } })));
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("open");
    if (!options.probeAllowed) await db.update(automaticRunBrakes).set({ nextProbeAt: sql`now() + interval '10 minutes'` })
      .where(eq(automaticRunBrakes.companyId, companyId));
    automaticRunBrake.reset();
  }

  const statuses = async (ids: string[]) => db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
    .from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids));
  const started = async (ids: string[]) => (await statuses(ids)).filter(run => run.status !== "queued").length;

  function countQueries() {
    let count = 0;
    for (const method of ["select", "insert", "update", "delete", "execute", "transaction"] as const) {
      const original = db[method].bind(db) as (...args: unknown[]) => unknown;
      vi.spyOn(db, method).mockImplementation(((...args: unknown[]) => { count += 1; return original(...args); }) as never);
    }
    return () => count;
  }

  async function passCost(heldRuns: number, passes: number) {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    const runs = await queued(companyId, agentId!, heldRuns, automatic);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    const read = countQueries();
    for (let pass = 0; pass < passes; pass += 1) await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    const total = read();
    vi.restoreAllMocks();
    expect(await started(runs.map(run => run.id))).toBe(0);
    expect((await statuses(runs.map(run => run.id))).every(run => run.errorCode === null)).toBe(true);
    return total;
  }

  it("walks hundreds of held runs without a claim attempt or a row read, and still starts other work in the same pass", async () => {
    const small = await passCost(10, 100);
    const large = await passCost(250, 100);
    expect(large).toBeLessThanOrEqual(small + 100);
    const beyondCache = await passCost(AUTOMATIC_RUN_BRAKE.maxRuns + 476, 3);
    expect(beyondCache).toBeLessThanOrEqual(await passCost(10, 3) + 100);

    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    const held = await queued(companyId, agentId!, 250, automatic);
    const [work] = await queued(companyId, agentId!, 1, () => ({ wakeReason: "issue_assigned" }), 0);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started([work!.id])).toBe(1);
    expect(await started(held.map(run => run.id))).toBe(0);
  }, 600_000);

  it("returns the probe when its run's claim is declined, so another automatic run starts in the same pass", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 5);
    await openBrake(companyId, agentId!, { probeAllowed: true });
    const [declined, next] = await queued(companyId, agentId!, 2, () => ({ wakeReason: "transient_failure_retry" }));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { chatControlRecoveryAdmission: { phase: "unknown" } } })
      .where(eq(heartbeatRuns.id, declined!.id));
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started([declined!.id])).toBe(0);
    expect(await started([next!.id])).toBe(1);
    const [brake] = await db.select().from(automaticRunBrakes).where(eq(automaticRunBrakes.companyId, companyId));
    expect(brake?.probeRunId).toBe(next!.id);
    automaticRunBrake.reset();
    await heartbeatService(db).resumeQueuedRunsAfterDrain({ companyId });
    expect(await started([declined!.id])).toBe(0);
    expect((await db.select().from(automaticRunBrakes).where(eq(automaticRunBrakes.companyId, companyId)))[0]?.probeRunId).toBe(next!.id);
  }, 300_000);

  it("returns an unused half-open release start to its window", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    const runs = await queued(companyId, agentId!, 4, automatic);
    await db.insert(automaticRunBrakes).values({ companyId, state: "half_open", stateChangedAt: sql`date_trunc('milliseconds', now())`,
      openedAt: sql`now() - interval '5 minutes'` });
    const reserve = (index: number) => automaticRunBrake.reserveStart(db, runs[index]!, { personOrigin: false });
    const first = await reserve(0);
    expect(first.held).toBe(false);
    expect((await reserve(1)).held).toBe(false);
    automaticRunBrake.reset();
    expect((await reserve(2)).held).toBe(true);
    if (!first.held) await first.release();
    expect((await reserve(2)).held).toBe(false);
    automaticRunBrake.reset();
    expect((await reserve(3)).held).toBe(true);
  }, 300_000);

  it("never holds a person's Retry", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    const held = await queued(companyId, agentId!, 20, automatic);
    const [retry] = await queued(companyId, agentId!, 1, () => ({ wakeReason: "task_retry", previousRunId: randomUUID() }), 0);
    const [request] = await db.insert(agentWakeupRequests).values({ companyId, agentId: agentId!, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "queued", requestedByActorType: "user", requestedByActorId: userId, runId: retry!.id }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: request!.id }).where(eq(heartbeatRuns.id, retry!.id));
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started([retry!.id])).toBe(1);
    expect(await started(held.map(run => run.id))).toBe(0);
  }, 300_000);

  it("never holds the only queued run when it continues a person's Retry", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    const [retry] = await db.insert(heartbeatRuns).values({ companyId, agentId: agentId!, invocationSource: "on_demand",
      triggerDetail: "manual", status: "failed", errorCode: "process_lost", startedAt: new Date(Date.now() - 2 * MINUTE),
      finishedAt: new Date(Date.now() - MINUTE), contextSnapshot: { wakeReason: "task_retry" } }).returning();
    const [continuation] = await queued(companyId, agentId!, 1,
      () => ({ wakeReason: "issue_continuation_needed", previousRunId: retry!.id }), 0);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started([continuation!.id])).toBe(1);
  }, 300_000);

  it("starts exactly one probe across two server instances", async () => {
    const { companyId, agentIds } = await seedCompany(2, 5);
    await openBrake(companyId, agentIds[0]!, { probeAllowed: true });
    const runs = [...await queued(companyId, agentIds[0]!, 10, automatic), ...await queued(companyId, agentIds[1]!, 10, automatic)];
    const other = heartbeatService(db);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    automaticRunBrake.reset();
    await other.resumeQueuedRunsAfterDrain({ companyId });
    automaticRunBrake.reset();
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started(runs.map(run => run.id))).toBe(1);
    for (const release of gate.releases.splice(0)) release();
    await other.drainActiveRunExecutions();
  }, 300_000);

  it("releases held runs at a doubling rate per window", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 100);
    const runs = await queued(companyId, agentId!, 40, automatic);
    await db.insert(automaticRunBrakes).values({ companyId, state: "half_open", stateChangedAt: sql`date_trunc('milliseconds', now())`,
      openedAt: sql`now() - interval '5 minutes'` });
    const counts: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      automaticRunBrake.reset();
      await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
      counts.push(await started(runs.map(run => run.id)));
      await db.update(automaticRunBrakes).set({
        stateChangedAt: sql`state_changed_at - ${`${AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval`,
        releaseWindowStartedAt: sql`release_window_started_at - ${`${AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval`,
      }).where(eq(automaticRunBrakes.companyId, companyId));
    }
    expect(counts).toEqual([2, 6, 14]);
  }, 300_000);

  it("keeps held runs out of the declined-claim backoff, so they start on the first pass after the pause", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 10);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    const runs = await queued(companyId, agentId!, 5, automatic);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started(runs.map(run => run.id))).toBe(0);
    await db.delete(automaticRunBrakes).where(eq(automaticRunBrakes.companyId, companyId));
    automaticRunBrake.reset();
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(await started(runs.map(run => run.id))).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("wakes the company's dispatch at the next try without polling", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    await db.update(automaticRunBrakes).set({ nextProbeAt: sql`now() + interval '2 seconds'` }).where(eq(automaticRunBrakes.companyId, companyId));
    automaticRunBrake.reset();
    await queued(companyId, agentId!, 3, automatic);
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    expect(takeDueAutomaticRunWakes().companyIds).toEqual([]);
    const resumed: Array<string | undefined> = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    try {
      await registerRunDispatchWork(coordinator, {
        promoteDueScheduledRetries: async () => undefined,
        nextScheduledRetryAt: async () => null,
        schedulingSuppressed: async () => false,
        resumeQueuedRunsAfterDrain: async scope => { resumed.push(scope?.companyId); },
        listUndispatchedQueuedRuns: async () => [],
      }, () => true).ready;
      await expect.poll(() => resumed, { timeout: 30_000, interval: 250 }).toContain(companyId);
    } finally {
      await coordinator.stop();
    }
  }, 300_000);

  it("still wakes every held company at its next try when more companies are held than the wake list keeps", async () => {
    const companyIds: string[] = [];
    for (let index = 0; index < AUTOMATIC_RUN_BRAKE.maxCompanies + 20; index += 1) {
      const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
      await openBrake(companyId, agentId!, { probeAllowed: false });
      companyIds.push(companyId);
    }
    for (const companyId of companyIds) {
      expect(await automaticRunBrake.holdAutomaticRunStart(db, { id: randomUUID(), companyId, contextSnapshot: automatic() },
        { personOrigin: false })).toBe(true);
    }
    expect(automaticRunBrake.cacheSizes().wakes).toBeLessThanOrEqual(AUTOMATIC_RUN_BRAKE.maxCompanies);
    const nextAt = automaticRunBrake.takeDueWakes(Number.NEGATIVE_INFINITY).nextAt;
    expect(nextAt).not.toBeNull();
    expect(nextAt!).toBeLessThanOrEqual(Date.now() + 11 * MINUTE);
    const due = takeDueAutomaticRunWakes(Date.now() + 20 * MINUTE);
    expect(due.all || companyIds.every(companyId => due.companyIds.includes(companyId))).toBe(true);
    expect(due.all).toBe(true);
  }, 600_000);

  it("keeps a held automatic run queued while paused and starts it on its own at the next try", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany(1, 1);
    await openBrake(companyId, agentId!, { probeAllowed: false });
    await db.update(automaticRunBrakes).set({ nextProbeAt: sql`now() + interval '3 seconds'` }).where(eq(automaticRunBrakes.companyId, companyId));
    automaticRunBrake.reset();
    const [run] = await queued(companyId, agentId!, 1, () => ({ wakeReason: "transient_failure_retry" }));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: agentId!, source: "automation", triggerDetail: "system",
      reason: "transient_failure_retry", status: "queued", requestedByActorType: "system", runId: run!.id }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: wake!.id }).where(eq(heartbeatRuns.id, run!.id));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    try {
      await heartbeat.registerRunDispatchWork(coordinator, () => true).ready;
      await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
      expect(await statuses([run!.id])).toEqual([{ id: run!.id, status: "queued", errorCode: null }]);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      await expect.poll(() => mockAdapterExecute.mock.calls.length, { timeout: 60_000, interval: 250 }).toBe(1);
      expect((await statuses([run!.id]))[0]?.status).toBe("running");
      for (const release of gate.releases.splice(0)) release();
      await expect.poll(async () => (await statuses([run!.id]))[0]?.status, { timeout: 60_000, interval: 250 }).toBe("succeeded");
    } finally {
      await coordinator.stop();
    }
  }, 300_000);
});
