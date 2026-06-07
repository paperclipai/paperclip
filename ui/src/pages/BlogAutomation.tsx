import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PenLine, ExternalLink, Trash2, CalendarClock } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "published") return "default";
  if (s === "scheduled" || s === "publishing") return "secondary";
  if (s === "failed") return "destructive";
  return "outline";
}

export function BlogAutomation() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Blog" }, { label: "Draft blogs" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.blogDrafts });

  const del = async (id: string) => { if (confirm("Delete draft?")) { await blogApi.deleteDraft(id).catch(() => {}); refresh(); } };
  const schedule = async (id: string) => {
    const at = prompt("Schedule at (ISO, e.g. 2026-07-01T10:00):");
    if (!at) return;
    await blogApi.patchDraft(id, { status: "scheduled", scheduled_at: new Date(at).toISOString() }).catch((e) => alert(e instanceof Error ? e.message : "Failed"));
    refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Blog drafts (archive)</h1>
      </div>
      <AgnbSubnav group="assets" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={PenLine} message="No drafts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Status</th><th className="p-2">When</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="border-b border-border/60">
                  <td className="p-2">{d.title}<span className="block font-mono text-[11px] text-muted-foreground">{d.slug}</span></td>
                  <td className="p-2"><Badge variant={tone(d.status)}>{d.status}</Badge></td>
                  <td className="p-2 text-xs text-muted-foreground">{d.published_at ? `pub ${relativeTime(d.published_at)}` : d.scheduled_at ? `sched ${relativeTime(d.scheduled_at)}` : `upd ${relativeTime(d.updated_at)}`}</td>
                  <td className="p-2">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <button title="Schedule" onClick={() => schedule(d.id)}><CalendarClock className="h-3.5 w-3.5 hover:text-foreground" /></button>
                      {(d.deployment_url || d.github_pr_url) &&<a href={d.deployment_url || d.github_pr_url!} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5 hover:text-foreground" /></a>}
                      <button title="Delete" onClick={() => del(d.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
