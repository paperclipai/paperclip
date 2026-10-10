import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordLegacyWorkspaceRestoreFailure, legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { hasConversationContinuationPolicy, conversationRecoveryActionPredicate } from "../services/conversation-continuation.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../services/legacy-workspace-restore-recovery.js";
import { hasConfirmedSandboxStopAndRetain, prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { environmentService } from "../services/environments.js";
import { hasRequiredWorkspaceRecovery } from "../services/workspace-restore-recovery-state.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy remote workspace recovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else { temporary = await startEmbeddedPostgresTestDatabase("legacy-workspace-recovery-"); db = createDb(temporary.connectionString); } }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function seed(options: { local?: boolean; taskDone?: boolean; reusable?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace recovery", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Restore files", status: options.taskDone ? "done" : "in_progress", assigneeAgentId: agentId });
    const [project] = await db.insert(projects).values({ companyId, name: "Workspace project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id,
      sourceIssueId: issueId, mode: "isolated", strategyType: "git_worktree", name: "Fixture workspace", cwd: "/work/fixture",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId, executionWorkspaceId: workspace.id },
    }).returning();
    if (options.local) await db.insert(environments).values({ name: "Local", driver: "local" }).onConflictDoNothing();
    const [environment] = options.local ? await db.select().from(environments).where(eq(environments.driver, "local"))
      : await db.insert(environments).values({ name: `Isolated test sandbox ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, executionWorkspaceId: workspace.id, heartbeatRunId: runId, environmentId: environment.id,
      status: "active", leasePolicy: options.reusable ? "reuse_by_environment" : "ephemeral",
      provider: options.local ? "local" : "daytona", providerLeaseId: randomUUID(),
      metadata: { remoteCwd: "/work/fixture", workspaceRealization: { authoritativeRoot: "/work/fixture" }, driver: options.local ? "local" : "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: !options.local },
    }).returning();
    return { companyId, runId, issueId, run, lease };
  }
  const patch = { errorCode: "workspace_restore_failed", finishedAt: new Date(), resultJson: {
    workspaceRestoreFailure: "restore_failed", conversationContinuation: "continue_conversation_v1",
  } };
  const readLease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0];

  async function stopAndRetain(f: Awaited<ReturnType<typeof seed>>, retry = false) {
    let stopping = (await prepareSandboxStopAndRetain(db, f.lease))!;
    expect(stopping.status).toBe("pending_cleanup");
    if (retry) {
      [stopping] = await db.update(environmentLeases).set({ metadata: {
        ...stopping.metadata, pendingCleanupAttemptId: randomUUID(),
      } }).where(eq(environmentLeases.id, f.lease.id)).returning();
    }
    const stopped = (await settleStopOnlyCleanup(db, stopping, {
      attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.lease.providerLeaseId, state: "stopped" },
    }))!;
    expect(stopped.status).toBe("released");
    return stopped;
  }

  it.each([false, true])("persists terminal status, stop-only source and board action atomically (task done=%s)", async taskDone => {
    const f = await seed({ taskDone, reusable: true });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...f.run, status: "failed", ...patch })).toBe(true);
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(failed?.status).toBe("failed");
    expect(failed?.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [f.lease.id] });
    expect(hasConversationContinuationPolicy(failed?.resultJson)).toBe(false);
    const lease = await readLease(f.lease.id);
    expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: {
      sandboxStopAndRetain: { companyId: f.companyId, runId: f.runId, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId },
      pendingCleanupInFlight: false,
    } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action).toMatchObject({ ownerType: "board", evidence: { workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, action.id), conversationRecoveryActionPredicate()))).toEqual([]);
    // A new controller uses the durable stop-only intent. It cannot turn a
    // successful stop into proof that the workspace files were restored.
    const receipt = { schema: "paperclip.remote-termination.v1", runId: f.runId, companyId: f.companyId,
      leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() };
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId), receipt });
    expect(await readLease(lease.id)).toMatchObject({ status: "released", leasePolicy: "retain_on_failure", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(hasRequiredWorkspaceRecovery(failed?.resultJson)).toBe(true);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, failed!)).toBe(true);
    // A late adapter metadata write cannot erase the source pin when its
    // in-memory result predates the terminal transaction.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...failed!, resultJson: patch.resultJson })).toBe(true);
    const repeated = await terminalizeLegacyExecution({ db, run: failed!, status: "failed", patch });
    expect(repeated?.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [f.lease.id] });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))).toHaveLength(1);
  });

  it("records the exact stopped source when provider cancellation finishes before copy-back", async () => {
    const f = await seed({ taskDone: true });
    const stopping = await prepareSandboxStopAndRetain(db, f.lease);
    expect(stopping).not.toBeNull();
    const stopped = await settleStopOnlyCleanup(db, stopping!, {
      attemptId: String(stopping!.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.lease.providerLeaseId, state: "stopped" },
    });
    expect(stopped?.status).toBe("released");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { executionCancellation: { state: "acknowledged" } },
    }).where(eq(heartbeatRuns.id, f.runId));
    // This is the lease captured by the host before invoking the adapter.
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("cancelled");
    expect(run.resultJson?.executionCancellation).toEqual({ state: "acknowledged" });
    expect(run.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [f.lease.id] });
    const retained = await readLease(f.lease.id);
    expect(retained).toMatchObject({ status: "released", leasePolicy: "retain_on_failure", cleanupStatus: "success",
      releasedAt: stopped!.releasedAt, metadata: { remoteExecutionTermination: stopped!.metadata!.remoteExecutionTermination,
        sandboxStopAndRetainReceipt: stopped!.metadata!.sandboxStopAndRetainReceipt } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked", ownerType: "board",
      evidence: { automaticRecovery: { replay: "blocked" }, workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
    // A lost commit response can cause the exact adapter receipt to be recorded twice.
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    const repeated = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ id: action.id, status: "resolved", outcome: "blocked", attemptCount: 1,
      evidence: { automaticRecovery: { replay: "blocked" }, workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    expect(await readLease(f.lease.id)).toEqual(retained);
  });

  it.each(["retry", "builtin"])("keeps the original stop proof after %s dispatch", async scenario => {
    const f = await seed();
    if (scenario === "builtin") {
      [f.lease] = await db.update(environmentLeases).set({ provider: "fake", metadata: {
        driver: "sandbox", remoteCwd: "/work/fixture",
      } }).where(eq(environmentLeases.id, f.lease.id)).returning();
    }
    const stopped = await stopAndRetain(f, scenario === "retry");
    if (scenario === "retry") expect((stopped.metadata!.sandboxStopAndRetainReceipt as Record<string, unknown>).requestId)
      .not.toBe(stopped.metadata!.pendingCleanupAttemptId);
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure", status: "released",
      metadata: { sandboxStopAndRetainReceipt: stopped.metadata!.sandboxStopAndRetainReceipt } });
  });

  it.each(["id", "companyId", "heartbeatRunId", "environmentId", "issueId", "executionWorkspaceId", "provider", "providerLeaseId", "acquiredAt", "pluginId", "remoteCwd", "workspaceRealization"])(
    "rejects a stopped source with a different original %s", async field => {
      const f = await seed();
      const stopped = await stopAndRetain(f);
      const source = { ...f.lease, metadata: { ...f.lease.metadata } };
      if (["pluginId", "remoteCwd", "workspaceRealization"].includes(field)) source.metadata[field] = "different-original-value";
      else if (field === "acquiredAt") source.acquiredAt = new Date(source.acquiredAt.getTime() - 1);
      else Object.assign(source, { [field]: randomUUID() });
      await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, source);
      expect(await readLease(f.lease.id)).toEqual(stopped);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    },
  );

  it.each(["missing_dedicated", "missing_termination", "destroyed", "foreign_receipt", "wrong_plugin", "wrong_method", "empty_request", "invalid_time", "before_acquisition", "after_release", "unequal_confirmation", "pending_intent", "cleanup_in_flight", "expired_allocation", "missing_release_time", "retained_without_stop", "failed_cleanup"])(
    "does not infer retention from %s", async scenario => {
      const f = await seed();
      const stopped = await stopAndRetain(f);
      const metadata = structuredClone(stopped.metadata!);
      const dedicated = metadata.sandboxStopAndRetainReceipt as Record<string, unknown>;
      const termination = metadata.remoteExecutionTermination as Record<string, unknown>;
      if (scenario === "missing_dedicated") delete metadata.sandboxStopAndRetainReceipt;
      if (scenario === "missing_termination") delete metadata.remoteExecutionTermination;
      if (scenario === "destroyed") termination.state = "destroyed";
      if (scenario === "foreign_receipt") dedicated.runId = randomUUID();
      if (scenario === "wrong_plugin") dedicated.pluginId = randomUUID();
      if (scenario === "wrong_method") dedicated.method = "environmentReleaseLease";
      if (scenario === "empty_request") dedicated.requestId = "   ";
      if (scenario === "invalid_time") dedicated.confirmedAt = termination.confirmedAt = "not-a-time";
      if (scenario === "before_acquisition") dedicated.confirmedAt = termination.confirmedAt = new Date(stopped.acquiredAt.getTime() - 1).toISOString();
      if (scenario === "after_release") dedicated.confirmedAt = termination.confirmedAt = new Date(stopped.releasedAt!.getTime() + 1).toISOString();
      if (scenario === "unequal_confirmation") dedicated.confirmedAt = new Date(stopped.releasedAt!.getTime() - 1).toISOString();
      if (scenario === "pending_intent") metadata.sandboxStopAndRetain = {};
      if (scenario === "cleanup_in_flight") metadata.pendingCleanupInFlight = true;
      const [invalid] = await db.update(environmentLeases).set({ metadata,
        ...(scenario === "retained_without_stop" ? { status: "retained" } : {}),
        ...(scenario === "expired_allocation" ? { expiresAt: new Date(stopped.acquiredAt.getTime() - 1) } : {}),
        ...(scenario === "missing_release_time" ? { releasedAt: null } : {}),
        ...(scenario === "failed_cleanup" ? { cleanupStatus: "failed" } : {}),
      }).where(eq(environmentLeases.id, f.lease.id)).returning();
      await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
      expect(await readLease(f.lease.id)).toEqual(invalid);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    },
  );

  it("rejects invalid lease timestamps instead of treating receipt metadata as proof", async () => {
    const f = await seed();
    const stopped = await stopAndRetain(f);
    expect(hasConfirmedSandboxStopAndRetain(stopped)).toBe(true);
    for (const field of ["acquiredAt", "releasedAt", "expiresAt"] as const) {
      expect(hasConfirmedSandboxStopAndRetain({ ...stopped, [field]: new Date(Number.NaN) })).toBe(false);
    }
  });

  it.each(["missing_root", "empty_root", "invalid_realized_root", "run_workspace_mismatch"])(
    "requires the original execution root after %s", async scenario => {
      const f = await seed();
      const metadata = { ...f.lease.metadata };
      if (scenario === "missing_root") delete metadata.remoteCwd;
      if (scenario === "empty_root") metadata.remoteCwd = "  ";
      if (scenario === "invalid_realized_root") metadata.workspaceRealization = { authoritativeRoot: " " };
      [f.lease] = await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.lease.id)).returning();
      if (scenario === "run_workspace_mismatch") await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...f.run.contextSnapshot, executionWorkspaceId: randomUUID(),
      } }).where(eq(heartbeatRuns.id, f.runId));
      const stopped = await stopAndRetain(f);
      await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
      expect(await readLease(f.lease.id)).toEqual(stopped);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    },
  );

  it("does not search arbitrary stopped leases when the original host snapshot is missing", async () => {
    const f = await seed();
    const stopped = await stopAndRetain(f);
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    expect(await readLease(f.lease.id)).toEqual(stopped);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it.each(["active", "stopped"])("rejects a competing %s allocation owner across companies", async state => {
    const f = await seed(), other = await seed();
    const stopped = await stopAndRetain(f);
    [other.lease] = await db.update(environmentLeases).set({ providerLeaseId: f.lease.providerLeaseId,
      acquiredAt: new Date(f.lease.acquiredAt.getTime() + 1),
    }).where(eq(environmentLeases.id, other.lease.id)).returning();
    if (state === "stopped") await stopAndRetain(other);
    const competing = await readLease(other.lease.id);
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    expect(await readLease(f.lease.id)).toEqual(stopped);
    expect(await readLease(other.lease.id)).toEqual(competing);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("does not claim a released reusable source from a stop receipt that may precede resume", async () => {
    const f = await seed({ reusable: true });
    const stopped = await stopAndRetain(f);
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    expect(await readLease(f.lease.id)).toEqual(stopped);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it.each(["original_reusable", "current_reusable", "expired", "root_rebound", "run_rebound"])(
    "leaves a stopped source unchanged after %s", async scenario => {
      const f = await seed({ reusable: scenario === "original_reusable" });
      const other = await seed();
      const stopped = await stopAndRetain(f);
      const [changed] = await db.update(environmentLeases).set({
        ...(scenario === "original_reusable" ? { leasePolicy: "ephemeral" } : {}),
        ...(scenario === "current_reusable" ? { leasePolicy: "reuse_by_environment" } : {}),
        ...(scenario === "expired" ? { status: "expired" } : {}),
        ...(scenario === "root_rebound" ? { metadata: { ...stopped.metadata, remoteCwd: "/work/replacement" } } : {}),
        ...(scenario === "run_rebound" ? { heartbeatRunId: other.runId } : {}),
      }).where(eq(environmentLeases.id, f.lease.id)).returning();
      await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
      expect(await readLease(f.lease.id)).toEqual(changed);
      expect(await readLease(other.lease.id)).toEqual(other.lease);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    },
  );

  it("does not adopt the expired source when a normal reusable handoff wins first", async () => {
    const f = await seed({ reusable: true });
    await stopAndRetain(f);
    const newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newerRunId, companyId: f.companyId, agentId: f.run.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId } });
    // The production handoff also checks the immutable task/agent scope.
    [f.lease] = await db.update(environmentLeases).set({ metadata: {
      ...(await readLease(f.lease.id)).metadata, agentId: f.run.agentId,
    } }).where(eq(environmentLeases.id, f.lease.id)).returning();
    const newer = await environmentService(db).acquireLease({ companyId: f.companyId,
      environmentId: f.lease.environmentId!, issueId: f.issueId, executionWorkspaceId: f.lease.executionWorkspaceId, heartbeatRunId: newerRunId,
      leasePolicy: "reuse_by_environment", provider: f.lease.provider!, providerLeaseId: f.lease.providerLeaseId,
      metadata: { ...f.lease.metadata, agentId: f.run.agentId }, replacesReusableLeaseId: f.lease.id,
    });
    const expired = await readLease(f.lease.id);
    expect(expired.status).toBe("expired");
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    expect(await readLease(f.lease.id)).toEqual(expired);
    expect(await readLease(newer.id)).toEqual(newer);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("rolls back the stopped-source hold and action if recording cannot commit", async () => {
    const f = await seed();
    const stopped = await stopAndRetain(f);
    await expect(db.transaction(async tx => {
      await recordLegacyWorkspaceRestoreFailure(tx as unknown as typeof db, f.run, patch.resultJson, f.lease);
      throw new Error("recording transaction failed");
    })).rejects.toThrow("recording transaction failed");
    expect(await readLease(f.lease.id)).toEqual(stopped);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("preserves newer task execution while retaining only the original stopped source", async () => {
    const f = await seed(), newerRunId = randomUUID();
    await stopAndRetain(f);
    await db.insert(heartbeatRuns).values({ id: newerRunId, companyId: f.companyId, agentId: f.run.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: newerRunId, checkoutRunId: newerRunId }).where(eq(issues.id, f.issueId));
    const [newerLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: newerRunId, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", leasePolicy: "ephemeral", metadata: { driver: "sandbox", pluginId: randomUUID() },
    }).returning();
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson, f.lease);
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure" });
    expect(await readLease(newerLease.id)).toEqual(newerLease);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "in_progress", executionRunId: newerRunId, checkoutRunId: newerRunId });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
  });

  it("leaves local lock retry and successful remote cleanup policy unchanged", async () => {
    const local = await seed({ local: true });
    const failure = { ...patch, resultJson: { ...patch.resultJson, workspaceRestoreFailure: "restore_lock_timeout" } };
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...local.run, status: "failed", ...failure })).toBe(false);
    expect(await readLease(local.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    const remote = await seed();
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...remote.run, status: "succeeded", resultJson: {} })).toBe(false);
    expect(await readLease(remote.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
  });

  it("does not retain another run's lease or revive an already released source", async () => {
    const f = await seed(), other = await seed();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, { ...f.run, status: "failed", ...patch })).toBe(false);
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "released", leasePolicy: "ephemeral" });
    expect(await readLease(other.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
  });

  it("keeps a competing physical owner out of the stop receipt", async () => {
    const f = await seed(), other = await seed();
    await db.update(environmentLeases).set({ providerLeaseId: f.lease.providerLeaseId }).where(eq(environmentLeases.id, other.lease.id));
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", metadata: { sandboxStopAndRetain: { runId: f.runId } } });
    expect(await readLease(other.lease.id)).toMatchObject({ status: "active", heartbeatRunId: other.runId });
  });


  it("keeps the original source if host finalization fails after adapter settlement", async () => {
    const f = await seed();
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(current.status).toBe("running");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
    expect(hasRequiredWorkspaceRecovery(current.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    // A restart's process-loss finalization sees the durable obligation, even
    // when its own result predates the restore failure.
    const stale = { stopReason: "process_lost" };
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", reconcileIfNeeded: true, patch: { errorCode: "process_lost", resultJson: stale } });
    expect(hasRequiredWorkspaceRecovery(failed?.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(hasConversationContinuationPolicy(failed?.resultJson)).toBe(false);
  });


  it("records a repair action when cancellation wins before adapter copy-back reports failure", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: { executionCancellation: { state: "acknowledged", proof: "provider_termination_receipt" } } }).where(eq(heartbeatRuns.id, f.runId));
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("cancelled");
    expect(run.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "provider_termination_receipt" });
    expect(hasRequiredWorkspaceRecovery(run.resultJson)).toBe(true);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
  });

  it.each(["write_condition", "native_takeover"])("preserves the existing terminal-write fence for %s", async scenario => {
    const f = await seed();
    if (scenario === "native_takeover") await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.runId));
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch,
      reconcileIfNeeded: true, ...(scenario === "write_condition" ? { writeConditions: [sql`false`] } : {}),
    });
    expect(failed).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it.each([false, true])("keeps exact retained source IDs through a projected metadata update (merge=%s)", async mergeCurrent => {
    const f = await seed();
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const projection = { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" }, presentationDecision: "updated" };
    const [updated] = await db.update(heartbeatRuns).set({ resultJson: preserveWorkspaceRestoreRecoveryMetadataSql(projection, mergeCurrent) })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    expect(updated.resultJson).toMatchObject({ presentationDecision: "updated", workspaceRestoreRecovery: run.resultJson!.workspaceRestoreRecovery });
    expect(updated.resultJson?.workspaceRestoreFailure).toBe("restore_failed");
  });

  it("keeps ordinary metadata replacement and null semantics without a repair marker", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { oldValue: true } }).where(eq(heartbeatRuns.id, f.runId));
    const [replaced] = await db.update(heartbeatRuns).set({ resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({ newValue: true }) })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    expect(replaced.resultJson).toEqual({ newValue: true });
    const [cleared] = await db.update(heartbeatRuns).set({ resultJson: preserveWorkspaceRestoreRecoveryMetadataSql(null) })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    expect(cleared.resultJson).toBeNull();
  });

  it("rolls back terminal status and retention together on a failed transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run: f.run, status: "failed", patch }); throw new Error("outer transaction failed"); })).rejects.toThrow("outer transaction failed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });  it.each(["conversation_reset", "new_owner"])("late restore remains repair-blocked after %s", async scenario => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 },
      resultJson: { executionCancellation: { state: "acknowledged" }, conversationContinuation: "continue_conversation_v1" },
    }).where(eq(heartbeatRuns.id, f.runId));
    if (scenario === "conversation_reset") await db.update(issues).set({ conversationAgentId: f.run.agentId, conversationUserId: "board-review-fixture", conversationState: "active",
      conversationSessionGeneration: scenario === "conversation_reset" ? 1 : 0,
    }).where(eq(issues.id, f.issueId));
    if (scenario === "new_owner") {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId: f.companyId, name: "New owner", role: "engineer", adapterType: "codex_local" });
      await db.update(issues).set({ assigneeAgentId: id }).where(eq(issues.id, f.issueId));
    }
    await recordLegacyWorkspaceRestoreFailure(db, f.run, patch.resultJson);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(hasRequiredWorkspaceRecovery(run.resultJson)).toBe(true);
    const lease = await readLease(f.lease.id);
    expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: lease.providerLeaseId, state: "stopped" } });
    const { getExecutionBlocker } = await import("../services/execution-blocker.js");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: expect.any(String), canRetry: false, canContinue: false,
    });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toHaveLength(1);
  });

  it("keeps a late source hold alongside a newer incident without replacing its execution", async () => {
    const f = await seed(), newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newerRunId, companyId: f.companyId, agentId: f.run.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: newerRunId, checkoutRunId: newerRunId }).where(eq(issues.id, f.issueId));
    const [newerAction] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", cause: "another_incident", fingerprint: `newer:${newerRunId}`,
      evidence: { runId: newerRunId }, nextAction: "Inspect the current incident." }).returning();
    const failed = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", patch });
    await terminalizeLegacyExecution({ db, run: failed!, status: "failed", patch });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "in_progress", executionRunId: newerRunId, checkoutRunId: newerRunId });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions).toHaveLength(2);
    expect(actions.find(a => a.id === newerAction.id)).toEqual(newerAction);
    const source = actions.find(a => a.evidence.runId === f.runId)!;
    expect(source).toMatchObject({ status: "resolved", outcome: "blocked", ownerType: "board",
      returnOwnerAgentId: null, attemptCount: 1, evidence: { automaticRecovery: { replay: "blocked" } } });
    const { markExecutionReconciliation } = await import("../services/execution-recovery-resolution.js");
    await markExecutionReconciliation(db, source, { runId: f.runId, providerStopped: true, actionOutcome: "mixed",
      outcomeEvidence: "The original provider's actions were inspected.",
      workspaceRepairEvidence: "The exact retained workspace was recovered and verified.",
    }, "board-test", undefined, { workspaceRepairOnly: true });
    await terminalizeLegacyExecution({ db, run: failed!, status: "failed", patch });
    const [repaired] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, source.id));
    expect(repaired.evidence.automaticRecovery).toBeUndefined();
    expect(repaired.evidence.continuationDelivery).toBe("not_requested");
    expect(repaired.evidence.executionReconciliation).toMatchObject({ runId: f.runId });
  });

});
