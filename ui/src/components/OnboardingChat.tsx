import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { cn } from "../lib/utils";
import { Loader2, Send, CheckCircle2, ArrowRight } from "lucide-react";

interface OnboardingChatProps {
  taskId: string;
  agentId: string;
  agentName: string;
  companyName: string;
  companyGoal: string;
  onPlanDetected?: (planMarkdown: string) => void;
  onReviewPlan?: () => void;
}

/**
 * Detects whether a comment body contains a structured hiring plan.
 * Looks for markdown headers or bullet lists that mention roles/positions.
 */
function detectHiringPlan(body: string): boolean {
  const planPatterns = [
    /##?\s*(hiring|team|org|roles|plan)/i,
    /##?\s*(proposed|recommended)\s*(roles|hires|team)/i,
    /\n-\s+\*\*[^*]+\*\*/g, // bullet list with bold items (role names)
    /\|\s*role\s*\|/i, // markdown table with "Role" header
  ];
  return planPatterns.some((pattern) => pattern.test(body));
}

const QUEUED_MESSAGES = [
  "Heartbeat triggered, waking up...",
  "Initializing...",
  "Getting ready...",
];

const RUNNING_MESSAGES = [
  "Working on a response...",
  "Reading the conversation...",
  "Thinking through the plan...",
  "Drafting a response...",
  "Still working...",
  "Almost there...",
];

const WAITING_MESSAGES = [
  "Waiting to wake up...",
  "Heartbeat pending...",
  "Should wake up soon...",
];

function getCyclingMessage(messages: string[], elapsed: number, agentName: string): string {
  // Cycle through messages every 5 seconds
  const idx = Math.floor(elapsed / 5) % messages.length;
  return `${agentName} · ${messages[idx]}`;
}

function getRunStatusMessage(status: string, agentName: string, elapsed: number): string {
  switch (status) {
    case "queued":
      return getCyclingMessage(QUEUED_MESSAGES, elapsed, agentName);
    case "running":
      return getCyclingMessage(RUNNING_MESSAGES, elapsed, agentName);
    case "succeeded":
      return `${agentName} finished`;
    case "failed":
      return `${agentName} encountered an error`;
    case "cancelled":
      return `${agentName}'s run was cancelled`;
    case "timed_out":
      return `${agentName}'s run timed out`;
    default:
      return `${agentName} is thinking...`;
  }
}

