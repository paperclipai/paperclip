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

export type SuppressionSignals = {
  snoozedOrContinued?: boolean;
  recoveryOriginSource?: boolean;
  blockedSource?: boolean;
  dismissedFalsePositive?: boolean;
};

export type SuppressionReason =
  | "snoozed"
  | "recovery_origin_source"
  | "blocked_source"
  | "dismissed_false_positive";

export type SuppressionResult =
  | { suppressed: false }
  | { suppressed: true; reason: SuppressionReason };

/**
 * Decides whether a signal on a silent active run suppresses recovery work.
 * The caller passes only the signals it has resolved at its call site; an
 * unresolved signal must be left `undefined`, not `false`, so this function
 * checks each rule in a fixed priority order and returns the first match.
 */
export function evaluateSuppression(signals: SuppressionSignals): SuppressionResult {
  if (signals.snoozedOrContinued) return { suppressed: true, reason: "snoozed" };
  if (signals.recoveryOriginSource) return { suppressed: true, reason: "recovery_origin_source" };
  if (signals.blockedSource) return { suppressed: true, reason: "blocked_source" };
  if (signals.dismissedFalsePositive) return { suppressed: true, reason: "dismissed_false_positive" };
  return { suppressed: false };
}

export function isTerminalIssueStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

export type ShouldFoldTerminalSourceInput = {
  sourceIssueStatus: string | null | undefined;
  hasSameRunTerminalEvidence: boolean;
};

/**
 * A terminal source issue folds the watchdog run only when durable,
 * same-run evidence shows the issue already reached that terminal status
 * from an action inside this run. A terminal status alone is not enough
 * evidence; a different run or a different actor could have closed it.
 */
export function shouldFoldTerminalSource(input: ShouldFoldTerminalSourceInput): boolean {
  return isTerminalIssueStatus(input.sourceIssueStatus) && input.hasSameRunTerminalEvidence;
}
