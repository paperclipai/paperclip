// Golden set for the SPC filter (spc.ts). Labelled metric series — clear noise, clear signal,
// trend, run, direction-filtered good moves, and edge cases. These are the ground truth the filter
// is graded against (build-notes §2: "build it first ... it must be right").
//
// The hard requirements this set encodes:
//   * MUST NOT promote common-cause noise (even the worst-so-far point if it's within limits).
//   * MUST NOT promote a GOOD outlier (a favourable move on the not-bad side).
//   * MUST promote a real special-cause signal (beyond-limits, a 7-run, or a monotonic trend).

import type { Direction, SpcClassification } from "./spc.js";

export interface SpcCase {
  key: string;
  series: number[];
  direction: Direction;
  expect: SpcClassification;
  /** Optional: a specific rule that must appear among rulesFired (when expect==='signal'). */
  expectRule?: string;
  why: string;
}

export const SPC_GOLDEN: SpcCase[] = [
  // ── clear noise: a red-looking dip that is still common-cause ─────────────────
  {
    key: "N1-worst-but-in-limits",
    // baseline ~100 with σ≈2.4, so LCL≈93; 96 is the lowest point yet but still inside the limits.
    series: [100, 104, 97, 101, 99, 103, 98, 100, 96],
    direction: "lower_is_bad",
    expect: "noise",
    why: "96 is the lowest point but inside mean±3σ of a stable ~100 process; tuning on it would be tampering",
  },
  {
    key: "N2-symmetric-wiggle",
    series: [50, 52, 48, 51, 49, 53, 47, 50, 52, 48],
    direction: "both",
    expect: "noise",
    why: "stationary oscillation around 50; latest 48 is ordinary common-cause variation",
  },
  {
    key: "N3-good-outlier-ignored",
    series: [20, 22, 19, 21, 20, 23, 18, 6],
    direction: "higher_is_bad",
    expect: "noise",
    why: "metric where HIGH is bad just dropped far LOW (a good move) — must NOT become an Issue",
  },
  {
    key: "N4-zero-variance-stable",
    series: [10, 10, 10, 10, 10, 10],
    direction: "both",
    expect: "noise",
    why: "perfectly flat process, latest equals the mean — nothing to discuss",
  },

  // ── clear signal: beyond the control limits ──────────────────────────────────
  {
    key: "S1-beyond-3sigma-low",
    series: [100, 102, 98, 101, 99, 103, 97, 100, 60],
    direction: "lower_is_bad",
    expect: "signal",
    expectRule: "beyond_limit_low",
    why: "60 is far below LCL of a tight ~100 process — special cause, route to IDS",
  },
  {
    key: "S2-beyond-3sigma-high",
    series: [5, 6, 4, 5, 6, 4, 5, 6, 40],
    direction: "higher_is_bad",
    expect: "signal",
    expectRule: "beyond_limit_high",
    why: "40 vs a ~5 process is a clear high-side special cause (e.g. error rate spike)",
  },
  {
    key: "S3-zero-variance-break",
    series: [10, 10, 10, 10, 10, 7],
    direction: "lower_is_bad",
    expect: "signal",
    expectRule: "beyond_limit_low",
    why: "a perfectly stable process suddenly deviates on the bad side — special cause by definition",
  },

  // ── clear signal: a run of 7 on one side of the mean (no point beyond limits) ──
  {
    key: "S4-run-7-below",
    // baseline spans both sides so the mean sits ~mid; then 7 straight below-mean points, all in-limits.
    series: [12, 8, 11, 9, 13, 7, 10, 9.4, 9.3, 9.2, 9.1, 9.0, 8.9, 8.8],
    direction: "lower_is_bad",
    expect: "signal",
    expectRule: "run_7_below_mean",
    why: "no single point is beyond 3σ, but 7 consecutive points below the mean = a shifted process",
  },

  // ── clear signal: a monotonic downward trend ─────────────────────────────────
  {
    key: "S5-trend-down",
    series: [100, 98, 100, 99, 101, 100, 98, 95, 92, 89, 86, 83],
    direction: "lower_is_bad",
    expect: "signal",
    expectRule: "trend_6_down",
    why: "the last 6+ points decline monotonically — drift toward trouble, catch it before it breaches",
  },

  // ── direction discipline: a downward run on a metric where LOW is fine ────────
  {
    key: "N5-run-down-but-low-is-good",
    series: [12, 8, 11, 9, 13, 7, 10, 9.4, 9.3, 9.2, 9.1, 9.0, 8.9, 8.8],
    direction: "higher_is_bad",
    expect: "noise",
    why: "same 7-below-mean run as S4, but here LOW is good — the run is on the good side, do not promote",
  },

  // ── edge cases ───────────────────────────────────────────────────────────────
  {
    key: "E1-insufficient-data",
    series: [100, 60],
    direction: "lower_is_bad",
    expect: "insufficient_data",
    why: "2 points cannot establish control limits; promoting would be a false alarm on noise",
  },
  {
    key: "E2-just-enough-baseline-signal",
    series: [100, 100, 100, 100, 50],
    direction: "lower_is_bad",
    expect: "signal",
    expectRule: "beyond_limit_low",
    why: "exactly minBaseline(4)+1 points; the 5th is a clear beyond-limits special cause",
  },
];
