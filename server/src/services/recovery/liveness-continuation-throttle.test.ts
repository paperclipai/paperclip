import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVENESS_CONTINUATION_THROTTLE_CONFIG,
  buildUpstreamThrottleCeilingNoticeMarker,
  computeLivenessContinuationBackoff,
  decideUpstreamThrottleCeiling,
  isUpstreamThrottleExitRun,
  resolveLivenessContinuationThrottleConfig,
  summarizeUpstreamThrottleStreak,
} from "./liveness-continuation-throttle.js";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function config(overrides: Partial<typeof DEFAULT_LIVENESS_CONTINUATION_THROTTLE_CONFIG> = {}) {
  return { ...DEFAULT_LIVENESS_CONTINUATION_THROTTLE_CONFIG, ...overrides };
}

function throttleRun(minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    status: "failed",
    errorCode: "claude_transient_upstream",
    livenessState: null,
    resultJson: null,
    finishedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    ...overrides,
  };
}

function productiveRun(minutesAgo: number) {
  return {
    status: "succeeded",
    errorCode: null,
    livenessState: "advanced",
    resultJson: { summary: "did work" },
    finishedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  };
}

describe("resolveLivenessContinuationThrottleConfig", () => {
  it("defaults to shadow mode with documented defaults", () => {
    const resolved = resolveLivenessContinuationThrottleConfig({});
    expect(resolved.mode).toBe("shadow");
    expect(resolved.backoffBaseMs).toBe(60_000);
    expect(resolved.backoffMaxMs).toBe(600_000);
    expect(resolved.ceilingConsecutiveRuns).toBe(5);
    expect(resolved.ceilingWindowMs).toBe(HOUR_MS);
  });

  it("honors explicit modes and rejects unknown modes", () => {
    for (const mode of ["off", "shadow", "enforce"] as const) {
      expect(
        resolveLivenessContinuationThrottleConfig({
          PAPERCLIP_LIVENESS_CONTINUATION_THROTTLE_MODE: mode,
        }).mode,
      ).toBe(mode);
    }
    expect(
      resolveLivenessContinuationThrottleConfig({
        PAPERCLIP_LIVENESS_CONTINUATION_THROTTLE_MODE: "yes-please",
      }).mode,
    ).toBe("shadow");
  });

  it("parses numeric overrides and falls back on junk", () => {
    const resolved = resolveLivenessContinuationThrottleConfig({
      PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_BASE_MS: "30000",
      PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_MAX_MS: "120000",
      PAPERCLIP_UPSTREAM_THROTTLE_CEILING_RUNS: "3",
      PAPERCLIP_UPSTREAM_THROTTLE_WINDOW_MS: "junk",
    });
    expect(resolved.backoffBaseMs).toBe(30_000);
    expect(resolved.backoffMaxMs).toBe(120_000);
    expect(resolved.ceilingConsecutiveRuns).toBe(3);
    expect(resolved.ceilingWindowMs).toBe(HOUR_MS);
  });

  it("never lets the backoff cap fall below the base", () => {
    const resolved = resolveLivenessContinuationThrottleConfig({
      PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_BASE_MS: "300000",
      PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_MAX_MS: "1000",
    });
    expect(resolved.backoffMaxMs).toBe(300_000);
  });
});

