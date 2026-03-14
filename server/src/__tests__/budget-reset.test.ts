import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resetMonthlyBudgetCounters,
  checkAndResetIfNewMonth,
  _setLastResetMonthForTesting,
} from "../services/budget-reset.js";

// Mock activity-log so we don't need a real DB for publish side-effects
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// Mock live-events (imported transitively via activity-log in production;
// the vi.mock above covers that, but guard against any direct import)
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

/**
 * Build a minimal Drizzle-like mock db that records calls and returns
 * controllable results for update().set().returning().
 */
function makeDb(
  agentRows: { id: string }[] = [{ id: "agent-1" }, { id: "agent-2" }],
  companyRows: { id: string }[] = [{ id: "company-1" }],
) {
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      returning: vi.fn()
        .mockResolvedValueOnce(agentRows)   // first update call -> agents
        .mockResolvedValueOnce(companyRows), // second update call -> companies
    }),
  });
  return { update: updateMock } as any;
}

describe("budget-reset", () => {
  beforeEach(() => {
    // Reset module-level state before each test
    _setLastResetMonthForTesting(null);
    vi.clearAllMocks();
  });

  describe("resetMonthlyBudgetCounters", () => {
    it("sets spentMonthlyCents to 0 for all agents and companies and returns counts", async () => {
      const db = makeDb([{ id: "a1" }, { id: "a2" }], [{ id: "c1" }]);
      const result = await resetMonthlyBudgetCounters(db);
      expect(result.agentsReset).toBe(2);
      expect(result.companiesReset).toBe(1);
    });

    it("returns zero counts when no agents or companies exist", async () => {
      const db = makeDb([], []);
      const result = await resetMonthlyBudgetCounters(db);
      expect(result.agentsReset).toBe(0);
      expect(result.companiesReset).toBe(0);
    });

    it("calls db.update twice (once for agents, once for companies)", async () => {
      const db = makeDb();
      await resetMonthlyBudgetCounters(db);
      expect(db.update).toHaveBeenCalledTimes(2);
    });
  });

  describe("checkAndResetIfNewMonth", () => {
    it("does NOT reset on first call — initialises lastResetMonth to current month", async () => {
      const db = makeDb();
      const result = await checkAndResetIfNewMonth(db);
      expect(result.reset).toBe(false);
      // update should NOT have been called (no reset happened)
      expect(db.update).not.toHaveBeenCalled();
    });

    it("does NOT reset when called again in the same month", async () => {
      const now = new Date();
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      _setLastResetMonthForTesting(month);
      const db = makeDb();
      const result = await checkAndResetIfNewMonth(db);
      expect(result.reset).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("resets when the month has changed", async () => {
      // Force lastResetMonth to a past month
      _setLastResetMonthForTesting("2025-01");
      const db = makeDb();
      const result = await checkAndResetIfNewMonth(db);
      expect(result.reset).toBe(true);
      // db.update called twice (agents + companies)
      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it("returns the current month string in YYYY-MM format", async () => {
      _setLastResetMonthForTesting("2025-01");
      const db = makeDb();
      const result = await checkAndResetIfNewMonth(db);
      expect(result.month).toMatch(/^\d{4}-\d{2}$/);
    });

    it("is idempotent — calling twice in same month only resets once", async () => {
      _setLastResetMonthForTesting("2025-01");
      const db1 = makeDb();
      const first = await checkAndResetIfNewMonth(db1);
      expect(first.reset).toBe(true);

      // Second call — lastResetMonth is now current month, so no reset
      const db2 = makeDb();
      const second = await checkAndResetIfNewMonth(db2);
      expect(second.reset).toBe(false);
      expect(db2.update).not.toHaveBeenCalled();
    });
  });
});
