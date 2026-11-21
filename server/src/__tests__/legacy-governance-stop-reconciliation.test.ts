import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environments, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy governance pause stop reconciliation", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("legacy-governance-stop-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  const lifecycleStop = (reason: string) => ({
    stopReason: "cancelled",
    cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
      reason, recordedAt: "2026-11-14T19:56:00.000Z" },
  });

  async function seed(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Governance stop", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Queued work", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, issueId, status: "queued", runtimeMode: "legacy",
      contextSnapshot: { issueId }, ...patch,
    }).returning();
    return { companyId, agentId, issueId, runId, run: run! };
  }

  const cancel = (fixture: Awaited<ReturnType<typeof seed>>, resultJson: Record<string, unknown>) =>
    terminalizeLegacyExecution({
      db, run: fixture.run, status: "cancelled", reconcileIfNeeded: true,
      patch: { errorCode: "cancelled", error: "Agent lifecycle stop requested", finishedAt: new Date(), resultJson },
    });

  const holds = (companyId: string, issueId: string) => db.select().from(issueRecoveryActions)
    .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));

  it.each(["Agent lifecycle stop requested", "Cancelled due to agent pause", "Cancelled due to budget pause"])(
    "records no reconciliation hold when %s stopped a run that never started", async (reason) => {
      const fixture = await seed();
      const cancelled = (await cancel(fixture, lifecycleStop(reason)))!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.startedAt).toBeNull();
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(false);
      expect(await holds(fixture.companyId, fixture.issueId)).toHaveLength(0);
    });

  it("still records the hold when the same stop reached a provider", async () => {
    const fixture = await seed({ startedAt: new Date("2026-11-14T19:55:00.000Z") });
    const cancelled = (await cancel(fixture, lifecycleStop("Agent lifecycle stop requested")))!;
    expect(cancelled.startedAt).not.toBeNull();
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(true);
    const recorded = await holds(fixture.companyId, fixture.issueId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.cause).toBe("legacy_execution_requires_reconciliation");
    expect(recorded[0]!.evidence.runId).toBe(fixture.runId);
  });

  it.each([
    { field: "processPid", value: 4913 },
    { field: "processGroupId", value: 4913 },
    { field: "processStartedAt", value: new Date("2026-11-14T19:55:00.000Z") },
    { field: "sessionIdAfter", value: "provider-session" },
    { field: "executionStage", value: "preparing" },
  ])("keeps the hold when retained execution evidence disagrees: $field", async ({ field, value }) => {
    const fixture = await seed({ [field]: value } as Partial<typeof heartbeatRuns.$inferInsert>);
    const cancelled = (await cancel(fixture, lifecycleStop("Agent lifecycle stop requested")))!;
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(true);
    expect(await holds(fixture.companyId, fixture.issueId)).toHaveLength(1);
  });

  it("keeps the hold when the run started a provider turn or retains an environment", async () => {
    const started = await seed();
    await db.insert(heartbeatRunEvents).values({ companyId: started.companyId, runId: started.runId,
      agentId: started.agentId, eventType: "adapter.invoke", stream: "system", level: "info", seq: 1,
      message: "adapter invoked", payload: { adapterType: "claude_local" } });
    const withEvent = (await cancel(started, lifecycleStop("Agent lifecycle stop requested")))!;
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, withEvent)).toBe(true);
    expect(await holds(started.companyId, started.issueId)).toHaveLength(1);

    const leased = await seed();
    const [environment] = await db.insert(environments).values({ name: `Sandbox ${leased.runId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId: leased.companyId, issueId: leased.issueId,
      heartbeatRunId: leased.runId, environmentId: environment!.id, status: "active", provider: "daytona",
      providerLeaseId: randomUUID() });
    const withLease = (await cancel(leased, lifecycleStop("Agent lifecycle stop requested")))!;
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, withLease)).toBe(true);
    expect(await holds(leased.companyId, leased.issueId)).toHaveLength(1);
  });

  it("keeps the hold for a cancellation that is not a governance pause stop", async () => {
    const fixture = await seed();
    const cancelled = (await cancel(fixture, {
      stopReason: "cancelled",
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
        reason: "Cancelled by control plane", recordedAt: "2026-11-14T19:56:00.000Z" },
    }))!;
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(true);
    expect(await holds(fixture.companyId, fixture.issueId)).toHaveLength(1);
  });
});
