import { describe, expect, it } from "vitest";
import {
  parseCircuitBreakerConfig,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../services/circuit-breaker.js";

function fakeAgent(runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "test-agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

describe("circuit-breaker", () => {
  describe("DEFAULT_CIRCUIT_BREAKER_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures).toBe(5);
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveNoProgress).toBe(8);
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.lookbackRuns).toBe(10);
    });
  });

  describe("parseCircuitBreakerConfig", () => {
    it("returns enabled with defaults when no runtimeConfig", () => {
      const config = parseCircuitBreakerConfig(fakeAgent());
      expect(config.enabled).toBe(true);
      expect(config.maxConsecutiveFailures).toBe(5);
      expect(config.maxConsecutiveNoProgress).toBe(8);
      expect(config.lookbackRuns).toBe(10);
    });

    it("returns enabled with defaults when runtimeConfig has no circuitBreaker", () => {
      const config = parseCircuitBreakerConfig(fakeAgent({ foo: "bar" }));
      expect(config.enabled).toBe(true);
      expect(config.maxConsecutiveFailures).toBe(5);
    });

    it("returns disabled when circuitBreaker.enabled is false", () => {
      const config = parseCircuitBreakerConfig(
        fakeAgent({ circuitBreaker: { enabled: false } }),
      );
      expect(config.enabled).toBe(false);
    });

    it("respects custom thresholds", () => {
      const config = parseCircuitBreakerConfig(
        fakeAgent({
          circuitBreaker: {
            maxConsecutiveFailures: 3,
            maxConsecutiveNoProgress: 5,
            lookbackRuns: 20,
          },
        }),
      );
      expect(config.enabled).toBe(true);
      expect(config.maxConsecutiveFailures).toBe(3);
      expect(config.maxConsecutiveNoProgress).toBe(5);
      expect(config.lookbackRuns).toBe(20);
    });

    it("falls back to defaults for non-numeric values", () => {
      const config = parseCircuitBreakerConfig(
        fakeAgent({
          circuitBreaker: {
            maxConsecutiveFailures: "not a number",
            maxConsecutiveNoProgress: null,
          },
        }),
      );
      expect(config.maxConsecutiveFailures).toBe(5);
      expect(config.maxConsecutiveNoProgress).toBe(8);
    });

    it("uses default lookbackRuns when not specified", () => {
      const config = parseCircuitBreakerConfig(
        fakeAgent({ circuitBreaker: { maxConsecutiveFailures: 2 } }),
      );
      expect(config.lookbackRuns).toBe(10);
    });
  });
});
