// Unit tests for the monitor cadence helper (NET-2045, NET-2044).
//
// The helper is a pure function. The framework never derives the green /
// deploy-confirmed signals — the monitor agent owns those via PATCHes — so
// the tests cover the acceptance criteria:
//   1. Default policy (no slowdown knobs) returns null (no behavior change).
//   2. slowdownAfterGreens without slowdownCadenceSeconds is rejected at
//      validation; helper stays no-op if either knob is missing.
//   3. Gate is met only when BOTH consecutiveGreens >= slowdownAfterGreens
//      AND deployConfirmed === true; either condition failing returns null.
//   4. computeMonitorNextCheckAt returns now+current when no slowdown, and
//      now+slowdown when the gate engages (NET-1244 target: 5min → 30min).
//   5. NET-2044 in-review tenure gate: when `slowdownAfterInReviewSeconds`
//      is set on the policy, the gate is only met once `now -
//      inReviewSinceAt >= slowdownAfterInReviewSeconds`. Below the
//      threshold, helper returns null and the agent's current cadence is
//      preserved.

import { describe, expect, it } from "vitest";

import {
  computeMonitorNextCheckAt,
  resolveMonitorSlowdownCadenceSeconds,
} from "./monitor-cadence.js";
import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
} from "@paperclipai/shared";

const POLICY_WITH_SLOWDOWN: IssueExecutionMonitorPolicy = {
  nextCheckAt: "2026-08-23T22:00:00.000Z",
  notes: null,
  scheduledBy: "assignee",
  serviceName: "paperclip-routine-cron-shadow-diff",
  slowdownAfterGreens: 3,
  slowdownCadenceSeconds: 1800, // 30 minutes
};

// NET-1244-style policy: keep fast cadence for first 1h of in_review, then
// stretch to 30min once at least 1 green + deploy-confirmed is recorded.
const POLICY_WITH_IN_REVIEW_GATE: IssueExecutionMonitorPolicy = {
  ...POLICY_WITH_SLOWDOWN,
  slowdownAfterGreens: 1,
  slowdownAfterInReviewSeconds: 3600, // 1 hour
};

function makeState(overrides: Partial<IssueExecutionMonitorState> = {}): IssueExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: null,
    lastTriggeredAt: null,
    attemptCount: 0,
    notes: null,
    scheduledBy: "assignee",
    serviceName: null,
    externalRef: null,
    timeoutAt: null,
    maxAttempts: null,
    recoveryPolicy: null,
    clearedAt: null,
    clearReason: null,
    consecutiveGreens: null,
    deployConfirmed: null,
    lastGreenAt: null,
    inReviewSinceAt: null,
    ...overrides,
  };
}

