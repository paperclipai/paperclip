import {
  AssistantRuntimeProvider,
  ActionBarPrimitive,
  ChainOfThoughtPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useMessage,
} from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "@/lib/router";
import type {
  Agent,
  FeedbackDataSharingPreference,
  FeedbackVote,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePaperclipIssueRuntime, type PaperclipIssueRuntimeReassignment } from "../hooks/usePaperclipIssueRuntime";
import {
  buildIssueChatMessages,
  type IssueChatComment,
  type IssueChatLinkedRun,
  type IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineAssignee, IssueTimelineEvent } from "../lib/issue-timeline-events";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MentionOption, type MarkdownEditorRef } from "./MarkdownEditor";
import { Identity } from "./Identity";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { AgentIcon } from "./AgentIconPicker";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { timeAgo } from "../lib/timeAgo";
import {
  displayToolName,
  formatToolPayload,
  parseToolPayload,
  summarizeToolInput,
  summarizeToolResult,
} from "../lib/transcriptPresentation";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, Check, ChevronDown, Copy, Loader2, MoreHorizontal, Paperclip, ThumbsDown, ThumbsUp } from "lucide-react";

interface IssueChatMessageContext {
  feedbackVoteByTargetId: Map<string, FeedbackVoteValue>;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  feedbackTermsUrl: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onInterruptQueued?: (runId: string) => Promise<void>;
  interruptingQueuedRunId?: string | null;
}

