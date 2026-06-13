import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue dedup route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/issues — 60s time-window dedup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let agentId2!: string;
  let runId!: string;
  let parentIssueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-dedup-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();
    agentId2 = randomUUID();
    runId = randomUUID();
    parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Dedup Test Corp",
      issuePrefix: "DED",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "TestAgent",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId2,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: parentIssueId },
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => { throw new Error("unexpected putFile"); }),
      getObject: vi.fn(async () => { throw new Error("unexpected getObject"); }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function makeApp(actorOverride: Partial<Express.Request["actor"]> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_jwt",
        ...actorOverride,
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", issueRoutes(db, makeStorage()));
    app.use(errorHandler);
    return app;
  }

  async function countChildIssues(title: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parentIssueId), eq(issues.title, title)));
    return rows.length;
  }

  // ---- Happy path ----

  it("returns 201 on first create (no dedup)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `dedup-first-${randomUUID()}`, parentId: parentIssueId, priority: "medium" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  it("returns 200 with original issue body on duplicate within 60s", async () => {
    const title = `dedup-happy-${randomUUID()}`;
    const app = makeApp();

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);

    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });

    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBe("true");
  });

  it("creates exactly one DB row when the same child issue is POSTed twice", async () => {
    const title = `dedup-one-row-${randomUUID()}`;
    const app = makeApp();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });

    expect(await countChildIssues(title)).toBe(1);
  });

  // ---- Edge cases from the spec ----

  it("does NOT dedup top-level issues (no parentId)", async () => {
    const title = `top-level-${randomUUID()}`;
    const app = makeApp();

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  it("does NOT dedup when parentId differs", async () => {
    const title = `diff-parent-${randomUUID()}`;
    const parent2Id = randomUUID();
    await db.insert(issues).values({
      id: parent2Id,
      companyId,
      title: "Second parent for dedup edge case",
      status: "todo",
      priority: "medium",
    });

    const app = makeApp();

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parent2Id, priority: "medium" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  it("does NOT dedup when createdByAgentId differs", async () => {
    const title = `diff-agent-${randomUUID()}`;
    const appAgent1 = makeApp();
    const appAgent2 = makeApp({ agentId: agentId2 });

    const r1 = await request(appAgent1)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });
    const r2 = await request(appAgent2)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  it("does NOT dedup a cancelled original — allows genuine re-create", async () => {
    const title = `cancelled-origin-${randomUUID()}`;
    const app = makeApp();

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });
    expect(r1.status).toBe(201);

    // Cancel the original in DB
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, r1.body.id));

    // Re-create should produce a new issue
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, parentId: parentIssueId, priority: "medium" });

    expect(r2.status).toBe(201);
    expect(r2.body.id).not.toBe(r1.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });
});
