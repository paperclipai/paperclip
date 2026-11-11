import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueWorkProducts, issues, statusDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native completion with a configured review stage", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-review-stage-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  type Options = { stage?: "user" | "agent"; monitor?: boolean; liveCycleWithRemovedStage?: boolean; unprovenEvidence?: boolean;
    beforeFinish?: (runId: string, result: PrpStructuredRunResult) => Promise<void> };
  async function finishVerifiedDone(options: Options = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const reviewerId = `reviewer-${randomUUID()}`, reviewerAgentId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review stage", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values([{ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" },
      { id: reviewerAgentId, companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "active" }]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: reviewerId, status: "active", membershipRole: "operator" });
    const participant = options.stage === "agent" ? { id: randomUUID(), type: "agent", agentId: reviewerAgentId } : { id: randomUUID(), type: "user", userId: reviewerId };
    const nextCheckAt = new Date(Date.now() + 3_600_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Build the site", status: "in_progress", assigneeAgentId: agentId,
      ...(options.stage || options.liveCycleWithRemovedStage ? { executionPolicy: { mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [participant] }],
        ...(options.monitor ? { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check the deploy.", scheduledBy: "assignee" } } : {}) } } : {}),
      ...(options.monitor ? { monitorNextCheckAt: nextCheckAt } : {}),
      ...(options.liveCycleWithRemovedStage ? { executionState: { status: "changes_requested", currentStageId: randomUUID(), currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "user", userId: reviewerId }, returnAssignee: { type: "agent", agentId },
        completedStageIds: [], lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested" } } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running",
      runtimeMode: "native", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const contractId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID(), contractSha256 = `contract-${runId}`;
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Build the site", criteria: [{ id: "objective", requirement: "Build the site" }] },
      canonicalSha256: contractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, completionContractSha256: contractSha256,
      nativeSessionId: sessionId, runnerInstanceId: runnerId }).where(eq(heartbeatRuns.id, runId));
    const [verified] = await db.insert(issueWorkProducts).values({ companyId, issueId,
      type: "artifact", provider: "test", title: "Site check", status: "completed", reviewState: "approved" }).returning();
    const evidenceRef = `work_product:${verified!.id}`;
    // The recorded failing report: a file name and an unbound attachment ref,
    // and a passed check with no durable artifact. The worker cannot make its
    // own unreviewed work product authoritative; the configured reviewer does.
    const refs = options.unprovenEvidence ? ["website.html", `attachment:${randomUUID()}`] : [evidenceRef];
    const result: PrpStructuredRunResult = { ...CONTROL_PLANE_CONFORMANCE_RESULT,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: refs }] },
      evidence: options.unprovenEvidence ? refs.map(ref => ({ ref })) : [{ kind: "work_product", ref: evidenceRef }],
      verification: [options.unprovenEvidence ? { commandOrCheck: "python3 html.parser verification of website.html", status: "passed" }
        : { commandOrCheck: "Site check", status: "passed", artifactRef: evidenceRef }] } as PrpStructuredRunResult;
    if (options.beforeFinish) await options.beforeFinish(runId, result);
    const identity = { companyId, agentId, issueId, runId };
    const port = new PaperclipControlPlanePort(db, { ...identity, sessionId, completionContractId: contractId,
      completionContractSha256: contractSha256, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: randomUUID() });
    await port.openRun({ identity: { ...identity, sessionId }, backendKind: "mock", sourceInstanceId: runnerId });
    await port.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: randomUUID() });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    return { task: task!, decisions, wakes, reviewerId, reviewerAgentId, stageId, agentId };
  }

  it("closes verified work on a task without a configured review stage", async () => {
    const r = await finishVerifiedDone();
    expect(r.task.status).toBe("done");
    expect(r.decisions.map(row => row.reasonCode)).toEqual(["completion_contract_satisfied"]);
  });

  it("starts the configured human review stage instead of closing verified work", async () => {
    const r = await finishVerifiedDone({ stage: "user", monitor: true });
    expect(r.task).toMatchObject({ status: "in_review", assigneeUserId: r.reviewerId, assigneeAgentId: null, monitorNextCheckAt: null });
    expect(r.task.executionState).toMatchObject({ status: "pending", currentStageId: r.stageId, currentStageType: "review",
      currentParticipant: { type: "user", userId: r.reviewerId }, returnAssignee: { type: "agent", agentId: r.agentId } });
    expect((r.task.executionPolicy as Record<string, unknown>).monitor ?? null).toBeNull();
    expect(r.decisions.map(row => [row.toStatus, row.reasonCode])).toEqual([["in_review", "execution_stage_review_required"]]);
    expect(r.wakes.filter(wake => wake.reason === "execution_review_requested")).toEqual([]);
  });

  it("starts the configured review for a clean done claim whose evidence only the reviewer can accept", async () => {
    const r = await finishVerifiedDone({ stage: "user", unprovenEvidence: true });
    expect(r.task).toMatchObject({ status: "in_review", assigneeUserId: r.reviewerId });
    expect(r.task.executionState).toMatchObject({ status: "pending", currentParticipant: { type: "user", userId: r.reviewerId } });
    expect(r.decisions.map(row => [row.toStatus, row.reasonCode])).toEqual([["in_review", "execution_stage_review_required"]]);
    expect(r.wakes.filter(wake => wake.agentId === r.agentId)).toEqual([]);
  });

  it("still requires proven evidence to close a task without a configured review", async () => {
    const r = await finishVerifiedDone({ unprovenEvidence: true });
    expect(r.task.status).toBe("in_progress");
    expect(r.decisions.map(row => row.reasonCode)).toEqual(["completion_evidence_incomplete"]);
  });

  it("starts a configured agent review stage and wakes that reviewer", async () => {
    const r = await finishVerifiedDone({ stage: "agent" });
    expect(r.task).toMatchObject({ status: "in_review", assigneeAgentId: r.reviewerAgentId, assigneeUserId: null });
    expect(r.task.executionState).toMatchObject({ status: "pending", currentParticipant: { type: "agent", agentId: r.reviewerAgentId } });
    expect(r.wakes.filter(wake => wake.reason === "execution_review_requested"))
      .toEqual([expect.objectContaining({ agentId: r.reviewerAgentId, status: "queued" })]);
  });

  it("keeps the task open when the policy refuses Done for a live review cycle", async () => {
    const r = await finishVerifiedDone({ liveCycleWithRemovedStage: true });
    expect(r.task.status).toBe("in_progress");
    expect(r.decisions.map(row => [row.toStatus, row.reasonCode])).toEqual([["in_progress", "execution_stage_transition_rejected"]]);
  });

  it("tells the worker the configured stage requests the review", async () => {
    await finishVerifiedDone({ stage: "user", beforeFinish: async (runId, result) => {
      const accepted = await nativeCompletionFeedback(db, runId, result);
      expect(accepted).toContain("configured review stage starts after this turn");
      expect(accepted).toContain("do not say the task is done");
      const review = { kind: "review" as const, summary: "Riley: please review the site.", ownerClass: "human" as const };
      await expect(nativeCompletionFeedback(db, runId, { ...result, reportedWorkDisposition: "needs_review", attentionRequests: [review] }))
        .rejects.toThrow("Report done once the work is complete and verified");
      await expect(nativeCompletionFeedback(db, runId, { ...result, reportedWorkDisposition: "needs_review",
        attentionRequests: [review, { kind: "human_input", summary: "Which signup URL?", ownerClass: "human" }] }))
        .rejects.toThrow("configured review stage with its own reviewer");
      await expect(nativeCompletionFeedback(db, runId, { ...result, reportedWorkDisposition: "needs_review" }))
        .rejects.toThrow("configured review stage with its own reviewer");
      await expect(nativeCompletionFeedback(db, runId, { ...result, reportedWorkDisposition: "needs_review",
        attentionRequests: [{ kind: "approval", summary: "Approve the page-service call.", ownerClass: "human" }] }))
        .resolves.not.toContain("configured review stage");
    } });
  });

  it("keeps ordinary completion feedback when no review stage is configured", async () => {
    await finishVerifiedDone({ beforeFinish: async (runId, result) => {
      expect(await nativeCompletionFeedback(db, runId, result)).not.toContain("configured review stage");
    } });
  });
});
