import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { ensureRunAccountedForCounting, heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-count cost-accounting tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage for the Greptile-flagged gap on PR #11842: a heartbeat
// run that produces no billed cost and no token usage used to be silently
// dropped from `cost_events`, which made it invisible to a `run_count` budget
// policy (`count(distinct heartbeat_run_id)` never saw the row). Fixed in
// `updateRuntimeState` (server/src/services/heartbeat.ts) by always emitting a
// cost_events row per finalized run. This test drives the real
// `updateRuntimeState` production function against the embedded database and
// verifies the real `budgetService.overview()` run_count aggregate counts a
// zero-usage run.
describeEmbeddedPostgres("run_count budget metric counts zero-usage heartbeat runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-count-zero-usage-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Zero Usage Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertFinishedRun(companyId: string, agentId: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
      })
      .returning();
    return run!;
  }

  it("emits a cost_events row for a run with zero cost and zero tokens, and run_count counts it", async () => {
    const { companyId, agentId } = await seed();
    const heartbeat = heartbeatService(db);

    const zeroUsageRun = await insertFinishedRun(companyId, agentId);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

    await heartbeat.updateRuntimeState(
      agent,
      zeroUsageRun,
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        costUsd: null,
      },
      { legacySessionId: null },
    );

    const rows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, zeroUsageRun.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      heartbeatRunId: zeroUsageRun.id,
    });

    // A second, real-usage run in the same window so the policy has two runs
    // in scope: the zero-usage run above plus this one.
    const usageRun = await insertFinishedRun(companyId, agentId);
    await heartbeat.updateRuntimeState(
      agent,
      usageRun,
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
        costUsd: 0.02,
      },
      { legacySessionId: null },
    );

    const budgets = budgetService(db);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "run_count",
      windowKind: "lifetime",
      amount: 5,
      warnPercent: 50,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });

    const overview = await budgets.overview(companyId);
    const policy = overview.policies.find((p) => p.metric === "run_count");
    // Without the fix, the zero-usage run never gets a cost_events row and
    // run_count would observe 1 (only the real-usage run). With the fix it
    // observes both runs.
    expect(policy).toMatchObject({ observedAmount: 2 });
  });
});

// Regression coverage for a second Greptile-flagged gap on PR #11842: a run
// that never reaches `updateRuntimeState` at all -- because it was
// terminalized by the recovery backstop (server/src/services/recovery/service.ts
// `terminalizeOrphanedRunningRun`, invoked from `sweepStaleIssueLocks`) -- used
// to leave no cost_events row behind, so run_count silently missed it too.
// Fixed by threading an `onRunTerminalized` hook through `recoveryService` that
// calls the shared `ensureRunAccountedForCounting` helper right after the
// backstop commits a terminal status. This test drives the real
// `sweepStaleIssueLocks` production function (with the hook wired the same way
// `heartbeatService` wires it) against a "running" run whose owning issue is
// already "done", and asserts the run_count budget aggregate counts it.
describeEmbeddedPostgres(
  "run_count budget metric counts runs terminalized by the recovery backstop",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-count-recovery-backstop-");
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(budgetPolicies);
      await db.delete(costEvents);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentRuntimeState);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    it("counts a run left 'running' after its issue reached 'done', once the backstop sweep terminalizes it", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Backstop Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Ship the thing",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "R1-1",
        executionRunId: runId,
      });

      // No cost_events row exists yet for this run: it never went through
      // updateRuntimeState. Without the fix, sweepStaleIssueLocks terminalizes
      // heartbeat_runs.status but run_count still observes 0 for this run.
      const preSweepRows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      expect(preSweepRows).toHaveLength(0);

      const recovery = recoveryService(db, {
        enqueueWakeup: async () => null,
        onRunTerminalized: (terminalizedRun) =>
          ensureRunAccountedForCounting(db, {}, terminalizedRun.companyId, terminalizedRun.agentId, terminalizedRun),
      });

      const sweepResult = await recovery.sweepStaleIssueLocks();
      expect(sweepResult.terminalizedRunIds).toContain(runId);

      const [terminalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(terminalRun?.status).toBe("succeeded");

      const postSweepRows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      expect(postSweepRows).toHaveLength(1);

      const budgets = budgetService(db);
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "run_count",
        windowKind: "lifetime",
        amount: 5,
        warnPercent: 50,
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
      });

      const overview = await budgets.overview(companyId);
      const policy = overview.policies.find((p) => p.metric === "run_count");
      expect(policy).toMatchObject({ observedAmount: 1 });
    });
  },
);
