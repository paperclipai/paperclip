import type { Issue, IssueBlockerStalledWakeContext } from "@paperclipai/shared";
import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { useTaskRetry } from "../hooks/useTaskRetry";
import { describeError } from "../api/errors";

/**
 * Children and blockers of this task that stopped on a recovery action that
 * needs the board (for example, retries exhausted). The task's agent is woken
 * once per stall (`issue_blocker_stalled`); this lets the board see and act on
 * each one from here, with the child's own Retry, without opening it.
 */
export function StalledDependencyNotice({ stalled }: { stalled: IssueBlockerStalledWakeContext[] | null | undefined }) {
  // Most tasks have none: render nothing and read nothing.
  if (!stalled || stalled.length === 0) return null;
  return <StalledDependencyList entries={stalled} />;
}

function StalledDependencyList({ entries }: { entries: IssueBlockerStalledWakeContext[] }) {
  // The child's own task state decides whether Retry is offered, as on its page.
  const children = useQueries({
    queries: entries.map(entry => {
      const ref = entry.stalledIssueIdentifier ?? entry.stalledIssueId;
      return { queryKey: queryKeys.issues.detail(ref), queryFn: () => issuesApi.get(ref) };
    }),
  });
  // The waiter's saved list refreshes only with the waiter. Once a child's own
  // refreshed state has moved on (its Retry started it, or it was unblocked),
  // drop it here rather than show a cleared stall.
  const rows = entries.map((entry, index) => ({ entry, child: children[index] }))
    .filter(({ entry, child }) => !child?.data || child.data.status === entry.stalledIssueStatus);
  if (rows.length === 0) return null;
  return (
    <div
      data-testid="stalled-dependency-notice"
      role="status"
      className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {rows.length === 1 ? "A dependency needs the board" : `${rows.length} dependencies need the board`}
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {rows.map(({ entry, child }) => <StalledDependencyRow key={entry.recoveryAction.id} entry={entry}
          child={child?.data} readError={child?.error ?? null} isFetching={child?.isFetching ?? false}
          refetch={() => void child?.refetch()} />)}
      </ul>
    </div>
  );
}

function StalledDependencyRow({ entry, child, readError, isFetching, refetch }: {
  entry: IssueBlockerStalledWakeContext; child: Issue | undefined; readError: Error | null; isFetching: boolean; refetch: () => void;
}) {
  const ref = entry.stalledIssueIdentifier ?? entry.stalledIssueId;
  const retry = useTaskRetry(child);
  const canRetry = child?.interruption?.canRetry === true;
  // Same states as the task's own Retry (ExecutionBlockerNotice): a refused
  // request explains why, and a lost response can be retried.
  const failed = Boolean(retry.error) && !retry.optimistic && !retry.takingLonger;
  return (
    <li data-testid="stalled-dependency-row" className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs text-amber-800 dark:text-amber-200">
        {entry.relation === "child" ? "Child" : "Blocker"}
      </span>
      <Link to={createIssueDetailPath(ref)} className="font-mono text-xs underline-offset-2 hover:underline">
        {entry.stalledIssueIdentifier ?? "Task"}
      </Link>
      <span className="min-w-0 flex-1 truncate">{entry.stalledIssueTitle}</span>
      {entry.recoveryAction.nextAction ? (
        <span className="basis-full text-xs text-amber-800 dark:text-amber-200">{entry.recoveryAction.nextAction}</span>
      ) : null}
      {readError && !child ? (
        <span role="alert" className="flex basis-full items-center gap-2 text-xs text-destructive">
          Could not load this task's state: {describeError(readError).body}
          <Button size="sm" variant="outline" className="h-6 px-2" disabled={isFetching} onClick={refetch}>
            Reload
          </Button>
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="basis-full text-xs text-destructive">{describeError(retry.error).body}</span>
      ) : null}
      {retry.takingLonger ? (
        <span role="status" className="basis-full text-xs text-muted-foreground">Taking longer than usual…</span>
      ) : null}
      {canRetry || failed || retry.takingLonger ? (
        <Button
          size="sm"
          variant="outline"
          disabled={retry.optimistic && !retry.takingLonger}
          onClick={retry.retry}
          aria-label={`Retry ${entry.stalledIssueIdentifier ?? "task"}`}
          className="h-7 gap-1 border-amber-300/80 bg-background/80 text-amber-950 shadow-none hover:bg-amber-100 dark:border-amber-500/50 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          {retry.optimistic && !retry.takingLonger ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </li>
  );
}