const IssueChatCtx = createContext<IssueChatMessageContext>({
  feedbackVoteByTargetId: new Map(),
  feedbackDataSharingPreference: "prompt",
  feedbackTermsUrl: null,
});

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface IssueChatThreadProps {
  comments: IssueChatComment[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: IssueChatLinkedRun[];
  timelineEvents?: IssueTimelineEvent[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  companyId?: string | null;
  projectId?: string | null;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  onCancelRun?: () => Promise<void>;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  composerDisabledReason?: string | null;
  showComposer?: boolean;
  enableLiveTranscriptPolling?: boolean;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  onInterruptQueued?: (runId: string) => Promise<void>;
  interruptingQueuedRunId?: string | null;
}

const DRAFT_DEBOUNCE_MS = 800;

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseReassignment(target: string): PaperclipIssueRuntimeReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function IssueChatTextPart({ text }: { text: string }) {
  return <MarkdownBody className="text-sm leading-6">{text}</MarkdownBody>;
}

function humanizeValue(value: string | null) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function formatTimelineAssigneeLabel(
  assignee: IssueTimelineAssignee,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
) {
  if (assignee.agentId) {
    return agentMap?.get(assignee.agentId)?.name ?? assignee.agentId.slice(0, 8);
  }
  if (assignee.userId) {
    return formatAssigneeUserLabel(assignee.userId, currentUserId) ?? "Board";
  }
  return "Unassigned";
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatRunStatusLabel(status: string) {
  switch (status) {
    case "timed_out":
      return "timed out";
    default:
      return status.replace(/_/g, " ");
  }
}

function runStatusClass(status: string) {
  switch (status) {
    case "succeeded":
      return "text-green-700 dark:text-green-300";
    case "failed":
    case "error":
      return "text-red-700 dark:text-red-300";
    case "timed_out":
      return "text-orange-700 dark:text-orange-300";
    case "running":
      return "text-cyan-700 dark:text-cyan-300";
    case "queued":
    case "pending":
      return "text-amber-700 dark:text-amber-300";
    case "cancelled":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

function IssueChatChainOfThought() {
  return (
    <ChainOfThoughtPrimitive.Root className="rounded-md bg-background/70">
      <ChainOfThoughtPrimitive.AccordionTrigger className="group flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground">
        <span className="inline-flex items-center gap-2 uppercase tracking-[0.14em]">
          Chain of thought
        </span>
        <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
      </ChainOfThoughtPrimitive.AccordionTrigger>
      <div className="mr-2 border-r border-border/70 pr-3">
        <ChainOfThoughtPrimitive.Parts
          components={{
            Reasoning: ({ text }) => <IssueChatReasoningPart text={text} />,
            tools: {
              Fallback: ({ toolName, args, argsText, result, isError }) => (
                <IssueChatToolPart
                  toolName={toolName}
                  args={args}
                  argsText={argsText}
                  result={result}
                  isError={isError}
                />
              ),
            },
            Layout: ({ children }) => <div className="space-y-2 pb-1 pl-1">{children}</div>,
          }}
        />
      </div>
    </ChainOfThoughtPrimitive.Root>
  );
}

function IssueChatReasoningPart({ text }: { text: string }) {
  return (
    <div className="rounded-sm bg-accent/20 px-3 py-2">
      <MarkdownBody className="text-sm leading-6">{text}</MarkdownBody>
    </div>
  );
}

function IssueChatToolPart({
  toolName,
  args,
  argsText,
  result,
  isError,
}: {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(isError));
  const rawArgsText = argsText ?? "";
  const parsedArgs = args ?? parseToolPayload(rawArgsText);
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : formatToolPayload(result);
  const displayName = displayToolName(toolName, parsedArgs);
  const summary =
    result === undefined
      ? summarizeToolInput(toolName, parsedArgs)
      : summarizeToolResult(resultText, isError);

  return (
    <div
      className={cn(
        "rounded-sm border px-3 py-2",
        isError
          ? "border-red-300/70 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10"
          : "border-border/70 bg-background/70",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {displayName}
          </span>
          <span className="mt-1 block text-sm text-foreground/80">{summary}</span>
        </span>
        <span className="shrink-0 flex items-center gap-2">
          {result === undefined ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running
            </span>
          ) : isError ? (
            <span className="inline-flex items-center rounded-full border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-red-700 dark:text-red-200">
              Error
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-emerald-400/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-200">
              Complete
            </span>
          )}
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {rawArgsText ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Input
              </div>
              <pre className="overflow-x-auto rounded-md bg-accent/40 p-2 text-xs text-foreground">{rawArgsText}</pre>
            </div>
          ) : null}
          {result !== undefined ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Result
              </div>
              <pre className="overflow-x-auto rounded-md bg-accent/40 p-2 text-xs text-foreground">{resultText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IssueChatUserMessage() {
  const { onInterruptQueued, interruptingQueuedRunId } = useContext(IssueChatCtx);
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const queued = custom.queueState === "queued" || custom.clientStatus === "queued";
  const pending = custom.clientStatus === "pending";
  const queueTargetRunId = typeof custom.queueTargetRunId === "string" ? custom.queueTargetRunId : null;
  const [copied, setCopied] = useState(false);

  return (
    <MessagePrimitive.Root id={anchorId}>
      <div className="group relative">
        <div className="flex flex-col items-end">
          <div
            className={cn(
              "max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5",
              queued
                ? "bg-amber-50/80 dark:bg-amber-500/10"
                : "bg-muted",
              pending && "opacity-80",
            )}
          >
            {queued ? (
              <div className="mb-1.5 flex items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
                  Queued
                </span>
                {queueTargetRunId && onInterruptQueued ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 border-red-300 px-2 text-[11px] text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                    disabled={interruptingQueuedRunId === queueTargetRunId}
                    onClick={() => void onInterruptQueued(queueTargetRunId)}
                  >
                    {interruptingQueuedRunId === queueTargetRunId ? "Interrupting..." : "Interrupt"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {pending ? <div className="mb-1 text-xs text-muted-foreground">Sending...</div> : null}

            <div className="space-y-3">
              <MessagePrimitive.Parts
                components={{
                  Text: ({ text }) => <IssueChatTextPart text={text} />,
                }}
              />
            </div>
          </div>

          <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={anchorId ? `#${anchorId}` : undefined}
                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {message.createdAt ? formatShortDate(message.createdAt) : ""}
                </a>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {message.createdAt ? formatDateTime(message.createdAt) : ""}
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title="Copy message"
              aria-label="Copy message"
              onClick={() => {
                const text = message.content
                  .filter((p): p is { type: "text"; text: string } => p.type === "text")
                  .map((p) => p.text)
                  .join("\n\n");
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <Avatar size="sm" className="absolute -right-8 top-1 shrink-0">
          <AvatarFallback>You</AvatarFallback>
        </Avatar>
      </div>
    </MessagePrimitive.Root>
  );
}

function IssueChatAssistantMessage() {
  const {
    feedbackVoteByTargetId,
    feedbackDataSharingPreference,
    feedbackTermsUrl,
    onVote,
    agentMap,
  } = useContext(IssueChatCtx);
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName = typeof custom.authorName === "string"
    ? custom.authorName
    : typeof custom.runAgentName === "string"
      ? custom.runAgentName
      : "Agent";
  const authorAgentId = typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
    : [];
  const waitingText = typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning = message.role === "assistant" && message.status?.type === "running";
  const runHref = runId && runAgentId ? `/agents/${runAgentId}/runs/${runId}` : null;

  const handleVote = async (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => {
    if (!commentId || !onVote) return;
    await onVote(commentId, vote, options);
  };

  const activeVote = commentId ? feedbackVoteByTargetId.get(commentId) ?? null : null;

  return (
    <MessagePrimitive.Root id={anchorId}>
      <div className="flex items-start gap-2.5 py-1.5">
        <Avatar size="sm" className="mt-0.5 shrink-0">
          {agentIcon ? (
            <AvatarFallback><AgentIcon icon={agentIcon} className="h-3.5 w-3.5" /></AvatarFallback>
          ) : (
            <AvatarFallback>{initialsForName(authorName)}</AvatarFallback>
          )}
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{authorName}</span>
              {isRunning ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <a href={anchorId ? `#${anchorId}` : undefined} className="hover:text-foreground hover:underline">
                {message.createdAt ? formatShortDate(message.createdAt) : ""}
              </a>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    title="More actions"
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      const text = message.content
                        .filter((p): p is { type: "text"; text: string } => p.type === "text")
                        .map((p) => p.text)
                        .join("\n\n");
                      void navigator.clipboard.writeText(text);
                    }}
                  >
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    Copy message
                  </DropdownMenuItem>
                  {runHref ? (
                    <DropdownMenuItem asChild>
                      <Link to={runHref}>View run</Link>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="space-y-3">
            <MessagePrimitive.Parts
              components={{
                Text: ({ text }) => <IssueChatTextPart text={text} />,
                ChainOfThought: IssueChatChainOfThought,
              }}
            />
            {message.content.length === 0 && waitingText ? (
              <div className="rounded-sm bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
                {waitingText}
              </div>
            ) : null}
            {notices.length > 0 ? (
              <div className="space-y-2">
                {notices.map((notice, index) => (
                  <div
                    key={`${message.id}:notice:${index}`}
                    className="rounded-sm border border-border/60 bg-accent/20 px-3 py-2 text-sm text-muted-foreground"
                  >
                    {notice}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-2 flex items-center gap-1">
            <ActionBarPrimitive.Copy
              copiedDuration={2000}
              className="group inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[copied=true]:text-foreground"
              title="Copy message"
              aria-label="Copy message"
            >
              <Copy className="h-3.5 w-3.5 group-data-[copied=true]:hidden" />
              <Check className="hidden h-3.5 w-3.5 group-data-[copied=true]:block" />
            </ActionBarPrimitive.Copy>
            {commentId && onVote ? (
              <IssueChatFeedbackButtons
                activeVote={activeVote}
                sharingPreference={feedbackDataSharingPreference}
                termsUrl={feedbackTermsUrl ?? null}
                onVote={handleVote}
              />
            ) : null}
          </div>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function IssueChatFeedbackButtons({
  activeVote,
  sharingPreference = "prompt",
  termsUrl,
  onVote,
}: {
  activeVote: FeedbackVoteValue | null;
  sharingPreference: FeedbackDataSharingPreference;
  termsUrl: string | null;
  onVote: (vote: FeedbackVoteValue, options?: { allowSharing?: boolean; reason?: string }) => Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [optimisticVote, setOptimisticVote] = useState<FeedbackVoteValue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [downvoteReason, setDownvoteReason] = useState("");
  const [pendingSharingDialog, setPendingSharingDialog] = useState<{
    vote: FeedbackVoteValue;
    reason?: string;
  } | null>(null);
  const visibleVote = optimisticVote ?? activeVote ?? null;

  useEffect(() => {
    if (optimisticVote && activeVote === optimisticVote) setOptimisticVote(null);
  }, [activeVote, optimisticVote]);

  async function doVote(
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) {
    setIsSaving(true);
    try {
      await onVote(vote, options);
    } catch {
      setOptimisticVote(null);
    } finally {
      setIsSaving(false);
    }
  }

  function handleVote(vote: FeedbackVoteValue, reason?: string) {
    setOptimisticVote(vote);
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote, ...(reason ? { reason } : {}) });
      return;
    }
    const allowSharing = sharingPreference === "allowed";
    void doVote(vote, {
      ...(allowSharing ? { allowSharing: true } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  function handleThumbsUp() {
    handleVote("up");
  }

  function handleThumbsDown() {
    setOptimisticVote("down");
    setReasonOpen(true);
    // Submit the initial down vote right away
    handleVote("down");
  }

  function handleSubmitReason() {
    if (!downvoteReason.trim()) return;
    // Re-submit with reason attached
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote: "down", reason: downvoteReason });
    } else {
      const allowSharing = sharingPreference === "allowed";
      void doVote("down", {
        ...(allowSharing ? { allowSharing: true } : {}),
        reason: downvoteReason,
      });
    }
    setReasonOpen(false);
    setDownvoteReason("");
  }

  return (
    <>
      <button
        type="button"
        disabled={isSaving}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          visibleVote === "up"
            ? "text-green-600 dark:text-green-400"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title="Helpful"
        aria-label="Helpful"
        onClick={handleThumbsUp}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <Popover open={reasonOpen} onOpenChange={setReasonOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isSaving}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              visibleVote === "down"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title="Needs work"
            aria-label="Needs work"
            onClick={handleThumbsDown}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <div className="mb-2 text-sm font-medium">What could have been better?</div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder="Add a short note"
            className="min-h-20 resize-y bg-background text-sm"
            disabled={isSaving}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setReasonOpen(false);
                setDownvoteReason("");
              }}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || !downvoteReason.trim()}
              onClick={handleSubmitReason}
            >
              {isSaving ? "Saving..." : "Save note"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={Boolean(pendingSharingDialog)}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setPendingSharingDialog(null);
            setOptimisticVote(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your feedback sharing preference</DialogTitle>
            <DialogDescription>
              Choose whether voted AI outputs can be shared with Paperclip Labs. This
              answer becomes the default for future thumbs up and thumbs down votes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>This vote is always saved locally.</p>
            <p>
              Choose <span className="font-medium text-foreground">Always allow</span> to share
              this vote and future voted AI outputs. Choose{" "}
              <span className="font-medium text-foreground">Don't allow</span> to keep this vote
              and future votes local.
            </p>
            <p>You can change this later in Instance Settings &gt; General.</p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(
                  pendingSharingDialog.vote,
                  pendingSharingDialog.reason ? { reason: pendingSharingDialog.reason } : undefined,
                ).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? "Saving..." : "Don't allow"}
            </Button>
            <Button
              type="button"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(pendingSharingDialog.vote, {
                  allowSharing: true,
                  ...(pendingSharingDialog.reason ? { reason: pendingSharingDialog.reason } : {}),
                }).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? "Saving..." : "Always allow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function IssueChatSystemMessage() {
  const { agentMap, currentUserId } = useContext(IssueChatCtx);
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgentName = typeof custom.runAgentName === "string" ? custom.runAgentName : null;
  const runStatus = typeof custom.runStatus === "string" ? custom.runStatus : null;
  const actorName = typeof custom.actorName === "string" ? custom.actorName : null;
  const actorType = typeof custom.actorType === "string" ? custom.actorType : null;
  const actorId = typeof custom.actorId === "string" ? custom.actorId : null;
  const statusChange = typeof custom.statusChange === "object" && custom.statusChange
    ? custom.statusChange as { from: string | null; to: string | null }
    : null;
  const assigneeChange = typeof custom.assigneeChange === "object" && custom.assigneeChange
    ? custom.assigneeChange as {
        from: IssueTimelineAssignee;
        to: IssueTimelineAssignee;
      }
    : null;

  if (custom.kind === "event" && actorName) {
    const isCurrentUser = actorType === "user" && !!currentUserId && actorId === currentUserId;
    const isAgent = actorType === "agent";
    const agentIcon = isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;

    const eventContent = (
      <div className="min-w-0 space-y-1">
        <div className={cn("flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs", isCurrentUser && "justify-end")}>
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">updated this task</span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {statusChange ? (
          <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isCurrentUser && "justify-end")}>
            <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </span>
            <span className="text-muted-foreground">{humanizeValue(statusChange.from)}</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-foreground">{humanizeValue(statusChange.to)}</span>
          </div>
        ) : null}

        {assigneeChange ? (
          <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isCurrentUser && "justify-end")}>
            <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Assignee
            </span>
            <span className="text-muted-foreground">
              {formatTimelineAssigneeLabel(assigneeChange.from, agentMap, currentUserId)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {formatTimelineAssigneeLabel(assigneeChange.to, agentMap, currentUserId)}
            </span>
          </div>
        ) : null}
      </div>
    );

    if (isCurrentUser) {
      return (
        <MessagePrimitive.Root id={anchorId}>
          <div className="flex items-start justify-end gap-2 py-1">
            {eventContent}
          </div>
        </MessagePrimitive.Root>
      );
    }

    return (
      <MessagePrimitive.Root id={anchorId}>
        <div className="flex items-start gap-2.5 py-1">
          <Avatar size="sm" className="mt-0.5">
            {agentIcon ? (
              <AvatarFallback><AgentIcon icon={agentIcon} className="h-3.5 w-3.5" /></AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(actorName)}</AvatarFallback>
            )}
          </Avatar>
          <div className="flex-1">
            {eventContent}
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  const displayedRunAgentName = runAgentName ?? (runAgentId ? agentMap?.get(runAgentId)?.name ?? runAgentId.slice(0, 8) : null);
  const runAgentIcon = runAgentId ? agentMap?.get(runAgentId)?.icon : undefined;
  if (custom.kind === "run" && runId && runAgentId && displayedRunAgentName && runStatus) {
    return (
      <MessagePrimitive.Root id={anchorId}>
        <div className="flex items-center gap-2.5 py-1">
          <Avatar size="sm">
            {runAgentIcon ? (
              <AvatarFallback><AgentIcon icon={runAgentIcon} className="h-3.5 w-3.5" /></AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(displayedRunAgentName)}</AvatarFallback>
            )}
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <Link to={`/agents/${runAgentId}`} className="font-medium text-foreground transition-colors hover:underline">
                {displayedRunAgentName}
              </Link>
              <span className="text-muted-foreground">run</span>
              <Link
                to={`/agents/${runAgentId}/runs/${runId}`}
                className="inline-flex items-center rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {runId.slice(0, 8)}
              </Link>
              <span className={cn("font-medium", runStatusClass(runStatus))}>
                {formatRunStatusLabel(runStatus)}
              </span>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
              >
                {timeAgo(message.createdAt)}
              </a>
            </div>
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  return null;
}

function IssueChatComposer({
  onImageUpload,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  agentMap,
  composerDisabledReason = null,
  issueStatus,
}: {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  composerDisabledReason?: string | null;
  issueStatus?: string;
}) {
  const api = useAui();
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(issueStatus === "done" || issueStatus === "cancelled");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : undefined;
    const submittedBody = trimmed;

    setSubmitting(true);
    setBody("");
    try {
      await api.thread().append({
        role: "user",
        content: [{ type: "text", text: submittedBody }],
        metadata: { custom: {} },
        attachments: [],
        runConfig: {
          custom: {
            ...(reopen ? { reopen: true } : {}),
            ...(reassignment ? { reassignment } : {}),
          },
        },
      });
      if (draftKey) clearDraft(draftKey);
      setReopen(issueStatus === "done" || issueStatus === "cancelled");
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (onImageUpload) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply"
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={onImageUpload}
        contentClassName="min-h-[72px] text-sm"
      />

      <div className="mt-3 flex items-center justify-end gap-3">
        {(onImageUpload || onAttachImage) ? (
          <div className="mr-auto flex items-center gap-3">
            <input
              ref={attachInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAttachFile}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => attachInputRef.current?.click()}
              disabled={attaching}
              title="Attach image"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={reopen}
            onChange={(event) => setReopen(event.target.checked)}
            className="rounded border-border"
          />
          Re-open
        </label>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Assignee"
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option) return <span className="text-muted-foreground">Assignee</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {submitting ? "Posting..." : "Send"}
        </Button>
      </div>
    </div>
  );
}

export function IssueChatThread({
  comments,
  feedbackVotes = [],
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  linkedRuns = [],
  timelineEvents = [],
  liveRuns = [],
  activeRun = null,
  companyId,
  projectId,
  issueStatus,
  agentMap,
  currentUserId,
  onVote,
  onAdd,
  onCancelRun,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  composerDisabledReason = null,
  showComposer = true,
  enableLiveTranscriptPolling = true,
  transcriptsByRunId,
  hasOutputForRun: hasOutputForRunOverride,
  onInterruptQueued,
  interruptingQueuedRunId = null,
}: IssueChatThreadProps) {
  const location = useLocation();
  const hasScrolledRef = useRef(false);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const displayLiveRuns = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
      });
    }
    return [...deduped.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [activeRun, liveRuns]);
  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: enableLiveTranscriptPolling ? displayLiveRuns : [],
    companyId,
  });
  const resolvedTranscriptByRun = transcriptsByRunId ?? transcriptByRun;
  const resolvedHasOutputForRun = hasOutputForRunOverride ?? hasOutputForRun;

  const messages = useMemo(
    () =>
      buildIssueChatMessages({
        comments,
        timelineEvents,
        linkedRuns,
        liveRuns,
        activeRun,
        transcriptsByRunId: resolvedTranscriptByRun,
        hasOutputForRun: resolvedHasOutputForRun,
        companyId,
        projectId,
        agentMap,
        currentUserId,
      }),
    [
      comments,
      timelineEvents,
      linkedRuns,
      liveRuns,
      activeRun,
      resolvedTranscriptByRun,
      resolvedHasOutputForRun,
      companyId,
      projectId,
      agentMap,
      currentUserId,
    ],
  );

  const isRunning = displayLiveRuns.some((run) => run.status === "queued" || run.status === "running");
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);

  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, reopen, reassignment }) => onAdd(body, reopen, reassignment),
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const hash = location.hash;
    if (!(hash.startsWith("#comment-") || hash.startsWith("#activity-") || hash.startsWith("#run-"))) return;
    if (messages.length === 0 || hasScrolledRef.current) return;
    const targetId = hash.slice(1);
    const element = document.getElementById(targetId);
    if (!element) return;
    hasScrolledRef.current = true;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [location.hash, messages]);

  function handleJumpToLatest() {
    bottomAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  const chatCtx = useMemo<IssueChatMessageContext>(
    () => ({
      feedbackVoteByTargetId,
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      onVote,
      onInterruptQueued,
      interruptingQueuedRunId,
    }),
    [
      feedbackVoteByTargetId,
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      onVote,
      onInterruptQueued,
      interruptingQueuedRunId,
    ],
  );

  const components = useMemo(
    () => ({
      UserMessage: IssueChatUserMessage,
      AssistantMessage: IssueChatAssistantMessage,
      SystemMessage: IssueChatSystemMessage,
    }),
    [],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <IssueChatCtx.Provider value={chatCtx}>
      <div className="space-y-4">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleJumpToLatest}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Jump to latest
          </button>
        </div>

        <ThreadPrimitive.Root className="">
          <ThreadPrimitive.Viewport className="space-y-4">
            <ThreadPrimitive.Empty>
              <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
                This issue conversation is empty. Start with a message below.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={components} />
            <div ref={bottomAnchorRef} />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        {showComposer ? (
          <IssueChatComposer
            onImageUpload={imageUploadHandler}
            onAttachImage={onAttachImage}
            draftKey={draftKey}
            enableReassign={enableReassign}
            reassignOptions={reassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            suggestedAssigneeValue={suggestedAssigneeValue}
            mentions={mentions}
            agentMap={agentMap}
            composerDisabledReason={composerDisabledReason}
            issueStatus={issueStatus}
          />
        ) : null}
      </div>
      </IssueChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}
