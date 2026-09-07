import { useEffect } from "react";
import { Activity, AlertCircle, Leaf, Sun, Thermometer, Wind } from "lucide-react";
import {
  usePersonalEnvironmentalScore,
  type ColorTier,
  type PersonalScoreHistoryEntry,
} from "../hooks/useEnvironmentalScore";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";

const TIER_CLASSES: Record<ColorTier, { bg: string; text: string; bar: string }> = {
  green:  { bg: "bg-green-100/80 border-green-200",  text: "text-green-700",  bar: "bg-green-500" },
  yellow: { bg: "bg-yellow-100/80 border-yellow-200", text: "text-yellow-700", bar: "bg-yellow-500" },
  orange: { bg: "bg-orange-100/80 border-orange-200", text: "text-orange-700", bar: "bg-orange-500" },
  red:    { bg: "bg-red-100/80 border-red-200",   text: "text-red-700",   bar: "bg-red-500" },
};

const TIER_LABEL: Record<ColorTier, string> = {
  green: "Good",
  yellow: "Moderate",
  orange: "Sensitive",
  red: "Unhealthy",
};

function ScoreCircle({ score, colorTier }: { score: number; colorTier: ColorTier }) {
  const t = TIER_CLASSES[colorTier];
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-full h-28 w-28 border-2 shrink-0", t.bg, t.text)}>
      <span className="text-4xl font-bold tabular-nums leading-none">{score}</span>
      <span className="text-xs font-medium mt-1 uppercase tracking-wide">{TIER_LABEL[colorTier]}</span>
    </div>
  );
}

function ComponentTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | null;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums">
        {value != null ? value : "—"}
      </p>
    </div>
  );
}

function HistoryBar({ entry }: { entry: PersonalScoreHistoryEntry }) {
  const t = TIER_CLASSES[entry.colorTier];
  const height = `${Math.max(8, entry.score)}%`;
  const date = new Date(entry.scoredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex flex-col items-center gap-1 flex-1 min-w-0" title={`${date}: ${entry.score}`}>
      <div className="w-full flex flex-col justify-end" style={{ height: "48px" }}>
        <div
          className={cn("w-full rounded-sm", t.bar)}
          style={{ height }}
        />
      </div>
    </div>
  );
}

export function Health() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Environmental Score" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = usePersonalEnvironmentalScore(selectedCompanyId);

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Select a company to view your environmental score." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error instanceof Error ? error.message : "Failed to load environmental score"}</span>
      </div>
    );
  }

  const today = data?.today ?? null;
  const history = data?.history ?? [];

  return (
    <div className="space-y-6">
      {/* Today's score */}
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
          Today's Environmental Score
        </p>
        {today ? (
          <div className="flex items-center gap-5 flex-wrap">
            <ScoreCircle score={today.score} colorTier={today.colorTier} />
            <div className="space-y-1 text-sm">
              {today.confidenceFlag && (
                <p className="text-xs text-muted-foreground">
                  Low confidence signal{today.partialSignals.length > 0 ? `: ${today.partialSignals.join(", ")}` : ""}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Updated {new Date(today.scoredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No score recorded yet for today.</p>
        )}
      </div>

      {/* Component breakdown */}
      {today && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Component Scores
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ComponentTile label="AQI" value={today.components.aqi} icon={Wind} />
            <ComponentTile label="UV" value={today.components.uv} icon={Sun} />
            <ComponentTile label="Heat Stress" value={today.components.heatStress} icon={Thermometer} />
            <ComponentTile label="Greenspace" value={today.components.greenspace} icon={Leaf} />
          </div>
        </div>
      )}

      {/* 30-day history */}
      {history.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              30-day History
            </p>
          </div>
          <div className="px-4 py-3 flex items-end gap-0.5">
            {history.slice(0, 30).map((entry, i) => (
              <HistoryBar key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {/* Medical disclaimer */}
      {data?.disclaimer && (
        <p className="text-xs text-muted-foreground border-t border-border pt-4">
          {data.disclaimer}
        </p>
      )}
    </div>
  );
}
