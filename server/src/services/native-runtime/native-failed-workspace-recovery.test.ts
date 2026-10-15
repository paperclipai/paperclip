import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { markExecutionReconciliation, validateExecutionReconciliation } from "../execution-recovery-resolution.js";
import { settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
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
