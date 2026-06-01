import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Swords } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

export function Competitors() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "Competition" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.competitors, queryFn: () => researchApi.competitors() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="research" />
      <h1 className="text-lg font-semibold">Competition</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Swords} message="No data." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Competitors ({data.competitors.length})</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Name</th><th className="p-2">Domain</th><th className="p-2">Status</th><th className="p-2 text-right">Blogs</th></tr>
              </thead>
              <tbody>
                {data.competitors.map((c) => (
                  <tr key={c.id} className="border-b border-border/60">
                    <td className="p-2">{c.name}</td>
                    <td className="p-2 font-mono text-xs">{c.domain}</td>
                    <td className="p-2"><Badge variant="outline">{c.status}</Badge></td>
                    <td className="p-2 text-right">{c.total_blogs_seen ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Content gaps ({data.gaps.length})</h2>
          <div className="flex flex-col gap-1">
            {data.gaps.map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span>{g.topic}</span>
                <span className="text-xs text-muted-foreground">gap {Math.round(g.gap_score)} · {g.competitor_count} comp / {g.our_coverage_count} ours</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
