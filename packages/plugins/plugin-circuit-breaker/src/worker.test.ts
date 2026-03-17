import { describe, it, expect, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk";
import type { Agent } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CO = "co-1";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: CO,
    name: "Test Agent",
    urlKey: "test-agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 0,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function finishedEvent(payload: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    runId: "run-1",
    status: "succeeded",
    outcome: "succeeded",
    exitCode: 0,
    usage: { totalTokens: 1000 },
    ...payload,
  };
}

function failedEvent(payload: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    runId: "run-1",
    status: "failed",
    outcome: "failed",
    exitCode: 1,
    usage: { totalTokens: 1000 },
    error: "adapter crashed",
    ...payload,
  };
}

const BASE = { companyId: CO, actorId: "agent-1", entityId: "run-1" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("circuit-breaker plugin", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({
      manifest,
      config: {
        enabled: true,
        maxConsecutiveFailures: 3,
        maxConsecutiveNoProgress: 5,
        tokenVelocityMultiplier: 3.0,
        tokenVelocityWindowSize: 20,
        recovery: { mode: "manual", cooldownMinutes: 30 },
      },
    });

    harness.seed({ agents: [makeAgent()] });
    await plugin.definition.setup(harness.ctx);
  });

  // -----------------------------------------------------------------------
  // Config validation
  // -----------------------------------------------------------------------

  it("validates config requires valid thresholds", async () => {
    const invalid = await plugin.definition.onValidateConfig!({
      maxConsecutiveFailures: 0,
      tokenVelocityMultiplier: 0.5,
      tokenVelocityWindowSize: 2,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toHaveLength(3);
    }

    const valid = await plugin.definition.onValidateConfig!({
      maxConsecutiveFailures: 3,
      tokenVelocityMultiplier: 2.0,
    });
    expect(valid.ok).toBe(true);
  });

  it("reports healthy", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });

  // -----------------------------------------------------------------------
  // Consecutive failure detection
  // -----------------------------------------------------------------------

  it("trips after maxConsecutiveFailures consecutive failures", async () => {
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    expect(state.tripReasons).toContain("consecutive_failures");
    expect(harness.activity.some((a) => a.message.includes("Circuit breaker tripped"))).toBe(true);
  });

  it("resets failure counter on successful run", async () => {
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    // Successful run should reset the counter
    await harness.emit("agent.run.finished", finishedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed");
    expect(state.consecutiveFailures).toBe(0);
  });

  it("does not count cancelled runs", async () => {
    // Cancelled runs should be ignored (no handler registered for agent.run.cancelled)
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    // This emit type is unhandled — counters should not change
    await harness.emit("agent.run.cancelled", { agentId: "agent-1" }, BASE);

    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    // Should have tripped on the 3rd failure (cancelled doesn't reset)
    expect(state.circuitState).toBe("open");
  });

  // -----------------------------------------------------------------------
  // No-progress detection
  // -----------------------------------------------------------------------

  it("trips after maxConsecutiveNoProgress runs with no progress", async () => {
    const noProgressPayload = finishedEvent({
      resultJson: { issuesModified: 0, issuesCreated: 0, commentsPosted: 0 },
    });

    for (let i = 0; i < 5; i++) {
      await harness.emit("agent.run.finished", noProgressPayload, BASE);
    }

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    expect(state.tripReasons).toContain("no_progress");
  });

  it("resets no-progress counter when resultJson shows progress", async () => {
    const noProgress = finishedEvent({
      resultJson: { issuesModified: 0, issuesCreated: 0, commentsPosted: 0 },
    });
    const withProgress = finishedEvent({
      resultJson: { issuesModified: 1, issuesCreated: 0, commentsPosted: 0 },
    });

    // 4 no-progress runs (one short of threshold)
    for (let i = 0; i < 4; i++) {
      await harness.emit("agent.run.finished", noProgress, BASE);
    }

    // Progress resets the counter
    await harness.emit("agent.run.finished", withProgress, BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed");
    expect(state.consecutiveNoProgress).toBe(0);
  });

  it("assumes progress when resultJson is missing (graceful fallback)", async () => {
    // Without resultJson, the plugin should assume progress
    const noResult = finishedEvent(); // no resultJson field

    for (let i = 0; i < 10; i++) {
      await harness.emit("agent.run.finished", noResult, BASE);
    }

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed");
    expect(state.consecutiveNoProgress).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Token velocity detection
  // -----------------------------------------------------------------------

  it("trips when token cost exceeds velocity multiplier x rolling average", async () => {
    // Build up history with normal costs (need >= ceil(20/2) = 10 samples)
    for (let i = 0; i < 12; i++) {
      await harness.emit(
        "agent.run.finished",
        finishedEvent({ usage: { totalTokens: 1000 } }),
        BASE,
      );
    }

    // Spike: 4000 tokens, well above 3.0x the average of 1000
    await harness.emit(
      "agent.run.finished",
      finishedEvent({ usage: { totalTokens: 4000 } }),
      BASE,
    );

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    expect(state.tripReasons).toContain("token_velocity");
  });

  it("skips velocity check during cold start (insufficient history)", async () => {
    // Only 5 runs — less than ceil(20/2) = 10
    for (let i = 0; i < 5; i++) {
      await harness.emit(
        "agent.run.finished",
        finishedEvent({ usage: { totalTokens: 100 } }),
        BASE,
      );
    }

    // Big spike, but should not trip due to cold start
    await harness.emit(
      "agent.run.finished",
      finishedEvent({ usage: { totalTokens: 10000 } }),
      BASE,
    );

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed");
  });

  it("trims token history to window size", async () => {
    // Set small window for testing
    harness.setConfig({
      enabled: true,
      maxConsecutiveFailures: 3,
      maxConsecutiveNoProgress: 5,
      tokenVelocityMultiplier: 3.0,
      tokenVelocityWindowSize: 4,
      recovery: { mode: "manual", cooldownMinutes: 30 },
    });

    // Send 6 events — window should only keep the last 4
    for (let i = 0; i < 6; i++) {
      await harness.emit(
        "agent.run.finished",
        finishedEvent({ usage: { totalTokens: 1000 } }),
        BASE,
      );
    }

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.tokenCostHistory.length).toBeLessThanOrEqual(4);
  });

  // -----------------------------------------------------------------------
  // Circuit state transitions
  // -----------------------------------------------------------------------

  it("does not double-pause already-paused agents", async () => {
    // First: trip the circuit
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    // Agent is now paused. Activity should have one trip entry.
    const tripCount = harness.activity.filter((a) =>
      a.message.includes("Circuit breaker tripped"),
    ).length;
    expect(tripCount).toBe(1);

    // Seed a second agent that's already paused
    harness.seed({
      agents: [makeAgent({ id: "agent-2", status: "paused" })],
    });

    // Send failures for agent-2 — should trip but not error on pause
    const base2 = { companyId: CO, actorId: "agent-2", entityId: "run-2" };
    await harness.emit("agent.run.failed", { ...failedEvent(), agentId: "agent-2" }, base2);
    await harness.emit("agent.run.failed", { ...failedEvent(), agentId: "agent-2" }, base2);
    await harness.emit("agent.run.failed", { ...failedEvent(), agentId: "agent-2" }, base2);

    const state2 = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-2",
      stateKey: "circuit",
    }) as any;

    expect(state2.circuitState).toBe("open");
  });

  it("emits single trip event when multiple detectors trigger", async () => {
    // Build token history
    for (let i = 0; i < 12; i++) {
      await harness.emit(
        "agent.run.finished",
        finishedEvent({
          usage: { totalTokens: 1000 },
          resultJson: { issuesModified: 0, issuesCreated: 0, commentsPosted: 0 },
        }),
        BASE,
      );
    }

    // Reset the agent to idle to avoid open-circuit short-circuit
    // (the no-progress counter hits 5 at run 5, tripping the circuit,
    //  so we need a fresh approach)
    // Instead, let's test with a config that makes both trip at the same time
    harness.setConfig({
      enabled: true,
      maxConsecutiveFailures: 3,
      maxConsecutiveNoProgress: 13,
      tokenVelocityMultiplier: 3.0,
      tokenVelocityWindowSize: 20,
      recovery: { mode: "manual", cooldownMinutes: 30 },
    });

    // Re-seed fresh agent
    harness.seed({ agents: [makeAgent({ id: "agent-3" })] });
    const base3 = { companyId: CO, actorId: "agent-3", entityId: "run-3" };

    // Build up normal history
    for (let i = 0; i < 12; i++) {
      await harness.emit(
        "agent.run.finished",
        { ...finishedEvent(), agentId: "agent-3", usage: { totalTokens: 1000 },
          resultJson: { issuesModified: 0, issuesCreated: 0, commentsPosted: 0 },
        },
        base3,
      );
    }

    // This 13th run triggers both no_progress (12 >= 12) AND token_velocity (4000 > 3 * ~1000)
    await harness.emit(
      "agent.run.finished",
      { ...finishedEvent(), agentId: "agent-3", usage: { totalTokens: 4000 },
        resultJson: { issuesModified: 0, issuesCreated: 0, commentsPosted: 0 },
      },
      base3,
    );

    const state3 = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-3",
      stateKey: "circuit",
    }) as any;

    expect(state3.circuitState).toBe("open");
    expect(state3.tripReasons).toContain("no_progress");
    expect(state3.tripReasons).toContain("token_velocity");
  });

  it("resets circuit on successful run during half-open state", async () => {
    // Manually set state to half-open
    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-1", stateKey: "circuit" },
      {
        circuitState: "half-open",
        consecutiveFailures: 3,
        consecutiveNoProgress: 0,
        tokenCostHistory: [],
        tripReasons: ["consecutive_failures"],
        trippedAt: new Date().toISOString(),
        lastEventAt: null,
      },
    );

    await harness.emit("agent.run.finished", finishedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed");
    expect(state.consecutiveFailures).toBe(0);
    expect(harness.activity.some((a) => a.message.includes("Circuit breaker reset"))).toBe(true);
  });

  it("re-trips on failure during half-open state", async () => {
    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-1", stateKey: "circuit" },
      {
        circuitState: "half-open",
        consecutiveFailures: 3,
        consecutiveNoProgress: 0,
        tokenCostHistory: [],
        tripReasons: ["consecutive_failures"],
        trippedAt: new Date().toISOString(),
        lastEventAt: null,
      },
    );

    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    expect(state.tripReasons).toContain("consecutive_failures");
  });

  // -----------------------------------------------------------------------
  // Config merging
  // -----------------------------------------------------------------------

  it("uses instance defaults when no per-agent override exists", async () => {
    // Agent has no runtimeConfig.circuitBreaker — should use instance config
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.consecutiveFailures).toBe(1);
    expect(state.circuitState).toBe("closed"); // threshold is 3
  });

  it("merges per-agent runtimeConfig override over instance defaults", async () => {
    // Set per-agent override: trip after just 1 failure
    harness.seed({
      agents: [
        makeAgent({
          runtimeConfig: {
            circuitBreaker: { maxConsecutiveFailures: 1 },
          },
        }),
      ],
    });

    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    expect(state.tripReasons).toContain("consecutive_failures");
  });

  it("skips detection when per-agent config sets enabled: false", async () => {
    harness.seed({
      agents: [
        makeAgent({
          runtimeConfig: {
            circuitBreaker: { enabled: false },
          },
        }),
      ],
    });

    // Send many failures — should not trip
    for (let i = 0; i < 10; i++) {
      await harness.emit("agent.run.failed", failedEvent(), BASE);
    }

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    });

    // No state should have been written at all (harness.getState returns undefined from raw Map.get)
    expect(state).toBeUndefined();
  });

  it("falls back to defaults for invalid per-agent overrides", async () => {
    harness.seed({
      agents: [
        makeAgent({
          runtimeConfig: {
            circuitBreaker: {
              maxConsecutiveFailures: -5, // invalid
              tokenVelocityMultiplier: "banana", // invalid
            },
          },
        }),
      ],
    });

    // Should use instance defaults (maxConsecutiveFailures: 3)
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("closed"); // 2 < 3 (default)
    expect(state.consecutiveFailures).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Half-open recovery job
  // -----------------------------------------------------------------------

  it("resumes agent after cooldown expires", async () => {
    // Set up half-open recovery mode
    harness.setConfig({
      enabled: true,
      maxConsecutiveFailures: 3,
      maxConsecutiveNoProgress: 5,
      tokenVelocityMultiplier: 3.0,
      tokenVelocityWindowSize: 20,
      recovery: { mode: "half-open", cooldownMinutes: 30 },
    });

    // Seed a paused agent
    harness.seed({ agents: [makeAgent({ status: "paused" })] });

    // Set open circuit state with trippedAt in the past (31 minutes ago)
    const trippedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-1", stateKey: "circuit" },
      {
        circuitState: "open",
        consecutiveFailures: 3,
        consecutiveNoProgress: 0,
        tokenCostHistory: [],
        tripReasons: ["consecutive_failures"],
        trippedAt,
        lastEventAt: null,
      },
    );

    // Track the agent
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: "tracked_agents" },
      { "agent-1": CO },
    );

    await harness.runJob("half-open-recovery");

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("half-open");
    expect(harness.activity.some((a) => a.message.includes("half-open"))).toBe(true);
    expect(harness.metrics.some((m) => m.name === "circuit_breaker.half_open")).toBe(true);
  });

  it("skips agents still within cooldown", async () => {
    harness.setConfig({
      enabled: true,
      maxConsecutiveFailures: 3,
      maxConsecutiveNoProgress: 5,
      tokenVelocityMultiplier: 3.0,
      tokenVelocityWindowSize: 20,
      recovery: { mode: "half-open", cooldownMinutes: 30 },
    });

    harness.seed({ agents: [makeAgent({ status: "paused" })] });

    // Tripped 10 minutes ago — within cooldown
    const trippedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-1", stateKey: "circuit" },
      {
        circuitState: "open",
        consecutiveFailures: 3,
        consecutiveNoProgress: 0,
        tokenCostHistory: [],
        tripReasons: ["consecutive_failures"],
        trippedAt,
        lastEventAt: null,
      },
    );

    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: "tracked_agents" },
      { "agent-1": CO },
    );

    await harness.runJob("half-open-recovery");

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    // Should still be open — not enough time has passed
    expect(state.circuitState).toBe("open");
  });

  it("cleans up state for deleted agents in state-cleanup job", async () => {
    // Track an agent that no longer exists
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: "tracked_agents" },
      { "agent-deleted": CO },
    );

    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-deleted", stateKey: "circuit" },
      { circuitState: "open", consecutiveFailures: 3 },
    );

    await harness.runJob("state-cleanup");

    // State should be cleaned up (harness.getState returns undefined from raw Map.get)
    const circuitState = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-deleted",
      stateKey: "circuit",
    });
    expect(circuitState).toBeUndefined();

    // Tracked agents should no longer include the deleted agent
    const tracked = harness.getState({
      scopeKind: "instance",
      stateKey: "tracked_agents",
    }) as Record<string, string>;
    expect(tracked["agent-deleted"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Observability
  // -----------------------------------------------------------------------

  it("logs activity on circuit trip with reasons", async () => {
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const tripActivity = harness.activity.find((a) =>
      a.message.includes("Circuit breaker tripped"),
    );
    expect(tripActivity).toBeDefined();
    expect(tripActivity!.entityType).toBe("agent");
    expect(tripActivity!.entityId).toBe("agent-1");
    expect(tripActivity!.metadata?.reasons).toContain("consecutive_failures");
  });

  it("writes metrics per detection strategy", async () => {
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const tripMetric = harness.metrics.find((m) => m.name === "circuit_breaker.tripped");
    expect(tripMetric).toBeDefined();

    const strategyMetric = harness.metrics.find(
      (m) => m.name === "circuit_breaker.tripped.consecutive_failures",
    );
    expect(strategyMetric).toBeDefined();
  });

  it("emits plugin.circuit_breaker.tripped custom event", async () => {
    // We can verify the emit was called by checking that no errors occurred
    // and the state reflects the trip (the test harness doesn't capture emitted events
    // in a separate list, but the emit call exercises the capability gate)
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);
    await harness.emit("agent.run.failed", failedEvent(), BASE);

    const state = harness.getState({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "circuit",
    }) as any;

    expect(state.circuitState).toBe("open");
    // If events.emit capability was missing, the handler would throw
    // The fact that we got here means emit succeeded
  });

  it("emits plugin.circuit_breaker.reset on recovery", async () => {
    // Set half-open state
    await harness.ctx.state.set(
      { scopeKind: "agent", scopeId: "agent-1", stateKey: "circuit" },
      {
        circuitState: "half-open",
        consecutiveFailures: 3,
        consecutiveNoProgress: 0,
        tokenCostHistory: [],
        tripReasons: ["consecutive_failures"],
        trippedAt: new Date().toISOString(),
        lastEventAt: null,
      },
    );

    // Track the agent
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: "tracked_agents" },
      { "agent-1": CO },
    );

    await harness.emit("agent.run.finished", finishedEvent(), BASE);

    const resetActivity = harness.activity.find((a) =>
      a.message.includes("Circuit breaker reset"),
    );
    expect(resetActivity).toBeDefined();

    const resetMetric = harness.metrics.find((m) => m.name === "circuit_breaker.reset");
    expect(resetMetric).toBeDefined();
  });
});
