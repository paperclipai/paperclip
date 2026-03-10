import { describe, expect, it, beforeEach } from "vitest";
import { parseCircuitBreakerConfig } from "../services/circuit-breaker.js";

describe("parseCircuitBreakerConfig", () => {
  it("returns defaults when no config is set", () => {
    const agent = makeAgent({});
    const config = parseCircuitBreakerConfig(agent);
    expect(config).toEqual({
      enabled: true,
      maxConsecutiveFailures: 3,
      maxConsecutiveNoProgress: 5,
      tokenVelocityMultiplier: 3.0,
    });
  });

  it("respects explicit config values", () => {
    const agent = makeAgent({
      runtimeConfig: {
        circuitBreaker: {
          enabled: false,
          maxConsecutiveFailures: 5,
          maxConsecutiveNoProgress: 10,
          tokenVelocityMultiplier: 5.0,
        },
      },
    });
    const config = parseCircuitBreakerConfig(agent);
    expect(config).toEqual({
      enabled: false,
      maxConsecutiveFailures: 5,
      maxConsecutiveNoProgress: 10,
      tokenVelocityMultiplier: 5.0,
    });
  });

  it("clamps minimum values", () => {
    const agent = makeAgent({
      runtimeConfig: {
        circuitBreaker: {
          maxConsecutiveFailures: 0,
          maxConsecutiveNoProgress: -1,
          tokenVelocityMultiplier: 1.0,
        },
      },
    });
    const config = parseCircuitBreakerConfig(agent);
    expect(config.maxConsecutiveFailures).toBe(1);
    expect(config.maxConsecutiveNoProgress).toBe(1);
    expect(config.tokenVelocityMultiplier).toBe(1.5);
  });

  it("handles malformed runtimeConfig gracefully", () => {
    const agent = makeAgent({ runtimeConfig: "not-an-object" as unknown });
    const config = parseCircuitBreakerConfig(agent);
    expect(config.enabled).toBe(true);
    expect(config.maxConsecutiveFailures).toBe(3);
  });

  it("handles null circuitBreaker key", () => {
    const agent = makeAgent({ runtimeConfig: { circuitBreaker: null } });
    const config = parseCircuitBreakerConfig(agent);
    expect(config.enabled).toBe(true);
  });
});

function makeAgent(overrides: Record<string, unknown>) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Test Agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Parameters<typeof parseCircuitBreakerConfig>[0];
}
