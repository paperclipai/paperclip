/** Session totals are monotonic observations, not additional billable receipts. */
export interface CodexUsageBaseline {
  baseline: Record<string, number>;
  latest: Record<string, number>;
  /** Totals the current run has accounted for. Usage above this at attachment
   * was never charged, so it stays in the next run's delta and is not lost. */
  accounted?: Record<string, number>;
}

export function codexUsageMeasurement(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] >= 0,
    ),
  );
}

export function observeCodexUsage(
  state: CodexUsageBaseline | null,
  total: unknown,
  historical: boolean,
): CodexUsageBaseline {
  const measurement = codexUsageMeasurement(total);
  const baseline = state?.baseline ?? (historical ? measurement : {});
  const latest = { ...state?.latest };
  for (const [key, value] of Object.entries(measurement)) {
    latest[key] = Math.max(latest[key] ?? 0, value);
  }
  return { baseline, latest, ...(state?.accounted ? { accounted: state.accounted } : {}) };
}

export function codexUsageBaselineForNextRun(state: CodexUsageBaseline): CodexUsageBaseline {
  return {
    baseline: { ...(state.accounted ?? state.latest) },
    latest: { ...state.latest },
    ...(state.accounted ? { accounted: { ...state.accounted } } : {}),
  };
}

export function codexRunUsage(
  state: CodexUsageBaseline,
): Record<string, unknown> {
  return {
    total: state.latest,
    runDelta: Object.fromEntries(
      Object.entries(state.latest).map(([key, value]) => [
        key,
        Math.max(0, value - (state.baseline[key] ?? 0)),
      ]),
    ),
  };
}
