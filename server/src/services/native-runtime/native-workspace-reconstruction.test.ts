import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, assets, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, heartbeatRuns, issueAttachments, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";
import { deliverReconciledExecutions, markExecutionReconciliation, validateExecutionReconciliation } from "../execution-recovery-resolution.js";
import { heartbeatService } from "../heartbeat.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { reconstructNativeWorkspace } from "./native-workspace-reconstruction.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import { drainHeartbeatRunsToQuiescence } from "../../__tests__/helpers/drain-heartbeat-runs.js";
import { reserveRunBudget } from "../budget-reservations.js";
import { accountRunCost } from "../run-cost-accounting.js";
const providerExecute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false,
  errorMessage: null, summary: "Bounded reconstruction completed.", provider: "test", model: "test" })));
vi.mock("../../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../../adapters/index.js")>("../../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: providerExecute }),
}));

describe("reconstruction after confirmed native workspace loss", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let runningHeartbeat: ReturnType<typeof heartbeatService> | null = null;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workspace-reconstruction-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary.cleanup(); });
  afterEach(async () => {
    if (runningHeartbeat) await drainHeartbeatRunsToQuiescence(db, runningHeartbeat);
    runningHeartbeat = null;
    providerExecute.mockClear();
    await db.transaction(async tx => {
    await tx.execute(sql`set local client_min_messages = warning`);
    await tx.execute(sql`truncate companies cascade`);
  }); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), resultId = randomUUID(),
      contractId = randomUUID(), leaseId = randomUUID(), actionId = randomUUID(), providerLeaseId = randomUUID(), userId = randomUUID(), attachmentId = randomUUID(), assetId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Reconstruction", issuePrefix: `REC${companyId.replaceAll("-", "").slice(0, 6)}`, defaultResponsibleUserId: userId, budgetMonthlyCents: 10000 });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "paperclip_runner", budgetMonthlyCents: 5000, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finish bounded work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { objective: "Finish bounded work" }, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId, nativePhase: "terminal_failure", completionContractId: contractId,
      createdAt: new Date("2026-05-01T00:00:00Z"), finishedAt: new Date("2026-05-01T01:30:00Z"), responsibleUserId: userId, scheduledRetryAttempt: 2,
      contextSnapshot: { issueId, originalWorkDeadline: "2026-05-01T01:30:00Z" }, errorCode: "native_session_interrupted", processPid: process.pid,
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: { work: "Unfinished local edits; no published PR" }, canonicalSha256: resultId });
    const cause = "native_workspace_sync_out_unrecoverable";
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", resultId, failureCode: cause });
    const identity = { id: leaseId, companyId, heartbeatRunId: runId, provider: "daytona", providerLeaseId };
    await db.insert(environmentLeases).values({ ...identity, issueId, status: "expired", releasedAt: new Date(), cleanupStatus: "success", metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId, state: "destroyed" }) } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause, fingerprint: runId, evidence: { runId }, nextAction: "Recover saved files", status: "resolved", outcome: "restored", resolutionNote: "new_source_execution_path" });
    await db.insert(assets).values({ id: assetId, companyId, provider: "local", objectKey: assetId, contentType: "text/plain", byteSize: 100, sha256: "c".repeat(64), originalFilename: "saved-baseline.ts" });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId, assetId });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const body = { actionId, runId, expectedStatusVersion: issue.statusVersion, attachmentIds: [attachmentId], missingWork: "The unexported patch is lost. Rebuild only from this earlier verified baseline.", actionOutcome: "not_performed" as const, outcomeEvidence: "The saved execution receipt and remote repository show no published PR or submitted external change.", acknowledgeLostWork: true as const };
    const input = { db, companyId, issueId, actorId: userId, request: body };
    return { ...input, body, agentId, leaseId, resultId, runId, actionId, providerLeaseId, attachmentId, assetId };
  }
  function app(actor: unknown = { type: "board", source: "local_implicit" }) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler); return app;
  }
  async function interveningCancelledRun(f: Awaited<ReturnType<typeof seed>>, repairFiles = true) {
    const runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, scopeKind: "issue", runtimeMode: "native", status: "cancelled",
      nativePhase: "observed", createdAt: new Date("2026-05-02T00:00:00Z"), finishedAt: new Date("2026-05-02T00:01:00Z"),
      contextSnapshot: { issueId: f.issueId }, resultJson: { cancelledByActorType: "user", cancelledByUserId: f.actorId,
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId: f.companyId, issueId: f.issueId,
          scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } },
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "d".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: runId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } });
    if (!repairFiles) return { runId, leaseId, actionId: null };
    await preserveNativeFailedWorkspace(db, run, { allowPreterminal: true });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId, state: "stopped" } });
    const repair = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .find(action => action.evidence.runId === runId)!;
    const decision = { runId, providerStopped: true as const, actionOutcome: "not_performed" as const,
      outcomeEvidence: "Acknowledged interruption before any recorded tool or external action.",
      workspaceRepairEvidence: "The exact stopped allocation was inspected; no source edits were made and the host baseline is unchanged." };
    await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: runId, decision, workspaceRepairOnly: true });
    await markExecutionReconciliation(db, repair, decision, f.actorId, undefined, { workspaceRepairOnly: true });
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored" }).where(eq(issueRecoveryActions.id, repair.id));
    return { runId, leaseId, actionId: repair.id };
  }
  it.each(["blocked", "in_progress"] as const)("reconstructs an inactive %s task after an intervening cancelled run was stopped and its files reconciled", async status => {
    const f = await seed();
    const [current] = await db.update(issues).set({ status }).where(eq(issues.id, f.issueId)).returning();
    f.request.expectedStatusVersion = current.statusVersion;
    const later = await interveningCancelledRun(f);
    const visible = await request(app()).get(`/api/issues/${f.issueId}`).expect(200);
    expect(visible.body.executionBlocker).toMatchObject({
      runId: f.runId, canReconstructWorkspace: true, workspaceRecoveryStatusVersion: current.statusVersion,
    });
    await request(app()).post(`/api/issues/${f.issueId}/recovery-actions/reconstruct-workspace`).send(f.body).expect(202);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.evidence.executionReconciliation).toMatchObject({ workspaceReconstruction: {
      interveningExecutions: [{ runId: later.runId, recoveryActionId: later.actionId, evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, later.runId)))[0].status).toBe("cancelled");
  });
  it("pins a historical cancelled workspace through public heartbeat startup without replaying its turn", async () => {
    const f = await seed();
    const later = await interveningCancelledRun(f, false);
    const heartbeat = runningHeartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } });
    await heartbeat.recoverNativeRunsAfterRestart();
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, later.leaseId)))[0])
      .toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: later.runId } } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, later.runId)))[0].status).toBe("cancelled");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    expect(providerExecute).not.toHaveBeenCalled();
  });
  it.each(["unrepaired", "unconfirmed", "foreign_agent", "missing_ack", "performed_action", "rebound"] as const)
    ("refuses an intervening cancellation without its complete proof: %s", async kind => {
    const f = await seed();
    const later = await interveningCancelledRun(f, kind !== "unrepaired");
    if (kind === "unconfirmed") await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, later.leaseId));
    if (kind === "foreign_agent") {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Different owner", adapterType: "paperclip_runner" }).returning();
      await db.update(heartbeatRuns).set({ agentId: agent.id }).where(eq(heartbeatRuns.id, later.runId));
    }
    if (kind === "missing_ack") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, later.runId));
    if (kind === "performed_action") {
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, later.actionId!));
      await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, executionReconciliation: {
        ...(action.evidence.executionReconciliation as object), actionOutcome: "mixed",
      } } }).where(eq(issueRecoveryActions.id, action.id));
    }
    if (kind === "rebound") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, later.leaseId));
      await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId,
        provider: lease.provider, providerLeaseId: lease.providerLeaseId, status: "active" });
    }
    await expect(reconstructNativeWorkspace(f)).rejects.toThrow();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence)
      .not.toHaveProperty("executionReconciliation");
  });
  it.each(["unchanged", "changed_evidence", "extra_reconciled"] as const)
    ("rechecks the recorded intervening executions at final provider handoff: %s", async kind => {
    const f = await seed();
    const later = await interveningCancelledRun(f);
    await reconstructNativeWorkspace(f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [source] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const successorId = String(source.evidence.continuationRunId);
    expect(successorId).not.toBe("undefined");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successorId));
    await db.update(issues).set({ status: "in_progress", executionRunId: successorId }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, successorId, null);
    if (kind === "changed_evidence") {
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, later.actionId!));
      await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, executionReconciliation: {
        ...(action.evidence.executionReconciliation as object), workspaceRepairEvidence: "A different later statement cannot replace the frozen original file proof.",
      } } }).where(eq(issueRecoveryActions.id, action.id));
    }
    if (kind === "extra_reconciled") await interveningCancelledRun(f);
    const dispatch = vi.fn(async () => "provider entered");
    const result = await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId,
      runId: successorId, reservationId: reservation.id, expectedStatus: "running", dispatch });
    expect(result.dispatched).toBe(kind === "unchanged");
    expect(dispatch).toHaveBeenCalledTimes(kind === "unchanged" ? 1 : 0);
  });
  it("keeps a falsely resolved export visible and prevents conversation reset from hiding it", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true, canReconstructWorkspace: true });
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.actorId, body: "/new" });
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.actorId, conversationState: "active" }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { conversationResetCommentId: commentId })).not.toBeNull();
    expect(await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      actorType: "user", actorId: f.actorId, reason: "issue_commented", commentId, successorRunId: randomUUID() })).toBeNull();
    const response = await request(app()).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
    expect(response.body.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.actionId })]));
  });
  it("records partial sources atomically, preserves failed history and budgets, and deduplicates concurrent submissions", async () => {
    const f = await seed();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await Promise.all([reconstructNativeWorkspace(f), reconstructNativeWorkspace(f)]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toMatchObject({ phase: "terminal_failure", resultId: f.resultId });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].schemaStatus).toBe("accepted");
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(record).toMatchObject({ outcome: "handed_back", evidence: { continuationDelivery: "pending", executionReconciliation: { workspaceReconstruction: { missingWork: f.body.missingWork, sources: [{ attachmentId: f.attachmentId, sha256: "c".repeat(64) }] } } } });
    expect(record.evidence.executionReconciliation).not.toHaveProperty("workspaceRepairEvidence");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId, workspaceRepairRequired: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].budgetMonthlyCents).toBe(10000);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].budgetMonthlyCents).toBe(5000);
  });
  it.each(["retained", "receipt", "lease", "owner", "coordinator", "copyback", "newer", "status", "version", "attachment", "result", "execution", "checkout"] as const)("rejects stale or unsafe reconstruction: %s", async kind => {
    const f = await seed();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "retained") await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "receipt") await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: { ...(lease.metadata!.remoteExecutionTermination as object), runId: randomUUID() } } }).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "lease") await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "owner") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    if (kind === "coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: "other-worker" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "copyback") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: { token: "other-worker" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "newer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId: f.issueId }, status: "succeeded" });
    if (kind === "status") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    if (kind === "execution") await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    if (kind === "checkout") await db.update(issues).set({ checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    if (kind === "version") f.request.expectedStatusVersion += 1;
    if (kind === "attachment") f.request.attachmentIds = [(await seed()).attachmentId];
    if (kind === "result") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
    if (kind === "execution" || kind === "checkout") expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.canReconstructWorkspace).not.toBe(true);
    await expect(reconstructNativeWorkspace(f)).rejects.toThrow();
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toHaveLength(0);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence).not.toHaveProperty("executionReconciliation");
  });
  it("exposes board recovery through the assembled API and rejects missing loss acknowledgement", async () => {
    const f = await seed();
    await request(app()).post(`/api/issues/${f.issueId}/recovery-actions/reconstruct-workspace`).send({ ...f.body, acknowledgeLostWork: false }).expect(400);
    await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, runId: f.runId })).post(`/api/issues/${f.issueId}/recovery-actions/reconstruct-workspace`).send(f.body).expect(403);
    await request(app()).post(`/api/issues/${f.issueId}/recovery-actions/reconstruct-workspace`).send(f.body).expect(202);
  });
  it.each(["status", "attachment", "paused"] as const)("keeps delivery pending when %s changes after reconstruction is recorded", async kind => {
    const f = await seed();
    await reconstructNativeWorkspace(f);
    if (kind === "status") await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    if (kind === "attachment") await db.delete(issueAttachments).where(eq(issueAttachments.id, f.attachmentId));
    if (kind === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence.continuationDelivery).toBe("pending");
  });
  it("admits one fresh continuation through public heartbeat, keeps retry budget, and adopts a lost acknowledgement", async () => {
    const f = await seed();
    await reconstructNativeWorkspace(f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const wake = vi.fn(heartbeat.wakeup);
    let successorId: string | undefined;
    let admissionError: unknown;
    await deliverReconciledExecutions(db, async (...args) => {
      let successor;
      try { successor = await wake(...args); } catch (error) { admissionError = error; throw error; }
      expect(successor).not.toBeNull(); successorId = successor!.id;
      expect(successor).toMatchObject({ retryOfRunId: f.runId, scheduledRetryAttempt: 2, contextSnapshot: { forceFreshSession: true, previousRunId: f.runId } });
      throw new Error("lost acknowledgement");
    });
    if (admissionError) throw admissionError;
    const queued = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(successorId, JSON.stringify(queued.map(row => ({ status: row.status, reason: row.reason, payload: row.payload })))).toBeDefined();
    await deliverReconciledExecutions(db, wake);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${f.actionId}`))).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: successorId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
  it.each(["unchanged", "blocked", "attachment", "paused", "forged_successor"] as const)("rechecks a queued reconstruction at the final provider handoff: %s", async kind => {
    const f = await seed();
    await reconstructNativeWorkspace(f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const successorId = String(action.evidence.continuationRunId);
    expect(successorId).not.toBe("undefined");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successorId));
    await db.update(issues).set({ status: "in_progress", executionRunId: successorId }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, successorId, null);
    if (kind === "blocked") await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    if (kind === "attachment") await db.delete(issueAttachments).where(eq(issueAttachments.id, f.attachmentId));
    if (kind === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (kind === "forged_successor") await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, continuationRunId: randomUUID() } }).where(eq(issueRecoveryActions.id, f.actionId));
    const dispatch = vi.fn(async () => "provider entered");
    const outcome = await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId,
      runId: successorId, reservationId: reservation.id, expectedStatus: "running", dispatch });
    expect(outcome.dispatched).toBe(kind === "unchanged");
    expect(dispatch).toHaveBeenCalledTimes(kind === "unchanged" ? 1 : 0);
    if (!outcome.dispatched) expect(outcome).toMatchObject({ cancellation: { outcome: "cancelled" } });
  });
  it.each(["unchanged", "attachment", "blocked", "paused", "forged_wake", "foreign_parent", "unrelated_run", "uncertain_parent", "new_recovery"] as const)("keeps bounded reconstruction retries under current authority: %s", async kind => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 0 }).where(eq(heartbeatRuns.id, f.runId));
    await reconstructNativeWorkspace(f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const firstId = String(action.evidence.continuationRunId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed",
      resultJson: { errorFamily: "transient_upstream", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, firstId));
    await db.update(issues).set({ status: "in_progress", executionRunId: firstId }).where(eq(issues.id, f.issueId));
    const retry = await heartbeat.scheduleBoundedRetry(firstId, { now: new Date(), random: () => 0, delayMs: 0 });
    expect(retry.outcome, JSON.stringify(retry)).toBe("scheduled");
    if (retry.outcome !== "scheduled" || !retry.run) throw new Error("Expected a bounded bootstrap retry");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, retry.run.id));
    await db.update(issues).set({ executionRunId: retry.run.id }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, retry.run.id, null);
    if (kind === "attachment") await db.delete(issueAttachments).where(eq(issueAttachments.id, f.attachmentId));
    if (kind === "blocked") await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    if (kind === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (kind === "forged_wake") await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, retry.run.wakeupRequestId!));
    if (kind === "foreign_parent") {
      const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "paperclip_runner" }).returning();
      await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, firstId));
    }
    if (kind === "unrelated_run") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      scopeKind: "issue", issueId: f.issueId, contextSnapshot: { issueId: f.issueId }, status: "succeeded" });
    if (kind === "uncertain_parent") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, firstId));
    if (kind === "new_recovery") await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: randomUUID(), evidence: { runId: firstId }, nextAction: "Reconcile the new execution", status: "active" });
    const dispatch = vi.fn(async () => "provider entered");
    const outcome = await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId,
      runId: retry.run.id, reservationId: reservation.id, expectedStatus: "running", dispatch });
    expect(outcome.dispatched).toBe(kind === "unchanged");
    expect(dispatch).toHaveBeenCalledTimes(kind === "unchanged" ? 1 : 0);
    if (kind === "unchanged") {
      expect(retry.run.scheduledRetryAttempt).toBe(1);
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, retry.run.id));
      await accountRunCost(db, retry.run.id);
      const second = await heartbeat.scheduleBoundedRetry(retry.run.id, { now: new Date(), random: () => 0, delayMs: 0 });
      expect(second.outcome).toBe("scheduled");
      if (second.outcome !== "scheduled" || !second.run) throw new Error("Expected the second bounded retry");
      expect(second.run.scheduledRetryAttempt).toBe(2);
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, second.run.id));
      await db.update(issues).set({ executionRunId: second.run.id }).where(eq(issues.id, f.issueId));
      const secondReservation = await reserveRunBudget(db, f.companyId, second.run.id, null);
      expect(await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId,
        runId: second.run.id, reservationId: secondReservation.id, expectedStatus: "running", dispatch })).toMatchObject({ dispatched: true });
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, second.run.id));
      expect(await heartbeat.scheduleBoundedRetry(second.run.id)).toMatchObject({ outcome: "retry_exhausted" });
    }
  });
  it.each([false, true])("dispatches the assembled bootstrap retry without overwriting a later block: %s", async blockAfterClaim => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 0 }).where(eq(heartbeatRuns.id, f.runId));
    await reconstructNativeWorkspace(f);
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const heartbeat = runningHeartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const firstId = String(action.evidence.continuationRunId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, firstId));
    await db.update(issues).set({ status: "in_progress", executionRunId: firstId }).where(eq(issues.id, f.issueId));
    const retry = await heartbeat.scheduleBoundedRetry(firstId, { now: new Date(), random: () => 0, delayMs: 0 });
    if (retry.outcome !== "scheduled" || !retry.run) throw new Error(`Expected a bounded retry: ${JSON.stringify(retry)}`);
    expect(await createRunDispatch(db).promoteScheduledRetry({ companyId: f.companyId, runId: retry.run.id }))
      .toMatchObject({ outcome: "promoted" });
    if (blockAfterClaim) await db.execute(sql.raw(`
      create function block_retry_after_claim() returns trigger language plpgsql as $$ begin
        if new.id = '${retry.run.id}' and old.status = 'queued' and new.status = 'running' then
          update issues set status = 'blocked' where id = '${f.issueId}';
        end if; return new; end $$;
      create trigger block_retry_after_claim after update on heartbeat_runs
      for each row execute function block_retry_after_claim();
    `));
    try {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await heartbeat.resumeQueuedRuns();
      const deadline = Date.now() + 15000;
      let current;
      do {
        [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.run.id));
        if (["succeeded", "failed", "cancelled"].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      expect(providerExecute).toHaveBeenCalledTimes(blockAfterClaim ? 0 : 1);
      expect(current).toMatchObject({ status: blockAfterClaim ? "cancelled" : "succeeded" });
      if (blockAfterClaim) expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    } finally {
      if (blockAfterClaim) await db.execute(sql`drop trigger block_retry_after_claim on heartbeat_runs; drop function block_retry_after_claim()`);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    }
  }, 30_000);
  it.each([false, true])("runs the assembled heartbeat without overwriting a block after claim: %s", async blockAfterClaim => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.agentId));
    await reconstructNativeWorkspace(f);
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const heartbeat = runningHeartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const successorId = String(action.evidence.continuationRunId);
    expect(successorId).not.toBe("undefined");
    if (blockAfterClaim) await db.execute(sql.raw(`
      create or replace function block_reconstruction_after_claim() returns trigger as $$
      begin
        if NEW.id = '${successorId}'::uuid and NEW.status = 'running' then
          update issues set status = 'blocked' where id = '${f.issueId}'::uuid;
        end if;
        return NEW;
      end; $$ language plpgsql;
      create trigger block_reconstruction_after_claim after update of status on heartbeat_runs
      for each row execute function block_reconstruction_after_claim();
    `));
    try {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await heartbeat.resumeQueuedRuns();
      const deadline = Date.now() + 15000;
      let current;
      do {
        [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
        if (["succeeded", "failed", "cancelled"].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      expect(providerExecute).toHaveBeenCalledTimes(blockAfterClaim ? 0 : 1);
      if (blockAfterClaim) {
        expect(current).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required" });
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
      } else expect(current.status).toBe("succeeded");
    } finally {
      if (blockAfterClaim) await db.execute(sql`drop trigger block_reconstruction_after_claim on heartbeat_runs; drop function block_reconstruction_after_claim()`);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    }
  }, 30_000);
});
