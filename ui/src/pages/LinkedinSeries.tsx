import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Trash2 } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function LinkedinSeries() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Series" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liSeries, queryFn: () => linkedinQueueApi.series() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.liSeries });
  const del = async (id: string) => { await linkedinQueueApi.deleteSeries(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Series</h1>
        <Button size="sm" onClick={() => setOpen(true)}>New series</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="New series"
          fields={[{ key: "title", label: "Title", required: true }, { key: "description", label: "Description", type: "textarea" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await linkedinQueueApi.createSeries({ title: v.title, description: v.description || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Layers} message="No series." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.map((s) => {
            const pct = s.total > 0 ? Math.round((s.posted / s.total) * 100) : 0;
            return (
              <Card key={s.id}><CardContent className="p-3">
                <div className="flex items-center justify-between"><span className="font-medium">{s.title}</span><span className="flex items-center gap-2"><Badge variant="outline">{s.status}</Badge><button onClick={() => del(s.id)}><Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" /></button></span></div>
                {s.description && <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>}
                <div className="mt-2 h-1.5 w-full rounded-full bg-muted"><div className="h-1.5 rounded-full bg-foreground" style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 text-[11px] text-muted-foreground">{s.posted} posted · {s.total - s.posted} pending · {pct}%</div>
              </CardContent></Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
