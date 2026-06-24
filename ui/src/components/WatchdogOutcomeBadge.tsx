import type { IssueWatchdogProofOutcome } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * Watchdog proof-outcome vocabulary badge (PAP-11887 / Phase 3b).
 *
 * Co-located with {@link StatusBadge} but kept separate because the five-outcome
 * vocabulary (accepted | restored | deferred | failed | dismissed) is
 * watchdog-specific and is reused by the pinned thread callout and the
 * IssueProperties sidebar readout. Tone mapping follows the Phase 3a UX spec:
 * emerald = accepted/restored, amber = deferred, red = failed, neutral =
 * dismissed.
 */
type OutcomeTone = {
  badge: string;
  dot: string;
  verb: string;
};

const OUTCOME_TONE: Record<IssueWatchdogProofOutcome, OutcomeTone> = {
  accepted: {
    verb: "Accepted",
    dot: "bg-emerald-500",
    badge:
      "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200",
  },
  restored: {
    verb: "Restored",
    dot: "bg-teal-500",
    badge:
      "border-teal-300/70 bg-teal-50 text-teal-800 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200",
  },
  deferred: {
    verb: "Deferred",
    dot: "bg-amber-500",
    badge:
      "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  },
  failed: {
    verb: "Failed",
    dot: "bg-red-500",
    badge:
      "border-red-300/70 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
  },
  dismissed: {
    verb: "Dismissed",
    dot: "bg-muted-foreground/60",
    badge:
      "border-border bg-muted/60 text-muted-foreground dark:bg-muted/30",
  },
};

export function watchdogOutcomeVerb(outcome: IssueWatchdogProofOutcome): string {
  return OUTCOME_TONE[outcome]?.verb ?? outcome;
}

export function watchdogOutcomeDotClass(outcome: IssueWatchdogProofOutcome): string {
  return OUTCOME_TONE[outcome]?.dot ?? "bg-muted-foreground/60";
}

export function WatchdogOutcomeBadge({
  outcome,
  className,
}: {
  outcome: IssueWatchdogProofOutcome;
  className?: string;
}) {
  const tone = OUTCOME_TONE[outcome] ?? OUTCOME_TONE.dismissed;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone.badge,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
      {tone.verb}
    </span>
  );
}

export default WatchdogOutcomeBadge;
