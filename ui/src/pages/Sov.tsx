import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, Trash2 } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function Sov() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Share of voice" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.sov, queryFn: () => mentionsApi.sov() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.sov });
  const delPrompt = async (id: string) => { if (confirm("Remove prompt?")) { await mentionsApi.deletePrompt(id).catch(() => {}); refresh(); } };

  const stats = useMemo(() => {
    const res = data?.results ?? [];
    const total = res.length;
    const mentioned = res.filter((r) => r.brand_mentioned).length;
    return { total, rate: total ? Math.round((mentioned / total) * 100) : 0 };
  }, [data]);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Share of voice</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add prompt</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="Add SoV prompt"
          fields={[{ key: "prompt", label: "Prompt", required: true, placeholder: "What are the best X tools?" }, { key: "category", label: "Category", placeholder: "optional" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await mentionsApi.addPrompt({ prompt: v.prompt, category: v.category || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Radar} message="No SoV data." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Prompts</div><div className="text-xl font-semibold">{data.prompts.length}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Runs</div><div className="text-xl font-semibold">{stats.total}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Brand mention rate</div><div className="text-xl font-semibold">{stats.rate}%</div></CardContent></Card>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Prompts ({data.prompts.length})</h2>
          <div className="flex flex-col gap-1">
            {data.prompts.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span>{p.prompt}{p.category ? <span className="ml-1 text-[11px] text-muted-foreground">· {p.category}</span> : null}</span>
                <button onClick={() => delPrompt(p.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
              </div>
            ))}
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Recent runs</h2>
          <div className="flex flex-col gap-1">
            {data.results.slice(0, 60).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <div className="flex items-center gap-2"><Badge variant="outline">{r.engine}</Badge>{r.brand_mentioned ? <span className="text-emerald-600">mentioned{r.position ? ` #${r.position}` : ""}</span> : <span className="text-muted-foreground">no mention</span>}</div>
                <span className="text-[11px] text-muted-foreground">{relativeTime(r.ran_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
