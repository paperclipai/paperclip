import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, BrainCircuit, Clock, Database, HeartPulse } from "lucide-react";
import { agentsApi } from "../api/agents";
import { instanceMemoryApi } from "../api/instanceMemory";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

function formatPercent(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function formatLatency(value: number | null) {
  if (value === null) return "n/a";
  return `${value} ms`;
}

function formatDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function shortActor(actorId: string) {
  if (actorId === "shared" || actorId === "<unattributed>") return actorId;
  return actorId.slice(0, 8);
}

function pillClass(pill: "green" | "yellow" | "red") {
  if (pill === "green") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (pill === "yellow") return "border-amber-300 bg-amber-50 text-amber-700";
  return "border-red-300 bg-red-50 text-red-700";
}

export function MemoryDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const dashboardQuery = useQuery({
    queryKey: queryKeys.memoryDashboard(),
    queryFn: () => instanceMemoryApi.dashboard(),
    refetchInterval: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);

  const actorTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of dashboardQuery.data?.writesPerAgentPerDay ?? []) {
      for (const actor of day.actors) {
        totals.set(actor.actorId, (totals.get(actor.actorId) ?? 0) + actor.count);
      }
    }
    return [...totals.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [dashboardQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={BrainCircuit} message="Select a company to view memory health." />;
  }

  if (dashboardQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (dashboardQuery.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {dashboardQuery.error.message}
      </div>
    );
  }

  const dashboard = dashboardQuery.data;
  if (!dashboard) return null;

  const maxDailyWrites = Math.max(1, ...dashboard.writesPerAgentPerDay.map((day) => day.total));
  const health = dashboard.health;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Memory</h1>
          <p className="text-sm text-muted-foreground">
            Generated {formatTimestamp(dashboard.generatedAt)}
          </p>
        </div>
        <span className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium ${pillClass(health.pill)}`}>
          {health.pill}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard
          icon={<Activity className="h-4 w-4" />}
          label="Recall hit rate"
          value={formatPercent(dashboard.recall.hitRate)}
          detail={`${dashboard.recall.hitSearches}/${dashboard.recall.totalSearches} searches hit`}
        />
        <MetricCard
          icon={<Clock className="h-4 w-4" />}
          label="Recall p50"
          value={formatLatency(dashboard.recall.latencyMs.p50)}
          detail={`last ${dashboard.recall.windowHours}h`}
        />
        <MetricCard
          icon={<Clock className="h-4 w-4" />}
          label="Recall p95"
          value={formatLatency(dashboard.recall.latencyMs.p95)}
          detail={`last ${dashboard.recall.windowHours}h`}
        />
        <MetricCard
          icon={<HeartPulse className="h-4 w-4" />}
          label="Last health"
          value={health.last?.status ?? "none"}
          detail={health.reason ?? `${health.last?.latencyMs ?? 0} ms`}
        />
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Writes Per Agent Per Day</h2>
          <span className="text-xs text-muted-foreground">Last 14 days</span>
        </div>
        <div className="rounded-md border border-border p-4">
          <div className="flex h-56 items-end gap-2">
            {dashboard.writesPerAgentPerDay.map((day) => (
              <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div className="flex h-44 w-full items-end rounded-sm bg-muted/40">
                  <div
                    className="w-full rounded-sm bg-primary"
                    style={{ height: `${Math.max(4, (day.total / maxDailyWrites) * 100)}%` }}
                    title={`${formatDay(day.day)}: ${day.total} writes`}
                  />
                </div>
                <span className="truncate text-[11px] text-muted-foreground">{formatDay(day.day)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          {actorTotals.map(([actorId, count]) => (
            <div key={actorId} className="rounded-md border border-border p-3">
              <div className="truncate text-sm font-medium">
                {agentNameById.get(actorId) ?? shortActor(actorId)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{count} writes</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border p-4">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Top Recalled Memory Keys</h2>
          </div>
          {dashboard.topRecalledMemoryKeys.available ? (
            <div className="mt-3 space-y-2">
              {dashboard.topRecalledMemoryKeys.rows.map((row) => (
                <div key={row.key} className="flex items-center justify-between text-sm">
                  <span className="truncate">{row.key}</span>
                  <span className="text-muted-foreground">{row.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {dashboard.topRecalledMemoryKeys.reason}
            </p>
          )}
        </section>

        <section className="rounded-md border border-border p-4">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Health Ping</h2>
          </div>
          <dl className="mt-3 grid grid-cols-[110px_1fr] gap-2 text-sm">
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{formatTimestamp(health.last?.createdAt)}</dd>
            <dt className="text-muted-foreground">Latency</dt>
            <dd>{health.last ? `${health.last.latencyMs} ms` : "n/a"}</dd>
            <dt className="text-muted-foreground">Components</dt>
            <dd className="space-y-1">
              {Object.entries(health.last?.components ?? {}).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-3">
                  <span>{key}</span>
                  <span className="text-muted-foreground">{String(value)}</span>
                </div>
              ))}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
