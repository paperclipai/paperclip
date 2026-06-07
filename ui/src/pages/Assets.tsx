import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package, Search, Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { marketingApi, type AssetRow, type AssetStage } from "../api/marketing";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "../lib/utils";
import { AgnbSubnav } from "../components/AgnbSubnav";

const STAGES: Array<{ key: AssetStage | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "awareness", label: "Awareness" },
  { key: "interest", label: "Interest" },
  { key: "evaluation", label: "Evaluation" },
  { key: "decision", label: "Decision" },
  { key: "onboard", label: "Onboard" },
  { key: "retention", label: "Retention" },
];

function statusTone(status: AssetRow["status"]): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

export function Assets() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<AssetStage | "all">("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Assets" }]);
  }, [setBreadcrumbs]);

  // Server-side search by title; stage filtered client-side (cheap, <500 rows).
  const { data: assets, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.assets(search.trim()),
    queryFn: () => marketingApi.list(search.trim() || undefined),
  });

  const byStage = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of assets ?? []) m[a.stage] = (m[a.stage] ?? 0) + 1;
    return m;
  }, [assets]);

  const visible = useMemo(
    () => (assets ?? []).filter((a) => stage === "all" || a.stage === stage),
    [assets, stage],
  );

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Assets</h1>
          <p className="text-sm text-muted-foreground">
            Sales enablement — pitches, case studies, battlecards, contracts.
            Grouped by funnel stage; each is HTML with <code>{`{{vars}}`}</code>.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/assets/new">
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New asset
          </Link>
        </Button>
      </div>
      <AgnbSubnav group="assets" />

      {error && (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Total" value={(assets?.length ?? 0).toString()} />
        <StatCard label="Awareness" value={(byStage.awareness ?? 0).toString()} sub="ToFu" />
        <StatCard
          label="Eval + Decision"
          value={((byStage.evaluation ?? 0) + (byStage.decision ?? 0)).toString()}
          sub="BoFu"
        />
        <StatCard
          label="Post-sale"
          value={((byStage.onboard ?? 0) + (byStage.retention ?? 0)).toString()}
          sub="onboard + retention"
        />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title…"
          className="pl-8"
        />
      </div>

      {/* Stage filter */}
      <div className="flex flex-wrap gap-1.5">
        {STAGES.map((s) => {
          const count = s.key === "all" ? (assets?.length ?? 0) : (byStage[s.key] ?? 0);
          return (
            <button
              key={s.key}
              onClick={() => setStage(s.key)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                stage === s.key
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent/50",
              )}
            >
              {s.label} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Package} message="No assets in this stage." />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((a) => (
            <Link
              key={a.id}
              to={`/assets/${a.id}`}
              className="block"
            >
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{a.title}</span>
                      <Badge variant={statusTone(a.status)}>{a.status}</Badge>
                      {(a.variables?.length ?? 0) > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {`{{${a.variables!.length}}}`}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {a.stage} · {a.kind} · v{a.version} · {a.created_by}
                    </div>
                    {(a.notes || a.body_preview) && (
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/80">
                        {a.notes || a.body_preview}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    {(a.fill_count ?? 0) > 0 ? (
                      <div>
                        {a.fill_count} fill{a.fill_count === 1 ? "" : "s"}
                        {a.last_fill_customer && (
                          <div className="opacity-70">{a.last_fill_customer}</div>
                        )}
                      </div>
                    ) : (
                      <span className="opacity-50">no fills</span>
                    )}
                    <div className="mt-1 opacity-60">{relativeTime(a.updated_at)}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground/70">{sub}</div>}
      </CardContent>
    </Card>
  );
}
