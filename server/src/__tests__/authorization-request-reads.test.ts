import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { authUsers, companyMemberships, issues, projects } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { authorizationReadScope } from "../services/authorization-read-scope.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("authorization reads per request", () => {
  const ctx = useEmbeddedPostgres("authorization-request-reads-");

  function appFor(userId: string) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(ctx.db, {
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: "Reader", email: `${userId}@example.test` },
      }),
    }));
    app.use(authorizationReadScope);
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seed(name: string) {
    const company = await seedCompanyWithBoardAccess(ctx.db, name);
    const now = new Date();
    await ctx.db.insert(authUsers).values({
      id: company.userId, name, email: `${company.userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    });
    const [project] = await ctx.db.insert(projects).values({ companyId: company.companyId, name: `${name} project` }).returning();
    const [issue] = await ctx.db.insert(issues).values({
      companyId: company.companyId, title: `${name} task`, status: "todo", projectId: project!.id, createdByUserId: company.userId,
    }).returning();
    return { ...company, issue: issue! };
  }

  it("reads the instance role once per request and the membership once for the authorization of one issue read", async () => {
    const { host, port } = (ctx.db.$client as unknown as { options: { host: string[]; port: number[] } }).options;
    const meter = meterDatabaseStatements(ctx.db, `postgres://${host[0]}:${port[0]}/authorization`);
    try {
      const fixture = await seed("Reads");
      const app = appFor(fixture.userId);
      await request(app).get(`/api/issues/${fixture.issue.id}`).expect(200);
      meter.startLog();
      await request(app).get(`/api/issues/${fixture.issue.id}`).expect(200);
      const log = meter.stopLog();
      const roleReads = log.filter((entry) => /from "instance_user_roles"/.test(entry.sql));
      const membershipReads = log.filter((entry) => /from "company_memberships"/.test(entry.sql));
      expect(roleReads).toHaveLength(1);
      expect(membershipReads).toHaveLength(2);

      meter.startLog();
      await request(app).get(`/api/companies/${fixture.companyId}/issues`).expect(200);
      await request(app).get(`/api/companies/${fixture.companyId}/issues/summaries?ids=${fixture.issue.id}`).expect(200);
      const listLog = meter.stopLog();
      expect(listLog.filter((entry) => /from "instance_user_roles"/.test(entry.sql))).toHaveLength(2);
    } finally {
      meter.uninstall();
    }
  }, 60_000);

  it("denies the very next request after the membership is removed", async () => {
    const fixture = await seed("Revoked");
    const app = appFor(fixture.userId);
    await request(app).get(`/api/issues/${fixture.issue.id}`).expect(200);
    await ctx.db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.userId));
    await request(app).get(`/api/issues/${fixture.issue.id}`).expect(404);
  }, 60_000);
});
