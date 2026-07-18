import type {
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Flag, Loader2, RotateCcw } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { formatMonitorOffset } from "../lib/issue-monitor";
import { useRetryNowMutation } from "../hooks/useRetryNowMutation";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { RetryErrorBand } from "./IssueScheduledRetryCard";
import { isAssignedBacklogBlocker } from "../lib/issue-blockers";
import { Badge } from "@/components/ui/badge";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
} from "../lib/recovery-display";
import { StatusGlyph } from "./StatusGlyph";

function BlockerRecoveryIndicator({ action }: { action: IssueRecoveryAction }) {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const label = recoveryChipLabel(state, action.kind);
  return (
    <Badge variant="outline"
      data-testid="issue-blocked-notice-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      role="status"
      aria-label={label}
      title={`${label} — open the source task to act.`}
      className={`[&>svg]:size-2.5 gap-0.5 px-1.5 text-(length:--text-nano) ${tone.className}`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </Badge>
  );
}

function SuccessfulRunRetryNowControl({
  issueId,
  scheduledRetry,
}: {
  issueId: string;
  scheduledRetry: IssueScheduledRetry;
}) {
  const retryNow = useRetryNowMutation(issueId);
  const dueAtIso = scheduledRetry.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const scheduleLabel = relative === "now"
    ? "due now"
    : relative
      ? `scheduled ${relative}`
      : "scheduled";
  const success = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");

  return (
    <div className="mt-2 rounded-md border border-amber-300/70 bg-background/80 p-2 dark:border-amber-500/40 dark:bg-background/40">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs leading-5 text-amber-900 dark:text-amber-100">
          Corrective wake {scheduleLabel}. Retry now starts the same recovery path immediately.
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-amber-300/80 bg-background/80 text-amber-950 shadow-none hover:bg-amber-100 dark:border-amber-500/50 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
          onClick={() => retryNow.mutate()}
          disabled={retryNow.isPending || success}
          data-testid="issue-next-step-retry-now"
        >
          {retryNow.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Retrying...
            </span>
          ) : success ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryNow.data?.outcome === "already_promoted" ? "Already promoted" : "Promoted"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry now
            </span>
          )}
        </Button>
      </div>
      <RetryErrorBand
        error={retryNow.lastError}
        className="mt-2 border-amber-300/70 bg-amber-100/70 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
        onRetry={() => {
          retryNow.reset();
          retryNow.mutate();
        }}
      />
    </div>
  );
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>();

type WaitingStepStatus = "done" | "running" | "queued";

function classifyWaitingStep(
  blocker: IssueRelationIssueSummary,
  liveIds: ReadonlySet<string>,
): WaitingStepStatus {
  // A resolved blocker (done/cancelled) is a completed step; a blocker with a
  // live run is the one currently being worked; everything else is queued.
  if (blocker.status === "done" || blocker.status === "cancelled") return "done";
  if (liveIds.has(blocker.id)) return "running";
  return "queued";
}

// Ordering heuristic (plan §3): done → running → queued, tie-break by identifier
// (P1…Pn plan naming). The payload doesn't carry explicit chain order.
const WAITING_STEP_RANK: Record<WaitingStepStatus, number> = {
  done: 0,
  running: 1,
  queued: 2,
};

function waitingTaskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function WaitingChipLink({
  blocker,
  running = false,
}: {
  blocker: IssueRelationIssueSummary;
  running?: boolean;
}) {
  const issuePathId = blocker.identifier ?? blocker.id;
  return (
    <IssueLinkQuicklook
      issuePathId={issuePathId}
      to={createIssueDetailPath(issuePathId)}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-blue-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-blue-950 transition-colors hover:border-blue-500 hover:bg-blue-100 hover:underline dark:border-blue-500/40 dark:bg-background/40 dark:text-blue-100 dark:hover:bg-blue-500/15"
    >
      <StatusGlyph
        status={blocker.status}
        size="sm"
        title={`${waitingTaskStatusLabel(blocker.status)} status`}
      />
      <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
      <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-blue-800 dark:text-blue-200">
        {blocker.title}
      </span>
      {running ? (
        <span className="ml-0.5 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide text-blue-700 dark:bg-blue-400/20 dark:text-blue-200">
          running
        </span>
      ) : null}
    </IssueLinkQuicklook>
  );
}

