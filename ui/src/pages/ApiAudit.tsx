import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { relativeTime } from "../lib/utils";

export function ApiAudit() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "API audit" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.audit, queryFn: () => opsApi.audit() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">API audit</h1>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ScrollText} message="No calls logged." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">When</th><th className="p-2">Method</th><th className="p-2">Status</th><th className="p-2 text-right">ms</th><th className="p-2">Error</th></tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="border-b border-border/60">
                  <td className="p-2 font-mono text-xs">{relativeTime(a.called_at)}</td>
                  <td className="p-2 font-mono text-xs">{a.method}</td>
                  <td className={a.ok ? "p-2 text-emerald-600" : "p-2 text-destructive"}>{a.ok ? "ok" : "fail"}</td>
                  <td className="p-2 text-right">{a.duration_ms}</td>
                  <td className="p-2 text-xs text-destructive">{a.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
