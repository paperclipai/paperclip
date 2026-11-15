import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq as equals } from "drizzle-orm";
import { authUsers, companyMemberships, instanceUserRoles, issues, projects } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { AUTHORIZATION_READ_MAX_AGE_MS, authorizationReadScope, readOncePerRequest } from "../services/authorization-read-scope.js";
import { readInstanceAdmin } from "../services/authorization.js";
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
  function membershipRead(companyId: string, userId: string) {
    return readOncePerRequest(`membership:${companyId}:user:${userId}`, () => ctx.db.select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(equals(companyMemberships.companyId, companyId), equals(companyMemberships.principalId, userId),
        equals(companyMemberships.status, "active")))
      .then((rows) => rows.length > 0));
  }

  function streamApp(userId: string, companyId: string, events: { afterRevoke: Promise<void>; late: (allowed: boolean) => void }) {
    const app = express();
    app.use(actorMiddleware(ctx.db, {
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: "Reader", email: `${userId}@example.test` },
      }),
    }));
    app.use(authorizationReadScope);
    app.get("/stream", async (_req, res) => {
      const atConnect = await membershipRead(companyId, userId);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      res.write(`data: ${atConnect}\n\n`);
      await events.afterRevoke;
      res.end(`data: ${await membershipRead(companyId, userId)}\n\n`);
    });
    app.get("/later", async (_req, res) => {
      await membershipRead(companyId, userId);
      setTimeout(() => { void events.afterRevoke.then(() => membershipRead(companyId, userId)).then(events.late); }, 0);
      res.json({ ok: true });
    });
    return app;
  }

  it("re-reads the membership during a stream after it is removed", async () => {
    const fixture = await seed("Stream");
    let revoked!: () => void;
    const afterRevoke = new Promise<void>((resolve) => { revoked = resolve; });
    const app = streamApp(fixture.userId, fixture.companyId, { afterRevoke, late: () => {} });
    const pending = request(app).get("/stream").buffer(true).parse((res, done) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("data: true") && !text.includes("data: false")) {
          void ctx.db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.userId)).then(revoked);
        }
      });
      res.on("end", () => done(null, text));
    });
    const response = await pending;
    expect(response.body).toBe("data: true\n\ndata: false\n\n");
  }, 60_000);

  it("re-reads in a callback that runs after the response and after a revoke", async () => {
    const fixture = await seed("Later");
    let revoked!: () => void;
    const afterRevoke = new Promise<void>((resolve) => { revoked = resolve; });
    let late!: (allowed: boolean) => void;
    const lateResult = new Promise<boolean>((resolve) => { late = resolve; });
    const app = streamApp(fixture.userId, fixture.companyId, { afterRevoke, late });
    await request(app).get("/later").expect(200);
    await ctx.db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.userId));
    revoked();
    expect(await lateResult).toBe(false);
  }, 60_000);

  it("seeds the instance role from a session read that matches the authorization predicate", async () => {
    const now = new Date();
    const cases = [
      { userId: `user-admin-${Date.now()}`, roles: ["instance_admin"], expected: true },
      { userId: `user-other-${Date.now()}`, roles: ["instance_viewer"], expected: false },
      { userId: `user-none-${Date.now()}`, roles: [], expected: false },
    ];
    for (const entry of cases) {
      await ctx.db.insert(authUsers).values({ id: entry.userId, name: entry.userId, email: `${entry.userId}@example.test`,
        emailVerified: true, createdAt: now, updatedAt: now });
      if (entry.roles.length) await ctx.db.insert(instanceUserRoles).values(entry.roles.map((role) => ({ userId: entry.userId, role })));
      const app = express();
      app.use(actorMiddleware(ctx.db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({ session: { id: `session-${entry.userId}`, userId: entry.userId },
          user: { id: entry.userId, name: "Admin check", email: `${entry.userId}@example.test` } }),
      }));
      app.get("/actor", (req, res) => { res.json({ isInstanceAdmin: req.actor.isInstanceAdmin }); });
      const seeded = (await request(app).get("/actor").expect(200)).body.isInstanceAdmin;
      expect({ seeded, read: await readInstanceAdmin(ctx.db, entry.userId) }).toEqual({ seeded: entry.expected, read: entry.expected });
    }
    await ctx.db.delete(instanceUserRoles);
  }, 60_000);

  it("treats HEAD like GET for an authorized read and denies it after a revoke", async () => {
    const fixture = await seed("Head");
    const app = appFor(fixture.userId);
    await request(app).head(`/api/issues/${fixture.issue.id}`).expect(200);
    await ctx.db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.userId));
    await request(app).head(`/api/issues/${fixture.issue.id}`).expect(404);
  }, 60_000);
});