function WaitingStepGlyph({ status }: { status: WaitingStepStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" aria-hidden />;
  }
  if (status === "running") {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
      </span>
    );
  }
  return <Circle className="h-3.5 w-3.5 text-blue-300 dark:text-blue-500/50" aria-hidden />;
}

/**
 * Blue "Waiting on live work" variant — rendered in place of the
 * amber notice when `blockerAttention.state === "covered"`: the blocker chain
 * is a healthy plan executing in order and something in it is live.
 */
function WaitingOnLiveWorkNotice({
  blockerAttentionState,
  chainBlockers,
  terminalBlockers,
  liveIds,
  parkedBlockers,
  renderParkedChip,
}: {
  blockerAttentionState?: string;
  chainBlockers: IssueRelationIssueSummary[];
  terminalBlockers: IssueRelationIssueSummary[];
  liveIds: ReadonlySet<string>;
  parkedBlockers: IssueRelationIssueSummary[];
  renderParkedChip: (blocker: IssueRelationIssueSummary) => ReactNode;
}) {
  const steps = chainBlockers
    .map((blocker) => ({ blocker, status: classifyWaitingStep(blocker, liveIds) }))
    .sort((a, b) => {
      const rank = WAITING_STEP_RANK[a.status] - WAITING_STEP_RANK[b.status];
      if (rank !== 0) return rank;
      const aKey = a.blocker.identifier ?? a.blocker.id;
      const bKey = b.blocker.identifier ?? b.blocker.id;
      return aKey.localeCompare(bKey, undefined, { numeric: true });
    });
  const total = steps.length;
  const doneCount = steps.filter((step) => step.status === "done").length;
  const runningCount = steps.filter((step) => step.status === "running").length;

  // "Now running" replaces "Ultimately waiting on": prefer live terminal
  // leaves that are not already shown in the ordered queue list.
  const stepIds = new Set(steps.map((step) => step.blocker.id));
  const nowRunningSeen = new Set<string>();
  const nowRunning: IssueRelationIssueSummary[] = [];
  for (const blocker of [...terminalBlockers, ...chainBlockers]) {
    if (!liveIds.has(blocker.id)) continue;
    if (stepIds.has(blocker.id)) continue;
    if (nowRunningSeen.has(blocker.id)) continue;
    nowRunningSeen.add(blocker.id);
    nowRunning.push(blocker);
  }

  const queuedNoun = total === 1 ? "task" : "tasks";

  return (
    <div
      data-blocker-attention-state={blockerAttentionState}
      data-testid="issue-blocked-notice-live"
      className="mb-3 rounded-md border border-blue-300/70 bg-blue-50/90 px-3 py-2.5 text-sm text-blue-950 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-1">
            <p className="font-medium leading-5">Waiting on live work</p>
            <p className="leading-5">
              Queued behind {total} {queuedNoun} being worked in order. This task
              resumes automatically when the chain is done. Comments still wake the
              responsible agent.
            </p>
          </div>

          <div className="space-y-1" data-testid="issue-blocked-notice-progress">
            <div className="text-xs font-medium text-blue-800 dark:text-blue-200">
              {doneCount} of {total} done
              {runningCount > 0 ? ` · ${runningCount} running` : null}
            </div>
            <div
              role="progressbar"
              aria-label="Blocker chain progress"
              aria-valuemin={0}
              aria-valuenow={doneCount}
              aria-valuemax={total}
              className="flex h-2 w-full overflow-hidden rounded-full bg-blue-100 dark:bg-blue-500/20"
            >
              {steps.map(({ blocker, status }) => (
                <span
                  key={blocker.id}
                  className={cn(
                    "h-full border-r border-blue-50/80 last:border-r-0 dark:border-blue-950/40",
                    status === "done"
                      ? "bg-blue-500 dark:bg-blue-400"
                      : status === "running"
                        ? "animate-pulse bg-blue-400"
                        : "bg-blue-200 dark:bg-blue-500/30",
                  )}
                  style={{ width: `${100 / total}%` }}
                  title={`${blocker.identifier ?? blocker.id.slice(0, 8)}: ${status}`}
                  aria-hidden
                />
              ))}
            </div>
          </div>

          <div data-testid="issue-blocked-notice-steps">
            {steps.map(({ blocker, status }) => (
              <div key={blocker.id} className="flex items-stretch gap-2">
                <div className="flex w-3.5 flex-col items-center">
                  <span className="flex min-h-6 items-center">
                    <WaitingStepGlyph status={status} />
                  </span>
                  <span
                    className="w-px flex-1 bg-blue-300/50 dark:bg-blue-500/30"
                    aria-hidden
                  />
                </div>
                <div className="min-w-0 pb-1.5">
                  <WaitingChipLink blocker={blocker} running={status === "running"} />
                </div>
              </div>
            ))}
            <div className="flex items-stretch gap-2">
              <div className="flex w-3.5 flex-col items-center">
                <span
                  className="mt-1.5 h-3 w-3 rounded-full border border-dashed border-blue-400/60 dark:border-blue-400/50"
                  aria-hidden
                />
              </div>
              <div className="min-w-0 pb-0.5">
                <span className="inline-block rounded-md border border-dashed border-blue-300/70 px-2 py-1 text-xs text-blue-800 dark:border-blue-500/40 dark:text-blue-200">
                  This task — resumes automatically when the chain is done
                </span>
              </div>
            </div>
          </div>

          {nowRunning.length > 0 ? (
            <div
              data-testid="issue-blocked-notice-now-running"
              className="space-y-1 pt-0.5"
            >
              <div className="text-xs font-medium text-blue-800 dark:text-blue-200">
                Now running
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {nowRunning.map((blocker) => (
                  <WaitingChipLink key={blocker.id} blocker={blocker} running />
                ))}
              </div>
            </div>
          ) : null}

          {parkedBlockers.length > 0 ? (
            <div
              data-testid="issue-blocked-notice-parked-row"
              className="flex flex-wrap items-center gap-1.5 pt-0.5"
            >
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                <Flag className="h-3 w-3" aria-hidden />
                Blocked by parked work
              </span>
              {parkedBlockers.map((blocker) => renderParkedChip(blocker))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function IssueBlockedNotice({
  issueId,
  issueStatus,
  blockers,
  allBlockers,
  liveIssueIds,
  blockerAttention,
  successfulRunHandoff,
  scheduledRetry,
  agentName,
}: {
  issueId?: string | null;
  issueStatus?: string;
  /** Unresolved blockers (drives the amber notice; unchanged). */
  blockers: IssueRelationIssueSummary[];
  /**
   * Full blocker list (resolved + unresolved). Used by the blue "Waiting on
   * live work" variant to render done steps and progress counts. Falls back to
   * {@link blockers} when not supplied.
   */
  allBlockers?: IssueRelationIssueSummary[];
  /** Company-wide set of issue ids with a queued/running run (own or blocker). */
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  agentName?: string | null;
}) {
  if (issueStatus === "done" || issueStatus === "cancelled") return null;
  const showSuccessfulRunHandoff = successfulRunHandoff?.required === true;
  if (!showSuccessfulRunHandoff && blockers.length === 0 && issueStatus !== "blocked") return null;
  const successfulRunRetryNow = showSuccessfulRunHandoff
    && issueId
    && scheduledRetry?.status === "scheduled_retry"
      ? { issueId, scheduledRetry }
      : null;

  const blockerLabel = blockers.length === 1 ? "the linked task" : "the linked tasks";
  const terminalBlockers = blockers
    .flatMap((blocker) => blocker.terminalBlockers ?? [])
    .filter((blocker, index, all) => all.findIndex((candidate) => candidate.id === blocker.id) === index);

  const isStalled = blockerAttention?.state === "stalled";
  const parkedBlockers = (() => {
    const seen = new Set<string>();
    const collected: IssueRelationIssueSummary[] = [];
    const sources: IssueRelationIssueSummary[] = [...blockers];
    for (const blocker of blockers) {
      for (const terminal of blocker.terminalBlockers ?? []) {
        sources.push(terminal);
      }
    }
    for (const blocker of sources) {
      if (!isAssignedBacklogBlocker(blocker)) continue;
      if (seen.has(blocker.id)) continue;
      seen.add(blocker.id);
      collected.push(blocker);
    }
    return collected;
  })();
  const showParkedRow = parkedBlockers.length > 0;
  const stalledLeafIdentifier =
    blockerAttention?.sampleStalledBlockerIdentifier ?? blockerAttention?.sampleBlockerIdentifier ?? null;
  const stalledLeafBlockers = (() => {
    const candidates: IssueRelationIssueSummary[] = [];
    for (const blocker of [...blockers, ...terminalBlockers]) {
      if (blocker.status !== "in_review") continue;
      if (candidates.some((existing) => existing.id === blocker.id)) continue;
      candidates.push(blocker);
    }
    if (stalledLeafIdentifier) {
      const preferred = candidates.find(
        (blocker) => (blocker.identifier ?? blocker.id) === stalledLeafIdentifier,
      );
      if (preferred) {
        return [preferred, ...candidates.filter((blocker) => blocker.id !== preferred.id)];
      }
    }
    return candidates;
  })();
  const showStalledRow = isStalled && stalledLeafBlockers.length > 0;

  // Rule C (PAP-13554 / plan §Rule C): when the issue is `blocked` and a
  // blocker edge is genuinely not done, a human comment does NOT reopen it —
  // the reopen gate keeps it blocked. `blockers` here is the *unresolved* set
  // (status ≠ done/cancelled), so a non-empty list on a `blocked` issue is
  // exactly the case the human's message can't move to todo. Done-but-pending-
  // finalize blockers are `done`, so they fall out of this set and into the
  // Rule B reopen path — we must not claim "a message won't reopen" for those.
  // Name the deepest unresolved leaf (prefer terminal leaves) with its status
  // so "I sent a message and nothing happened" can't recur silently.
  const responsibleName = agentName ?? "the responsible agent";
  const reopenSuppressed = issueStatus === "blocked" && !isStalled && blockers.length > 0;
  const unresolvedLeafBlockers = (() => {
    if (!reopenSuppressed) return [] as IssueRelationIssueSummary[];
    const seen = new Set<string>();
    const collected: IssueRelationIssueSummary[] = [];
    for (const blocker of blockers) {
      const terminals = (blocker.terminalBlockers ?? []).filter(
        (leaf) => leaf.status !== "done" && leaf.status !== "cancelled",
      );
      const leaves = terminals.length > 0 ? terminals : [blocker];
      for (const leaf of leaves) {
        if (seen.has(leaf.id)) continue;
        seen.add(leaf.id);
        collected.push(leaf);
      }
    }
    return collected;
  })();
  const reopenSuppressedLeaf = unresolvedLeafBlockers[0] ?? null;
  const reopenSuppressedLeafId = reopenSuppressedLeaf
    ? reopenSuppressedLeaf.identifier ?? reopenSuppressedLeaf.id.slice(0, 8)
    : null;
  const reopenSuppressedLeafStatus = reopenSuppressedLeaf
    ? reopenSuppressedLeaf.status.replace(/_/g, " ")
    : null;
  const reopenSuppressedOtherCount = Math.max(unresolvedLeafBlockers.length - 1, 0);

  const renderBlockerChip = (blocker: IssueRelationIssueSummary) => {
    const issuePathId = blocker.identifier ?? blocker.id;
    const recoveryAction = blocker.activeRecoveryAction ?? null;
    return (
      <IssueLinkQuicklook
        key={blocker.id}
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-amber-950 transition-colors hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
      >
        <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
        <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-amber-800 dark:text-amber-200">
          {blocker.title}
        </span>
        {recoveryAction ? <BlockerRecoveryIndicator action={recoveryAction} /> : null}
      </IssueLinkQuicklook>
    );
  };

  // Blue "Waiting on live work" variant: the blocker chain is a healthy plan
  // executing in order and something in it is live. `covered` is
  // the only state that goes blue — stalled / needs_attention / none keep the
  // amber notice byte-for-byte. The successful-run handoff notice is about this
  // task's own finished run, so it always keeps its amber priority styling.
  const liveIds = liveIssueIds ?? EMPTY_LIVE_IDS;
  const chainBlockers = allBlockers ?? blockers;
  const hasLiveWaitingBlocker = [...chainBlockers, ...terminalBlockers].some((blocker) => (
    liveIds.has(blocker.id)
  ));
  const waitingOnLiveWork =
    !showSuccessfulRunHandoff
    && blockerAttention?.state === "covered"
    && chainBlockers.length > 0
    && hasLiveWaitingBlocker;

  if (waitingOnLiveWork) {
    return (
      <WaitingOnLiveWorkNotice
        blockerAttentionState={blockerAttention?.state}
        chainBlockers={chainBlockers}
        terminalBlockers={terminalBlockers}
        liveIds={liveIds}
        parkedBlockers={showParkedRow ? parkedBlockers : []}
        renderParkedChip={renderBlockerChip}
      />
    );
  }

  return (
    <div
      data-blocker-attention-state={blockerAttention?.state}
      data-successful-run-handoff={showSuccessfulRunHandoff ? "required" : undefined}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 space-y-1.5">
          {showSuccessfulRunHandoff ? (
            <>
              <p className="font-medium leading-5">This task still needs a next step.</p>
              <p className="leading-5">
                A run finished successfully, but this task is still open in{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-400/15">
                  in_progress
                </code>{" "}
                with no clear owner for the next action.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900 dark:text-amber-100">
                <li>Mark it done or cancelled.</li>
                <li>Send it for review or ask for input.</li>
                <li>Mark it blocked with a blocker owner.</li>
                <li>Delegate follow-up work or queue a continuation.</li>
              </ul>
              <div className="flex flex-wrap gap-1.5 text-xs">
                {successfulRunHandoff.sourceRunId && successfulRunHandoff.assigneeAgentId ? (
                  <Link
                    to={`/agents/${successfulRunHandoff.assigneeAgentId}/runs/${successfulRunHandoff.sourceRunId}`}
                    className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
                  >
                    run {successfulRunHandoff.sourceRunId.slice(0, 8)}
                  </Link>
                ) : successfulRunHandoff.sourceRunId ? (
                  <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                    run {successfulRunHandoff.sourceRunId.slice(0, 8)}
                  </span>
                ) : null}
                <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 text-amber-900 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                  Corrective wake queued for {agentName ?? "the responsible"}
                </span>
              </div>
              {successfulRunHandoff.detectedProgressSummary ? (
                <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                  Detected progress: {successfulRunHandoff.detectedProgressSummary}
                </p>
              ) : null}
              {successfulRunRetryNow ? (
                <SuccessfulRunRetryNowControl
                  issueId={successfulRunRetryNow.issueId}
                  scheduledRetry={successfulRunRetryNow.scheduledRetry}
                />
              ) : null}
            </>
          ) : null}
          {showSuccessfulRunHandoff && (blockers.length > 0 || issueStatus === "blocked") ? (
            <div className="border-t border-amber-300/60 pt-1.5 dark:border-amber-500/30" />
          ) : null}
          {blockers.length > 0 || issueStatus === "blocked" ? (
            <>
              <p className="leading-5">
                {blockers.length > 0
                  ? isStalled
                    ? stalledLeafBlockers.length > 1
                      ? <>Work on this task is blocked by {blockerLabel}, but the chain is stalled in review without a clear next step. Resolve the stalled reviews below or remove them as blockers.</>
                      : <>Work on this task is blocked by {blockerLabel}, but the chain is stalled in review without a clear next step. Resolve the stalled review below or remove it as a blocker.</>
                    : reopenSuppressed
                      ? <>A message won&rsquo;t move this back to todo yet — it stays blocked by {blockerLabel} until {blockers.length === 1 ? "it is" : "they are"} done, then it reopens automatically. Comments still wake {responsibleName} for questions or triage in the meantime.</>
                      : <>Work on this task is blocked by {blockerLabel} until {blockers.length === 1 ? "it is" : "they are"} complete. Comments still wake the responsible for questions or triage.</>
                  : <>Work on this task is blocked until it is moved back to todo. Comments still wake the responsible for questions or triage.</>}
              </p>
              {reopenSuppressed && reopenSuppressedLeafId ? (
                <p
                  data-testid="issue-blocked-notice-reopen-suppressed"
                  className="text-xs font-medium leading-5 text-amber-900 dark:text-amber-100"
                >
                  Still blocked by{" "}
                  <span className="font-mono">{reopenSuppressedLeafId}</span>
                  {reopenSuppressedLeafStatus ? <> ({reopenSuppressedLeafStatus})</> : null}
                  {reopenSuppressedOtherCount > 0
                    ? ` and ${reopenSuppressedOtherCount} other ${
                        reopenSuppressedOtherCount === 1 ? "task" : "tasks"
                      }`
                    : null}
                  .
                </p>
              ) : null}
              {blockers.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {blockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showStalledRow ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    Stalled in review
                  </span>
                  {stalledLeafBlockers.map(renderBlockerChip)}
                </div>
              ) : terminalBlockers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    Ultimately waiting on
                  </span>
                  {terminalBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showParkedRow ? (
                <div
                  data-testid="issue-blocked-notice-parked-row"
                  className="flex flex-wrap items-center gap-1.5 pt-0.5"
                >
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                    <Flag className="h-3 w-3" aria-hidden />
                    Blocked by parked work
                  </span>
                  {parkedBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
