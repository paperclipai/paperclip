import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Swords, Trash2 } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function Competitors() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "Competition" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.competitors, queryFn: () => researchApi.competitors() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.competitors });
  const del = async (id: string) => { if (confirm("Remove competitor?")) { await researchApi.deleteCompetitor(id).catch(() => {}); refresh(); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Competition</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add competitor</Button>
      </div>
      <AgnbSubnav group="research" />
      {open && (
        <AgnbFormModal
          title="Add competitor"
          fields={[{ key: "name", label: "Name", required: true }, { key: "domain", label: "Domain", required: true, placeholder: "example.com" }, { key: "sitemap_url", label: "Sitemap URL", required: true, placeholder: "https://example.com/sitemap.xml" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await researchApi.addCompetitor({ name: v.name, domain: v.domain, sitemap_url: v.sitemap_url }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Swords} message="No data." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Competitors ({data.competitors.length})</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Name</th><th className="p-2">Domain</th><th className="p-2">Status</th><th className="p-2 text-right">Blogs</th><th className="p-2"></th></tr>
              </thead>
              <tbody>
                {data.competitors.map((c) => (
                  <tr key={c.id} className="border-b border-border/60">
                    <td className="p-2">{c.name}</td>
                    <td className="p-2 font-mono text-xs">{c.domain}</td>
                    <td className="p-2"><Badge variant="outline">{c.status}</Badge></td>
                    <td className="p-2 text-right">{c.total_blogs_seen ?? 0}</td>
                    <td className="p-2"><button onClick={() => del(c.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Content gaps ({data.gaps.length})</h2>
          <div className="flex flex-col gap-1">
            {data.gaps.map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span>{g.topic}</span>
                <span className="text-xs text-muted-foreground">gap {Math.round(g.gap_score)} · {g.competitor_count} comp / {g.our_coverage_count} ours</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
