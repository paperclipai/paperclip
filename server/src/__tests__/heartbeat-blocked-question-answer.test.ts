import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Wrote the brief with the answer.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("an answer to the agent's own question continues the task it blocked on", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const userId = "blocked-question-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-question-answer-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: "board@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seed(options: { askAfterBlock?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Question fixture",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the brief", status: "in_review",
      assigneeAgentId: agentId, responsibleUserId: userId });
    if (options.askAfterBlock) await agentReportsBlocker({ companyId, agentId, issueId });
    const askingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: askingRunId, companyId, agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId }, finishedAt: new Date() });
    const [question] = await db.insert(issueThreadInteractions).values({ companyId, issueId,
      createdByAgentId: agentId, sourceRunId: askingRunId, kind: "ask_user_questions", status: "pending",
      continuationPolicy: "wake_assignee", title: "Pick a codename",
      payload: { version: 1, questions: [{ id: "codename", prompt: "Which codename?", selectionMode: "single",
        options: [{ id: "alpha", label: "ALPHA" }, { id: "bravo", label: "BRAVO" }] }] },
    }).returning();
    return { companyId, agentId, issueId, question: question! };
  }

  async function agentReportsBlocker(input: { companyId: string; agentId: string; issueId: string }): Promise<void> {
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: input.companyId, issueId: input.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: input.issueId, invocationSource: "automation",
      triggerDetail: "system", completionContractId: contractId, contextSnapshot: { issueId: input.issueId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: input.companyId, issueId: input.issueId,
      runId, completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: resultId });
    const [snapshot] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    await db.insert(workAssessments).values({ id: assessmentId, companyId: input.companyId, issueId: input.issueId,
      runId, contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: input.companyId,
      priorIssueStatus: snapshot!.status, priorStatusVersion: snapshot!.statusVersion,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: input.companyId, issueId: input.issueId,
      phase: "arbitrating", resultId, assessmentId });
    await commitNativeStatusDecision({
      db, companyId: input.companyId, issueId: input.issueId, runId, assessmentId,
      priorStatus: snapshot!.status, priorStatusVersion: Number(snapshot!.statusVersion),
      priorDecisionId: snapshot!.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "blocked", toStatus: "blocked",
        reasonCode: "current_track_blocker_waiting",
        unblockDescriptor: { owner: "board", action: "Answer the pending codename question." },
        effects: [{ kind: "release_checkout" }] },
    });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  }

  async function answer(question: typeof issueThreadInteractions.$inferSelect) {
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: userId, resolvedAt: new Date(),
      result: { version: 1, answers: [{ questionId: "codename", optionIds: ["bravo"] }] } })
      .where(eq(issueThreadInteractions.id, question.id));
  }

  async function deliverAnswer(input: { agentId: string; issueId: string; questionId: string }) {
    const context = { issueId: input.issueId, mutation: "interaction", interactionId: input.questionId,
      interactionKind: "ask_user_questions", interactionStatus: "answered",
      interactionResolvedAt: new Date().toISOString(), wakeReason: "issue_commented" };
    const run = await heartbeat.wakeup(input.agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_commented", payload: context, contextSnapshot: context,
      requestedByActorType: "user", requestedByActorId: userId });
    await heartbeat.drainActiveRunExecutions();
    return run ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]! : null;
  }

  it("delivers the answer when the agent blocked the task to wait for it", async () => {
    mockAdapterExecute.mockClear();
    const { agentId, issueId, question, companyId } = await seed();
    await agentReportsBlocker({ companyId, agentId, issueId });
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked!.status).toBe("blocked");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, blocked!.lastStatusDecisionId!));
    expect(decision!.decisionJson).toMatchObject({ awaitingInteractionIds: [question.id] });
    await answer(question);
    const run = await deliverAnswer({ agentId, issueId, questionId: question.id });
    expect({ status: run?.status, errorCode: run?.errorCode ?? null, error: run?.error ?? null })
      .toEqual({ status: "succeeded", errorCode: null, error: null });
    expect(run?.startedAt).not.toBeNull();
    expect(run?.contextSnapshot).toMatchObject({ interactionId: question.id, interactionStatus: "answered" });
    expect(mockAdapterExecute).toHaveBeenCalled();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ blockedTransitionAt: null, unblockDescriptor: null });
  }, 60_000);

  it("keeps cancelling the answer when a person blocked the task after the agent", async () => {
    mockAdapterExecute.mockClear();
    const { agentId, issueId, question, companyId } = await seed();
    await agentReportsBlocker({ companyId, agentId, issueId });
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date() }).where(eq(issues.id, issueId));
    await answer(question);
    const run = await deliverAnswer({ agentId, issueId, questionId: question.id });
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps cancelling the answer when the question did not exist when the agent blocked", async () => {
    mockAdapterExecute.mockClear();
    const { agentId, issueId, question } = await seed({ askAfterBlock: true });
    await answer(question);
    const run = await deliverAnswer({ agentId, issueId, questionId: question.id });
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps cancelling the answer once the task is done", async () => {
    mockAdapterExecute.mockClear();
    const { agentId, issueId, question, companyId } = await seed();
    await agentReportsBlocker({ companyId, agentId, issueId });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    await answer(question);
    const run = await deliverAnswer({ agentId, issueId, questionId: question.id });
    if (run) expect(run).toMatchObject({ status: "cancelled" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  it("does not check out a task whose verified block changed before checkout", async () => {
    const { agentId, issueId, question, companyId } = await seed();
    await agentReportsBlocker({ companyId, agentId, issueId });
    await answer(question);
    const [verified] = await db.select().from(issues).where(eq(issues.id, issueId));
    const blockedState = { lastStatusDecisionId: verified!.lastStatusDecisionId!, statusVersion: Number(verified!.statusVersion) };
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await db.update(issues).set({ status: "blocked", unblockDescriptor: { owner: "board", action: "Person's new blocker" } })
      .where(eq(issues.id, issueId));
    await expect(issueService(db).checkout(issueId, agentId, ["in_progress", "in_review", "blocked"], null, { blockedState }))
      .rejects.toThrow();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
      .toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: "Person's new blocker" } });
  }, 60_000);
});
