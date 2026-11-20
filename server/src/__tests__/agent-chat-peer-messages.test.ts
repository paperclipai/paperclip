import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

(support.supported ? describe : describe.skip)("messages from another agent in a chat", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-agent-chat-peer-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function seed() {
    const prefix = `PC${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Peer chat", issuePrefix: prefix, issueCounter: 0 }).returning();
    const [person, otherPerson] = [randomUUID(), randomUUID()];
    const now = new Date();
    await db.insert(authUsers).values([person, otherPerson].map((id) => ({
      id, name: id === person ? "Leia" : "Other person", email: `${id}@fixture.invalid`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([person, otherPerson].map((principalId) => ({
      companyId: company.id, principalType: "user", principalId, status: "active", membershipRole: "member",
    })));
    const [assistant, chief] = await db.insert(agents).values(["Executive Assistant", "Chief of Staff"].map((name) => ({
      companyId: company.id, name, role: "general", status: "active" as const, adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }))).returning();
    const svc = issueService(db);
    const assistantChat = await svc.create(company.id, {
      title: "Chat with Executive Assistant", assigneeAgentId: assistant.id, conversationAgentId: assistant.id,
      conversationUserId: person, conversationState: "waiting", status: "in_review", createdByUserId: person,
    });
    const chiefChat = await svc.create(company.id, {
      title: "Chat with Chief of Staff", assigneeAgentId: chief.id, conversationAgentId: chief.id,
      conversationUserId: person, conversationState: "waiting", status: "in_review", createdByUserId: person,
    });
    const [chiefRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: chief.id, status: "running", responsibleUserId: person,
      contextSnapshot: { issueId: chiefChat.id, taskKey: chiefChat.id, conversationSessionGeneration: 0 },
    }).returning();
    await db.update(issues).set({ status: "in_progress", conversationState: "active", executionRunId: chiefRun.id })
      .where(eq(issues.id, chiefChat.id));
    return { company, person, otherPerson, assistant, chief, assistantChat, chiefChat, chiefRun };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  function chiefApp(f: Seed) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent", agentId: f.chief.id, companyId: f.company.id, runId: f.chiefRun.id, onBehalfOfUserId: f.person,
        onBehalfOfMemberships: [{ companyId: f.company.id, membershipRole: "member", status: "active" }],
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  const message = "The launch review moved to Thursday. Please update the agenda you are drafting.";

  it("finds the person's chat with another agent through the task search", async () => {
    const f = await seed();
    const response = await request(chiefApp(f))
      .get(`/api/companies/${f.company.id}/issues`).query({ q: "Chat with Executive Assistant" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({
      id: f.assistantChat.id, conversationAgentId: f.assistant.id, conversationUserId: f.person,
    })]));
  });

  it("delivers the message to the chat's agent as the sending agent's message", async () => {
    const f = await seed();
    const response = await request(chiefApp(f))
      .post(`/api/issues/${f.assistantChat.id}/comments`)
      .send({ body: message, resume: true });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      body: message, authorAgentId: f.chief.id, authorUserId: null,
      createdByRunId: f.chiefRun.id, onBehalfOfUserId: f.person,
    });
    expect((await issueService(db).getById(f.assistantChat.id))).toMatchObject({
      status: "in_review", conversationState: "waiting", assigneeAgentId: f.assistant.id,
    });
    const wake = await vi.waitFor(async () => {
      const [row] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.assistant.id),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${response.body.id}`,
      ));
      expect(row).toBeDefined();
      return row!;
    }, { timeout: 10_000, interval: 50 });
    expect(wake).toMatchObject({
      reason: "heartbeat.wakeOnDemand.disabled", requestedByActorType: "agent", requestedByActorId: f.chief.id,
      payload: expect.objectContaining({ issueId: f.assistantChat.id }),
    });
    expect((wake.payload as Record<string, Record<string, unknown>>)._paperclipWakeContext).toMatchObject({
      issueId: f.assistantChat.id, wakeCommentId: response.body.id, wakeReason: "issue_commented",
    });
  });

  it("requires the sending agent's own running run, acting for the chat's person", async () => {
    const f = await seed();
    const svc = issueService(db);
    const post = (actor: { agentId: string; runId?: string }) => svc.addComment(f.assistantChat.id, message, actor);

    await expect(post({ agentId: f.chief.id })).rejects.toMatchObject({ status: 403 });
    const [otherPersonRun] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.otherPerson,
      contextSnapshot: { issueId: f.chiefChat.id },
    }).returning();
    await expect(post({ agentId: f.chief.id, runId: otherPersonRun.id }))
      .rejects.toThrow(/person who owns that chat/);
    const [assistantRun] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.assistant.id, status: "running", responsibleUserId: f.person,
      contextSnapshot: { issueId: f.chiefChat.id },
    }).returning();
    await expect(post({ agentId: f.chief.id, runId: assistantRun.id })).rejects.toThrow(/own running run/);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, otherPersonRun.id));
    await db.update(heartbeatRuns).set({ responsibleUserId: f.person }).where(eq(heartbeatRuns.id, otherPersonRun.id));
    await expect(post({ agentId: f.chief.id, runId: otherPersonRun.id })).rejects.toThrow(/own running run/);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, otherPersonRun.id));
    await expect(post({ agentId: f.chief.id, runId: otherPersonRun.id })).rejects.toThrow(/cancelled/);
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: f.chiefRun.id }, {
      proactiveChatMessage: { sourceTaskId: f.chiefChat.id, userId: f.person },
    })).rejects.toMatchObject({ status: 403 });
    for (const onBehalfOfUserId of [f.otherPerson, null]) {
      await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: f.chiefRun.id, onBehalfOfUserId }))
        .rejects.toThrow(/person who owns that chat/);
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);

    const saved = await post({ agentId: f.chief.id, runId: f.chiefRun.id });
    expect(saved).toMatchObject({ authorAgentId: f.chief.id, createdByRunId: f.chiefRun.id, onBehalfOfUserId: f.person });
  });

  it("refuses content from a restricted or missing source task", async () => {
    const f = await seed();
    const svc = issueService(db);
    const privateTask = await svc.create(f.company.id, {
      title: "Private source", assigneeAgentId: f.chief.id, status: "in_progress", createdByUserId: f.person,
    });
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, privateTask.id));
    const [privateRun, unscopedRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: { issueId: privateTask.id } },
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: {} },
    ]).returning();
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: privateRun.id }))
      .rejects.toThrow(/Restricted task content/);
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: unscopedRun.id }))
      .rejects.toThrow(/task-bound run/);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
  });

  it("keeps the chat agent's session fence and the receiving agent's comment setting", async () => {
    const f = await seed();
    const svc = issueService(db);
    const [staleRun] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.assistant.id, status: "running", responsibleUserId: f.person,
      contextSnapshot: { issueId: f.assistantChat.id, conversationSessionGeneration: 0 },
    }).returning();
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.assistantChat.id));
    await expect(svc.addComment(f.assistantChat.id, "Stale reply", { agentId: f.assistant.id, runId: staleRun.id }))
      .rejects.toThrow(/earlier session/);
    await db.update(agents).set({ permissions: { interactions: { canReceiveCommentsFromAgents: false } } })
      .where(eq(agents.id, f.assistant.id));
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: f.chiefRun.id }))
      .rejects.toThrow(/canReceiveCommentsFromAgents/);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
  });
});
