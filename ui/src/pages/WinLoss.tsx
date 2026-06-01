import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { cn, formatShortDate } from "../lib/utils";

function tone(o: string): "default" | "destructive" | "secondary" | "outline" {
  if (o === "won") return "default";
  if (o === "lost") return "destructive";
  if (o === "churned") return "secondary";
  return "outline";
}
const OUTCOMES = ["all", "won", "lost", "churned", "no-decision"] as const;

export function WinLoss() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Win/loss" }]), [setBreadcrumbs]);
  const [outcome, setOutcome] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.winLoss(outcome),
    queryFn: () => agnbPagesApi.winLoss(outcome),
  });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Win/loss</h1>
        <div className="flex flex-wrap gap-1">
          {OUTCOMES.map((o) => (
            <button key={o} onClick={() => setOutcome(o)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize",
                outcome === o ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {o}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ClipboardList} message="No interviews." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Customer</th><th className="p-2">Outcome</th><th className="p-2">Date</th><th className="p-2">Top reasons</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="border-b border-border/60">
                  <td className="p-2">
                    {i.customer_name}
                    {i.contact_name && <span className="block text-xs text-muted-foreground">{i.contact_name}{i.contact_title ? ` · ${i.contact_title}` : ""}</span>}
                  </td>
                  <td className="p-2"><Badge variant={tone(i.outcome)}>{i.outcome}</Badge></td>
                  <td className="p-2 font-mono text-xs">{i.interview_date ? formatShortDate(i.interview_date) : "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{(i.top_reasons ?? []).slice(0, 2).join(" · ") || "—"}</td>
                  <td className="p-2 font-mono text-xs">{i.analysis_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
