// The SPC filter — segment 2's load-bearing pure function (meeting-flow.md §2 + 02b §4).
//
// A "red" number is NOT automatically an Issue. We compute Shewhart control limits (mean ± kσ)
// over the metric's recent history and decide noise vs signal:
//   * a point INSIDE the limits with no run/trend  = common-cause noise  -> do NOT promote to IDS
//     (Deming: tuning on noise makes the process worse).
//   * a point OUTSIDE the limits, or a run/trend    = special-cause      -> promote to a meeting_issue.
//
// This gates whether an issue enters IDS at all: a false signal wastes IDS tokens; a missed signal
// lets a real problem through. So it is pure, deterministic, and has its own golden set (spc.golden.ts),
// proven before anything downstream is built.
//
// Design decisions (documented because they are load-bearing):
//  - Limits are computed from a BASELINE = the series EXCLUDING the current (latest) point, so a single
//    large anomaly cannot inflate σ and hide itself. The latest point is then tested against those limits.
//  - DIRECTION matters. A metric usually has a "bad" side (reply-quality dropping is bad; it spiking up
//    is good). We only promote a special-cause excursion on the bad side, so a GOOD outlier is never
//    turned into an Issue. direction='both' treats either side as worth flagging.
//  - Thin data is honest: with fewer than `minBaseline` baseline points we cannot compute trustworthy
//    limits, so we return 'insufficient_data' and do NOT promote (false alarms on 2–3 points are worse
//    than waiting for a real baseline; this is recorded, not hidden).

export type Direction = "higher_is_bad" | "lower_is_bad" | "both";

export interface SpcInput {
  /** Metric values in chronological order (oldest first, newest last). */
  series: number[];
  /** Which side is "bad". Default 'both'. */
  direction?: Direction;
  /** Run-rule length: N consecutive points one side of the mean = signal. Canon: 7. */
  runLength?: number;
  /** Trend-rule length: N consecutive strictly monotonic points = signal. Default 6. */
  trendLength?: number;
  /** Sigma multiplier for the control limits. Default 3 (Shewhart). */
  sigma?: number;
  /** Minimum baseline points required to compute limits. Default 4. */
  minBaseline?: number;
}

export type SpcClassification = "signal" | "noise" | "insufficient_data";

export interface SpcResult {
  classification: SpcClassification;
  /** True iff classification === 'signal' (i.e. this red should become a meeting_issue). */
  promote: boolean;
  /** Which SPC rules fired, e.g. ['beyond_3sigma_low','run_7_below_mean']. */
  rulesFired: string[];
  mean: number;
  /** Baseline sample standard deviation. */
  sigmaHat: number;
  ucl: number;
  lcl: number;
  /** The latest point under test. */
  current: number;
  reason: string;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Sample standard deviation (n-1). Returns 0 for a single point or a perfectly flat baseline.
function sampleStd(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  const ss = xs.reduce((s, x) => s + (x - mu) * (x - mu), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

const badHigh = (d: Direction) => d === "higher_is_bad" || d === "both";
const badLow = (d: Direction) => d === "lower_is_bad" || d === "both";

/**
 * Classify the latest point of a metric series as common-cause noise or special-cause signal.
 * Pure: same input -> same output, no I/O.
 */
export function spcClassify(input: SpcInput): SpcResult {
  const direction: Direction = input.direction ?? "both";
  const runLength = input.runLength ?? 7;
  const trendLength = input.trendLength ?? 6;
  const sigma = input.sigma ?? 3;
  const minBaseline = input.minBaseline ?? 4;
  const series = input.series;

  const empty: Omit<SpcResult, "reason" | "classification" | "promote"> = {
    rulesFired: [],
    mean: NaN,
    sigmaHat: NaN,
    ucl: NaN,
    lcl: NaN,
    current: series.length ? series[series.length - 1] : NaN,
  };

  if (series.length < minBaseline + 1) {
    return {
      ...empty,
      classification: "insufficient_data",
      promote: false,
      reason: `need >= ${minBaseline + 1} points (baseline ${minBaseline} + current); have ${series.length}`,
    };
  }

  const current = series[series.length - 1];
  const baseline = series.slice(0, series.length - 1);
  const mu = mean(baseline);
  const sd = sampleStd(baseline, mu);
  const ucl = mu + sigma * sd;
  const lcl = mu - sigma * sd;
  const rulesFired: string[] = [];

  // Rule 1 — beyond the control limits (special cause). Zero-variance baseline: any deviation from a
  // perfectly stable process on the bad side is, by definition, special cause.
  const high = sd === 0 ? current > mu : current > ucl;
  const low = sd === 0 ? current < mu : current < lcl;
  if (high && badHigh(direction)) rulesFired.push("beyond_limit_high");
  if (low && badLow(direction)) rulesFired.push("beyond_limit_low");

  // Rule 2 — a run of N consecutive points on the same side of the mean (canon: 7-in-a-row).
  if (series.length >= runLength) {
    const tail = series.slice(series.length - runLength);
    if (tail.every((v) => v > mu) && badHigh(direction)) rulesFired.push(`run_${runLength}_above_mean`);
    if (tail.every((v) => v < mu) && badLow(direction)) rulesFired.push(`run_${runLength}_below_mean`);
  }

  // Rule 3 — a monotonic trend of N consecutive points (drift). Increasing trend is bad iff
  // higher_is_bad; decreasing trend is bad iff lower_is_bad.
  if (series.length >= trendLength) {
    const tail = series.slice(series.length - trendLength);
    let inc = true;
    let dec = true;
    for (let i = 1; i < tail.length; i++) {
      if (!(tail[i] > tail[i - 1])) inc = false;
      if (!(tail[i] < tail[i - 1])) dec = false;
    }
    if (inc && badHigh(direction)) rulesFired.push(`trend_${trendLength}_up`);
    if (dec && badLow(direction)) rulesFired.push(`trend_${trendLength}_down`);
  }

  const classification: SpcClassification = rulesFired.length > 0 ? "signal" : "noise";
  return {
    classification,
    promote: classification === "signal",
    rulesFired,
    mean: mu,
    sigmaHat: sd,
    ucl,
    lcl,
    current,
    reason:
      classification === "signal"
        ? `special-cause: ${rulesFired.join(", ")}`
        : `common-cause noise: current ${current} within [${lcl.toFixed(2)}, ${ucl.toFixed(2)}], no run/trend on the bad side`,
  };
}
