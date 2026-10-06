import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, workAssessments } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { NATIVE_MODEL_REJECTION_DIAGNOSTIC, NATIVE_MODEL_REJECTION_MESSAGE } from "./native-provider-failure.js";
import { collectRunFailureDiagnostics } from "../run-failure-diagnostics.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readPersistedNativeModelRejection } from "./native-provider-failure-evidence.js";
import { heartbeatService } from "../heartbeat.js";
import { getNativeReviewAssignment } from "./native-review-participant.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

describe("native completed failure diagnostics", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const workerId = randomUUID();
  const model = "test-model";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-model-failure-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native failure regression", issuePrefix: "NMF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native failure agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model } });
    await db.insert(agents).values({ id: workerId, companyId, name: "Review source worker", status: "active", adapterType: "paperclip_runner" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["committed", "duplicate", "pending-review", "superseded-review", "resolved-review", "reassigned", "successor-race", "different-turn", "unknown-error", "untrusted-source", "untrusted-run", "untrusted-session", "succeeded", "cancelled"] as const)(
    "preserves accepted results and only labels the matching provider rejection (%s)", async (scenario) => {
      const issueId = randomUUID();
      const runId = randomUUID();
      const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Explain a provider rejection", status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } }).returning();
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      const execution: NativeExecutionInputV1 = {
        schema: "paperclip.native-execution-input.v1",
        binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
        provider: { kind: "codex", model },
        task: { identifier: issueId, title: issue.title, description: null, prompt: "Reply to the current message.", workMode: "standard" },
        workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
        interactionResponses: [], credentialBindings: [],
      };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
      if (scenario.endsWith("-review")) {
        const sourceRunId = randomUUID(), sourceResultId = randomUUID(), assessmentId = randomUUID();
        const decisionId = randomUUID(), interactionId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 });
        await db.insert(nativeRunResults).values({ id: sourceResultId, companyId, issueId, runId: sourceRunId, completionContractId: contract.id, serverFingerprint: sourceResultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: sourceResultId });
        await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId: contract.id, resultId: sourceResultId, triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
        const [reviewIssue] = await db.update(issues).set({ status: "in_review", assigneeAgentId: workerId }).where(eq(issues.id, issueId)).returning();
        await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion }, decisionDigest: decisionId, applicationState: "applied" });
        await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
        await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", sourceRunId, addresseeAgentId: agentId, createdByAgentId: workerId,
          status: scenario === "resolved-review" ? "accepted" : "pending",
          ...(scenario === "resolved-review" ? { resolvedByRunId: runId, resolvedByAgentId: agentId } : {}),
          payload: { version: 1, prompt: "Review the completed work.", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } },
        });
        const contextSnapshot = { issueId, nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId };
        await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, runId));
        if (scenario === "superseded-review") await db.update(issues).set({ lastStatusDecisionId: null }).where(eq(issues.id, issueId));
        const review = await getNativeReviewAssignment(db, { companyId, issueId, agentId, contextSnapshot, allowResolvedByRunId: runId });
        if (scenario === "superseded-review") expect(review).toBeNull();
        else expect(review?.interaction.status).toBe(scenario === "resolved-review" ? "accepted" : "pending");
      }
      const event: PrpEvent = {
        schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
        turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "model-terminal", sourceSeq: 1,
        sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
        payload: { status: "failed", error: { codexErrorInfo: "other", message: JSON.stringify({
          type: "error", status: 400, error: { type: "invalid_request_error", message: scenario === "unknown-error" ? "Private unknown failure" : `The '${model}' model is not supported when using Codex with a ChatGPT account.` },
        }) } },
      };
      const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
      if (scenario === "duplicate") {
        const prior = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId, sourceInstanceId: native.runnerInstanceId, controlPlaneSourceInstanceId: "prior-controller", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 });
        await prior.openRun(openInput);
        expect((await prior.appendEvent(event)).disposition).toBe("committed");
      }
      const turnId = scenario === "different-turn" ? "later-turn" : native.turnId;
      const terminal: PrpTerminalState = {
        schema: "paperclip.prp.terminal.v1", turnTerminalState: scenario === "succeeded" ? "completed" : scenario === "cancelled" ? "cancelled" : "failed",
        runTerminalState: scenario === "succeeded" ? "succeeded" : scenario === "cancelled" ? "cancelled" : "failed", reportedWorkDisposition: "blocked",
      };
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "blocked" as const,
        blocker: { reasonCode: "provider_rejected", owner: { kind: "user" as const, name: "Task owner" }, unblockAction: "Select a compatible connection.", scope: "task_wide" as const },
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
      provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
        await options.controlPlane.openRun(openInput);
        if (scenario === "untrusted-source") {
          await expect(options.controlPlane.appendEvent({ ...event, sourceInstanceId: "wrong-runner" })).rejects.toThrow("native_event_source_binding_mismatch");
        } else if (scenario === "untrusted-run" || scenario === "untrusted-session") {
          await expect(options.controlPlane.appendEvent({ ...event,
            ...(scenario === "untrusted-run" ? { runId: randomUUID() } : { normalizedSessionId: "wrong-session" }),
          })).rejects.toThrow("native_event_binding_mismatch");
        } else {
          expect((await options.controlPlane.appendEvent(event)).disposition).toBe(scenario === "duplicate" ? "duplicate" : "committed");
        }
        await options.controlPlane.completeRun({ result, terminal, turnId });
        return { result, terminal, turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
      });
      const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
        descriptor: async () => { throw new Error("Unexpected provider call"); },
        openSession: async () => { throw new Error("Unexpected provider call"); },
      } });
      const classified = scenario === "committed" || scenario === "duplicate" || scenario.endsWith("-review") || scenario === "reassigned" || scenario === "successor-race";
      const reviewAuthorityEnded = scenario === "superseded-review" || scenario === "resolved-review";
      const ownerChanged = scenario === "reassigned" || scenario === "successor-race";
      expect(adapter.errorCode).toBe(classified ? "native_provider_model_rejected" : undefined);
      expect(adapter.errorMessage).toBe(classified ? NATIVE_MODEL_REJECTION_MESSAGE : scenario === "succeeded" ? null : `Native session ${terminal.runTerminalState}`);
      expect(adapter.resultJson?.nativeProviderFailure).toEqual(classified ? NATIVE_MODEL_REJECTION_DIAGNOSTIC : undefined);
      expect(adapter.nativeFinalization).toMatchObject({ result, terminal, turnId, workspaceFinalizeStatus: "pending" });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(execution.provider).toEqual({ kind: "codex", model });
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator).toMatchObject({ phase: "workspace_finalizing", leaseOwner: null, attempt: 1, nextAttemptAt: null });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(scenario.startsWith("untrusted-") ? 0 : 1);
      const diagnostics = collectRunFailureDiagnostics({ ...run, resultJson: adapter.resultJson ?? null }, {});
      expect(diagnostics.provider).toEqual(classified ? NATIVE_MODEL_REJECTION_DIAGNOSTIC : {});
      expect(JSON.stringify(diagnostics)).not.toContain(model);
      expect(JSON.stringify(diagnostics)).not.toContain("Private");
      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persistedRun.errorCode).toBeNull(); // No adapter metadata has been saved yet.
      expect(await readPersistedNativeModelRejection(db, persistedRun, turnId, terminal)).toEqual(classified ? {
        errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE, diagnostic: NATIVE_MODEL_REJECTION_DIAGNOSTIC,
      } : null);
      if (classified) {
        if (scenario === "committed") {
          // Neither saved display diagnostics nor a different execution binding
          // can confer the right to change the finalizer's retry decision.
          for (const changed of [
            { ...persistedRun, runnerProfileJson: null },
            { ...persistedRun, nativeSessionId: "foreign-session" },
            { ...persistedRun, runnerInstanceId: "foreign-source" },
            { ...persistedRun, companyId: randomUUID() },
            { ...persistedRun, completionContractSha256: "foreign-contract" },
            { ...persistedRun, runnerProfileJson: { nativeExecutionInput: { ...execution, provider: { kind: "codex", model: "different-model" } } } },
            { ...persistedRun, runnerProfileJson: { nativeExecutionInput: { ...execution, binding: { ...execution.binding, runId: randomUUID() } } } },
          ]) expect(await readPersistedNativeModelRejection(db, changed, turnId, terminal)).toBeNull();
          const [stored] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
          await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: "invalid-hash" }).where(eq(heartbeatRunEvents.id, stored.id));
          expect(await readPersistedNativeModelRejection(db, persistedRun, turnId, terminal)).toBeNull();
          await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: stored.sourcePayloadSha256 }).where(eq(heartbeatRunEvents.id, stored.id));
        }
        // Simulate a restart after native result acceptance, before heartbeat's
        // adapter update. Finalization must use durable provider evidence.
        const acceptedBefore = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
        if (scenario === "reassigned") {
          await db.update(issues).set({ assigneeAgentId: workerId, executionRunId: null }).where(eq(issues.id, issueId));
        } else if (scenario === "successor-race") {
          const [snapshot] = await db.select().from(issues).where(eq(issues.id, issueId));
          const newerRunId = randomUUID(), raceAssessmentId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: newerRunId, companyId, agentId, status: "running", nativeIssueId: issueId });
          await db.update(issues).set({ executionRunId: newerRunId }).where(eq(issues.id, issueId));
          const [changed] = await db.select().from(issues).where(eq(issues.id, issueId));
          expect(changed.statusVersion).toBe(snapshot.statusVersion);
          await db.insert(workAssessments).values({ id: raceAssessmentId, companyId, issueId, runId, contractId: contract.id, resultId: acceptedBefore[0].id, triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: snapshot.status, priorStatusVersion: snapshot.statusVersion, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {}, inputDigest: raceAssessmentId });
          await expect(commitNativeStatusDecision({ db, companyId, issueId, runId, assessmentId: raceAssessmentId,
            priorStatus: snapshot.status, priorStatusVersion: snapshot.statusVersion, priorDecisionId: snapshot.lastStatusDecisionId,
            requireModelRejectionOwner: { agentId, reviewContext: null },
            decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "blocked", toStatus: "blocked", reasonCode: "native_provider_model_rejected", unblockDescriptor: { owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE }, effects: [{ kind: "bind_blocker", owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE }] },
          })).rejects.toBeInstanceOf(NativeStatusRaceError);
          expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId))).toHaveLength(0);
        }
        for (let retry = 0; retry < 2; retry++) {
          await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        }
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual(acceptedBefore);
        const [finalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(finalRun).toMatchObject({ status: "failed", errorCode: "native_provider_model_rejected", error: NATIVE_MODEL_REJECTION_MESSAGE });
        const [finalIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(finalIssue.status).toBe(reviewAuthorityEnded ? "in_review" : ownerChanged ? "in_progress" : "blocked");
        const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
        expect(decisions).toHaveLength(1);
        expect(decisions[0].reasonCode).toBe(reviewAuthorityEnded ? "native_review_action_finished" : ownerChanged ? "run_failed_partial_evidence_preserved" : "native_provider_model_rejected");
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
        expect(wakes.filter(wake => wake.payload?.issueId === issueId)).toHaveLength(ownerChanged ? 1 : 0);
        if (!ownerChanged) expect(await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId })).toEqual({ scanned: 0, dispatched: 0, recovered: 0, deferred: 0 });
        expect(provider.execute).toHaveBeenCalledTimes(1);
      } else if (scenario === "unknown-error") {
        // A lookalike diagnostic flag does not alter unknown failed-result policy.
        await db.update(heartbeatRuns).set({ resultJson: { nativeProviderFailure: NATIVE_MODEL_REJECTION_DIAGNOSTIC } }).where(eq(heartbeatRuns.id, runId));
        await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
        const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
        expect(decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
        expect(wakes.filter(wake => wake.payload?.issueId === issueId)).toHaveLength(1);
      }
    },
  );
});
