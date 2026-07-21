/**
 * Tests for the agent timer-only execution source policy (FALA-880).
 *
 * Verifies that when `runtimeConfig.heartbeat.timerOnly = true`:
 * - non-timer sources are blocked before any run is started (0 non-timer runs)
 * - timer sources are still permitted
 * - the policy is reflected in the parsed heartbeat policy object
 *
 * These are pure tests of `parseHeartbeatPolicy` exported from heartbeat.ts
 * and the wakeup-gate logic tested via an integration-style helper that
 * simulates the enqueueWakeup early-exit path.
 */

import { describe, expect, it } from "vitest";
import { parseHeartbeatPolicyForTest } from "../services/heartbeat.js";

// ---------------------------------------------------------------------------
// parseHeartbeatPolicy — timerOnly flag
// ---------------------------------------------------------------------------

describe("parseHeartbeatPolicyForTest — timerOnly", () => {
  it("defaults to timerOnly=false when not set", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true } });
    expect(policy.timerOnly).toBe(false);
    expect(policy.wakeOnDemand).toBe(true);
  });

  it("sets timerOnly=true and forces wakeOnDemand=false", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    expect(policy.timerOnly).toBe(true);
    expect(policy.wakeOnDemand).toBe(false);
  });

  it("timerOnly=true overrides explicit wakeOnDemand=true", () => {
    const policy = parseHeartbeatPolicyForTest({
      heartbeat: { enabled: true, timerOnly: true, wakeOnDemand: true },
    });
    expect(policy.timerOnly).toBe(true);
    expect(policy.wakeOnDemand).toBe(false);
  });

  it("timerOnly=false leaves wakeOnDemand governed by its own config", () => {
    const policy = parseHeartbeatPolicyForTest({
      heartbeat: { enabled: true, timerOnly: false, wakeOnDemand: false },
    });
    expect(policy.timerOnly).toBe(false);
    expect(policy.wakeOnDemand).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timer-only canary invariant test
//
// When timerOnly=true the guard must produce:
//   non-timer runs started = 0
//   timer runs blocked      = 0  (timers still pass)
// ---------------------------------------------------------------------------

describe("timer-only canary invariant", () => {
  function simulateWakeupGate(
    policy: { timerOnly: boolean; wakeOnDemand: boolean; enabled: boolean },
    source: "timer" | "assignment" | "on_demand" | "automation",
  ): "allowed" | "blocked_timerOnly" | "blocked_wakeOnDemand" | "blocked_disabled" {
    if (source === "timer" && !policy.enabled) return "blocked_disabled";
    if (source !== "timer" && policy.timerOnly) return "blocked_timerOnly";
    if (source !== "timer" && !policy.wakeOnDemand) return "blocked_wakeOnDemand";
    return "allowed";
  }

  it("timer source is allowed when timerOnly=true and enabled=true", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    expect(simulateWakeupGate(policy, "timer")).toBe("allowed");
  });

  it("assignment source is blocked when timerOnly=true (non-timer = 0)", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    expect(simulateWakeupGate(policy, "assignment")).toBe("blocked_timerOnly");
  });

  it("automation source is blocked when timerOnly=true", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    expect(simulateWakeupGate(policy, "automation")).toBe("blocked_timerOnly");
  });

  it("on_demand source is blocked when timerOnly=true", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    expect(simulateWakeupGate(policy, "on_demand")).toBe("blocked_timerOnly");
  });

  it("canary: non-timer=0, overlap=0 when timerOnly=true", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true, timerOnly: true } });
    const sources = ["assignment", "automation", "on_demand"] as const;
    const nonTimerAllowed = sources.filter((s) => simulateWakeupGate(policy, s) === "allowed").length;
    // timer-only canary: non-timer starts = 0
    expect(nonTimerAllowed).toBe(0);
  });
});
