import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { CeoChatThread } from "../components/CeoChatThread";
import { CeoGoalsPanel } from "../components/CeoGoalsPanel";
import { IssueThreadInteractionCard } from "../components/IssueThreadInteractionCard";
import { ChatComposer, type ChatComposerHandle } from "../components/ChatComposer";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ArrowDown, Target } from "lucide-react";

/** The board-level standing issue the CEO conversation streams into. */
const BOARD_OPS_TITLE = "Board Operations";

type ActionableInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

/**
 * CEO conversation screen (new `/:companyPrefix/ceo`). The home where the
 * operator talks to the CEO agent — goals live as context beside the
 * conversation, and the CEO's replies can spawn real tasks. Replaces the
 * static goals list as the primary "goals" experience.
 *
 * Data contract (SSE loop, board-issue detection, `isUser` sentinel, CEO-agent
 * + active-goal selectors) is lifted from BoardChat; the layout and copy are
 * this screen's own.
 */
export function Ceo() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [boardIssueId, setBoardIssueId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [goalsSheetOpen, setGoalsSheetOpen] = useState(false);

  const composerRef = useRef<ChatComposerHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasNearBottomRef = useRef(true);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    wasNearBottomRef.current = true;
    setHasNewBelow(false);
  }, []);

  // Reset transient state when the active company changes.
  const prevCompanyRef = useRef(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyRef.current !== selectedCompanyId) {
      if (boardIssueId) {
        queryClient.removeQueries({ queryKey: queryKeys.issues.comments(boardIssueId) });
      }
      setBoardIssueId(null);
      setStreamingText("");
      setStatusText("");
      setSending(false);
      setOptimisticMessage(null);
      setInput("");
      prevCompanyRef.current = selectedCompanyId;
    }
  }, [selectedCompanyId, boardIssueId, queryClient]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = useMemo(
    () => agents?.find((a) => a.role === "ceo" && a.status !== "terminated"),
    [agents],
  );

  const { data: goals, isLoading: goalsLoading } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const missionText = useMemo(() => {
    const active = (goals ?? []).find((g) => g.status === "active");
    return active?.title ?? null;
  }, [goals]);

  // Find the standing Board Operations issue the chat streams into.
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!issues) {
      setBoardIssueId(null);
      return;
    }
    const boardIssue = issues.find(
      (i) => i.title === BOARD_OPS_TITLE && i.status !== "done" && i.status !== "cancelled",
    );
    setBoardIssueId(boardIssue?.id ?? null);
  }, [issues]);

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(boardIssueId ?? ""),
    queryFn: () => issuesApi.listComments(boardIssueId!),
    enabled: !!boardIssueId,
    refetchInterval: 3000,
  });

  // Pending task-suggestion interactions render inline below the thread.
  const { data: interactions } = useQuery({
    queryKey: queryKeys.issues.interactions(boardIssueId ?? ""),
    queryFn: () => issuesApi.listInteractions(boardIssueId!),
    enabled: !!boardIssueId,
    refetchInterval: 5000,
  });

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a] as const)),
    [agents],
  );

  // Clear optimistic message once server-persisted comments include it.
  const sortedComments = useMemo(
    () =>
      (comments ?? [])
        .slice()
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [comments],
  );
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

  // Track near-bottom on scroll so new content auto-scrolls only when the user
  // was already at the bottom; otherwise surface the jump-to-latest chip.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const near =
        container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
      wasNearBottomRef.current = near;
      if (near) setHasNewBelow(false);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (optimisticMessage) {
      scrollToLatest("smooth");
      return;
    }
    if (wasNearBottomRef.current) {
      scrollToLatest("smooth");
    } else {
      setHasNewBelow(true);
    }
  }, [sortedComments.length, streamingText, statusText, optimisticMessage, scrollToLatest]);

  // Elapsed timer for the "CEO is working…" indicator.
  useEffect(() => {
    if (sending) {
      setElapsedSec(0);
      const startedAt = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSec((Date.now() - startedAt) / 1000);
      }, 100);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [sending]);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || sending || !selectedCompanyId) return;

      setOptimisticMessage(trimmed);
      setSending(true);
      setInput("");
      setStreamingText("");
      setErrorText("");
      setStatusText("Connecting…");

      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 130000);
        const res = await fetch("/api/board/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: selectedCompanyId,
            message: trimmed,
            taskId: boardIssueId ?? undefined,
          }),
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);

        // The stream endpoint 403s when the experimental flag is off — surface
        // a calm inline notice rather than the generic error bubble.
        if (res.status === 403) {
          setErrorText("Live chat is disabled on this instance.");
          setStatusText("");
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error("CEO chat stream not available");
        }

        setStatusText("Thinking…");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "chunk" && event.text) {
                accumulated += event.text;
                setStreamingText(accumulated);
                setStatusText("");
              } else if (event.type === "status" && event.text) {
                setStatusText(event.text);
              } else if (event.type === "start" && event.issueId) {
                setBoardIssueId(event.issueId);
              } else if (event.type === "error") {
                setErrorText(
                  event.message || "Your CEO couldn't respond. Please try again.",
                );
                setStatusText("");
              } else if (event.type === "done") {
                if (event.issueId) {
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.issues.comments(event.issueId),
                  });
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.issues.interactions(event.issueId),
                  });
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.issues.list(selectedCompanyId),
                  });
                }
              }
            } catch {
              /* malformed SSE line */
            }
          }
        }

        setStreamingText("");
        setStatusText("");
        if (boardIssueId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(boardIssueId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(boardIssueId) });
        }
        // First send may create the Board Operations issue server-side — refetch
        // the list so the detection effect can bind the new issue id.
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      } catch (err) {
        console.error("CEO chat error:", err);
        setStatusText("");
        setErrorText("Your CEO is unavailable right now. Please try again in a moment.");
      } finally {
        setSending(false);
        composerRef.current?.focus();
      }
    },
    [sending, selectedCompanyId, boardIssueId, queryClient],
  );

  const handleSend = useCallback(() => sendMessage(input), [input, sendMessage]);

  const handleAcceptInteraction = useCallback(
    async (interaction: ActionableInteraction, selectedClientKeys?: string[], selectedOptionIds?: string[]) => {
      if (!boardIssueId) return;
      await issuesApi.acceptInteraction(boardIssueId, interaction.id, {
        selectedClientKeys,
        selectedOptionIds,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(boardIssueId) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }
    },
    [boardIssueId, selectedCompanyId, queryClient],
  );

  const handleRejectInteraction = useCallback(
    async (interaction: ActionableInteraction, reason?: string) => {
      if (!boardIssueId) return;
      await issuesApi.rejectInteraction(boardIssueId, interaction.id, reason);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(boardIssueId) });
    },
    [boardIssueId, queryClient],
  );

  // Render pending `suggest_tasks` interactions inline, accept/reject wired.
  const interactionSlot = useMemo(() => {
    const pending = (interactions ?? []).filter(
      (i) => i.kind === "suggest_tasks" && i.status === "pending",
    );
    if (pending.length === 0) return null;
    return (
      <div className="flex flex-col gap-3">
        {pending.map((interaction) => (
          <IssueThreadInteractionCard
            key={interaction.id}
            interaction={interaction}
            agentMap={agentMap}
            onAcceptInteraction={handleAcceptInteraction}
            onRejectInteraction={handleRejectInteraction}
          />
        ))}
      </div>
    );
  }, [interactions, agentMap, handleAcceptInteraction, handleRejectInteraction]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to talk to your CEO." />;
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        // Mobile: the host <main> is document-flow with p-4 / pb-20 and a fixed
        // bottom nav. Counter that padding and pin the chat to the dynamic
        // viewport below the sticky header (~48px) and above the bottom nav
        // (~65px) so the thread scrolls internally and the composer stays docked.
        "-mx-4 -mt-4 -mb-20 h-[calc(100dvh-48px-65px)]",
        // Desktop: full-bleed inside the flex shell — counter md:p-6 and grow to
        // fill the parent (the +3rem offsets the host's bottom padding).
        "md:-m-6 md:h-[calc(100%+3rem)]",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        {/* Left / main: the conversation — full width on mobile, flex on desktop. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {/* Header strip — CEO identity + active-goal mission subtext. */}
          <div className="relative flex shrink-0 items-center justify-between gap-2 px-4 py-3">
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-border"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">
                {ceoAgent?.name ?? "CEO"}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {ceoAgent ? "Chief Executive" : selectedCompany?.name ?? ""}
                </span>
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                {missionText ? `Mission: ${missionText}` : "Set a mission to steer the company"}
              </p>
            </div>
            {/* Mobile-only Goals trigger — opens the bottom Sheet drawer. */}
            <div className="md:hidden">
              <Sheet open={goalsSheetOpen} onOpenChange={setGoalsSheetOpen}>
                <SheetTrigger asChild>
                  <Button type="button" variant="outline" size="sm" aria-label="Open goals">
                    <Target className="h-4 w-4" />
                    Goals
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[70vh] p-0">
                  <CeoGoalsPanel goals={goals} isLoading={goalsLoading} />
                </SheetContent>
              </Sheet>
            </div>
          </div>

          <CeoChatThread
            comments={comments ?? []}
            ceoAgent={ceoAgent}
            company={selectedCompany}
            missionText={missionText}
            optimisticMessage={optimisticMessage}
            streamingText={streamingText}
            statusText={statusText}
            sending={sending}
            elapsedSec={elapsedSec}
            errorText={errorText}
            interactionSlot={interactionSlot}
            scrollContainerRef={scrollContainerRef}
            messagesEndRef={messagesEndRef}
          />

          {/* Jump-to-latest chip. */}
          {hasNewBelow && (
            <button
              type="button"
              onClick={() => scrollToLatest("smooth")}
              aria-label="Jump to latest messages"
              className="absolute bottom-24 left-1/2 z-20 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:border-muted-foreground/30"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}

          {/* Composer dock — floats over the stream (translucent glass). */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/95 to-background/0 px-6 pt-6 pb-5">
            <ChatComposer
              ref={composerRef}
              value={input}
              onChange={setInput}
              onSubmit={handleSend}
              placeholder="Tell your CEO what you want to achieve…"
              submitKey="enter"
              surface="translucent"
              submitting={sending}
              disabled={sending}
              sendLabel="Send message"
              className="pointer-events-auto"
            />
          </div>
        </div>

        {/* Right: Goals context rail — desktop only (~320px). */}
        <div className="hidden w-80 shrink-0 border-l border-border md:flex md:min-h-0 md:flex-col">
          <CeoGoalsPanel goals={goals} isLoading={goalsLoading} />
        </div>
      </div>
    </div>
  );
}
