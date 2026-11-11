import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, createDb, issueRecoveryActions, nativeRunFinalizations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { nativeWorkspaceFinalizationLockKey } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { reconcileRetainedWorkspaces, retainedWorkspaceCandidates, type PassiveSweep } from "./workspace-recovery.js";
import { acceptedRemoteExport, action, connectionString, db, run, seed, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./execution-control-deadline.js", async importOriginal => ({
  ...await importOriginal<typeof import("./execution-control-deadline.js")>(), EXECUTION_RECONCILIATION_INTERVAL_MS: 200 }));
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/**
 * Staging (Nov 11): 36 minutes after #20680 shipped, the
 * worker had still re-armed none of the company's 29 exhausted holds, not even
 * one whose id sorts in the first percent. It did run manual Retries, which
 * its unfinished lane selects. Discovery is instance-wide: unfinished work
 * had strict priority over every obligation, and the obligation pass mixed due
 * holds with hundreds of settled holds whose saved user input waits, two per
 * run. Either kind of load kept the due holds from being reached.
 */
describe("the workspace recovery worker reaches every due hold whatever its other load", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** An export hold of Nov 4, exhausted waiting for stop proof: the exact evidence that release saved. */
  async function stopProofHold(id: string) {
    const f = await acceptedRemoteExport("retained");
    const firstFailureAt = Date.parse("2026-11-04T23:58:14Z");
    await db.update(issueRecoveryActions).set({ id, ownerType: "system", evidence: { ...(await action(f.actionId)).evidence,
      systemRecovery: { ...readSystemRecovery((await action(f.actionId)).evidence)!, revision: 3, phase: "verify_execution", state: "exhausted",
        attempts: 1, retriesUsed: 0, attemptId: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "9615".repeat(16) } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
        attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] } } }).where(eq(issueRecoveryActions.id, f.actionId));
    return { ...f, actionId: id };
  }

  /** A board-owned save of Nov 10, exhausted after 6 attempts under capture policy 1 (no version saved). */
  async function capturePolicyHold(id: string) {
    const f = await acceptedRemoteExport("retained");
    const prior = await action(f.actionId);
    const { capturePolicyVersion: _omitted, ...saved } = readSystemRecovery(prior.evidence)! as ReturnType<typeof readSystemRecovery> & { capturePolicyVersion?: number };
    const firstFailureAt = Date.parse("2026-11-10T13:58:11Z");
    await db.update(issueRecoveryActions).set({ id, ownerType: "board", evidence: { ...prior.evidence,
      systemRecovery: { ...saved, revision: 18, phase: "preserve_files", state: "exhausted", attempts: 6, retriesUsed: 5,
        attemptId: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "9483".repeat(16),
          cause: { code: null, label: "provider_error", status: null } } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "restoring_files",
        attempt: 6, attemptLimit: 6, retryable: true, requestIds: [] } } }).where(eq(issueRecoveryActions.id, f.actionId));
    return { ...f, actionId: id };
  }

  /** A settled no-replay hold (active or resolved-but-blocked) whose task has saved user input waiting: selectable on every pass. */
  async function waitingSettledHold(id: string, status: "active" | "resolved") {
    const f = await seed("native", true);
    await adoptSystemRecovery(db, f);
    const prior = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ id, status, outcome: status === "resolved" ? "blocked" : null, ownerType: "system",
      evidence: { ...prior.evidence,
        systemRecovery: { ...readSystemRecovery(prior.evidence)!, state: "complete", phase: "reconcile_effects", attempts: 1 },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "recovered", stage: "saving_receipts",
          attempt: 1, attemptLimit: 6, retryable: false, requestIds: [] },
        automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked" } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: (await run(f.runId)).agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId } });
    return f;
  }

  const rearmed = async (id: string) => {
    const evidence = (await action(id)).evidence;
    return Boolean(evidence.stopProofRecovery || evidence.capturePolicyRecovery);
  };

  it("re-arms both staging holds while a save that another server owns stays unfinished", async () => {
    // A scheduled save whose run another server is finalizing: every attempt
    // here finds the run's finalization lock busy and leaves it scheduled.
    const busy = await seed("native", true);
    await adoptSystemRecovery(db, busy);
    expect(readSystemRecovery((await action(busy.actionId)).evidence)?.state).toBe("scheduled");
    const owner = createDb(connectionString);
    await owner.execute(sql`select pg_advisory_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(busy.companyId, busy.runId)}, 0))`);
    const capture = await capturePolicyHold(randomUUID());
    const stop = await stopProofHold(randomUUID());
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, stop.environmentRuntime, async () => undefined);
    try {
      await worker.ready;
      await vi.waitFor(async () => {
        expect(await rearmed(capture.actionId)).toBe(true);
        expect(await rearmed(stop.actionId)).toBe(true);
      }, { timeout: 20_000, interval: 250 });
      // The busy save is still retried; it is not dropped to make room.
      expect(readSystemRecovery((await action(busy.actionId)).evidence)?.state).toBe("scheduled");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
      await coordinator.stop();
      await owner.$client.end();
    }
  }, 90_000);

  it("re-arms the holds with one free slot while a long local job holds the other and a busy save stays unfinished", async () => {
    // A local job holds one of the two slots for the whole test.
    const long = await waitingSettledHold(randomUUID(), "resolved");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const onRecovered = async (source: { id: string }) => { if (source.id === long.runId) await held; };
    const sweep: PassiveSweep = {};
    const first = reconcileRetainedWorkspaces(db, long.environmentRuntime, onRecovered, true, undefined, sweep);
    const holding = await first ?? [];
    expect(holding).toHaveLength(1);

    const busy = await seed("native", true);
    await adoptSystemRecovery(db, busy);
    const owner = createDb(connectionString);
    await owner.execute(sql`select pg_advisory_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(busy.companyId, busy.runId)}, 0))`);
    const capture = await capturePolicyHold(randomUUID());
    const stop = await stopProofHold(randomUUID());
    try {
      // One free slot per run: each lane has priority in one run of three.
      for (let pass = 0; pass < 6; pass += 1)
        await Promise.all(await reconcileRetainedWorkspaces(db, stop.environmentRuntime, onRecovered, true, undefined, sweep) ?? []);
      expect(await rearmed(capture.actionId)).toBe(true);
      expect(await rearmed(stop.actionId)).toBe(true);
      expect(readSystemRecovery((await action(busy.actionId)).evidence)?.state).toBe("scheduled");
    } finally {
      release();
      await Promise.all(holding);
      await owner.$client.end();
    }
  }, 90_000);

  it("reaches due holds within two runs however many settled holds with waiting input sort before them", async () => {
    for (let index = 1; index <= 10; index += 1)
      await waitingSettledHold(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, index % 3 ? "resolved" : "active");
    const capture = await capturePolicyHold("fffffffe-0000-4000-8000-000000000000");
    const stop = await stopProofHold("ffffffff-0000-4000-8000-000000000000");
    const passive = (await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id);
    expect(passive.slice(0, 5).every(id => id.startsWith("00000000-"))).toBe(true);

    const sweep: PassiveSweep = {};
    for (let pass = 0; pass < 2; pass += 1)
      await Promise.all(await reconcileRetainedWorkspaces(db, stop.environmentRuntime, async () => undefined, true, undefined, sweep) ?? []);
    expect(await rearmed(capture.actionId)).toBe(true);
    expect(await rearmed(stop.actionId)).toBe(true);
    // The waiting input is still visited: the pass keeps advancing.
    expect(sweep.cursor).toMatch(/^00000000-/);
  }, 90_000);

  it("re-arms a hold that becomes due after its pass completed, with no committed change", async () => {
    const stop = await stopProofHold("00000000-0000-4000-8000-000000000001");
    await waitingSettledHold("ffffffff-0000-4000-8000-000000000000", "resolved");
    // The finished coordinator's owner holds a live lease: not due yet.
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-finalizer:${randomUUID()}`, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, stop.runId));
    const sweep: PassiveSweep = {};
    for (let pass = 0; pass < 3 && !sweep.complete; pass += 1)
      await Promise.all(await reconcileRetainedWorkspaces(db, stop.environmentRuntime, async () => undefined, true, undefined, sweep) ?? []);
    expect(sweep.complete).toBe(true);
    expect(await rearmed(stop.actionId)).toBe(false);

    // The lease lapses. Time alone makes the re-arm due: nothing commits.
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, stop.runId));
    await Promise.all(await reconcileRetainedWorkspaces(db, stop.environmentRuntime, async () => undefined, true, undefined, sweep) ?? []);
    expect(await rearmed(stop.actionId)).toBe(true);
  }, 90_000);
});
