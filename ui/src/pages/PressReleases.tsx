import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Newspaper, Send, Trash2 } from "lucide-react";
import { renewalsApi } from "../api/agnbRenewals";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

export function PressReleases() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Renewals" }, { label: "Press releases" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.pressReleases, queryFn: () => renewalsApi.pressReleases() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.pressReleases });
  const publish = async (id: string) => { await renewalsApi.publishPress(id).catch(() => {}); refresh(); };
  const del = async (id: string) => { await renewalsApi.deletePress(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="renewals" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Press releases</h1>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Newspaper} message="No press releases." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((p) => (
            <div key={p.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline">{p.trigger_event}</Badge>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Badge variant={p.status === "published" ? "default" : "outline"}>{p.status}</Badge>
                  {p.status !== "published" && <button title="Publish" onClick={() => publish(p.id)}><Send className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                  <button title="Delete" onClick={() => del(p.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                </span>
              </div>
              {p.headline && <h3 className="mt-1 font-semibold">{p.headline}</h3>}
              {p.subhead && <p className="text-xs italic text-muted-foreground">{p.subhead}</p>}
              {p.body && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{p.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
