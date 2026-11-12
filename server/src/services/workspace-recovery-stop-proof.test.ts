import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { readRemoteWorkspaceWriterHold, remoteWorkspaceHoldRefusesStart } from "./remote-workspace-writer-hold.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { RETAINED_SOURCE_FALLBACK_OUTCOME } from "./workspace-recovery-fallback.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { reconcileRetainedWorkspaces, recoverRetainedWorkspace, retainedWorkspaceCandidates, type PassiveSweep } from "./workspace-recovery.js";
import { acceptedRemoteExport, action, connectionString, db, run, seed, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./execution-control-deadline.js", async importOriginal => ({
  ...await importOriginal<typeof import("./execution-control-deadline.js")>(), EXECUTION_RECONCILIATION_INTERVAL_MS: 200 }));
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

// Recovery text never asks a person to inspect or fix a sandbox.
const adminText = /sandbox|environment|administrator|board member|owner must|inspect the run/i;
const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;

describe("exhausted stop-proof holds", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * The staging shape (Nov 5): a parent task and three children that an older
   * release bound to the parent's remote workspace. One child's run wrote the
   * workspace, failed to save it, and its save recovery was exhausted after one
   * attempt with `agent_stop_unconfirmed`: the recovery window ran out while
   * the stop could not be proven yet. The run has since ended and its sandbox
   * has a provider stop receipt, so the agent is provably gone.
   */
  async function exhaustedStopProofHold() {
    const f = await acceptedRemoteExport("retained");
    const source = await run(f.runId);
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Landing page", status: "blocked",
      assigneeAgentId: source.agentId, executionWorkspaceId: f.workspaceId, executionWorkspacePreference: "reuse_existing" }).returning();
    await db.update(executionWorkspaces).set({ sourceIssueId: parent.id }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(issues).set({ parentId: parent.id, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, f.issueId));
    const siblings = await db.insert(issues).values(["Hero copy", "Pricing table"].map(title => ({ companyId: f.companyId, title,
      parentId: parent.id, status: "blocked" as const, assigneeAgentId: source.agentId, executionWorkspaceId: f.workspaceId,
      executionWorkspacePreference: "reuse_existing" }))).returning();
    const firstFailureAt = Date.now() - 5 * 86_400_000;
    // The writer went silent days ago, past the workspace holder cutoff.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(firstFailureAt - 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    const nextAction = "Automatic recovery of saved work stopped after 1 attempts (last failure: agent_stop_unconfirmed). "
      + "Retry to try again; the agent will not repeat its work.";
    const prior = await action(f.actionId);
    const current = readSystemRecovery(prior.evidence)!;
    // The exact evidence the Nov 5 release saved; no field this change adds.
    await db.update(issueRecoveryActions).set({ ownerType: "system", nextAction, evidence: { ...prior.evidence,
      systemRecovery: { ...current, revision: 3, phase: "verify_execution", state: "exhausted", attempts: 1, retriesUsed: 0,
        attemptId: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "d".repeat(64) } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
        attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
      coordinatorAttempt: 1, originalFailureCode: "native_workspace_sync_out_failed", workspaceFinalizeAttempt: 3 } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    return { ...f, parentIssueId: parent.id, siblingIssueIds: siblings.map(row => row.id) };
  }

  async function parentHold(f: { companyId: string; workspaceId: string }) {
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    return readRemoteWorkspaceWriterHold(db as never, { companyId: f.companyId, authority, runId: randomUUID() });
  }

  it("re-proves the stop, saves the files and frees the shared workspace without a person", async () => {
    const f = await exhaustedStopProofHold();
    // The hold refuses every other task on the shared workspace, the parent included.
    expect(remoteWorkspaceHoldRefusesStart(await parentHold(f))).toBe(true);

    // The recovery worker discovers it and wakes for it.
    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    const ids = (await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id);
    expect(ids).toContain(f.actionId);
    const onRecovered = vi.fn(async () => undefined);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true) ?? []);

    const settled = await action(f.actionId);
    expect(readSystemRecovery(settled.evidence)).toMatchObject({ state: "complete" });
    expect(readSystemRecovery(settled.evidence)!.preservationOperationIds.length).toBeGreaterThan(0);
    expect(readWorkspaceRecovery(settled.evidence)?.status).toBe("recovered");
    expect(settled.evidence.stopProofRecovery).toMatchObject({ schema: "paperclip.stop-proof-recovery.v1", rearms: 1 });
    expect(settled.ownerType).toBe("system");
    expect(String(settled.nextAction)).not.toMatch(adminText);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    // The child's files are saved into the workspace it wrote; the hold is gone.
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    expect(authority).toMatchObject({ dirty: false });
    expect(authority.snapshotId).not.toBeNull();
    expect(await parentHold(f)).toEqual({ kind: "free" });
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");

    const [rearmed] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.workspace_recovery_rearmed"));
    expect(rearmed).toMatchObject({ actorType: "system", entityId: f.issueId, runId: f.runId });
  }, 60_000);

  it("keeps the hold while the source run's controller still holds its lease", async () => {
    const f = await exhaustedStopProofHold();
    const expiresAt = Date.now() + 60 * 60_000;
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(expiresAt) }).where(eq(heartbeatRuns.id, f.runId));

    // The worker is not woken until the lease can expire, and does not select the hold before that.
    expect(await nextWorkspaceRecoveryAt(db)).toBeGreaterThanOrEqual(expiresAt - 1_000);
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    await recoverRetainedWorkspace(f.input);

    const held = await action(f.actionId);
    expect(readSystemRecovery(held.evidence)).toMatchObject({ state: "exhausted", failure: { code: "agent_stop_unconfirmed" } });
    expect(held.evidence.stopProofRecovery).toBeUndefined();
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
  }, 60_000);

  it("waits for the next re-arm on its backoff", async () => {
    const f = await exhaustedStopProofHold();
    const prior = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...prior.evidence, stopProofRecovery: {
      schema: "paperclip.stop-proof-recovery.v1", rearms: 1, generationId: randomUUID(), previousGenerationId: randomUUID(),
      rearmedAt: Date.now() - 60_000, nextRearmAt: Date.now() + 60 * 60_000 } } }).where(eq(issueRecoveryActions.id, f.actionId));

    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    expect(await nextWorkspaceRecoveryAt(db)).toBeGreaterThan(Date.now());
    await recoverRetainedWorkspace(f.input);
    const waiting = await action(f.actionId);
    expect(readSystemRecovery(waiting.evidence)?.state).toBe("exhausted");
    // The wait names the automatic retry; it asks no person to act.
    expect(waiting.nextAction).toMatch(/tries again automatically/);
    expect(String(waiting.nextAction)).not.toMatch(adminText);
  }, 60_000);

  it("after its bounded re-arms, attaches the unsaved files and continues from the last save", async () => {
    const f = await exhaustedStopProofHold();
    const prior = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...prior.evidence, stopProofRecovery: {
      schema: "paperclip.stop-proof-recovery.v1", rearms: 4, generationId: randomUUID(), previousGenerationId: randomUUID(),
      rearmedAt: Date.now() - 86_400_000, nextRearmAt: null } } }).where(eq(issueRecoveryActions.id, f.actionId));

    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);

    const settled = await action(f.actionId);
    expect(settled).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    const decision = settled.evidence.executionReconciliation as { retainedSourceFallback: { quarantine: { state: string } } };
    // No unsaved work is discarded silently: it is attached to the child task.
    expect(decision.retainedSourceFallback.quarantine.state).toBe("captured");
    expect(await parentHold(f)).toEqual({ kind: "free" });
  }, 60_000);

  it("reconsiders a spent fallback when a late stop receipt arrives", async () => {
    const f = await exhaustedStopProofHold();
    const prior = await action(f.actionId);
    const generationId = readSystemRecovery(prior.evidence)!.generationId;
    const checkedAt = Date.now() - 60_000;
    await db.update(issueRecoveryActions).set({ evidence: { ...prior.evidence,
      stopProofRecovery: { schema: "paperclip.stop-proof-recovery.v1", rearms: 4, generationId, previousGenerationId: randomUUID(),
        rearmedAt: Date.now() - 86_400_000, nextRearmAt: null },
      retainedSourceFallbackCheck: { generationId, reason: "execution_not_stopped", checks: 12, checkedAt, nextCheckAt: null } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(environmentLeases).set({ updatedAt: new Date(checkedAt - 60_000) }).where(eq(environmentLeases.heartbeatRunId, f.runId));
    const ids = async () => (await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id);
    // Every bounded check is spent: the worker stops selecting the hold.
    expect(await ids()).not.toContain(f.actionId);

    // A provider stop receipt lands on the source allocation afterwards.
    await db.update(environmentLeases).set({ updatedAt: new Date() }).where(eq(environmentLeases.heartbeatRunId, f.runId));
    expect(await ids()).toContain(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    expect(await parentHold(f)).toEqual({ kind: "free" });
  }, 60_000);

  /** Exhausts a saved-work recovery with the Nov 5 evidence shape: one attempt, `agent_stop_unconfirmed`, window spent. */
  async function exhaustStopWait(actionId: string, runId: string) {
    const prior = await action(actionId);
    const current = readSystemRecovery(prior.evidence)!;
    const firstFailureAt = Date.now() - 5 * 86_400_000;
    await db.update(issueRecoveryActions).set({ evidence: { ...prior.evidence,
      systemRecovery: { ...current, revision: current.revision + 3, state: "exhausted", attempts: 1, retriesUsed: 0, attemptId: randomUUID(),
        firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "e".repeat(64) } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "blocked", stage: "verifying_stop",
        attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] } } }).where(eq(issueRecoveryActions.id, actionId));
  }

  it("re-arms an exhausted restore hold too, through the worker's own discovery", async () => {
    // A restore hold (native continuation reconciliation), not a workspace export.
    const f = await seed("native", true);
    await adoptSystemRecovery(db, f);
    expect((await action(f.actionId)).cause).toBe("native_continuation_requires_reconciliation");
    await exhaustStopWait(f.actionId, f.runId);

    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);

    const rearmed = await action(f.actionId);
    expect(rearmed.evidence.stopProofRecovery).toMatchObject({ rearms: 1 });
    expect(readSystemRecovery(rearmed.evidence)).toMatchObject({ state: "complete" });
    expect(rearmed.ownerType).toBe("system");
  }, 60_000);

  /**
   * The staging shape (Nov 10): the finished coordinator of the
   * source run still names the lease owner of a finalizer pass from a server
   * that was replaced days ago. Its lease lapsed long ago, nothing settles an
   * owner on a finished coordinator, and every stop check refused it, so the
   * hold was never re-armed and its task stayed blocked.
   */
  it.each([
    ["an expired finalizer lease", { leaseOwner: `native-finalizer:${randomUUID()}`, expiresAgoMs: 6 * 86_400_000 }],
    ["an owner recorded without an expiry by an older release", { leaseOwner: `boot:${randomUUID()}`, expiresAgoMs: null }],
  ] as const)("re-arms a hold whose finished coordinator still names %s", async (_shape, owner) => {
    const f = await exhaustedStopProofHold();
    await db.update(nativeRunFinalizations).set({ leaseOwner: owner.leaseOwner,
      leaseExpiresAt: owner.expiresAgoMs === null ? null : new Date(Date.now() - owner.expiresAgoMs),
      controllerBootId: randomUUID(), controllerPid: 2_147_000_000, controllerGeneration: 3 })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_retry_exhausted" });

    // The worker discovers the hold and wakes for it now.
    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);

    const settled = await action(f.actionId);
    expect(settled.evidence.stopProofRecovery).toMatchObject({ rearms: 1, releasedLapsedOwner: true });
    expect(readSystemRecovery(settled.evidence)).toMatchObject({ state: "complete" });
    expect(readWorkspaceRecovery(settled.evidence)?.status).toBe("recovered");
    expect(String(settled.nextAction)).not.toMatch(adminText);
    // The lapsed owner is released (the saved result then finalizes as usual).
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]?.leaseOwner)
      .not.toBe(owner.leaseOwner);
    const [rearmed] = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))
      .then(rows => rows.filter(row => row.action === "issue.workspace_recovery_rearmed"));
    expect(rearmed?.details).toMatchObject({ rearm: 1, releasedLapsedOwner: owner.leaseOwner });
    // The dirty files are saved into the shared workspace; the parent task can run.
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toMatchObject({ dirty: false });
    expect(await parentHold(f)).toEqual({ kind: "free" });
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 60_000);

  it("keeps the hold while a finished coordinator's owner still holds a live lease", async () => {
    const f = await exhaustedStopProofHold();
    const expiresAt = Date.now() + 10 * 60_000;
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-finalizer:${randomUUID()}`, leaseExpiresAt: new Date(expiresAt) })
      .where(eq(nativeRunFinalizations.runId, f.runId));

    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    expect(await nextWorkspaceRecoveryAt(db)).toBeGreaterThanOrEqual(expiresAt - 1_000);
    await recoverRetainedWorkspace(f.input);
    const held = await action(f.actionId);
    expect(held.evidence.stopProofRecovery).toBeUndefined();
    expect(readSystemRecovery(held.evidence)?.state).toBe("exhausted");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]?.leaseOwner)
      .toMatch(/^native-finalizer:/);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
  }, 60_000);

  it("leaves a stale owner of an unfinished coordinator to the abandoned-owner settlement instead of spending re-arms", async () => {
    const f = await exhaustedStopProofHold();
    // An observed (not finished) coordinator: the abandoned-owner settlement
    // must prove its controller stopped before anything releases it.
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: `boot:${randomUUID()}`, leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));

    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    const next = await nextWorkspaceRecoveryAt(db);
    expect(next === null || next > Date.now()).toBe(true);
    await recoverRetainedWorkspace(f.input);
    const held = await action(f.actionId);
    expect(held.evidence.stopProofRecovery).toBeUndefined();
    expect(readSystemRecovery(held.evidence)?.state).toBe("exhausted");

    // Once that settlement releases the owner, the hold is due again.
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
  }, 60_000);

  async function waitingSettledHold(id: string) {
    const f = await seed("native", true);
    settledRuns.set(id, f.runId);
    await adoptSystemRecovery(db, f);
    const prior = await action(f.actionId);
    const system = readSystemRecovery(prior.evidence)!;
    await db.update(issueRecoveryActions).set({ id, status: "resolved", outcome: "blocked", ownerType: "system", evidence: { ...prior.evidence,
      systemRecovery: { ...system, state: "complete", phase: "reconcile_effects", attempts: 1 },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "recovered", stage: "saving_receipts",
        attempt: 1, attemptLimit: 6, retryable: false, requestIds: [] },
      automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked" } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const source = await run(f.runId);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: source.agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId } });
    return f;
  }

  const settledRuns = new Map<string, string>();

  it("restarts a finished passive pass when a change adds work both before and after its cursor", async () => {
    const first = await waitingSettledHold("00000002-0000-4000-8000-000000000000");
    await waitingSettledHold("00000003-0000-4000-8000-000000000000");
    const visited: string[] = [];
    const onRecovered = async (source: { id: string }) => { visited.push(source.id); };
    const sweep: PassiveSweep = {};
    for (let pass = 0; pass < 4 && !sweep.complete; pass += 1)
      await Promise.all(await reconcileRetainedWorkspaces(db, first.environmentRuntime, onRecovered, true, undefined, sweep) ?? []);
    expect(sweep.complete).toBe(true);
    await waitingSettledHold("00000001-0000-4000-8000-000000000000");
    const f = await exhaustedStopProofHold();
    await db.update(issueRecoveryActions).set({ id: "ffffffff-0000-4000-8000-000000000000" }).where(eq(issueRecoveryActions.id, f.actionId));
    sweep.restart = true;
    visited.length = 0;
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true, undefined, sweep) ?? []);
    expect(sweep).toMatchObject({ complete: false, restart: true });
    for (let pass = 0; pass < 6 && !(sweep.complete && !sweep.restart && visited.includes(settledRuns.get("00000001-0000-4000-8000-000000000000")!)); pass += 1)
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true, undefined, sweep) ?? []);
    expect(visited).toContain(settledRuns.get("00000001-0000-4000-8000-000000000000"));
    expect((await action("ffffffff-0000-4000-8000-000000000000")).evidence.stopProofRecovery).toMatchObject({ rearms: 1 });
  }, 60_000);

  it("re-arms the hold on a busy instance whose passive sweep keeps selecting earlier settled holds", async () => {
    for (const prefix of ["00000001", "00000002", "00000003", "00000004", "00000005", "00000006"])
      await waitingSettledHold(`${prefix}-0000-4000-8000-000000000000`);
    const f = await exhaustedStopProofHold();
    const holdId = "ffffffff-0000-4000-8000-000000000000";
    await db.update(issueRecoveryActions).set({ id: holdId }).where(eq(issueRecoveryActions.id, f.actionId));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: vi.fn() });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, async () => undefined);
    const busy = setInterval(() => { void db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery)).catch(() => undefined); }, 50);
    try {
      await worker.ready;
      await vi.waitFor(async () => expect((await action(holdId)).evidence.stopProofRecovery).toMatchObject({ rearms: 1 }),
        { timeout: 20_000, interval: 250 });
    } finally {
      clearInterval(busy);
      await worker.stop();
      await coordinator.stop();
    }
  }, 60_000);

  it("wakes the workspace recovery worker when a stop receipt is recorded", async () => {
    const f = await acceptedRemoteExport("retained");
    const woken: string[] = [];
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.workspaceRecovery, () => woken.push("workspace-recovery"));
    try {
      const [active] = await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null,
        metadata: { ...f.lease.metadata, remoteExecutionTermination: undefined } }).where(eq(environmentLeases.id, f.lease.id)).returning();
      const stopping = await prepareSandboxStopAndRetain(db, active);
      expect(stopping).not.toBeNull();
      woken.length = 0;
      expect(await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata?.pendingCleanupAttemptId ?? randomUUID()),
        receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } })).not.toBeNull();
      await vi.waitFor(() => expect(woken.length).toBeGreaterThan(0), { timeout: 5_000 });
    } finally { stop(); }
  }, 60_000);
});
