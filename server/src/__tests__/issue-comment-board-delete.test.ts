import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, authUsers, issueComments, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("board delete of agent-authored comments", () => {
  const ctx = useEmbeddedPostgres("paperclip-board-comment-delete-", {
    resetEach: async db => {
      await db.delete(activityLog);
      await db.delete(issueComments);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
      await db.delete(authUsers);
    },
  });

  it("tombstones the comment and removes only its snippet from the activity log", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Board delete");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Author agent",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const svc = issueService(ctx.db);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const issue = await svc.create(companyId, { title: "Issue with agent comments", status: "backlog" });
    const target = await svc.addComment(issue.id, "Sensitive agent output", { agentId });
    const kept = await svc.addComment(issue.id, "Ordinary agent output", { agentId });
    const row = (commentId: string, bodySnippet: string) => ({
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issue.id,
      details: { commentId, bodySnippet, identifier: issue.identifier },
    });
    await ctx.db.insert(activityLog).values([
      row(target.id, "Sensitive agent output"),
      row(kept.id, "Ordinary agent output"),
    ]);

    const res = await request(app).delete(`/api/issues/${issue.id}/comments/${target.id}`).expect(200);
    expect(res.body).toMatchObject({ id: target.id, body: "", deletedByType: "user" });

    const [stored] = await ctx.db.select().from(issueComments).where(eq(issueComments.id, target.id));
    expect(stored!.deletedAt).not.toBeNull();
    expect(stored!.body).toBe("");

    const rows = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    const byComment = (commentId: string, action: string) => rows.find(item =>
      item.action === action && (item.details as Record<string, unknown>).commentId === commentId);
    const scrubbed = byComment(target.id, "issue.comment_added")!.details as Record<string, unknown>;
    expect(scrubbed).not.toHaveProperty("bodySnippet");
    expect(scrubbed.commentId).toBe(target.id);
    expect(scrubbed.identifier).toBe(issue.identifier);
    expect((byComment(kept.id, "issue.comment_added")!.details as Record<string, unknown>).bodySnippet).toBe("Ordinary agent output");
    expect((byComment(target.id, "issue.comment_deleted")!.details as Record<string, unknown>).source).toBe("board_delete");
    expect(JSON.stringify(rows)).not.toContain("Sensitive agent output");
  });

  it("clears a snippet left by a comment that was already deleted", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Old tombstone");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Author agent",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const svc = issueService(ctx.db);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const issue = await svc.create(companyId, { title: "Old tombstone issue", status: "backlog" });
    const comment = await svc.addComment(issue.id, "Old sensitive output", { agentId });
    await ctx.db.update(issueComments)
      .set({ body: "", deletedAt: new Date(), deletedByType: "agent", deletedByAgentId: agentId })
      .where(eq(issueComments.id, comment.id));
    await ctx.db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issue.id,
      details: { commentId: comment.id, bodySnippet: "Old sensitive output" },
    });

    await request(app).delete(`/api/issues/${issue.id}/comments/${comment.id}`).expect(200);

    const rows = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(JSON.stringify(rows)).not.toContain("Old sensitive output");
  });

  it("still refuses an agent that deletes another agent's comment", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Agent actor");
    const [actorAgentId, authorAgentId] = [randomUUID(), randomUUID()];
    await ctx.db.insert(agents).values([actorAgentId, authorAgentId].map((id, index) => ({
      id,
      companyId,
      name: `Agent ${index}`,
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    const svc = issueService(ctx.db);
    const issue = await svc.create(companyId, { title: "Other agent's comment", status: "backlog", assigneeAgentId: actorAgentId });
    const comment = await svc.addComment(issue.id, "Written by another agent", { agentId: authorAgentId });
    const app = routeApp(ctx.db, { type: "agent", agentId: actorAgentId, companyId, source: "agent_key", runId: null } as never, issueRoutes);

    const res = await request(app).delete(`/api/issues/${issue.id}/comments/${comment.id}`);

    expect([401, 403]).toContain(res.status);
    const [stored] = await ctx.db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(stored!.deletedAt).toBeNull();
  });

  it("still refuses to delete another human's comment", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Human author");
    const svc = issueService(ctx.db);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const issue = await svc.create(companyId, { title: "Issue with a human comment", status: "backlog" });
    const comment = await svc.addComment(issue.id, "A human wrote this", { userId: `author-${randomUUID()}` });

    await request(app).delete(`/api/issues/${issue.id}/comments/${comment.id}`).expect(403);

    const [stored] = await ctx.db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(stored!.deletedAt).toBeNull();
  });
});
