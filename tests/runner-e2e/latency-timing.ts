/** Probe timing is an interval, never the timestamp of the poll that found it. */
export type LatencyEvent = "acknowledgement" | "first_visible_response" | "message_creation" | "final_settlement";
export type LatencyVerdict = "pass" | "fail" | "inconclusive";
export interface TimingBound { ms: number; inclusive: boolean }
export interface LatencyTarget { operator: "<" | "<="; ms: number }
export interface LatencyEvidence {
  event: LatencyEvent;
  interval: { lower: TimingBound | null; upper: TimingBound | null };
  lastAbsentMs: number | null;
  firstPresentMs: number | null;
  /** Conservative uncertainty on each elapsed observation; null means unknown. */
  resolutionMs: number | null;
  invalid?: boolean;
  observationFailures?: number;
  /** Reads abandoned when the browser observer's shutdown deadline expires. */
  observationTimeouts?: number;
  /** Provider wall-clock metadata is retained separately and never measures visibility. */
  messageTimestamps?: { createdAt?: string; editedAt?: string };
}
export interface LatencyResult extends LatencyEvidence {
  target: LatencyTarget;
  verdict: LatencyVerdict;
  /** Original retained verdict, if report regeneration corrects the timing grade. */
  recordedVerdict?: LatencyVerdict;
  reason: "within_target" | "outside_target" | "threshold_overlap" | "missing_observations" | "invalid_evidence" | "unknown_resolution";
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function classifyLatency(evidence: LatencyEvidence, target: LatencyTarget): LatencyResult {
  const { lower, upper } = evidence.interval ?? {};
  const result = (verdict: LatencyVerdict, reason: LatencyResult["reason"]): LatencyResult =>
    ({ ...evidence, target, verdict, reason });
  const validBound = (bound: TimingBound | null) => bound === null
    || (bound && nonnegative(bound.ms) && typeof bound.inclusive === "boolean");
  if (evidence.invalid || !nonnegative(target.ms) || !["<", "<="].includes(target.operator)
    || !validBound(lower) || !validBound(upper)
    || (evidence.lastAbsentMs !== null && !nonnegative(evidence.lastAbsentMs))
    || (evidence.firstPresentMs !== null && !nonnegative(evidence.firstPresentMs))
    || (evidence.lastAbsentMs !== null && evidence.firstPresentMs !== null && evidence.lastAbsentMs > evidence.firstPresentMs)
    || (lower && upper && (lower.ms > upper.ms || (lower.ms === upper.ms && !(lower.inclusive && upper.inclusive))))
    || (evidence.resolutionMs !== null && !nonnegative(evidence.resolutionMs))) {
    return result("inconclusive", "invalid_evidence");
  }
  if (evidence.resolutionMs === null) return result("inconclusive", "unknown_resolution");
  if (!lower && !upper) return result("inconclusive", "missing_observations");
  if (upper && (upper.ms < target.ms || (upper.ms === target.ms && (target.operator === "<=" || !upper.inclusive)))) {
    return result("pass", "within_target");
  }
  if (lower && (lower.ms > target.ms || (lower.ms === target.ms && (target.operator === "<" || !lower.inclusive)))) {
    return result("fail", "outside_target");
  }
  return result("inconclusive", "threshold_overlap");
}

export function observationTiming(input: Omit<LatencyEvidence, "interval">): LatencyEvidence {
  const uncertainty = input.resolutionMs ?? 0;
  return {
    ...input,
    interval: {
      lower: input.lastAbsentMs === null ? null : { ms: Math.max(0, input.lastAbsentMs - uncertainty), inclusive: input.lastAbsentMs - uncertainty < 0 },
      upper: input.firstPresentMs === null ? null : { ms: input.firstPresentMs + uncertainty, inclusive: true },
    },
  };
}

/** Arm immediately before dispatch. Inject a monotonic clock for deterministic tests.
 * The predicate must describe a persistent event (or a latched event observer).
 * A missing/failed read is not an absent observation. */
export function armLatencyProbe(input: {
  event: LatencyEvent;
  target: LatencyTarget;
  resolutionMs: number;
  now?: () => number;
}) {
  const now = input.now ?? (() => performance.now());
  const start = now();
  let lastClock = start;
  let invalid = !Number.isFinite(start);
  let lastAbsentMs: number | null = null;
  let firstPresentMs: number | null = null;
  let observationFailures = 0;
  let messageTimestamps: LatencyEvidence["messageTimestamps"];
  const elapsed = () => {
    const current = now();
    if (!Number.isFinite(current) || current < lastClock) invalid = true;
    lastClock = current;
    return current - start;
  };
  type Observation = { present: boolean; messageTimestamps?: LatencyEvidence["messageTimestamps"] };
  const beginObservation = () => {
    const before = elapsed();
    let completed = false;
    return (observation: Observation) => {
      if (completed) throw new Error("Observation already completed");
      completed = true;
      const after = elapsed();
      if (typeof observation.present !== "boolean" || after < before) invalid = true;
      // Concurrent or late reads cannot replace the first positive observation.
      if (firstPresentMs !== null) return;
      if (observation.present) {
        firstPresentMs = after;
        messageTimestamps = observation.messageTimestamps;
      } else {
        lastAbsentMs = Math.max(lastAbsentMs ?? 0, before);
      }
    };
  };
  return {
    beginObservation,
    async sample(load: () => Promise<Observation>) {
      if (firstPresentMs !== null) return;
      const complete = beginObservation();
      try { complete(await load()); }
      catch (error) { observationFailures++; throw error; }
    },
    result(): LatencyResult {
      return classifyLatency(observationTiming({ event: input.event, lastAbsentMs, firstPresentMs,
        resolutionMs: input.resolutionMs, ...(invalid ? { invalid: true } : {}),
        ...(observationFailures ? { observationFailures } : {}),
        ...(messageTimestamps ? { messageTimestamps } : {}) }), input.target);
    },
  };
}

export function latencyIntervalLabel(evidence: LatencyEvidence): string {
  const { lower, upper } = evidence.interval;
  return `${lower?.inclusive ? "[" : "("}${lower?.ms ?? "unknown"}, ${upper?.ms ?? "unknown"}${upper?.inclusive ? "]" : ")"} ms`;
}
