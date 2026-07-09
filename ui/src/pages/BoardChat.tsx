import { useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  type ThreadMessage,
} from "@assistant-ui/react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogState } from "../context/DialogContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { heartbeatsApi } from "../api/heartbeats";
import { activityApi, type RunForIssue } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Activity, ArrowDown, History, MessageSquarePlus, Search } from "lucide-react";
import { ActivityFeed } from "../components/ActivityFeed";
import {
  type MarkdownEditorRef,
  type MentionOption,
} from "../components/MarkdownEditor";
import {
  AgentBubbleActionRow,
  agentBubbleDateLabel,
} from "../components/AgentBubbleActionRow";
import { AgentIcon } from "../components/AgentIconPicker";
import { usePaperclipIssueRuntime } from "../hooks/usePaperclipIssueRuntime";
import { cn, formatDateTime, visibleRunCostUsd } from "../lib/utils";
import type { FeedbackVoteValue, IssueComment } from "@paperclipai/shared";
import type { BoardChatMessageResponse } from "@paperclipai/shared";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { BoardChatComposer } from "./board-chat/BoardChatComposer";
import { BoardChatHitlCards } from "./board-chat/BoardChatHitlCards";
import {
  BoardChatTurnNotFoundError,
  fetchBoardChatTurn,
  isTerminalHostRunStatus,
} from "./board-chat/board-chat-turn";

/**
 * Conference Room — issue-backed chat aligned with Issue chat UX
 * (assistant-ui shell + attachments) and silent-until-@ / host_run wake.
 */
/** Hit zone to the right of the 1px line (line sits on chat pane’s right edge). */
const SPLIT_DIVIDER_PX = 12;
const SPLIT_MIN_PANE_PX = 280;
/** Chat pane share of width below the divider (agent feed gets the rest). */
const DEFAULT_CHAT_FRACTION = 2 / 3;

/** sessionStorage key for the Board Operations issue id (also read by LiveUpdates). */
export function boardIssueCacheKey(companyId: string) {
  return `paperclip.boardChat.boardIssueId.${companyId}`;
}


/** Wrapped markdown in bubbles; pre/table scroll horizontally when needed. */
const BOARD_CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

/** User bubble markdown — inverted prose for legibility on blue accent. */
const USER_BUBBLE_MARKDOWN_CLASS = cn(
  BOARD_CHAT_MARKDOWN_CLASS,
  "prose-invert text-sm leading-6",
);

const boardChatBubbleShell =
  "min-w-0 max-w-[85%] break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible";

/** First-letter(s) fallback for an agent with no icon. */
function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()) || "A";
}

/**
 * Icon-adjacent-to-name header rendered directly above an agent bubble —
 * the shared `[agent icon][agent name]` convention (PAP-105 / PAP-97).
 */
function AgentBubbleHeader({ name, icon }: { name: string; icon: string | null }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-1">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>
          {icon ? (
            <AgentIcon icon={icon} className="h-3.5 w-3.5" />
          ) : (
            agentInitials(name)
          )}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium text-foreground">{name}</span>
    </div>
  );
}

