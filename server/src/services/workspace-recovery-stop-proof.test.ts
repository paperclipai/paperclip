import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { readRemoteWorkspaceWriterHold, remoteWorkspaceHoldRefusesStart } from "./remote-workspace-writer-hold.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { RETAINED_SOURCE_FALLBACK_OUTCOME } from "./workspace-recovery-fallback.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { reconcileRetainedWorkspaces, recoverRetainedWorkspace, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { acceptedRemoteExport, action, connectionString, db, run, seed, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
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

  it("leaves a stale finalizer owner to the abandoned-owner settlement instead of spending re-arms", async () => {
    const f = await exhaustedStopProofHold();
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-finalizer:${randomUUID()}`, leaseExpiresAt: new Date(Date.now() - 60_000) })
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
