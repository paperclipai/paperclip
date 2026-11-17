import type { heartbeatRuns } from "@paperclipai/db";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "startedAt" | "lastOutputAt" | "processPid" | "processGroupId">;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCAL_CHECKS = ["not_observed_alive", "not_checked", "no_identifiers"] as const;

export interface ProcessLossDiagnostic {
  pidRecorded: boolean;
  groupRecorded: boolean;
  localCheck: typeof LOCAL_CHECKS[number];
  retryEligible: boolean;
  runPredatesObserver?: boolean;
  /** The run's recorded owner was another server boot: a restart or replacement ended it. */
  controllerReplaced?: boolean;
  lastOutputAgeMs?: number;
  observerUptimeMs?: number;
}

function age(now: number, then: number | undefined): number | undefined {
  if (then === undefined) return undefined;
  const elapsed = now - then;
  return Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= MAX_AGE_MS
    ? elapsed : undefined;
}

/** Snapshot before status writes and cleanup. Never infer why ownership was lost. */
export function buildProcessLossDiagnostic(input: {
  run: Run;
  nowMs: number;
  observerStartedAtMs: number;
  checksPersistedChildLiveness: boolean;
  retryEligible: boolean;
  controllerReplaced?: boolean;
}): ProcessLossDiagnostic {
  const { run, nowMs, observerStartedAtMs } = input;
  const pidRecorded = !!run.processPid;
  const groupRecorded = !!run.processGroupId;
  const startedAt = run.startedAt?.getTime();
  const validObserverStart = Number.isFinite(observerStartedAtMs) && observerStartedAtMs <= nowMs;
  const lastOutputAgeMs = age(nowMs, run.lastOutputAt?.getTime());
  const observerUptimeMs = validObserverStart ? age(nowMs, Math.floor(observerStartedAtMs)) : undefined;
  return {
    pidRecorded,
    groupRecorded,
    localCheck: !pidRecorded && !groupRecorded ? "no_identifiers"
      : input.checksPersistedChildLiveness ? "not_observed_alive" : "not_checked",
    retryEligible: input.retryEligible,
    ...(validObserverStart && startedAt !== undefined && Number.isFinite(startedAt) && startedAt <= nowMs
      ? { runPredatesObserver: startedAt < observerStartedAtMs } : {}),
    ...(input.controllerReplaced !== undefined ? { controllerReplaced: input.controllerReplaced } : {}),
    ...(lastOutputAgeMs !== undefined ? { lastOutputAgeMs } : {}),
    ...(observerUptimeMs !== undefined ? { observerUptimeMs } : {}),
  };
}

/** Persisted adapter data is untrusted. Only closed labels, booleans and ages leave the instance. */
export function readProcessLossDiagnostic(value: unknown): Partial<ProcessLossDiagnostic> {
  const result: Partial<ProcessLossDiagnostic> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const read = (key: string): unknown => {
    try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
  };
  for (const key of ["pidRecorded", "groupRecorded", "retryEligible", "runPredatesObserver", "controllerReplaced"] as const) {
    const entry = read(key);
    if (typeof entry === "boolean") result[key] = entry;
  }
  const localCheck = read("localCheck");
  if (LOCAL_CHECKS.some(check => check === localCheck)) result.localCheck = localCheck as ProcessLossDiagnostic["localCheck"];
  for (const key of ["lastOutputAgeMs", "observerUptimeMs"] as const) {
    const entry = read(key);
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= MAX_AGE_MS) result[key] = entry;
  }
  return result;
}
