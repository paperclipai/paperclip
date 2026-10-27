import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, authUsers, chatConversations, chatEndpoints, chatMessageLinks, issueComments, issueReadStates, issues, issueThreadInteractions, toolApplications, toolConnections } from "@paperclipai/db";
import { isAgentCreatedIssue } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue creation visibility", () => {
  const ctx = useEmbeddedPostgres("paperclip-creation-visibility-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(chatMessageLinks);
      await db.delete(chatConversations);
      await db.delete(chatEndpoints);
      await db.delete(toolConnections);
      await db.delete(toolApplications);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
      await db.delete(authUsers);
    },
  });

  it("filters ordinary and compact searches before pagination without changing API defaults", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Creation visibility");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other company");
    const rows = [
      { id: randomUUID(), companyId, title: "Visibility human", createdByUserId: userId, originKind: "manual" },
      { id: randomUUID(), companyId, title: "Visibility second human", createdByUserId: userId, originKind: "manual" },
      { id: randomUUID(), companyId, title: "Visibility channel", createdByUserId: userId, originKind: "chat_channel" },
      { id: randomUUID(), companyId, title: "Visibility onboarding", createdByUserId: userId, originKind: "onboarding_first_task" },
      { id: randomUUID(), companyId, title: "Visibility inbound email", originKind: "chat_channel", originId: "email:endpoint:thread" },
      { id: randomUUID(), companyId, title: "Visibility outbound email", originKind: "chat_channel", originId: "email-send:tool-call" },
      ...["routine_execution", "task_watchdog", "stranded_issue_recovery", "plugin:workflow:task", "harness_liveness_escalation", "manual"].map((originKind) => ({ id: randomUUID(), companyId, title: `Visibility ${originKind}`, originKind, responsibleUserId: userId })),
      { id: randomUUID(), companyId, title: "Visibility manually run routine", createdByUserId: userId, originKind: "routine_execution" },
    ];
    await ctx.db.insert(issues).values([
      ...rows.map((row, index) => ({ ...row, status: "todo", updatedAt: new Date(2026, 9, 13, 0, index) })),
      { companyId: other.companyId, title: "Visibility other company", createdByUserId: other.userId },
      { companyId, title: "Visibility private task", createdByUserId: other.userId, visibility: "private" },
    ]);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const defaults = await request(app).get(`${path}?includeRoutineExecutions=true`).expect(200);
    expect(defaults.body).toHaveLength(rows.length);
    for (const view of ["", "&view=compact"]) {
      const first = await request(app).get(`${path}?includeAgentCreatedTasks=false&q=Visibility&sortField=updated&limit=2${view}`).expect(200);
      const second = await request(app).get(`${path}?includeAgentCreatedTasks=false&q=Visibility&sortField=updated&limit=2&offset=2${view}`).expect(200);
      expect(first.body).toHaveLength(2);
      expect(second.body).toHaveLength(1);
      expect([...first.body, ...second.body].every((issue: Parameters<typeof isAgentCreatedIssue>[0]) => !isAgentCreatedIssue(issue))).toBe(true);
    }
    await request(app).get(`${path}?includeAgentCreatedTasks=invalid`).expect(400);
    await request(app).get(`${path}?includeParticipatedTasks=invalid`).expect(400);
    await request(app).get(`/api/companies/${other.companyId}/issues?includeAgentCreatedTasks=false`).expect(403);
  });

  it("preserves participation but excludes routine ownership and read-only activity", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Inbox participation");
    const ids = Object.fromEntries(["scheduled", "commented", "assigned", "manual", "read", "touched", "channelScheduled", "channelCommented", "channelManual"].map((name) => [name, randomUUID()]));
    await ctx.db.insert(issues).values(Object.entries(ids).map(([name, id]) => ({
      id, companyId, title: `Participation ${name}`, status: "todo", originKind: name.startsWith("channel") ? "chat_channel" : "routine_execution",
      responsibleUserId: userId,
      assigneeUserId: name === "assigned" ? userId : null,
      createdByUserId: name === "manual" || name === "channelManual" ? userId : null,
    })));
    await ctx.db.insert(issueComments).values([ids.commented!, ids.channelCommented!].map((issueId) => ({ companyId, issueId, authorUserId: userId, body: "I joined this task" })));
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: ids.read!, userId, lastReadAt: new Date() });
    await ctx.db.insert(activityLog).values([
      { companyId, entityType: "issue", entityId: ids.read!, actorType: "user", actorId: userId, action: "issue.read_marked" },
      { companyId, entityType: "issue", entityId: ids.touched!, actorType: "user", actorId: userId, action: "issue.inbox_touched" },
    ]);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const mine = await request(app).get(`${path}?touchedByUserId=me&inboxArchivedByUserId=me&includeRoutineExecutions=true`).expect(200);
    const expected = [ids.commented, ids.assigned, ids.touched, ids.channelCommented].sort();
    expect(mine.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
    const discovery = await request(app).get(`${path}?q=Participation&includeAgentCreatedTasks=false&includeParticipatedTasks=true`).expect(200);
    expect(discovery.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
    const strict = await issueService(ctx.db).list(companyId, { includeAgentCreatedTasks: false });
    expect(strict).toEqual([]);
  });

  it("uses source evidence for existing imports and keeps direct board/API participation", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Personal inbox sources");
    const svc = issueService(ctx.db);
    const names = ["github", "slack", "legacySender", "legacyLink", "direct", "outbound", "manualRun", "human", "agent", "private"];
    const ids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-02T00:00:00Z");
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    await ctx.db.insert(issues).values(names.map((name) => ({
      id: ids[name]!, companyId, title: `Source ${name}`, status: "todo",
      originKind: name === "human" || name === "agent" ? "manual" : name === "manualRun" ? "routine_execution" : "chat_channel",
      createdByUserId: name === "private" ? "other-user" : userId, createdByAgentId: name === "agent" ? agent!.id : null,
      responsibleUserId: name === "private" ? "other-user" : userId, visibility: name === "private" ? "private" : "open",
      createdAt: old, updatedAt: old,
    })));
    const comments = await ctx.db.insert(issueComments).values(
      ["github", "slack", "legacySender", "legacyLink", "direct", "outbound", "private"].map((name) => ({
        companyId, issueId: ids[name]!, authorUserId: userId, authorType: "user" as const,
        body: "User identity is attribution", createdAt: old,
        metadata: name === "github" || name === "slack"
          ? { version: 1 as const, sourceChannel: name as "github" | "slack", sections: [] }
          : name === "legacySender" ? { version: 1 as const, sections: [{ title: "GitHub sender", rows: [{ type: "key_value" as const, label: "Provider ID", value: "external-user" }] }] } : null,
      })),
    ).returning();
    const [appRow] = await ctx.db.insert(toolApplications).values({ companyId, name: "Chat", type: "mcp" }).returning();
    const [connection] = await ctx.db.insert(toolConnections).values({ companyId, applicationId: appRow!.id, name: "GitHub", uid: randomUUID(), transport: "mcp_remote", authKind: "api_key" }).returning();
    const [endpoint] = await ctx.db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, assignedAgentId: agent!.id, provider: "github", publicId: randomUUID(), sponsorUserId: userId }).returning();
    const conversations = await ctx.db.insert(chatConversations).values(["legacyLink", "outbound"].map((name) => ({
      companyId, endpointId: endpoint!.id, issueId: ids[name]!, externalConversationId: name, externalLabel: "Review",
    }))).returning();
    await ctx.db.insert(chatMessageLinks).values(["legacyLink", "outbound"].map((name) => ({
      companyId, endpointId: endpoint!.id, conversationId: conversations.find((conversation) => conversation.issueId === ids[name])!.id,
      commentId: comments.find((comment) => comment.issueId === ids[name])!.id,
      providerMessageId: name, direction: name === "legacyLink" ? "inbound" : "outbound",
    })));
    await ctx.db.insert(activityLog).values({ companyId, entityType: "issue", entityId: ids.manualRun!, actorType: "user", actorId: userId, action: "issue.inbox_touched", details: { source: "manual_routine_run" } });
    await ctx.db.insert(issueComments).values(names.map((name) => ({ companyId, issueId: ids[name]!, body: "New agent result", createdAt: newer })));
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const expected = [ids.direct, ids.outbound, ids.human].sort();
    for (const view of ["", "&view=compact"]) {
      const mine = await request(app).get(`${path}?touchedByUserId=me&includeRoutineExecutions=true${view}`).expect(200);
      expect(mine.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
      const unread = await request(app).get(`${path}?unreadForUserId=me&includeRoutineExecutions=true${view}`).expect(200);
      expect(unread.body.map((issue: { id: string }) => issue.id).sort()).toEqual(expected);
    }
    await ctx.db.delete(issues).where(eq(issues.id, ids.private!));
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(3);
    await ctx.db.insert(issueComments).values({ companyId, issueId: ids.github!, authorUserId: userId, body: "Direct API reply" });
    const beforeReply = await request(app).get(`${path}?includeRoutineExecutions=true&inboxArchivedByUserId=me`).expect(200);
    const imported = beforeReply.body.find((issue: { id: string }) => issue.id === ids.slack);
    expect(imported.myLastTouchAt).toBeNull();
    expect(imported.isUnreadForMe).toBe(false);
    const joined = await request(app).get(`${path}?touchedByUserId=me`).expect(200);
    expect(joined.body.map((issue: { id: string }) => issue.id)).toContain(ids.github);
  });

  it("admits open addressed requests and removes that reason when they resolve", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Human requests");
    const ids = Object.fromEntries(["question", "confirmation", "otherUser", "creatorExcluded", "private"].map((name) => [name, randomUUID()]));
    await ctx.db.insert(issues).values(Object.entries(ids).map(([name, id]) => ({ id, companyId, title: name, status: "todo", originKind: "chat_channel", visibility: name === "private" ? "private" : "open", createdAt: new Date("2026-01-01") })));
    const requests = await ctx.db.insert(issueThreadInteractions).values(Object.entries(ids).map(([name, issueId]) => ({
      companyId, issueId, kind: name === "confirmation" ? "request_confirmation" : "ask_user_questions",
      addresseeUserId: name === "otherUser" ? "someone-else" : userId,
      createdByUserId: name === "creatorExcluded" ? userId : null,
      effectiveResolverPolicy: name === "creatorExcluded" ? "not_creator" as const : "human_only" as const,
      payload: name === "confirmation" ? { version: 1 as const, prompt: "Accept this result?" } : { version: 1 as const, questions: [{ id: "answer", prompt: "Choose a result.", selectionMode: "single" as const, options: [{ id: "yes", label: "Accept" }, { id: "no", label: "Reject" }] }] },
    }))).returning();
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    for (const filter of ["touchedByUserId=me", "unreadForUserId=me", "includeAgentCreatedTasks=false&includeParticipatedTasks=true"]) {
      const result = await request(app).get(`${path}?${filter}`).expect(200);
      expect(result.body.map((issue: { id: string }) => issue.id).sort()).toEqual([ids.question, ids.confirmation].sort());
      if (!filter.includes("includeParticipatedTasks")) {
        expect(result.body.every((issue: { isUnreadForMe: boolean }) => issue.isUnreadForMe)).toBe(true);
      }
    }
    const svc = issueService(ctx.db);
    await svc.markRead(companyId, ids.question!, userId);
    const unread = await request(app).get(`${path}?unreadForUserId=me`).expect(200);
    expect(unread.body.map((issue: { id: string }) => issue.id)).toEqual([ids.confirmation]);
    for (const interaction of requests) await ctx.db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, interaction.id));
    const resolved = await request(app).get(`${path}?touchedByUserId=me`).expect(200);
    expect(resolved.body).toEqual([]);
  });

  it("keeps a service-created request unread for the human assignee until they read it", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Assigned request");
    await ctx.db.insert(authUsers).values({ id: userId, name: "Recipient", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Requester", role: "engineer", adapterType: "process" }).returning();
    const [issue] = await ctx.db.insert(issues).values({
      companyId, title: "Assigned channel task", originKind: "chat_channel", status: "todo", assigneeUserId: userId,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    }).returning();
    const svc = issueService(ctx.db);
    await svc.markRead(companyId, issue!.id, userId, new Date("2026-01-02"));
    const interaction = await issueThreadInteractionService(ctx.db).create(issue!, {
      kind: "ask_user_questions", addresseeUserId: userId, resolverPolicy: "human_only",
      payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "answer", prompt: "What result do you need?", answerMode: "text", required: true }] } },
    }, { agentId: agent!.id });
    const [updated] = await ctx.db.select().from(issues).where(eq(issues.id, issue!.id));
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(new Date(interaction.createdAt).getTime());
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    for (const view of ["", "&view=compact"]) {
      const unread = await request(app).get(`${path}?unreadForUserId=me${view}`).expect(200);
      expect(unread.body.map((row: { id: string }) => row.id)).toEqual([issue!.id]);
      expect(unread.body[0].isUnreadForMe).toBe(true);
    }
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(1);
    await svc.markRead(companyId, issue!.id, userId);
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(0);
    const read = await request(app).get(`${path}?touchedByUserId=me`).expect(200);
    expect(read.body[0].isUnreadForMe).toBe(false);
  });

  it.each(["request_checkbox_confirmation", "request_item_verdicts"] as const)("resurfaces archived automatic work for an addressed %s", async (kind) => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Archived requests");
    await ctx.db.insert(authUsers).values({ id: userId, name: "Recipient", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Requester", role: "engineer", adapterType: "process" }).returning();
    const tasks = await ctx.db.insert(issues).values(["addressed", "otherRecipient"].map((title) => ({
      companyId, title, originKind: "chat_channel", status: "todo",
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    }))).returning();
    const svc = issueService(ctx.db);
    for (const task of tasks) {
      await svc.archiveInbox(companyId, task.id, userId, new Date("2026-01-02"));
      await svc.markRead(companyId, task.id, userId, new Date("2026-01-02"));
    }
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    const mineQuery = "touchedByUserId=me&inboxArchivedByUserId=me";
    const unreadQuery = "unreadForUserId=me&inboxArchivedByUserId=me";
    await request(app).get(`${path}?${mineQuery}`).expect(200).expect([]);
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(0);
    const input = kind === "request_checkbox_confirmation"
      ? { kind, payload: { version: 1 as const, prompt: "Select the result.", options: [{ id: "result", label: "Result" }] } }
      : { kind, payload: { version: 1 as const, prompt: "Review the result.", items: [{ id: "result", label: "Result" }] } };
    await issueThreadInteractionService(ctx.db).create(tasks[0]!, {
      ...input, addresseeUserId: userId, resolverPolicy: "human_only",
    }, { agentId: agent!.id });
    await ctx.db.insert(issueThreadInteractions).values({
      companyId, issueId: tasks[1]!.id, kind, addresseeUserId: "someone-else",
      effectiveResolverPolicy: "human_only", payload: input.payload,
    });
    for (const view of ["", "&view=compact"]) {
      for (const query of [mineQuery, unreadQuery]) {
        const result = await request(app).get(`${path}?${query}${view}`).expect(200);
        expect(result.body.map((row: { id: string }) => row.id)).toEqual([tasks[0]!.id]);
        expect(result.body[0].isUnreadForMe).toBe(true);
      }
    }
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(1);
    await svc.markRead(companyId, tasks[0]!.id, userId);
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(0);
    const read = await request(app).get(`${path}?${mineQuery}`).expect(200);
    expect(read.body.map((row: { id: string }) => row.id)).toEqual([tasks[0]!.id]);
    expect(read.body[0].isUnreadForMe).toBe(false);
    await svc.archiveInbox(companyId, tasks[0]!.id, userId);
    await request(app).get(`${path}?${mineQuery}`).expect(200).expect([]);
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(0);
  });

  it("excludes historical and closed requests while preserving current questions and authorization requests", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Current requests");
    const names = ["historical", "done", "cancelled", "current", "authorization"];
    const ids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
    await ctx.db.insert(issues).values(names.map((name) => ({
      id: ids[name]!, companyId, title: name, originKind: "chat_channel",
      status: name === "done" || name === "cancelled" ? name : "todo",
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    })));
    await ctx.db.insert(issueThreadInteractions).values(names.map((name) => ({
      companyId, issueId: ids[name]!, kind: "ask_user_questions", addresseeUserId: userId,
      effectiveResolverPolicy: "human_only" as const, createdAt: new Date("2026-01-02"),
      payload: { version: 1 as const, ...(name === "authorization" ? { connectionAuthorization: {} } : {}),
        questionSet: { schema: "paperclip.question_set.v1" as const, questions: [{ id: "answer", prompt: "What result do you need?", answerMode: "text" as const, required: true }] } },
    })));
    await ctx.db.insert(issueComments).values(["historical", "authorization"].map((name) => ({
      companyId, issueId: ids[name]!, authorUserId: "another-human", body: "The request has changed.", createdAt: new Date("2026-01-03"),
    })));
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    for (const filter of ["touchedByUserId=me", "unreadForUserId=me", "includeAgentCreatedTasks=false&includeParticipatedTasks=true"]) {
      const result = await request(app).get(`${path}?${filter}`).expect(200);
      expect(result.body.map((row: { id: string }) => row.id).sort()).toEqual([ids.current, ids.authorization].sort());
    }
    expect(await issueService(ctx.db).countUnreadTouchedByUser(companyId, userId)).toBe(2);
  });

});
