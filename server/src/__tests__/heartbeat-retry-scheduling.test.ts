import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../adapters/types.js";
import {
  agents,
  approvals,
  issueApprovals,
  issueThreadInteractions,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { deferQueuedRunAfterStartupFailure } from "../services/agent-startup-backoff.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

// Wraps the real implementation so most tests exercise genuine transactional
// writes; a test that needs to prove a rollback overrides one call with
// `mockRejectedValueOnce` and lets every other call fall through untouched.
vi.mock("../services/heartbeat-run-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat-run-events.js")>();
  return { ...actual, appendHeartbeatRunEvent: vi.fn(actual.appendHeartbeatRunEvent) };
});

import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const mockedAppendHeartbeatRunEvent = vi.mocked(appendHeartbeatRunEvent);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const PROVIDER_QUOTA_TEST_ADAPTER = "provider_quota_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: PROVIDER_QUOTA_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // cleanup deletes. heartbeat.invoke claims a run and dispatches its
    // execution fire-and-forget, and that run can schedule a follow-up retry
    // wakeup, so a run or wakeup can still write heartbeat_runs and issues rows
    // when teardown starts. The cleanup deletes issues before heartbeat_runs, so
    // a late write races the deletes and can deadlock or break a foreign key.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupRetryFixture();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    unregisterServerAdapter(PROVIDER_QUOTA_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function cleanupRetryFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupRetryFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupHeartbeatRunDependents() {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
  }

  async function cleanupRetryFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await cleanupHeartbeatRunDependents();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | "provider_quota" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: string;
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  describe("seat startup failure cooldown at dispatch", () => {
    const adapterType = "seat_cooldown_test";
    async function completeTask(context: AdapterExecutionContext) {
      await context.onLog("stdout", "Completed task work.\n");
      await db.update(issues).set({ status: "done" }).where(and(
        eq(issues.companyId, context.agent.companyId), eq(issues.id, String(context.context.issueId))));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Completed task work." };
    }
    const execute = vi.fn(completeTask);
    let issueNumber = 100;

    beforeEach(() => {
      issueNumber = 100;
      execute.mockReset().mockImplementation(completeTask);
      registerServerAdapter({
        type: adapterType,
        execute,
        testEnvironment: async () => ({
          adapterType, status: "pass", checks: [], testedAt: new Date().toISOString(),
        }),
      });
    });

    afterEach(async () => {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    });

    async function seedFailedSeat(finishedAt = new Date()) {
      const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
      await seedRetryFixture({ companyId, agentId, runId, now: finishedAt,
        errorCode: "adapter_failed", adapterType });
      await db.update(heartbeatRuns).set({ startedAt: new Date(finishedAt.getTime() - 100) })
        .where(eq(heartbeatRuns.id, runId));
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } } })
        .where(eq(agents.id, agentId));
      return { companyId, agentId, runId, finishedAt };
    }

    async function seedTask(companyId: string, agentId: string) {
      const issueId = randomUUID();
      issueNumber += 1;
      await db.insert(issues).values({ id: issueId, companyId, title: "Preserve queued task",
        status: "todo", priority: "medium", assigneeAgentId: agentId,
        responsibleUserId: "responsible-user", issueNumber,
        identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-${issueNumber}` });
      return { issueId, wakeReason: "issue_assigned", taskPayload: { instruction: "Keep this task context" } };
    }

    async function seedQueuedWork(companyId: string, agentId: string) {
      const contextSnapshot = await seedTask(companyId, agentId);
      const runId = randomUUID(), wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId,
        source: "assignment", reason: "issue_assigned", status: "queued", payload: contextSnapshot });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued",
        invocationSource: "assignment", wakeupRequestId, contextSnapshot });
      await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
      return { runId, wakeupRequestId, contextSnapshot };
    }

    it("requires both prior issue cleanup and expired startup cooldown before claiming the same queued run", async () => {
      const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      const issueId = queued.contextSnapshot.issueId;
      await db.update(issues).set({ executionRunId: seat.runId }).where(eq(issues.id, issueId));
      const [lease] = await db.insert(environmentLeases).values({
        companyId: seat.companyId, issueId, heartbeatRunId: seat.runId,
        status: "pending_cleanup", cleanupStatus: "failed",
      }).returning();
      const [beforeDispatch] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
      const [beforeWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));

      // An expired agent cooldown cannot override the prior issue owner's
      // durable cleanup obligation, even when no local executor remains.
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(queued.runId)).toMatchObject({ status: "queued", startedAt: null });
      expect(execute).not.toHaveBeenCalled();
      const [owned] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(owned.executionRunId).toBe(seat.runId);

      // Conversely, a cleanup receipt cannot override the agent's persisted
      // provider deadline. Deferral changes neither the run nor its wake.
      await db.update(heartbeatRuns).set({ resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: new Date(Date.now() + 60 * 60_000).toISOString(),
      } }).where(eq(heartbeatRuns.id, seat.runId));
      await db.update(environmentLeases).set({
        status: "released", cleanupStatus: "success", releasedAt: new Date(),
      }).where(eq(environmentLeases.id, lease!.id));
      await heartbeat.resumeQueuedRuns();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId))).toEqual([beforeDispatch]);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId))).toEqual([beforeWake]);
      expect(execute).not.toHaveBeenCalled();

      await db.update(heartbeatRuns).set({ resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      } }).where(eq(heartbeatRuns.id, seat.runId));
      let release!: () => void;
      const executing = new Promise<void>((resolve) => { release = resolve; });
      execute.mockImplementation(async (context) => {
        await executing;
        return completeTask(context);
      });
      const secondService = heartbeatService(db);
      try {
        await Promise.all([heartbeat.resumeQueuedRuns(), secondService.resumeQueuedRuns()]);
        await expect.poll(() => execute.mock.calls.length).toBe(1);
        const [claimed] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(claimed.executionRunId).toBe(queued.runId);
        expect(await heartbeat.getRun(queued.runId)).toMatchObject({ status: "running" });
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
        expect(wake).toMatchObject({ runId: queued.runId, status: "claimed", payload: queued.contextSnapshot });
      } finally {
        release();
        await Promise.all([heartbeat.drainActiveRunExecutions(), secondService.drainActiveRunExecutions()]);
      }
      expect(await heartbeat.getRun(queued.runId)).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("defers existing queued work and fresh task wakes without replacing their context or retry identity", async () => {
      const seat = await seedFailedSeat();
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      await db.update(heartbeatRuns).set({ retryOfRunId: seat.runId, scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure" }).where(eq(heartbeatRuns.id, queued.runId));
      const [beforeDispatch] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
      const freshContext = await seedTask(seat.companyId, seat.agentId);
      const fresh = await heartbeat.wakeup(seat.agentId, { source: "assignment", reason: "issue_assigned",
        allowRunCoalescing: false, contextSnapshot: freshContext });
      expect(fresh).not.toBeNull();
      await heartbeat.resumeQueuedRuns();

      const [deferred] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
      expect(deferred).toEqual(beforeDispatch);
      expect(await heartbeat.getRun(fresh!.id)).toMatchObject({ status: "queued",
        startedAt: null, scheduledRetryAt: null, contextSnapshot: freshContext });
      expect(execute).not.toHaveBeenCalled();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
      expect(wake).toMatchObject({ runId: queued.runId, payload: queued.contextSnapshot });
      const [issue] = await db.select().from(issues).where(eq(issues.id, queued.contextSnapshot.issueId));
      expect(issue.executionRunId).toBeNull();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seat.agentId))).toHaveLength(3);
    });

    it.each([
      { failures: 1, delayMs: 5_000, beforeDeadlineAge: 0 },
      { failures: 2, delayMs: 10_000, beforeDeadlineAge: 7_000 },
      { failures: 3, delayMs: 20_000, beforeDeadlineAge: 12_000 },
      { failures: 10, delayMs: 300_000, beforeDeadlineAge: 250_000 },
    ])("expires the $delayMs ms cooldown after $failures failures without resetting on unstarted cancelled placeholders", async ({ failures, delayMs, beforeDeadlineAge }) => {
      const seat = await seedFailedSeat();
      const [agent] = await db.select().from(agents).where(eq(agents.id, seat.agentId));
      // A time beyond the preceding step, but before this step, proves that
      // the deadline increases across independent failed run IDs.
      const finishedAt = new Date(Date.now() - beforeDeadlineAge);
      const agentId = randomUUID();
      const failureIds: string[] = [];
      await db.insert(agents).values({ ...agent, id: agentId, name: `Seat ${failures}` });
      for (let index = 0; index < failures; index += 1) {
        const failureAt = new Date(finishedAt.getTime() - (failures - index - 1) * 1_000);
        const id = randomUUID();
        failureIds.push(id);
        await db.insert(heartbeatRuns).values({ id, companyId: seat.companyId, agentId, status: "failed",
          errorCode: "adapter_failed", startedAt: new Date(failureAt.getTime() - 100), finishedAt: failureAt,
          createdAt: new Date(failureAt.getTime() - 100), updatedAt: failureAt,
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
      }
      await db.insert(heartbeatRuns).values({ companyId: seat.companyId, agentId,
        status: "cancelled", createdAt: finishedAt, updatedAt: finishedAt });
      const queued = await seedQueuedWork(seat.companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");
      expect(execute.mock.calls.filter(([context]) => context.agent.id === agentId)).toHaveLength(0);

      // Move only durable failure history across expiry; neither the queued
      // run nor its wake is rewritten or promoted to make it runnable.
      const shiftMs = delayMs - beforeDeadlineAge + 1_000;
      await db.update(heartbeatRuns).set({
        startedAt: sql`${heartbeatRuns.startedAt} - ${shiftMs} * interval '1 millisecond'`,
        finishedAt: sql`${heartbeatRuns.finishedAt} - ${shiftMs} * interval '1 millisecond'`,
      }).where(inArray(heartbeatRuns.id, failureIds));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("succeeded");
      expect(execute.mock.calls.filter(([context]) => context.agent.id === agentId)).toHaveLength(1);
    });

    it("admits one probe after cooldown while another seat runs, then resumes queued work after progress", async () => {
      const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
      const queued = await Promise.all(Array.from({ length: 3 }, () => seedQueuedWork(seat.companyId, seat.agentId)));
      let releaseProbe!: () => void;
      const probe = new Promise<void>((resolve) => { releaseProbe = resolve; });
      const secondService = heartbeatService(db);
      execute.mockImplementation(async (context) => {
        if (context.agent.id === seat.agentId) await probe;
        return completeTask(context);
      });
      try {
        await Promise.all([heartbeat.resumeQueuedRuns(), secondService.resumeQueuedRuns()]);
        await expect.poll(() => execute.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0);
        await heartbeat.resumeQueuedRuns();
        const running = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.agentId, seat.agentId), eq(heartbeatRuns.status, "running")));
        expect(running).toHaveLength(1);
        expect(execute).toHaveBeenCalledTimes(1);

        const [agent] = await db.select().from(agents).where(eq(agents.id, seat.agentId));
        const otherAgentId = randomUUID();
        await db.insert(agents).values({ ...agent, id: otherAgentId, name: "Healthy seat", status: "idle" });
        const other = await seedQueuedWork(seat.companyId, otherAgentId);
        await heartbeat.resumeQueuedRuns();
        await expect.poll(async () => (await heartbeat.getRun(other.runId))?.status, { timeout: 5_000 }).toBe("succeeded");
        expect(execute.mock.calls.filter(([context]) => context.agent.id === seat.agentId)).toHaveLength(1);
      } finally {
        releaseProbe();
        await Promise.all([heartbeat.drainActiveRunExecutions(), secondService.drainActiveRunExecutions()]);
      }

      // Existing startup/periodic queue resumption owns the next dispatch.
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      for (const work of queued) expect((await heartbeat.getRun(work.runId))?.status).toBe("succeeded");
      expect(execute.mock.calls.filter(([context]) => context.agent.id === seat.agentId)).toHaveLength(3);
      // Four adapter completions plus concurrent service sweeps need a local
      // timeout budget when the broader database shard runs under host load.
    }, 30_000);

    it("admits exactly one probe across concurrent database transactions without the process-local start lock", async () => {
      const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
      const queued = await Promise.all(Array.from({ length: 3 }, () => seedQueuedWork(seat.companyId, seat.agentId)));
      let entered = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      try {
        const decisions = await Promise.all(queued.map((work) => db.transaction(async (tx) => {
          const [locked] = await tx.select().from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, work.runId)).for("update");
          entered += 1;
          if (entered === queued.length) releaseBarrier();
          await barrier;
          const deferred = await deferQueuedRunAfterStartupFailure(tx as unknown as Db, locked!);
          if (!deferred) {
            // Hold the admission-to-commit window open while other database
            // sessions compete; no in-process scheduler lock protects this path.
            await new Promise((resolve) => setTimeout(resolve, 100));
            await tx.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
              .where(eq(heartbeatRuns.id, work.runId));
          }
          return deferred;
        })));
        expect(decisions.filter((deferred) => !deferred)).toHaveLength(1);
        expect(decisions.filter(Boolean)).toHaveLength(2);
        const rows = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, queued.map((work) => work.runId)));
        expect(rows.filter((run) => run.status === "running")).toHaveLength(1);
        expect(rows.filter((run) => run.status === "queued" && run.startedAt === null)).toHaveLength(2);
      } finally {
        // These claims deliberately have no adapter execution to settle them.
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
          .where(inArray(heartbeatRuns.id, queued.map((work) => work.runId)));
      }
    });

    it("starts cooldown at the latest failure completion when concurrent attempts finish out of start order", async () => {
      const seat = await seedFailedSeat();
      await db.update(heartbeatRuns).set({ startedAt: new Date(seat.finishedAt.getTime() - 61_000) })
        .where(eq(heartbeatRuns.id, seat.runId));
      await db.insert(heartbeatRuns).values({ companyId: seat.companyId, agentId: seat.agentId,
        status: "failed", errorCode: "adapter_failed",
        startedAt: new Date(seat.finishedAt.getTime() - 51_000),
        finishedAt: new Date(seat.finishedAt.getTime() - 50_000),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");
      expect(execute).not.toHaveBeenCalled();
    });

    describe("durable startup history", () => {
      it("does not hide ambiguous terminal rows with no completion timestamp", async () => {
        const seat = await seedFailedSeat();
        await db.insert(heartbeatRuns).values({
          companyId: seat.companyId, agentId: seat.agentId, status: "failed",
          startedAt: new Date(), finishedAt: null,
        });
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        const deferred = await db.transaction(async (tx) => {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
          return deferQueuedRunAfterStartupFailure(tx as unknown as Db, run!);
        });
        expect(deferred).toBe(false);
      });

      it("uses the completion index without filtering queued backlog", async () => {
        const seat = await seedFailedSeat();
        await db.insert(heartbeatRuns).values(Array.from({ length: 1_024 }, () => ({
          companyId: seat.companyId, agentId: seat.agentId, status: "queued",
        })));
        const plan = await db.transaction(async (tx) => {
          await tx.execute(sql`set local enable_seqscan = off`);
          await tx.execute(sql`set local enable_bitmapscan = off`);
          await tx.execute(sql`set local enable_sort = off`);
          return tx.execute(sql`explain (analyze, format json)
            select id from heartbeat_runs
            where company_id = ${seat.companyId} and agent_id = ${seat.agentId}
              and started_at is not null
              and status in ('failed', 'timed_out', 'succeeded', 'cancelled', 'interrupted')
            order by finished_at desc, id desc limit 1`);
        });
        const root = (plan[0]!["QUERY PLAN"] as Array<{ Plan: { Plans: Array<Record<string, unknown>> } }>)[0]!.Plan;
        const scan = root.Plans[0]!;
        expect(scan["Index Name"]).toBe("heartbeat_runs_company_agent_finished_idx");
        expect(scan["Rows Removed by Filter"] ?? 0).toBe(0);
        expect(scan["Actual Rows"]).toBe(1);
      });

      async function seedExpiredFailures(seat: { companyId: string; agentId: string }, count: number) {
        const latestCompletion = Date.now() - 10 * 60_000;
        await db.insert(heartbeatRuns).values(Array.from({ length: count }, (_, index) => ({
          companyId: seat.companyId, agentId: seat.agentId, status: "failed", errorCode: "adapter_failed",
          startedAt: new Date(latestCompletion - index * 1_000 - 100),
          finishedAt: new Date(latestCompletion - index * 1_000),
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        })));
      }

      it("keeps a late completion and provider deadline when seven later-started attempts finished earlier", async () => {
        const seat = await seedFailedSeat();
        await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 60 * 60_000),
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            retryNotBefore: new Date(Date.now() + 30 * 60_000).toISOString() },
        }).where(eq(heartbeatRuns.id, seat.runId));
        await seedExpiredFailures(seat, 7);
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        await heartbeat.resumeQueuedRuns();
        expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");

        // The provider's deadline still holds after every local delay expires.
        await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 6 * 60_000) })
          .where(eq(heartbeatRuns.id, seat.runId));
        await heartbeat.resumeQueuedRuns();
        expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");
        expect(execute).not.toHaveBeenCalled();
      });

      it("honors an older provider deadline throughout a long consecutive failure streak", async () => {
        const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
        await db.update(heartbeatRuns).set({ resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          retryNotBefore: new Date(Date.now() + 30 * 60_000).toISOString(),
        } }).where(eq(heartbeatRuns.id, seat.runId));
        await seedExpiredFailures(seat, 64);
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        await heartbeat.resumeQueuedRuns();
        expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");
        expect(execute).not.toHaveBeenCalled();
      });

      it("reads only the newest history row when completed successes keep the seat healthy", async () => {
        const seat = await seedFailedSeat(new Date(Date.now() - 60_000));
        await db.update(heartbeatRuns).set({ status: "succeeded", error: null, errorCode: null,
          resultJson: null, stdoutExcerpt: "Completed real work." }).where(eq(heartbeatRuns.id, seat.runId));
        await db.insert(heartbeatRuns).values(Array.from({ length: 31 }, (_, index) => ({
          companyId: seat.companyId, agentId: seat.agentId, status: "succeeded",
          startedAt: new Date(seat.finishedAt.getTime() - (index + 1) * 1_000 - 100),
          finishedAt: new Date(seat.finishedAt.getTime() - (index + 1) * 1_000),
          stdoutExcerpt: "Completed real work.",
        })));
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
        let historyRowsRead = 0;
        const deferred = await db.transaction((tx) => {
          const observedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "select") return Reflect.get(target, property, receiver);
              return (fields: any) => {
                const builder = target.select(fields);
                if (!fields?.finishedAt) return builder;
                const from = builder.from.bind(builder);
                builder.from = ((...args: any[]) => {
                  const query = (from as any)(...args);
                  const then = query.then.bind(query);
                  query.then = (resolve: any, reject: any) => then((rows: unknown[]) => {
                    historyRowsRead += rows.length;
                    return rows;
                  }).then(resolve, reject);
                  return query;
                }) as typeof builder.from;
                return builder;
              };
            },
          });
          return deferQueuedRunAfterStartupFailure(observedTx as unknown as Db, run!);
        });
        expect(deferred).toBe(false);
        expect(historyRowsRead).toBe(1);
      });

      it("bounds history reads while honoring an old provider deadline after more than a thousand failures", async () => {
        const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
        await db.update(heartbeatRuns).set({ resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          retryNotBefore: new Date(Date.now() + 30 * 60_000).toISOString(),
        } }).where(eq(heartbeatRuns.id, seat.runId));
        await seedExpiredFailures(seat, 1_025);
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
        let historyReads = 0;
        const deferred = await db.transaction((tx) => {
          const observedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "select") return Reflect.get(target, property, receiver);
              return (fields: any) => {
                if (fields?.finishedAt) historyReads += 1;
                return target.select(fields);
              };
            },
          });
          return deferQueuedRunAfterStartupFailure(observedTx as unknown as Db, run!);
        });
        expect(deferred).toBe(true);
        expect(historyReads).toBeGreaterThan(0);
        expect(historyReads).toBeLessThanOrEqual(3);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId))).toEqual([run]);
      });

      it("stops considering older provider deadlines once completed progress breaks the long failure streak", async () => {
        const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
        await db.update(heartbeatRuns).set({ resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          retryNotBefore: new Date(Date.now() + 30 * 60_000).toISOString(),
        } }).where(eq(heartbeatRuns.id, seat.runId));
        await db.insert(heartbeatRuns).values({ companyId: seat.companyId, agentId: seat.agentId,
          status: "succeeded", startedAt: new Date(Date.now() - 65 * 60_000),
          finishedAt: new Date(Date.now() - 15 * 60_000), stdoutExcerpt: "Completed real work." });
        await seedExpiredFailures(seat, 64);
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(queued.runId))?.status).toBe("succeeded");
        expect(execute).toHaveBeenCalledTimes(1);
      });

      it("defers when an active probe fails immediately after the failure history is read", async () => {
        const seat = await seedFailedSeat(new Date(Date.now() - 60_000));
        const probeId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: probeId, companyId: seat.companyId, agentId: seat.agentId,
          status: "running", startedAt: new Date(Date.now() - 100) });
        const queued = await seedQueuedWork(seat.companyId, seat.agentId);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
        const finalizerDb = createDb(tempDb!.connectionString);
        let terminalized = false;
        const racingDecision = await db.transaction(async (tx) => {
          // Execute every query against PostgreSQL. Only the delivery of the
          // history result is intercepted to reproduce a concurrent finalizer.
          const observedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "select") return Reflect.get(target, property, receiver);
              return (fields: any) => {
                const builder = target.select(fields);
                if (!fields?.finishedAt) return builder;
                const from = builder.from.bind(builder);
                builder.from = ((...args: any[]) => {
                  const query = (from as any)(...args);
                  const then = query.then.bind(query);
                  query.then = (resolve: any, reject: any) => then(async (rows: unknown) => {
                    if (!terminalized) {
                      await finalizerDb.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
                        errorCode: "adapter_failed",
                        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
                      }).where(eq(heartbeatRuns.id, probeId));
                      terminalized = true;
                    }
                    return rows;
                  }).then(resolve, reject);
                  return query;
                }) as typeof builder.from;
                return builder;
              };
            },
          });
          return deferQueuedRunAfterStartupFailure(observedTx as unknown as Db, run!);
        });
        const freshDecision = await db.transaction((tx) =>
          deferQueuedRunAfterStartupFailure(tx as unknown as Db, run!));
        expect(terminalized).toBe(true);
        expect({ racingDecision, freshDecision }).toEqual({ racingDecision: true, freshDecision: true });
      });
    });

    it("honors a provider deadline after local cooldown expires and resumes the same queued run when it passes", async () => {
      const seat = await seedFailedSeat(new Date(Date.now() - 60 * 60_000));
      await db.update(heartbeatRuns).set({ resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
      } }).where(eq(heartbeatRuns.id, seat.runId));
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("queued");
      expect(execute).not.toHaveBeenCalled();
      await db.update(heartbeatRuns).set({ resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: new Date(Date.now() - 1_000).toISOString(),
      } }).where(eq(heartbeatRuns.id, seat.runId));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("clears the failure streak after productive work is cancelled", async () => {
      const seat = await seedFailedSeat();
      await db.insert(heartbeatRuns).values({ companyId: seat.companyId, agentId: seat.agentId,
        status: "cancelled", startedAt: new Date(), finishedAt: new Date(),
        stdoutExcerpt: "Applied requested change before the operator stopped this run." });
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: "successful work", evidence: { status: "succeeded", stdoutExcerpt: "Task completed." } },
      { label: "missing pre-provider evidence", evidence: { resultJson: {} } },
      { label: "positive output evidence", evidence: { stdoutExcerpt: "I changed the requested file." } },
      { label: "positive usage evidence", evidence: { usageJson: { inputTokens: 10, outputTokens: 1 } } },
      { label: "cached-input usage evidence", evidence: { usageJson: { cachedInputTokens: 10 } } },
    ])("leaves $label runnable", async ({ evidence }) => {
      const seat = await seedFailedSeat();
      await db.update(heartbeatRuns).set(evidence).where(eq(heartbeatRuns.id, seat.runId));
      const queued = await seedQueuedWork(seat.companyId, seat.agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(queued.runId))?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it("reuses one failure successor across concurrent and repeated scheduling", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
    const outcomes = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "scheduled")).toBe(true);
    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(children).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, children[0]!.id));
    await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0, retryReason: "execution_review_participant_recovery" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
  });

  it.each([
    ["workspace_busy", "failureRetriesBeforeWorkspaceWait"],
    ["ai_connection_busy", "failureRetriesBeforeAiConnectionWait"],
  ])("retains the failure budget after many pre-provider %s waits", async (reason, countKey) => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "overloaded", errorFamily: "transient_upstream" });
    await db.update(heartbeatRuns).set({ scheduledRetryReason: reason, scheduledRetryAttempt: 12,
      contextSnapshot: { [countKey]: 1 } }).where(eq(heartbeatRuns.id, runId));
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", run: { scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure" } });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected a bounded retry");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "overloaded",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, scheduled.run!.id));
    expect(await heartbeat.scheduleBoundedRetry(scheduled.run!.id, { now, random: () => 0 })).toMatchObject({ outcome: "retry_exhausted" });
  });
  it("records pre-provider quota rejection, schedules the reset-time retry, and leaves the agent idle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test",
      role: "engineer",
      status: "idle",
      adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.providerQuotaRetryNotBefore).toBe(
      "2030-04-22T21:00:00.000Z",
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("bounds interrupted conversations across restarts and concurrent scheduling", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    const resultJson = { conversationContinuation: "continue_conversation_v1" };
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson })
      .where(eq(heartbeatRuns.id, runId));
    let predecessor = runId;
    for (const attempt of [1, 2]) {
      const restarted = heartbeatService(db);
      const outcomes = await Promise.all([
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
      ]);
      expect(outcomes.every(outcome => outcome.outcome === "scheduled")).toBe(true);
      const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, predecessor));
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ scheduledRetryAttempt: attempt });
      predecessor = children[0]!.id;
      await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: now, resultJson })
        .where(eq(heartbeatRuns.id, predecessor));
    }
    expect(await heartbeatService(db).scheduleBoundedRetry(predecessor, { now }))
      .toMatchObject({ outcome: "retry_exhausted" });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
    // Exhaustion leaves the task available to a new explicit request.
    const { getExecutionBlocker } = await import("../services/execution-blocker.js");
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  it.each(["dependency", "disabled", "reassigned"])("respects the %s gate for interrupted conversations", async gate => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: "Required work", status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    } else if (gate === "disabled") {
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    } else {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    }
    expect(await heartbeat.scheduleBoundedRetry(runId, { now })).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
  });

  it.each([
    ["interaction", false], ["approval", false], ["interaction", true], ["approval", true],
  ] as const)("waits for a pending %s before continuing (already scheduled: %s)", async (kind, alreadyScheduled) => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    let retryRunId = runId;
    if (alreadyScheduled) {
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") throw new Error("Expected a retry");
      retryRunId = scheduled.run.id;
    }
    if (kind === "interaction") {
      await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions",
        status: "pending", payload: { version: 1, questions: [] } });
    } else {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    }
    if (alreadyScheduled) {
      const adapter = createPostgresRunDispatchAdapter(db);
      expect(await adapter.promoteOrCancelDueRetry({ companyId, runId: retryRunId, now: new Date(now.getTime() + 60_000) }))
        .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
      const stopped = await heartbeat.getRun(retryRunId);
      expect(stopped?.status).toBe("cancelled");
      const { legacyExecutionNeedsReconciliation } = await import("../services/legacy-execution-recovery.js");
      expect(legacyExecutionNeedsReconciliation(stopped!)).toBe(false);
    } else {
      expect(await heartbeat.scheduleBoundedRetry(runId, { now }))
        .toMatchObject({ outcome: "not_scheduled", errorCode: "issue_waiting_for_response" });
    }
  });

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date(expectedDueAt.getTime() - 1));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("schedules max-turn continuations with distinct retry metadata", async () => {
    const { runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(new Date(now.getTime() + 1_000).toISOString());

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      retryOfRunId: runId,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
  });

  it("schedules accepted interaction continuation infra retries while the issue is in_review", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(3);

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      issueId,
      interactionId,
      retryOfRunId: runId,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(scheduled.run.id);
  });

  it("coalesces duplicate accepted interaction continuation infra retry schedules", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const retryOptions = {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    };
    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, runId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        eq(heartbeatRuns.scheduledRetryAttempt, 1),
      ));
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, INTERACTION_CONTINUATION_INFRA_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);
  });

  it.each([
    {
      name: "renamed branch",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:renamed",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "clean",
      }),
    },
    {
      name: "dirty worktree",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "dirty",
        safeRepair: {
          eligible: false,
          attempted: false,
          succeeded: false,
          reason: "worktree is not clean",
        },
      }),
    },
  ])("quarantines a failed $name workspace before scheduling the accepted interaction retry", async ({ workspaceValidation }) => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const validation = workspaceValidation(executionWorkspaceId);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "stale-plan-approval-workspace",
      status: "active",
      cwd: "/workspace/stale-plan-approval-workspace",
      baseRef: "origin/master",
      branchName: "stale-plan-approval-workspace",
      providerType: "git_worktree",
      providerRef: "/workspace/stale-plan-approval-workspace",
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const workspace = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace).toMatchObject({
      status: "archived",
      cleanupEligibleAt: null,
      cleanupReason: "workspace_validation_failed",
    });
    expect(workspace?.closedAt?.toISOString()).toBe(now.toISOString());
    expect(workspace?.metadata).toMatchObject({
      existing: true,
      workspaceValidationQuarantine: {
        reason: "workspace_validation_failed",
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        sourceRunId: runId,
        retryRunId: scheduled.run.id,
        issueId,
        sourceIssueId: issueId,
        workspaceValidation: validation,
      },
    });

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.contextSnapshot).toMatchObject({
      workspaceValidationRecovery: {
        strategy: "quarantine_failed_workspace_and_retry_clean",
        sourceRunId: runId,
        reason: "git_worktree_branch_incoherence",
        fingerprint: validation.fingerprint,
        failedExecutionWorkspaceId: executionWorkspaceId,
      },
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(activity).toMatchObject({
      action: "execution_workspace.workspace_validation_quarantined",
      entityId: executionWorkspaceId,
      details: expect.objectContaining({
        retryRunId: scheduled.run.id,
        workspaceValidation: validation,
      }),
    });

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.id).toBe(agentId);
  });

  it("does not quarantine another issue's workspace when validation payload is stale", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const foreignIssueId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale",
      executionWorkspaceId: foreignWorkspaceId,
      expectedBranch: "current-issue-branch",
      actualBranch: "foreign-issue-branch",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId,
      title: "Other active issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-issue-branch",
        status: "active",
        cwd: "/workspace/current-issue-branch",
        baseRef: "origin/master",
        branchName: "current-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/current-issue-branch",
        metadata: { current: true },
      },
      {
        id: foreignWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: foreignIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "foreign-issue-branch",
        status: "active",
        cwd: "/workspace/foreign-issue-branch",
        baseRef: "origin/master",
        branchName: "foreign-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/foreign-issue-branch",
        metadata: { foreign: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: foreignWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: foreignWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [currentWorkspaceId, foreignWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
      expect.objectContaining({ id: foreignWorkspaceId, status: "active", metadata: { foreign: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not quarantine an owned workspace that is no longer attached to the issue", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const staleWorkspaceId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale-owned",
      executionWorkspaceId: staleWorkspaceId,
      expectedBranch: "old-plan-approval-workspace",
      actualBranch: "current-plan-approval-workspace",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "old-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/old-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "old-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/old-plan-approval-workspace",
        metadata: { stale: true },
      },
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/current-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "current-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/current-plan-approval-workspace",
        metadata: { current: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: currentWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: currentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [staleWorkspaceId, currentWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: staleWorkspaceId, status: "active", metadata: { stale: true } }),
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not schedule accepted interaction continuation infra retries after terminal issue status", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "done" });

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_terminal_status",
      issueId,
    });
  });

  it("coalesces duplicate max-turn continuation schedules for the same source run and attempt", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture();
    const retryOptions = {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    };

    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, runId),
          eq(heartbeatRuns.scheduledRetryReason, MAX_TURN_CONTINUATION_RETRY_REASON),
          eq(heartbeatRuns.scheduledRetryAttempt, 1),
        ),
      );
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it.each(["schedule", "transaction", "promote", "dispatch"] as const)(
    "suppresses a busy-subscription retry whose task lock was cleared before %s",
    async (phase) => {
      const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
      await db.update(heartbeatRuns).set({
        status: "cancelled", errorCode: "ai_connection_busy",
        resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, runId));
      const clearLock = () => db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      if (phase === "schedule") await clearLock();
      const transaction = db.transaction.bind(db);
      let raceApplied = false;
      const transactionSpy = phase === "transaction"
        ? vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
            await clearLock();
            raceApplied = true;
            return transaction(callback, config);
          })
        : null;
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now, retryReason: "ai_connection_busy", wakeReason: "ai_connection_busy_retry",
        maxAttempts: 1, delayMs: 1_000,
      }).finally(() => transactionSpy?.mockRestore());
      if (phase === "transaction") expect(raceApplied).toBe(true);
      if (phase === "schedule" || phase === "transaction") {
        expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "issue_execution_lock_changed" });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
        return;
      }
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;
      if (phase === "promote") await clearLock();
      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      if (phase === "promote") {
        expect(promotion).toEqual({ promoted: 0, runIds: [] });
      } else {
        expect(promotion.runIds).toContain(scheduled.run.id);
        await clearLock();
        const adapter = createPostgresRunDispatchAdapter(db);
        expect(await adapter.cancelStaleQueuedRun({
          companyId, runId: scheduled.run.id, expectedStatus: "queued", now: scheduled.dueAt,
        })).toMatchObject({ outcome: "cancelled", errorCode: "issue_execution_lock_changed" });
      }
      expect(await heartbeat.getRun(scheduled.run.id)).toMatchObject({
        status: "cancelled", errorCode: "issue_execution_lock_changed",
      });
    },
  );

  it("does not promote a duplicate max-turn continuation that does not own the issue lock", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const duplicateWakeupId = randomUUID();
    const duplicateRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: MAX_TURN_CONTINUATION_WAKE_REASON,
      payload: {
        issueId,
        retryOfRunId: runId,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: duplicateWakeupId,
      retryOfRunId: runId,
      scheduledRetryAt: scheduled.dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: duplicateRunId })
      .where(eq(agentWakeupRequests.id, duplicateWakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const duplicate = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, duplicateRunId))
      .then((rows) => rows[0] ?? null);
    expect(duplicate).toEqual({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
    });

    const duplicateWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("cancelled");
  });

  it.each(["blocked", "todo", "backlog"] as const)(
    "cancels a due max-turn continuation when the issue moves to %s before retry promotion",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture();

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      await db.update(issues).set({
        status: issueStatus,
        updatedAt: new Date(now.getTime() + 500),
      }).where(eq(issues.id, issueId));

      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(promotion).toEqual({ promoted: 0, runIds: [] });

      const retryRun = await db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "cancelled",
        errorCode: "issue_not_in_progress",
      });

      const wakeupRequest = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect(wakeupRequest?.status).toBe("cancelled");

      const issue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      const event = await db
        .select({
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, scheduled.run.id))
        .orderBy(sql`${heartbeatRunEvents.seq} desc`)
        .then((rows) => rows[0] ?? null);
      expect(event?.message).toContain("no longer in_progress");
      expect(event?.payload).toMatchObject({
        currentStatus: issueStatus,
        requiredStatus: "in_progress",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      });
    },
  );

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);

    // The stale-retry cancel runs inside enqueueWakeup's transaction, and
    // the run's own required lifecycle work never awaits the telemetry
    // emission, so wait for it here instead of asserting it fired
    // synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: oldAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const onLiveEvent = vi.fn();
    const unsubscribe = subscribeCompanyLiveEvents(companyId, onLiveEvent);
    try {
      const restartedHeartbeat = heartbeatService(createDb(tempDb!.connectionString));
      const repeated = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? heartbeat : restartedHeartbeat).scheduleBoundedRetry(cappedRunId, {
          now, random: () => 0.5,
        })));
      expect(repeated).toEqual(Array.from({ length: 8 }, () => exhausted));
      expect(await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, cappedRunId))).toHaveLength(1);
      expect((await heartbeat.getRun(cappedRunId))?.nextEventSeq).toBe(2);
      expect(onLiveEvent).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await cleanupRetryFixture();
    }
  });

  it("requires reconciliation for a classified Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T12:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: "transient_upstream",
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
  });

  it("requires reconciliation for an error-code-only Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T13:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: null,
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  describe("run-dispatch module transactions", () => {
    it("promotes a due scheduled retry exactly once under concurrent promotion attempts", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-01T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      const [first, second] = await Promise.all([
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
      ]);

      expect(first.promoted + second.promoted).toBe(1);
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("queued");
    });

    it("rolls back the run-status update when the run-event write fails during promotion", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-02T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected promotion event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(scheduled.dueAt)).rejects.toThrow(
        "injected promotion event fault",
      );

      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("scheduled_retry");
    });

    it("rolls back the wakeup-request update when the run-event write fails during a gate-suppressed cancellation", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const missingIssueId = randomUUID();
      const now = new Date("2026-05-03T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });

      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "retry",
        status: "queued",
      });

      // A max-turn continuation whose issue no longer exists trips the gate's
      // "issue_not_found" rejection without the legacy transient-retry
      // exception, so promotion routes it to the cancel-suppressed-retry write.
      const retryRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeupRequestId,
        contextSnapshot: { issueId: missingIssueId, wakeReason: "issue_continuation_needed" },
        updatedAt: now,
        createdAt: now,
      });

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected cancellation event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(now)).rejects.toThrow(
        "injected cancellation event fault",
      );

      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId));
      expect(run?.status).toBe("scheduled_retry");

      const [wake] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      expect(wake?.status).toBe("queued");
    });

    it("keeps promotion and stale-queued-run cancellation company-scoped", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date("2026-05-04T00:00:00.000Z");

      await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
      await db
        .update(heartbeatRuns)
        .set({ status: "scheduled_retry", scheduledRetryAt: now })
        .where(eq(heartbeatRuns.id, runId));

      const wrongCompanyPromotion = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId: otherCompanyId,
        now,
      });
      expect(wrongCompanyPromotion).toEqual({ outcome: "not_promoted" });
      const [afterWrongCompanyPromotion] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(afterWrongCompanyPromotion?.status).toBe("scheduled_retry");

      const rightCompanyPromotion = await adapter.promoteOrCancelDueRetry({ runId, companyId, now });
      expect(rightCompanyPromotion.outcome).toBe("promoted");

      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      const queuedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId },
        updatedAt: now,
        createdAt: now,
      });

      await expect(
        adapter.cancelStaleQueuedRun({
          runId: queuedRunId,
          companyId: otherCompanyId,
          expectedStatus: "queued",
          now,
        }),
      ).rejects.toThrow();
      const [afterWrongCompanyCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterWrongCompanyCancel?.status).toBe("queued");

      const lostRaceCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "running",
        now,
      });
      expect(lostRaceCancel).toEqual({ outcome: "lost_race" });
      const [afterLostRaceCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterLostRaceCancel?.status).toBe("queued");

      const rightCompanyCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(rightCompanyCancel.outcome).toBe("cancelled");
    });

    it("never writes another company's wakeup request during suppressed-retry or stale-queued-run cancellation", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");

      await seedRetryFixture({ runId: randomUUID(), companyId, agentId, now, errorCode: "adapter_failed" });
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Each wakeup request belongs to `otherCompanyId`, standing in for a
      // mismatched cross-company reference on the run — the scenario the
      // company predicate on the wakeup write must guard against.
      const suppressedWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: suppressedWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "retry",
        status: "queued",
      });
      const suppressedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: suppressedRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        wakeupRequestId: suppressedWakeupId,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        contextSnapshot: { issueId: randomUUID() },
        updatedAt: now,
        createdAt: now,
      });

      const suppressedCancel = await adapter.promoteOrCancelDueRetry({
        runId: suppressedRunId,
        companyId,
        now,
      });
      expect(suppressedCancel.outcome).toBe("gate_suppressed");

      const [suppressedWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, suppressedWakeupId));
      expect(suppressedWakeup?.status).toBe("queued");

      const staleWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: staleWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "assignment",
        status: "queued",
      });
      const staleIssueId = randomUUID();
      const staleIssuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: staleIssueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 3,
        identifier: `${staleIssuePrefix}-3`,
      });
      const staleRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        wakeupRequestId: staleWakeupId,
        contextSnapshot: { issueId: staleIssueId },
        updatedAt: now,
        createdAt: now,
      });

      const staleCancel = await adapter.cancelStaleQueuedRun({
        runId: staleRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(staleCancel.outcome).toBe("cancelled");

      const [staleWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, staleWakeupId));
      expect(staleWakeup?.status).toBe("queued");
    });

    it("orders due retries by due time, honors the cutoff, and caps a sweep at 50 runs", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Due, but created well before the cutoff: the cutoff must exclude it
      // even though it is the single most-overdue run in the table.
      const beforeCutoffRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: beforeCutoffRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(now.getTime() - 1_000),
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 1_000_000),
        updatedAt: now,
      });

      // 52 due, in-cutoff runs, strictly ordered by scheduledRetryAt/createdAt.
      const dueRunIds = Array.from({ length: 52 }, () => randomUUID());
      for (let i = 0; i < dueRunIds.length; i += 1) {
        const dueAt = new Date(now.getTime() - (dueRunIds.length - i) * 1_000);
        await db.insert(heartbeatRuns).values({
          id: dueRunIds[i],
          companyId,
          agentId,
          invocationSource: "retry",
          status: "scheduled_retry",
          scheduledRetryAt: dueAt,
          contextSnapshot: {},
          createdAt: dueAt,
          updatedAt: now,
        });
      }

      const cutoff = new Date(now.getTime() - 500_000);
      const result = await adapter.listDueRetries({ now, cutoff, limit: 50 });

      expect(result).toHaveLength(50);
      expect(result.map((r) => r.runId)).toEqual(dueRunIds.slice(0, 50));
      const resultIds = new Set(result.map((r) => r.runId));
      expect(resultIds.has(beforeCutoffRunId)).toBe(false);
      expect(resultIds.has(dueRunIds[50])).toBe(false);
      expect(resultIds.has(dueRunIds[51])).toBe(false);
    });
  });
});
