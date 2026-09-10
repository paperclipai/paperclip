import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "@/lib/router";
import {
  onboardingStepForCompany,
  shouldRouteAgentlessCompanyToOnboarding,
} from "../lib/onboarding-route";
import { claimOnboardingOffer } from "../lib/onboarding-auto-open";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { attentionApi } from "../api/attention";
import { decisionsApi } from "../api/decisions";
import { authApi } from "../api/auth";
import { useIssueOverviews } from "../hooks/useIssueOverviews";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  OPERATOR_DECIDED_PREVIEW_LIMIT,
  OPERATOR_DECISION_PREVIEW_LIMIT,
  OPERATOR_ISSUE_LOAD_LIMIT,
  buildAgentNameMap,
  deriveDeliveredOutcomes,
  deriveNextCandidates,
  deriveProjectRollups,
  deriveStuckTasks,
  describeDecisionPreviewCoverage,
  describeOperatorInventory,
  loadOperatorLastVisit,
  loadOperatorTimeWindow,
  recordOperatorVisit,
  resolveOperatorWindow,
  saveOperatorTimeWindow,
  scanDecisionPreview,
  type OperatorTimeWindowId,
} from "../lib/operator-dashboard";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { formatCents } from "../lib/utils";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import { Button } from "../components/ui/button";
import { InlineBanner } from "../components/InlineBanner";
import type { Agent, AttentionItem, DashboardSummary, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SmokeLabDashboardCard } from "../components/SmokeLabDashboardCard";
import {
  CompletedWorkSection,
  EngineeringDisclosure,
  NeedsDecisionSection,
  NextCandidatesSection,
  OperatorCostStrip,
  OperatorWindowPicker,
  ProjectRollupsSection,
  RecentlyDecidedSection,
  StuckTasksSection,
} from "../components/operator/OperatorDashboardSections";
const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export type PausedAgentBanner =
  | { kind: "imported"; pausedImportedAgentIds: string[] }
  | { kind: "all-paused" }
  | null;

/**
 * Which paused-agents banner the dashboard should show. Import-paused agents
 * get the specific banner with a bulk resume (they were parked by the import
 * safety default and stay parked until someone acts); otherwise a company
 * whose agents are ALL paused gets a generic explanation, because from the
 * outside it is indistinguishable from a broken company.
 */
export function derivePausedAgentBanner(agents: Agent[] | undefined): PausedAgentBanner {
  if (!agents || agents.length === 0) return null;
  const importedPaused = agents.filter(
    (agent) => agent.status === "paused" && agent.pauseReason === "import",
  );
  if (importedPaused.length > 0) {
    return { kind: "imported", pausedImportedAgentIds: importedPaused.map((agent) => agent.id) };
  }
  if (agents.every((agent) => agent.status === "paused")) return { kind: "all-paused" };
  return null;
}

/**
 * How much of the month's cost is actually accounted for, derived from the
 * observation counts the dashboard API now returns next to the subtotal.
 *
 * - `no-usage-reported`: no cost events this month. The card must NOT render
 *   `$0.00` as if usage were measured and free — nothing was reported.
 * - `incomplete`: some events carried token usage but no provider-reported
 *   price (that bucket also holds subscription-included usage). Their recorded
 *   amounts are excluded from the subtotal whatever they are, so the subtotal
 *   covers priced events only and must be labelled.
 * - `reported`: every event this month reported a price, so a `$0.00` subtotal
 *   is a genuine reported zero rather than a missing measurement.
 *
 * Only events, not runs, are counted: a month can have runs and no cost events
 * at all, so these counts must never be read as "every run was metered".
 */
export type MonthCostCoverage =
  | { kind: "no-usage-reported" }
  | { kind: "incomplete"; reportedCount: number; unpricedCount: number }
  | { kind: "reported"; reportedCount: number };

export function deriveMonthCostCoverage(
  costs: Pick<DashboardSummary["costs"], "monthReportedCount" | "monthUnpricedCount">,
): MonthCostCoverage {
  if (costs.monthReportedCount === 0 && costs.monthUnpricedCount === 0) {
    return { kind: "no-usage-reported" };
  }
  if (costs.monthUnpricedCount > 0) {
    return {
      kind: "incomplete",
      reportedCount: costs.monthReportedCount,
      unpricedCount: costs.monthUnpricedCount,
    };
  }
  return { kind: "reported", reportedCount: costs.monthReportedCount };
}

