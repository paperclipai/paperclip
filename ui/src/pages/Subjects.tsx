import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Type } from "lucide-react";
import { experimentsApi } from "../api/agnbExperiments";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export function Subjects() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Experiments" }, { label: "Subjects" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.subjects, queryFn: () => experimentsApi.subjects() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Subject tournament</h1>
      <AgnbSubnav group="experiments" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Type} message="No subject lines." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Subject</th><th className="p-2 text-right">Sends</th><th className="p-2 text-right">Open</th><th className="p-2 text-right">Reply</th></tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="p-2">{s.subject}{s.campaign_name && <span className="block text-[11px] text-muted-foreground">{s.campaign_name}</span>}</td>
                  <td className="p-2 text-right">{s.sends}</td>
                  <td className="p-2 text-right">{pct(s.open_rate)}</td>
                  <td className="p-2 text-right font-medium">{pct(s.reply_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
