import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CostByAgentModel, CostByProviderModel, CostWindowSpendRow, QuotaWindow } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { PageTabBar } from "../components/PageTabBar";
import { formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, ChevronDown, ChevronRight } from "lucide-react";
import { useDateRange, PRESET_LABELS, PRESET_KEYS } from "../hooks/useDateRange";

// sentinel used in query keys when no company is selected, to avoid polluting the cache
// with undefined/null entries before the early-return guard fires
const NO_COMPANY = "__none__";

// ---------- helpers ----------

/** current week mon-sun boundaries as iso strings */
function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59, 999);
  return { from: mon.toISOString(), to: sun.toISOString() };
}

function ProviderTabLabel({ provider, rows }: { provider: string; rows: CostByProviderModel[] }) {
  const totalTokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(provider)}</span>
      <span className="text-xs text-muted-foreground font-mono">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

// ---------- page ----------

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [mainTab, setMainTab] = useState<"spend" | "providers">("spend");
  const [activeProvider, setActiveProvider] = useState("all");

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
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  // today as state so the weekRange memo refreshes after midnight.
  // stable [] dep + ref avoids the StrictMode double-invoke problem of the
  // chained [today] dep pattern (which would schedule two concurrent timers).
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
    return () => { if (todayTimerRef.current != null) clearTimeout(todayTimerRef.current); };
  }, []);
  const weekRange = useMemo(() => currentWeekRange(), [today]);

  // ---------- spend tab queries (no polling — cost data doesn't change in real time) ----------

  const companyId = selectedCompanyId ?? NO_COMPANY;

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

  // tracks which agent rows are expanded in the By Agent card.
  // reset whenever the date range or company changes so stale open-states
  // from a previous query window don't bleed into the new result set.
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

  // group byAgentModel rows by agentId for O(1) lookup in the render pass.
  // sub-rows are sorted by cost descending so the most expensive model is first.
  const agentModelRows = useMemo(() => {
    const map = new Map<string, CostByAgentModel[]>();
    for (const row of spendData?.byAgentModel ?? []) {
      const arr = map.get(row.agentId) ?? [];
      arr.push(row);
      map.set(row.agentId, arr);
    }
    for (const [id, rows] of map) {
      map.set(id, rows.slice().sort((a, b) => b.costCents - a.costCents));
    }
    return map;
  }, [spendData?.byAgentModel]);

  // ---------- providers tab queries (polling — provider quota changes during agent runs) ----------

  const { data: providerData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.byProvider(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // weekData intentionally omits the customReady guard — it always uses the
  // fixed current-week range (weekRange), not the user's custom date selection.
  // running it unconditionally (when the providers tab is active) ensures the
  // week-over-week spend column is always populated on tab mount.
  const { data: weekData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: windowData } = useQuery({
    queryKey: queryKeys.usageWindowSpend(companyId),
    queryFn: () => costsApi.windowSpend(companyId),
    // only fetch when the providers tab is active — these queries trigger outbound
    // network calls to provider quota apis; no need to run them on the spend tab.
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: quotaData } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!selectedCompanyId && mainTab === "providers",
    // quota windows come from external provider apis; refresh every 5 minutes
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  // ---------- providers tab derived maps ----------

  const byProvider = useMemo(() => {
    const map = new Map<string, CostByProviderModel[]>();
    for (const row of providerData ?? []) {
      const arr = map.get(row.provider) ?? [];
      arr.push(row);
      map.set(row.provider, arr);
    }
    return map;
  }, [providerData]);

  const weekSpendByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekData ?? []) {
      map.set(row.provider, (map.get(row.provider) ?? 0) + row.costCents);
    }
    return map;
  }, [weekData]);

  const windowSpendByProvider = useMemo(() => {
    const map = new Map<string, CostWindowSpendRow[]>();
    for (const row of windowData ?? []) {
      const arr = map.get(row.provider) ?? [];
      arr.push(row);
      map.set(row.provider, arr);
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

  // deficit notch: projected month-end spend vs pro-rata budget share (mtd only)
  // memoized to avoid stale closure reads when summary and byProvider arrive separately
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
      const providerCostCents = rows.reduce((s, r) => s + r.costCents, 0);
      const providerShare = totalSpend > 0 ? providerCostCents / totalSpend : 0;
      const providerBudget = budget * providerShare;
      if (providerBudget <= 0) { map.set(providerKey, false); continue; }
      const burnRate = providerCostCents / Math.max(daysElapsed, 1);
      map.set(providerKey, providerCostCents + burnRate * (daysInMonth - daysElapsed) > providerBudget);
    }
    return map;
  }, [preset, spendData, byProvider]);

  const providers = useMemo(() => Array.from(byProvider.keys()), [byProvider]);

  // derive effective provider synchronously so the tab body never flashes blank.
  // when activeProvider is no longer in the providers list, fall back to "all".
  const effectiveProvider =
    activeProvider === "all" || providers.includes(activeProvider)
      ? activeProvider
      : "all";

  // write the fallback back into state so subsequent renders and user interactions
  // start from a consistent baseline — without this, activeProvider stays stale and
  // any future setActiveProvider call would re-derive from the wrong base value.
  useEffect(() => {
    if (effectiveProvider !== activeProvider) setActiveProvider("all");
  }, [effectiveProvider, activeProvider]);

  // ---------- provider tab items (memoized — contains jsx, recreating on every render
  // forces PageTabBar to diff the full item tree on every 30s poll tick).
  // totals are derived from byProvider (already memoized on providerData) so this memo
  // only rebuilds when the underlying data actually changes, not on every query refetch. ----------
  const providerTabItems = useMemo(() => {
    // derive provider keys inline so this memo only rebuilds when byProvider changes,
    // not on the extra tick caused by the derived `providers` memo also changing.
    const providerKeys = Array.from(byProvider.keys());
    const allTokens = providerKeys.reduce(
      (s, p) => s + (byProvider.get(p)?.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) ?? 0),
      0,
    );
    const allCents = providerKeys.reduce(
      (s, p) => s + (byProvider.get(p)?.reduce((a, r) => a + r.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All providers</span>
            {providerKeys.length > 0 && (
              <>
                <span className="text-xs text-muted-foreground font-mono">
                  {formatTokens(allTokens)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatCents(allCents)}
                </span>
              </>
            )}
          </span>
        ),
      },
      ...providerKeys.map((p) => ({
        value: p,
        label: <ProviderTabLabel provider={p} rows={byProvider.get(p) ?? []} />,
      })),
    ];
  }, [byProvider]);

  // ---------- guard ----------

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  // ---------- render ----------

  return (
    <div className="space-y-6">
      {/* date range selector */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESET_KEYS.map((p) => (
          <Button
            key={p}
            variant={preset === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(p)}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 border border-input bg-background px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 border border-input bg-background px-2 text-sm text-foreground"
            />
          </div>
        )}
      </div>

      {/* main spend / providers tab switcher */}
      <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as "spend" | "providers")}>
        <TabsList>
          <TabsTrigger value="spend">Spend</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
        </TabsList>

        {/* ── spend tab ─────────────────────────────────────────────── */}
        <TabsContent value="spend" className="mt-4 space-y-4">
          {spendLoading ? (
            <PageSkeleton variant="costs" />
          ) : preset === "custom" && !customReady ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : spendError ? (
            <p className="text-sm text-destructive">{(spendError as Error).message}</p>
          ) : spendData ? (
            <>
              {/* summary card */}
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">{PRESET_LABELS[preset]}</p>
                    {spendData.summary.budgetCents > 0 && (
                      <p className="text-sm text-muted-foreground">
                        {spendData.summary.utilizationPercent}% utilized
                      </p>
                    )}
                  </div>
                  <p className="text-2xl font-bold">
                    {formatCents(spendData.summary.spendCents)}{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      {spendData.summary.budgetCents > 0
                        ? `/ ${formatCents(spendData.summary.budgetCents)}`
                        : "Unlimited budget"}
                    </span>
                  </p>
                  {spendData.summary.budgetCents > 0 && (
                    <div className="w-full h-2 border border-border overflow-hidden">
                      <div
                        className={`h-full transition-[width,background-color] duration-150 ${
                          spendData.summary.utilizationPercent > 90
                            ? "bg-red-400"
                            : spendData.summary.utilizationPercent > 70
                              ? "bg-yellow-400"
                              : "bg-green-400"
                        }`}
                        style={{ width: `${Math.min(100, spendData.summary.utilizationPercent)}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* by agent / by project */}
              <div className="grid md:grid-cols-2 gap-4">
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                    {spendData.byAgent.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No cost events yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {spendData.byAgent.map((row) => {
                          const modelRows = agentModelRows.get(row.agentId) ?? [];
                          const isExpanded = expandedAgents.has(row.agentId);
                          const hasBreakdown = modelRows.length > 0;
                          return (
                            <div key={row.agentId}>
                              <div
                                className={`flex items-start justify-between text-sm ${hasBreakdown ? "cursor-pointer select-none" : ""}`}
                                onClick={() => hasBreakdown && toggleAgent(row.agentId)}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {hasBreakdown ? (
                                    isExpanded
                                      ? <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
                                      : <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <span className="w-3 h-3 shrink-0" />
                                  )}
                                  <Identity name={row.agentName ?? row.agentId} size="sm" />
                                  {row.agentStatus === "terminated" && (
                                    <StatusBadge status="terminated" />
                                  )}
                                </div>
                                <div className="text-right shrink-0 ml-2">
                                  <span className="font-medium block">{formatCents(row.costCents)}</span>
                                  <span className="text-xs text-muted-foreground block">
                                    in {formatTokens(row.inputTokens)} / out {formatTokens(row.outputTokens)} tok
                                  </span>
                                  {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                                    <span className="text-xs text-muted-foreground block">
                                      {row.apiRunCount > 0 ? `api runs: ${row.apiRunCount}` : null}
                                      {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                                      {row.subscriptionRunCount > 0
                                        ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                                        : null}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isExpanded && modelRows.length > 0 && (
                                <div className="ml-5 mt-1 mb-1 border-l border-border pl-3 space-y-1">
                                  {modelRows.map((m) => {
                                    const totalAgentCents = row.costCents;
                                    const sharePct = totalAgentCents > 0
                                      ? Math.round((m.costCents / totalAgentCents) * 100)
                                      : 0;
                                    return (
                                      <div
                                        key={`${m.provider}/${m.model}`}
                                        className="flex items-start justify-between text-xs text-muted-foreground"
                                      >
                                        <div className="min-w-0 truncate">
                                          <span className="font-medium text-foreground">{providerDisplayName(m.provider)}</span>
                                          <span className="mx-1 text-border">/</span>
                                          <span className="font-mono">{m.model}</span>
                                        </div>
                                        <div className="text-right shrink-0 ml-2">
                                          <span className="font-medium text-foreground block">
                                            {formatCents(m.costCents)}
                                            <span className="font-normal text-muted-foreground ml-1">({sharePct}%)</span>
                                          </span>
                                          <span className="block">
                                            in {formatTokens(m.inputTokens)} / out {formatTokens(m.outputTokens)} tok
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold mb-3">By Project</h3>
                    {spendData.byProject.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {spendData.byProject.map((row, i) => (
                          <div
                            key={row.projectId ?? `unattributed-${i}`}
                            className="flex items-center justify-between text-sm"
                          >
                            <span className="truncate">
                              {row.projectName ?? row.projectId ?? "Unattributed"}
                            </span>
                            <span className="font-medium">{formatCents(row.costCents)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          ) : null}
        </TabsContent>

        {/* ── providers tab ─────────────────────────────────────────── */}
        <TabsContent value="providers" className="mt-4">
          {preset === "custom" && !customReady ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <Tabs value={effectiveProvider} onValueChange={setActiveProvider}>
              <PageTabBar
                items={providerTabItems}
                value={effectiveProvider}
              />

              <TabsContent value="all" className="mt-4">
                {providers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No cost events in this period.</p>
                ) : (
                  <div className="grid md:grid-cols-2 gap-4">
                    {providers.map((p) => (
                      <ProviderQuotaCard
                        key={p}
                        provider={p}
                        rows={byProvider.get(p) ?? []}
                        budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                        totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                        weekSpendCents={weekSpendByProvider.get(p) ?? 0}
                        windowRows={windowSpendByProvider.get(p) ?? []}
                        showDeficitNotch={deficitNotchByProvider.get(p) ?? false}
                        quotaWindows={quotaWindowsByProvider.get(p) ?? []}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>

              {providers.map((p) => (
                <TabsContent key={p} value={p} className="mt-4">
                  <ProviderQuotaCard
                    provider={p}
                    rows={byProvider.get(p) ?? []}
                    budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                    totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                    weekSpendCents={weekSpendByProvider.get(p) ?? 0}
                    windowRows={windowSpendByProvider.get(p) ?? []}
                    showDeficitNotch={deficitNotchByProvider.get(p) ?? false}
                    quotaWindows={quotaWindowsByProvider.get(p) ?? []}
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
