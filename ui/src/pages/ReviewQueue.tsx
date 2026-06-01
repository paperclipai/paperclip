import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Send, Trash2 } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function ReviewQueue() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Blog" }, { label: "Review queue" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.blogDrafts });
  const publish = async (id: string) => { try { await blogApi.publishDraft(id); refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } };
  const del = async (id: string) => { if (confirm("Delete draft?")) { await blogApi.deleteDraft(id).catch(() => {}); refresh(); } };

  const pending = (data ?? []).filter((d) => d.status === "draft" || d.status === "scheduled");

  return (
    <div className="space-y-4">
      <AgnbSubnav group="blog" />
      <h1 className="text-lg font-semibold">Review queue</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : pending.length === 0 ? (
        <EmptyState icon={ClipboardCheck} message="Nothing to review." />
      ) : (
        <div className="flex flex-col gap-2">
          {pending.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{d.title}</span>
                  {d.cluster_type && <Badge variant="outline">{d.cluster_type === "pillar" ? "P" : "S"}</Badge>}
                  <Badge variant="secondary">{d.status}</Badge>
                </div>
                {d.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{d.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{d.created_by ?? "—"} · {relativeTime(d.updated_at)}</span>
                <button title="Publish" onClick={() => publish(d.id)}><Send className="h-3.5 w-3.5 text-muted-foreground hover:text-emerald-600" /></button>
                <button title="Delete" onClick={() => del(d.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
