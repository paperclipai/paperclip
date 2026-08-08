import { Ban, Clock, LifeBuoy, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueScheduledRetry,
  IssueStatus,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  deriveNextAction,
  type NextActionAccent,
  type NextActionLane,
  type NextActionReference,
  type NextActionSummary,
} from "../lib/next-action";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";

/** Left-accent hue per lane. All values are tokens — never raw color literals. */
const ACCENT_VAR: Record<NextActionAccent, string> = {
  in_progress: "var(--status-task-in_progress)",
  in_review: "var(--status-task-in_review)",
  todo: "var(--status-task-todo)",
  blocked: "var(--status-task-blocked)",
  recovery_amber: "var(--status-task-todo)",
  recovery_sky: "var(--status-task-in_progress)",
  recovery_red: "var(--status-task-blocked)",
  none: "var(--border)",
};

const LANE_ICON: Record<NextActionLane, LucideIcon> = {
  working_now: Play,
  recovery: LifeBuoy,
  waiting_decision: Clock,
  blocked_real_work: Ban,
  none: Clock,
};

function ReferenceChip({ reference }: { reference: NextActionReference }) {
  const { ref, label, gate } = reference;
  const issuePathId = ref.identifier ?? ref.id;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <IssueLinkQuicklook
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-0.5 font-mono text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:underline"
      >
        <span>{ref.identifier ?? ref.id.slice(0, 8)}</span>
        <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-muted-foreground">
          {ref.title}
        </span>
      </IssueLinkQuicklook>
      {gate ? (
        <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
          {gate}
        </span>
      ) : null}
    </span>
  );
}

export interface IssueNextActionCardProps {
  status: IssueStatus;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  scheduledRetry?: IssueScheduledRetry | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  blockerDiagnostics?: IssueBlockerDiagnosticsResponse | null;
  hasLiveRun?: boolean;
  /** Error from loading blocker diagnostics; surfaced so failures are visible. */
  diagnosticsError?: string | null;
  /** Render even when there is no special next action (lane "none"). */
  showWhenOnTrack?: boolean;
  className?: string;
}

/**
 * The consolidated "what moves this forward next" panel resolves the task
 * into exactly one of four lanes
 * and renders it as a neutral card with a lane-hued left accent.
 */
export function IssueNextActionCard({
  status,
  blockedInboxAttention,
  activeRecoveryAction,
  scheduledRetry,
  successfulRunHandoff,
  blockerDiagnostics,
  hasLiveRun,
  diagnosticsError,
  showWhenOnTrack = false,
  className,
}: IssueNextActionCardProps) {
  const summary: NextActionSummary = deriveNextAction({
    status,
    blockedInboxAttention,
    activeRecoveryAction,
    scheduledRetry,
    successfulRunHandoff,
    blockerDiagnostics,
    hasLiveRun,
  });

  if (summary.lane === "none" && !showWhenOnTrack && !diagnosticsError) {
    return null;
  }

  const accent = ACCENT_VAR[summary.accent];
  const Icon = LANE_ICON[summary.lane];
  const control = summary.primaryControl;

  return (
    <div
      role="status"
      data-testid="issue-next-action-card"
      data-next-action-lane={summary.lane}
      data-next-action-accent={summary.accent}
      data-terminal-gate={summary.terminalGate ? "true" : undefined}
      data-recovery-debt={summary.recoveryDebt ? "true" : undefined}
      style={{ borderLeftColor: accent, borderLeftWidth: "var(--sz-4px)" }}
      className={`rounded-md border border-border bg-card text-card-foreground px-3 py-2.5 shadow-sm ${className ?? ""}`}
    >
      {/* 1. Lane chip */}
      <div className="flex items-center gap-1.5">
        {summary.live ? (
          <span className="relative flex h-2 w-2" aria-hidden>
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
              style={{ backgroundColor: accent }}
            />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
          </span>
        ) : (
          <Icon className="h-3.5 w-3.5" style={{ color: accent }} aria-hidden />
        )}
        <span
          className="text-(length:--text-micro) font-semibold uppercase tracking-wide"
          style={{ color: accent }}
        >
          {summary.laneLabel}
        </span>
      </div>

      {/* 2. Statement — the answer */}
      <p className="mt-1 text-sm font-semibold leading-5 text-foreground">{summary.statement}</p>

      {/* 3. Why line */}
      {summary.why ? (
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {summary.owner ? (
            <>
              <span className="font-medium text-foreground">{summary.owner.label}</span>
              {" · "}
            </>
          ) : null}
          {summary.why}
        </p>
      ) : null}

      {/* 4. Action row: primary control + reference chips */}
      {(control?.ref || summary.references.length > 0) ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {control?.ref ? (
            <Link
              to={createIssueDetailPath(control.ref.identifier ?? control.ref.id)}
              data-testid="issue-next-action-primary-control"
              data-control-kind={control.kind}
              className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted"
            >
              {control.label}
            </Link>
          ) : null}
          {summary.references.map((reference) => (
            <ReferenceChip key={`${reference.label}-${reference.ref.id}`} reference={reference} />
          ))}
        </div>
      ) : null}

      {/* 5. Provenance meta */}
      <p className="mt-1.5 font-mono text-(length:--text-nano) text-muted-foreground">
        resolved from {summary.resolvedFrom}
      </p>

      {diagnosticsError ? (
        <p
          data-testid="issue-next-action-diagnostics-error"
          className="mt-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs leading-5 text-foreground"
          style={{ borderLeftColor: "var(--status-task-blocked)", borderLeftWidth: "var(--sz-3px)" }}
        >
          Couldn&apos;t load full blocker diagnostics: {diagnosticsError}
        </p>
      ) : null}
    </div>
  );
}
