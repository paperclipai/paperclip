import { describe, expect, it } from "vitest";
import { isHeartbeatCooldownActive } from "../services/heartbeat.ts";

// Regression coverage for PEN-825 / BLO-9089: the per-agent heartbeat cooldown
// must throttle only the periodic *timer* self-wake loop. Externally-triggered
// demand wakes (PR opened/review/@mention) must never be dropped on cooldown —
// a skipped demand wake is terminal (no defer column on agent_wakeup_requests),
// so dropping it silently loses a PR review.
describe("isHeartbeatCooldownActive", () => {
  const last = new Date("2026-06-26T00:00:00.000Z");
  const base = last.getTime();
  const within = base + 10_000; // 10s into a 30s window
  const after = base + 40_000; // 10s past a 30s window

  it("suppresses a timer wake inside the cooldown window", () => {
    const r = isHeartbeatCooldownActive({ source: "timer", cooldownSec: 30, lastHeartbeatAt: last, now: within });
    expect(r.active).toBe(true);
    expect(r.remainingSec).toBe(20);
  });

  it("does not suppress a timer wake once the window has elapsed", () => {
    const r = isHeartbeatCooldownActive({ source: "timer", cooldownSec: 30, lastHeartbeatAt: last, now: after });
    expect(r.active).toBe(false);
    expect(r.remainingSec).toBe(0);
  });

  it("never suppresses a demand wake inside the cooldown window", () => {
    for (const source of ["automation", "assignment", "on_demand"]) {
      const r = isHeartbeatCooldownActive({ source, cooldownSec: 30, lastHeartbeatAt: last, now: within });
      expect(r.active).toBe(false);
      expect(r.remainingSec).toBe(0);
    }
  });

  it("does not suppress when the cooldown is disabled or no prior heartbeat exists", () => {
    expect(
      isHeartbeatCooldownActive({ source: "timer", cooldownSec: 0, lastHeartbeatAt: last, now: within }).active,
    ).toBe(false);
    expect(
      isHeartbeatCooldownActive({ source: "timer", cooldownSec: 30, lastHeartbeatAt: null, now: within }).active,
    ).toBe(false);
  });

  it("accepts string and number lastHeartbeatAt values", () => {
    expect(
      isHeartbeatCooldownActive({ source: "timer", cooldownSec: 30, lastHeartbeatAt: last.toISOString(), now: within })
        .active,
    ).toBe(true);
    expect(
      isHeartbeatCooldownActive({ source: "timer", cooldownSec: 30, lastHeartbeatAt: base, now: within }).active,
    ).toBe(true);
  });
});
