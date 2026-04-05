/**
 * RaavaInbox — Raava-branded Inbox page (Figma Screens 18 & 19).
 *
 * Rendered when `isRaava` is true. Three tabs:
 *   - Review Requests: approval cards with blue left border, Approve/Reject buttons
 *   - Notifications: issue update items with unread blue dot indicators
 *   - Escalations: failed runs / error items with red left border
 *
 * Reuses existing API hooks (approvals, issues, heartbeats) and wraps them
 * in Raava-branded chrome.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState, createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { getLatestFailedRunsByAgent, getRecentTouchedIssues } from "../lib/inbox";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Inbox as InboxIcon,
  Bell,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";
import type { Approval, Issue, HeartbeatRun } from "@paperclipai/shared";
import { ACTIONABLE_APPROVAL_STATUSES } from "../lib/inbox";

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type RaavaInboxTab = "reviews" | "notifications" | "escalations";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ReviewRequestCard({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
}) {
  const canAct = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  return (
    <div className="raava-card bg-white dark:bg-card border-l-4 border-l-[#224ae8] px-5 py-4">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="mt-0.5">
          <Identity name={requesterName ?? "Agent"} size="sm" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground line-clamp-2">
            {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {requesterName ? `Requested by ${requesterName}` : "Requested"}
            {" \u00B7 "}
            {timeAgo(approval.createdAt)}
          </p>
        </div>
        {/* Buttons */}
        {canAct && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="gradient"
              size="sm"
              onClick={onApprove}
              disabled={isPending}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onReject}
              disabled={isPending}
            >
              Reject
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationItem({
  issue,
  isUnread,
  issueLinkState,
  onMarkRead,
}: {
  issue: Issue;
  isUnread: boolean;
  issueLinkState: unknown;
  onMarkRead: () => void;
}) {
  return (
    <Link
      to={createIssueDetailPath(issue.identifier ?? issue.id, issueLinkState)}
      state={issueLinkState}
      className={cn(
        "group flex items-center gap-3 border-b border-border px-4 py-3 text-sm no-underline text-inherit transition-colors hover:bg-accent/40 last:border-b-0",
        isUnread && "bg-[rgba(34,74,232,0.03)]",
      )}
    >
      {/* Unread dot */}
      <span className="flex h-4 w-4 items-center justify-center shrink-0">
        {isUnread ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMarkRead();
            }}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-blue-500/20 transition-colors"
            aria-label="Mark as read"
          >
            <span className="block h-2 w-2 rounded-full bg-[#224ae8]" />
          </button>
        ) : (
          <span className="h-2 w-2" />
        )}
      </span>

      <span className="flex-1 min-w-0">
        <span className={cn("truncate text-sm", isUnread ? "font-semibold text-foreground" : "font-medium text-foreground")}>
          <span className="font-mono text-xs text-muted-foreground mr-1.5">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {issue.title}
        </span>
        <span className="block text-xs text-muted-foreground mt-0.5">
          Updated {timeAgo(issue.updatedAt)}
          {issue.status && (
            <>
              {" \u00B7 "}
              <StatusBadge status={issue.status} />
            </>
          )}
        </span>
      </span>
    </Link>
  );
}

