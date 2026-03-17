import { beforeEach, describe, expect, it, vi } from "vitest";
import { circuitBreakerService, type CircuitBreakerConfig } from "../services/circuitBreaker";

type DbStub = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function createDbStub(
  recentRuns: unknown[],
  agent: unknown,
): { db: DbStub; selectWhere: ReturnType<typeof vi.fn>; insertValues: ReturnType<typeof vi.fn> } {
  const selectWhere = vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(() => recentRuns) })) }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const insertValues = vi.fn(() => ({ returning: vi.fn(async () => [{}]) }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [agent]) })) }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    db: { select, insert, update } as any,
    selectWhere,
    insertValues,
  };
}

describe("Circuit Breaker Service", () => {
  let mockDb: ReturnType<typeof createDbStub>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const config: CircuitBreakerConfig = {
    enabled: true,
    maxConsecutiveNoProgress: 5,
    maxConsecutiveFailures: 3,
    tokenVelocityMultiplier: 3.0,
  };

  describe("getCircuitBreakerState", () => {
    it("should not trip with healthy runs", async () => {
      const recentRuns = [
        { id: "run-1", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
        { id: "run-2", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1100 } },
        { id: "run-3", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 900 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const state = await svc.getCircuitBreakerState("agent-1", config);

      expect(state.consecutiveFailures).toBe(0);
      expect(state.consecutiveNoProgress).toBe(0);
      expect(state.rollingAvgInputTokens).toBeCloseTo(1000, 0);
      expect(state.tokenVelocityExceeded).toBe(false);
      expect(state.isTripped).toBe(false);
    });

    it("should detect consecutive failures", async () => {
      const recentRuns = [
        { id: "run-1", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-2", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-3", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-4", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const state = await svc.getCircuitBreakerState("agent-1", config);

      expect(state.consecutiveFailures).toBe(3);
      expect(state.consecutiveNoProgress).toBe(3);
      expect(state.isTripped).toBe(true);
    });

    it("should detect consecutive no-progress runs", async () => {
      const recentRuns = [
        { id: "run-1", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-2", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-3", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-4", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-5", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-6", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const state = await svc.getCircuitBreakerState("agent-1", config);

      expect(state.consecutiveFailures).toBe(0);
      expect(state.consecutiveNoProgress).toBe(5);
      expect(state.isTripped).toBe(true);
    });

    it("should detect token velocity spike when latest run significantly exceeds average", async () => {
      const recentRuns = [
        { id: "run-4", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 10000 } },
        { id: "run-3", status: "succeeded", finishedAt: new Date(Date.now() - 1000), usageJson: { inputTokens: 900 } },
        { id: "run-2", status: "succeeded", finishedAt: new Date(Date.now() - 2000), usageJson: { inputTokens: 1100 } },
        { id: "run-1", status: "succeeded", finishedAt: new Date(Date.now() - 3000), usageJson: { inputTokens: 1000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const state = await svc.getCircuitBreakerState("agent-1", config);

      expect(state.rollingAvgInputTokens).toBeCloseTo(3250, 0);
      expect(state.tokenVelocityExceeded).toBe(true);
    });

    it("should not trip when disabled", async () => {
      const recentRuns = [
        { id: "run-1", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-2", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-3", status: "failed", finishedAt: new Date(), usageJson: null },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const state = await svc.getCircuitBreakerState("agent-1", { ...config, enabled: false });

      expect(state.consecutiveFailures).toBe(3);
      expect(state.isTripped).toBe(false);
    });
  });

  describe("checkAgentRunHealth", () => {
    it("should pause agent on consecutive failures", async () => {
      const recentRuns = [
        { id: "run-1", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-2", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-3", status: "failed", finishedAt: new Date(), usageJson: null },
        { id: "run-4", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const result = await svc.checkAgentRunHealth("agent-1", "company-1", config);

      expect(result.shouldPause).toBe(true);
      expect(result.reason).toContain("consecutive failures");
      expect(mockDb.db.insert).toHaveBeenCalled();
      expect(mockDb.db.update).toHaveBeenCalled();
    });

    it("should pause agent on consecutive no-progress", async () => {
      const recentRuns = [
        { id: "run-1", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-2", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-3", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-4", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-5", status: "cancelled", finishedAt: new Date(), usageJson: null },
        { id: "run-6", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const result = await svc.checkAgentRunHealth("agent-1", "company-1", config);

      expect(result.shouldPause).toBe(true);
      expect(result.reason).toContain("no progress");
      expect(mockDb.db.insert).toHaveBeenCalled();
      expect(mockDb.db.update).toHaveBeenCalled();
    });

    it("should not pause healthy agent", async () => {
      const recentRuns = [
        { id: "run-1", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
        { id: "run-2", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1100 } },
        { id: "run-3", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 900 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const result = await svc.checkAgentRunHealth("agent-1", "company-1", config);

      expect(result.shouldPause).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(mockDb.db.update).not.toHaveBeenCalled();
    });

    it("should log token velocity warning", async () => {
      const recentRuns = [
        { id: "run-1", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1000 } },
        { id: "run-2", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 1100 } },
        { id: "run-3", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 900 } },
        { id: "run-4", status: "succeeded", finishedAt: new Date(), usageJson: { inputTokens: 5000 } },
      ];

      mockDb = createDbStub(recentRuns, {});

      const svc = circuitBreakerService(mockDb.db as any);
      const result = await svc.checkAgentRunHealth("agent-1", "company-1", config);

      expect(result.shouldPause).toBe(false);
      expect(mockDb.db.update).not.toHaveBeenCalled();
    });
  });
});
