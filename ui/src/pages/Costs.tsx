import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BudgetPolicySummary,
  CostByAgentModel,
  CostByBiller,
  CostByProviderModel,
  CostWindowSpendRow,
  FinanceEvent,
  QuotaWindow,
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
import { useLocalizedCopy } from "../i18n/ui-copy";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const NO_COMPANY = "__none__";

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
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </div>
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
  const copy = useLocalizedCopy();
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{copy("costs.financeLedger", "Finance ledger", "재무 장부")}</CardTitle>
        <CardDescription>
          {copy(
            "costs.financeLedger.description",
            "Account-level charges that do not map to a single inference request.",
            "단일 추론 요청에 직접 매핑되지 않는 계정 단위 비용입니다.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label={copy("costs.debits", "Debits", "차감")}
          value={formatCents(debitCents)}
          subtitle={copy(
            "costs.finance.eventsInRange",
            eventCount === 1 ? "{{count}} total event in range" : "{{count}} total events in range",
            "범위 내 총 이벤트 {{count}}건",
            { count: eventCount },
          )}
          icon={ArrowUpRight}
        />
        <MetricTile
          label={copy("costs.credits", "Credits", "크레딧")}
          value={formatCents(creditCents)}
          subtitle={copy("costs.credits.subtitle", "Refunds, offsets, and credit returns", "환불, 상계, 크레딧 반환")}
          icon={ArrowDownLeft}
        />
        <MetricTile
          label={copy("costs.net", "Net", "순액")}
          value={formatCents(netCents)}
          subtitle={copy("costs.net.subtitle", "Debit minus credit for the selected period", "선택 기간의 차감액에서 크레딧을 뺀 값")}
          icon={ReceiptText}
        />
        <MetricTile
          label={copy("costs.estimated", "Estimated", "추정")}
          value={formatCents(estimatedDebitCents)}
          subtitle={copy("costs.estimated.subtitle", "Estimated debits that are not yet invoice-authoritative", "아직 청구서 기준으로 확정되지 않은 추정 차감액")}
          icon={Coins}
        />
      </CardContent>
    </Card>
  );
}

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();
  const queryClient = useQueryClient();

  const [mainTab, setMainTab] = useState<"overview" | "budgets" | "providers" | "billers" | "finance">("overview");
  const [activeProvider, setActiveProvider] = useState("all");
  const [activeBiller, setActiveBiller] = useState("all");

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
    setBreadcrumbs([{ label: copy("costs.breadcrumb", "Costs", "비용") }]);
  }, [copy, setBreadcrumbs]);

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
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
  };

  const policyMutation = useMutation({
    mutationFn: (input: {
      scopeType: BudgetPolicySummary["scopeType"];
      scopeId: string;
      amount: number;
      windowKind: BudgetPolicySummary["windowKind"];
    }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        amount: input.amount,
        windowKind: input.windowKind,
      }),
    onSuccess: invalidateBudgetViews,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, input),
    onSuccess: invalidateBudgetViews,
  });

  const { data: spendData, isLoading: spendLoading, error: spendError } = useQuery({
    queryKey: queryKeys.costs(companyId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject, byAgentModel] = await Promise.all([
        costsApi.summary(companyId, from || undefined, to || undefined),
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byProject(companyId, from || undefined, to || undefined),
        costsApi.byAgentModel(companyId, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject, byAgentModel };
    },
    enabled: !!selectedCompanyId && customReady,
  });

  const { data: financeData, isLoading: financeLoading, error: financeError } = useQuery({
    queryKey: [
      queryKeys.financeSummary(companyId, from || undefined, to || undefined),
      queryKeys.financeByBiller(companyId, from || undefined, to || undefined),
      queryKeys.financeByKind(companyId, from || undefined, to || undefined),
      queryKeys.financeEvents(companyId, from || undefined, to || undefined, 18),
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
    enabled: !!selectedCompanyId && customReady,
  });

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedAgents(new Set());
  }, [companyId, from, to]);

  function toggleAgent(agentId: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const agentModelRows = useMemo(() => {
    const map = new Map<string, CostByAgentModel[]>();
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

  const { data: providerData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.byProvider(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: billerData } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.byBiller(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekBillerData } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byBiller(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: windowData } = useQuery({
    queryKey: queryKeys.usageWindowSpend(companyId),
    queryFn: () => costsApi.windowSpend(companyId),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: quotaData, isLoading: quotaLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
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
      if (result.ok && result.windows.length > 0) {
        map.set(result.provider, result.windows);
      }
    }
    return map;
  }, [quotaData]);

  const quotaErrorsByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (!result.ok && result.error) map.set(result.provider, result.error);
    }
    return map;
  }, [quotaData]);

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
    const totalSpend = spendData?.summary.spendCents ?? 0;
    const now = new Date();
    const daysElapsed = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (const [providerKey, rows] of byProvider) {
      const providerCostCents = rows.reduce((sum, row) => sum + row.costCents, 0);
      const providerShare = totalSpend > 0 ? providerCostCents / totalSpend : 0;
      const providerBudget = budget * providerShare;
      if (providerBudget <= 0) {
        map.set(providerKey, false);
        continue;
      }
      const burnRate = providerCostCents / Math.max(daysElapsed, 1);
      map.set(providerKey, providerCostCents + burnRate * (daysInMonth - daysElapsed) > providerBudget);
    }
    return map;
  }, [preset, spendData, byProvider]);

  const providers = useMemo(() => Array.from(byProvider.keys()), [byProvider]);
  const billers = useMemo(() => Array.from(byBiller.keys()), [byBiller]);
  const billingModeSummary = useMemo(() => {
    let apiRunCount = 0;
    let subscriptionRunCount = 0;
    let subscriptionTokens = 0;
    for (const row of spendData?.byAgent ?? []) {
      apiRunCount += row.apiRunCount;
      subscriptionRunCount += row.subscriptionRunCount;
      subscriptionTokens += row.subscriptionCachedInputTokens + row.subscriptionInputTokens + row.subscriptionOutputTokens;
    }
    return { apiRunCount, subscriptionRunCount, subscriptionTokens };
  }, [spendData?.byAgent]);

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
            <span>{copy("costs.allProviders", "All providers", "전체 제공자")}</span>
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
  }, [byProvider, copy]);

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
            <span>{copy("costs.allBillers", "All billers", "전체 청구자")}</span>
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
  }, [byBiller, copy]);

  const inferenceTokenTotal =
    (spendData?.byAgent ?? []).reduce(
      (sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens,
      0,
    );

  const topFinanceEvents = (financeData?.events ?? []) as FinanceEvent[];
  const budgetPolicies = budgetData?.policies ?? [];
  const activeBudgetIncidents = budgetData?.activeIncidents ?? [];
  const presetLabels = {
    mtd: copy("costs.preset.mtd", PRESET_LABELS.mtd, "이번 달"),
    "7d": copy("costs.preset.7d", PRESET_LABELS["7d"], "최근 7일"),
    "30d": copy("costs.preset.30d", PRESET_LABELS["30d"], "최근 30일"),
    ytd: copy("costs.preset.ytd", PRESET_LABELS.ytd, "올해"),
    all: copy("costs.preset.all", PRESET_LABELS.all, "전체"),
    custom: copy("costs.preset.custom", PRESET_LABELS.custom, "직접 선택"),
  };
  const budgetPoliciesByScope = useMemo(() => ({
    company: budgetPolicies.filter((policy) => policy.scopeType === "company"),
    agent: budgetPolicies.filter((policy) => policy.scopeType === "agent"),
    project: budgetPolicies.filter((policy) => policy.scopeType === "project"),
  }), [budgetPolicies]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message={copy("costs.noCompany", "Select a company to view costs.", "비용을 보려면 회사를 선택하세요.")} />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const showOverviewLoading = (spendLoading || financeLoading) && customReady;
  const overviewError = spendError ?? financeError;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
                <h1 className="text-3xl font-semibold tracking-tight">{copy("costs.title", "Costs", "비용")}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {copy(
                    "costs.subtitle",
                    "Inference spend, platform fees, credits, and live quota windows.",
                    "추론 지출, 플랫폼 비용, 크레딧, 실시간 quota 구간을 관리합니다.",
                  )}
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PRESET_KEYS.map((key) => (
                <Button
                  key={key}
                  variant={preset === key ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setPreset(key)}
                >
                  {presetLabels[key]}
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
              <span className="text-sm text-muted-foreground">{copy("costs.dateRange.to", "to", "까지")}</span>
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-4">
            <MetricTile
              label={copy("costs.inferenceSpend", "Inference spend", "추론 지출")}
              value={formatCents(spendData?.summary.spendCents ?? 0)}
              subtitle={copy(
                "costs.inferenceSpend.subtitle",
                "{{tokens}} tokens across request-scoped events",
                "요청 단위 이벤트 토큰 {{tokens}}",
                { tokens: formatTokens(inferenceTokenTotal) },
              )}
              icon={DollarSign}
            />
            <MetricTile
              label={copy("costs.budget", "Budget", "예산")}
              value={activeBudgetIncidents.length > 0 ? String(activeBudgetIncidents.length) : (
                spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                  ? `${spendData.summary.utilizationPercent}%`
                  : copy("costs.budget.open", "Open", "열림")
              )}
              subtitle={
                activeBudgetIncidents.length > 0
                  ? copy(
                    "costs.budget.paused",
                    "{{agents}} agents paused · {{projects}} projects paused",
                    "직원 {{agents}}명 일시정지 · 프로젝트 {{projects}}개 일시정지",
                    { agents: budgetData?.pausedAgentCount ?? 0, projects: budgetData?.pausedProjectCount ?? 0 },
                  )
                  : spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                    ? `${formatCents(spendData.summary.spendCents)} of ${formatCents(spendData.summary.budgetCents)}`
                    : copy("costs.budget.noCap", "No monthly cap configured", "월 한도 미설정")
              }
              icon={Coins}
            />
            <MetricTile
              label={copy("costs.financeNet", "Finance net", "재무 순액")}
              value={formatCents(financeData?.summary.netCents ?? 0)}
              subtitle={copy(
                "costs.financeNet.subtitle",
                "{{debits}} debits · {{credits}} credits",
                "차감 {{debits}} · 크레딧 {{credits}}",
                { debits: formatCents(financeData?.summary.debitCents ?? 0), credits: formatCents(financeData?.summary.creditCents ?? 0) },
              )}
              icon={ReceiptText}
            />
            <MetricTile
              label={copy("costs.financeEvents", "Finance events", "재무 이벤트")}
              value={String(financeData?.summary.eventCount ?? 0)}
              subtitle={copy(
                "costs.financeEvents.subtitle",
                "{{amount}} estimated in range",
                "범위 내 추정 {{amount}}",
                { amount: formatCents(financeData?.summary.estimatedDebitCents ?? 0) },
              )}
              icon={ArrowUpRight}
            />
          </div>

          <div className="grid gap-3 border border-border p-4 md:grid-cols-[1fr_auto] md:items-center">
            <div className="min-w-0">
              <div className="text-sm font-medium">{copy("costs.billingMode.title", "Billing mode split", "구독/API 과금 구분")}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {copy(
                  "costs.billingMode.description",
                  "Subscription-included runs are counted separately from API-billed spend so GPT Max-style usage is not mistaken for direct API charges.",
                  "구독형 포함 실행은 API 과금 지출과 분리해 표시하므로 GPT Max형 사용량을 직접 API 비용으로 오해하지 않습니다.",
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="border border-border px-3 py-2">
                {copy("costs.billingMode.subscription", "Subscription {{count}} runs", "구독형 {{count}}회", { count: billingModeSummary.subscriptionRunCount })}
                {" · "}
                {formatTokens(billingModeSummary.subscriptionTokens)}
              </span>
              <span className="border border-border px-3 py-2">
                {copy("costs.billingMode.api", "API {{count}} runs", "API {{count}}회", { count: billingModeSummary.apiRunCount })}
              </span>
            </div>
          </div>
      </div>

      <Tabs value={mainTab} onValueChange={(value) => setMainTab(value as typeof mainTab)}>
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="overview">{copy("costs.tab.overview", "Overview", "개요")}</TabsTrigger>
          <TabsTrigger value="budgets">{copy("costs.tab.budgets", "Budgets", "예산")}</TabsTrigger>
          <TabsTrigger value="providers">{copy("costs.tab.providers", "Providers", "제공자")}</TabsTrigger>
          <TabsTrigger value="billers">{copy("costs.tab.billers", "Billers", "청구자")}</TabsTrigger>
          <TabsTrigger value="finance">{copy("costs.tab.finance", "Finance", "재무")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">{copy("costs.customPrompt", "Select a start and end date to load data.", "데이터를 불러올 시작일과 종료일을 선택하세요.")}</p>
          ) : showOverviewLoading ? (
            <PageSkeleton variant="costs" />
          ) : overviewError ? (
            <p className="text-sm text-destructive">{(overviewError as Error).message}</p>
          ) : (
            <>
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

              <div className="grid gap-4 xl:grid-cols-[1.3fr,1fr]">
                <Card>
                  <CardHeader className="px-5 pt-5 pb-2">
                    <CardTitle className="text-base">{copy("costs.inferenceLedger", "Inference ledger", "추론 장부")}</CardTitle>
                    <CardDescription>
                      {copy(
                        "costs.inferenceLedger.description",
                        "Request-scoped inference spend for the selected period.",
                        "선택 기간의 요청 단위 추론 지출입니다.",
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 px-5 pb-5 pt-2">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <div className="text-3xl font-semibold tabular-nums">
                          {formatCents(spendData?.summary.spendCents ?? 0)}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                            ? copy("costs.inferenceLedger.budget", "Budget {{amount}}", "예산 {{amount}}", { amount: formatCents(spendData.summary.budgetCents) })
                            : copy("costs.inferenceLedger.unlimited", "Unlimited budget", "무제한 예산")}
                        </div>
                      </div>
                      <div className="border border-border px-4 py-3 text-right">
                        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{copy("costs.usage", "usage", "사용량")}</div>
                        <div className="mt-1 text-lg font-medium tabular-nums">
                          {formatTokens(inferenceTokenTotal)}
                        </div>
                      </div>
                    </div>
                    {spendData?.summary.budgetCents && spendData.summary.budgetCents > 0 ? (
                      <div className="space-y-2">
                        <div className="h-2 overflow-hidden bg-muted">
                          <div
                            className={cn(
                              "h-full transition-[width,background-color] duration-150",
                              spendData.summary.utilizationPercent > 90
                                ? "bg-red-400"
                                : spendData.summary.utilizationPercent > 70
                                  ? "bg-yellow-400"
                                  : "bg-emerald-400",
                            )}
                            style={{ width: `${Math.min(100, spendData.summary.utilizationPercent)}%` }}
                          />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {copy(
                            "costs.inferenceLedger.utilization",
                            "{{percent}}% of monthly budget consumed in this range.",
                            "이 범위에서 월 예산의 {{percent}}%를 사용했습니다.",
                            { percent: spendData.summary.utilizationPercent },
                          )}
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <FinanceSummaryCard
                  debitCents={financeData?.summary.debitCents ?? 0}
                  creditCents={financeData?.summary.creditCents ?? 0}
                  netCents={financeData?.summary.netCents ?? 0}
                  estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                  eventCount={financeData?.summary.eventCount ?? 0}
                />
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.25fr,0.95fr]">
                <Card>
                  <CardHeader className="px-5 pt-5 pb-2">
                    <CardTitle className="text-base">{copy("costs.byAgent", "By agent", "직원별")}</CardTitle>
                    <CardDescription>
                      {copy("costs.byAgent.description", "What each agent consumed in the selected period.", "선택 기간 동안 각 직원이 사용한 비용입니다.")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 px-5 pb-5 pt-2">
                    {(spendData?.byAgent.length ?? 0) === 0 ? (
                      <p className="text-sm text-muted-foreground">{copy("costs.empty.costEvents", "No cost events yet.", "아직 비용 이벤트가 없습니다.")}</p>
                    ) : (
                      spendData?.byAgent.map((row) => {
                        const modelRows = agentModelRows.get(row.agentId) ?? [];
                        const isExpanded = expandedAgents.has(row.agentId);
                        const hasBreakdown = modelRows.length > 0;
                        return (
                          <div key={row.agentId} className="border border-border px-4 py-3">
                            <div
                              className={cn("flex items-start justify-between gap-3", hasBreakdown ? "cursor-pointer select-none" : "")}
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
                                <Identity name={row.agentName ?? row.agentId} size="sm" />
                                {row.agentStatus === "terminated" ? <StatusBadge status="terminated" /> : null}
                              </div>
                              <div className="text-right text-sm tabular-nums">
                                <div className="font-medium">{formatCents(row.costCents)}</div>
                                <div className="text-xs text-muted-foreground">
                                  {copy("costs.tokens.inOut", "in {{input}} · out {{output}}", "입력 {{input}} · 출력 {{output}}", {
                                    input: formatTokens(row.inputTokens + row.cachedInputTokens),
                                    output: formatTokens(row.outputTokens),
                                  })}
                                </div>
                                {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) ? (
                                  <div className="text-xs text-muted-foreground">
                                    {row.apiRunCount > 0
                                      ? copy("costs.runCount.api", "{{count}} api", "API {{count}}회", { count: row.apiRunCount })
                                      : copy("costs.runCount.api", "{{count}} api", "API {{count}}회", { count: 0 })}
                                    {" · "}
                                    {row.subscriptionRunCount > 0
                                      ? copy("costs.runCount.subscription", "{{count}} subscription", "구독 {{count}}회", { count: row.subscriptionRunCount })
                                      : copy("costs.runCount.subscription", "{{count}} subscription", "구독 {{count}}회", { count: 0 })}
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
                                      className="flex items-start justify-between gap-3 text-xs"
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
                                        <div className="font-medium">
                                          {formatCents(modelRow.costCents)}
                                          <span className="ml-1 font-normal text-muted-foreground">({sharePct}%)</span>
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

                <div className="space-y-4">
                  <Card>
                    <CardHeader className="px-5 pt-5 pb-2">
                      <CardTitle className="text-base">{copy("costs.byProject", "By project", "프로젝트별")}</CardTitle>
                      <CardDescription>{copy("costs.byProject.description", "Run costs attributed through project-linked issues.", "프로젝트와 연결된 작업을 통해 귀속된 실행 비용입니다.")}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5 pb-5 pt-2">
                      {(spendData?.byProject.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">{copy("costs.empty.projectCosts", "No project-attributed run costs yet.", "아직 프로젝트 귀속 실행 비용이 없습니다.")}</p>
                      ) : (
                        spendData?.byProject.map((row, index) => (
                          <div
                            key={row.projectId ?? `unattributed-${index}`}
                            className="flex items-center justify-between gap-3 border border-border px-3 py-2 text-sm"
                          >
                            <span className="truncate">{row.projectName ?? row.projectId ?? copy("costs.unattributed", "Unattributed", "미귀속")}</span>
                            <span className="font-medium tabular-nums">{formatCents(row.costCents)}</span>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                  <FinanceTimelineCard
                    rows={topFinanceEvents.slice(0, 6)}
                    emptyMessage={copy(
                      "costs.empty.financeTimeline",
                      "No finance events yet. Add account-level charges once biller invoices or credits land.",
                      "아직 재무 이벤트가 없습니다. 청구자 인보이스나 크레딧이 반영되면 계정 단위 비용을 추가하세요.",
                    )}
                  />
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="budgets" className="mt-4 space-y-4">
          {budgetLoading ? (
            <PageSkeleton variant="costs" />
          ) : budgetError ? (
            <p className="text-sm text-destructive">{(budgetError as Error).message}</p>
          ) : (
            <>
              <Card className="border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))]">
                <CardHeader className="px-5 pt-5 pb-3">
                  <CardTitle className="text-base">{copy("costs.budgetControl", "Budget control plane", "예산 제어판")}</CardTitle>
                  <CardDescription>
                    {copy(
                      "costs.budgetControl.description",
                      "Hard-stop spend limits for agents and projects. Provider subscription quota stays separate and appears under Providers.",
                      "직원과 프로젝트의 강제 중지 지출 한도입니다. 제공자 구독 quota는 별도로 Providers 아래에 표시됩니다.",
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-4">
                  <MetricTile
                    label={copy("costs.activeIncidents", "Active incidents", "활성 사고")}
                    value={String(activeBudgetIncidents.length)}
                    subtitle={copy("costs.activeIncidents.subtitle", "Open soft or hard threshold crossings", "열려 있는 소프트/하드 한도 초과")}
                    icon={ReceiptText}
                  />
                  <MetricTile
                    label={copy("costs.pendingApprovals", "Pending approvals", "대기 승인")}
                    value={String(budgetData?.pendingApprovalCount ?? 0)}
                    subtitle={copy("costs.pendingApprovals.subtitle", "Budget override approvals awaiting board action", "보드 처리를 기다리는 예산 초과 승인")}
                    icon={ArrowUpRight}
                  />
                  <MetricTile
                    label={copy("costs.pausedAgents", "Paused agents", "일시정지 직원")}
                    value={String(budgetData?.pausedAgentCount ?? 0)}
                    subtitle={copy("costs.pausedAgents.subtitle", "Agent heartbeats blocked by budget", "예산으로 차단된 직원 상태 점검")}
                    icon={Coins}
                  />
                  <MetricTile
                    label={copy("costs.pausedProjects", "Paused projects", "일시정지 프로젝트")}
                    value={String(budgetData?.pausedProjectCount ?? 0)}
                    subtitle={copy("costs.pausedProjects.subtitle", "Project execution blocked by budget", "예산으로 차단된 프로젝트 실행")}
                    icon={DollarSign}
                  />
                </CardContent>
              </Card>

              {activeBudgetIncidents.length > 0 ? (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-lg font-semibold">{copy("costs.activeIncidents", "Active incidents", "활성 사고")}</h2>
                    <p className="text-sm text-muted-foreground">
                      {copy(
                        "costs.activeIncidents.description",
                        "Resolve hard stops here by raising the budget or explicitly keeping the scope paused.",
                        "예산을 올리거나 범위를 명시적으로 일시정지 상태로 유지해 강제 중지를 처리합니다.",
                      )}
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
                        <h2 className="text-lg font-semibold capitalize">
                          {scopeType === "company"
                            ? copy("costs.budgetScope.company", "Company budgets", "회사 예산")
                            : scopeType === "agent"
                              ? copy("costs.budgetScope.agent", "Agent budgets", "직원 예산")
                              : copy("costs.budgetScope.project", "Project budgets", "프로젝트 예산")}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {scopeType === "company"
                            ? copy("costs.budgetScope.companyHelp", "Company-wide monthly policy.", "회사 전체 월간 정책입니다.")
                            : scopeType === "agent"
                              ? copy("costs.budgetScope.agentHelp", "Recurring monthly spend policies for individual agents.", "개별 직원의 반복 월간 지출 정책입니다.")
                              : copy("costs.budgetScope.projectHelp", "Lifetime spend policies for execution-bound projects.", "실행 연결 프로젝트의 누적 지출 정책입니다.")}
                        </p>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {rows.map((summary) => (
                          <BudgetPolicyCard
                            key={summary.policyId}
                            summary={summary}
                            isSaving={policyMutation.isPending}
                            onSave={(amount) =>
                              policyMutation.mutate({
                                scopeType: summary.scopeType,
                                scopeId: summary.scopeId,
                                amount,
                                windowKind: summary.windowKind,
                              })}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}

                {budgetPolicies.length === 0 ? (
                  <Card>
                    <CardContent className="px-5 py-8 text-sm text-muted-foreground">
                      {copy(
                        "costs.empty.budgetPolicies",
                        "No budget policies yet. Set agent and project budgets from their detail pages, or use the existing company monthly budget control.",
                        "아직 예산 정책이 없습니다. 직원/프로젝트 상세에서 예산을 설정하거나 기존 회사 월간 예산 제어를 사용하세요.",
                      )}
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="providers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">{copy("costs.customPrompt", "Select a start and end date to load data.", "데이터를 불러올 시작일과 종료일을 선택하세요.")}</p>
          ) : (
            <>
              <Tabs value={effectiveProvider} onValueChange={setActiveProvider}>
                <PageTabBar items={providerTabItems} value={effectiveProvider} />

                <TabsContent value="all" className="mt-4">
                  {providers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{copy("costs.empty.periodCosts", "No cost events in this period.", "이 기간에는 비용 이벤트가 없습니다.")}</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {providers.map((provider) => (
                        <ProviderQuotaCard
                          key={provider}
                          provider={provider}
                          rows={byProvider.get(provider) ?? []}
                          budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                          weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                          windowRows={windowSpendByProvider.get(provider) ?? []}
                          showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
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
                      totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                      weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                      windowRows={windowSpendByProvider.get(provider) ?? []}
                      showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
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
            <p className="text-sm text-muted-foreground">{copy("costs.customPrompt", "Select a start and end date to load data.", "데이터를 불러올 시작일과 종료일을 선택하세요.")}</p>
          ) : (
            <>
              <Tabs value={effectiveBiller} onValueChange={setActiveBiller}>
                <PageTabBar items={billerTabItems} value={effectiveBiller} />

                <TabsContent value="all" className="mt-4">
                  {billers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{copy("costs.empty.billablePeriod", "No billable events in this period.", "이 기간에는 청구 가능 이벤트가 없습니다.")}</p>
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
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">{copy("costs.customPrompt", "Select a start and end date to load data.", "데이터를 불러올 시작일과 종료일을 선택하세요.")}</p>
          ) : financeLoading ? (
            <PageSkeleton variant="costs" />
          ) : financeError ? (
            <p className="text-sm text-destructive">{(financeError as Error).message}</p>
          ) : (
            <>
              <FinanceSummaryCard
                debitCents={financeData?.summary.debitCents ?? 0}
                creditCents={financeData?.summary.creditCents ?? 0}
                netCents={financeData?.summary.netCents ?? 0}
                estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                eventCount={financeData?.summary.eventCount ?? 0}
              />

              <div className="grid gap-4 xl:grid-cols-[1.2fr,0.95fr]">
                <div className="space-y-4">
                  <Card>
                    <CardHeader className="px-5 pt-5 pb-2">
                      <CardTitle className="text-base">{copy("costs.byBiller", "By biller", "청구자별")}</CardTitle>
                      <CardDescription>
                        {copy(
                          "costs.byBiller.description",
                          "Account-level financial events grouped by who charged or credited them.",
                          "비용을 청구하거나 크레딧을 준 주체별 계정 단위 재무 이벤트입니다.",
                        )}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 px-5 pb-5 pt-2 md:grid-cols-2">
                      {(financeData?.byBiller.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">{copy("costs.empty.financeEvents", "No finance events yet.", "아직 재무 이벤트가 없습니다.")}</p>
                      ) : (
                        financeData?.byBiller.map((row) => <FinanceBillerCard key={row.biller} row={row} />)
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
