import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Trash2 } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Button } from "@/components/ui/button";

const STATUSES = ["idea", "scripted", "recorded", "edited", "scheduled", "published"];

export function YoutubeShorts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Shorts mill" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [milling, setMilling] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.youtube });
  const mill = async () => { setMilling(true); try { await youtubeApi.millShorts(); refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setMilling(false); } };
  const setStatus = async (id: string, status: string) => { await youtubeApi.patchShort(id, { status }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await youtubeApi.deleteShort(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Shorts mill</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={mill} disabled={milling}>{milling ? "Milling…" : "Mill shorts"}</Button>
          <Button size="sm" onClick={() => setOpen(true)}>Add short</Button>
        </div>
      </div>
      {open && (
        <AgnbFormModal
          title="Add short"
          fields={[{ key: "title", label: "Title", required: true }, { key: "duration_sec", label: "Duration (sec)", type: "number" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await youtubeApi.addShort({ title: v.title, duration_sec: v.duration_sec ? Number(v.duration_sec) : undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.shorts.length === 0 ? (
        <EmptyState icon={Clapperboard} message="No shorts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Status</th><th className="p-2 text-right">Dur</th><th className="p-2">IG</th><th className="p-2 text-right">Views</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.shorts.map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="p-2">{s.title}</td>
                  <td className="p-2">
                    <select value={s.status} onChange={(e) => setStatus(s.id, e.target.value)} className="rounded border border-border bg-background px-1 py-0.5 text-xs">
                      {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-right">{s.duration_sec ? `${s.duration_sec}s` : "—"}</td>
                  <td className="p-2">{s.cross_post_ig ? "✓" : "—"}</td>
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
