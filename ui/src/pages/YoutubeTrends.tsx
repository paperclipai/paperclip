import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import { youtubeApi, type Trend } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function YoutubeTrends() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Trends" }]), [setBreadcrumbs]);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [busy, setBusy] = useState(false);
  const [promoted, setPromoted] = useState<Set<number>>(new Set());

  const fetchTrends = async () => {
    setBusy(true); setPromoted(new Set());
    try { setTrends(await youtubeApi.fetchTrends()); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  const promote = async (i: number, t: Trend) => { await youtubeApi.promoteTrend(t).catch((e) => alert(e instanceof Error ? e.message : "Failed")); setPromoted((s) => new Set(s).add(i)); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trends</h1>
        <Button size="sm" onClick={fetchTrends} disabled={busy}>{busy ? "Fetching…" : "Fetch trends"}</Button>
      </div>
      {trends.length === 0 ? (
        <EmptyState icon={TrendingUp} message="Fetch trends to surface video angles, then promote to the Ideas wall." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {trends.map((t, i) => (
            <Card key={i}><CardContent className="p-3">
              <div className="flex items-start justify-between gap-2"><span className="font-medium">{t.title}</span><Badge variant="outline">{t.source}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">{t.angle}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">score {t.score}</span>
                <Button size="sm" variant="outline" onClick={() => promote(i, t)} disabled={promoted.has(i)}>{promoted.has(i) ? "Promoted ✓" : "To idea wall"}</Button>
              </div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
