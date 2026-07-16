import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { boardChatApi } from "../api/boardChat";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Activity, AlertCircle, Check, Copy, History, Loader2, MessageSquarePlus } from "lucide-react";
import { ActivityFeed } from "../components/ActivityFeed";
import { AssistantChat } from "../components/AssistantChat";
import { cn, relativeTime } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import { AGENT_ROLE_LABELS, type Agent, type Issue } from "@paperclipai/shared";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Conference Room — the board user's live conversation with the real company
 * CEO (PAP-11099). The room is backed by an ordinary company-scoped
 * `board_chat` issue (so history survives reloads) and the conversation runs
 * over the reusable {@link AssistantChat} surface: durable history is the
 * issue's comments, live output is the target agent's active run, and
 * next-step choices are real issue-thread interactions. Sending wakes the real
 * agent (default CEO) — no board-concierge persona.
 */
/** Hit zone to the right of the 1px line (line sits on chat pane’s right edge). */
const SPLIT_DIVIDER_PX = 12;
const SPLIT_MIN_PANE_PX = 280;
/** Chat pane share of width below the divider (agent feed gets the rest). */
const DEFAULT_CHAT_FRACTION = 2 / 3;

const BOARD_CHAT_ISSUE_TITLE = "Board Operations";
const BOARD_CHAT_ORIGIN_KIND = "board_chat";
const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

const boardChatHistoryDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatBoardChatHistoryDate(value: Date | string | null | undefined): string {
  if (!value) return "recent chat";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recent chat";
  return boardChatHistoryDateFormatter.format(date);
}

function boardChatHistoryLabel(issue: Pick<Issue, "title" | "createdAt" | "updatedAt">): string {
  if (!issue.title || issue.title === BOARD_CHAT_ISSUE_TITLE || issue.title === "New chat") {
    return `Chat from ${formatBoardChatHistoryDate(issue.createdAt ?? issue.updatedAt)}`;
  }
  return issue.title;
}

function boardChatHistoryAgentLabel(
  issue: Pick<Issue, "originId" | "originKind">,
  agentsById: Map<string, Agent>,
  fallbackAgent: Agent | null,
): string | null {
  const targetAgent =
    issue.originKind === BOARD_CHAT_ORIGIN_KIND && issue.originId
      ? agentsById.get(issue.originId) ?? null
      : null;
  const agent = targetAgent ?? fallbackAgent;
  if (!agent) return null;
  const role = roleLabels[agent.role] ?? agent.role;
  return `${agent.name} · ${role}`;
}

function boardChatConversationRef(issue: Pick<Issue, "id" | "identifier">): string {
  return issue.identifier || issue.id;
}

function boardChatUnavailableMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "cancelled":
      return "This Conference Room chat was cancelled and is no longer available.";
    case "wrong_company":
      return "This chat does not belong to the selected company.";
    case "wrong_kind":
      return "This link points to an issue, but it is not a Conference Room chat.";
    case "not_found":
      return "This Conference Room chat could not be found.";
    default:
      return "This Conference Room chat is unavailable.";
  }
}

