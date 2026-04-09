import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { approvalsApi } from "../api/approvals";
import { activityApi, type RunForIssue } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { extractIssueTimelineEvents } from "../lib/issue-timeline-events";
import { queryKeys } from "../lib/queryKeys";
import {
  hasLegacyIssueDetailQuery,
  createIssueDetailPath,
  readIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  readIssueDetailHeaderSeed,
  rememberIssueDetailLocationState,
} from "../lib/issueDetailBreadcrumb";
import {
  hasBlockingShortcutDialog,
  resolveIssueDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
} from "../lib/keyboardShortcuts";
import {
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
  applyOptimisticIssueCommentUpdate,
  createOptimisticIssueComment,
  flattenIssueCommentPages,
  getNextIssueCommentPageParam,
  isQueuedIssueComment,
  matchesIssueRef,
  mergeIssueComments,
  upsertIssueCommentInPages,
  type IssueCommentReassignment,
  type OptimisticIssueComment,
} from "../lib/optimistic-issue-comments";
import { removeLiveRunById, upsertInterruptedRun } from "../lib/optimistic-issue-runs";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { ApprovalCard } from "../components/ApprovalCard";
import { InlineEditor } from "../components/InlineEditor";
import { IssueChatThread, type IssueChatComposerHandle } from "../components/IssueChatThread";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueProperties } from "../components/IssueProperties";
import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";
import type { MentionOption } from "../components/MarkdownEditor";
import { ImageGalleryModal } from "../components/ImageGalleryModal";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatIssueActivityAction } from "@/lib/activity-format";
import { resolveIssueChatTranscriptRuns } from "../lib/issueChatTranscriptRuns";
import {
  Activity as ActivityIcon,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ActivityEvent,
  type Agent,
  type FeedbackVote,
  type Issue,
  type IssueAttachment,
  type IssueComment,
} from "@paperclipai/shared";

type CommentReassignment = IssueCommentReassignment;
type IssueDetailComment = (IssueComment | OptimisticIssueComment) & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
};

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";
const ISSUE_COMMENT_PAGE_SIZE = 50;

