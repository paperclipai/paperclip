import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function sevTone(s: string): "destructive" | "secondary" | "outline" {
  if (s === "fail") return "destructive";
  if (s === "warn") return "secondary";
  return "outline";
}

export function ContentAudit() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Blog" }, { label: "Audit" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.contentAudit, queryFn: () => blogApi.contentAudit() });
  const scan = async () => { setScanning(true); try { await blogApi.runContentAudit(); qc.invalidateQueries({ queryKey: queryKeys.agnb.contentAudit }); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setScanning(false); } };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="blog" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Content audit</h1>
        <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>{scanning ? "Scanning…" : "Run scan"}</Button>
      </div>
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
