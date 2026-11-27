import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, applyPendingMigrations, companies, completionContracts, createDb, environmentLeases, environments,
  heartbeatRuns, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

// A worker finished its task and asked another agent for a completion review.
// The reviewer's remote run is on the worker's task, so the task's assignee is
// the worker, not the reviewer. A server restart must not read that as a
// change of task ownership while the review it was asked for is still open.
(support.supported ? describe : describe.skip)("native restart recovery of a completion reviewer's remote run", () => {
  let db: ReturnType<typeof createDb>;
  let runtimeRoot: string;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyId = randomUUID();
  const workerId = randomUUID();
  const reviewerId = randomUUID();
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("native-restart-review-participant-");
      db = createDb(temporary.connectionString);
    }
    await db.insert(companies).values({ id: companyId, name: "Restart review", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", status: "active", adapterType: "paperclip_runner" },
      { id: reviewerId, companyId, name: "Reviewer", status: "active", adapterType: "paperclip_runner" },
    ]);
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "restart-review-authority-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "83".repeat(32));
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end(); await temporary?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedInterruptedReview() {
    const issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
    const failedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the finished change",
      status: "in_progress", workMode: "standard", assigneeAgentId: workerId });

    // The worker's run finished and the status arbiter applied its review decision.
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", objective: "Finish the change", criteria: [] },
      canonicalSha256: `review-contract-${issueId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    const sourceRunId = randomUUID(), sourceResultId = randomUUID(), assessmentId = randomUUID();
    const decisionId = randomUUID(), interactionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, nativeIssueId: issueId,
      runtimeMode: "native", status: "succeeded", completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256 });
    await db.insert(nativeRunResults).values({ id: sourceResultId, companyId, issueId, runId: sourceRunId,
      completionContractId: contract.id, serverFingerprint: sourceResultId, schemaStatus: "accepted", resultJson: {},
      canonicalSha256: sourceResultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId,
      contractId: contract.id, resultId: sourceResultId, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {},
      inputDigest: assessmentId });
    const [reviewIssue] = await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId)).returning();
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId,
      decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review",
      reasonCode: "actionable_attention_pending", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion },
      decisionDigest: decisionId, applicationState: "applied" });
    await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation",
      sourceRunId, addresseeAgentId: reviewerId, createdByAgentId: workerId, continuationPolicy: "wake_assignee",
      status: "pending",
      payload: { version: 1, prompt: "Review the completed work.",
        target: { type: "custom", key: "native_completion_review", revisionId: decisionId } } });

    // The reviewer's remote run holds the task's execution lock and was
    // interrupted with a resumable checkpoint.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "retryable_failure", nativeSessionId: sessionId,
      processPid: 4_343, processStartedAt: failedAt, startedAt: failedAt, finishedAt: new Date(),
      errorCode: "native_session_interrupted", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId, wakeReason: "native_completion_review", source: "native_status_decision",
        nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId } });
    const [environment] = await db.insert(environments).values({ name: `Restart review ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
      leasePolicy: "ephemeral", metadata: { driver: "sandbox", remoteCwd: "/work" } }).returning();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeExecutionInput: { binding: { companyId, issueId, runId, agentId: reviewerId } },
      nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: runId,
        leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
      },
      sessionCheckpoint: { sessionId: "driver-session", providerSessionId: "provider-session",
        identity: { runId, companyId, issueId, agentId: reviewerId, sessionId } },
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: failedAt })
      .where(eq(issues.id, issueId));
    const owner = { bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1,
      controllerBootId: owner.bootId, controllerGeneration: owner.generation,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
      nextAttemptAt: new Date(Date.now() - 60_000), recoveryState: "resuming_session",
      failureCode: "native_session_interrupted",
      failureDetail: { recoveryMode: "exact_checkpoint_resume", checkpointExists: true,
        providerSessionEstablished: true, providerEventsExist: false } });
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(runtimeRoot, runId),
      identity: { runId, normalizedSessionId: sessionId, runnerInstanceId: randomUUID(),
        environmentLeaseId: lease.id, turnId: randomUUID(), itemId: randomUUID() },
      expectedRunnerVersion: "restart-review-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    authority.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, {
      companyId, issueId, runId, authorityRunId: runId, ...owner,
    }));
    await authority.flushCheckpoint();
    await authority.stop();
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    return { issueId, runId, interactionId };
  }

  it("reattaches the reviewer's run while its completion review is still open", async () => {
    const review = await seedInterruptedReview();
    const [claim] = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [review.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: review.runId });
    // Recovery leaves the worker's task and the open review as they were.
    expect((await db.select().from(issues).where(eq(issues.id, review.issueId)))[0])
      .toMatchObject({ status: "in_review", assigneeAgentId: workerId, executionRunId: review.runId });
    expect((await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, review.interactionId)))[0]).toMatchObject({ status: "pending" });
  });

  it("still ends the reviewer's run when the task has moved past that review", async () => {
    const review = await seedInterruptedReview();
    // The worker's task took a newer status decision, so this review is stale.
    await db.update(issues).set({ lastStatusDecisionId: null }).where(eq(issues.id, review.issueId));
    const [claim] = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [review.runId] });
    expect(claim).toEqual({ kind: "blocked", runId: review.runId, reason: "task_ownership_or_status_changed" });
  });
});
