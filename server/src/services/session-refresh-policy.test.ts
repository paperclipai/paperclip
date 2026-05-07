import { describe, expect, it } from "vitest";
import { evaluateSessionRefreshPolicy, parseSessionRefreshPolicyConfig } from "./session-refresh-policy.js";

describe("parseSessionRefreshPolicyConfig", () => {
  it("defaults to none with standard TTL and hour", () => {
    expect(parseSessionRefreshPolicyConfig({})).toEqual({
      sessionRefreshPolicy: "none",
      sessionInactivityTtlSec: 1800,
      sessionDailyRefreshHour: 0,
    });
  });

  it("accepts valid policy and numeric fields", () => {
    expect(
      parseSessionRefreshPolicyConfig({
        sessionRefreshPolicy: "inactivity",
        sessionInactivityTtlSec: 60,
        sessionDailyRefreshHour: 12,
      }),
    ).toEqual({
      sessionRefreshPolicy: "inactivity",
      sessionInactivityTtlSec: 60,
      sessionDailyRefreshHour: 12,
    });
  });

  it("rejects invalid policy string", () => {
    expect(
      parseSessionRefreshPolicyConfig({ sessionRefreshPolicy: "nope" }).sessionRefreshPolicy,
    ).toBe("none");
  });

  it("clamps daily hour to 0–23", () => {
    expect(
      parseSessionRefreshPolicyConfig({ sessionDailyRefreshHour: 99 }).sessionDailyRefreshHour,
    ).toBe(0);
  });
});

describe("evaluateSessionRefreshPolicy", () => {
  const baseConfig = { sessionRefreshPolicy: "per_run" as const };

  it("never clears on explicit resume", () => {
    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: baseConfig,
        now: new Date("2026-04-22T12:00:00.000Z"),
        hasExplicitResume: true,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: new Date("2026-04-22T11:00:00.000Z"),
      }),
    ).toEqual({ clearPersistedSession: false, logReason: null });
  });

  it("does not clear when nothing would be resumed", () => {
    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: baseConfig,
        now: new Date(),
        hasExplicitResume: false,
        wouldResumeFromPersistence: false,
        lastPersistedSessionTouch: null,
      }),
    ).toEqual({ clearPersistedSession: false, logReason: null });
  });

  it("per_run clears when persistence would resume", () => {
    const r = evaluateSessionRefreshPolicy({
      adapterConfig: { sessionRefreshPolicy: "per_run" },
      now: new Date(),
      hasExplicitResume: false,
      wouldResumeFromPersistence: true,
      lastPersistedSessionTouch: new Date(),
    });
    expect(r.clearPersistedSession).toBe(true);
    expect(r.logReason).toContain("per_run");
  });

  it("inactivity clears after TTL", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const last = new Date("2026-04-22T11:00:00.000Z");
    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "inactivity", sessionInactivityTtlSec: 1800 },
        now,
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: last,
      }).clearPersistedSession,
    ).toBe(false);

    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "inactivity", sessionInactivityTtlSec: 600 },
        now,
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: last,
      }).clearPersistedSession,
    ).toBe(true);
  });

  it("daily clears across UTC boundary windows", () => {
    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "daily", sessionDailyRefreshHour: 0 },
        now: new Date("2026-04-22T01:00:00.000Z"),
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: new Date("2026-04-22T00:30:00.000Z"),
      }).clearPersistedSession,
    ).toBe(false);

    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "daily", sessionDailyRefreshHour: 0 },
        now: new Date("2026-04-22T01:00:00.000Z"),
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: new Date("2026-04-21T12:00:00.000Z"),
      }).clearPersistedSession,
    ).toBe(true);
  });

  it("daily respects boundary hour in UTC", () => {
    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "daily", sessionDailyRefreshHour: 6 },
        now: new Date("2026-04-22T05:00:00.000Z"),
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: new Date("2026-04-22T04:00:00.000Z"),
      }).clearPersistedSession,
    ).toBe(false);

    expect(
      evaluateSessionRefreshPolicy({
        adapterConfig: { sessionRefreshPolicy: "daily", sessionDailyRefreshHour: 6 },
        now: new Date("2026-04-22T07:00:00.000Z"),
        hasExplicitResume: false,
        wouldResumeFromPersistence: true,
        lastPersistedSessionTouch: new Date("2026-04-22T04:00:00.000Z"),
      }).clearPersistedSession,
    ).toBe(true);
  });
});
