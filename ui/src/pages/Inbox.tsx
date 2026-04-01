import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
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
import { createIssueDetailLocationState, createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { IssueRow } from "../components/IssueRow";
import { SwipeToArchive } from "../components/SwipeToArchive";

import { StatusIcon } from "../components/StatusIcon";
import { cn } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { approvalLabel, defaultTypeIcon, typeIcon } from "../components/ApprovalPayload";
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
  XCircle,
  X,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import { PageTabBar } from "../components/PageTabBar";
import type { Approval, HeartbeatRun, Issue, JoinRequest } from "@paperclipai/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getApprovalsForTab,
  getInboxWorkItems,
  getInboxKeyboardSelectionIndex,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  isMineInboxTab,
  resolveInboxSelectionIndex,
  InboxApprovalFilter,
  saveLastInboxTab,
  shouldShowInboxSection,
  type InboxTab,
  type InboxWorkItem,
} from "../lib/inbox";
import { useDismissedInboxItems, useReadInboxItems } from "../hooks/useInboxBadge";

type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
type SectionKey =
  | "work_items"
  | "alerts";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean);
  return line ?? null;
}

function runFailureMessage(run: HeartbeatRun): string {
  return firstNonEmptyLine(run.error) ?? firstNonEmptyLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

function approvalStatusLabel(status: Approval["status"]): string {
  return status.replaceAll("_", " ");
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


type NonIssueUnreadState = "visible" | "fading" | "hidden" | null;
const selectedInboxAccentClass = "!text-muted-foreground !border-muted-foreground";

function getSelectedUnreadButtonClass(selected: boolean): string {
  return selected ? "hover:bg-muted/80" : "hover:bg-blue-500/20";
}

function getSelectedUnreadDotClass(selected: boolean): string {
  return selected ? "bg-muted-foreground/70" : "bg-blue-600 dark:bg-blue-400";
}

export function InboxIssueMetaLeading({
  issue,
  selected,
  isLive,
}: {
  issue: Issue;
  selected: boolean;
  isLive: boolean;
}) {
  return (
    <>
      <span className="hidden shrink-0 sm:inline-flex">
        <StatusIcon
          status={issue.status}
          className={selected ? selectedInboxAccentClass : undefined}
        />
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {issue.identifier ?? issue.id.slice(0, 8)}
      </span>
      {isLive && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
            selected ? "bg-muted" : "bg-blue-500/10",
          )}
        >
          <span className="relative flex h-2 w-2">
            {!selected ? (
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
            ) : null}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                selected ? "bg-muted-foreground/70" : "bg-blue-500",
              )}
            />
          </span>
          <span
            className={cn(
              "hidden text-[11px] font-medium sm:inline",
              selected ? "text-muted-foreground" : "text-blue-600 dark:text-blue-400",
            )}
          >
            Live
          </span>
        </span>
      )}
    </>
  );
}

