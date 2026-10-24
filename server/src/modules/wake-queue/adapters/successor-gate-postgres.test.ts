import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";
import type { WakeQueuePostgresAdapterDeps } from "./postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";

// The release transaction's successor gate: a queued run of the releasing
// agent holds the issue only while that agent still owns it (assignee,
// current or native review participant, live source-scoped recovery, and the
// other ownership bypasses run dispatch applies). Otherwise the next owner's
// deferred wake is promoted. The adapter's other release behaviour is covered
// in `postgres.test.ts`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-queue successor gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-queue successor gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const stubDeps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => "responsible-user",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-queue-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueThreadInteractions);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    // `heartbeat_runs.wakeup_request_id` references `agent_wakeup_requests.id`,
    // so the run row must go first.
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(input: { companyId: string; name?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    issueId?: string;
    status?: string;
    assigneeAgentId?: string | null;
    executionRunId?: string | null;
    checkoutRunId?: string | null;
    parentId?: string | null;
    identifier?: string;
  }): Promise<string> {
    const issueId = input.issueId ?? randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Wake-queue adapter fixture issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionRunId: input.executionRunId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
      parentId: input.parentId ?? null,
      identifier: input.identifier,
    });
    return issueId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown>;
    errorCode?: string | null;
    runtimeMode?: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status ?? "failed",
      contextSnapshot: input.contextSnapshot ?? {},
      errorCode: input.errorCode ?? null,
    });
    return runId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestedByActorType?: string;
    requestedByActorId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: input.requestedByActorType ?? "user",
      requestedByActorId: input.requestedByActorId ?? null,
      payload: { issueId: input.issueId, ...(input.payload ?? {}) },
    });
    return id;
  }

  it("promotes the new assignee's deferred wake past a queued successor of the agent that handed the issue over", async () => {
    const companyId = await seedCompany();
    const previousOwnerId = await seedAgent({ companyId, name: "Reviewer" });
    const newOwnerId = await seedAgent({ companyId, name: "Approver" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: newOwnerId });
    const runId = await seedRun({ companyId, agentId: previousOwnerId, status: "succeeded", contextSnapshot: { issueId } });
    const staleRunId = await seedRun({ companyId, agentId: previousOwnerId, status: "queued", contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId: newOwnerId, issueId });
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    const result = await release({ companyId, runId, now: new Date() });
    expect(result.outcome.kind).toBe("promoted");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const promoted = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .find(candidate => candidate.agentId === newOwnerId);
    expect(promoted).toMatchObject({ status: "queued" });
    expect(wake).toMatchObject({ status: "queued", runId: promoted!.id });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ assigneeAgentId: newOwnerId, executionRunId: promoted!.id });
    const [stale] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, staleRunId));
    expect(stale.status).toBe("queued");
  });

  // A pending native completion review of the worker's applied decision, addressed to the reviewer.
  async function seedNativeReview(input: { companyId: string; workerId: string; reviewerId: string; issueId: string }) {
    const { companyId, workerId, reviewerId, issueId } = input;
    const sourceRunId = randomUUID(), decisionId = randomUUID(), interactionId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "1",
      policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "agent", createdByActorId: workerId });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId,
      completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {},
      canonicalSha256: randomUUID() });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId,
      resultId, triggerKind: "test", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId,
      decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review",
      reasonCode: "completion_review", decisionJson: { projectedStatusVersion: 1 }, decisionDigest: randomUUID(),
      applicationState: "applied" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation",
      status: "pending", continuationPolicy: "wake_assignee", requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "inherited", sourceRunId, addresseeAgentId: reviewerId,
      payload: { version: 1, prompt: "Review", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } } });
    await db.update(issues).set({ status: "in_review", statusVersion: 1, lastStatusDecisionId: decisionId })
      .where(eq(issues.id, issueId));
    return { nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId };
  }

  it.each([true, false])("lets a queued native completion review hold the issue only while its assignment is live: %s", async (live) => {
    const companyId = await seedCompany();
    const reviewerId = await seedAgent({ companyId, name: "Reviewer" });
    const workerId = await seedAgent({ companyId, name: "Worker" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: workerId });
    const reviewContext = await seedNativeReview({ companyId, workerId, reviewerId, issueId });
    // The board reassigns the issue, so the saved review ids no longer resolve to an assignment.
    const wakeAgentId = live ? workerId : await seedAgent({ companyId, name: "New owner" });
    if (!live) await db.update(issues).set({ assigneeAgentId: wakeAgentId }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId: reviewerId, status: "succeeded", contextSnapshot: { issueId } });
    await seedRun({ companyId, agentId: reviewerId, status: "queued", contextSnapshot: { issueId, ...reviewContext } });
    const wakeId = await seedDeferredWake({ companyId, agentId: wakeAgentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drained = false;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      drained = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(drained).toBe(!live);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    if (live) expect(wake.status).toBe("deferred_issue_execution");
  });

  it.each([true, false])("lets a queued source-scoped recovery hold the issue only while its action is live: %s", async (live) => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent({ companyId, name: "Recovery owner" });
    const assigneeId = await seedAgent({ companyId, name: "Assignee" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: assigneeId });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: live ? "active" : "resolved", ownerType: "agent", ownerAgentId: ownerId,
      cause: "stranded_assigned_issue", fingerprint: `source-scoped:${issueId}`, evidence: {},
      nextAction: "Recover the issue." }).returning();
    const runId = await seedRun({ companyId, agentId: ownerId, status: "succeeded", contextSnapshot: { issueId } });
    await seedRun({ companyId, agentId: ownerId, status: "queued", contextSnapshot: {
      issueId, wakeReason: "source_scoped_recovery_action", recoveryActionId: action!.id,
    } });
    await seedDeferredWake({ companyId, agentId: assigneeId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drained = false;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      drained = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(drained).toBe(!live);
  });

  it("keeps a queued successor of the current review participant ahead of other deferred wakes", async () => {
    const companyId = await seedCompany();
    const reviewerId = await seedAgent({ companyId, name: "Reviewer" });
    const assigneeId = await seedAgent({ companyId, name: "Producer" });
    const issueId = await seedIssue({ companyId, status: "in_review", assigneeAgentId: assigneeId });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: assigneeId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId: reviewerId, status: "succeeded", contextSnapshot: { issueId } });
    await seedRun({ companyId, agentId: reviewerId, status: "queued", contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId: assigneeId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drained = false;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      drained = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(drained).toBe(false);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
  });
});
