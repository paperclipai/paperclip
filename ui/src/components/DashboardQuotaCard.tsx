import type {
  CredentialType,
  ProviderCredentialQuota,
  ProviderCredentialUsage,
  QuotaWindow,
} from "@paperclipai/shared";
import { Gauge, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  cn,
  formatCents,
  formatTokens,
  quotaSourceDisplayName,
} from "@/lib/utils";
import { DotMatrixText, LedProgress } from "./NothingAesthetic";

interface DashboardQuotaCardProps {
  results: ProviderCredentialQuota[];
  usage?: ProviderCredentialUsage[];
  isLoading: boolean;
  isFetching: boolean;
  usageLoading?: boolean;
  error?: Error | string | null;
  usageError?: Error | string | null;
  monthTokens: number;
  monthSpendCents: number;
  onRefresh: () => void;
}

function credentialTypeDisplayName(type: CredentialType): string {
  switch (type) {
    case "claude_oauth":
      return "Claude OAuth";
    case "claude_api_key":
      return "Claude API key";
    case "codex_oauth":
      return "Codex OAuth (ChatGPT)";
    case "openai_api_key":
      return "OpenAI API key";
    case "openrouter_api_key":
      return "OpenRouter API key";
    case "gemini_api_key":
      return "Gemini API key";
    case "deepseek_api_key":
      return "DeepSeek API key";
    case "mimo_api_key":
      return "MiMo API key";
    default:
      return type;
  }
}

function formatResetTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return `resets ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
}

function detailText(window: QuotaWindow): string | null {
  const reset = formatResetTime(window.resetsAt);
  const detail = window.detail?.trim() || null;
  if (detail && reset) return `${detail} · ${reset}`;
  return detail ?? reset;
}

function normalizedPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function quotaProgressTone(remainingPercent: number): "success" | "warning" | "danger" {
  if (remainingPercent <= 10) return "danger";
  if (remainingPercent <= 30) return "warning";
  return "success";
}

function totalTokens(usage: ProviderCredentialUsage | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
}

function totalInputTokens(usage: ProviderCredentialUsage | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.cachedInputTokens;
}

function cacheHitPercent(usage: ProviderCredentialUsage | undefined): number | null {
  const inputTokens = totalInputTokens(usage);
  if (inputTokens <= 0) return null;
  return Math.min(100, Math.max(0, (usage!.cachedInputTokens / inputTokens) * 100));
}

function windowTokens(usage: ProviderCredentialUsage | undefined, label: string): number {
  const window = usage?.windows.find((entry) => entry.label === label);
  if (!window) return 0;
  return window.inputTokens + window.cachedInputTokens + window.outputTokens;
}

function usageModelTitle(usage: ProviderCredentialUsage | undefined): string {
  const models = usage?.models ?? [];
  if (models.length === 0) return "Model-aware API value is unavailable for this period.";
  return models
    .slice(0, 8)
    .map((model) => {
      const tokens = model.inputTokens + model.cachedInputTokens + model.outputTokens;
      return [
        `${model.model} (${model.provider}/${model.biller})`,
        `${formatTokens(tokens)} tokens`,
        `${formatCents(model.apiEquivalentCostCents)} API value`,
        model.pricingLabel ?? "recorded/fallback pricing",
      ].join(" · ");
    })
    .join("\n");
}

function topModelLabel(usage: ProviderCredentialUsage | undefined): string {
  const model = usage?.models?.[0]?.model;
  if (!model) return "model pricing unavailable";
  return model.length > 22 ? `${model.slice(0, 21)}…` : model;
}

function usageBreakdown(usage: ProviderCredentialUsage | undefined): string {
  if (!usage) return "cache miss 0 · cache hit 0 · output 0";
  return [
    `cache miss ${formatTokens(usage.inputTokens)}`,
    `cache hit ${formatTokens(usage.cachedInputTokens)}`,
    `output ${formatTokens(usage.outputTokens)}`,
  ].join(" · ");
}

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function billedDetail(costCents: number, includedCents = 0): string {
  const billed = `${formatCents(costCents)} billed`;
  return includedCents > 0 ? `${billed} · ${formatCents(includedCents)} included` : billed;
}

function errorMessage(error: Error | string | null | undefined): string | null {
  return typeof error === "string" ? error : error?.message ?? null;
}

function statusForCredential(
  result: ProviderCredentialQuota,
  windows: QuotaWindow[],
): string {
  const cooldownUntil = result.cooldownUntil ? new Date(result.cooldownUntil).getTime() : Number.NaN;
  const isCooling = Number.isFinite(cooldownUntil) && cooldownUntil > Date.now();
  if (result.disabledAt) return "disabled";
  if (result.quotaBlocked) return "quota blocked";
  if (isCooling) return "cooling";
  if (!result.supported) return "quota n/a";
  if (!result.ok) return result.stale && windows.length > 0 ? "stale" : "unavailable";
  return windows.length > 0 ? "live" : "no windows";
}

function statusClass(status: string): string {
  if (status === "live") return "dashboard-status-chip dashboard-status-live";
  if (status === "disabled" || status === "unavailable" || status === "quota blocked") {
    return "dashboard-status-chip dashboard-status-danger";
  }
  if (status === "cooling" || status === "stale") {
    return "dashboard-status-chip dashboard-status-warning";
  }
  return "dashboard-status-chip dashboard-status-neutral";
}

function Metric({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="dashboard-eyebrow">
        {label}
      </p>
      <span title={title}>
        <DotMatrixText className="dashboard-display-value mt-1 block truncate text-xl leading-none">
          {value}
        </DotMatrixText>
      </span>
      {detail ? (
        <p className="dashboard-supporting-text mt-1 truncate" title={title}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function DashboardQuotaCard({
  results,
  usage = [],
  isLoading,
  isFetching,
  usageLoading = false,
  error = null,
  usageError = null,
  monthTokens,
  monthSpendCents,
  onRefresh,
}: DashboardQuotaCardProps) {
  const quotaError = errorMessage(error);
  const usageErrorText = errorMessage(usageError);
  const usageByCredential = new Map(usage.map((row) => [row.credentialId, row]));
  const usageTotals = usage.reduce(
    (totals, row) => {
      totals.tokens += totalTokens(row);
      totals.freshInput += row.inputTokens;
      totals.cachedInput += row.cachedInputTokens;
      totals.output += row.outputTokens;
      totals.apiValueCents += row.apiEquivalentCostCents;
      totals.subscriptionApiValueCents += row.subscriptionApiEquivalentCostCents;
      totals.billedCents += row.costCents;
      totals.events += row.events;
      return totals;
    },
    {
      tokens: 0,
      freshInput: 0,
      cachedInput: 0,
      output: 0,
      apiValueCents: 0,
      subscriptionApiValueCents: 0,
      billedCents: 0,
      events: 0,
    },
  );
  const totalInput = usageTotals.freshInput + usageTotals.cachedInput;
  const totalCacheHitPercent = totalInput > 0 ? (usageTotals.cachedInput / totalInput) * 100 : null;
  const usageValue = usageLoading ? "…" : usageErrorText ? "—" : formatCents(usageTotals.apiValueCents);
  const usageValueDetail = usageLoading
    ? "loading credential ledger"
    : usageErrorText
      ? "credential ledger unavailable"
      : billedDetail(usageTotals.billedCents, usageTotals.subscriptionApiValueCents);
  const cacheDetail = usageLoading
    ? "loading cache telemetry"
    : usageErrorText
      ? "cache telemetry unavailable"
      : `${formatTokens(usageTotals.cachedInput)} cached`;
  const monthSpendDetail = usageLoading
    ? "loading credential ledger"
    : usageErrorText
      ? "credential ledger unavailable"
      : `${usageTotals.events} credential events`;

  return (
    <Card className="dashboard-quota-card dashboard-surface dashboard-surface-dotted" data-testid="dashboard-provider-quota">
      <CardHeader className="px-4 pb-0 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Gauge className="h-4 w-4 dashboard-tone-accent" />
              Usage quota
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              Live quota windows and month-to-date usage for each configured credential.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={onRefresh}
              disabled={isLoading || isFetching}
            >
              <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              Refresh
            </Button>
            <Link to="/costs" className="dashboard-link text-xs hover:text-foreground">
              Details
            </Link>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div className="dashboard-summary-cell rounded-md border px-3 py-2">
            <Metric label="Month tokens" value={formatTokens(monthTokens)} detail="all recorded runs" />
          </div>
          <div className="dashboard-summary-cell rounded-md border px-3 py-2">
            <Metric label="API value" value={usageValue} detail={usageValueDetail} title="Model-aware equivalent value for managed credentials" />
          </div>
          <div className="dashboard-summary-cell rounded-md border px-3 py-2">
            <Metric label="Month spend" value={formatCents(monthSpendCents)} detail={monthSpendDetail} />
          </div>
          <div className="dashboard-summary-cell rounded-md border px-3 py-2">
            <Metric label="Cache hit" value={usageLoading || usageErrorText ? "—" : formatPercent(totalCacheHitPercent)} detail={cacheDetail} />
          </div>
        </div>

        {usageErrorText ? (
          <div role="status" className="dashboard-subtle-panel rounded-md border px-3 py-2 text-(length:--text-micro) text-muted-foreground">
            Usage details are unavailable: {usageErrorText}. Live quota remains available below.
          </div>
        ) : null}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading live credential quota…</p>
        ) : quotaError ? (
          <div role="alert" className="dashboard-alert dashboard-alert-danger rounded-md px-3 py-2 text-sm">
            Unable to load live credential quota: {quotaError}
          </div>
        ) : results.length === 0 ? (
          <p className="dashboard-subtle-panel rounded-md border px-3 py-3 text-sm text-muted-foreground">
            No configured credentials reported live quota. Open Costs for the recorded usage ledger.
          </p>
        ) : (
          <div className="space-y-3">
            {results.map((result) => {
              const usageRow = usageByCredential.get(result.credentialId);
              const windows = result.quotaWindows.slice(0, 6);
              const status = statusForCredential(result, windows);
              const sourceLabel = result.source ? quotaSourceDisplayName(result.source) : null;
              const cachePercent = cacheHitPercent(usageRow);
              const tokenValue = usageLoading ? "…" : usageErrorText ? "—" : formatTokens(totalTokens(usageRow));
              const apiValue = usageLoading ? "…" : usageErrorText ? "—" : formatCents(usageRow?.apiEquivalentCostCents ?? 0);
              const tokenDetail = usageLoading
                ? "loading usage"
                : usageErrorText
                  ? "credential ledger unavailable"
                  : usageBreakdown(usageRow);
              const apiDetail = usageLoading
                ? "loading pricing"
                : usageErrorText
                  ? "credential ledger unavailable"
                  : billedDetail(
                    usageRow?.costCents ?? 0,
                    usageRow?.subscriptionApiEquivalentCostCents ?? 0,
                  );
              const cacheDetailForCredential = usageLoading
                ? "loading cache data"
                : usageErrorText
                  ? "cache telemetry unavailable"
                : cachePercent == null
                  ? "no input telemetry"
                  : `${formatTokens(usageRow?.cachedInputTokens ?? 0)} cached`;

              return (
                <div key={result.credentialId} className="dashboard-credential-card rounded-md border px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={result.name}>{result.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {credentialTypeDisplayName(result.type)}
                        {sourceLabel ? ` · ${sourceLabel}` : ""}
                      </p>
                    </div>
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-(length:--text-micro)", statusClass(status))}>
                      {status}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Metric label="MTD tokens" value={tokenValue} detail={tokenDetail} />
                    <Metric label="API value" value={apiValue} detail={apiDetail} title={usageModelTitle(usageRow)} />
                    <Metric label="Cache hit" value={formatPercent(cachePercent)} detail={cacheDetailForCredential} />
                  </div>

                  {usageRow?.models?.length ? (
                    <p className="mt-2 truncate text-(length:--text-micro) text-muted-foreground" title={usageModelTitle(usageRow)}>
                      top model: {topModelLabel(usageRow)} · {usageRow.events} run{usageRow.events === 1 ? "" : "s"}
                    </p>
                  ) : null}

                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-(length:--text-micro) text-muted-foreground sm:grid-cols-4">
                    <span>cache miss {formatTokens(usageRow?.inputTokens ?? 0)}</span>
                    <span>cache hit {formatTokens(usageRow?.cachedInputTokens ?? 0)}</span>
                    <span>output {formatTokens(usageRow?.outputTokens ?? 0)}</span>
                    <span className="text-right">{usageRow?.events ?? 0} event{usageRow?.events === 1 ? "" : "s"}</span>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-(length:--text-micro) text-muted-foreground">
                      <span>cache input coverage</span>
                      <DotMatrixText className="shrink-0 text-xs text-foreground">
                        {formatPercent(cachePercent)}
                      </DotMatrixText>
                    </div>
                    {usageLoading || usageErrorText ? (
                      <p className="text-(length:--text-micro) text-muted-foreground">
                        {usageLoading ? "cache telemetry loading" : "cache telemetry unavailable"}
                      </p>
                    ) : (
                      <div
                        role="progressbar"
                        aria-label={`${result.name} cache hit coverage`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(cachePercent ?? 0)}
                      >
                        <LedProgress percent={cachePercent ?? 0} tone="success" />
                      </div>
                    )}
                  </div>

                  <div className="mt-3 space-y-3">
                    {result.stale && result.error ? (
                      <p className="text-(length:--text-micro) text-muted-foreground" title={result.error}>
                        showing last successful quota sample
                      </p>
                    ) : null}
                    {!result.supported ? (
                      <p className="text-(length:--text-micro) text-muted-foreground">
                        Live quota is not available for this credential type.
                      </p>
                    ) : !result.ok && windows.length === 0 ? (
                      <p className="text-(length:--text-micro) dashboard-tone-danger">
                        {result.error ?? "This credential could not report live quota."}
                      </p>
                    ) : windows.length === 0 ? (
                      <p className="text-(length:--text-micro) text-muted-foreground">No quota windows reported.</p>
                    ) : (
                      windows.map((window, windowIndex) => {
                        const usedPercent = normalizedPercent(window.usedPercent);
                        const remainingPercent = usedPercent == null ? null : 100 - usedPercent;
                        const detail = detailText(window);
                        const rightLabel = remainingPercent == null
                          ? window.valueLabel ?? "reported"
                          : `${Math.round(remainingPercent)}% left`;

                        return (
                          <div key={`${window.label}-${windowIndex}`} className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate text-muted-foreground">{window.label}</span>
                              <DotMatrixText className="shrink-0 text-xs text-foreground">{rightLabel}</DotMatrixText>
                            </div>
                            {detail ? <p className="truncate text-(length:--text-micro) text-muted-foreground">{detail}</p> : null}
                            {remainingPercent != null ? (
                              <div
                                role="progressbar"
                                aria-label={`${result.name} ${window.label} quota remaining`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(remainingPercent)}
                                aria-valuetext={`${Math.round(remainingPercent)}% remaining (${Math.round(usedPercent!)}% used)`}
                              >
                                <LedProgress
                                  percent={remainingPercent}
                                  tone={quotaProgressTone(remainingPercent)}
                                  showDeficitNotch={remainingPercent > 0 && remainingPercent <= 10}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                    {!result.ok && result.error && windows.length > 0 ? (
                      <p className="text-(length:--text-micro) text-muted-foreground">{result.error}</p>
                    ) : null}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-1.5 text-(length:--text-micro) text-muted-foreground">
                    <span>
                      5h {usageLoading || usageErrorText ? "—" : formatTokens(windowTokens(usageRow, "5h"))}
                    </span>
                    <span className="text-right">
                      7d {usageLoading || usageErrorText
                        ? "—"
                        : formatCents(usageRow?.windows.find((entry) => entry.label === "7d")?.apiEquivalentCostCents ?? 0)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
