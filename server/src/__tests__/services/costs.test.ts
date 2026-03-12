import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { costService } from "../../services/costs.js";
import { companies, agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

describe("costService", () => {
  let testDb: TestDb;
  let companyId: string;
  let agentId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({
        name: "Cost Co",
        issuePrefix: `C${randomUUID().slice(0, 4).toUpperCase()}`,
        budgetMonthlyCents: 100000,
      })
      .returning();
    companyId = co.id;
    const [ag] = await testDb.db
      .insert(agents)
      .values({
        companyId,
        name: "Cost Agent",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 50000,
        spentMonthlyCents: 0,
        status: "idle",
      })
      .returning();
    agentId = ag.id;
  });

  function svc() {
    return costService(testDb.db);
  }

  // ── createEvent ───────────────────────────────────────────────────────

  describe("createEvent", () => {
    it("records a cost event and updates agent spend", async () => {
      const event = await svc().createEvent(companyId, {
        agentId,
        costCents: 500,
        inputTokens: 1000,
        outputTokens: 200,
        provider: "anthropic",
        model: "test-model",
        occurredAt: new Date(),
      });
      expect(event).toBeDefined();
      expect(event.costCents).toBe(500);
    });
  });

  // ── summary ───────────────────────────────────────────────────────────

  describe("summary", () => {
    it("aggregates company cost summary", async () => {
      await svc().createEvent(companyId, {
        agentId,
        costCents: 300,
        inputTokens: 100,
        outputTokens: 50,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      await svc().createEvent(companyId, {
        agentId,
        costCents: 200,
        inputTokens: 100,
        outputTokens: 50,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });

      const summary = await svc().summary(companyId);
      expect(summary.spendCents).toBe(500);
      expect(summary.budgetCents).toBe(100000);
      expect(summary.utilizationPercent).toBeCloseTo(0.5, 1);
    });
  });

  // ── byAgent ───────────────────────────────────────────────────────────

  describe("byAgent", () => {
    it("groups costs by agent", async () => {
      await svc().createEvent(companyId, {
        agentId,
        costCents: 100,
        inputTokens: 50,
        outputTokens: 25,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const breakdown = await svc().byAgent(companyId);
      expect(breakdown.length).toBe(1);
      expect(breakdown[0].agentId).toBe(agentId);
      expect(breakdown[0].costCents).toBe(100);
    });
  });

  // ── createEvent: budget auto-pause ─────────────────────────────────

  describe("createEvent: budget auto-pause", () => {
    it("pauses agent when budget exceeded", async () => {
      // Agent has budgetMonthlyCents=50000, so spending 50000 should trigger pause
      await svc().createEvent(companyId, {
        agentId,
        costCents: 50000,
        inputTokens: 1000,
        outputTokens: 200,
        provider: "anthropic",
        model: "test-model",
        occurredAt: new Date(),
      });
      // Check the agent was paused
      const [updatedAgent] = await testDb.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(updatedAgent.status).toBe("paused");
    });

    it("does not pause agent with zero budget", async () => {
      const [zeroBudgetAgent] = await testDb.db
        .insert(agents)
        .values({
          companyId,
          name: "Zero Budget Agent",
          role: "general",
          adapterType: "process",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        })
        .returning();

      await svc().createEvent(companyId, {
        agentId: zeroBudgetAgent.id,
        costCents: 100,
        inputTokens: 50,
        outputTokens: 25,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const [updatedAgent] = await testDb.db
        .select()
        .from(agents)
        .where(eq(agents.id, zeroBudgetAgent.id));
      expect(updatedAgent.status).toBe("idle");
    });

    it("does not pause already-paused agent", async () => {
      await testDb.db
        .update(agents)
        .set({ status: "paused" })
        .where(eq(agents.id, agentId));

      await svc().createEvent(companyId, {
        agentId,
        costCents: 50000,
        inputTokens: 100,
        outputTokens: 50,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const [updatedAgent] = await testDb.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(updatedAgent.status).toBe("paused");
    });

    it("does not pause terminated agent", async () => {
      await testDb.db
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));

      await svc().createEvent(companyId, {
        agentId,
        costCents: 50000,
        inputTokens: 100,
        outputTokens: 50,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const [updatedAgent] = await testDb.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(updatedAgent.status).toBe("terminated");
    });
  });

  // ── createEvent: agent-company mismatch ───────────────────────────

  describe("createEvent: agent-company mismatch", () => {
    it("throws when agent belongs to a different company", async () => {
      const [otherCo] = await testDb.db
        .insert(companies)
        .values({
          name: "Other Co",
          issuePrefix: `O${randomUUID().slice(0, 4).toUpperCase()}`,
        })
        .returning();
      await expect(
        svc().createEvent(otherCo.id, {
          agentId,
          costCents: 100,
          inputTokens: 0,
          outputTokens: 0,
          provider: "anthropic",
          model: "m1",
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/does not belong/i);
    });
  });

  // ── summary: date range and edge cases ────────────────────────────

  describe("summary: edge cases", () => {
    it("returns 0 utilization when company has zero budget", async () => {
      const [zeroBudgetCo] = await testDb.db
        .insert(companies)
        .values({
          name: "Zero Budget Co",
          issuePrefix: `Z${randomUUID().slice(0, 4).toUpperCase()}`,
          budgetMonthlyCents: 0,
        })
        .returning();
      const summary = await svc().summary(zeroBudgetCo.id);
      expect(summary.utilizationPercent).toBe(0);
      expect(summary.budgetCents).toBe(0);
    });

    it("filters by date range", async () => {
      const past = new Date("2020-01-01");
      const future = new Date("2099-01-01");
      await svc().createEvent(companyId, {
        agentId,
        costCents: 100,
        inputTokens: 10,
        outputTokens: 5,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const ranged = await svc().summary(companyId, { from: past, to: future });
      expect(ranged.spendCents).toBe(100);

      const empty = await svc().summary(companyId, { from: future });
      expect(empty.spendCents).toBe(0);
    });
  });

  // ── byAgent: date range ───────────────────────────────────────────

  describe("byAgent: date range", () => {
    it("filters by date range", async () => {
      await svc().createEvent(companyId, {
        agentId,
        costCents: 200,
        inputTokens: 50,
        outputTokens: 25,
        provider: "anthropic",
        model: "m1",
        occurredAt: new Date(),
      });
      const future = new Date("2099-01-01");
      const breakdown = await svc().byAgent(companyId, { from: future });
      expect(breakdown.length).toBe(0);
    });
  });

  // ── negative ──────────────────────────────────────────────────────────

  describe("negative", () => {
    it("negative: throws when agent not found", async () => {
      await expect(
        svc().createEvent(companyId, {
          agentId: randomUUID(),
          costCents: 100,
          inputTokens: 0,
          outputTokens: 0,
          provider: "anthropic",
          model: "m1",
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("negative: throws when company not found for summary", async () => {
      await expect(svc().summary(randomUUID())).rejects.toThrow(/not found/i);
    });
  });
});
