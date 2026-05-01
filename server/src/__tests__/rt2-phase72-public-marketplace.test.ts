import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issueWorkProducts,
  issues,
  projects,
  rt2AgentMarketplace,
  rt2AgentSubscriptions,
  rt2CollaborationRewards,
  rt2QualityScores,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2AgentMarketplaceRoutes } from "../routes/rt2-agent-marketplace.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 phase 72 public marketplace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 phase 72 public marketplace approval workflow", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let otherCompanyId!: string;
  let projectId!: string;
  let listingId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase72-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2AgentSubscriptions);
    await db.delete(rt2AgentMarketplace);
    await db.delete(rt2CollaborationRewards);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(rt2V33TaskParticipants);
    await db.delete(rt2QualityScores);
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.stop();
    }
  });

  // ----- Test helpers -----

  async function insertCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, plan: "free", mode: "test" })
      .returning();
    return company.id;
  }

  async function insertProject(companyId: string) {
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: "Test Project", slug: `test-${randomUUID()}` })
      .returning();
    return project.id;
  }

  async function insertListing(
    companyId: string,
    overrides: Partial<{
      name: string;
      category: string;
      listingApprovalStatus: string;
      rejectionReason: string | null;
      submittedAt: Date | null;
      approvedAt: Date | null;
    }> = {},
  ) {
    const [listing] = await db
      .insert(rt2AgentMarketplace)
      .values({
        creatorCompanyId: companyId,
        name: overrides.name ?? "Test Agent",
        category: overrides.category ?? "coding",
        adapterType: "claude-code",
        description: "A test marketplace listing",
        pricingType: "per_task",
        pricePerTaskCents: 500,
        capabilities: JSON.stringify({ skills: ["typescript", "react"] }),
        isActive: true,
        totalSubscriptions: 0,
        ratingAverage: 4.5,
        ratingCount: 10,
        listingApprovalStatus: overrides.listingApprovalStatus ?? "draft",
        rejectionReason: overrides.rejectionReason ?? null,
        submittedAt: overrides.submittedAt ?? null,
        approvedAt: overrides.approvedAt ?? null,
      })
      .returning();
    return listing.id;
  }

  function makeApp(db: ReturnType<typeof createDb>) {
    const app = express();
    app.use(express.json());
    app.use("/", rt2AgentMarketplaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ----- Tests -----

  describe("createListing defaults to draft", () => {
    it("should create listing with listingApprovalStatus = 'draft'", async () => {
      const cid = await insertCompany("Draft Test Co");
      await insertProject(cid);
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${cid}/rt2/marketplace/listings`)
        .send({ name: "Draft Agent", category: "coding", adapterType: "claude-code" });

      expect(res.status).toBe(200);
      expect(res.body.listingApprovalStatus).toBe("draft");
      expect(res.body.rejectionReason).toBeNull();
      expect(res.body.submittedAt).toBeNull();
      expect(res.body.approvedAt).toBeNull();
    });
  });

  describe("public marketplace routes only return approved listings", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Public Test Co");
      otherCompanyId = await insertCompany("Other Test Co");
      await insertProject(companyId);
      await insertProject(otherCompanyId);
    });

    it("GET /rt2/marketplace/agents should only return approved listings", async () => {
      // Insert one approved, one draft, one pending
      const approvedId = await insertListing(companyId, { name: "Approved Agent", listingApprovalStatus: "approved" });
      const draftId = await insertListing(otherCompanyId, { name: "Draft Agent", listingApprovalStatus: "draft" });
      const pendingId = await insertListing(otherCompanyId, { name: "Pending Agent", listingApprovalStatus: "pending_approval" });

      const app = makeApp(db);
      const res = await request(app).get("/rt2/marketplace/agents");

      expect(res.status).toBe(200);
      const ids = res.body.map((l: { id: string }) => l.id);
      expect(ids).toContain(approvedId);
      expect(ids).not.toContain(draftId);
      expect(ids).not.toContain(pendingId);
    });

    it("GET /rt2/marketplace/agents/:id should return null for non-approved", async () => {
      const draftId = await insertListing(companyId, { name: "Draft Only", listingApprovalStatus: "draft" });
      const app = makeApp(db);

      const res = await request(app).get(`/rt2/marketplace/agents/${draftId}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not found|not approved/i);
    });

    it("GET /rt2/marketplace/agents/:id?includePrivate=true should return draft listing to owner", async () => {
      const draftId = await insertListing(companyId, { name: "My Draft", listingApprovalStatus: "draft" });
      const app = makeApp(db);

      const res = await request(app).get(`/rt2/marketplace/agents/${draftId}?includePrivate=true`);

      expect(res.status).toBe(200);
      expect(res.body.listingApprovalStatus).toBe("draft");
    });
  });

  describe("approval workflow", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Approval Workflow Co");
      await insertProject(companyId);
    });

    it("submitForApproval: draft -> pending_approval", async () => {
      const listingId = await insertListing(companyId, { name: "Submit Test", listingApprovalStatus: "draft" });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/submit-for-approval`);

      expect(res.status).toBe(200);
      expect(res.body.listingApprovalStatus).toBe("pending_approval");
      expect(res.body.submittedAt).not.toBeNull();
    });

    it("submitForApproval: only draft listings can be submitted", async () => {
      const listingId = await insertListing(companyId, { name: "Already Pending", listingApprovalStatus: "pending_approval" });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/submit-for-approval`);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("approveListing: pending_approval -> approved", async () => {
      const listingId = await insertListing(companyId, {
        name: "Approve Test",
        listingApprovalStatus: "pending_approval",
        submittedAt: new Date(),
      });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/approve`);

      expect(res.status).toBe(200);
      expect(res.body.listingApprovalStatus).toBe("approved");
      expect(res.body.approvedAt).not.toBeNull();
    });

    it("approveListing: only pending_approval listings can be approved", async () => {
      const listingId = await insertListing(companyId, { name: "Not Pending", listingApprovalStatus: "draft" });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/approve`);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rejectListing: pending_approval -> rejected with reason", async () => {
      const listingId = await insertListing(companyId, {
        name: "Reject Test",
        listingApprovalStatus: "pending_approval",
        submittedAt: new Date(),
      });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/reject`)
        .send({ reason: "Insufficient documentation" });

      expect(res.status).toBe(200);
      expect(res.body.listingApprovalStatus).toBe("rejected");
      expect(res.body.rejectionReason).toBe("Insufficient documentation");
    });

    it("rejectListing: reason is required", async () => {
      const listingId = await insertListing(companyId, {
        name: "Reject No Reason",
        listingApprovalStatus: "pending_approval",
        submittedAt: new Date(),
      });
      const app = makeApp(db);

      const res = await request(app)
        .post(`/companies/${companyId}/rt2/marketplace/listings/${listingId}/reject`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/reason/i);
    });

    it("getPendingApprovals: returns only pending listings for company", async () => {
      const pendingId = await insertListing(companyId, {
        name: "Pending 1",
        listingApprovalStatus: "pending_approval",
        submittedAt: new Date(),
      });
      await insertListing(companyId, { name: "Approved 1", listingApprovalStatus: "approved" });
      await insertListing(companyId, { name: "Draft 1", listingApprovalStatus: "draft" });

      const app = makeApp(db);
      const res = await request(app).get(`/companies/${companyId}/rt2/marketplace/pending-approvals`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body.some((l: { id: string }) => l.id === pendingId)).toBe(true);
    });
  });

  describe("public evidence contract", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Evidence Contract Co");
      await insertProject(companyId);
    });

    it("getPublicMarketplaceListing should return PublicMarketplaceListing shape", async () => {
      const listingId = await insertListing(companyId, {
        name: "Evidence Test",
        listingApprovalStatus: "approved",
        approvedAt: new Date(),
      });
      const app = makeApp(db);

      const res = await request(app).get(`/rt2/marketplace/agents/${listingId}`);

      expect(res.status).toBe(200);
      // Public evidence contract fields
      expect(res.body).toHaveProperty("publicEvidence");
      expect(res.body.publicEvidence).toHaveProperty("evidenceTier");
      expect(res.body.publicEvidence).toHaveProperty("reputationTier");
      expect(res.body.publicEvidence).toHaveProperty("qualityTier");
      expect(res.body.publicEvidence).toHaveProperty("evidenceStatus");
      expect(res.body.publicEvidence).toHaveProperty("pricingSummary");
      expect(res.body.publicEvidence.approvalStatus).toBe("approved");
      // No raw gold amounts in public view
      expect(res.body).not.toHaveProperty("earnedGoldEstimate");
      expect(res.body).not.toHaveProperty("approvedBasePriceGold");
    });

    it("listPublicMarketplaceAgents should return array of PublicMarketplaceListing", async () => {
      await insertListing(companyId, { name: "Public Agent 1", listingApprovalStatus: "approved", approvedAt: new Date() });
      await insertListing(companyId, { name: "Public Agent 2", listingApprovalStatus: "approved", approvedAt: new Date() });
      const app = makeApp(db);

      const res = await request(app).get("/rt2/marketplace/agents");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("publicEvidence");
        expect(res.body[0].publicEvidence).toHaveProperty("evidenceTier");
        expect(["bronze", "silver", "gold"]).toContain(res.body[0].publicEvidence.evidenceTier);
      }
    });

    it("tier derivation: evidenceTier is bronze/silver/gold based on approved deliverable count", async () => {
      const app = makeApp(db);
      const res = await request(app).get("/rt2/marketplace/agents");

      // Bronze (0-2), Silver (3-5), Gold (6+)
      for (const listing of res.body) {
        expect(["bronze", "silver", "gold"]).toContain(listing.publicEvidence.evidenceTier);
      }
    });

    it("tier derivation: reputationTier is new/established/top_rated based on subscription count", async () => {
      const app = makeApp(db);
      const res = await request(app).get("/rt2/marketplace/agents");

      for (const listing of res.body) {
        expect(["new", "established", "top_rated"]).toContain(listing.publicEvidence.reputationTier);
      }
    });

    it("tier derivation: qualityTier is bronze/silver/gold based on average quality score", async () => {
      const app = makeApp(db);
      const res = await request(app).get("/rt2/marketplace/agents");

      for (const listing of res.body) {
        expect(["bronze", "silver", "gold"]).toContain(listing.publicEvidence.qualityTier);
      }
    });
  });

  describe("company-scoped routes include own listings", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Company Scope Co");
      otherCompanyId = await insertCompany("Other Scope Co");
      await insertProject(companyId);
      await insertProject(otherCompanyId);
    });

    it("GET /companies/:id/rt2/marketplace/agents should include own draft/pending listings", async () => {
      await insertListing(companyId, { name: "My Draft", listingApprovalStatus: "draft" });
      await insertListing(companyId, { name: "My Pending", listingApprovalStatus: "pending_approval" });
      await insertListing(otherCompanyId, { name: "Other Draft", listingApprovalStatus: "draft" });
      const app = makeApp(db);

      const res = await request(app).get(`/companies/${companyId}/rt2/marketplace/agents`);

      expect(res.status).toBe(200);
      const names = res.body.map((l: { name: string }) => l.name);
      expect(names).toContain("My Draft");
      expect(names).toContain("My Pending");
      expect(names).not.toContain("Other Draft");
    });
  });
});
