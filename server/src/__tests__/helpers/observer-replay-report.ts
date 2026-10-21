// Test evidence only. Keep observation load beside timing and query counts.
export interface ObserverLoad {
  activeViewers: { start: number; end: number; min: number; max: number };
  activeSubscribers: { start: number; end: number; min: number; max: number };
  diagnosticSubscribers: number;
  transport: "authenticated_websocket";
  polling: {
    applicability: "applicable" | "not_applicable";
    reason: "scheduled_log_reads" | "push_only" | "no_viewers";
    cadenceMs: number | null;
    firstBatchDelayAfterWorkMs: number;
    completedBatches: number;
    offsetsMs: number[][];
  };
}

export interface ObserverReplayMeasurement {
  id: string;
  fixture: string;
  zeroViewerControlId: string;
  observers: ObserverLoad;
  interval: { startedAt: string; finishedAt: string; wallMs: number; workMs: number };
  queries: { persistence: number; viewerDelivery: number; polling: number; visibilityProof: number; total: number };
  correctness: {
    committedEvents: number;
    durableEvents: number;
    duplicateReceipts: number;
    deliveriesPerViewer: number[];
    durableOutput: boolean;
    orderedEvents: boolean;
    duplicateReplay: boolean;
    safeViewerPayloads: boolean;
  };
}

export function compareObserverReplays(
  baseline: ObserverReplayMeasurement,
  candidate: ObserverReplayMeasurement,
  axis: "implementation" | "observation_load" = "implementation",
) {
  const differences: string[] = [];
  if (baseline.fixture !== candidate.fixture) differences.push("fixture");
  for (const field of ["activeViewers", "activeSubscribers", "diagnosticSubscribers", "transport"] as const) {
    if (JSON.stringify(baseline.observers[field]) !== JSON.stringify(candidate.observers[field])) differences.push(field);
  }
  // Actual offsets describe scheduling jitter. Compare the configured cadence,
  // not the number of reads accumulated in differently sized timing windows.
  if (baseline.observers.polling.cadenceMs !== candidate.observers.polling.cadenceMs ||
      baseline.observers.polling.firstBatchDelayAfterWorkMs !== candidate.observers.polling.firstBatchDelayAfterWorkMs ||
      baseline.observers.polling.applicability !== candidate.observers.polling.applicability) differences.push("polling");
  const stable = [baseline, candidate].every(({ observers }) =>
    [observers.activeViewers, observers.activeSubscribers].every(count =>
      count.start === count.end && count.start === count.min && count.start === count.max));
  if (!stable) differences.push("observer_churn");
  const status = differences.length === 0 ? "matched"
    : axis === "observation_load" && stable && !differences.includes("fixture") ? "observation_experiment"
      : "unmatched";
  return {
    baselineId: baseline.id, candidateId: candidate.id, axis, status, differences,
    // Never attribute a performance ratio to a confounded implementation pair.
    timingBasis: "interval.workMs",
    wallTimeRatio: status === "matched" && baseline.interval.workMs > 0
      ? candidate.interval.workMs / baseline.interval.workMs : null,
  };
}
