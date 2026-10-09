import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, issueRecoveryActions, issueThreadInteractions, nativeRunResults, statusDecisions, workAssessments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});

import { reconcileAbandonedExecutionControl } from "./execution-control-reconciliation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileAbandonedExecutionControl reports a genuine failed transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAbandonedRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const pastDeadline = new Date(Date.now() - 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Control Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stuck worker",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      executionControlDeadlineAt: pastDeadline,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Abandoned execution control fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      checkoutRunId: runId,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("reports exactly one Sentry event for a genuine finalization-deadline failure", async () => {
    const { runId } = await seedAbandonedRunFixture();
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    const result = await reconcileAbandonedExecutionControl(db);

    expect(result.surfaced).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("execution_finalization_deadline_exceeded");

    await vi.waitFor(() => {
      expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(1);
    }, { timeout: 5_000 });
    const newCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBefore);
    expect(newCaptures[0]?.[0]).toMatchObject({
      runId,
      runStatus: "failed",
      errorCode: "execution_finalization_deadline_exceeded",
    });
  });

  it("reports zero events for a repeated sweep over the same already-failed run", async () => {
    const { runId } = await seedAbandonedRunFixture();
    await reconcileAbandonedExecutionControl(db);
    // The first report is fire-and-forget. Observe it before taking the
    // second sweep's baseline, so a late first report is not a duplicate.
    await vi.waitFor(() => {
      expect(mockCaptureRunFailure.mock.calls.filter(([event]) => event.runId === runId)).toHaveLength(1);
    }, { timeout: 5_000 });
    // The first sweep already cleared executionControlDeadlineAt and moved the
    // run to "failed". Restore the deadline to simulate a second sweep still
    // observing the same run as a candidate.
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));

    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;
    const result = await reconcileAbandonedExecutionControl(db);

    // The run is already terminal ("failed"), so the early terminal-status
    // guard applies and no second "failed" write happens.
    expect(result.surfaced).toBe(1);
    expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(0);
  });
});

describeEmbeddedPostgres("native review execution reconciliation admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it.each([true, false])("only releases the exact admitted review (admitted=%s)", async (admitted) => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const sourceRunId = randomUUID();
    const decisionId = randomUUID();
    const interactionId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Reviewer recovery", issuePrefix: admitted ? "RRA" : "RRN" });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", adapterType: "codex_local", status: "idle" },
      { id: reviewerId, companyId, name: "Reviewer", adapterType: "codex_local", status: "running" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: reviewerId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, executionControlDeadlineAt: new Date(now.getTime() - 60_000),
      contextSnapshot: { issueId, ...(admitted ? { nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId } : {}) },
    });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review task", status: "in_review", statusVersion: 1,
      lastStatusDecisionId: decisionId, assigneeAgentId: workerId, executionRunId: runId, checkoutRunId: runId,
    });
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "1", policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "agent", createdByActorId: workerId });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId, completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {}, canonicalSha256: randomUUID() });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId, resultId, triggerKind: "test", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(statusDecisions).values({
      id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId: assessmentId, decisionVersion: 1,
      policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "completion_review",
      decisionJson: { projectedStatusVersion: 1 }, decisionDigest: randomUUID(), applicationState: "applied",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited", sourceRunId: sourceRunId, addresseeAgentId: reviewerId,
      payload: { version: 1, prompt: "Review", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } },
    });
    await reconcileAbandonedExecutionControl(db, now);
    await reconcileAbandonedExecutionControl(db, now);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [review] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(updatedIssue).toMatchObject({ assigneeAgentId: workerId, executionRunId: admitted ? null : runId, checkoutRunId: admitted ? null : runId });
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(recovery).toHaveLength(admitted ? 1 : 0);
    if (admitted) expect(recovery[0]).toMatchObject({ maxAttempts: 3, wakePolicy: null, returnOwnerAgentId: workerId });
    expect(updatedRun?.status).toBe("failed");
    expect(review?.status).toBe("pending");
  });
});
