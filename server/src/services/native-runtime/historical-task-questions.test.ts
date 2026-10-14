import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, approvals, companies, completionContracts, createDb, heartbeatRuns, issueApprovals,
  issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issueWorkProducts, issues, statusDecisions,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { readTaskQuestionContext } from "../issue-question-context.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { finalizeNativeRun, pendingNativeGovernance } from "./native-run-finalizer.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { PaperclipRunnerSemanticAuthority } from "./runner-semantic-authority.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

const questionTime = new Date("2026-01-01T12:00:00Z");
const messageTime = new Date("2026-01-01T12:01:00Z");
const done: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Configuration verified.",
  completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [],
};

describe("historical task questions", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("historical-task-questions-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(conversationMode = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Question history", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Verify configuration", status: "in_progress",
      assigneeAgentId: agentId, ...(conversationMode ? { conversationAgentId: agentId,
        conversationUserId: "board-user", conversationState: "active" as const } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running",
      runtimeMode: "native", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const [question] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "ask_user_questions", status: "pending", sourceRunId: runId,
      createdByAgentId: agentId, effectiveResolverPolicy: "human_only", title: "Enable configuration",
      createdAt: questionTime, payload: { version: 1, supersedeOnUserComment: false,
        questions: [{ id: "configuration", prompt: "Which configuration action did you complete?",
          selectionMode: "single", required: true, options: [{ id: "configured", label: "Configured" }] }] },
    }).returning();
    return { companyId, agentId, issueId, runId, question, conversationMode };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function message(f: Fixture, changes: Partial<typeof issueComments.$inferInsert> = {}) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board-user", body: "Figure it out and verify it.", createdAt: messageTime, ...changes }).returning();
    return comment;
  }
  const gate = (f: Fixture) => pendingNativeGovernance({ db, ...f, executionState: null });

  it.each([false, true])("keeps old questions answerable without reminders or completion gates (chat=%s)", async conversationMode => {
    const f = await fixture(conversationMode);
    await message(f);
    expect(await gate(f)).toBeNull();
    const feedback = await nativeCompletionFeedback(db, f.runId, done);
    expect(feedback).not.toContain("waiting for a response");
    expect(feedback).not.toContain("Tell the user");
    expect(feedback).not.toContain(f.question.id);
    const blockedFeedback = await nativeCompletionFeedback(db, f.runId, {
      ...done, reportedWorkDisposition: "blocked",
      completionClaim: { ...done.completionClaim, objectiveSatisfied: false },
      blocker: { reasonCode: "missing_access", reason: "Missing test environment access",
        owner: { name: "Environment owner", kind: "user" }, unblockAction: "Grant test access", scope: "task_wide" },
    });
    expect(blockedFeedback).toContain("Explain why work cannot continue");
    expect(blockedFeedback).not.toContain(f.question.id);
    const authority = new PaperclipRunnerToolAuthority(db, f);
    expect(await authority.execute({ tool: "get_task_context", callId: "context", arguments: {} }))
      .toMatchObject({ taskQuestionContext: { questions: [{ id: f.question.id, historical: true }], truncated: false } });
    const semantic = new PaperclipRunnerSemanticAuthority(db, f);
    expect(await semantic.dispatch({ callId: "context", operationId: "get_task_context", input: {},
      correlation: { runId: f.runId, normalizedSessionId: randomUUID(), turnId: "turn", itemId: "item" } }))
      .toMatchObject({ ok: true, value: { taskQuestionContext: { questions: [{ id: f.question.id, historical: true }] } } });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.question.id)))
      .toEqual([expect.objectContaining({ status: "pending", result: null, resolvedAt: null, payload: f.question.payload })]);
  });

  it("keeps a real current question gated without commanding another reminder", async () => {
    const f = await fixture();
    expect(await gate(f)).toEqual({ kind: "interaction", id: f.question.id });
    const feedback = await nativeCompletionFeedback(db, f.runId, done);
    expect(feedback).toContain("Reassess whether");
    expect(feedback).toContain("Withdraw the question");
    expect(feedback).not.toContain("Tell the user");
  });

  it.each([false, true])("commits the correct native task status with a retained question (historical=%s)", async historical => {
    const f = await fixture();
    if (historical) await message(f);
    const contractId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    const contractSha256 = "historical-question-contract";
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Verify configuration", criteria: [{ id: "objective", requirement: "Verify configuration" }] },
      canonicalSha256: contractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, completionContractSha256: contractSha256,
      nativeSessionId: sessionId, runnerInstanceId: runnerId }).where(eq(heartbeatRuns.id, f.runId));
    const [verified] = await db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: f.issueId,
      type: "artifact", provider: "test", title: "Configuration verification", status: "completed", reviewState: "approved" }).returning();
    const evidenceRef = `work_product:${verified.id}`;
    const verifiedResult: PrpStructuredRunResult = { ...CONTROL_PLANE_CONFORMANCE_RESULT,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [evidenceRef] }] },
      evidence: [{ kind: "work_product", ref: evidenceRef }],
      verification: [{ commandOrCheck: "Configuration verification", status: "passed", artifactRef: evidenceRef }] };
    const port = new PaperclipControlPlanePort(db, { ...f, sessionId, completionContractId: contractId,
      completionContractSha256: contractSha256, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: randomUUID() });
    await port.openRun({ identity: { ...f, sessionId }, backendKind: "mock", sourceInstanceId: runnerId });
    await port.completeRun({ result: verifiedResult, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: randomUUID() });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded" });
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
      .toEqual([expect.objectContaining({ status: historical ? "done" : "in_review" })]);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, f.issueId)))
      .toEqual([expect.objectContaining({ reasonCode: historical ? "completion_contract_satisfied" : "governed_gate_pending" })]);
    if (historical) {
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.question.id)))
        .toEqual([expect.objectContaining({ status: "pending", result: null, resolvedAt: null })]);
      const answered = await issueThreadInteractionService(db).answerQuestions(
        { id: f.issueId, companyId: f.companyId, status: "done" }, f.question.id,
        { answers: [{ questionId: "configuration", optionIds: ["configured"] }] }, { userId: "board-user" });
      expect(answered).toMatchObject({ status: "answered", resolvedByUserId: "board-user",
        result: { answers: [{ questionId: "configuration", optionIds: ["configured"] }] } });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
      expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.issueId, f.issueId)))
        .toEqual([]);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .toEqual([]);
    }
  });

  it("keeps a new input blocker active after the earlier question becomes historical", async () => {
    const f = await fixture();
    await message(f);
    const [current] = await db.insert(issueThreadInteractions).values({ ...f.question, id: randomUUID(),
      title: "Select the remaining test environment", createdAt: new Date("2026-01-01T12:02:00Z") }).returning();
    expect(await gate(f)).toEqual({ kind: "interaction", id: current.id });
    expect(await nativeCompletionFeedback(db, f.runId, done)).toContain(current.id);
    expect((await readTaskQuestionContext(db, f)).questions).toEqual([
      expect.objectContaining({ id: current.id, historical: false }),
      expect.objectContaining({ id: f.question.id, historical: true }),
    ]);
  });

  it.each(["agent", "run", "derived_agent", "derived_run", "derived_source", "system", "system_notice", "deleted", "untrusted", "earlier", "same_time", "other_issue", "other_company"])
    ("does not mistake a %s comment for newer human direction", async kind => {
      const f = await fixture();
      const changes: Partial<typeof issueComments.$inferInsert> = {};
      if (kind === "agent") changes.authorAgentId = f.agentId;
      if (kind === "run") changes.createdByRunId = f.runId;
      if (kind === "derived_agent") changes.derivedAuthorAgentId = f.agentId;
      if (kind === "derived_run") changes.derivedCreatedByRunId = f.runId;
      if (kind === "derived_source") changes.derivedAuthorSource = "run_log_comment_post";
      if (kind === "system") changes.authorType = "system";
      if (kind === "system_notice") changes.presentation = { kind: "system_notice", tone: "neutral",
        title: "Automation update", detailsDefaultOpen: false };
      if (kind === "deleted") changes.deletedAt = messageTime;
      if (kind === "untrusted") changes.sourceTrust = { preset: "low_trust_review", disposition: "quarantined" };
      if (kind === "earlier") changes.createdAt = new Date("2026-01-01T11:59:00Z");
      if (kind === "same_time") changes.createdAt = questionTime;
      if (kind === "other_issue") {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
        changes.issueId = other.id;
      }
      if (kind === "other_company") {
        const other = await fixture(); changes.companyId = other.companyId; changes.issueId = other.issueId;
      }
      await message(f, changes);
      expect(await gate(f)).toEqual({ kind: "interaction", id: f.question.id });
      expect((await readTaskQuestionContext(db, f)).questions[0].historical).toBe(false);
    });

  it("compares database timestamp precision rather than rounded JavaScript dates", async () => {
    const f = await fixture(), comment = await message(f);
    await db.update(issueThreadInteractions).set({ createdAt: sql`'2026-01-01 12:00:00.000001+00'::timestamptz` })
      .where(eq(issueThreadInteractions.id, f.question.id));
    await db.update(issueComments).set({ createdAt: sql`'2026-01-01 12:00:00.000002+00'::timestamptz` })
      .where(eq(issueComments.id, comment.id));
    expect(await gate(f)).toBeNull();
  });

  it.each(["request_confirmation", "request_checkbox_confirmation", "connection_intent", "request_item_verdicts"])
    ("preserves a %s gate after a newer human message", async kind => {
      const f = await fixture();
      await db.update(issueThreadInteractions).set({ kind }).where(eq(issueThreadInteractions.id, f.question.id));
      await message(f);
      expect(await gate(f)).toEqual({ kind: "interaction", id: f.question.id });
      expect(await nativeCompletionFeedback(db, f.runId, done)).toContain("Tell the user");
    });

  it("preserves linked approvals and configured review stages", async () => {
    const f = await fixture(); await message(f);
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "request_board_approval",
      status: "pending", payload: { title: "Approve action" } }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval.id });
    expect(await gate(f)).toEqual({ kind: "approval", id: approval.id });
    expect(await nativeCompletionFeedback(db, f.runId, done)).toContain("waiting for approval");
    expect(await pendingNativeGovernance({ db, ...f, executionState: { status: "pending" } }))
      .toEqual({ kind: "execution_stage", id: f.runId });
  });

  it.each(["toolAction", "secretProposal", "connectionAuthorization"])
    ("preserves a governed %s payload even on a question-shaped request", async key => {
      const f = await fixture(true);
      await db.update(issueThreadInteractions).set({ sourceRunId: null,
        payload: sql`${issueThreadInteractions.payload} || jsonb_build_object(${key}::text, '{}'::jsonb)` })
        .where(eq(issueThreadInteractions.id, f.question.id));
      await message(f);
      expect(await gate(f)).toEqual({ kind: "interaction", id: f.question.id });
      expect(await nativeCompletionFeedback(db, f.runId, done)).toContain("Tell the user");
      expect((await readTaskQuestionContext(db, f)).questions).toEqual([]);
    });

  it("does not make a task question historical merely because it belongs to an earlier run", async () => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, f.question.id));
    expect(await gate(f)).toEqual({ kind: "interaction", id: f.question.id });
    expect((await readTaskQuestionContext(db, f)).questions[0].historical).toBe(false);
  });

  it.each([false, true])("expires questions on cancellation and rejects answers with stale task state (historical=%s)", async historical => {
    const f = await fixture();
    if (historical) await message(f);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    const service = issueThreadInteractionService(db);
    await expect(service.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" },
      f.question.id, { answers: [{ questionId: "configuration", optionIds: ["configured"] }] },
      { userId: "board-user" })).rejects.toMatchObject({ status: 409, details: { code: "interaction_issue_closed" } });
    expect(await service.expirePendingInteractionsForTerminalIssue({ id: f.issueId, companyId: f.companyId, status: "cancelled" }))
      .toEqual([expect.objectContaining({ id: f.question.id, status: "expired" })]);
  });

  it("keeps current questions and governed confirmations closed on completion", async () => {
    const f = await fixture();
    const [confirmation] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Approve publication?",
        target: { type: "custom", key: "publish" }, supersedeOnUserComment: false, rejectRequiresReason: false } }).returning();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const service = issueThreadInteractionService(db);
    await expect(service.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" },
      f.question.id, { answers: [{ questionId: "configuration", optionIds: ["configured"] }] },
      { userId: "board-user" })).rejects.toMatchObject({ status: 409, details: { code: "interaction_issue_closed" } });
    expect(await service.expirePendingInteractionsForTerminalIssue({ id: f.issueId, companyId: f.companyId, status: "done" }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: f.question.id, status: "expired" }),
        expect.objectContaining({ id: confirmation.id, status: "expired" }),
      ]));
  });

  it("keeps Agent Chat's previous-turn exception aligned in context and completion feedback", async () => {
    const f = await fixture(true);
    await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, f.question.id));
    expect(await gate(f)).toBeNull();
    expect(await nativeCompletionFeedback(db, f.runId, done)).not.toContain("current question remains unanswered");
    expect((await readTaskQuestionContext(db, f)).questions[0].historical).toBe(true);
  });
});
