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

export function Newsletter() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Renewals" }, { label: "Newsletter" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.newsletter, queryFn: () => renewalsApi.newsletter() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.newsletter });
  const sent = async (id: string) => { await renewalsApi.markNewsletterSent(id).catch(() => {}); refresh(); };
  const del = async (id: string) => { await renewalsApi.deleteNewsletter(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Newsletter</h1>
      </div>
      <AgnbSubnav group="renewals" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Newspaper} message="No newsletter issues." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((n) => (
            <div key={n.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{n.subject ?? `Issue #${n.issue_number ?? "?"}`}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Badge variant={n.status === "sent" ? "default" : "outline"}>{n.status}</Badge>
                  <span className="text-[11px]">{n.blog_ids?.length ?? 0} blogs</span>
                  {n.status !== "sent" && <button title="Mark sent" onClick={() => sent(n.id)}><Send className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                  <button title="Delete" onClick={() => del(n.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                </span>
              </div>
              {n.intro && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{n.intro}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
