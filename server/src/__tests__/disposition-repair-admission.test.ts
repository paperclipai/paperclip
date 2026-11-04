import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("disposition repair admission", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("disposition-admission-");
    db = createDb(temporary.connectionString);
  }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it.each(["sweep", "direct"])("reuses an unspent cancelled repair across rejected %s checks and later admission", async entry => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission fixture", issuePrefix: `A${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Implement export", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, legacyDispositionEpisode: { id: runId, attempt: 0, maxAttempts: 2 } } });
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    for (let check = 0; check < 6; check += 1) {
      const recovery = recoveryService(db, { enqueueWakeup: async () => null });
      if (entry === "sweep") await recovery.reconcileStrandedAssignedIssues();
      else await recovery.reconcileLegacyContinuation(runId);
    }
    const rejected = await actions();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: "cancelled", outcome: "cancelled", attemptCount: 0 });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    const admitted = recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    await admitted.reconcileLegacyContinuation(runId);
    expect(await actions()).toMatchObject([{ id: rejected[0].id, status: "active", outcome: null, attemptCount: 1, resolvedAt: null, resolutionNote: null }]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(2);
    const successor = runs.find(run => run.id !== runId)!;
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.runId, successor.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), contextSnapshot: {
      issueId, legacyDispositionEpisode: { id: successor.id, attempt: 0, maxAttempts: 2 },
    } }).where(eq(heartbeatRuns.id, successor.id));
    for (let check = 0; check < 3; check += 1) {
      await recoveryService(db, { enqueueWakeup: async () => null }).reconcileLegacyContinuation(successor.id);
    }
    const changed = await actions();
    expect(changed).toHaveLength(2);
    expect(changed.find(action => action.id !== rejected[0].id)).toMatchObject({ status: "cancelled", attemptCount: 0 });
    expect(new Set(changed.map(action => action.fingerprint)).size).toBe(2);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
  });
});
