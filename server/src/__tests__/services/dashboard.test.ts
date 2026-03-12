import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { dashboardService } from "../../services/dashboard.js";
import { companies, agents, issues, approvals } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("dashboardService", () => {
  let testDb: TestDb;
  let companyId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({
        name: "Dash Co",
        issuePrefix: `D${randomUUID().slice(0, 4).toUpperCase()}`,
        budgetMonthlyCents: 10000,
      })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return dashboardService(testDb.db);
  }

  // ── summary ───────────────────────────────────────────────────────────

  describe("summary", () => {
    it("returns aggregated stats for a company", async () => {
      // Add agents
      await testDb.db.insert(agents).values({
        companyId,
        name: "Active Bot",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        status: "idle",
      });
      await testDb.db.insert(agents).values({
        companyId,
        name: "Paused Bot",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        status: "paused",
      });

      // Add issues (must get proper issueNumber/identifier)
      const issueService = (await import("../../services/issues.js")).issueService;
      const issueSvc = issueService(testDb.db);
      await issueSvc.create(companyId, { title: "Open", status: "todo" });
      await issueSvc.create(companyId, { title: "Done", status: "done" });

      // Add pending approval
      await testDb.db.insert(approvals).values({
        companyId,
        type: "general",
        status: "pending",
        payload: {},
      });

      const summary = await svc().summary(companyId);
      expect(summary.companyId).toBe(companyId);
      expect(summary.agents.active).toBe(1);
      expect(summary.agents.paused).toBe(1);
      expect(summary.tasks.open).toBeGreaterThanOrEqual(1);
      expect(summary.tasks.done).toBe(1);
      expect(summary.pendingApprovals).toBe(1);
      expect(summary.costs).toBeDefined();
    });
  });

  // ── negative ──────────────────────────────────────────────────────────

  describe("negative", () => {
    it("negative: throws when company not found", async () => {
      await expect(svc().summary(randomUUID())).rejects.toThrow(/not found/i);
    });
  });
});
