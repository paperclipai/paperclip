import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { cn } from "../lib/utils";

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`;
const WINDOWS = [30, 90, 180, 365];

export function Channels() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Channels" }]), [setBreadcrumbs]);
  const [days, setDays] = useState(90);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.channels(days),
    queryFn: () => agnbPagesApi.channels(days),
  });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Channels</h1>
        <div className="flex gap-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                days === d ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.channels.length === 0 ? (
        <EmptyState icon={Share2} message="No attribution events in window." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Channel</th>
                <th className="p-2 text-right">Meetings</th>
                <th className="p-2 text-right">Wins</th>
                <th className="p-2 text-right">Losses</th>
                <th className="p-2 text-right">Win rate</th>
                <th className="p-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channel} className="border-b border-border/60">
                  <td className="p-2">
                    <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: c.color }} />
                    {c.channel}
                  </td>
                  <td className="p-2 text-right">{c.meetings}</td>
                  <td className="p-2 text-right text-emerald-600">{c.wins}</td>
                  <td className="p-2 text-right">{c.losses}</td>
                  <td className="p-2 text-right">{Math.round(c.win_rate * 100)}%</td>
                  <td className="p-2 text-right font-mono">{usd(c.revenue_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
