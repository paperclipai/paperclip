import { describe, expect, it } from "vitest";
import {
  computeHeartbeatCooldownEligibleAt,
  isHeartbeatCooldownThrottledSource,
  parseHeartbeatCooldownPolicy,
  shouldBypassHeartbeatCooldown,
} from "../services/heartbeat-cooldown.js";

describe("heartbeat-cooldown policy", () => {
  it("parses cooldownSec from runtime config", () => {
    expect(
      parseHeartbeatCooldownPolicy({
        heartbeat: { cooldownSec: 600 },
      }).cooldownSec,
    ).toBe(600);
    expect(parseHeartbeatCooldownPolicy({}).cooldownSec).toBe(0);
  });

  it("identifies throttled invocation sources", () => {
    expect(isHeartbeatCooldownThrottledSource("assignment")).toBe(true);
    expect(isHeartbeatCooldownThrottledSource("automation")).toBe(true);
    expect(isHeartbeatCooldownThrottledSource("on_demand")).toBe(false);
    expect(isHeartbeatCooldownThrottledSource("timer")).toBe(false);
  });

  it("bypasses timer and manual board wakeups", () => {
    expect(shouldBypassHeartbeatCooldown({ source: "timer" })).toBe(true);
    expect(
      shouldBypassHeartbeatCooldown({
        source: "on_demand",
        requestedByActorType: "user",
      }),
    ).toBe(true);
    expect(
      shouldBypassHeartbeatCooldown({
        source: "on_demand",
        requestedByActorType: "system",
      }),
    ).toBe(false);
  });

  it("computes eligibleAt from last finished run", () => {
    const lastFinishedAt = new Date("2026-06-02T12:00:00.000Z");
    const now = new Date("2026-06-02T12:05:00.000Z");
    const eligibleAt = computeHeartbeatCooldownEligibleAt(lastFinishedAt, 600, now);
    expect(eligibleAt?.toISOString()).toBe("2026-06-02T12:10:00.000Z");

    const afterCooldown = new Date("2026-06-02T12:11:00.000Z");
    expect(computeHeartbeatCooldownEligibleAt(lastFinishedAt, 600, afterCooldown)).toBeNull();
  });
});
