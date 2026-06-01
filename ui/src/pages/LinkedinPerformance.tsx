import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { formatNumber } from "../lib/utils";

export function LinkedinPerformance() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Performance" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liQueue, queryFn: () => linkedinQueueApi.queue() });

  const posts = (data ?? [])
    .filter((r) => r.status === "posted" || r.status === "published")
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, 50);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <h1 className="text-lg font-semibold">Performance</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : posts.length === 0 ? (
        <EmptyState icon={TrendingUp} message="No published posts yet." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Post</th><th className="p-2 text-right">Impressions</th><th className="p-2 text-right">Reactions</th><th className="p-2 text-right">Comments</th><th className="p-2">Why it worked</th></tr>
            </thead>
            <tbody>
              {posts.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="p-2 max-w-xs"><span className="line-clamp-2">{r.content}</span></td>
                  <td className="p-2 text-right">{r.impressions != null ? formatNumber(r.impressions) : "—"}</td>
                  <td className="p-2 text-right">{r.reactions != null ? formatNumber(r.reactions) : "—"}</td>
                  <td className="p-2 text-right">{r.comments_count != null ? formatNumber(r.comments_count) : "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{r.worked_why ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