export function OnboardingChat({
  taskId,
  agentId,
  agentName,
  companyName,
  companyGoal,
  onPlanDetected,
  onReviewPlan,
}: OnboardingChatProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [detectedPlanCommentId, setDetectedPlanCommentId] = useState<
    string | null
  >(null);
  // Track the comment ID after which we should ignore old plan detections
  // (set when user sends a new message to request revisions)
  const [ignoreBeforeCommentId, setIgnoreBeforeCommentId] = useState<
    string | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    data: rawComments,
    isLoading,
  } = useQuery({
    queryKey: queryKeys.issues.comments(taskId),
    queryFn: () => issuesApi.listComments(taskId),
    refetchInterval: 4000,
  });

  // Poll for active heartbeat run on this task
  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(taskId),
    queryFn: () => heartbeatsApi.activeRunForIssue(taskId),
    refetchInterval: 3000,
  });

  // Sort comments chronologically (oldest first) for chat-style display
  const comments = useMemo(
    () =>
      rawComments
        ? [...rawComments].sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        : undefined,
    [rawComments],
  );

  // Auto-scroll to bottom when new comments arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments?.length]);

  // Detect hiring plan in agent comments.
  // Only considers agent comments newer than the user's last message AND
  // newer than any "ignore" marker (set when user asks for revisions).
  useEffect(() => {
    if (!comments || !onPlanDetected || detectedPlanCommentId) return;

    // Find the cutoff — the later of the user's last message or the ignore marker
    let cutoffIdx = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].authorUserId) { cutoffIdx = i; break; }
    }
    if (ignoreBeforeCommentId) {
      const ignoreIdx = comments.findIndex((c) => c.id === ignoreBeforeCommentId);
      if (ignoreIdx >= 0) cutoffIdx = Math.max(cutoffIdx, ignoreIdx);
    }

    // Only scan agent comments after the cutoff
    for (let i = comments.length - 1; i > cutoffIdx; i--) {
      const c = comments[i];
      if (c.authorAgentId && detectHiringPlan(c.body)) {
        setDetectedPlanCommentId(c.id);
        // Fetch the full plan document — it has richer role descriptions
        issuesApi.getDocument(taskId, "plan").then((doc) => {
          onPlanDetected(doc.body ?? c.body);
        }).catch(() => {
          onPlanDetected(c.body);
        });
        break;
      }
    }
  }, [comments, onPlanDetected, detectedPlanCommentId, ignoreBeforeCommentId, taskId]);

  const sendMessage = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      // Ensure the task is assigned to the CEO and in_progress before commenting.
      try {
        await issuesApi.update(taskId, { assigneeUserId: null });
      } catch { /* may already be null */ }
      try {
        await issuesApi.update(taskId, {
          assigneeAgentId: agentId,
          status: "in_progress",
        });
      } catch { /* may already be assigned */ }

      await issuesApi.addComment(taskId, trimmed, true, true);
      setInput("");
      // Clear detected plan — user is asking for revisions
      const latestId = comments?.[comments.length - 1]?.id ?? null;
      setIgnoreBeforeCommentId(latestId);
      setDetectedPlanCommentId(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(taskId),
      });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [sending, taskId, agentId, queryClient, comments]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Determine if we should show a status indicator
  const lastComment = comments?.[comments.length - 1];
  const isWaitingForAgent =
    lastComment && lastComment.authorUserId && !lastComment.authorAgentId;
  const hasActiveRun = activeRun && (activeRun.status === "queued" || activeRun.status === "running");
  const showStatus = isWaitingForAgent || hasActiveRun;

  // Elapsed timer — ticks every second while waiting
  const [elapsed, setElapsed] = useState(0);
  const waitingSince = useMemo(() => {
    if (!showStatus || !lastComment) return null;
    // Use the user's last message timestamp as the start time
    if (lastComment.authorUserId) return new Date(lastComment.createdAt).getTime();
    // If an active run exists, use its creation time
    if (hasActiveRun && activeRun.createdAt) return new Date(activeRun.createdAt).getTime();
    return null;
  }, [showStatus, lastComment, hasActiveRun, activeRun]);

  useEffect(() => {
    if (!waitingSince) { setElapsed(0); return; }
    setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [waitingSince]);

  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading conversation...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-[180px] max-h-[320px] pr-1"
      >
        {/* CEO welcome message + chips — delayed reveal */}
        <WelcomeMessage
          agentName={agentName}
          companyName={companyName}
          companyGoal={companyGoal}
          hasComments={Boolean(comments?.length)}
          onDiscuss={() => {
            setInput("I want to discuss the plan before you get started.");
            inputRef.current?.focus();
          }}
          onStart={() => sendMessage("Yes, get started on the hiring plan!")}
        />
        {comments?.map((comment) => {
          const isAgent = Boolean(comment.authorAgentId);
          const isPlan =
            detectedPlanCommentId === comment.id;
          return (
            <div
              key={comment.id}
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                isAgent
                  ? "bg-muted/50 border border-border mr-8"
                  : "bg-accent/50 border border-accent ml-8",
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className={cn(
                    "text-[10px] font-medium uppercase tracking-wide",
                    isAgent
                      ? "text-muted-foreground"
                      : "text-foreground/70",
                  )}
                >
                  {isAgent ? agentName : "You"}
                </span>
                {isPlan && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                    <CheckCircle2 className="h-3 w-3" />
                    Hiring plan detected
                  </span>
                )}
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <MarkdownBody>
                  {isAgent
                    ? comment.body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                    : comment.body}
                </MarkdownBody>
              </div>
            </div>
          );
        })}

        {/* Status indicator — shows real heartbeat run status */}
        {showStatus && (
          <div className="flex items-center justify-between text-sm text-muted-foreground px-3 py-2">
            <div className="flex items-center gap-2">
              {hasActiveRun ? (
                <>
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
                  </span>
                  {getRunStatusMessage(activeRun.status, agentName, elapsed)}
                </>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  {getCyclingMessage(WAITING_MESSAGES, elapsed, agentName)}
                </>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
              {elapsedStr}
            </span>
          </div>
        )}
      </div>

      {/* Plan ready CTA */}
      {detectedPlanCommentId && onReviewPlan && (
        <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-3 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {agentName} has prepared a hiring plan
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Review it, make edits, then approve.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={onReviewPlan}>
              Review plan
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          placeholder={detectedPlanCommentId ? `Ask ${agentName} to revise the plan...` : `Message ${agentName}...`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus={!detectedPlanCommentId}
        />
        <Button
          size="sm"
          disabled={!input.trim() || sending}
          onClick={handleSend}
          className="shrink-0"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

function WelcomeMessage({
  agentName,
  companyName,
  companyGoal,
  hasComments,
  onDiscuss,
  onStart,
}: {
  agentName: string;
  companyName: string;
  companyGoal: string;
  hasComments: boolean;
  onDiscuss: () => void;
  onStart: () => void;
}) {
  const [phase, setPhase] = useState<"waking" | "composing" | "message" | "chips">("waking");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("composing"), 2500);
    const t2 = setTimeout(() => setPhase("message"), 5500);
    const t3 = setTimeout(() => setPhase("chips"), 6500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  const showMessage = phase === "message" || phase === "chips";
  const showChips = phase === "chips" && !hasComments;

  return (
    <>
      {/* Message — appears after typing indicator */}
      {showMessage && (
        <div className="rounded-md px-3 py-2 text-sm bg-muted/50 border border-border mr-8 animate-in fade-in duration-300">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {agentName}
            </span>
          </div>
          <p>
            Hi! Thanks for bringing me on to lead <strong>{companyName}</strong>.
          </p>
          <p className="mt-1">
            Our mission is: <em>{companyGoal}</em>
          </p>
          <p className="mt-1">
            I'm ready to put together a plan for who we should bring on. Want me to get started?
          </p>
        </div>
      )}

      {/* Chips — fade in after message */}
      {showChips && (
        <div className="flex gap-2 ml-auto justify-end animate-in fade-in duration-500">
          <button
            className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
            onClick={onDiscuss}
          >
            Let's discuss first
          </button>
          <button
            className="rounded-full border border-foreground bg-foreground text-background px-3 py-1 text-xs hover:opacity-90 transition-opacity"
            onClick={onStart}
          >
            Yes, get started!
          </button>
        </div>
      )}

      {/* Typing indicator — anchored at bottom of scroll area, before real status messages */}
      {!showMessage && (
        <div className="flex-1" />
      )}
      {!showMessage && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
          </span>
          {phase === "waking"
            ? `${agentName} is waking up...`
            : `${agentName} is composing a message...`}
        </div>
      )}
    </>
  );
}
