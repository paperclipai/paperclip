import { useQuery } from "@tanstack/react-query";
import { attentionApi } from "@/api/attention";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey, coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { useLocation } from "@/lib/router";

/** Navigation never starts a full-feed read. Reuse it on pages that own one;
 * elsewhere desktop and mobile navigation share the same count-only read. */
export function useCoordinatorAttentionCount(companyId: string | null | undefined, enabled = true) {
  const location = useLocation();
  const feedPage = location.pathname.endsWith("/decisions");
  const taskPage = location.pathname.endsWith("/issues") && new URLSearchParams(location.search).get("view") === "needs_attention";
  const attention = useQuery({ queryKey: coordinatorAttentionQueryKey(companyId!),
    queryFn: () => attentionApi.list(companyId!, { all: true }), enabled: false });
  const summary = useQuery({ queryKey: coordinatorAttentionSummaryQueryKey(companyId!),
    queryFn: () => attentionApi.summary(companyId!), enabled: enabled && !!companyId && !feedPage && !taskPage });
  const tasks = useQuery({ queryKey: coordinatorAttentionTasksQueryKey(companyId!),
    queryFn: () => attentionApi.taskIndex(companyId!), enabled: false });
  // These are three projections of the same company/person count. Keep the
  // newest known count during route changes, including an explicit fresh zero.
  // Server generation time wins over a delayed older response arriving later.
  const snapshots = feedPage ? [attention, tasks, summary] : taskPage ? [tasks, attention, summary] : [summary, attention, tasks];
  return snapshots.filter(snapshot => snapshot.data !== undefined)
    .sort((a, b) => ((Date.parse(b.data?.generatedAt ?? "") || 0) - (Date.parse(a.data?.generatedAt ?? "") || 0))
      || b.dataUpdatedAt - a.dataUpdatedAt)[0]?.data?.totalCount ?? 0;
}
