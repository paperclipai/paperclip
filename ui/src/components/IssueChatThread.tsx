import {
  AssistantRuntimeProvider,
  useAui,
} from "@assistant-ui/react";
import type {
  ReasoningMessagePart,
  TextMessagePart,
  ThreadMessage,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import {
  createContext,
  Component,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type ErrorInfo,
  type Ref,
  type ReactNode,
} from "react";
import { Link, useLocation } from "@/lib/router";
import type {
  Agent,
  FeedbackDataSharingPreference,
  FeedbackVote,
  FeedbackVoteValue,
  IssueAttachment,
  IssueBlockerAttention,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePaperclipIssueRuntime, type PaperclipIssueRuntimeReassignment } from "../hooks/usePaperclipIssueRuntime";
import {
  buildIssueChatMessages,
  formatDurationWords,
  stabilizeThreadMessages,
  type IssueChatComment,
  type IssueChatLinkedRun,
  type StableThreadMessageCacheEntry,
  type IssueChatTranscriptEntry,
  type SegmentTiming,
} from "../lib/issue-chat-messages";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import { buildIssueThreadInteractionSummary, isIssueThreadInteraction } from "../lib/issue-thread-interactions";
import { resolveIssueChatTranscriptRuns } from "../lib/issueChatTranscriptRuns";
import type { IssueTimelineAssignee, IssueTimelineEvent } from "../lib/issue-timeline-events";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { AgentIcon } from "./AgentIconPicker";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "../lib/issue-chat-scroll";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { useOptionalToastActions } from "../context/ToastContext";
import type { CompanyUserProfile } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import {
  describeToolInput,
  displayToolName,
  formatToolPayload,
  isCommandTool,
  parseToolPayload,
  summarizeToolInput,
  summarizeToolResult,
} from "../lib/transcriptPresentation";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, ArrowRight, Brain, Check, ChevronDown, Copy, Hammer, Loader2, MoreHorizontal, Paperclip, PauseCircle, Search, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { IssueBlockedNotice } from "./IssueBlockedNotice";

interface IssueChatMessageContext {
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  feedbackTermsUrl: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onStopRun?: (runId: string) => Promise<void>;
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
}

const IssueChatCtx = createContext<IssueChatMessageContext>({
  feedbackDataSharingPreference: "prompt",
  feedbackTermsUrl: null,
});

export function resolveAssistantMessageFoldedState(args: {
  messageId: string;
  currentFolded: boolean;
  isFoldable: boolean;
  previousMessageId: string | null;
  previousIsFoldable: boolean;
}) {
  const {
    messageId,
    currentFolded,
    isFoldable,
    previousMessageId,
    previousIsFoldable,
  } = args;

  if (messageId !== previousMessageId) return isFoldable;
  if (!isFoldable) return false;
  if (!previousIsFoldable) return true;
  return currentFolded;
}

export function canStopIssueChatRun(args: {
  runId: string | null;
  runStatus: string | null;
  activeRunIds: ReadonlySet<string>;
}) {
  const { runId, runStatus, activeRunIds } = args;
  if (!runId) return false;
  if (activeRunIds.has(runId)) return true;
  return runStatus === "queued" || runStatus === "running";
}

function findCoTSegmentIndex(
  messageParts: ReadonlyArray<{ type: string }>,
  cotParts: ReadonlyArray<{ type: string }>,
): number {
  if (cotParts.length === 0) return -1;
  const firstPart = cotParts[0];
  let segIdx = -1;
  let inCoT = false;
  for (const part of messageParts) {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (!inCoT) { segIdx++; inCoT = true; }
      if (part === firstPart) return segIdx;
    } else {
      inCoT = false;
    }
  }
  return -1;
}

function useLiveElapsed(startMs: number | null | undefined, active: boolean): string | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!active || !startMs) return;
    const interval = setInterval(() => rerender((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [active, startMs]);
  if (!active || !startMs) return null;
  return formatDurationWords(Date.now() - startMs);
}

function useStableEvent<T extends (...args: never[]) => unknown>(callback: T | undefined): T | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useMemo(() => {
    if (!callback) return undefined;
    return ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T;
    // Keep the wrapper stable while the callback identity changes; the ref above
    // carries the current callback implementation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(callback)]);
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
}

interface IssueChatComposerProps {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  issueStatus?: string;
}

interface IssueChatThreadProps {
  comments: IssueChatComment[];
  interactions?: IssueThreadInteraction[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: IssueChatLinkedRun[];
  timelineEvents?: IssueTimelineEvent[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention | null;
  companyId?: string | null;
  projectId?: string | null;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  onCancelRun?: () => Promise<void>;
  onStopRun?: (runId: string) => Promise<void>;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  showComposer?: boolean;
  showJumpToLatest?: boolean;
  emptyMessage?: string;
  variant?: "full" | "embedded";
  enableLiveTranscriptPolling?: boolean;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  includeSucceededRunsWithoutOutput?: boolean;
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  interruptingQueuedRunId?: string | null;
  stoppingRunId?: string | null;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  composerRef?: Ref<IssueChatComposerHandle>;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
}

type IssueChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  children: ReactNode;
};

type IssueChatErrorBoundaryState = {
  hasError: boolean;
};

class IssueChatErrorBoundary extends Component<IssueChatErrorBoundaryProps, IssueChatErrorBoundaryState> {
  override state: IssueChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): IssueChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Issue chat renderer failed; falling back to safe transcript view", {
      error,
      info: info.componentStack,
    });
  }

  override componentDidUpdate(prevProps: IssueChatErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <IssueChatFallbackThread
          messages={this.props.messages}
          emptyMessage={this.props.emptyMessage}
          variant={this.props.variant}
        />
      );
    }
    return this.props.children;
  }
}

function IssueAssigneePausedNotice({ agent }: { agent: Agent | null }) {
  if (!agent || agent.status !== "paused") return null;

  const pauseDetail =
    agent.pauseReason === "budget"
      ? "It was paused by a budget hard stop."
      : agent.pauseReason === "system"
        ? "It was paused by the system."
        : "It was paused manually.";

  return (
    <div className="mb-3 rounded-md border border-orange-300/70 bg-orange-50/90 px-3 py-2.5 text-sm text-orange-950 shadow-sm dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-100">
      <div className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
        <p className="min-w-0 leading-5">
          <span className="font-medium">{agent.name}</span> is paused. New runs will not start until the agent is resumed. {pauseDetail}
        </p>
      </div>
    </div>
  );
}

function fallbackAuthorLabel(message: ThreadMessage) {
  const custom = message.metadata?.custom as Record<string, unknown> | undefined;
  if (typeof custom?.["authorName"] === "string") return custom["authorName"];
  if (typeof custom?.["runAgentName"] === "string") return custom["runAgentName"];
  if (message.role === "assistant") return "Agent";
  if (message.role === "user") return "You";
  return "System";
}

function fallbackTextParts(message: ThreadMessage) {
  const contentLines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim().length > 0) contentLines.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      const lines = [`Tool: ${part.toolName}`];
      if (part.argsText?.trim()) lines.push(`Args:\n${part.argsText}`);
      if (typeof part.result === "string" && part.result.trim()) lines.push(`Result:\n${part.result}`);
      contentLines.push(lines.join("\n\n"));
    }
  }

  const custom = message.metadata?.custom as Record<string, unknown> | undefined;
  if (contentLines.length === 0 && typeof custom?.["waitingText"] === "string" && custom["waitingText"].trim()) {
    contentLines.push(custom["waitingText"]);
  }
  return contentLines;
}

