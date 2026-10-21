import { randomUUID } from "node:crypto";
import {
  activityLog, agentInstructionWorkingCopies, agents, agentWakeupRequests, companies,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments, heartbeatRuns,
  issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatAgentStatus, settledAgentWorkCondition } from "./agent-status.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent status database tests: ${support.reason}`);

describePostgres("heartbeat agent status", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let service: ReturnType<typeof createHeartbeatAgentStatus>;
  const live = new Set<string>();
  const old = () => new Date(Date.now() - 60 * 60_000);

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-status-");
    db = createDb(database.connectionString);
    service = createHeartbeatAgentStatus(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    live.clear();
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(agentInstructionWorkingCopies);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(status = "interrupted") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Status recovery", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
      status: "running", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false } },
      lastHeartbeatAt: null, updatedAt: old(), createdAt: old() });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished work", status: "done" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      invocationSource: "automation", status, runtimeMode: "legacy", startedAt: old(),
      finishedAt: ["running", "queued"].includes(status) ? null : old(),
      updatedAt: old(), createdAt: old(),
      errorCode: status === "interrupted" ? "server_shutdown_interrupted" : null });
    return { companyId, agentId, runId, issueId };
  }

  const reconcile = () => service.reconcileStrandedAgentStatuses(() => live);
  const agent = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0]!);

  it("repairs a shutdown flag without inventing a heartbeat, and records the repair once", async () => {
    const { agentId, runId } = await seed();
    expect(await reconcile()).toEqual([agentId]);
    expect(await agent(agentId)).toMatchObject({ status: "idle", lastHeartbeatAt: null, errorReason: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
      .toEqual([expect.objectContaining({ status: "interrupted", errorCode: "server_shutdown_interrupted" })]);
    expect(await reconcile()).toEqual([]);
    expect(await db.select().from(activityLog)).toEqual([expect.objectContaining({
      entityId: agentId, action: "agent.status_reconciled",
      details: { previousStatus: "running", nextStatus: "idle", reason: "no_unsettled_execution" },
    })]);
  });

  it("repairs a pre-run flag when no run was ever recorded", async () => {
    const { agentId, runId } = await seed();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await reconcile()).toEqual([agentId]);
  });

  it.each(["failed", "timed_out"])("preserves a %s outcome and its error", async status => {
    const { agentId, runId } = await seed(status);
    await db.update(heartbeatRuns).set({ error: "  Execution failed  " }).where(eq(heartbeatRuns.id, runId));
    expect(await reconcile()).toEqual([agentId]);
    expect(await agent(agentId)).toMatchObject({ status: "error", errorReason: "Execution failed" });
  });

  it.each(["running", "queued", "unrecognized"])("keeps a %s run as work", async status => {
    const { agentId } = await seed(status);
    expect(await reconcile()).toEqual([]);
    expect((await agent(agentId)).status).toBe("running");
  });

  it.each(["paused", "terminated", "error", "pending_approval"])("preserves an agent's %s state", async status => {
    const { agentId } = await seed();
    await db.update(agents).set({ status }).where(eq(agents.id, agentId));
    expect(await reconcile()).toEqual([]);
    if (["paused", "terminated", "pending_approval"].includes(status)) {
      await db.update(agents).set({ lifecycleState: "paused" }).where(eq(agents.id, agentId));
      await service.finalizeAgentStatus(agentId, "succeeded");
    }
    expect((await agent(agentId)).status).toBe(status);
  });

  it("retains the startup grace window", async () => {
    const { agentId } = await seed();
    await db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, agentId));
    expect(await reconcile()).toEqual([]);
  });

  it.each(["missing_finish", "accounting", "retry", "controller", "local_execution"])("retains unfinished %s work", async hold => {
    const { runId } = await seed();
    const patch = hold === "missing_finish" ? { finishedAt: null }
      : hold === "accounting" ? { costAccountingPending: true }
      : hold === "retry" ? { scheduledRetryAt: new Date() }
      : hold === "controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {};
    await db.update(heartbeatRuns).set({ ...patch, updatedAt: old() }).where(eq(heartbeatRuns.id, runId));
    if (hold === "local_execution") live.add(runId);
    expect(await reconcile()).toEqual([]);
  });

  it("retains an admitted wake even without a run", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "queued" });
    expect(await reconcile()).toEqual([]);
  });

  it("retains resource cleanup and succeeds after cleanup is recorded", async () => {
    const { companyId, agentId, runId } = await seed();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      status: "pending_cleanup", provider: "daytona", providerLeaseId: "synthetic-allocation" }).returning();
    expect(await reconcile()).toEqual([]);
    await db.update(environmentLeases).set({ status: "released", releasedAt: old() }).where(eq(environmentLeases.id, lease!.id));
    expect(await reconcile()).toEqual([agentId]);
  });

  it.each(["pendingCleanupInFlight", "nativeWorkspaceExportResume", "sandboxStopAndRetain"])("keeps a released lease's %s obligation", async key => {
    const { companyId, runId } = await seed();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      status: "released", releasedAt: old(), metadata: { [key]: true } });
    expect(await reconcile()).toEqual([]);
  });

  it("accepts proved-settled failed local lease history before a later shutdown", async () => {
    const { companyId, agentId, runId } = await seed("failed");
    const [environment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, environmentId: environment!.id,
      status: "failed", leasePolicy: "ephemeral", provider: "local", releasedAt: old(), metadata: { driver: "local" } });
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "interrupted",
      runtimeMode: "legacy", startedAt: old(), finishedAt: new Date(Date.now() - 30 * 60_000) });
    expect(await reconcile()).toEqual([agentId]);
    expect((await agent(agentId)).status).toBe("idle");
  });

  it.each(["valid", "wrong_run", "missing_receipt", "pending_cleanup"])("requires exact failed remote cleanup proof: %s", async kind => {
    const { companyId, agentId, runId } = await seed();
    const leaseId = randomUUID();
    const receipt = { schema: "paperclip.remote-termination.v1", companyId, runId: kind === "wrong_run" ? randomUUID() : runId,
      leaseId, provider: "daytona", providerLeaseId: "synthetic-allocation", state: "destroyed" };
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId,
      status: "failed", leasePolicy: "ephemeral", provider: "daytona", providerLeaseId: "synthetic-allocation",
      releasedAt: old(), cleanupStatus: "success", metadata: {
        ...(kind === "missing_receipt" ? {} : { remoteExecutionTermination: receipt }),
        ...(kind === "pending_cleanup" ? { pendingCleanupInFlight: true } : {}),
      } });
    expect(await reconcile()).toEqual(kind === "valid" ? [agentId] : []);
  });

  it("does not probe cleanup once per retained finished run", async () => {
    const { companyId, agentId } = await seed();
    await db.execute(sql`INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status,
      started_at, finished_at, created_at, updated_at)
      SELECT ${companyId}::uuid, ${agentId}::uuid, 'automation', 'succeeded',
        ${old().toISOString()}::timestamptz, ${old().toISOString()}::timestamptz,
        ${old().toISOString()}::timestamptz, ${old().toISOString()}::timestamptz
      FROM generate_series(1, 10000)`);
    await db.execute(sql`ANALYZE heartbeat_runs`);
    const predicate = and(eq(agents.id, agentId), settledAgentWorkCondition(live, new Date()));
    const result = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT ${agents.id} FROM ${agents} WHERE ${predicate}`);
    const plan = result[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const scans: Record<string, number[]> = {};
    function visit(node: Record<string, unknown>) {
      const relation = node["Relation Name"] as string | undefined;
      if (relation) (scans[relation] ??= []).push(Number(node["Actual Loops"]));
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
    }
    visit(plan[0]!.Plan);
    for (const table of ["native_run_finalizations", "environment_leases"]) {
      expect(scans[table]?.length).toBeGreaterThan(0);
      expect(Math.max(...scans[table]!)).toBeLessThanOrEqual(1);
    }
    expect(await reconcile()).toEqual([agentId]);
  });

  it("retains unfinished instruction copyback", async () => {
    const { companyId, agentId, runId } = await seed();
    await db.insert(agentInstructionWorkingCopies).values({ companyId, agentId, runId,
      responsibleUserId: "test-user", entryFile: "AGENTS.md", baseHash: "test-hash",
      localRoot: "/tmp/test-root", executionRoot: "/tmp/test-root", location: "local",
      state: "captured", receipt: {}, processStoppedAt: old() });
    expect(await reconcile()).toEqual([]);
    await db.update(agentInstructionWorkingCopies).set({ state: "saved" })
      .where(eq(agentInstructionWorkingCopies.runId, runId));
    expect(await reconcile()).toEqual([agentId]);
  });

  it("retains native finalization ownership", async () => {
    const { companyId, runId, issueId } = await seed();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "workspace_finalizing" });
    expect(await reconcile()).toEqual([]);
  });

  it("does not read another company's run as the agent's outcome", async () => {
    const own = await seed();
    const other = await seed("failed");
    await db.update(heartbeatRuns).set({ agentId: own.agentId }).where(eq(heartbeatRuns.id, other.runId));
    expect(await reconcile()).toContain(own.agentId);
    expect((await agent(own.agentId)).status).toBe("idle");
  });

  it("bounds each recovery pass and leaves the next batch eligible", async () => {
    for (let i = 0; i < 27; i++) await seed();
    expect(await reconcile()).toHaveLength(25);
    expect(await reconcile()).toHaveLength(2);
  });

  it("rolls the correction back when the audit write fails", async () => {
    const { agentId } = await seed();
    await db.execute(sql`ALTER TABLE activity_log ADD CONSTRAINT reject_status_repair CHECK (action <> 'agent.status_reconciled')`);
    try {
      await expect(reconcile()).rejects.toThrow();
      expect((await agent(agentId)).status).toBe("running");
    } finally {
      await db.execute(sql`ALTER TABLE activity_log DROP CONSTRAINT reject_status_repair`);
    }
    expect(await reconcile()).toEqual([agentId]);
  });

  it("rechecks admission that commits after candidate selection", async () => {
    const { companyId, agentId } = await seed();
    let transactions = 0;
    const raced = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<Db["transaction"]>[0]) => {
          if (++transactions === 2) await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "queued" });
          return db.transaction(callback);
        };
      },
    });
    expect(await createHeartbeatAgentStatus(raced).reconcileStrandedAgentStatuses(() => live)).toEqual([]);
    expect((await agent(agentId)).status).toBe("running");
  });

  it("skips a concurrent status writer and preserves its pause", async () => {
    const { agentId } = await seed();
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pause = db.transaction(async tx => {
      await tx.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      locked();
      await gate;
    });
    await acquired;
    try { expect(await reconcile()).toEqual([]); }
    finally { release(); await pause; }
    expect((await agent(agentId)).status).toBe("paused");
  });

  it("does not overwrite a new run while finalization waits for the agent row", async () => {
    const { companyId, agentId } = await seed();
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatch = db.transaction(async tx => {
      await tx.update(agents).set({ status: "running" }).where(eq(agents.id, agentId));
      locked();
      await gate;
      await tx.insert(heartbeatRuns).values({ companyId, agentId,
        invocationSource: "on_demand", status: "running" });
    });
    await acquired;
    const completion = service.finalizeAgentStatus(agentId, "succeeded");
    try {
      const deadline = Date.now() + 5_000;
      while (true) {
        const result = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%agents%'
        ) AS blocked`);
        if (result[0]?.blocked) break;
        if (Date.now() > deadline) throw new Error("Finalization did not wait on the dispatch lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      release();
      await dispatch;
      await completion;
    }
    expect((await agent(agentId)).status).toBe("running");
  });

  it.each(["succeeded", "interrupted", "cancelled", "failed", "timed_out"] as const)("keeps completion semantics for %s", async outcome => {
    const { agentId } = await seed(outcome);
    await service.finalizeAgentStatus(agentId, outcome, "Failure detail");
    expect(await agent(agentId)).toMatchObject({
      status: ["failed", "timed_out"].includes(outcome) ? "error" : "idle",
      errorReason: ["failed", "timed_out"].includes(outcome) ? "Failure detail" : null,
      lastHeartbeatAt: expect.any(Date),
    });
  });

  it("keeps failures idle when the caller owns a continuation", async () => {
    const { agentId } = await seed("failed");
    await service.finalizeAgentStatus(agentId, "failed", "Retrying", { keepIdleOnFailure: true });
    expect(await agent(agentId)).toMatchObject({ status: "idle", errorReason: null });
  });
});
