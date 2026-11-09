import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { invalidateNativeReplacementDiscovery, reconcileSafeNativeReplacements } from "./native-runtime/native-safe-replacement.js";
import * as storageBackend from "../storage/index.js";
import { acceptedRemoteExport, action, connectionString, db, run, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/**
 * The staging shape of a native run that failed before its first coordinator
 * claim (2026-11-07: a resumed run aborted at the harness-backup restore
 * deadline). No provider process, no claim, no provider or tool events. The
 * failure path moved the coordinator to `terminal_failure` with attempt 0 and
 * an earlier release recorded a resolved `preserve_without_replay_v1` hold
 * that blocks replay and the task.
 */
async function preClaimNativeFailure() {
  const f = await acceptedRemoteExport("published");
  const source = await run(f.runId);
  await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, f.runId));
  await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
  await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", attempt: 0, leaseOwner: null, leaseExpiresAt: null,
    failureCode: "native_continuation_requires_reconciliation", failureDetail: null })
    .where(eq(nativeRunFinalizations.runId, f.runId));
  const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] };
  const remoteWorkspace = source.runnerProfileJson!.remoteWorkspace as { remoteCwd: string };
  await db.update(heartbeatRuns).set({
    status: "failed", finishedAt: new Date(), error: "The operation was aborted",
    errorCode: "native_continuation_requires_reconciliation", completionContractId: null,
    sessionIdBefore: "ses_previous_provider_session", nativeSessionId: randomUUID(), nativePhase: "terminal_failure",
    contextSnapshot: { issueId: f.issueId, wakeReason: "External chat message received" },
    resultJson: { stopReason: "adapter_failed", timeoutFired: false, timeoutSource: "config",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, timeoutConfigured: false, effectiveTimeoutSec: 0,
      workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery },
    runnerProfileJson: { ...source.runnerProfileJson,
      nativeExecutionInput: { workspace: { cwd: remoteWorkspace.remoteCwd } } },
  }).where(eq(heartbeatRuns.id, f.runId));
  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "lifecycle", stream: "system", level: "info", message: "run started" });
  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "error", stream: "system", level: "error", message: "The operation was aborted" });
  await db.update(issues).set({ status: "blocked", statusVersion: 18, executionRunId: null, checkoutRunId: null })
    .where(eq(issues.id, f.issueId));
  // The hold exactly as e2d490c61 recorded it (resolved, replay blocked, board-owned).
  await db.update(issueRecoveryActions).set({
    cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${f.runId}`,
    status: "resolved", outcome: "blocked", ownerType: "board", resolvedAt: new Date(),
    nextAction: "The original sandbox is retained for workspace repair. Verify its exact stop receipt, recover the missing files, and record workspaceRepairEvidence without changing the current task. Repair does not replay the stopped run. Explicitly remove the retained allocation after recovery.",
    evidence: { runId: f.runId, originalFailureCode: null, continuationDelivery: "invalidated",
      workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked",
        actionOutcome: "unknown", recordedAt: new Date().toISOString() },
      nativeFailureBlock: { runId: f.runId, statusVersion: 18 } },
  }).where(eq(issueRecoveryActions.id, f.actionId));
  await adoptSystemRecovery(db, f);
  return { ...f, agentId: source.agentId };
}

async function successorsOf(runId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
}

async function sweep() {
  invalidateNativeReplacementDiscovery(db);
  return reconcileSafeNativeReplacements(db);
}

describe("native run that failed before its first coordinator claim", () => {
  useWorkspaceRecoveryFixture(targets);
  // A published remote workspace: the shape staging persists and restores.
  const priorEnv = { databaseUrl: process.env.DATABASE_URL, masterKey: process.env.PAPERCLIP_SECRETS_MASTER_KEY };
  beforeEach(() => {
    const local = storageBackend.getStorageService();
    vi.spyOn(storageBackend, "getStorageService").mockReturnValue({ ...local, provider: "s3" });
    process.env.DATABASE_URL = connectionString; process.env.PAPERCLIP_SECRETS_MASTER_KEY = "63".repeat(32);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (priorEnv.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorEnv.databaseUrl;
    if (priorEnv.masterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorEnv.masterKey;
  });

  it("continues automatically exactly once after its saved work is recovered", async () => {
    const f = await preClaimNativeFailure();
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered" });

    await Promise.all([sweep(), sweep()]);
    await sweep();

    const successors = await successorsOf(f.runId);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "scheduled_retry", agentId: f.agentId,
      scheduledRetryReason: "native_safe_replacement",
      contextSnapshot: { issueId: f.issueId, retryOfRunId: f.runId, nativePreClaimContinuationOf: f.runId } });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successors[0].id));
    expect(wake).toMatchObject({ status: "queued", requestedByActorType: "system" });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator.failureDetail).toMatchObject({ successorRunId: successors[0].id, preClaimContinuation: true });
    const hold = await action(f.actionId);
    expect(hold).toMatchObject({ status: "resolved", outcome: "handed_back",
      evidence: { automaticRecovery: { replay: "verified_safe_replacement", successorRunId: successors[0].id } } });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "in_progress", executionRunId: null, checkoutRunId: null });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  }, 60_000);

  it("waits for saved work before continuing", async () => {
    const f = await preClaimNativeFailure();
    await sweep();
    expect(await successorsOf(f.runId)).toHaveLength(0);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.status).toBe("blocked");
  }, 60_000);

  it("does not chain a second automatic continuation from its own successor", async () => {
    const f = await preClaimNativeFailure();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, nativePreClaimContinuationOf: randomUUID() } })
      .where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    await sweep();
    expect(await successorsOf(f.runId)).toHaveLength(0);
  }, 60_000);

  it.each(["claimed", "provider_event", "tool_call", "uncertain_side_effect", "process", "superseded"] as const)(
    "keeps reconciliation when the run may have acted: %s", async gate => {
      const f = await preClaimNativeFailure();
      await recoverRetainedWorkspace(f.input);
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered" });
      if (gate === "claimed") await db.update(nativeRunFinalizations).set({ attempt: 1, controllerGeneration: 1 })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (gate === "provider_event") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: f.agentId, eventType: "turn.started", stream: "system", level: "info", payload: {} });
      if (gate === "tool_call") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: f.agentId, eventType: "tool.execution.started", stream: "system", level: "info",
        payload: { name: "paperclip_create_issue", executionId: randomUUID() } });
      if (gate === "uncertain_side_effect") {
        const current = await run(f.runId);
        await db.update(heartbeatRuns).set({ resultJson: { ...current.resultJson,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, f.runId));
      }
      if (gate === "process") await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, processStartedAt: new Date() })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "superseded") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "succeeded", contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 1000) });
      await sweep();
      expect(await successorsOf(f.runId)).toHaveLength(0);
      const hold = await action(f.actionId);
      expect(hold).toMatchObject({ outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
      const [task] = await db.select().from(issues).where(and(eq(issues.id, f.issueId)));
      expect(task.status).toBe("blocked");
    }, 60_000);
});
