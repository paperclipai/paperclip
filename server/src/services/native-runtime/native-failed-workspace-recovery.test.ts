import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, externalAgentHolds, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { markExecutionReconciliation, validateExecutionReconciliation } from "../execution-recovery-resolution.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { preserveCancelledNativeWorkspaces, preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-workspace-finalization-ownership.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";

const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("failed native workspace retention", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    if (externalUrl) db = createDb(externalUrl);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("native-failed-workspace-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native workspace", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve unfinished files", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "terminal_failure", errorCode: "adapter_failed",
      error: "runner_remote_process_identity_unavailable", resultJson: { originalDiagnostic: true }, contextSnapshot: { issueId },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: `Native recovery ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
    }).returning();
    const [bound] = await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: runId,
      leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
    } } }).where(eq(heartbeatRuns.id, runId)).returning();
    return { companyId, agentId, issueId, runId, run: bound, lease, environment };
  }
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const readLease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const actions = async (issueId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  it.each(["acknowledged", "warm", "pending", "foreign", "owned"])("pins historical cancelled work only after an exact Stop acknowledgement: %s", async kind => {
    const f = await seed();
    if (kind === "warm") await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "observed", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId,
        companyId: kind === "foreign" ? randomUUID() : f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: kind === "pending" ? "pending" : "acknowledged",
        dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "owned") await db.update(nativeRunFinalizations).set({ leaseOwner: "current-controller" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await preserveCancelledNativeWorkspaces(db);
    const current = await readRun(f.runId);
    expect(current).toMatchObject({ status: "cancelled", resultJson: { nativeCancellation: { scope: "run" } } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
    const pinned = kind === "acknowledged" || kind === "warm";
    expect(await readLease(f.lease.id)).toMatchObject(pinned
      ? { status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: { sandboxStopAndRetain: { runId: f.runId } } }
      : { status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(pinned ? 1 : 0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });
  it("keeps another cancelled workspace recoverable when one task row is locked", async () => {
    const busy = await seed(), free = await seed();
    for (const f of [busy, free]) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    let release!: () => void, ready!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, busy.issueId)).for("update");
      ready(); await released;
    });
    await acquired;
    try {
      for (let pass = 0; pass < 3; pass++) await preserveCancelledNativeWorkspaces(db);
      expect(await readLease(busy.lease.id)).toMatchObject({ status: "active" });
      expect(await readLease(free.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    } finally { release(); await holding; }
  }, 15_000);
  it.each(["pending_cleanup", "released"])("keeps an exact %s cancellation eligible until its file hold is recorded", async status => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const stopping = await prepareSandboxStopAndRetain(db, f.lease);
    if (!stopping) throw new Error("Expected the exact stop-only source");
    if (status === "pending_cleanup") {
      await preserveCancelledNativeWorkspaces(db);
      expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreRecovery");
      expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral" });
    }
    await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.lease.providerLeaseId, state: "stopped" } });
    for (let pass = 0; pass < 3; pass++) await preserveCancelledNativeWorkspaces(db);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "released", leasePolicy: "retain_on_failure",
      metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(await readRun(f.runId)).toMatchObject({ status: "cancelled", resultJson: {
      workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it("pins only the exact unexported source and exposes a file-only recovery card", async () => {
    const f = await seed();
    const [other] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      issueId: f.issueId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", metadata: f.lease.metadata,
    }).returning();
    await db.transaction(tx => preserveNativeFailedWorkspace(tx as unknown as typeof db, f.run));
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", errorCode: "adapter_failed", resultJson: {
      originalDiagnostic: true, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: {
      sandboxStopAndRetain: { runId: f.runId, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId },
    } });
    expect(await readLease(other.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toMatchObject([{ status: "resolved", outcome: "blocked", evidence: { runId: f.runId } }]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId,
      cause: "native_continuation_requires_reconciliation", workspaceRepairRequired: true,
      canRecordWorkspaceRepair: true, canRetry: false, canContinue: false,
    });
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect(await actions(f.issueId)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.workspace_recovery_required")))).toHaveLength(1);
  });

  async function bindExternalInput(f: Awaited<ReturnType<typeof seed>>, provider: "grok_bot" | "openai_dot" | "muse", change?: (input: { schema: string; binding: { runId: string; companyId: string; agentId: string; issueId: string }; provider: { kind: string; bridgeRevision?: string }; workspace: { access: string; cwd: string | null } }) => void) {
    const run = await readRun(f.runId);
    const input = { schema: provider === "muse" ? "paperclip.native-execution-input.v8" : "paperclip.native-execution-input.v6",
      binding: { runId: f.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
      provider: { kind: provider, ...(provider === "muse" ? { bridgeRevision: "muse-v1" } : {}) }, workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null } };
    change?.(input);
    const [updated] = await db.update(heartbeatRuns).set({ driverKind: provider === "muse" ? "muse_external" : provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp",
      runnerProfileJson: { ...run.runnerProfileJson, nativeExecutionInput: input } }).where(eq(heartbeatRuns.id, f.runId)).returning();
    return updated;
  }

  it.each(["grok_bot", "openai_dot", "muse"] as const)("does not invent file recovery for %s admitted without workspace access", async provider => {
    const f = await seed(), run = await bindExternalInput(f, provider);
    const [hold] = provider === "muse" ? await db.insert(externalAgentHolds).values({ companyId: f.companyId, agentId: f.agentId,
      provider: "muse", assignmentId: randomUUID(), bindingId: randomUUID(), bindingGeneration: 1, runId: f.runId,
      workerUnknown: true, nativeEffectsUnknown: true }).returning() : [];
    await preserveNativeFailedWorkspace(db, run);
    expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreFailure");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(0);
    if (hold) expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id, hold.id)))[0]).toEqual(hold);
  });

  it.each(["run", "company", "agent", "schema", "write_access"])("preserves file safeguards when no-workspace evidence has an invalid %s", async mismatch => {
    const f = await seed();
    const run = await bindExternalInput(f, "grok_bot", input => {
      if (mismatch === "run") input.binding.runId = randomUUID();
      if (mismatch === "company") input.binding.companyId = randomUUID();
      if (mismatch === "agent") input.binding.agentId = randomUUID();
      if (mismatch === "schema") input.schema = "unknown";
      if (mismatch === "write_access") input.workspace.access = "read_write";
    });
    await preserveNativeFailedWorkspace(db, run);
    expect((await readRun(f.runId)).resultJson).toHaveProperty("workspaceRestoreFailure", "restore_failed");
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure" });
  });

  it.each(["run", "company", "agent", "issue", "schema", "provider", "bridge", "missing_bridge", "driver", "write_access", "cwd"] as const)("retains file safeguards for a mismatched Muse %s contract", async mismatch => {
    const f = await seed();
    await bindExternalInput(f, "muse", input => {
      if (mismatch === "run") input.binding.runId = randomUUID();
      if (mismatch === "company") input.binding.companyId = randomUUID();
      if (mismatch === "agent") input.binding.agentId = randomUUID();
      if (mismatch === "issue") input.binding.issueId = randomUUID();
      if (mismatch === "schema") input.schema = "paperclip.native-execution-input.v6";
      if (mismatch === "provider") input.provider.kind = "grok_bot";
      if (mismatch === "bridge") input.provider.bridgeRevision = "unknown";
      if (mismatch === "missing_bridge") delete input.provider.bridgeRevision;
      if (mismatch === "write_access") input.workspace.access = "read_write";
      if (mismatch === "cwd") input.workspace.cwd = "/untrusted-task-workspace";
    });
    if (mismatch === "driver") await db.update(heartbeatRuns).set({ driverKind: "openai_dot_mcp" }).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect((await readRun(f.runId)).resultJson).toHaveProperty("workspaceRestoreFailure", "restore_failed");
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure" });
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it.each(["grok_bot", "openai_dot"] as const)("keeps historical %s inspection holds with an available recovery path", async provider => {
    const f = await seed();
    // Reproduce a hold persisted by an older cancellation path, then attach its admitted contract.
    await preserveNativeFailedWorkspace(db, f.run);
    const lease = await readLease(f.lease.id);
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: lease.providerLeaseId, state: "stopped" } });
    await bindExternalInput(f, provider);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.runId, canRetry: false, canContinue: false,
      workspaceRepairRequired: provider !== "grok_bot", canRecordWorkspaceRepair: provider !== "grok_bot" });
    if (provider === "grok_bot") {
      expect(blocker?.nextAction).not.toContain("files");
      expect(blocker?.nextAction).toContain("Runtime");
    }
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it("records verified file repair without retrying the native run or changing its task", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    await preserveNativeFailedWorkspace(db, f.run);
    const lease = await readLease(f.lease.id);
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: lease.providerLeaseId, state: "stopped" },
    });
    const [action] = await actions(f.issueId);
    const decision = { runId: f.runId, providerStopped: true as const, actionOutcome: "mixed" as const,
      outcomeEvidence: "Files verified; no external action is replayed.", workspaceRepairEvidence: "Exact retained allocation exported and every source hash checked." };
    await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: null, sourceRunId: f.runId, decision, workspaceRepairOnly: true });
    await markExecutionReconciliation(db, action!, decision, "board-operator", undefined, { workspaceRepairOnly: true });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toMatchObject([{ status: "done", assigneeAgentId: null }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await actions(f.issueId)).toMatchObject([{ evidence: { continuationDelivery: "not_requested" } }]);
  });

  async function claimRestart(f: Awaited<ReturnType<typeof seed>>) {
    const claim: NativeRestartRecoveryClaim = { kind: "reattach_remote_runner", runId: f.runId,
      leaseOwner: randomUUID(), controllerGeneration: 2, providerAttempt: 3,
      restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: f.lease.providerLeaseId!, remoteCwd: "/work" } };
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: claim.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000), controllerGeneration: claim.controllerGeneration, attempt: claim.providerAttempt,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    return claim;
  }

  it.each([false, true])("captures a preparation failure before the terminal writer, with recovery claim: %s", async claimed => {
    const f = await seed();
    const restartRecovery = claimed ? await claimRestart(f) : undefined;
    if (!claimed) {
      await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    await preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery });
    expect(await readRun(f.runId)).toMatchObject({ status: "running", resultJson: { workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    if (claimed) expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))
      .toMatchObject([{ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null }]);
    await db.update(heartbeatRuns).set({ status: "failed", resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({ stopReason: "adapter_failed" }) })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", resultJson: {
      stopReason: "adapter_failed", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true });
  });

  it("records terminal file retention after the executor retires its recovery claim", async () => {
    const f = await seed();
    const restartRecovery = await claimRestart(f);
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ status: "failed", nativePhase: "terminal_failure" }).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery });
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true });
  });

  it.each(["token", "generation", "attempt", "run", "remote", "expired", "released"])("refuses a stale %s recovery claim", async kind => {
    const f = await seed();
    const restartRecovery = await claimRestart(f);
    if (kind === "token") restartRecovery.leaseOwner = randomUUID();
    if (kind === "generation") restartRecovery.controllerGeneration += 1;
    if (kind === "attempt") restartRecovery.providerAttempt += 1;
    if (kind === "run") restartRecovery.runId = randomUUID();
    if (kind === "remote" && restartRecovery.kind === "reattach_remote_runner") restartRecovery.remote.remoteCwd = "/other";
    if (kind === "expired") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "released") await db.update(nativeRunFinalizations).set({ leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery }))
      .rejects.toBeInstanceOf(NativeWorkspaceFinalizationBusyError);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toHaveLength(0);
    expect(await readRun(f.runId)).toMatchObject({ status: "running", nativePhase: "observed" });
  });

  it("refuses cleanup when another execution still owns the coordinator", async () => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: randomUUID() })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(preserveNativeFailedWorkspace(db, f.run, { allowPreterminal: true }))
      .rejects.toBeInstanceOf(NativeWorkspaceFinalizationBusyError);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toHaveLength(0);
  });

  it.each(["finalized", "retryable_failure", "result_accepted", "wrong_provider", "wrong_company"])("leaves %s outside failed-source retention", async kind => {
    const f = await seed();
    if (kind === "retryable_failure" || kind === "result_accepted") {
      await db.update(nativeRunFinalizations).set({ phase: kind }).where(eq(nativeRunFinalizations.runId, f.runId));
    } else {
      const reference = f.run.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
      if (kind === "wrong_company") {
        const foreign = await seed();
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
          ...reference, leaseId: foreign.lease.id, providerLeaseId: foreign.lease.providerLeaseId,
        } } }).where(eq(heartbeatRuns.id, f.runId));
      } else await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        ...reference, ...(kind === "finalized" ? { state: "finalized", finalHostSha256: "c".repeat(64) } : { providerLeaseId: randomUUID() }),
      } } }).where(eq(heartbeatRuns.id, f.runId));
    }
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect(await actions(f.issueId)).toHaveLength(0);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
  });

  it("rolls back terminal status, source retention and the recovery card together", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(db.transaction(async tx => {
      const [run] = await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId)).returning();
      await preserveNativeFailedWorkspace(tx as unknown as typeof db, run!);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await readRun(f.runId)).toMatchObject({ status: "running", resultJson: { originalDiagnostic: true } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(0);
  });
});
