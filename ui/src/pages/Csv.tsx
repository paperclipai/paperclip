import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import { experimentsApi } from "../api/agnbExperiments";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function Csv() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "CSV leads" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.csv, queryFn: () => experimentsApi.csv() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">CSV lead pipeline</h1>
      <AgnbSubnav group="campaigns" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={FileSpreadsheet} message="No uploads." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">File</th><th className="p-2">Status</th><th className="p-2 text-right">Total</th><th className="p-2 text-right">Kept</th><th className="p-2 text-right">Dedup</th><th className="p-2">When</th></tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className="border-b border-border/60">
                  <td className="p-2">{u.filename}</td>
                  <td className="p-2"><Badge variant="outline">{u.status}</Badge></td>
                  <td className="p-2 text-right">{u.rows_total ?? "—"}</td>
                  <td className="p-2 text-right">{u.rows_kept ?? "—"}</td>
                  <td className="p-2 text-right">{u.rows_dedup ?? "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{relativeTime(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
