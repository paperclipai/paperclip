import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { useMemo } from "react";
import { DATA_KEYS } from "../constants.js";

interface TopSpender {
  agentId: string;
  totalCents: number;
  count: number;
  meanCents: number;
  byModel: Record<string, number>;
  byProvider: Record<string, number>;
  lastOccurredAt: string | null;
}

interface RecentAnomaly {
  rule: "z_score" | "absolute_ceiling";
  agentId: string;
  model: string;
  provider: string;
  costCents: number;
  meanCents: number | null;
  zScore: number | null;
  reason: string;
  detectedAt: string;
}

interface BudgetIncident {
  scopeType: string | null;
  scopeId: string | null;
  reason: string | null;
  openedAt: string | null;
}

interface OverviewData {
  configured: boolean;
  topSpenders: TopSpender[];
  recentAnomalies: RecentAnomaly[];
  openBudgetIncidents: BudgetIncident[];
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ruleLabel(rule: RecentAnomaly["rule"]): string {
  return rule === "z_score" ? "Spike" : "Ceiling";
}

export function CostClipperWidget({ context }: PluginWidgetProps) {
  const params = useMemo(() => ({ companyId: context.companyId ?? "" }), [context.companyId]);
  const { data, loading, error } = usePluginData<OverviewData>(DATA_KEYS.overview, params);

  if (loading) {
    return (
      <div className="border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
        Loading cost signal…
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
        <div className="font-medium text-foreground">Cost Clipper unavailable</div>
        <div className="mt-1 text-muted-foreground">{error.message}</div>
      </div>
    );
  }

  if (!data || !data.configured) {
    return (
      <div className="border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
        Select a company to see cost signal.
      </div>
    );
  }

  const { topSpenders, recentAnomalies, openBudgetIncidents } = data;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Cost Clipper</h3>
        {openBudgetIncidents.length > 0 ? (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
            {openBudgetIncidents.length} budget incident{openBudgetIncidents.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Nominal
          </span>
        )}
      </header>

      <section>
        <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Recent anomalies
        </div>
        {recentAnomalies.length === 0 ? (
          <div className="text-sm text-muted-foreground">No anomalies detected.</div>
        ) : (
          <ul className="space-y-1.5">
            {recentAnomalies.slice(0, 5).map((anomaly, index) => (
              <li
                key={`${anomaly.agentId}:${anomaly.detectedAt}:${index}`}
                className="flex items-start gap-2 border-b border-border/60 pb-1.5 text-sm last:border-b-0"
              >
                <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                  {ruleLabel(anomaly.rule)}
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <span className="font-mono text-foreground">{dollars(anomaly.costCents)}</span>{" "}
                  on <span className="font-mono">{anomaly.model}</span>
                  {anomaly.zScore !== null ? (
                    <span className="text-muted-foreground"> · {anomaly.zScore}σ</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Top spenders
        </div>
        {topSpenders.length === 0 ? (
          <div className="text-sm text-muted-foreground">No cost events yet.</div>
        ) : (
          <ul className="space-y-1">
            {topSpenders.slice(0, 5).map((spender) => (
              <li key={spender.agentId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{spender.agentId}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{dollars(spender.totalCents)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{spender.count} runs</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
