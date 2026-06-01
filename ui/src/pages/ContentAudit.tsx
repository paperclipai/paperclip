import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

function sevTone(s: string): "destructive" | "secondary" | "outline" {
  if (s === "fail") return "destructive";
  if (s === "warn") return "secondary";
  return "outline";
}

export function ContentAudit() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Blog" }, { label: "Audit" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.contentAudit, queryFn: () => blogApi.contentAudit() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="blog" />
      <h1 className="text-lg font-semibold">Content audit</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={FileSearch} message="No open audit issues." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Blog</th><th className="p-2">Issue</th><th className="p-2">Details</th></tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="border-b border-border/60">
                  <td className="p-2">{i.blog_title ?? i.blog_path}<span className="block font-mono text-[11px] text-muted-foreground">{i.blog_path}</span></td>
                  <td className="p-2"><Badge variant={sevTone(i.severity)}>{i.issue_type}</Badge></td>
                  <td className="p-2 text-xs text-muted-foreground">{i.details ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
