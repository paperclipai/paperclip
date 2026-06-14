// Bounded in-memory counters for dep-blocked wake coalescing. These reset on
// process restart and are intended for operational visibility, not persistence.
// Counter names mirror the heartbeat outcome kinds surfaced in structured logs.

export type DepBlockedMetricKey =
  | "dep_blocked_scheduled"
  | "dep_blocked_coalesced"
  | "dep_blocked_reset"
  | "dep_blocked_promoted"
  | "dep_blocked_redeferred"
  | "dep_blocked_exhausted";

const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

const counters: Record<DepBlockedMetricKey, number> = {
  dep_blocked_scheduled: 0,
  dep_blocked_coalesced: 0,
  dep_blocked_reset: 0,
  dep_blocked_promoted: 0,
  dep_blocked_redeferred: 0,
  dep_blocked_exhausted: 0,
};

export function incrementDepBlockedMetric(key: DepBlockedMetricKey): void {
  if (counters[key] < MAX_COUNTER_VALUE) {
    counters[key] += 1;
  }
}

export function getDepBlockedMetric(key: DepBlockedMetricKey): number {
  return counters[key];
}

export function resetDepBlockedMetrics(): void {
  for (const key of Object.keys(counters) as DepBlockedMetricKey[]) {
    counters[key] = 0;
  }
}

export function snapshotDepBlockedMetrics(): Record<DepBlockedMetricKey, number> {
  return { ...counters };
}
