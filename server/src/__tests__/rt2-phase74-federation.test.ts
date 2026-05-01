import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  rt2FederationAuditTrails,
  rt2FederationEvidenceContracts,
  rt2FederationPartners,
  rt2SsoConnections,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2FederationRoutes } from "../routes/rt2-federation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres RT2 Phase 74 federation tests on this host: " +
      (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("rt2 phase 74 federation cross-company evidence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let partnerCompanyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase74-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2FederationAuditTrails);
    await db.delete(rt2FederationEvidenceContracts);
    await db.delete(rt2FederationPartners);
    await db.delete(rt2SsoConnections);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.stop();
    }
  });

  async function insertCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, plan: "free", mode: "test" })
      .returning();
    return company.id;
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", rt2FederationRoutes(db));
    app.use(errorHandler);
    return app;
  }

  describe("federation partners", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Federation Test Co");
      partnerCompanyId = await insertCompany("Partner Co");
    });

    it("POST creates a federation partner with pending status", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          partnerCompanyId: partnerCompanyId,
          partnershipType: "bidirectional",
          evidenceSharingLevel: "quality_scores",
          trustLevel: "verified",
          allowedEvidenceTypes: ["quality_score", "reputation"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("pending");
      expect(res.body.data.evidenceSharingLevel).toBe("quality_scores");
      expect(res.body.data.trustLevel).toBe("verified");
      expect(res.body.data.partnershipType).toBe("bidirectional");
    });

    it("GET lists federation partners", async () => {
      const app = buildApp();
      // Create a partner first
      await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("PATCH updates partnership status and evidence sharing level", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const partnerId = createRes.body.data.id;

      const updateRes = await request(app)
        .patch("/api/companies/" + companyId + "/rt2/federation/partners/" + partnerId)
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ status: "active", evidenceSharingLevel: "full_settlements" });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.status).toBe("active");
      expect(updateRes.body.data.evidenceSharingLevel).toBe("full_settlements");
    });

    it("GET /audit-trails returns audit trail entries", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const partnerId = createRes.body.data.id;

      // Record an audit trail entry
      await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/audit-trails")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          federationPartnerId: partnerId,
          evidenceType: "quality_score",
          accessAction: "viewed",
          accessResult: "success",
          accessedByActorId: "partner-agent-1",
          accessedByActorType: "agent",
        });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/federation/audit-trails")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.some(function(t: { evidenceType: string }) {
        return t.evidenceType === "quality_score";
      })).toBe(true);
    });

    it("GET /audit-report returns aggregated audit statistics", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const partnerId = createRes.body.data.id;

      await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/audit-trails")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          federationPartnerId: partnerId,
          evidenceType: "settlement",
          accessAction: "shared",
          accessResult: "redacted",
          accessedByActorId: "partner-user-1",
          accessedByActorType: "user",
        });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/federation/audit-report")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.totalEvents).toBeGreaterThan(0);
      expect(res.body.data.byEvidenceType).toHaveProperty("settlement");
      expect(res.body.data.byAction).toHaveProperty("shared");
      expect(res.body.data.redactedCount).toBeGreaterThan(0);
    });

    it("POST creates an evidence sharing contract", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const partnerId = createRes.body.data.id;

      const contractRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/contracts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          federationPartnerId: partnerId,
          contractType: "quality_evidence",
          evidenceTypes: ["quality_score", "reputation"],
          transformationRules: {
            redactAmounts: true,
            redactNames: false,
            aggregateQuality: true,
            showTiersOnly: true,
          },
        });

      expect(contractRes.status).toBe(201);
      expect(contractRes.body.data.contractType).toBe("quality_evidence");
      expect(contractRes.body.data.evidenceTypes).toContain("quality_score");
      expect(contractRes.body.data.isActive).toBe(true);
    });

    it("GET /contracts lists evidence contracts", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/partners")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ partnerCompanyId: partnerCompanyId });

      const partnerId = createRes.body.data.id;

      await request(app)
        .post("/api/companies/" + companyId + "/rt2/federation/contracts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          federationPartnerId: partnerId,
          contractType: "settlement_summary",
          evidenceTypes: ["settlement"],
        });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/federation/contracts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });
});
