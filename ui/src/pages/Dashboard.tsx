import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { credentialsApi, type CredentialUsage } from "../api/credentials";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { CircularStatWidget } from "../components/CircularStatWidget";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { Button } from "@/components/ui/button";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents, formatTokens } from "../lib/utils";
import { Bot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, Eye, KeyRound, RefreshCw } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { AnimatedNumber, DotMatrixText } from "../components/NothingAesthetic";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function credentialUsageTokens(usage: CredentialUsage | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
}

function credentialUsageWindowTokens(usage: CredentialUsage | undefined, label: string): number {
  const window = usage?.windows.find((entry) => entry.label === label);
  if (!window) return 0;
  return window.inputTokens + window.cachedInputTokens + window.outputTokens;
}

function credentialUsageBreakdown(usage: CredentialUsage | undefined): string {
  if (!usage) return "input miss 0 · cached 0 · output 0";
  return [
    `input miss ${formatTokens(usage.inputTokens)}`,
    `cached ${formatTokens(usage.cachedInputTokens)}`,
    `output ${formatTokens(usage.outputTokens)}`,
  ].join(" · ");
}

function credentialModelTitle(usage: CredentialUsage | undefined): string {
  const models = usage?.models ?? [];
  if (models.length === 0) return "Model-aware value uses recorded model pricing when available.";
  return models
    .slice(0, 8)
    .map((model) => {
      const tokens = model.inputTokens + model.cachedInputTokens + model.outputTokens;
      return [
        `${model.model} (${model.provider}/${model.biller})`,
        `${formatTokens(tokens)} tok`,
        `${formatCents(model.apiEquivalentCostCents)} API value`,
        model.pricingLabel ?? "recorded/fallback pricing",
      ].join(" · ");
    })
    .join("\n");
}

function credentialTopModelLabel(usage: CredentialUsage | undefined): string {
  const top = usage?.models?.[0];
  if (!top) return "model-aware";
  return top.model.length > 18 ? `${top.model.slice(0, 17)}…` : top.model;
}

