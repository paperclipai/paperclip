import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { MetricCard } from "@/components/MetricCard";
import { adminApi } from "@/api/admin";
import { cn, formatCents } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Building2,
  CircleDot,
  DollarSign,
  Info,
  RefreshCw,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";

function SeverityDot({ severity }: { severity: "warning" | "error" | "info" }) {
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        severity === "error" ? "bg-red-500" : severity === "warning" ? "bg-amber-500" : "bg-blue-500",
      )}
    />
  );
}

function AlertBanner({
  type,
  severity,
  message,
  count,
  targetPath,
}: {
  type: string;
  severity: "warning" | "error" | "info";
  message: string;
  count: number;
  targetPath?: string;
}) {
  const content = (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
        severity === "error"
          ? "border-red-500/20 bg-red-500/[0.06] text-red-200"
          : severity === "warning"
            ? "border-amber-500/20 bg-amber-500/[0.06] text-amber-200"
            : "border-blue-500/20 bg-blue-500/[0.06] text-blue-200",
      )}
    >
      <div className="flex items-center gap-2.5">
        <SeverityDot severity={severity} />
        <span>{message}</span>
        <span className="ml-1 text-xs font-bold opacity-70">({count})</span>
      </div>
      {targetPath && <span className="text-xs underline underline-offset-2 opacity-70">View</span>}
    </div>
  );

  if (targetPath) {
    return (
      <Link to={targetPath} className="no-underline block">
        {content}
      </Link>
    );
  }
  return content;
}

function ErrorRateBadge({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const color =
    pct < 5 ? "text-emerald-400" : pct < 15 ? "text-amber-400" : "text-red-400";
  return <span className={cn("font-semibold tabular-nums", color)}>{pct}%</span>;
}

export default function AdminDashboard() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "IronWorks Admin" }, { label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: () => adminApi.getDashboard(),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Platform-wide health &amp; metrics
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-400">
          Failed to load dashboard: {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border h-28 animate-pulse bg-muted/30" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Row 1: Key metrics */}
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Platform Overview
            </h2>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={Building2}
                  value={data.totalCompanies}
                  label="Total Companies"
                  to="/manage/companies"
                />
              </div>
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={Zap}
                  value={data.totalAgents}
                  label="Total Agents"
                  to="/manage/companies"
                />
              </div>
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={Users}
                  value={data.totalUsers}
                  label="Total Users"
                  to="/manage/users"
                />
              </div>
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={DollarSign}
                  value={formatCents(data.mrrCents)}
                  label="Monthly Recurring Revenue"
                />
              </div>
            </div>
          </div>

          {/* Row 2: Operational metrics */}
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Operations (Today)
            </h2>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={CircleDot}
                  value={data.activeAgentsNow}
                  label="Active Agents Now"
                  description={
                    <span className="flex items-center gap-1">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                      live
                    </span>
                  }
                />
              </div>
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={Activity}
                  value={data.runsToday}
                  label="Runs Today"
                />
              </div>
              <div className="rounded-xl border border-border">
                <MetricCard
                  icon={DollarSign}
                  value={formatCents(data.totalSpendTodayCents)}
                  label="Spend Today"
                />
              </div>
              <div className="rounded-xl border border-border px-4 py-4 sm:px-5 sm:py-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-2xl sm:text-3xl font-semibold tracking-tight">
                      <ErrorRateBadge rate={data.errorRate24h} />
                    </p>
                    <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
                      Error Rate (24h)
                    </p>
                    <div className="text-sm text-muted-foreground/70 mt-1.5 hidden sm:block">
                      &lt;5% green · 5-15% yellow · &gt;15% red
                    </div>
                  </div>
                  <TrendingUp className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
                </div>
              </div>
            </div>
          </div>

          {/* Row 3: Two-column lists */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top companies by spend */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Top Companies by Spend (MTD)
                </h3>
              </div>
              {data.topCompaniesBySpend.length === 0 ? (
                <p className="text-sm text-muted-foreground">No spend data yet.</p>
              ) : (
                <div className="space-y-2">
                  {data.topCompaniesBySpend.map((c) => (
                    <div
                      key={c.companyId}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{c.companyName}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {c.agentCount} agents
                        </span>
                      </div>
                      <span className="font-medium tabular-nums shrink-0">
                        {formatCents(c.spendCents)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent signups */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent Signups
              </h3>
              {data.recentSignups.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent signups.</p>
              ) : (
                <div className="divide-y divide-border -mx-4">
                  {data.recentSignups.slice(0, 10).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{s.name}</span>
                        <span className="text-[10px] font-medium rounded px-1.5 py-0.5 bg-muted text-muted-foreground shrink-0">
                          {s.planTier}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(s.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Row 4: Subscriptions by tier */}
          {Object.keys(data.subscriptionsByTier).length > 0 && (
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Subscriptions by Tier
              </h3>
              <div className="flex flex-wrap gap-3">
                {Object.entries(data.subscriptionsByTier).map(([tier, count]) => (
                  <div
                    key={tier}
                    className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <span className="text-sm font-medium capitalize">{tier}</span>
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Row 5: Alerts */}
          {data.alerts.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Alerts Requiring Attention
                </h3>
              </div>
              <div className="space-y-2">
                {data.alerts.map((alert) => (
                  <AlertBanner key={alert.type} {...alert} />
                ))}
              </div>
            </div>
          )}

          {data.alerts.length === 0 && (
            <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3 text-sm text-emerald-400">
              <Info className="h-4 w-4 shrink-0" />
              All systems normal — no alerts at this time.
            </div>
          )}
        </>
      )}
    </div>
  );
}
