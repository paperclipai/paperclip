import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Type, Crown, Trash2 } from "lucide-react";
import { youtubeApi, type YtTitle } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function YoutubeTitles() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Title tester" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.youtube });
  const win = async (id: string) => { await youtubeApi.titleWinner(id).catch(() => {}); refresh(); };
  const del = async (id: string) => { await youtubeApi.deleteTitle(id).catch(() => {}); refresh(); };

  const scriptTitle = (id: string) => data?.scripts.find((s) => s.id === id)?.title ?? "(script)";
  const byScript = new Map<string, YtTitle[]>();
  for (const t of data?.titles ?? []) {
    const arr = byScript.get(t.script_id) ?? [];
    arr.push(t);
    byScript.set(t.script_id, arr);
  }

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Title tester</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.titles.length === 0 ? (
        <EmptyState icon={Type} message="No titles." />
      ) : (
        <div className="space-y-4">
          {[...byScript.entries()].map(([sid, titles]) => (
            <div key={sid}>
              <h2 className="mb-1 text-sm font-medium text-muted-foreground">{scriptTitle(sid)}</h2>
              <div className="flex flex-col gap-1">
                {titles.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                    <span className="flex items-center gap-1.5">{t.is_winner && <Crown className="h-3.5 w-3.5 text-amber-500" />}{t.title}</span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      {t.ctr_pct != null ? `${t.ctr_pct}% CTR` : `${t.votes ?? 0} votes`}
                      {!t.is_winner && <button title="Mark winner" onClick={() => win(t.id)}><Crown className="h-3.5 w-3.5 hover:text-amber-500" /></button>}
                      <button title="Delete" onClick={() => del(t.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