describe("resolveMonitorSlowdownCadenceSeconds (NET-2045)", () => {
  it("returns null when the policy omits slowdown knobs (default behavior preserved)", () => {
    const policy: IssueExecutionMonitorPolicy = {
      nextCheckAt: "2026-08-23T22:00:00.000Z",
      notes: null,
      scheduledBy: "assignee",
      serviceName: "paperclip-routine-cron-shadow-diff",
    };
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy,
        state: makeState({ consecutiveGreens: 10, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when policy is null", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: null,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when state is null", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: null,
      }),
    ).toBeNull();
  });

  it("returns null when consecutiveGreens is below the slowdown threshold", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 2, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when deploy is not confirmed", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: false }),
      }),
    ).toBeNull();
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: null }),
      }),
    ).toBeNull();
  });

  it("returns the slowdown cadence when the gate is fully met", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 3, deployConfirmed: true }),
      }),
    ).toBe(1800);
  });

  it("engages at exactly the slowdownAfterGreens boundary (off-by-one guard)", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 3, deployConfirmed: true }),
      }),
    ).toBe(1800);
  });

  it("ignores a zero / negative slowdownCadenceSeconds", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: { ...POLICY_WITH_SLOWDOWN, slowdownCadenceSeconds: 0 },
        state: makeState({ consecutiveGreens: 5, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  // NET-2044: in-review tenure gate.
  describe("slowdownAfterInReviewSeconds gate (NET-2044)", () => {
    const inReviewSinceAt = "2026-08-24T00:00:00.000Z";

    it("returns null when inReviewSinceAt is missing on the state", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 5,
            deployConfirmed: true,
            inReviewSinceAt: null,
          }),
          now: new Date("2026-08-24T02:00:00.000Z"),
        }),
      ).toBeNull();
    });

    it("returns null when the in-review tenure is below the threshold", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 5,
            deployConfirmed: true,
            inReviewSinceAt,
          }),
          now: new Date("2026-08-24T00:30:00.000Z"), // 30min in
        }),
      ).toBeNull();
    });

    it("engages at exactly the slowdownAfterInReviewSeconds boundary (off-by-one guard)", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 1,
            deployConfirmed: true,
            inReviewSinceAt,
          }),
          now: new Date("2026-08-24T01:00:00.000Z"), // 1h exactly
        }),
      ).toBe(1800);
    });

    it("engages once the in-review tenure is comfortably past the threshold", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 1,
            deployConfirmed: true,
            inReviewSinceAt,
          }),
          now: new Date("2026-08-24T05:00:00.000Z"), // 5h later
        }),
      ).toBe(1800);
    });

    it("still requires consecutiveGreens and deployConfirmed when the in-review gate is met", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 0, // below threshold
            deployConfirmed: true,
            inReviewSinceAt,
          }),
          now: new Date("2026-08-24T05:00:00.000Z"),
        }),
      ).toBeNull();
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 5,
            deployConfirmed: false, // not confirmed
            inReviewSinceAt,
          }),
          now: new Date("2026-08-24T05:00:00.000Z"),
        }),
      ).toBeNull();
    });

    it("ignores an unparseable inReviewSinceAt", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: POLICY_WITH_IN_REVIEW_GATE,
          state: makeState({
            consecutiveGreens: 5,
            deployConfirmed: true,
            inReviewSinceAt: "not-a-date",
          }),
          now: new Date("2026-08-24T05:00:00.000Z"),
        }),
      ).toBeNull();
    });

    it("behaves like NET-2045 when slowdownAfterInReviewSeconds is absent (gate skipped)", () => {
      expect(
        resolveMonitorSlowdownCadenceSeconds({
          policy: { ...POLICY_WITH_SLOWDOWN, slowdownAfterGreens: 1 },
          state: makeState({
            consecutiveGreens: 1,
            deployConfirmed: true,
            inReviewSinceAt: null,
          }),
        }),
      ).toBe(1800);
    });
  });
});

describe("computeMonitorNextCheckAt (NET-2045)", () => {
  const now = new Date("2026-08-23T22:00:00.000Z");

  it("uses the current cadence when the slowdown gate is not met", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_SLOWDOWN,
      state: makeState({ consecutiveGreens: 1, deployConfirmed: true }),
      currentCadenceSeconds: 300,
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:05:00.000Z");
  });

  it("stretches to the slowdown cadence when the gate is met (NET-1244 target)", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_SLOWDOWN,
      state: makeState({ consecutiveGreens: 4, deployConfirmed: true }),
      currentCadenceSeconds: 300, // 5 minutes — current NET-1244 cadence
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:30:00.000Z"); // 30 minutes later
  });

  it("falls back to the current cadence when no slowdown policy is set (default monitors unaffected)", () => {
    const policy: IssueExecutionMonitorPolicy = {
      nextCheckAt: "2026-08-23T22:00:00.000Z",
      notes: null,
      scheduledBy: "assignee",
      serviceName: "legacy-monitor",
    };
    const next = computeMonitorNextCheckAt({
      policy,
      state: makeState({ consecutiveGreens: 99, deployConfirmed: true }),
      currentCadenceSeconds: 600,
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:10:00.000Z");
  });

  // NET-2044: in-review tenure gate at the compute layer.
  it("keeps the fast cadence for the first hour of in_review (NET-1244 5min target)", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_IN_REVIEW_GATE,
      state: makeState({
        consecutiveGreens: 5,
        deployConfirmed: true,
        inReviewSinceAt: "2026-08-24T00:00:00.000Z",
      }),
      currentCadenceSeconds: 300, // 5 minutes
      now: new Date("2026-08-24T00:30:00.000Z"), // 30min into in_review
    });
    expect(next.toISOString()).toBe("2026-08-24T00:35:00.000Z"); // +5min, not +30min
  });

  it("stretches to the slowdown cadence after the in-review tenure threshold (NET-1244 30min target)", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_IN_REVIEW_GATE,
      state: makeState({
        consecutiveGreens: 5,
        deployConfirmed: true,
        inReviewSinceAt: "2026-08-24T00:00:00.000Z",
      }),
      currentCadenceSeconds: 300, // 5 minutes
      now: new Date("2026-08-24T02:00:00.000Z"), // 2h into in_review
    });
    expect(next.toISOString()).toBe("2026-08-24T02:30:00.000Z"); // +30min
  });
});