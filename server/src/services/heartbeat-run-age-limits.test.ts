import { describe, expect, it } from "vitest";

import { resolveHeartbeatRunAgeLimits } from "./heartbeat.js";

// Documented defaults for CAN-3606. The test pins the defaults so any
// accidental change to the baseline ceilings is caught at unit-test time.
const EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS = 60 * 60 * 1000;
const EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS = 60 * 60 * 1000;

describe("resolveHeartbeatRunAgeLimits", () => {
  it("returns the documented defaults when no env overrides are set", () => {
    const limits = resolveHeartbeatRunAgeLimits({});
    expect(limits.activeRunMaxAgeMs).toBe(EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS);
    expect(limits.queuedRunMaxAgeMs).toBe(EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS);
  });

  it("applies independent overrides for the active and queued ceilings", () => {
    const limits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "14400000",
      PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "1800000",
    });
    expect(limits.activeRunMaxAgeMs).toBe(14_400_000);
    expect(limits.queuedRunMaxAgeMs).toBe(1_800_000);
  });

  it("falls back to defaults for malformed, blank, or negative values", () => {
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "  ",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "not-a-number",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "-1000",
      }),
    ).toEqual(fallback);
  });

  it("treats each env override as an independent knob (one does not bleed into the other)", () => {
    const limits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "7200000",
    });
    expect(limits.activeRunMaxAgeMs).toBe(7_200_000);
    expect(limits.queuedRunMaxAgeMs).toBe(EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS);
  });
});