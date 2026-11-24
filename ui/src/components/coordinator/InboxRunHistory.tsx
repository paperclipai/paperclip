import { Button } from "@/components/ui/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { attentionApi } from "@/api/attention";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { QueryErrorState, useQueryView } from "@/components/QueryView";

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
  if (view.kind === "error") return <QueryErrorState error={view.error} onRetry={view.retry} />;
  return <section className="space-y-3"><h2 className="text-lg font-medium">Recent run history</h2>
    {query.isLoading && <p role="status">Loading runs…</p>}
    {runs?.length === 0 && <p>No failed runs on visible tasks.</p>}
    {runs?.map(run => <div key={run.runId} className="flex flex-wrap items-baseline gap-2 text-sm">
      <Link to={`/issues/${run.identifier ?? run.taskId}`} className="underline">{run.identifier} {run.taskTitle}</Link>
      <span>{run.reason} · {run.outcome}</span>
      <Link to={`/agents/${run.agentId}/runs/${run.runId}`} className="underline">{run.agentName} run log</Link>
      <time className="text-muted-foreground" dateTime={run.recordedAt}>{new Date(run.recordedAt).toLocaleString()}</time>
    </div>)}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Show older runs</Button>}
  </section>;
}
