import { describe, expect, it } from "vitest";
import { heartbeatService } from "./heartbeat.js";

// Helper to build a minimal agent fixture for parseHeartbeatPolicy testing.
function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-agent-id",
    companyId: "test-company-id",
    name: "Test Agent",
    status: "active",
    role: "worker",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    maxConcurrentRuns: null,
    maxTurns: null,
    maxTurnDurationSec: null,
    maxHeartbeatDurationSec: null,
    budgetLimitCents: null,
    budgetWindowStart: null,
    budgetSpendCents: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastHeartbeatAt: null,
    lastRunAt: null,
    lastStatusChangeAt: new Date(),
    ...overrides,
  };
}

describe("parseHeartbeatPolicy", () => {
  const mockDb = {} as any;

  it("defaults maxConcurrentRuns to 1 for timer heartbeats (intervalSec > 0)", () => {
    const svc = heartbeatService(mockDb);
    const agent = makeAgent({
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60 },
      },
    });
    const policy = svc.parseHeartbeatPolicy(agent as any);
    expect(policy.enabled).toBe(true);
    expect(policy.intervalSec).toBe(60);
    expect(policy.maxConcurrentRuns).toBe(1);
  });

  it("defaults maxConcurrentRuns to 20 for on-demand heartbeats (intervalSec = 0)", () => {
    const svc = heartbeatService(mockDb);
    const agent = makeAgent({
      runtimeConfig: {
        heartbeat: { enabled: true },
      },
    });
    const policy = svc.parseHeartbeatPolicy(agent as any);
    expect(policy.enabled).toBe(true);
    expect(policy.intervalSec).toBe(0);
    expect(policy.maxConcurrentRuns).toBe(20);
  });

  it("respects explicit maxConcurrentRuns for timer heartbeats", () => {
    const svc = heartbeatService(mockDb);
    const agent = makeAgent({
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 30, maxConcurrentRuns: 5 },
      },
    });
    const policy = svc.parseHeartbeatPolicy(agent as any);
    expect(policy.maxConcurrentRuns).toBe(5);
  });

  it("respects explicit maxConcurrentRuns for on-demand heartbeats", () => {
    const svc = heartbeatService(mockDb);
    const agent = makeAgent({
      runtimeConfig: {
        heartbeat: { enabled: true, maxConcurrentRuns: 3 },
      },
    });
    const policy = svc.parseHeartbeatPolicy(agent as any);
    expect(policy.maxConcurrentRuns).toBe(3);
  });
});
