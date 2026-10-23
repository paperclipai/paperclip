import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping live-runs ordering route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /companies/:companyId/live-runs ordering", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-runs-ordering-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns running runs first when a newer queued backlog exceeds the default limit", async () => {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db
      .insert(companies)
      .values({ name: `Live Runs Co ${nonce}`, issuePrefix: `LR${nonce.slice(0, 4).toUpperCase()}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Engineer",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const base = Date.now() - 24 * 60 * 60 * 1000;
    const minutesAfterBase = (minutes: number) => new Date(base + minutes * 60_000);

    // Two runs started first; 55 queued runs arrived after them. Ordered by
    // createdAt alone, the default 50-row page holds only queued runs.
    const running = await db
      .insert(heartbeatRuns)
      .values([0, 1].map((i) => ({
        companyId: company!.id,
        agentId: agent!.id,
        status: "running",
        contextSnapshot: {},
        createdAt: minutesAfterBase(i),
        startedAt: minutesAfterBase(i),
      })))
      .returning({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt });
    const queued = await db
      .insert(heartbeatRuns)
      .values(Array.from({ length: 55 }, (_, i) => ({
        companyId: company!.id,
        agentId: agent!.id,
        status: "queued",
        contextSnapshot: {},
        createdAt: minutesAfterBase(10 + i),
      })))
      .returning({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt });

    const res = await request(createApp(db, company!.id)).get(`/api/companies/${company!.id}/live-runs`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(50);

    const newestFirst = (a: { createdAt: Date }, b: { createdAt: Date }) =>
      b.createdAt.getTime() - a.createdAt.getTime();
    // Running runs lead the page, newest first.
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual([...running].sort(newestFirst).map((run) => run.id));
    expect(rows.slice(0, 2).every((row) => row.status === "running")).toBe(true);
    // The rest of the page is the 48 newest queued runs, newest first.
    expect(rows.slice(2).map((row) => row.id)).toEqual(
      [...queued].sort(newestFirst).slice(0, 48).map((run) => run.id),
    );
  });
});
