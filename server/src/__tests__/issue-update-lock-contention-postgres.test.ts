import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import express, { type ErrorRequestHandler } from "express";
import pino, { type Logger } from "pino";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createHttpLogger } from "../middleware/logger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("issue PATCH response under PostgreSQL lock contention", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-issue-write-lock-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(options: { httpLogger?: Logger; onError?: () => void } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const sourceIssueId = randomUUID(), targetIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic lock test", issuePrefix: `L${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic worker", role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, permissions: {} });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, title: "Source task", status: "in_progress", assigneeAgentId: agentId },
      { id: targetIssueId, companyId, title: "Target task", status: "blocked", assigneeAgentId: agentId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      contextSnapshot: { issueId: sourceIssueId } });
    const app = express();
    if (options.httpLogger) app.use(createHttpLogger(options.httpLogger));
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    if (options.onError) app.use(((error, _req, _res, next) => {
      options.onError?.();
      next(error);
    }) as ErrorRequestHandler);
    app.use(errorHandler);
    return { app, companyId, agentId, runId, targetIssueId };
  }

  const body = { status: "in_review", executionPolicy: { monitor: {
    nextCheckAt: "2099-12-01T12:00:00.000Z", notes: "Synthetic monitor" } }, comment: "Synthetic check complete" };

  it.each(["issue", "company"])("returns 200 only for persisted writes while the %s row is locked", async lockedTable => {
    const f = await fixture();
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let blockerPid = 0;
    const blocker = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      blockerPid = Number(backend.pid);
      if (lockedTable === "issue") {
        await tx.select().from(issues).where(eq(issues.id, f.targetIssueId)).for("no key update");
      } else {
        await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      }
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let responded = false;
    const mutation = request(f.app).patch(`/api/issues/${f.targetIssueId}`).send(body).timeout({ deadline: 5_000 })
      .then(response => { responded = true; return response; });
    try {
      await expect.poll(async () => (await db.select().from(activityLog).where(and(
        eq(activityLog.runId, f.runId), eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ))).length).toBe(2);
      if (lockedTable === "issue") {
        await expect.poll(async () => {
          const [waiting] = await db.execute(sql`select count(*)::int as count from pg_stat_activity
            where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))`);
          return Number(waiting.count);
        }).toBeGreaterThan(0);
        expect(responded).toBe(false);
        expect((await db.select().from(issues).where(eq(issues.id, f.targetIssueId)))[0].status).toBe("blocked");
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetIssueId))).toHaveLength(0);
      } else {
        expect((await mutation).status).toBe(200);
        expect((await db.select().from(issues).where(eq(issues.id, f.targetIssueId)))[0].status).toBe("in_review");
      }
    } finally {
      release.resolve();
      await blocker;
    }
    const response = await mutation;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, f.targetIssueId));
    expect(persisted.status).toBe("in_review");
    expect(persisted.executionPolicy).toMatchObject(body.executionPolicy);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetIssueId)))
      .toMatchObject([{ body: body.comment }]);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.targetIssueId), eq(activityLog.action, "issue.updated"),
    ))).toHaveLength(1);
  });

  it("returns an error when the database rejects the issue write", async () => {
    const f = await fixture();
    await db.execute(sql`create function reject_synthetic_issue_write() returns trigger language plpgsql as $$
      begin raise exception 'synthetic issue write rejected'; end $$`);
    await db.execute(sql`create trigger reject_synthetic_issue_write before update on issues
      for each row execute function reject_synthetic_issue_write()`);
    let response;
    try {
      response = await request(f.app).patch(`/api/issues/${f.targetIssueId}`).send(body);
    } finally {
      await db.execute(sql`drop trigger reject_synthetic_issue_write on issues`);
      await db.execute(sql`drop function reject_synthetic_issue_write()`);
    }
    expect(response.status).toBe(500);
    expect((await db.select().from(issues).where(eq(issues.id, f.targetIssueId)))[0].status).toBe("blocked");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetIssueId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.runId, f.runId), eq(activityLog.action, "issue.cross_issue_influence_observed"),
    ))).toHaveLength(2);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.targetIssueId), eq(activityLog.action, "issue.updated"),
    ))).toHaveLength(0);
  });

  it("records an abort, not HTTP 200, when a blocked write fails after the client disconnects", async () => {
    const logs: Array<Record<string, any>> = [];
    const stream = new Writable({ write(chunk, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()));
      callback();
    } });
    let failed = false;
    const f = await fixture({ httpLogger: pino(stream), onError: () => { failed = true; } });
    await db.execute(sql`create function reject_disconnected_issue_write() returns trigger language plpgsql as $$
      begin raise exception 'synthetic disconnected issue write rejected'; end $$`);
    await db.execute(sql`create trigger reject_disconnected_issue_write before update on issues
      for each row execute function reject_disconnected_issue_write()`);
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let blockerPid = 0;
    const blocker = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      blockerPid = Number(backend.pid);
      await tx.select().from(issues).where(eq(issues.id, f.targetIssueId)).for("no key update");
      locked.resolve();
      await release.promise;
    });
    const server = createServer(f.app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    let receivedResponse = false;
    const client = httpRequest({ hostname: "127.0.0.1", port: address.port,
      path: `/api/issues/${f.targetIssueId}`, method: "PATCH", headers: { "content-type": "application/json" } }, res => {
      receivedResponse = true;
      res.resume();
    });
    client.on("error", () => undefined);
    try {
      await locked.promise;
      client.end(JSON.stringify(body));
      await expect.poll(async () => {
        const [waiting] = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))`);
        return Number(waiting.count);
      }).toBeGreaterThan(0);
      client.destroy();
      await expect.poll(() => logs.length, { timeout: 3_000 }).toBe(1);
      expect(receivedResponse).toBe(false);
      expect(logs).toMatchObject([{ level: 40,
        msg: `PATCH /issues/${f.targetIssueId} — request aborted before response`, res: { statusCode: null } }]);
      release.resolve();
      await blocker;
      await expect.poll(() => failed).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, f.targetIssueId)))[0].status).toBe("blocked");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetIssueId))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.runId, f.runId), eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ))).toHaveLength(2);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, f.targetIssueId), eq(activityLog.action, "issue.updated"),
      ))).toHaveLength(0);
    } finally {
      client.destroy();
      release.resolve();
      await blocker;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await db.execute(sql`drop trigger reject_disconnected_issue_write on issues`);
      await db.execute(sql`drop function reject_disconnected_issue_write()`);
    }
  });
});
