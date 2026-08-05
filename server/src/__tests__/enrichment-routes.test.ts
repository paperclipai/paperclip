import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  enrichmentStaging,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { enrichmentRoutes } from "../routes/enrichment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres enrichment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("enrichment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-enrichment-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(enrichmentStaging);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", enrichmentRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(prefix: string) {
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return company!;
  }

  async function seedAgent(companyId: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Reviewer Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!;
  }

  async function seedStagingRow(input: {
    companyId: string;
    batchId: string;
    sourceRowId: string;
    anomalyScore?: string | null;
  }) {
    const [row] = await db.insert(enrichmentStaging).values({
      companyId: input.companyId,
      batchId: input.batchId,
      sourceRowId: input.sourceRowId,
      primaryOutputJson: { secret: "ai-output" },
      anomalyScore: input.anomalyScore ?? null,
    }).returning();
    return row!;
  }

  function agentActor(agentId: string, companyId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_key" };
  }

  function boardActor(companyIds: string[]): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
      memberships: companyIds.map((companyId) => ({
        companyId,
        membershipRole: "admin",
        status: "active",
      })),
    };
  }

  it("blocks an agent from reading another company's batches and staging rows", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const agentA = await seedAgent(companyA.id);
    const batchB = randomUUID();
    await seedStagingRow({ companyId: companyB.id, batchId: batchB, sourceRowId: "b-1" });

    const http = request(app(agentActor(agentA.id, companyA.id)));

    await http.get(`/api/companies/${companyB.id}/enrichment/batches`).expect(403);
    await http.get(`/api/companies/${companyB.id}/enrichment/staging?batchId=${batchB}`).expect(403);
  });

  it("scopes batch and staging reads to the caller's company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const batch = randomUUID();
    // Same batch id lives in both companies; a company read must never see the other's row.
    await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "a-1", anomalyScore: "0.9000" });
    await seedStagingRow({ companyId: companyB.id, batchId: batch, sourceRowId: "b-1", anomalyScore: "0.9000" });

    const http = request(app(boardActor([companyA.id, companyB.id])));

    const batches = await http.get(`/api/companies/${companyA.id}/enrichment/batches`).expect(200);
    expect(batches.body.batches).toEqual([
      { batchId: batch, rowCount: 1, flaggedCount: 1, approvedCount: 0 },
    ]);

    const staging = await http.get(`/api/companies/${companyA.id}/enrichment/staging?batchId=${batch}`).expect(200);
    expect(staging.body.rows).toHaveLength(1);
    expect(staging.body.rows[0].sourceRowId).toBe("a-1");
  });

  it("filters staging rows to flagged when requested", async () => {
    const companyA = await seedCompany("A");
    const batch = randomUUID();
    await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "clean", anomalyScore: "0.1000" });
    await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "flagged", anomalyScore: "0.9000" });

    const http = request(app(boardActor([companyA.id])));
    const flagged = await http
      .get(`/api/companies/${companyA.id}/enrichment/staging?batchId=${batch}&flagged=true`)
      .expect(200);
    expect(flagged.body.rows).toHaveLength(1);
    expect(flagged.body.rows[0].sourceRowId).toBe("flagged");
  });

  it("returns 404 without mutating when approving a missing row", async () => {
    const companyA = await seedCompany("A");
    const http = request(app(boardActor([companyA.id])));
    await http
      .post(`/api/companies/${companyA.id}/enrichment/staging/${randomUUID()}/approve`)
      .expect(404);
    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(0);
  });

  it("returns 404 without mutating another company's row on approve", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const rowB = await seedStagingRow({ companyId: companyB.id, batchId: randomUUID(), sourceRowId: "b-1" });

    // Board user has access to company A; targets company A's path with company B's row id.
    const http = request(app(boardActor([companyA.id, companyB.id])));
    await http
      .post(`/api/companies/${companyA.id}/enrichment/staging/${rowB.id}/approve`)
      .expect(404);

    const [reloaded] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, rowB.id));
    expect(reloaded.humanApprovedAt).toBeNull();
    expect(reloaded.reviewerVerdict).toBeNull();
    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(0);
  });

  it("returns 404 on a second approve of an already-reviewed row", async () => {
    const companyA = await seedCompany("A");
    const agentA = await seedAgent(companyA.id);
    const row = await seedStagingRow({ companyId: companyA.id, batchId: randomUUID(), sourceRowId: "a-1" });

    const http = request(app(agentActor(agentA.id, companyA.id)));
    await http.post(`/api/companies/${companyA.id}/enrichment/staging/${row.id}/approve`).expect(200);
    await http.post(`/api/companies/${companyA.id}/enrichment/staging/${row.id}/approve`).expect(404);

    const [reloaded] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, row.id));
    expect(reloaded.humanApprovedBy).toBe(agentA.id);
  });

  it("logs a safe activity record on approve", async () => {
    const companyA = await seedCompany("A");
    const agentA = await seedAgent(companyA.id);
    const batch = randomUUID();
    const row = await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "a-1" });

    const http = request(app(agentActor(agentA.id, companyA.id)));
    await http.post(`/api/companies/${companyA.id}/enrichment/staging/${row.id}/approve`).expect(200);

    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("enrichment.row_approved");
    expect(logs[0].entityType).toBe("enrichment_staging");
    expect(logs[0].entityId).toBe(row.id);
    expect(logs[0].details).toEqual({ batchId: batch, verdict: "approved" });
    // The AI payload must never leak into the audit trail.
    expect(JSON.stringify(logs[0].details)).not.toContain("ai-output");
  });

  it("logs a safe activity record on reject with a reason", async () => {
    const companyA = await seedCompany("A");
    const agentA = await seedAgent(companyA.id);
    const batch = randomUUID();
    const row = await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "a-1" });

    const http = request(app(agentActor(agentA.id, companyA.id)));
    await http
      .post(`/api/companies/${companyA.id}/enrichment/staging/${row.id}/reject`)
      .send({ reason: "bad value" })
      .expect(200);

    const [reloaded] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, row.id));
    expect(reloaded.reviewerVerdict).toBe("rejected: bad value");

    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("enrichment.row_rejected");
    expect(logs[0].details).toEqual({ batchId: batch, verdict: "rejected: bad value" });
  });

  it("bulk-approves only clean unreviewed rows and logs one record", async () => {
    const companyA = await seedCompany("A");
    const agentA = await seedAgent(companyA.id);
    const batch = randomUUID();
    const clean = await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "clean", anomalyScore: "0.1000" });
    const flagged = await seedStagingRow({ companyId: companyA.id, batchId: batch, sourceRowId: "flagged", anomalyScore: "0.9000" });
    // A row in another company sharing the batch id must be untouched.
    const companyB = await seedCompany("B");
    const foreign = await seedStagingRow({ companyId: companyB.id, batchId: batch, sourceRowId: "b-clean", anomalyScore: "0.1000" });

    const http = request(app(agentActor(agentA.id, companyA.id)));
    const res = await http
      .post(`/api/companies/${companyA.id}/enrichment/batches/${batch}/bulk-approve`)
      .expect(200);
    expect(res.body).toEqual({ ok: true, approved_count: 1 });

    const [cleanRow] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, clean.id));
    const [flaggedRow] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, flagged.id));
    const [foreignRow] = await db.select().from(enrichmentStaging).where(eq(enrichmentStaging.id, foreign.id));
    expect(cleanRow.humanApprovedAt).not.toBeNull();
    expect(flaggedRow.humanApprovedAt).toBeNull();
    expect(foreignRow.humanApprovedAt).toBeNull();

    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("enrichment.batch_bulk_approved");
    expect(logs[0].details).toEqual({ batchId: batch, approvedCount: 1 });
  });
});
