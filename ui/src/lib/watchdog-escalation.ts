import type { Issue, IssueWatchdogSummary } from "@paperclipai/shared";

/**
 * Mirrors the server's `TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS` (server/src/services/task-watchdogs.ts).
 * The read model doesn't carry the limit, so the escalation card references this UI constant to render
 * "N of {max} attempts". Keep in sync with the server if the budget changes.
 */
export const WATCHDOG_MAX_RESTORATION_ATTEMPTS = 3;

export interface WatchdogAttemptView {
  attempt: number;
  completedAt: string | null;
  runId: string | null;
  fingerprint: string;
  /** True when this attempt's stop fingerprint matches the escalation fingerprint (the leaf never moved). */
  fingerprintUnchanged: boolean;
  /** Human summary of the writes this attempt made (e.g. "commented on PAP-1234, set PAP-5678 → todo"). */
  mutationSummary: string;
}

export interface WatchdogEscalationView {
  escalated: boolean;
  attemptCount: number;
  maxAttempts: number;
  fingerprint: string | null;
  fingerprintShort: string | null;
  /** True when every recorded attempt shares one fingerprint — the incident's "nothing moved" signature. */
  fingerprintUnchangedAcrossAttempts: boolean;
  watchdogAgentId: string | null;
  escalatedAt: string | null;
  attempts: WatchdogAttemptView[];
}

/** An exhausted-watchdog escalation (P4): recovery action escalated, or the watchdog recorded an escalation. */
export function isWatchdogEscalated(issue: Pick<Issue, "activeRecoveryAction" | "watchdog">): boolean {
  return (
    issue.activeRecoveryAction?.status === "escalated" ||
    Boolean(issue.watchdog?.restorationEscalatedAt)
  );
}

function shortFingerprint(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  const cleaned = fingerprint.trim();
  if (!cleaned) return null;
  return cleaned.length > 8 ? `${cleaned.slice(0, 8)}…` : cleaned;
}

function shortIssueId(value: unknown): string {
  return typeof value === "string" && value.length > 8 ? value.slice(0, 8) : String(value ?? "task");
}

/** Turn one persisted recovery mutation record into a short human phrase. */
function summarizeMutation(mutation: Record<string, unknown>): string {
  const type = typeof mutation.type === "string" ? mutation.type : null;
  const target = shortIssueId(mutation.issueId);
  if (type === "add_comment") return `commented on ${target}`;
  if (type === "update_issue") {
    const update = mutation.update;
    const status =
      update && typeof update === "object" && "status" in update
        ? (update as { status?: unknown }).status
        : undefined;
    if (typeof status === "string" && status) return `set ${target} → ${status}`;
    return `updated ${target}`;
  }
  return type ? type.replaceAll("_", " ") : "write";
}

function summarizeMutations(mutations: unknown): string {
  if (!Array.isArray(mutations) || mutations.length === 0) return "no restoration write recorded";
  return mutations
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map(summarizeMutation)
    .join(", ");
}

/**
 * Build the escalation card view-model from an issue's watchdog summary. Returns `null` when there's
 * no watchdog to describe. `escalated` distinguishes an exhausted escalation (render the card) from a
 * merely-triggered watchdog (don't).
 */
export function buildWatchdogEscalationView(
  issue: Pick<Issue, "activeRecoveryAction" | "watchdog">,
): WatchdogEscalationView | null {
  const watchdog: IssueWatchdogSummary | null | undefined = issue.watchdog;
  if (!watchdog) return null;

  const attempts: WatchdogAttemptView[] = (watchdog.restorationAttempts ?? []).map((entry) => ({
    attempt: entry.attempt,
    completedAt: entry.completedAt ?? null,
    runId: entry.runId ?? null,
    fingerprint: entry.fingerprint,
    fingerprintUnchanged: watchdog.restorationFingerprint
      ? entry.fingerprint === watchdog.restorationFingerprint
      : false,
    mutationSummary: summarizeMutations(entry.mutations),
  }));

  const uniqueFingerprints = new Set(attempts.map((attempt) => attempt.fingerprint));
  const escalatedAt = watchdog.restorationEscalatedAt
    ? new Date(watchdog.restorationEscalatedAt).toISOString()
    : null;

  return {
    escalated: isWatchdogEscalated(issue),
    attemptCount: watchdog.restorationAttemptCount ?? attempts.length,
    maxAttempts: WATCHDOG_MAX_RESTORATION_ATTEMPTS,
    fingerprint: watchdog.restorationFingerprint,
    fingerprintShort: shortFingerprint(watchdog.restorationFingerprint),
    fingerprintUnchangedAcrossAttempts: attempts.length > 1 && uniqueFingerprints.size === 1,
    watchdogAgentId: watchdog.watchdogAgentId ?? null,
    escalatedAt,
    attempts,
  };
}
