import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Trash2 } from "lucide-react";
import { researchApi, type ContentBrief } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Button } from "@/components/ui/button";

const STAGES = ["idea", "briefed", "drafting", "review", "published", "killed"];
const TYPES = ["comparison", "alternatives", "best_list", "use_case", "integration", "evergreen", "refresh"];

export function ContentBriefs() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "Briefs" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.content, queryFn: () => researchApi.content() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.content });
  const move = async (id: string, stage: string) => { await researchApi.patchBrief(id, { stage }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await researchApi.deleteBrief(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Content briefs</h1>
        <Button size="sm" onClick={() => setOpen(true)}>New brief</Button>
      </div>
      <AgnbSubnav group="research" />
      {open && (
        <AgnbFormModal
          title="New content brief"
          fields={[
            { key: "title", label: "Title", required: true },
            { key: "content_type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
            { key: "stage", label: "Stage", type: "select", options: STAGES.map((s) => ({ value: s, label: s })) },
            { key: "primary_keyword", label: "Primary keyword" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await researchApi.createBrief({ title: v.title, content_type: v.content_type || undefined, stage: v.stage || undefined, primary_keyword: v.primary_keyword || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={FileText} message="No briefs." />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((stage) => {
            const items: ContentBrief[] = data.filter((b) => b.stage === stage);
            return (
              <div key={stage} className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/30">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-sm font-medium capitalize">{stage}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {items.map((b) => (
                    <div key={b.id} className="rounded-md border border-border bg-background p-2 text-sm">
                      <div className="flex items-start justify-between gap-1">
                        <span className="font-medium">{b.title}</span>
                        <button onClick={() => del(b.id)}><Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" /></button>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{b.content_type}{b.primary_keyword ? ` · ${b.primary_keyword}` : ""}</div>
                      <select value={b.stage} onChange={(e) => move(b.id, e.target.value)} className="mt-1 w-full rounded border border-border bg-background px-1 py-0.5 text-[11px]">
                        {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
