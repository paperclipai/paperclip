import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "done") return "default";
  if (s === "running") return "secondary";
  if (s === "error" || s === "blocked") return "destructive";
  return "outline";
}

export function JustDial() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "JustDial" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.justdial, queryFn: () => campaignsApi.justdial() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="campaigns" />
      <h1 className="text-lg font-semibold">JustDial scraper</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Phone} message="No scrape jobs." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Category</th><th className="p-2">City</th><th className="p-2 text-right">Pages</th><th className="p-2">Status</th><th className="p-2 text-right">Leads</th><th className="p-2">When</th></tr>
            </thead>
            <tbody>
              {data.map((j) => (
                <tr key={j.id} className="border-b border-border/60">
                  <td className="p-2">{j.category}</td>
                  <td className="p-2">{j.city}</td>
                  <td className="p-2 text-right">{j.pages_scraped ?? 0}/{j.max_pages}</td>
                  <td className="p-2"><Badge variant={tone(j.status)}>{j.status}</Badge></td>
                  <td className="p-2 text-right">{j.leads_count ?? 0}</td>
                  <td className="p-2 text-xs text-muted-foreground">{relativeTime(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
