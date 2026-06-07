import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Columns3 } from "lucide-react";
import { campaignsApi, type BucketRow } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { cn } from "../lib/utils";

const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export function BucketCompare() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Experiments" }, { label: "Compare" }]), [setBreadcrumbs]);
  const [sel, setSel] = useState<string[]>([]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.buckets, queryFn: () => campaignsApi.buckets() });

  const toggle = (id: string) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : s.length < 4 ? [...s, id] : s);
  const chosen: BucketRow[] = (data ?? []).filter((b) => sel.includes(b.id));
  const rows: Array<[string, (b: BucketRow) => string]> = [
    ["ICP", (b) => b.icp_name ?? "—"],
    ["Status", (b) => b.status],
    ["Sent", (b) => String(b.rollup?.total_sent ?? 0)],
    ["Reply rate", (b) => pct(b.rollup?.compound_reply_rate)],
    ["Positive", (b) => pct(b.rollup?.compound_positive_rate)],
    ["Meetings", (b) => String(b.rollup?.total_meetings ?? 0)],
    ["Campaigns", (b) => String(b.rollup?.campaigns_run ?? 0)],
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Bucket compare</h1>
      <AgnbSubnav group="experiments" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Columns3} message="No buckets." />
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {data.map((b) => (
              <button key={b.id} onClick={() => toggle(b.id)} disabled={!sel.includes(b.id) && sel.length >= 4}
                className={cn("rounded-md border px-2 py-0.5 text-xs", sel.includes(b.id) ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                {b.name}
              </button>
            ))}
          </div>
          {chosen.length === 0 ? (
            <p className="text-sm text-muted-foreground">Pick up to 4 buckets to compare.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr><th className="p-2">Metric</th>{chosen.map((b) => <th key={b.id} className="p-2">{b.name}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map(([label, fn]) => (
                    <tr key={label} className="border-b border-border/60">
                      <td className="p-2 text-muted-foreground">{label}</td>
                      {chosen.map((b) => <td key={b.id} className="p-2">{fn(b)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
