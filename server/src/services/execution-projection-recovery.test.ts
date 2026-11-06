import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, completionContracts } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("persisted stopped-workspace projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stopped-workspace-projection");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("reads recovered files on a cancelled run through the real batched query", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped workspace", issuePrefix: "SWP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review current changes", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
      contextSnapshot: { issueId }, resultJson: { workspaceRestoreFailure: "restore_failed" } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${runId}`,
      ownerType: "system", status: "resolved", outcome: "blocked", resolvedAt: new Date(),
      nextAction: "The original sandbox is retained for workspace repair.",
      evidence: { runId, continuationDelivery: "invalidated",
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown", policy: "preserve_without_replay_v1" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "recovered",
          stage: "saving_receipts", attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
      } });
    const projections = await executionProjectionsForRuns(db, companyId, [runId]);
    expect(projections.get(runId)).toMatchObject({ phase: "recovery_needed", label: "Stopped",
      nextAction: "Saved work recovered. Send a message to continue.", permittedActions: ["inspect_run"] });
  });
  it("advertises Stop for a failed native retry from the real batched coordinator read", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pending native retry", issuePrefix: "PNR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pending retry", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", resultId: null });
    const projections = await executionProjectionsForRuns(db, companyId, [runId]);
    expect(projections.get(runId)).toMatchObject({ canStop: true });
    await db.update(heartbeatRuns).set({ driverKind: "grok_bot_mcp" }).where(eq(heartbeatRuns.id, runId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
    await db.update(heartbeatRuns).set({ driverKind: "codex_app_server" }).where(eq(heartbeatRuns.id, runId));
    for (const status of ["succeeded", "cancelled", "timed_out"] as const) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, runId));
      expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
    }
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, runId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    for (const phase of ["observed", "terminal_failure", "committed"] as const) {
      await db.update(nativeRunFinalizations).set({ phase }).where(eq(nativeRunFinalizations.runId, runId));
      expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
    }
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" }).where(eq(nativeRunFinalizations.runId, runId));
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low", completionAuthority: "server",
      incompleteCriteriaPolicy: "deny", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "agent", createdByActorId: agentId }).returning();
    await db.update(heartbeatRuns).set({ completionContractId: contract.id }).where(eq(heartbeatRuns.id, runId));
    const [accepted] = await db.insert(nativeRunResults).values({ companyId, issueId, runId, completionContractId: contract.id,
      schemaStatus: "accepted", serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), resultJson: { summary: "Accepted result" } }).returning();
    await db.update(nativeRunFinalizations).set({ resultId: accepted.id }).where(eq(nativeRunFinalizations.runId, runId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
    expect((await executionProjectionsForRuns(db, randomUUID(), [runId])).has(runId)).toBe(false);
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.canStop).toBe(false);
  });

  it("names the wait when a stopped predecessor still holds the task's runner", async () => {
    // Staging: a hung native run was stopped by the board, then a resume
    // comment queued a successor. The stopped run's controller still held its
    // execution lease, so the successor sat "Queued" with no reason.
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const stoppedRunId = randomUUID(), successorRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped predecessor", issuePrefix: "SPR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long foreground tool", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: stoppedRunId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: stoppedRunId, phase: "observed",
      leaseOwner: "controller-a", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId,
      runtimeMode: "native", status: "queued", contextSnapshot: { issueId } });
    expect((await executionProjectionsForRuns(db, companyId, [successorRunId])).get(successorRunId)).toMatchObject({
      phase: "queued", label: "Waiting for previous run to stop", cause: "previous_run_settling", canStop: true,
    });
    // An expired lease still owned by a controller still holds admission.
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(nativeRunFinalizations.runId, stoppedRunId));
    expect((await executionProjectionsForRuns(db, companyId, [successorRunId])).get(successorRunId)?.cause)
      .toBe("previous_run_settling");
    // Once the controller releases its claim, the wait is ordinary.
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, stoppedRunId));
    expect((await executionProjectionsForRuns(db, companyId, [successorRunId])).get(successorRunId)).toMatchObject({
      phase: "queued", label: "Queued", cause: null,
    });
    // Another agent's held run on the same task is not this turn's predecessor.
    const otherAgentId = randomUUID(), otherRunId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId: otherAgentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: otherRunId, phase: "observed",
      leaseOwner: "controller-b", leaseExpiresAt: new Date(Date.now() + 60_000) });
    expect((await executionProjectionsForRuns(db, companyId, [successorRunId])).get(successorRunId)?.cause).toBeNull();
  });
});
