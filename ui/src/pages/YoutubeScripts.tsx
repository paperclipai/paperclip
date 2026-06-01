import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Trash2 } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STAGES = ["outline", "script", "storyboard", "shot_list", "recording", "editing", "scheduled", "published"];

export function YoutubeScripts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Scripts" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.youtube });
  const create = async () => { if (!title.trim()) return; await youtubeApi.createScript(title.trim()); setTitle(""); refresh(); };
  const setStage = async (id: string, status: string) => { await youtubeApi.patchScript(id, { status }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await youtubeApi.deleteScript(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Scripts</h1>
      <div className="flex gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} placeholder="New script title…" />
        <Button size="sm" onClick={create} disabled={!title.trim()}>Add</Button>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.scripts.length === 0 ? (
        <EmptyState icon={FileText} message="No scripts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Stage</th><th className="p-2 text-right">Duration</th><th className="p-2 text-right">Views</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.scripts.map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="p-2">{s.title}</td>
                  <td className="p-2">
                    <select value={s.status} onChange={(e) => setStage(s.id, e.target.value)} className="rounded border border-border bg-background px-1 py-0.5 text-xs">
                      {STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-right">{s.duration_sec ? `${Math.round(s.duration_sec / 60)}m` : "—"}</td>
                  <td className="p-2 text-right">{s.views ?? 0}</td>
                  <td className="p-2"><button onClick={() => del(s.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
