import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, applyPendingMigrations, type Db } from "@paperclipai/db";
import { companies, costEvents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { dashboardService } from "../services/dashboard.js";

let db: Db;
let testCompanyIds: string[] = [];

beforeAll(async () => {
  db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/paperclip_test");
  await applyPendingMigrations(db);
});

afterAll(async () => {
  // Cleanup test data
  for (const companyId of testCompanyIds) {
    await db.delete(costEvents).where(eq(costEvents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  }
});

describe("dashboard service", () => {

  describe("budget utilization", () => {
    it("should return null utilization and budgetConfigured=false when budget is unset", async () => {
      // Insert company with zero budget
      const [company] = await db
        .insert(companies)
        .values({
          name: "Budget Unset Test Co",
          issuePrefix: "BUT",
          status: "active",
          budgetMonthlyCents: 0,
        })
        .returning();

      testCompanyIds.push(company.id);

      // Insert some cost events
      const now = new Date();
      await db.insert(costEvents).values({
        companyId: company.id,
        agentId: "agent-1",
        runId: "run-1",
        costCents: 500,
        occurredAt: now,
      });

      const svc = dashboardService(db);
      const result = await svc.summary(company.id);

      expect(result.costs.monthSpendCents).toBe(500);
      expect(result.costs.monthBudgetCents).toBe(0);
      expect(result.costs.monthUtilizationPercent).toBeNull();
      expect(result.costs.budgetConfigured).toBe(false);
    });

    it("should return calculated utilization and budgetConfigured=true when budget is set", async () => {
      // Insert company with budget
      const [company] = await db
        .insert(companies)
        .values({
          name: "Budget Set Test Co",
          issuePrefix: "BST",
          status: "active",
          budgetMonthlyCents: 10000, // $100 budget
        })
        .returning();

      testCompanyIds.push(company.id);

      // Insert some cost events (spend $25)
      const now = new Date();
      await db.insert(costEvents).values({
        companyId: company.id,
        agentId: "agent-1",
        runId: "run-1",
        costCents: 2500,
        occurredAt: now,
      });

      const svc = dashboardService(db);
      const result = await svc.summary(company.id);

      expect(result.costs.monthSpendCents).toBe(2500);
      expect(result.costs.monthBudgetCents).toBe(10000);
      expect(result.costs.monthUtilizationPercent).toBe(25);
      expect(result.costs.budgetConfigured).toBe(true);
    });

    it("should return 0% utilization when budget is set but no spend", async () => {
      // Insert company with budget
      const [company] = await db
        .insert(companies)
        .values({
          name: "Zero Spend Test Co",
          issuePrefix: "ZST",
          status: "active",
          budgetMonthlyCents: 10000,
        })
        .returning();

      testCompanyIds.push(company.id);

      // No cost events

      const svc = dashboardService(db);
      const result = await svc.summary(company.id);

      expect(result.costs.monthSpendCents).toBe(0);
      expect(result.costs.monthBudgetCents).toBe(10000);
      expect(result.costs.monthUtilizationPercent).toBe(0);
      expect(result.costs.budgetConfigured).toBe(true);
    });
  });
});
