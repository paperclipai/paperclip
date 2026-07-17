import { useMemo } from "react";
import type {
  Agent,
  GitWorktreeBranchAncestryVerdict,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";
import {
  Eye,
  GitBranch,
  GitBranchPlus,
  Loader2,
  OctagonAlert,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { agentUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  deriveRecoveryDisplayState,
  type RecoveryDisplayState,
} from "@/lib/recovery-display";

export type RecoveryCardCardState = RecoveryDisplayState;
export const deriveRecoveryCardState = deriveRecoveryDisplayState;

export type RecoveryResolveOutcome =
  | "todo"
  | "done"
  | "in_review"
  | "false_positive_done"
  | "false_positive_in_review";

/**
 * Payload for the "Re-issue on isolated workspace" action (workspace_validation only).
 * The caller composes an isolated-workspace re-issue whose git worktree bases off `baseRef`
 * — the live (checked-out) branch that diverged, or its HEAD sha when the branch is detached.
 */
export interface RecoveryReissueRequest {
  baseRef: string;
  liveBranch: string | null;
  liveHeadSha: string | null;
  expectedBranch: string | null;
}

export interface IssueRecoveryActionCardProps {
  action: IssueRecoveryAction;
  agentMap?: ReadonlyMap<string, Agent>;
  /** Preferred state hint (e.g. observe_only when watchdog tone is requested). Falls back to derived state. */
  forcedState?: RecoveryCardCardState;
  /** Optional click handler for resolve menu actions. If omitted, the buttons are not rendered. */
  onResolve?: (outcome: RecoveryResolveOutcome) => void;
  /**
   * Optional handler for the workspace_validation "Re-issue on isolated workspace" action.
   * Rendered only for a git-worktree branch-incoherence divergence with a resolvable live ref.
   * If omitted, the re-issue button is not shown.
   */
  onReissueIsolated?: (request: RecoveryReissueRequest) => void;
  /** Whether an isolated re-issue is currently in flight (disables the action + shows a spinner). */
  reissuePending?: boolean;
  /** Whether the viewer can run destructive board-only actions (e.g. false-positive dismissal). */
  canFalsePositive?: boolean;
  className?: string;
}

const KIND_LABEL: Record<IssueRecoveryActionKind, string> = {
  missing_disposition: "Missing Disposition",
  stranded_assigned_issue: "Stranded Task",
  workspace_validation: "Workspace Validation",
  configuration_validation: "Configuration Validation",
  active_run_watchdog: "Active Watchdog",
  issue_graph_liveness: "Graph Liveness",
};

const KIND_HEADLINE: Record<IssueRecoveryActionKind, string> = {
  missing_disposition: "This task's run finished, but no next step was chosen.",
  stranded_assigned_issue:
    "Paperclip retried this task's last run and it still has no live execution path.",
  workspace_validation:
    "Paperclip stopped this run because the task's git workspace could not be validated.",
  configuration_validation:
    "Paperclip stopped before dispatching this run because required secret/env bindings are missing.",
  active_run_watchdog:
    "The active run has been silent. Recovery is observing without interrupting it.",
  issue_graph_liveness:
    "Paperclip detected this task lost a live action path. A recovery owner needs to act.",
};

const STATE_TONE: Record<RecoveryCardCardState, {
  label: string;
  containerClass: string;
  iconWrapClass: string;
  iconClass: string;
  labelClass: string;
  Icon: typeof TriangleAlert;
  divider: string;
}> = {
  needed: {
    label: "RECOVERY NEEDED",
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    label: "RECOVERY IN PROGRESS",
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    label: "OBSERVING ACTIVE RUN",
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    label: "RECOVERY ESCALATED",
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    label: "RECOVERY RESOLVED",
    containerClass:
      "border-emerald-300/70 bg-emerald-50/80 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    iconWrapClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    iconClass: "text-emerald-700 dark:text-emerald-300",
    labelClass: "text-emerald-900 dark:text-emerald-200",
    Icon: Sparkles,
    divider: "border-emerald-300/60 dark:border-emerald-500/30",
  },
};

const OUTCOME_LABEL: Record<IssueRecoveryActionOutcome, string> = {
  restored: "restored",
  delegated: "delegated to follow-up",
  false_positive: "false positive",
  blocked: "blocked",
  escalated: "escalated",
  cancelled: "cancelled",
};

function readEvidenceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

function pickEvidenceSummary(action: IssueRecoveryAction): string | null {
  const evidence = action.evidence ?? {};
  const candidates = [
    "summary",
    "detectedProgressSummary",
    "missingDisposition",
    "retryReason",
    "latestRunErrorCode",
    "latestRunStatus",
    "latestIssueStatus",
  ] as const;
  for (const key of candidates) {
    const next = readEvidenceString(evidence[key]);
    if (next) return next;
  }
  return null;
}

function readEvidenceRunId(action: IssueRecoveryAction, key: "sourceRunId" | "correctiveRunId" | "latestRunId") {
  const evidence = action.evidence ?? {};
  const next = readEvidenceString(evidence[key]);
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asAncestryVerdict(value: unknown): GitWorktreeBranchAncestryVerdict | null {
  return value === "ancestor" || value === "diverged" || value === "unknown" ? value : null;
}

function formatShortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/**
 * Diagnosis derived from a workspace_validation recovery action whose underlying failure is a
 * git-worktree branch incoherence. The evidence carries the recorded ("expected") branch, the
 * live ("actual"/checked-out) branch, both HEAD shas, and a server-computed ancestry verdict +
 * plain-language explanation of why the run was declined.
 */
interface WorkspaceDivergence {
  expectedBranch: string | null;
  liveBranch: string | null;
  expectedHeadSha: string | null;
  liveHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict | null;
  plainLanguageReason: string | null;
  cleanliness: "clean" | "dirty" | "unknown" | null;
  /** Ref a re-issue should base off — the live branch when known, else the live HEAD sha. */
  reissueBaseRef: string | null;
}

function readWorkspaceDivergence(action: IssueRecoveryAction): WorkspaceDivergence | null {
  if (action.kind !== "workspace_validation") return null;
  const workspaceValidation = asRecord(action.evidence?.workspaceValidation);
  if (!workspaceValidation) return null;
  if (workspaceValidation.reason !== "git_worktree_branch_incoherence") return null;
  const provenance = asRecord(workspaceValidation.provenance) ?? {};
  const expectedBranch = asNonEmptyString(workspaceValidation.expectedBranch);
  const liveBranch = asNonEmptyString(workspaceValidation.actualBranch);
  const expectedHeadSha = asNonEmptyString(provenance.expectedHeadSha);
  const liveHeadSha = asNonEmptyString(provenance.actualHeadSha);
  const cleanlinessRaw = workspaceValidation.cleanliness;
  const cleanliness =
    cleanlinessRaw === "clean" || cleanlinessRaw === "dirty" || cleanlinessRaw === "unknown"
      ? cleanlinessRaw
      : null;
  return {
    expectedBranch,
    liveBranch,
    expectedHeadSha,
    liveHeadSha,
    ancestryVerdict: asAncestryVerdict(provenance.ancestryVerdict),
    plainLanguageReason: asNonEmptyString(provenance.plainLanguageReason),
    cleanliness,
    reissueBaseRef: liveBranch ?? liveHeadSha,
  };
}

const ANCESTRY_BADGE: Record<
  GitWorktreeBranchAncestryVerdict,
  { label: string; className: string }
> = {
  ancestor: {
    label: "Forward-only",
    className: "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  diverged: {
    label: "Diverged",
    className: "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  unknown: {
    label: "Ancestry unknown",
    className: "border-border bg-muted/60 text-muted-foreground",
  },
};

function BranchFacet({
  label,
  branch,
  sha,
}: {
  label: string;
  branch: string | null;
  sha: string | null;
}) {
  const shortSha = formatShortSha(sha);
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {branch ? (
          <code className="truncate font-mono text-[12px] text-foreground/90">{branch}</code>
        ) : (
          <span className="text-[12px] italic text-muted-foreground">detached / unknown</span>
        )}
      </div>
      <div className="mt-0.5 pl-5 font-mono text-[11px] text-muted-foreground">
        {shortSha ? `@ ${shortSha}` : "@ —"}
      </div>
    </div>
  );
}

function DivergenceDiagnosis({
  divergence,
  dividerClass,
}: {
  divergence: WorkspaceDivergence;
  dividerClass: string;
}) {
  const badge = ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"];
  return (
    <div
      data-testid="recovery-divergence-diagnosis"
      className={cn(
        "space-y-2.5 border-t bg-background/40 px-3 py-3 dark:bg-background/20 sm:px-4",
        dividerClass,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Divergence diagnosis
        </span>
        <span
          data-testid="recovery-ancestry-verdict"
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
            badge.className,
          )}
        >
          {badge.label}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <BranchFacet
          label="Expected · recorded"
          branch={divergence.expectedBranch}
          sha={divergence.expectedHeadSha}
        />
        <BranchFacet
          label="Live · checked out"
          branch={divergence.liveBranch}
          sha={divergence.liveHeadSha}
        />
      </div>
      {divergence.plainLanguageReason ? (
        <p className="text-[12px] leading-5 text-foreground/80">{divergence.plainLanguageReason}</p>
      ) : null}
    </div>
  );
}

function readWakePolicySummary(action: IssueRecoveryAction): string | null {
  const policy = action.wakePolicy;
  if (!policy) return null;
  const type = readEvidenceString(policy.type);
  if (!type) return null;
  if (type === "wake_owner") return "Corrective wake queued";
  if (type === "board_escalation") return "Escalated to board";
  if (type === "manual") return "Manual";
  if (type === "manual_repair_required") return "Manual repair required";
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval ? `Monitor scheduled · ${interval}` : "Monitor scheduled";
  }
  return type.replaceAll("_", " ");
}

function formatTimeShort(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMs = date.getTime() - now;
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    if (absMin < 60) {
      return diffMs >= 0 ? `in ${absMin}m` : `${absMin}m ago`;
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function shortenRunId(runId: string | null | undefined) {
  if (!runId) return null;
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0 px-3 py-1.5 text-xs sm:px-4">
      <dt className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

function MissingValue() {
  return <span className="text-muted-foreground">—</span>;
}

function AgentLink({
  agentId,
  agentMap,
  fallback,
}: {
  agentId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Agent>;
  fallback?: string | null;
}) {
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label = agent?.name ?? `agent ${agentId.slice(0, 8)}`;
  if (agent) {
    return (
      <Link
        to={agentUrl(agent)}
        className="rounded-sm font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}

function RunChip({
  runId,
  agentId,
  status,
}: {
  runId: string | null;
  agentId: string | null | undefined;
  status?: string | null;
}) {
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
        run {short}
      </code>
      {status ? (
        <span className="font-sans text-[11px] text-muted-foreground">{status}</span>
      ) : null}
    </>
  );
  if (agentId) {
    return (
      <Link
        to={`/agents/${agentId}/runs/${runId}`}
        className="inline-flex items-center gap-2 rounded-sm underline-offset-2 hover:underline"
      >
        {inner}
      </Link>
    );
  }
  return <span className="inline-flex items-center gap-2">{inner}</span>;
}

const RESOLVE_OPTIONS: Array<{
  outcome: RecoveryResolveOutcome;
  label: string;
  description: string;
  destructive?: boolean;
  boardOnly?: boolean;
}> = [
  {
    outcome: "todo",
    label: "Try again",
    description: "Dismiss recovery and return the source task to todo.",
  },
  {
    outcome: "done",
    label: "Mark task done",
    description: "Restore by recording the requested work as complete.",
  },
  {
    outcome: "in_review",
    label: "Send for review",
    description: "Hand off to a reviewer with a real review path.",
  },
  {
    outcome: "false_positive_done",
    label: "False positive, done",
    description: "Dismiss recovery and mark the source task complete.",
    destructive: true,
    boardOnly: true,
  },
  {
    outcome: "false_positive_in_review",
    label: "False positive, review",
    description: "Dismiss recovery and send the source task for review.",
    destructive: true,
    boardOnly: true,
  },
];

export function IssueRecoveryActionCard({
  action,
  agentMap,
  forcedState,
  onResolve,
  onReissueIsolated,
  reissuePending = false,
  canFalsePositive = false,
  className,
}: IssueRecoveryActionCardProps) {
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action);
  const tone = STATE_TONE[cardState];
  const ToneIcon = tone.Icon;
  const divergence = useMemo(() => readWorkspaceDivergence(action), [action]);

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      return `Recovery resolved as ${OUTCOME_LABEL[action.outcome] ?? action.outcome}.`;
    }
    return KIND_HEADLINE[action.kind] ?? KIND_HEADLINE.missing_disposition;
  }, [action.kind, action.outcome, cardState]);

  const wakeSummary = readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  const showAttempt = action.attemptCount > 1 && action.maxAttempts !== null;
  const showTimeoutInline = (() => {
    if (!action.timeoutAt) return false;
    try {
      const date = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 && diffMs < 60 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  const updatedAtLabel = formatTimeShort(action.updatedAt);

  const ariaState = ({
    needed: "needed",
    in_progress: "in progress",
    observe_only: "observing active run",
    escalated: "escalated",
    resolved: "resolved",
  } satisfies Record<RecoveryCardCardState, string>)[cardState];

  const showResolveActions = onResolve !== undefined && cardState !== "resolved";
  const visibleResolveOptions = RESOLVE_OPTIONS.filter((option) => {
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });
  const reissueBaseRef = divergence?.reissueBaseRef ?? null;
  const showReissueAction =
    onReissueIsolated !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    reissueBaseRef !== null;
  const reissueVerdictBadge = divergence
    ? ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"]
    : null;
  const showFooter = showResolveActions || showReissueAction;

  return (
    <section
      role="status"
      aria-label={`Recovery action: ${ariaState}`}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-[0_1px_0_rgba(15,23,42,0.02)]",
        tone.containerClass,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone.iconWrapClass,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tone.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]">
            <span className={tone.labelClass}>{tone.label}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-muted-foreground">
              {KIND_LABEL[action.kind] ?? action.kind}
            </code>
            {updatedAtLabel ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {updatedAtLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-[14px] leading-6">{headline}</p>
        </div>
      </header>
      <dl className={cn("border-t bg-background/40 dark:bg-background/20", tone.divider)}>
        <MetadataRow label="Owner">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">Recovery:</span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">Board</span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium">user {action.ownerUserId.slice(0, 6)}</span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">System</span>
            ) : (
              <span className="text-muted-foreground">unassigned — pick one to wake them</span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">→ Returns to:</span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        <MetadataRow label="Source run">
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow label="Corrective run">
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow label="Evidence">
          {evidenceSummary ? (
            <span className="break-words font-mono text-[11px] text-foreground/80">{evidenceSummary}</span>
          ) : (
            <MissingValue />
          )}
        </MetadataRow>
        <MetadataRow label="Next action">
          {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
        </MetadataRow>
        <MetadataRow label="Wake">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                attempt {action.attemptCount} of {action.maxAttempts}
              </span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                Times out {formatTimeShort(action.timeoutAt) ?? "soon"}
              </span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow label="Resolution">
            <span className={cn("font-medium", tone.labelClass)}>
              Resolved as {OUTCOME_LABEL[action.outcome]}
              {action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}
            </span>
          </MetadataRow>
        ) : null}
      </dl>
      {divergence ? <DivergenceDiagnosis divergence={divergence} dividerClass={tone.divider} /> : null}
      {showFooter ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          {showResolveActions ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="recovery-action-resolve-trigger"
                  aria-label="Resolve recovery"
                >
                  Resolve…
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-72 p-1.5"
              >
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Resolve recovery
                </div>
                <div className="flex flex-col">
                  {visibleResolveOptions.map((option) => (
                    <button
                      key={option.outcome}
                      type="button"
                      onClick={() => onResolve?.(option.outcome)}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        option.destructive ? "text-destructive" : null,
                      )}
                    >
                      <span className="font-medium leading-5">{option.label}</span>
                      <span className="text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {showReissueAction && divergence && reissueBaseRef ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-trigger"
                >
                  {reissuePending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <GitBranchPlus className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Re-issue on isolated workspace
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 space-y-3 p-3">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Re-issue on isolated workspace
                  </div>
                  <p className="text-[12px] leading-5 text-muted-foreground">
                    Creates a fresh copy of this task on an isolated git worktree based on the live
                    branch. Your current workspace and its commits are left untouched.
                  </p>
                </div>
                <dl className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">Base ref</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/90">{reissueBaseRef}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">Recorded</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/80">
                      {divergence.expectedBranch ?? "—"}
                    </dd>
                  </div>
                  {reissueVerdictBadge ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Ancestry</dt>
                      <dd className="font-medium">{reissueVerdictBadge.label}</dd>
                    </div>
                  ) : null}
                </dl>
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-confirm"
                  onClick={() =>
                    onReissueIsolated?.({
                      baseRef: reissueBaseRef,
                      liveBranch: divergence.liveBranch,
                      liveHeadSha: divergence.liveHeadSha,
                      expectedBranch: divergence.expectedBranch,
                    })
                  }
                >
                  {reissuePending ? "Creating…" : "Create isolated re-issue"}
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
          {showResolveActions ? (
            cardState === "observe_only" ? (
              <span className="text-[11px] text-muted-foreground">
                Recovery is observing without interrupting the live run.
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                The card stays open until an explicit decision is recorded.
              </span>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