export function BoardChat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { conversationRef } = useParams<{ conversationRef?: string }>();

  useEffect(() => {
    setBreadcrumbs([{ label: "Conference Room" }]);
  }, [setBreadcrumbs]);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [chatPaneFraction, setChatPaneFraction] = useState(DEFAULT_CHAT_FRACTION);
  const splitDragging = useRef(false);

  useLayoutEffect(() => {
    const el = splitContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerWidth = Math.max(0, containerWidth - SPLIT_DIVIDER_PX);
  const splitLowerPx = SPLIT_MIN_PANE_PX;
  const splitUpperPx = innerWidth - SPLIT_MIN_PANE_PX;
  const minChatFraction =
    innerWidth > 0 ? Math.min(1, SPLIT_MIN_PANE_PX / innerWidth) : 0;
  const maxChatFraction =
    innerWidth > 0 ? Math.max(0, 1 - SPLIT_MIN_PANE_PX / innerWidth) : 1;
  const leftPaneWidth =
    innerWidth > 0
      ? splitUpperPx < splitLowerPx
        ? Math.max(0, Math.round(innerWidth / 2))
        : Math.round(
            innerWidth *
              Math.min(
                maxChatFraction,
                Math.max(minChatFraction, chatPaneFraction),
              ),
          )
      : 0;

  const handleSplitDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      splitDragging.current = true;
      const startX = e.clientX;
      const startWidth = leftPaneWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!splitDragging.current) return;
        const containerW = splitContainerRef.current?.clientWidth ?? containerWidth;
        const inner = containerW - SPLIT_DIVIDER_PX;
        const lower = SPLIT_MIN_PANE_PX;
        const upper = inner - SPLIT_MIN_PANE_PX;
        const next = startWidth + ev.clientX - startX;
        if (inner <= 0) return;
        if (upper < lower) {
          setChatPaneFraction(0.5);
        } else {
          const clamped = Math.min(upper, Math.max(lower, next));
          setChatPaneFraction(clamped / inner);
        }
      };

      const onMouseUp = () => {
        splitDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [containerWidth, leftPaneWidth],
  );

  const [boardIssueId, setBoardIssueId] = useState<string | null>(null);
  const [localBoardIssue, setLocalBoardIssue] = useState<Issue | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  /** Guards the resolve-or-create endpoint against overlapping calls. */
  const mintingRef = useRef(false);
  const [mobileFeedOpen, setMobileFeedOpen] = useState(false);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = useMemo(
    () => agents?.find((a) => a.role === "ceo" && a.status !== "terminated"),
    [agents],
  );
  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent] as const)),
    [agents],
  );

  // Conference Room conversations are backed by ordinary company-scoped
  // `board_chat` issues so history survives reloads without a separate store.
  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "board-chat-history"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        originKind: BOARD_CHAT_ORIGIN_KIND,
        limit: 50,
        sortField: "updated",
        sortDir: "desc",
      }),
    enabled: !!selectedCompanyId,
  });

  const boardChatIssues = useMemo(
    () =>
      (issues ?? [])
        .filter(
          (i) =>
            i.originKind === BOARD_CHAT_ORIGIN_KIND &&
            i.status !== "cancelled",
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [issues],
  );

  const { data: directConversation } = useQuery({
    queryKey: ["board-chat-conversation", selectedCompanyId, conversationRef],
    queryFn: () => boardChatApi.getConversation(selectedCompanyId!, conversationRef!),
    enabled: !!selectedCompanyId && !!conversationRef,
    retry: false,
    staleTime: 30_000,
  });

  const directBoardIssue = directConversation?.issue ?? null;

  const activeBoardIssue = useMemo(
    () =>
      boardChatIssues.find((issue) => issue.id === boardIssueId) ??
      (localBoardIssue?.id === boardIssueId ? localBoardIssue : null) ??
      (directBoardIssue?.id === boardIssueId ? directBoardIssue : null),
    [boardChatIssues, boardIssueId, localBoardIssue, directBoardIssue],
  );

  const historyQueryKey = useMemo(
    () =>
      selectedCompanyId
        ? [...queryKeys.issues.list(selectedCompanyId), "board-chat-history"]
        : null,
    [selectedCompanyId],
  );

  // Resolve-or-create the backing board_chat issue. The web client can't mint
  // it directly (the create schema strips `originKind`), so the server owns it.
  const boardChatPath = useCallback(
    (issue: Pick<Issue, "id" | "identifier">) => {
      const prefix = selectedCompany?.issuePrefix || issue.identifier?.split("-")[0] || null;
      const path = `/board-chat/${boardChatConversationRef(issue)}`;
      return prefix ? `/${prefix}${path}` : path;
    },
    [selectedCompany],
  );

  const ensureConversation = useCallback(
    async (opts?: { newConversation?: boolean; replace?: boolean }) => {
      if (!selectedCompanyId || mintingRef.current) return;
      mintingRef.current = true;
      setMinting(true);
      setMintError(null);
      try {
        const { issue } = await boardChatApi.resolveConversation(
          selectedCompanyId,
          opts?.newConversation ? { newConversation: true } : undefined,
        );
        setBoardIssueId(issue.id);
        setLocalBoardIssue(issue);
        queryClient.setQueryData(
          ["board-chat-conversation", selectedCompanyId, boardChatConversationRef(issue)],
          { issue, unavailableReason: null },
        );
        navigate(boardChatPath(issue), { replace: opts?.replace ?? false });
        if (historyQueryKey) {
          await queryClient.invalidateQueries({ queryKey: historyQueryKey });
        }
      } catch (err) {
        setMintError(
          err instanceof Error
            ? err.message
            : "Couldn't open the Conference Room. Please try again.",
        );
      } finally {
        mintingRef.current = false;
        setMinting(false);
      }
    },
    [selectedCompanyId, historyQueryKey, queryClient, navigate, boardChatPath],
  );

  // Reset the active conversation when the company changes; the resolve effect
  // below re-anchors (or mints) for the newly selected company.
  const prevCompanyRef = useRef(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyRef.current !== selectedCompanyId) {
      setBoardIssueId(null);
      setLocalBoardIssue(null);
      setHistoryOpen(false);
      setMintError(null);
      setCopiedLink(false);
      prevCompanyRef.current = selectedCompanyId;
    }
  }, [selectedCompanyId]);

  // The default room URL is only an entry point. Once history loads, replace it
  // with the latest non-cancelled conversation, or mint the first one and
  // replace to that canonical URL.
  useEffect(() => {
    if (!selectedCompanyId || conversationRef || !issues) return;
    if (localBoardIssue && localBoardIssue.id === boardIssueId) {
      navigate(boardChatPath(localBoardIssue), { replace: true });
      return;
    }
    if (boardChatIssues.length > 0) {
      const latest = boardChatIssues[0] ?? null;
      if (!latest) return;
      setBoardIssueId(latest.id);
      setLocalBoardIssue(null);
      navigate(boardChatPath(latest), { replace: true });
      return;
    }
    void ensureConversation({ replace: true });
  }, [
    selectedCompanyId,
    conversationRef,
    issues,
    boardChatIssues,
    localBoardIssue,
    boardIssueId,
    ensureConversation,
    navigate,
    boardChatPath,
  ]);

  useEffect(() => {
    if (!selectedCompanyId || conversationRef || !localBoardIssue) return;
    if (localBoardIssue.id !== boardIssueId) return;
    navigate(boardChatPath(localBoardIssue), { replace: true });
  }, [
    selectedCompanyId,
    conversationRef,
    localBoardIssue,
    boardIssueId,
    navigate,
    boardChatPath,
  ]);

  useEffect(() => {
    if (!conversationRef || !directConversation) return;
    if (directConversation.issue) {
      const issue = directConversation.issue;
      setMintError(null);
      setBoardIssueId(issue.id);
      setLocalBoardIssue(issue);
      const canonicalRef = boardChatConversationRef(issue);
      if (conversationRef !== canonicalRef) {
        navigate(boardChatPath(issue), { replace: true });
      }
      return;
    }
    setBoardIssueId(null);
    setLocalBoardIssue(null);
    setMintError(null);
  }, [conversationRef, directConversation, navigate, boardChatPath]);

  const handleNewChat = useCallback(() => {
    if (minting) return;
    setHistoryOpen(false);
    void ensureConversation({ newConversation: true });
  }, [minting, ensureConversation]);

  const handleSelectConversation = useCallback((issue: Issue) => {
    setBoardIssueId(issue.id);
    setLocalBoardIssue(issue);
    setHistoryOpen(false);
    setMintError(null);
    if (selectedCompanyId) {
      queryClient.setQueryData(
        ["board-chat-conversation", selectedCompanyId, boardChatConversationRef(issue)],
        { issue, unavailableReason: null },
      );
    }
    navigate(boardChatPath(issue));
  }, [selectedCompanyId, queryClient, navigate, boardChatPath]);

  const currentChatUrl = useMemo(() => {
    if (!activeBoardIssue || typeof window === "undefined") return null;
    return new URL(boardChatPath(activeBoardIssue), window.location.origin).toString();
  }, [activeBoardIssue, boardChatPath]);

  const handleCopyLink = useCallback(() => {
    if (!currentChatUrl) return;
    void copyTextToClipboard(currentChatUrl).then(() => {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1500);
    });
  }, [currentChatUrl]);

  const refreshBoardChatHistory = useCallback(async () => {
    if (!historyQueryKey) return;
    await queryClient.invalidateQueries({ queryKey: historyQueryKey });
  }, [historyQueryKey, queryClient]);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">No company selected</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Select a company to start chatting with your CEO.
          </p>
        </div>
      </div>
    );
  }

  const defaultRouteRedirect =
    !conversationRef && activeBoardIssue ? (
      <Navigate to={boardChatPath(activeBoardIssue)} replace />
    ) : null;

  return (
    <>
      {defaultRouteRedirect}
      <div
        data-testid="board-chat-shell"
        className="flex h-(--sz-calc-43) flex-col -m-4 md:h-(--sz-calc-29) md:-m-6"
      >
        <div
          ref={splitContainerRef}
          className="flex min-h-0 min-w-0 flex-1 flex-row"
        >
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 shrink-0 flex-col bg-background",
              "w-full md:w-auto",
              innerWidth <= 0 && "md:w-2/3",
            )}
            style={
              innerWidth > 0 && containerWidth >= 2 * SPLIT_MIN_PANE_PX + SPLIT_DIVIDER_PX
                ? { width: leftPaneWidth }
                : undefined
            }
          >
            <div className="relative flex shrink-0 items-center justify-between gap-2 px-4 py-2">
              <p className="min-w-0 truncate text-xs text-muted-foreground">
                {activeBoardIssue
                  ? `${selectedCompany?.name ?? "Your company"} · updated ${relativeTime(activeBoardIssue.updatedAt)}`
                  : selectedCompany?.name ?? "Your company"}
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="chat history"
                      onClick={() => setHistoryOpen(true)}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">chat history</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="copy chat link"
                      onClick={handleCopyLink}
                      disabled={!currentChatUrl}
                    >
                      {copiedLink ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">copy chat link</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="new chat"
                      onClick={handleNewChat}
                      disabled={minting}
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">new chat</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetContent side="right" className="w-(--sz-calc-46) p-0 sm:max-w-md">
                <SheetHeader className="border-b px-4 py-3">
                  <SheetTitle className="text-sm">Chat history</SheetTitle>
                  <SheetDescription>
                    Pick up a previous CEO conversation.
                  </SheetDescription>
                </SheetHeader>
                <div className="min-h-0 overflow-y-auto py-2">
                  <div className="px-3 pb-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-start"
                      onClick={handleNewChat}
                      disabled={minting}
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                      New chat
                    </Button>
                  </div>
                  {boardChatIssues.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No previous chats yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {boardChatIssues.map((issue) => {
                        const active = issue.id === boardIssueId;
                        const label = boardChatHistoryLabel(issue);
                        const agentLabel = boardChatHistoryAgentLabel(
                          issue,
                          agentsById,
                          ceoAgent ?? null,
                        );
                        return (
                          <button
                            key={issue.id}
                            type="button"
                            className={cn(
                              "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
                              active && "bg-accent/70",
                            )}
                            onClick={() => handleSelectConversation(issue)}
                            disabled={active}
                          >
                            <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {label}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {agentLabel ? `${agentLabel} · ` : ""}updated{" "}
                                {relativeTime(issue.updatedAt)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>

            {directConversation && !directConversation.issue ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <div
                  role="alert"
                  className="flex max-w-md items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="break-words">
                    {boardChatUnavailableMessage(directConversation.unavailableReason)}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/board-chat", { replace: true })}
                >
                  Open latest chat
                </Button>
              </div>
            ) : boardIssueId ? (
              <AssistantChat
                key={boardIssueId}
                issueId={boardIssueId}
                companyId={selectedCompanyId}
                agents={agents}
                targetAgentId={ceoAgent?.id ?? null}
                showAgentSwitcher={false}
                companyName={selectedCompany?.name ?? null}
                currentUserId={currentUserId}
                onMessageSent={refreshBoardChatHistory}
                className="min-h-0 flex-1"
              />
            ) : mintError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{mintError}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void ensureConversation()}
                  disabled={minting}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2
                  className="h-5 w-5 animate-spin"
                  aria-label="Opening the Conference Room"
                />
              </div>
            )}
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize board chat and agent feed"
            className="group relative hidden w-3 shrink-0 cursor-col-resize bg-background md:flex"
            onMouseDown={handleSplitDragStart}
          >
            <div
              className="pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-border transition-colors group-hover:bg-foreground/20"
              aria-hidden
            />
          </div>

          <div className="hidden md:flex md:min-h-0 md:min-w-0 md:flex-1">
            <ActivityFeed />
          </div>
        </div>

        <div className="md:hidden">
          <Sheet open={mobileFeedOpen} onOpenChange={setMobileFeedOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="fixed bottom-(--sz-calc-45) right-4 z-20 h-10 w-10 rounded-full shadow-lg"
                aria-label="Open agent feed"
              >
                <Activity className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="h-(--sz-70vh) p-0 rounded-t-xl">
              <ActivityFeed />
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </>
  );
}
