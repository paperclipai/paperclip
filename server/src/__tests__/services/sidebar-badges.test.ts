import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { sidebarBadgeService } from "../../services/sidebar-badges.js";
import { agents, approvals, companies, heartbeatRuns } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("sidebarBadgeService", () => {
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
      .values({ name: "Badge Co", issuePrefix: `B${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return sidebarBadgeService(testDb.db);
  }

  describe("get", () => {
    it("returns zero counts for empty company", async () => {
      const badges = await svc().get(companyId);
      expect(badges.approvals).toBe(0);
      expect(badges.failedRuns).toBe(0);
      expect(badges.joinRequests).toBe(0);
      expect(badges.inbox).toBe(0);
    });

    it("counts pending approvals", async () => {
      await testDb.db.insert(approvals).values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        requestedByAgentId: null,
        requestedByUserId: null,
      });
      await testDb.db.insert(approvals).values({
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
        requestedByUserId: null,
      });

      const badges = await svc().get(companyId);
      expect(badges.approvals).toBe(1);
    });

    it("counts revision_requested approvals as actionable", async () => {
      await testDb.db.insert(approvals).values({
        companyId,
        type: "hire_agent",
        status: "revision_requested",
        payload: {},
        requestedByAgentId: null,
        requestedByUserId: null,
      });

      const badges = await svc().get(companyId);
      expect(badges.approvals).toBe(1);
    });

    it("counts failed heartbeat runs", async () => {
      const [ag] = await testDb.db
        .insert(agents)
        .values({
          companyId,
          name: "Test Agent",
          role: "general",
          adapterType: "process",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        })
        .returning();

      await testDb.db.insert(heartbeatRuns).values({
        companyId,
        agentId: ag.id,
        status: "failed",
        invocationSource: "timer",
      });

      const badges = await svc().get(companyId);
      expect(badges.failedRuns).toBe(1);
    });

    it("does not count runs from terminated agents", async () => {
      const [ag] = await testDb.db
        .insert(agents)
        .values({
          companyId,
          name: "Terminated Agent",
          role: "general",
          adapterType: "process",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "terminated",
        })
        .returning();

      await testDb.db.insert(heartbeatRuns).values({
        companyId,
        agentId: ag.id,
        status: "failed",
        invocationSource: "timer",
      });

      const badges = await svc().get(companyId);
      expect(badges.failedRuns).toBe(0);
    });

    it("aggregates inbox from all sources including extras", async () => {
      await testDb.db.insert(approvals).values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        requestedByAgentId: null,
        requestedByUserId: null,
      });

      const badges = await svc().get(companyId, {
        joinRequests: 3,
        unreadTouchedIssues: 2,
      });
      expect(badges.inbox).toBe(1 + 0 + 3 + 2); // 1 approval + 0 failed + 3 join + 2 unread
      expect(badges.joinRequests).toBe(3);
    });

    it("only counts latest run per agent for failed status", async () => {
      const [ag] = await testDb.db
        .insert(agents)
        .values({
          companyId,
          name: "Multi-run Agent",
          role: "general",
          adapterType: "process",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        })
        .returning();

      // Insert older failed run
      await testDb.db.insert(heartbeatRuns).values({
        companyId,
        agentId: ag.id,
        status: "failed",
        invocationSource: "timer",
        createdAt: new Date("2020-01-01"),
      });
      // Insert newer completed run
      await testDb.db.insert(heartbeatRuns).values({
        companyId,
        agentId: ag.id,
        status: "completed",
        invocationSource: "timer",
        createdAt: new Date("2025-01-01"),
      });

      const badges = await svc().get(companyId);
      // Only latest run (completed) should be considered, so 0 failed
      expect(badges.failedRuns).toBe(0);
    });
  });
});
