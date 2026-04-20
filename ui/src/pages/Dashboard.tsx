import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { costsApi } from "../api/costs";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { formatCents, formatTokens } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, Gauge, TrendingUp } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { DashboardCodexLimitsCard } from "../components/DashboardCodexLimitsCard";
import type {
  Agent,
  CostByBiller,
  CostByProviderModel,
  DashboardCodexProjectsEstimate,
  Issue,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import {
  findCodexCreditsQuotaWindow,
  formatCodexQuotaErrorMessage,
  findCodexQuotaResult,
  pickPrimaryCodexQuotaWindow,
} from "@/lib/codexQuota";

const DASHBOARD_HEARTBEAT_RUN_LIMIT = 100;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

const SUBSCRIPTION_BILLING_TYPES = new Set(["subscription_included", "subscription_overage"]);

type CodexUsageMetric = {
  usedTokens: number;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowLabel: string | null;
  creditsLabel: string | null;
};

type OpenRouterSpendMetric = {
  spendCents: number;
  totalTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
};

function buildCodexUsageMetric(
  providerRows: CostByProviderModel[] | undefined,
  quotaResults: ProviderQuotaResult[] | undefined,
): CodexUsageMetric | null {
  const providerUsage = providerRows ?? [];
  const codexRows = providerUsage.filter((row) =>
    row.provider === "openai" &&
    row.biller === "chatgpt" &&
    SUBSCRIPTION_BILLING_TYPES.has(row.billingType),
  );
  const fallbackCodexRows = codexRows.length > 0
    ? codexRows
    : providerUsage.filter((row) => row.provider === "openai" && row.biller === "chatgpt");

  const codexQuota = findCodexQuotaResult(quotaResults);

  if (fallbackCodexRows.length === 0 && !codexQuota?.ok) {
    return null;
  }

  const usedTokens = fallbackCodexRows.reduce(
    (sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens,
    0,
  );
  const primaryWindow = codexQuota?.ok ? pickPrimaryCodexQuotaWindow(codexQuota.windows) : null;
  const creditsWindow = codexQuota?.ok ? findCodexCreditsQuotaWindow(codexQuota.windows) : null;
  const usedPercent = primaryWindow?.usedPercent ?? null;
  const remainingPercent = typeof usedPercent === "number" ? Math.max(0, 100 - usedPercent) : null;

  return {
    usedTokens,
    usedPercent,
    remainingPercent,
    windowLabel: primaryWindow?.label ?? null,
    creditsLabel: creditsWindow?.valueLabel ?? null,
  };
}

function buildOpenRouterSpendMetric(
  billerRows: CostByBiller[] | undefined,
): OpenRouterSpendMetric | null {
  const openRouterRow = (billerRows ?? []).find((row) => row.biller === "openrouter");
  if (!openRouterRow) return null;

  const totalTokens =
    openRouterRow.inputTokens +
    openRouterRow.cachedInputTokens +
    openRouterRow.outputTokens;

  if (openRouterRow.costCents <= 0 && totalTokens <= 0) {
    return null;
  }

  return {
    spendCents: openRouterRow.costCents,
    totalTokens,
    apiRunCount: openRouterRow.apiRunCount,
    subscriptionRunCount: openRouterRow.subscriptionRunCount,
  };
}

function formatDevHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0h";
  if (hours < 1) return `${hours.toFixed(2)}h`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function formatRoiMultiple(roi: number | null): string {
  if (roi === null) return "no billed spend";
  if (!Number.isFinite(roi)) return "0x ROI";
  return `${roi.toFixed(roi >= 10 ? 0 : 1)}x ROI`;
}

function CodexProjectEstimatePanel({ estimate }: { estimate: DashboardCodexProjectsEstimate }) {
  const projectLabel = estimate.projectCount === 1 ? "project" : "projects";

  return (
    <Card className="border-border/70">
      <CardHeader className="px-5 pt-5 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Codex Project Estimate</CardTitle>
            <CardDescription>
              7-day replacement-value estimate for current Codex-labeled projects, not billed spend.
            </CardDescription>
          </div>
          <Link to="/projects" className="shrink-0 text-xs font-medium text-muted-foreground no-underline hover:text-foreground">
            Open projects
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-4">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
          <div className="min-w-0 border border-border bg-muted/20 px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Estimated Value
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums text-foreground">
              {formatCents(estimate.estimatedDevValueCents)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatDevHours(estimate.estimatedDevHours)} estimated project work
            </div>
          </div>

          <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="border border-border px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Coverage</div>
              <div className="mt-1 font-medium tabular-nums">{estimate.projectCount} {projectLabel}</div>
            </div>
            <div className="border border-border px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Project Time</div>
              <div className="mt-1 font-medium tabular-nums">{estimate.projectWeekEquivalent.toFixed(2)} wk</div>
            </div>
            <div className="border border-border px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Tokens</div>
              <div className="mt-1 font-medium tabular-nums">{formatTokens(estimate.totalTokens)}</div>
            </div>
            <div className="border border-border px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Model</div>
              <div className="mt-1 font-medium tabular-nums">
                {formatCents(estimate.devValueHourlyRateCents)}/hr
              </div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Model: {estimate.assumption} Current basis is {formatCents(estimate.devValueHourlyRateCents)} per{" "}
          {formatTokens(estimate.devValueTokensPerHour)} tokens of work.
        </p>
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "limit", DASHBOARD_HEARTBEAT_RUN_LIMIT],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, DASHBOARD_HEARTBEAT_RUN_LIMIT),
    enabled: !!selectedCompanyId,
  });

  const monthStartIso = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }, []);

  const { data: providerUsageRows } = useQuery({
    queryKey: queryKeys.usageByProvider(selectedCompanyId!, monthStartIso),
    queryFn: () => costsApi.byProvider(selectedCompanyId!, monthStartIso),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: billerUsageRows } = useQuery({
    queryKey: queryKeys.usageByBiller(selectedCompanyId!, monthStartIso),
    queryFn: () => costsApi.byBiller(selectedCompanyId!, monthStartIso),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: quotaRows, isLoading: quotaLoading, error: quotaError } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(selectedCompanyId!),
    queryFn: async () => {
      try {
        return await costsApi.quotaWindows(selectedCompanyId!);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);
  const codexUsageMetric = useMemo(() => {
    return buildCodexUsageMetric(providerUsageRows, quotaRows);
  }, [providerUsageRows, quotaRows]);
  const openRouterSpendMetric = useMemo(() => {
    return buildOpenRouterSpendMetric(billerUsageRows);
  }, [billerUsageRows]);
  const codexQuotaResult = useMemo(() => findCodexQuotaResult(quotaRows), [quotaRows]);
  const codexQuotaWindows = codexQuotaResult?.ok ? codexQuotaResult.windows : [];
  const codexQuotaSource = codexQuotaResult?.source ?? null;
  const hasCodexUsageEvidence = useMemo(() => {
    return (providerUsageRows ?? []).some((row) =>
      row.provider === "openai" && row.biller === "chatgpt",
    );
  }, [providerUsageRows]);
  const codexQuotaErrorMessage = useMemo(() => {
    if (codexQuotaResult && !codexQuotaResult.ok) {
      return formatCodexQuotaErrorMessage(codexQuotaResult.error) ??
        "Paperclip could not load live Codex rate limits.";
    }
    if (quotaError instanceof Error) return formatCodexQuotaErrorMessage(quotaError.message);
    return null;
  }, [codexQuotaResult, quotaError]);
  const shouldShowCodexLimitsCard = codexQuotaWindows.length > 0 || hasCodexUsageEvidence;
  const codexUsageDescription = useMemo(() => {
    if (!codexUsageMetric) return "No ChatGPT Codex usage tracked yet.";
    const quotaSummary =
      codexUsageMetric.usedPercent != null && codexUsageMetric.remainingPercent != null
        ? `${codexUsageMetric.usedPercent}% used · ${codexUsageMetric.remainingPercent}% left (${codexUsageMetric.windowLabel ?? "active window"})`
        : (codexUsageMetric.creditsLabel ?? "Live quota unavailable");
    return `MTD usage · ${quotaSummary}`;
  }, [codexUsageMetric]);
  const openRouterSpendDescription = useMemo(() => {
    if (!openRouterSpendMetric) return "No OpenRouter activity tracked yet.";

    const parts = [`${formatTokens(openRouterSpendMetric.totalTokens)} tok`];
    if (openRouterSpendMetric.apiRunCount > 0 || openRouterSpendMetric.subscriptionRunCount > 0) {
      parts.push(`${openRouterSpendMetric.apiRunCount} metered`);
      parts.push(`${openRouterSpendMetric.subscriptionRunCount} subscription`);
    }
    return `MTD usage · ${parts.join(" · ")}`;
  }, [openRouterSpendMetric]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const metricGridClassName = openRouterSpendMetric
    ? "grid grid-cols-2 gap-1 sm:gap-2 md:grid-cols-3 xl:grid-cols-7 2xl:grid-cols-8"
    : "grid grid-cols-2 gap-1 sm:gap-2 md:grid-cols-3 xl:grid-cols-7";

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className={metricGridClassName}>
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={TrendingUp}
              value={formatCents(data.costs.workValue.estimatedDevValueCents)}
              label="Estimated Dev Value"
              to="/costs"
              description={
                <span>
                  {formatDevHours(data.costs.workValue.estimatedDevHours)} est. dev time{", "}
                  {formatTokens(data.costs.workValue.totalTokens)} tokens{", "}
                  {formatCents(data.costs.workValue.estimatedSavingsCents)} saved{", "}
                  {formatRoiMultiple(data.costs.workValue.roiMultiple)}
                </span>
              }
            />
            <MetricCard
              icon={TrendingUp}
              value={formatCents(data.costs.codexProjectsEstimate.estimatedDevValueCents)}
              label="Codex Project Estimate"
              to="/projects"
              description={
                <span>
                  {data.costs.codexProjectsEstimate.projectCount} Codex projects{", "}
                  {formatDevHours(data.costs.codexProjectsEstimate.estimatedDevHours)} estimated{", "}
                  not billed spend
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
            <MetricCard
              icon={Gauge}
              value={codexUsageMetric ? formatTokens(codexUsageMetric.usedTokens) : "—"}
              label="Codex Tokens (MTD)"
              to="/costs"
              description={<span>{codexUsageDescription}</span>}
            />
            {openRouterSpendMetric ? (
              <MetricCard
                icon={DollarSign}
                value={formatCents(openRouterSpendMetric.spendCents)}
                label="OpenRouter Spend (MTD)"
                to="/costs"
                description={<span>{openRouterSpendDescription}</span>}
              />
            ) : null}
          </div>

          <CodexProjectEstimatePanel estimate={data.costs.codexProjectsEstimate} />

          {shouldShowCodexLimitsCard ? (
            <DashboardCodexLimitsCard
              windows={codexQuotaWindows}
              source={codexQuotaSource}
              error={codexQuotaErrorMessage}
              loading={quotaLoading && codexQuotaWindows.length === 0}
            />
          ) : null}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart runs={runs ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart runs={runs ?? []} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <div className="border border-border p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : (
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
