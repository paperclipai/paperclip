import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueWorkProducts, issues, statusDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";


const staleRead = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("../issue-execution-policy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../issue-execution-policy.js")>();
  return { ...actual, completionReviewStageEntry: (...args: Parameters<typeof actual.completionReviewStageEntry>) => {
    if (staleRead.remaining > 0) { staleRead.remaining -= 1; return { kind: "none" as const }; }
    return actual.completionReviewStageEntry(...args);
  } };
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native completion when the review policy changes before commit", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-review-stage-race-");
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

  it("does not close a task whose policy gained a review stage after the finalizer read it", async () => {
    // The finalizer reads the task as having no stage (a stale read); the
    // committer then sees the configured stage under the lock.
    staleRead.remaining = 1;
    const r = await finishVerifiedDone({ stage: "user" });
    expect(r.task.status).not.toBe("done");
    expect(r.decisions.some(row => row.toStatus === "done")).toBe(false);
  });
});