function monthCostCoverageNote(coverage: MonthCostCoverage): string {
  if (coverage.kind === "no-usage-reported") {
    return "No cost usage reported this month";
  }
  if (coverage.kind === "incomplete") {
    const total = coverage.reportedCount + coverage.unpricedCount;
    return `${coverage.unpricedCount} of ${total} cost events unpriced — subtotal covers priced events only`;
  }
  return `${coverage.reportedCount} cost event${coverage.reportedCount === 1 ? "" : "s"} reported`;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
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

  // Bulk resume for agents parked by a company import. Sequential on purpose
  // (mirrors the import page's activation checklist); a per-agent failure is
  // tolerated so one bad agent never blocks the rest, and the refetch below
  // re-renders the banner with whatever remains paused.
  const queryClient = useQueryClient();
  const resumeImportedAgents = useMutation({
    mutationFn: async () => {
      const targets = derivePausedAgentBanner(agents);
      if (!targets || targets.kind !== "imported") return;
      for (const agentId of targets.pausedImportedAgentIds) {
        try {
          await agentsApi.resume(agentId, selectedCompanyId ?? undefined);
        } catch {
          // Leave the agent paused; the banner re-renders with the remainder.
        }
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) }),
      ]);
    },
  });

  // A company with no agent cannot do anything — no runs, no tasks, nothing
  // to show. The banner below already says so and offers a link; this takes
  // the customer there instead of asking them to notice.
  //
  // It also closes the gap a Cloud-provisioned stack falls into. Cloud creates
  // the company before the tenant boots, so the companyless redirect never
  // fires and a seeded customer lands here, on an empty dashboard, straight
  // out of signup.
  //
  // Opened as the dialog rather than navigated to: the wizard is already
  // mounted globally, so there is no route to race and no redirect to loop.
  // Placed with the other hooks — the early returns below mean anything
  // further down would be called conditionally.
  //
  // The company and the step are both passed. Opening with empty options would
  // start the wizard at the front door with no company, and the new-company
  // path there would create a *second* company instead of giving this one an
  // agent.
  const shouldOpenOnboarding = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentCount: agents?.length ?? 0,
  });
  // Auto-open once per company. Every input to the effect sits behind a query,
  // so a refetch re-runs it, and the customer can also navigate away and come
  // back — both would otherwise call `openOnboarding` again and reopen a
  // wizard that was deliberately closed. `claimOnboardingOffer` holds the
  // companies already offered; see it for why that outlives this component.
  useEffect(() => {
    if (!shouldOpenOnboarding || !selectedCompanyId) return;
    if (!claimOnboardingOffer(selectedCompanyId)) return;
    openOnboarding({
      companyId: selectedCompanyId,
      initialStep: onboardingStepForCompany(),
    });
    // No mission lookup to wait on any more: the step this opens is the same
    // whatever the goals say, so waiting only delayed the open.
  }, [shouldOpenOnboarding, selectedCompanyId, openOnboarding]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Operator time window: persisted per company + user. Hydration here only
  // reads; the visit itself is recorded further down, once operator data has
  // loaded, through a per-company/user guard (StrictMode double-invokes
  // effects, which would otherwise overwrite the previous visit with "now"
  // twice and collapse the since-visit window to zero).
  const [windowId, setWindowId] = useState<OperatorTimeWindowId>(() =>
    loadOperatorTimeWindow(selectedCompanyId, currentUserId),
  );
  const [lastVisit, setLastVisit] = useState<number | null>(() =>
    loadOperatorLastVisit(selectedCompanyId, currentUserId),
  );
  const visitRecordedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    setWindowId(loadOperatorTimeWindow(selectedCompanyId, currentUserId));
    setLastVisit(loadOperatorLastVisit(selectedCompanyId, currentUserId));
  }, [selectedCompanyId, currentUserId]);

  const dashboardQueryKey = queryKeys.dashboard(selectedCompanyId!);
  const sharedDashboard = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data, isLoading, error, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedDashboard, data, dashboardUpdatedAt);

  const activityQueryKey = [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }] as const;
  const sharedActivity = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: `activity:limit:${DASHBOARD_ACTIVITY_LIMIT}`,
    queryKey: activityQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data: activity, dataUpdatedAt: activityUpdatedAt } = useQuery({
    queryKey: activityQueryKey,
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedActivity, activity, activityUpdatedAt);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Bounded task inventory for the operator sections: the most recently
  // updated tasks, with the bound disclosed next to every derived list so a
  // partial fetch never masquerades as a full inventory.
  const operatorIssuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "operator", { limit: OPERATOR_ISSUE_LOAD_LIMIT }] as const,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        limit: OPERATOR_ISSUE_LOAD_LIMIT,
        sortField: "updated",
        sortDir: "desc",
      }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });
  const operatorIssues = operatorIssuesQuery.data;

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Decisions preview: the server ranks the whole attention feed before it
  // paginates, so the viewer's own gates can sit below the first page. Read
  // bounded pages until the quota is filled or the budget runs out, and carry
  // the scan's scope into the section so a partial read never reads as an
  // all-clear.
  const decisionPreviewQuery = useQuery({
    queryKey: [
      ...queryKeys.attention(selectedCompanyId!),
      "operator-preview",
      currentUserId ?? "signed-out",
    ] as const,
    queryFn: () =>
      scanDecisionPreview<AttentionItem>(
        (cursor) =>
          attentionApi.list(selectedCompanyId!, {
            limit: OPERATOR_DECISION_PREVIEW_LIMIT,
            cursor: cursor ?? undefined,
          }),
        currentUserId,
      ),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });
  const decisionPreviewScan = decisionPreviewQuery.data;

  const decidedPreviewQuery = useQuery({
    queryKey: [...queryKeys.decisions.list(selectedCompanyId!, "decided"), "operator"] as const,
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "decided", limit: OPERATOR_DECIDED_PREVIEW_LIMIT }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });
  const decidedPreview = decidedPreviewQuery.data;

  // Merge/blocker/child evidence for the loaded tasks, via the shared
  // issue-overview read contract (DATA scope). A chunk failure still renders:
  // the hook keeps what loaded and reports the gap as an error.
  const overviewIssueIds = useMemo(() => {
    const ids: string[] = [];
    for (const issue of operatorIssues ?? []) {
      if (
        issue.status === "done" ||
        issue.status === "blocked" ||
        issue.status === "in_review" ||
        issue.status === "ready_to_merge" ||
        issue.status === "merging" ||
        issue.status === "in_progress" ||
        issue.status === "todo"
      ) {
        ids.push(issue.id);
      }
    }
    return ids;
  }, [operatorIssues]);
  const {
    byId: overviewsById,
    isPending: overviewsPending,
    error: overviewsError,
  } = useIssueOverviews(selectedCompanyId, overviewIssueIds);

  // Record the visit only once per company/user and only after operator data
  // has actually rendered — never before a failed view, never twice for one
  // mount (StrictMode), so the next since-visit window stays truthful.
  const operatorDataOk =
    operatorIssues !== undefined && !operatorIssuesQuery.error && !decisionPreviewQuery.error;
  useEffect(() => {
    if (!selectedCompanyId || !operatorDataOk) return;
    const key = `${selectedCompanyId}:${currentUserId ?? "signed-out"}`;
    if (visitRecordedKeyRef.current === key) return;
    visitRecordedKeyRef.current = key;
    recordOperatorVisit(selectedCompanyId, currentUserId);
  }, [selectedCompanyId, currentUserId, operatorDataOk]);

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const agentNameById = useMemo(() => buildAgentNameMap(agents), [agents]);
  const userLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, profile] of userProfileMap) map.set(id, profile.label);
    return map;
  }, [userProfileMap]);
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) map.set(project.id, project.name);
    return map;
  }, [projects]);

  const windowResolution = useMemo(
    () => resolveOperatorWindow(windowId, lastVisit),
    [windowId, lastVisit],
  );
  const inventoryNote = useMemo(
    () => describeOperatorInventory(operatorIssues?.length ?? 0, OPERATOR_ISSUE_LOAD_LIMIT),
    [operatorIssues],
  );

  const deliveredOutcomes = useMemo(
    () =>
      deriveDeliveredOutcomes(
        operatorIssues ?? [],
        overviewsById,
        windowResolution.sinceMs,
        projectNameById,
      ),
    [operatorIssues, overviewsById, windowResolution, projectNameById],
  );
  const stuckTasks = useMemo(
    () =>
      deriveStuckTasks(operatorIssues ?? [], overviewsById, {
        agentNameById,
        userLabelById,
        projectNameById,
      }),
    [operatorIssues, overviewsById, agentNameById, userLabelById, projectNameById],
  );
  const nextCandidates = useMemo(
    () => deriveNextCandidates(operatorIssues ?? [], overviewsById, projectNameById),
    [operatorIssues, overviewsById, projectNameById],
  );
  // Rollups count independent product deliveries only: root outcomes, never
  // subtasks or system tasks.
  const deliveredRootIds = useMemo(
    () =>
      new Set(
        deliveredOutcomes
          .filter((outcome) => !outcome.isChild && !outcome.isSystemTask)
          .map((outcome) => outcome.issueId),
      ),
    [deliveredOutcomes],
  );
  const projectRollups = useMemo(
    () => deriveProjectRollups(operatorIssues ?? [], deliveredRootIds, projects ?? [], overviewsById),
    [operatorIssues, deliveredRootIds, projects, overviewsById],
  );

  // The preview shows the viewer's own gates only, resolved by actual
  // audience/ownership — never every attention row under a personal label.
  const previewMineItems = useMemo(
    () => (decisionPreviewScan?.items ?? []).slice(0, OPERATOR_DECISION_PREVIEW_LIMIT),
    [decisionPreviewScan],
  );
  const decisionPreviewCoverage = useMemo(
    () => (decisionPreviewScan ? describeDecisionPreviewCoverage(decisionPreviewScan) : null),
    [decisionPreviewScan],
  );

  const decidedByLabel = useMemo(() => {
    return (userId: string | null): string | null => {
      if (!userId) return null;
      if (userId === currentUserId) return "you";
      return userLabelById.get(userId) ?? null;
    };
  }, [userLabelById, currentUserId]);

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

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
          message="Welcome to Paperclip. Set up your first organization and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select an organization to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const pausedBanner = derivePausedAgentBanner(agents);
  const pausedImportedCount =
    pausedBanner?.kind === "imported" ? pausedBanner.pausedImportedAgentIds.length : 0;
  const costCoverage = data ? deriveMonthCostCoverage(data.costs) : null;

  const updateWindowId = (next: OperatorTimeWindowId) => {
    setWindowId(next);
    saveOperatorTimeWindow(selectedCompanyId, currentUserId, next);
  };

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {pausedBanner?.kind === "imported" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title={`${pausedImportedCount} imported agent${pausedImportedCount === 1 ? " is" : "s are"} paused and will not run.`}
          actions={
            <Button
              size="sm"
              onClick={() => resumeImportedAgents.mutate()}
              disabled={resumeImportedAgents.isPending}
              data-testid="dashboard-resume-imported-agents"
            >
              {resumeImportedAgents.isPending ? "Resuming…" : "Resume all"}
            </Button>
          }
        >
          Agents from an organization import arrive paused as a safety default. Resume them so assigned tasks can start.
        </InlineBanner>
      ) : pausedBanner?.kind === "all-paused" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title="All agents in this organization are paused — nothing will run."
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/agents">Review agents</Link>
            </Button>
          }
        >
          Resume at least one agent to let assigned tasks start.
        </InlineBanner>
      ) : null}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 3, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <OperatorWindowPicker
        windowId={windowId}
        resolution={windowResolution}
        inventory={inventoryNote}
        onChange={updateWindowId}
      />

      {overviewsError && operatorIssues && (
        <p className="text-xs text-muted-foreground">
          Task evidence partially unavailable ({overviewsError.message}) — showing task records with
          whatever evidence loaded. Some outcomes may read “delivery evidence not recorded” until
          evidence loads.
        </p>
      )}

      {/* Operator sections stand on their own queries: a metrics failure must
          never blank them, and each one names its own loading/error state. */}
      {operatorIssuesQuery.isPending || overviewsPending ? (
        <p className="py-3 text-sm text-muted-foreground">Loading completed work and tasks…</p>
      ) : operatorIssuesQuery.error ? (
        <div className="flex flex-wrap items-center gap-2 py-3">
          <p className="text-sm text-destructive">Could not load tasks: {operatorIssuesQuery.error.message}</p>
          <Button type="button" variant="ghost" size="xs" onClick={() => operatorIssuesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <CompletedWorkSection outcomes={deliveredOutcomes} />

          {decisionPreviewQuery.isPending ? (
            <p className="py-3 text-sm text-muted-foreground">Loading decisions…</p>
          ) : decisionPreviewQuery.error ? (
            <div className="flex flex-wrap items-center gap-2 py-3">
              <p className="text-sm text-destructive">
                Could not load decisions: {decisionPreviewQuery.error.message}
              </p>
              <Button type="button" variant="ghost" size="xs" onClick={() => decisionPreviewQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <NeedsDecisionSection
              companyId={selectedCompanyId!}
              items={previewMineItems}
              totalOpenCount={decisionPreviewScan?.totalCount ?? previewMineItems.length}
              coverage={decisionPreviewCoverage}
              agentMap={agentMap}
              agents={agents}
              currentUserId={currentUserId}
            />
          )}

          {decidedPreviewQuery.isPending ? (
            <p className="py-3 text-sm text-muted-foreground">Loading recent decisions…</p>
          ) : decidedPreviewQuery.error ? (
            <div className="flex flex-wrap items-center gap-2 py-3">
              <p className="text-sm text-destructive">
                Could not load recent decisions: {decidedPreviewQuery.error.message}
              </p>
              <Button type="button" variant="ghost" size="xs" onClick={() => decidedPreviewQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <RecentlyDecidedSection decisions={decidedPreview ?? []} decidedByLabel={decidedByLabel} />
          )}

          <StuckTasksSection stuck={stuckTasks} />

          <NextCandidatesSection candidates={nextCandidates} />

          <ProjectRollupsSection rollups={projectRollups} />
        </div>
      )}

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-950 dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-900/70 dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          {costCoverage?.kind === "incomplete" && (
            <InlineBanner
              tone="warning"
              icon={DollarSign}
              title="Month spend is incomplete"
              actions={
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/costs">Review costs</Link>
                </Button>
              }
            >
              {costCoverage.unpricedCount} of{" "}
              {costCoverage.unpricedCount + costCoverage.reportedCount} cost events this month have
              no provider-reported price (subscription-included usage also counts here), so the{" "}
              {formatCents(data.costs.monthSpendCents)} subtotal covers priced events only.
            </InlineBanner>
          )}

          <OperatorCostStrip
            monthSpendLabel={
              costCoverage?.kind === "no-usage-reported" ? "—" : formatCents(data.costs.monthSpendCents)
            }
            budgetLabel={
              data.costs.monthBudgetCents > 0
                ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                : "Unlimited budget"
            }
            coverageNote={costCoverage ? monthCostCoverageNote(costCoverage) : null}
          />

          <EngineeringDisclosure
            companyId={selectedCompanyId!}
            summary={`${data.agents.running} running · ${data.tasks.inProgress} in progress · ${data.tasks.blocked} blocked`}
          >
            <ActiveAgentsPanel companyId={selectedCompanyId!} />

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
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
                value={
                  costCoverage?.kind === "no-usage-reported"
                    ? "—"
                    : formatCents(data.costs.monthSpendCents)
                }
                label="Month Spend"
                to="/costs"
                description={
                  <span className="block space-y-0.5">
                    <span className="block">
                      {data.costs.monthBudgetCents > 0
                        ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                        : "Unlimited budget"}
                    </span>
                    {costCoverage && (
                      <span className="block">{monthCostCoverageNote(costCoverage)}</span>
                    )}
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
            </div>

            <SmokeLabDashboardCard companyId={selectedCompanyId!} />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <ChartCard title="Run Activity" subtitle="Last 14 days">
                <RunActivityChart activity={data.runActivity} />
              </ChartCard>
              {/* PAP-411: "Tasks by Priority" chart hidden behind SHOW_TASK_PRIORITY_UI. */}
              {SHOW_TASK_PRIORITY_UI && (
                <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
                  <PriorityChart issues={issues ?? []} />
                </ChartCard>
              )}
              <ChartCard title="Tasks by Status" subtitle="Last 14 days">
                <IssueStatusChart issues={issues ?? []} />
              </ChartCard>
              <ChartCard title="Success Rate" subtitle="Last 14 days">
                <SuccessRateChart activity={data.runActivity} />
              </ChartCard>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Recent Activity */}
              {recentActivity.length > 0 && (
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Recent Activity
                  </h3>
                  <Card className="block py-0 divide-y divide-border overflow-hidden">
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
                  </Card>
                </div>
              )}

              {/* Recent Tasks */}
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Tasks
                </h3>
                {recentIssues.length === 0 ? (
                  <Card className="block p-4">
                    <p className="text-sm text-muted-foreground">No tasks yet.</p>
                  </Card>
                ) : (
                  <Card className="block py-0 divide-y divide-border overflow-hidden">
                    {recentIssues.slice(0, 10).map((issue) => (
                      <Link
                        key={issue.id}
                        to={`/issues/${issue.identifier ?? issue.id}`}
                        className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
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
                  </Card>
                )}
              </div>
            </div>
          </EngineeringDisclosure>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />
        </>
      )}
    </div>
  );
}
