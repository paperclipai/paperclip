import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker readback routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blockers-routes-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndBlockers() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockerC = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "todo", priority: "high" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "high" },
      { id: blockerC, companyId, title: "Blocker C", status: "todo", priority: "high" },
    ]);

    return { companyId, blockerA, blockerB, blockerC };
  }

  it("returns blockedByIssueIds, blockedBy, and blocks across create and patch readback", async () => {
    const app = createApp();
    const { companyId, blockerA, blockerB, blockerC } = await seedCompanyAndBlockers();

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Dependent issue",
        status: "blocked",
        priority: "medium",
        blockedByIssueIds: [blockerA],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.blockedByIssueIds).toEqual([blockerA]);
    expect(createRes.body.blockedBy).toEqual([
      expect.objectContaining({ id: blockerA, title: "Blocker A" }),
    ]);
    expect(createRes.body.blocks).toEqual([]);

    const dependentId = createRes.body.id as string;

    const createReadback = await request(app).get(`/api/issues/${dependentId}`);
    expect(createReadback.status).toBe(200);
    expect(createReadback.body.blockedByIssueIds).toEqual([blockerA]);
    expect(createReadback.body.blockedBy).toEqual([
      expect.objectContaining({ id: blockerA, title: "Blocker A" }),
    ]);

    const blockerAReadback = await request(app).get(`/api/issues/${blockerA}`);
    expect(blockerAReadback.status).toBe(200);
    expect(blockerAReadback.body.blocks).toEqual([
      expect.objectContaining({ id: dependentId, title: "Dependent issue" }),
    ]);

    const addRes = await request(app)
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [blockerA, blockerB] });

    expect(addRes.status).toBe(200);
    expect(addRes.body.blockedByIssueIds).toEqual([blockerA, blockerB]);
    expect(addRes.body.blockedBy).toEqual([
      expect.objectContaining({ id: blockerA, title: "Blocker A" }),
      expect.objectContaining({ id: blockerB, title: "Blocker B" }),
    ]);

    const addReadback = await request(app).get(`/api/issues/${dependentId}`);
    expect(addReadback.status).toBe(200);
    expect(addReadback.body.blockedByIssueIds).toEqual([blockerA, blockerB]);

    const replaceRes = await request(app)
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [blockerB, blockerC] });

    expect(replaceRes.status).toBe(200);
    expect(replaceRes.body.blockedByIssueIds).toEqual([blockerB, blockerC]);
    expect(replaceRes.body.blockedBy).toEqual([
      expect.objectContaining({ id: blockerB, title: "Blocker B" }),
      expect.objectContaining({ id: blockerC, title: "Blocker C" }),
    ]);

    const replaceReadback = await request(app).get(`/api/issues/${dependentId}`);
    expect(replaceReadback.status).toBe(200);
    expect(replaceReadback.body.blockedByIssueIds).toEqual([blockerB, blockerC]);

    const blockerCReadback = await request(app).get(`/api/issues/${blockerC}`);
    expect(blockerCReadback.status).toBe(200);
    expect(blockerCReadback.body.blocks).toEqual([
      expect.objectContaining({ id: dependentId, title: "Dependent issue" }),
    ]);

    const clearRes = await request(app)
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [] });

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.blockedByIssueIds).toEqual([]);
    expect(clearRes.body.blockedBy).toEqual([]);

    const clearReadback = await request(app).get(`/api/issues/${dependentId}`);
    expect(clearReadback.status).toBe(200);
    expect(clearReadback.body.blockedByIssueIds).toEqual([]);
    expect(clearReadback.body.blockedBy).toEqual([]);

    const blockerBReadback = await request(app).get(`/api/issues/${blockerB}`);
    expect(blockerBReadback.status).toBe(200);
    expect(blockerBReadback.body.blocks).toEqual([]);
  });

  it("returns empty blocker fields on create when blockedByIssueIds is omitted", async () => {
    const app = createApp();
    const { companyId } = await seedCompanyAndBlockers();

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Standalone issue",
        status: "todo",
        priority: "medium",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.blockedByIssueIds).toEqual([]);
    expect(createRes.body.blockedBy).toEqual([]);
    expect(createRes.body.blocks).toEqual([]);
  });
});