describe("authorization read scope boundaries", () => {
  afterEach(() => { vi.useRealTimers(); });

  function countingApp(actor: Express.Request["actor"] = { type: "board", source: "session", userId: "user-1", isInstanceAdmin: false }) {
    let reads = 0;
    const gates: Array<() => void> = [];
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
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
  it("ignores an entry older than the age bound", async () => {
    const { app, gates, reads } = countingApp();
    vi.useFakeTimers({ toFake: ["Date"] });
    const pending = request(app).get("/read?wait=1").then((res) => res.body);
    while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    vi.setSystemTime(Date.now() + AUTHORIZATION_READ_MAX_AGE_MS + 1);
    gates[0]!();
    expect(await pending).toEqual({ first: 1, second: 2, admin: "read" });
    expect(reads()).toBe(2);
  });

  it("does not keep a rejected read", async () => {
    let attempts = 0;
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "user-1", isInstanceAdmin: false };
      next();
    });
    app.use(authorizationReadScope);
    app.get("/read", async (_req, res) => {
      const read = () => readOncePerRequest("membership:company-1:user:user-1", async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection reset");
        return attempts;
      });
      const first = await read().catch((error: Error) => error.message);
      res.json({ first, second: await read(), third: await read() });
    });
    expect((await request(app).get("/read")).body).toEqual({ first: "connection reset", second: 2, third: 2 });
  });

  it.each([
    ["an agent key", { type: "agent", source: "agent_key", agentId: "agent-1", companyId: "company-1" }],
    ["a board key", { type: "board", source: "board_key", userId: "user-1", isInstanceAdmin: true }],
    ["a cloud tenant", { type: "board", source: "cloud_tenant", userId: "user-1", isInstanceAdmin: true }],
  ] as const)("seeds nothing for %s", async (_label, actor) => {
    const { app } = countingApp(actor as Express.Request["actor"]);
    expect((await request(app).get("/read")).body.admin).toBe("read");
  });
  it("keeps response hooks that later middleware installs", async () => {
    const app = express();
    app.use(authorizationReadScope);
    app.use((_req, res, next) => {
      const { writeHead, write } = res;
      let writes = 0;
      res.writeHead = function (this: typeof res, ...args: Parameters<typeof res.writeHead>) {
        this.setHeader("x-late-hook", "kept");
        return writeHead.apply(this, args);
      } as typeof res.writeHead;
      res.write = function (this: typeof res, ...args: Parameters<typeof res.write>) {
        writes += 1;
        res.locals.writes = writes;
        return write.apply(this, args);
      } as typeof res.write;
      next();
    });
    app.get("/json", (_req, res) => { res.json({ ok: true }); });
    app.get("/stream", (_req, res) => {
      res.write("a");
      res.write("b");
      res.end(String(res.locals.writes));
    });
    const json = await request(app).get("/json").expect(200);
    expect(json.headers["x-late-hook"]).toBe("kept");
    const stream = await request(app).get("/stream").expect(200);
    expect(stream.headers["x-late-hook"]).toBe("kept");
    expect(stream.text).toBe("ab2");
  });
});
