import { createRunDispatch, deriveCommentId } from "../../modules/run-dispatch/index.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { issueService } from "../issues.js";
import { activityService } from "../activity.js";
import { buildPaperclipWakePayload, heartbeatService } from "../heartbeat.js";
import { legacyExecutionNeedsReconciliation, terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { deliverExecutionStatuses } from "../execution-status-delivery.js";
import { publishLiveEvent } from "../live-events.js";
import {
  settleUnrecoverableExecutions,
  validateExecutionReconciliation,
  markExecutionReconciliation,
  deliverReconciledExecutions,
} from "../execution-recovery-resolution.js";
import { randomUUID } from "node:crypto";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { tmpdir } from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueComments,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { reconcileSafeNativeReplacements } from "./native-safe-replacement.js";
import { reconcileAbandonedExecutionControl } from "../execution-control-reconciliation.js";
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "durable replacement and control recovery",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        // The caller owns this fresh, already-migrated database.
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-safe-replacement-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });
    async function seed(attempt = 1) {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        issueId = randomUUID(),
        runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Recovery",
        issuePrefix: `R${companyId.slice(0, 6)}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Executor",
        role: "engineer",
        adapterType: "paperclip_runner",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Read fixture",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        runtimeMode: "native",
        status: "failed",
        contextSnapshot: { issueId },
        runnerProfileJson: {
          recoveryEventInventoryVersion: 1,
          nativeExecutionInput: {
            provider: { kind: "codex" },
            workspace: { cwd: tmpdir() },
          },
        },
      });
      await db.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId,
        phase: "terminal_failure",
        attempt,
        failureCode: "native_provider_terminal_failed",
        failureDetail: { originalFailureCode: "fixture_checkpoint_unusable" },
      });
      return { companyId, agentId, issueId, runId };
    }
    it.each(["unproven", "changed", "verified"] as const)("requires stopped-session proof through commit (%s)", async (mode) => {
      const source = await seed(2);
      await db.update(nativeRunFinalizations).set({ failureCode: "native_session_cleanup_quarantined" }).where(eq(nativeRunFinalizations.runId, source.runId));
      const [projected] = await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, source.issueId)).returning();
      await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId,
        kind: "active_run_watchdog", cause: "native_session_cleanup_quarantined", fingerprint: source.runId,
        ownerType: "board", returnOwnerAgentId: source.agentId, status: "resolved", outcome: "blocked",
        evidence: { runId: source.runId, nativeFailureBlock: { runId: source.runId, statusVersion: projected!.statusVersion }, automaticRecovery: { replay: "blocked" } }, nextAction: "Automatic recovery stopped.",
      });
      const retire = vi.fn(() => mode === "verified");
      const verifyStoppedSession = vi.fn(async (run: typeof heartbeatRuns.$inferSelect) =>
        run.id === source.runId && mode !== "unproven" ? { evidence: { completedTaskControlCallIds: ["completion"] }, retire } : null);
      await appendHeartbeatRunEvent(db, { companyId: source.companyId, runId: source.runId, agentId: source.agentId,
        eventType: "tool.execution.started", stream: "system",
        payload: { name: "paperclip_finish", executionId: "completion", transport: "process" },
      });
      await reconcileSafeNativeReplacements(db, new Date(), { verifyStoppedSession });
      await reconcileSafeNativeReplacements(db, new Date(), { verifyStoppedSession });
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId));
      expect(successors).toHaveLength(mode === "verified" ? 1 : 0);
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      if (mode === "verified") {
        expect(retire).toHaveBeenCalledOnce();
        expect(hold).toMatchObject({ status: "resolved", outcome: "handed_back", evidence: { automaticRecovery: { replay: "verified_safe_replacement" } } });
        // Prove that the real dispatch gate accepts the successor, not only that a row exists.
        const dispatch = createRunDispatch(db);
        await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, successors[0]!.id));
        const result = await dispatch.cancelStaleQueuedRun({ companyId: source.companyId, runId: successors[0]!.id, expectedStatus: "queued", now: new Date() });
        expect(result.outcome).toBe("not_stale");
      } else {
        expect(hold!.evidence.automaticRecovery).toEqual({ replay: "blocked" });
      }
    });
    it.each(["missing_receipt", "other_run", "other_cause", "manual_reblock", "dependency_edit", "queued_comment"] as const)("honors blocking intent before safe replacement (%s)", async (mode) => {
      const source = await seed(2);
      await db.update(nativeRunFinalizations).set({ failureCode: "native_session_cleanup_quarantined" }).where(eq(nativeRunFinalizations.runId, source.runId));
      const projected = await issueService(db).update(source.issueId, { status: "blocked" });
      const evidence = { runId: source.runId, ...(mode === "missing_receipt" ? {} : {
        nativeFailureBlock: { runId: mode === "other_run" ? randomUUID() : source.runId, statusVersion: projected!.statusVersion },
      }) };
      const [hold] = await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId,
        kind: "active_run_watchdog", cause: mode === "other_cause" ? "native_event_replay_conflict" : "native_session_cleanup_quarantined",
        fingerprint: source.runId, ownerType: "board", returnOwnerAgentId: source.agentId,
        status: "resolved", outcome: "blocked", evidence, nextAction: "Preserve this hold.",
      }).returning();
      if (mode === "manual_reblock") await issueService(db).update(source.issueId, { status: "blocked", actorUserId: "operator" });
      if (mode === "dependency_edit") {
        const blockerId = randomUUID();
        await db.insert(issues).values({ id: blockerId, companyId: source.companyId, title: "Human dependency", status: "todo" });
        await issueService(db).update(source.issueId, { blockedByIssueIds: [blockerId], actorUserId: "operator" });
      }
      const comment = mode === "queued_comment" ? await issueService(db).addComment(source.issueId, "Also explain the result", { userId: "operator" }) : null;
      const retire = vi.fn(() => true);
      await reconcileSafeNativeReplacements(db, new Date(), { verifyStoppedSession: async run =>
        run.id === source.runId ? { evidence: {}, retire } : null });
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId));
      const [after] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      const [afterHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id));
      if (mode === "queued_comment") {
        expect(successors).toHaveLength(1);
        expect(after!.status).toBe("in_progress");
        expect(afterHold!.outcome).toBe("handed_back");
        expect((await db.select().from(issueComments).where(eq(issueComments.id, comment!.id)))[0]!.body).toBe("Also explain the result");
      } else {
        expect(successors).toHaveLength(0);
        expect(retire).not.toHaveBeenCalled();
        expect(after!.status).toBe("blocked");
        expect(afterHold!.evidence).toEqual(evidence);
        expect(afterHold!.outcome).toBe("blocked");
      }
    });
    it("automatically closes an exhausted incident once, preserves ownership, and records no replay", async () => {
      const source = await seed(3);
      await reconcileSafeNativeReplacements(db);
      await Promise.all([settleUnrecoverableExecutions(db), settleUnrecoverableExecutions(db)]);
      await settleUnrecoverableExecutions(db);
      const [task] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(task).toMatchObject({ status: "blocked", assigneeAgentId: source.agentId, executionRunId: null, checkoutRunId: null });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ status: "resolved", outcome: "blocked", evidence: {
        automaticRecovery: { policy: "preserve_without_replay_v1", actionOutcome: "unknown", replay: "blocked", runId: source.runId },
      } });
      const logs = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, source.runId));
      expect(logs.filter(log => log.payload?.automaticRecovery === "preserve_without_replay_v1")).toHaveLength(1);
      const history = await activityService(db).runsForIssue(source.companyId, source.issueId);
      expect(history.find(run => run.runId === source.runId)).toMatchObject({ execution: { phase: "recovery_needed", label: "Stopped" } });

      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, source.companyId))).toHaveLength(1);
    });
    it("does not let a full batch awaiting replacement starve an eligible disposition", async () => {
      const sources: Awaited<ReturnType<typeof seed>>[] = [];
      for (let index = 0; index < 26; index += 1) {
        const source = await seed();
        sources.push(source);
        await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId,
          kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: source.agentId,
          cause: "native_provider_terminal_failed", fingerprint: source.runId, evidence: { runId: source.runId }, nextAction: "Checking recovery" });
        if (index === 25) {
          await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "uncertain_external_action" } }).where(eq(nativeRunFinalizations.runId, source.runId));
          await settleUnrecoverableExecutions(db);
          const [task] = await db.select().from(issues).where(eq(issues.id, source.issueId));
          expect(task.status).toBe("blocked");
        }
      }
      await db.update(issueRecoveryActions).set({ status: "resolved" }).where(inArray(issueRecoveryActions.sourceIssueId, sources.map(source => source.issueId)));
      await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "fixture_closed" } }).where(inArray(nativeRunFinalizations.runId, sources.map(source => source.runId)));
    });
    it("rolls back a crashed automatic disposition and completes it on the next sweep", async () => {
      const source = await seed(3);
      await reconcileSafeNativeReplacements(db);
      await expect(settleUnrecoverableExecutions(db, new Date(), { failpoint: () => { throw new Error("crash before commit"); } })).rejects.toThrow("crash before commit");
      const [before] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(before.status).toBe("in_progress");
      const [pending] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(pending.status).toBe("active");
      await settleUnrecoverableExecutions(db);
      const [after] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(after.status).toBe("blocked");
      const logs = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, source.runId));
      expect(logs.filter(log => log.payload?.automaticRecovery === "preserve_without_replay_v1")).toHaveLength(1);
    });
    it("does not let the automatic fallback preempt a safe replacement", async () => {
      const source = await seed();
      await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: source.agentId,
        cause: "native_provider_terminal_failed", fingerprint: source.runId, evidence: { runId: source.runId }, nextAction: "Checking recovery" });
      await settleUnrecoverableExecutions(db);
      const [task] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(task.status).toBe("in_progress");
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(action.status).toBe("active");
    });
    it.each(["closed", "reassigned", "new_execution"])("closes stale recovery after %s without changing task state or granting replay", async change => {
      const source = await seed(3);
      await reconcileSafeNativeReplacements(db);
      const nextRun = randomUUID();
      if (change === "new_execution") await db.insert(heartbeatRuns).values({ id: nextRun, companyId: source.companyId, agentId: source.agentId, status: "running" });
      const patch = change === "closed" ? { status: "done" } : change === "reassigned" ? { assigneeAgentId: null } : { executionRunId: nextRun };
      await db.update(issues).set(patch).where(eq(issues.id, source.issueId));
      await settleUnrecoverableExecutions(db);
      const [task] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(task).toMatchObject(patch);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(action).toMatchObject({ status: "resolved", outcome: "cancelled", evidence: { automaticRecovery: { replay: "blocked" } } });
    });
    it("cancels a durable native retry even when its previous provider is already failed", async () => {
      const source = await seed();
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", nextAttemptAt: new Date(Date.now() + 30_000) }).where(eq(nativeRunFinalizations.runId, source.runId));
      await db.update(issues).set({ executionRunId: source.runId }).where(eq(issues.id, source.issueId));
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.cancelRun(source.runId)).toMatchObject({ status: "cancelled" });
      expect(await heartbeat.cancelRun(source.runId)).toMatchObject({ status: "cancelled" });
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, source.runId));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, leaseOwner: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId))).toHaveLength(0);
    });
    it("atomically terminalizes unsupported legacy recovery and preserves its owner", async () => {
      const source = await seed();
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "running" }).where(eq(heartbeatRuns.id, source.runId));
      await db.update(issues).set({ executionRunId: source.runId, checkoutRunId: source.runId }).where(eq(issues.id, source.issueId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.runId));
      const results = await Promise.all([1, 2].map(() => terminalizeLegacyExecution({ db, run, status: "failed", fromStatuses: ["running"], patch: { errorCode: "provider_quota", finishedAt: new Date() } })));
      expect(results.filter(Boolean)).toHaveLength(1);
      const [task] = await db.select().from(issues).where(eq(issues.id, source.issueId));
      expect(task).toMatchObject({ assigneeAgentId: source.agentId, executionRunId: null, checkoutRunId: null });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ ownerType: "board", cause: "legacy_execution_requires_reconciliation" });
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, source.runId));
      await settleUnrecoverableExecutions(db);
      const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actions[0]!.id));
      expect(settled).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });

      expect(legacyExecutionNeedsReconciliation({ ...run, status: "failed", resultJson: { errorFamily: "provider_quota" } })).toBe(true);
      expect(legacyExecutionNeedsReconciliation({ ...run, status: "failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })).toBe(false);
      expect(legacyExecutionNeedsReconciliation({ ...run, status: "failed", scheduledRetryAttempt: 2, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })).toBe(true);
    });
    it("does not reopen a reconciled legacy run while continuation is pending", async () => {
      const source = await seed();
      const [run] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled" }).where(eq(heartbeatRuns.id, source.runId)).returning();
      await terminalizeLegacyExecution({ db, run, status: "cancelled" });
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      await markExecutionReconciliation(db, action!, { runId: source.runId, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "The deterministic fixture has stopped and only printed output." }, "board");
      await db.update(issueRecoveryActions).set({ status: "resolved" }).where(eq(issueRecoveryActions.id, action!.id));
      await terminalizeLegacyExecution({ db, run, status: "cancelled" });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ status: "resolved", evidence: { continuationDelivery: "pending", executionReconciliation: { runId: source.runId } } });
      await db.update(issueRecoveryActions).set({ evidence: { ...actions[0]!.evidence, continuationDelivery: "invalidated" } }).where(eq(issueRecoveryActions.id, action!.id));
    });
    it("surfaces a failed current reviewer without transferring the original assignment", async () => {
      const source = await seed();
      const reviewerId = randomUUID();
      await db.insert(agents).values({ id: reviewerId, companyId: source.companyId, name: "Reviewer", role: "engineer", adapterType: "process" });
      await db.update(issues).set({ status: "in_review", executionState: {
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: source.agentId, userId: null },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } }).where(eq(issues.id, source.issueId));
      const [run] = await db.update(heartbeatRuns).set({ agentId: reviewerId, runtimeMode: "legacy", status: "running" }).where(eq(heartbeatRuns.id, source.runId)).returning();
      await terminalizeLegacyExecution({ db, run, status: "failed", patch: { finishedAt: new Date() } });
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId));
      expect(action).toMatchObject({ ownerType: "board", returnOwnerAgentId: source.agentId, evidence: { reviewParticipantAgentId: reviewerId } });
      const input = { db, companyId: source.companyId, issueId: source.issueId, agentId: source.agentId, sourceRunId: source.runId,
        decision: { runId: source.runId, providerStopped: true as const, actionOutcome: "not_performed" as const, outcomeEvidence: "Inspected reviewer process and verified no actions occurred." } };
      await expect(validateExecutionReconciliation(input)).resolves.toMatchObject({ id: source.runId });
      await db.update(issues).set({ executionState: null }).where(eq(issues.id, source.issueId));
      await expect(validateExecutionReconciliation(input)).rejects.toThrow("source or task owner changed");
    });
    it("does not turn an already reconciled continuation into a recovery assignment", async () => {
      const source = await seed();
      const [action] = await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId, kind: "active_run_watchdog", status: "resolved", ownerType: "board", returnOwnerAgentId: source.agentId, cause: "native_event_replay_conflict", fingerprint: source.runId, nextAction: "Old recovery instruction", evidence: { executionReconciliation: { runId: source.runId } } }).returning();
      const wake = await buildPaperclipWakePayload({ db, companyId: source.companyId, contextSnapshot: { issueId: source.issueId, recoveryActionId: action.id, wakeReason: "issue_recovery_action_restored" } });
      expect(wake?.recovery).toBeNull();
      expect(wake?.reason).toBe("issue_recovery_action_restored");
    });
    it("keeps an unclassified transport terminal operator-owned", async () => {
      const source = await seed();
      await db
        .update(nativeRunFinalizations)
        .set({
          failureDetail: {
            originalFailureCode: "notification_transport_failed",
          },
        })
        .where(eq(nativeRunFinalizations.runId, source.runId));
      await reconcileSafeNativeReplacements(db);
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
      ).toHaveLength(0);
      const [coordinator] = await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, source.runId));
      expect(coordinator?.failureDetail?.replacementDenied).toBe(
        "provider_failure_meaning_unverified",
      );
    });
    it.each(["done", "cancelled", "review"])("does not reuse consumed wake authority after a later %s transition", async transition => {
      const source = await seed();
      const previousRunId = randomUUID(), commentId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: previousRunId, companyId: source.companyId,
        agentId: source.agentId, runtimeMode: "native", status: "failed", contextSnapshot: { issueId: source.issueId } });
      await db.insert(issueComments).values({ id: commentId, companyId: source.companyId,
        issueId: source.issueId, authorType: "user", authorUserId: "board", body: "Continue" });
      await db.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: source.issueId,
        kind: "active_run_watchdog", cause: "native_provider_terminal_failed", fingerprint: previousRunId,
        status: "resolved", outcome: "cancelled", nextAction: "User continued", evidence: {
          explicitUserContinuation: { previousRunId, commentId, actorId: "board", runId: source.runId },
        } });
      await db.update(heartbeatRuns).set({ contextSnapshot: {
        issueId: source.issueId, previousRunId,
        wakeCommentId: commentId, wakeCommentIds: [commentId], commentId,
        resumeIntent: true, followUpRequested: true,
        explicitUserContinuation: { previousRunId, commentId },
      } }).where(eq(heartbeatRuns.id, source.runId));
      await reconcileSafeNativeReplacements(db);
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId));
      expect(successor.contextSnapshot?.explicitUserContinuation).toBeUndefined();
      expect(deriveCommentId(successor.contextSnapshot)).toBeNull();
      expect(successor.contextSnapshot?.resumeIntent).toBeUndefined();
      expect(successor.contextSnapshot?.followUpRequested).toBeUndefined();
      const envelope = await buildExecutionContinuation({ db, companyId: source.companyId,
        issueId: source.issueId, agentId: source.agentId, context: successor.contextSnapshot!,
        summary: null, exposeLowTrustRaw: false });
      expect(envelope.trigger.sourceRunId).toBe(source.runId);
      expect(envelope.objective).toBe("Continue");
      if (transition === "review") {
        await db.update(issues).set({ status: "in_review", executionState: {
          status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: randomUUID(), userId: null },
          returnAssignee: { type: "agent", agentId: source.agentId, userId: null },
          reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        } }).where(eq(issues.id, source.issueId));
      } else {
        await db.update(issues).set({ status: transition }).where(eq(issues.id, source.issueId));
      }
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, successor.id));
      expect(await createRunDispatch(db).cancelStaleQueuedRun({ companyId: source.companyId,
        runId: successor.id, expectedStatus: "queued" })).toMatchObject({ outcome: "cancelled",
        errorCode: transition === "review" ? "issue_review_participant_changed" : "issue_terminal_status" });
    });
    it("persists exactly one linked successor under competing sweepers and restarts", async () => {
      const source = await seed(2);
      const now = new Date();
      await Promise.all([
        reconcileSafeNativeReplacements(db, now),
        reconcileSafeNativeReplacements(db, now),
      ]);
      await reconcileSafeNativeReplacements(db, now);
      const children = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, source.runId));
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({
        agentId: source.agentId,
        status: "scheduled_retry",
        scheduledRetryAttempt: 2,
        contextSnapshot: {
          forceFreshSession: true,
          recoveryIncidentRootRunId: source.runId,
        },
      });
      expect(children[0]!.scheduledRetryAt!.getTime()).toBe(
        now.getTime() + 30_000,
      );
      expect(
        (
          await db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, source.runId))
        )[0]?.failureDetail?.successorRunId,
      ).toBe(children[0]!.id);
    });
    it("retries status publication after a crash without dispatching provider work", async () => {
      await deliverExecutionStatuses(db);
      const source = await seed();
      const deliveryId = randomUUID();
      await db
        .update(heartbeatRuns)
        .set({
          executionStatusDeliveryId: deliveryId,
          error: "credential-in-provider-error",
          errorCode: "credential-in-provider-code",
          triggerDetail: "credential-in-trigger-detail",
          contextSnapshot: {
            issueId: source.issueId,
            secret: "credential-in-context",
            nested: { provider: "credential-in-nested-context" },
          },
          resultJson: {
            summary: "credential-in-provider-summary",
            toolResult: "credential-in-tool-result",
          },
        })
        .where(eq(heartbeatRuns.id, source.runId));
      await deliverExecutionStatuses(db, {
        publish: () => {
          throw new Error("publication unavailable");
        },
      });
      expect(
        (
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, source.runId))
        )[0]?.executionStatusDeliveryId,
      ).toBe(deliveryId);
      const observed: unknown[] = [];
      const publish: typeof publishLiveEvent = (event) => {
        observed.push(event);
        return publishLiveEvent(event);
      };
      await expect(
        deliverExecutionStatuses(db, {
          publish,
          failpoint: () => {
            throw new Error("crash after publication");
          },
        }),
      ).rejects.toThrow("crash after publication");
      await deliverExecutionStatuses(db, { publish });
      expect(JSON.stringify(observed)).not.toContain("credential-in-");
      expect(
        Object.keys(
          (observed[0] as { payload: Record<string, unknown> }).payload,
        ).sort(),
      ).toEqual(
        [
          "runId",
          "agentId",
          "issueId",
          "status",
          "startedAt",
          "finishedAt",
          "deliveryId",
        ].sort(),
      );
      expect(observed).toEqual([
        expect.objectContaining({
          companyId: source.companyId,
          payload: expect.objectContaining({
            runId: source.runId,
            issueId: source.issueId,
            deliveryId,
            status: "failed",
          }),
        }),
        expect.objectContaining({
          companyId: source.companyId,
          payload: expect.objectContaining({
            runId: source.runId,
            issueId: source.issueId,
            deliveryId,
            status: "failed",
          }),
        }),
      ]);
      expect(
        (
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, source.runId))
        )[0]?.executionStatusDeliveryId,
      ).toBeNull();
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
      ).toHaveLength(0);
    });
    it.each([
      "native",
      "legacy",
      "native_precedes_context",
      "missing",
      "nonexistent",
      "deleted",
      "foreign",
      "malformed",
      "object",
      "array",
      "number",
      "json_null",
      "native_foreign",
      "native_nonexistent",
    ] as const)(
      "routes status delivery only through a proven same-company task: %s",
      async (association) => {
        await deliverExecutionStatuses(db);
        const source = await seed();
        const otherIssueId = randomUUID();
        await db.insert(issues).values({
          id: otherIssueId,
          companyId: source.companyId,
          title: "Other task",
          status: "backlog",
        });
        const foreign =
          association === "foreign" || association === "native_foreign"
            ? await seed()
            : null;
        const runId = randomUUID();
        const deliveryId = randomUUID();
        let nativeIssueId: string | null = null;
        let contextSnapshot: Record<string, unknown> = {
          issueId: source.issueId,
        };
        let expectedIssueId: string | null = null;
        switch (association) {
          case "native":
            nativeIssueId = source.issueId;
            contextSnapshot = {};
            expectedIssueId = source.issueId;
            break;
          case "legacy":
            expectedIssueId = source.issueId;
            break;
          case "native_precedes_context":
            nativeIssueId = source.issueId;
            contextSnapshot = { issueId: otherIssueId };
            expectedIssueId = source.issueId;
            break;
          case "missing":
            contextSnapshot = {};
            break;
          case "nonexistent":
            contextSnapshot = { issueId: randomUUID() };
            break;
          case "deleted":
            contextSnapshot = { issueId: otherIssueId };
            await db.delete(issues).where(eq(issues.id, otherIssueId));
            break;
          case "foreign":
            contextSnapshot = { issueId: foreign!.issueId };
            break;
          case "malformed":
            contextSnapshot = { issueId: "credential-in-invalid-issue-id" };
            break;
          case "object":
            contextSnapshot = { issueId: { secret: "credential-in-object" } };
            break;
          case "array":
            contextSnapshot = {
              issueId: [source.issueId, "credential-in-array"],
            };
            break;
          case "number":
            contextSnapshot = { issueId: 42 };
            break;
          case "json_null":
            contextSnapshot = { issueId: null };
            break;
          case "native_foreign":
            nativeIssueId = foreign!.issueId;
            break;
          case "native_nonexistent":
            nativeIssueId = randomUUID();
            break;
        }
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: source.companyId,
          agentId: source.agentId,
          runtimeMode: nativeIssueId ? "native" : "legacy",
          nativeIssueId,
          contextSnapshot: {
            ...contextSnapshot,
            secret: "credential-in-context",
          },
          status: "cancelled",
          executionStatusDeliveryId: deliveryId,
          error: "credential-in-error",
          resultJson: { output: "credential-in-output" },
        });
        const beforeRunIds = (
          await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.companyId, source.companyId))
        )
          .map((row) => row.id)
          .sort();
        const observed: Parameters<typeof publishLiveEvent>[0][] = [];
        await deliverExecutionStatuses(db, {
          publish: (event) => {
            observed.push(event);
            return publishLiveEvent(event);
          },
        });
        expect(observed).toEqual([
          {
            companyId: source.companyId,
            type: "heartbeat.run.status",
            payload: {
              runId,
              agentId: source.agentId,
              issueId: expectedIssueId,
              status: "cancelled",
              startedAt: null,
              finishedAt: null,
              deliveryId,
            },
          },
        ]);
        expect(JSON.stringify(observed)).not.toContain("credential-in-");
        if (foreign)
          expect(JSON.stringify(observed)).not.toContain(foreign.issueId);
        expect(
          (
            await db
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.companyId, source.companyId))
          )
            .map((row) => row.id)
            .sort(),
        ).toEqual(beforeRunIds);
        expect(
          (
            await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runId))
          )[0],
        ).toMatchObject({
          status: "cancelled",
          executionStatusDeliveryId: null,
          processPid: null,
        });
      },
    );

    it("never resets an exhausted incident by assigning another run id", async () => {
      const source = await seed(3);
      await reconcileSafeNativeReplacements(db);
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
      ).toHaveLength(0);
      expect(
        (
          await db
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.sourceIssueId, source.issueId))
        )[0],
      ).toMatchObject({
        ownerType: "board",
        cause: "execution_recovery_budget_exhausted",
      });
    });
    it.each(["successor_inserted", "lineage_committed"] as const)(
      "recovers a crash at %s without duplicate successors",
      async (phase) => {
        const source = await seed();
        await expect(
          reconcileSafeNativeReplacements(db, new Date(), {
            failpoint: (point) => {
              if (point === phase)
                throw new Error("simulated coordinator crash");
            },
          }),
        ).rejects.toThrow("simulated coordinator crash");
        await reconcileSafeNativeReplacements(db);
        expect(
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
        ).toHaveLength(1);
      },
    );
    it.each([false, true])(
      "does not replay a provider-native command with unknown effects (PRP envelope: %s)",
      async (wrapped) => {
        const source = await seed();
        await db.insert(heartbeatRunEvents).values({
          companyId: source.companyId,
          runId: source.runId,
          agentId: source.agentId,
          seq: 1,
          eventType: "tool.execution.started",
          stream: "system",
          payload: wrapped
            ? {
                prpEvent: {
                  payload: {
                    transport: "process",
                    executionId: "shell-write-1",
                    name: "send_email",
                  },
                },
              }
            : {
                transport: "process",
                executionId: "shell-write-1",
                name: "send_email",
              },
        });
        await reconcileSafeNativeReplacements(db);
        expect(
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(issueRecoveryActions)
              .where(eq(issueRecoveryActions.sourceIssueId, source.issueId))
          )[0]?.nextAction,
        ).toContain("shell-write-1");
      },
    );
    it("surfaces a reviewer's abandoned control transition for the operator", async () => {
      const source = await seed();
      const reviewerId = randomUUID();
      await db.insert(agents).values({ id: reviewerId, companyId: source.companyId, name: "Reviewer", role: "engineer", adapterType: "process" });
      await db.update(issues).set({ status: "in_review", executionRunId: source.runId, executionState: {
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: source.agentId, userId: null },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } }).where(eq(issues.id, source.issueId));
      await db.update(heartbeatRuns).set({ agentId: reviewerId, status: "running", executionControlDeadlineAt: new Date(Date.now() - 1_000) }).where(eq(heartbeatRuns.id, source.runId));
      await reconcileAbandonedExecutionControl(db);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, source.issueId))).toMatchObject([
        { ownerType: "board", returnOwnerAgentId: source.agentId, evidence: { reviewParticipantAgentId: reviewerId } },
      ]);
      expect((await db.select().from(issues).where(eq(issues.id, source.issueId)))[0]).toMatchObject({ assigneeAgentId: source.agentId, executionRunId: null });
    });
    it("fences a stranded finalization and surfaces one operator action after its deadline", async () => {
      const source = await seed();
      const deadline = new Date("2026-09-08T10:00:00Z");
      await db
        .update(heartbeatRuns)
        .set({ status: "running" })
        .where(eq(heartbeatRuns.id, source.runId));
      await db
        .update(nativeRunFinalizations)
        .set({
          phase: "observed",
          leaseOwner: "dead-controller",
          controlDeadlineAt: deadline,
        })
        .where(eq(nativeRunFinalizations.runId, source.runId));
      await reconcileAbandonedExecutionControl(
        db,
        new Date(deadline.getTime() + 15_000),
      );
      await reconcileAbandonedExecutionControl(
        db,
        new Date(deadline.getTime() + 30_000),
      );
      expect(
        (
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, source.runId))
        )[0],
      ).toMatchObject({
        status: "failed",
        errorCode: "execution_finalization_deadline_exceeded",
      });
      expect(
        (
          await db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, source.runId))
        )[0],
      ).toMatchObject({
        leaseOwner: null,
        controlDeadlineAt: null,
        phase: "terminal_failure",
      });
      expect(
        await db
          .select()
          .from(issueRecoveryActions)
          .where(
            and(
              eq(issueRecoveryActions.sourceIssueId, source.issueId),
              eq(
                issueRecoveryActions.cause,
                "execution_finalization_deadline_exceeded",
              ),
            ),
          ),
      ).toHaveLength(1);
    });
    it("bounds legacy finalization without adding a deadline to healthy provider execution", async () => {
      const source = await seed();
      await db
        .delete(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, source.runId));
      await db
        .update(heartbeatRuns)
        .set({
          runtimeMode: "legacy",
          status: "running",
          executionControlDeadlineAt: null,
        })
        .where(eq(heartbeatRuns.id, source.runId));
      await reconcileAbandonedExecutionControl(db);
      expect(
        (
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, source.runId))
        )[0]?.status,
      ).toBe("running");
      await db
        .update(heartbeatRuns)
        .set({ executionControlDeadlineAt: new Date(Date.now() - 1000) })
        .where(eq(heartbeatRuns.id, source.runId));
      await reconcileAbandonedExecutionControl(db);
      expect(
        (
          await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, source.runId))
        )[0],
      ).toMatchObject({ status: "failed", executionControlDeadlineAt: null });
      expect(
        (
          await db
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.sourceIssueId, source.issueId))
        )[0]?.ownerType,
      ).toBe("board");
    });
    it("does not release another run's checkout or replace a reassigned task", async () => {
      const source = await seed();
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId: source.companyId,
        agentId: source.agentId,
        status: "running",
      });
      await db
        .update(issues)
        .set({ checkoutRunId: otherRunId })
        .where(eq(issues.id, source.issueId));
      await reconcileSafeNativeReplacements(db);
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
      ).toHaveLength(0);
      await db
        .update(issues)
        .set({ assigneeAgentId: null })
        .where(eq(issues.id, source.issueId));
      await reconcileSafeNativeReplacements(db);
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, source.runId)),
      ).toHaveLength(0);
    });
    it("requires explicit reconciled outcomes and rejects a still-running provider", async () => {
      const source = await seed();
      const input = {
        db,
        companyId: source.companyId,
        issueId: source.issueId,
        agentId: source.agentId,
        sourceRunId: source.runId,
        decision: undefined,
      };
      await expect(validateExecutionReconciliation(input)).rejects.toThrow(
        "Reconcile the recorded execution",
      );
      const decision = {
        runId: source.runId,
        providerStopped: true as const,
        actionOutcome: "not_performed" as const,
        outcomeEvidence:
          "Verified that the fixture emitted an event only; no external action happened.",
      };
      await db
        .update(heartbeatRuns)
        .set({ processPid: process.pid })
        .where(eq(heartbeatRuns.id, source.runId));
      await expect(
        validateExecutionReconciliation({ ...input, decision }),
      ).rejects.toThrow("still running");
      await db
        .update(heartbeatRuns)
        .set({ processPid: null })
        .where(eq(heartbeatRuns.id, source.runId));
      await expect(
        validateExecutionReconciliation({ ...input, decision }),
      ).resolves.toMatchObject({ id: source.runId });
      await expect(
        validateExecutionReconciliation({
          ...input,
          companyId: randomUUID(),
          decision,
        }),
      ).rejects.toThrow("source or task owner changed");
    });
    it("retains a reconciliation delivery across dispatch failure and invalidates stale ownership", async () => {
      const source = await seed();
      const [action] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: source.companyId,
          sourceIssueId: source.issueId,
          kind: "active_run_watchdog",
          status: "resolved",
          ownerType: "board",
          returnOwnerAgentId: source.agentId,
          cause: "uncertain_provider_action",
          fingerprint: source.runId,
          evidence: { runId: source.runId },
          nextAction: "Reconcile fixture action",
        })
        .returning();
      const decision = {
        runId: source.runId,
        providerStopped: true as const,
        actionOutcome: "not_performed" as const,
        outcomeEvidence:
          "The fixture was inspected and no command was executed.",
      };
      await markExecutionReconciliation(db, action!, decision, "operator");
      await deliverReconciledExecutions(db, async () => {
        throw new Error("dispatch unavailable");
      });
      expect(
        (
          await db
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.id, action!.id))
        )[0]?.evidence.continuationDelivery,
      ).toBe("pending");
      await db
        .update(issues)
        .set({ assigneeAgentId: null })
        .where(eq(issues.id, source.issueId));
      let woke = false;
      await deliverReconciledExecutions(db, async () => {
        woke = true;
        return null;
      });
      expect(woke).toBe(false);
      expect(
        (
          await db
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.id, action!.id))
        )[0]?.evidence.continuationDelivery,
      ).toBe("invalidated");
    });
  },
);