function formatQuotaResetTime(iso: string | null | undefined): string | null {
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

function formatQuotaResetOrDetail(window: { resetsAt: string | null; detail?: string | null }): string | null {
  return formatQuotaResetTime(window.resetsAt) ?? window.detail ?? null;
}

function DottedUsageBar({
  usedPercent,
  className,
}: {
  usedPercent: number;
  className?: string;
}) {
  const used = Math.min(100, Math.max(0, usedPercent));
  const segmentCount = 28;
  const usedSegments = used <= 0
    ? 0
    : Math.max(1, Math.min(segmentCount, Math.round((used / 100) * segmentCount)));
  return (
    <div
      className={cn(
        "grid h-4 grid-cols-[repeat(28,minmax(0,1fr))] items-center gap-1 rounded-full border border-border/50 bg-muted/20 px-1",
        className,
      )}
      aria-label={`${Math.round(used)}% used, ${Math.max(0, Math.round(100 - used))}% available`}
    >
      {Array.from({ length: segmentCount }).map((_, index) => {
        const isUsed = index < usedSegments;
        return (
          <span
            key={index}
            className={cn(
              "h-2 min-w-0 rounded-full transition-colors duration-200",
              isUsed
                ? "bg-red-500/90 shadow-[0_0_8px_rgba(239,68,68,0.22)]"
                : "bg-green-500/75 shadow-[0_0_8px_rgba(34,197,94,0.18)]",
            )}
          />
        );
      })}
    </div>
  );
}

function compactQuotaLabel(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("session")) return "5h";
  if (normalized.includes("week") && normalized.includes("sonnet")) return "sonnet wk";
  if (normalized.includes("week") && normalized.includes("opus")) return "opus wk";
  if (normalized.includes("week")) return "week";
  if (normalized.includes("extra")) return "extra";
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);
  const forceCredentialQuotaRefreshRef = useRef(false);

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
    refetchInterval: 15_000,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // "Needs you": issues genuinely awaiting THIS user's decision — the same
  // strict signal the Inbox "Needs you" tab uses (awaitingDecisionForUserId),
  // so the dashboard count matches the Inbox instead of over-counting every
  // in_review item (those may be under review by an agent, not waiting on you).
  // The metric deep-links to /inbox/decisions, which renders this exact set.
  const { data: waitingOnYou } = useQuery({
    queryKey: ["issues", selectedCompanyId, "awaiting-decision", "me"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, { awaitingDecisionForUserId: "me", includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // "In review": the broader "what's in flight on me" view — issues assigned to
  // the current user currently in_review. Distinct from "Needs you" (those
  // strictly awaiting your decision); an in_review issue may be under review by
  // an agent and not require your action yet.
  const { data: inReviewMine } = useQuery({
    queryKey: ["issues", selectedCompanyId, "in-review", "me"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeUserId: "me", status: "in_review" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: credentialQuota = [],
    refetch: refetchCredentialQuota,
    isFetching: credentialQuotaFetching,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.credentials.quotaWindows(selectedCompanyId)
      : ["credentials", "none", "quota-windows"],
    queryFn: () => {
      const refresh = forceCredentialQuotaRefreshRef.current;
      forceCredentialQuotaRefreshRef.current = false;
      return credentialsApi.quotaWindows(selectedCompanyId!, { refresh });
    },
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const refreshCredentialQuota = () => {
    forceCredentialQuotaRefreshRef.current = true;
    void refetchCredentialQuota();
  };

  const { data: credentialUsageResp } = useQuery({
    queryKey: selectedCompanyId
      ? ["credentials", selectedCompanyId, "usage", "mtd"]
      : ["credentials", "none", "usage", "mtd"],
    queryFn: () => credentialsApi.usage(selectedCompanyId!, { period: "month" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);
  const credentialUsageById = useMemo(() => {
    const map = new Map<string, CredentialUsage>();
    for (const usage of credentialUsageResp?.usage ?? []) map.set(usage.credentialId, usage);
    return map;
  }, [credentialUsageResp]);
  const credentialUsageTotals = useMemo(() => {
    const usageRows = credentialUsageResp?.usage ?? [];
    let tokens5h = 0;
    let value7dCents = 0;
    let valueMtdCents = 0;
    let billedMtdCents = 0;
    let maxCredentialTokens = 1;
    for (const usage of usageRows) {
      tokens5h += credentialUsageWindowTokens(usage, "5h");
      value7dCents += usage.windows.find((entry) => entry.label === "7d")?.apiEquivalentCostCents ?? 0;
      valueMtdCents += usage.apiEquivalentCostCents;
      billedMtdCents += usage.costCents;
      maxCredentialTokens = Math.max(maxCredentialTokens, credentialUsageTokens(usage));
    }
    return { tokens5h, value7dCents, valueMtdCents, billedMtdCents, maxCredentialTokens };
  }, [credentialUsageResp]);

  // Stalled tasks: open issues whose blocker-attention says they're stalled or
  // need attention (computed server-side and returned on the list). Most-recent
  // first so the drill-down shows what to investigate.
  const stalledIssues = useMemo(
    () =>
      getRecentIssues(
        (issues ?? []).filter(
          (i) =>
            i.blockerAttention?.state === "stalled" ||
            i.blockerAttention?.state === "needs_attention",
        ),
      ),
    [issues],
  );

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

  return (
    <div className="space-y-8 pb-10">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-300/60 bg-amber-50/80 backdrop-blur-sm px-5 py-4 dark:border-amber-500/25 dark:bg-amber-950/60 shadow-sm">
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

      <ActiveAgentsPanel
        companyId={selectedCompanyId!}
        headerExtra={
          data ? (
            <div className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-[#34BFF0] animate-pulse" aria-hidden />
              <span>Tokens this month</span>
              <DotMatrixText className="text-[15px] leading-none text-foreground">
                <AnimatedNumber
                  value={
                    data.costs.monthInputTokens
                    + data.costs.monthOutputTokens
                    + data.costs.monthCachedInputTokens
                  }
                  format={formatTokens}
                />
              </DotMatrixText>
            </div>
          ) : null
        }
      />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-2xl border border-red-500/20 bg-[linear-gradient(135deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] backdrop-blur-sm px-5 py-4 shadow-sm">
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

          {credentialQuota.length > 0 && (
            <div className="rounded-2xl border border-border/60 bg-background/75 backdrop-blur-sm shadow-sm px-5 py-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-[#34BFF0]" />
                  <h3 className="text-sm font-medium">Credential quota & value</h3>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                    onClick={refreshCredentialQuota}
                    disabled={credentialQuotaFetching}
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", credentialQuotaFetching && "animate-spin")} />
                    Refresh
                  </Button>
                  <Link to="/settings" className="text-xs text-muted-foreground hover:text-foreground">
                    Manage
                  </Link>
                </div>
              </div>
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">5h tokens</p>
                  <DotMatrixText className="text-xl leading-tight text-foreground">
                    <AnimatedNumber value={credentialUsageTotals.tokens5h} format={formatTokens} />
                  </DotMatrixText>
                </div>
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">7d API value</p>
                  <DotMatrixText className="text-xl leading-tight text-foreground">
                    <AnimatedNumber value={credentialUsageTotals.value7dCents} format={(n) => formatCents(Math.round(n))} />
                  </DotMatrixText>
                </div>
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">MTD value / billed</p>
                  <DotMatrixText className="text-xl leading-tight text-foreground">
                    <AnimatedNumber value={credentialUsageTotals.valueMtdCents} format={(n) => formatCents(Math.round(n))} />
                  </DotMatrixText>
                  <p className="text-[10px] text-muted-foreground">
                    billed {formatCents(credentialUsageTotals.billedMtdCents)}
                  </p>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {credentialQuota.slice(0, 6).map((row) => {
                  const usage = credentialUsageById.get(row.credentialId);
                  const totalTokens = credentialUsageTokens(usage);
                  const weekValue = usage?.windows.find((entry) => entry.label === "7d")?.apiEquivalentCostCents ?? 0;
                  const observedPercent = Math.min(
                    100,
                    credentialUsageTotals.maxCredentialTokens > 0
                      ? (totalTokens / credentialUsageTotals.maxCredentialTokens) * 100
                      : 0,
                  );
                  const visibleQuotaWindows = row.quotaWindows
                    .filter((entry) => entry.usedPercent != null || entry.valueLabel)
                    .slice(0, 4);
                  const quotaStatusLabel = row.stale
                    ? "stale"
                    : row.disabledAt
                      ? "disabled"
                      : row.cooldownUntil
                        ? "cooling"
                        : !row.ok
                          ? "retrying"
                          : row.type;
                  const quotaStatusTitle = row.stale && row.cachedAt
                    ? `Showing last successful quota sample from ${new Date(row.cachedAt).toLocaleString()}`
                    : row.error;
                  return (
                    <div key={row.credentialId} className="rounded-md border border-border/60 bg-muted/20 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium">{row.name}</span>
                        <span className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                          row.stale
                            ? "bg-amber-500/10 text-amber-600"
                            : row.disabledAt
                            ? "bg-destructive/10 text-destructive"
                            : row.cooldownUntil
                              ? "bg-sky-500/10 text-sky-600"
                              : "bg-muted text-muted-foreground",
                        )}
                        title={quotaStatusTitle}
                        >
                          {quotaStatusLabel}
                        </span>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-2">
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">MTD tokens</p>
                          <DotMatrixText className="text-base leading-none">
                            {formatTokens(totalTokens)}
                          </DotMatrixText>
                          <p className="mt-1 max-w-[12rem] truncate text-[10px] text-muted-foreground" title={credentialUsageBreakdown(usage)}>
                            {credentialUsageBreakdown(usage)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">API value</p>
                          <span className="text-xs tabular-nums" title={credentialModelTitle(usage)}>
                            {formatCents(usage?.apiEquivalentCostCents ?? 0)}
                          </span>
                          <p className="mt-1 max-w-[9rem] truncate text-[10px] text-muted-foreground" title={credentialModelTitle(usage)}>
                            {credentialTopModelLabel(usage)}
                          </p>
                        </div>
                      </div>
                      <DottedUsageBar usedPercent={observedPercent} className="mt-2" />
                      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] text-muted-foreground">
                        <span>5h {formatTokens(credentialUsageWindowTokens(usage, "5h"))}</span>
                        <span className="text-right">7d {formatCents(weekValue)}</span>
                      </div>
                      <div
                        className="mt-3 space-y-1.5"
                        title={row.quotaWindows
                          .map((entry) => {
                            const reset = formatQuotaResetOrDetail(entry);
                            return `${entry.label}: ${entry.usedPercent != null ? `${Math.round(entry.usedPercent)}% used, ${Math.max(0, Math.round(100 - entry.usedPercent))}% available` : entry.valueLabel ?? "reported"}${reset ? ` · ${reset}` : ""}`;
                          })
                          .join(" · ")}
                      >
                        {row.stale && row.error ? (
                          <p className="text-[10px] text-amber-600" title={row.error}>
                            stale quota sample
                          </p>
                        ) : null}
                        {!row.supported ? (
                          <p className="text-[10px] text-muted-foreground">quota n/a</p>
                        ) : !row.ok && visibleQuotaWindows.length === 0 ? (
                          <p className="text-[10px] text-amber-600" title={row.error ?? "quota unavailable"}>
                            quota retrying
                          </p>
                        ) : visibleQuotaWindows.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground">quota ok</p>
                        ) : (
                          visibleQuotaWindows.map((window) => (
                            <div key={window.label} className="space-y-1">
                              <div className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="truncate text-muted-foreground">{compactQuotaLabel(window.label)}</span>
                                <span className="shrink-0 tabular-nums">
                                  {window.usedPercent != null
                                    ? `${Math.max(0, Math.round(100 - window.usedPercent))}% left`
                                    : window.valueLabel ?? "ok"}
                                </span>
                              </div>
                              {formatQuotaResetOrDetail(window) ? (
                                <div className="truncate text-[10px] text-muted-foreground">
                                  {formatQuotaResetOrDetail(window)}
                                </div>
                              ) : null}
                              {window.usedPercent != null ? (
                                <DottedUsageBar usedPercent={window.usedPercent} />
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(() => {
            const costsPercent =
              data.costs.monthBudgetCents > 0 ? data.costs.monthUtilizationPercent / 100 : 0;
            const costsTone: "default" | "danger" =
              data.costs.monthBudgetCents > 0 && data.costs.monthUtilizationPercent > 80
                ? "danger"
                : "default";
            const approvalsCount = data.pendingApprovals + data.budgets.pendingApprovals;
            const approvalsPercent = Math.min(approvalsCount / 10, 1);
            const approvalsTone: "default" | "danger" = approvalsCount > 0 ? "danger" : "default";
            // "Needs you" = issues awaiting this user's decision (same set as the
            // Inbox "Needs you" tab). "Stalled" = issues whose blockerAttention
            // says they're stalled or need attention (client-side from the issues
            // list, which carries blockerAttention).
            const waitingCount = waitingOnYou?.length ?? 0;
            const waitingTone: "default" | "danger" = waitingCount > 0 ? "danger" : "default";
            const inReviewCount = inReviewMine?.length ?? 0;
            const stalledCount = stalledIssues.length;
            const stalledTone: "default" | "danger" = stalledCount > 0 ? "danger" : "default";
            return (
              <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 sm:gap-4">
                <CircularStatWidget
                  icon={Bot}
                  value={waitingCount}
                  label="Needs you"
                  percent={Math.min(waitingCount / 10, 1)}
                  tone={waitingTone}
                  to="/inbox/decisions"
                  description={
                    <span>
                      {waitingCount > 0 ? "awaiting your decision" : "nothing waiting"}
                    </span>
                  }
                />
                <CircularStatWidget
                  icon={Eye}
                  value={inReviewCount}
                  label="In review"
                  percent={Math.min(inReviewCount / 10, 1)}
                  tone="info"
                  to="/issues"
                  description={
                    <span>
                      {inReviewCount > 0 ? "in flight, assigned to you" : "nothing in review"}
                    </span>
                  }
                />
                <CircularStatWidget
                  icon={PauseCircle}
                  value={stalledCount}
                  label="Stalled tasks"
                  percent={Math.min(stalledCount / 10, 1)}
                  tone={stalledTone}
                  to="/issues"
                  description={
                    <span>
                      {stalledCount > 0 ? "needs attention" : "none stalled"}
                    </span>
                  }
                />
                {(() => {
                  const tokensTotal =
                    data.costs.monthInputTokens
                    + data.costs.monthOutputTokens
                    + data.costs.monthCachedInputTokens;
                  const tokensLabel = formatTokens(tokensTotal);
                  const hasCost = data.costs.monthSpendCents > 0;
                  return (
                    <CircularStatWidget
                      icon={DollarSign}
                      value={hasCost ? formatCents(data.costs.monthSpendCents) : tokensLabel}
                      label={hasCost ? "Month Spend" : "Month Tokens"}
                      percent={costsPercent}
                      tone={costsTone}
                      to="/costs"
                      description={
                        <span>
                          {hasCost
                            ? (data.costs.monthBudgetCents > 0
                                ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget · ${tokensLabel} tokens`
                                : `${tokensLabel} tokens · unlimited budget`)
                            : (data.costs.monthBudgetCents > 0
                                ? `${formatCents(data.costs.monthSpendCents)} cost · ${formatCents(data.costs.monthBudgetCents)} budget`
                                : "Subscription plan — $0 metered")}
                        </span>
                      }
                    />
                  );
                })()}
                <CircularStatWidget
                  icon={ShieldCheck}
                  value={approvalsCount}
                  label="Pending Approvals"
                  percent={approvalsPercent}
                  tone={approvalsTone}
                  to="/approvals"
                  description={
                    <span>
                      {data.budgets.pendingApprovals > 0
                        ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                        : "Awaiting board review"}
                    </span>
                  }
                />
              </div>
            );
          })()}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm p-5"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                  Recent Activity
                </h3>
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Needs you — issues awaiting your decision (same set as Inbox) */}
            {waitingOnYou && waitingOnYou.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1 flex items-center justify-between">
                  <span>Needs you ({waitingOnYou.length})</span>
                  <Link to="/inbox/decisions" className="text-[10px] font-normal normal-case tracking-normal text-blue-600 dark:text-blue-400 no-underline hover:underline">
                    Open inbox
                  </Link>
                </h3>
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {waitingOnYou.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-5 py-4 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            <span className="text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 bg-amber-500/10 text-amber-600">
                              needs decision
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Stalled tasks — drill-down for the "Stalled tasks" metric */}
            {stalledIssues.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                  Stalled tasks ({stalledIssues.length})
                </h3>
                <div className="rounded-2xl border border-amber-500/20 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {stalledIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-5 py-4 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.blockerAttention?.reason && (
                              <span className="text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 bg-amber-500/10 text-amber-600">
                                {issue.blockerAttention.reason.replace(/_/g, " ")}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm p-5">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : (
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-5 py-4 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
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
