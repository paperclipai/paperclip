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
  projects,
} from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildNativeSessionHandoff } from "../services/native-runtime/native-session-handoff.js";
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
    await db?.$client.end({ timeout: 5 });
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

  function chiefApp(
    f: Seed,
    overrides?: Partial<{
      agentId: string;
      companyId: string;
      runId: string;
      onBehalfOfUserId: string | null;
      source: "agent_jwt" | "agent_key";
    }>,
  ) {
    const companyId = overrides?.companyId ?? f.company.id;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: overrides?.agentId ?? f.chief.id,
        companyId,
        runId: overrides?.runId ?? f.chiefRun.id,
        onBehalfOfUserId: overrides && "onBehalfOfUserId" in overrides ? overrides.onBehalfOfUserId : f.person,
        onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }],
        source: overrides?.source ?? "agent_jwt",
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
    const [privateProject] = await db.insert(projects).values({
      companyId: f.company.id, name: "Private project", status: "in_progress", visibility: "private", privacyOwnerUserId: f.person,
    }).returning();
    const privateProjectTask = await svc.create(f.company.id, {
      title: "Private project task", projectId: privateProject.id, assigneeAgentId: f.chief.id, status: "in_progress", createdByUserId: f.person,
    });
    const privateAncestorChild = await svc.create(f.company.id, {
      title: "Child under private task", assigneeAgentId: f.chief.id, status: "in_progress", createdByUserId: f.person,
    });
    await db.update(issues).set({
      parentId: privateTask.id, privacyParentIssueId: privateTask.id, privacyRootIssueId: privateTask.id,
    }).where(eq(issues.id, privateAncestorChild.id));
    const [privateRun, privateProjectRun, privateAncestorRun, unscopedRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: { issueId: privateTask.id } },
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: { issueId: privateProjectTask.id } },
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: { issueId: privateAncestorChild.id } },
      { companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person, contextSnapshot: {} },
    ]).returning();
    for (const restrictedRun of [privateRun, privateProjectRun, privateAncestorRun]) {
      await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: restrictedRun.id }))
        .rejects.toThrow(/Restricted task content/);
    }
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: unscopedRun.id }))
      .rejects.toThrow(/task-bound run/);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
  });

  it("keeps the chat agent's session fence and both agents' comment permissions", async () => {
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
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, f.assistant.id));
    await db.update(agents).set({ permissions: { interactions: { canCommentOnOtherTasks: false } } })
      .where(eq(agents.id, f.chief.id));
    await expect(svc.addComment(f.assistantChat.id, message, { agentId: f.chief.id, runId: f.chiefRun.id }))
      .rejects.toThrow(/canCommentOnOtherTasks/);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
  });

  it("enforces company boundaries and credential responsible user through the HTTP route", async () => {
    const f = await seed();
    const foreign = await seed();
    const mismatchRes = await request(chiefApp(f, { onBehalfOfUserId: f.otherPerson, source: "agent_key" }))
      .post(`/api/issues/${f.assistantChat.id}/comments`)
      .send({ body: message });
    expect(mismatchRes.status, JSON.stringify(mismatchRes.body)).toBe(403);
    const crossCompanyRes = await request(chiefApp(foreign))
      .post(`/api/issues/${f.assistantChat.id}/comments`)
      .send({ body: message });
    expect(crossCompanyRes.status, JSON.stringify(crossCompanyRes.body)).toBe(404);
    await expect(issueService(db).addComment(f.assistantChat.id, message, {
      agentId: foreign.chief.id, runId: foreign.chiefRun.id, onBehalfOfUserId: f.person,
    })).rejects.toMatchObject({ status: 404 });
    await expect(issueService(db).addComment(f.assistantChat.id, message, {
      agentId: f.chief.id, runId: foreign.chiefRun.id, onBehalfOfUserId: f.person,
    })).rejects.toThrow(/own running run/);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toEqual([]);
  });

  it("admits a real chat run for the receiving agent when wake-on-demand is enabled", async () => {
    const f = await seed();
    await db.update(agents).set({
      adapterConfig: { command: process.execPath, args: ["-e", ""] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).where(eq(agents.id, f.assistant.id));
    const response = await request(chiefApp(f))
      .post(`/api/issues/${f.assistantChat.id}/comments`)
      .send({ body: message });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const run = await vi.waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.company.id),
        eq(heartbeatRuns.agentId, f.assistant.id),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${response.body.id}`,
      ));
      expect(row).toBeDefined();
      return row!;
    }, { timeout: 10_000, interval: 50 });
    expect(run.contextSnapshot).toMatchObject({
      issueId: f.assistantChat.id,
      wakeCommentId: response.body.id,
      wakeReason: "issue_commented",
    });
    // Wait for the trivial no-op process run and its finalization cleanup to settle.
    await vi.waitFor(async () => {
      const [settled] = await db.select({
        status: heartbeatRuns.status,
        controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      const chat = await issueService(db).getById(f.assistantChat.id);
      expect(["succeeded", "failed", "cancelled"]).toContain(settled?.status);
      expect(settled?.controllerLeaseExpiresAt).toBeNull();
      expect(chat?.executionRunId).toBeNull();
    }, { timeout: 10_000, interval: 50 });
  });

  it("serializes peer source privacy checks with concurrent privacy transitions", async () => {
    const f = await seed();
    const svc = issueService(db);
    const sourceTask = await svc.create(f.company.id, {
      title: "Soon private source", assigneeAgentId: f.chief.id, status: "in_progress", createdByUserId: f.person,
    });
    const [sourceRun] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.chief.id, status: "running", responsibleUserId: f.person,
      contextSnapshot: { issueId: sourceTask.id },
    }).returning();
    let unlock!: () => void;
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => { ready = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gate = db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.company.id}`}, 0))`);
      ready(pid);
      await release;
      await tx.update(issues).set({ visibility: "private" }).where(eq(issues.id, sourceTask.id));
    });
    const pid = await locked;
    let peerPost: Promise<unknown> | undefined;
    try {
      peerPost = svc.addComment(f.assistantChat.id, message, {
        agentId: f.chief.id, runId: sourceRun.id, onBehalfOfUserId: f.person,
      });
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ blocked: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))
        ) as blocked`);
        expect(row.blocked).toBe(true);
      }, { timeout: 5_000, interval: 20 });
      unlock();
      await gate;
      await expect(peerPost).rejects.toThrow(/Restricted task content/);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id))).toEqual([]);
    } finally {
      unlock();
      await gate.catch(() => {});
      await peerPost?.catch(() => {});
    }
  });

  it("acquires the privacy-tree lock before locking the chat row on PATCH comment updates", async () => {
    const f = await seed();
    let unlock!: () => void;
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => { ready = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gate = db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.company.id}`}, 0))`);
      ready(pid);
      await release;
    });
    const pid = await locked;
    const app = chiefApp(f);
    let patchPromise: Promise<request.Response> | undefined;
    try {
      patchPromise = request(app)
        .patch(`/api/issues/${f.assistantChat.id}`)
        .send({ comment: "PATCH peer update" })
        .then((res) => res);
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ blocked: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))
        ) as blocked`);
        expect(row.blocked).toBe(true);
      }, { timeout: 5_000, interval: 20 });
      // While PATCH waits on issue-privacy-tree, it must not yet hold a FOR UPDATE lock on the chat row.
      const lockedCheck = await db.transaction(async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`select id from issues where id = ${f.assistantChat.id} for update nowait`);
        return rows.length;
      });
      expect(lockedCheck).toBe(1);
      unlock();
      await gate;
      const [patchRes, postRes] = await Promise.all([
        patchPromise,
        request(app).post(`/api/issues/${f.assistantChat.id}/comments`).send({ body: message }),
      ]);
      expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
      expect(postRes.status, JSON.stringify(postRes.body)).toBe(201);
      const saved = await db.select().from(issueComments).where(eq(issueComments.issueId, f.assistantChat.id));
      expect(saved.map((c) => c.body)).toEqual(expect.arrayContaining(["PATCH peer update", message]));
    } finally {
      unlock();
      await gate.catch(() => {});
      await patchPromise?.catch(() => {});
    }
  });

  it("labels another agent's chat message as other_agent in fresh-session history", async () => {
    const f = await seed();
    await db.insert(issueComments).values([
      { companyId: f.company.id, issueId: f.assistantChat.id, body: "Plan the launch", authorUserId: f.person, createdAt: new Date(1_000) },
      { companyId: f.company.id, issueId: f.assistantChat.id, body: "PEER NOTE", authorAgentId: f.chief.id, createdAt: new Date(2_000) },
      { companyId: f.company.id, issueId: f.assistantChat.id, body: "OWN REPLY", authorAgentId: f.assistant.id, createdAt: new Date(3_000) },
    ]);
    const history = await buildNativeSessionHandoff({
      db, companyId: f.company.id, issueId: f.assistantChat.id, agentId: f.assistant.id, before: new Date(20_000),
    });
    expect(history).not.toBeNull();
    const packet = JSON.parse(history!.split("\n").at(-1)!);
    expect(packet.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: "Plan the launch", author: "user" }),
      expect.objectContaining({ body: "PEER NOTE", author: "other_agent", authorAgentId: f.chief.id }),
      expect.objectContaining({ body: "OWN REPLY", author: "agent", authorAgentId: f.assistant.id }),
    ]));
  });
});
