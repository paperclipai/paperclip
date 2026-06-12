import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activeRunExecutions,
  heartbeatService,
  runClaimHeartbeatPass,
} from "../services/heartbeat.ts";

/**
 * Multi-replica executor claim tests: two heartbeat-service instances with
 * distinct replica ids over two connection pools against ONE embedded
 * Postgres, reproducing the distributed-claim race. Claims go through the
 * real claimRunsForExecution (SKIP LOCKED batch claim + post-claim
 * validations); rows are seeded directly through the schema.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat executor-claim tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbedded("heartbeat executor batch claims", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;
  let replicaA: ReturnType<typeof heartbeatService>;
  let replicaB: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-executor-claims-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
    replicaA = heartbeatService(dbA, { replicaId: "replica-a" });
    replicaB = heartbeatService(dbB, { replicaId: "replica-b" });
  }, 30_000);

  afterEach(async () => {
    await dbA.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts?: {
    companyStatus?: string;
    agentStatus?: string;
    maxConcurrentRuns?: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await dbA.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...(opts?.companyStatus ? { status: opts.companyStatus } : {}),
    });
    await dbA.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: opts?.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts?.maxConcurrentRuns ?? 50,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    createdAt?: Date;
    claimAttempts?: number;
    withWakeup?: boolean;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    let wakeupRequestId: string | null = null;
    if (input.withWakeup) {
      wakeupRequestId = randomUUID();
      await dbA.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: input.companyId,
        agentId: input.agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "executor-claim-test",
        payload: {},
        status: "queued",
      });
    }
    await dbA.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: input.contextSnapshot ?? {},
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(typeof input.claimAttempts === "number" ? { claimAttempts: input.claimAttempts } : {}),
    });
    return { runId, wakeupRequestId };
  }

  async function getRunRow(runId: string) {
    return dbA
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("never claims the same run twice across two replicas claiming concurrently", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const seeded: string[] = [];
    const base = Date.now() - 60_000;
    for (let i = 0; i < 20; i += 1) {
      const { runId } = await seedQueuedRun({
        companyId,
        agentId,
        createdAt: new Date(base + i * 100),
      });
      seeded.push(runId);
    }

    const claimedByA: string[] = [];
    const claimedByB: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const [fromA, fromB] = await Promise.all([
        replicaA.claimRunsForExecution(2),
        replicaB.claimRunsForExecution(2),
      ]);
      claimedByA.push(...fromA);
      claimedByB.push(...fromB);
    }

    const all = [...claimedByA, ...claimedByB];
    expect(new Set(all).size).toBe(all.length); // no id claimed twice
    expect([...all].sort()).toEqual([...seeded].sort()); // union complete

    const rows = await dbA
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, claimedBy: heartbeatRuns.claimedBy })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, seeded));
    for (const row of rows) {
      expect(row.status).toBe("running");
      expect(claimedByA.includes(row.id) ? "replica-a" : "replica-b").toBe(row.claimedBy);
    }
  });

  it("escalates runs past the claim-attempt bound to failure instead of returning them", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      claimAttempts: 5,
      withWakeup: true,
    });

    const claimed = await replicaA.claimRunsForExecution(5);
    expect(claimed).toEqual([]);

    const run = await getRunRow(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("claim_attempts_exhausted");
    expect(run?.finishedAt).not.toBeNull();

    const wakeup = await dbA
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("failed");
  });

  it("claims mark wakeups claimed and stamp the executor-claim columns", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, withWakeup: true });

    const claimed = await replicaA.claimRunsForExecution(1);
    expect(claimed).toEqual([runId]);

    const run = await getRunRow(runId);
    expect(run?.status).toBe("running");
    expect(run?.claimedBy).toBe("replica-a");
    expect(run?.claimedAt).not.toBeNull();
    expect(run?.executorHeartbeatAt).not.toBeNull();
    expect(run?.startedAt).not.toBeNull();
    expect(run?.claimAttempts).toBe(1);

    const wakeup = await dbA
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("releaseExecutorClaims returns claimed runs to queued, keeping the attempt count", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId } = await seedQueuedRun({ companyId, agentId });

    const claimed = await replicaA.claimRunsForExecution(1);
    expect(claimed).toEqual([runId]);

    // Wrong replica: a foreign release must not touch the claim.
    await replicaB.releaseExecutorClaims([runId]);
    expect((await getRunRow(runId))?.status).toBe("running");

    await replicaA.releaseExecutorClaims([runId]);
    const run = await getRunRow(runId);
    expect(run?.status).toBe("queued");
    expect(run?.claimedBy).toBeNull();
    expect(run?.claimedAt).toBeNull();
    expect(run?.executorHeartbeatAt).toBeNull();
    expect(run?.claimAttempts).toBe(1); // release keeps the consumed attempt

    // Released runs are claimable again.
    const reclaimed = await replicaB.claimRunsForExecution(1);
    expect(reclaimed).toEqual([runId]);
    expect((await getRunRow(runId))?.claimedBy).toBe("replica-b");
    expect((await getRunRow(runId))?.claimAttempts).toBe(2);
  });

  it("heartbeatExecutorClaims re-stamps only claims owned by the caller", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId } = await seedQueuedRun({ companyId, agentId });
    await replicaA.claimRunsForExecution(1);

    const before = (await getRunRow(runId))!.executorHeartbeatAt!;
    await new Promise((res) => setTimeout(res, 25));

    await replicaB.heartbeatExecutorClaims([runId]); // foreign: no-op
    expect((await getRunRow(runId))!.executorHeartbeatAt!.getTime()).toBe(before.getTime());

    await replicaA.heartbeatExecutorClaims([runId]);
    expect((await getRunRow(runId))!.executorHeartbeatAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("never claims runs of non-active companies", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ companyStatus: "archived" });
    const { runId } = await seedQueuedRun({ companyId, agentId });

    const claimed = await replicaA.claimRunsForExecution(10);
    expect(claimed).toEqual([]);
    expect((await getRunRow(runId))?.status).toBe("queued");
    expect((await getRunRow(runId))?.claimAttempts).toBe(0);
  });

  it("releases claims beyond the agent's max concurrent runs without consuming attempts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });
    // One run already running for the agent: the agent has zero free slots.
    await dbA.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
    });
    const { runId } = await seedQueuedRun({ companyId, agentId });

    const claimed = await replicaA.claimRunsForExecution(5);
    expect(claimed).toEqual([]);

    const run = await getRunRow(runId);
    expect(run?.status).toBe("queued");
    expect(run?.claimedBy).toBeNull();
    // Waiting on a busy agent is not claim churn: the attempt is restored.
    expect(run?.claimAttempts).toBe(0);
  });

  it("allocates only the agent's free slots when a batch claims several runs of one agent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 2 });
    const base = Date.now() - 60_000;
    const first = await seedQueuedRun({ companyId, agentId, createdAt: new Date(base) });
    const second = await seedQueuedRun({ companyId, agentId, createdAt: new Date(base + 100) });
    const third = await seedQueuedRun({ companyId, agentId, createdAt: new Date(base + 200) });

    const claimed = await replicaA.claimRunsForExecution(5);
    expect([...claimed].sort()).toEqual([first.runId, second.runId].sort());

    expect((await getRunRow(third.runId))?.status).toBe("queued");
    expect((await getRunRow(third.runId))?.claimAttempts).toBe(0);
  });

  it("cancels claimed runs of terminated agents and releases runs of paused agents", async () => {
    const terminated = await seedCompanyAndAgent({ agentStatus: "terminated" });
    const paused = await seedCompanyAndAgent({ agentStatus: "paused" });
    const terminatedRun = await seedQueuedRun({ companyId: terminated.companyId, agentId: terminated.agentId });
    const pausedRun = await seedQueuedRun({ companyId: paused.companyId, agentId: paused.agentId });

    const claimed = await replicaA.claimRunsForExecution(10);
    expect(claimed).toEqual([]);

    const cancelled = await getRunRow(terminatedRun.runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toContain("not invokable");

    // The per-agent scheduler leaves paused agents' queued runs queued; the
    // executor mirrors that by releasing the claim without an attempt.
    const released = await getRunRow(pausedRun.runId);
    expect(released?.status).toBe("queued");
    expect(released?.claimedBy).toBeNull();
    expect(released?.claimAttempts).toBe(0);
  });

  describe("sweep/claim TOCTOU race", () => {
    async function cancelEventCount(runId: string) {
      const rows = await dbA
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      return Number(rows[0]?.count ?? 0);
    }

    it("the sweep's stale-snapshot validation must not cancel a run an executor just claimed", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, withWakeup: true });

      // The leader-side sweep takes its queued snapshot...
      const staleSnapshot = await getRunRow(runId);
      expect(staleSnapshot?.status).toBe("queued");

      // ...then an executor batch-claims the run (atomic, status -> running)...
      const claimed = await replicaB.claimRunsForExecution(1);
      expect(claimed).toEqual([runId]);

      // ...and a cancel gate flips (agent terminated) before the sweep
      // validates its stale snapshot.
      await dbA.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

      const validation = await replicaA.validateQueuedRunForClaim(staleSnapshot!, undefined, {
        cancelOnlyIf: { status: "queued" },
      });
      expect(validation).toEqual({ ok: false, outcome: "unchanged" });

      // The executor's claim survives, with none of the cancel side effects.
      const run = await getRunRow(runId);
      expect(run?.status).toBe("running");
      expect(run?.claimedBy).toBe("replica-b");
      expect(run?.error).toBeNull();
      expect(run?.finishedAt).toBeNull();

      const wakeup = await dbA
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId!))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("claimed");
      expect(await cancelEventCount(runId)).toBe(0);
    });

    it("post-claim validation does not cancel a run another executor now owns", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId } = await seedQueuedRun({ companyId, agentId });

      const claimed = await replicaB.claimRunsForExecution(1);
      expect(claimed).toEqual([runId]);
      const claimedRow = await getRunRow(runId);

      await dbA.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

      // Replica A validating a claim it believes it owns (e.g. after losing
      // the row to a reap/re-claim cycle) must not touch replica B's claim.
      const validation = await replicaA.validateQueuedRunForClaim(claimedRow!, undefined, {
        cancelOnlyIf: { status: "running", claimedBy: "replica-a" },
      });
      expect(validation).toEqual({ ok: false, outcome: "unchanged" });

      const run = await getRunRow(runId);
      expect(run?.status).toBe("running");
      expect(run?.claimedBy).toBe("replica-b");
    });

    it("a genuinely queued gated run is still cancelled by the sweep validation", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, withWakeup: true });
      await dbA.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

      const snapshot = await getRunRow(runId);
      const validation = await replicaA.validateQueuedRunForClaim(snapshot!, undefined, {
        cancelOnlyIf: { status: "queued" },
      });
      expect(validation).toEqual({ ok: false, outcome: "cancelled" });

      const run = await getRunRow(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.error).toContain("not invokable");

      const wakeup = await dbA
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId!))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("cancelled");
    });

    it("resumeQueuedRuns end-to-end still cancels a queued run whose issue no longer exists", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId } = await seedQueuedRun({
        companyId,
        agentId,
        contextSnapshot: { issueId: randomUUID() },
      });

      await replicaA.resumeQueuedRuns();

      const run = await getRunRow(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("issue_not_found");
    });
  });

  describe("claimed_by-aware orphan reaper", () => {
    async function seedRunningRun(input: {
      companyId: string;
      agentId: string;
      claimedBy?: string | null;
      executorHeartbeatAt?: Date | null;
      updatedAt?: Date;
    }) {
      const runId = randomUUID();
      await dbA.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(Date.now() - 10 * 60_000),
        claimedBy: input.claimedBy ?? null,
        claimedAt: input.claimedBy ? new Date(Date.now() - 10 * 60_000) : null,
        executorHeartbeatAt: input.executorHeartbeatAt ?? null,
      });
      if (input.updatedAt) {
        await dbA
          .update(heartbeatRuns)
          .set({ updatedAt: input.updatedAt })
          .where(eq(heartbeatRuns.id, runId));
      }
      return runId;
    }

    it("does not reap a foreign run with a fresh executor heartbeat even when updated_at is stale", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const runId = await seedRunningRun({
        companyId,
        agentId,
        claimedBy: "replica-b",
        executorHeartbeatAt: new Date(),
        updatedAt: new Date(Date.now() - 60 * 60_000),
      });

      const result = await replicaA.reapOrphanedRuns({ staleThresholdMs: 1_000 });
      expect(result.runIds).not.toContain(runId);
      expect((await getRunRow(runId))?.status).toBe("running");
    });

    it("reaps a foreign run whose executor heartbeat went stale", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const runId = await seedRunningRun({
        companyId,
        agentId,
        claimedBy: "replica-b",
        executorHeartbeatAt: new Date(Date.now() - 120_000),
      });

      const result = await replicaA.reapOrphanedRuns();
      expect(result.runIds).toContain(runId);
      const run = await getRunRow(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("process_lost");
    });

    it("keeps reaping unclaimed runs and own claims whose heartbeat went stale", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const unclaimed = await seedRunningRun({ companyId, agentId, claimedBy: null });
      const ownStale = await seedRunningRun({
        companyId,
        agentId,
        claimedBy: "replica-a",
        // Own claims with a STALE beat are dead: the owning process stamps
        // the claim heartbeat every 15s while a run executes locally, so a
        // 120s-old beat means this process is no longer driving the run.
        executorHeartbeatAt: new Date(Date.now() - 120_000),
      });

      const result = await replicaA.reapOrphanedRuns();
      expect(result.runIds).toEqual(expect.arrayContaining([unclaimed, ownStale]));
      expect((await getRunRow(unclaimed))?.status).toBe("failed");
      expect((await getRunRow(ownStale))?.status).toBe("failed");
    });

    it("a locally-executing run with a live process-level heartbeat survives a foreign reaper pass at >90s wall-clock", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId } = await seedQueuedRun({ companyId, agentId });
      const claimed = await replicaA.claimRunsForExecution(1);
      expect(claimed).toEqual([runId]);

      // Simulate a long-lived run: the claim and last row write happened far
      // beyond EXECUTOR_HEARTBEAT_STALE_MS ago, but the owning process keeps
      // re-stamping the claim heartbeat.
      const old = new Date(Date.now() - 10 * 60_000);
      await dbA
        .update(heartbeatRuns)
        .set({ claimedAt: old, startedAt: old, updatedAt: old, executorHeartbeatAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));

      const result = await replicaB.reapOrphanedRuns({ staleThresholdMs: 1_000 });
      expect(result.runIds).not.toContain(runId);
      expect((await getRunRow(runId))?.status).toBe("running");
    });

    it("the process-wide claim-heartbeat pass refreshes executor_heartbeat_at for ids in the shared execution set regardless of which service instance claimed them", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId } = await seedQueuedRun({ companyId, agentId });
      const claimed = await replicaA.claimRunsForExecution(1);
      expect(claimed).toEqual([runId]);

      const stale = new Date(Date.now() - 60_000);
      await dbA
        .update(heartbeatRuns)
        .set({ executorHeartbeatAt: stale, updatedAt: stale })
        .where(eq(heartbeatRuns.id, runId));

      // The pass is module-level and reads the module-scoped execution set:
      // replica A's service instance claimed the run, but the pass runs over
      // a different pool (dbB) with only the replica id — exactly how the
      // always-on per-process loop sees claims made by route-constructed
      // service instances.
      activeRunExecutions.add(runId);
      try {
        await runClaimHeartbeatPass(dbB, "replica-a");
      } finally {
        activeRunExecutions.delete(runId);
      }

      const run = await getRunRow(runId);
      expect(run!.executorHeartbeatAt!.getTime()).toBeGreaterThan(stale.getTime());
      expect(run!.updatedAt!.getTime()).toBeGreaterThan(stale.getTime());

      // Foreign replica id: the pass must not touch claims it does not own.
      const after = run!.executorHeartbeatAt!;
      activeRunExecutions.add(runId);
      try {
        await runClaimHeartbeatPass(dbB, "replica-b");
      } finally {
        activeRunExecutions.delete(runId);
      }
      expect((await getRunRow(runId))!.executorHeartbeatAt!.getTime()).toBe(after.getTime());
    });

    it("own-branch freshness: a just-claimed run not yet in activeRunExecutions survives an acquisition reap (threshold 0)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { runId } = await seedQueuedRun({ companyId, agentId });
      const claimed = await replicaA.claimRunsForExecution(1);
      expect(claimed).toEqual([runId]);

      // Deliberately NOT executing the run: this is the window between the
      // claim UPDATE and activeRunExecutions.add (or a claim made by another
      // service instance in this process). The fresh claim beat must shield
      // it from the leadership-acquisition reap (threshold 0).
      const result = await replicaA.reapOrphanedRuns({ staleThresholdMs: 0 });
      expect(result.runIds).not.toContain(runId);
      const run = await getRunRow(runId);
      expect(run?.status).toBe("running");
      expect(run?.claimedBy).toBe("replica-a");
    });
  });
});
