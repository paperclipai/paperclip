import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  projects,
  rt2CoinLedger,
  rt2PayrollRuns,
  rt2PayrollRunEntries,
  rt2PaymentReceipts,
  rt2PersonalPnL,
  rt2QualityScores,
  rt2SettlementGovernance,
  rt2SettlementReconciliation,
  rt2V33TaskParticipants,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2PayrollSettlementRoutes } from "../routes/rt2-payroll-settlement.js";
import { rt2PersonalPnLRoutes } from "../routes/rt2-personal-pnl.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres RT2 Phase 73 payroll/settlement tests on this host: " +
      (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("rt2 phase 73 payroll settlement", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase73-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2SettlementReconciliation);
    await db.delete(rt2PayrollRunEntries);
    await db.delete(rt2PayrollRuns);
    await db.delete(rt2PaymentReceipts);
    await db.delete(rt2CoinLedger);
    await db.delete(rt2PersonalPnL);
    await db.delete(rt2SettlementGovernance);
    await db.delete(rt2QualityScores);
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

  async function insertIssue(projectId: string, companyId: string) {
    const [issue] = await db
      .insert(issues)
      .values({
        projectId,
        companyId,
        title: "Test Issue",
        status: "in_progress",
        priority: "medium",
      })
      .returning();
    return issue.id;
  }

  async function insertPersonalPnL(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    period: string,
    income: number,
  ) {
    await db.insert(rt2PersonalPnL).values({
      companyId,
      actorId,
      actorType,
      period,
      income,
      expenses: 0,
      netPnL: income,
    });
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", rt2PersonalPnLRoutes(db));
    app.use("/api", rt2PayrollSettlementRoutes(db));
    app.use(errorHandler);
    return app;
  }

  describe("payroll routes", () => {
    beforeAll(async () => {
      companyId = await insertCompany("Payroll Test Co");
    });

    it("POST /companies/:companyId/rt2/payroll/run creates a payroll run", async () => {
      const period = "2026-05";
      await insertPersonalPnL(companyId, "agent-1", "agent", period, 1000);
      await insertPersonalPnL(companyId, "agent-2", "agent", period, 500);

      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/run")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ period });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        companyId,
        period,
        status: "completed",
        totalGrossGold: 1500,
        actorCount: 2,
      });
      expect(res.body.data.totalNetGold).toBe(1275);
      expect(res.body.data.totalDeductions).toBe(225);
    });

    it("GET /companies/:companyId/rt2/payroll/runs lists payroll runs", async () => {
      const period = "2026-04";
      await insertPersonalPnL(companyId, "agent-1", "agent", period, 800);
      const app = buildApp();

      await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/run")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ period });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/payroll/runs")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .query({ limit: 5 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("POST /companies/:companyId/rt2/payroll/receipts adds a payment receipt", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/receipts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({
          providerReference: "PAY-12345",
          providerName: "Bank Transfer",
          amount: 500,
          currency: "GOLD",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.providerReference).toBe("PAY-12345");
      expect(res.body.data.status).toBe("pending");
    });

    it("POST /companies/:companyId/rt2/payroll/receipts/:receiptId/confirm confirms a receipt", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/receipts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ providerReference: "PAY-CONFIRM", amount: 300 });

      const receiptId = createRes.body.data.id;
      const confirmRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/receipts/" + receiptId + "/confirm")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user");

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.data.status).toBe("confirmed");
    });

    it("GET /companies/:companyId/rt2/payroll/receipts returns receipts", async () => {
      const app = buildApp();
      await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/receipts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ providerReference: "PAY-LIST", amount: 200 });

      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/payroll/receipts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user");

      expect(res.status).toBe(200);
      expect(
        res.body.data.some(function(r: { providerReference: string }) {
          return r.providerReference === "PAY-LIST";
        }),
      ).toBe(true);
    });

    it("POST /companies/:companyId/rt2/payroll/reconcile reconciles settlement with receipt", async () => {
      const projectId = await insertProject(companyId);
      const issueId = await insertIssue(projectId, companyId);
      const [settlement] = await db
        .insert(rt2SettlementGovernance)
        .values({
          companyId,
          workProductId: "wp-reconcile-test",
          taskIssueId: issueId,
          ownerActorId: "agent-reconcile",
          ownerActorType: "agent",
          proposedPriceGold: 500,
          status: "approved",
        })
        .returning();

      const app = buildApp();
      const receiptRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/receipts")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ providerReference: "PAY-REC", amount: 500, settlementId: settlement.id });

      const receiptId = receiptRes.body.data.id;

      const reconcileRes = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/reconcile")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ settlementId: settlement.id, receiptId });

      expect(reconcileRes.status).toBe(200);
      expect(reconcileRes.body.data.reconciliationStatus).toBe("matched");
      expect(reconcileRes.body.data.discrepancyGold).toBe(0);
    });

    it("GET /companies/:companyId/rt2/payroll/reconciliation-report returns report", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/api/companies/" + companyId + "/rt2/payroll/reconciliation-report")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .query({ period: "2026-05" });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        companyId,
        period: "2026-05",
      });
      expect(Array.isArray(res.body.data.records)).toBe(true);
    });
  });

  describe("payroll run idempotency", () => {
    it("returns existing run if period already processed", async () => {
      const period = "2026-06";
      await insertPersonalPnL(companyId, "agent-idempotent", "agent", period, 2000);
      const app = buildApp();

      const first = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/run")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ period });

      const second = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/run")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ period });

      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.actorCount).toBe(first.body.data.actorCount);
    });
  });

  describe("fee calculation", () => {
    it("applies 10% platform fee and 5% operational fee correctly", async () => {
      const period = "2026-07";
      const grossIncome = 1000;
      await insertPersonalPnL(companyId, "agent-fee", "agent", period, grossIncome);
      const app = buildApp();

      const res = await request(app)
        .post("/api/companies/" + companyId + "/rt2/payroll/run")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin-user")
        .send({ period });

      expect(res.status).toBe(200);
      expect(res.body.data.totalGrossGold).toBe(grossIncome);
      expect(res.body.data.totalNetGold).toBe(850);
      expect(res.body.data.totalDeductions).toBe(150);
    });
  });
});