function keepPreviousData<T>(previousData: T | undefined) {
  return previousData;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mergeOptimisticFeedbackVote(
  previousVotes: FeedbackVote[] | undefined,
  nextVote: {
    issueId: string;
    targetType: "issue_comment" | "issue_document_revision";
    targetId: string;
    vote: "up" | "down";
    reason?: string;
  },
  currentUserId: string | null,
): FeedbackVote[] {
  const now = new Date();
  const existingVotes = previousVotes ?? [];
  const existingIndex = existingVotes.findIndex(
    (feedbackVote) =>
      feedbackVote.targetType === nextVote.targetType &&
      feedbackVote.targetId === nextVote.targetId &&
      (!currentUserId || feedbackVote.authorUserId === currentUserId),
  );

  if (existingIndex >= 0) {
    const existingVote = existingVotes[existingIndex]!;
    const updatedVote: FeedbackVote = {
      ...existingVote,
      vote: nextVote.vote,
      reason:
        nextVote.reason !== undefined
          ? nextVote.reason.trim() || null
          : existingVote.reason,
      updatedAt: now,
    };
    const nextVotes = [...existingVotes];
    nextVotes[existingIndex] = updatedVote;
    return nextVotes;
  }

  return [
    ...existingVotes,
    {
      id: `optimistic:${nextVote.targetType}:${nextVote.targetId}`,
      companyId: "",
      issueId: nextVote.issueId,
      targetType: nextVote.targetType,
      targetId: nextVote.targetId,
      authorUserId: currentUserId ?? "current-user",
      vote: nextVote.vote,
      reason: nextVote.reason?.trim() || null,
      sharedWithLabs: false,
      sharedAt: null,
      consentVersion: null,
      redactionSummary: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

function IssueSectionSkeleton({
  titleWidth = "w-28",
  rows = 3,
}: {
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Skeleton className={cn("h-4", titleWidth)} />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

function IssueChatSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-end gap-2">
          <div className="space-y-2 text-right">
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <Skeleton className="ml-auto h-16 w-[85%] rounded-xl" />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}

function IssueDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readIssueDetailHeaderSeed>;
}) {
  const identifier = headerSeed?.identifier ?? headerSeed?.id.slice(0, 8) ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />

        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {headerSeed ? (
            <>
              <StatusIcon status={headerSeed.status} />
              <PriorityIcon priority={headerSeed.priority} />
              {identifier ? (
                <span className="text-sm font-mono text-muted-foreground shrink-0">{identifier}</span>
              ) : null}
              {headerSeed.originKind === "routine_execution" && headerSeed.originId ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0">
                  <Repeat className="h-3 w-3" />
                  Routine
                </span>
              ) : null}
              {headerSeed.projectId ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground rounded px-1 -mx-1 py-0.5 min-w-0">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {headerSeed.projectName ?? headerSeed.projectId.slice(0, 8)}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  No project
                </span>
              )}
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </>
          )}
        </div>

        {headerSeed ? (
          <>
            <h2 className="text-xl font-bold leading-tight">{headerSeed.title}</h2>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full max-w-xl" />
              <Skeleton className="h-4 w-[72%]" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-8 w-[min(100%,22rem)]" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>

      <Skeleton className="h-28 w-full rounded-lg border border-border" />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <IssueChatSkeleton />
      </div>

      <IssueSectionSkeleton titleWidth="w-24" rows={3} />
    </div>
  );
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  const [pendingApprovalAction, setPendingApprovalAction] = useState<{
    approvalId: string;
    action: "approve" | "reject";
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [optimisticComments, setOptimisticComments] = useState<OptimisticIssueComment[]>([]);
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] = useState(0);
  const [issueChatInitialTranscriptReady, setIssueChatInitialTranscriptReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);
  const commentComposerRef = useRef<IssueChatComposerHandle | null>(null);

  useEffect(() => {
    setIssueChatInitialTranscriptReady(false);
  }, [issueId]);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;
  const commentComposerDisabledReason = useMemo(() => {
    if (!issue?.currentExecutionWorkspace || !isClosedIsolatedExecutionWorkspace(issue.currentExecutionWorkspace)) {
      return null;
    }
    return getClosedIsolatedExecutionWorkspaceMessage(issue.currentExecutionWorkspace);
  }, [issue?.currentExecutionWorkspace]);

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: ({ pageParam }) =>
      issuesApi.listComments(issueId!, {
        order: "desc",
        limit: ISSUE_COMMENT_PAGE_SIZE,
        ...(pageParam ? { after: pageParam } : {}),
      }),
    enabled: !!issueId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      getNextIssueCommentPageParam(lastPage, ISSUE_COMMENT_PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const comments = useMemo(
    () => flattenIssueCommentPages(commentPages?.pages),
    [commentPages?.pages],
  );

  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousData,
  });

  const { data: linkedRuns, isLoading: linkedRunsLoading } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousData,
  });

  const { data: attachments, isLoading: attachmentsLoading } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousData,
  });

  const { data: liveRuns, isLoading: liveRunsLoading } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
    placeholderData: keepPreviousData,
  });

  const { data: activeRun, isLoading: activeRunLoading } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId && (!!issue?.executionRunId || issue?.status === "in_progress"),
    refetchInterval: (liveRuns?.length ?? 0) > 0 ? false : 3000,
    placeholderData: keepPreviousData,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;
  const runningIssueRun = useMemo(
    () => (
      activeRun?.status === "running"
        ? activeRun
        : (liveRuns ?? []).find((run) => run.status === "running") ?? null
    ),
    [activeRun, liveRuns],
  );
  const resolvedIssueDetailState = useMemo(
    () => readIssueDetailLocationState(issueId, location.state, location.search),
    [issueId, location.state, location.search],
  );
  const issueHeaderSeed = useMemo(
    () => readIssueDetailHeaderSeed(location.state) ?? readIssueDetailHeaderSeed(resolvedIssueDetailState),
    [location.state, resolvedIssueDetailState],
  );
  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(issueId, location.state, location.search) ?? { label: "Issues", href: "/issues" },
    [issueId, location.state, location.search],
  );

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    const historicalRuns = liveIds.size === 0
      ? (linkedRuns ?? [])
      : (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
    return historicalRuns.map((run) => ({
      ...run,
      adapterType: run.adapterType,
      hasStoredOutput: (run.logBytes ?? 0) > 0,
    }));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: rawChildIssues = [], isLoading: childIssuesLoading } = useQuery({
    queryKey:
      issue?.id && resolvedCompanyId
        ? queryKeys.issues.listByParent(resolvedCompanyId, issue.id)
        : ["issues", "parent", "pending"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { parentId: issue!.id }),
    enabled: !!resolvedCompanyId && !!issue?.id,
    placeholderData: keepPreviousData,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { data: feedbackVotes } = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(issueId!),
    queryFn: () => issuesApi.listFeedbackVotes(issueId!),
    enabled: !!issueId && !!currentUserId,
  });
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: !!issueId,
    retry: false,
  });
  const keyboardShortcutsEnabled = instanceGeneralSettings?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = instanceGeneralSettings?.feedbackDataSharingPreference ?? "prompt";
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === detailTab) ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);
  const transcriptRuns = useMemo(
    () =>
      resolveIssueChatTranscriptRuns({
        linkedRuns: timelineRuns,
        liveRuns: liveRuns ?? [],
        activeRun,
      }),
    [activeRun, liveRuns, timelineRuns],
  );
  const {
    transcriptByRun: issueChatTranscriptByRun,
    hasOutputForRun: issueChatHasOutputForRun,
    isInitialHydrating: issueChatTranscriptHydrating,
  } = useLiveRunTranscripts({
    runs: transcriptRuns,
    companyId: issue?.companyId ?? selectedCompanyId,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const resolvedProject = useMemo(
    () => (issue?.projectId ? orderedProjects.find((project) => project.id === issue.projectId) ?? issue.project ?? null : null),
    [issue?.project, issue?.projectId, orderedProjects],
  );
  const childIssues = useMemo(
    () => [...rawChildIssues].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [rawChildIssues],
  );
  const childIssuesPanelKey = useMemo(
    () => childIssues.map((child) => `${child.id}:${String(child.updatedAt)}`).join("|"),
    [childIssues],
  );
  const issuePanelKey = issue
    ? `${issue.id}:${String(issue.updatedAt)}:${childIssuesPanelKey}`
    : "";
  const openNewSubIssue = useCallback(() => {
    if (!issue) return;
    openNewIssue({
      parentId: issue.id,
      parentIdentifier: issue.identifier ?? undefined,
      parentTitle: issue.title,
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      goalId: issue.goalId ?? undefined,
      executionWorkspaceId: issue.executionWorkspaceId ?? undefined,
      executionWorkspaceMode: issue.executionWorkspaceId ? "reuse_existing" : issue.executionWorkspacePreference ?? undefined,
      parentExecutionWorkspaceLabel:
        issue.currentExecutionWorkspace?.name
          ?? issue.currentExecutionWorkspace?.branchName
          ?? issue.currentExecutionWorkspace?.cwd
          ?? issue.executionWorkspaceId
          ?? undefined,
    });
  }, [
    issue?.currentExecutionWorkspace?.branchName,
    issue?.currentExecutionWorkspace?.cwd,
    issue?.currentExecutionWorkspace?.name,
    issue?.executionWorkspaceId,
    issue?.executionWorkspacePreference,
    issue?.goalId,
    issue?.id,
    issue?.identifier,
    issue?.projectId,
    issue?.projectWorkspaceId,
    issue?.title,
    openNewIssue,
  ]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(issue ?? {}),
    [issue],
  );

  const suggestedAssigneeValue = useMemo(
    () =>
      suggestedCommentAssigneeValue(
        issue ?? {},
        mergeIssueComments(comments ?? [], optimisticComments),
        currentUserId,
      ),
    [issue, comments, optimisticComments, currentUserId],
  );

  const threadComments = useMemo(
    () => mergeIssueComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );

  const commentsWithRunMeta = useMemo<IssueDetailComment[]>(() => {
    const activeRunStartedAt = runningIssueRun?.startedAt ?? runningIssueRun?.createdAt ?? null;
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null; interruptedRunId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      const interruptedRunId =
        typeof details["interruptedRunId"] === "string" ? details["interruptedRunId"] : null;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
        interruptedRunId,
      });
    }
    return threadComments.map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      const nextComment: IssueDetailComment = meta ? { ...comment, ...meta } : { ...comment };
      if (
        isQueuedIssueComment({
          comment: nextComment,
          activeRunStartedAt,
          activeRunAgentId: runningIssueRun?.agentId ?? null,
          runId: meta?.runId ?? nextComment.runId ?? null,
          interruptedRunId: meta?.interruptedRunId ?? nextComment.interruptedRunId ?? null,
        })
      ) {
        return {
          ...nextComment,
          queueState: "queued" as const,
          queueTargetRunId: runningIssueRun?.id ?? nextComment.queueTargetRunId ?? null,
        };
      }
      return nextComment;
    });
  }, [activity, threadComments, linkedRuns, runningIssueRun]);

  const timelineEvents = useMemo(
    () => extractIssueTimelineEvents(activity),
    [activity],
  );

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssueDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
  }, [issueId, queryClient]);
  const invalidateIssueThreadLazily = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!), refetchType: "inactive" });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!), refetchType: "inactive" });
  }, [issueId, queryClient]);

  const invalidateIssueRunState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
  }, [issueId, queryClient]);

  const invalidateIssueCollections = useCallback(() => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  }, [queryClient, selectedCompanyId]);

  const applyOptimisticIssueCacheUpdate = useCallback((refs: Iterable<string>, data: Record<string, unknown>) => {
    queryClient.setQueriesData<Issue>(
      { queryKey: ["issues", "detail"] },
      (cached) => (cached && matchesIssueRef(cached, refs) ? applyOptimisticIssueFieldUpdate(cached, data) : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Issue[] | undefined>(
      queryKeys.issues.list(selectedCompanyId),
      (cached) => applyOptimisticIssueFieldUpdateToCollection(cached, refs, data),
    );
  }, [queryClient, selectedCompanyId]);

  const mergeIssueResponseIntoCaches = useCallback((refs: Iterable<string>, nextIssue: Issue) => {
    queryClient.setQueriesData<Issue>(
      { queryKey: ["issues", "detail"] },
      (cached) => (cached && matchesIssueRef(cached, refs) ? { ...cached, ...nextIssue } : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Issue[] | undefined>(
      queryKeys.issues.list(selectedCompanyId),
      (cached) => cached?.map((item) => (matchesIssueRef(item, refs) ? { ...item, ...nextIssue } : item)),
    );
  }, [queryClient, selectedCompanyId]);

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });
      if (selectedCompanyId) {
        await queryClient.cancelQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const issueRefs = new Set<string>([issueId!]);
      if (previousIssue?.id) issueRefs.add(previousIssue.id);
      if (previousIssue?.identifier) issueRefs.add(previousIssue.identifier);

      const previousDetailQueries = queryClient
        .getQueriesData<Issue>({ queryKey: ["issues", "detail"] })
        .filter(([, cachedIssue]) => cachedIssue && matchesIssueRef(cachedIssue, issueRefs));
      const previousList = selectedCompanyId
        ? queryClient.getQueryData<Issue[]>(queryKeys.issues.list(selectedCompanyId))
        : undefined;

      applyOptimisticIssueCacheUpdate(issueRefs, data);

      return { previousDetailQueries, previousList, selectedCompanyId };
    },
    onSuccess: ({ comment: _comment, ...nextIssue }) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
      invalidateIssueCollections();
    },
    onError: (err, _variables, context) => {
      for (const [queryKey, previousIssue] of context?.previousDetailQueries ?? []) {
        queryClient.setQueryData(queryKey, previousIssue);
      }
      if (context?.selectedCompanyId) {
        queryClient.setQueryData(queryKeys.issues.list(context.selectedCompanyId), context.previousList);
      }
      pushToast({
        title: "Issue update failed",
        body: err instanceof Error ? err.message : "Unable to save issue changes",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }
    },
  });
  const handleIssuePropertiesUpdate = useCallback((data: Record<string, unknown>) => {
    updateIssue.mutate(data);
  }, [updateIssue.mutate]);

  const approvalDecision = useMutation({
    mutationFn: async ({ approvalId, action }: { approvalId: string; action: "approve" | "reject" }) => {
      if (action === "approve") {
        return approvalsApi.approve(approvalId);
      }
      return approvalsApi.reject(approvalId);
    },
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateIssueDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
      invalidateIssueCollections();
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(variables.approvalId) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(resolvedCompanyId) });
      }
      pushToast({
        title: variables.action === "approve" ? "Approval approved" : "Approval rejected",
        tone: "success",
      });
    },
    onError: (err, variables) => {
      pushToast({
        title: variables.action === "approve" ? "Approval failed" : "Rejection failed",
        body: err instanceof Error ? err.message : "Unable to update approval",
        tone: "error",
      });
    },
    onSettled: () => {
      setPendingApprovalAction(null);
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen, interrupt }: { body: string; reopen?: boolean; interrupt?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen, interrupt),
    onMutate: async ({ body, reopen, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const queuedComment = !interrupt && runningIssueRun;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment ? runningIssueRun.id : null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, { reopen }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        previousIssue,
      };
    },
    onSuccess: (comment, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      queryClient.setQueryData<Issue | undefined>(
        queryKeys.issues.detail(issueId!),
        (current) => current ? { ...current, updatedAt: comment.createdAt } : current,
      );
      queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
        queryKeys.issues.comments(issueId!),
        (current) => current ? {
          ...current,
          pages: upsertIssueCommentInPages(current.pages, comment),
        } : {
          pageParams: [null],
          pages: upsertIssueCommentInPages(undefined, comment),
        },
      );
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(queryKeys.issues.detail(issueId!), context.previousIssue);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateIssueThreadLazily();
      if (variables.interrupt) {
        invalidateIssueRunState();
      }
      if (variables.reopen) {
        invalidateIssueCollections();
      }
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      interrupt,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
        ...(interrupt ? { interrupt } : {}),
      }),
    onMutate: async ({ body, reopen, reassignment, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(issueId!) });

      const previousIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId!));
      const queuedComment = !interrupt && runningIssueRun;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment ? runningIssueRun.id : null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, { reopen, reassignment }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        previousIssue,
      };
    },
    onSuccess: (result, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }

      const { comment, ...nextIssue } = result;
      queryClient.setQueryData(queryKeys.issues.detail(issueId!), nextIssue);
      if (comment) {
        queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
          queryKeys.issues.comments(issueId!),
          (current) => current ? {
            ...current,
            pages: upsertIssueCommentInPages(current.pages, comment),
          } : {
            pageParams: [null],
            pages: upsertIssueCommentInPages(undefined, comment),
          },
        );
      }
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(queryKeys.issues.detail(issueId!), context.previousIssue);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateIssueThreadLazily();
      if (variables.interrupt) {
        invalidateIssueRunState();
      }
      invalidateIssueCollections();
    },
  });

  const interruptQueuedComment = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onMutate: async (runId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.runs(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });

      const previousRuns = queryClient.getQueryData<RunForIssue[]>(queryKeys.issues.runs(issueId!));
      const previousLiveRuns = queryClient.getQueryData<typeof liveRuns>(queryKeys.issues.liveRuns(issueId!));
      const previousActiveRun = queryClient.getQueryData<typeof activeRun>(queryKeys.issues.activeRun(issueId!));
      const liveRunList = previousLiveRuns ?? liveRuns ?? [];
      const cachedActiveRun = previousActiveRun ?? activeRun;
      const targetRun =
        cachedActiveRun?.id === runId
          ? cachedActiveRun
          : liveRunList?.find((run) => run.id === runId) ?? runningIssueRun ?? null;

      if (targetRun) {
        const interruptedAt = new Date().toISOString();
        queryClient.setQueryData<RunForIssue[] | undefined>(
          queryKeys.issues.runs(issueId!),
          (current) => upsertInterruptedRun(current, targetRun, interruptedAt),
        );
      }

      queryClient.setQueryData(
        queryKeys.issues.liveRuns(issueId!),
        (current: typeof liveRuns) => removeLiveRunById(current, runId),
      );
      queryClient.setQueryData(
        queryKeys.issues.activeRun(issueId!),
        (current: typeof activeRun) => (current?.id === runId ? null : current),
      );

      return {
        previousRuns,
        previousLiveRuns,
        previousActiveRun,
      };
    },
    onSuccess: () => {
      invalidateIssueDetail();
      invalidateIssueRunState();
      pushToast({
        title: "Interrupt requested",
        body: "The active run is stopping so queued comments can continue next.",
        tone: "success",
      });
    },
    onError: (err, _runId, context) => {
      queryClient.setQueryData(queryKeys.issues.runs(issueId!), context?.previousRuns);
      queryClient.setQueryData(queryKeys.issues.liveRuns(issueId!), context?.previousLiveRuns);
      queryClient.setQueryData(queryKeys.issues.activeRun(issueId!), context?.previousActiveRun);
      pushToast({
        title: "Interrupt failed",
        body: err instanceof Error ? err.message : "Unable to interrupt the active run",
        tone: "error",
      });
    },
  });

  const feedbackVoteMutation = useMutation({
    mutationFn: (variables: {
      targetType: "issue_comment" | "issue_document_revision";
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
      sharingPreferenceAtSubmit: "allowed" | "not_allowed" | "prompt";
    }) =>
      issuesApi.upsertFeedbackVote(issueId!, {
        targetType: variables.targetType,
        targetId: variables.targetId,
        vote: variables.vote,
        ...(variables.reason ? { reason: variables.reason } : {}),
        ...(variables.allowSharing ? { allowSharing: true } : {}),
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.feedbackVotes(issueId!) });
      const previousVotes = queryClient.getQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
      );
      queryClient.setQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
        mergeOptimisticFeedbackVote(
          previousVotes,
          {
            issueId: issueId!,
            targetType: variables.targetType,
            targetId: variables.targetId,
            vote: variables.vote,
            reason: variables.reason,
          },
          currentUserId,
        ),
      );
      return { previousVotes };
    },
    onSuccess: (_savedVote, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.feedbackVotes(issueId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
      pushToast({
        title:
          variables.sharingPreferenceAtSubmit === "prompt"
            ? variables.allowSharing
              ? "Feedback saved. Future votes will share"
              : "Feedback saved. Future votes will stay local"
            : variables.allowSharing
              ? "Feedback saved and sharing enabled"
              : "Feedback saved",
        tone: "success",
      });
    },
    onError: (err, _variables, context) => {
      if (context?.previousVotes) {
        queryClient.setQueryData(queryKeys.issues.feedbackVotes(issueId!), context.previousVotes);
      }
      pushToast({
        title: "Failed to save feedback",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssueDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssueDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssueDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => issuesApi.archiveFromInbox(id),
    onSuccess: () => {
      invalidateIssueCollections();
      navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox", { replace: true });
      pushToast({ title: "Issue archived from inbox", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Archive failed",
        body: err instanceof Error ? err.message : "Unable to archive this issue from the inbox",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId, hasLiveRuns]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    const nextState = resolvedIssueDetailState ?? location.state;
    if (issue?.identifier && issueId !== issue.identifier) {
      rememberIssueDetailLocationState(issue.identifier, nextState, location.search);
      navigate(createIssueDetailPath(issue.identifier), {
        replace: true,
        state: nextState,
      });
      return;
    }

    if (issueId && hasLegacyIssueDetailQuery(location.search)) {
      rememberIssueDetailLocationState(issueId, nextState, location.search);
      navigate(createIssueDetailPath(issueId), {
        replace: true,
        state: nextState,
      });
    }
  }, [issue, issueId, navigate, location.state, location.search, resolvedIssueDetailState]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!issue) {
      closePanel();
      return;
    }
    openPanel(
      <IssueProperties
        issue={issue}
        childIssues={childIssues}
        onAddSubIssue={openNewSubIssue}
        onUpdate={handleIssuePropertiesUpdate}
      />
    );
    return () => closePanel();
  }, [closePanel, handleIssuePropertiesUpdate, issuePanelKey, openNewSubIssue, openPanel]);

  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox =
    keyboardShortcutsEnabled &&
    !issue?.hiddenAt;

  useEffect(() => {
    if (!issue?.id || !canQuickArchiveFromInbox) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveInboxQuickArchiveKeyAction({
        armed: canQuickArchiveFromInbox,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action !== "archive") return;

      event.preventDefault();
      if (!archiveFromInbox.isPending) {
        archiveFromInbox.mutate(issue.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [archiveFromInbox, canQuickArchiveFromInbox, issue?.id]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      goToInboxShortcutArmedRef.current = false;
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
      return;
    }

    const clearArmTimeout = () => {
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
    };

    const disarm = () => {
      goToInboxShortcutArmedRef.current = false;
      clearArmTimeout();
    };

    const arm = () => {
      goToInboxShortcutArmedRef.current = true;
      clearArmTimeout();
      goToInboxShortcutTimeoutRef.current = window.setTimeout(() => {
        goToInboxShortcutArmedRef.current = false;
        goToInboxShortcutTimeoutRef.current = null;
      }, 1200);
    };

    const handlePointerDown = () => {
      disarm();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveIssueDetailGoKeyAction({
        armed: goToInboxShortcutArmedRef.current,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action === "ignore") return;
      if (action === "arm") {
        arm();
        return;
      }

      disarm();
      if (action === "navigate_inbox") {
        event.preventDefault();
        event.stopPropagation();
        navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox");
        return;
      }
      if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [keyboardShortcutsEnabled, navigate, sourceBreadcrumb.href]);

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0) return;
    if (detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const imageAttachments = attachmentList.filter(isImageAttachment);
  const nonImageAttachments = attachmentList.filter((a) => !isImageAttachment(a));

  const handleChatImageClick = useCallback(
    (src: string) => {
      // Try exact contentPath match first
      let idx = imageAttachments.findIndex((a) => a.contentPath === src);
      if (idx < 0) {
        // Try matching by asset ID extracted from /api/assets/{assetId}/content URLs
        const assetMatch = src.match(/\/api\/assets\/([^/]+)\/content/);
        if (assetMatch) {
          idx = imageAttachments.findIndex((a) => a.assetId === assetMatch[1]);
        }
      }
      if (idx >= 0) {
        setGalleryIndex(idx);
        setGalleryOpen(true);
      } else {
        // Image not in attachment list — open in new tab
        window.open(src, "_blank");
      }
    },
    [imageAttachments],
  );

  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issue.title);
    const body = decodeEntities(issue.description ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    await navigator.clipboard.writeText(md);
    setCopied(true);
    pushToast({ title: "Copied to clipboard", tone: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  const issueChatCoreInitialLoading =
    (commentsLoading && commentPages === undefined)
    || (activityLoading && activity === undefined)
    || (linkedRunsLoading && linkedRuns === undefined)
    || (liveRunsLoading && liveRuns === undefined)
    || (activeRunLoading && activeRun === undefined);
  useEffect(() => {
    if (issueChatInitialTranscriptReady) return;
    if (issueChatCoreInitialLoading || issueChatTranscriptHydrating) return;
    setIssueChatInitialTranscriptReady(true);
  }, [issueChatCoreInitialLoading, issueChatInitialTranscriptReady, issueChatTranscriptHydrating]);
  const issueChatInitialLoading =
    issueChatCoreInitialLoading
    || (!issueChatInitialTranscriptReady && issueChatTranscriptHydrating);
  const activityInitialLoading =
    (activityLoading && activity === undefined)
    || (linkedRunsLoading && linkedRuns === undefined);
  const attachmentsInitialLoading = attachmentsLoading && attachments === undefined;

  if (isLoading) return <IssueDetailLoadingState headerSeed={issueHeaderSeed} />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const hasAttachments = attachmentList.length > 0;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  return (
    <div className="max-w-2xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={createIssueDetailPath(ancestor.identifier ?? ancestor.id)}
                state={resolvedIssueDetailState ?? location.state}
                onClickCapture={() =>
                  rememberIssueDetailLocationState(
                    ancestor.identifier ?? ancestor.id,
                    resolvedIssueDetailState ?? location.state,
                    location.search,
                  )}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {issue.originKind === "routine_execution" && issue.originId && (
            <Link
              to={`/routines/${issue.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{resolvedProject?.name ?? issue.project?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: pickTextColorForPillBg(label.color, 0.12),
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onDropFile={async (file) => {
            await uploadAttachment.mutateAsync(file);
          }}
        />
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      {(childIssuesLoading || childIssues.length > 0) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Sub-issues</h3>
            <Button variant="outline" size="sm" onClick={openNewSubIssue} className="shadow-none">
              <ListTree className="h-3.5 w-3.5 mr-1.5" />
              <span className="hidden sm:inline">Add sub-issue</span>
              <span className="sm:hidden">Sub-issue</span>
            </Button>
          </div>
          {childIssuesLoading ? (
            <IssueSectionSkeleton titleWidth="w-24" rows={2} />
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={createIssueDetailPath(child.identifier ?? child.id)}
                  state={resolvedIssueDetailState ?? location.state}
                  onClickCapture={() =>
                    rememberIssueDetailLocationState(
                      child.identifier ?? child.id,
                      resolvedIssueDetailState ?? location.state,
                      location.search,
                    )}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={child.status} />
                    <PriorityIcon priority={child.priority} />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {child.identifier ?? child.id.slice(0, 8)}
                    </span>
                    <span className="truncate">{child.title}</span>
                  </div>
                  {child.assigneeAgentId && (() => {
                    const name = agentMap.get(child.assigneeAgentId)?.name;
                    return name
                      ? <Identity name={name} size="sm" />
                      : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                  })()}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={Boolean(session?.user?.id)}
        feedbackVotes={feedbackVotes}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        feedbackTermsUrl={FEEDBACK_TERMS_URL}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        onVote={async (revisionId, vote, options) => {
          await feedbackVoteMutation.mutateAsync({
            targetType: "issue_document_revision",
            targetId: revisionId,
            vote,
            reason: options?.reason,
            allowSharing: options?.allowSharing,
            sharingPreferenceAtSubmit: feedbackDataSharingPreference,
          });
        }}
        extraActions={
          <>
            {!hasAttachments && attachmentUploadButton}
            {childIssues.length === 0 && (
              <Button variant="outline" size="sm" onClick={openNewSubIssue} className="shadow-none">
                <ListTree className="h-3.5 w-3.5 mr-1.5" />
                <span className="hidden sm:inline">Add sub-issue</span>
                <span className="sm:hidden">Sub-issue</span>
              </Button>
            )}
          </>
        }
      />

      {attachmentsInitialLoading ? (
        <IssueSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <div
        className={cn(
          "space-y-3 rounded-lg transition-colors",
        )}
        onDragEnter={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragOver={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragLeave={(evt) => {
          if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
          setAttachmentDragActive(false);
        }}
        onDrop={(evt) => void handleAttachmentDrop(evt)}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          {attachmentUploadButton}
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        {imageAttachments.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {imageAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative aspect-square rounded-lg overflow-hidden border border-border bg-accent/10 cursor-pointer"
                onClick={() => {
                  const idx = imageAttachments.findIndex((a) => a.id === attachment.id);
                  setGalleryIndex(idx >= 0 ? idx : 0);
                  setGalleryOpen(true);
                }}
              >
                <img
                  src={attachment.contentPath}
                  alt={attachment.originalFilename ?? "attachment"}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors" />
                {confirmDeleteId === attachment.id ? (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-xs text-white font-medium">Delete?</p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        className="rounded bg-destructive px-2 py-0.5 text-xs text-white hover:bg-destructive/80"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAttachment.mutate(attachment.id);
                          setConfirmDeleteId(null);
                        }}
                        disabled={deleteAttachment.isPending}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/80"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                        }}
                      >
                        No
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="absolute top-1.5 right-1.5 rounded-md bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(attachment.id);
                    }}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {nonImageAttachments.length > 0 && (
          <div className="space-y-2">
            {nonImageAttachments.map((attachment) => (
              <div key={attachment.id} className="border border-border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={attachment.contentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline truncate"
                    title={attachment.originalFilename ?? attachment.id}
                  >
                    {attachment.originalFilename ?? attachment.id}
                  </a>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteAttachment.mutate(attachment.id)}
                    disabled={deleteAttachment.isPending}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                </p>
              </div>
            ))}
          </div>
        )}
        </div>
      ) : null}

      <ImageGalleryModal
        images={imageAttachments}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />

      <IssueWorkspaceCard
        issue={issue}
        project={resolvedProject}
        onUpdate={(data) => updateIssue.mutate(data)}
      />

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="chat" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          {issuePluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="chat">
          {issueChatInitialLoading ? (
            <IssueChatSkeleton />
          ) : (
            <div className="space-y-3">
              {hasOlderComments ? (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={commentsLoadingOlder}
                    onClick={() => {
                      void fetchOlderComments();
                    }}
                  >
                    {commentsLoadingOlder ? "Loading earlier comments..." : "Load earlier comments"}
                  </Button>
                </div>
              ) : null}
              <IssueChatThread
                composerRef={commentComposerRef}
                comments={commentsWithRunMeta}
                feedbackVotes={feedbackVotes}
                feedbackDataSharingPreference={feedbackDataSharingPreference}
                feedbackTermsUrl={FEEDBACK_TERMS_URL}
                linkedRuns={timelineRuns}
                timelineEvents={timelineEvents}
                liveRuns={liveRuns}
                activeRun={activeRun}
                companyId={issue.companyId}
                projectId={issue.projectId}
                issueStatus={issue.status}
                agentMap={agentMap}
                currentUserId={currentUserId}
                enableLiveTranscriptPolling={false}
                transcriptsByRunId={issueChatTranscriptByRun}
                hasOutputForRun={issueChatHasOutputForRun}
                draftKey={`paperclip:issue-comment-draft:${issue.id}`}
                enableReassign
                reassignOptions={commentReassignOptions}
                currentAssigneeValue={actualAssigneeValue}
                suggestedAssigneeValue={suggestedAssigneeValue}
                mentions={mentionOptions}
                composerDisabledReason={commentComposerDisabledReason}
                onVote={async (commentId, vote, options) => {
                  await feedbackVoteMutation.mutateAsync({
                    targetType: "issue_comment",
                    targetId: commentId,
                    vote,
                    reason: options?.reason,
                    allowSharing: options?.allowSharing,
                    sharingPreferenceAtSubmit: feedbackDataSharingPreference,
                  });
                }}
                onAdd={async (body, reopen, reassignment) => {
                  if (reassignment) {
                    await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                    return;
                  }
                  await addComment.mutateAsync({ body, reopen });
                }}
                imageUploadHandler={async (file) => {
                  const attachment = await uploadAttachment.mutateAsync(file);
                  return attachment.contentPath;
                }}
                onAttachImage={async (file) => {
                  await uploadAttachment.mutateAsync(file);
                }}
                onInterruptQueued={async (runId) => {
                  await interruptQueuedComment.mutateAsync(runId);
                }}
                interruptingQueuedRunId={interruptQueuedComment.isPending ? interruptQueuedComment.variables ?? null : null}
                onCancelRun={runningIssueRun
                  ? async () => {
                      await interruptQueuedComment.mutateAsync(runningIssueRun.id);
                    }
                  : undefined}
                onImageClick={handleChatImageClick}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {activityInitialLoading ? (
            <IssueSectionSkeleton titleWidth="w-20" rows={4} />
          ) : (
            <>
              {linkedApprovals && linkedApprovals.length > 0 && (
                <div className="mb-3 space-y-3">
                  {linkedApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      requesterAgent={approval.requestedByAgentId ? agentMap.get(approval.requestedByAgentId) ?? null : null}
                      onApprove={() => approvalDecision.mutate({ approvalId: approval.id, action: "approve" })}
                      onReject={() => approvalDecision.mutate({ approvalId: approval.id, action: "reject" })}
                      detailLink={`/approvals/${approval.id}`}
                      isPending={pendingApprovalAction?.approvalId === approval.id}
                      pendingAction={
                        pendingApprovalAction?.approvalId === approval.id
                          ? pendingApprovalAction.action
                          : null
                      }
                    />
                  ))}
                </div>
              )}
              {linkedRuns && linkedRuns.length > 0 && (
                <div className="mb-3 px-3 py-2 rounded-lg border border-border">
                  <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
                  {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                    <div className="text-xs text-muted-foreground">No cost data yet.</div>
                  ) : (
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
                      {issueCostSummary.hasCost && (
                        <span className="font-medium text-foreground">
                          ${issueCostSummary.cost.toFixed(4)}
                        </span>
                      )}
                      {issueCostSummary.hasTokens && (
                        <span>
                          Tokens {formatTokens(issueCostSummary.totalTokens)}
                          {issueCostSummary.cached > 0
                            ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                            : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!activity || activity.length === 0 ? (
                <p className="text-xs text-muted-foreground">No activity yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {activity.slice(0, 20).map((evt) => (
                    <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ActorIdentity evt={evt} agentMap={agentMap} />
                      <span>{formatIssueActivityAction(evt.action, evt.details, { agentMap, currentUserId })}</span>
                      <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: issue.companyId,
                projectId: issue.projectId ?? null,
                entityId: issue.id,
                entityType: "issue",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties
                issue={issue}
                childIssues={childIssues}
                onAddSubIssue={openNewSubIssue}
                onUpdate={(data) => updateIssue.mutate(data)}
                inline
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
