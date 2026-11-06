import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatRunEvents, authUsers, companyMemberships, agents, companies, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, agentWakeupRequests, workspaceOperations, executionWorkspaces } from "@paperclipai/db";
import { requestedRunCancellation } from "./run-cancellation.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { materializeIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { heartbeatService } from "./heartbeat.js";
import { useWorkspaceRecoveryFixture, boardRecoveryApp, db, failedRemotePreparation, fixtureCompanyIds, receiptOnlyRecoveryApp, run } from "./workspace-recovery.test-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it.each(["malformed_worker_stop", "foreign_run_worker_stop", "unstopped_worker", "active_workspace_owner", "delayed_provider_event", "native_input", "session_checkpoint", "session_after", "controller_recovery", "process", "coordinator",
    "runtime_selected", "live_controller", "missing_error", "missing_measurement", "foreign_error", "unknown_result",
    "wrong_snapshot", "wrong_generation", "active_writer", "missing_stop", "foreign_stop", "additional_unstopped_lease",
    "operator_stop", "newer_input", "reassigned", "wrong_actor", "actor_permission_revoked",
    "provider_usage", "unknown_usage", "invalid_ledger_scope", "foreign_ledger_scope",
    "array_usage", "false_usage", "zero_usage", "empty_usage_string", "empty_usage_object",
    "active_lease", "pending_cleanup", "cleanup_failed", "cleanup_unknown", "cleanup_inflight", "unreleased", "foreign_lease_issue", "local_provider_claim"] as const)(
    "holds a failed-preparation HTTP Retry when current proof changes: %s", async gate => {
      const f = await failedRemotePreparation();
      await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      await recoverRetainedWorkspace(f.input);
      const source = await run(f.runId), heartbeat = heartbeatService(db);
      const stoppedWorkerAudit = { v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1",
        sub: "test-stack", stopped: true, iat: 100, exp: 160, runId: f.runId, ownerToken: randomUUID(),
        worker: { provider: "railway", projectId: randomUUID(), environmentId: randomUUID(), serviceId: randomUUID(), deploymentId: randomUUID() } };
      source.runnerProfileJson = { ...source.runnerProfileJson, nativeWorkspaceOwnerStopProof:
        gate === "malformed_worker_stop" ? { stopped: true } : {
          ...stoppedWorkerAudit, ...(gate === "foreign_run_worker_stop" ? { runId: randomUUID() } : {}),
          ...(gate === "unstopped_worker" ? { stopped: false } : {}),
        }, ...(gate === "active_workspace_owner" ? { nativeWorkspaceFinalizationOwner: { token: randomUUID() } } : {}) };
      await db.update(heartbeatRuns).set({ runnerProfileJson: source.runnerProfileJson }).where(eq(heartbeatRuns.id, f.runId));
      const actorId = gate === "actor_permission_revoked" ? randomUUID() : "local-board";
      if (gate === "actor_permission_revoked") {
        await db.insert(authUsers).values({ id: actorId, name: "Retry owner", email: `${actorId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: actorId, membershipRole: "owner" });
      }
      const app = receiptOnlyRecoveryApp({ userId: actorId, source: gate === "actor_permission_revoked" ? "session" : "local_implicit", companyIds: [f.companyId] });
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      if (gate === "delayed_provider_event") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: source.agentId, eventType: "session.started", stream: "system", payload: { sessionId: randomUUID() },
        nativeSource: { sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1, protocolSchemaVersion: 1,
          canonicalPayload: { type: "session.started", sessionId: randomUUID() } } });
      if (["native_input", "session_checkpoint", "controller_recovery"].includes(gate)) {
        const key = gate === "native_input" ? "nativeExecutionInput" : gate === "session_checkpoint" ? "sessionCheckpoint" : "nativeControllerRecovery";
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, [key]: { sessionId: randomUUID() } } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (gate === "process") await db.update(heartbeatRuns).set({ processPid: 1386 }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "session_after") await db.update(heartbeatRuns).set({ sessionIdAfter: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "coordinator") {
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
          issueId: f.issueId, runId: f.runId, phase: "observed", attempt: 1 });
      }
      if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "missing_error" || gate === "missing_measurement") await db.delete(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, gate === "missing_error" ? 1 : 2)));
      if (gate === "foreign_error") {
        const [foreign] = await db.insert(agents).values({ companyId: f.companyId, name: "Other owner", adapterType: "paperclip_runner" }).returning();
        await db.update(heartbeatRunEvents).set({ agentId: foreign.id })
          .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      }
      if (["array_usage", "false_usage", "zero_usage", "empty_usage_string", "empty_usage_object"].includes(gate)) {
        const invalid = gate === "array_usage" ? [] : gate === "false_usage" ? false : gate === "zero_usage" ? 0
          : gate === "empty_usage_string" ? "" : {};
        await db.update(heartbeatRuns).set({ usageJson: sql`${JSON.stringify(invalid)}::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
      }
      if (["provider_usage", "unknown_usage", "invalid_ledger_scope", "foreign_ledger_scope"].includes(gate)) {
        const ledgerScope = { issueId: gate === "foreign_ledger_scope" ? randomUUID() : f.issueId, projectId: null, billingCode: null };
        await db.update(heartbeatRuns).set({ usageJson: gate === "provider_usage" ? { ledgerScope, inputTokens: 0 }
          : gate === "unknown_usage" ? { ledgerScope, unknown: true }
            : { ledgerScope: gate === "invalid_ledger_scope" ? { ...ledgerScope, providerWorkStarted: false } : ledgerScope } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (gate === "unknown_result") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        output: "Unknown provider work must not be replayed" } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "wrong_snapshot") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
        remoteWorkspace: { ...(source.runnerProfileJson!.remoteWorkspace as Record<string, unknown>), snapshotId: randomUUID() } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "wrong_generation") await db.update(workspaceOperations).set({ metadata: sql`jsonb_set(${workspaceOperations.metadata}, '{generation}', '999')` })
        .where(and(eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery")));
      if (gate === "active_writer") await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,writerRunId}', ${JSON.stringify(randomUUID())}::jsonb)` })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      if (gate === "missing_stop" || gate === "foreign_stop") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteExecutionTermination: gate === "missing_stop"
          ? null : { ...(lease.metadata!.remoteExecutionTermination as Record<string, unknown>), runId: randomUUID() } } })
          .where(eq(environmentLeases.id, lease.id));
      }
      if (["active_lease", "pending_cleanup", "cleanup_failed", "cleanup_unknown", "cleanup_inflight", "unreleased", "local_provider_claim"].includes(gate)) {
        await db.update(environmentLeases).set({
          ...(gate === "active_lease" ? { status: "active" } : gate === "pending_cleanup" ? { status: "pending_cleanup" } : {}),
          ...(gate === "cleanup_failed" ? { cleanupStatus: "failed" } : gate === "cleanup_unknown" ? { cleanupStatus: null } : {}),
          ...(gate === "unreleased" ? { releasedAt: null } : {}),
          ...(gate === "cleanup_inflight" ? { metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupInFlight}', 'true')` } : {}),
          ...(gate === "local_provider_claim" ? { provider: "local", providerLeaseId: null,
            metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'` } : {}),
        }).where(eq(environmentLeases.id, f.lease.id));
      }
      if (gate === "foreign_lease_issue") {
        const [foreign] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task", status: "blocked", assigneeAgentId: source.agentId }).returning();
        await db.update(environmentLeases).set({ issueId: foreign.id }).where(eq(environmentLeases.id, f.lease.id));
      }
      if (gate === "additional_unstopped_lease") await db.insert(environmentLeases).values({ companyId: f.companyId,
        issueId: f.issueId, heartbeatRunId: f.runId, environmentId: f.lease.environmentId,
        provider: "daytona", providerLeaseId: randomUUID(), status: "active" });
      if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted",
        resultJson: { ...source.resultJson, cancellation: requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "local-board" }, "Stop requested") } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "newer_input") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
        issueId: f.issueId, contextSnapshot: { issueId: f.issueId, source: "issue.comment.reopen" }, status: "running" });
      if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
      if (gate === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" })
        .where(eq(agentWakeupRequests.id, receipt.requestId));
      if (gate === "actor_permission_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, actorId)));
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await run(f.runId)).error).toBe(source.error);
    }, 30_000);

  it.each(["settled", "active", "provider_handle"] as const)("keeps unsupported mixed local and remote source leases held: %s", async state => {
    const f = await failedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "local", providerLeaseId: state === "provider_handle" ? randomUUID() : null,
      status: state === "active" ? "active" : "released", releasedAt: new Date(), cleanupStatus: "success" });
    const receipt = (await request(boardRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
  }, 30_000);

  it.each(["plain", "unsupported_warning", "warning_presentation", "provider_warning", "measurement"] as const)(
    "keeps the existing-directory readiness settlement contract: %s", async mode => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), sourceRunId = randomUUID(),
      successorRunId = randomUUID(), requestId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Preparation settlement", issuePrefix: `S${companyId.slice(0, 6)}` });
    fixtureCompanyIds.add(companyId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue existing directory", status: "blocked", assigneeAgentId: agentId });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    await writeFile(path.join(cwd, "saved.txt"), "existing task work\n");
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Task directory", cwd }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, issueId));
    const error = "The selected existing task directory has no Git checkout.";
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, issueId, runtimeMode: "legacy",
      status: "failed", finishedAt: new Date(), errorCode: "workspace_validation_failed", error, executionStage: "preparing",
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceValidation: { reason: "git_worktree_base_not_git_checkout", issueId,
          resolvedWorkspaceSource: "task_session", requestedExecutionWorkspaceMode: "isolated_workspace",
          issueExecutionWorkspacePreference: "reuse_existing", issueExecutionWorkspaceId: workspace.id,
          issueProjectId: null, issueProjectWorkspaceId: null, resolvedWorkspaceCwd: cwd } } });
    if (mode.includes("warning")) await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId,
      eventType: "agent_observability.unavailable", level: "warn", stream: "system",
      message: mode === "warning_presentation" ? "Changed presentation" : "Company observability was not applied: this harness is not supported.",
      payload: { reason: "unsupported_harness", revision: randomUUID() },
      ...(mode === "provider_warning" ? { nativeSource: { sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: { type: "agent_observability.unavailable" } } } : {}) });
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId, eventType: "error", level: "error", stream: "system", message: error });
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId: sourceRunId, eventType: "lifecycle", level: "info", stream: "system",
      message: "task.run.measured", payload: { phase: "task.run.measured", outcome: "failed", durationMs: 1, durableSettlement: mode !== "measurement" } });
    const [successor] = await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, issueId, status: "queued",
      contextSnapshot: { issueId, previousRunId: sourceRunId, taskRetryRequestId: requestId } }).returning();
    await db.insert(agentWakeupRequests).values({ id: requestId, companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "task_retry",
      status: "coalesced", runId: successor.id, requestedByActorType: "user", requestedByActorId: "local-board",
      idempotencyKey: `task-retry:${randomUUID()}`, payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1",
        generationId: requestId, sourceRunId, actorId: "local-board", actorSource: "session", strategy: "evaluate" } } });
    const reuse = mode === "plain" || mode === "unsupported_warning";
    expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject(reuse
      ? { mode: "reuse_current_workspace", retryIntentId: requestId, sourceRunId, workspaceId: workspace.id, cwd }
      : { mode: "fresh_isolated_workspace", retryIntentId: requestId, sourceRunId, retainedSourceIds: [] });
    expect(await readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("existing task work\n");
  });

});