function EscalationItem({
  run,
  agentName,
  onRetry,
  isRetrying,
}: {
  run: HeartbeatRun;
  agentName: string | null;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const errorMsg =
    (run.error ?? "").split("\n").map((l) => l.trim()).find(Boolean)
    ?? (run.stderrExcerpt ?? "").split("\n").map((l) => l.trim()).find(Boolean)
    ?? "Run exited with an error.";

  return (
    <div className="raava-card bg-white dark:bg-card border-l-4 border-l-red-500 px-5 py-4">
      <div className="flex items-start gap-3">
        <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {agentName ? `${agentName} — ` : ""}Failed run
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {errorMsg}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{timeAgo(run.createdAt)}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={isRetrying}
          className="shrink-0"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
          {isRetrying ? "Retrying..." : "Retry"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RaavaInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<RaavaInboxTab>("reviews");
  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
        "inbox",
      ),
    [location.pathname, location.search, location.hash],
  );

  // --- Data queries ---

  const { data: agents, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(a.id, a.name);
    return map;
  }, [agents]);

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
    data: touchedIssuesRaw = [],
    isLoading: isTouchedIssuesLoading,
    error: touchedIssuesError,
  } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: heartbeatRuns, isLoading: isRunsLoading, error: runsError } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);

  const actionableApprovals = useMemo(
    () => (approvals ?? []).filter((a) => ACTIONABLE_APPROVAL_STATUSES.has(a.status)),
    [approvals],
  );

  const failedRuns = useMemo(
    () => getLatestFailedRunsByAgent(heartbeatRuns ?? []),
    [heartbeatRuns],
  );

  // --- Mutations ---

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      pushToast({ title: "Approval failed", body: err instanceof Error ? err.message : "Could not approve request.", tone: "error" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      pushToast({ title: "Rejection failed", body: err instanceof Error ? err.message : "Could not reject request.", tone: "error" });
    },
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({ title: "Mark read failed", body: err instanceof Error ? err.message : "Could not mark as read.", tone: "error" });
    },
  });

  const retryRunMutation = useMutation({
    mutationFn: async (run: HeartbeatRun) => {
      const payload: Record<string, unknown> = {};
      const context = run.contextSnapshot as Record<string, unknown> | null;
      if (context) {
        if (typeof context.issueId === "string" && context.issueId) payload.issueId = context.issueId;
      }
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error("Retry was skipped.");
      }
      return { newRun: result, originalRun: run };
    },
    onMutate: (run) => {
      setRetryingRunIds((prev) => new Set(prev).add(run.id));
    },
    onSuccess: ({ newRun, originalRun }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId) });
      navigate(`/agents/${originalRun.agentId}/runs/${newRun.id}`);
    },
    onError: (err) => {
      pushToast({ title: "Retry failed", body: err instanceof Error ? err.message : "Could not retry the run.", tone: "error" });
    },
    onSettled: (_data, _err, run) => {
      if (!run) return;
      setRetryingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company to view inbox." />;
  }

  const allLoaded = !isApprovalsLoading && !isTouchedIssuesLoading && !isRunsLoading;

  // Tab counts
  const reviewCount = actionableApprovals.length;
  const notificationCount = touchedIssues.length;
  const escalationCount = failedRuns.length;

  const tabs: { id: RaavaInboxTab; label: string; count: number }[] = [
    { id: "reviews", label: "Review Requests", count: reviewCount },
    { id: "notifications", label: "Notifications", count: notificationCount },
    { id: "escalations", label: "Escalations", count: escalationCount },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <h1 className="font-display text-[22px] text-foreground">Inbox</h1>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative inline-flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count > 0 && (
                <span
                  className={cn(
                    "inline-flex items-center justify-center rounded-full px-1.5 min-w-[18px] text-[11px] font-semibold",
                    isActive
                      ? "[background:linear-gradient(90deg,#224AE8,#716EFF,#00BDB7)] text-white"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {tab.count}
                </span>
              )}
              {/* Active underline */}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 [background:linear-gradient(90deg,#224AE8,#716EFF,#00BDB7)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {!allLoaded ? (
        <PageSkeleton variant="inbox" />
      ) : (
        <>
          {/* Review Requests */}
          {activeTab === "reviews" && (
            <div className="space-y-3">
              {approvalsError ? (
                <div className="text-center py-8">
                  <p className="text-sm text-destructive">{approvalsError instanceof Error ? approvalsError.message : "Failed to load review requests."}</p>
                </div>
              ) : actionableApprovals.length === 0 ? (
                <EmptyState icon={CheckCircle2} message="No pending review requests." />
              ) : (
                actionableApprovals.map((approval) => {
                  const requesterName = approval.requestedByAgentId
                    ? agentById.get(approval.requestedByAgentId) ?? null
                    : null;
                  return (
                    <ReviewRequestCard
                      key={approval.id}
                      approval={approval}
                      requesterName={requesterName}
                      onApprove={() => approveMutation.mutate(approval.id)}
                      onReject={() => rejectMutation.mutate(approval.id)}
                      isPending={approveMutation.isPending || rejectMutation.isPending}
                    />
                  );
                })
              )}
            </div>
          )}

          {/* Notifications */}
          {activeTab === "notifications" && (
            <div className="raava-card overflow-hidden bg-white dark:bg-card">
              {touchedIssuesError ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-destructive">{touchedIssuesError instanceof Error ? touchedIssuesError.message : "Failed to load notifications."}</p>
                </div>
              ) : touchedIssues.length === 0 ? (
                <div className="px-4 py-8">
                  <EmptyState icon={Bell} message="No notifications." />
                </div>
              ) : (
                touchedIssues.map((issue) => (
                  <NotificationItem
                    key={issue.id}
                    issue={issue}
                    isUnread={!!issue.isUnreadForMe}
                    issueLinkState={issueLinkState}
                    onMarkRead={() => markReadMutation.mutate(issue.id)}
                  />
                ))
              )}
            </div>
          )}

          {/* Escalations */}
          {activeTab === "escalations" && (
            <div className="space-y-3">
              {runsError ? (
                <div className="text-center py-8">
                  <p className="text-sm text-destructive">{runsError instanceof Error ? runsError.message : "Failed to load escalations."}</p>
                </div>
              ) : failedRuns.length === 0 ? (
                <EmptyState icon={AlertTriangle} message="No escalations." />
              ) : (
                failedRuns.map((run) => {
                  const agentName = agentById.get(run.agentId) ?? null;
                  return (
                    <EscalationItem
                      key={run.id}
                      run={run}
                      agentName={agentName}
                      onRetry={() => retryRunMutation.mutate(run)}
                      isRetrying={retryingRunIds.has(run.id)}
                    />
                  );
                })
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
