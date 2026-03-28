import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ApprovalCard } from "../components/ApprovalCard";
import { StatusBadge } from "../components/StatusBadge";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  ArrowUpRight,
  XCircle,
  X,
  RotateCcw,
} from "lucide-react";
import { Identity } from "../components/Identity";
import { PageTabBar } from "../components/PageTabBar";
import type { HeartbeatRun, InboxFeedItem, Issue, JoinRequest } from "@paperclipai/shared";
import { inboxFeedApi } from "../api/inbox-feed";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  type InboxTab,
  saveLastInboxTab,
} from "../lib/inbox";
import { useDismissedInboxItems } from "../hooks/useInboxBadge";

type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
type InboxApprovalFilter = "all" | "actionable" | "resolved";
type SectionKey =
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";

const RUN_SOURCE_LABELS: Record<string, string> = {
  timer: "Scheduled",
  assignment: "Assignment",
  on_demand: "Manual",
  automation: "Automation",
};

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean);
  return line ?? null;
}

function runFailureMessage(run: HeartbeatRun): string {
  return firstNonEmptyLine(run.error) ?? firstNonEmptyLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

function readIssueIdFromRun(run: HeartbeatRun): string | null {
  const context = run.contextSnapshot;
  if (!context) return null;

  const issueId = context["issueId"];
  if (typeof issueId === "string" && issueId.length > 0) return issueId;

  const taskId = context["taskId"];
  if (typeof taskId === "string" && taskId.length > 0) return taskId;

  return null;
}

function FailedRunCard({
  run,
  issueById,
  agentName: linkedAgentName,
  issueLinkState,
  onDismiss,
}: {
  run: HeartbeatRun;
  issueById: Map<string, Issue>;
  agentName: string | null;
  issueLinkState: unknown;
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const issueId = readIssueIdFromRun(run);
  const issue = issueId ? issueById.get(issueId) ?? null : null;
  const sourceLabel = RUN_SOURCE_LABELS[run.invocationSource] ?? "Manual";
  const displayError = runFailureMessage(run);

  const retryRun = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      const context = run.contextSnapshot as Record<string, unknown> | null;
      if (context) {
        if (typeof context.issueId === "string" && context.issueId) payload.issueId = context.issueId;
        if (typeof context.taskId === "string" && context.taskId) payload.taskId = context.taskId;
        if (typeof context.taskKey === "string" && context.taskKey) payload.taskKey = context.taskKey;
      }
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${run.agentId}/runs/${newRun.id}`);
    },
  });

  return (
    <div className="group relative overflow-hidden rounded-xl border border-red-500/30 bg-gradient-to-br from-red-500/10 via-card to-card p-4">
      <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-red-500/10 blur-2xl" />
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-2 top-2 z-10 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="relative space-y-3">
        {issue ? (
          <Link
            to={`/issues/${issue.identifier ?? issue.id}`}
            state={issueLinkState}
            className="block truncate text-sm font-medium transition-colors hover:text-foreground no-underline text-inherit"
          >
            <span className="font-mono text-muted-foreground mr-1.5">
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
            {issue.title}
          </Link>
        ) : (
          <span className="block text-sm text-muted-foreground">
            {run.errorCode ? `Error code: ${run.errorCode}` : "No linked issue"}
          </span>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-red-500/20 p-1.5">
                <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              </span>
              {linkedAgentName ? (
                <Identity name={linkedAgentName} size="sm" />
              ) : (
                <span className="text-sm font-medium">Agent {run.agentId.slice(0, 8)}</span>
              )}
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {sourceLabel} run failed {timeAgo(run.createdAt)}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2.5"
              onClick={() => retryRun.mutate()}
              disabled={retryRun.isPending}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {retryRun.isPending ? "Retrying…" : "Retry"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2.5"
              asChild
            >
              <Link to={`/agents/${run.agentId}/runs/${run.id}`}>
                Open run
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm">
          {displayError}
        </div>

        <div className="text-xs">
          <span className="font-mono text-muted-foreground">run {run.id.slice(0, 8)}</span>
        </div>

        {retryRun.isError && (
          <div className="text-xs text-destructive">
            {retryRun.error instanceof Error ? retryRun.error.message : "Failed to retry run"}
          </div>
        )}
      </div>
    </div>
  );
}

export function Inbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [allCategoryFilter, setAllCategoryFilter] = useState<InboxCategoryFilter>("everything");
  const [allApprovalFilter, setAllApprovalFilter] = useState<InboxApprovalFilter>("all");
  const { dismissed, dismiss } = useDismissedInboxItems(selectedCompanyId);
  const [optimisticallyDismissedRunIds, setOptimisticallyDismissedRunIds] = useState<Set<string>>(new Set());

  const pathSegment = location.pathname.split("/").pop() ?? "recent";
  const tab: InboxTab =
    pathSegment === "all" || pathSegment === "unread" ? pathSegment : "recent";
  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveLastInboxTab(tab);
  }, [tab]);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: joinRequests = [],
    isLoading: isJoinRequestsLoading,
  } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(selectedCompanyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues, isLoading: isIssuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const {
    data: touchedIssuesRaw = [],
    isLoading: isTouchedIssuesLoading,
  } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: "backlog,todo,in_progress,in_review,blocked,done",
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: heartbeatRunsResult, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const heartbeatRuns = heartbeatRunsResult?.runs;

  const {
    data: feedItems = [],
    isLoading: isFeedLoading,
  } = useQuery({
    queryKey: queryKeys.inboxFeed(selectedCompanyId!),
    queryFn: () => inboxFeedApi.feed(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadTouchedIssues = useMemo(
    () => touchedIssues.filter((issue) => issue.isUnreadForMe),
    [touchedIssues],
  );
  const unreadFeedItems = useMemo(
    () => feedItems.filter((item) => item.unreadCount > 0),
    [feedItems],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const failedRuns = useMemo(
    () =>
      getLatestFailedRunsByAgent(heartbeatRuns ?? []).filter(
        (r) => !dismissed.has(`run:${r.id}`) && !optimisticallyDismissedRunIds.has(r.id),
      ),
    [heartbeatRuns, dismissed, optimisticallyDismissedRunIds],
  );

  const allApprovals = useMemo(
    () =>
      [...(approvals ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [approvals],
  );

  const actionableApprovals = useMemo(
    () => allApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status)),
    [allApprovals],
  );

  const filteredAllApprovals = useMemo(() => {
    if (allApprovalFilter === "all") return allApprovals;

    return allApprovals.filter((approval) => {
      const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
      return allApprovalFilter === "actionable" ? isActionable : !isActionable;
    });
  }, [allApprovals, allApprovalFilter]);

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve join request");
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject join request");
    },
  });

  const [fadingOutIssues, setFadingOutIssues] = useState<Set<string>>(new Set());

  const invalidateInboxIssueQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.inboxFeed(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onMutate: (id) => {
      setFadingOutIssues((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (issueIds: string[]) => {
      await Promise.all(issueIds.map((issueId) => issuesApi.markRead(issueId)));
    },
    onMutate: (issueIds) => {
      setFadingOutIssues((prev) => {
        const next = new Set(prev);
        for (const issueId of issueIds) next.add(issueId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, issueIds) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          for (const issueId of issueIds) next.delete(issueId);
          return next;
        });
      }, 300);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company to view inbox." />;
  }

  const hasRunFailures = failedRuns.length > 0;
  const showAggregateAgentError = !!dashboard && dashboard.agents.error > 0 && !hasRunFailures && !dismissed.has("alert:agent-errors");
  const showBudgetAlert =
    !!dashboard &&
    dashboard.costs.monthBudgetCents > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissed.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const hasJoinRequests = joinRequests.length > 0;
  const hasTouchedIssues = feedItems.length > 0;

  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "issues_i_touched";
  const showApprovalsCategory = allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";

  const approvalsToRender = tab === "all" ? filteredAllApprovals : actionableApprovals;
  const showTouchedSection =
    tab === "all"
      ? showTouchedCategory && hasTouchedIssues
      : tab === "unread"
        ? unreadFeedItems.length > 0
        : hasTouchedIssues;
  const showJoinRequestsSection =
    tab === "all" ? showJoinRequestsCategory && hasJoinRequests : tab === "unread" && hasJoinRequests;
  const showApprovalsSection = tab === "all"
    ? showApprovalsCategory && filteredAllApprovals.length > 0
    : actionableApprovals.length > 0;
  const showFailedRunsSection =
    tab === "all" ? showFailedRunsCategory && hasRunFailures : tab === "unread" && hasRunFailures;
  const showAlertsSection = tab === "all" ? showAlertsCategory && hasAlerts : tab === "unread" && hasAlerts;

  const visibleSections = [
    showFailedRunsSection ? "failed_runs" : null,
    showAlertsSection ? "alerts" : null,
    showApprovalsSection ? "approvals" : null,
    showJoinRequestsSection ? "join_requests" : null,
    showTouchedSection ? "issues_i_touched" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isIssuesLoading &&
    !isTouchedIssuesLoading &&
    !isFeedLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const unreadIssueIds = unreadTouchedIssues
    .filter((issue) => !fadingOutIssues.has(issue.id))
    .map((issue) => issue.id);
  const canMarkAllRead = unreadIssueIds.length > 0;

  return (
    <div className="space-y-6 animate-page-enter">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
          <PageTabBar
            items={[
              {
                value: "recent",
                label: "Recent",
              },
              { value: "unread", label: "Unread" },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          {canMarkAllRead && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => markAllReadMutation.mutate(unreadIssueIds)}
              disabled={markAllReadMutation.isPending}
            >
              {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
            </Button>
          )}

          {tab === "all" && (
            <>
            <Select
              value={allCategoryFilter}
              onValueChange={(value) => setAllCategoryFilter(value as InboxCategoryFilter)}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everything">All categories</SelectItem>
                <SelectItem value="issues_i_touched">My recent issues</SelectItem>
                <SelectItem value="join_requests">Join requests</SelectItem>
                <SelectItem value="approvals">Approvals</SelectItem>
                <SelectItem value="failed_runs">Failed runs</SelectItem>
                <SelectItem value="alerts">Alerts</SelectItem>
              </SelectContent>
            </Select>

            {showApprovalsCategory && (
              <Select
                value={allApprovalFilter}
                onValueChange={(value) => setAllApprovalFilter(value as InboxApprovalFilter)}
              >
                <SelectTrigger className="h-8 w-[170px] text-xs">
                  <SelectValue placeholder="Approval status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All approval statuses</SelectItem>
                  <SelectItem value="actionable">Needs action</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
            )}
            </>
          )}
        </div>
      </div>

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          message={
            tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showApprovalsSection && (
        <>
          {showSeparatorBefore("approvals") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {tab === "unread" ? "Approvals Needing Action" : "Approvals"}
            </h3>
            <div className="grid gap-3">
              {approvalsToRender.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  requesterAgent={
                    approval.requestedByAgentId
                      ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null
                      : null
                  }
                  onApprove={() => approveMutation.mutate(approval.id)}
                  onReject={() => rejectMutation.mutate(approval.id)}
                  detailLink={`/approvals/${approval.id}`}
                  isPending={approveMutation.isPending || rejectMutation.isPending}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {showJoinRequestsSection && (
        <>
          {showSeparatorBefore("join_requests") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Join Requests
            </h3>
            <div className="grid gap-3">
              {joinRequests.map((joinRequest) => (
                <div key={joinRequest.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {joinRequest.requestType === "human"
                          ? "Human join request"
                          : `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}
                      </p>
                      {joinRequest.requestEmailSnapshot && (
                        <p className="text-xs text-muted-foreground">
                          email: {joinRequest.requestEmailSnapshot}
                        </p>
                      )}
                      {joinRequest.adapterType && (
                        <p className="text-xs text-muted-foreground">adapter: {joinRequest.adapterType}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => rejectJoinMutation.mutate(joinRequest)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => approveJoinMutation.mutate(joinRequest)}
                      >
                        Approve
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {showFailedRunsSection && (
        <>
          {showSeparatorBefore("failed_runs") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Failed Runs
            </h3>
            <div className="grid gap-3">
              {failedRuns.map((run) => (
                <FailedRunCard
                  key={run.id}
                  run={run}
                  issueById={issueById}
                  agentName={agentName(run.agentId)}
                  issueLinkState={issueLinkState}
                  onDismiss={() => {
                    setOptimisticallyDismissedRunIds((prev) => new Set(prev).add(run.id));
                    dismiss(`run:${run.id}`);
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts
            </h3>
            <div className="divide-y divide-border border border-border">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/agents"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium">{dashboard!.agents.error}</span>{" "}
                      {dashboard!.agents.error === 1 ? "agent has" : "agents have"} errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/costs"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium">{dashboard!.costs.monthUtilizationPercent}%</span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showTouchedSection && (
        <>
          {showSeparatorBefore("issues_i_touched") && <Separator />}
          <div>
            <div className="divide-y divide-border border border-border">
              {(tab === "unread" ? unreadFeedItems : feedItems).map((item) => {
                const issue = item.issue;
                const isUnread = (issue.isUnreadForMe || item.unreadCount > 0) && !fadingOutIssues.has(issue.id);
                const isFading = fadingOutIssues.has(issue.id);
                const activity = item.latestActivity;
                return (
                  <Link
                    key={issue.id}
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    state={issueLinkState}
                    className="flex min-w-0 cursor-pointer items-start gap-2 px-3 py-2.5 no-underline text-inherit transition-colors hover:bg-accent/50 sm:gap-3 sm:px-4"
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center mt-1">
                      {(isUnread || isFading) ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            markReadMutation.mutate(issue.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              markReadMutation.mutate(issue.id);
                            }
                          }}
                          className="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-blue-500/20"
                          aria-label="Mark as read"
                        >
                          <span
                            className={`block h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400 transition-opacity duration-300 ${
                              isFading ? "opacity-0" : "opacity-100"
                            }`}
                          />
                        </span>
                      ) : (
                        <span className="inline-flex h-4 w-4" aria-hidden="true" />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex shrink-0"><PriorityIcon priority={issue.priority} /></span>
                        <span className="inline-flex shrink-0"><StatusIcon status={issue.status} /></span>
                        <span className="shrink-0 text-xs font-mono text-muted-foreground">
                          {issue.identifier ?? issue.id.slice(0, 8)}
                        </span>
                        <span className="min-w-0 flex-1 text-sm truncate">
                          {issue.title}
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                          {activity
                            ? timeAgo(activity.timestamp)
                            : issue.lastExternalCommentAt
                              ? timeAgo(issue.lastExternalCommentAt)
                              : timeAgo(issue.updatedAt)}
                        </span>
                      </div>
                      {activity && (
                        <div className="mt-1 flex items-baseline gap-1.5 text-xs text-muted-foreground pl-[calc(1rem+0.5rem+1rem+0.5rem)]">
                          <span className="shrink-0 font-medium text-foreground/70">
                            {activity.actorName ?? activity.actorId}
                          </span>
                          {activity.action === "comment.created" ? (
                            <span className="min-w-0 truncate italic">
                              &ldquo;{activity.summary}&rdquo;
                            </span>
                          ) : (
                            <span className="min-w-0 truncate">
                              {activity.summary}
                            </span>
                          )}
                          {item.unreadCount > 1 && (
                            <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                              {item.unreadCount} new
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
