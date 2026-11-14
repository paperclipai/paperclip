import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, environmentLeases, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readSystemRecovery } from "./system-recovery-state.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { heartbeatService } from "./heartbeat.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { assignedWorkSweep, ASSIGNED_WORK_CONTINUED_ACTION } from "./recovery/assigned-work-sweep.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { legacyReconciliationRunFields, terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { action, connectionString, db, failedRemotePreparation, run, useWorkspaceRecoveryFixture, withheldPreparationRetry } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/**
 * Staging, 2026-11-13: a legacy run on Daytona failed in setup and
 * its files were held for saved-work recovery. The sandbox was gone, so the
 * recovery ended `source_unavailable` (use another strategy). The task then
 * offered Retry, and Retry worked: it continued in a fresh workspace. But
 * nothing continued it automatically. For 2 hours the assigned-work sweep
 * logged `retry_offered` / `not_started` every 15 minutes, because the hold
 * refused its wake. A person had to press Retry.
 */
describe("a legacy run whose saved files are gone", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function sourceGone(withheldRetry = true) {
    const f = await failedRemotePreparation();
    // The staging run was itself a person's Retry, so it is not an automatic
    // recovery run, and the failure (setup_failed) is not a restart.
    const source = await run(f.runId);
    const finishedAt = new Date(Date.now() - 45 * 60_000);
    await db.update(heartbeatRuns).set({ finishedAt, startedAt: new Date(finishedAt.getTime() - 10 * 60_000),
      createdAt: new Date(finishedAt.getTime() - 11 * 60_000),
      contextSnapshot: { ...source.contextSnapshot, wakeReason: "task_retry" } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress", statusVersion: 3 }).where(eq(issues.id, f.issueId));
    // The provider destroyed the sandbox: its files can never be read again.
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: f.providerLeaseId, state: "destroyed" }) } })
      .where(eq(environmentLeases.id, f.lease.id));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted",
      failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" } });
    // The hold withheld the scheduled retry that came after it.
    if (!withheldRetry) return f;
    const withheld = await withheldPreparationRetry(f);
    await db.update(heartbeatRuns).set({ createdAt: new Date(finishedAt.getTime() + 60_000),
      finishedAt: new Date(finishedAt.getTime() + 2 * 60_000) }).where(eq(heartbeatRuns.id, withheld.id));
    return f;
  }

  /** What the stranded-work sweep does on every pass for this failed run. */
  async function strandedPass(runId: string) {
    const [source] = await db.select(legacyReconciliationRunFields).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({ db, run: source, status: source.status, fromStatuses: [source.status] });
  }

  it("continues the task in a fresh workspace without a person's Retry", async () => {
    const f = await sourceGone();
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
    const heartbeat = heartbeatService(db);
    const sweep = assignedWorkSweep(db, { enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts) });
    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    // The sweep's wake becomes the fresh continuation (the same path Retry
    // takes), instead of a wake the hold refuses.
    expect(check).toMatchObject({ verdict: { reason: "retry_offered" }, outcome: "repaired" });
    // The stranded sweep revisiting the failed run keeps the recorded continuation.
    await strandedPass(f.runId);
    expect((await action(f.actionId)).evidence).toMatchObject({ continuationDelivery: "pending",
      freshContinuation: { sourceRunId: f.runId }, executionReconciliation: { runId: f.runId } });
    // The continuation worker starts the recorded continuation.
    await deliverReconciledExecutions(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    // A run continues the task, in a workspace that is not the lost sandbox.
    await vi.waitFor(async () => {
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`,
        sql`${heartbeatRuns.errorCode} is distinct from 'execution_reconciliation_required'`));
      expect(successor).toBeDefined();
    }, { timeout: 10_000, interval: 200 });
    // The task no longer asks a person to press Retry.
    expect((await taskInterruptionPresentation(db, issue))?.canRetry ?? false).toBe(false);
    const refused = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION), sql`${activityLog.details}->>'outcome' = 'not_started'`));
    expect(refused).toHaveLength(0);
    expect((await run(f.runId)).status).toBe("failed");
  }, 90_000);

  it("leaves the hold as it is when the stranded sweep revisits the failed run", async () => {
    const f = await sourceGone();
    const before = await action(f.actionId);
    await strandedPass(f.runId);
    await strandedPass(f.runId);
    const after = await action(f.actionId);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.updatedAt).toEqual(before.updatedAt);
    // A changed decision is still recorded: a hold that lost it gets it back.
    await db.update(issueRecoveryActions).set({ evidence: { ...before.evidence, automaticRecovery: undefined } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await strandedPass(f.runId);
    expect((await action(f.actionId)).evidence).toMatchObject({ automaticRecovery: { runId: f.runId, replay: "blocked" } });
  }, 90_000);

  it("counts the continuation as started when its worker delivers it before the sweep looks", async () => {
    // No withheld retry: the sweep's own wake reaches the fallback in admission.
    const f = await sourceGone(false);
    const heartbeat = heartbeatService(db);
    // The continuation worker delivers the run between admission and the sweep's read.
    const sweep = assignedWorkSweep(db, { enqueueWakeup: async (agentId, opts) => {
      const run = await heartbeat.wakeup(agentId, opts);
      await deliverReconciledExecutions(db, (id, wake) => heartbeat.wakeup(id, wake));
      return run;
    } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId })).toMatchObject({ outcome: "repaired" });
    expect((await action(f.actionId)).evidence).toMatchObject({ continuationDelivery: "delivered" });
    const refused = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION), sql`${activityLog.details}->>'outcome' = 'not_started'`));
    expect(refused).toHaveLength(0);
  }, 90_000);
});
