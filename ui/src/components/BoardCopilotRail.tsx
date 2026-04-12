import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, History, MessageSquare, MessageSquarePlus, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { Agent, CopilotThreadHistoryEntry, IssueComment } from "@paperclipai/shared";
import { useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { activityApi } from "../api/activity";
import { copilotApi } from "../api/copilot";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { buildCopilotRouteContext, extractContextIssueRef } from "../lib/copilot-route-context";
import { extractIssueTimelineEvents } from "../lib/issue-timeline-events";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatShortDate } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IssueChatThread } from "./IssueChatThread";

const STORAGE_KEY = "paperclip:board-copilot-visible";
const CONTEXT_BLOCK_PREFIX = "<!-- paperclip:board-copilot-context";
const COMMENTS_PAGE_SIZE = 60;
const THREAD_HISTORY_LIMIT = 50;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 80;
const BOTTOM_STICKY_THRESHOLD_PX = 80;

function readPreference() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writePreference(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function stripCopilotContext(body: string) {
  if (!body.startsWith(CONTEXT_BLOCK_PREFIX)) return body;
  const markerEnd = body.indexOf("-->");
  if (markerEnd < 0) return body;
  return body.slice(markerEnd + 3).replace(/^\s+/, "");
}

function contextLabel(pageKind: string, entityType?: string | null, entityId?: string | null) {
  if (entityType && entityId) {
    return `${entityType.replace(/_/g, " ")}: ${entityId}`;
  }
  return pageKind.replace(/_/g, " ");
}

interface CopilotCommentsPage {
  comments: IssueComment[];
  nextCursor: string | null;
}

function threadHistoryLabel(thread: CopilotThreadHistoryEntry) {
  if (!thread.hiddenAt) return "Current";
  return `Archived ${formatShortDate(thread.hiddenAt)}`;
}

export function BoardCopilotRail() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(readPreference);
  const [selectedThreadIssueId, setSelectedThreadIssueId] = useState<string | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const prependRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const autoScrolledThreadRef = useRef<string | null>(null);
  const newestCommentIdRef = useRef<string | null>(null);

  const routeContext = useMemo(
    () => buildCopilotRouteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const contextIssueRef = useMemo(
    () => extractContextIssueRef(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const copilotEnabledForRoute = Boolean(selectedCompanyId) && routeContext.pageKind !== "instance";
  const threadQueryKey = useMemo(
    () => [...queryKeys.copilot.thread(selectedCompanyId ?? "__none__"), contextIssueRef ?? "__none__"] as const,
    [selectedCompanyId, contextIssueRef],
  );

  const resolveViewport = useCallback(() => {
    const host = scrollHostRef.current;
    if (!host) {
      scrollViewportRef.current = null;
      return null;
    }
    const viewport = host.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    scrollViewportRef.current = viewport;
    return viewport;
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = resolveViewport();
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [resolveViewport]);

  const threadQuery = useQuery({
    queryKey: threadQueryKey,
    queryFn: () =>
      copilotApi.getThread(selectedCompanyId!, {
        contextIssueId: contextIssueRef,
      }),
    enabled: copilotEnabledForRoute,
  });

  const threadIssueId = threadQuery.data?.issueId ?? null;
  const activeThreadIssueId = selectedThreadIssueId ?? threadIssueId;

  const threadHistoryQuery = useQuery({
    queryKey: [...queryKeys.copilot.history(selectedCompanyId ?? "__none__"), "board", THREAD_HISTORY_LIMIT],
    queryFn: () =>
      copilotApi.listThreads(selectedCompanyId!, {
        limit: THREAD_HISTORY_LIMIT,
      }),
    enabled: copilotEnabledForRoute,
    refetchInterval: 5000,
  });

  const commentsQuery = useInfiniteQuery({
    queryKey: [...queryKeys.issues.comments(activeThreadIssueId ?? "__none__"), "copilot", "paged", COMMENTS_PAGE_SIZE],
    queryFn: async ({ pageParam }): Promise<CopilotCommentsPage> => {
      const afterCommentId = typeof pageParam === "string" && pageParam.trim().length > 0 ? pageParam : null;
      const comments = await issuesApi.listComments(activeThreadIssueId!, {
        afterCommentId,
        order: "desc",
        limit: COMMENTS_PAGE_SIZE,
      });
      const nextCursor =
        comments.length >= COMMENTS_PAGE_SIZE ? comments[comments.length - 1]?.id ?? null : null;
      return {
        comments,
        nextCursor,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(activeThreadIssueId),
    refetchInterval: 4000,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.issues.runs(activeThreadIssueId ?? "__none__"),
    queryFn: () => activityApi.runsForIssue(activeThreadIssueId!),
    enabled: Boolean(activeThreadIssueId),
    refetchInterval: 5000,
  });

  const activityQuery = useQuery({
    queryKey: queryKeys.issues.activity(activeThreadIssueId ?? "__none__"),
    queryFn: () => activityApi.forIssue(activeThreadIssueId!),
    enabled: Boolean(activeThreadIssueId),
    refetchInterval: 5000,
  });

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.issues.liveRuns(activeThreadIssueId ?? "__none__"),
    queryFn: () => heartbeatsApi.liveRunsForIssue(activeThreadIssueId!),
    enabled: Boolean(activeThreadIssueId),
    refetchInterval: 3000,
  });

  const activeRunQuery = useQuery({
    queryKey: queryKeys.issues.activeRun(activeThreadIssueId ?? "__none__"),
    queryFn: () => heartbeatsApi.activeRunForIssue(activeThreadIssueId!),
    enabled: Boolean(activeThreadIssueId),
    refetchInterval: 3000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: copilotEnabledForRoute,
  });

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: copilotEnabledForRoute,
  });

  const sendMessage = useMutation({
    mutationFn: async (body: string) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return copilotApi.sendMessage(selectedCompanyId, {
        body,
        context: routeContext,
      });
    },
    onSuccess: async (result) => {
      if (result.wakeup.warning) {
        pushToast({
          title: "Copilot wakeup warning",
          body: result.wakeup.warning,
          tone: "warn",
        });
      }
      const targetIssueId = result.thread.issueId;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(targetIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(targetIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(targetIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(targetIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(targetIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.copilot.history(selectedCompanyId ?? "__none__") }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Unable to send copilot message",
        body: error instanceof Error ? error.message : "Request failed",
        tone: "error",
      });
    },
  });

  const createThread = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return copilotApi.createThread(selectedCompanyId, {
        contextIssueId: contextIssueRef,
      });
    },
    onSuccess: async (thread) => {
      queryClient.setQueryData(threadQueryKey, thread);
      setSelectedThreadIssueId(thread.issueId);
      autoScrolledThreadRef.current = null;
      newestCommentIdRef.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.copilot.thread(selectedCompanyId ?? "__none__") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.copilot.history(selectedCompanyId ?? "__none__") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(thread.issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(thread.issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(thread.issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(thread.issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(thread.issueId) }),
      ]);
      pushToast({
        title: "Started a new copilot chat",
        body: "Older chat history is archived. Scroll up in this thread to load older messages as needed.",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Unable to start a new copilot chat",
        body: error instanceof Error ? error.message : "Request failed",
        tone: "error",
      });
    },
  });

  const cancelRun = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onSuccess: async () => {
      if (!activeThreadIssueId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(activeThreadIssueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(activeThreadIssueId) }),
      ]);
    },
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agentsQuery.data]);

  const timelineEvents = useMemo(
    () => extractIssueTimelineEvents(activityQuery.data),
    [activityQuery.data],
  );

  const comments = useMemo(() => {
    const deduped = new Map<string, IssueComment>();
    for (const page of commentsQuery.data?.pages ?? []) {
      for (const comment of page.comments) {
        if (!deduped.has(comment.id)) {
          deduped.set(comment.id, comment);
        }
      }
    }
    return [...deduped.values()].map((comment) => ({
      ...comment,
      body: stripCopilotContext(comment.body),
    }));
  }, [commentsQuery.data]);

  const newestLoadedCommentId = commentsQuery.data?.pages[0]?.comments[0]?.id ?? null;
  const threadHistory = threadHistoryQuery.data ?? [];
  const activeThreadSummary = useMemo(
    () => threadHistory.find((thread) => thread.issueId === activeThreadIssueId) ?? null,
    [threadHistory, activeThreadIssueId],
  );
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const isViewingHistoryThread = Boolean(
    activeThreadIssueId &&
    threadIssueId &&
    activeThreadIssueId !== threadIssueId,
  );
  const runningRun =
    activeRunQuery.data?.status === "running"
      ? activeRunQuery.data
      : (liveRunsQuery.data ?? []).find((run) => run.status === "running") ?? null;
  const isLoadingThreadBody =
    threadQuery.isLoading || (Boolean(activeThreadIssueId) && commentsQuery.status === "pending");

  useEffect(() => {
    setSelectedThreadIssueId(null);
    autoScrolledThreadRef.current = null;
    newestCommentIdRef.current = null;
  }, [selectedCompanyId, contextIssueRef]);

  useEffect(() => {
    if (!selectedThreadIssueId) return;
    if (selectedThreadIssueId === threadIssueId) return;
    const found = threadHistory.some((thread) => thread.issueId === selectedThreadIssueId);
    if (found) return;
    setSelectedThreadIssueId(null);
  }, [selectedThreadIssueId, threadIssueId, threadHistory]);

  const maybeLoadOlderHistory = useCallback(() => {
    const viewport = resolveViewport();
    if (!viewport || !commentsQuery.hasNextPage || commentsQuery.isFetchingNextPage) return;
    if (viewport.scrollTop > TOP_HISTORY_LOAD_THRESHOLD_PX) return;
    prependRestoreRef.current = {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
    };
    void commentsQuery.fetchNextPage();
  }, [commentsQuery.fetchNextPage, commentsQuery.hasNextPage, commentsQuery.isFetchingNextPage, resolveViewport]);

  useEffect(() => {
    if (!visible) return;
    resolveViewport();
  }, [visible, activeThreadIssueId, resolveViewport]);

  useEffect(() => {
    if (!visible || !activeThreadIssueId) return;
    const viewport = resolveViewport();
    if (!viewport) return;
    const onScroll = () => {
      maybeLoadOlderHistory();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [maybeLoadOlderHistory, resolveViewport, activeThreadIssueId, visible]);

  useEffect(() => {
    if (commentsQuery.isFetchingNextPage) return;
    const restore = prependRestoreRef.current;
    if (!restore) return;
    const viewport = resolveViewport();
    if (!viewport) return;
    viewport.scrollTop = restore.scrollTop + (viewport.scrollHeight - restore.scrollHeight);
    prependRestoreRef.current = null;
  }, [commentsQuery.isFetchingNextPage, commentsQuery.data?.pages.length, resolveViewport]);

  useEffect(() => {
    if (!visible || !activeThreadIssueId || commentsQuery.status !== "success") return;
    if (autoScrolledThreadRef.current !== activeThreadIssueId) {
      autoScrolledThreadRef.current = activeThreadIssueId;
      newestCommentIdRef.current = newestLoadedCommentId;
      requestAnimationFrame(() => {
        scrollToBottom();
      });
      return;
    }
    if (!newestLoadedCommentId) return;
    const previousNewestCommentId = newestCommentIdRef.current;
    newestCommentIdRef.current = newestLoadedCommentId;
    if (!previousNewestCommentId || previousNewestCommentId === newestLoadedCommentId) return;

    const viewport = resolveViewport();
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
    if (distanceFromBottom <= BOTTOM_STICKY_THRESHOLD_PX) {
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [
    commentsQuery.status,
    commentsQuery.dataUpdatedAt,
    newestLoadedCommentId,
    resolveViewport,
    scrollToBottom,
    activeThreadIssueId,
    visible,
  ]);

  if (!copilotEnabledForRoute) return null;

  return (
    <aside
      className={cn(
        "hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out",
        visible ? "w-[420px]" : "w-12",
      )}
    >
      {!visible ? (
        <div className="flex h-full items-start justify-center pt-2">
          <Button
            variant="ghost"
            size="icon-xs"
            title="Open board copilot"
            onClick={() => {
              setVisible(true);
              writePreference(true);
            }}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex h-full min-w-[420px] flex-col">
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Board Copilot</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-7 px-2 text-[11px]"
                    disabled={threadHistoryQuery.isLoading}
                    title="Chat history"
                  >
                    <History className="mr-1 h-3.5 w-3.5" />
                    History
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>Chat history</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      if (threadIssueId) setSelectedThreadIssueId(threadIssueId);
                    }}
                    disabled={!threadIssueId}
                  >
                    {activeThreadIssueId === threadIssueId ? <Check className="h-3.5 w-3.5" /> : null}
                    <div className="min-w-0">
                      <p className="truncate font-medium">Current chat</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {threadIssueId ? "Active priority thread" : "No active chat"}
                      </p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {threadHistory.filter((thread) => thread.issueId !== threadIssueId).length === 0 ? (
                    <DropdownMenuItem disabled>
                      <div className="min-w-0">
                        <p className="truncate font-medium">No chat history yet</p>
                      </div>
                    </DropdownMenuItem>
                  ) : (
                    threadHistory
                      .filter((thread) => thread.issueId !== threadIssueId)
                      .map((thread) => (
                      <DropdownMenuItem
                        key={thread.issueId}
                        onClick={() => setSelectedThreadIssueId(thread.issueId)}
                      >
                        {activeThreadIssueId === thread.issueId ? <Check className="h-3.5 w-3.5" /> : null}
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {thread.issueIdentifier ?? thread.issueId.slice(0, 8)} · {threadHistoryLabel(thread)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {thread.issueTitle}
                          </p>
                        </div>
                      </DropdownMenuItem>
                      ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={createThread.isPending || threadQuery.isLoading}
                onClick={() => createThread.mutate()}
              >
                <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
                {createThread.isPending ? "Starting..." : "New chat"}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Collapse board copilot"
                onClick={() => {
                  setVisible(false);
                  writePreference(false);
                }}
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Context: {contextLabel(routeContext.pageKind, routeContext.entityType, routeContext.entityId)}
            </div>
            {activeThreadSummary ? (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Chat: {threadHistoryLabel(activeThreadSummary)} · Updated {formatShortDate(activeThreadSummary.updatedAt)}
              </div>
            ) : null}
          </div>

          <div ref={scrollHostRef} className="flex-1 min-h-0">
            <ScrollArea className="h-full">
              <div className="p-3">
                {activeThreadIssueId && commentsQuery.hasNextPage ? (
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Older messages are hidden by default. Scroll up to load history.
                  </p>
                ) : null}
                {commentsQuery.isFetchingNextPage ? (
                  <p className="mb-2 text-[11px] text-muted-foreground">Loading older messages…</p>
                ) : null}
                {isLoadingThreadBody ? (
                  <p className="text-xs text-muted-foreground">Preparing copilot thread…</p>
                ) : threadQuery.error ? (
                  <p className="text-xs text-destructive">
                    {threadQuery.error instanceof Error ? threadQuery.error.message : "Failed to load copilot thread"}
                  </p>
                ) : !activeThreadIssueId ? (
                  <p className="text-xs text-muted-foreground">No thread available.</p>
                ) : (
                  <IssueChatThread
                    comments={comments}
                    linkedRuns={runsQuery.data ?? []}
                    timelineEvents={timelineEvents}
                    liveRuns={liveRunsQuery.data ?? []}
                    activeRun={activeRunQuery.data ?? null}
                    companyId={selectedCompanyId}
                    issueStatus={activeThreadSummary?.issueStatus ?? threadQuery.data?.issueStatus}
                    agentMap={agentMap}
                    currentUserId={currentUserId}
                    draftKey={`paperclip:board-copilot-draft:${activeThreadIssueId}`}
                    emptyMessage="Ask the board copilot to review this page, summarize status, or clean up board state."
                    submitHotkey="enter"
                    composerDisabledReason={
                      isViewingHistoryThread
                        ? "Viewing chat history. Switch to the current chat or start a new chat to send messages."
                        : null
                    }
                    onAdd={async (body) => {
                      if (isViewingHistoryThread) return;
                      await sendMessage.mutateAsync(body);
                    }}
                    onCancelRun={
                      !isViewingHistoryThread && runningRun
                        ? async () => cancelRun.mutateAsync(runningRun.id)
                        : undefined
                    }
                  />
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </aside>
  );
}
