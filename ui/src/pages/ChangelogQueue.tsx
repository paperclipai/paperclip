import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollText, Send, Trash2 } from "lucide-react";
import { renewalsApi } from "../api/agnbRenewals";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

export function ChangelogQueue() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Renewals" }, { label: "Changelog" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.changelog, queryFn: () => renewalsApi.changelog() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.changelog });
  const publish = async (id: string) => { await renewalsApi.publishChangelog(id).catch(() => {}); refresh(); };
  const del = async (id: string) => { await renewalsApi.deleteChangelog(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Changelog</h1>
      </div>
      <AgnbSubnav group="renewals" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ScrollText} message="No changelog drafts." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{c.period_start} → {c.period_end}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Badge variant={c.status === "published" ? "default" : "outline"}>{c.status}</Badge>
                  <span className="text-[11px]">{c.commit_count} commits</span>
                  {c.status !== "published" && <button title="Publish" onClick={() => publish(c.id)}><Send className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                  <button title="Delete" onClick={() => del(c.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                </span>
              </div>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{c.markdown}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
