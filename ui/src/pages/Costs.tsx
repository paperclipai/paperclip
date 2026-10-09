import { DecisionHistory } from "../components/decision-models/DecisionHistory";
import { useSearchParams } from "@/lib/router";
import { CostEstimateLabel } from "../components/CostEstimateLabel";
import { CostByUserTable } from "../components/CostByUserTable";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BudgetPolicySummary,
  CostByAgentModel,
  CostByBiller,
  CostByProviderModel,
  CostWindowSpendRow,
  FinanceEvent,
  QuotaWindow,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Coins, DollarSign, ReceiptText } from "lucide-react";
import { budgetsApi } from "../api/budgets";
import { costsApi } from "../api/costs";
import { BillerSpendCard } from "../components/BillerSpendCard";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { EmptyState } from "../components/EmptyState";
import { FinanceBillerCard } from "../components/FinanceBillerCard";
import { FinanceKindCard } from "../components/FinanceKindCard";
import { FinanceTimelineCard } from "../components/FinanceTimelineCard";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDateRange, PRESET_KEYS, PRESET_LABELS } from "../hooks/useDateRange";
import { retainQuotaWindows } from "../lib/quota-refresh";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const NO_COMPANY = "__none__";
export type CostsMainTab = "overview" | "budgets" | "providers" | "billers" | "finance" | "decisions";

export interface CostsProps {
  /** Render inside Audit without a second page-level title or breadcrumb. */
  embedded?: boolean;
  initialTab?: CostsMainTab;
  /** Pin the surface to one tab (used by Audit > Budgets). */
  lockTab?: boolean;
  /** Budgets is a peer Audit section, so omit it from the Costs sub-navigation. */
  hideBudgetsTab?: boolean;
}

function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59, 999);
  return { from: mon.toISOString(), to: sun.toISOString() };
}

