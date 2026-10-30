import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, issueComments, issueInboxArchives, issueReadStates, issues, issueThreadInteractions, issueAccessGrants, projectAccessMembers, projects } from "@paperclipai/db";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const old = new Date("2026-01-01T00:00:00Z");
const commentAt = new Date("2026-01-02T00:00:00Z");
const newer = new Date("2026-01-03T00:00:00Z");
const readable = sql<boolean>`true`;

describeEmbeddedPostgres("Mine unread badge", () => {
  const ctx = useEmbeddedPostgres("paperclip-mine-unread-");

  it("ranks all visible Mine tasks before unread with canonical activity and exact ID ties", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Mine top100");
    const ids = Array.from({ length: 130 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await ctx.db.insert(issues).values(ids.map(id => ({ id, companyId, title: id, status: "todo", createdByUserId: userId, createdAt: old, updatedAt: commentAt })));
    await ctx.db.insert(issueComments).values(ids.map(issueId => ({ companyId, issueId, body: "External", createdAt: commentAt })));
    await ctx.db.insert(issueReadStates).values(ids.slice(30).map(issueId => ({ companyId, issueId, userId, lastReadAt: newer })));
    const svc = issueService(ctx.db);
    expect(await svc.unreadInboxIssueIds(companyId, userId, readable)).toEqual([]);
    expect((await svc.unreadInboxIssueIds(companyId, userId, inArray(issues.id, ids.slice(0, 30)))).sort()).toEqual(ids.slice(0, 30));
    await ctx.db.insert(activityLog).values({ companyId, entityType: "issue", entityId: ids[0]!, actorType: "agent", actorId: "worker", action: "issue.updated", createdAt: newer });
    expect(await svc.unreadInboxIssueIds(companyId, userId, readable)).toEqual([ids[0]]);
    await ctx.db.insert(activityLog).values([
      { companyId, entityType: "issue", entityId: ids[1]!, actorType: "user", actorId: userId, action: "issue.read_marked", createdAt: new Date("2026-01-04") },
      { companyId, entityType: "issue", entityId: ids[2]!, actorType: "user", actorId: userId, action: "issue.recovery_action_resolved", details: { source: "source_revalidation", trigger: "read_projection" }, createdAt: new Date("2026-01-04") },
    ]);
    expect(await svc.unreadInboxIssueIds(companyId, userId, readable)).toEqual([ids[0]]);
  });

  it("keeps text activity IDs exact and company/user scoped", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Mine IDs");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other company");
    const ids = ["a0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002", randomUUID(), randomUUID(), randomUUID(), "00000000-0000-0000-0000-000000000000", randomUUID()];
    await ctx.db.insert(issues).values(ids.map(id => ({ id, companyId, title: id, originKind: "routine_execution", assigneeUserId: id === ids[6] ? userId : null, createdAt: old, updatedAt: old })));
    await ctx.db.insert(issueComments).values(ids.map(issueId => ({ companyId, issueId, body: "External", createdAt: commentAt })));
    await ctx.db.insert(activityLog).values([
      { companyId, entityType: "issue", entityId: ids[0]!.toUpperCase(), actorType: "user", actorId: userId, action: "issue.updated" },
      ...[ids[0] + "\n", ids[0] + " ", ids[0]!.replaceAll("-", ""), "{" + ids[0] + "}"].map(entityId => ({ companyId, entityType: "issue", entityId, actorType: "user", actorId: userId, action: "issue.updated" })),
      { companyId, entityType: "issue", entityId: ids[5]!, actorType: "user", actorId: userId, action: "issue.updated" },
      { companyId, entityType: "issue", entityId: "not-a-uuid", actorType: "user", actorId: userId, action: "issue.updated" },
      { companyId: other.companyId, entityType: "issue", entityId: ids[1]!, actorType: "user", actorId: userId, action: "issue.updated" },
      { companyId, entityType: "issue", entityId: ids[2]!, actorType: "user", actorId: other.userId, action: "issue.updated" },
      { companyId, entityType: "project", entityId: ids[3]!, actorType: "user", actorId: userId, action: "issue.updated" },
      { companyId, entityType: "issue", entityId: ids[4]!, actorType: "user", actorId: userId, action: "issue.updated" },
    ]);
    expect((await issueService(ctx.db).unreadInboxIssueIds(companyId, userId, readable)).sort()).toEqual([ids[4], ids[5], ids[6]].sort());
  });

  it("preserves pending request audience, self-creator, dismissal and completion rules", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Mine requests");
    const names = ["addressed", "selfCreator", "otherUser", "dismissed", "done", "cancelled"];
    const ids = Object.fromEntries(names.map(name => [name, randomUUID()]));
    await ctx.db.insert(issues).values(names.map(name => ({ id: ids[name]!, companyId, title: name, originKind: "routine_execution", status: name === "done" || name === "cancelled" ? name : "todo", createdAt: old, updatedAt: old })));
    await ctx.db.insert(issueThreadInteractions).values(names.map(name => ({ companyId, issueId: ids[name]!, kind: "request_confirmation", status: "pending", addresseeUserId: name === "otherUser" ? "other-user" : userId,
      createdByUserId: name === "selfCreator" ? userId : null, effectiveResolverPolicy: name === "selfCreator" ? "not_creator" as const : "human_only" as const,
      effectiveResolverPolicySource: "requested" as const, dismissedAt: name === "dismissed" ? newer : null, payload: { version: 1 as const, prompt: "Accept?" }, createdAt: commentAt })));
    const svc = issueService(ctx.db);
    expect(await svc.unreadInboxIssueIds(companyId, userId, readable)).toEqual([ids.addressed]);
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: ids.addressed!, userId, lastReadAt: newer });
    expect(await svc.unreadInboxIssueIds(companyId, userId, readable)).toEqual([]);
  });

  it("keeps archive resurfacing and deleted-comment rules", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Mine archives");
    const names = ["archived", "humanReply", "deletedReply", "statusChange", "doneAlreadyArchived"];
    const ids = Object.fromEntries(names.map(name => [name, randomUUID()]));
    await ctx.db.insert(issues).values(names.map(name => ({ id: ids[name]!, companyId, title: name, createdByUserId: userId, status: name === "doneAlreadyArchived" ? "done" : "todo", completedAt: name === "doneAlreadyArchived" ? old : null, createdAt: old, updatedAt: old })));
    await ctx.db.insert(issueInboxArchives).values(names.map(name => ({ companyId, issueId: ids[name]!, userId, archivedAt: commentAt })));
    await ctx.db.insert(issueComments).values([...names.map(name => ({ companyId, issueId: ids[name]!, body: "Old unread", createdAt: commentAt })),
      { companyId, issueId: ids.humanReply!, authorUserId: "other-user", body: "Resurface", createdAt: newer },
      { companyId, issueId: ids.deletedReply!, authorUserId: "other-user", body: "Deleted", deletedAt: newer, createdAt: newer }]);
    await ctx.db.insert(activityLog).values(["statusChange", "doneAlreadyArchived"].map(name => ({ companyId, entityType: "issue", entityId: ids[name]!, actorType: "agent", actorId: "worker", action: "issue.updated", createdAt: newer, details: { status: name === "statusChange" ? "blocked" : "done", _previous: { status: "in_progress" } } })));
    expect((await issueService(ctx.db).unreadInboxIssueIds(companyId, userId, readable)).sort()).toEqual([ids.humanReply, ids.statusChange].sort());
  });

  it("applies read restrictions and returns fresh unread state through the badge route", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Mine access");
    const [visible, denied] = [randomUUID(), randomUUID()];
    await ctx.db.insert(issues).values([{ id: visible, companyId, title: "Visible", createdByUserId: userId, createdAt: old, updatedAt: old }, { id: denied, companyId, title: "Denied", createdByUserId: userId, createdAt: old, updatedAt: newer }]);
    await ctx.db.insert(issueComments).values([visible, denied].map(issueId => ({ companyId, issueId, body: "External", createdAt: commentAt })));
    const svc = issueService(ctx.db);
    expect(await svc.unreadInboxIssueIds(companyId, userId, eq(issues.id, visible))).toEqual([visible]);
    expect(await svc.unreadInboxIssueIds(companyId, userId, sql<boolean>`false`)).toEqual([]);
    const app = routeApp(ctx.db, actor, sidebarBadgeRoutes), url = `/api/companies/${companyId}/sidebar-badges`;
    expect((await request(app).get(url).expect(200)).body.unreadIssueIds.sort()).toEqual([visible, denied].sort());
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: visible, userId, lastReadAt: newer });
    expect((await request(app).get(url).expect(200)).body.unreadIssueIds).toEqual([denied]);
    await request(app).get(`/api/companies/${randomUUID()}/sidebar-badges`).expect(403);
  });

  it("checks inherited task grants and private project access on each badge read", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Mine privacy");
    const [parent, child, sibling, projectIssue] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [project] = await ctx.db.insert(projects).values({ companyId, name: "Private project", visibility: "private" }).returning();
    await ctx.db.insert(issues).values({ id: parent!, companyId, title: "Private parent", visibility: "private", createdByUserId: "other-user", createdAt: old, updatedAt: old });
    await ctx.db.insert(issues).values([
      { id: child!, companyId, title: "Child", privacyParentIssueId: parent!, createdByUserId: "other-user", createdAt: old, updatedAt: old },
      { id: sibling!, companyId, title: "Sibling", privacyParentIssueId: parent!, createdByUserId: "other-user", createdAt: old, updatedAt: old },
      { id: projectIssue!, companyId, title: "Project task", projectId: project!.id, createdByUserId: "other-user", createdAt: old, updatedAt: old },
    ]);
    await ctx.db.insert(issueComments).values([parent!, child!, sibling!, projectIssue!].flatMap(issueId => [
      { companyId, issueId, authorUserId: userId, body: "Direct reply", createdAt: old },
      { companyId, issueId, authorUserId: "other-user", body: "External result", createdAt: commentAt },
    ]));
    const readCondition = await issueReadSqlCondition(ctx.db, { ...actor, source: "session" });
    const svc = issueService(ctx.db);
    expect(await svc.unreadInboxIssueIds(companyId, userId, readCondition)).toEqual([]);
    const [grant] = await ctx.db.insert(issueAccessGrants).values({ issueId: child!, subjectType: "user", subjectId: userId, source: "explicit" }).returning();
    expect(await svc.unreadInboxIssueIds(companyId, userId, readCondition)).toEqual([child]);
    await ctx.db.update(issueAccessGrants).set({ revokedAt: newer }).where(eq(issueAccessGrants.id, grant!.id));
    expect(await svc.unreadInboxIssueIds(companyId, userId, readCondition)).toEqual([]);
    await ctx.db.insert(projectAccessMembers).values({ companyId, projectId: project!.id, subjectType: "user", subjectId: userId });
    expect(await svc.unreadInboxIssueIds(companyId, userId, readCondition)).toEqual([projectIssue]);
  });

});
