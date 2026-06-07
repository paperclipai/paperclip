import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { campaignsApi, type BucketRow } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const STATUSES = ["all", "proposed", "running", "paused", "concluded"] as const;
function tone(s: string): "default" | "secondary" | "outline" {
  if (s === "running") return "default";
  if (s === "paused") return "secondary";
  return "outline";
}

export function Buckets() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Experiments" }, { label: "Buckets" }]), [setBreadcrumbs]);
  const [status, setStatus] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.buckets, queryFn: () => campaignsApi.buckets() });

  const rows: BucketRow[] = (data ?? []).filter((b) => status === "all" || b.status === status);

  return (
    <div className="space-y-4">
      {open && (
        <AgnbFormModal
          title="New bucket"
          fields={[{ key: "name", label: "Name", required: true }, { key: "target_reply_rate", label: "Target reply rate (e.g. 0.03)", type: "number" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await campaignsApi.createBucket({ name: v.name, target_reply_rate: v.target_reply_rate ? Number(v.target_reply_rate) : undefined }); qc.invalidateQueries({ queryKey: queryKeys.agnb.buckets }); }}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Buckets</h1>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" className="mr-1" onClick={() => setOpen(true)}>New bucket</Button>
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", status === s ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <AgnbSubnav group="experiments" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={FlaskConical} message="No buckets." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Bucket</th><th className="p-2">ICP</th><th className="p-2">Status</th><th className="p-2 text-right">Sent</th><th className="p-2 text-right">Positive</th><th className="p-2 text-right">Meetings</th></tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-b border-border/60">
                  <td className="p-2">{b.name}</td>
                  <td className="p-2 text-xs text-muted-foreground">{b.icp_name ?? "—"}</td>
                  <td className="p-2"><Badge variant={tone(b.status)}>{b.status}</Badge></td>
                  <td className="p-2 text-right">{b.rollup?.total_sent ?? 0}</td>
                  <td className="p-2 text-right">{pct(b.rollup?.compound_positive_rate)}</td>
                  <td className="p-2 text-right">{b.rollup?.total_meetings ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