function IssueChatFallbackThread({
  messages,
  emptyMessage,
  variant,
}: {
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
}) {
  return (
    <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
      <div className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Chat renderer hit an internal state error.</p>
            <p className="text-xs opacity-80">
              Showing a safe fallback transcript instead of crashing the issues page.
            </p>
          </div>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className={cn(
          "text-center text-sm text-muted-foreground",
          variant === "embedded"
            ? "rounded-xl border border-dashed border-border/70 bg-background/60 px-4 py-6"
            : "rounded-2xl border border-dashed border-border bg-card px-6 py-10",
        )}>
          {emptyMessage}
        </div>
      ) : (
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {messages.map((message) => {
            const lines = fallbackTextParts(message);
            return (
              <div key={message.id} className="rounded-xl border border-border/60 bg-card/70 px-4 py-3">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">{fallbackAuthorLabel(message)}</span>
                  {message.createdAt ? (
                    <span className="text-[11px] text-muted-foreground">
                      {commentDateLabel(message.createdAt)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {lines.length > 0 ? lines.map((line, index) => (
                    <MarkdownBody key={`${message.id}:fallback:${index}`}>{line}</MarkdownBody>
                  )) : (
                    <p className="text-sm text-muted-foreground">No message content.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DRAFT_DEBOUNCE_MS = 800;
const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;
const SUBMIT_SCROLL_RESERVE_VH = 0.4;

type ComposerAttachmentItem = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

function hasFilePayload(evt: ReactDragEvent<HTMLDivElement>) {
  return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

function shouldImplicitlyReopenComment(issueStatus: string | undefined, assigneeValue: string) {
  const resumesToTodo = issueStatus === "done" || issueStatus === "cancelled" || issueStatus === "blocked";
  return resumesToTodo && assigneeValue.startsWith("agent:");
}

function isUnassignedReassignValue(value: string): boolean {
  return !value || value === "__none__";
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function commentDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

const IssueChatTextPart = memo(function IssueChatTextPart({ text, recessed }: { text: string; recessed?: boolean }) {
  const { onImageClick } = useContext(IssueChatCtx);
  return (
    <MarkdownBody
      className="text-sm leading-6"
      style={recessed ? { opacity: 0.55 } : undefined}
      softBreaks
      onImageClick={onImageClick}
    >
      {text}
    </MarkdownBody>
  );
});

function humanizeValue(value: string | null) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function formatTimelineAssigneeLabel(
  assignee: IssueTimelineAssignee,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
  userLabelMap?: ReadonlyMap<string, string> | null,
) {
  if (assignee.agentId) {
    return agentMap?.get(assignee.agentId)?.name ?? assignee.agentId.slice(0, 8);
  }
  if (assignee.userId) {
    return formatAssigneeUserLabel(assignee.userId, currentUserId, userLabelMap) ?? "Board";
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

function formatInteractionActorLabel(args: {
  agentId?: string | null;
  userId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { agentId, userId, agentMap, currentUserId, userLabelMap } = args;
  if (agentId) return agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
  if (userId) {
    return userLabelMap?.get(userId)
      ?? formatAssigneeUserLabel(userId, currentUserId, userLabelMap)
      ?? "Board";
  }
  return "System";
}

export function resolveIssueChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap } = args;
  const profile = authorUserId ? userProfileMap?.get(authorUserId) ?? null : null;
  const isCurrentUser = Boolean(authorUserId && currentUserId && authorUserId === currentUserId);
  const resolvedAuthorName = profile?.label?.trim()
    || authorName?.trim()
    || (authorUserId === "local-board" ? "Board" : (isCurrentUser ? "You" : "User"));

  return {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl: profile?.image ?? null,
  };
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

function toolCountSummary(toolParts: ToolCallMessagePart[]): string | null {
  if (toolParts.length === 0) return null;
  let commands = 0;
  let other = 0;
  for (const tool of toolParts) {
    if (isCommandTool(tool.toolName, tool.args)) commands++;
    else other++;
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`called ${other} tool${other === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function cleanToolDisplayText(tool: ToolCallMessagePart): string {
  const name = displayToolName(tool.toolName, tool.args);
  if (isCommandTool(tool.toolName, tool.args)) return name;
  const summary = tool.result === undefined
    ? summarizeToolInput(tool.toolName, tool.args)
    : null;
  return summary ? `${name} ${summary}` : name;
}

type IssueChatCoTPart = ReasoningMessagePart | ToolCallMessagePart;

function IssueChatChainOfThought({
  message,
  cotParts,
}: {
  message: ThreadMessage;
  cotParts: readonly IssueChatCoTPart[];
}) {
  const { agentMap } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const authorAgentId = typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const isMessageRunning = message.role === "assistant" && message.status?.type === "running";

  const myIndex = useMemo(
    () => findCoTSegmentIndex(message.content, cotParts),
    [message.content, cotParts],
  );

  const allReasoningText = cotParts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning" && !!p.text)
    .map((p) => p.text)
    .join("\n");
  const toolParts = cotParts.filter(
    (p): p is ToolCallMessagePart => p.type === "tool-call",
  );

  const isActive = isMessageRunning;
  const [expanded, setExpanded] = useState(isActive);

  const rawSegments = Array.isArray(custom.chainOfThoughtSegments)
    ? (custom.chainOfThoughtSegments as SegmentTiming[])
    : [];
  const segmentTiming = myIndex >= 0 ? rawSegments[myIndex] ?? null : null;
  const liveElapsed = useLiveElapsed(segmentTiming?.startMs, isActive);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  let headerVerb: string;
  let headerSuffix: string | null = null;
  if (isActive) {
    headerVerb = "Working";
    if (liveElapsed) headerSuffix = `for ${liveElapsed}`;
  } else if (segmentTiming) {
    const durationMs = segmentTiming.endMs - segmentTiming.startMs;
    const durationText = formatDurationWords(durationMs);
    headerVerb = "Worked";
    if (durationText) headerSuffix = `for ${durationText}`;
  } else {
    headerVerb = "Worked";
  }

  const toolSummary = toolCountSummary(toolParts);
  const hasContent = allReasoningText.trim().length > 0 || toolParts.length > 0;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-accent/5"
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
          {agentIcon ? (
            <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
          ) : isActive ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
            </span>
          )}
          {isActive ? (
            <span className="shimmer-text">{headerVerb}</span>
          ) : (
            headerVerb
          )}
        </span>
        {headerSuffix ? (
          <span className="text-xs text-muted-foreground/60">{headerSuffix}</span>
        ) : null}
        {toolSummary ? (
          <span className="text-xs text-muted-foreground/40">· {toolSummary}</span>
        ) : null}
        {hasContent ? (
          <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-180")} />
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="space-y-1 py-1">
          {isActive ? (
            <>
              {allReasoningText ? <IssueChatReasoningPart text={allReasoningText} /> : null}
              {toolParts.length > 0 ? <IssueChatRollingToolPart toolParts={toolParts} /> : null}
            </>
          ) : (
            <>
              {allReasoningText ? <IssueChatReasoningPart text={allReasoningText} /> : null}
              {toolParts.map((tool) => (
                <IssueChatToolPart
                  key={tool.toolCallId}
                  toolName={tool.toolName}
                  args={tool.args}
                  argsText={tool.argsText}
                  result={tool.result}
                  isError={false}
                />
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function IssueChatReasoningPart({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] ?? text.slice(-200);
  const prevRef = useRef(lastLine);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: lastLine, exiting: null });

  useEffect(() => {
    if (lastLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = lastLine;
      setTicker((t) => ({ key: t.key + 1, current: lastLine, exiting: prev }));
    }
  }, [lastLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-[13px] italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-[13px] italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function IssueChatRollingToolPart({ toolParts }: { toolParts: ToolCallMessagePart[] }) {
  const latest = toolParts[toolParts.length - 1];
  if (!latest) return null;

  const fullText = cleanToolDisplayText(latest);

  const prevRef = useRef(fullText);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: fullText, exiting: null });

  useEffect(() => {
    if (fullText !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = fullText;
      setTicker((t) => ({ key: t.key + 1, current: fullText, exiting: prev }));
    }
  }, [fullText]);

  const ToolIcon = getToolIcon(latest.toolName);
  const isRunning = latest.result === undefined;

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
        ) : (
          <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-[13px] leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-[13px] leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function CopyablePreBlock({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/pre relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/pre:opacity-100",
          copied && "opacity-100",
        )}
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

const TOOL_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  // Extend with specific tool icons as they become known
};

function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICON_MAP[toolName] ?? Hammer;
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
  const [open, setOpen] = useState(false);
  const rawArgsText = argsText ?? "";
  const parsedArgs = args ?? parseToolPayload(rawArgsText);
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : formatToolPayload(result);
  const inputDetails = describeToolInput(toolName, parsedArgs);
  const displayName = displayToolName(toolName, parsedArgs);
  const isCommand = isCommandTool(toolName, parsedArgs);
  const summary = isCommand
    ? null
    : result === undefined
      ? summarizeToolInput(toolName, parsedArgs)
      : summarizeToolResult(resultText, false);
  const ToolIcon = getToolIcon(toolName);

  const intentDetail = inputDetails.find((d) => d.label === "Intent");
  const title = intentDetail?.value ?? displayName;
  const nonIntentDetails = inputDetails.filter((d) => d.label !== "Intent");

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-1">
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        {open ? <div className="mt-1 w-px flex-1 bg-border/40" /> : null}
      </div>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-accent/5"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/80">
            {title}
            {!intentDetail && summary ? <span className="ml-1.5 text-muted-foreground/50">{summary}</span> : null}
          </span>
          {result === undefined ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
          ) : null}
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform", open && "rotate-180")} />
        </button>

        {open ? (
          <div className="mt-1 space-y-2 pb-1">
            {nonIntentDetails.length > 0 ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                  Input
                </div>
                <dl className="space-y-1.5">
                  {nonIntentDetails.map((detail) => (
                    <div key={`${detail.label}:${detail.value}`}>
                      <dt className="text-[10px] font-medium text-muted-foreground/60">
                        {detail.label}
                      </dt>
                      <dd className={cn("text-xs leading-5 text-foreground/70", detail.tone === "code" && "font-mono text-[11px]")}>
                        {detail.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : rawArgsText ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                  Input
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-[11px] leading-4 text-foreground/70">{rawArgsText}</CopyablePreBlock>
              </div>
            ) : null}
            {result !== undefined ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                  Result
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-[11px] leading-4 text-foreground/70">{resultText}</CopyablePreBlock>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getThreadMessageCopyText(message: ThreadMessage) {
  return message.content
    .filter((part): part is TextMessagePart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

const IssueChatTextParts = memo(function IssueChatTextParts({
  message,
  recessed = false,
}: {
  message: ThreadMessage;
  recessed?: boolean;
}) {
  return (
    <>
      {message.content
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part, index) => (
          <IssueChatTextPart
            key={`${message.id}:text:${index}`}
            text={part.text}
            recessed={recessed}
          />
        ))}
    </>
  );
});

function groupAssistantParts(
  content: readonly ThreadMessage["content"][number][],
): Array<
  | { type: "text"; part: TextMessagePart; index: number }
  | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
> {
  const groups: Array<
    | { type: "text"; part: TextMessagePart; index: number }
    | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
  > = [];
  let pendingCoT: IssueChatCoTPart[] = [];
  let pendingStartIndex = -1;

  const flushCoT = () => {
    if (pendingCoT.length === 0) return;
    groups.push({ type: "cot", parts: pendingCoT, startIndex: pendingStartIndex });
    pendingCoT = [];
    pendingStartIndex = -1;
  };

  content.forEach((part, index) => {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (pendingCoT.length === 0) pendingStartIndex = index;
      pendingCoT.push(part);
      return;
    }
    flushCoT();
    if (part.type === "text") {
      groups.push({ type: "text", part, index });
    }
  });
  flushCoT();

  return groups;
}

const IssueChatAssistantParts = memo(function IssueChatAssistantParts({
  message,
  hasCoT,
}: {
  message: ThreadMessage;
  hasCoT: boolean;
}) {
  const groupedParts = useMemo(() => groupAssistantParts(message.content), [message.content]);
  return (
    <>
      {groupedParts.map((group) => {
        if (group.type === "text") {
          return (
            <IssueChatTextPart
              key={`${message.id}:text:${group.index}`}
              text={group.part.text}
              recessed={hasCoT}
            />
          );
        }
        return (
          <IssueChatChainOfThought
            key={`${message.id}:cot:${group.startIndex}`}
            message={message}
            cotParts={group.parts}
          />
        );
      })}
    </>
  );
});

function IssueChatUserMessage({
  message,
  isInterruptingQueuedRun,
}: {
  message: ThreadMessage;
  isInterruptingQueuedRun: boolean;
}) {
  const {
    onInterruptQueued,
    onCancelQueued,
    currentUserId,
    userProfileMap,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName = typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId = typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued = custom.queueState === "queued" || custom.clientStatus === "queued";
  const followUpRequested = custom.followUpRequested === true;
  const queueReason = typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel = queueReason === "hold" ? "\u23f8 Deferred wake" : "Queued";
  const pending = custom.clientStatus === "pending";
  const queueTargetRunId = typeof custom.queueTargetRunId === "string" ? custom.queueTargetRunId : null;
  const [copied, setCopied] = useState(false);
  const {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl,
  } = resolveIssueChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,
  });
  const authorAvatar = (
    <Avatar size="sm" className="shrink-0">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={resolvedAuthorName} /> : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const messageBody = (
    <div className={cn("flex min-w-0 max-w-[85%] flex-col", isCurrentUser && "items-end")}>
      <div className={cn("mb-1 flex items-center gap-2 px-1", isCurrentUser ? "justify-end" : "justify-start")}>
        <span className="text-sm font-medium text-foreground">{resolvedAuthorName}</span>
        {followUpRequested ? (
          <Badge variant="outline" className="text-[10px] uppercase tracking-[0.14em]">
            Follow-up
          </Badge>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden break-all rounded-2xl px-4 py-2.5",
          queued
            ? "bg-amber-50/80 dark:bg-amber-500/10"
            : "bg-muted",
          pending && "opacity-80",
        )}
      >
        {queued ? (
          <div className="mb-1.5 flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
              {queueBadgeLabel}
            </span>
            {queueTargetRunId && onInterruptQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-red-300 px-2 text-[11px] text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={isInterruptingQueuedRun}
                onClick={() => void onInterruptQueued(queueTargetRunId)}
              >
                {isInterruptingQueuedRun ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
            {onCancelQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-300 px-2 text-[11px] text-amber-900 hover:bg-amber-100/80 hover:text-amber-950 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/10"
                onClick={() => onCancelQueued(commentId)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 max-w-full space-y-3">
          <IssueChatTextParts message={message} />
        </div>
      </div>

      {pending ? (
        <div className={cn("mt-1 flex px-1 text-[11px] text-muted-foreground", isCurrentUser ? "justify-end" : "justify-start")}>
          Sending...
        </div>
      ) : (
        <div
          className={cn(
            "mt-1 flex items-center gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
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
      )}
    </div>
  );

  return (
    <div id={anchorId}>
      <div className={cn("group flex items-start gap-2.5", isCurrentUser && "justify-end")}>
        {isCurrentUser ? (
          <>
            {messageBody}
            {authorAvatar}
          </>
        ) : (
          <>
            {authorAvatar}
            {messageBody}
          </>
        )}
      </div>
    </div>
  );
}

function IssueChatAssistantMessage({
  message,
  activeVote,
  isRunActive,
  isStoppingRun,
}: {
  message: ThreadMessage;
  activeVote: FeedbackVoteValue | null;
  isRunActive: boolean;
  isStoppingRun: boolean;
}) {
  const {
    feedbackDataSharingPreference,
    feedbackTermsUrl,
    onVote,
    agentMap,
    onStopRun,
  } = useContext(IssueChatCtx);
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
  const runStatus = typeof custom.runStatus === "string" ? custom.runStatus : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
    : [];
  const waitingText = typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning = message.role === "assistant" && message.status?.type === "running";
  const runHref = runId && runAgentId ? `/agents/${runAgentId}/runs/${runId}` : null;
  const canStopRun = Boolean(runId) && (isRunActive || runStatus === "queued" || runStatus === "running");
  const chainOfThoughtLabel = typeof custom.chainOfThoughtLabel === "string" ? custom.chainOfThoughtLabel : null;
  const hasCoT = message.content.some((p) => p.type === "reasoning" || p.type === "tool-call");
  const isFoldable = !isRunning && !!chainOfThoughtLabel;
  const [folded, setFolded] = useState(isFoldable);
  const [prevFoldKey, setPrevFoldKey] = useState({ messageId: message.id, isFoldable });
  const [copied, setCopied] = useState(false);
  const copyText = getThreadMessageCopyText(message);

  // Derive fold state synchronously during render (not in useEffect) so the
  // browser never paints the un-folded intermediate state — prevents the
  // visible "jump" when loading a page with already-folded work sections.
  if (message.id !== prevFoldKey.messageId || isFoldable !== prevFoldKey.isFoldable) {
    const nextFolded = resolveAssistantMessageFoldedState({
      messageId: message.id,
      currentFolded: folded,
      isFoldable,
      previousMessageId: prevFoldKey.messageId,
      previousIsFoldable: prevFoldKey.isFoldable,
    });
    setPrevFoldKey({ messageId: message.id, isFoldable });
    if (nextFolded !== folded) {
      setFolded(nextFolded);
    }
  }

  const handleVote = async (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => {
    if (!commentId || !onVote) return;
    await onVote(commentId, vote, options);
  };

  const followUpRequested = custom.followUpRequested === true;

  return (
    <div id={anchorId}>
      <div className="flex items-start gap-2.5 py-1.5">
        <Avatar size="sm" className="shrink-0">
          {agentIcon ? (
            <AvatarFallback><AgentIcon icon={agentIcon} className="h-3.5 w-3.5" /></AvatarFallback>
          ) : (
            <AvatarFallback>{initialsForName(authorName)}</AvatarFallback>
          )}
        </Avatar>

        <div className="min-w-0 flex-1">
          {isFoldable ? (
            <button
              type="button"
              className="group flex w-full items-center gap-2 py-0.5 text-left"
              onClick={() => setFolded((v) => !v)}
            >
              <span className="text-sm font-medium text-foreground">{authorName}</span>
              <span className="text-xs text-muted-foreground/60">{chainOfThoughtLabel?.toLowerCase()}</span>
              <span className="ml-auto flex items-center gap-1.5">
                {message.createdAt ? (
                  <span className="text-[11px] text-muted-foreground/50">
                    {commentDateLabel(message.createdAt)}
                  </span>
                ) : null}
                <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition-transform", !folded && "rotate-180")} />
              </span>
            </button>
          ) : (
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{authorName}</span>
              {followUpRequested ? (
                <Badge variant="outline" className="text-[10px] uppercase tracking-[0.14em]">
                  Follow-up
                </Badge>
              ) : null}
              {isRunning ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </span>
              ) : null}
            </div>
          )}

          {!folded ? (
            <>
              <div className="space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={hasCoT} />
                {message.content.length === 0 && waitingText ? (
                  <div className="flex items-center gap-2.5 rounded-lg px-1 py-2">
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                      {agentIcon ? (
                        <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
                      ) : (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      )}
                      <span className="shimmer-text">{waitingText}</span>
                    </span>
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
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Copy message"
                  aria-label="Copy message"
                  onClick={() => {
                    void navigator.clipboard.writeText(copyText).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                {commentId && onVote ? (
                  <IssueChatFeedbackButtons
                    activeVote={activeVote}
                    sharingPreference={feedbackDataSharingPreference}
                    termsUrl={feedbackTermsUrl ?? null}
                    onVote={handleVote}
                  />
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={anchorId ? `#${anchorId}` : undefined}
                      className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {message.createdAt ? commentDateLabel(message.createdAt) : ""}
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {message.createdAt ? formatDateTime(message.createdAt) : ""}
                  </TooltipContent>
                </Tooltip>
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
                        void navigator.clipboard.writeText(copyText);
                      }}
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      Copy message
                    </DropdownMenuItem>
                    {canStopRun && onStopRun && runId ? (
                      <DropdownMenuItem
                        disabled={isStoppingRun}
                        className="text-red-700 focus:text-red-800 dark:text-red-300 dark:focus:text-red-200"
                        onSelect={() => {
                          void onStopRun(runId);
                        }}
                      >
                        <Square className="mr-2 h-3.5 w-3.5 fill-current" />
                        {isStoppingRun ? "Stopping…" : "Stop run"}
                      </DropdownMenuItem>
                    ) : null}
                    {runHref ? (
                      <DropdownMenuItem asChild>
                        <Link to={runHref} target="_blank" rel="noreferrer noopener">
                          <Search className="mr-2 h-3.5 w-3.5" />
                          View run
                        </Link>
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
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

function ExpiredRequestConfirmationActivity({
  message,
  anchorId,
  interaction,
}: {
  message: ThreadMessage;
  anchorId?: string;
  interaction: RequestConfirmationInteraction;
}) {
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
  } = useContext(IssueChatCtx);
  const [expanded, setExpanded] = useState(false);
  const hasResolvedActor = Boolean(interaction.resolvedByAgentId || interaction.resolvedByUserId);
  const actorAgentId = hasResolvedActor
    ? interaction.resolvedByAgentId ?? null
    : interaction.createdByAgentId ?? null;
  const actorUserId = hasResolvedActor
    ? interaction.resolvedByUserId ?? null
    : interaction.createdByUserId ?? null;
  const actorName = formatInteractionActorLabel({
    agentId: actorAgentId,
    userId: actorUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const actorIcon = actorAgentId ? agentMap?.get(actorAgentId)?.icon : undefined;
  const isCurrentUser = Boolean(actorUserId && currentUserId && actorUserId === currentUserId);
  const detailsId = anchorId ? `${anchorId}-details` : `${interaction.id}-details`;
  const summary = buildIssueThreadInteractionSummary(interaction);

  const rowContent = (
    <div className="min-w-0 flex-1">
      <div className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs", isCurrentUser && "justify-end")}>
        <span className="font-medium text-foreground">{actorName}</span>
        <span className="text-muted-foreground">updated this task</span>
        <a
          href={anchorId ? `#${anchorId}` : undefined}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {timeAgo(message.createdAt)}
        </a>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
          {expanded ? "Hide confirmation" : "Expired confirmation"}
        </button>
      </div>
      {expanded ? (
        <p className={cn("mt-1 text-xs text-muted-foreground", isCurrentUser && "text-right")}>
          {summary}
        </p>
      ) : null}
    </div>
  );

  return (
    <div id={anchorId}>
      {isCurrentUser ? (
        <div className="flex items-start justify-end gap-2 py-1">
          {rowContent}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 py-1">
          <Avatar size="sm" className="mt-0.5">
            {actorIcon ? (
              <AvatarFallback><AgentIcon icon={actorIcon} className="h-3.5 w-3.5" /></AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(actorName)}</AvatarFallback>
            )}
          </Avatar>
          {rowContent}
        </div>
      )}
      {expanded ? (
        <div id={detailsId} className="mt-2">
          <IssueThreadInteractionCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
          />
        </div>
      ) : null}
    </div>
  );
}

function IssueChatSystemMessage({ message }: { message: ThreadMessage }) {
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
    onSubmitInteractionAnswers,
  } = useContext(IssueChatCtx);
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
  const interaction = isIssueThreadInteraction(custom.interaction)
    ? custom.interaction
    : null;

  if (custom.kind === "interaction" && interaction) {
    if (interaction.kind === "request_confirmation" && interaction.status === "expired") {
      return (
        <ExpiredRequestConfirmationActivity
          message={message}
          anchorId={anchorId}
          interaction={interaction}
        />
      );
    }

    return (
      <div id={anchorId}>
        <div className="py-1.5">
          <IssueThreadInteractionCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
          />
        </div>
      </div>
    );
  }

  if (custom.kind === "event" && actorName) {
    const isCurrentUser = actorType === "user" && !!currentUserId && actorId === currentUserId;
    const isAgent = actorType === "agent";
    const agentIcon = isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;

    const eventContent = (
      <div className="min-w-0 space-y-1">
        <div className={cn("flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs", isCurrentUser && "justify-end")}>
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">
            {custom.followUpRequested === true ? "requested follow-up" : "updated this task"}
          </span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {statusChange ? (
          <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isCurrentUser && "justify-end")}>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </span>
            <span className="text-muted-foreground">{humanizeValue(statusChange.from)}</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-foreground">{humanizeValue(statusChange.to)}</span>
          </div>
        ) : null}

        {assigneeChange ? (
          <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isCurrentUser && "justify-end")}>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Assignee
            </span>
            <span className="text-muted-foreground">
              {formatTimelineAssigneeLabel(assigneeChange.from, agentMap, currentUserId, userLabelMap)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {formatTimelineAssigneeLabel(assigneeChange.to, agentMap, currentUserId, userLabelMap)}
            </span>
          </div>
        ) : null}
      </div>
    );

    if (isCurrentUser) {
      return (
        <div id={anchorId}>
          <div className="flex items-start justify-end gap-2 py-1">
            {eventContent}
          </div>
        </div>
      );
    }

    return (
      <div id={anchorId}>
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
      </div>
    );
  }

  const displayedRunAgentName = runAgentName ?? (runAgentId ? agentMap?.get(runAgentId)?.name ?? runAgentId.slice(0, 8) : null);
  const runAgentIcon = runAgentId ? agentMap?.get(runAgentId)?.icon : undefined;
  if (custom.kind === "run" && runId && runAgentId && displayedRunAgentName && runStatus) {
    return (
      <div id={anchorId}>
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
      </div>
    );
  }

  return null;
}

function issueChatMessageCustom(message: ThreadMessage): Record<string, unknown> {
  return (message.metadata?.custom ?? {}) as Record<string, unknown>;
}

function issueChatMessageKind(message: ThreadMessage): string {
  const custom = issueChatMessageCustom(message);
  return typeof custom.kind === "string" ? custom.kind : message.role;
}

function issueChatMessageCommentId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.commentId === "string" ? custom.commentId : null;
}

function issueChatMessageRunId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.runId === "string" ? custom.runId : null;
}

function issueChatMessageQueueTargetRunId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.queueTargetRunId === "string" ? custom.queueTargetRunId : null;
}

function issueChatMessageActiveVote(
  message: ThreadMessage,
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>,
): FeedbackVoteValue | null {
  const commentId = issueChatMessageCommentId(message);
  return commentId ? feedbackVoteByTargetId.get(commentId) ?? null : null;
}

function issueChatMessageRunIsActive(
  message: ThreadMessage,
  activeRunIds: ReadonlySet<string>,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && activeRunIds.has(runId));
}

function issueChatMessageRunIsStopping(
  message: ThreadMessage,
  stoppingRunId: string | null | undefined,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && stoppingRunId === runId);
}

function issueChatMessageQueuedRunIsInterrupting(
  message: ThreadMessage,
  interruptingQueuedRunId: string | null | undefined,
): boolean {
  const queueTargetRunId = issueChatMessageQueueTargetRunId(message);
  return Boolean(queueTargetRunId && interruptingQueuedRunId === queueTargetRunId);
}

// Above ~150 merged rows the direct render path forces React to mount and
// re-render hundreds of Markdown bodies, feedback controls, and avatars on
// unrelated parent updates. Above this threshold we switch to a windowed
// render path so only visible rows plus overscan stay mounted.
export const VIRTUALIZED_THREAD_ROW_THRESHOLD = 150;
const VIRTUALIZED_THREAD_OVERSCAN = 6;
// Rough "average row" estimate. The virtualizer measures real heights as
// rows mount, so this only affects offscreen rows it has not seen yet.
const VIRTUALIZED_THREAD_ROW_ESTIMATE_PX = 220;
const VIRTUALIZED_THREAD_GAP_FULL_PX = 16;
const VIRTUALIZED_THREAD_GAP_EMBEDDED_PX = 12;

interface VirtualizedIssueChatThreadListProps {
  messages: readonly ThreadMessage[];
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
  variant: "full" | "embedded";
}

interface VirtualizedIssueChatThreadListHandle {
  scrollToIndex: (
    index: number,
    options?: { align?: "start" | "center" | "end" | "auto"; behavior?: ScrollBehavior },
  ) => void;
  scrollToLatest: (options?: { behavior?: ScrollBehavior }) => void;
  measure: () => void;
}

function issueChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = message.metadata.custom as { anchorId?: unknown } | undefined;
  return typeof custom?.anchorId === "string" ? custom.anchorId : null;
}

function findMessageAnchorIndex(messages: readonly ThreadMessage[], anchorId: string): number {
  return messages.findIndex((message) => issueChatMessageAnchorId(message) === anchorId);
}

export function findLatestCommentMessageIndex(messages: readonly ThreadMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const anchorId = issueChatMessageAnchorId(messages[index]);
    if (anchorId && anchorId.startsWith("comment-")) return index;
  }
  return -1;
}

type VirtualizedVisibleAnchorSnapshot = {
  anchorId: string;
  index: number;
  viewportTop: number;
};

type VirtualizedScrollMode =
  | { kind: "window" }
  | { kind: "element"; element: HTMLElement };

type SimpleVirtualItem = {
  index: number;
  key: React.Key;
  start: number;
  size: number;
};

function useIssueThreadVirtualizer({
  count,
  estimateSize,
  overscan,
  scrollMargin,
  gap,
  getItemKey,
  mode,
}: {
  count: number;
  estimateSize: () => number;
  overscan: number;
  scrollMargin: number;
  gap: number;
  getItemKey: (index: number) => React.Key;
  mode: VirtualizedScrollMode;
}) {
  const measuredSizeByKeyRef = useRef(new Map<React.Key, number>());
  const [, rerender] = useState(0);
  const estimatedSize = estimateSize();

  const itemStarts: number[] = [];
  const itemSizes: number[] = [];
  let nextStart = scrollMargin;
  for (let index = 0; index < count; index += 1) {
    const key = getItemKey(index);
    const size = measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
    itemStarts.push(nextStart);
    itemSizes.push(size);
    nextStart += size + gap;
  }
  const totalSize = Math.max(0, nextStart - scrollMargin - gap);

  const viewportHeight = () => (mode.kind === "window" ? window.innerHeight : mode.element.clientHeight);
  const scrollOffset = () => (mode.kind === "window" ? window.scrollY : mode.element.scrollTop);
  const maxScrollOffset = () => {
    const targetScrollHeight = mode.kind === "window"
      ? document.documentElement.scrollHeight
      : mode.element.scrollHeight;
    return Math.max(0, Math.max(targetScrollHeight, totalSize) - viewportHeight());
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target: Window | HTMLElement = mode.kind === "window" ? window : mode.element;
    const update = () => rerender((value) => value + 1);
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const rawStart = Math.max(scrollMargin, scrollOffset());
  const rawEnd = rawStart + viewportHeight();
  let visibleStartIndex = 0;
  while (
    visibleStartIndex < count - 1
    && itemStarts[visibleStartIndex] + itemSizes[visibleStartIndex] < rawStart
  ) {
    visibleStartIndex += 1;
  }
  let visibleEndIndex = visibleStartIndex;
  while (visibleEndIndex < count - 1 && itemStarts[visibleEndIndex] <= rawEnd) {
    visibleEndIndex += 1;
  }
  const startIndex = Math.max(0, visibleStartIndex - overscan);
  const endIndex = Math.min(count - 1, visibleEndIndex + overscan);
  const virtualItems: SimpleVirtualItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    virtualItems.push({
      index,
      key: getItemKey(index),
      start: itemStarts[index] ?? scrollMargin,
      size: itemSizes[index] ?? estimatedSize,
    });
  }

  const scrollToIndex = (
    index: number,
    options?: { align?: "start" | "center" | "end" | "auto"; behavior?: ScrollBehavior },
  ) => {
    const clampedIndex = Math.max(0, Math.min(index, count - 1));
    const targetMax = maxScrollOffset();
    let top = itemStarts[clampedIndex] ?? scrollMargin;
    if (options?.align === "center") {
      top = top - viewportHeight() / 2 + (itemSizes[clampedIndex] ?? estimatedSize) / 2;
    } else if (options?.align === "end") {
      top = top + (itemSizes[clampedIndex] ?? estimatedSize) - viewportHeight();
    }
    top = Math.max(0, Math.min(top, targetMax));
    if (mode.kind === "window") {
      window.scrollTo({ top, behavior: options?.behavior });
    } else {
      mode.element.scrollTo({ top, behavior: options?.behavior });
    }
    rerender((value) => value + 1);
  };

  return {
    getVirtualItems: () => virtualItems,
    getTotalSize: () => totalSize,
    scrollToIndex,
    measure: () => undefined,
    measureElement: (element?: HTMLElement | null) => {
      if (!element) return;
      const index = Number(element.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      const measuredSize = element.getBoundingClientRect().height || element.offsetHeight;
      if (!Number.isFinite(measuredSize) || measuredSize <= 0) return;
      const key = getItemKey(index);
      const previousSize = measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
      if (Math.abs(previousSize - measuredSize) < 1) return;
      measuredSizeByKeyRef.current.set(key, measuredSize);
      rerender((value) => value + 1);
    },
  };
}

// The chat thread renders inside `<main id="main-content">` on the real issue
// page (overflow-auto on desktop), but lives at document scope on mobile (main
// is overflow-visible) and in the auth-free perf fixture. Walk the DOM to find
// the actual scroll container so the virtualizer binds to the right offset
// source — otherwise it stays anchored at offset 0 forever and the visible
// chat area renders blank past the first viewport (PAP-2660).
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el || typeof window === "undefined") return null;
  let current: HTMLElement | null = el.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

const VirtualizedIssueChatThreadList = forwardRef<VirtualizedIssueChatThreadListHandle, VirtualizedIssueChatThreadListProps>(function VirtualizedIssueChatThreadList(props, ref) {
  const probeRef = useRef<HTMLDivElement | null>(null);
  // Default to window scroll on first render so the imperative handle is
  // available immediately for hash-target / submit-scroll effects. After mount
  // we probe the DOM and remount via key={modeKey} if the actual scroll
  // container is an element ancestor (e.g. desktop <main id="main-content">).
  const [mode, setMode] = useState<VirtualizedScrollMode>({ kind: "window" });

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const detect = () => {
      const probe = probeRef.current;
      if (!probe) return;
      const container = findScrollContainer(probe);
      setMode((prev) => {
        if (container === null) {
          return prev.kind === "window" ? prev : { kind: "window" };
        }
        if (prev.kind === "element" && prev.element === container) return prev;
        return { kind: "element", element: container };
      });
    };
    detect();
    window.addEventListener("resize", detect);
    return () => {
      window.removeEventListener("resize", detect);
    };
  }, []);

  return (
    <VirtualizedIssueChatThreadListInner
      key={mode.kind === "window" ? "window" : "element"}
      ref={ref}
      probeRef={probeRef}
      mode={mode}
      {...props}
    />
  );
});

interface VirtualizedIssueChatThreadListInnerProps extends VirtualizedIssueChatThreadListProps {
  mode: VirtualizedScrollMode;
  probeRef: React.MutableRefObject<HTMLDivElement | null>;
}

const VirtualizedIssueChatThreadListInner = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListInnerProps
>(function VirtualizedIssueChatThreadListInner({
  messages,
  feedbackVoteByTargetId,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
  variant,
  mode,
  probeRef,
}, ref) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const pendingPrependAnchorRef = useRef<VirtualizedVisibleAnchorSnapshot | null>(null);

  const setRefs = useCallback((element: HTMLDivElement | null) => {
    parentRef.current = element;
    probeRef.current = element;
  }, [probeRef]);

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element || typeof window === "undefined") return;
    const update = () => {
      if (!parentRef.current) return;
      const rect = parentRef.current.getBoundingClientRect();
      const offset = mode.kind === "window"
        ? rect.top + window.scrollY
        : rect.top - mode.element.getBoundingClientRect().top + mode.element.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - offset) < 0.5 ? previous : offset));
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const gap = variant === "embedded"
    ? VIRTUALIZED_THREAD_GAP_EMBEDDED_PX
    : VIRTUALIZED_THREAD_GAP_FULL_PX;

  const virtualizer = useIssueThreadVirtualizer({
    count: messages.length,
    estimateSize: () => VIRTUALIZED_THREAD_ROW_ESTIMATE_PX,
    overscan: VIRTUALIZED_THREAD_OVERSCAN,
    scrollMargin,
    gap,
    getItemKey: (index) => messages[index]?.id ?? index,
    mode,
  });

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index, options) => {
      if (index < 0 || index >= messages.length) return;
      virtualizer.scrollToIndex(index, {
        align: options?.align ?? "center",
        behavior: options?.behavior ?? "smooth",
      });
    },
    scrollToLatest: (options) => {
      if (messages.length === 0) return;
      virtualizer.scrollToIndex(messages.length - 1, {
        align: "end",
        behavior: options?.behavior ?? "smooth",
      });
    },
    measure: () => {
      virtualizer.measure();
    },
  }), [messages.length, virtualizer]);

  useLayoutEffect(() => {
    return () => {
      const element = parentRef.current;
      if (!element || typeof window === "undefined") return;
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>("[data-anchor-id][data-index]"),
      );
      const visibleRow = rows.find((row) => row.getBoundingClientRect().bottom >= 0);
      if (!visibleRow) return;
      const anchorId = visibleRow.dataset.anchorId;
      const index = Number(visibleRow.dataset.index);
      if (!anchorId || !Number.isFinite(index)) return;
      pendingPrependAnchorRef.current = {
        anchorId,
        index,
        viewportTop: visibleRow.getBoundingClientRect().top,
      };
    };
  }, [messages]);

  useLayoutEffect(() => {
    const pendingAnchor = pendingPrependAnchorRef.current;
    pendingPrependAnchorRef.current = null;
    virtualizer.measure();
    if (!pendingAnchor || typeof window === "undefined") return;
    const nextIndex = findMessageAnchorIndex(messages, pendingAnchor.anchorId);
    if (nextIndex <= pendingAnchor.index) return;

    virtualizer.scrollToIndex(nextIndex, { align: "start", behavior: "auto" });
    requestAnimationFrame(() => {
      const element = document.getElementById(pendingAnchor.anchorId);
      if (!element) return;
      const delta = element.getBoundingClientRect().top - pendingAnchor.viewportTop;
      if (Math.abs(delta) > 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: delta, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: delta, behavior: "auto" });
        }
      }
      virtualizer.measure();
    });
  }, [messages, virtualizer, mode]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={setRefs}
      data-testid="issue-chat-thread-virtualizer"
      data-virtual-count={messages.length}
      style={{ position: "relative", width: "100%", height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const message = messages[virtualItem.index];
        if (!message) return null;
        const anchorId = issueChatMessageAnchorId(message);
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            data-anchor-id={anchorId ?? undefined}
            data-testid="issue-chat-thread-virtual-row"
            ref={(element) => {
              if (element) virtualizer.measureElement(element);
            }}
            onLoadCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            onClickCapture={(event) => {
              const row = event.currentTarget;
              requestAnimationFrame(() => {
                virtualizer.measureElement(row);
              });
            }}
            onTransitionEndCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            <IssueChatMessageRow
              message={message}
              feedbackVoteByTargetId={feedbackVoteByTargetId}
              activeRunIds={activeRunIds}
              stoppingRunId={stoppingRunId}
              interruptingQueuedRunId={interruptingQueuedRunId}
            />
          </div>
        );
      })}
    </div>
  );
});

