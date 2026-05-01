import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  projects,
  rt2JarvisRewriteEvals,
  rt2JarvisRewriteProposals,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2JarvisAutonomyRoutes } from "../routes/rt2-jarvis-autonomy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres RT2 Phase 75 autonomy tests on this host: " +
      (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("rt2 phase 75 jarvis autonomy apply", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase75-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2JarvisRewriteEvals);
    await db.delete(rt2JarvisRewriteProposals);
    await db.delete(approvals);
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

  async function insertProject(companyId: string) {
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: "Test Project", slug: "test-" + randomUUID() })
      .returning();
    return project.id;
  }

  async function insertProposal(companyId: string, overrides?: Record<string, unknown>) {
    const [proposal] = await db
      .insert(rt2JarvisRewriteProposals)
      .values({
        companyId,
        projectId: null,
        targetType: "issue",
        targetId: randomUUID(),
        targetKey: "test-issue-key",
        title: "Test Jarvis Rewrite",
        status: "proposed",
        riskLevel: "medium",
        proposedDiff: { field: "description", newValue: "Updated description" },
        rationale: "Test rationale for the rewrite",
        citations: [],
        contradictionIds: [],
        createdBy: "test-agent",
        ...overrides,
      })
      .returning();
    return proposal;
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", rt2JarvisAutonomyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  describe("submit for approval", () => {
    it("POST /submit/:proposalId transitions proposal to pending_approval", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid);

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/submit/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ submittedBy: "operator", submittedByType: "user", riskLevel: "high" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("pending_approval");
      expect(res.body.data.approvalId).toBeDefined();
      expect(res.body.data.riskLevel).toBe("high");
    });

    it("POST /submit/:proposalId returns 400 for non-existent proposal", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/submit/" + randomUUID())
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ submittedBy: "operator", submittedByType: "user" });

      expect(res.status).toBe(400);
    });
  });

  describe("approve proposal", () => {
    it("POST /approve/:proposalId transitions proposal to approved", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "pending_approval", approvalRoute: "operator_review" });

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/approve/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ approverId: "operator", approverType: "user", decisionReason: "Looks good" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("approved");
    });
  });

  describe("reject proposal", () => {
    it("POST /reject/:proposalId transitions proposal to rejected", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "pending_approval", approvalRoute: "operator_review" });

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/reject/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ rejecterId: "operator", rejecterType: "user", decisionReason: "Insufficient rationale" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("rejected");
    });

    it("POST /reject/:proposalId returns 400 without decisionReason", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "pending_approval" });

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/reject/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ rejecterId: "operator", rejecterType: "user" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("decisionReason");
    });
  });

  describe("apply proposal", () => {
    it("POST /apply/:proposalId returns applied=true for approved proposals", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "approved" });

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/apply/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ appliedByActorId: "operator", appliedByActorType: "user" });

      expect(res.status).toBe(200);
      expect(res.body.data.applied).toBe(true);
      expect(res.body.data.applyError).toBeNull();
    });

    it("POST /apply/:proposalId returns applied=false for non-approved proposals", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "proposed" });

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/apply/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ appliedByActorId: "operator", appliedByActorType: "user" });

      expect(res.status).toBe(200);
      expect(res.body.data.applied).toBe(false);
      expect(res.body.data.applyError).toContain("Cannot apply proposal in status");
    });

    it("POST /apply/:proposalId transitions proposal to applied status", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      const proposal = await insertProposal(cid, { status: "approved" });

      const app = buildApp();
      await request(app)
        .post("/api/companies/" + cid + "/rt2/jarvis/autonomy/apply/" + proposal.id)
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator")
        .send({ appliedByActorId: "operator", appliedByActorType: "user" });

      const [updated] = await db
        .select()
        .from(rt2JarvisRewriteProposals)
        .where(rt2JarvisRewriteProposals.id === proposal.id)
        .limit(1);

      expect(updated.status).toBe("applied");
    });
  });

  describe("list proposals with gate status", () => {
    it("GET /proposals returns proposals with approval info", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      await insertProposal(cid, { status: "proposed" });
      await insertProposal(cid, { status: "pending_approval" });

      const app = buildApp();
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/jarvis/autonomy/proposals")
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /proposals?status=pending_approval filters by status", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      await insertProposal(cid, { status: "proposed" });
      await insertProposal(cid, { status: "pending_approval" });

      const app = buildApp();
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/jarvis/autonomy/proposals?status=pending_approval")
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator");

      expect(res.status).toBe(200);
      expect(res.body.data.every((p: { status: string }) => p.status === "pending_approval")).toBe(true);
    });
  });

  describe("apply status summary", () => {
    it("GET /status-summary returns correct counts per status", async () => {
      const cid = await insertCompany("Autonomy Test Co");
      await insertProposal(cid, { status: "proposed" });
      await insertProposal(cid, { status: "proposed" });
      await insertProposal(cid, { status: "pending_approval" });
      await insertProposal(cid, { status: "approved" });
      await insertProposal(cid, { status: "applied" });
      await insertProposal(cid, { status: "rejected" });

      const app = buildApp();
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/jarvis/autonomy/status-summary")
        .set("x-actor-type", "user")
        .set("x-actor-id", "operator");

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(6);
      expect(res.body.data.proposed).toBe(2);
      expect(res.body.data.pending_approval).toBe(1);
      expect(res.body.data.approved).toBe(1);
      expect(res.body.data.applied).toBe(1);
      expect(res.body.data.rejected).toBe(1);
    });
  });
});
