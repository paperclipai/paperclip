import { describe, expect, it } from "vitest";
import {
  FALSE_LIVENESS_ERROR_REASON,
  FALSE_LIVENESS_SCAN_LIMIT,
  FALSE_LIVENESS_STREAK_THRESHOLD,
  falseLivenessStreak,
  hasProviderUsageRecord,
  isFalseLivenessRun,
  PROVIDER_USAGE_MEASURE_KEYS,
  reportsZeroProviderUsage,
  resolveFalseLivenessEscalation,
  tripsFalseLivenessDetector,
  type RunUsageSample,
} from "../services/run-liveness.ts";

// A run whose provider reported nothing: the shape a dead adapter produces.
// Copied from a real GeminiEng row on 2026-09-01, the episode that ran 63 times
// before a human noticed.
const DEAD_USAGE = {
  model: "google-gemini-cli/gemini-2.5-pro",
  biller: "google-gemini-cli",
  provider: "google-gemini-cli",
  billingType: "unknown",
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  rawInputTokens: 0,
  rawOutputTokens: 0,
  rawCachedInputTokens: 0,
  freshSession: true,
  sessionReused: false,
};

// FIXTURE 1 (load-bearing). A resumed session reports zero NORMALIZED tokens
// while the model genuinely ran and billed. Copied from a real CEO row.
// A detector reading inputTokens/outputTokens marks this agent dead.
const SESSION_DELTA_USAGE = {
  costUsd: 0.125663,
  usageSource: "session_delta",
  inputTokens: 0,
  outputTokens: 0,
  rawInputTokens: 4,
  rawOutputTokens: 452,
  rawCachedInputTokens: 200986,
};

// FIXTURE 2. An ordinary healthy run, non-zero everywhere.
const HEALTHY_USAGE = {
  costUsd: 0.3948814,
  inputTokens: 104000,
  outputTokens: 6379,
  rawInputTokens: 104000,
  rawOutputTokens: 6379,
  rawCachedInputTokens: 98000,
};

const dead = (): RunUsageSample => ({
  status: "succeeded",
  usageJson: { ...DEAD_USAGE },
});
const healthy = (): RunUsageSample => ({
  status: "succeeded",
  usageJson: { ...HEALTHY_USAGE },
});
const repeat = (n: number, make: () => RunUsageSample) =>
  Array.from({ length: n }, make);

