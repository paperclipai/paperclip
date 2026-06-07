import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Target, Trash2 } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const TYPES = ["comparison", "alternatives", "vs", "use_case", "integration", "migration_guide"];

export function Bofu() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "BoFu" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.bofu, queryFn: () => researchApi.bofu() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.bofu });
  const del = async (id: string) => { await researchApi.deleteBofu(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">BoFu tracker</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add page</Button>
      </div>
      <AgnbSubnav group="research" />
      {open && (
        <AgnbFormModal
          title="Add BoFu page"
          fields={[
            { key: "title", label: "Title", required: true },
            { key: "url", label: "URL", required: true },
            { key: "content_type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
            { key: "competitor", label: "Competitor" },
            { key: "primary_keyword", label: "Primary keyword" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await researchApi.addBofu({ url: v.url, title: v.title, content_type: v.content_type || undefined, competitor: v.competitor || undefined, primary_keyword: v.primary_keyword || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Target} message="No BoFu pages." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Type</th><th className="p-2">Status</th><th className="p-2 text-right">Rank</th><th className="p-2 text-right">Traffic</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="p-2"><a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">{p.title}</a></td>
                  <td className="p-2 text-xs text-muted-foreground">{p.content_type}</td>
                  <td className="p-2"><Badge variant="outline">{p.status}</Badge></td>
                  <td className="p-2 text-right">{p.current_rank ?? "—"}</td>
                  <td className="p-2 text-right">{p.monthly_traffic ?? 0}</td>
                  <td className="p-2"><button onClick={() => del(p.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
