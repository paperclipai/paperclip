import type {
  Agent,
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { AlertTriangle, Bell, CheckCircle2, Flag, Loader2, RotateCcw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { formatMonitorOffset } from "../lib/issue-monitor";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { useRetryNowMutation } from "../hooks/useRetryNowMutation";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { RetryErrorBand } from "./IssueScheduledRetryCard";
import { StatusIcon } from "./StatusIcon";
import { isAssignedBacklogBlocker } from "../lib/issue-blockers";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
} from "../lib/recovery-display";

// HUM-126 Fix 2: the previous banner said "click to find out more" — the user
// had no idea who to ping. This block resolves the blocker's assignee to a display
// label so we can render it inline.
function resolveBlockerAssigneeLabel(args: {
  blocker: IssueRelationIssueSummary;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
}): { label: string; kind: "agent" | "user" | "unassigned" } {
  const { blocker, agentMap, currentUserId } = args;
  if (blocker.assigneeAgentId) {
    const name =
      blocker.assigneeAgentName
      ?? agentMap?.get(blocker.assigneeAgentId)?.name
      ?? blocker.assigneeAgentId.slice(0, 8);
    return { label: name, kind: "agent" };
  }
  if (blocker.assigneeUserId) {
    const formatted = formatAssigneeUserLabel(blocker.assigneeUserId, currentUserId);
    return {
      label: blocker.assigneeUserName ?? formatted ?? blocker.assigneeUserId.slice(0, 8),
      kind: "user",
    };
  }
  return { label: "Unassigned", kind: "unassigned" };
}

function issueStatusLabel(status: IssueRelationIssueSummary["status"]): string {
  switch (status) {
    case "in_progress": return "In progress";
    case "in_review": return "In review";
    case "todo": return "Todo";
    case "backlog": return "Backlog";
    case "blocked": return "Blocked";
    case "done": return "Done";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function BlockerRecoveryIndicator({ action }: { action: IssueRecoveryAction }) {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  return (
    <span
      data-testid="issue-blocked-notice-recovery-indicator"
      data-recovery-state={state}
      role="status"
      aria-label={tone.label}
      title={`${tone.label} — open the source issue to act.`}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.className}`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </span>
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

export function IssueBlockedNotice({
  issueId,
  issueStatus,
  blockers,
  blockerAttention,
  successfulRunHandoff,
  scheduledRetry,
  agentName,
  agentMap,
  currentUserId,
}: {
  issueId?: string | null;
  issueStatus?: string;
  blockers: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  agentName?: string | null;
  // HUM-126 Fix 2: passed through so each blocker chip can show its assignee's
  // display name without the banner doing its own data fetch.
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
}) {
  if (issueStatus === "done" || issueStatus === "cancelled") return null;
  const showSuccessfulRunHandoff = successfulRunHandoff?.required === true;
  if (!showSuccessfulRunHandoff && blockers.length === 0 && issueStatus !== "blocked") return null;
  const successfulRunRetryNow = showSuccessfulRunHandoff
    && issueId
    && scheduledRetry?.status === "scheduled_retry"
      ? { issueId, scheduledRetry }
      : null;

  const blockerLabel = blockers.length === 1 ? "the linked issue" : "the linked issues";
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

  const renderBlockerChip = (blocker: IssueRelationIssueSummary) => {
    const issuePathId = blocker.identifier ?? blocker.id;
    const recoveryAction = blocker.activeRecoveryAction ?? null;
    const assignee = resolveBlockerAssigneeLabel({ blocker, agentMap, currentUserId });
    const detailPath = createIssueDetailPath(issuePathId);
    // HUM-126 Fix 2: ping = navigate to the blocking issue with a focus signal so
    // the chat thread auto-scrolls + focuses the composer. Cheaper than a modal,
    // and reuses the composer's existing draft/assignee logic.
    const pingPath = `${detailPath}?focus=composer`;
    return (
      <div
        key={blocker.id}
        data-testid="issue-blocked-notice-blocker-card"
        className="flex w-full max-w-md flex-col gap-1 rounded-md border border-amber-300/70 bg-background/80 px-2.5 py-2 text-xs text-amber-950 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100"
      >
        <div className="flex items-center justify-between gap-2">
          <IssueLinkQuicklook
            issuePathId={issuePathId}
            to={detailPath}
            className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-xs text-amber-950 transition-colors hover:underline dark:text-amber-100"
          >
            <span className="shrink-0">{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
            <span className="min-w-0 truncate font-sans text-[11px] text-amber-800 dark:text-amber-200">
              {blocker.title}
            </span>
          </IssueLinkQuicklook>
          {recoveryAction ? <BlockerRecoveryIndicator action={recoveryAction} /> : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-900 dark:text-amber-100">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/70 bg-amber-100/80 px-1.5 py-0.5 font-medium dark:border-amber-500/40 dark:bg-amber-500/15">
              <StatusIcon status={blocker.status} />
              <span>{issueStatusLabel(blocker.status)}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-amber-800/80 dark:text-amber-200/80">Assigned to</span>
              {blocker.assigneeAgentId ? (
                <Link
                  to={`/agents/${blocker.assigneeAgentId}`}
                  className="font-medium hover:underline"
                >
                  {assignee.label}
                </Link>
              ) : (
                <span className="font-medium">{assignee.label}</span>
              )}
            </span>
          </div>
          <Link
            to={pingPath}
            data-testid="issue-blocked-notice-ping-button"
            aria-label={`Ping ${assignee.label} on ${blocker.identifier ?? "the blocking issue"}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300/80 bg-background/90 px-2 py-1 text-[11px] font-medium text-amber-950 transition-colors hover:border-amber-500 hover:bg-amber-100 dark:border-amber-500/50 dark:bg-background/50 dark:text-amber-100 dark:hover:bg-amber-500/15"
          >
            <Bell className="h-3 w-3" aria-hidden />
            <span>Ping</span>
          </Link>
        </div>
      </div>
    );
  };

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
              <p className="font-medium leading-5">This issue still needs a next step.</p>
              <p className="leading-5">
                A run finished successfully, but this issue is still open in{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 text-[12px] dark:bg-amber-400/15">
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
                  Corrective wake queued for {agentName ?? "the assignee"}
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
                      ? <>Work on this issue is blocked by {blockerLabel}, but the chain is stalled in review without a clear next step. Resolve the stalled reviews below or remove them as blockers.</>
                      : <>Work on this issue is blocked by {blockerLabel}, but the chain is stalled in review without a clear next step. Resolve the stalled review below or remove it as a blocker.</>
                    : <>Work on this issue is blocked by {blockerLabel} until {blockers.length === 1 ? "it is" : "they are"} complete. Comments still wake the assignee for questions or triage.</>
                  : <>Work on this issue is blocked until it is moved back to todo. Comments still wake the assignee for questions or triage.</>}
              </p>
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