describe("false-liveness predicate", () => {
  // FIXTURE 1 — the control the whole change exists to protect.
  it("does not trip on a session_delta run with zero normalized tokens", () => {
    expect(reportsZeroProviderUsage(SESSION_DELTA_USAGE)).toBe(false);
    expect(
      isFalseLivenessRun({
        status: "succeeded",
        usageJson: SESSION_DELTA_USAGE,
      }),
    ).toBe(false);
    // Even an unbroken run of them must never trip the detector.
    expect(
      tripsFalseLivenessDetector(
        repeat(50, () => ({
          status: "succeeded",
          usageJson: { ...SESSION_DELTA_USAGE },
        })),
      ),
    ).toBe(false);
  });

  // FIXTURE 2.
  it("does not trip on an ordinary healthy run", () => {
    expect(reportsZeroProviderUsage(HEALTHY_USAGE)).toBe(false);
    expect(tripsFalseLivenessDetector(repeat(50, healthy))).toBe(false);
  });

  it("matches a succeeded run whose provider reported zero usage and cost", () => {
    expect(reportsZeroProviderUsage(DEAD_USAGE)).toBe(true);
    expect(isFalseLivenessRun(dead())).toBe(true);
  });

  // The measure list, pinned by EQUALITY. The per-key fixtures below are all
  // removals, and a removal probe cannot falsify a membership guard: `some`
  // and `every` are both satisfied by a SUPERSET, so appending a key (e.g.
  // "cacheAdjustedCostUsd", which heartbeat.ts really writes) left the whole
  // suite green. Equality terminates the class; a battery of negatives does
  // not. ADR-004 Amendment 6.
  it("reads exactly these provider usage measures, in this order", () => {
    expect(PROVIDER_USAGE_MEASURE_KEYS).toEqual([
      "rawInputTokens",
      "rawOutputTokens",
      "rawCachedInputTokens",
      "costUsd",
    ]);
  });

  // Pins each measure INDIVIDUALLY. Dropping any one key from the guard's key
  // list must be caught, so each key gets a fixture where it alone is non-zero.
  it.each([
    ["rawInputTokens", { ...DEAD_USAGE, rawInputTokens: 12 }],
    ["rawOutputTokens", { ...DEAD_USAGE, rawOutputTokens: 12 }],
    ["rawCachedInputTokens", { ...DEAD_USAGE, rawCachedInputTokens: 12 }],
    ["costUsd", { ...DEAD_USAGE, costUsd: 0.0001 }],
  ])("a non-zero %s alone disqualifies the run", (_key, usageJson) => {
    expect(reportsZeroProviderUsage(usageJson)).toBe(false);
  });

  // The normalized counters must have NO influence. Flipping them either way
  // on an otherwise-dead run must not change the verdict.
  it.each([
    ["inputTokens", { ...DEAD_USAGE, inputTokens: 104000 }],
    ["outputTokens", { ...DEAD_USAGE, outputTokens: 6379 }],
  ])("a non-zero %s does NOT rescue a zero-raw run", (_key, usageJson) => {
    expect(reportsZeroProviderUsage(usageJson)).toBe(true);
  });

  // FIXTURE 7 — stated behaviour, decided on live data rather than left to
  // coalesce. Absent usage is an instrumentation gap, not proof the model
  // produced nothing. Over 90 days every zero-usage run on a healthy agent
  // (27 runs across FoundingEng, AdversarialEng, CTO, CEO, CMO) had a NULL
  // usage_json, while all 221 on dead agents carried a populated object.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["an object with no measures", { model: "x", biller: "y" }],
    // The sharp one: zero-valued keys shaped exactly like measures, but
    // normalized rather than raw. Adding either to the measure list would
    // flip this to true and put every session_delta agent one run from error.
    ["only zero-valued non-measure keys", { inputTokens: 0, outputTokens: 0 }],
  ])("carries no usage record when usageJson is %s", (_label, usageJson) => {
    expect(hasProviderUsageRecord(usageJson as never)).toBe(false);
    expect(reportsZeroProviderUsage(usageJson as never)).toBe(false);
    // Never enough on its own to mark an agent unavailable.
    expect(
      tripsFalseLivenessDetector(
        repeat(50, () => ({
          status: "succeeded",
          usageJson: usageJson as never,
        })),
      ),
    ).toBe(false);
  });

  it("carries a usage record when only some measures are present", () => {
    // 962 live runs report the three raw counters without costUsd; a
    // partially-reporting adapter must still be able to trip.
    expect(
      hasProviderUsageRecord({
        rawInputTokens: 0,
        rawOutputTokens: 0,
        rawCachedInputTokens: 0,
      }),
    ).toBe(true);
    expect(
      reportsZeroProviderUsage({
        rawInputTokens: 0,
        rawOutputTokens: 0,
        rawCachedInputTokens: 0,
      }),
    ).toBe(true);
  });

  it("reads numeric strings, and treats malformed values as absent", () => {
    expect(
      reportsZeroProviderUsage({ ...DEAD_USAGE, rawOutputTokens: "452" }),
    ).toBe(false);
    expect(reportsZeroProviderUsage({ ...DEAD_USAGE, costUsd: "0" })).toBe(true);
    expect(
      reportsZeroProviderUsage({ ...DEAD_USAGE, costUsd: Number.NaN }),
    ).toBe(true);
  });
});

