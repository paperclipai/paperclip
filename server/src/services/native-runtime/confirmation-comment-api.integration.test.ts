import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { runnerApiMutationRestriction } from "./runner-api-policy.js";

describe("confirmation reply through the native API tool", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret; });
  async function seed(mode: "standard" | "planning" | "ask" = "standard") {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true, mode });
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const card = await issueThreadInteractionService(server.db).create(issue!, createIssueThreadInteractionSchema.parse({ kind: "request_confirmation", payload: { version: 1, prompt: "Write the welcome note?" } }), { agentId: f.agentId });
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.userId, body: "Yes, write it." }).returning();
    const call = { tool: "call_api", callId: randomUUID(), arguments: { operationId: "POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment", pathParams: { id: f.issueId, interactionId: card.id }, body: { commentId: comment!.id, decision: "accept" } } };
    return { f, card, comment: comment!, call };
  }
  it("advertises and executes the real authenticated route, including retry", async () => {
    const { f, card, comment, call } = await seed();
    const first = await f.authority.execute(call);
    expect(first).toMatchObject({ status: 200, data: { deduplicated: false, interaction: { id: card.id, status: "accepted", result: { commentId: comment.id } } } });
    const retry = await f.authority.execute({ ...call, callId: randomUUID() });
    expect(retry).toMatchObject({ status: 200, data: { deduplicated: true } });
    const snapshot = await f.snapshot();
    expect(snapshot.activity.filter(row => row.action === "issue.thread_interaction_accepted")).toHaveLength(1);
  });
  it("denies human-only resolution and foreign-message provenance through the same tool", async () => {
    const { f, card, call, comment } = await seed();
    await server.db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, card.id));
    expect(await f.authority.execute(call)).toMatchObject({ status: 403 });
    const other = await seed();
    const foreignAnswer = { ...other.call, arguments: { ...other.call.arguments, body: { ...other.call.arguments.body, commentId: comment.id } } };
    expect(await other.f.authority.execute(foreignAnswer)).toMatchObject({ status: 422 });
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
  it("does not open the ordinary interaction or governance mutation routes", () => {
    for (const operation of ["accept", "reject", "respond", "verdicts", "withdraw"]) {
      expect(runnerApiMutationRestriction(`/api/issues/{id}/interactions/{interactionId}/${operation}`)).not.toBeNull();
    }
    expect(runnerApiMutationRestriction("/api/issues/{id}/interactions/{interactionId}/resolve-from-comment")).toBeNull();
  });
});