describe("computeLivenessContinuationBackoff", () => {
  const midJitter = () => 0.5; // jitter multiplier 1.0

  it("grows exponentially with the attempt number", () => {
    const first = computeLivenessContinuationBackoff({
      attempt: 1,
      config: config(),
      now: NOW,
      random: midJitter,
    });
    const second = computeLivenessContinuationBackoff({
      attempt: 2,
      config: config(),
      now: NOW,
      random: midJitter,
    });
    expect(first?.delayMs).toBe(60_000);
    expect(second?.delayMs).toBe(120_000);
    expect(second?.dueAt.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("caps the delay at backoffMaxMs even with max jitter", () => {
    const deep = computeLivenessContinuationBackoff({
      attempt: 12,
      config: config(),
      now: NOW,
      random: () => 1,
    });
    expect(deep?.delayMs).toBe(600_000);
  });

  it("bounds jitter within the configured ratio", () => {
    const low = computeLivenessContinuationBackoff({
      attempt: 1,
      config: config(),
      now: NOW,
      random: () => 0,
    });
    const high = computeLivenessContinuationBackoff({
      attempt: 1,
      config: config(),
      now: NOW,
      random: () => 1,
    });
    expect(low?.delayMs).toBe(45_000);
    expect(high?.delayMs).toBe(75_000);
  });

  it("returns null for non-positive or non-integer attempts", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(
        computeLivenessContinuationBackoff({ attempt, config: config(), now: NOW }),
      ).toBeNull();
    }
  });
});

describe("isUpstreamThrottleExitRun", () => {
  it("matches the Layer A adapter error codes", () => {
    expect(isUpstreamThrottleExitRun({ errorCode: "claude_transient_upstream" })).toBe(true);
    expect(isUpstreamThrottleExitRun({ errorCode: "codex_transient_upstream" })).toBe(true);
  });

  it("matches the persisted errorFamily contract, including clean-exit successes", () => {
    expect(
      isUpstreamThrottleExitRun({
        status: "succeeded",
        resultJson: { errorFamily: "transient_upstream" },
      }),
    ).toBe(true);
    expect(
      isUpstreamThrottleExitRun({ resultJson: { errorFamily: "upstream_throttled" } }),
    ).toBe(true);
    expect(
      isUpstreamThrottleExitRun({ resultJson: JSON.stringify({ errorFamily: "transient_upstream" }) }),
    ).toBe(true);
  });

  it("matches the Layer B upstream_throttled liveness state before it lands in the shared union", () => {
    expect(isUpstreamThrottleExitRun({ livenessState: "upstream_throttled" })).toBe(true);
  });

  it("rejects ordinary runs and unrelated failures", () => {
    expect(isUpstreamThrottleExitRun({ status: "succeeded", livenessState: "advanced" })).toBe(false);
    expect(isUpstreamThrottleExitRun({ errorCode: "process_lost" })).toBe(false);
    expect(isUpstreamThrottleExitRun({ resultJson: { errorFamily: "workspace_validation" } })).toBe(false);
    expect(isUpstreamThrottleExitRun({ resultJson: "not json" })).toBe(false);
    expect(isUpstreamThrottleExitRun({})).toBe(false);
  });
});

describe("summarizeUpstreamThrottleStreak", () => {
  it("counts consecutive throttle exits across source runs — the reset-hole case", () => {
    // Nine throttle exits from nine distinct source runs (each fresh wake
    // reset continuationAttempt to 0) — the streak must still see all nine.
    const runs = Array.from({ length: 9 }, (_, index) => throttleRun(index * 5));
    const streak = summarizeUpstreamThrottleStreak({ runs, now: NOW, windowMs: HOUR_MS });
    expect(streak.streak).toBe(9);
    expect(streak.firstThrottleAt?.getTime()).toBe(NOW.getTime() - 40 * 60_000);
    expect(streak.lastThrottleAt?.getTime()).toBe(NOW.getTime());
  });

  it("resets at the first productive run", () => {
    const runs = [throttleRun(0), throttleRun(5), productiveRun(10), throttleRun(15)];
    const streak = summarizeUpstreamThrottleStreak({ runs, now: NOW, windowMs: HOUR_MS });
    expect(streak.streak).toBe(2);
  });

  it("ignores throttle exits outside the rolling window", () => {
    const runs = [throttleRun(0), throttleRun(5), throttleRun(90)];
    const streak = summarizeUpstreamThrottleStreak({ runs, now: NOW, windowMs: HOUR_MS });
    expect(streak.streak).toBe(2);
  });

  it("orders unsorted input by timestamp before counting", () => {
    const runs = [throttleRun(30), productiveRun(10), throttleRun(5), throttleRun(0)];
    const streak = summarizeUpstreamThrottleStreak({ runs, now: NOW, windowMs: HOUR_MS });
    expect(streak.streak).toBe(2);
  });

  it("lets cancelled runs neither extend nor break a streak", () => {
    // A cancellation is not a throttle exit, but it is also not evidence the
    // upstream recovered — the streak walks straight past it.
    const runs = [throttleRun(0), throttleRun(5, { status: "cancelled" }), throttleRun(10)];
    const streak = summarizeUpstreamThrottleStreak({ runs, now: NOW, windowMs: HOUR_MS });
    expect(streak.streak).toBe(2);
    expect(streak.firstThrottleAt?.getTime()).toBe(NOW.getTime() - 10 * 60_000);
  });

  it("handles empty input and missing timestamps", () => {
    expect(summarizeUpstreamThrottleStreak({ runs: [], now: NOW, windowMs: HOUR_MS }).streak).toBe(0);
    expect(
      summarizeUpstreamThrottleStreak({
        runs: [{ errorCode: "claude_transient_upstream", finishedAt: null }],
        now: NOW,
        windowMs: HOUR_MS,
      }).streak,
    ).toBe(0);
  });
});

describe("decideUpstreamThrottleCeiling", () => {
  const issue = { id: "issue-1", identifier: "GOL-1", title: "Example" };

  function streakOf(count: number) {
    return summarizeUpstreamThrottleStreak({
      runs: Array.from({ length: count }, (_, index) => throttleRun(index * 2)),
      now: NOW,
      windowMs: HOUR_MS,
    });
  }

  it("does nothing below the ceiling", () => {
    const decision = decideUpstreamThrottleCeiling({
      streak: streakOf(4),
      config: config({ mode: "enforce" }),
      issue,
      agentId: "agent-1",
    });
    expect(decision.action).toBe("none");
  });

  it("does nothing when the mode is off, even above the ceiling", () => {
    const decision = decideUpstreamThrottleCeiling({
      streak: streakOf(9),
      config: config({ mode: "off" }),
      issue,
      agentId: "agent-1",
    });
    expect(decision.action).toBe("none");
  });

  it("reaches the ceiling in shadow mode without authorizing a pause", () => {
    const decision = decideUpstreamThrottleCeiling({
      streak: streakOf(5),
      config: config({ mode: "shadow" }),
      issue,
      agentId: "agent-1",
    });
    expect(decision.action).toBe("ceiling_reached");
    if (decision.action !== "ceiling_reached") return;
    expect(decision.pauseAgent).toBe(false);
    expect(decision.mode).toBe("shadow");
  });

  it("authorizes the pause and one consolidated notice in enforce mode", () => {
    const decision = decideUpstreamThrottleCeiling({
      streak: streakOf(9),
      config: config({ mode: "enforce" }),
      issue,
      agentId: "agent-1",
    });
    expect(decision.action).toBe("ceiling_reached");
    if (decision.action !== "ceiling_reached") return;
    expect(decision.pauseAgent).toBe(true);
    expect(decision.streak).toBe(9);
    expect(decision.noticeMarker).toBe(buildUpstreamThrottleCeilingNoticeMarker(issue.id));
    expect(decision.noticeBody).toContain("Upstream throttle ceiling reached for GOL-1");
    expect(decision.noticeBody).toContain("rate limit / quota");
    expect(decision.noticeBody).toContain(`<!-- upstream-throttle-ceiling:${issue.id} -->`);
  });

  it("honors a configured ceiling override", () => {
    const decision = decideUpstreamThrottleCeiling({
      streak: streakOf(3),
      config: config({ mode: "enforce", ceilingConsecutiveRuns: 3 }),
      issue,
      agentId: "agent-1",
    });
    expect(decision.action).toBe("ceiling_reached");
  });
});
