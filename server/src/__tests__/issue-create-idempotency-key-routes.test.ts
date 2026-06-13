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
    `Skipping issue idempotencyKey route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/issues — idempotencyKey dedup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let companyId2!: string;
  let agentId!: string;
  let runId!: string;
  let parentIssueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-idempotency-key-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    companyId2 = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();
    parentIssueId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Idempotency Test Corp",
        issuePrefix: "IKY",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: companyId2,
        name: "Other Corp",
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "board-user",
        status: "active",
        membershipRole: "owner",
        updatedAt: new Date(),
      },
      {
        companyId: companyId2,
        principalType: "user",
        principalId: "board-user",
        status: "active",
        membershipRole: "owner",
        updatedAt: new Date(),
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
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

  function makeAppForCompany2() {
    const agent2Id = randomUUID();
    return makeApp({ companyId: companyId2, agentId: agent2Id });
  }

  async function countIssuesByKey(key: string, inCompanyId: string = companyId) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, inCompanyId), eq(issues.idempotencyKey, key)));
    return rows.length;
  }

  // ---- Happy path ----

  it("returns 201 on first create with idempotencyKey (no dedup)", async () => {
    const app = makeApp();
    const key = `issue:${parentIssueId}:first-create-${randomUUID()}`;
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "First create", parentId: parentIssueId, priority: "medium", idempotencyKey: key });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  it("stores idempotencyKey on the created issue", async () => {
    const app = makeApp();
    const key = `issue:${parentIssueId}:stored-key-${randomUUID()}`;
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Store key test", parentId: parentIssueId, priority: "medium", idempotencyKey: key });

    expect(res.status).toBe(201);
    expect(res.body.idempotencyKey).toBe(key);
  });

  it("returns 200 with original issue body on duplicate key within 24h", async () => {
    const app = makeApp();
    const key = `issue:${parentIssueId}:happy-dedup-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Dedup happy path", parentId: parentIssueId, priority: "medium", idempotencyKey: key });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);

    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Dedup happy path", parentId: parentIssueId, priority: "medium", idempotencyKey: key });

    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBe("true");
  });

  it("creates exactly one DB row when same idempotencyKey is POSTed twice", async () => {
    const app = makeApp();
    const key = `issue:${parentIssueId}:one-row-${randomUUID()}`;

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "One row test", parentId: parentIssueId, priority: "medium", idempotencyKey: key });
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "One row test", parentId: parentIssueId, priority: "medium", idempotencyKey: key });

    expect(await countIssuesByKey(key)).toBe(1);
  });

  // ---- Key reset on cancel ----

  it("allows re-create when original issue is cancelled (key released)", async () => {
    const app = makeApp();
    const key = `issue:${parentIssueId}:cancel-reset-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cancel reset test", parentId: parentIssueId, priority: "medium", idempotencyKey: key });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);

    // Cancel the original
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, r1.body.id));

    // Re-create should produce a new issue (not deduplicated)
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cancel reset test", parentId: parentIssueId, priority: "medium", idempotencyKey: key });

    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.id).not.toBe(r1.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  // ---- Cross-company isolation ----

  it("does NOT dedup across companies — same key in company B creates a new issue", async () => {
    const appA = makeApp();
    const key = `issue:shared-key-${randomUUID()}`;

    // Company A creates with the key
    const rA = await request(appA)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cross-company test", priority: "medium", idempotencyKey: key });
    expect(rA.status, JSON.stringify(rA.body)).toBe(201);

    // Company B uses the same key — should get a fresh issue
    const appB = makeAppForCompany2();
    const rB = await request(appB)
      .post(`/api/companies/${companyId2}/issues`)
      .send({ title: "Cross-company test", priority: "medium", idempotencyKey: key });

    expect(rB.status, JSON.stringify(rB.body)).toBe(201);
    expect(rB.body.id).not.toBe(rA.body.id);
    expect(rB.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  // ---- Without idempotencyKey — normal creation, Layer 1 still works ----

  it("does NOT dedup when no idempotencyKey is provided (normal Layer 1 behaviour unaffected)", async () => {
    const app = makeApp();
    const title = `no-key-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });

    // Both should succeed — top-level issues without idempotencyKey are not deduplicated by Layer 2
    // (Layer 1 only fires on child issues with same parentId+title+agent)
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });
});
