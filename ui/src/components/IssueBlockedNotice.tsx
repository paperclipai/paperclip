import type { IssueBlockerAttention, IssueRelationIssueSummary } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";

export function IssueBlockedNotice({
  issueStatus,
  blockers,
  blockerAttention,
}: {
  issueStatus?: string;
  blockers: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention | null;
}) {
  if (blockers.length === 0 && issueStatus !== "blocked") return null;

  const blockerLabel = blockers.length === 1 ? "the linked issue" : "the linked issues";
  const terminalBlockers = blockers
    .flatMap((blocker) => blocker.terminalBlockers ?? [])
    .filter((blocker, index, all) => all.findIndex((candidate) => candidate.id === blocker.id) === index);

  const isStalled = blockerAttention?.state === "stalled";
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
      </IssueLinkQuicklook>
    );
  };

  return (
    <div
      data-blocker-attention-state={blockerAttention?.state}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 space-y-1.5">
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
        </div>
      </div>
    </div>
  );
}