export function FailedRunInboxRow({
  run,
  issueById,
  agentName: linkedAgentName,
  issueLinkState,
  onDismiss,
  onRetry,
  isRetrying,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  run: HeartbeatRun;
  issueById: Map<string, Issue>;
  agentName: string | null;
  issueLinkState: unknown;
  onDismiss: () => void;
  onRetry: () => void;
  isRetrying: boolean;
  unreadState?: NonIssueUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const issueId = readIssueIdFromRun(run);
  const issue = issueId ? issueById.get(issueId) ?? null : null;
  const displayError = runFailureMessage(run);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  getSelectedUnreadButtonClass(selected),
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  getSelectedUnreadDotClass(selected),
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
            selected ? "hover:bg-transparent" : "hover:bg-accent/50",
          )}
        >
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-red-500/20 p-1.5 sm:mt-0">
            <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {issue ? (
                <>
                  <span className="font-mono text-muted-foreground mr-1.5">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  {issue.title}
                </>
              ) : (
                <>Failed run{linkedAgentName ? ` — ${linkedAgentName}` : ""}</>
              )}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusBadge status={run.status} />
              {linkedAgentName && issue ? <span>{linkedAgentName}</span> : null}
              <span className="truncate max-w-[300px]">{displayError}</span>
              <span>{timeAgo(run.createdAt)}</span>
            </span>
          </span>
        </Link>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2.5"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {isRetrying ? "Retrying…" : "Retry"}
          </Button>
          {!showUnreadSlot && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          onClick={onRetry}
          disabled={isRetrying}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
        {!showUnreadSlot && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalInboxRow({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonIssueUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  getSelectedUnreadButtonClass(selected),
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  getSelectedUnreadDotClass(selected),
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <Link
          to={`/approvals/${approval.id}`}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
            selected ? "hover:bg-transparent" : "hover:bg-accent/50",
          )}
        >
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="capitalize">{approvalStatusLabel(approval.status)}</span>
              {requesterName ? <span>requested by {requesterName}</span> : null}
              <span>updated {timeAgo(approval.updatedAt)}</span>
            </span>
          </span>
        </Link>
        {showResolutionButtons ? (
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <Button
              size="sm"
              className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
              onClick={onApprove}
              disabled={isPending}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-3"
              onClick={onReject}
              disabled={isPending}
            >
              Reject
            </Button>
          </div>
        ) : null}
      </div>
      {showResolutionButtons ? (
        <div className="mt-3 flex gap-2 sm:hidden">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JoinRequestInboxRow({
  joinRequest,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  joinRequest: JoinRequest;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonIssueUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const label =
    joinRequest.requestType === "human"
      ? "Human join request"
      : `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`;
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  getSelectedUnreadButtonClass(selected),
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  getSelectedUnreadDotClass(selected),
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}</span>
              {joinRequest.adapterType && <span>adapter: {joinRequest.adapterType}</span>}
            </span>
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        <Button
          size="sm"
          className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
          onClick={onApprove}
          disabled={isPending}
        >
          Approve
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-8 px-3"
          onClick={onReject}
          disabled={isPending}
        >
          Reject
        </Button>
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
  const { dismissed, dismiss } = useDismissedInboxItems();
  const { readItems, markRead: markItemRead, markUnread: markItemUnread } = useReadInboxItems();

  const pathSegment = location.pathname.split("/").pop() ?? "mine";
  const tab: InboxTab =
    pathSegment === "mine" || pathSegment === "recent" || pathSegment === "all" || pathSegment === "unread"
      ? pathSegment
      : "mine";
  const canArchiveFromTab = isMineInboxTab(tab);
  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
        "inbox",
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
    setSelectedIndex(-1);
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
    data: mineIssuesRaw = [],
    isLoading: isMineIssuesLoading,
  } = useQuery({
    queryKey: queryKeys.issues.listMineByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
      }),
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
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: heartbeatRuns, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const mineIssues = useMemo(() => getRecentTouchedIssues(mineIssuesRaw), [mineIssuesRaw]);
  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadTouchedIssues = useMemo(
    () => touchedIssues.filter((issue) => issue.isUnreadForMe),
    [touchedIssues],
  );
  const issuesToRender = useMemo(
    () => {
      if (tab === "mine") return mineIssues;
      if (tab === "unread") return unreadTouchedIssues;
      return touchedIssues;
    },
    [tab, mineIssues, touchedIssues, unreadTouchedIssues],
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
    () => getLatestFailedRunsByAgent(heartbeatRuns ?? []).filter((r) => !dismissed.has(`run:${r.id}`)),
    [heartbeatRuns, dismissed],
  );
  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of heartbeatRuns ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const issueId = readIssueIdFromRun(run);
      if (issueId) ids.add(issueId);
    }
    return ids;
  }, [heartbeatRuns]);

  const approvalsToRender = useMemo(() => {
    let filtered = getApprovalsForTab(approvals ?? [], tab, allApprovalFilter);
    if (tab === "mine") {
      filtered = filtered.filter((a) => !dismissed.has(`approval:${a.id}`));
    }
    return filtered;
  }, [approvals, tab, allApprovalFilter, dismissed]);
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "issues_i_touched";
  const showApprovalsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(() => {
    if (tab === "all" && !showFailedRunsCategory) return [];
    return failedRuns;
  }, [failedRuns, tab, showFailedRunsCategory]);

  const joinRequestsForTab = useMemo(() => {
    if (tab === "all" && !showJoinRequestsCategory) return [];
    if (tab === "mine") return joinRequests.filter((jr) => !dismissed.has(`join:${jr.id}`));
    return joinRequests;
  }, [joinRequests, tab, showJoinRequestsCategory, dismissed]);

  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        issues: tab === "all" && !showTouchedCategory ? [] : issuesToRender,
        approvals: tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
        joinRequests: joinRequestsForTab,
      }),
    [approvalsToRender, issuesToRender, showApprovalsCategory, showTouchedCategory, tab, failedRunsForTab, joinRequestsForTab],
  );

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

  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(new Set());

  const retryRunMutation = useMutation({
    mutationFn: async (run: HeartbeatRun) => {
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
      return { newRun: result, originalRun: run };
    },
    onMutate: (run) => {
      setRetryingRunIds((prev) => new Set(prev).add(run.id));
    },
    onSuccess: ({ newRun, originalRun }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId, originalRun.agentId) });
      navigate(`/agents/${originalRun.agentId}/runs/${newRun.id}`);
    },
    onSettled: (_data, _error, run) => {
      if (!run) return;
      setRetryingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    },
  });

  const [fadingOutIssues, setFadingOutIssues] = useState<Set<string>>(new Set());
  const [archivingIssueIds, setArchivingIssueIds] = useState<Set<string>>(new Set());
  const [fadingNonIssueItems, setFadingNonIssueItems] = useState<Set<string>>(new Set());
  const [archivingNonIssueIds, setArchivingNonIssueIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const invalidateInboxIssueQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  };

  const archiveIssueMutation = useMutation({
    mutationFn: (id: string) => issuesApi.archiveFromInbox(id),
    onMutate: (id) => {
      setActionError(null);
      setArchivingIssueIds((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onError: (err, id) => {
      setActionError(err instanceof Error ? err.message : "Failed to archive issue");
      setArchivingIssueIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    onSettled: (_data, error, id) => {
      if (error) return;
      window.setTimeout(() => {
        setArchivingIssueIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 500);
    },
  });

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

  const markUnreadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markUnread(id),
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
  });

  const handleMarkNonIssueRead = useCallback((key: string) => {
    setFadingNonIssueItems((prev) => new Set(prev).add(key));
    markItemRead(key);
    setTimeout(() => {
      setFadingNonIssueItems((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 300);
  }, [markItemRead]);

  const handleArchiveNonIssue = useCallback((key: string) => {
    setArchivingNonIssueIds((prev) => new Set(prev).add(key));
    setTimeout(() => {
      dismiss(key);
      setArchivingNonIssueIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 200);
  }, [dismiss]);

  const nonIssueUnreadState = (key: string): NonIssueUnreadState => {
    if (!canArchiveFromTab) return null;
    const isRead = readItems.has(key);
    const isFading = fadingNonIssueItems.has(key);
    if (isFading) return "fading";
    if (!isRead) return "visible";
    return "hidden";
  };

  const getWorkItemKey = useCallback((item: InboxWorkItem): string => {
    if (item.kind === "issue") return `issue:${item.issue.id}`;
    if (item.kind === "approval") return `approval:${item.approval.id}`;
    if (item.kind === "failed_run") return `run:${item.run.id}`;
    return `join:${item.joinRequest.id}`;
  }, []);

  // Keep selection valid when the list shape changes, but do not auto-select on initial load.
  useEffect(() => {
    setSelectedIndex((prev) => resolveInboxSelectionIndex(prev, workItemsToRender.length));
  }, [workItemsToRender.length]);

  // Use refs for keyboard handler to avoid stale closures
  const kbStateRef = useRef({
    workItems: workItemsToRender,
    selectedIndex,
    canArchive: canArchiveFromTab,
    archivingIssueIds,
    archivingNonIssueIds,
    fadingOutIssues,
    readItems,
  });
  kbStateRef.current = {
    workItems: workItemsToRender,
    selectedIndex,
    canArchive: canArchiveFromTab,
    archivingIssueIds,
    archivingNonIssueIds,
    fadingOutIssues,
    readItems,
  };

  const kbActionsRef = useRef({
    archiveIssue: (id: string) => archiveIssueMutation.mutate(id),
    archiveNonIssue: handleArchiveNonIssue,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadIssue: (id: string) => markUnreadMutation.mutate(id),
    markNonIssueRead: handleMarkNonIssueRead,
    markNonIssueUnread: markItemUnread,
    navigate,
  });
  kbActionsRef.current = {
    archiveIssue: (id: string) => archiveIssueMutation.mutate(id),
    archiveNonIssue: handleArchiveNonIssue,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadIssue: (id: string) => markUnreadMutation.mutate(id),
    markNonIssueRead: handleMarkNonIssueRead,
    markNonIssueUnread: markItemUnread,
    navigate,
  };

  // Keyboard shortcuts (mail-client style) — single stable listener using refs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Don't capture when typing in inputs/textareas or with modifier keys
      const target = e.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']") ||
        target.isContentEditable ||
        document.querySelector("[role='dialog'], [aria-modal='true']") ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }

      const st = kbStateRef.current;
      const act = kbActionsRef.current;

      // Keyboard shortcuts are only active on the "mine" tab
      if (!st.canArchive) return;

      const itemCount = st.workItems.length;
      if (itemCount === 0) return;

      switch (e.key) {
        case "j": {
          e.preventDefault();
          setSelectedIndex((prev) => getInboxKeyboardSelectionIndex(prev, itemCount, "next"));
          break;
        }
        case "k": {
          e.preventDefault();
          setSelectedIndex((prev) => getInboxKeyboardSelectionIndex(prev, itemCount, "previous"));
          break;
        }
        case "a":
        case "y": {
          if (st.selectedIndex < 0 || st.selectedIndex >= itemCount) return;
          e.preventDefault();
          const item = st.workItems[st.selectedIndex];
          if (item.kind === "issue") {
            if (!st.archivingIssueIds.has(item.issue.id)) {
              act.archiveIssue(item.issue.id);
            }
          } else {
            const key = getWorkItemKey(item);
            if (!st.archivingNonIssueIds.has(key)) {
              act.archiveNonIssue(key);
            }
          }
          break;
        }
        case "U": {
          if (st.selectedIndex < 0 || st.selectedIndex >= itemCount) return;
          e.preventDefault();
          const item = st.workItems[st.selectedIndex];
          if (item.kind === "issue") {
            act.markUnreadIssue(item.issue.id);
          } else {
            act.markNonIssueUnread(getWorkItemKey(item));
          }
          break;
        }
        case "r": {
          if (st.selectedIndex < 0 || st.selectedIndex >= itemCount) return;
          e.preventDefault();
          const item = st.workItems[st.selectedIndex];
          if (item.kind === "issue") {
            if (item.issue.isUnreadForMe && !st.fadingOutIssues.has(item.issue.id)) {
              act.markRead(item.issue.id);
            }
          } else {
            const key = getWorkItemKey(item);
            if (!st.readItems.has(key)) {
              act.markNonIssueRead(key);
            }
          }
          break;
        }
        case "Enter": {
          if (st.selectedIndex < 0 || st.selectedIndex >= itemCount) return;
          e.preventDefault();
          const item = st.workItems[st.selectedIndex];
          if (item.kind === "issue") {
            const pathId = item.issue.identifier ?? item.issue.id;
            act.navigate(createIssueDetailPath(pathId, issueLinkState), { state: issueLinkState });
          } else if (item.kind === "approval") {
            act.navigate(`/approvals/${item.approval.id}`);
          } else if (item.kind === "failed_run") {
            act.navigate(`/agents/${item.run.agentId}/runs/${item.run.id}`);
          }
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [getWorkItemKey, issueLinkState]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const rows = listRef.current.querySelectorAll("[data-inbox-item]");
    const row = rows[selectedIndex];
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

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
  const showWorkItemsSection = workItemsToRender.length > 0;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnMine: hasAlerts,
    showOnRecent: hasAlerts,
    showOnUnread: hasAlerts,
    showOnAll: showAlertsCategory && hasAlerts,
  });

  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isIssuesLoading &&
    !isMineIssuesLoading &&
    !isTouchedIssuesLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const markAllReadIssues = (tab === "mine" ? mineIssues : unreadTouchedIssues)
    .filter((issue) => issue.isUnreadForMe && !fadingOutIssues.has(issue.id) && !archivingIssueIds.has(issue.id));
  const unreadIssueIds = markAllReadIssues
    .map((issue) => issue.id);
  const canMarkAllRead = unreadIssueIds.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
          <PageTabBar
            items={[
              {
                value: "mine",
                label: "Mine",
              },
              {
                value: "recent",
                label: "Recent",
              },
              { value: "unread", label: "Unread" },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>

        <div className="flex items-center gap-2">
          {canMarkAllRead && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => markAllReadMutation.mutate(unreadIssueIds)}
              disabled={markAllReadMutation.isPending}
            >
              {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
            </Button>
          )}
        </div>
      </div>

      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      )}

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          message={
            tab === "mine"
              ? "Inbox zero."
              : tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <div ref={listRef} className="overflow-hidden rounded-xl border border-border bg-card">
              {workItemsToRender.flatMap((item, index) => {
                const wrapItem = (key: string, isSelected: boolean, child: ReactNode) => (
                  <div
                    key={`sel-${key}`}
                    data-inbox-item
                    className="relative"
                    onClick={() => setSelectedIndex(index)}
                  >
                    {child}
                  </div>
                );
                const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
                const showTodayDivider =
                  index > 0 &&
                  item.timestamp > 0 &&
                  item.timestamp < todayCutoff &&
                  workItemsToRender[index - 1].timestamp >= todayCutoff;
                const elements: ReactNode[] = [];
                if (showTodayDivider) {
                  elements.push(
                    <div key="today-divider" className="flex items-center gap-3 px-4 my-2">
                      <div className="flex-1 border-t border-border" />
                      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Earlier
                      </span>
                    </div>,
                  );
                }
                const isSelected = selectedIndex === index;

                if (item.kind === "approval") {
                  const approvalKey = `approval:${item.approval.id}`;
                  const isArchiving = archivingNonIssueIds.has(approvalKey);
                  const row = (
                    <ApprovalInboxRow
                      key={approvalKey}
                      approval={item.approval}
                      selected={isSelected}
                      requesterName={agentName(item.approval.requestedByAgentId)}
                      onApprove={() => approveMutation.mutate(item.approval.id)}
                      onReject={() => rejectMutation.mutate(item.approval.id)}
                      isPending={approveMutation.isPending || rejectMutation.isPending}
                      unreadState={nonIssueUnreadState(approvalKey)}
                      onMarkRead={() => handleMarkNonIssueRead(approvalKey)}
                      onArchive={canArchiveFromTab ? () => handleArchiveNonIssue(approvalKey) : undefined}
                      archiveDisabled={isArchiving}
                      className={
                        isArchiving
                          ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                          : "transition-all duration-200 ease-out"
                      }
                    />
                  );
                  elements.push(wrapItem(approvalKey, isSelected, canArchiveFromTab ? (
                    <SwipeToArchive
                      key={approvalKey}
                      selected={isSelected}
                      disabled={isArchiving}
                      onArchive={() => handleArchiveNonIssue(approvalKey)}
                    >
                      {row}
                    </SwipeToArchive>
                  ) : row));
                  return elements;
                }

                if (item.kind === "failed_run") {
                  const runKey = `run:${item.run.id}`;
                  const isArchiving = archivingNonIssueIds.has(runKey);
                  const row = (
                    <FailedRunInboxRow
                      key={runKey}
                      run={item.run}
                      selected={isSelected}
                      issueById={issueById}
                      agentName={agentName(item.run.agentId)}
                      issueLinkState={issueLinkState}
                      onDismiss={() => dismiss(runKey)}
                      onRetry={() => retryRunMutation.mutate(item.run)}
                      isRetrying={retryingRunIds.has(item.run.id)}
                      unreadState={nonIssueUnreadState(runKey)}
                      onMarkRead={() => handleMarkNonIssueRead(runKey)}
                      onArchive={canArchiveFromTab ? () => handleArchiveNonIssue(runKey) : undefined}
                      archiveDisabled={isArchiving}
                      className={
                        isArchiving
                          ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                          : "transition-all duration-200 ease-out"
                      }
                    />
                  );
                  elements.push(wrapItem(runKey, isSelected, canArchiveFromTab ? (
                    <SwipeToArchive
                      key={runKey}
                      selected={isSelected}
                      disabled={isArchiving}
                      onArchive={() => handleArchiveNonIssue(runKey)}
                    >
                      {row}
                    </SwipeToArchive>
                  ) : row));
                  return elements;
                }

                if (item.kind === "join_request") {
                  const joinKey = `join:${item.joinRequest.id}`;
                  const isArchiving = archivingNonIssueIds.has(joinKey);
                  const row = (
                    <JoinRequestInboxRow
                      key={joinKey}
                      joinRequest={item.joinRequest}
                      selected={isSelected}
                      onApprove={() => approveJoinMutation.mutate(item.joinRequest)}
                      onReject={() => rejectJoinMutation.mutate(item.joinRequest)}
                      isPending={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                      unreadState={nonIssueUnreadState(joinKey)}
                      onMarkRead={() => handleMarkNonIssueRead(joinKey)}
                      onArchive={canArchiveFromTab ? () => handleArchiveNonIssue(joinKey) : undefined}
                      archiveDisabled={isArchiving}
                      className={
                        isArchiving
                          ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                          : "transition-all duration-200 ease-out"
                      }
                    />
                  );
                  elements.push(wrapItem(joinKey, isSelected, canArchiveFromTab ? (
                    <SwipeToArchive
                      key={joinKey}
                      selected={isSelected}
                      disabled={isArchiving}
                      onArchive={() => handleArchiveNonIssue(joinKey)}
                    >
                      {row}
                    </SwipeToArchive>
                  ) : row));
                  return elements;
                }

                const issue = item.issue;
                const isUnread = issue.isUnreadForMe && !fadingOutIssues.has(issue.id);
                const isFading = fadingOutIssues.has(issue.id);
                const isArchiving = archivingIssueIds.has(issue.id);
                const row = (
                  <IssueRow
                    key={`issue:${issue.id}`}
                    issue={issue}
                    issueLinkState={issueLinkState}
                    selected={isSelected}
                    className={
                      isArchiving
                        ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                        : "transition-all duration-200 ease-out"
                    }
                    desktopMetaLeading={
                      <InboxIssueMetaLeading
                        issue={issue}
                        selected={isSelected}
                        isLive={liveIssueIds.has(issue.id)}
                      />
                    }
                    mobileMeta={
                      issue.lastExternalCommentAt
                        ? `commented ${timeAgo(issue.lastExternalCommentAt)}`
                        : `updated ${timeAgo(issue.updatedAt)}`
                    }
                    unreadState={
                      isUnread ? "visible" : isFading ? "fading" : "hidden"
                    }
                    onMarkRead={() => markReadMutation.mutate(issue.id)}
                    onArchive={
                      canArchiveFromTab
                        ? () => archiveIssueMutation.mutate(issue.id)
                        : undefined
                    }
                    archiveDisabled={isArchiving || archiveIssueMutation.isPending}
                    trailingMeta={
                      issue.lastExternalCommentAt
                        ? `commented ${timeAgo(issue.lastExternalCommentAt)}`
                        : `updated ${timeAgo(issue.updatedAt)}`
                    }
                  />
                );

                elements.push(wrapItem(`issue:${issue.id}`, isSelected, canArchiveFromTab ? (
                  <SwipeToArchive
                    key={`issue:${issue.id}`}
                    selected={isSelected}
                    disabled={isArchiving || archiveIssueMutation.isPending}
                    onArchive={() => archiveIssueMutation.mutate(issue.id)}
                  >
                    {row}
                  </SwipeToArchive>
                ) : row));
                return elements;
              })}
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

    </div>
  );
}
