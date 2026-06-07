import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Trash2, ArrowUpCircle, Archive } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeTime } from "../lib/utils";

export function IdeaInbox() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Content" }, { label: "Idea inbox" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.ideaInbox, queryFn: () => researchApi.ideaInbox() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.ideaInbox });

  const capture = async () => { if (!text.trim()) return; await researchApi.captureIdea({ raw_text: text.trim() }); setText(""); refresh(); };
  const promote = async (id: string) => { await researchApi.patchIdea(id, { status: "promoted" }).catch(() => {}); refresh(); };
  const trash = async (id: string) => { await researchApi.patchIdea(id, { status: "trashed" }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await researchApi.deleteIdea(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Idea inbox</h1>
      <AgnbSubnav group="content" />
      <div className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") capture(); }} placeholder="Capture an idea…" />
        <Button size="sm" onClick={capture} disabled={!text.trim()}>Capture</Button>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Lightbulb} message="No ideas." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((i) => (
            <div key={i.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <span>{i.raw_text}</span>
                <div className="mt-1 flex items-center gap-1.5"><Badge variant="outline">{i.status}</Badge><span className="text-[11px] text-muted-foreground">{[i.source, i.created_by].filter(Boolean).join(" · ")} · {relativeTime(i.created_at)}</span></div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <button title="Promote" onClick={() => promote(i.id)}><ArrowUpCircle className="h-4 w-4 hover:text-emerald-600" /></button>
                <button title="Trash" onClick={() => trash(i.id)}><Archive className="h-4 w-4 hover:text-amber-600" /></button>
                <button title="Delete" onClick={() => del(i.id)}><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
