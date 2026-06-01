import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

export function Bofu() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "BoFu" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.bofu, queryFn: () => researchApi.bofu() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="research" />
      <h1 className="text-lg font-semibold">BoFu tracker</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Target} message="No BoFu pages." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Type</th><th className="p-2">Competitor</th><th className="p-2">Status</th><th className="p-2 text-right">Rank</th><th className="p-2 text-right">Traffic</th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="p-2"><a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">{p.title}</a></td>
                  <td className="p-2 text-xs text-muted-foreground">{p.content_type}</td>
                  <td className="p-2 text-xs">{p.competitor ?? "—"}</td>
                  <td className="p-2"><Badge variant="outline">{p.status}</Badge></td>
                  <td className="p-2 text-right">{p.current_rank ?? "—"}</td>
                  <td className="p-2 text-right">{p.monthly_traffic ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
