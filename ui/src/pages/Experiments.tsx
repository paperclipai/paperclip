import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Beaker } from "lucide-react";
import { experimentsApi } from "../api/agnbExperiments";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

function tone(v: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (v === "win") return "default";
  if (v === "loss") return "destructive";
  if (v === "flat") return "secondary";
  return "outline";
}

export function Experiments() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Experiments" }, { label: "Auto-experiments" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.experiments, queryFn: () => experimentsApi.experiments() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Auto-experiments</h1>
      <AgnbSubnav group="experiments" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Beaker} message="No experiments." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((e) => (
            <div key={e.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{e.title}</span>
                <span className="flex items-center gap-2"><Badge variant={tone(e.verdict)}>{e.verdict ?? (e.ended_at ? "done" : "running")}</Badge>{e.p_b_beats_a != null && <span className="text-[11px] text-muted-foreground">P(B&gt;A) {Math.round(e.p_b_beats_a * 100)}%</span>}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{e.hypothesis}</p>
              <div className="mt-0.5 text-[11px] text-muted-foreground">metric: {e.metric} · A {e.variant_a_replies}/{e.variant_a_sent} · B {e.variant_b_replies}/{e.variant_b_sent}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
