import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export function Campaigns() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.campaigns, queryFn: () => campaignsApi.campaigns() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Campaigns</h1>
      <AgnbSubnav group="campaigns" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.campaigns.length === 0 ? (
        <EmptyState icon={Megaphone} message="No campaigns." />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{data.campaigns.length} campaigns · {data.senders.length} senders</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Campaign</th><th className="p-2">Status</th><th className="p-2 text-right">Sent</th><th className="p-2 text-right">Open</th><th className="p-2 text-right">Reply</th><th className="p-2 text-right">Meetings</th></tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-border/60">
                    <td className="p-2">{c.name ?? "(untitled)"}{c.framework && <span className="block text-xs text-muted-foreground">{c.framework}</span>}</td>
                    <td className="p-2"><Badge variant="outline">{c.status ?? "—"}</Badge></td>
                    <td className="p-2 text-right">{c.sent_count ?? 0}</td>
                    <td className="p-2 text-right">{pct(c.open_rate)}</td>
                    <td className="p-2 text-right font-medium">{pct(c.reply_rate)}</td>
                    <td className="p-2 text-right">{c.meeting_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
