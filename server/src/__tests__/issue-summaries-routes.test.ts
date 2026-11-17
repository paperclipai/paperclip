import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@paperclipai/db/schema/index";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  activityLog, agents, chatConversations, chatEndpoints, companyMemberships, heartbeatRuns, issueComments, issueReadStates, issueRelations, issues, issueThreadInteractions, toolApplications, toolConnections,
} from "@paperclipai/db";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import * as issueServices from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { recentSubtaskParents } from "../realtime/recent-subtask-parents.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres, type BoardActor } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("bounded issue summaries", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-summaries-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Summaries");
    const rows = await ctx.db.insert(issues).values([
      { companyId: company.companyId, title: "First", description: "Do not serialize this".repeat(100), status: "todo" },
      { companyId: company.companyId, title: "Second", status: "done" },
    ]).returning();
    return { ...company, actor: { ...company.actor, source: "session" as const }, rows };
  }
  function app(actor: BoardActor | Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use(errorHandler);
    return result;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/issues/summaries`;

  it("matches the inbox unread predicate across participation, request, withdrawal and read histories", async () => {
    const f = await fixture();
    const user = f.actor.userId!;
    const names = ["created", "read", "untouched", "assigned", "human-comment", "derived-comment", "activity",
      "read-only-activity", "pending", "not-creator", "withdrawn", "withdrawn-read", "deleted-comment", "self-after-external"];
    const day = (n: number) => new Date(`2026-01-0${n}`);
    const rows = await ctx.db.insert(issues).values(names.map(title => ({
      companyId: f.companyId, parentId: f.rows[0]!.id, title, createdAt: day(1), updatedAt: day(1),
      createdByUserId: ["created", "read", "withdrawn", "withdrawn-read", "deleted-comment", "self-after-external"].includes(title) ? user : "other",
      assigneeUserId: title === "assigned" ? user : null,
    }))).returning();
    const byName = new Map(rows.map(row => [row.title, row]));
    const id = (name: string) => byName.get(name)!.id;
    const noExternal = new Set(["pending", "not-creator", "withdrawn", "withdrawn-read"]);
    await ctx.db.insert(issueComments).values(rows.filter(row => !noExternal.has(row.title)).map(row => ({
      companyId: f.companyId, issueId: row.id, authorUserId: "other", body: "External", createdAt: day(3),
      deletedAt: row.title === "deleted-comment" ? day(4) : null,
    })));
    await ctx.db.insert(issueComments).values(["human-comment", "derived-comment", "self-after-external"].map<typeof issueComments.$inferInsert>(name => ({
      companyId: f.companyId, issueId: id(name), authorUserId: user, body: "Mine",
      createdAt: day(name === "self-after-external" ? 4 : 2),
      metadata: name === "derived-comment" ? { version: 1, sections: [], sourceChannel: "slack" } : null,
    })));
    await ctx.db.insert(issueReadStates).values(["read", "withdrawn-read"].map(name => ({
      companyId: f.companyId, issueId: id(name), userId: user, lastReadAt: day(4),
    })));
    await ctx.db.insert(activityLog).values(["activity", "read-only-activity", "withdrawn", "withdrawn-read"].map(name => ({
      companyId: f.companyId, entityType: "issue", entityId: id(name), actorType: "user",
      actorId: name.startsWith("withdrawn") ? "other" : user,
      action: name.startsWith("withdrawn") ? "issue.thread_interaction_withdrawn" : name === "activity" ? "issue.updated" : "issue.read_marked",
      createdAt: day(3), details: name.startsWith("withdrawn") ? { handledForUserId: user, receipt: { outcome: "withdrawn", issueId: id(name) } } : null,
    })));
    await ctx.db.insert(issueThreadInteractions).values(["pending", "not-creator"].map<typeof issueThreadInteractions.$inferInsert>(name => ({
      companyId: f.companyId, issueId: id(name), kind: "request_confirmation", payload: { version: 1, prompt: "Confirm this task." },
      addresseeUserId: user, createdByUserId: user, createdAt: day(3),
      effectiveResolverPolicy: name === "not-creator" ? "not_creator" as const : "anyone" as const,
    })));
    const oracle = await ctx.db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, f.companyId), inArray(issues.id, rows.map(row => row.id)),
      issueServices.unreadForUserCondition(f.companyId, user),
    ));
    const expected = new Set(oracle.map(row => row.id));
    expect(rows.filter(row => expected.has(row.id)).map(row => row.title).sort()).toEqual([
      "activity", "assigned", "created", "human-comment", "pending", "withdrawn",
    ]);
    const res = await request(app(f.actor)).get(url(f.companyId)).query({
      ids: [f.rows[0]!.id, ...rows.map(row => row.id)].join(","), navigation: "true",
    }).expect(200);
    expect(res.body[0]).toMatchObject({ subtaskCount: rows.length, unreadSubtaskCount: expected.size });
    for (const row of res.body.slice(1)) expect(row.isUnreadForMe, byName.get(row.title)?.title).toBe(expected.has(row.id));
  });

  it("authorizes both reparenting hints and excludes hidden, private and foreign parents", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({ id: privateId, companyId: f.companyId, title: "Secret", visibility: "private", createdByUserId: "other" });
    const [child] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Child", parentId: privateId }).returning();
    const payload = { entityType: "issue", entityId: child!.id, details: { _previous: { parentId: f.rows[0]!.id } } };
    const queries: string[] = [];
    const observedDb = drizzle(ctx.db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as typeof ctx.db;
    const reads = new Map<string, Promise<unknown>>();
    for (let delivery = 0; delivery < 2; delivery++) {
      expect(await recentSubtaskParents(observedDb, f.actor, f.companyId, payload, reads)).toEqual({ recentSubtaskParentIds: [f.rows[0]!.id] });
    }
    expect(queries.filter(query => query.startsWith('select "parent_id" from "issues"'))).toHaveLength(1);
    await ctx.db.update(issues).set({ parentId: f.rows[1]!.id }).where(eq(issues.id, child!.id));
    expect(new Set((await recentSubtaskParents(ctx.db, f.actor, f.companyId, payload)).recentSubtaskParentIds)).toEqual(new Set(f.rows.map(row => row.id)));
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.rows[0]!.id));
    expect(await recentSubtaskParents(ctx.db, f.actor, f.companyId, {
      ...payload, details: { parentId: foreign.rows[0]!.id, _previous: { parentId: f.rows[0]!.id } },
    })).toEqual({ recentSubtaskParentIds: [f.rows[1]!.id] });
  });

  it("publishes a parent event when an uncached child is deleted", async () => {
    const f = await fixture();
    const parentId = f.rows[0]!.id;
    const [child] = await ctx.db.insert(issues).values({ companyId: f.companyId, parentId, title: "Uncached child" }).returning();
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => { if (event.type === "activity.logged") events.push(event.payload); });
    try {
      await request(app(f.actor)).delete(`/api/issues/${child!.id}`).expect(200);
      const deleted = events.find(event => event.action === "issue.deleted")!;
      expect(deleted.details).toMatchObject({ parentId });
      expect(await recentSubtaskParents(ctx.db, f.actor, f.companyId, deleted)).toEqual({ recentSubtaskParentIds: [parentId] });
      // The deleted task no longer passes live read authorization. Its
      // independently authorized parent still receives a content-free update.
      expect(events).toContainEqual(expect.objectContaining({ action: "issue.child_deleted", entityType: "issue", entityId: parentId }));
      const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: parentId, navigation: "true" }).expect(200);
      expect(res.body[0]).toMatchObject({ subtaskCount: 0, unreadSubtaskCount: 0 });
    } finally { unsubscribe(); }
  });

  it("counts only readable subtasks and preserves each person's unread state beyond ten children", async () => {
    const f = await fixture();
    const parent = f.rows[0]!;
    const children = await ctx.db.insert(issues).values(Array.from({ length: 14 }, (_, index) => ({
      companyId: f.companyId, parentId: parent.id, title: `Child ${index}`, createdByUserId: f.actor.userId,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    }))).returning();
    await ctx.db.insert(issueComments).values(children.map(child => ({
      companyId: f.companyId, issueId: child.id, authorUserId: "another-user", body: "New message", createdAt: new Date("2026-01-02"),
    })));
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, children[0]!.id));
    await ctx.db.update(issues).set({ visibility: "private", privacyRootIssueId: children[1]!.id, responsibleUserId: "another-user", createdByUserId: "another-user" }).where(eq(issues.id, children[1]!.id));
    const read = () => request(app(f.actor)).get(url(f.companyId)).query({ ids: `${parent.id},${children[13]!.id}`, navigation: "true" }).expect(200);
    const first = (await read()).body;
    expect(first[0]).toMatchObject({ parentId: null, isUnreadForMe: false, subtaskCount: 12, unreadSubtaskCount: 12 });
    expect(first[1]).toMatchObject({ parentId: parent.id, isUnreadForMe: true, subtaskCount: 0 });
    // Opening a parent records only its own read receipt.
    await ctx.db.insert(issueReadStates).values({ companyId: f.companyId, issueId: parent.id, userId: f.actor.userId!, lastReadAt: new Date("2026-01-03") });
    expect((await read()).body[0].unreadSubtaskCount).toBe(12);
    await ctx.db.insert(issueReadStates).values({ companyId: f.companyId, issueId: children[13]!.id, userId: f.actor.userId!, lastReadAt: new Date("2026-01-03") });
    const last = (await read()).body;
    expect(last[0].unreadSubtaskCount).toBe(11);
    expect(last[1].isUnreadForMe).toBe(false);
    const [untouched] = await ctx.db.insert(issues).values({ companyId: f.companyId, parentId: parent.id, title: "Untouched child" }).returning();
    const childrenRead = await request(app(f.actor)).get(`/api/companies/${f.companyId}/issues`).query({
      parentId: parent.id, view: "rows", limit: 100, includeReadState: "true",
    }).expect(200);
    expect(childrenRead.body).toHaveLength(13);
    expect(childrenRead.body.find((row: { id: string }) => row.id === children[13]!.id)?.isUnreadForMe).toBe(false);
    expect(childrenRead.body.find((row: { id: string }) => row.id === children[12]!.id)?.isUnreadForMe).toBe(true);
    expect(childrenRead.body.find((row: { id: string }) => row.id === untouched!.id)?.isUnreadForMe).toBe(false);
    const otherViewer = { ...f.actor, userId: "untouched-viewer" };
    await ctx.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: otherViewer.userId, status: "active", membershipRole: "owner" });
    await ensureHumanRoleDefaultGrants(ctx.db, { companyId: f.companyId, principalId: otherViewer.userId, membershipRole: "owner", grantedByUserId: null });
    expect((await request(app(otherViewer)).get(url(f.companyId)).query({ ids: parent.id, navigation: "true" }).expect(200)).body[0].unreadSubtaskCount).toBe(0);
  });

  it("returns only summaries in requested order without full-detail reads", async () => {
    const f = await fixture();
    const original = issueServices.issueService;
    const forbiddenRead = vi.fn(() => { throw new Error("Full detail read invoked"); });
    const spy = vi.spyOn(issueServices, "issueService").mockImplementation((...args) => ({
      ...original(...args), getById: forbiddenRead, list: forbiddenRead,
    }));
    try {
      const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ` ${f.rows[1]!.id.toUpperCase()},${f.rows[0]!.id},${f.rows[1]!.id} ` }).expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.map((row: { id: string }) => row.id)).toEqual([f.rows[1]!.id, f.rows[0]!.id]);
      expect(Object.keys(res.body[0]).sort()).toEqual([
        "companyId", "displayStatus", "externalConversationState", "id", "identifier", "status", "title", "updatedAt",
      ]);
      expect(res.body[0].externalConversationState).toBeNull();
      expect(forbiddenRead).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it.each(["", "?ids=", "?ids=nope", "?ids=,", "?ids[]=nope", "?ids[x]=nope",
    `?ids=${randomUUID()}&ids[]=nope`, `?ids=${randomUUID()}&ids[x]=nope`,
    `?ids=${randomUUID()}&ids=${randomUUID()}`, `?ids=${Array.from({ length: ISSUE_SUMMARIES_MAX_IDS + 1 }, () => randomUUID()).join(",")}`,
  ])("rejects invalid query %s", async (query) => {
    const f = await fixture();
    await request(app(f.actor)).get(url(f.companyId) + query).expect(400);
  });

  it("accepts exactly the maximum number of IDs", async () => {
    const f = await fixture();
    const ids = [f.rows[0]!.id, f.rows[1]!.id,
      ...Array.from({ length: ISSUE_SUMMARIES_MAX_IDS - 2 }, () => randomUUID())];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([f.rows[0]!.id, f.rows[1]!.id]);
  });

  it("omits hidden, private, foreign and missing IDs without revealing them", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const hidden = f.rows[1]!;
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.id));
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({ id: privateId, companyId: f.companyId, title: "Private", visibility: "private", privacyRootIssueId: privateId, responsibleUserId: "someone-else", createdByUserId: "someone-else" });
    const ids = [f.rows[0]!.id, hidden.id, privateId, foreign.rows[0]!.id, randomUUID()];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([f.rows[0]!.id]);
    const empty = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.slice(1).join(",") }).expect(200);
    expect(empty.body).toEqual([]);
    await request(app(f.actor)).get(url(foreign.companyId)).query({ ids: foreign.rows[0]!.id }).expect(403);
  });

  it("permits ordinary same-company agents and rejects task-bridge keys", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Reader", role: "engineer", adapterType: "process" }).returning();
    const actor: Express.Request["actor"] = { type: "agent", agentId: agent!.id, companyId: f.companyId, source: "agent_key" };
    const res = await request(app(actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(200);
    expect(res.body).toHaveLength(1);
    await request(app(actor)).get(`/api/companies/${f.companyId}/issues`).query({ view: "rows", includeReadState: "true" }).expect(403);
    await request(app({ ...actor, keyScope: { kind: "task_bridge", issueId: f.rows[0]!.id } } as Express.Request["actor"]))
      .get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(403);
  });

  it("projects conversation readiness changes without advancing the task version", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Chat", role: "general", adapterType: "process" }).returning();
    const issue = f.rows[0]!;
    await ctx.db.update(issues).set({ status: "in_review", assigneeAgentId: agent!.id, parentId: f.rows[1]!.id }).where(eq(issues.id, issue.id));
    const [application] = await ctx.db.insert(toolApplications).values({ companyId: f.companyId, name: "Slack", type: "chat" }).returning();
    const connectionId = randomUUID();
    await ctx.db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId: application!.id, uid: connectionId, name: "Slack", transport: "chat_sdk", connectionPurpose: "channel" });
    const endpointId = randomUUID();
    await ctx.db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agent!.id, status: "active" });
    const [conversation] = await ctx.db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: issue.id, externalConversationId: "channel", externalThreadId: issue.id, externalLabel: "#summary-test", state: "waiting" }).returning();
    const read = () => request(app(f.actor)).get(url(f.companyId)).query({ ids: issue.id }).expect(200);
    const waiting = (await read()).body[0];
    expect(waiting.externalConversationState).toBe("waiting");
    const children = await request(app(f.actor)).get(`/api/companies/${f.companyId}/issues`).query({
      parentId: f.rows[1]!.id, view: "rows", includeRoutineExecutions: "true", includeReadState: "true",
    }).expect(200);
    expect(children.body.map((row: { id: string }) => row.id)).toEqual([issue.id]);
    const count = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows[1]!.id, navigation: "true" }).expect(200);
    expect(count.body[0].subtaskCount).toBe(children.body.length);
    expect((await issueServices.issueService(ctx.db).getById(issue.id))?.externalConversationState).toBe("waiting");
    await ctx.db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, conversation!.id));
    const active = (await read()).body[0];
    expect(active.externalConversationState).toBe("active");
    expect(active.updatedAt).toBe(waiting.updatedAt);
  });

  it("projects the covered-blocker state so every task view picks the same queued glyph (BUG-07)", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Builder", role: "engineer", adapterType: "process" }).returning();
    const [parent] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Parent", status: "blocked" }).returning();
    const [child] = await ctx.db.insert(issues).values({
      companyId: f.companyId, title: "Running child", identifier: "SUM-9", status: "todo", parentId: parent!.id, assigneeAgentId: agent!.id,
    }).returning();
    await ctx.db.insert(issueRelations).values({ companyId: f.companyId, issueId: child!.id, relatedIssueId: parent!.id, type: "blocks" });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: child!.id } });
    await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, child!.id));

    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: `${parent!.id},${f.rows[0]!.id}` }).expect(200);
    expect(res.body[0].blockerAttention).toMatchObject({ state: "covered", reason: "active_child", sampleBlockerIdentifier: "SUM-9" });
    // Only what the glyph needs: no blocker titles or IDs.
    expect(Object.keys(res.body[0].blockerAttention).sort()).toEqual([
      "attentionBlockerCount", "coveredBlockerCount", "reason", "sampleBlockerIdentifier",
      "sampleStalledBlockerIdentifier", "stalledBlockerCount", "state", "unresolvedBlockerCount",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("Running child");
    expect(JSON.stringify(res.body)).not.toContain(child!.id);
    // Unblocked tasks keep the bounded summary shape.
    expect(res.body[1]).not.toHaveProperty("blockerAttention");
  });

  it("does not disclose a private blocker through a readable blocked task's summary", async () => {
    const f = await fixture();
    const [parent] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Public parent", status: "blocked" }).returning();
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({
      id: privateId, companyId: f.companyId, title: "Secret blocker title", status: "todo", visibility: "private",
      privacyRootIssueId: privateId, responsibleUserId: "someone-else", createdByUserId: "someone-else",
    });
    await ctx.db.insert(issueRelations).values({ companyId: f.companyId, issueId: privateId, relatedIssueId: parent!.id, type: "blocks" });

    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: parent!.id }).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].blockerAttention?.state).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain("Secret blocker title");
    expect(JSON.stringify(res.body)).not.toContain(privateId);
    expect(res.body[0].blockerAttention).not.toHaveProperty("terminalBlocker");
  });
});
