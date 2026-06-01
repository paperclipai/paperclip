import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Sparkles, X } from "lucide-react";
import { agnbPagesApi, type RematchSuggestion } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function Attribution() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Attribution" }]), [setBreadcrumbs]);
  const [rematchOpen, setRematchOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.attribution,
    queryFn: () => agnbPagesApi.attribution(),
  });

  const total = (data?.matched ?? 0) + (data?.unmatched ?? 0);
  const matchPct = total > 0 ? Math.round(((data?.matched ?? 0) / total) * 100) : 0;

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Attribution</h1>
        <Button size="sm" variant="outline" onClick={() => setRematchOpen(true)}>
          <Sparkles className="mr-1 h-3.5 w-3.5" /> Gemini rematch
        </Button>
      </div>
      {rematchOpen && <RematchModal onClose={() => setRematchOpen(false)} />}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Link2} message="No attribution data." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Match rate</div><div className="text-xl font-semibold">{matchPct}%</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Unmatched</div><div className={cnNum(data.unmatched)}>{data.unmatched}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Matched</div><div className="text-xl font-semibold">{data.matched}</div></CardContent></Card>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Recent unmatched</h2>
          {data.recent_unmatched.length === 0 ? (
            <p className="text-xs text-muted-foreground">none — all attributed</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.recent_unmatched.map((e) => (
                <Card key={e.id}>
                  <CardContent className="flex items-center justify-between gap-3 p-2.5 text-sm">
                    <div className="min-w-0">
                      <Badge variant="outline">{e.event_type}</Badge>
                      <span className="ml-2">{e.contact_name ?? e.email ?? "unknown"}</span>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      {e.amount_usd ? <span className="text-emerald-600">${e.amount_usd}</span> : null}
                      <div>{e.source} · {relativeTime(e.occurred_at)}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function cnNum(unmatched: number) {
  return unmatched > 5 ? "text-xl font-semibold text-amber-600" : "text-xl font-semibold";
}

function RematchModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<RematchSuggestion[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const preview = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await agnbPagesApi.attributionRematch(false);
      setSuggestions(r.suggestions); setNote(r.note ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await agnbPagesApi.attributionRematch(true);
      qc.invalidateQueries({ queryKey: queryKeys.agnb.attribution });
      setNote(`Applied ${r.applied ?? 0} matches.`);
      setSuggestions(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };

  useEffect(() => { preview(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Gemini rematch</h3>
          <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
        </div>
        {busy && <p className="text-xs text-muted-foreground">Working…</p>}
        {err && <p className="text-xs text-destructive">{err}</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {suggestions && suggestions.length > 0 && (
          <div className="mt-2 space-y-1">
            {suggestions.map((s) => (
              <div key={s.event_id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex justify-between"><span className="font-mono">{s.event_id.slice(0, 8)}</span><Badge variant="outline">{Math.round(s.confidence * 100)}%</Badge></div>
                <div className="text-muted-foreground">{s.reason}</div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={apply} disabled={busy || !suggestions?.length}>Apply (conf ≥ 0.7)</Button>
        </div>
      </div>
    </div>
  );
}