function ProviderTabLabel({ provider, rows }: { provider: string; rows: CostByProviderModel[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(provider)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

function BillerTabLabel({ biller, rows }: { biller: string; rows: CostByBiller[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(biller)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: ReactNode;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="block p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Card>
  );
}

function FinanceSummaryCard({
  debitCents,
  creditCents,
  netCents,
  estimatedDebitCents,
  eventCount,
}: {
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
}) {
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Finance ledger</CardTitle>
        <CardDescription>
          Account-level charges that do not map to a single inference request.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Debits"
          value={formatCents(debitCents)}
          subtitle={`${eventCount} total event${eventCount === 1 ? "" : "s"} in range`}
          icon={ArrowUpRight}
        />
        <MetricTile
          label="Credits"
          value={formatCents(creditCents)}
          subtitle="Refunds, offsets, and credit returns"
          icon={ArrowDownLeft}
        />
        <MetricTile
          label="Net"
          value={formatCents(netCents)}
          subtitle="Debit minus credit for the selected period"
          icon={ReceiptText}
        />
        <MetricTile
          label="Estimated"
          value={formatCents(estimatedDebitCents)}
          subtitle="Estimated debits that are not yet invoice-authoritative"
          icon={Coins}
        />
      </CardContent>
    </Card>
  );
}

export function Costs({
  embedded = false,
  initialTab = "overview",
  lockTab = false,
  hideBudgetsTab = false,
}: CostsProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  const [mainTab, setMainTab] = useState<CostsMainTab>(initialTab);
  const [activeProvider, setActiveProvider] = useState("all");
  const [activeBiller, setActiveBiller] = useState("all");
  const showSummaryChrome = !(embedded && lockTab && initialTab === "budgets");

  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: "Costs" }]);
  }, [embedded, setBreadcrumbs]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    setMainTab(!lockTab && tab && ["overview", "providers", "billers", "finance", "budgets", "decisions"].includes(tab) ? tab as CostsMainTab : initialTab);
  }, [initialTab, lockTab, searchParams]);

  const [today, setToday] = useState(() => new Date().toDateString());
  const todayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const schedule = () => {
      const now = new Date();
      const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
      todayTimerRef.current = setTimeout(() => {
        setToday(new Date().toDateString());
        schedule();
      }, ms);
    };
    schedule();
    return () => {
      if (todayTimerRef.current != null) clearTimeout(todayTimerRef.current);
    };
  }, []);

  const weekRange = useMemo(() => currentWeekRange(), [today]);
  const companyId = selectedCompanyId ?? NO_COMPANY;
  // The clock advances the request bounds, not the identity of the report.
  // Keep successful data visible during polling; a different company or selected
  // period still gets its own cache entry and initial loading state.
  // Month/year-to-date become a different reporting period at their UTC
  // boundary. Rolling windows retain identity as their lower bound advances.
  const reportQueryFrom = ["custom", "mtd", "ytd"].includes(preset) ? from || undefined : undefined;
  const reportQueryTo = preset === "custom" ? to || undefined : preset;

  const { data: budgetData, isLoading: budgetLoading, error: budgetError } = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: !!selectedCompanyId && customReady,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const invalidateBudgetViews = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId) });
  };

  const policyMutation = useMutation({
    mutationFn: ({ summary, changes }: {
      summary: BudgetPolicySummary;
      changes: Partial<Pick<BudgetPolicySummary, "amount" | "reservationCents" | "unpricedUsagePolicy">>;
    }) => budgetsApi.upsertPolicy(companyId, {
      scopeType: summary.scopeType,
      scopeId: summary.scopeId,
      metric: summary.metric,
      windowKind: summary.windowKind,
      ...changes,
    }),
    onSuccess: invalidateBudgetViews,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, input),
    onSuccess: invalidateBudgetViews,
  });

  const { data: spendData, isLoading: spendLoading, error: spendError } = useQuery({
    queryKey: queryKeys.costs(companyId, reportQueryFrom, reportQueryTo),
    queryFn: async () => {
      const [summary, byAgent, byProject, byAgentModel] = await Promise.all([
        costsApi.summary(companyId, from || undefined, to || undefined),
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byProject(companyId, from || undefined, to || undefined),
        costsApi.byAgentModel(companyId, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject, byAgentModel };
    },
    enabled: !!selectedCompanyId && customReady && showSummaryChrome,
    refetchInterval: 30_000,
  });

  const { data: userSpendData, error: userSpendError } = useQuery({
    queryKey: [...queryKeys.costs(companyId, reportQueryFrom, reportQueryTo), "by-user"],
    queryFn: () => costsApi.byUser(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && showSummaryChrome && mainTab === "overview",
    refetchInterval: 30_000,
  });

  const { data: financeData, isLoading: financeLoading, error: financeError } = useQuery({
    queryKey: [
      queryKeys.financeSummary(companyId, reportQueryFrom, reportQueryTo),
      queryKeys.financeByBiller(companyId, reportQueryFrom, reportQueryTo),
      queryKeys.financeByKind(companyId, reportQueryFrom, reportQueryTo),
      queryKeys.financeEvents(companyId, reportQueryFrom, reportQueryTo, 18),
    ],
    queryFn: async () => {
      const [summary, byBiller, byKind, events] = await Promise.all([
        costsApi.financeSummary(companyId, from || undefined, to || undefined),
        costsApi.financeByBiller(companyId, from || undefined, to || undefined),
        costsApi.financeByKind(companyId, from || undefined, to || undefined),
        costsApi.financeEvents(companyId, from || undefined, to || undefined, 18),
      ]);
      return { summary, byBiller, byKind, events };
    },
    enabled: !!selectedCompanyId && customReady && showSummaryChrome,
    refetchInterval: 30_000,
  });

  const [expandedAgents, setExpandedAgents] = useState<Set<string | null>>(new Set());
  useEffect(() => {
    setExpandedAgents(new Set());
  }, [companyId, preset, customFrom, customTo]);

  function toggleAgent(agentId: string | null) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const agentModelRows = useMemo(() => {
    const map = new Map<string | null, CostByAgentModel[]>();
    for (const row of spendData?.byAgentModel ?? []) {
      const rows = map.get(row.agentId) ?? [];
      rows.push(row);
      map.set(row.agentId, rows);
    }
    for (const [agentId, rows] of map) {
      map.set(agentId, rows.slice().sort((a, b) => b.costCents - a.costCents));
    }
    return map;
  }, [spendData?.byAgentModel]);

  const { data: providerData, error: providerError } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, reportQueryFrom, reportQueryTo),
    queryFn: () => costsApi.byProvider(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: billerData, error: billerError } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, reportQueryFrom, reportQueryTo),
    queryFn: () => costsApi.byBiller(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekData, error: weekError } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekBillerData, error: weekBillerError } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byBiller(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: windowData, error: windowError } = useQuery({
    queryKey: queryKeys.usageWindowSpend(companyId),
    queryFn: () => costsApi.windowSpend(companyId),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: quotaData, isLoading: quotaLoading, error: quotaFetchError } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    structuralSharing: (previous, incoming) => retainQuotaWindows(
      previous as ProviderQuotaResult[] | undefined,
      incoming as ProviderQuotaResult[],
    ),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const byProvider = useMemo(() => {
    const map = new Map<string, CostByProviderModel[]>();
    for (const row of providerData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [providerData]);

  const byBiller = useMemo(() => {
    const map = new Map<string, CostByBiller[]>();
    for (const row of billerData ?? []) {
      const rows = map.get(row.biller) ?? [];
      rows.push(row);
      map.set(row.biller, rows);
    }
    return map;
  }, [billerData]);

  const weekSpendByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekData ?? []) {
      map.set(row.provider, (map.get(row.provider) ?? 0) + row.costCents);
    }
    return map;
  }, [weekData]);

  const weekSpendByBiller = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekBillerData ?? []) {
      map.set(row.biller, (map.get(row.biller) ?? 0) + row.costCents);
    }
    return map;
  }, [weekBillerData]);

  const windowSpendByProvider = useMemo(() => {
    const map = new Map<string, CostWindowSpendRow[]>();
    for (const row of windowData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [windowData]);

  const quotaWindowsByProvider = useMemo(() => {
    const map = new Map<string, QuotaWindow[]>();
    for (const result of quotaData ?? []) {
      if (result.windows.length > 0) {
        map.set(result.provider, result.windows);
      }
    }
    return map;
  }, [quotaData]);

  const quotaErrorsByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (!result.ok) map.set(result.provider, "unavailable");
    }
    if (quotaFetchError) {
      map.set("anthropic", "unavailable");
      map.set("openai", "unavailable");
    }
    return map;
  }, [quotaData, quotaFetchError]);

  const quotaSourcesByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (typeof result.source === "string" && result.source.length > 0) {
        map.set(result.provider, result.source);
      }
    }
    return map;
  }, [quotaData]);

  const deficitNotchByProvider = useMemo(() => {
    const map = new Map<string, boolean>();
    if (preset !== "mtd") return map;
    const budget = spendData?.summary.budgetCents ?? 0;
    if (budget <= 0) return map;
    const now = new Date();
    const daysElapsed = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    for (const [providerKey, rows] of byProvider) {
      const providerCostCents = rows.reduce((sum, row) => sum + row.costCents, 0);
      const burnRate = providerCostCents / Math.max(daysElapsed, 1);
      map.set(providerKey, providerCostCents + burnRate * (daysInMonth - daysElapsed) > budget);
    }
    return map;
  }, [preset, spendData, byProvider]);

  const providers = useMemo(() => Array.from(byProvider.keys()), [byProvider]);
  const billers = useMemo(() => Array.from(byBiller.keys()), [byBiller]);

  const effectiveProvider =
    activeProvider === "all" || providers.includes(activeProvider) ? activeProvider : "all";
  useEffect(() => {
    if (effectiveProvider !== activeProvider) setActiveProvider("all");
  }, [effectiveProvider, activeProvider]);

  const effectiveBiller =
    activeBiller === "all" || billers.includes(activeBiller) ? activeBiller : "all";
  useEffect(() => {
    if (effectiveBiller !== activeBiller) setActiveBiller("all");
  }, [effectiveBiller, activeBiller]);

  const providerTabItems = useMemo(() => {
    const providerKeys = Array.from(byProvider.keys());
    const allTokens = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0) ?? 0),
      0,
    );
    const allCents = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All providers</span>
            {providerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...providerKeys.map((provider) => ({
        value: provider,
        label: <ProviderTabLabel provider={provider} rows={byProvider.get(provider) ?? []} />,
      })),
    ];
  }, [byProvider]);

  const billerTabItems = useMemo(() => {
    const billerKeys = Array.from(byBiller.keys());
    const allTokens = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0) ?? 0),
      0,
    );
    const allCents = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All billers</span>
            {billerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...billerKeys.map((biller) => ({
        value: biller,
        label: <BillerTabLabel biller={biller} rows={byBiller.get(biller) ?? []} />,
      })),
    ];
  }, [byBiller]);

  const inferenceTokenTotal =
    (spendData?.byAgent ?? []).reduce(
      (sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens,
      0,
    );

  const topFinanceEvents = (financeData?.events ?? []) as FinanceEvent[];
  const budgetPolicies = budgetData?.policies ?? [];
  const activeBudgetIncidents = budgetData?.activeIncidents ?? [];
  const budgetPoliciesByScope = useMemo(() => ({
    company: budgetPolicies.filter((policy) => policy.scopeType === "company"),
    agent: budgetPolicies.filter((policy) => policy.scopeType === "agent"),
    project: budgetPolicies.filter((policy) => policy.scopeType === "project"),
  }), [budgetPolicies]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select an organization to view costs." />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const showOverviewLoading = spendLoading && customReady;
  const overviewError = !spendData && spendError;
  return (
    <div className="space-y-6">
      {showSummaryChrome ? (
        <div className="space-y-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              {embedded ? (
                <h2 className="text-lg font-semibold text-foreground">Costs</h2>
              ) : (
                <h1 className="text-3xl font-semibold tracking-tight">Costs</h1>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PRESET_KEYS.map((key) => (
                <Button
                  key={key}
                  variant={preset === key ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setPreset(key)}
                  aria-pressed={preset === key}
                >
                  {PRESET_LABELS[key]}
                </Button>
              ))}
            </div>
          </div>

          {preset === "custom" ? (
            <div className="flex flex-wrap items-center gap-2 border border-border p-3">
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
            </div>
          ) : null}

          {financeData?.summary.currencies?.some((row) => row.currency !== "USD") && (
            <p role="status" className="text-sm text-muted-foreground">
              Finance headline totals are USD only. Other currencies are listed separately; no exchange-rate conversion is applied.
            </p>
          )}
          <div className="grid gap-3 lg:grid-cols-4">
            <MetricTile
              label="Inference spend"
              value={spendData ? formatCents(spendData.summary.spendCents) : "—"}
              subtitle={`${formatTokens(inferenceTokenTotal)} tokens across request-scoped events`}
              icon={DollarSign}
            />
            <MetricTile
              label="Budget"
              value={activeBudgetIncidents.length > 0 ? String(activeBudgetIncidents.length) : (
                spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                  ? preset === "mtd" ? `${spendData.summary.utilizationPercent}%` : formatCents(spendData.summary.budgetCents)
                  : "Open"
              )}
              subtitle={
                activeBudgetIncidents.length > 0
                  ? `${budgetData?.pausedAgentCount ?? 0} agents paused · ${budgetData?.pausedProjectCount ?? 0} projects paused`
                  : spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                    ? preset === "mtd" ? `${formatCents(spendData.summary.spendCents)} of ${formatCents(spendData.summary.budgetCents)} this month` : "Monthly limit"
                    : "No monthly cap configured"
              }
              icon={Coins}
            />
            <MetricTile
              label="Recorded charges"
              value={financeData ? formatCents(financeData.summary.netCents) : "—"}
              subtitle={financeData ? (
                <>
                  <span className="block whitespace-nowrap">{formatCents(financeData.summary.debitCents)} debits</span>
                  <span className="block whitespace-nowrap">{formatCents(financeData.summary.creditCents)} credits</span>
                </>
              ) : "Financial data unavailable"}
              icon={ReceiptText}
            />
            <MetricTile
              label="Finance events"
              value={financeData ? String(financeData.summary.eventCount) : "—"}
              subtitle={financeData ? `${formatCents(financeData.summary.estimatedDebitCents)} estimated in range` : "Financial data unavailable"}
              icon={ArrowUpRight}
            />
          </div>
          {spendData?.summary.pricingComplete === false && (
            <div role="status" className="space-y-1 text-sm text-muted-foreground">
              {spendData.summary.unpricedEventCount > 0 && (
                <p>
                  Costs are unavailable for {spendData.summary.unpricedEventCount} usage {spendData.summary.unpricedEventCount === 1 ? "entry" : "entries"} in this period. Totals include known costs only.
                </p>
              )}
              {spendData.summary.pendingRunCount > 0 && (
                <p>
                  {spendData.summary.pendingRunCount} {spendData.summary.pendingRunCount === 1 ? "run is" : "runs are"} awaiting cost data.
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}

      {budgetError && !budgetData ? (
        <p role="status" className="text-sm text-muted-foreground">
          Budget data could not be loaded. Please try again shortly.
        </p>
      ) : null}
      {((spendData && spendError) || (financeData && financeError) || (budgetData && budgetError) || providerError || billerError || weekError || weekBillerError || windowError) ? (
        <p role="status" className="text-sm text-muted-foreground">
          Showing the last loaded data. Updates will resume automatically.
        </p>
      ) : null}

      {!!spendData?.summary.estimatedEventCount && <p role="status" className="text-sm text-muted-foreground">Includes {spendData.summary.estimatedEventCount} estimated {spendData.summary.estimatedEventCount === 1 ? "charge" : "charges"}. Token estimates use published rates and recorded assumptions; provider bills may differ.</p>}
      {incidentMutation.error && <p role="alert" className="text-sm text-destructive">Could not update the budget. Check any pending runs or unpriced usage shown on this page, then try again.</p>}
      <Tabs value={mainTab} onValueChange={(value) => { setMainTab(value as typeof mainTab); setSearchParams(current => { const next = new URLSearchParams(current); next.set("tab", value); return next; }, { replace: true }); }}>
        {!lockTab ? (
          <TabsList variant="line" className="justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {!hideBudgetsTab ? <TabsTrigger value="budgets">Budgets</TabsTrigger> : null}
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="billers">Billers</TabsTrigger>
            <TabsTrigger value="finance">Finance</TabsTrigger>
            <TabsTrigger value="decisions">Decisions</TabsTrigger>
          </TabsList>
        ) : null}

        <TabsContent value="decisions" className="mt-4">{showCustomPrompt ? <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p> : <DecisionHistory companyId={companyId} from={from} to={to} />}</TabsContent>
        <TabsContent value="overview" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : showOverviewLoading ? (
            <PageSkeleton variant="costs" />
          ) : overviewError ? (
            <p className="text-sm text-destructive">Cost data could not be loaded. Please try again shortly.</p>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-(--gtc-32)">
                <div className="min-w-0 space-y-4">
                  <Card className="gap-3 py-4">
                    <CardHeader className="gap-0 px-5">
                      <CardTitle className="text-base">By agent</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5">
                      {(spendData?.byAgent.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">No cost events yet.</p>
                      ) : (
                        spendData?.byAgent.map((row) => {
                          const modelRows = agentModelRows.get(row.agentId) ?? [];
                          const isExpanded = expandedAgents.has(row.agentId);
                          const hasBreakdown = modelRows.length > 0;
                          return (
                            <div key={row.agentId ?? "services"} role="group" aria-label={`${row.agentName ?? row.agentId ?? "Paperclip services"} costs`} className="border border-border px-4 py-3">
                              <div
                                className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", hasBreakdown ? "cursor-pointer select-none" : "")}
                                onClick={() => hasBreakdown && toggleAgent(row.agentId)}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  {hasBreakdown ? (
                                    isExpanded
                                      ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                      : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <span className="h-3 w-3 shrink-0" />
                                  )}
                                  {row.agentId ? <AgentIdentity agent={{ id: row.agentId, name: row.agentName ?? row.agentId, appearance: row.agentAppearance }} size="sm" /> : <span className="font-medium">Paperclip services</span>}
                                  {row.agentStatus === "terminated" ? <StatusBadge status="terminated" /> : null}
                                </div>
                                <div className="text-right text-sm tabular-nums">
                                  <div className="flex flex-wrap items-center justify-end gap-2 font-medium">
                                    <span>{formatCents(row.costCents)}</span>
                                    <CostEstimateLabel eventCount={row.eventCount} estimatedEventCount={row.estimatedEventCount} />
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    in {formatTokens(row.inputTokens + row.cachedInputTokens)} ({formatTokens(row.cachedInputTokens)} cached) · out {formatTokens(row.outputTokens)}
                                  </div>
                                  {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) ? (
                                    <div className="text-xs text-muted-foreground">
                                      {"runs: "}
                                      {row.apiRunCount > 0 ? `${row.apiRunCount} api` : "0 api"}
                                      {" · "}
                                      {row.subscriptionRunCount > 0
                                        ? `${row.subscriptionRunCount} sub`
                                        : "0 sub"}
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              {isExpanded && modelRows.length > 0 ? (
                                <div className="mt-3 space-y-2 border-l border-border pl-4">
                                  {modelRows.map((modelRow) => {
                                    const sharePct = row.costCents > 0 ? Math.round((modelRow.costCents / row.costCents) * 100) : 0;
                                    return (
                                      <div
                                        key={`${modelRow.provider}:${modelRow.model}:${modelRow.billingType}`}
                                        className="flex flex-col gap-2 text-xs sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                                      >
                                        <div className="min-w-0">
                                          <div className="truncate font-medium text-foreground">
                                            {providerDisplayName(modelRow.provider)}
                                            <span className="mx-1 text-border">/</span>
                                            <span className="font-mono">{modelRow.model}</span>
                                          </div>
                                          <div className="truncate text-muted-foreground">
                                            {providerDisplayName(modelRow.biller)} · {billingTypeDisplayName(modelRow.billingType)}
                                          </div>
                                        </div>
                                        <div className="text-right tabular-nums">
                                          <div className="flex flex-wrap items-center justify-end gap-2 font-medium">
                                            <span>
                                              {formatCents(modelRow.costCents)}
                                              <span className="ml-1 font-normal text-muted-foreground">({sharePct}%)</span>
                                            </span>
                                            <CostEstimateLabel eventCount={modelRow.eventCount} estimatedEventCount={modelRow.estimatedEventCount} />
                                          </div>
                                          <div className="text-muted-foreground">
                                            {formatTokens(modelRow.inputTokens + modelRow.cachedInputTokens + modelRow.outputTokens)} tok
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>
                  {userSpendError && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {userSpendData ? "User costs could not be refreshed. Showing the last loaded data." : "User costs could not be loaded. Please try again shortly."}
                    </p>
                  )}
                  {userSpendData && <CostByUserTable report={userSpendData} />}
                </div>

                <div className="space-y-4">
                  <Card className="gap-3 py-4">
                    <CardHeader className="gap-0 px-5">
                      <CardTitle className="text-base">By project</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5">
                      {(spendData?.byProject.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
                      ) : (
                        spendData?.byProject.map((row, index) => (
                          <div
                            key={row.projectId ?? `unattributed-${index}`}
                            className="flex items-center justify-between gap-3 border border-border px-3 py-2 text-sm"
                          >
                            <span className="truncate">{row.projectName ?? row.projectId ?? "Unattributed"}</span>
                            <span className="font-medium tabular-nums">{formatCents(row.costCents)}</span>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                </div>
              </div>

              {activeBudgetIncidents.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {activeBudgetIncidents.slice(0, 2).map((incident) => (
                    <BudgetIncidentCard
                      key={incident.id}
                      incident={incident}
                      isMutating={incidentMutation.isPending}
                      onKeepPaused={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                      onRaiseAndResume={(amount) =>
                        incidentMutation.mutate({
                          incidentId: incident.id,
                          action: "raise_budget_and_resume",
                          amount,
                        })}
                    />
                  ))}
                </div>
              ) : null}

              {financeData ? (
                <FinanceSummaryCard
                  debitCents={financeData.summary.debitCents}
                  creditCents={financeData.summary.creditCents}
                  netCents={financeData.summary.netCents}
                  estimatedDebitCents={financeData.summary.estimatedDebitCents}
                  eventCount={financeData.summary.eventCount}
                />
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {financeLoading ? "Loading financial events…" : "Financial events could not be loaded. Please try again shortly."}
                </p>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="budgets" className="mt-4 space-y-4">
          {policyMutation.error && <p role="alert" className="text-sm text-destructive">Could not update the budget policy. Review your settings and try again.</p>}
          {budgetLoading ? (
            <PageSkeleton variant="costs" />
          ) : budgetError && !budgetData ? null : (
            <>
              <Card className="border-border/70 bg-(image:--gradient-extract-2)">
                <CardHeader className="px-5 pt-5 pb-3">
                  <CardTitle className="text-base">Budget control plane</CardTitle>
                  <CardDescription>
                    Hard-stop spend limits for agents and projects. Provider subscription quota stays separate and appears under Providers.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-4">
                  <MetricTile
                    label="Active incidents"
                    value={String(activeBudgetIncidents.length)}
                    subtitle="Open soft or hard threshold crossings"
                    icon={ReceiptText}
                  />
                  <MetricTile
                    label="Pending approvals"
                    value={String(budgetData?.pendingApprovalCount ?? 0)}
                    subtitle="Budget override approvals awaiting board action"
                    icon={ArrowUpRight}
                  />
                  <MetricTile
                    label="Paused agents"
                    value={String(budgetData?.pausedAgentCount ?? 0)}
                    subtitle="Agent heartbeats blocked by budget"
                    icon={Coins}
                  />
                  <MetricTile
                    label="Paused projects"
                    value={String(budgetData?.pausedProjectCount ?? 0)}
                    subtitle="Project execution blocked by budget"
                    icon={DollarSign}
                  />
                </CardContent>
              </Card>

              {activeBudgetIncidents.length > 0 ? (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-lg font-semibold">Active incidents</h2>
                    <p className="text-sm text-muted-foreground">
                      Resolve hard stops here by raising the budget or explicitly keeping the scope paused.
                    </p>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {activeBudgetIncidents.map((incident) => (
                      <BudgetIncidentCard
                        key={incident.id}
                        incident={incident}
                        isMutating={incidentMutation.isPending}
                        onKeepPaused={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                        onRaiseAndResume={(amount) =>
                          incidentMutation.mutate({
                            incidentId: incident.id,
                            action: "raise_budget_and_resume",
                            amount,
                          })}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-5">
                {(["company", "agent", "project"] as const).map((scopeType) => {
                  const rows = budgetPoliciesByScope[scopeType];
                  if (rows.length === 0) return null;
                  return (
                    <section key={scopeType} className="space-y-3">
                      <div>
                        <h2 className="text-lg font-semibold capitalize">{scopeType === "company" ? "organization" : scopeType} budgets</h2>
                        <p className="text-sm text-muted-foreground">
                          {scopeType === "company"
                            ? "Organization-wide monthly policy."
                            : scopeType === "agent"
                              ? "Recurring monthly spend policies for individual agents."
                              : "Lifetime spend policies for execution-bound projects."}
                        </p>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {rows.map((summary) => (
                          <BudgetPolicyCard
                            key={summary.policyId}
                            summary={summary}
                            onReservationChange={(reservationCents) => policyMutation.mutate({ summary, changes: { reservationCents } })}
                            onUnpricedUsagePolicyChange={(unpricedUsagePolicy) => policyMutation.mutate({ summary, changes: { unpricedUsagePolicy } })}
                            isSaving={policyMutation.isPending}
                            onSave={(amount) =>
                              policyMutation.mutate({ summary, changes: { amount } })}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}

                {budgetPolicies.length === 0 ? (
                  <Card>
                    <CardContent className="px-5 py-8 text-sm text-muted-foreground">
                      No budget policies yet. Set agent and project budgets from their detail pages, or use the existing organization monthly budget control.
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="providers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <Tabs value={effectiveProvider} onValueChange={setActiveProvider}>
                <PageTabBar items={providerTabItems} value={effectiveProvider} />

                <TabsContent value="all" className="mt-4">
                  {providers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No cost events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {providers.map((provider) => (
                        <ProviderQuotaCard
                          key={provider}
                          provider={provider}
                          rows={byProvider.get(provider) ?? []}
                          budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          showBudgetUtilization={preset === "mtd"}
                          totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                          weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                          windowRows={windowSpendByProvider.get(provider) ?? []}
                          showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                          quotaAccounts={quotaData?.filter(account => account.provider === provider)}
                      quotaRequestFailed={Boolean(quotaFetchError)}
                      quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                          quotaError={quotaErrorsByProvider.get(provider) ?? null}
                          quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                          quotaLoading={quotaLoading}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {providers.map((provider) => (
                  <TabsContent key={provider} value={provider} className="mt-4">
                    <ProviderQuotaCard
                      provider={provider}
                      rows={byProvider.get(provider) ?? []}
                      budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          showBudgetUtilization={preset === "mtd"}
                      totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                      weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                      windowRows={windowSpendByProvider.get(provider) ?? []}
                      showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                      quotaAccounts={quotaData?.filter(account => account.provider === provider)}
                      quotaRequestFailed={Boolean(quotaFetchError)}
                      quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                      quotaError={quotaErrorsByProvider.get(provider) ?? null}
                      quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                      quotaLoading={quotaLoading}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="billers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <Tabs value={effectiveBiller} onValueChange={setActiveBiller}>
                <PageTabBar items={billerTabItems} value={effectiveBiller} />

                <TabsContent value="all" className="mt-4">
                  {billers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No billable events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {billers.map((biller) => {
                        const row = (byBiller.get(biller) ?? [])[0];
                        if (!row) return null;
                        const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                        return (
                          <BillerSpendCard
                            key={biller}
                            row={row}
                            weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                            budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          showBudgetUtilization={preset === "mtd"}
                            totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                            providerRows={providerRows}
                          />
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                {billers.map((biller) => {
                  const row = (byBiller.get(biller) ?? [])[0];
                  if (!row) return null;
                  const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                  return (
                    <TabsContent key={biller} value={biller} className="mt-4">
                      <BillerSpendCard
                        row={row}
                        weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                        budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          showBudgetUtilization={preset === "mtd"}
                        totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                        providerRows={providerRows}
                      />
                    </TabsContent>
                  );
                })}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="finance" className="mt-4 space-y-4">
          {financeData?.summary.providerReportedCentsExact !== undefined && <p className="text-sm text-muted-foreground">Provider API cost reports: {formatCents(financeData.summary.providerReportedCents ?? 0)}. Report totals overlap invoices and run estimates and are shown separately from recorded charges.</p>}

          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : financeLoading ? (
            <PageSkeleton variant="costs" />
          ) : financeError && !financeData ? (
            <p className="text-sm text-destructive">Financial events could not be loaded. Please try again shortly.</p>
          ) : (
            <>
              <FinanceSummaryCard
                debitCents={financeData?.summary.debitCents ?? 0}
                creditCents={financeData?.summary.creditCents ?? 0}
                netCents={financeData?.summary.netCents ?? 0}
                estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                eventCount={financeData?.summary.eventCount ?? 0}
              />

              <div className="grid gap-4 xl:grid-cols-(--gtc-33)">
                <div className="space-y-4">
                  <Card>
                    <CardHeader className="px-5 pt-5 pb-2">
                      <CardTitle className="text-base">By biller</CardTitle>
                      <CardDescription>Account-level financial events grouped by who charged or credited them.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 px-5 pb-5 pt-2 md:grid-cols-2">
                      {(financeData?.byBiller.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">No finance events yet.</p>
                      ) : (
                        financeData?.byBiller.map((row) => <FinanceBillerCard key={`${row.biller}:${row.currency}`} row={row} />)
                      )}
                    </CardContent>
                  </Card>
                  <FinanceTimelineCard rows={topFinanceEvents} />
                </div>

                <FinanceKindCard rows={financeData?.byKind ?? []} />
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
