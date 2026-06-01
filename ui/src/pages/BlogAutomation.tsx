import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { PenLine, ExternalLink } from "lucide-react";
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
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="blog" />
      <h1 className="text-lg font-semibold">Draft blogs</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={PenLine} message="No drafts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Status</th><th className="p-2">When</th><th className="p-2">Updated</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="border-b border-border/60">
                  <td className="p-2">{d.title}<span className="block font-mono text-[11px] text-muted-foreground">{d.slug}</span></td>
                  <td className="p-2"><Badge variant={tone(d.status)}>{d.status}</Badge></td>
                  <td className="p-2 text-xs text-muted-foreground">{d.published_at ? `pub ${relativeTime(d.published_at)}` : d.scheduled_at ? `sched ${relativeTime(d.scheduled_at)}` : "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{relativeTime(d.updated_at)}{d.created_by ? ` · ${d.created_by}` : ""}</td>
                  <td className="p-2">{(d.deployment_url || d.github_pr_url) && <a href={d.deployment_url || d.github_pr_url!} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
