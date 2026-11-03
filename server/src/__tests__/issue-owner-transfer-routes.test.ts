import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, heartbeatRuns, companyMemberships, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("responsible owner transfers", () => {
  const ctx = useEmbeddedPostgres("paperclip-owner-transfer-");
  async function fixture(role = "member") {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Owner transfers");
    await ctx.db.update(companyMemberships).set({ membershipRole: role }).where(eq(companyMemberships.principalId, f.userId));
    const targetId = `user-${randomUUID()}`;
    await ctx.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: targetId, status: "active", membershipRole: "member" });
    const [issue] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Transfer", responsibleUserId: f.userId, createdByUserId: f.userId }).returning();
    return { ...f, targetId, issue: issue!, app: routeApp(ctx.db, f.actor, issueRoutes) };
  }
  const url = (id: string) => `/api/issues/${id}/responsible-owner`;

  it.each(["member", "admin", "owner"])("allows %s to transfer and preserves origin and audit", async (role) => {
    const f = await fixture(role);
    if (role !== "member") await ctx.db.update(issues).set({ responsibleUserId: f.targetId }).where(eq(issues.id, f.issue.id));
    const expected = role === "member" ? f.userId : f.targetId;
    const target = role === "member" ? f.targetId : f.userId;
    expect((await request(f.app).get(url(f.issue.id)).expect(200)).body.canTransfer).toBe(true);
    const response = await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: target, expectedResponsibleUserId: expected }).expect(200);
    expect(response.body.responsibleUserId).toBe(target);
    expect(response.body.createdByUserId).toBe(f.userId);
    const audit = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ responsibleUserId: target, previousResponsibleUserId: expected });
  });

  it("denies the old owner after transfer, including the task creator", async () => {
    const f = await fixture();
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(200);
    expect((await request(f.app).get(url(f.issue.id)).expect(200)).body.canTransfer).toBe(false);
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.userId, expectedResponsibleUserId: f.targetId }).expect(403);
  });

  it("denies agents even when they act for the owner", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    const actor = { type: "agent", agentId: agent!.id, companyId: f.companyId, source: "agent_key", onBehalfOfUserId: f.userId, onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] };
    const app = routeApp(ctx.db, actor as never, issueRoutes);
    await request(app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(403);
  });

  it("serializes competing transfers against the observed owner", async () => {
    const f = await fixture("admin");
    const results = await Promise.all([1, 2].map(() => request(f.app).post(url(f.issue.id))
      .send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const audit = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(audit).toHaveLength(1);
  });

  it("lets the new owner transfer a private task again", async () => {
    const f = await fixture();
    await ctx.db.update(issues).set({ visibility: "private", privacyRootIssueId: f.issue.id }).where(eq(issues.id, f.issue.id));
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(200);
    const nextApp = routeApp(ctx.db, { ...f.actor, userId: f.targetId,
      memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }],
    }, issueRoutes);
    expect((await request(nextApp).get(url(f.issue.id)).expect(200)).body.canTransfer).toBe(true);
    await request(nextApp).post(url(f.issue.id)).send({ responsibleUserId: f.userId, expectedResponsibleUserId: f.targetId }).expect(200);
  });

  it("supports creator fallback and rejects stale ownership", async () => {
    const f = await fixture();
    await ctx.db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, f.issue.id));
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(409);
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: null }).expect(200);
  });

  it("rejects foreign, inactive and empty recipients without changing the task", async () => {
    const f = await fixture();
    const foreign = await fixture();
    for (const target of [foreign.targetId, "missing"]) {
      await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: target, expectedResponsibleUserId: f.userId }).expect(422);
    }
    await ctx.db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.targetId));
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(422);
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: "", expectedResponsibleUserId: f.userId }).expect(400);
    const [unchanged] = await ctx.db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(unchanged!.responsibleUserId).toBe(f.userId);
  });

  it("blocks transfers during a run", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Runner", role: "engineer", adapterType: "process" }).returning();
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running" }).returning();
    await ctx.db.update(issues).set({ checkoutRunId: run!.id }).where(eq(issues.id, f.issue.id));
    await request(f.app).post(url(f.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: f.userId }).expect(409);
  });

  it("does not allow cross-company reads or writes", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await request(f.app).get(url(foreign.issue.id)).expect(404);
    await request(f.app).post(url(foreign.issue.id)).send({ responsibleUserId: f.targetId, expectedResponsibleUserId: foreign.userId }).expect(404);
  });
});
