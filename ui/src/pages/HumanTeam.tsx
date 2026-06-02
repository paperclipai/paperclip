import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function HumanTeam() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.team, queryFn: () => teamApi.members() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.team });
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); try { await fn(); refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setBusy(null); } };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="team" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Team</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => run("ingest", teamApi.ingest)} disabled={busy === "ingest"}>{busy === "ingest" ? "…" : "Ingest"}</Button>
          <Button size="sm" onClick={() => run("route", teamApi.autoRoute)} disabled={busy === "route"}>{busy === "route" ? "…" : "Rebalance"}</Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={UsersRound} message="No team members." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((m) => (
            <Card key={m.id}><CardContent className="p-3">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{m.name}</span><Badge variant="outline">{m.is_ai ? `AI · ${m.ai_engine ?? ""}` : m.role ?? "human"}</Badge></div>
              {(m.skills?.length ?? 0) > 0 && <div className="mt-1 text-[11px] text-muted-foreground">{m.skills!.join(", ")}</div>}
              <div className="mt-1 text-[11px] text-muted-foreground">open {m.open_load ?? 0}{m.capacity_daily ? `/${m.capacity_daily}` : ""} · done7d {m.done_7d ?? 0}</div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
