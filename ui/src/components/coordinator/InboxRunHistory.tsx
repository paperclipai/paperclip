import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { attentionApi } from "@/api/attention";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { HorizontalScrollViewport } from "@/components/HorizontalScrollViewport";
import { FileText } from "lucide-react";

const recordedTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function InboxRunHistory({ companyId, userId }: { companyId: string; userId: string | null }) {
  const query = useInfiniteQuery({ queryKey: [...queryKeys.attention(companyId), userId, "run-history"],
    initialPageParam: undefined as { at: string; id: string } | undefined,
    queryFn: ({ pageParam }) => attentionApi.runHistory(companyId, pageParam),
    getNextPageParam: (rows) => {
      const last = rows.at(-1);
      return rows.length === 100 && last ? { at: last.recordedAt, id: last.runId } : undefined;
    } });
  const runs = query.data?.pages.flat();
  const view = useQueryView(query);
  return <section className="min-w-0 space-y-3"><h2 className="text-2xl font-medium" id="recent-run-history">Recent run history</h2>
    {view.kind === "error" && <QueryErrorState error={view.error} onRetry={view.retry} />}
    {query.isLoading && <p role="status">Loading runs…</p>}
    {view.kind !== "error" && runs?.length === 0 && <EmptyState placement="upper" message="No failed runs on visible tasks." />}
    {runs && runs.length > 0 && <HorizontalScrollViewport label="Run history columns">
      <table className="inbox-run-table" aria-labelledby="recent-run-history">
        <thead><tr>{["Task", "Task ID", "Outcome", "Run log", "Recorded"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{runs.map(run => {
          const recordedAt = new Date(run.recordedAt);
          return <tr key={run.runId}>
            <td><Link to={`/issues/${run.identifier ?? run.taskId}`} className="block max-w-xs truncate hover:underline" title={run.taskTitle}>{run.taskTitle}</Link></td>
            <td className="font-mono text-muted-foreground">{run.identifier ?? "—"}</td>
            <td><div>{run.outcome}</div><div className="text-xs text-muted-foreground">{run.reason}</div></td>
            <td><Link to={`/agents/${run.agentId}/runs/${run.runId}`} className="inline-flex items-center gap-1.5 hover:underline" aria-label={`${run.agentName} run log for ${run.identifier ?? run.taskTitle}`}>
              <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="max-w-40 truncate">{run.agentName}</span>
            </Link></td>
            <td><time className="tabular-nums text-muted-foreground" dateTime={run.recordedAt} title={recordedAt.toLocaleString()}>{recordedTime.format(recordedAt)}</time></td>
          </tr>;
        })}</tbody>
      </table>
    </HorizontalScrollViewport>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Show older runs</Button>}
  </section>;
}
