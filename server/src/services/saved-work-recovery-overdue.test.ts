import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerIssueRecoveryWork } from "./recovery/work.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readSystemRecovery } from "./system-recovery-state.js";
import { startOverdueWorkspaceRecovery } from "./workspace-recovery.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { assignedWorkSweep, ASSIGNED_WORK_CONTINUED_ACTION } from "./recovery/assigned-work-sweep.js";
import { SAVED_WORK_RECOVERY_START_BOUND_MS } from "./recovery/assigned-work-invariant.js";
import { action, connectionString, db, failedRemotePreparation, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/**
 * Staging, 2026-11-13: a legacy retry failed in setup when saving
 * its sandbox workspace timed out (`setup_failed`, "capture (configured
 * timeout 300000ms)"). Its files were held for a saved-work recovery
 * (`legacy_execution_requires_reconciliation`, resolved, replay blocked) that
 * the recovery queue still had at 0 attempts 45 minutes later; 29 such
 * recoveries waited on the instance, one since 15:01Z. The task said
 * "Recovering saved work…" while the assigned-work sweep logged
 * `no_pending_path` and a continuation the hold refused, every few minutes.
 */
describe("a saved-work recovery the queue has not reached", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function stagingShape(stoppedAgoMs: number, clock: { now?: () => Date } = {}) {
    const f = await failedRemotePreparation();
    const finishedAt = new Date(Date.now() - stoppedAgoMs);
    await db.update(heartbeatRuns).set({ finishedAt, startedAt: new Date(finishedAt.getTime() - 10 * 60_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress", statusVersion: 3 }).where(eq(issues.id, f.issueId));
    // The hold the staging task had: adopted by the system, never attempted.
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "scheduled", attempts: 0 });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const onRecovered = vi.fn(async () => undefined);
    // Staging's admission parked every continuation behind the hold.
    const enqueueWakeup = vi.fn(async () => null);
    const sweep = assignedWorkSweep(db, { enqueueWakeup, ...clock,
      startSavedWorkRecovery: source => startOverdueWorkspaceRecovery(db, f.environmentRuntime, onRecovered, source) });
    return { ...f, sweep, enqueueWakeup, onRecovered };
  }

  const continuationEntries = async (issueId: string) => db.select().from(activityLog).where(and(
    eq(activityLog.entityId, issueId), eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));

  it("starts the recovery itself once it is overdue, and the task's files are recovered", async () => {
    const f = await stagingShape(45 * 60_000);
    const check = await f.sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    expect(check).toMatchObject({ verdict: { kind: "violation", reason: "saved_work_recovery_overdue" },
      outcome: "started_saved_work_recovery" });
    // No wake that the hold would refuse, and no "could not start" entry.
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await continuationEntries(f.issueId)).toHaveLength(0);
    await vi.waitFor(async () => {
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 20_000, interval: 100 });
    // The recovery's completion hands the run to the normal continuation path.
    await vi.waitFor(() => expect(f.onRecovered).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const [recovered] = f.onRecovered.mock.calls[0] as unknown as [{ id: string }];
    expect(recovered.id).toBe(f.runId);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.workspaceRecovery?.status).toBe("recovered");
    // With the files recovered the task continues: the next check admits an
    // ordinary continuation through the real wake path.
    const heartbeat = heartbeatService(db);
    const continued = assignedWorkSweep(db, { enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts) });
    // The hold now lets a continuation through: the sweep records a fresh
    // continuation from the recovered files, and the continuation worker
    // starts its run.
    await continued.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    expect(await continued.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ verdict: { kind: "ok", clause: "pending_intent" } });
    await deliverReconciledExecutions(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    expect(successor).toBeDefined();
  }, 90_000);

  it("counts a recovery the queue has time to start as the task's pending path, and looks again when its bound ends", async () => {
    let clock = Date.now();
    const f = await stagingShape(2 * 60_000, { now: () => new Date(clock) });
    const stoppedAt = (await db.select({ finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId)))[0].finishedAt!.getTime();
    const deadlines: number[] = [];
    expect(await f.sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId, onDeferredDeadline: at => deadlines.push(at) }))
      .toMatchObject({ verdict: { kind: "ok", clause: "pending_intent", intent: "saved_work_recovery" }, outcome: "ok" });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "scheduled", attempts: 0 });
    expect(await continuationEntries(f.issueId)).toHaveLength(0);
    // The worker keeps this deadline; nothing else needs to wake the task.
    expect(deadlines).toEqual([stoppedAt + SAVED_WORK_RECOVERY_START_BOUND_MS + 1_000]);
    clock = deadlines[0];
    expect(await f.sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ verdict: { reason: "saved_work_recovery_overdue" }, outcome: "started_saved_work_recovery" });
    await vi.waitFor(async () => {
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 20_000, interval: 100 });
  }, 60_000);

  it("never starts a second attempt beside one already running for the same run", async () => {
    const f = await stagingShape(SAVED_WORK_RECOVERY_START_BOUND_MS + 60_000);
    const source = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId };
    const first = await startOverdueWorkspaceRecovery(db, f.environmentRuntime, f.onRecovered, source);
    const second = await startOverdueWorkspaceRecovery(db, f.environmentRuntime, f.onRecovered, source);
    expect([first, second]).toEqual(["started", "in_flight"]);
    await vi.waitFor(async () => {
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    }, { timeout: 20_000, interval: 100 });
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.attempts).toBe(1);
    // A completed recovery is not selected again.
    await vi.waitFor(async () => {
      expect(await startOverdueWorkspaceRecovery(db, f.environmentRuntime, f.onRecovered, source)).toBe("not_eligible");
    }, { timeout: 10_000, interval: 100 });
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));
    expect(row.count).toBe(1);
  }, 60_000);

  it("reaches a blocked task with an active saved-work hold through the recovery worker", async () => {
    const f = await stagingShape(45 * 60_000);
    // The same hold, still active, on a task the recovery left blocked.
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(issues.id, f.issueId));
    expect((await f.sweep.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).toContain(f.issueId);
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError });
    const noop = async () => ({ enqueueFailed: 0, incomplete: 0 });
    const worker = registerIssueRecoveryWork(db, coordinator, { stranded: noop, orphanBlockers: noop, recoveryActions: noop,
      dependencies: noop, locks: noop, watchdogs: noop, schedulingSuppressed: async () => false,
      assignedWork: { listSuspects: f.sweep.listSuspects, checkIssue: f.sweep.checkIssue } }, () => true);
    try {
      await worker.ready;
      await vi.waitFor(async () => {
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      }, { timeout: 30_000, interval: 250 });
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
      await coordinator.stop();
    }
  }, 90_000);
});