describe("false-liveness streak accounting", () => {
  // FIXTURE 3. A failed run is ignored: it neither trips nor resets.
  it("ignores non-succeeded runs entirely", () => {
    for (const status of ["failed", "cancelled", "timed_out"]) {
      // All-zero usage on a failed run must not count toward the streak.
      expect(
        falseLivenessStreak([{ status, usageJson: { ...DEAD_USAGE } }]),
      ).toBe(0);
      expect(
        tripsFalseLivenessDetector(
          repeat(50, () => ({ status, usageJson: { ...DEAD_USAGE } })),
        ),
      ).toBe(false);
      // ...and must not reset a streak that spans it.
      expect(
        falseLivenessStreak([
          ...repeat(2, dead),
          { status, usageJson: { ...DEAD_USAGE } },
          ...repeat(3, dead),
        ]),
      ).toBe(FALSE_LIVENESS_STREAK_THRESHOLD);
    }
  });

  // FIXTURE 7, streak half. A succeeded run with no usage record is IGNORED —
  // it neither counts nor resets — the same treatment as a failed run. This is
  // what separates "ignore" from "reset": the streak spans the gap.
  it("ignores a succeeded run that recorded no usage, without resetting", () => {
    const noSignal = (): RunUsageSample => ({
      status: "succeeded",
      usageJson: null,
    });

    // 2 dead + a recording gap + 3 dead is still a streak of 5.
    const spanning = [
      ...repeat(2, dead),
      noSignal(),
      ...repeat(3, dead),
    ];
    expect(falseLivenessStreak(spanning)).toBe(FALSE_LIVENESS_STREAK_THRESHOLD);
    expect(tripsFalseLivenessDetector(spanning)).toBe(true);

    // But the gap adds nothing on its own: 4 dead around it stays at 4.
    const short = [...repeat(2, dead), ...repeat(9, noSignal), ...repeat(2, dead)];
    expect(falseLivenessStreak(short)).toBe(4);
    expect(tripsFalseLivenessDetector(short)).toBe(false);

    // And a healthy run still resets THROUGH a gap.
    expect(
      falseLivenessStreak([
        ...repeat(3, dead),
        noSignal(),
        healthy(),
        ...repeat(9, dead),
      ]),
    ).toBe(3);
  });

  // The scan window must be wide enough that skipped runs cannot starve the
  // streak: reading only THRESHOLD rows would make the detector unable to trip
  // whenever a recording gap sits in the window.
  it("scans a window wider than the threshold", () => {
    expect(FALSE_LIVENESS_SCAN_LIMIT).toBeGreaterThan(
      FALSE_LIVENESS_STREAK_THRESHOLD,
    );
    const window: RunUsageSample[] = [
      ...repeat(FALSE_LIVENESS_SCAN_LIMIT - FALSE_LIVENESS_STREAK_THRESHOLD, () => ({
        status: "succeeded",
        usageJson: null,
      })),
      ...repeat(FALSE_LIVENESS_STREAK_THRESHOLD, dead),
    ];
    expect(window.length).toBe(FALSE_LIVENESS_SCAN_LIMIT);
    expect(tripsFalseLivenessDetector(window)).toBe(true);
  });

  // FIXTURE 4 — the off-by-one below the threshold.
  it("does not trip one run short of the threshold", () => {
    const runs = repeat(FALSE_LIVENESS_STREAK_THRESHOLD - 1, dead);
    expect(falseLivenessStreak(runs)).toBe(FALSE_LIVENESS_STREAK_THRESHOLD - 1);
    expect(tripsFalseLivenessDetector(runs)).toBe(false);
  });

  // FIXTURE 5 — trips at exactly the threshold, and stays tripped after.
  it("trips at exactly the threshold", () => {
    const runs = repeat(FALSE_LIVENESS_STREAK_THRESHOLD, dead);
    expect(falseLivenessStreak(runs)).toBe(FALSE_LIVENESS_STREAK_THRESHOLD);
    expect(tripsFalseLivenessDetector(runs)).toBe(true);
    expect(
      tripsFalseLivenessDetector(repeat(FALSE_LIVENESS_STREAK_THRESHOLD + 1, dead)),
    ).toBe(true);
  });

  // FIXTURE 6 — a healthy run resets, so 4 + healthy + 4 must not trip.
  it("resets the streak on a healthy succeeded run", () => {
    const runs = [
      ...repeat(FALSE_LIVENESS_STREAK_THRESHOLD - 1, dead),
      healthy(),
      ...repeat(FALSE_LIVENESS_STREAK_THRESHOLD - 1, dead),
    ];
    expect(falseLivenessStreak(runs)).toBe(FALSE_LIVENESS_STREAK_THRESHOLD - 1);
    expect(tripsFalseLivenessDetector(runs)).toBe(false);
  });

  // The streak is the TRAILING one. A recovered agent whose history still holds
  // a long dead episode must not be marked on that history.
  it("counts only the trailing streak, not a historical episode", () => {
    const runs = [healthy(), ...repeat(63, dead)];
    expect(falseLivenessStreak(runs)).toBe(0);
    expect(tripsFalseLivenessDetector(runs)).toBe(false);
  });

  it("does not trip on an empty history", () => {
    expect(falseLivenessStreak([])).toBe(0);
    expect(tripsFalseLivenessDetector([])).toBe(false);
  });

  // The threshold sits in the measured gap between live and dead agents:
  // live agents top out at 3 consecutive zero-usage successes, dead episodes
  // ran 63 and 105. Pin the value so a change to it is a deliberate edit.
  it("pins the derived threshold", () => {
    expect(FALSE_LIVENESS_STREAK_THRESHOLD).toBe(5);
  });
});

