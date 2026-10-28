import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, environmentLeases, environments,
  heartbeatRuns, issueRecoveryActions, issues, workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { inspectWorkspaceRecoverySource } from "./workspace-recovery-source.js";
import { createSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { inspectWorkspaceSource } from "./workspace-source-inspection.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("workspace source verification diagnostics", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) {
      await applyPendingMigrations(external);
      temporary = { connectionString: external, cleanup: async () => {} };
    } else temporary = await startEmbeddedPostgresTestDatabase("source-verification-");
    db = createDb(temporary.connectionString);
    if (external) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Source verification", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve the source", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date() });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "retain_on_failure",
      status: "released", cleanupStatus: "success", metadata: { remoteCwd: "/workspace", token: "secret-must-not-appear" } }).returning();
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", leaseId: lease.id,
      providerLeaseId: lease.providerLeaseId, workspaceId: issueId, remoteCwd: "/workspace", resourceDisposition: "keep_running",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: reference } }).where(eq(heartbeatRuns.id, runId));
    const systemRecovery = failSystemRecovery(createSystemRecovery(runId, randomUUID()),
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "native_workspace_sync_out_retry_exhausted", fingerprint: runId,
      nextAction: "Inspect the retained source", evidence: { runId, systemRecovery,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "blocked",
          stage: "verifying_stop", attempt: 1, attemptLimit: 6, requestIds: [] } } });
    return { db, companyId, issueId, runId, actionId, agentId, environment, lease, reference };
  }

  function app(actor: express.Request["actor"] = { type: "board", source: "local_implicit" }) {
    const result = express();
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    result.use(errorHandler);
    return result;
  }

  function path(f: Awaited<ReturnType<typeof seed>>, actionId: string = f.actionId, runId: string = f.runId) {
    return `/api/issues/${f.issueId}/recovery-actions?inspectSourceRunId=${runId}&inspectSourceActionId=${actionId}`;
  }

  async function snapshot(f: Awaited<ReturnType<typeof seed>>) {
    return {
      actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
      leases: await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
      wakeups: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      operations: await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, f.companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)),
    };
  }

  it.each(["lease_policy_not_retained", "source_lease_not_bound"])("identifies the rejected contract: %s", async reason => {
    const f = await seed();
    if (reason === "lease_policy_not_retained") {
      await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    } else {
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, status: "running" });
      await db.update(environmentLeases).set({ heartbeatRunId: otherRunId }).where(eq(environmentLeases.id, f.lease.id));
    }
    await expect(inspectWorkspaceRecoverySource(db, f)).rejects.toMatchObject({
      code: "source_binding_invalid", retryClass: "service_required", sourceVerification: { reason },
    });
  });

  it("inspects a resolved retained source through HTTP without revalidating or changing recorded recovery", async () => {
    const f = await seed();
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", evidence: {
      ...(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence,
      automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: f.runId },
    } }).where(eq(issueRecoveryActions.id, f.actionId));
    const before = await snapshot(f);
    const response = await request(app()).get(path(f)).expect(200);
    expect(response.body.active).toBeNull();
    expect(response.body.actions[0]).toMatchObject({ id: f.actionId, status: "resolved", evidence: {
      systemRecovery: { state: "exhausted", failure: { code: "source_binding_invalid" } },
    } });
    expect(response.body.sourceInspection).toMatchObject({ actionId: f.actionId, runId: f.runId,
      scope: "recorded_source_identity", status: "blocked", failureCode: "source_binding_invalid",
      sourceVerification: { reason: "lease_policy_not_retained", observedLeasePolicy: "reuse_by_environment" } });
    expect(response.body.actions[0].evidence.systemRecovery.failure.sourceVerification).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("secret-must-not-appear");
    expect(JSON.stringify(response.body)).not.toContain("/workspace");
    expect(JSON.stringify(response.body)).not.toContain(f.lease.providerLeaseId);
    expect(await snapshot(f)).toEqual(before);
  });

  it("only verifies current recorded identity for a valid retained source", async () => {
    const f = await seed();
    const before = await snapshot(f);
    const response = await request(app()).get(path(f)).expect(200);
    expect(response.body.sourceInspection).toEqual({ schema: "paperclip.workspace-source-inspection.v1",
      actionId: f.actionId, runId: f.runId, scope: "recorded_source_identity", status: "verified",
      observedAt: expect.any(String) });
    expect(await snapshot(f)).toEqual(before);
  });

  it("keeps a reused physical allocation blocked without touching either lease", async () => {
    const f = await seed();
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
      provider: "daytona", providerLeaseId: f.lease.providerLeaseId, leasePolicy: "reuse_by_environment", status: "active" });
    const before = await snapshot(f);
    const response = await request(app()).get(path(f)).expect(200);
    expect(response.body.sourceInspection).toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
    expect(response.body.sourceInspection.sourceVerification).toBeUndefined();
    expect(await snapshot(f)).toEqual(before);
  });

  it("rejects a foreign action, mismatched run, and malformed selection without inspection", async () => {
    const f = await seed(), foreign = await seed();
    const before = await snapshot(f);
    await request(app()).get(path(f, foreign.actionId)).expect(404);
    await request(app()).get(path(f, f.actionId, foreign.runId)).expect(404);
    await request(app()).get(path(f, "not-a-uuid")).expect(400);
    expect(await snapshot(f)).toEqual(before);
  });

  it("does not let another company's agent inspect the source", async () => {
    const f = await seed(), foreign = await seed();
    const response = await request(app({ type: "agent", agentId: foreign.agentId, companyId: foreign.companyId,
      source: "agent_key" })).get(path(f));
    expect([403, 404]).toContain(response.status);
    expect(response.body.sourceInspection).toBeUndefined();
  });

  it("lists only the explicitly requested run without inspecting it", async () => {
    const f = await seed();
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    const response = await request(app()).get(`/api/issues/${f.issueId}/recovery-actions?inspectSourceRunId=${f.runId}`).expect(200);
    expect(response.body.actions.map((action: { id: string }) => action.id)).toEqual([f.actionId]);
    expect(response.body.sourceInspection).toBeUndefined();
  });

  it("bounds explicit inspection before lease lookup without changing worker verification", async () => {
    const f = await seed();
    const leaseIds = [f.lease.id];
    for (let index = 0; index < 8; index++) {
      const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.runId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: randomUUID(),
        leasePolicy: "retain_on_failure", status: "released", metadata: { remoteCwd: "/workspace" } }).returning();
      leaseIds.push(lease.id);
    }
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreRecovery: {
      schema: "paperclip.workspace-restore-recovery.v1", leaseIds } } }).where(eq(heartbeatRuns.id, f.runId));
    const before = await snapshot(f);
    const select = vi.spyOn(db, "select");
    try {
      expect(await inspectWorkspaceSource(db, f)).toMatchObject({ status: "not_inspected", reason: "source_limit" });
      expect(select).toHaveBeenCalledTimes(2);
    } finally { select.mockRestore(); }
    expect((await inspectWorkspaceRecoverySource(db, f)).sources).toHaveLength(9);
    expect(await snapshot(f)).toEqual(before);
  });
});
