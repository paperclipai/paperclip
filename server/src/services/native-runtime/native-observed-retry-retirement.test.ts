import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { retireSupersededNativeRetry } from "./native-superseded-retry.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("superseded observed workspace recovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-observed-retirement-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const oldRunId = randomUUID(), oldWorkspaceId = randomUUID(), oldLeaseId = randomUUID();
    const retryId = randomUUID(), successorId = randomUUID(), failedPreparationId = randomUUID();
    const snapshotId = randomUUID(), successorLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Observed recovery", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ name: `Observed ${oldRunId}`, driver: "sandbox" }).returning();
    const oldRemote = { schema: "paperclip.remote-workspace-run.v1", state: "prepared", epoch: 3,
      workspaceId: oldWorkspaceId, leaseId: oldLeaseId, providerLeaseId: randomUUID(), remoteCwd: "/old/work", snapshotId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "observed", processPid: 424242,
      startedAt: new Date(1), finishedAt: new Date(2), contextSnapshot: { issueId },
      errorCode: "configuration_incomplete", resultJson: { originalDiagnostic: true }, runnerProfileJson: { remoteWorkspace: oldRemote } });
    await db.insert(nativeRunFinalizations).values({ runId: oldRunId, companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner: "expired-controller", leaseExpiresAt: new Date(3), recoveryState: "awaiting_runner_reattach" });
    await db.insert(executionWorkspaces).values({ id: oldWorkspaceId, companyId, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "shared_existing", name: "Retained source", providerType: "cloud_sandbox",
      cwd: oldRemote.remoteCwd, metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3,
        dirty: true, writerRunId: oldRunId, source: { kind: "empty" }, snapshotId: oldRemote.snapshotId,
        location: { environmentId: environment.id, leaseId: oldLeaseId, providerLeaseId: oldRemote.providerLeaseId, remoteCwd: oldRemote.remoteCwd } } } });
    await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId: environment.id,
      issueId, heartbeatRunId: oldRunId, executionWorkspaceId: oldWorkspaceId, provider: "daytona",
      providerLeaseId: oldRemote.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { remoteCwd: oldRemote.remoteCwd, agentId } });
    await db.insert(heartbeatRuns).values({ id: failedPreparationId, companyId, agentId, issueId,
      runtimeMode: "legacy", status: "failed", errorCode: "setup_failed", startedAt: new Date(4), finishedAt: new Date(5) });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", criteria: [] }, canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "test" }).returning();
    const successorRemote = { ...oldRemote, state: "saved", epoch: 1, workspaceId: retryId,
      leaseId: successorLeaseId, providerLeaseId: randomUUID(), remoteCwd: "/new/work", snapshotId };
    await db.insert(heartbeatRuns).values({ id: successorId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "succeeded", nativePhase: "committed", completionContractId: contract.id,
      startedAt: new Date(7), finishedAt: new Date(8), retryOfRunId: failedPreparationId,
      contextSnapshot: { issueId, previousRunId: failedPreparationId, taskRetryRequestId: retryId, executionWorkspaceId: retryId },
      runnerProfileJson: { remoteWorkspace: successorRemote } });
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: successorId,
      completionContractId: contract.id, serverFingerprint: randomUUID(), schemaStatus: "accepted", canonicalSha256: randomUUID(),
      resultJson: { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Changes saved; wait for CI." } } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: successorId, companyId, issueId, phase: "committed", resultId: result.id });
    await db.insert(agentWakeupRequests).values({ id: retryId, companyId, agentId, reason: "task_retry", source: "on_demand",
      status: "coalesced", runId: successorId, requestedByActorType: "user", requestedByActorId: "owner", requestedAt: new Date(6),
      payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1", generationId: retryId, sourceRunId: failedPreparationId,
        actorId: "owner", actorSource: "session", strategy: "fresh_isolated_workspace" } } });
    await db.insert(executionWorkspaces).values({ id: retryId, companyId, sourceIssueId: issueId, cwd: "/new/work",
      mode: "isolated_workspace", strategyType: "isolated_directory", name: "Explicit retry", providerType: "cloud_sandbox",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, dirty: false, writerRunId: null,
        source: { kind: "empty" }, snapshotId, location: { environmentId: environment.id, leaseId: successorLeaseId,
          providerLeaseId: successorRemote.providerLeaseId, remoteCwd: "/new/work" } } } });
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId: retryId,
      sourceRunId: successorId, sourceOperationId: randomUUID(), generation: 1, epoch: 1, status: "committed",
      objectKey: "test/saved-work", sha256: "a".repeat(64), byteSize: 100, manifestDigest: "b".repeat(64) });
    await db.update(issues).set({ executionWorkspaceId: retryId, workspaceBindingRevision: 2 }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, oldRunId, oldWorkspaceId, oldLeaseId, retryId, successorId, failedPreparationId,
      snapshotId, resultId: result.id, contractId: contract.id, oldRemote, successorRemote };
  }

  const recover = (f: Awaited<ReturnType<typeof fixture>>, owner = db) => claimNativeRestartRecoveries({
    db: owner, runIds: [f.oldRunId], restartKind: "hard" });
  const task = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const source = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const coordinator = async (id: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, id)))[0]!;
  const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;

  it("hands an expired observed source to preservation after an explicit isolated retry commits", async () => {
    const f = await fixture(); const beforeTask = await task(f.issueId);
    expect(await recover(f)).toEqual([{ kind: "blocked", runId: f.oldRunId, reason: "native_retry_superseded" }]);
    expect(await coordinator(f.oldRunId)).toMatchObject({ phase: "terminal_failure", resultId: null, leaseOwner: null,
      failureCode: "native_retry_superseded", failureDetail: { successorRunId: f.successorId } });
    expect(await source(f.oldRunId)).toMatchObject({ status: "failed", processPid: 424242,
      runnerProfileJson: { remoteWorkspace: f.oldRemote }, resultJson: { originalDiagnostic: true,
        workspaceRestoreRecovery: { leaseIds: [f.oldLeaseId] } } });
    expect(await task(f.issueId)).toEqual(beforeTask);
    expect((await workspace(f.oldWorkspaceId)).metadata?.remoteWorkspace).toMatchObject({ dirty: true, writerRunId: f.oldRunId });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.oldLeaseId));
    expect(lease).toMatchObject({ providerLeaseId: f.oldRemote.providerLeaseId, status: "pending_cleanup",
      leasePolicy: "retain_on_failure", cleanupStatus: "failed", metadata: { sandboxStopAndRetain: {
        runId: f.oldRunId, leaseId: f.oldLeaseId,
      } } });
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId)))).toHaveLength(1);
    await recover(f);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(3);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
  });

  it.each(["live_owner", "unknown_owner_deadline", "current_execution", "dirty_successor", "pending_result",
    "missing_result", "non_user_retry", "changed_actor", "changed_retry_source", "foreign_agent", "foreign_workspace", "same_workspace",
    "changed_source_allocation", "changed_source_cwd", "changed_source_writer", "expired_source", "missing_snapshot",
    "changed_snapshot_epoch", "active_successor", "accepted_source"] as const)("preserves authority when proof is incomplete: %s", async scenario => {
    const f = await fixture();
    if (scenario === "live_owner") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.oldRunId));
    if (scenario === "unknown_owner_deadline") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.oldRunId));
    if (scenario === "current_execution") await db.update(issues).set({ executionRunId: f.oldRunId }).where(eq(issues.id, f.issueId));
    if (scenario === "dirty_successor" || scenario === "changed_source_writer") {
      const id = scenario === "dirty_successor" ? f.retryId : f.oldWorkspaceId;
      const row = await workspace(id);
      await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, remoteWorkspace: {
        ...(row.metadata?.remoteWorkspace as object), ...(scenario === "dirty_successor" ? { dirty: true } : { writerRunId: randomUUID() }),
      } } }).where(eq(executionWorkspaces.id, id));
    }
    if (scenario === "pending_result" || scenario === "missing_result") await db.update(nativeRunFinalizations)
      .set(scenario === "pending_result" ? { phase: "retryable_failure" } : { resultId: null })
      .where(eq(nativeRunFinalizations.runId, f.successorId));
    if (scenario === "non_user_retry") await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, f.retryId));
    if (scenario === "changed_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" }).where(eq(agentWakeupRequests.id, f.retryId));
    if (scenario === "changed_retry_source") await db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: f.issueId, previousRunId: randomUUID(), taskRetryRequestId: f.retryId,
    } }).where(eq(heartbeatRuns.id, f.successorId));
    if (scenario === "foreign_agent") {
      const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "paperclip_runner" }).returning();
      await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.successorId));
    }
    if (scenario === "foreign_workspace") {
      const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: randomUUID().slice(0, 8) }).returning();
      await db.update(executionWorkspaces).set({ companyId: other.id }).where(eq(executionWorkspaces.id, f.retryId));
    }
    if (scenario === "same_workspace") await db.update(issues).set({ executionWorkspaceId: f.oldWorkspaceId }).where(eq(issues.id, f.issueId));
    if (scenario === "changed_source_allocation") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.oldLeaseId));
    if (scenario === "changed_source_cwd") await db.update(environmentLeases).set({ metadata: { remoteCwd: "/other/work" } }).where(eq(environmentLeases.id, f.oldLeaseId));
    if (scenario === "expired_source") await db.update(environmentLeases).set({ expiresAt: new Date(1) }).where(eq(environmentLeases.id, f.oldLeaseId));
    if (scenario === "missing_snapshot") await db.update(executionWorkspaceSnapshots).set({ status: "delete_requested" }).where(eq(executionWorkspaceSnapshots.id, f.snapshotId));
    if (scenario === "changed_snapshot_epoch") await db.update(executionWorkspaceSnapshots).set({ epoch: 2 }).where(eq(executionWorkspaceSnapshots.id, f.snapshotId));
    if (scenario === "active_successor") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "queued" });
    if (scenario === "accepted_source") {
      await db.update(heartbeatRuns).set({ completionContractId: f.contractId }).where(eq(heartbeatRuns.id, f.oldRunId));
      await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.oldRunId,
        completionContractId: f.contractId, serverFingerprint: randomUUID(), schemaStatus: "accepted", canonicalSha256: randomUUID(),
        resultJson: { result: { summary: "Awaiting result persistence" } } });
    }
    const before = { run: await source(f.oldRunId), coordinator: await coordinator(f.oldRunId), task: await task(f.issueId),
      lease: (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.oldLeaseId)))[0] };
    expect(await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const [owner] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.oldRunId)).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.oldRunId)).for("update");
      return retireSupersededNativeRetry(tx as unknown as typeof db, { run, coordinator: owner,
        issueExecutionRunId: issue.executionRunId, now: new Date() });
    })).toBe(false);
    expect(await source(f.oldRunId)).toEqual(before.run);
    expect(await coordinator(f.oldRunId)).toEqual(before.coordinator);
    expect(await task(f.issueId)).toEqual(before.task);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.oldLeaseId)))[0]).toEqual(before.lease);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it("rolls back retirement and its preservation obligation together", async () => {
    const f = await fixture(); const before = { run: await source(f.oldRunId), coordinator: await coordinator(f.oldRunId),
      workspace: await workspace(f.oldWorkspaceId) };
    await expect(db.transaction(async tx => {
      expect(await recover(f, tx as unknown as typeof db)).toEqual([{ kind: "blocked", runId: f.oldRunId, reason: "native_retry_superseded" }]);
      expect((await coordinator(f.oldRunId)).phase).toBe("observed");
      throw new Error("rollback retirement");
    })).rejects.toThrow("rollback retirement");
    expect(await source(f.oldRunId)).toEqual(before.run);
    expect(await coordinator(f.oldRunId)).toEqual(before.coordinator);
    expect(await workspace(f.oldWorkspaceId)).toEqual(before.workspace);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it("keeps the coordinator held if recording the file obligation fails", async () => {
    const f = await fixture(); const before = { run: await source(f.oldRunId), coordinator: await coordinator(f.oldRunId), task: await task(f.issueId) };
    const trigger = sql.identifier(`reject_observed_preservation_${f.oldRunId.replaceAll("-", "")}`);
    await db.execute(sql`create function ${trigger}() returns trigger language plpgsql as $$
      begin
        if new.id = '${sql.raw(f.oldRunId)}'::uuid and new.result_json ? 'workspaceRestoreRecovery' then
          raise exception 'preservation storage unavailable';
        end if;
        return new;
      end;
    $$`);
    await db.execute(sql`create trigger ${trigger} before update on heartbeat_runs for each row execute function ${trigger}()`);
    try {
      expect(await recover(f)).toMatchObject([{ kind: "awaiting_evidence", runId: f.oldRunId, reason: "restart_recovery_failed" }]);
      expect(await source(f.oldRunId)).toEqual(before.run);
      expect(await coordinator(f.oldRunId)).toEqual(before.coordinator);
      expect(await task(f.issueId)).toEqual(before.task);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger ${trigger} on heartbeat_runs`);
      await db.execute(sql`drop function ${trigger}()`);
    }
  });

  it("defers a locked source workspace before changing coordinator ownership", async () => {
    const f = await fixture(); const before = await coordinator(f.oldRunId);
    let unlock!: () => void, ready!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.oldWorkspaceId)).for("update");
      ready(); await released;
    });
    await acquired;
    try {
      expect(await recover(f)).toMatchObject([{ kind: "awaiting_evidence", runId: f.oldRunId, reason: "restart_recovery_failed" }]);
      expect(await coordinator(f.oldRunId)).toEqual(before);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    } finally { unlock(); await holding; }
    expect(await recover(f)).toEqual([{ kind: "blocked", runId: f.oldRunId, reason: "native_retry_superseded" }]);
  });
});