interface IssueChatMessageRowProps {
  message: ThreadMessage;
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
}

const IssueChatMessageRow = memo(function IssueChatMessageRow({
  message,
  feedbackVoteByTargetId,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: IssueChatMessageRowProps) {
  const kind = issueChatMessageKind(message);
  const activeVote = issueChatMessageActiveVote(message, feedbackVoteByTargetId);
  const isRunActive = issueChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = issueChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = issueChatMessageQueuedRunIsInterrupting(message, interruptingQueuedRunId);
  const renderedMessage = message.role === "user"
    ? (
      <IssueChatUserMessage
        message={message}
        isInterruptingQueuedRun={isInterruptingQueuedRun}
      />
    )
    : message.role === "assistant"
      ? (
        <IssueChatAssistantMessage
          message={message}
          activeVote={activeVote}
          isRunActive={isRunActive}
          isStoppingRun={isStoppingRun}
        />
      )
      : <IssueChatSystemMessage message={message} />;

  return (
    <div
      data-testid="issue-chat-message-row"
      data-message-role={message.role}
      data-message-kind={kind}
    >
      {renderedMessage}
    </div>
  );
}, areIssueChatMessageRowPropsEqual);

function areIssueChatMessageRowPropsEqual(
  prev: IssueChatMessageRowProps,
  next: IssueChatMessageRowProps,
) {
  if (prev.message !== next.message) return false;
  if (issueChatMessageActiveVote(prev.message, prev.feedbackVoteByTargetId) !== issueChatMessageActiveVote(next.message, next.feedbackVoteByTargetId)) return false;
  if (issueChatMessageRunIsActive(prev.message, prev.activeRunIds) !== issueChatMessageRunIsActive(next.message, next.activeRunIds)) return false;
  if (issueChatMessageRunIsStopping(prev.message, prev.stoppingRunId) !== issueChatMessageRunIsStopping(next.message, next.stoppingRunId)) return false;
  if (issueChatMessageQueuedRunIsInterrupting(prev.message, prev.interruptingQueuedRunId) !== issueChatMessageQueuedRunIsInterrupting(next.message, next.interruptingQueuedRunId)) return false;
  return true;
}

const IssueChatComposer = forwardRef<IssueChatComposerHandle, IssueChatComposerProps>(function IssueChatComposer({
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
  composerHint = null,
  issueStatus,
}, forwardedRef) {
  const api = useAui();
  const toastActions = useOptionalToastActions();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentItem[]>([]);
  const dragDepthRef = useRef(0);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const [unassignedConfirmed, setUnassignedConfirmed] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles = Boolean(onImageUpload || onAttachImage);

  function queueViewportRestore(snapshot: ReturnType<typeof captureComposerViewportSnapshot>) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    requestAnimationFrame(() => {
      window.scrollBy({ top: COMPOSER_FOCUS_SCROLL_PADDING_PX, behavior: "smooth" });
      editorRef.current?.focus();
    });
  }

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

  useEffect(() => {
    setUnassignedConfirmed(false);
  }, [reassignTarget]);

  useImperativeHandle(forwardedRef, () => ({
    focus: focusComposer,
    restoreDraft: (submittedBody: string) => {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
      focusComposer();
    },
  }), []);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    const composerHasAssigneePicker = enableReassign && reassignOptions.length > 0;
    if (
      composerHasAssigneePicker
      && isUnassignedReassignValue(reassignTarget)
      && !unassignedConfirmed
    ) {
      toastActions?.pushToast({
        title: "No assignee selected",
        body: "Pick an assignee or click Send again to post without one.",
        tone: "warn",
        dedupeKey: `issue-chat-no-assignee:${draftKey ?? ""}`,
      });
      setUnassignedConfirmed(true);
      return;
    }

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : undefined;
    const reopen = shouldImplicitlyReopenComment(
      issueStatus,
      hasReassignment ? reassignTarget : currentAssigneeValue,
    ) ? true : undefined;
    const submittedBody = trimmed;
    const viewportSnapshot = captureComposerViewportSnapshot(composerContainerRef.current);

    setSubmitting(true);
    setBody("");
    setUnassignedConfirmed(false);
    try {
      const appendPromise = api.thread().append({
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
      queueViewportRestore(viewportSnapshot);
      await appendPromise;
      if (draftKey) clearDraft(draftKey);
      setComposerAttachments([]);
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
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(file: File) {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = Boolean(onImageUpload && file.type.startsWith("image/"));
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (onImageUpload && file.type.startsWith("image/")) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? { ...item, status: "attached", contentPath: url }
            : item,
        ));
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "attached",
                contentPath: attachment?.contentPath,
                name: attachment?.originalFilename ?? item.name,
              }
            : item,
        ));
      } else {
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? { ...item, status: "error", error: "This file type cannot be attached here" }
            : item,
        ));
      }
    } catch (err) {
      setComposerAttachments((prev) => prev.map((item) =>
        item.id === attachmentId
          ? {
              ...item,
              status: "error",
              error: err instanceof Error ? err.message : "Upload failed",
            }
          : item,
      ));
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
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
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-[15px] shadow-[0_-12px_28px_rgba(15,23,42,0.08)] backdrop-blur transition-[border-color,background-color,box-shadow] duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-[0_-12px_28px_rgba(0,0,0,0.28)]",
        isDragOver && "border-primary/45 bg-background shadow-[0_-12px_28px_rgba(15,23,42,0.08),0_0_0_1px_hsl(var(--primary)/0.16)]",
      )}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-[2px] dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Drop to upload</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this issue.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply"
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={onImageUpload}
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-[28dvh] overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
          {composerHint}
        </div>
      ) : null}

      {composerAttachments.length > 0 ? (
        <div
          data-testid="issue-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to issue"
                : attachment.status === "error"
                  ? attachment.error ?? "Upload failed"
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to issue";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">{sizeLabel}</span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {(onImageUpload || onAttachImage) ? (
          <div className="mr-auto flex items-center gap-3">
            <input
              ref={attachInputRef}
              type="file"
              className="hidden"
              onChange={handleAttachFile}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => attachInputRef.current?.click()}
              disabled={attaching}
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

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
});

export function IssueChatThread({
  comments,
  interactions = [],
  feedbackVotes = [],
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  linkedRuns = [],
  timelineEvents = [],
  liveRuns = [],
  activeRun = null,
  blockedBy = [],
  blockerAttention = null,
  companyId,
  projectId,
  issueStatus,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  onVote,
  onAdd,
  onCancelRun,
  onStopRun,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  composerDisabledReason = null,
  composerHint = null,
  showComposer = true,
  showJumpToLatest,
  emptyMessage,
  variant = "full",
  enableLiveTranscriptPolling = true,
  transcriptsByRunId,
  hasOutputForRun: hasOutputForRunOverride,
  includeSucceededRunsWithoutOutput = false,
  onInterruptQueued,
  onCancelQueued,
  interruptingQueuedRunId = null,
  stoppingRunId = null,
  onImageClick,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  composerRef,
  onRefreshLatestComments,
}: IssueChatThreadProps) {
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const virtualizedThreadRef = useRef<VirtualizedIssueChatThreadListHandle | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportSnapshotRef = useRef<ReturnType<typeof captureComposerViewportSnapshot>>(null);
  const preserveComposerViewportRef = useRef(false);
  const pendingSubmitScrollRef = useRef(false);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const spacerBaselineAnchorRef = useRef<string | null>(null);
  const spacerInitialReserveRef = useRef(0);
  const latestSettleTimeoutsRef = useRef<number[]>([]);
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState(0);
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
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
      });
    }
    return [...deduped.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [activeRun, liveRuns]);
  const transcriptRuns = useMemo(() => {
    return resolveIssueChatTranscriptRuns({
      linkedRuns,
      liveRuns: displayLiveRuns,
      activeRun,
    });
  }, [activeRun, displayLiveRuns, linkedRuns]);
  const activeRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of displayLiveRuns) {
      if (run.status === "queued" || run.status === "running") {
        ids.add(run.id);
      }
    }
    return ids;
  }, [displayLiveRuns]);
  const clearLatestSettleTimeouts = useCallback(() => {
    for (const timeout of latestSettleTimeoutsRef.current) {
      window.clearTimeout(timeout);
    }
    latestSettleTimeoutsRef.current = [];
  }, []);

  useEffect(() => clearLatestSettleTimeouts, [clearLatestSettleTimeouts]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: enableLiveTranscriptPolling ? transcriptRuns : [],
    companyId,
  });
  const resolvedTranscriptByRun = transcriptsByRunId ?? transcriptByRun;
  const resolvedHasOutputForRun = hasOutputForRunOverride ?? hasOutputForRun;
  const rawMessages = useMemo(
    () =>
      buildIssueChatMessages({
        comments,
        interactions,
        timelineEvents,
        linkedRuns,
        liveRuns,
        activeRun,
        transcriptsByRunId: resolvedTranscriptByRun,
        hasOutputForRun: resolvedHasOutputForRun,
        includeSucceededRunsWithoutOutput,
        companyId,
        projectId,
        agentMap,
        currentUserId,
        userLabelMap,
      }),
    [
      comments,
      interactions,
      timelineEvents,
      linkedRuns,
      liveRuns,
      activeRun,
      resolvedTranscriptByRun,
      resolvedHasOutputForRun,
      includeSucceededRunsWithoutOutput,
      companyId,
      projectId,
      agentMap,
      currentUserId,
      userLabelMap,
    ],
  );
  const stableMessagesRef = useRef<readonly ThreadMessage[]>([]);
  const stableMessageCacheRef = useRef<Map<string, StableThreadMessageCacheEntry>>(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      rawMessages,
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [rawMessages]);

  const isRunning = displayLiveRuns.some((run) => run.status === "queued" || run.status === "running");
  const unresolvedBlockers = useMemo(
    () => blockedBy.filter((blocker) => blocker.status !== "done" && blocker.status !== "cancelled"),
    [blockedBy],
  );
  const assignedAgent = useMemo(() => {
    if (!currentAssigneeValue.startsWith("agent:")) return null;
    const assigneeAgentId = currentAssigneeValue.slice("agent:".length);
    return agentMap?.get(assigneeAgentId) ?? null;
  }, [agentMap, currentAssigneeValue]);
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);
  const useVirtualizedThread = messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
  const messageAnchorIndex = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => {
      const anchorId = issueChatMessageAnchorId(message);
      if (anchorId) map.set(anchorId, index);
    });
    return map;
  }, [messages]);

  function scrollToThreadAnchor(
    anchorId: string,
    options?: { align?: "start" | "center" | "end" | "auto"; behavior?: ScrollBehavior },
  ) {
    const virtualIndex = messageAnchorIndex.get(anchorId);
    if (useVirtualizedThread && virtualIndex !== undefined) {
      if (!virtualizedThreadRef.current) return false;
      virtualizedThreadRef.current.scrollToIndex(virtualIndex, {
        align: options?.align ?? "center",
        behavior: options?.behavior ?? "smooth",
      });
      return true;
    }

    const element = document.getElementById(anchorId);
    if (!element) return false;
    element.scrollIntoView({
      behavior: options?.behavior ?? "smooth",
      block: options?.align === "start"
        ? "start"
        : options?.align === "end"
          ? "end"
          : "center",
    });
    return true;
  }

  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, reopen, reassignment }) => {
      pendingSubmitScrollRef.current = true;
      return onAdd(body, reopen, reassignment);
    },
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const lastUserId = lastUserMessage?.id ?? null;

    if (
      pendingSubmitScrollRef.current
      && lastUserId
      && lastUserId !== lastUserMessageIdRef.current
    ) {
      pendingSubmitScrollRef.current = false;
      const custom = lastUserMessage?.metadata.custom as { anchorId?: unknown } | undefined;
      const anchorId = typeof custom?.anchorId === "string" ? custom.anchorId : null;
      if (anchorId) {
        const reserve = Math.round(window.innerHeight * SUBMIT_SCROLL_RESERVE_VH);
        spacerBaselineAnchorRef.current = anchorId;
        spacerInitialReserveRef.current = reserve;
        setBottomSpacerHeight(reserve);
        requestAnimationFrame(() => {
          scrollToThreadAnchor(anchorId, { align: "start", behavior: "smooth" });
        });
      }
    }

    lastUserMessageIdRef.current = lastUserId;
  }, [messageAnchorIndex, messages, useVirtualizedThread]);

  useLayoutEffect(() => {
    const anchorId = spacerBaselineAnchorRef.current;
    if (!anchorId || spacerInitialReserveRef.current <= 0) return;
    const userEl = document.getElementById(anchorId);
    const bottomEl = bottomAnchorRef.current;
    if (!userEl || !bottomEl) return;
    const contentBelow = Math.max(
      0,
      bottomEl.getBoundingClientRect().top - userEl.getBoundingClientRect().bottom,
    );
    const next = Math.max(0, spacerInitialReserveRef.current - contentBelow);
    setBottomSpacerHeight((prev) => (prev === next ? prev : next));
    if (next === 0) {
      spacerBaselineAnchorRef.current = null;
      spacerInitialReserveRef.current = 0;
    }
  }, [messages]);
  useLayoutEffect(() => {
    const composerElement = composerViewportAnchorRef.current;
    if (preserveComposerViewportRef.current) {
      restoreComposerViewportSnapshot(
        composerViewportSnapshotRef.current,
        composerElement,
      );
    }

    composerViewportSnapshotRef.current = captureComposerViewportSnapshot(composerElement);
    preserveComposerViewportRef.current = shouldPreserveComposerViewport(composerElement);
  }, [messages]);

  useEffect(() => {
    const hash = location.hash || (typeof window !== "undefined" ? window.location.hash : "");
    if (
      !(
        hash.startsWith("#comment-")
        || hash.startsWith("#activity-")
        || hash.startsWith("#run-")
        || hash.startsWith("#interaction-")
      )
    ) return;
    if (messages.length === 0 || lastScrolledHashRef.current === hash) return;
    const targetId = hash.slice(1);
    let cancelled = false;
    const attemptScroll = (finalAttempt = false) => {
      if (cancelled || lastScrolledHashRef.current === hash) return;
      const didScroll = scrollToThreadAnchor(targetId, { align: "center", behavior: "smooth" });
      if (!didScroll) return;
      if (finalAttempt || !useVirtualizedThread || document.getElementById(targetId)) {
        lastScrolledHashRef.current = hash;
      }
    };

    attemptScroll();
    const frame = requestAnimationFrame(() => attemptScroll());
    const timeout = window.setTimeout(() => attemptScroll(true), 250);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [location.hash, messageAnchorIndex, messages, useVirtualizedThread]);

  function jumpToLatestFallback() {
    if (useVirtualizedThread) {
      virtualizedThreadRef.current?.scrollToLatest({ behavior: "smooth" });
      return;
    }
    bottomAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // Walks the thread by anchor and lands on the latest `comment-*` row, with
  // a short series of settle passes. The virtualizer estimates row sizes for
  // unmeasured rows, and that estimate undershoots tall markdown comments —
  // so the first scroll often lands above the actual bottom and the user
  // ends up clicking Jump to latest repeatedly to converge. Re-issuing the
  // scroll after measurements catch up lets one click reach the actual
  // latest comment (PAP-2672 follow-up).
  function scrollToLatestCommentWithSettle() {
    const latestCommentIndex = findLatestCommentMessageIndex(messages);
    if (latestCommentIndex < 0) {
      jumpToLatestFallback();
      return;
    }
    const latestCommentAnchor = issueChatMessageAnchorId(messages[latestCommentIndex]);
    if (!latestCommentAnchor) {
      jumpToLatestFallback();
      return;
    }

    const initial = scrollToThreadAnchor(latestCommentAnchor, { align: "end", behavior: "smooth" });
    if (!initial) {
      jumpToLatestFallback();
      return;
    }

    if (typeof window === "undefined") return;

    clearLatestSettleTimeouts();
    const settleDelays = [380, 760, 1140];
    settleDelays.forEach((delay) => {
      const timeout = window.setTimeout(() => {
        if (typeof document === "undefined") return;
        const el = document.getElementById(latestCommentAnchor);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "end" });
          return;
        }
        // The row may still be outside the virtualizer's render buffer; nudge
        // the offset so it gets mounted, then the next pass can align with
        // real DOM measurements.
        virtualizedThreadRef.current?.scrollToIndex(latestCommentIndex, {
          align: "end",
          behavior: "auto",
        });
      }, delay);
      latestSettleTimeoutsRef.current.push(timeout);
    });
  }

  function handleJumpToLatest() {
    if (onRefreshLatestComments) {
      // Refetching from page 0 (newest first) brings any comments that
      // arrived after the initial load into the cache before we scroll —
      // otherwise we'd land on the latest *loaded* row rather than the
      // absolute newest, which is what PAP-2672 reopened on.
      const refreshed = onRefreshLatestComments();
      if (refreshed && typeof (refreshed as Promise<unknown>).then === "function") {
        (refreshed as Promise<unknown>).then(
          () => scrollToLatestCommentWithSettle(),
          () => scrollToLatestCommentWithSettle(),
        );
        return;
      }
    }
    scrollToLatestCommentWithSettle();
  }

  const stableOnVote = useStableEvent(onVote);
  const stableOnStopRun = useStableEvent(onStopRun);
  const stableOnInterruptQueued = useStableEvent(onInterruptQueued);
  const stableOnCancelQueued = useStableEvent(onCancelQueued);
  const stableOnImageClick = useStableEvent(onImageClick);
  const stableOnAcceptInteraction = useStableEvent(onAcceptInteraction);
  const stableOnRejectInteraction = useStableEvent(onRejectInteraction);
  const stableOnSubmitInteractionAnswers = useStableEvent(onSubmitInteractionAnswers);

  const chatCtx = useMemo<IssueChatMessageContext>(
    () => ({
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      onVote: stableOnVote,
      onStopRun: stableOnStopRun,
      onInterruptQueued: stableOnInterruptQueued,
      onCancelQueued: stableOnCancelQueued,
      onImageClick: stableOnImageClick,
      onAcceptInteraction: stableOnAcceptInteraction,
      onRejectInteraction: stableOnRejectInteraction,
      onSubmitInteractionAnswers: stableOnSubmitInteractionAnswers,
    }),
    [
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      stableOnVote,
      stableOnStopRun,
      stableOnInterruptQueued,
      stableOnCancelQueued,
      stableOnImageClick,
      stableOnAcceptInteraction,
      stableOnRejectInteraction,
      stableOnSubmitInteractionAnswers,
    ],
  );

  const resolvedShowJumpToLatest = showJumpToLatest ?? variant === "full";
  const resolvedEmptyMessage = emptyMessage
    ?? (variant === "embedded"
      ? "No run output yet."
      : "This issue conversation is empty. Start with a message below.");
  const previousErrorBoundaryMessagesRef = useRef<readonly ThreadMessage[] | null>(null);
  const errorBoundaryResetVersionRef = useRef(0);
  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }
  const errorBoundaryResetKey = String(errorBoundaryResetVersionRef.current);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <IssueChatCtx.Provider value={chatCtx}>
      <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
        {resolvedShowJumpToLatest ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleJumpToLatest}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Jump to latest
            </button>
          </div>
        ) : null}

        <IssueChatErrorBoundary
          resetKey={errorBoundaryResetKey}
          messages={messages}
          emptyMessage={resolvedEmptyMessage}
          variant={variant}
        >
          <div data-testid="thread-root">
            <div
              data-testid="thread-viewport"
              className={variant === "embedded" ? "space-y-3" : "space-y-4"}
            >
              {messages.length === 0 ? (
                <div className={cn(
                  "text-center text-sm text-muted-foreground",
                  variant === "embedded"
                    ? "rounded-xl border border-dashed border-border/70 bg-background/60 px-4 py-6"
                    : "rounded-2xl border border-dashed border-border bg-card px-6 py-10",
                )}>
                  {resolvedEmptyMessage}
                </div>
              ) : messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD ? (
                <VirtualizedIssueChatThreadList
                  ref={virtualizedThreadRef}
                  messages={messages}
                  feedbackVoteByTargetId={feedbackVoteByTargetId}
                  activeRunIds={activeRunIds}
                  stoppingRunId={stoppingRunId}
                  interruptingQueuedRunId={interruptingQueuedRunId}
                  variant={variant}
                />
              ) : (
                // Keep transcript rendering independent from assistant-ui's
                // index-scoped message providers; live transcripts can shrink
                // or regroup while the runtime still holds stale indices.
                messages.map((message) => (
                  <IssueChatMessageRow
                    key={message.id}
                    message={message}
                    feedbackVoteByTargetId={feedbackVoteByTargetId}
                    activeRunIds={activeRunIds}
                    stoppingRunId={stoppingRunId}
                    interruptingQueuedRunId={interruptingQueuedRunId}
                  />
                ))
              )}
              {showComposer ? (
                <div data-testid="issue-chat-thread-notices" className="space-y-2">
                  <IssueBlockedNotice
                    issueStatus={issueStatus}
                    blockers={unresolvedBlockers}
                    blockerAttention={blockerAttention}
                  />
                  <IssueAssigneePausedNotice agent={assignedAgent} />
                </div>
              ) : null}
              <div ref={bottomAnchorRef} />
              {showComposer ? (
                <div
                  aria-hidden
                  data-testid="issue-chat-bottom-spacer"
                  style={{ height: bottomSpacerHeight }}
                />
              ) : null}
            </div>
          </div>
        </IssueChatErrorBoundary>

        {showComposer ? (
          <div
            ref={composerViewportAnchorRef}
            data-testid="issue-chat-composer-dock"
            className="sticky bottom-[calc(env(safe-area-inset-bottom)+20px)] z-20 space-y-2 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6"
          >
            <IssueChatComposer
              ref={composerRef}
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
              composerHint={composerHint}
              issueStatus={issueStatus}
            />
          </div>
        ) : null}
      </div>
      </IssueChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}
