import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { recordNativeLocalProcessStop, hasNativeLocalProcessStop, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  approvals, issueApprovals, issueThreadInteractions,
  agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, environmentLeases, environments, issueRelations, issueTreeHolds, issueTreeHoldMembers,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { heartbeatService, persistHeartbeatRunProcessMetadata, type HeartbeatEnvironmentRuntime } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit native conversation continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("explicit-native-message-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), successorRunId = randomUUID();
    const commentId: string = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explicit turn", defaultResponsibleUserId: "board", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deploy", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      nativeIssueId: issueId, runtimeMode: "native", status: "failed", processPid: 999999999,
      contextSnapshot: { issueId }, finishedAt: new Date("2026-09-11T10:00:00Z") });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId,
      phase: "terminal_failure", attempt: 3, failureDetail: { replacementDenied: "uncertain_external_action" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: sourceRunId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board", body: "What happened?", createdAt: new Date("2026-09-11T11:00:00Z") });
    return { companyId, issueId, agentId, sourceRunId, commentId, successorRunId,
      actorType: "user", actorId: "board", reason: "issue_commented" };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  it.each(["ready", "unacknowledged", "pause", "recovery", "controller", "process_running", "identity_missing", "remote_pending", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"])("delivers a saved native message after run-only Stop exactly once (%s)", async gate => {
    const f = await seed();
    if (gate !== "recovery") await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureDetail: null, leaseOwner: gate === "controller" ? "still-cleaning" : null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    const [source] = await db.update(heartbeatRuns).set({ status: "cancelled",
      processPid: gate === "process_running" ? process.pid : gate === "identity_missing" ? null : 999999999, resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.sourceRunId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatched: true,
        dispatchState: gate === "unacknowledged" ? "requested" : "acknowledged",
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      },
    } }).where(eq(heartbeatRuns.id, f.sourceRunId)).returning();
    // Occupy the agent slot: admission is real, but no provider should launch.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "in_progress" });
    }
    let queuedIds = [f.commentId];
    let expectedIds = queuedIds;
    if (["first_delivered", "last_delivered", "mixed_authors"].includes(gate)) {
      const secondId = randomUUID();
      await db.insert(issueComments).values({ id: secondId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: gate === "mixed_authors" ? "second-author" : "board",
        body: "Keep the earlier direction too.", createdAt: new Date("2026-09-11T09:01:00Z") });
      queuedIds = [f.commentId, secondId];
      expectedIds = gate === "first_delivered" ? [secondId] : gate === "last_delivered" ? [f.commentId] : queuedIds;
      if (gate !== "mixed_authors") await db.update(heartbeatRuns).set({ startedAt: new Date("2026-09-11T09:02:00Z"),
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: gate === "first_delivered" ? [f.commentId] : [secondId] },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "board", payload: {
        issueId: f.issueId, commentId: queuedIds.at(-1), _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: queuedIds.at(-1), wakeCommentIds: queuedIds },
      },
    });
    if (gate.startsWith("remote_")) {
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "owned-sandbox" };
      await db.insert(environmentLeases).values({ ...identity, status: gate === "remote_stopped" ? "released" : "active",
        leasePolicy: "ephemeral", releasedAt: gate === "remote_stopped" ? new Date() : null,
        cleanupStatus: gate === "remote_stopped" ? "success" : null,
        metadata: gate === "remote_stopped" ? { remoteExecutionTermination: remoteTerminationReceipt(identity,
          { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } : {},
      });
    }
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(["ready", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"].includes(gate) ? 1 : 0);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    if (["ready", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"].includes(gate)) {
      expect(wake).toMatchObject({ status: "coalesced", runId: successors[0].id, requestedByActorId: "board" });
      expect(successors[0].contextSnapshot).toMatchObject({ wakeCommentIds: expectedIds });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    } else expect(wake.status).toBe("deferred_issue_execution");
  });
  it.each(["pending", "failed", "historical", "shared", "retained"])("an explicit queued interrupt retries only its stopped sandbox, without granting automatic retries (%s)", async scenario => {
    const fails = scenario === "failed";
    const protectedLease = scenario === "shared" || scenario === "retained";
    const f = await seed(), other = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, processPid: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: f.issueId, commentId: f.commentId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    const identities = [f, other].map(fixture => ({ id: randomUUID(), companyId: fixture.companyId,
      heartbeatRunId: fixture.sourceRunId, provider: "daytona", providerLeaseId: fixture.sourceRunId }));
    for (const identity of identities) await db.insert(environmentLeases).values({ ...identity,
      status: "pending_cleanup", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "failed",
      metadata: { pendingCleanupRetryAttempts: 5, pendingCleanupRetryCapWarned: true } });
    if (scenario === "historical" || protectedLease) await db.update(environmentLeases).set({
      status: "failed", cleanupStatus: "success",
    }).where(eq(environmentLeases.id, identities[0].id));
    if (scenario === "shared") await db.update(environmentLeases).set({
      providerLeaseId: identities[0].providerLeaseId, status: "active", releasedAt: null,
    }).where(eq(environmentLeases.id, identities[1].id));
    if (scenario === "retained") await db.update(environmentLeases).set({
      status: "retained", leasePolicy: "retain_on_failure",
    }).where(eq(environmentLeases.id, identities[0].id));
    const attempted: string[] = [];
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      isPendingCleanupWorkerReady: async () => true,
      retryPendingSandboxTeardown: async ({ lease }: { lease: { id: string; providerLeaseId: string } }) => {
        attempted.push(lease.id);
        if (fails) throw new Error("Provider unavailable");
        return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    try {
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
      expect(attempted).toEqual([]);
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId, { retryCleanup: true });
      expect(attempted).toEqual(protectedLease ? [] : [identities[0].id]);
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
      expect(attempted).toHaveLength(protectedLease ? 0 : 1);
      const [queue] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
      expect(queue.status).toBe(fails || protectedLease ? "deferred_issue_execution" : "coalesced");
      expect(Boolean(queue.runId)).toBe(!fails && !protectedLease);
      const [untouched] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identities[1].id));
      expect(untouched).toMatchObject({ status: scenario === "shared" ? "active" : "pending_cleanup", metadata: { pendingCleanupRetryAttempts: 5 } });
    } finally {
      for (const identity of identities) await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });
  it("a durable queue interrupt authorizes older legacy messages but still requires the provider to stop", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
      processPid: process.pid,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "original-author",
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    const attempt = (queue = queueId) => db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      return admitExplicitNativeContinuation({ ...f, db: tx as unknown as typeof db,
        queuedCommentInterruptId: queue, dryRun: true });
    });
    expect(await attempt()).toBeNull();
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await attempt(randomUUID())).toBeNull();
    expect(await attempt()).toMatchObject({ previousRunId: f.sourceRunId, commentId: f.commentId });
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, queueId));
    expect(await attempt()).toBeNull();
  });
  it("dispatches another user's queued legacy message using the consumed board interrupt receipt", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    // Hold adapter startup so the test can exercise the real dispatch envelope
    // deterministically, without invoking a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: f.issueId, commentId: f.commentId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, queueId);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    expect(receipt.status).toBe("coalesced");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
    const dispatch = (runId = run.id) => buildExecutionContinuation({ db, companyId: f.companyId,
      issueId: f.issueId, agentId: f.agentId, runId, context: run.contextSnapshot!,
      summary: null, exposeLowTrustRaw: false });
    const envelope = await dispatch();
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect(envelope.originCommentIds).toContain(f.commentId);
    expect(envelope.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.commentId, body: "What happened?" })]));
    await expect(dispatch(randomUUID())).rejects.toThrow("continuation_user_authorization_missing");
    for (const patch of [
      { status: "cancelled" }, { runId: f.sourceRunId },
      { payload: { ...receipt.payload, issueId: randomUUID() } },
      { payload: { ...receipt.payload, queuedCommentInterrupt: { actorId: "someone-else" } } },
      { payload: { ...receipt.payload, _paperclipWakeContext: { wakeCommentIds: [] }, commentId: undefined } },
    ]) {
      await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, queueId));
      await expect(dispatch()).rejects.toThrow("continuation_user_authorization_missing");
      await db.update(agentWakeupRequests).set({ status: receipt.status, runId: receipt.runId, payload: receipt.payload })
        .where(eq(agentWakeupRequests.id, queueId));
    }
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence,
      explicitUserContinuation: { ...(action.evidence.explicitUserContinuation as Record<string, unknown>),
        queuedCommentInterruptId: "malformed-historical-receipt" },
    } }).where(eq(issueRecoveryActions.id, action.id));
    await expect(dispatch()).rejects.toThrow("continuation_user_authorization_missing");
  });
  it.each(["valid", "stale_retry_context", "wrong_actor", "wrong_run", "wrong_company", "discarded"])("verifies another author's queued Interrupt at execution setup: %s", async kind => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const queueId = randomUUID();
    const payload = { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
      queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } };
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload });
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, queueId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    expect(wake.status).toBe("coalesced");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    if (kind === "wrong_actor") await db.update(agentWakeupRequests).set({
      payload: { ...payload, queuedCommentInterrupt: { ...payload.queuedCommentInterrupt, actorId: "forged" } },
    }).where(eq(agentWakeupRequests.id, queueId));
    if (kind === "wrong_run") await db.update(agentWakeupRequests).set({ runId: f.sourceRunId })
      .where(eq(agentWakeupRequests.id, queueId));
    if (kind === "wrong_company") await db.update(agentWakeupRequests).set({ companyId: (await seed()).companyId })
      .where(eq(agentWakeupRequests.id, queueId));
    if (kind === "discarded") await db.update(issueComments).set({ deletedAt: new Date() })
      .where(eq(issueComments.id, f.commentId));
    const result = buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: run.id, context: {
        ...run.contextSnapshot, ...(kind === "stale_retry_context" ? { retryOfRunId: randomUUID() } : {}),
      }, summary: null, exposeLowTrustRaw: false });
    if (kind === "valid" || kind === "stale_retry_context") await expect(result).resolves.toMatchObject({ interruptedRunId: f.sourceRunId });
    else await expect(result).rejects.toThrow("continuation_user_authorization_missing");
  });

  it.each(["valid", "wrong_actor", "consumed", "discarded", "operator_stop", "already_delivered", "earlier_delivered", "unstarted_cancelled", "unstarted_cancelled_metadata", "foreign_queue"])("validates automatic saved-message delivery: %s", async kind => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
      status: kind === "operator_stop" ? "cancelled" : "failed",
      contextSnapshot: { issueId: f.issueId, ...(kind === "already_delivered" ? { wakeCommentIds: [f.commentId] } : {}) },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z"),
      ...(kind === "discarded" ? { deletedAt: new Date() } : {}),
    }).where(eq(issueComments.id, f.commentId));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: kind === "consumed" ? "coalesced" : "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: kind === "foreign_queue" ? randomUUID() : f.issueId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] } },
    });
    if (kind.startsWith("unstarted_cancelled")) {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", runtimeMode: "legacy", errorCode: "agent_paused", finishedAt: new Date(),
        ...(kind === "unstarted_cancelled_metadata" ? { nativeIssueId: f.issueId, processPid: 999999999, processGroupId: 999999999 } : {}),
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.commentId] },
      });
    }
    if (kind === "earlier_delivered") {
      const earlierId = randomUUID();
      await db.insert(issueComments).values({ id: earlierId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.actorId, body: "Already handled" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentIds: [earlierId] } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(agentWakeupRequests).set({ payload: { issueId: f.issueId,
        _paperclipWakeContext: { wakeCommentIds: [earlierId, f.commentId] } } })
        .where(eq(agentWakeupRequests.id, queueId));
    }
    const result = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      return admitExplicitNativeContinuation({ ...f, actorId: kind === "wrong_actor" ? "someone-else" : f.actorId,
        db: tx as unknown as typeof db, queuedCommentRequestId: queueId, dryRun: true });
    });
    if (kind === "valid" || kind.startsWith("unstarted_cancelled")) expect(result).toMatchObject({ previousRunId: f.sourceRunId, commentId: f.commentId });
    else expect(result).toBeNull();
  });

  const admit = (f: Fixture, dryRun = false) => db.transaction(async tx => {
    await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
    const result = await admitExplicitNativeContinuation({ ...f, dryRun, db: tx as unknown as typeof db });
    if (result && !dryRun) await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
      agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: result.previousRunId, forceFreshSession: true } });
    return result;
  });
  async function seedCancelledStartup() {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", processPid: null,
      startedAt: new Date("2026-09-11T09:59:59Z"),
      runtimeModeResolvedAt: new Date("2026-09-11T10:00:01Z"),
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date("2026-09-11T10:01:00Z"),
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 0,
      failureDetail: null,
    }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "local", status: "released", releasedAt: new Date("2026-09-11T10:00:02Z"),
      cleanupStatus: "succeeded", leasePolicy: "ephemeral" });
    return f;
  }

  it("settles a cancelled unclaimed coordinator after restart and admits one user successor", async () => {
    const f = await seedCancelledStartup();
    expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId)))[0].phase).toBe("observed");
    const results = await Promise.all([admit(f), admit(f)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", attempt: 0,
      failureCode: "native_startup_cancelled", failureDetail: { replacementDenied: "explicit_user_continuation" } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].status).toBe("cancelled");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId))).toHaveLength(1);
  });

  it("continues native-runner preparation cancelled before runtime selection", async () => {
    const f = await seedCancelledStartup();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: new Date().toISOString() },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await admit(f)).toMatchObject({ previousRunId: f.sourceRunId });
  });

  it.each(["attempt", "generation", "controller", "lease", "process", "launch", "provider", "cleanup", "remote", "preparing", "closed", "reassigned"])(
    "retains cancellation safeguards with %s evidence", async kind => {
      const f = await seedCancelledStartup();
      if (kind === "attempt") await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "generation") await db.update(nativeRunFinalizations).set({ controllerGeneration: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "controller") await db.update(nativeRunFinalizations).set({ controllerBootId: "old-owner" }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "lease") await db.update(nativeRunFinalizations).set({ leaseOwner: "owner", leaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (kind === "launch" || kind === "provider") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: f.sourceRunId, seq: 1,
        eventType: kind === "launch" ? PROCESS_START_REQUESTED : "provider.event",
        ...(kind === "provider" ? { sourceEventId: "provider-1", sourceInstanceId: "provider", sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayloadHash: "hash" } : {}),
      });
      if (kind === "cleanup") await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" }).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
      if (kind === "remote") await db.update(environmentLeases).set({ provider: "daytona", providerLeaseId: "unverified" }).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
      if (kind === "preparing") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (kind === "closed") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      expect(await admit(f)).toBeNull();
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId)))[0].phase).toBe("observed");
      await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    },
  );

  it("preserves local stop proof after process metadata is cleared and invalidates it on another launch", async () => {
    const f = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.transaction(async tx => {
      expect(await recordNativeLocalProcessStop(tx as unknown as typeof db, source)).toBe(true);
      await tx.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, source.id));
    });
    expect(await hasNativeLocalProcessStop(db, f.companyId, source.id)).toBe(true);
    expect(await hasNativeLocalProcessStop(db, randomUUID(), source.id)).toBe(false);
    expect(await admit(f, true)).toMatchObject({ previousRunId: source.id });
    await persistHeartbeatRunProcessMetadata(db, source.id, { pid: 999999999, processGroupId: null, startedAt: new Date().toISOString() });
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, source.id));
    expect(await admit(f, true)).toBeNull();
    expect(await recordNativeLocalProcessStop(db, source)).toBe(true);
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: source.id, agentId: f.agentId,
      eventType: PROCESS_START_REQUESTED });
    // No PID was stored for the new launch, as when the server dies after spawn.
    expect(await admit(f, true)).toBeNull();
  });

  it.each(["live", "remote", "provider_event"])("does not accept invalid local stop proof: %s", async kind => {
    const f = await seed();
    if (kind === "remote") {
      const [environment] = await db.insert(environments).values({ name: "Remote stop", driver: "sandbox" }).returning();
      await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        environmentId: environment.id, provider: "daytona", status: "active", leasePolicy: "ephemeral" });
    }
    if (kind === "live") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "provider_event") {
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: source.id, agentId: f.agentId,
        eventType: "native.local_process_stopped", seq: 1, sourceEventId: randomUUID() });
    } else expect(await recordNativeLocalProcessStop(db, source)).toBe(false);
    expect(await hasNativeLocalProcessStop(db, f.companyId, source.id)).toBe(false);
  });

  it.each(["stopped_process", "cancelled_startup"])("resumes saved local messages after restart exactly once: %s", async kind => {
    const f = kind === "cancelled_startup" ? await seedCancelledStartup() : await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    // A prior cancelled admission is also held, but cannot select the native
    // retry source. The newest blocker must win just as it does on Send.
    const oldAdmissionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: oldAdmissionId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
      finishedAt: new Date("2026-09-11T09:00:00Z") });
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(0), evidence: { runId: oldAdmissionId,
      automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active",
      nextAction: "Waiting for the current run.", evidence: { runId: f.sourceRunId } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.sourceRunId });
    await heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(waiting.payload?.executionWait).toMatchObject({ reason: kind === "cancelled_startup" ? "controller_settling" : "process_running" });
    const makeDue = () => db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, waiting.id));
    await makeDue();
    await heartbeatService(db).resumeExecutionWaitComments();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.transaction(async tx => {
      await recordNativeLocalProcessStop(tx as unknown as typeof db, stopped);
      await tx.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, stopped.id));
    });
    const holdId = randomUUID();
    await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
    await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await makeDue();
      await heartbeatService(db).resumeExecutionWaitComments();
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const [paused] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
    expect(paused.payload?.executionWait).toMatchObject({ reason: "issue_tree_hold_active" });
    await db.update(issueTreeHolds).set({ status: "released" }).where(eq(issueTreeHolds.id, holdId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 0 } } }).where(eq(agents.id, f.agentId));
    for (let attempt = 0; attempt < 2; attempt++) {
      await makeDue();
      await heartbeatService(db).resumeExecutionWaitComments();
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    await makeDue();
    await Promise.all([heartbeatService(db).resumeExecutionWaitComments(), heartbeatService(db).resumeExecutionWaitComments()]);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId,
      explicitUserContinuation: { commentId: f.commentId } });
    const [adopted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
    expect(adopted).toMatchObject({ status: "coalesced", runId: runs[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each(["issue_commented", "retry_failed_run"])("continues a legacy Daytona run lost before adapter.invoke: %s", async reason => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: null,
      errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [environment] = await db.insert(environments).values({ name: `Daytona startup ${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "startup-sandbox" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
      status: "released", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity,
        { providerLeaseId: identity.providerLeaseId, state: "destroyed" }) } });
    const result = await db.transaction(tx => admitExplicitNativeContinuation({ ...f, reason,
      commentId: reason === "issue_commented" ? f.commentId : null,
      failedRunId: reason === "retry_failed_run" ? f.sourceRunId : null,
      db: tx as unknown as typeof db }));
    expect(result).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.resultJson).toBeNull();
  });

  it.each(["claim", "invocation"])("does not convert a known process run after switching the agent to Claude: %s", async evidence => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "process_lost",
      runnerProfileJson: evidence === "claim" ? { adapterDispatch: { adapterType: "process" } } : null,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (evidence === "invocation") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.sourceRunId, agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "process" } });
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(await admit(f)).toBeNull();
    expect(await admitExplicitNativeContinuation({ ...f, db, reason: "retry_failed_run",
      commentId: null, failedRunId: f.sourceRunId })).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps failed remote cleanup blocked even after the lease release timestamp is recorded", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: null,
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [environment] = await db.insert(environments).values({ name: `Cleanup ${f.sourceRunId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: "still-running",
      status: "pending_cleanup", releasedAt: new Date(), cleanupStatus: "failed", leasePolicy: "ephemeral" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ cause: "execution_owner_active" });
    await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
  });

  it("retries exhausted cleanup only for the selected failed run and adopts concurrent Retry clicks", async () => {
    const f = await seed(), other = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const identities = [f, other].map(fixture => ({ id: randomUUID(), companyId: fixture.companyId,
      heartbeatRunId: fixture.sourceRunId, provider: "daytona", providerLeaseId: fixture.sourceRunId }));
    for (const identity of identities) await db.insert(environmentLeases).values({ ...identity,
      status: "pending_cleanup", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "failed",
      metadata: { pendingCleanupRetryAttempts: 5, pendingCleanupRetryCapWarned: true } });
    const destroyed: string[] = [];
    let readyCount = 0;
    let bothReady!: () => void;
    const ready = new Promise<void>(resolve => { bothReady = resolve; });
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      isPendingCleanupWorkerReady: async () => { if (++readyCount === 2) bothReady(); await ready; return true; },
      retryPendingSandboxTeardown: async ({ lease }: { lease: { id: string; providerLeaseId: string } }) => {
        destroyed.push(lease.id);
        return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId,
      requestedByActorType: "user" as const, requestedByActorId: "board", payload: { issueId: f.issueId } };
    try {
      const [first, second] = await Promise.all([heartbeat.wakeup(f.agentId, request), heartbeat.wakeup(f.agentId, request)]);
      // A losing cleanup claim can still see the hold until the winner finishes;
      // a subsequent click adopts the already admitted successor.
      const successor = first ?? second;
      expect(successor?.id).toBeTruthy();
      expect((await heartbeat.wakeup(f.agentId, request))?.id).toBe(successor?.id);
      expect(destroyed).toEqual([identities[0].id]);
      const [untouched] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identities[1].id));
      expect(untouched).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupRetryAttempts: 5 } });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    } finally {
      for (const identity of identities) await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });

  it("allows a later user cleanup attempt after transient failure without resetting automatic retries", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: f.sourceRunId };
    await db.insert(environmentLeases).values({ ...identity, status: "pending_cleanup", leasePolicy: "ephemeral",
      releasedAt: new Date(), cleanupStatus: "failed", metadata: { pendingCleanupRetryAttempts: 5 } });
    let attempts = 0;
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown: async () => {
        if (++attempts < 3) throw new Error("provider temporarily unavailable");
        return { providerLeaseId: identity.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId, requestedByActorType: "user" as const,
      requestedByActorId: "board", payload: { issueId: f.issueId } };
    try {
      expect(await heartbeat.wakeup(f.agentId, request)).toBeNull();
      expect(attempts).toBe(1);
      expect(await heartbeat.wakeup(f.agentId, request)).toBeNull();
      expect(attempts).toBe(2);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      await heartbeat.sweepPendingCleanupLeases();
      expect(attempts).toBe(2);
      const successor = await heartbeat.wakeup(f.agentId, request);
      expect(attempts).toBe(3);
      expect(successor?.retryOfRunId).toBe(f.sourceRunId);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await heartbeat.wakeup(f.agentId, request))?.id).toBe(successor?.id);
      expect(attempts).toBe(3);
    } finally {
      await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });

  it("queues one exact Retry with fresh history and adopts repeated clicks", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const service = heartbeatService(db);
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId,
      requestedByActorType: "user" as const, requestedByActorId: "board", payload: { issueId: f.issueId } };
    const [first, second] = await Promise.all([service.wakeup(f.agentId, request), service.wakeup(f.agentId, request)]);
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    expect(first).toMatchObject({ retryOfRunId: f.sourceRunId,
      contextSnapshot: { previousRunId: f.sourceRunId, forceFreshSession: true } });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: first!.id, context: first!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: randomUUID(), context: first!.contextSnapshot!, summary: null, exposeLowTrustRaw: false }))
      .rejects.toThrow("continuation_user_authorization_missing");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each([true, false])("acknowledges a legacy remote Stop only after confirmed lease cleanup: %s", async confirmed => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", processPid: null,
      resultJson: { executionCancellation: { state: "requested" } },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.sourceRunId,
      agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_local" } });
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [environment] = await db.insert(environments).values({ name: `Remote ${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "sandbox-legacy" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: confirmed ? { remoteExecutionTermination: remoteTerminationReceipt(identity,
        { providerLeaseId: identity.providerLeaseId, state: "destroyed" }) } : {},
    });
    await heartbeatService(db).releaseEnvironmentLeasesForRun({ runId: f.sourceRunId,
      companyId: f.companyId, agentId: f.agentId, status: "cancelled" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(run.resultJson?.executionCancellation).toMatchObject({ state: confirmed ? "acknowledged" : "requested" });
    if (confirmed) expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    else expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it.each(["stopped", "destroyed", "missing", "wrong_lease", "cleanup_failed", "active"])(
    "admits a remote native predecessor only with confirmed termination: %s", async kind => {
      const f = await seed();
      // This PID exists on the control-plane host. It must never be used to
      // infer liveness of the identically numbered remote process.
      await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const [environment] = await db.insert(environments).values({ name: `Remote ${f.sourceRunId}`, driver: "sandbox" }).returning();
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "sandbox-1" };
      const proof = remoteTerminationReceipt(identity, { providerLeaseId: "sandbox-1",
        state: kind === "destroyed" ? "destroyed" : "stopped" });
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
        issueId: f.issueId, status: kind === "active" ? "active" : "released", leasePolicy: "ephemeral",
        releasedAt: kind === "active" ? null : new Date(), cleanupStatus: kind === "cleanup_failed" ? "failed" : "success",
        metadata: kind === "missing" ? {} : { remoteExecutionTermination:
          kind === "wrong_lease" ? { ...proof, providerLeaseId: "other-sandbox" } : proof },
      });
      const result = await admit(f);
      if (["stopped", "destroyed"].includes(kind)) expect(result).toMatchObject({ previousRunId: f.sourceRunId });
      else expect(result).toBeNull();
    },
  );

  it.each([
    { runtime: "native", retry: false }, { runtime: "native", retry: true },
    { runtime: "legacy", retry: false }, { runtime: "legacy", retry: true },
    { runtime: "legacy_startup", retry: false }, { runtime: "legacy_startup", retry: true },
  ])("resumes a user message after confirmed cleanup: %j", async ({ runtime, retry }) => {
    const f = await seed();
    if (runtime.startsWith("legacy")) {
      await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", processPid: null,
        resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (runtime === "legacy_startup") {
        await db.update(heartbeatRuns).set({ status: "failed", resultJson: null, errorCode: "process_lost" })
          .where(eq(heartbeatRuns.id, f.sourceRunId));
      } else await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.sourceRunId,
        agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_local" } });
      await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
        .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    }
    // Keep the successor queued so this test never starts an actual provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const [environment] = await db.insert(environments).values({ name: `pending-${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "pending-sandbox" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id, status: "active", leasePolicy: "ephemeral" });
    const heartbeat = heartbeatService(db, retry ? { environmentRuntime: {
      retryPendingSandboxTeardown: async () => ({ providerLeaseId: identity.providerLeaseId, state: "destroyed" }),
    } as unknown as HeartbeatEnvironmentRuntime } : {});
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeat.resumeRemoteStopComments(source);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    if (retry) {
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" })
        .where(eq(environmentLeases.id, identity.id));
      expect(await heartbeat.sweepPendingCleanupLeases()).toMatchObject({ destroyed: 1 });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identity.id));
      expect(lease.metadata?.remoteExecutionTermination).toMatchObject({ runId: f.sourceRunId, state: "destroyed" });
    } else {
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity,
          { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, identity.id));
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: source.id, companyId: source.companyId,
        agentId: source.agentId, status: source.status });
    }
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    if (runtime !== "legacy") expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId,
      explicitUserContinuation: { commentId: f.commentId } });
    else expect(runs[0].contextSnapshot).toMatchObject({ wakeCommentId: f.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("queues the actual user wake with a fresh session and retained source context", async () => {
    const f = await seed();
    // Occupy this agent's only slot so this admission test never starts a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toMatchObject({ status: "queued", retryOfRunId: null,
      contextSnapshot: { forceFreshSession: true, previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId: f.sourceRunId, commentId: f.commentId } } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toMatchObject({ runId: wake!.id });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: wake!.contextSnapshot!, summary: "Deployment completed.", exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect(envelope.objective).toBe("What happened?");
    expect(envelope.completedWork).toBe("Deployment completed.");
  });

  it.each(["pause", "dependency", "state"])("keeps the existing %s gate on the actual user wake", async gate => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    } else if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Required approval", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    }
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board",
      ...(gate === "state" ? { issueStateGuard: { statuses: ["todo"], assigneeAgentId: f.agentId } } : {}),
      payload: { issueId: f.issueId, commentId: f.commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    if (gate === "pause" || gate === "state") {
      expect(wake).toBeNull();
      expect(action.evidence.explicitUserContinuation).toBeUndefined();
    } else {
      expect(wake).toMatchObject({ contextSnapshot: { dependencyBlockedInteraction: true, unresolvedBlockerCount: 1 } });
      expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.companyId))).toHaveLength(1);
    }
  });

  it("preflights eligibility without retiring the hold or creating a successor", async () => {
    const f = await seed();
    expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId))).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toBeUndefined();
  });
  it("retains the message receipt without a phantom run when ownership is still live", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toBeNull();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", requestedByActorId: "board", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it("lets a new human message continue after exhausted recovery without certifying old actions", async () => {
    const f = await seed();
    expect(await admit(f)).toEqual({ previousRunId: f.sourceRunId, commentId: f.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence).toMatchObject({ automaticRecovery: { actionOutcome: "unknown" }, explicitUserContinuation: { runId: f.successorRunId, commentId: f.commentId } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.status).toBe("failed");
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator.attempt).toBe(3);
    expect(coordinator.failureDetail?.replacementDenied).toBe("explicit_user_continuation");
  });
  it.each(["live_process", "missing_process", "lease", "coordinator", "successor", "agent_message", "old_comment", "wrong_author", "run_authored", "reassigned", "automatic", "approval", "question", "malformed_comment", "legacy_owner"])("keeps the hold for %s", async kind => {
    const f = await seed();
    if (kind === "legacy_owner") await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: f.agentId, status: "failed", runtimeMode: "legacy", processPid: process.pid,
      contextSnapshot: { issueId: f.issueId }, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    if (kind === "live_process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "missing_process") await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: "active-controller" }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "successor") await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: randomUUID() } }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "lease") {
      const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const environmentId = environment.id;
      await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId, heartbeatRunId: f.sourceRunId, issueId: f.issueId, status: "active", leasePolicy: "ephemeral", provider: "local" });
    }
    if (kind === "question") await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] },
    });
    if (kind === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    if (kind === "malformed_comment") f.commentId = "not-a-uuid";
    if (kind === "agent_message") f.actorType = "agent";
    if (kind === "automatic") f.reason = "issue_continuation_needed";
    if (kind === "wrong_author") f.actorId = "someone-else";
    if (kind === "run_authored") await db.update(issueComments).set({ createdByRunId: f.sourceRunId }).where(eq(issueComments.id, f.commentId));
    if (kind === "old_comment") await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") }).where(eq(issueComments.id, f.commentId));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await admit(f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it.each(["foreign_source", "missing_authorization", "nonterminal_source"])("rejects unverified interruption context: %s", async kind => {
    const f = await seed();
    let previousRunId: string = f.sourceRunId;
    if (kind === "foreign_source") previousRunId = (await seed()).sourceRunId;
    if (kind === "nonterminal_source") {
      await admit(f);
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: { previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId, commentId: f.commentId } },
      summary: null, exposeLowTrustRaw: false })).rejects.toThrow("continuation_user_authorization_missing");
  });
  it("keeps one new turn under concurrent delivery of the same message", async () => {
    const f = await seed();
    const results = await Promise.all([admit(f), admit(f)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
  });
  it("retains the source incident through prior rejected message admissions", async () => {
    const f = await seed(), rejectedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: rejectedRunId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
      finishedAt: new Date("2026-09-11T10:30:00Z") });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: rejectedRunId,
      status: "resolved", outcome: "blocked", nextAction: "Could not start", evidence: { runId: rejectedRunId, automaticRecovery: { replay: "blocked" } } });
    expect(await admit(f)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
