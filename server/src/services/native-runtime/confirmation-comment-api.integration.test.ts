import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { initializeRunIdentity } from "../run-identity.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("confirmation reply through the native API tool", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret; });
  async function proposal(
    f: Awaited<ReturnType<typeof server.fixture>>,
    idempotencyKey: string,
    prompt: string,
    resolverPolicy?: "human_only",
  ) {
    const result = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
      idempotencyKey, interactionKind: "confirmation", title: "Approve child task", prompt,
      continuationPolicy: "wake_assignee", ...(resolverPolicy === undefined ? {} : { resolverPolicy }),
      payload: { version: 1, supersedeOnUserComment: false, acceptLabel: "Approve", rejectLabel: "Revise", rejectRequiresReason: true },
    } });
    const [card] = await server.db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, f.companyId), eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
    ));
    if (!card) throw new Error("Native proposal did not persist its confirmation");
    expect(result).toMatchObject({ disposition: "applied", interaction: { id: card.id, status: "pending" } });
    return card;
  }
  async function seed(mode: "standard" | "planning" | "ask" = "standard", resolverPolicy?: "human_only") {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true, mode });
    const card = await proposal(f, "first-task-proposal-confirmation", "Approve creating one child task to write the welcome note?", resolverPolicy);
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.userId, body: "Yes, write it." }).returning();
    const call = { tool: "call_api", callId: randomUUID(), arguments: { operationId: "POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment", pathParams: { id: f.issueId, interactionId: card.id }, body: { commentId: comment!.id, decision: "accept" } } };
    return { f, card, comment: comment!, call };
  }
  it("advertises and executes the real authenticated route, including retry", async () => {
    const { f, card, comment, call } = await seed();
    expect(card).toMatchObject({ requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "inherited" });
    const first = await f.authority.execute(call);
    expect(first).toMatchObject({ status: 200, data: { deduplicated: false, interaction: {
      id: card.id, status: "accepted", result: { outcome: "accepted", commentId: comment.id },
      resolvedByAgentId: f.agentId, resolvedByRunId: f.runId, resolvedByUserId: null,
    } } });
    const retry = await f.authority.execute({ ...call, callId: randomUUID() });
    expect(retry).toMatchObject({ status: 200, data: { deduplicated: true } });
    const snapshot = await f.snapshot();
    expect(snapshot.activity.filter(row => row.action === "issue.thread_interaction_accepted")).toHaveLength(1);
  });
  it("relays the conversation user's reply to a self-requested human-only card, but not another user's", async () => {
    const { f, card, call, comment } = await seed("standard", "human_only");
    expect(card).toMatchObject({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "requested", resolverPolicyProvenance: "explicit" });
    expect(await f.authority.execute(call)).toMatchObject({ status: 200, data: { interaction: {
      id: card.id, status: "accepted", result: { commentId: comment.id }, resolvedByAgentId: f.agentId, resolvedByUserId: null } } });
    const snapshot = await f.snapshot();
    expect(snapshot.activity.filter(row => row.action === "issue.thread_interaction_accepted"))
      .toMatchObject([{ details: { resolverPolicy: "human_only", resolution: "relayed_human_decision" } }]);

    const intruder = await seed("standard", "human_only");
    await server.db.update(issueComments).set({ authorUserId: "somebody-else" }).where(eq(issueComments.id, intruder.comment.id));
    expect(await intruder.f.authority.execute(intruder.call)).toMatchObject({ status: 403 });
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, intruder.card.id)))[0])
      .toMatchObject({ status: "pending", result: null });
    const other = await seed();
    const foreignAnswer = { ...other.call, arguments: { ...other.call.arguments, body: { ...other.call.arguments.body, commentId: comment.id } } };
    expect(await other.f.authority.execute(foreignAnswer)).toMatchObject({ status: 422 });
  });
  it("records acceptance on the revised native proposal without accepting its superseded predecessor", async () => {
    const { f, card: original } = await seed();
    const revised = await proposal(f, "first-task-proposal-confirmation-revised", "Approve creating one child task to write the revised Sunday welcome note?");
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Yes, I accept the revised Sunday proposal. Please do it." }).returning();
    const call = { tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment",
      pathParams: { id: f.issueId, interactionId: original.id }, body: { commentId: comment!.id, decision: "accept" },
    } };
    expect(await f.authority.execute(call)).toMatchObject({ status: 409 });
    expect(await f.authority.execute({ ...call, callId: randomUUID(), arguments: {
      ...call.arguments, pathParams: { ...call.arguments.pathParams, interactionId: revised.id },
    } })).toMatchObject({ status: 200, data: { interaction: { id: revised.id, status: "accepted", result: { commentId: comment!.id },
      resolvedByAgentId: f.agentId, resolvedByRunId: f.runId, resolvedByUserId: null } } });
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, original.id)))[0]).toMatchObject({
      status: "expired", result: { outcome: "superseded_by_newer_request", supersededByInteractionId: revised.id },
    });
  });
  it("retains a newer native response turn when it rejects an older proposal to revise it", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    await server.db.update(issues).set({ conversationAgentId: null, conversationUserId: null,
      conversationState: null }).where(eq(issues.id, f.issueId));
    const original = await proposal(f, "first-task-proposal-confirmation", "Approve the Saturday welcome note?");
    const nativeSessionId = randomUUID();
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), nativeSessionId })
      .where(eq(heartbeatRuns.id, f.runId));
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId,
      body: "Change the note to our Sunday meetup. Please revise your proposal; I have not accepted it yet." }).returning();
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "running", responsibleUserId: f.userId, runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId, commentId: comment!.id } });
    await initializeRunIdentity(server.db, { companyId: f.companyId, runId, issueId: f.issueId,
      responsibleUserId: f.userId!, cause: "instruction" });
    const lockedAt = new Date();
    const lease = { runId, companyId: f.companyId, issueId: f.issueId, phase: "observed", attempt: 1,
      leaseOwner: `response-${randomUUID()}`, leaseExpiresAt: new Date(lockedAt.getTime() + 20 * 60_000),
      controllerBootId: randomUUID(), controllerPid: process.pid, controllerProcessStartedAt: lockedAt,
      controllerGeneration: 1 };
    await server.db.insert(nativeRunFinalizations).values(lease);
    await server.db.update(issues).set({ status: "in_review", executionRunId: runId, checkoutRunId: runId,
      executionLockedAt: lockedAt, executionAgentNameKey: "api-eval-agent" }).where(eq(issues.id, f.issueId));
    const current = new PaperclipRunnerToolAuthority(server.db, { ...f.authority.binding, runId });
    await expect(current.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} })).resolves.toBeDefined();
    const rejected = await current.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment",
      pathParams: { id: f.issueId, interactionId: original.id }, body: { commentId: comment!.id, decision: "reject",
        reason: "User requested a revised proposal for the Sunday meetup." },
    } });
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, original.id)))[0])
      .toMatchObject({ status: "rejected", sourceRunId: f.runId, resolvedByRunId: runId, result: { commentId: comment!.id } });
    expect((await server.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "in_review", executionRunId: runId, checkoutRunId: runId,
        executionLockedAt: lockedAt, executionAgentNameKey: "api-eval-agent" });
    expect(rejected).toMatchObject({ status: 200 });
    await expect(current.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} })).resolves.toBeDefined();
    // The next attempted tool in the retained failure used this confirmation shape.
    const next = await current.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
      title: "Approve revised welcome-note task",
      prompt: "Approve creating exactly one child task to write a two-sentence garden club welcome note for our free Sunday meetup and save it as a task document?",
      payload: { version: 1, acceptLabel: "Approve", rejectLabel: "Revise", rejectRequiresReason: true, supersedeOnUserComment: false },
      idempotencyKey: "first-task-proposal-confirmation-garden-welcome-note-sunday-v2",
      interactionKind: "confirmation", continuationPolicy: "wake_assignee",
    } });
    expect(next).toMatchObject({ disposition: "applied", interaction: { status: "pending", sourceRunId: runId } });
    expect((await server.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0])
      .toMatchObject(lease);
    expect((await f.snapshot()).activity.filter(row => row.action === "issue.thread_interaction_rejected")).toHaveLength(1);
  });
  it("still requeues rejection of a proposal owned by the current response run", async () => {
    const { f, card, call } = await seed();
    await server.db.update(issues).set({ status: "in_review", checkoutRunId: f.runId,
      executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.userId);
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}/interactions/${card.id}/resolve-from-comment`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...call.arguments.body, decision: "reject", reason: "Revise this proposal." }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ interaction: { id: card.id, status: "rejected" } });
    expect((await server.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "todo", executionRunId: null, checkoutRunId: null, executionLockedAt: null });
  });
  it("preserves human-only native completion-review rejection without ordinary continuation", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const service = issueThreadInteractionService(server.db);
    const card = await service.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", sourceRunId: f.runId, resolverPolicy: "human_only", continuationPolicy: "none",
      payload: { version: 1, prompt: "Review the completed work.",
        target: { type: "custom", key: "native_completion_review", revisionId: randomUUID() } },
    }, { agentId: f.agentId, runId: f.runId });
    await server.db.update(issues).set({ status: "in_review", checkoutRunId: f.runId,
      executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
    expect(await service.rejectInteraction({ id: f.issueId, companyId: f.companyId }, card.id,
      { reason: "The work needs revision." }, { userId: f.userId }))
      .toMatchObject({ status: "rejected", effectiveResolverPolicy: "human_only", resolvedByUserId: f.userId });
    expect((await server.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "todo", executionRunId: null, checkoutRunId: null, executionLockedAt: null });
  });
  it.each([false, true])("preserves human rejection requeueing with a newer response owner=%s", async (hasNewOwner) => {
    const { f, card } = await seed();
    const runId = hasNewOwner ? randomUUID() : null;
    if (runId) await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId,
      agentId: f.agentId, status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
      invocationSource: "assignment", triggerDetail: "system" });
    await server.db.update(issues).set({ status: "in_review", executionRunId: runId,
      checkoutRunId: runId, executionLockedAt: runId ? new Date() : null }).where(eq(issues.id, f.issueId));
    const rejected = await issueThreadInteractionService(server.db).rejectInteraction(
      { id: f.issueId, companyId: f.companyId }, card.id, { reason: "Please revise the proposal." }, { userId: f.userId });
    expect(rejected).toMatchObject({ status: "rejected", resolvedByUserId: f.userId });
    expect((await server.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "todo", executionRunId: null, checkoutRunId: null, executionLockedAt: null });
  });
  it("records a conversational decision in Plan mode without opening writes in Ask mode", async () => {
    const planning = await seed("planning");
    expect(await planning.f.authority.execute(planning.call)).toMatchObject({ status: 200, data: { interaction: { status: "accepted" } } });
    const ask = await seed("ask");
    await expect(ask.f.authority.execute(ask.call)).rejects.toThrow("only reads");
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, ask.card.id)))[0]?.status).toBe("pending");
  });
  it("rejects unauthenticated HTTP requests", async () => {
    const { f, card, call, comment } = await seed();
    const url = `${server.apiUrl}/api/issues/${f.issueId}/interactions/${card.id}/resolve-from-comment`;
    expect((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(call.arguments.body) })).status).toBe(404);
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.userId);
    expect((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...call.arguments.body, actorUserId: f.userId }) })).status).toBe(400);
  });
  it("preserves formal approval authority in the HTTP route", async () => {
    const { f } = await seed();
    expect(await f.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "POST /api/approvals/{id}/approve", pathParams: { id: f.approvalId }, body: {},
    } })).toMatchObject({ ok: false, status: 403 });
    expect((await f.snapshot()).approvals.find(row => row.id === f.approvalId)?.status).toBe("pending");
  });
});
