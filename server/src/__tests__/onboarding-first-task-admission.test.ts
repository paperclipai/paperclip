import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authUsers, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { documentService } from "../services/documents.js";
import { resolveConfirmationFromComment } from "../services/confirmation-comment-resolution.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping first-task admission database tests: ${support.reason}`);
describe.skipIf(!support.supported)("onboarding first-task execution admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const fixture = async () => {
    const f = await server.fixture({ disableWakeOnDemand: true, connectionScenario: "fresh" });
    await server.db.update(issues).set({ originKind: "onboarding_first_task" }).where(eq(issues.id, f.issueId));
    return f;
  };

  it("rejects native child creation before persisted human proposal acceptance", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    await expect(authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Execute proposed work", idempotencyKey: "before-acceptance", status: "todo",
    } })).rejects.toThrow(/proposal.*accept/i);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
    expect(wakes).toEqual([]);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
  });

  it.each(["root", "child"])("rejects generic %s creation including explicit standalone parent before acceptance", async path => {
    const f = await fixture();
    const before = await f.snapshot();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)!;
    const route = path === "root" ? `/api/companies/${f.companyId}/issues` : `/api/issues/${f.issueId}/children`;
    const response = await fetch(`${server.apiUrl}${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bypass proposal", parentId: null, assigneeAgentId: f.agentId, status: "todo" }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toMatch(/proposal.*accept/i);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
  });

  const create = (f: Awaited<ReturnType<typeof fixture>>, key = randomUUID()) => f.authority.execute({
    tool: "create_task", callId: randomUUID(), arguments: { title: "Approved execution", idempotencyKey: key, status: "backlog" },
  });
  const proposal = async (f: Awaited<ReturnType<typeof fixture>>, checkbox = false) => {
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const plan = checkbox ? (await documentService(server.db).upsertIssueDocument({
      issueId: f.issueId, key: "plan", title: "First task plan", format: "markdown", body: "Create and verify the approved deliverable.",
      createdByAgentId: f.agentId, createdByRunId: f.runId,
    })).document : null;
    const svc = issueThreadInteractionService(server.db);
    const card = await svc.create(issue, checkbox ? {
      kind: "request_checkbox_confirmation", payload: { version: 1, prompt: "Approve this plan?",
        options: [{ id: "execute", label: "Execute the plan" }], defaultSelectedOptionIds: ["execute"], minSelected: 1,
        target: { type: "issue_document", key: "plan", issueId: f.issueId, documentId: plan!.id, revisionId: plan!.latestRevisionId! } },
    } : { kind: "request_confirmation", payload: { version: 1, prompt: "Create one task for the agreed deliverable?" } }, { agentId: f.agentId });
    return { issue, card, svc, plan };
  };
  const accept = async (f: Awaited<ReturnType<typeof fixture>>, p: Awaited<ReturnType<typeof proposal>>) => {
    await p.svc.acceptInteraction(p.issue, p.card.id, p.plan ? { selectedOptionIds: ["execute"] } : {}, { userId: f.responsibleUserId! });
  };

  it.each([false, true])("admits persisted human proposal acceptance (checkbox=%s)", async checkbox => {
    const f = await fixture();
    const p = await proposal(f, checkbox);
    await accept(f, p);
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("admits a persisted conversational acceptance with actual same-task human comment provenance", async () => {
    const f = await fixture();
    const p = await proposal(f);
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.responsibleUserId!, authorType: "user", body: "Yes, create that task." }).returning();
    await resolveConfirmationFromComment(server.db, { companyId: f.companyId, issueId: f.issueId,
      interactionId: p.card.id, actor: { agentId: f.agentId, runId: f.runId }, input: { commentId: comment.id, decision: "accept" } });
    const [saved] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, p.card.id));
    expect(saved).toMatchObject({ status: "accepted", resolvedByAgentId: f.agentId, resolvedByUserId: null,
      result: { outcome: "accepted", commentId: comment.id } });
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it.each(["card", "conversation"])("preserves valid %s acceptance across clocks and a changed responding user", async kind => {
    const f = await fixture();
    const originalUserId = randomUUID();
    await server.db.insert(authUsers).values({ id: originalUserId, name: "Original requester",
      email: `${originalUserId}@fixture.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: originalUserId, status: "active", membershipRole: "member" });
    await server.db.update(issues).set({ responsibleUserId: originalUserId }).where(eq(issues.id, f.issueId));
    const p = await proposal(f);
    if (kind === "card") await accept(f, p);
    else {
      const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: f.responsibleUserId!, authorType: "user", body: "Yes, create that task." }).returning();
      await resolveConfirmationFromComment(server.db, { companyId: f.companyId, issueId: f.issueId,
        interactionId: p.card.id, actor: { agentId: f.agentId, runId: f.runId }, input: { commentId: comment.id, decision: "accept" } });
    }
    // Database-created timestamps and application decision timestamps have
    // independent clocks. Persisted authority must not depend on their order.
    await server.db.update(issueThreadInteractions).set({ resolvedAt: new Date(new Date(p.card.createdAt).getTime() - 100) })
      .where(eq(issueThreadInteractions.id, p.card.id));
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("preserves acceptance of a previously dismissed proposal", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await p.svc.dismissInteraction(p.issue, p.card.id, { userId: f.responsibleUserId! });
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    await accept(f, p);
    const [saved] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, p.card.id));
    expect(saved.dismissedAt).not.toBeNull();
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it.each(["opening-answer", "agent-self-accept", "old-comment", "foreign-comment", "derived-comment", "governed-accept", "foreign-source-run"])(
    "does not treat %s as persisted human proposal acceptance", async kind => {
      const f = await fixture();
      const p = await proposal(f);
      if (kind === "opening-answer") {
        await server.db.update(issueThreadInteractions).set({ kind: "ask_user_questions", status: "answered",
          result: { version: 1, answers: [] }, resolvedByUserId: f.responsibleUserId!, resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, p.card.id));
      } else if (kind === "agent-self-accept") {
        await p.svc.acceptInteraction(p.issue, p.card.id, {}, { agentId: f.agentId, runId: f.runId });
      } else if (kind === "governed-accept") {
        await accept(f, p);
        await server.db.update(issueThreadInteractions).set({ payload: { ...p.card.payload, toolAction: {} } as never }).where(eq(issueThreadInteractions.id, p.card.id));
      } else if (kind === "foreign-source-run") {
        const other = await server.fixture({ disableWakeOnDemand: true });
        await accept(f, p);
        await server.db.update(issueThreadInteractions).set({ sourceRunId: other.runId }).where(eq(issueThreadInteractions.id, p.card.id));
      } else {
        const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId,
          issueId: kind === "foreign-comment" ? f.blockerId : f.issueId,
          authorUserId: f.responsibleUserId!, authorType: "user", body: "A reply",
          ...(kind === "old-comment" ? { createdAt: new Date(new Date(p.card.createdAt).getTime() - 1_000) } : {}),
          ...(kind === "derived-comment" ? { derivedAuthorAgentId: f.agentId, derivedCreatedByRunId: f.runId } : {}),
        }).returning();
        await server.db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(),
          resolvedByAgentId: f.agentId, resolvedByRunId: f.runId,
          result: { version: 1, outcome: "accepted", commentId: comment.id } }).where(eq(issueThreadInteractions.id, p.card.id));
      }
      await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    });

  it.each(["pending", "rejected"])("a newer cross-kind %s proposal supersedes old acceptance", async status => {
    const f = await fixture();
    const old = await proposal(f);
    await accept(f, old);
    const current = await proposal(f, true);
    await server.db.update(issueThreadInteractions).set({ createdAt: new Date(new Date(old.card.createdAt).getTime() + 1_000),
      ...(status === "rejected" ? { status, resolvedByUserId: f.responsibleUserId!, resolvedAt: new Date(),
        result: { version: 1, outcome: "rejected" } as const } : {}),
    }).where(eq(issueThreadInteractions.id, current.card.id));
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it("does not substitute untargeted acceptance for approval of a saved plan", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown",
      body: "This saved plan requires acceptance of its exact revision.", createdByAgentId: f.agentId, createdByRunId: f.runId });
    await accept(f, p);
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it.each(["stale", "foreign-target", "empty-selection"])("does not execute a plan with %s approval", async kind => {
    const f = await fixture();
    const p = await proposal(f, true);
    await accept(f, p);
    if (kind === "stale") {
      await documentService(server.db).unlockIssueDocument(f.issueId, "plan");
      await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown",
        baseRevisionId: p.plan!.latestRevisionId, body: "A revised scope that has not been accepted." });
    } else if (kind === "foreign-target") {
      await server.db.update(issueThreadInteractions).set({ payload: { ...p.card.payload,
        target: { type: "issue_document", key: "plan", issueId: f.blockerId, revisionId: p.plan!.latestRevisionId! } } as never }).where(eq(issueThreadInteractions.id, p.card.id));
    } else {
      await server.db.update(issueThreadInteractions).set({ result: { version: 1, outcome: "accepted", selectedOptionIds: [] } }).where(eq(issueThreadInteractions.id, p.card.id));
    }
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it("keeps ordinary delegation available even when its description invokes the skill", async () => {
    const f = await fixture();
    await server.db.update(issues).set({ originKind: "manual", description: "Please read /first-task, then delegate." }).where(eq(issues.id, f.issueId));
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("preserves native creation replay and dispatch recovery after a newer pending proposal", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await accept(f, p);
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    const input = { tool: "create_task", callId: randomUUID(), arguments: { title: "Approved child", idempotencyKey: "owned", status: "todo" } };
    const first = await authority.execute(input);
    expect(wakes).toHaveLength(1);
    await proposal(f);
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await authority.execute({ ...input, callId: randomUUID() })).toEqual(first);
    // Existing dispatch recovery remains bounded to this already-admitted child.
    expect(wakes).toHaveLength(2);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
    await expect(authority.execute({ ...input, arguments: { ...input.arguments, idempotencyKey: "new" } })).rejects.toThrow(/proposal.*accept/i);
  });


  it("replays an owned generic creation after a newer pending proposal", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const route = `${server.apiUrl}/api/companies/${f.companyId}/issues`;
    const body = { title: "Approved child", parentId: f.issueId, idempotencyKey: "owned-rest", assigneeAgentId: f.agentId, status: "backlog" };
    const post = async (input = body) => {
      const response = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      return { response, data: await response.json() };
    };
    const first = await post();
    expect(first.response.status, JSON.stringify(first.data)).toBe(201);
    await proposal(f);
    const before = await f.snapshot();
    const replay = await post();
    expect(replay.response.status, JSON.stringify(replay.data)).toBe(200);
    expect(replay.data).toMatchObject({ id: first.data.id, deduplicated: true });
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    const fresh = await post({ ...body, idempotencyKey: "new-rest", title: "Another child" });
    expect(fresh.response.status, JSON.stringify(fresh.data)).toBe(403);
  });

});
