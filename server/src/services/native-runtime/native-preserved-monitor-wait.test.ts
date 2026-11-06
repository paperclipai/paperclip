import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, subscribeDatabaseWork, workspaceOperations, workAssessments } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "./native-run-finalizer.js";
import { nativeSha256 } from "./canonical.js";
import * as monitorDelivery from "./native-monitor-delivery.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { heartbeatService } from "../heartbeat.js";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PRESERVED_MONITOR_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("released native monitor results", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("native-preserved-monitor-");
    db = createDb(external ?? temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Saved monitor", issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved follow-up", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const nextCheckAt = new Date(Date.now() + 3_600_000).toISOString();
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: {
      idempotencyKey: "saved-monitor", monitor: { nextCheckAt, notes: "Check the saved result." },
    } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test" });
    const result = { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
      summary: "Wait for the saved check.", completionClaim: { contractRevision: "test", objectiveSatisfied: false,
        criteria: [], remainingWork: [{ description: "Check again", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the check", idempotencyKey: "provider-selected" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
    const finishedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt, completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted", resultJson: result });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", resultId });
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const readIssue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const finalize = (workspaceFinalizeStatus: "succeeded" | "failed" = "succeeded") => finalizeNativeRun({
      db, runId, workspaceFinalizeStatus, projectRunStatus: true,
    });
    return { companyId, agentId, issueId, runId, resultId, result, finishedAt, nextCheckAt, readIssue, finalize };
  }

  it.each(["original", "rescheduled", "past_due"])("keeps the saved monitor and settles a released successful result (%s)", async state => {
    const f = await fixture();
    if (state !== "original") {
      const issue = await f.readIssue();
      const nextCheckAt = state === "past_due" ? "2020-01-01T01:00:00Z" : new Date(Date.now() + 7_200_000).toISOString();
      await db.update(issues).set({ monitorNextCheckAt: new Date(nextCheckAt), executionPolicy: {
        ...issue.executionPolicy, monitor: { ...(issue.executionPolicy?.monitor as Record<string, unknown>), nextCheckAt },
      } }).where(eq(issues.id, f.issueId));
    }
    const issueBefore = await f.readIssue();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      status: "active", ownerType: "board", nextAction: "Preserve independent recovery.", evidence: { runId: randomUUID() },
    }).returning();
    await f.finalize();
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator.phase).toBe("committed");
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decisions.at(-1)).toMatchObject({ reasonCode: "scheduled_monitor_preserved", toStatus: issueBefore.status });
    expect(decisions.at(-1)?.decisionJson).toMatchObject({ effects: [] });
    expect(await f.readIssue()).toMatchObject({ status: issueBefore.status, executionPolicy: issueBefore.executionPolicy,
      monitorNextCheckAt: issueBefore.monitorNextCheckAt, monitorAttemptCount: issueBefore.monitorAttemptCount,
      executionRunId: null, checkoutRunId: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].finishedAt).toEqual(f.finishedAt);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id))).toEqual([hold]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual([{ id: f.runId }]);
    await f.finalize();
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toEqual(decisions);
  });

  it.each(["cleared", "owner", "checkout", "other_agent", "no_receipt", "foreign_receipt", "unfinished", "failed_source", "quota", "workspace_failed",
    "cancellation", "nativeCancellation", "executionCancellation", "startupCancellation"])(
    "does not settle a released monitor without current proof (%s)", async state => {
      const f = await fixture();
      const issue = await f.readIssue();
      if (state === "cleared") await db.update(issues).set({ monitorNextCheckAt: null, executionPolicy: {} }).where(eq(issues.id, f.issueId));
      if (state === "quota") await db.update(issues).set({ executionPolicy: { ...issue.executionPolicy,
        monitor: { ...(issue.executionPolicy?.monitor as Record<string, unknown>), serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME },
      } }).where(eq(issues.id, f.issueId));
      if (state === "other_agent") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      if (state === "owner" || state === "checkout") {
        const [owner] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
        await db.update(issues).set(state === "owner" ? { executionRunId: owner!.id } : { checkoutRunId: owner!.id }).where(eq(issues.id, f.issueId));
      }
      if (state === "unfinished") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
      if (state === "failed_source") await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
      if (state === "no_receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      if (["cancellation", "nativeCancellation", "executionCancellation", "startupCancellation"].includes(state)) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, [state]: { state: "pending" } } }).where(eq(heartbeatRuns.id, f.runId));
      }
      if (state === "foreign_receipt") await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
        invalid: { operationId: "set_task_monitor", result: { taskId: randomUUID(), monitor: { status: "scheduled", nextCheckAt: f.nextCheckAt } } },
      } } }).where(eq(heartbeatRuns.id, f.runId));
      const before = await f.readIssue();
      await f.finalize(state === "workspace_failed" ? "failed" : "succeeded");
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(coordinator.phase).toBe("retryable_failure");
      expect(await f.readIssue()).toMatchObject({ executionPolicy: before.executionPolicy, monitorNextCheckAt: before.monitorNextCheckAt,
        executionRunId: before.executionRunId, checkoutRunId: before.checkoutRunId, assigneeAgentId: before.assigneeAgentId });
      expect(await db.select().from(statusDecisions).where(and(eq(statusDecisions.runId, f.runId), eq(statusDecisions.reasonCode, "scheduled_monitor_preserved")))).toEqual([]);
    },
  );

  it.each(["schedule", "receipt", "finished_time"] as const)("supersedes an earlier authority error after restoring %s without replaying the result", async state => {
    const f = await fixture(), scheduled = await f.readIssue();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), attempt: 1 })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (state === "schedule") await db.update(issues).set({ executionPolicy: {}, monitorNextCheckAt: null }).where(eq(issues.id, f.issueId));
    if (state === "receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    if (state === "finished_time") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    await f.finalize();
    const old = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(old.some(decision => decision.reasonCode === "monitor_wait_authority_lost")).toBe(true);
    if (state === "schedule") await db.update(issues).set({ executionPolicy: scheduled.executionPolicy, monitorNextCheckAt: scheduled.monitorNextCheckAt })
      .where(eq(issues.id, f.issueId));
    if (state === "receipt") {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...current.resultJson,
        semanticToolReceipts: source.resultJson?.semanticToolReceipts } }).where(eq(heartbeatRuns.id, f.runId));
    }
    if (state === "finished_time") await db.update(heartbeatRuns).set({ finishedAt: f.finishedAt }).where(eq(heartbeatRuns.id, f.runId));
    await f.finalize();
    const [settled] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(settled).toMatchObject({ phase: "committed", nextAttemptAt: null, attempt: 1 });
    const after = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    for (const before of old) expect(after.find(decision => decision.id === before.id)).toEqual(before);
    expect(after.some(decision => decision.reasonCode === "scheduled_monitor_preserved")).toBe(true);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    expect(await f.readIssue()).toMatchObject({ monitorNextCheckAt: scheduled.monitorNextCheckAt,
      executionRunId: null, checkoutRunId: null });
    await f.finalize();
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toEqual(after);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].finishedAt).toEqual(f.finishedAt);
  });

  it("makes the saved deadline eligible after finalization commits without replaying the result", async () => {
    const f = await fixture();
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    const observedDeadlines: Promise<number | null>[] = [];
    expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(true);
    expect(await scheduler.nextIssueMonitorAt()).toBeNull();
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.issueMonitors, event => {
      if (event === "settled") observedDeadlines.push(scheduler.nextIssueMonitorAt());
    });
    try {
      await f.finalize();
      const deadline = new Date(f.nextCheckAt).getTime();


      expect(await Promise.all(observedDeadlines)).toContain(deadline);
      expect(await scheduler.nextIssueMonitorAt()).toBe(deadline);
      expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(false);
      const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
      await f.finalize();
      expect(await scheduler.nextIssueMonitorAt()).toBe(deadline);
      expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toEqual(decisions);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    } finally {
      unsubscribe();
      await Promise.all(observedDeadlines);
    }
  });

  it.each(["live", "recovered"])("publishes the accepted monitor explanation once (%s)", async mode => {
    const f = await fixture(), before = await f.readIssue();
    const completionContractSha256 = `sha256:${nativeSha256({ revision: "test", criteria: [] })}`;
    const canonicalSha256 = `sha256:${nativeSha256({ ...f.result, turnId: null })}`;
    const serverFingerprint = `sha256:${nativeSha256({ runId: f.runId, completionContractSha256, canonicalSha256 })}`;
    await db.update(nativeRunResults).set({ canonicalSha256, serverFingerprint }).where(eq(nativeRunResults.id, f.resultId));
    await db.update(heartbeatRuns).set({ completionContractSha256,
      contextSnapshot: { issueId: f.issueId, ...(mode === "recovered" ? { skipIssueComment: true } : {}) },
    }).where(eq(heartbeatRuns.id, f.runId));
    const comments = () => db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments)
      .where(and(eq(issueComments.companyId, f.companyId), eq(issueComments.createdByRunId, f.runId)));
    const repair = () => repairCommittedNativeChatResponse(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId });
    await f.finalize();
    if (mode === "recovered") {
      expect(await comments()).toEqual([]);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
      expect(await repair()).toBe(true);
    }
    const published = await comments();
    expect(published).toEqual([{ id: expect.any(String), body: f.result.result.summary }]);
    expect(await repair()).toBe(false);
    await f.finalize();
    expect(await comments()).toEqual(published);
    expect((await f.readIssue()).monitorNextCheckAt).toEqual(before.monitorNextCheckAt);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
  });

  async function newerUserRequest(state: "queued" | "consumed", existing?: Awaited<ReturnType<typeof fixture>>) {
    const f = existing ?? await fixture();
    if (!existing) await db.update(issues).set({ status: "blocked", statusVersion: 5 }).where(eq(issues.id, f.issueId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Continue with the new objective." }).returning();
    const successorId = state === "consumed" ? randomUUID() : null;
    if (successorId) await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", errorCode: "native_continuation_requires_reconciliation",
      contextSnapshot: { issueId: f.issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        executionContinuation: { companyId: f.companyId, issueId: f.issueId,
          objectiveSource: { kind: "comment", id: comment!.id, revision: comment!.updatedAt.toISOString() },
          resumeDelta: { baseRunId: f.runId } } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_reopened_via_comment", requestedByActorType: "user", requestedByActorId: "operator",
      status: successorId ? "failed" : "queued", runId: successorId,
      payload: { issueId: f.issueId, commentId: comment!.id,
        _paperclipWakeContext: { issueId: f.issueId, wakeCommentId: comment!.id, wakeCommentIds: [comment!.id] } },
    }).returning();
    if (successorId) await db.update(heartbeatRuns).set({ wakeupRequestId: wake!.id }).where(eq(heartbeatRuns.id, successorId));
    if (!existing) await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.runId));
    return { f, comment: comment!, wake: wake!, successorId };
  }

  it.each(["queued", "consumed", "owned_successor", "new_monitor"] as const)("settles the old saved monitor result without changing a newer user request (%s)", async state => {
    const { f, comment, wake, successorId } = await newerUserRequest(state === "queued" ? "queued" : "consumed");
    if (state === "owned_successor") {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successorId!));
      await db.update(issues).set({ executionRunId: successorId, checkoutRunId: successorId }).where(eq(issues.id, f.issueId));
    }
    if (state === "new_monitor") {
      const task = await f.readIssue(), nextCheckAt = new Date(Date.now() + 7_200_000);
      await db.update(issues).set({ monitorNextCheckAt: nextCheckAt, executionPolicy: { ...task.executionPolicy,
        monitor: { ...(task.executionPolicy?.monitor as Record<string, unknown>), nextCheckAt: nextCheckAt.toISOString() } } })
        .where(eq(issues.id, f.issueId));
    }
    expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(true);
    const before = await f.readIssue();
    await f.finalize();
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "committed", nextAttemptAt: null, failureCode: null, attempt: 2 });
    expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(false);
    expect(await heartbeatService(db, { runtimeEnv: {} }).tickIssueMonitors(new Date(Date.parse(f.nextCheckAt) + 1)))
      .toMatchObject({ triggered: 0 });
    expect(await f.readIssue()).toMatchObject({ status: before.status, statusVersion: before.statusVersion,
      assigneeAgentId: before.assigneeAgentId, assigneeUserId: before.assigneeUserId,
      executionRunId: before.executionRunId, checkoutRunId: before.checkoutRunId,
      executionPolicy: before.executionPolicy, monitorNextCheckAt: before.monitorNextCheckAt,
      monitorAttemptCount: before.monitorAttemptCount, workMode: before.workMode });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([wake]);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, comment!.id))).toEqual([comment]);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.runId))).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "succeeded", finishedAt: f.finishedAt });
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decisions.at(-1)?.decisionJson).toMatchObject({ effects: [] });
    await f.finalize();
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toEqual(decisions);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].attempt).toBe(2);
  });

  it.each(["queued", "consumed"] as const)("reconstructs and settles a historical monitor error through the real finalization reconciler (%s)", async state => {
    const f = await fixture();
    await db.update(issues).set({ status: "blocked", statusVersion: 5 }).where(eq(issues.id, f.issueId));
    await f.finalize();
    const [prior] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(prior).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost" });
    const oldAssessment = await db.select().from(workAssessments).where(eq(workAssessments.id, prior.assessmentId!));
    const oldDecision = await db.select().from(statusDecisions).where(eq(statusDecisions.id, prior.decisionId!));
    expect(oldAssessment).toHaveLength(1);
    expect(oldDecision).toHaveLength(1);
    const { comment, wake, successorId } = await newerUserRequest(state, f);
    let hold: typeof issueRecoveryActions.$inferSelect | undefined;
    if (successorId) {
      const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
        ownerType: "board", nextAction: "Recover the current user request.", evidence: { runId: successorId }, supersedeOnIdentityChange: true });
      [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    }
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null,
      controllerBootId: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.runId));
    const before = await f.readIssue();
    const results = await reconcileNativeFinalizations(db, [f.runId]);
    expect(results).toContainEqual(expect.objectContaining({ runId: f.runId, phase: "committed" }));
    const [settled] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(settled).toMatchObject({ phase: "committed", failureCode: null, nextAttemptAt: null });
    expect(settled.assessmentId).not.toBe(prior.assessmentId);
    const [assessment] = await db.select().from(workAssessments).where(eq(workAssessments.id, settled.assessmentId!));
    expect(assessment).toMatchObject({ supersedesAssessmentId: prior.assessmentId, resultId: f.resultId,
      assessmentJson: { supersededMonitorWait: { agentId: f.agentId, resultId: f.resultId,
        commentId: comment.id, wakeId: wake.id, successorRunId: successorId } } });
    expect(await db.select().from(workAssessments).where(eq(workAssessments.id, prior.assessmentId!))).toEqual(oldAssessment);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.id, prior.decisionId!))).toEqual(oldDecision);
    expect(await hasPendingRunCleanup(db, f.companyId, f.runId)).toBe(false);
    expect(await f.readIssue()).toMatchObject({ status: before.status, statusVersion: before.statusVersion,
      executionPolicy: before.executionPolicy, monitorNextCheckAt: before.monitorNextCheckAt,
      executionRunId: before.executionRunId, checkoutRunId: before.checkoutRunId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([wake]);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, comment.id))).toEqual([comment]);
    if (hold) expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id))).toEqual([hold]);
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decisions.at(-1)?.toStatus).toBe(before.status);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
  });

  it.each(["missing_wake", "actor", "foreign_task", "foreign_company", "untrusted_comment", "deleted_comment", "edited_comment",
    "prior_comment", "foreign_run", "foreign_base", "wrong_objective", "cancelled_request", "source_stop", "missing_monitor_receipt",
    "workspace_failed"])("keeps the old monitor held without exact newer user-request proof (%s)", async state => {
      const consumed = ["foreign_run", "foreign_base", "wrong_objective"].includes(state);
      const { f, comment, wake, successorId } = await newerUserRequest(consumed ? "consumed" : "queued");
      if (state === "missing_wake") await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      if (state === "actor") await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, wake.id));
      if (state === "foreign_task") await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, issueId: randomUUID() } })
        .where(eq(agentWakeupRequests.id, wake.id));
      if (state === "foreign_company") {
        const other = await fixture();
        await db.update(agentWakeupRequests).set({ companyId: other.companyId, agentId: other.agentId })
          .where(eq(agentWakeupRequests.id, wake.id));
      }
      if (state === "untrusted_comment") await db.update(issueComments).set({ sourceTrust: { preset: "low_trust_review", disposition: "quarantined" } }).where(eq(issueComments.id, comment.id));
      if (state === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
      if (state === "edited_comment") await db.update(issueComments).set({ updatedAt: new Date(comment.createdAt.getTime() + 1) }).where(eq(issueComments.id, comment.id));
      if (state === "prior_comment") await db.update(issueComments).set({ createdAt: new Date(f.finishedAt.getTime() - 1),
        updatedAt: new Date(f.finishedAt.getTime() - 1) }).where(eq(issueComments.id, comment.id));
      if (state === "foreign_run") {
        const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task", status: "blocked" }).returning();
        const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          nativeIssueId: otherIssue!.id, runtimeMode: "native", status: "failed", wakeupRequestId: wake.id,
          contextSnapshot: { issueId: otherIssue!.id } }).returning();
        await db.update(agentWakeupRequests).set({ runId: otherRun!.id }).where(eq(agentWakeupRequests.id, wake.id));
      }
      if (state === "foreign_base" || state === "wrong_objective") await db.update(heartbeatRuns).set({ contextSnapshot:
        sql`jsonb_set(${heartbeatRuns.contextSnapshot}, ${state === "foreign_base" ? "{executionContinuation,resumeDelta,baseRunId}" : "{executionContinuation,objectiveSource,id}"}::text[], ${JSON.stringify(randomUUID())}::jsonb)` })
        .where(eq(heartbeatRuns.id, successorId!));
      if (state === "cancelled_request") await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wake.id));
      if (state === "source_stop") await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation}', '{"state":"pending"}'::jsonb)` })
        .where(eq(heartbeatRuns.id, f.runId));
      if (state === "missing_monitor_receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      const before = await f.readIssue();
      await f.finalize(state === "workspace_failed" ? "failed" : "succeeded");
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(coordinator.phase).toBe("retryable_failure");
      expect(await f.readIssue()).toMatchObject({ status: before.status, executionPolicy: before.executionPolicy,
        monitorNextCheckAt: before.monitorNextCheckAt, executionRunId: before.executionRunId, checkoutRunId: before.checkoutRunId });
      expect(await db.select().from(statusDecisions).where(and(eq(statusDecisions.runId, f.runId),
        eq(statusDecisions.reasonCode, "scheduled_monitor_superseded")))).toEqual([]);
    });

  it.each(["comment", "wake", "lineage", "source_stop"])("rechecks newer user-request proof under the task lock (%s)", async state => {
    const { f, comment, wake, successorId } = await newerUserRequest("consumed");
    const original = monitorDelivery.readNativeSupersededMonitorWait;
    const race = vi.spyOn(monitorDelivery, "readNativeSupersededMonitorWait").mockImplementationOnce(async (...args) => {
      const proof = await original(...args);
      expect(proof).not.toBeNull();
      if (state === "comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
      if (state === "wake") await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wake.id));
      if (state === "lineage") await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, successorId!));
      if (state === "source_stop") await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation}', '{"state":"pending"}'::jsonb)` })
        .where(eq(heartbeatRuns.id, f.runId));
      return proof;
    });
    try { await f.finalize(); } finally { race.mockRestore(); }
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("retryable_failure");
    expect(await db.select().from(statusDecisions).where(and(eq(statusDecisions.runId, f.runId),
      eq(statusDecisions.reasonCode, "scheduled_monitor_superseded")))).toEqual([]);
  });

  it.each(["cleared", "owner", "receipt", "rescheduled"])("rechecks monitor proof under the task lock (%s)", async state => {
    const f = await fixture(), scheduled = await f.readIssue();
    const [owner] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const nextCheckAt = new Date(Date.now() + 7_200_000).toISOString();
    const original = monitorDelivery.readNativePreservedMonitorWait;
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    expect(await scheduler.nextIssueMonitorAt()).toBeNull();
    const race = vi.spyOn(monitorDelivery, "readNativePreservedMonitorWait").mockImplementationOnce(async (...args) => {
      const proof = await original(...args);
      expect(proof).not.toBeNull();
      if (state === "cleared") await db.update(issues).set({ executionPolicy: {}, monitorNextCheckAt: null }).where(eq(issues.id, f.issueId));
      if (state === "owner") await db.update(issues).set({ executionRunId: owner!.id }).where(eq(issues.id, f.issueId));
      if (state === "receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      if (state === "rescheduled") await db.update(issues).set({ monitorNextCheckAt: new Date(nextCheckAt), executionPolicy: {
        ...scheduled.executionPolicy, monitor: { ...(scheduled.executionPolicy?.monitor as Record<string, unknown>), nextCheckAt },
      } }).where(eq(issues.id, f.issueId));
      return proof;
    });
    try { await f.finalize(); } finally { race.mockRestore(); }
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator.phase).toBe(state === "rescheduled" ? "committed" : "retryable_failure");
    expect(await scheduler.nextIssueMonitorAt()).toBe(state === "rescheduled" ? new Date(nextCheckAt).getTime() : null);
    const task = await f.readIssue();
    expect(task.executionRunId).toBe(state === "owner" ? owner!.id : null);
    expect(task.monitorNextCheckAt?.toISOString() ?? null).toBe(state === "cleared" ? null : state === "rescheduled" ? nextCheckAt : f.nextCheckAt);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner!.id)))[0].status).toBe("running");
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.result);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
  });
});
