import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { createDelegateTaskCallback } from "../services/delegation.js";

// -----------------------------------------------------------------------------
// Step 3 / Option 1 — delegation integration test.
//
// Criterion covered: (a) Donald's child heartbeat_run.parent_run_id is
// populated with Ada's parent run id when delegate_task fires. This exercises
// Fix #9 end-to-end through the REAL heartbeatService.wakeup (not a mock),
// against the REAL heartbeat_runs table on embedded postgres.
//
// Criteria (b) post_tool_result_ok and (c) cacheReadTokens > 0 live at the
// adapter layer and are covered separately by delegation-h1-detector.test.ts
// (healthy case asserts cacheReadTokens=19300, spanCount=2, post_tool_result
// 2xx logs).
//
// The earlier live-server Tests 1 / 5 / 6 in delegation-e2e.test.ts are
// superseded by this file for the local CI path — real-MA verification is
// still needed for criterion (d) and happens in a separate dev-server repro.
// -----------------------------------------------------------------------------

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "stub-delegation-integration",
    finalText: "stub-delegation-integration: child run completed",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delegation integration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("delegation — integration (Fix #9 parent_run_id)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegation-integration-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 120_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Let any in-flight async run scheduling settle before truncating.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("delegate_task threads parent_run_id through the real heartbeat service to the child run", async () => {
    const companyId = randomUUID();
    const adaId = randomUUID();
    const donaldId = randomUUID();
    const adaParentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Charlie Oscar (delegation-int)",
      issuePrefix: `CO${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: adaId,
        companyId,
        name: "Ada",
        role: "ceo",
        status: "active",
        adapterType: "managed_agents",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: { canDelegate: true },
        reportsTo: null,
      },
      {
        id: donaldId,
        companyId,
        name: "Donald",
        role: "general",
        status: "active",
        adapterType: "managed_agents",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: { canDelegate: false },
        reportsTo: adaId,
      },
    ]);

    // Seed Ada's parent heartbeat_run so Fix #9's FK + lineage holds on the
    // child row we're about to create.
    await db.insert(heartbeatRuns).values({
      id: adaParentRunId,
      companyId,
      agentId: adaId,
      status: "running",
      invocationSource: "on_demand",
    });

    const delegateTask = createDelegateTaskCallback({
      db,
      // Real heartbeat service — not a mock. This is the whole point: we want
      // to exercise the actual enqueueWakeup code path that Fix #9 touches.
      heartbeat: {
        wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      },
      parentAgent: {
        id: adaId,
        companyId,
        name: "Ada",
        permissions: { canDelegate: true },
      },
      parentRunId: adaParentRunId,
    });

    const result = await delegateTask({
      assigneeAgentName: "Donald",
      title: "Run Cornerstone hygiene audit",
      description:
        "Audit Mal's default namespace for stale facts, duplicates, contradictions.",
      waitForCompletion: false,
      timeoutSeconds: 30,
    });

    // delegate_task returns status=queued with a real heartbeat_run id.
    expect(result.status).toBe("queued");
    expect(result.errorCode).toBeNull();
    expect(result.childRunId).toBeTruthy();
    expect(result.childIssueId).toBeTruthy();

    // -------------------------------------------------------------------------
    // Criterion (a): parent_run_id must be populated on the child run.
    //
    // This is the direct Fix #9 assertion. Before Fix #9 either the coalesce
    // path at heartbeat.ts:6552 or the new-run insert at :6678 would drop
    // opts.parentRunId; the row would have parent_run_id = null and the cost
    // rollup + lineage audit trail would be severed.
    // -------------------------------------------------------------------------
    const childRunId = result.childRunId!;
    const childRow = await waitForCondition(async () => {
      const row = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, childRunId))
        .then((rows) => rows[0] ?? null);
      return row != null;
    }).then(() =>
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, childRunId))
        .then((rows) => rows[0] ?? null),
    );

    expect(childRow).toBeTruthy();
    expect(childRow!.agentId).toBe(donaldId);
    expect(childRow!.parentRunId).toBe(adaParentRunId);
    expect(childRow!.invocationSource).toBe("assignment");

    // Issue ↔ run linkage: child run's context_snapshot must carry issueId so
    // the reconciler can tie them together for resumption logic.
    const contextSnapshot = (childRow!.contextSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    expect(contextSnapshot.issueId).toBe(result.childIssueId);
    expect(contextSnapshot.source).toBe("delegate_task");

    // -------------------------------------------------------------------------
    // Wakeup request must be flagged as delegation-originated so the
    // reconciler can distinguish it from ordinary assignments.
    // -------------------------------------------------------------------------
    const wakeupRow = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, donaldId),
          eq(agentWakeupRequests.reason, "delegate_task"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeupRow).toBeTruthy();
    expect(wakeupRow!.requestedByActorType).toBe("agent");
    expect(wakeupRow!.requestedByActorId).toBe(adaId);
  });

  it("coalesce path preserves parent_run_id when a delegation wakeup merges into an existing run", async () => {
    // ------------------------------------------------------------------------
    // Covers the SECOND Fix #9 site: the coalesce path at heartbeat.ts:6756
    // (shouldSetParentRunId first-writer-wins gate). Scenario: Donald already
    // has a queued/running run from a prior wake; a new delegation wakeup
    // from Ada arrives and coalesces into it. Fix #9 requires the coalesce
    // UPDATE to stamp parent_run_id on the pre-existing run.
    // ------------------------------------------------------------------------
    const companyId = randomUUID();
    const adaId = randomUUID();
    const donaldId = randomUUID();
    const adaParentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Charlie Oscar (coalesce-int)",
      issuePrefix: `CC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: adaId,
        companyId,
        name: "Ada",
        role: "ceo",
        status: "active",
        adapterType: "managed_agents",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: { canDelegate: true },
        reportsTo: null,
      },
      {
        id: donaldId,
        companyId,
        name: "Donald",
        role: "general",
        status: "active",
        adapterType: "managed_agents",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: { canDelegate: false },
        reportsTo: adaId,
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: adaParentRunId,
      companyId,
      agentId: adaId,
      status: "running",
      invocationSource: "on_demand",
    });

    // Seed a pre-existing queued run for Donald — no parent_run_id yet.
    const existingDonaldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingDonaldRunId,
      companyId,
      agentId: donaldId,
      status: "queued",
      invocationSource: "on_demand",
      contextSnapshot: {},
    });

    // Fire a delegation wakeup that should coalesce into the existing run.
    await heartbeat.wakeup(donaldId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "delegate_task",
      payload: { mutation: "delegate_task" },
      contextSnapshot: { source: "delegate_task" },
      parentRunId: adaParentRunId,
    });

    // ------------------------------------------------------------------------
    // After coalesce: existing run row must carry the delegator's parent_run_id
    // even though it was inserted earlier without one. This is the
    // shouldSetParentRunId first-writer-wins branch.
    // ------------------------------------------------------------------------
    const coalescedRow = await waitForCondition(async () => {
      const row = await db
        .select({ parentRunId: heartbeatRuns.parentRunId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, existingDonaldRunId))
        .then((rows) => rows[0] ?? null);
      return row?.parentRunId === adaParentRunId;
    }).then(() =>
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, existingDonaldRunId))
        .then((rows) => rows[0] ?? null),
    );

    expect(coalescedRow).toBeTruthy();
    expect(coalescedRow!.parentRunId).toBe(adaParentRunId);

    // A subsequent delegation wakeup from a DIFFERENT parent must NOT overwrite
    // the already-set parent_run_id (first-writer-wins guard).
    const otherParentRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherParentRunId,
      companyId,
      agentId: adaId,
      status: "running",
      invocationSource: "on_demand",
    });

    await heartbeat.wakeup(donaldId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "delegate_task",
      payload: { mutation: "delegate_task" },
      contextSnapshot: { source: "delegate_task" },
      parentRunId: otherParentRunId,
    });

    const afterSecondWake = await db
      .select({ parentRunId: heartbeatRuns.parentRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, existingDonaldRunId))
      .then((rows) => rows[0] ?? null);
    expect(afterSecondWake?.parentRunId).toBe(adaParentRunId);
  });

  it("non-delegation wakeups leave parent_run_id null (no accidental inheritance)", async () => {
    // Defensive regression test: an ordinary (non-delegation) wakeup must not
    // stamp parent_run_id from any ambient state. Guards against a future
    // refactor that might leak a stray parentRunId into the insert.
    const companyId = randomUUID();
    const donaldId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Charlie Oscar (no-parent-int)",
      issuePrefix: `CN${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: donaldId,
      companyId,
      name: "Donald",
      role: "general",
      status: "active",
      adapterType: "managed_agents",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      reportsTo: null,
    });

    const wakeupResult = await heartbeat.wakeup(donaldId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "user_requested",
      payload: {},
      contextSnapshot: {},
    });
    expect(wakeupResult).not.toBeNull();

    const row = await db
      .select({ parentRunId: heartbeatRuns.parentRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeupResult!.id))
      .then((rows) => rows[0] ?? null);
    expect(row?.parentRunId).toBeNull();

    // Also assert zero rows in the same company have a non-null parent_run_id.
    const leakedCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.parentRunId} is not null`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    expect(leakedCount).toBe(0);
  });
});
