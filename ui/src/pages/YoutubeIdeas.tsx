import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, ArrowUpCircle, Trash2 } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function YoutubeIdeas() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Ideas" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.youtube });
  const capture = async () => { if (!text.trim()) return; await youtubeApi.captureIdea(text.trim()); setText(""); refresh(); };
  const promote = async (id: string) => { await youtubeApi.patchIdea(id, { status: "promoted" }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await youtubeApi.deleteIdea(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Ideas</h1>
      <div className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") capture(); }} placeholder="Capture a video idea…" />
        <Button size="sm" onClick={capture} disabled={!text.trim()}>Capture</Button>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.ideas.length === 0 ? (
        <EmptyState icon={Lightbulb} message="No ideas." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.ideas.map((i) => (
            <Card key={i.id}><CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{i.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <Badge variant="outline">{i.status}</Badge>
                  <button title="Promote" onClick={() => promote(i.id)}><ArrowUpCircle className="h-4 w-4 hover:text-emerald-600" /></button>
                  <button title="Delete" onClick={() => del(i.id)}><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{[i.source, i.est_views ? `~${i.est_views} views` : null, i.score != null ? `score ${i.score}` : null].filter(Boolean).join(" · ")}</div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
