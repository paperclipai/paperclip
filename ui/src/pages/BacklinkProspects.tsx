import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { mentionsApi, type BacklinkProspect } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { cn } from "../lib/utils";

const STATUSES = ["all", "new", "researching", "outreach-drafted", "contacted", "responded", "won", "lost"] as const;
function rankColor(r: number | null) {
  if (r == null) return "text-muted-foreground";
  if (r >= 6) return "text-emerald-600";
  if (r >= 4) return "text-amber-600";
  return "text-muted-foreground";
}

export function BacklinkProspects() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Prospects" }]), [setBreadcrumbs]);
  const [status, setStatus] = useState<string>("all");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.prospects, queryFn: () => mentionsApi.prospects() });

  const rows: BacklinkProspect[] = (data ?? []).filter((p) => status === "all" || p.status === status);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Backlink prospects</h1>
        <div className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={cn("rounded-md border px-2 py-0.5 text-xs", status === s ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Search} message="No prospects." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Domain</th><th className="p-2 text-right">Rank</th><th className="p-2">Via</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="p-2">{p.source_url ? <a href={p.source_url} target="_blank" rel="noreferrer" className="hover:underline">{p.source_domain}</a> : p.source_domain}{p.competitor_name ? <span className="block text-[11px] text-muted-foreground">{p.competitor_name}</span> : null}</td>
                  <td className={cn("p-2 text-right font-mono", rankColor(p.domain_rank))}>{p.domain_rank ?? "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{p.discovered_via}</td>
                  <td className="p-2 text-xs">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
