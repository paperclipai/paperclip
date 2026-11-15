import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authUsers, companyMemberships, issues, projects } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { authorizationReadScope, readOncePerRequest } from "../services/authorization-read-scope.js";
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

describe("authorization read scope boundaries", () => {
  function countingApp() {
    let reads = 0;
    const gates: Array<() => void> = [];
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "user-1", isInstanceAdmin: false };
      next();
    });
    app.use(authorizationReadScope);
    app.all("/read", async (req, res) => {
      const read = () => readOncePerRequest("membership:company-1:user:user-1", async () => ++reads);
      const first = await read();
      if (req.query.wait) await new Promise<void>((resolve) => gates.push(resolve));
      res.json({ first, second: await read(), admin: await readOncePerRequest("admin:user-1", async () => "read") });
    });
    return { app, gates, reads: () => reads };
  }

  it("shares a read only inside one GET request", async () => {
    const { app, reads } = countingApp();
    expect((await request(app).get("/read")).body).toEqual({ first: 1, second: 1, admin: false });
    expect((await request(app).get("/read")).body).toEqual({ first: 2, second: 2, admin: false });
    expect(reads()).toBe(2);
  });

  it("reads again for every call in a write request", async () => {
    const { app, reads } = countingApp();
    expect((await request(app).post("/read")).body).toEqual({ first: 1, second: 2, admin: "read" });
    expect((await request(app).delete("/read")).body).toEqual({ first: 3, second: 4, admin: "read" });
    expect(reads()).toBe(4);
  });

  it("keeps overlapping GET requests apart", async () => {
    const { app, gates } = countingApp();
    const slow = request(app).get("/read?wait=1").then((res) => res.body);
    while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const fast = await request(app).get("/read");
    gates[0]!();
    expect(await slow).toEqual({ first: 1, second: 1, admin: false });
    expect(fast.body).toEqual({ first: 2, second: 2, admin: false });
  });
});
