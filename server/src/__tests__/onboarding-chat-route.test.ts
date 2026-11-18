import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyOnboardingSeeds, goals, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { onboardingChatRoutes } from "../routes/onboarding-chat.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { documentService } from "../services/documents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ONBOARDING_CHAT_GREETING_REASON } from "../services/onboarding-chat-prompt.js";
import { prepareConversationTurn, settleConversationTurn } from "../services/agent-conversations.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("onboarding chat", () => {
  const ctx = useEmbeddedPostgres("onboarding-chat");
  async function setup() {
    const owner = await seedCompanyWithBoardAccess(ctx.db, "New company");
    await ctx.db.insert(authUsers).values({ id: owner.userId, name: "Owner", email: `${owner.userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await ctx.db.insert(agents).values({ companyId: owner.companyId, name: "Ada", role: "ceo", status: "idle", adapterType: "process" }).returning();
    const wakeup = vi.fn(async (_agentId, options) => {
      await ctx.db.insert(agentWakeupRequests).values({ companyId: owner.companyId, agentId: agent.id,
        source: options.source, reason: options.reason, status: "pending", idempotencyKey: options.idempotencyKey });
      return { id: randomUUID() };
    });
    const app = routeApp(ctx.db, owner.actor, db => onboardingChatRoutes(db, { wakeup } as never));
    const path = `/api/companies/${owner.companyId}/chats/${agent.id}/onboarding`;
    return { ...owner, agent, wakeup, app, path };
  }

  it("keeps chats out of the task sequence, including repeated and concurrent onboarding opens", async () => {
    const { companyId, app, path } = await setup();
    const opened = await Promise.all([request(app).post(path), request(app).post(path)]);
    for (const response of opened) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ identifier: null, issueNumber: null });
    }
    const [colleague] = await ctx.db.insert(agents).values({ companyId, name: "Grace", role: "engineer", status: "idle", adapterType: "process" }).returning();
    const secondChat = await request(app).post(`/api/companies/${companyId}/chats/${colleague.id}/onboarding`);
    expect(secondChat.status).toBe(200);
    expect(secondChat.body).toMatchObject({ identifier: null, issueNumber: null });
    const [company] = await ctx.db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(0);
    const tasks = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      issueService(ctx.db).create(companyId, { title: `Accepted task ${index}`, status: "backlog" }),
    ));
    expect(tasks.map(task => task.issueNumber).sort()).toEqual([1, 2, 3]);
    expect(tasks.map(task => task.identifier).sort()).toEqual([1, 2, 3].map(number => `${company.issuePrefix}-${number}`));
  });

  it("opens one owner-bound chat with signup context, zero execution tasks, zero projects, and no early wake", async () => {
    const { companyId, userId, agent, app, path, wakeup } = await setup();
    await ctx.db.insert(goals).values({ companyId, title: "Launch a robotics newsletter", level: "company", status: "active" });
    await ctx.db.insert(companyOnboardingSeeds).values({ companyId, revision: "one", firstTaskTitle: "Draft an editorial plan", firstTaskDetails: "One page" });
    const [first, retry] = await Promise.all([request(app).post(path), request(app).post(path)]);
    expect(first.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ conversationAgentId: agent.id, conversationUserId: userId,
      originKind: "onboarding_chat", projectId: null, parentId: null });
    expect(JSON.parse(first.body.description)).toMatchObject({ initialIdea: "Draft an editorial plan", initialDetails: "One page",
      goals: [{ title: "Launch a robotics newsletter" }] });
    expect(await issueService(ctx.db).list(companyId)).toEqual([]);
    expect(await ctx.db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    await Promise.all([request(app).post(`${path}/greeting`), request(app).post(`${path}/greeting`)]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agent.id, expect.objectContaining({
      reason: ONBOARDING_CHAT_GREETING_REASON, requestedByActorId: userId, manualUserWake: true,
      contextSnapshot: expect.objectContaining({ issueId: first.body.id }),
    }));
  });

  it("respects company access, keeps another person's chat private, and skips a welcome after a user reply", async () => {
    const { companyId, app, path, wakeup, actor } = await setup();
    const opened = await request(app).post(path);
    const stranger = routeApp(ctx.db, { ...actor, companyIds: [], memberships: [] }, db => onboardingChatRoutes(db, { wakeup } as never));
    expect((await request(stranger).post(path)).status).toBe(403);
    const colleague = routeApp(ctx.db, { ...actor, userId: "another-person" }, db => onboardingChatRoutes(db, { wakeup } as never));
    expect((await request(colleague).post(`${path}/greeting`)).status).toBe(404);
    await issueService(ctx.db).addComment(opened.body.id, "Interview me", { userId: actor.userId });
    expect((await request(app).post(`${path}/greeting`)).body.started).toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });

  it.each(["request", "run"])("retries a timed-out welcome recorded on its %s", async timedOutRecord => {
    const { companyId, agent, app, path, wakeup } = await setup();
    await request(app).post(path);
    await request(app).post(`${path}/greeting`);
    const [receipt] = await ctx.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id));
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "timed_out",
      wakeupRequestId: receipt.id, finishedAt: new Date() }).returning();
    await ctx.db.update(agentWakeupRequests).set(timedOutRecord === "request" ? { status: "timed_out" } : { runId: run.id })
      .where(eq(agentWakeupRequests.id, receipt.id));
    expect((await request(app).post(`${path}/greeting`)).status).toBe(200);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it.each(["message", "new session"])("skips a queued welcome superseded by a %s before dispatch", async superseding => {
    const { companyId, agent, userId, app, path } = await setup();
    const opened = await request(app).post(path);
    const [receipt] = await ctx.db.insert(agentWakeupRequests).values({ companyId, agentId: agent.id,
      source: "on_demand", reason: ONBOARDING_CHAT_GREETING_REASON, status: "pending" }).returning();
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "queued",
      wakeupRequestId: receipt.id, contextSnapshot: { issueId: opened.body.id, wakeReason: ONBOARDING_CHAT_GREETING_REASON } }).returning();
    if (superseding === "message") await issueService(ctx.db).addComment(opened.body.id, "Interview me", { userId });
    else await ctx.db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, opened.body.id));
    const deps = createHeartbeatQueueTestDependencies(ctx.db);
    deps.getAgent.mockResolvedValue(agent);
    const queue = createHeartbeatQueue(ctx.db, deps);
    expect(await queue.claimQueuedRun(run)).toBeNull();
    expect((await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null, errorCode: "onboarding_welcome_superseded" });
    expect(deps.setWakeupStatus).toHaveBeenCalledWith(receipt.id, "skipped", expect.anything());
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }),
      expect.objectContaining({ suppressImmediateRecovery: true }));
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("admits a real greeting run without a synthetic human message", async () => {
    const { agent, actor, app, path, companyId } = await setup();
    const opened = await request(app).post(path);
    const provider = express();
    provider.use(express.json());
    provider.post("/reply", async (req, res) => {
      await issueService(ctx.db).addComment(opened.body.id, "Welcome! What would you like to achieve?", { agentId: agent.id, runId: req.body.runId });
      res.json({ ok: true });
    });
    const listener = provider.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(r=>{if(!r.ok)process.exitCode=1})`;
    await ctx.db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, agent.id));
    const runtimeApp = routeApp(ctx.db, actor, db => onboardingChatRoutes(db, heartbeatService(db)));
    try {
    const response = await request(runtimeApp).post(`${path}/greeting`);
    expect(response.status).toBe(200);
    await vi.waitFor(async () => {
      const [run] = await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
      expect(run?.status).toBe("succeeded");
      expect(run?.contextSnapshot).toMatchObject({ issueId: opened.body.id, conversationMode: true });
      const current = await issueService(ctx.db).getById(opened.body.id);
      expect(current?.conversationState).toBe("waiting");
      expect(current?.executionRunId).toBeNull();
    }, { timeout: 10000 });
    expect(await issueService(ctx.db).list(companyId)).toEqual([]);
    expect(await ctx.db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(0);
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  });

  it.each([false, true])("keeps a reply sent during the welcome actionable (reply=%s)", async hasReply => {
    const { app, path, companyId, agent, userId } = await setup();
    const opened = await request(app).post(path);
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running",
      contextSnapshot: { issueId: opened.body.id, wakeReason: ONBOARDING_CHAT_GREETING_REASON } }).returning();
    const prepared = await prepareConversationTurn(ctx.db, run);
    if (hasReply) await issueService(ctx.db).addComment(opened.body.id, "Interview me", { userId });
    await issueService(ctx.db).addComment(opened.body.id, "Welcome!", { agentId: agent.id, runId: run.id });
    expect(await settleConversationTurn(ctx.db, { ...run, status: "succeeded", contextSnapshot: prepared.context })).toBe(true);
    const current = await issueService(ctx.db).getById(opened.body.id);
    expect(current?.conversationState).toBe(hasReply ? "active" : "waiting");
  });

  it("keeps a suggestion as chat context until acceptance creates its standalone task once", async () => {
    const { app, path, companyId, agent, userId } = await setup();
    const opened = await request(app).post(path);
    const chat = (await issueService(ctx.db).getById(opened.body.id))!;
    const interactions = issueThreadInteractionService(ctx.db);
    const plan = "Goal: launch a newsletter. Done: a one-page editorial plan with three topics and a publishing schedule.";
    const proposal = await interactions.create(chat, { kind: "suggest_tasks", idempotencyKey: "editorial-plan",
      payload: { version: 1, tasks: [{ clientKey: "plan", title: "Draft the editorial plan", description: plan,
        initialPlan: plan, assigneeAgentId: agent.id }] } }, { userId });
    expect(await issueService(ctx.db).list(companyId)).toEqual([]);
    expect(await ctx.db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(0);
    const accepted = await interactions.acceptInteraction(chat, proposal.id, {}, { userId });
    expect(accepted.createdIssues).toHaveLength(1);
    const [task] = await issueService(ctx.db).list(companyId);
    expect(task).toMatchObject({ title: "Draft the editorial plan", parentId: null, assigneeAgentId: agent.id, issueNumber: 1 });
    expect((await documentService(ctx.db).getIssueDocumentByKey(task.id, "plan"))?.body).toBe(plan);
    await expect(interactions.acceptInteraction(chat, proposal.id, {}, { userId })).rejects.toThrow("already been resolved");
    expect(await issueService(ctx.db).list(companyId)).toHaveLength(1);
  });
});
