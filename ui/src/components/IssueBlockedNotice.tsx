import type {
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { AlertTriangle, Flag } from "lucide-react";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { isAssignedBacklogBlocker } from "../lib/issue-blockers";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
} from "../lib/recovery-display";

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

export function IssueBlockedNotice({
  issueStatus,
  blockers,
  blockerAttention,
  successfulRunHandoff,
  agentName,
}: {
  issueStatus?: string;
  blockers: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  agentName?: string | null;
}) {
  if (issueStatus === "done" || issueStatus === "cancelled") return null;
  const showSuccessfulRunHandoff = successfulRunHandoff?.required === true;
  if (!showSuccessfulRunHandoff && blockers.length === 0 && issueStatus !== "blocked") return null;

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
    return (
      <IssueLinkQuicklook
        key={blocker.id}
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-amber-950 transition-colors hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
      >
        <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
        <span className="max-w-[18rem] truncate font-sans text-[11px] text-amber-800 dark:text-amber-200">
          {blocker.title}
        </span>
        {recoveryAction ? <BlockerRecoveryIndicator action={recoveryAction} /> : null}
      </IssueLinkQuicklook>
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