/** Agent-styled chat bubble containing the three-dot typing indicator. */
function TypingBubble({ label, elapsedSec }: { label?: string; elapsedSec?: number }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {label ? (
        <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
          <img src="/paperclip-thinking.svg" alt="" className="inline-block shrink-0" style={{ width: 14, height: 14 }} />
          <span>{label}</span>
          {elapsedSec != null && elapsedSec > 0 ? (
            <span className="opacity-50">{elapsedSec.toFixed(1)}s</span>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-start">
        <div
          className={cn(
            boardChatBubbleShell,
            "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
          )}
        >
          <span className="typing-dots" aria-label="digitando">
            <span />
            <span />
            <span />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Owns the 100ms elapsed timer so parent message list does not re-render on ticks. */
function TypingBubbleWithTimer({ active, label }: { active: boolean; label?: string }) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const timerId = setInterval(() => {
      setElapsedSec((Date.now() - startedAt) / 1000);
    }, 100);
    return () => clearInterval(timerId);
  }, [active]);

  if (!active) return null;
  return <TypingBubble label={label} elapsedSec={elapsedSec} />;
}

function commentToThreadMessage(comment: IssueComment): ThreadMessage {
  const isUser =
    !comment.authorAgentId && comment.authorUserId !== "board-concierge";
  const createdAt = new Date(comment.createdAt);
  if (isUser) {
    return {
      id: comment.id,
      role: "user",
      createdAt,
      content: [{ type: "text", text: comment.body ?? "" }],
      attachments: [],
      metadata: { custom: {} },
    } as ThreadMessage;
  }
  return {
    id: comment.id,
    role: "assistant",
    createdAt,
    content: [{ type: "text", text: comment.body ?? "" }],
    status: { type: "complete", reason: "stop" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {
        authorAgentId: comment.authorAgentId ?? null,
        runId: comment.createdByRunId ?? null,
      },
    },
  } as ThreadMessage;
}

function formatCostPill(costUsd: number | null | undefined): string | null {
  if (costUsd == null || !Number.isFinite(costUsd)) return null;
  if (costUsd <= 0) return null;
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}

function runForIssueToCostLookup(runs: RunForIssue[] | undefined) {
  if (!runs) return {} as Record<string, RunForIssue>;
  return Object.fromEntries(runs.map((run) => [run.runId, run]));
}

export function BoardChat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

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

  const handleSplitKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = 0.03;
      const delta = e.key === "ArrowLeft" ? -step : step;
      setChatPaneFraction((prev) => {
        const next = prev + delta;
        const lower = Math.max(0.2, minChatFraction);
        const upper = Math.min(0.8, maxChatFraction);
        if (upper < lower) return 0.5;
        return Math.min(upper, Math.max(lower, next));
      });
    },
    [maxChatFraction, minChatFraction],
  );

  const [input, setInput] = useState("");
  const inputRef = useRef("");
  /** Guards the draft-persistence effect so it doesn't overwrite a saved
   *  draft with "" before we've had a chance to load it. */
  const loadedDraftCompanyRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [hostRunId, setHostRunId] = useState<string | null>(null);
  const [hostAgentId, setHostAgentId] = useState<string | null>(null);
  /** Fan-out MVP: multiple parallel wakes; empty when single host_run / idle. */
  const [fanoutHostRuns, setFanoutHostRuns] = useState<
    Array<{ agentId: string; runId: string }>
  >([]);
  const [hostRoomMessageId, setHostRoomMessageId] = useState<string | null>(null);
  const [turnPollAvailable, setTurnPollAvailable] = useState(true);
  const [turnCostByRunId, setTurnCostByRunId] = useState<Record<string, number>>({});
  const [boardIssueId, setBoardIssueId] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasRestoredScrollRef = useRef(false);
  const composerRef = useRef<MarkdownEditorRef>(null);

  /** True when the user is scrolled away from the bottom AND new content
   *  has arrived they can't see. Drives the floating "jump to latest" chip. */
  const [hasNewBelow, setHasNewBelow] = useState(false);

  /** Tracks whether the user was near the bottom BEFORE the latest content
   *  change. Updated on scroll events (and after programmatic scrolls) so
   *  that when a tall new message inflates scrollHeight, we still know the
   *  user's pre-update position and can decide whether to auto-scroll. */
  const wasNearBottomRef = useRef(true);

  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onVisibilityChange = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    wasNearBottomRef.current = true;
    setHasNewBelow(false);
  }, []);

  // Welcome typing intro: staged reveal of typing → welcome bubble → chips.
  // The timers don't start until the data needed to render the welcome is
  // actually loaded, so the animation plays at the moment the user arrives
  // at the chat (e.g. right after creating a new company) rather than
  // burning off while a spinner is on screen.
  const [welcomeRevealed, setWelcomeRevealed] = useState(false);
  const [chipsRevealed, setChipsRevealed] = useState(false);

  // Reset state and clear cached comments when company changes. The
  // composer draft is NOT wiped — it's loaded from per-company
  // sessionStorage in the effect below so users don't lose typed content
  // when switching between companies or navigating away and back.
  const prevCompanyRef = useRef(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyRef.current !== selectedCompanyId) {
      if (boardIssueId) {
        queryClient.removeQueries({ queryKey: queryKeys.issues.comments(boardIssueId) });
        queryClient.removeQueries({ queryKey: queryKeys.issues.interactions(boardIssueId) });
      }
      setBoardIssueId(null);
      setStreamingText("");
      setStatusText("");
      setSending(false);
      setOptimisticMessage(null);
      prevCompanyRef.current = selectedCompanyId;
    }
  }, [selectedCompanyId, boardIssueId, queryClient]);

  // Load a saved composer draft (if any) whenever the active company
  // changes — runs on first mount too.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (loadedDraftCompanyRef.current === selectedCompanyId) return;
    try {
      const saved = sessionStorage.getItem(
        `paperclip.boardChat.draft.${selectedCompanyId}`,
      );
      setInput(saved ?? "");
      inputRef.current = saved ?? "";
    } catch {
      setInput("");
      inputRef.current = "";
    }
    loadedDraftCompanyRef.current = selectedCompanyId;
  }, [selectedCompanyId]);

  // Persist composer draft to sessionStorage on change (per company).
  // Only runs after the initial load for this company to avoid clobbering
  // a saved draft with an empty initial value.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (loadedDraftCompanyRef.current !== selectedCompanyId) return;
    try {
      const key = `paperclip.boardChat.draft.${selectedCompanyId}`;
      if (input) {
        sessionStorage.setItem(key, input);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch { /* sessionStorage unavailable */ }
  }, [input, selectedCompanyId]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = useMemo(
    () => agents?.find((a) => a.role === "ceo" && a.status !== "terminated"),
    [agents],
  );

  /** Agent used to prefix NUX chip prompts with a structured @mention. */
  const chipMentionAgent = useMemo(() => {
    if (ceoAgent) return ceoAgent;
    return agents?.find((a) => a.status !== "terminated") ?? null;
  }, [agents, ceoAgent]);

  // Pull the company's top-level goal so the CEO's welcome can reference
  // the mission verbatim.
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const missionText = useMemo(() => {
    const active = (goals ?? []).find((g) => g.status === "active");
    return active?.title ?? null;
  }, [goals]);

  // Load cached Board Operations issue id when company changes (fallback if search misses).
  useEffect(() => {
    if (!selectedCompanyId) return;
    try {
      const cached = sessionStorage.getItem(boardIssueCacheKey(selectedCompanyId));
      if (cached) setBoardIssueId(cached);
    } catch { /* sessionStorage unavailable */ }
  }, [selectedCompanyId]);

  // Find Board Operations via conference_room origin; fall back to title search.
  const { data: boardOpsIssues } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "board-ops",
      "conference_room",
      selectedCompanyId,
    ],
    queryFn: async () => {
      const byOrigin = await issuesApi.list(selectedCompanyId!, {
        originKind: "conference_room",
        originId: selectedCompanyId!,
        limit: 50,
      });
      if (byOrigin.length > 0) return byOrigin;
      return issuesApi.list(selectedCompanyId!, { q: "Board Operations", limit: 50 });
    },
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!selectedCompanyId || !boardOpsIssues) return;
    const isOpen = (status: string) => status !== "done" && status !== "cancelled";
    const boardIssue =
      boardOpsIssues.find(
        (i) =>
          isOpen(i.status) &&
          typeof i.originKind === "string" &&
          i.originKind === "conference_room" &&
          i.originId === selectedCompanyId,
      ) ??
      boardOpsIssues.find(
        (i) => isOpen(i.status) && i.title === "Board Operations",
      );
    if (boardIssue?.id) {
      setBoardIssueId(boardIssue.id);
      try {
        sessionStorage.setItem(boardIssueCacheKey(selectedCompanyId), boardIssue.id);
      } catch { /* sessionStorage unavailable */ }
    }
  }, [boardOpsIssues, selectedCompanyId]);

  const isFanoutTracking = fanoutHostRuns.length > 0;
  const trackedRunIds = isFanoutTracking
    ? fanoutHostRuns.map((run) => run.runId)
    : hostRunId
      ? [hostRunId]
      : [];
  const hasTrackedRuns = trackedRunIds.length > 0;

  // Fan-out uses liveRuns (turn endpoint returns a single host run).
  const useTurnPollPath =
    turnPollAvailable && Boolean(hostRoomMessageId) && !isFanoutTracking;

  const { data: hostTurn, error: hostTurnError } = useQuery({
    queryKey: ["board-chat-turn", selectedCompanyId, hostRoomMessageId],
    queryFn: () => fetchBoardChatTurn(hostRoomMessageId!, selectedCompanyId!),
    enabled: Boolean(
      selectedCompanyId &&
        hostRoomMessageId &&
        hostRunId &&
        !isFanoutTracking &&
        turnPollAvailable &&
        pageVisible,
    ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && isTerminalHostRunStatus(status)) return false;
      return hostRunId && !isFanoutTracking ? 2000 : false;
    },
    retry: false,
  });

  useEffect(() => {
    if (hostTurnError instanceof BoardChatTurnNotFoundError) {
      setTurnPollAvailable(false);
    }
  }, [hostTurnError]);

  // Fetch comments for the board issue
  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(boardIssueId ?? ""),
    queryFn: () => issuesApi.listComments(boardIssueId!, { limit: 100 }),
    enabled: !!boardIssueId,
    refetchInterval: pageVisible
      ? hasTrackedRuns
        ? useTurnPollPath
          ? false
          : 5000
        : 30000
      : false,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(boardIssueId ?? ""),
    queryFn: () => heartbeatsApi.liveRunsForIssue(boardIssueId!),
    enabled: !!boardIssueId && hasTrackedRuns && !useTurnPollPath,
    refetchInterval: hasTrackedRuns && pageVisible && !useTurnPollPath ? 2000 : false,
  });

  const hostLiveRun = useMemo(
    () => (liveRuns ?? []).find((run) => run.id === hostRunId) ?? null,
    [liveRuns, hostRunId],
  );

  const fanoutLiveById = useMemo(() => {
    if (!isFanoutTracking) return new Map<string, NonNullable<typeof liveRuns>[number]>();
    return new Map((liveRuns ?? []).map((run) => [run.id, run] as const));
  }, [isFanoutTracking, liveRuns]);

  const hostRunActive = useTurnPollPath
    ? Boolean(hostTurn && !isTerminalHostRunStatus(hostTurn.status))
    : isFanoutTracking
      ? fanoutHostRuns.some((tracked) => {
          const run = fanoutLiveById.get(tracked.runId);
          if (!run) return true;
          return !isTerminalHostRunStatus(run.status);
        })
      : Boolean(
          hostLiveRun &&
            (hostLiveRun.status === "queued" ||
              hostLiveRun.status === "running" ||
              hostLiveRun.status === "starting"),
        );

  const sortedComments = useMemo(
    () =>
      (comments ?? [])
        .slice()
        .sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [comments],
  );

  const userHasReplied = useMemo(
    () =>
      sortedComments.some(
        (c) => !c.authorAgentId && c.authorUserId !== "board-concierge",
      ),
    [sortedComments],
  );

  const showWelcomeIntro = sortedComments.length === 0 && !userHasReplied;

  const { data: issueRuns } = useQuery({
    queryKey: queryKeys.issues.runs(boardIssueId ?? ""),
    queryFn: () => activityApi.runsForIssue(boardIssueId!),
    enabled: !!boardIssueId,
    staleTime: 8_000,
    refetchInterval:
      hasTrackedRuns && pageVisible && !useTurnPollPath ? 5000 : false,
  });

  const runById = useMemo(() => runForIssueToCostLookup(issueRuns), [issueRuns]);

  const { data: hostRunDetail } = useQuery({
    queryKey: ["board-chat-host-run", hostRunId],
    queryFn: () => heartbeatsApi.get(hostRunId!),
    enabled: !!hostRunId && !isFanoutTracking && !useTurnPollPath,
    refetchInterval:
      hostRunId && !isFanoutTracking && pageVisible && !useTurnPollPath ? 2000 : false,
  });

  const clearTrackedWakeState = useCallback(() => {
    setHostRunId(null);
    setHostAgentId(null);
    setFanoutHostRuns([]);
    setHostRoomMessageId(null);
    setSending(false);
    setStatusText("");
  }, []);

  const finalizeHostRun = useCallback(
    (trackedStatus: string, trackedRunId?: string, costUsd?: number | null) => {
      clearTrackedWakeState();
      if (
        trackedRunId &&
        costUsd != null &&
        Number.isFinite(costUsd) &&
        costUsd > 0
      ) {
        setTurnCostByRunId((prev) => ({ ...prev, [trackedRunId]: costUsd }));
      }
      if (trackedStatus !== "succeeded") {
        setErrorText(
          `A run do agente terminou com status ${trackedStatus}. Abra o detalhe da run para mais informações.`,
        );
      }
      if (boardIssueId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.comments(boardIssueId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.runs(boardIssueId),
        });
      }
    },
    [boardIssueId, clearTrackedWakeState, queryClient],
  );

  const finalizeFanoutRuns = useCallback(
    (statuses: string[]) => {
      clearTrackedWakeState();
      const failed = statuses.filter((status) => status !== "succeeded");
      if (failed.length > 0 && failed.length < statuses.length) {
        setErrorText(
          `${failed.length} de ${statuses.length} agentes terminaram com erro. Veja as runs no feed de atividades.`,
        );
      } else if (failed.length === statuses.length) {
        setErrorText(
          "As runs dos agentes terminaram com erro. Abra o detalhe das runs para mais informações.",
        );
      }
      if (boardIssueId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.comments(boardIssueId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.runs(boardIssueId),
        });
      }
    },
    [boardIssueId, clearTrackedWakeState, queryClient],
  );

  useEffect(() => {
    if (!useTurnPollPath || !hostTurn) return;
    if (!isTerminalHostRunStatus(hostTurn.status)) return;
    finalizeHostRun(
      hostTurn.status,
      hostTurn.hostRunId,
      hostTurn.costUsd,
    );
  }, [useTurnPollPath, hostTurn, finalizeHostRun]);

  useEffect(() => {
    if (useTurnPollPath || isFanoutTracking) return;
    if (!hostRunId) return;
    const trackedRun = hostRunDetail ?? hostLiveRun;
    if (!trackedRun) return;
    if (isTerminalHostRunStatus(trackedRun.status)) {
      const costUsd =
        hostRunDetail != null
          ? visibleRunCostUsd(
              (hostRunDetail.usageJson as Record<string, unknown> | null) ?? null,
              (hostRunDetail.resultJson as Record<string, unknown> | null) ?? null,
            )
          : null;
      finalizeHostRun(trackedRun.status, trackedRun.id, costUsd);
    }
  }, [
    useTurnPollPath,
    isFanoutTracking,
    hostRunDetail,
    hostLiveRun,
    hostRunId,
    finalizeHostRun,
  ]);

  useEffect(() => {
    if (!isFanoutTracking || useTurnPollPath) return;
    const statuses = fanoutHostRuns.map((tracked) => {
      const run = fanoutLiveById.get(tracked.runId);
      return run?.status ?? null;
    });
    if (statuses.some((status) => status == null)) return;
    if (!statuses.every((status) => status != null && isTerminalHostRunStatus(status))) {
      return;
    }
    finalizeFanoutRuns(statuses as string[]);
  }, [
    isFanoutTracking,
    useTurnPollPath,
    fanoutHostRuns,
    fanoutLiveById,
    finalizeFanoutRuns,
  ]);

  useEffect(() => {
    if (!hasTrackedRuns || !sending) return;
    const timeoutId = setTimeout(() => {
      if (useTurnPollPath) {
        if (hostTurn && isTerminalHostRunStatus(hostTurn.status)) return;
      } else if (isFanoutTracking) {
        const statuses = fanoutHostRuns.map(
          (tracked) => fanoutLiveById.get(tracked.runId)?.status,
        );
        if (
          statuses.every(
            (status) => status != null && isTerminalHostRunStatus(status),
          )
        ) {
          return;
        }
      } else {
        const trackedRun = hostRunDetail ?? hostLiveRun;
        if (trackedRun && isTerminalHostRunStatus(trackedRun.status)) {
          return;
        }
      }
      clearTrackedWakeState();
      setErrorText(
        isFanoutTracking
          ? "As respostas dos agentes estão demorando. Verifique o status das runs no feed de atividades."
          : "A resposta do agente está demorando. Verifique o status da run no feed de atividades.",
      );
    }, 90_000);
    return () => clearTimeout(timeoutId);
  }, [
    hasTrackedRuns,
    sending,
    hostRunDetail,
    hostLiveRun,
    useTurnPollPath,
    hostTurn,
    isFanoutTracking,
    fanoutHostRuns,
    fanoutLiveById,
    clearTrackedWakeState,
  ]);

  const threadMessages = useMemo(
    () => sortedComments.map(commentToThreadMessage),
    [sortedComments],
  );

  // Agent lookup so each bubble can show its author's name + icon header.
  const agentMap = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a] as const)),
    [agents],
  );

  const mentionOptions = useMemo<MentionOption[]>(
    () =>
      (agents ?? [])
        .filter((agent) => agent.status !== "terminated")
        .map((agent) => ({
          id: `agent:${agent.id}`,
          name: agent.name,
          kind: "agent" as const,
          agentId: agent.id,
          agentIcon: agent.icon,
        })),
    [agents],
  );

  // Feedback votes for the board issue power the 👍/👎 affordance — the same
  // store the task thread reads (PAP-105 shares the action row).
  const { data: feedbackVotes } = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(boardIssueId ?? ""),
    queryFn: () => issuesApi.listFeedbackVotes(boardIssueId!),
    enabled: !!boardIssueId,
  });

  const voteByComment = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const vote of feedbackVotes ?? []) {
      if (vote.targetType === "issue_comment") map.set(vote.targetId, vote.vote);
    }
    return map;
  }, [feedbackVotes]);

  const handleCommentVote = useCallback(
    async (
      commentId: string,
      vote: FeedbackVoteValue,
      options?: { allowSharing?: boolean; reason?: string },
    ) => {
      if (!boardIssueId) return;
      await issuesApi.upsertFeedbackVote(boardIssueId, {
        targetType: "issue_comment",
        targetId: commentId,
        vote,
        reason: options?.reason,
        allowSharing: options?.allowSharing,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.feedbackVotes(boardIssueId),
      });
    },
    [boardIssueId, queryClient],
  );

  // Reset the staged reveal on mount AND whenever the active company
  // changes, so every arrival at the Conference Room replays the typing
  // intro from scratch (a freshly-created company included). The effect's
  // mount run is intentional — it keeps the intro fresh even if a future
  // refactor preserves this component instance across navigations (PAP-134).
  useEffect(() => {
    setWelcomeRevealed(false);
    setChipsRevealed(false);
  }, [selectedCompanyId]);

  // The onboarding wizard renders as an overlay above an already-mounted
  // Conference Room (sidebar "Create new team..." path). Holding the reveal
  // timer while it's open guarantees the dots window can't burn off behind
  // the wizard before the user ever sees the chat (PAP-134).
  const { onboardingOpen } = useDialogState();

  // Start the typing → welcome timer only once we have the ingredients
  // needed to render the welcome bubble. This guarantees the animation is
  // visible at the moment the user arrives, even if agent/goal queries
  // take a beat to resolve. Prefer CEO; fall back to first active agent.
  const canRenderWelcome = !!chipMentionAgent && !!selectedCompany;
  useEffect(() => {
    if (!canRenderWelcome) return;
    if (welcomeRevealed) return;
    if (onboardingOpen || !pageVisible) return;
    const timeout = setTimeout(() => setWelcomeRevealed(true), 2000);
    return () => clearTimeout(timeout);
  }, [canRenderWelcome, welcomeRevealed, onboardingOpen, pageVisible]);

  // Stage the suggestion chips in shortly after the welcome bubble lands
  // so the eye reads the message first, then the actions.
  useEffect(() => {
    if (!welcomeRevealed) return;
    if (chipsRevealed) return;
    const timeout = setTimeout(() => setChipsRevealed(true), 700);
    return () => clearTimeout(timeout);
  }, [welcomeRevealed, chipsRevealed]);

  // If the user has already replied in this conversation, fast-forward
  // past the intro — the welcome isn't a "new" event anymore.
  useEffect(() => {
    if (welcomeRevealed && chipsRevealed) return;
    if (userHasReplied) {
      setWelcomeRevealed(true);
      setChipsRevealed(true);
    }
  }, [userHasReplied, welcomeRevealed, chipsRevealed]);

  // Clear optimistic message once server-persisted comments include it
  useEffect(() => {
    if (optimisticMessage && sortedComments.length > 0) {
      const lastUserComment = [...sortedComments]
        .reverse()
        .find((c) => !c.authorAgentId && c.authorUserId !== "board-concierge");
      if (lastUserComment?.body === optimisticMessage) {
        setOptimisticMessage(null);
      }
    }
  }, [sortedComments, optimisticMessage]);

  // Scroll behavior:
  //   - First mount in a session (no saved position): jump to bottom instantly.
  //   - Returning to the page within the same session: restore last scrollTop.
  //   - New content arriving: smooth-scroll to bottom only if user is already
  //     near the bottom, so we don't yank them away from reading history.
  //   - Scroll position is persisted to sessionStorage (cleared when tab closes).
  useEffect(() => {
    if (hasRestoredScrollRef.current) return;
    if (sortedComments.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    try {
      const saved = sessionStorage.getItem("paperclip.boardChat.scrollTop");
      if (saved != null) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) {
          container.scrollTop = parsed;
          hasRestoredScrollRef.current = true;
          return;
        }
      }
    } catch { /* sessionStorage unavailable */ }

    container.scrollTop = container.scrollHeight;
    hasRestoredScrollRef.current = true;
  }, [sortedComments.length]);

  // User sent a message: always scroll so their just-typed message is in
  // view, even if they were scrolled up reading history.
  useEffect(() => {
    if (!optimisticMessage) return;
    scrollToLatest("smooth");
  }, [optimisticMessage, scrollToLatest]);

  // Agent activity (new persisted comment, streaming chunks, status):
  // auto-scroll only if the user was near the bottom BEFORE the new content
  // arrived. Using the ref (updated on scroll events) instead of measuring
  // after the render, because the new content has already grown scrollHeight
  // by the time this effect fires — making the post-update "distance from
  // bottom" misleading.
  useEffect(() => {
    if (!hasRestoredScrollRef.current) return;
    if (wasNearBottomRef.current) {
      scrollToLatest("smooth");
    } else {
      setHasNewBelow(true);
    }
  }, [sortedComments.length, streamingText, statusText, scrollToLatest]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    const handleScroll = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
      wasNearBottomRef.current = near;
      if (near) setHasNewBelow(false);

      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          sessionStorage.setItem(
            "paperclip.boardChat.scrollTop",
            String(container.scrollTop),
          );
        } catch { /* sessionStorage unavailable */ }
      });
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || sending || !selectedCompanyId) return;

      setOptimisticMessage(trimmed);
      setSending(true);
      setInput("");
      inputRef.current = "";
      setStreamingText("");
      setErrorText("");
      setStatusText("");
      setStatusNotice("");
      setHostRunId(null);
      setHostAgentId(null);
      setFanoutHostRuns([]);
      setHostRoomMessageId(null);
      setTurnPollAvailable(true);

      let keepSendingForHostRun = false;

      try {
        const clientMessageId = crypto.randomUUID();
        const res = await fetch("/api/board/chat/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": clientMessageId,
          },
          body: JSON.stringify({
            companyId: selectedCompanyId,
            message: trimmed,
            taskId: boardIssueId ?? undefined,
            clientMessageId,
          }),
        });

        const payload = (await res.json().catch(() => ({}))) as
          | BoardChatMessageResponse
          | { error?: string; code?: string; message?: string; max?: number };

        if (!res.ok) {
          const code = "code" in payload ? payload.code : undefined;
          if (code === "INVALID_MENTION") {
            throw new Error(
              "Menção inválida — use @ e escolha um agente da lista.",
            );
          }
          if (code === "TOO_MANY_MENTIONS") {
            const max =
              "max" in payload && typeof payload.max === "number" ? payload.max : 5;
            throw new Error(
              `Mencione no máximo ${max} agentes por mensagem.`,
            );
          }
          if (code === "FANOUT_NOT_ENABLED") {
            throw new Error(
              "Por enquanto, mencione um agente por vez.",
            );
          }
          if (code === "RATE_LIMITED" || res.status === 429) {
            throw new Error(
              "Muitas solicitações em pouco tempo. Aguarde um momento e tente de novo.",
            );
          }
          if (code === "FEATURE_DISABLED") {
            throw new Error(
              "A Conference Room está desativada nesta instância.",
            );
          }
          if (res.status === 403) {
            throw new Error(
              ("error" in payload && payload.error) ||
                "A Conference Room está desativada nesta instância.",
            );
          }
          if (res.status === 409) {
            throw new Error(
              ("error" in payload && payload.error) ||
                "Agente indisponível para wake (paused/terminated).",
            );
          }
          throw new Error(
            ("error" in payload && payload.error) ||
              "Não foi possível enviar a mensagem para a Conference Room.",
          );
        }

        const result = payload as BoardChatMessageResponse;

        if (result.issueId) {
          setBoardIssueId(result.issueId);
          try {
            sessionStorage.setItem(boardIssueCacheKey(selectedCompanyId), result.issueId);
          } catch { /* sessionStorage unavailable */ }
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.comments(result.issueId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.list(selectedCompanyId),
          });
        }

        if (result.mode === "silent") {
          setStatusNotice("Mencione um agente com @ para ele responder.");
        } else if (result.mode === "host_run") {
          keepSendingForHostRun = true;
          setFanoutHostRuns([]);
          setHostRunId(result.hostRunId);
          setHostAgentId(result.hostAgentId);
          setHostRoomMessageId(result.roomMessageId);
          setStatusNotice("");
          setStatusText(
            `${agentMap.get(result.hostAgentId)?.name ?? "Agente"} está respondendo…`,
          );
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.liveRuns(result.issueId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.runs(result.issueId),
          });
        } else if (result.mode === "fanout") {
          keepSendingForHostRun = true;
          setHostRunId(null);
          setHostAgentId(null);
          setFanoutHostRuns(result.hostRuns);
          setHostRoomMessageId(result.roomMessageId);
          setStatusNotice("");
          const names = result.hostRuns
            .map((run) => agentMap.get(run.agentId)?.name)
            .filter((name): name is string => Boolean(name));
          setStatusText(
            names.length > 0
              ? `${names.join(", ")} estão respondendo…`
              : `${result.hostRuns.length} agentes estão respondendo…`,
          );
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.liveRuns(result.issueId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.runs(result.issueId),
          });
        }
      } catch (err) {
        console.error("Board chat error:", err);
        setOptimisticMessage(null);
        setInput(trimmed);
        inputRef.current = trimmed;
        setErrorText(
          err instanceof Error
            ? err.message
            : "A Conference Room está indisponível. Tente novamente em instantes.",
        );
      } finally {
        if (!keepSendingForHostRun) {
          setSending(false);
        }
        composerRef.current?.focus();
      }
    },
    [sending, selectedCompanyId, boardIssueId, queryClient, agentMap],
  );

  const cancelHostRunWait = useCallback(() => {
    clearTrackedWakeState();
    setStatusNotice(
      isFanoutTracking
        ? "Espera cancelada. As runs no servidor continuam; você pode enviar outra mensagem."
        : "Espera cancelada. A run no servidor continua; você pode enviar outra mensagem.",
    );
  }, [clearTrackedWakeState, isFanoutTracking]);

  const handleSend = useCallback(() => {
    sendMessage(inputRef.current);
  }, [sendMessage]);

  const handleInputChange = useCallback((value: string) => {
    inputRef.current = value;
    setInput(value);
  }, []);

  const handleUploadImage = useCallback(
    async (file: File) => {
      if (!selectedCompanyId || !boardIssueId) {
        throw new Error("Sala ainda sem issue Board Operations");
      }
      const attachment = await issuesApi.uploadAttachment(
        selectedCompanyId,
        boardIssueId,
        file,
      );
      return attachment.contentPath;
    },
    [selectedCompanyId, boardIssueId],
  );

  const handleAttachFile = useCallback(
    async (file: File) => {
      if (!selectedCompanyId || !boardIssueId) {
        throw new Error("Sala ainda sem issue Board Operations");
      }
      const attachment = await issuesApi.uploadAttachment(
        selectedCompanyId,
        boardIssueId,
        file,
      );
      return attachment.contentPath;
    },
    [selectedCompanyId, boardIssueId],
  );

  const runtime = usePaperclipIssueRuntime({
    messages: threadMessages,
    isRunning: sending || hostRunActive,
    onSend: async ({ body }) => {
      await sendMessage(body);
    },
  });

  const hostAgentName = isFanoutTracking
    ? fanoutHostRuns
        .map((run) => agentMap.get(run.agentId)?.name)
        .filter((name): name is string => Boolean(name))
        .join(", ") || `${fanoutHostRuns.length} agentes`
    : hostAgentId
      ? agentMap.get(hostAgentId)?.name ?? "Agente"
      : ceoAgent?.name ?? "Agente";

  const wakeWaitLabel = isFanoutTracking
    ? `${hostAgentName} estão respondendo…`
    : `${hostAgentName} está respondendo…`;

  // NOTE: declared before the early return below — all hooks must run on
  // every render (Rules of Hooks). Placing it after the `!selectedCompanyId`
  // guard caused "Rendered more hooks than during the previous render" and a
  // blank page once a company was selected.
  const [mobileFeedOpen, setMobileFeedOpen] = useState(false);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">Nenhuma empresa selecionada</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Selecione uma empresa para abrir a Conference Room.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <div className="flex h-[calc(100%+3rem)] flex-col -m-6" data-testid="board-chat-root">
      <div
        ref={splitContainerRef}
        className="flex min-h-0 min-w-0 flex-1 flex-row"
      >
        {/* Left: chat (self-contained pane) — full width on mobile, 2/3 default on desktop */}
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 shrink-0 flex-col bg-background",
            "w-full md:w-auto",
            innerWidth <= 0 && "md:w-2/3",
          )}
          style={innerWidth > 0 && containerWidth >= 2 * SPLIT_MIN_PANE_PX + SPLIT_DIVIDER_PX ? { width: leftPaneWidth } : undefined}
        >
          <div className="relative flex shrink-0 items-center justify-between gap-2 px-4 py-3">
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-border"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">
                {ceoAgent?.name ?? "Conference Room"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {selectedCompany?.name ?? "Sua empresa"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="Histórico de chat"
                      disabled
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Em breve</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="Nova conversa"
                      disabled
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Em breve</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Messages — scroll viewport flush right so the scrollbar sits on the pane/divider edge */}
          <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={scrollContainerRef}
            className="scrollbar-auto-hide absolute inset-0 overflow-y-auto overflow-x-hidden"
          >
            {/* pb clears the floating glass dock (PAP-131) so the last bubble can
                 scroll fully above the composer. */}
            <div className="flex flex-col gap-4 px-6 pt-3 pb-32">
              {/* Typing bubble — shown unconditionally until the reveal
                   timer fires, so the animation is guaranteed to be
                   visible even while agent/goal data is still loading. */}
              {!welcomeRevealed && showWelcomeIntro ? (
                <TypingBubble label={`${chipMentionAgent?.name ?? "CEO"} está digitando…`} />
              ) : null}

              {welcomeRevealed && showWelcomeIntro && chipMentionAgent && selectedCompany && (() => {
                const hostAgent = chipMentionAgent;
                const hostName = hostAgent.name;
                const companyName = selectedCompany.name;
                const missionLine = missionText
                  ? ` — sua missão é "${missionText}".`
                  : ".";
                const roleLine = hostAgent.role === "ceo"
                  ? `Sou ${hostName}, líder do time.`
                  : `Sou ${hostName}.`;
                const welcomeBody =
                  `Bem-vindo(a) à **${companyName}**! ${roleLine} Li o que você compartilhou no assistente${missionLine}\n\n` +
                  `Algumas coisas com as quais posso ajudar agora. Escolha uma opção abaixo e eu preparo um rascunho com base no que você nos contou.`;

                const mentionPrefix =
                  `[@${hostAgent.name}](${buildAgentMentionHref(hostAgent.id, hostAgent.icon)}) `;
                const chips: Array<{ label: string; prompt: string }> = [
                  {
                    label: "Rascunhar um brief da empresa",
                    prompt: `${mentionPrefix}Rascunhe um brief de uma página para ${companyName} — inclua missão, time e primeiras prioridades.`,
                  },
                  {
                    label: "Criar plano de contratação",
                    prompt: `${mentionPrefix}Crie um plano de contratação para ${companyName}. Liste os próximos cargos em ordem de prioridade, com uma breve justificativa para cada.`,
                  },
                  {
                    label: "Planejar os primeiros 30 dias",
                    prompt: `${mentionPrefix}Planeje nossos primeiros 30 dias. Divida em prioridades semanais com responsáveis.`,
                  },
                  {
                    label: "Escrever pitch de apresentação",
                    prompt: `${mentionPrefix}Escreva um pitch curto de apresentação para ${companyName} que eu possa reutilizar com investidores, clientes ou candidatos.`,
                  },
                ];

                return (
                  <>
                    <div className="flex flex-col items-start">
                      <AgentBubbleHeader name={hostName} icon={hostAgent.icon} />
                      <div
                        className={cn(
                          boardChatBubbleShell,
                          "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                        )}
                      >
                        <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>{welcomeBody}</MarkdownBody>
                      </div>
                    </div>
                    {!userHasReplied && chipsRevealed && (
                      <div
                        className="flex flex-wrap gap-2 pl-1"
                        role="group"
                        aria-label="Sugestões de início"
                      >
                        {chips.map((chip) => (
                          <button
                            key={chip.label}
                            type="button"
                            data-testid="board-chat-nux-chip"
                            onClick={() => {
                              setInput(chip.prompt);
                              inputRef.current = chip.prompt;
                              composerRef.current?.focus();
                            }}
                            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {sortedComments.map((comment) => {
                const isUser = !comment.authorAgentId && comment.authorUserId !== "board-concierge";
                if (isUser) {
                  return (
                    <div key={comment.id} className="flex justify-end">
                      <div
                        className={cn(
                          boardChatBubbleShell,
                          "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                        )}
                      >
                        <MarkdownBody className={USER_BUBBLE_MARKDOWN_CLASS}>
                          {comment.body ?? ""}
                        </MarkdownBody>
                      </div>
                    </div>
                  );
                }
                // Agent bubble — name/icon header above + action row below so
                // the room speaks the same bubble language as the task thread.
                const agent = comment.authorAgentId
                  ? agentMap.get(comment.authorAgentId) ?? null
                  : ceoAgent ?? null;
                const agentName = agent?.name ?? "Assistant";
                const agentIconValue = agent?.icon ?? null;
                const linkedRun = comment.createdByRunId
                  ? runById?.[comment.createdByRunId] ?? null
                  : null;
                const turnCostUsd = comment.createdByRunId
                  ? turnCostByRunId[comment.createdByRunId]
                  : undefined;
                const runCostLabel = comment.createdByRunId
                  ? formatCostPill(
                      turnCostUsd ??
                        (linkedRun
                          ? visibleRunCostUsd(
                              (linkedRun.usageJson as Record<string, unknown> | null) ?? null,
                              (linkedRun.resultJson as Record<string, unknown> | null) ?? null,
                            )
                          : null),
                    )
                  : null;
                const runHref =
                  comment.authorAgentId && comment.createdByRunId
                    ? `/agents/${comment.authorAgentId}/runs/${comment.createdByRunId}`
                    : null;
                return (
                  <div
                    key={comment.id}
                    id={`comment-${comment.id}`}
                    className="flex flex-col items-start"
                    data-testid="board-chat-agent-bubble"
                  >
                    <AgentBubbleHeader name={agentName} icon={agentIconValue} />
                    <div
                      className={cn(
                        boardChatBubbleShell,
                        "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                      )}
                    >
                      <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>
                        {comment.body ?? ""}
                      </MarkdownBody>
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-1">
                      {runCostLabel ? (
                        <span
                          className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                          title="Custo da run"
                          data-testid="board-chat-cost-pill"
                        >
                          {runCostLabel}
                        </span>
                      ) : null}
                      <AgentBubbleActionRow
                        copyText={comment.body ?? ""}
                        dateLabel={agentBubbleDateLabel(comment.createdAt)}
                        dateTitle={formatDateTime(comment.createdAt)}
                        anchorHref={`#comment-${comment.id}`}
                        menuItems={
                          runHref ? (
                            <DropdownMenuItem asChild>
                              <Link to={runHref} target="_blank" rel="noreferrer noopener">
                                <Search className="mr-2 h-3.5 w-3.5" />
                                Ver run
                              </Link>
                            </DropdownMenuItem>
                          ) : null
                        }
                        feedback={
                          boardIssueId
                            ? {
                                activeVote: voteByComment.get(comment.id) ?? null,
                                sharingPreference: "prompt",
                                termsUrl: null,
                                onVote: (vote, options) =>
                                  handleCommentVote(comment.id, vote, options),
                              }
                            : null
                        }
                      />
                    </div>
                  </div>
                );
              })}

              {/* Optimistic user message — shows instantly before server persists */}
              {optimisticMessage && (
                <div className="flex justify-end">
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                    )}
                  >
                    <MarkdownBody className={USER_BUBBLE_MARKDOWN_CLASS}>
                      {optimisticMessage}
                    </MarkdownBody>
                  </div>
                </div>
              )}

              {/* Streaming response */}
              {streamingText && (
                <div className="flex flex-col items-start">
                  {ceoAgent && (
                    <AgentBubbleHeader name={ceoAgent.name} icon={ceoAgent.icon} />
                  )}
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                    )}
                  >
                    <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>{streamingText}</MarkdownBody>
                  </div>
                </div>
              )}

              {/* Typing bubble — sits above the status line while the agent
                   is preparing a reply but no text has streamed yet. Shows
                   alongside the user's optimistic bubble to make the
                   turn-taking feel alive. */}
              {(sending || hostRunActive) && !streamingText ? (
                <div className="flex flex-col items-start gap-1">
                  <TypingBubbleWithTimer
                    active
                    label={
                      hostRunActive || hasTrackedRuns
                        ? wakeWaitLabel
                        : statusText || "Enviando…"
                    }
                  />
                  {sending && (hostRunActive || hasTrackedRuns) ? (
                    <button
                      type="button"
                      onClick={cancelHostRunWait}
                      className="pl-1 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                      data-testid="board-chat-cancel-host-wait"
                    >
                      Cancelar espera
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* Pending HITL cards (ask_user_questions, confirmations, …)
                   for the Board Operations issue — same card as IssueChatThread. */}
              {boardIssueId ? (
                <BoardChatHitlCards
                  boardIssueId={boardIssueId}
                  agentMap={agentMap}
                  onUploadImage={handleUploadImage}
                />
              ) : null}

              <div
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="board-chat-live-status"
              >
                {sending || hostRunActive
                  ? hostRunActive || hasTrackedRuns
                    ? isFanoutTracking
                      ? `${hostAgentName} estão respondendo`
                      : `${hostAgentName} está respondendo`
                    : statusText || "Enviando mensagem"
                  : statusNotice ||
                    (!boardIssueId
                      ? "Anexos disponíveis após a sala criar a issue Board Operations"
                      : "")}
              </div>

              {statusNotice && !sending && !hostRunActive ? (
                <div
                  className="pl-1 text-xs text-muted-foreground"
                  role="status"
                  data-testid="board-chat-status-notice"
                >
                  {statusNotice}
                </div>
              ) : null}

              {/* Error notice — surfaced when the stream endpoint fails so
                  the message doesn't silently sit with no response. */}
              {errorText && !sending && (
                <div
                  role="alert"
                  className="flex justify-start"
                >
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-destructive/10 border border-destructive/30 text-destructive [border-radius:14px_14px_14px_4px]",
                    )}
                  >
                    {errorText}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
          </div>

          {/* Jump-to-latest — shows when user is scrolled away and new content has arrived */}
          {hasNewBelow && (
            <button
              type="button"
              onClick={() => scrollToLatest("smooth")}
              aria-label="Ir para as mensagens mais recentes"
              className="absolute bottom-24 left-1/2 z-20 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:border-muted-foreground/30"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}

          {/* Input — shared ChatComposer (PAP-95a), adopted bare: textarea + send.
               No mode chip (the room has no task lifecycle). Multiline like task
               comments (PAP-116): text soft-wraps and the box auto-grows instead of
               clipping / showing a horizontal scrollbar. Sends on plain Enter today
               (Shift+Enter for a newline); flipping to ⌘/Ctrl+Enter is pending board
               confirmation.

               PAP-131 (PAP-128 A): the dock floats over the message stream so text
               scrolls behind the translucent glass box. The old hard black gradient
               mask is gone — the dock carries the task-style soft top fade instead
               (mirrors IssueChatThread's composer dock). pointer-events pass through
               the fade so the scrollbar stays usable; the composer re-enables them. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/95 to-background/0 px-6 pt-6 pb-5">
            <BoardChatComposer
              editorRef={composerRef}
              value={input}
              onChange={handleInputChange}
              onSubmit={handleSend}
              mentions={mentionOptions}
              disabled={sending || hostRunActive}
              submitting={sending || hostRunActive}
              canAttach={Boolean(boardIssueId && selectedCompanyId)}
              onUploadImage={handleUploadImage}
              onAttachFile={handleAttachFile}
            />
          </div>
        </div>

        {/* Resize handle — hidden on mobile */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar chat e feed de agentes"
          aria-valuenow={Math.round(
            Math.min(0.8, Math.max(0.2, chatPaneFraction)) * 100,
          )}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          className="group relative hidden w-3 shrink-0 cursor-col-resize bg-background md:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseDown={handleSplitDragStart}
          onKeyDown={handleSplitKeyDown}
        >
          <div
            className="pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-border transition-colors group-hover:bg-foreground/20"
            aria-hidden
          />
        </div>

        {/* Right: Agent Feed — hidden on mobile */}
        <div className="hidden md:flex md:min-h-0 md:min-w-0 md:flex-1">
          <ActivityFeed />
        </div>
      </div>

      {/* Mobile: floating feed toggle + sheet drawer */}
      <div className="md:hidden">
        <Sheet open={mobileFeedOpen} onOpenChange={setMobileFeedOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="fixed bottom-20 right-4 z-20 h-10 w-10 rounded-full shadow-lg"
              aria-label="Abrir feed de agentes"
            >
              <Activity className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-[70vh] p-0 rounded-t-xl">
            <SheetTitle className="sr-only">Feed de agentes</SheetTitle>
            <ActivityFeed />
          </SheetContent>
        </Sheet>
      </div>
    </div>
    </AssistantRuntimeProvider>
  );
}
