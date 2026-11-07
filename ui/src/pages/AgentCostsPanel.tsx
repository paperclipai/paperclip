import { useTranslation } from "@/i18n";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Coins, DollarSign, PlayCircle, ReceiptText } from "lucide-react";
import type { CostByAgent, CostByAgentModel } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { CostAmount } from "../components/CostAmount";
import { EmptyState } from "../components/EmptyState";
import { MetricCard } from "../components/MetricCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useDateRange, PRESET_KEYS, PRESET_LABELS } from "../hooks/useDateRange";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, formatCents, formatTokens, providerDisplayName } from "../lib/utils";

export function agentCostRow(rows: readonly CostByAgent[] | undefined, agentId: string): CostByAgent | null {
  return rows?.find((row) => row.agentId === agentId) ?? null;
}

export function agentModelCostRows(rows: readonly CostByAgentModel[] | undefined, agentId: string): CostByAgentModel[] {
  return (rows ?? [])
    .filter((row) => row.agentId === agentId)
    .sort((a, b) => b.costCents - a.costCents);
}

export function AgentCostsPanel({ agentId, agentName, companyId }: { agentId: string; agentName: string; companyId: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, from, to, customReady } = useDateRange();
  const reportFrom = ["custom", "mtd", "ytd"].includes(preset) ? from || undefined : undefined;
  const reportTo = preset === "custom" ? to || undefined : preset;
  const spend = useQuery({
    queryKey: [...queryKeys.costs(companyId, reportFrom, reportTo), "agent", agentId],
    queryFn: async () => {
      const [byAgent, byAgentModel] = await Promise.all([
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byAgentModel(companyId, from || undefined, to || undefined),
      ]);
      return { row: agentCostRow(byAgent, agentId), models: agentModelCostRows(byAgentModel, agentId) };
    },
    enabled: customReady,
    refetchInterval: 30_000,
  });
  const row = spend.data?.row ?? null;
  const models = spend.data?.models ?? [];
  const totalTokens = useMemo(
    () => (row ? row.inputTokens + row.cachedInputTokens + row.outputTokens : 0),
    [row],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={translateAgentPage("agents:cost_period")}>
        {PRESET_KEYS.map((key) => (
          <Button key={key} variant={preset === key ? "secondary" : "ghost"} size="sm" onClick={() => setPreset(key)} aria-pressed={preset === key}>
            {PRESET_LABELS[key]}
          </Button>
        ))}
      </div>
      {preset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
          <input type="date" aria-label={translateAgentPage("agents:from")} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
          <span className="text-sm text-muted-foreground">{translateAgentPage("agents:to")}</span>
          <input type="date" aria-label={translateAgentPage("agents:to_ae79ea")} value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        </div>
      ) : null}
      {!customReady ? (
        <p className="text-sm text-muted-foreground">{translateAgentPage("agents:select_a_start_and_end_date_to_load")}</p>
      ) : spend.isLoading ? (
        <PageSkeleton variant="costs" />
      ) : spend.error && !spend.data ? (
        <p role="alert" className="text-sm text-destructive">{agentName}{translateAgentPage("agents:s_costs_could_not_be_loaded_please_try")}</p>
      ) : !row ? (
        <EmptyState icon={DollarSign} message={translateAgentPage("agents:no_cost_events_for_in_this_period", { value1: agentName })} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard appearance="card" icon={ReceiptText} value={formatCents(row.costCents)} label={translateAgentPage("agents:spend")} description={translateAgentPage("agents:ledger_events", { value1: row.eventCount })} />
            <MetricCard appearance="card" icon={Coins} value={formatTokens(totalTokens)} label={translateAgentPage("agents:tokens")} description={translateAgentPage("agents:in_cached_out", { value1: formatTokens(row.inputTokens + row.cachedInputTokens), value2: formatTokens(row.cachedInputTokens), value3: formatTokens(row.outputTokens) })} />
            <MetricCard appearance="card" icon={PlayCircle} value={row.apiRunCount + row.subscriptionRunCount} label={translateAgentPage("agents:runs")} description={translateAgentPage("agents:api_subscription", { value1: row.apiRunCount, value2: row.subscriptionRunCount })} />
          </div>
          <section className="space-y-3" aria-labelledby="agent-cost-models-heading">
            <h3 id="agent-cost-models-heading" className="text-sm font-medium text-foreground">{translateAgentPage("agents:by_model")}</h3>
            {models.length === 0 ? (
              <p className="text-sm text-muted-foreground">{translateAgentPage("agents:no_model_breakdown_for_this_period")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {models.map((model) => {
                  const share = row.costCents > 0 ? Math.round((model.costCents / row.costCents) * 100) : 0;
                  return (
                    <li key={`${model.provider}:${model.model}:${model.billingType}`} className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-foreground">
                          {providerDisplayName(model.provider)}
                          <span className="mx-1 text-muted-foreground">/</span>
                          <span className="font-mono">{model.model}</span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {providerDisplayName(model.biller)} · {billingTypeDisplayName(model.billingType)}
                        </div>
                      </div>
                      <div className="text-right tabular-nums">
                        <CostAmount
                          costCents={model.costCents}
                          eventCount={model.eventCount}
                          estimatedEventCount={model.estimatedEventCount}
                          suffix={<span className="ml-1 font-normal text-muted-foreground">({share}%)</span>}
                        />
                        <div className="text-xs text-muted-foreground">
                          {formatTokens(model.inputTokens + model.cachedInputTokens + model.outputTokens)}{" "}{translateAgentPage("agents:tok")}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
