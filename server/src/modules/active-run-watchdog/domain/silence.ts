export type RunSilenceTimestamps = {
  lastOutputAt: Date | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
};

export type SilenceLevel = "not_applicable" | "ok" | "snoozed" | "suspicious" | "critical";

export type ClassifySilenceLevelInput = {
  isRunningRun: boolean;
  silenceAgeMs: number | null;
  dismissedFalsePositive: boolean;
  snoozed: boolean;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
};

/**
 * Picks the timestamp the silence clock started counting from. The order is
 * the last output time, then the process start time, then the run start
 * time, then the run creation time.
 */
export function silenceStartedAt(run: RunSilenceTimestamps): Date | null {
  return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
}

export function silenceAgeMs(run: RunSilenceTimestamps, now: Date): number | null {
  const startedAt = silenceStartedAt(run);
  return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
}

export function classifySilenceLevel(input: ClassifySilenceLevelInput): SilenceLevel {
  if (!input.isRunningRun) return "not_applicable";
  if (input.dismissedFalsePositive) return "not_applicable";
  if (input.snoozed) return "snoozed";
  const age = input.silenceAgeMs ?? 0;
  if (age >= input.criticalThresholdMs) return "critical";
  if (age >= input.suspicionThresholdMs) return "suspicious";
  return "ok";
}
