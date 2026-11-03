import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { readBoardBootstrap } from "@paperclipai/shared";
import { expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { authRoutes } from "../routes/auth.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("authenticated board bootstrap", () => {
  const ctx = useEmbeddedPostgres("board-bootstrap-");

  it("uses the authenticated account and current memberships, including for instance admins", async () => {
    const userId = `bootstrap-${randomUUID()}`, companyId = randomUUID(), foreignId = randomUUID();
    const now = new Date();
    await ctx.db.insert(authUsers).values({ id: userId, name: "Bootstrap user", email: `${userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await ctx.db.insert(companies).values([
      { id: companyId, name: "Accessible", issuePrefix: `A${companyId.slice(0, 7)}` },
      { id: foreignId, name: "Directory only", issuePrefix: `B${foreignId.slice(0, 7)}` },
    ]);
    const [membership] = await ctx.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active",
    }).returning();
    await ctx.db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    const app = express();
    app.use(actorMiddleware(ctx.db, { deploymentMode: "authenticated", resolveSession: async () => ({
      session: { id: "bootstrap-session", userId }, user: { id: userId, name: "Bootstrap user", email: `${userId}@example.com` },
    }) }));
    app.use("/api/auth", authRoutes(ctx.db));
    app.use(errorHandler);

    const first = await request(app).get(`/api/auth/get-session?userId=foreign-user&companyId=${foreignId}`).expect(200);
    expect(first.body.user.id).toBe(userId);
    expect(first.body.boardBootstrap.userId).toBe(userId);
    expect(first.body.boardBootstrap.companies.map((value: { id: string }) => value.id)).toEqual([companyId]);
    expect(first.body.boardBootstrap.boardAccess).toEqual({ userId, isInstanceAdmin: true, companyIds: [companyId] });
    expect(readBoardBootstrap(first.body.boardBootstrap, userId)?.companies[0]?.id).toBe(companyId);
    expect(first.headers["cache-control"]).toBe("private, no-store");

    await ctx.db.update(companyMemberships).set({ status: "archived" }).where(eq(companyMemberships.id, membership!.id));
    await ctx.db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, userId));
    const revoked = await request(app).get("/api/auth/get-session").expect(200);
    expect(revoked.body.boardBootstrap.companies).toEqual([]);
    expect(revoked.body.boardBootstrap.boardAccess).toEqual({ userId, isInstanceAdmin: false, companyIds: [] });
  });
});
