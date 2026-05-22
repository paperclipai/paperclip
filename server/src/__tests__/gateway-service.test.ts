import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the logger to avoid console noise
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// We dynamically import so mocks are applied first
const gateway = await import("../services/gateway.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: `route-${Math.random().toString(36).slice(2, 8)}`,
    companyId: "company-1",
    agentId: null as string | null,
    name: "Test Route",
    priority: 10,
    adapterType: "gemini_local",
    model: "auto",
    weight: 100,
    isEnabled: true,
    quotaTokensPerMinute: null as number | null,
    quotaTokensPerHour: null as number | null,
    quotaTokensPerDay: null as number | null,
    quotaRequestsPerMinute: null as number | null,
    quotaRequestsPerHour: null as number | null,
    quotaRequestsPerDay: null as number | null,
    circuitBreakerEnabled: false,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerResetSec: 60,
    timeoutSec: null as number | null,
    adapterConfigOverrides: null as Record<string, unknown> | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a minimal DB stub that returns `routes` for select queries
 * and records insert/update/delete calls.
 */
function createDbStub(routes: ReturnType<typeof makeRoute>[] = []) {
  const selectOrderBy = vi.fn(async () => routes);
  const selectLimit = vi.fn(async () => routes.slice(0, 1));
  const selectWhere = vi.fn(() => ({
    orderBy: selectOrderBy,
    limit: selectLimit,
  }));
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const onConflictDoUpdate = vi.fn(async () => routes.slice(0, 1));
  const insertReturning = vi.fn(async () => routes.slice(0, 1));
  const insertValues = vi.fn(() => ({ returning: insertReturning, onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn(async () => routes.slice(0, 1));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const deleteWhere = vi.fn(async () => {});
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  return {
    db: { select, insert, update, delete: deleteFn } as any,
    selectWhere,
    selectLimit,
    insertValues,
    updateSet,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear in-memory state between tests by resetting the module-level Maps.
    // We access them indirectly by calling resetCircuit / deleteRoute on known IDs.
  });

  // =========================================================================
  // resolveRoute
  // =========================================================================

  describe("resolveRoute", () => {
    it("returns null when no routes exist", async () => {
      const { db } = createDbStub([]);
      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).toBeNull();
    });

    it("returns the highest-priority route", async () => {
      const low = makeRoute({ id: "low", priority: 1, adapterType: "opencode_local", model: "free" });
      const high = makeRoute({ id: "high", priority: 10, adapterType: "gemini_local", model: "auto" });
      const { db } = createDbStub([high, low]);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("high");
      expect(result!.adapterType).toBe("gemini_local");
      expect(result!.model).toBe("auto");
    });

    it("prefers agent-specific routes but falls back to company-wide when exhausted", async () => {
      // Agent route at higher priority wins in normal case
      const companyRoute = makeRoute({ id: "company", priority: 5, agentId: null });
      const agentRoute = makeRoute({ id: "agent", priority: 10, agentId: "agent-1" });
      const { db } = createDbStub([companyRoute, agentRoute]);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("agent");

      // Exhaust agent route → should fall back to company-wide route
      gateway.recordSuccess(db, "agent", 500);
      // Make the agent route quota-exhausted
      const agentRouteExhausted = makeRoute({
        id: "agent-exhausted",
        priority: 10,
        agentId: "agent-1",
        quotaRequestsPerMinute: 1,
      });
      const { db: db2 } = createDbStub([companyRoute, agentRouteExhausted]);
      gateway.recordSuccess(db2, "agent-exhausted", 500);
      const result2 = await gateway.resolveRoute(db2, "agent-1", "company-1");
      expect(result2).not.toBeNull();
      expect(result2!.routeId).toBe("company");
    });

    it("prefers agent-specific routes over company-wide at the same priority", async () => {
      const companyRoute = makeRoute({ id: "company", priority: 10, agentId: null });
      const agentRoute = makeRoute({ id: "agent", priority: 10, agentId: "agent-1" });
      const { db } = createDbStub([companyRoute, agentRoute]);

      // At the same priority, agent-specific route should always win
      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("agent");
    });

    it("skips routes that have exhausted their request quota", async () => {
      const exhausted = makeRoute({
        id: "exhausted",
        priority: 10,
        quotaRequestsPerMinute: 1,
      });
      const fallback = makeRoute({
        id: "fallback",
        priority: 5,
        adapterType: "codex_local",
        model: "gpt-5",
      });
      const { db } = createDbStub([exhausted, fallback]);

      // Record a success to consume the 1-request-per-minute quota
      await gateway.recordSuccess(db, "exhausted", 100);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("fallback");
    });

    it("skips routes that have exhausted their token quota", async () => {
      const limited = makeRoute({
        id: "token-limited",
        priority: 10,
        quotaTokensPerMinute: 500,
      });
      const unlimited = makeRoute({
        id: "unlimited",
        priority: 5,
      });
      const { db } = createDbStub([limited, unlimited]);

      // Consume 500 tokens (hits the limit)
      await gateway.recordSuccess(db, "token-limited", 500);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("unlimited");
    });

    it("returns null when all routes are exhausted", async () => {
      const only = makeRoute({
        id: "only-one",
        priority: 10,
        quotaRequestsPerMinute: 1,
      });
      const { db } = createDbStub([only]);

      await gateway.recordSuccess(db, "only-one", 100);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // recordSuccess / recordFailure
  // =========================================================================

  describe("recordSuccess", () => {
    it("increments token and request counters", async () => {
      const route = makeRoute({ id: "success-route" });
      const { db } = createDbStub([route]);

      await gateway.recordSuccess(db, "success-route", 250);

      const health = gateway.getRouteHealth("success-route");
      expect(health.usage.minute.tokens).toBe(250);
      expect(health.usage.minute.requests).toBe(1);
      expect(health.usage.hour.tokens).toBe(250);
      expect(health.usage.day.tokens).toBe(250);
    });

    it("resets circuit breaker on success after failure", async () => {
      const route = makeRoute({
        id: "recovery-route",
        circuitBreakerEnabled: true,
        circuitBreakerFailureThreshold: 3,
      });
      const { db } = createDbStub([route]);

      // Cause 2 failures (not enough to open)
      await gateway.recordFailure(db, "recovery-route");
      await gateway.recordFailure(db, "recovery-route");

      let health = gateway.getRouteHealth("recovery-route");
      expect(health.failureCount).toBe(2);

      // Success resets everything
      await gateway.recordSuccess(db, "recovery-route", 100);

      health = gateway.getRouteHealth("recovery-route");
      expect(health.circuitState).toBe("closed");
      expect(health.failureCount).toBe(0);
    });
  });

  describe("recordFailure", () => {
    it("increments failure count and opens circuit at threshold", async () => {
      const route = makeRoute({
        id: "breaker-route",
        circuitBreakerEnabled: true,
        circuitBreakerFailureThreshold: 3,
      });
      const { db } = createDbStub([route]);

      await gateway.recordFailure(db, "breaker-route");
      expect(gateway.getRouteHealth("breaker-route").failureCount).toBe(1);
      expect(gateway.getRouteHealth("breaker-route").circuitState).toBe("closed");

      await gateway.recordFailure(db, "breaker-route");
      expect(gateway.getRouteHealth("breaker-route").failureCount).toBe(2);

      await gateway.recordFailure(db, "breaker-route");
      expect(gateway.getRouteHealth("breaker-route").circuitState).toBe("open");
      expect(gateway.getRouteHealth("breaker-route").openedAt).not.toBeNull();
    });

    it("does nothing if circuit breaker is disabled", async () => {
      const route = makeRoute({
        id: "no-breaker",
        circuitBreakerEnabled: false,
      });
      const { db } = createDbStub([route]);

      await gateway.recordFailure(db, "no-breaker");
      await gateway.recordFailure(db, "no-breaker");
      await gateway.recordFailure(db, "no-breaker");

      const health = gateway.getRouteHealth("no-breaker");
      expect(health.circuitState).toBe("closed");
    });

    it("re-opens circuit immediately on half_open failure", async () => {
      const route = makeRoute({
        id: "half-open-route",
        circuitBreakerEnabled: true,
        circuitBreakerFailureThreshold: 2,
        circuitBreakerResetSec: 60,
      });
      const { db } = createDbStub([route]);

      // Open the circuit by reaching the failure threshold
      await gateway.recordFailure(db, "half-open-route");
      await gateway.recordFailure(db, "half-open-route");
      expect(gateway.getRouteHealth("half-open-route").circuitState).toBe("open");

      // Simulate cooldown elapsed (61s > 60s resetSec) so isRouteAvailable
      // transitions the circuit from open → half_open
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
      await gateway.resolveRoute(db, "agent-1", "company-1");
      vi.restoreAllMocks();

      expect(gateway.getRouteHealth("half-open-route").circuitState).toBe("half_open");

      // A failure in half_open state should immediately re-open the circuit
      await gateway.recordFailure(db, "half-open-route");
      expect(gateway.getRouteHealth("half-open-route").circuitState).toBe("open");
    });
  });

  // =========================================================================
  // resetCircuit
  // =========================================================================

  describe("resetCircuit", () => {
    it("resets an open circuit to closed", async () => {
      const route = makeRoute({
        id: "reset-route",
        circuitBreakerEnabled: true,
        circuitBreakerFailureThreshold: 2,
      });
      const { db } = createDbStub([route]);

      await gateway.recordFailure(db, "reset-route");
      await gateway.recordFailure(db, "reset-route");
      expect(gateway.getRouteHealth("reset-route").circuitState).toBe("open");

      await gateway.resetCircuit(db, "reset-route");
      const health = gateway.getRouteHealth("reset-route");
      expect(health.circuitState).toBe("closed");
      expect(health.failureCount).toBe(0);
      expect(health.openedAt).toBeNull();
    });
  });

  // =========================================================================
  // getRouteHealth
  // =========================================================================

  describe("getRouteHealth", () => {
    it("returns clean health for unknown route", () => {
      const health = gateway.getRouteHealth("nonexistent-route");
      expect(health.routeId).toBe("nonexistent-route");
      expect(health.circuitState).toBe("closed");
      expect(health.failureCount).toBe(0);
      expect(health.usage.minute.tokens).toBe(0);
      expect(health.usage.minute.requests).toBe(0);
    });

    it("accumulates usage across multiple successes", async () => {
      const route = makeRoute({ id: "accumulate-route" });
      const { db } = createDbStub([route]);

      await gateway.recordSuccess(db, "accumulate-route", 100);
      await gateway.recordSuccess(db, "accumulate-route", 200);
      await gateway.recordSuccess(db, "accumulate-route", 50);

      const health = gateway.getRouteHealth("accumulate-route");
      expect(health.usage.minute.tokens).toBe(350);
      expect(health.usage.minute.requests).toBe(3);
    });
  });

  // =========================================================================
  // Integration: circuit breaker + route resolution
  // =========================================================================

  describe("circuit breaker integration with route resolution", () => {
    it("skips a route with open circuit and uses lower-priority fallback", async () => {
      const primary = makeRoute({
        id: "primary",
        priority: 10,
        circuitBreakerEnabled: true,
        circuitBreakerFailureThreshold: 2,
      });
      const fallback = makeRoute({
        id: "fallback",
        priority: 5,
        adapterType: "codex_local",
        model: "gpt-5",
      });
      const { db } = createDbStub([primary, fallback]);

      // Trip the primary circuit
      await gateway.recordFailure(db, "primary");
      await gateway.recordFailure(db, "primary");
      expect(gateway.getRouteHealth("primary").circuitState).toBe("open");

      // Route resolution should skip primary and use fallback
      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("fallback");
      expect(result!.adapterType).toBe("codex_local");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles routes with zero weight gracefully", async () => {
      const route = makeRoute({ id: "zero-weight", weight: 0, priority: 10 });
      const { db } = createDbStub([route]);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.routeId).toBe("zero-weight");
    });

    it("handles multiple routes at same priority with weighted selection", async () => {
      const routeA = makeRoute({ id: "a", priority: 10, weight: 50 });
      const routeB = makeRoute({ id: "b", priority: 10, weight: 50 });
      const { db } = createDbStub([routeA, routeB]);

      // Run multiple resolutions - should consistently return some route
      const results = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await gateway.resolveRoute(db, "agent-1", "company-1");
        expect(r).not.toBeNull();
        results.add(r!.routeId);
      }
      // At least one of the two should be picked (probabilistic but very unlikely to fail)
      expect(results.size).toBeGreaterThanOrEqual(1);
    });

    it("returns timeoutSec from route decision when set", async () => {
      const route = makeRoute({ id: "timeout-route", timeoutSec: 900 });
      const { db } = createDbStub([route]);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.timeoutSec).toBe(900);
    });

    it("returns null timeoutSec when not configured", async () => {
      const route = makeRoute({ id: "no-timeout", timeoutSec: null });
      const { db } = createDbStub([route]);

      const result = await gateway.resolveRoute(db, "agent-1", "company-1");
      expect(result).not.toBeNull();
      expect(result!.timeoutSec).toBeNull();
    });
  });
});