describe("false-liveness escalation", () => {
  it("returns no escalation below the threshold", () => {
    expect(
      resolveFalseLivenessEscalation(
        repeat(FALSE_LIVENESS_STREAK_THRESHOLD - 1, dead),
        null,
      ),
    ).toBeNull();
  });

  // FIXTURE 5, second half: trips ONCE, not once per subsequent run.
  it("reports the escalation only on the transition into the fault", () => {
    const tripped = repeat(FALSE_LIVENESS_STREAK_THRESHOLD, dead);

    const first = resolveFalseLivenessEscalation(tripped, null);
    expect(first).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
      reportEscalation: true,
    });

    // The next run over the same streak keeps the agent marked but does not
    // re-report, so the operator sees one escalation per episode.
    const second = resolveFalseLivenessEscalation(
      repeat(FALSE_LIVENESS_STREAK_THRESHOLD + 1, dead),
      FALSE_LIVENESS_ERROR_REASON,
    );
    expect(second?.status).toBe("error");
    expect(second?.reportEscalation).toBe(false);
  });

  // A generic adapter error must not be mistaken for this fault, so an agent
  // already in error for another reason still reports this escalation.
  it("reports when the agent is in error for a different reason", () => {
    expect(
      resolveFalseLivenessEscalation(
        repeat(FALSE_LIVENESS_STREAK_THRESHOLD, dead),
        "Run ended with failed (provider_quota)",
      )?.reportEscalation,
    ).toBe(true);
  });

  // Equality, not presence. `toMatch(/credential/i)` is satisfied by any
  // superset, so rewriting the leading bytes to "Run failure: " left the old
  // assertions green while breaking the reversal path below. Equality also
  // pins the ${FALSE_LIVENESS_STREAK_THRESHOLD} interpolation, so a threshold
  // change cannot silently leave the operator-facing text saying "5".
  it("stores this exact operator-facing reason", () => {
    expect(FALSE_LIVENESS_ERROR_REASON).toBe(
      "Adapter credential/config fault: the last 5 runs exited cleanly but " +
        "the provider reported no tokens and no cost, so the model never " +
        "ran. Check this agent's adapter credentials and configuration.",
    );
    // agents.error_reason is truncated at 500 chars by the caller.
    expect(FALSE_LIVENESS_ERROR_REASON.length).toBeLessThanOrEqual(500);
  });

  // Kept separate from the equality above on purpose: these leading bytes are
  // the ADR-004 control-3 reversal path, not prose. class-b-dry-run §D undoes
  // a bad run with
  //   UPDATE agents SET status='idle', error_reason=NULL
  //   WHERE error_reason LIKE 'Adapter credential/config fault:%'
  // so an edit that rewrites the message tail must not quietly take the
  // prefix with it.
  it("keys the documented bulk-undo prefix", () => {
    expect(
      FALSE_LIVENESS_ERROR_REASON.startsWith("Adapter credential/config fault: "),
    ).toBe(true);
  });
});
