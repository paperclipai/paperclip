import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completionContracts, nativeRunResults, nativeRunFinalizations, workAssessments, statusDecisions, statusDecisionEffects,
  agents, toolActionDeliveries, toolActionRequests, toolInvocations, toolGatewaySessions, toolCallEvents, toolAccessAuditEvents, toolPolicies,
  companySecretBindings, companySecretProposals, companySecrets, createDb,
  chatPublications, heartbeatRuns, issueComments, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { prepareConversationTurn } from "../services/agent-conversations.js";
import { dismissAutomaticCompletionReviews } from "../services/native-runtime/automatic-completion-reviews.js";
import { dismissObsoleteNativePolicyReviews } from "../services/native-runtime/obsolete-policy-reviews.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_GOVERNED_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after governed interaction writes", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-governed-milestones-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; f = await fixtures.create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(companySecretProposals).where(eq(companySecretProposals.companyId, f.companyId));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
    await db.delete(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    await db.delete(toolActionDeliveries).where(eq(toolActionDeliveries.companyId, f.companyId));
    await db.delete(toolGatewaySessions).where(eq(toolGatewaySessions.companyId, f.companyId));
    await db.delete(toolCallEvents).where(eq(toolCallEvents.companyId, f.companyId));
    await db.delete(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.companyId));
    await db.delete(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    await db.delete(toolInvocations).where(eq(toolInvocations.companyId, f.companyId));
    await db.delete(toolPolicies).where(eq(toolPolicies.companyId, f.companyId));
    await fixtures.cleanup();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush();
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet() {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = () => db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issueId));

  async function run(status: "failed" | "running" = "failed") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      responsibleUserId: f.userId, status, errorCode: "test_run_failed", updatedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    return runId;
  }

  it.each(["approved", "rejected", "withdrawn", "expired", "rolled back", "parent rejected"] as const)("reactivates after a binding proposal is %s", async status => {
    const runId = await run();
    // Binding review needs secret metadata, not the provider value. No secret is resolved.
    const [secret] = await db.insert(companySecrets).values({ companyId: f.companyId, name: "test/binding", key: "BINDING_TEST" }).returning();
    const parent = status === "parent rejected" ? (await db.insert(companySecretProposals).values({
      companyId: f.companyId, kind: "secret", proposedName: "test/parent", proposedKey: "PARENT_TEST",
      justification: "Pending parent secret", proposedByAgentId: f.agentId, originRunId: runId,
      originIssueId: f.issueId, expiresAt: new Date(Date.now() + 86_400_000),
    }).returning())[0] : null;
    const proposals = createSecretProposalsService(db);
    const proposal = await proposals.createBinding({ companyId: f.companyId, heartbeatRunId: runId }, {
      ...(parent ? { secretProposalId: parent.id } : { secretId: secret.id }), configPath: "env.BINDING_TEST", justification: "Use the existing company credential", bindingTargetPolicy: "self_and_reports",
    });
    expect(proposal.interactionId).toBeTruthy();
    await start(); expect(await publications()).toEqual([]); await quiet();
    if (status === "rolled back") {
      await expect(db.transaction(async tx => {
        await createSecretProposalsService(tx as unknown as typeof db).transition(f.companyId, proposal.id, "rejected");
        throw new Error("rollback proposal");
      })).rejects.toThrow("rollback proposal");
      expect((await proposals.getById(f.companyId, proposal.id))?.status).toBe("pending");
      await flush(); expect(await publications()).toEqual([]); await quiet();
      await proposals.transition(f.companyId, proposal.id, "rejected");
    } else if (parent) {
      await proposals.transition(f.companyId, parent.id, "rejected");
      expect((await proposals.getById(f.companyId, proposal.id))?.status).toBe("rejected");
    } else if (status === "approved") {
      await proposals.approve(f.companyId, proposal.id, { resolvedByUserId: f.userId });
    } else if (status === "expired") {
      expect(await proposals.sweepExpired(new Date(proposal.expiresAt.getTime() + 1))).toBe(1);
    } else if (status === "rejected" || status === "withdrawn") {
      await proposals.transition(f.companyId, proposal.id, status, { resolvedByUserId: f.userId, proposerAgentId: f.agentId });
    }
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, proposal.interactionId!)))[0].status)
      .toBe(status === "approved" ? "accepted" : status === "withdrawn" ? "cancelled" : status === "rolled back" || status === "parent rejected" ? "rejected" : status);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${runId}:failed:${f.endpointId}`);
    await quiet();
  });
  it.each(["approved", "rejected", "expired"] as const)("reactivates after a tool review is %s", async status => {
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, f.agentId));
    const runId = await run("running");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Ask first", policyType: "require_approval",
      selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const remote = vi.fn(async () => { throw new Error("Review must not invoke the provider"); });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "milestone-review-fixture", remoteHttpRequest: remote });
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.agentId, runId });
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "test" } }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    expect(request.interactionId).toBeTruthy();
    // The prompt could not be delivered, and the run failed while awaiting review.
    // The pending review still owns its response until the board resolves it.
    await db.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.issueId, f.issueId));
    await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await start();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${runId}:`))).toBe(false);
    await quiet();
    if (status === "expired") {
      await db.update(toolActionRequests).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(toolActionRequests.id, request.id));
      await gateway.sweepExpiredActionReviews();
    } else {
      await commitToolActionReview(db, { companyId: f.companyId, actionRequestId: request.id, decision: status, actor: { userId: f.userId } });
    }
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.interactionId!)))[0].status)
      .toBe(status === "approved" ? "accepted" : status);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${runId}:failed:${f.endpointId}`);
    await quiet(); expect(remote).not.toHaveBeenCalled();
  });

  it.each([
    ["automatic", "prompt"], ["automatic", "no prompt"], ["automatic", "explicit request"],
    ["obsolete", "prompt"], ["obsolete", "no prompt"], ["obsolete", "explicit request"],
  ] as const)("handles %s review retirement with %s", async (kind, history) => {
    const runId = await run(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const prompt = kind === "automatic"
      ? "Review the persisted native-run evidence and confirm whether this issue may be completed."
      : "Review the superseding native policy assessment.";
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: kind === "automatic" ? "low" : "standard",
      completionAuthority: kind === "automatic" ? "agent_claim_policy" : "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Respond to chat" }, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, completionContractId: contractId,
      resultJson: { presentationDecision: { source: "none" } } }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded" } } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "committed", resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.issueId, runId,
      contractId, resultId, triggerKind: "run_result", triggerActorCompanyId: f.companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 0, policyVersion: "phase6-v1", assessmentJson: { attentionRequests: [] }, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: f.companyId, issueId: f.issueId, runId, assessmentId,
      decisionVersion: 1, policyVersion: "phase6-v1", fromStatus: "in_progress", toStatus: "in_review", applicationState: "applied",
      reasonCode: kind === "automatic" ? "completion_claim_incomplete" : "completion_review_required", decisionDigest: decisionId,
      decisionJson: { projectedStatusVersion: 1, effects: [{ kind: "bind_reviewer", prompt, ownerUserId: null },
        ...(kind === "obsolete" ? [{ kind: "append_superseding_assessment" }] : [])] } });
    await db.update(issues).set({ status: "in_review", statusVersion: 1, lastStatusDecisionId: decisionId }).where(eq(issues.id, f.issueId));
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", sourceRunId: runId, idempotencyKey: `native-review:${decisionId}`, status: "pending",
      payload: { version: 1, prompt: history === "explicit request" ? "Review the release before publishing." : prompt,
        target: { type: "custom", key: "native_completion_review", revisionId: decisionId } } }).returning();
    await db.insert(statusDecisionEffects).values({ companyId: f.companyId, issueId: f.issueId, decisionId,
      ordinal: 0, effectKind: "bind_reviewer", targetType: "issue_thread_interaction", targetId: interaction.id,
      idempotencyKey: decisionId, payload: {}, deliveryState: "delivered" });
    // System cards are no longer externalized, but stored prompt rows still own
    // the response slot. Exercise their supported retirement rather than insert
    // a synthetic new provider send through today's author-validation boundary.
    if (history !== "no prompt") await db.insert(chatPublications).values({ companyId: f.companyId, issueId: f.issueId,
      endpointId: f.endpointId, conversationId: f.conversationId, state: "pending", payload: { text: prompt, interactionId: interaction.id },
      idempotencyKey: `interaction:${interaction.id}:${f.endpointId}` });
    const notices = async () => (await publications()).filter(row => row.idempotencyKey === `run:${runId}:completed:${f.endpointId}`);
    const retire = () => kind === "automatic" ? dismissAutomaticCompletionReviews(db, f.issueId) : dismissObsoleteNativePolicyReviews(db, [runId]);
    await start(); expect(await notices()).toHaveLength(history === "no prompt" ? 1 : 0); await quiet();
    await retire();
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status)
      .toBe(history === "explicit request" ? "pending" : "cancelled");
    await flush(); expect(await notices()).toHaveLength(history === "explicit request" ? 0 : 1); await quiet();
    await retire(); await flush(); expect(await notices()).toHaveLength(history === "explicit request" ? 0 : 1); await quiet();
  });

  it("rechecks a stored chat binding when a conversation reset expires its question", async () => {
    const runId = await run();
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
    const interaction = await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", sourceRunId: runId, continuationPolicy: "wake_assignee",
      payload: { version: 1, title: "Choose", questions: [{ id: "choice", prompt: "Continue?", selectionMode: "single",
        options: [{ id: "yes", label: "Yes" }], required: true }] },
    }, { agentId: f.agentId, runId });
    // Failed delivery leaves the pending question itself as the response owner.
    await db.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.issueId, f.issueId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "/new" }).returning();
    const [resetRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: f.issueId, source: "issue.comment", wakeCommentId: comment.id } }).returning();
    await start();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${runId}:`))).toBe(false); await quiet();
    expect(await prepareConversationTurn(db, resetRun)).toMatchObject({ reset: true });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe("expired");
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${runId}:failed:${f.endpointId}`);
    await quiet();
  });

});
