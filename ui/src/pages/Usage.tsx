import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CostByProviderModel, CostWindowSpendRow } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { PageTabBar } from "../components/PageTabBar";
import { formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Gauge } from "lucide-react";

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d": {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "30d": {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to };
    }
    case "all":
      return { from: "", to: "" };
    case "custom":
      return { from: "", to: "" };
  }
}

/** current week mon-sun boundaries as iso strings */
function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun, 1 = Mon, …
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sun = new Date(mon.getTime() + 6 * 24 * 60 * 60 * 1000 + 23 * 3600 * 1000 + 3599 * 1000 + 999);
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

export function Usage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [activeProvider, setActiveProvider] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Usage" }]);
  }, [setBreadcrumbs]);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      // treat custom date strings as local-date boundaries so the full day is included
      // regardless of the user's timezone. "from" starts at local midnight (00:00:00),
      // "to" ends at local 23:59:59.999 (converted to utc via Date constructor).
      const fromDate = customFrom ? new Date(customFrom + "T00:00:00") : null;
      const toDate = customTo ? new Date(customTo + "T23:59:59.999") : null;
      return {
        from: fromDate ? fromDate.toISOString() : "",
        to: toDate ? toDate.toISOString() : "",
      };
    }
    const range = computeRange(preset);
    // floor `to` to the nearest minute so the query key is stable across 30s refetch ticks
    // (prevents a new cache entry being created on every poll cycle)
    if (range.to) {
      const d = new Date(range.to);
      d.setSeconds(0, 0);
      range.to = d.toISOString();
    }
    return range;
  }, [preset, customFrom, customTo]);

  // key to today's date string so the range auto-refreshes after midnight on the next 30s refetch
  const today = new Date().toDateString();
  const weekRange = useMemo(() => currentWeekRange(), [today]);

  // for custom preset, only fetch once both dates are selected
  const customReady = preset !== "custom" || (!!customFrom && !!customTo);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.usageByProvider(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: () => costsApi.byProvider(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: summary } = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: () =>
      costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekData } = useQuery({
    queryKey: queryKeys.usageByProvider(selectedCompanyId!, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(selectedCompanyId!, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: windowData } = useQuery({
    queryKey: queryKeys.usageWindowSpend(selectedCompanyId!),
    queryFn: () => costsApi.windowSpend(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // rows grouped by provider
  const byProvider = useMemo(() => {
    const map = new Map<string, CostByProviderModel[]>();
    for (const row of data ?? []) {
      const arr = map.get(row.provider) ?? [];
      arr.push(row);
      map.set(row.provider, arr);
    }
    return map;
  }, [data]);

  // week spend per provider
  const weekSpendByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekData ?? []) {
      map.set(row.provider, (map.get(row.provider) ?? 0) + row.costCents);
    }
    return map;
  }, [weekData]);

  // window spend rows per provider, keyed by provider with the 3-window array
  const windowSpendByProvider = useMemo(() => {
    const map = new Map<string, CostWindowSpendRow[]>();
    for (const row of windowData ?? []) {
      const arr = map.get(row.provider) ?? [];
      arr.push(row);
      map.set(row.provider, arr);
    }
    return map;
  }, [windowData]);

  // compute deficit notch per provider: only meaningful for mtd — projects spend to month end
  // and flags when that projection exceeds the provider's pro-rata budget share.
  function providerDeficitNotch(providerKey: string): boolean {
    if (preset !== "mtd") return false;
    const budget = summary?.budgetCents ?? 0;
    if (budget <= 0) return false;
    const totalSpend = summary?.spendCents ?? 0;
    const providerCostCents = (byProvider.get(providerKey) ?? []).reduce((s, r) => s + r.costCents, 0);
    const providerShare = totalSpend > 0 ? providerCostCents / totalSpend : 0;
    const providerBudget = budget * providerShare;
    if (providerBudget <= 0) return false;
    const now = new Date();
    const daysElapsed = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const burnRate = providerCostCents / Math.max(daysElapsed, 1);
    return providerCostCents + burnRate * (daysInMonth - daysElapsed) > providerBudget;
  }

  const providers = Array.from(byProvider.keys());

  if (!selectedCompanyId) {
    return <EmptyState icon={Gauge} message="Select a company to view usage." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  const tabItems = [
    {
      value: "all",
      label: (
        <span className="flex items-center gap-1.5">
          <span>All providers</span>
          {data && data.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground font-mono">
                {formatTokens(data.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0))}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatCents(data.reduce((s, r) => s + r.costCents, 0))}
              </span>
            </>
          )}
        </span>
      ),
    },
    ...providers.map((p) => ({
      value: p,
      label: <ProviderTabLabel provider={p} rows={byProvider.get(p)!} />,
    })),
  ];

  return (
    <div className="space-y-6">
      {/* date range selector */}
      <div className="flex flex-wrap items-center gap-2">
        {presetKeys.map((p) => (
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
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {preset === "custom" && !customReady ? (
        <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
      ) : (
        <Tabs value={activeProvider} onValueChange={setActiveProvider}>
          <PageTabBar items={tabItems} value={activeProvider} onValueChange={setActiveProvider} />

          <TabsContent value="all" className="mt-4">
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cost events in this period.</p>
            ) : (
              <div className="grid md:grid-cols-2 gap-4">
                {providers.map((p) => (
                  <ProviderQuotaCard
                    key={p}
                    provider={p}
                    rows={byProvider.get(p)!}
                    budgetMonthlyCents={summary?.budgetCents ?? 0}
                    totalCompanySpendCents={summary?.spendCents ?? 0}
                    weekSpendCents={weekSpendByProvider.get(p) ?? 0}
                    windowRows={windowSpendByProvider.get(p) ?? []}
                    showDeficitNotch={providerDeficitNotch(p)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          {providers.map((p) => (
            <TabsContent key={p} value={p} className="mt-4">
              <ProviderQuotaCard
                provider={p}
                rows={byProvider.get(p)!}
                budgetMonthlyCents={summary?.budgetCents ?? 0}
                totalCompanySpendCents={summary?.spendCents ?? 0}
                weekSpendCents={weekSpendByProvider.get(p) ?? 0}
                windowRows={windowSpendByProvider.get(p) ?? []}
                showDeficitNotch={providerDeficitNotch(p)}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
