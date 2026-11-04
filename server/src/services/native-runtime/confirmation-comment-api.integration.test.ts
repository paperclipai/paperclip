import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueComments, issueThreadInteractions } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";

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
  it("denies human-only resolution and foreign-message provenance through the same tool", async () => {
    const { f, card, call, comment } = await seed("standard", "human_only");
    expect(card).toMatchObject({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit" });
    expect(await f.authority.execute(call)).toMatchObject({ status: 403 });
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0]).toMatchObject({ status: "pending", result: null });
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
