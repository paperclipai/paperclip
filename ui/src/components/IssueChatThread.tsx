import { t, useTranslation, i18n } from "@/i18n";
import { Trans } from "react-i18next";
import { formatFileSizeDisplay } from "./task-chat/task-chat-attachments";
import { taskChatDisplayLabel, taskChatDurationLabel, taskChatEnumLabel } from "./task-chat/task-chat-display";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
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
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
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
  IssueDocumentSummary,
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueQueuedCommentQueue,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
  IssueWorkMode,
  IssueWorkProduct,
} from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { findUIAdapter } from "../adapters/registry";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { useSecondTick } from "../hooks/useSecondTick";
import {
  usePaperclipIssueRuntime,
  type PaperclipIssueRuntimeReassignment,
} from "../hooks/usePaperclipIssueRuntime";
import { useOptionalToastActions } from "../context/ToastContext";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  loadDraftAttachments,
  saveDraftAttachments,
  loadDraftSubmission,
  saveDraftSubmission,
  clearDraftSubmission,
  type ComposerDraftSubmission,
} from "../lib/composer-draft";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";
import {
  buildIssueChatMessages,
  formatDurationWords,

  issueChatRunLabelDisplay,
  isCoTSegmentActive,
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
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import {
  buildIssueThreadInteractionSummary,
  isIssueThreadInteraction,
} from "../lib/issue-thread-interactions";
import { isLiveIssueRun } from "../lib/liveIssueIds";
import { resolveIssueChatTranscriptRuns } from "../lib/issueChatTranscriptRuns";
import {

  timelineWorkspaceLabelDisplay as formatTimelineWorkspaceLabel,
  type IssueTimelineAssignee,
  type IssueTimelineEvent,
  type IssueTimelineWorkspace,
  type IssueWorkModeChange,
} from "../lib/issue-timeline-events";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/InlineBanner";
import { Card } from "@/components/ui/card";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MarkdownBody,
  type MarkdownExternalReferenceMap,
} from "./MarkdownBody";
import type { TaskChatIssueBrief } from "./task-chat/TaskChatDescriptionBubble";
import { WorkspaceFileMarkdownBody } from "./WorkspaceFileMarkdownBody";
import {
  MarkdownEditor,
  type MentionOption,
  type MarkdownEditorRef,
} from "./MarkdownEditor";
import { Identity } from "./Identity";
import {
  InlineEntitySelector,
  type InlineEntityOption,
} from "./InlineEntitySelector";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { AgentIcon } from "./AgentIconPicker";
import {
  AssigneeChip,
  ComposerHandoffPreviewRow,
  ComposerMentionCoach,
  HandoffWakeRow,
  RunStatusBadge,
  type HandoffChipResolvers,
} from "./interrupt-handoff/InterruptHandoffViews";
import {
  computeComposerHandoffPreview,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  type ComposerHandoffPreview,
  type HandoffAgentMention,
} from "../lib/interrupt-handoff";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "../lib/issue-chat-scroll";
import { formatAssigneeUserDisplayLabel as formatAssigneeUserLabel, formatAssigneeUserLabel as canonicalAssigneeUserLabel } from "../lib/assignees";
import { companyUserLabelDisplayLabel, companyUserProfileDisplayLabel, type CompanyUserProfile } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import {
  isSuccessfulRunHandoffComment,
  isSuccessfulRunHandoffEscalationComment,
} from "../lib/successful-run-handoff";
import {
  SystemNotice,
  type SystemNoticeMetadataRow,
  type SystemNoticeMetadataSection,
  type SystemNoticeProps,
  type SystemNoticeTone,
} from "./SystemNotice";
import {
  buildSystemNoticeProps,
  mapCommentMetadataToSystemNoticeSections,
  systemNoticeLabelForTone,
} from "../lib/system-notice-comment";
import  { systemNoticeMetadataLabelDisplay, systemNoticeMetadataValueDisplay, systemNoticeRunStatusDisplay } from "../lib/system-notice-comment";
import type {
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  describeToolInput,
  displayToolName,
  formatToolPayload,
  isCommandTool,
  parseToolPayload,
  summarizeToolInput,
  summarizeToolResult,

  toolInputDetailDisplay,
} from "../lib/transcriptPresentation";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { useComposerStop } from "@/hooks/useComposerStop";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { liveBlueBadge } from "../lib/status-colors";
import {
  nextWorkMode,
  titleForPendingWorkMode,
  workModeMetaFor,
  workModeMetaList,
} from "../lib/work-mode-meta";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ClipboardList,
  Copy,
  Hammer,
  Loader2,
  MoreHorizontal,
  Paperclip,
  PauseCircle,
  Search,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { IssueBlockedNotice } from "./IssueBlockedNotice";
import { IssueAssignedBacklogNotice } from "./IssueAssignedBacklogNotice";
import {
  IssueRecoveryActionCard,
  type RecoveryReissueRequest,
  type RecoveryResolveOutcome,
} from "./IssueRecoveryActionCard";
import { SourceTrustBadge } from "./SourceTrustBadge";
import { CommentAttributionChip } from "./CommentAttributionChip";
import { resolveCommentAttribution } from "../lib/comment-attribution";

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
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  /** New task-view composer takeover action. The classic thread does not render it. */
  onSkipInteraction?: (
    interaction: IssueThreadInteraction,
  ) => Promise<void> | void;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: {
      id: string;
      verdict: RequestItemVerdictValue;
      reason?: string;
    }[],
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  issueStatus?: string;
  /**
   * Current assignee. Agent comments from anyone else are cross-issue writes, so
   * they carry a "for {user}" attribution chip (the open cross-task write design (attribution)).
   */
  issueAssigneeAgentId?: string | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  externalReferences?: MarkdownExternalReferenceMap;
  /** Linkify `PAP-C7` case chips in comment bodies (experimental Cases flag). */
  linkCaseReferences?: boolean;
}

const IssueChatCtx = createContext<IssueChatMessageContext>({
  feedbackDataSharingPreference: "prompt",
  feedbackTermsUrl: null,
  issueStatus: undefined,
  successfulRunHandoff: null,
});

const AGENT_COMMENT_BUBBLE_WIDTH_CLASS =
  "max-w-(--sz-calc-7) sm:max-w-(--pct-85)";

export type IssueChatRunFinalizationAction = {
  id: "cancel" | "done";
  label: string;
  pendingLabel: string;
  onSelect: (runId: string) => Promise<void> | void;
  isPending?: boolean;
  disabled?: boolean;
};

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
      if (!inCoT) {
        segIdx++;
        inCoT = true;
      }
      if (part === firstPart) return segIdx;
    } else {
      inCoT = false;
    }
  }
  return -1;
}

function useLiveElapsed(
  startMs: number | null | undefined,
  active: boolean,
): string | null {
  // Drive the 1s refresh from the shared page-wide ticker instead of a
  // per-instance setInterval, so a thread with many live elements uses one
  // timer rather than one per element.
  useSecondTick(Boolean(active && startMs));
  if (!active || !startMs) return null;
  return  taskChatDurationLabel(formatDurationWords(Date.now() - startMs) ?? "");
}

function readCustomString(
  custom: Record<string, unknown>,
  key: string,
): string {
  return typeof custom[key] === "string" ? custom[key].trim() : "";
}

function toTimestampOrNull(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function IssueChatLiveRunStatusLine({
  custom,
  active,
  className,
}: {
  custom: Record<string, unknown>;
  active: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const currentStatusMessage = readCustomString(custom, "currentStatusMessage");
  const currentToolName = readCustomString(custom, "currentToolName");
  const lastAssistantSnippet = readCustomString(custom, "lastAssistantSnippet");
  const lastEventAt = readCustomString(custom, "lastEventAt");
  const lastEventAtMs = toTimestampOrNull(lastEventAt);
  const lastActivityElapsed = useLiveElapsed(lastEventAtMs, active);
  const lastActivityAgeMs = lastEventAtMs ? Date.now() - lastEventAtMs : null;

  if (!active) return null;

  const primary = currentToolName
    ? t("localizationTaskRuntime.liveUsingTool", { tool: currentToolName })
    : lastAssistantSnippet
      ? lastAssistantSnippet
      : currentStatusMessage;
  const activityText = lastActivityElapsed
    ? lastActivityAgeMs !== null && lastActivityAgeMs >= 15_000
      ? t("localizationTaskRuntime.noOutputRunning", { duration: lastActivityElapsed })
      : t("localizationTaskRuntime.timeAgo", { duration: lastActivityElapsed })
    : "";
  const text = [primary, activityText].filter(Boolean).join(" · ");
  if (!text) return null;

  return (
    <span
      className={cn(
        "mt-0.5 block truncate text-xs leading-4 text-muted-foreground/70",
        className,
      )}
      title={text}
    >
      {text}
    </span>
  );
}

function useStableEvent<T extends (...args: never[]) => unknown>(
  callback: T | undefined,
): T | undefined {
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
  }, [i18n.resolvedLanguage, Boolean(callback)]);
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export function shouldRenderComposerHandoffPreview(
  body: string,
  preview: ComposerHandoffPreview,
): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

export interface IssueChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
}

interface IssueChatComposerProps {
  onSend: IssueChatThreadProps["onAdd"];
  onReviewConversation?: () => Promise<void>;
  onStop?: () => Promise<void>;
  stopPending?: boolean;
  stopScope?: "leaf" | "subtree";
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  /** Whether an agent run is currently in flight, so the composer can preview an interrupt. */
  hasActiveRun?: boolean;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  issueStatus?: string;
  issueWorkMode?: IssueWorkMode;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
}

interface IssueChatThreadProps {
  comments: IssueChatComment[];
  interactions?: IssueThreadInteraction[];
  /** App-authoritative resources interleaved by the default task thread. */
  documents?: IssueDocumentSummary[];
  workProducts?: IssueWorkProduct[];
  attachments?: IssueAttachment[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: IssueChatLinkedRun[];
  timelineEvents?: IssueTimelineEvent[];
  /**
   * Work-mode switch history from the activity feed. Only the chat-style
   * TaskChatThread consumes this to tag each agent reply with the mode its
   * request ran under; this thread — the classic task view behind
   * enableClassicTaskInterface — ignores it.
   */
  workModeChanges?: IssueWorkModeChange[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  issueId?: string | null;
  blockedBy?: IssueRelationIssueSummary[];
  /** Company-wide set of issue ids with a live (queued/running) run. */
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  recoveryAction?: IssueRecoveryAction | null;
  onResolveRecoveryAction?: (outcome: RecoveryResolveOutcome) => void;
  onReissueIsolatedRecoveryAction?: (request: RecoveryReissueRequest) => void;
  reissueIsolatedRecoveryActionPending?: boolean;
  onReconcileForwardRecoveryAction?: () => void;
  onBreakGlassOverrideRecoveryAction?: (reason: string) => void;
  onQuarantineRestoreRecoveryAction?: () => void;
  quarantineRestoreRecoveryActionPending?: boolean;
  canBreakGlassRecoveryAction?: boolean;
  reconcileRecoveryActionPending?: boolean;
  canFalsePositiveRecoveryAction?: boolean;
  legacyRecoverySourceIssue?: {
    identifier: string | null;
    href: string;
    title?: string | null;
  } | null;
  assigneeUserId?: string | null;
  /** Current assignee agent, used to mark cross-issue agent comments (the open cross-task write design (attribution)). */
  issueAssigneeAgentId?: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  /** Resume a paused assignee agent so runs can start again. */
  onResumeAssignee?: () => Promise<void> | void;
  resumeAssigneePending?: boolean;
  /** Requeues a blocked task after its no-live-execution-path recovery notice. */
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
  /** Starts a fresh on-demand run for the selected failed run. */
  onRetryFailedRun?: (runId: string) => Promise<void> | void;
  retryFailedRunId?: string | null;
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
  onAdd: (
    body: string,
    reopen?: boolean,
    reassignment?: CommentReassignment,
    attachmentIds?: string[],
  ) => Promise<void>;
  onReviewConversation?: () => Promise<void>;
  onCancelRun?: () => Promise<void>;
  stopPending?: boolean;
  stopScope?: "leaf" | "subtree";
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
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
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
  showComposer?: boolean;
  showJumpToLatest?: boolean;
  autoScrollToLatestOnInitialLoad?: boolean;
  autoScrollToHashOnInitialLoad?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
  /**
   * Issue header content (title row, badges, plugin toolbars) rendered INSIDE
   * the thread's scroll viewport so it scrolls away with the messages. Only
   * the chat-style TaskChatThread consumes this; this thread ignores it — its
   * header stays in the page flow.
   */
  threadHeader?: ReactNode;
  /**
   * The task description rendered as the requester's first chat bubble
   * (PAP-375). Only the chat-style TaskChatThread consumes it; this thread
   * ignores it — its description stays in the page header via InlineEditor.
   */
  issueBrief?: TaskChatIssueBrief;
  variant?: "full" | "embedded";
  enableLiveTranscriptPolling?: boolean;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  includeSucceededRunsWithoutOutput?: boolean;
  onInterruptQueued?: (runId: string) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  /** Authoritative PRP queue. The classic thread intentionally ignores it. */
  queuedCommentQueue?: IssueQueuedCommentQueue | null;
  onEditQueuedComment?: (
    commentId: string,
    body: string,
    revision: string,
  ) => Promise<void>;
  onReorderQueuedComments?: (
    orderedCommentIds: string[],
    revision: string,
  ) => Promise<void>;
  onSteerQueuedComment?: (commentId: string, revision: string) => Promise<void>;
  onDiscardQueuedComment?: (
    commentId: string,
    revision: string,
  ) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  interruptingQueuedRunId?: string | null;
  stoppingRunId?: string | null;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  /** New task-view composer takeover action. The classic thread does not render it. */
  onSkipInteraction?: (
    interaction: IssueThreadInteraction,
  ) => Promise<void> | void;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: {
      id: string;
      verdict: RequestItemVerdictValue;
      reason?: string;
    }[],
  ) => Promise<void> | void;
  composerRef?: Ref<IssueChatComposerHandle>;
  /** Optional node rendered inline directly above the sticky composer dock (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  issueWorkMode?: IssueWorkMode;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
  externalReferences?: MarkdownExternalReferenceMap;
  /** Linkify `PAP-C7` case chips in comment bodies (experimental Cases flag). */
  linkCaseReferences?: boolean;
}

type IssueChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  externalReferences?: MarkdownExternalReferenceMap;
  children: ReactNode;
};

type IssueChatErrorBoundaryState = {
  hasError: boolean;
};

class IssueChatErrorBoundary extends Component<
  IssueChatErrorBoundaryProps,
  IssueChatErrorBoundaryState
> {
  override state: IssueChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): IssueChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      "Issue chat renderer failed; falling back to safe transcript view",
      {
        error,
        info: info.componentStack,
      },
    );
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
          externalReferences={this.props.externalReferences}
        />
      );
    }
    return this.props.children;
  }
}

export function IssueAssigneePausedNotice({
  agent,
  onResume,
  resuming,
}: {
  agent: Agent | null;
  onResume?: () => Promise<void> | void;
  resuming?: boolean;
}) {

  const { t } = useTranslation();
  if (!agent || agent.status !== "paused") return null;

  const pauseDetail =
    agent.pauseReason === "budget"
      ? t("localizationTaskRuntime.ui_It_was_paused_by_a_budget_hard_stop_1b05ob1")
      : agent.pauseReason === "import"
        ? t("localizationTaskRuntime.ui_It_arrived_paused_from_an_organization_import_imported_agents_sta_lvfkig")
        : agent.pauseReason === "system"
          ? t("localizationTaskRuntime.ui_It_was_paused_by_the_system_1rec418")
          : t("localizationTaskRuntime.ui_It_was_paused_manually_16f49io");
  // Budget pauses clear on their own when the budget resets; resuming by hand
  // would fight the hard stop, so the action is only offered for the rest.
  const canResume = Boolean(onResume) && agent.pauseReason !== "budget";

  return (
    <div data-testid="issue-assignee-paused-notice" className="mb-3">
      <InlineBanner
        tone="warning"
        icon={PauseCircle}
        compact
        title={<Trans i18nKey="localizationTaskRuntime.agentPaused" values={{ name: agent.name }} components={{ agent: <span className="font-medium" /> }} />}
        actions={
          canResume ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onResume}
              disabled={resuming}
              data-testid="issue-assignee-paused-resume"
            >
              {resuming ? t("localizationTaskRuntime.ui_Resuming_1uisyc1") : t("localizationTaskRuntime.ui_Resume_agent_1iqt3xn")}
            </Button>
          ) : undefined
        }
      >
        {t("localizationTaskRuntime.ui_New_runs_will_not_start_until_the_agent_is_resumed_h8divt")} {pauseDetail}
      </InlineBanner>
    </div>
  );
}

function fallbackAuthorLabel(message: ThreadMessage) {
  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (typeof custom?.["authorName"] === "string") return custom["authorName"];
  if (typeof custom?.["runAgentName"] === "string")
    return custom["runAgentName"];
  if (message.role === "assistant") return t("localizationTaskRuntime.ui_Agent_1w5o8jq");
  if (message.role === "user") return t("localizationTaskRuntime.ui_You_1efd4xo");
  return t("localizationTaskRuntime.ui_System_13qbhrw");
}

function fallbackTextParts(message: ThreadMessage) {
  const contentLines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim().length > 0) contentLines.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      const lines = [t("localizationTaskRuntime.toolFallback", { tool: part.toolName })];
      if (part.argsText?.trim()) lines.push(t("localizationTaskRuntime.argsFallback", { args: part.argsText }));
      if (typeof part.result === "string" && part.result.trim())
        lines.push(t("localizationTaskRuntime.resultFallback", { result: part.result }));
      contentLines.push(lines.join("\n\n"));
    }
  }

  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (
    contentLines.length === 0 &&
    typeof custom?.["waitingText"] === "string" &&
    custom["waitingText"].trim()
  ) {
    contentLines.push(issueChatRunLabelDisplay(custom["waitingText"], taskChatDurationLabel));
  }
  return contentLines;
}

function IssueChatFallbackThread({
  messages,
  emptyMessage,
  variant,
  externalReferences,
}: {
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  externalReferences?: MarkdownExternalReferenceMap;
}) {

  const { t } = useTranslation();
  return (
    <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
      <div className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">{t("localizationTaskRuntime.ui_Chat_renderer_hit_an_internal_state_error_cywhli")}</p>
            <p className="text-xs opacity-80">
              {t("localizationTaskRuntime.ui_Showing_a_safe_fallback_transcript_instead_of_crashing_the_tasks__fg7682")}
            </p>
          </div>
        </div>
      </div>

      {messages.length === 0 ? (
        <Card
          className={cn(
            "block shadow-none text-center text-sm text-muted-foreground",
            variant === "embedded"
              ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
              : "border-dashed px-6 py-10",
          )}
        >
          {emptyMessage}
        </Card>
      ) : (
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {messages.map((message) => {
            const lines = fallbackTextParts(message);
            return (
              <Card
                key={message.id}
                className="block border-border/60 bg-card/70 px-4 py-3"
              >
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {fallbackAuthorLabel(message)}
                  </span>
                  {message.createdAt ? (
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      {commentDateLabel(message.createdAt)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {lines.length > 0 ? (
                    lines.map((line, index) => (
                      <MarkdownBody
                        key={`${message.id}:fallback:${index}`}
                        externalReferences={externalReferences}
                      >
                        {line}
                      </MarkdownBody>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("localizationTaskRuntime.ui_No_message_content_177uukq")}</p>
                  )}
                </div>
              </Card>
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
  attachmentId?: string;
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
  return formatFileSizeDisplay(bytes);
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * ISO timestamp for display, or undefined when the value does not parse as a
 * real date. Comment timestamps can arrive malformed (e.g. a server
 * serialization bug turning Dates into `{}`); formatting must degrade to "no
 * timestamp" instead of throwing mid-render (PAP-16607).
 */
function toValidIsoString(
  value: Date | string | number | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseReassignment(
  target: string,
): PaperclipIssueRuntimeReassignment | null {
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

function shouldImplicitlyReopenComment(
  issueStatus: string | undefined,
  assigneeValue: string,
) {
  const resumesToTodo =
    issueStatus === "done" ||
    issueStatus === "cancelled" ||
    issueStatus === "blocked";
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

const IssueChatTextPart = memo(function IssueChatTextPart({
  text,
  recessed,
  onAccent,
}: {
  text: string;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  const { onImageClick, externalReferences, linkCaseReferences } =
    useContext(IssueChatCtx);
  if (isSuccessfulRunHandoffComment(text)) {
    return (
      <SuccessfulRunHandoffCommentCallout
        text={text}
        recessed={recessed}
        onImageClick={onImageClick}
      />
    );
  }
  return (
    <WorkspaceFileMarkdownBody
      className={cn(
        "text-sm leading-6",
        onAccent && "paperclip-markdown-on-accent",
      )}
      style={recessed ? { opacity: 0.55 } : undefined}
      softBreaks
      onImageClick={onImageClick}
      externalReferences={externalReferences}
      linkCaseReferences={linkCaseReferences}
    >
      {text}
    </WorkspaceFileMarkdownBody>
  );
});

export function SuccessfulRunHandoffCommentCallout({
  text,
  recessed,
  onImageClick,
}: {
  text: string;
  recessed?: boolean;
  onImageClick?: (src: string) => void;
}) {

  useTranslation();
  const escalated = isSuccessfulRunHandoffEscalationComment(text);
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 text-sm shadow-sm",
        escalated
          ? "border-red-500/35 bg-red-500/10 text-red-950 dark:text-red-100"
          : "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
      style={recessed ? { opacity: 0.55 } : undefined}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className={cn(
            "mt-1 h-4 w-4 shrink-0",
            escalated
              ? "text-red-600 dark:text-red-300"
              : "text-amber-600 dark:text-amber-300",
          )}
        />
        <MarkdownBody
          className="min-w-0 text-sm leading-6"
          softBreaks
          onImageClick={onImageClick}
        >
          {text}
        </MarkdownBody>
      </div>
    </div>
  );
}

function humanizeValue(value: string | null) {
  if (!value) return t("localizationTaskRuntime.ui_None_deku7v");
  return t(`status.${value}`, { defaultValue: value.replace(/_/g, " ") });
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
    return (
      companyUserLabelDisplayLabel(userId, userLabelMap) ??
      formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ??
      t("localizationTaskRuntime.ui_Board_1hpelzf")
    );
  }
  return t("localizationTaskRuntime.ui_System_13qbhrw");
}

export function resolveIssueChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;

  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap , userLabelMap } = args;
  const profile = authorUserId
    ? (userProfileMap?.get(authorUserId) ?? null)
    : null;
  const isCurrentUser = Boolean(
    authorUserId && currentUserId && authorUserId === currentUserId,
  );
  const explicitLabel = companyUserProfileDisplayLabel(profile)?.trim()
    || companyUserLabelDisplayLabel(authorUserId, userLabelMap)?.trim();
  // Translate only generated author fallbacks; real names remain unchanged.
  const canonicalFallback = canonicalAssigneeUserLabel(authorUserId, currentUserId) ?? "You";
  const displayAuthorName = !explicitLabel && authorName === canonicalFallback
    ? formatAssigneeUserLabel(authorUserId, currentUserId) ?? t("localizationTaskRuntime.ui_You_1efd4xo")
    : authorName?.trim();
  const resolvedAuthorName = explicitLabel || displayAuthorName
    || (authorUserId === "local-board" ? t("localizationTaskRuntime.ui_Board_1hpelzf") : isCurrentUser ? t("localizationTaskRuntime.ui_You_1efd4xo") : t("localizationTaskRuntime.ui_User_1qbyk9e"));

  return {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl: profile?.image ?? null,
  };
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
  if (commands > 0)
    parts.push(t("localizationTaskRuntime.ranCommands", { count: commands }));
  if (other > 0) parts.push(t("localizationTaskRuntime.calledTools", { count: other }));
  return parts.join(", ");
}

function cleanToolDisplayText(tool: ToolCallMessagePart): string {
  const name = displayToolName(tool.toolName, tool.args);
  if (isCommandTool(tool.toolName, tool.args)) return name;
  const summary =
    tool.result === undefined
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
  const { t } = useTranslation();
  const { agentMap } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  // Adapters whose backends overwhelm the one-line reasoning ticker declare
  // a scrollable live reasoning view via their UI adapter module
  // (transcriptPresentation.liveReasoningView); resolved through the registry
  // so this component never branches on adapter identities. Every adapter
  // without a declaration keeps the existing ticker rendering.
  const adapterType =
    typeof custom.adapterType === "string" ? custom.adapterType : null;
  const isVerboseStreamingBackend =
    (adapterType
      ? findUIAdapter(adapterType)?.transcriptPresentation?.liveReasoningView
      : undefined) === "scrollLog";
  const isMessageRunning =
    message.role === "assistant" && message.status?.type === "running";

  const myIndex = useMemo(
    () => findCoTSegmentIndex(message.content, cotParts),
    [i18n.resolvedLanguage, message.content, cotParts],
  );

  const allReasoningText = cotParts
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && !!p.text,
    )
    .map((p) => p.text)
    .join("\n");
  const toolParts = cotParts.filter(
    (p): p is ToolCallMessagePart => p.type === "tool-call",
  );

  const rawSegments = Array.isArray(custom.chainOfThoughtSegments)
    ? (custom.chainOfThoughtSegments as SegmentTiming[])
    : [];
  const segmentTiming = myIndex >= 0 ? (rawSegments[myIndex] ?? null) : null;
  const isActive = isCoTSegmentActive({
    isMessageRunning,
    segmentIndex: myIndex,
    segmentCount: rawSegments.length,
  });
  const [expanded, setExpanded] = useState(isActive);
  const liveElapsed = useLiveElapsed(segmentTiming?.startMs, isActive);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  let headerVerb: string;
  let headerSuffix: string | null = null;
  if (isActive) {
    const execution = custom.execution as { phase?: string } | undefined;
    headerVerb =
      execution?.phase === "reconnecting" ||
      execution?.phase === "retry_scheduled"
        ? t("localizationActivity.reconnecting")
        : taskChatDisplayLabel("Working");
    if (liveElapsed) headerSuffix = t("localizationTaskRuntime.forDuration", { duration: liveElapsed });
  } else if (segmentTiming) {
    const durationMs = segmentTiming.endMs - segmentTiming.startMs;
    const durationText = taskChatDurationLabel(formatDurationWords(durationMs) ?? "");
    headerVerb = t("localizationTaskRuntime.worked");
    if (durationText) headerSuffix = t("localizationTaskRuntime.forDuration", { duration: durationText });
  } else {
    headerVerb = t("localizationTaskRuntime.worked");
  }

  const toolSummary = toolCountSummary(toolParts);
  const hasContent = allReasoningText.trim().length > 0 || toolParts.length > 0;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-start gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-accent/5"
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
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
              <span className="text-xs text-muted-foreground/60">
                {headerSuffix}
              </span>
            ) : null}
            {toolSummary ? (
              <span className="text-xs text-muted-foreground/40">
                · {toolSummary}
              </span>
            ) : null}
          </div>
          <IssueChatLiveRunStatusLine
            custom={custom}
            active={isActive}
            className="pl-6"
          />
        </div>
        {hasContent ? (
          <ChevronDown
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="space-y-1 py-1">
          {isActive && isVerboseStreamingBackend ? (
            <>
              {allReasoningText ? (
                <IssueChatVerboseLiveReasoningPart text={allReasoningText} />
              ) : null}
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
          ) : isActive ? (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.length > 0 ? (
                <IssueChatRollingToolPart toolParts={toolParts} />
              ) : null}
            </>
          ) : (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
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

// Live reasoning for verbose streaming backends: the one-line
// ticker cannot keep up with token-level delta volume, so show the full
// reasoning in a scrollable box that auto-follows the newest line unless the
// reader has scrolled up to review earlier thinking. All other adapters keep
// the ticker (IssueChatReasoningPart below), which is unchanged.
function IssueChatVerboseLiveReasoningPart({ text }: { text: string }) {

  useTranslation();
  const lines = text.split("\n").filter((l) => l.trim());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinnedToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [text]);

  if (lines.length <= 1) {
    return <IssueChatReasoningPart text={text} />;
  }

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          pinnedToBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
        className="min-w-0 flex-1 max-h-40 space-y-0.5 overflow-y-auto pr-1"
      >
        {lines.map((line, index) => (
          <p
            key={index}
            className="whitespace-pre-wrap break-words text-(length:--text-compact) italic leading-5 text-muted-foreground/70"
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function IssueChatReasoningPart({ text }: { text: string }) {

  useTranslation();
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
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function IssueChatRollingToolPart({
  toolParts,
}: {
  toolParts: ToolCallMessagePart[];
}) {

  useTranslation();
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
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function CopyablePreBlock({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  return (
    <div className="group/pre relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/pre:opacity-100",
          copied && "opacity-100",
        )}
        title={t("localizationTaskRuntime.ui_Copy_s6g5lw")}
        aria-label={t("localizationTaskRuntime.ui_Copy_s6g5lw")}
        onClick={() => {
          void copyTextToClipboard(children)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch((error) => {
              toastActions?.pushToast({
                get title() { return t("localizationTaskRuntime.ui_Copy_failed_1begn1d"); },
                body:
                  error instanceof Error
                    ? error.message
                    : t("localizationTaskRuntime.ui_Unable_to_copy_text_kfatar"),
                tone: "error",
              });
            });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

const TOOL_ICON_MAP: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  paperclip_provider_activity: ClipboardList,
};

function getToolIcon(
  toolName: string,
): React.ComponentType<{ className?: string }> {
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (toolName === "paperclip_provider_activity") {
    return (
      <IssueChatProviderActivity
        args={args}
        running={result === undefined}
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />
    );
  }
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
          <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-muted-foreground/80">
            {title}
            {!intentDetail && summary ? (
              <span className="ml-1.5 text-muted-foreground/50">{summary}</span>
            ) : null}
          </span>
          {result === undefined ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
          ) : null}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {open ? (
          <div className="mt-1 space-y-2 pb-1">
            {nonIntentDetails.length > 0 ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                  {t("localizationTaskRuntime.ui_Input_189z5sr")}
                </div>
                <dl className="space-y-1.5">
                  {nonIntentDetails.map((detail) => (
                    <div key={`${detail.label}:${detail.value}`}>
                      <dt className="text-(length:--text-nano) font-medium text-muted-foreground/60">
                        {toolInputDetailDisplay(detail, parsedArgs).label}
                      </dt>
                      <dd
                        className={cn(
                          "text-xs leading-5 text-foreground/70",
                          detail.tone === "code" &&
                            "font-mono text-(length:--text-micro)",
                        )}
                      >
                        {toolInputDetailDisplay(detail, parsedArgs).value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : rawArgsText ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                  {t("localizationTaskRuntime.ui_Input_189z5sr")}
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {rawArgsText}
                </CopyablePreBlock>
              </div>
            ) : null}
            {result !== undefined ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">{t("pages.secrets.import.steps.result")}</div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {resultText}
                </CopyablePreBlock>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IssueChatProviderActivity({
  args,
  running,
  open,
  onToggle,
}: {
  args: unknown;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const value =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const payload =
    typeof value.payload === "object" &&
    value.payload !== null &&
    !Array.isArray(value.payload)
      ? (value.payload as Record<string, unknown>)
      : {};
  const title =
    typeof value.title === "string" ? value.title : t("localizationTaskRuntime.ui_Provider_activity_3z9emh");
  const summary = typeof value.summary === "string" ? value.summary : "";
  const steps = Array.isArray(payload.steps) ? payload.steps.slice(0, 256) : [];
  const children = Array.isArray(payload.children)
    ? payload.children.slice(0, 64)
    : [];
  const sources = Array.isArray(payload.sources)
    ? payload.sources.slice(0, 64)
    : [];
  const output =
    typeof payload.output === "string" ? payload.output.slice(-(8 * 1024)) : "";
  const effectiveModel =
    typeof payload.effectiveModel === "string" ? payload.effectiveModel : null;
  const requestedModel =
    typeof payload.requestedModel === "string" ? payload.requestedModel : null;
  const hasDetails =
    steps.length > 0 ||
    children.length > 0 ||
    sources.length > 0 ||
    output.length > 0 ||
    effectiveModel !== null;
  return (
    <div
      className="flex gap-2 px-1"
      data-provider-family={String(value.family ?? "unknown")}
    >
      <div className="pt-1">
        <ClipboardList className="h-3.5 w-3.5 text-muted-foreground/50" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-accent/5"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-muted-foreground/80">
            {title}
            {summary ? (
              <span className="ml-1.5 text-muted-foreground/50">{summary}</span>
            ) : null}
          </span>
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
          ) : null}
          {hasDetails ? (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
                open && "rotate-180",
              )}
            />
          ) : null}
        </button>
        {open && hasDetails ? (
          <div className="mt-1 space-y-2 rounded-md border border-border/50 bg-accent/15 p-2 text-xs">
            {steps.map((entry, index) => {
              const step =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              return (
                <div key={String(step.stepId ?? index)} className="flex gap-2">
                  <span aria-hidden>
                    {step.status === "completed"
                      ? "✓"
                      : step.status === "blocked"
                        ? "!"
                        : "○"}
                  </span>
                  <span>{String(step.body ?? "")}</span>
                </div>
              );
            })}
            {children.map((entry, index) => {
              const child =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              return (
                <div key={String(child.childId ?? index)}>
                  <span className="font-medium">
                    {String(child.role ?? t("localizationTaskRuntime.ui_Child_agent_ffy6zw"))}
                  </span>{" "}
                  · {taskChatEnumLabel(String(child.status ?? "unknown"))}
                  {child.summary ? ` — ${String(child.summary)}` : ""}
                </div>
              );
            })}
            {sources.map((entry, index) => {
              const source =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              const href =
                typeof source.url === "string" &&
                /^https?:\/\//.test(source.url)
                  ? source.url
                  : null;
              return (
                <div key={String(source.sourceId ?? index)}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {String(source.title ?? href)}
                    </a>
                  ) : (
                    <span>{String(source.title ?? t("localizationTaskRuntime.ui_Unavailable_source_19zoxse"))}</span>
                  )}{" "}
                  <span className="text-muted-foreground">{t("localizationTaskRuntime.ui__provider_reported_1gwckph")}</span>
                </div>
              );
            })}
            {effectiveModel ? (
              <div>
                <span className="text-muted-foreground">{t("localizationTaskRuntime.ui_Model_107rbay")}</span>{" "}
                {requestedModel && requestedModel !== effectiveModel
                  ? `${requestedModel} → `
                  : ""}
                {effectiveModel}
              </div>
            ) : null}
            {output ? (
              <CopyablePreBlock className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-(length:--text-micro)">
                {output}
              </CopyablePreBlock>
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
  onAccent = false,
}: {
  message: ThreadMessage;
  recessed?: boolean;
  onAccent?: boolean;
}) {

  useTranslation();
  return (
    <>
      {message.content
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part, index) => (
          <IssueChatTextPart
            key={`${message.id}:text:${index}`}
            text={part.text}
            recessed={recessed}
            onAccent={onAccent}
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
    groups.push({
      type: "cot",
      parts: pendingCoT,
      startIndex: pendingStartIndex,
    });
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

  useTranslation();
  const groupedParts = useMemo(
    () => groupAssistantParts(message.content),
    [message.content],
  );
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
     t } = useTranslation();
  const {
    onInterruptQueued,
    onCancelQueued,
    onDeleteComment,
    currentUserId,
    userProfileMap,

    userLabelMap,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId =
    typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued =
    custom.queueState === "queued" || custom.clientStatus === "queued";
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const followUpRequested = custom.followUpRequested === true;
  const queueReason =
    typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel =
    queueReason === "hold" ? t("localizationTaskThread.deferredWake") : taskChatDisplayLabel("Queued");
  const pending = custom.clientStatus === "pending";
  const deleted = Boolean(custom.deletedAt);
  const queueTargetRunId =
    typeof custom.queueTargetRunId === "string"
      ? custom.queueTargetRunId
      : null;
  const [copied, setCopied] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const toastActions = useOptionalToastActions();
  const {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl,
  } = resolveIssueChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,

    userLabelMap,
  });
  const authorAvatar = (
    <Avatar size="sm" className="shrink-0">
      {avatarUrl ? (
        <AvatarImage src={avatarUrl} alt={resolvedAuthorName} />
      ) : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const canDeleteComment = Boolean(
    onDeleteComment && isCurrentUser && !queued && !pending && !deleted,
  );
  const handleDeleteComment = () => {
    if (!canDeleteComment) return;
    setDeleteDialogOpen(true);
  };
  const confirmDeleteComment = () => {
    if (!canDeleteComment) return;
    setDeleteDialogOpen(false);
    void onDeleteComment?.(commentId);
  };
  const messageBody = (
    <div
      className={cn(
        "flex min-w-0 max-w-(--pct-85) flex-col",
        isCurrentUser && "items-end",
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center gap-2 px-1",
          isCurrentUser ? "justify-end" : "justify-start",
        )}
      >
        <span className="text-sm font-medium text-foreground">
          {resolvedAuthorName}
        </span>
        <SourceTrustBadge sourceTrust={sourceTrust} artifactLabel="comment" />
        {followUpRequested ? (
          <Badge
            variant="outline"
            className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
          >
            {t("localizationTaskRuntime.ui_Follow_up_91gycy")}
          </Badge>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden break-all rounded-2xl px-4 py-2.5",
          // Tail-hugging corner: flatten the bottom corner nearest the avatar so
          // the bubble points at it (bottom-right for the right-aligned human).
          isCurrentUser ? "rounded-br-(--rad-4)" : "rounded-bl-(--rad-4)",
          queued
            ? "bg-amber-50/80 dark:bg-amber-500/10"
            : deleted
              ? "bg-muted/50 text-muted-foreground"
              : isCurrentUser
                ? // Liveness blue (--liveness-blue, decoupled from --status-task-in_progress
                  // in DECISION-SHEET.md A6) for the human's own messages (PAP-95 rev 5).
                  "bg-(--liveness-blue) text-white"
                : "bg-muted",
          pending && "opacity-80",
        )}
      >
        {queued ? (
          <div className="mb-1.5 flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-amber-400/60 bg-amber-100/70 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200"
            >
              {queueBadgeLabel}
            </Badge>
            {queueTargetRunId && onInterruptQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-red-300 px-2 text-(length:--text-micro) text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={isInterruptingQueuedRun}
                onClick={() => void onInterruptQueued(queueTargetRunId)}
              >
                {isInterruptingQueuedRun ? t("localizationTaskRuntime.ui_Interrupting_1jn05i6") : t("localizationTaskRuntime.ui_Interrupt_1arf5yo")}
              </Button>
            ) : null}
            {onCancelQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-300 px-2 text-(length:--text-micro) text-amber-900 hover:bg-amber-100/80 hover:text-amber-950 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/10"
                onClick={() => onCancelQueued(commentId)}
              >
                {t("localizationTaskRuntime.ui_Cancel_ew9em3")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {deleted ? (
          <div className="text-sm italic text-muted-foreground">{t("localizationIssueDetail.ui_Comment_deleted")}</div>
        ) : (
          <div className="min-w-0 max-w-full space-y-3">
            <IssueChatTextParts
              message={message}
              onAccent={isCurrentUser && !queued}
            />
          </div>
        )}
      </div>

      {pending ? (
        <div
          className={cn(
            "mt-1 flex px-1 text-(length:--text-micro) text-muted-foreground",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          {t("localizationTaskRuntime.ui_Sending_2q3xjh")}
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
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {!deleted ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title={t("localizationTaskRuntime.ui_Copy_message_1b3i557")}
              aria-label={t("localizationTaskRuntime.ui_Copy_message_1b3i557")}
              onClick={() => {
                const text = message.content
                  .filter(
                    (p): p is { type: "text"; text: string } =>
                      p.type === "text",
                  )
                  .map((p) => p.text)
                  .join("\n\n");
                void copyTextToClipboard(text)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch((error) => {
                    toastActions?.pushToast({
                      title: t("localizationAgents.ui93_Copy_failed"),
                      body:
                        error instanceof Error
                          ? error.message
                          : t("localizationTaskRuntime.ui_Unable_to_copy_message_9tn003"),
                      tone: "error",
                    });
                  });
              }}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {canDeleteComment ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
              title={t("localizationTaskRuntime.ui_Delete_comment_1o5c6oj")}
              aria-label={t("localizationTaskRuntime.ui_Delete_comment_1o5c6oj")}
              onClick={handleDeleteComment}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div id={anchorId}>
        <div
          className={cn(
            "group flex items-end gap-2",
            isCurrentUser && "justify-end",
          )}
        >
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
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localizationTaskRuntime.ui_Delete_comment_co8f44")}</DialogTitle>
            <DialogDescription>
              {t("localizationTaskRuntime.ui_This_will_replace_the_comment_with_a_deleted_comment_marker_qkvt99")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t("localizationTaskRuntime.ui_Cancel_ew9em3")}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteComment}>
              {t("localizationTaskRuntime.ui_Delete_comment_1o5c6oj")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
     t } = useTranslation();
  const {
    feedbackDataSharingPreference,
    feedbackTermsUrl,
    onVote,
    agentMap,
    onStopRun,
    stopRunLabel = t("localizationTaskRuntime.ui_Stop_run_94a594"),
    stoppingRunLabel = t("localizationTaskRuntime.ui_Stopping_1qfhze5"),
    stopRunVariant = "stop",
    runFinalizationActions = [],
    userLabelMap,
    issueAssigneeAgentId,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string"
      ? custom.authorName
      : typeof custom.runAgentName === "string"
        ? custom.runAgentName
        : t("localizationTaskRuntime.ui_Agent_1w5o8jq");
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : null;
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const attribution = resolveCommentAttribution({
    authorAgentId,
    onBehalfOfUserId:
      typeof custom.onBehalfOfUserId === "string"
        ? custom.onBehalfOfUserId
        : null,
    issueAssigneeAgentId,
    resolveUserLabel: (userId) => companyUserLabelDisplayLabel(userId, userLabelMap),
  });
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter(
        (notice): notice is string =>
          typeof notice === "string" && notice.length > 0,
      )
    : [];
  const waitingText =
    typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning =
    message.role === "assistant" && message.status?.type === "running";
  const runHref =
    runId && runAgentId ? `/agents/${runAgentId}/runs/${runId}` : null;
  const canStopRun =
    Boolean(runId) &&
    (isRunActive || runStatus === "queued" || runStatus === "running");
  const chainOfThoughtLabel =
    typeof custom.chainOfThoughtLabel === "string"
      ? custom.chainOfThoughtLabel
      : null;
  const hasCoT = message.content.some(
    (p) => p.type === "reasoning" || p.type === "tool-call",
  );
  const deleted = Boolean(custom.deletedAt);
  const isFoldable = !isRunning && !!chainOfThoughtLabel;
  const [folded, setFolded] = useState(isFoldable);
  const [prevFoldKey, setPrevFoldKey] = useState({
    messageId: message.id,
    isFoldable,
  });
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  const copyText = deleted ? "" : getThreadMessageCopyText(message);

  // Derive fold state synchronously during render (not in useEffect) so the
  // browser never paints the un-folded intermediate state — prevents the
  // visible "jump" when loading a page with already-folded work sections.
  if (
    message.id !== prevFoldKey.messageId ||
    isFoldable !== prevFoldKey.isFoldable
  ) {
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

  const kind = typeof custom.kind === "string" ? custom.kind : null;
  const hasCommentText = message.content.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
  // A genuine posted agent comment (kind "comment" with real text) renders in a
  // left-aligned neutral bubble — the mirror of the human blue bubble. Run
  // activity (chain-of-thought, tool calls, waiting shimmer, "worked N min")
  // keeps the existing flat / metadata treatment (PAP-95 rev 6).
  const isGenuineComment =
    kind === "comment" &&
    !!commentId &&
    !isRunning &&
    (hasCommentText || deleted);

  const agentAvatar = (
    <Avatar size="sm" className="shrink-0">
      {agentIcon ? (
        <AvatarFallback>
          <AgentIcon icon={agentIcon} className="h-3.5 w-3.5" />
        </AvatarFallback>
      ) : (
        <AvatarFallback>{initialsForName(authorName)}</AvatarFallback>
      )}
    </Avatar>
  );

  const messageActionBar = (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t("localizationTaskRuntime.ui_Copy_message_1b3i557")}
        aria-label={t("localizationTaskRuntime.ui_Copy_message_1b3i557")}
        onClick={() => {
          void copyTextToClipboard(copyText)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch((error) => {
              toastActions?.pushToast({
                title: t("localizationAgents.ui93_Copy_failed"),
                body:
                  error instanceof Error
                    ? error.message
                    : t("localizationTaskRuntime.ui_Unable_to_copy_message_9tn003"),
                tone: "error",
              });
            });
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
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
            className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
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
            title={t("localizationIssueDetail.ui_More_actions")}
            aria-label={t("localizationIssueDetail.ui_More_actions")}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void copyTextToClipboard(copyText).catch((error) => {
                toastActions?.pushToast({
                  get title() { return t("localizationTaskRuntime.ui_Copy_failed_1begn1d"); },
                  body:
                    error instanceof Error
                      ? error.message
                      : t("localizationTaskRuntime.ui_Unable_to_copy_message_9tn003"),
                  tone: "error",
                });
              });
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            {t("localizationTaskRuntime.ui_Copy_message_1b3i557")}
          </DropdownMenuItem>
          {canStopRun && onStopRun && runId ? (
            <DropdownMenuItem
              disabled={isStoppingRun}
              className={cn(
                stopRunVariant === "pause"
                  ? "text-amber-700 focus:text-amber-800 dark:text-amber-300 dark:focus:text-amber-200"
                  : "text-red-700 focus:text-red-800 dark:text-red-300 dark:focus:text-red-200",
              )}
              onSelect={() => {
                void onStopRun(runId);
              }}
            >
              {stopRunVariant === "pause" ? (
                <PauseCircle className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
              )}
              {isStoppingRun ? stoppingRunLabel : stopRunLabel}
            </DropdownMenuItem>
          ) : null}
          {runHref ? (
            <DropdownMenuItem asChild>
              <Link to={runHref} target="_blank" rel="noreferrer noopener">
                <Search className="mr-2 h-3.5 w-3.5" />{t("localizationActivity.viewRun")}</Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Genuine agent comment → neutral left-aligned bubble (mirror of the human
  // blue bubble in IssueChatUserMessage). See PAP-95 rev 6.
  if (isGenuineComment) {
    return (
      <div id={anchorId}>
        <div className="group flex flex-col items-start py-1.5">
          {/* Icon + name together in a header ABOVE the bubble (PAP-95 rev 7). */}
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {agentIcon ? (
                <AgentIcon icon={agentIcon} className="h-4 w-4" />
              ) : (
                <Avatar size="sm" className="size-5">
                  <AvatarFallback className="text-(length:--text-nano)">
                    {initialsForName(authorName)}
                  </AvatarFallback>
                </Avatar>
              )}
            </span>
            <span className="text-sm font-medium text-foreground">
              {authorName}
            </span>
            {/* Reads as "Fable · for Dotta" beside the author name (the open cross-task write design (attribution)). */}
            {attribution ? (
              <CommentAttributionChip
                agentName={authorName}
                userName={attribution.userName}
              />
            ) : null}
            <SourceTrustBadge
              sourceTrust={sourceTrust}
              artifactLabel="comment"
            />
            {followUpRequested ? (
              <Badge
                variant="outline"
                className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
              >
                {t("localizationTaskRuntime.ui_Follow_up_91gycy")}
              </Badge>
            ) : null}
          </div>
          {/* Canonical conference-room agent bubble (BoardChat.tsx:712). */}
          <div
            className={cn(
              "min-w-0 break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible [border-radius:14px_14px_14px_4px]",
              AGENT_COMMENT_BUBBLE_WIDTH_CLASS,
              deleted
                ? "border border-border bg-muted/50 text-muted-foreground"
                : "border border-border bg-card text-foreground",
            )}
          >
            {deleted ? (
              <div className="text-sm italic text-muted-foreground">{t("localizationIssueDetail.ui_Comment_deleted")}</div>
            ) : (
              <div className="min-w-0 max-w-full space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={false} />
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
            )}
          </div>
          {!deleted ? messageActionBar : null}
        </div>
      </div>
    );
  }

  return (
    <div id={anchorId}>
      <div className="flex items-start gap-2.5 py-1.5">
        {agentAvatar}

        <div className="min-w-0 flex-1">
          {isFoldable ? (
            <button
              type="button"
              className="group flex w-full items-center gap-2 py-0.5 text-left"
              onClick={() => setFolded((v) => !v)}
            >
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              <span className="text-xs text-muted-foreground/60">
                {chainOfThoughtLabel? issueChatRunLabelDisplay(chainOfThoughtLabel, taskChatDurationLabel).toLowerCase() : null}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {message.createdAt ? (
                  <span className="text-(length:--text-micro) text-muted-foreground/50">
                    {commentDateLabel(message.createdAt)}
                  </span>
                ) : null}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
                    !folded && "rotate-180",
                  )}
                />
              </span>
            </button>
          ) : (
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              {followUpRequested ? (
                <Badge
                  variant="outline"
                  className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
                >
                  {t("localizationTaskRuntime.ui_Follow_up_91gycy")}
                </Badge>
              ) : null}
              {isRunning ? (
                // Running chip shares the liveness-blue badge recipe with the
                // issue header's "Live" badge (one live/running blue).
                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)",
                    liveBlueBadge,
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("localizationTaskRuntime.ui_Running_j6ts6k")}
                </Badge>
              ) : null}
            </div>
          )}

          {deleted ? (
            <div className="rounded-sm bg-muted/40 px-3 py-2 text-sm italic text-muted-foreground">{t("localizationIssueDetail.ui_Comment_deleted")}</div>
          ) : !folded ? (
            <>
              <div className="space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={hasCoT} />
                {message.content.length === 0 && waitingText ? (
                  <div className="rounded-lg px-1 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                        {agentIcon ? (
                          <AgentIcon
                            icon={agentIcon}
                            className="h-4 w-4 shrink-0"
                          />
                        ) : (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                        <span className="shimmer-text">{issueChatRunLabelDisplay(waitingText, taskChatDurationLabel)}</span>
                      </span>
                    </div>
                    <IssueChatLiveRunStatusLine
                      custom={custom}
                      active={isRunning}
                      className="pl-6"
                    />
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

              {messageActionBar}
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
  onVote: (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [optimisticVote, setOptimisticVote] =
    useState<FeedbackVoteValue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [downvoteReason, setDownvoteReason] = useState("");
  const [pendingSharingDialog, setPendingSharingDialog] = useState<{
    vote: FeedbackVoteValue;
    reason?: string;
  } | null>(null);
  const visibleVote = optimisticVote ?? activeVote ?? null;

  useEffect(() => {
    if (optimisticVote && activeVote === optimisticVote)
      setOptimisticVote(null);
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
        title={t("localizationTaskRuntime.ui_Helpful_x076el")}
        aria-label={t("localizationTaskRuntime.ui_Helpful_x076el")}
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
            title={t("localizationTaskRuntime.ui_Needs_work_v7b92r")}
            aria-label={t("localizationTaskRuntime.ui_Needs_work_v7b92r")}
            onClick={handleThumbsDown}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <div className="mb-2 text-sm font-medium">{t("localizationTaskRuntime.ui_What_could_have_been_better_1natcm5")}</div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder={t("localizationIssueDetail.ui_Add_a_short_note")}
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
              {t("localizationTaskRuntime.ui_Dismiss_an1pf7")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || !downvoteReason.trim()}
              onClick={handleSubmitReason}
            >
              {isSaving ? t("localizationTaskRuntime.ui_Saving_8kfkb3") : t("localizationTaskRuntime.ui_Save_note_1f8pchg")}
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
            <DialogTitle>{t("localizationTaskRuntime.ui_Save_your_feedback_sharing_preference_1ebw6en")}</DialogTitle>
            <DialogDescription>
              {t("localizationTaskRuntime.ui_Choose_whether_voted_AI_outputs_can_be_shared_with_Paperclip_Labs_crke3y")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>{t("localizationTaskRuntime.ui_This_vote_is_always_saved_locally_kj9hq1")}</p>
            <p><Trans i18nKey="localizationTaskRuntime.feedbackSharingPolicy" components={{ allow: <span className="font-medium text-foreground" />, deny: <span className="font-medium text-foreground" /> }} /></p>
            <p>{t("localizationTaskRuntime.ui_You_can_change_this_later_in_Settings_General_1veml1c")}</p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >{t("localizationSettings.terms")}</a>
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
                  pendingSharingDialog.reason
                    ? { reason: pendingSharingDialog.reason }
                    : undefined,
                ).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? t("localizationTaskRuntime.ui_Saving_8kfkb3") : t("localizationSettings.dontAllow")}
            </Button>
            <Button
              type="button"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(pendingSharingDialog.vote, {
                  allowSharing: true,
                  ...(pendingSharingDialog.reason
                    ? { reason: pendingSharingDialog.reason }
                    : {}),
                }).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? t("localizationTaskRuntime.ui_Saving_8kfkb3") : t("localizationTaskRuntime.ui_Always_allow_1vl0a6l")}
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
     t } = useTranslation();
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
    onCancelInteraction,
    onUploadImage,
    externalReferences,
  } = useContext(IssueChatCtx);
  const [expanded, setExpanded] = useState(false);
  const hasResolvedActor = Boolean(
    interaction.resolvedByAgentId || interaction.resolvedByUserId,
  );
  const actorAgentId = hasResolvedActor
    ? (interaction.resolvedByAgentId ?? null)
    : (interaction.createdByAgentId ?? null);
  const actorUserId = hasResolvedActor
    ? (interaction.resolvedByUserId ?? null)
    : (interaction.createdByUserId ?? null);
  const actorName = formatInteractionActorLabel({
    agentId: actorAgentId,
    userId: actorUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const actorIcon = actorAgentId
    ? agentMap?.get(actorAgentId)?.icon
    : undefined;
  const isCurrentUser = Boolean(
    actorUserId && currentUserId && actorUserId === currentUserId,
  );
  const detailsId = anchorId
    ? `${anchorId}-details`
    : `${interaction.id}-details`;
  const summary = buildIssueThreadInteractionSummary(interaction);

  const rowContent = (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs",
          isCurrentUser && "justify-end",
        )}
      >
        <span className="font-medium text-foreground">{actorName}</span>
        <span className="text-muted-foreground">{t("localizationTaskRuntime.taskUpdatedBy")}</span>
        <a
          href={anchorId ? `#${anchorId}` : undefined}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {timeAgo(message.createdAt)}
        </a>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded ? t("localizationTaskRuntime.ui_Hide_confirmation_1e7a40q") : t("localizationTaskRuntime.ui_Expired_confirmation_1qkbp3b")}
        </button>
      </div>
      {expanded ? (
        <p
          className={cn(
            "mt-1 text-xs text-muted-foreground",
            isCurrentUser && "text-right",
          )}
        >
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
              <AvatarFallback>
                <AgentIcon icon={actorIcon} className="h-3.5 w-3.5" />
              </AvatarFallback>
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
            onCancelInteraction={onCancelInteraction}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        </div>
      ) : null}
    </div>
  );
}

function isIssueCommentPresentation(
  value: unknown,
): value is IssueCommentPresentation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "system_notice" || v.kind === "message";
}

function isIssueCommentMetadata(value: unknown): value is IssueCommentMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.sections);
}

function isSourceTrustMetadata(value: unknown): value is SourceTrustMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.preset === "low_trust_review" &&
    (v.disposition === "quarantined" || v.disposition === "promoted")
  );
}

function issueStatusIsTerminalDisposition(issueStatus: string | undefined) {
  return issueStatus === "done" || issueStatus === "cancelled";
}

function sourceRunIdFromSuccessfulRunHandoffMetadata(
  metadata: IssueCommentMetadata | null,
) {
  if (metadata?.sourceRunId) return metadata.sourceRunId;
  const runLinks = [];
  for (const section of metadata?.sections ?? []) {
    for (const row of section.rows) {
      if (row.type === "run_link") runLinks.push(row.runId);
    }
  }
  return runLinks.length === 1 ? runLinks[0] : null;
}

function isStaleSuccessfulRunHandoffNotice(input: {
  bodyText: string;
  issueStatus?: string;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  runId?: string | null;
  metadata: IssueCommentMetadata | null;
}) {
  if (!isSuccessfulRunHandoffComment(input.bodyText)) return false;

  const currentHandoff = input.successfulRunHandoff ?? null;
  if (currentHandoff?.state === "resolved") return true;
  if (issueStatusIsTerminalDisposition(input.issueStatus)) return true;
  // A live continuation (running/queued run or queued wake) means an agent is
  // already handling the issue — fold the warning until the issue is actually
  // stuck again.
  if (currentHandoff?.hasLiveContinuation) return true;

  const noticeSourceRunId =
    sourceRunIdFromSuccessfulRunHandoffMetadata(input.metadata) ??
    input.runId ??
    null;
  if (
    noticeSourceRunId &&
    currentHandoff?.sourceRunId &&
    noticeSourceRunId !== currentHandoff.sourceRunId
  ) {
    return true;
  }

  return false;
}

function StaleDispositionWarningMetadataRow({
  row,
}: {
  row: SystemNoticeMetadataRow;
}) {

  useTranslation();
  const label = (
    <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
      {systemNoticeMetadataLabelDisplay(row.label)}
    </span>
  );
  const value = (() => {
    switch (row.kind) {
      case "text":
        return <span>{systemNoticeMetadataValueDisplay(row)}</span>;
      case "code":
        return (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
            {row.value}
          </code>
        );
      case "issue": {
        const content = (
          <>
            <span>{row.identifier}</span>
            {row.title ? (
              <span className="text-muted-foreground"> - {row.title}</span>
            ) : null}
          </>
        );
        return row.href ? (
          <a
            href={row.href}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {content}
          </a>
        ) : (
          <span className="font-medium text-foreground">{content}</span>
        );
      }
      case "agent":
        return row.href ? (
          <a
            href={row.href}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {row.name}
          </a>
        ) : (
          <span className="font-medium text-foreground">{row.name}</span>
        );
      case "run": {
        const runShort =
          row.runId.length > 12 ? `${row.runId.slice(0, 8)}...` : row.runId;
        const content = (
          <>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
              {runShort}
            </code>
            {row.status ? <span>{systemNoticeRunStatusDisplay(row.status)}</span> : null}
          </>
        );
        return row.href ? (
          <a
            href={row.href}
            className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline"
          >
            {content}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5">{content}</span>
        );
      }
    }
  })();

  return (
    <div className="grid grid-cols-(--gtc-7) gap-2 text-xs leading-5">
      {label}
      <div className="min-w-0 break-words text-foreground/80">{value}</div>
    </div>
  );
}

function metadataRowKey(row: SystemNoticeMetadataRow) {
  switch (row.kind) {
    case "issue":
      return `issue:${row.label}:${row.identifier}:${row.href ?? ""}:${row.title ?? ""}`;
    case "agent":
      return `agent:${row.label}:${row.name}:${row.href ?? ""}`;
    case "run":
      return `run:${row.label}:${row.runId}:${row.href ?? ""}:${row.status ?? ""}`;
    default:
      return `${row.kind}:${row.label}:${row.value}`;
  }
}

function metadataSectionKey(section: SystemNoticeMetadataSection) {
  return `${section.title ?? "details"}:${section.rows.map(metadataRowKey).join("|")}`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTimelineWorkspace(value: unknown): value is IssueTimelineWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workspace = value as Record<string, unknown>;
  return (
    isNullableString(workspace.label) &&
    isNullableString(workspace.projectWorkspaceId) &&
    isNullableString(workspace.executionWorkspaceId) &&
    isNullableString(workspace.mode)
  );
}

function isTimelineWorkspaceChange(
  value: unknown,
): value is NonNullable<IssueTimelineEvent["workspaceChange"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return isTimelineWorkspace(change.from) && isTimelineWorkspace(change.to);
}

function StaleDispositionWarningDetails({
  sections,
}: {
  sections: SystemNoticeMetadataSection[];
}) {

  const { t } = useTranslation();
  if (sections.length === 0) {
    return (
      <div className="text-xs leading-5 text-muted-foreground">{t("localizationTaskRuntime.ui_No_additional_details_as053x")}</div>
    );
  }

  return (
    <div className="space-y-3 text-left">
      {sections.map((section) => (
        <div key={metadataSectionKey(section)} className="space-y-1.5">
          {section.title ? (
            <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {systemNoticeMetadataLabelDisplay(section.title)}
            </div>
          ) : null}
          <div className="space-y-1">
            {section.rows.map((row) => (
              <StaleDispositionWarningMetadataRow
                key={metadataRowKey(row)}
                row={row}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StaleDispositionWarningRow({
  anchorId,
  message,
  metadata,
  runAgentId,
}: {
  anchorId?: string;
  message: ThreadMessage;
  metadata: IssueCommentMetadata | null;
  runAgentId?: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const sections = mapCommentMetadataToSystemNoticeSections(metadata, {
    runAgentId,
  });

  return (
    <div id={anchorId} data-testid="stale-disposition-warning">
      <div className="flex items-start gap-2.5 py-1.5">
        <span className="size-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            className="group flex w-full items-center gap-2 py-0.5 text-left"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="text-sm font-medium text-foreground/80">
              {t("localizationTaskRuntime.ui_Stale_disposition_warning_8mzu19")}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {message.createdAt ? (
                <span
                  data-testid="stale-disposition-warning-time"
                  className="text-(length:--text-micro) text-muted-foreground/50"
                >
                  {commentDateLabel(message.createdAt)}
                </span>
              ) : null}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
                  open && "rotate-180",
                )}
              />
            </span>
          </button>
          <div id={detailsId} hidden={!open} className="space-y-1 py-1">
            <StaleDispositionWarningDetails sections={sections} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Tone-colored dot for the fully-collapsed compact notice row. Tone is never
// conveyed by color alone — the adjacent title text names the notice.
const COMPACT_TONE_DOT: Record<SystemNoticeTone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-sky-500 dark:bg-sky-400",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  danger: "bg-red-500 dark:bg-red-400",
};

// A system notice whose presentation opts into `density: "compact"` collapses to
// a single quiet row — tone dot + title (+ author) + timestamp + chevron.
// Expanding reveals the full SystemNotice card (body + details), so no
// information is lost. Generalized from the StaleDispositionWarningRow precedent.
function CompactSystemNoticeRow({
  anchorId,
  message,
  tone,
  title,
  source,
  noticeProps,
  defaultOpen = false,
}: {
  anchorId?: string;
  message: ThreadMessage;
  tone: SystemNoticeTone;
  title: string;
  source?: SystemNoticeProps["source"];
  noticeProps: SystemNoticeProps;
  defaultOpen?: boolean;
}) {

  useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();

  return (
    <div id={anchorId} data-testid="compact-system-notice" className="group">
      <div className="flex items-start gap-2.5 py-1.5">
        <span className="size-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            className="-mx-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/5"
            onClick={() => setOpen((value) => !value)}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                COMPACT_TONE_DOT[tone],
              )}
              aria-hidden
            />
            <span className="truncate text-sm font-medium text-foreground/80">
              {title}
            </span>
            {source ? (
              <span className="truncate text-(length:--text-micro) text-muted-foreground">
                · {source.label}
              </span>
            ) : null}
            {/* Trailing meta never shrinks — keeps the timestamp on one line so the
                collapsed row stays a single quiet line on narrow / mobile widths. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {message.createdAt ? (
                <span
                  data-testid="compact-system-notice-time"
                  className="whitespace-nowrap text-(length:--text-micro) text-muted-foreground/50"
                >
                  {commentDateLabel(message.createdAt)}
                </span>
              ) : null}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground/70",
                  open && "rotate-180",
                )}
              />
            </span>
          </button>
          <div id={detailsId} hidden={!open} className="py-1">
            <SystemNotice {...noticeProps} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SystemNoticeCommentRow({
  message,
  anchorId,
}: {
  message: ThreadMessage;
  anchorId?: string;
}) {
  const { t } = useTranslation();
  const { onImageClick, agentMap, issueStatus, successfulRunHandoff } =
    useContext(IssueChatCtx);
  const toastActions = useOptionalToastActions();
  const custom = message.metadata.custom as Record<string, unknown>;
  const presentation = isIssueCommentPresentation(custom.presentation)
    ? custom.presentation
    : null;
  const commentMetadata = isIssueCommentMetadata(custom.commentMetadata)
    ? custom.commentMetadata
    : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const authorType =
    typeof custom.authorType === "string" ? custom.authorType : null;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const bodyText = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const staleSuccessfulRunHandoffNotice = isStaleSuccessfulRunHandoffNotice({
    bodyText,
    issueStatus,
    successfulRunHandoff,
    runId,
    metadata: commentMetadata,
  });
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const source = (() => {
    const runAgentName = runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? null)
      : null;
    if (authorType === "system") {
      const label = runAgentName ?? "Paperclip";
      if (runAgentId && runId)
        return { label, href: `/agents/${runAgentId}/runs/${runId}` };
      return { label };
    }
    if (runAgentId && runId) {
      return {
        label: authorName ?? runAgentName ?? "Paperclip",
        href: `/agents/${runAgentId}/runs/${runId}`,
      };
    }
    if (authorName) return { label: authorName };
    return undefined;
  })();

  const props = buildSystemNoticeProps({
    presentation,
    metadata: commentMetadata,
    body: (
      <MarkdownBody
        className="text-sm leading-6"
        softBreaks
        onImageClick={onImageClick}
      >
        {bodyText}
      </MarkdownBody>
    ),
    timestamp: toValidIsoString(message.createdAt),
    source,
    runAgentId,
  });

  const handleCopy = () => {
    void copyTextToClipboard(bodyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          get title() { return t("localizationTaskRuntime.ui_Copy_failed_1begn1d"); },
          body:
            error instanceof Error
              ? error.message
              : t("localizationTaskRuntime.ui_Unable_to_copy_system_notice_1dn1n2n"),
          tone: "error",
        });
      });
  };

  const handleCopyLink = () => {
    if (!anchorId || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    void copyTextToClipboard(url)
      .then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          get title() { return t("localizationTaskRuntime.ui_Copy_failed_1begn1d"); },
          body:
            error instanceof Error
              ? error.message
              : t("localizationTaskRuntime.ui_Unable_to_copy_system_notice_link_19f923l"),
          tone: "error",
        });
      });
  };

  if (staleSuccessfulRunHandoffNotice) {
    return (
      <StaleDispositionWarningRow
        anchorId={anchorId}
        message={message}
        metadata={commentMetadata}
        runAgentId={runAgentId}
      />
    );
  }

  // Compact presentation collapses the notice to a single quiet row. Notices
  // without `density` (old comments / old data) keep today's full card.
  if (presentation?.density === "compact") {
    const tone = presentation.tone ?? "neutral";
    const title = systemNoticeLabelForTone(tone, presentation.title);
    return (
      <CompactSystemNoticeRow
        anchorId={anchorId}
        message={message}
        tone={tone}
        title={title}
        source={source}
        noticeProps={props}
        defaultOpen={Boolean(presentation.detailsDefaultOpen)}
      />
    );
  }

  return (
    <div id={anchorId} className="group">
      <div className="py-1">
        <SystemNotice {...props} />
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {anchorId ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title={t("pages.secrets.actions.copyLink")}
              aria-label={t("localizationTaskRuntime.ui_Copy_link_to_system_notice_35y0i")}
              onClick={handleCopyLink}
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title={t("localizationTaskRuntime.ui_Copy_notice_text_1v4vodb")}
            aria-label={t("localizationTaskRuntime.ui_Copy_system_notice_1i8uion")}
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Non-comment timeline items (run/status events, "updated this task",
// "worked for N minutes") render as quiet, subordinate metadata rows hung off a
// left rail — visually distinct from the bubbles used for genuine comments.
// Virtualized rows are absolutely positioned, so each row carries its own rail
// segment; stacked rows read as one continuous rail. See PAP-95 mockup rev 5.
function IssueChatMetadataRow({
  anchorId,
  icon,
  children,
  testid = "issue-chat-metadata-row",
}: {
  anchorId?: string;
  icon: ReactNode;
  children: ReactNode;
  testid?: string;
}) {

  useTranslation();
  return (
    <div id={anchorId} data-testid={testid}>
      <div className="ml-3 flex items-start gap-2.5 border-l-2 border-border/50 py-0.5 pl-3">
        <span className="mt-px flex size-(--sz-18px) shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground/60">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">{children}</div>
      </div>
    </div>
  );
}

function IssueChatSystemMessage({ message }: { message: ThreadMessage }) {
  const {
     t } = useTranslation();
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
    onSubmitInteractionAnswers,
    onCancelInteraction,
    onSubmitInteractionVerdicts,
    onUploadImage,
    externalReferences,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgentName =
    typeof custom.runAgentName === "string" ? custom.runAgentName : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const actorName =
    typeof custom.actorName === "string" ? custom.actorName : null;
  const actorType =
    typeof custom.actorType === "string" ? custom.actorType : null;
  const actorId = typeof custom.actorId === "string" ? custom.actorId : null;
  const statusChange =
    typeof custom.statusChange === "object" && custom.statusChange
      ? (custom.statusChange as { from: string | null; to: string | null })
      : null;
  const assigneeChange =
    typeof custom.assigneeChange === "object" && custom.assigneeChange
      ? (custom.assigneeChange as {
          from: IssueTimelineAssignee;
          to: IssueTimelineAssignee;
        })
      : null;
  const workspaceChange = isTimelineWorkspaceChange(custom.workspaceChange)
    ? custom.workspaceChange
    : null;
  const interaction = isIssueThreadInteraction(custom.interaction)
    ? custom.interaction
    : null;

  if (custom.kind === "system_notice") {
    return <SystemNoticeCommentRow message={message} anchorId={anchorId} />;
  }

  if (custom.kind === "interaction" && interaction) {
    if (
      interaction.kind === "request_confirmation" &&
      interaction.status === "expired" &&
      !interaction.payload.secretProposal
    ) {
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
            onCancelInteraction={onCancelInteraction}
            onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        </div>
      </div>
    );
  }

  if (custom.kind === "event" && actorName) {
    const isAgent = actorType === "agent";
    const agentIcon =
      isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;
    const isCurrentUser =
      actorType === "user" && !!currentUserId && actorId === currentUserId;
    const rowIcon = agentIcon ? (
      <AgentIcon icon={agentIcon} className="h-3 w-3" />
    ) : (
      <ClipboardList className="h-3 w-3" />
    );
    const handoffResolvers: HandoffChipResolvers = {
      agentMap,
      currentUserId,
      resolveUserLabel: (userId) =>
        formatAssigneeUserLabel(userId, null, userLabelMap),
    };

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">
            {custom.followUpRequested === true
              ? t("localizationTaskRuntime.followUpRequestedBy") : t("localizationTaskRuntime.taskUpdatedBy")}
          </span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {statusChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
              {t("localizationTaskRuntime.ui_Status_3pd73")}
            </span>
            <span className="text-muted-foreground">
              {humanizeValue(statusChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
            <span className="font-medium text-foreground">
              {humanizeValue(statusChange.to)}
            </span>
          </div>
        ) : null}

        {assigneeChange ? (
          <div className="space-y-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5 text-xs",
                isCurrentUser && "justify-end",
              )}
            >
              <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">{t("localizationFilters.assignee")}</span>
              <AssigneeChip
                assignee={assigneeChange.from}
                resolvers={handoffResolvers}
              />
              <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
              <AssigneeChip
                assignee={assigneeChange.to}
                resolvers={handoffResolvers}
              />
            </div>
            <div className={cn(isCurrentUser && "flex justify-end")}>
              <HandoffWakeRow
                to={assigneeChange.to}
                resolvers={handoffResolvers}
                interruptedRunAttached={custom.interruptedRunId != null}
              />
            </div>
          </div>
        ) : null}

        {workspaceChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
              {t("localizationTaskRuntime.ui_Workspace_aw4cba")}
            </span>
            <span className="text-muted-foreground">
              {formatTimelineWorkspaceLabel(workspaceChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
            <span className="font-medium text-foreground">
              {formatTimelineWorkspaceLabel(workspaceChange.to)}
            </span>
          </div>
        ) : null}
      </IssueChatMetadataRow>
    );
  }

  const displayedRunAgentName =
    runAgentName ??
    (runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? runAgentId.slice(0, 8))
      : null);
  const runAgentIcon = runAgentId ? agentMap?.get(runAgentId)?.icon : undefined;
  if (
    custom.kind === "run" &&
    runId &&
    runAgentId &&
    displayedRunAgentName &&
    runStatus
  ) {
    const rowIcon = runAgentIcon ? (
      <AgentIcon icon={runAgentIcon} className="h-3 w-3" />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
    );

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <Link
            to={`/agents/${runAgentId}`}
            className="font-medium text-foreground transition-colors hover:underline"
          >
            {displayedRunAgentName}
          </Link>
          <span className="text-muted-foreground">{t("localizationActivity.run")}</span>
          <Link
            to={`/agents/${runAgentId}/runs/${runId}`}
            className="inline-flex items-center rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {runId.slice(0, 8)}
          </Link>
          <RunStatusBadge
            status={runStatus}
            operatorInterrupted={custom.runOperatorInterrupted === true}
          />
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>
      </IssueChatMetadataRow>
    );
  }

  return null;
}

function issueChatMessageCustom(
  message: ThreadMessage,
): Record<string, unknown> {
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

function issueChatMessageQueueTargetRunId(
  message: ThreadMessage,
): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.queueTargetRunId === "string"
    ? custom.queueTargetRunId
    : null;
}

function issueChatMessageActiveVote(
  message: ThreadMessage,
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>,
): FeedbackVoteValue | null {
  const commentId = issueChatMessageCommentId(message);
  return commentId ? (feedbackVoteByTargetId.get(commentId) ?? null) : null;
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
  return Boolean(
    queueTargetRunId && interruptingQueuedRunId === queueTargetRunId,
  );
}

function issueChatMessageIsDeleted(message: ThreadMessage): boolean {
  const custom = issueChatMessageCustom(message);
  return Boolean(custom.deletedAt);
}

function issueChatMessageDeletedAt(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.deletedAt === "string" ? custom.deletedAt : null;
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
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => void;
  scrollToLatest: (options?: { behavior?: ScrollBehavior }) => void;
  measure: () => void;
}

function issueChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = message.metadata.custom as { anchorId?: unknown } | undefined;
  return typeof custom?.anchorId === "string" ? custom.anchorId : null;
}

function findMessageAnchorIndex(
  messages: readonly ThreadMessage[],
  anchorId: string,
): number {
  return messages.findIndex(
    (message) => issueChatMessageAnchorId(message) === anchorId,
  );
}

export function findLatestCommentMessageIndex(
  messages: readonly ThreadMessage[],
): number {
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
  { kind: "window" } | { kind: "element"; element: HTMLElement };

type SimpleVirtualItem = {
  index: number;
  key: React.Key;
  start: number;
  size: number;
};

export function getVirtualizedMeasurementScrollAdjustment(args: {
  itemStart: number;
  previousSize: number;
  nextSize: number;
  viewportStart: number;
}) {
  const { itemStart, previousSize, nextSize, viewportStart } = args;
  const previousEnd = itemStart + previousSize;
  if (previousEnd > viewportStart) return 0;
  return nextSize - previousSize;
}

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

  const viewportHeight = () =>
    mode.kind === "window" ? window.innerHeight : mode.element.clientHeight;
  const scrollOffset = () =>
    mode.kind === "window" ? window.scrollY : mode.element.scrollTop;
  const maxScrollOffset = () => {
    const targetScrollHeight =
      mode.kind === "window"
        ? document.documentElement.scrollHeight
        : mode.element.scrollHeight;
    return Math.max(
      0,
      Math.max(targetScrollHeight, totalSize) - viewportHeight(),
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target: Window | HTMLElement =
      mode.kind === "window" ? window : mode.element;
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
    visibleStartIndex < count - 1 &&
    itemStarts[visibleStartIndex] + itemSizes[visibleStartIndex] < rawStart
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
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => {
    const clampedIndex = Math.max(0, Math.min(index, count - 1));
    const targetMax = maxScrollOffset();
    let top = itemStarts[clampedIndex] ?? scrollMargin;
    if (options?.align === "center") {
      top =
        top -
        viewportHeight() / 2 +
        (itemSizes[clampedIndex] ?? estimatedSize) / 2;
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
      const measuredSize =
        element.getBoundingClientRect().height || element.offsetHeight;
      if (!Number.isFinite(measuredSize) || measuredSize <= 0) return;
      const key = getItemKey(index);
      const previousSize =
        measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
      if (Math.abs(previousSize - measuredSize) < 1) return;
      const scrollAdjustment = getVirtualizedMeasurementScrollAdjustment({
        itemStart: itemStarts[index] ?? scrollMargin,
        previousSize,
        nextSize: measuredSize,
        viewportStart: Math.max(scrollMargin, scrollOffset()),
      });
      measuredSizeByKeyRef.current.set(key, measuredSize);
      if (Math.abs(scrollAdjustment) >= 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        }
      }
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
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

const VirtualizedIssueChatThreadList = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListProps
>(function VirtualizedIssueChatThreadList(props, ref) {

  useTranslation();
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
>(function VirtualizedIssueChatThreadListInner(
  {
    messages,
    feedbackVoteByTargetId,
    activeRunIds,
    stoppingRunId,
    interruptingQueuedRunId,
    variant,
    mode,
    probeRef,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const pendingPrependAnchorRef =
    useRef<VirtualizedVisibleAnchorSnapshot | null>(null);

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      parentRef.current = element;
      probeRef.current = element;
    },
    [probeRef],
  );

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element || typeof window === "undefined") return;
    const update = () => {
      if (!parentRef.current) return;
      const rect = parentRef.current.getBoundingClientRect();
      const offset =
        mode.kind === "window"
          ? rect.top + window.scrollY
          : rect.top -
            mode.element.getBoundingClientRect().top +
            mode.element.scrollTop;
      setScrollMargin((previous) =>
        Math.abs(previous - offset) < 0.5 ? previous : offset,
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const gap =
    variant === "embedded"
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

  useImperativeHandle(
    ref,
    () => ({
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
    }),
    [messages.length, virtualizer],
  );

  useLayoutEffect(() => {
    return () => {
      const element = parentRef.current;
      if (!element || typeof window === "undefined") return;
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>("[data-anchor-id][data-index]"),
      );
      const visibleRow = rows.find(
        (row) => row.getBoundingClientRect().bottom >= 0,
      );
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
      const delta =
        element.getBoundingClientRect().top - pendingAnchor.viewportTop;
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

function IssueChatDeletedComment({
  message,
  deletedAt,
}: {
  message: ThreadMessage;
  deletedAt: string;
}) {
  const { t } = useTranslation();
  const custom = issueChatMessageCustom(message);
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : t("localizationTaskRuntime.ui_Comment_169e4n2");
  const deletedDate = new Date(deletedAt);
  const deletedDateLabel = Number.isNaN(deletedDate.getTime())
    ? ""
    : formatDateTime(deletedDate);

  return (
    <div id={anchorId} className="flex items-start gap-2.5 py-1.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Trash2 className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Trans i18nKey="localizationTaskRuntime.commentDeletedBy" values={{ actor: authorName }} components={{ actor: <span className="font-medium text-foreground/80" /> }} />
        {deletedDateLabel ? (
          <span className="text-xs"> · {deletedDateLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

const IssueChatMessageRow = memo(function IssueChatMessageRow({
  message,
  feedbackVoteByTargetId,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: IssueChatMessageRowProps) {

  useTranslation();
  const kind = issueChatMessageKind(message);
  const deletedAt = issueChatMessageDeletedAt(message);
  const activeVote = issueChatMessageActiveVote(
    message,
    feedbackVoteByTargetId,
  );
  const isRunActive = issueChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = issueChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = issueChatMessageQueuedRunIsInterrupting(
    message,
    interruptingQueuedRunId,
  );
  const renderedMessage = deletedAt ? (
    <IssueChatDeletedComment message={message} deletedAt={deletedAt} />
  ) : message.role === "user" ? (
    <IssueChatUserMessage
      message={message}
      isInterruptingQueuedRun={isInterruptingQueuedRun}
    />
  ) : message.role === "assistant" ? (
    <IssueChatAssistantMessage
      message={message}
      activeVote={activeVote}
      isRunActive={isRunActive}
      isStoppingRun={isStoppingRun}
    />
  ) : (
    <IssueChatSystemMessage message={message} />
  );

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
  if (
    issueChatMessageActiveVote(prev.message, prev.feedbackVoteByTargetId) !==
    issueChatMessageActiveVote(next.message, next.feedbackVoteByTargetId)
  )
    return false;
  if (
    issueChatMessageRunIsActive(prev.message, prev.activeRunIds) !==
    issueChatMessageRunIsActive(next.message, next.activeRunIds)
  )
    return false;
  if (
    issueChatMessageRunIsStopping(prev.message, prev.stoppingRunId) !==
    issueChatMessageRunIsStopping(next.message, next.stoppingRunId)
  )
    return false;
  if (
    issueChatMessageQueuedRunIsInterrupting(
      prev.message,
      prev.interruptingQueuedRunId,
    ) !==
    issueChatMessageQueuedRunIsInterrupting(
      next.message,
      next.interruptingQueuedRunId,
    )
  )
    return false;
  return true;
}

const IssueChatComposer = forwardRef<
  IssueChatComposerHandle,
  IssueChatComposerProps
>(function IssueChatComposer(
  {
    onSend,
    onReviewConversation,
    onStop,
    stopPending,
    stopScope = "leaf",
    onImageUpload,
    onAttachImage,
    draftKey,
    enableReassign = false,
    reassignOptions = [],
    currentAssigneeValue = "",
    suggestedAssigneeValue,
    mentions = [],
    agentMap,
    hasActiveRun = false,
    currentUserId = null,
    userLabelMap = null,
    composerDisabledReason = null,
    composerHint = null,
    issueStatus,
    issueWorkMode,
    onWorkModeChange,
  },
  forwardedRef,
) {
  useTranslation();
  const stopControl = useComposerStop(onStop, stopPending);
  // Initialize before StrictMode's mount cleanup can flush an empty value over
  // the stored draft. The effect below handles subsequent task-key changes.
  const [body, setBody] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [uncertainSubmission, setUncertainSubmission] =
    useState<ComposerDraftSubmission | null>(() =>
      draftKey ? loadDraftSubmission(draftKey) : null,
    );
  const mountedTaskKey = useRef(draftKey);
  useEffect(() => {
    mountedTaskKey.current = draftKey;
    setUncertainSubmission(draftKey ? loadDraftSubmission(draftKey) : null);
    return () => {
      mountedTaskKey.current = undefined;
    };
  }, [draftKey]);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachmentState] = useState<
    ComposerAttachmentItem[]
  >(() =>
    draftKey
      ? loadDraftAttachments(draftKey).map((item) => ({
          ...item,
          size: item.size ?? 0,
          id: `receipt:${item.attachmentId}`,
          status: "attached",
        }))
      : [],
  );
  const composerAttachmentsRef = useRef(composerAttachments);
  function setComposerAttachments(
    update:
      | ComposerAttachmentItem[]
      | ((previous: ComposerAttachmentItem[]) => ComposerAttachmentItem[]),
  ) {
    const next =
      typeof update === "function"
        ? update(composerAttachmentsRef.current)
        : update;
    composerAttachmentsRef.current = next;
    setComposerAttachmentState(next);
  }
  const dragDepthRef = useRef(0);
  const effectiveSuggestedAssigneeValue =
    suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(
    effectiveSuggestedAssigneeValue,
  );
  const [noAssigneeDialogOpen, setNoAssigneeDialogOpen] = useState(false);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(
    null,
  );
  const resolvedIssueWorkMode: IssueWorkMode = issueWorkMode ?? "standard";
  const [pendingWorkMode, setPendingWorkMode] = useState<IssueWorkMode>(
    resolvedIssueWorkMode,
  );
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const canToggleWorkMode = typeof onWorkModeChange === "function";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const reassignTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAssigneeOnDialogCloseRef = useRef(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles =
    !uncertainSubmission && Boolean(onImageUpload || onAttachImage);
  const uploadUnsettled =
    attaching || composerAttachments.some((item) => item.status !== "attached");
  const attachedFiles = composerAttachments.filter(
    (item) => item.status === "attached" && !item.inline && item.contentPath,
  );

  function queueViewportRestore(
    snapshot: ReturnType<typeof captureComposerViewportSnapshot>,
  ) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    requestAnimationFrame(() => {
      window.scrollBy({
        top: COMPOSER_FOCUS_SCROLL_PADDING_PX,
        behavior: "smooth",
      });
      editorRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
    setComposerAttachments(
      loadDraftAttachments(draftKey).map((item) => ({
        ...item,
        size: item.size ?? 0,
        id: `receipt:${item.attachmentId}`,
        status: "attached",
      })),
    );
  }, [draftKey]);

  useEffect(() => {
    if (
      !draftKey ||
      submitting ||
      composerAttachments !== composerAttachmentsRef.current
    )
      return;
    saveDraftAttachments(
      draftKey,
      composerAttachments.filter(
        (item) => item.status === "attached" && item.attachmentId,
      ),
    );
  }, [composerAttachments, draftKey, submitting]);

  useEffect(() => {
    if (!draftKey || submitting) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey, submitting]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftKey && !submittingRef.current)
        saveDraft(draftKey, bodyRef.current);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const flushDraft = () => {
      if (!submittingRef.current) saveDraft(draftKey, bodyRef.current);
    };
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [draftKey]);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  useEffect(() => {
    setPendingWorkMode(resolvedIssueWorkMode);
  }, [resolvedIssueWorkMode]);

  useImperativeHandle(
    forwardedRef,
    () => ({
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
    }),
    [],
  );

  const showStop =
    !submitting &&
    !attaching &&
    body.trim().length === 0 &&
    composerAttachments.length === 0 &&
    Boolean(onStop || stopControl.stopping);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const composerHasAssigneePicker =
      enableReassign && reassignOptions.length > 0;
    if (
      composerHasAssigneePicker &&
      isUnassignedReassignValue(reassignTarget)
    ) {
      setNoAssigneeDialogOpen(true);
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const hasReassignment =
      enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment
      ? (parseReassignment(reassignTarget) ?? undefined)
      : undefined;
    const reopen = shouldImplicitlyReopenComment(
      issueStatus,
      hasReassignment ? reassignTarget : currentAssigneeValue,
    )
      ? true
      : undefined;
    const submittedBody = [
      trimmed,
      ...attachedFiles.map(
        (item) =>
          `[${item.name.replace(/[[\]]/g, "\\$&")}](${item.contentPath})`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    const submittedAttachmentKeys = new Set(
      composerAttachments.map((item) => item.id),
    );
    const attachmentIds = [
      ...new Set(
        composerAttachments
          .filter(
            (item) =>
              item.status === "attached" &&
              item.attachmentId &&
              (!item.inline ||
                (item.contentPath && trimmed.includes(item.contentPath))),
          )
          .map((item) => item.attachmentId!),
      ),
    ];
    const viewportSnapshot = captureComposerViewportSnapshot(
      composerContainerRef.current,
    );

    const workModeChanged = pendingWorkMode !== resolvedIssueWorkMode;
    if (draftKey) saveDraft(draftKey, trimmed);
    setSubmitting(true);
    setBody("");
    let attemptId: string | null = null;
    try {
      if (workModeChanged && onWorkModeChange) {
        await onWorkModeChange(pendingWorkMode);
      }
      const retained = draftKey ? loadDraftSubmission(draftKey) : null;
      if (retained) {
        setUncertainSubmission(retained);
        setBody(trimmed);
        return;
      }
      attemptId = crypto.randomUUID();
      if (draftKey) {
        saveDraft(draftKey, trimmed);
        saveDraftSubmission(draftKey, { attemptId, reviewed: false });
      }
      // assistant-ui thread.append is fire-and-forget. Await the actual Board
      // mutation; it already owns optimistic echo and durable error handling.
      const sendPromise = attachmentIds.length
        ? onSend(submittedBody, reopen, reassignment, attachmentIds)
        : onSend(submittedBody, reopen, reassignment);
      queueViewportRestore(viewportSnapshot);
      await sendPromise;
      if (mountedTaskKey.current !== draftKey) return;
      if (draftKey) clearDraftSubmission(draftKey, attemptId);
      if (draftKey) clearDraft(draftKey);
      setComposerAttachments((current) =>
        current.filter((item) => !submittedAttachmentKeys.has(item.id)),
      );
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch (error) {
      if (mountedTaskKey.current !== draftKey) return;
      if (attemptId && error instanceof CommentSubmissionUnknownError) {
        const uncertain = { attemptId, reviewed: false };
        setUncertainSubmission(uncertain);
        if (draftKey && loadDraftSubmission(draftKey)?.attemptId === attemptId)
          saveDraftSubmission(draftKey, uncertain);
      } else if (draftKey && attemptId)
        clearDraftSubmission(draftKey, attemptId);
      const restoredBody = restoreSubmittedCommentDraft({
        currentBody: bodyRef.current,
        submittedBody: trimmed,
      });
      if (draftKey) saveDraft(draftKey, restoredBody, attemptId ?? undefined);
      setBody(restoredBody);
    } finally {
      setSubmitting(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(
    file: File,
    insertInline = true,
  ): Promise<string | undefined> {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = file.type.startsWith("image/");
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
      if (!onAttachImage && onImageUpload && inline) {
        const url = await onImageUpload(file);
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        if (insertInline)
          setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? { ...item, status: "attached", contentPath: url }
              : item,
          ),
        );
        return url;
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        if (!attachment?.contentPath)
          throw new Error(t("localizationTaskRuntime.ui_Upload_did_not_return_a_file_URL_gsrcr4"));
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        if (inline && insertInline) {
          const markdown = `![${file.name.replace(/[[\]]/g, "\\$&")}](${attachment.contentPath})`;
          setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        }
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "attached",
                  attachmentId: attachment.id,
                  contentPath: attachment?.contentPath,
                  name: attachment?.originalFilename ?? item.name,
                }
              : item,
          ),
        );
        return attachment.contentPath;
      } else {
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "error",
                  error: t("localizationTaskRuntime.ui_This_file_type_cannot_be_attached_here_1htxodp"),
                }
              : item,
          ),
        );
      }
    } catch (err) {
      setComposerAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : t("localizationTaskRuntime.ui_Upload_failed_mxel7t"),
              }
            : item,
        ),
      );
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

  const canSubmit =
    !submitting &&
    !uploadUnsettled &&
    !uncertainSubmission &&
    (!!body.trim() || attachedFiles.length > 0);

  // Interrupt-handoff clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<HandoffAgentMention[]>(
    () =>
      mentions
        .filter((m) => (m.kind ?? "agent") === "agent" && (m.agentId ?? m.id))
        .map((m) => ({
          agentId: m.agentId ?? m.id.replace(/^agent:/, ""),
          name: m.name,
        })),
    [i18n.resolvedLanguage, mentions],
  );
  const handoffResolvers = useMemo<HandoffChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) =>
        formatAssigneeUserLabel(userId, null, userLabelMap),
    }),
    [i18n.resolvedLanguage, agentMap, currentUserId, userLabelMap],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [i18n.resolvedLanguage, body]);
  const plainNameCandidate = useMemo(
    () =>
      mentionedAgentIds.length > 0
        ? null
        : findPlainAgentNameCandidate(body, agentMentionOptions),
    [i18n.resolvedLanguage, body, mentionedAgentIds, agentMentionOptions],
  );
  const handoffPreview = useMemo(
    () =>
      computeComposerHandoffPreview({
        reassignTarget,
        currentAssigneeValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [
      i18n.resolvedLanguage, reassignTarget,
      currentAssigneeValue,
      hasActiveRun,
      mentionedAgentIds,
      plainNameCandidate,
    ],
  );
  const coachVisible = Boolean(
    plainNameCandidate &&
    plainNameCandidate.matchedText !== dismissedCoachToken,
  );
  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ??
      plainNameCandidate.matchedText)
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (m) =>
        (m.agentId ?? m.id.replace(/^agent:/, "")) ===
        plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    setBody((current) => {
      if (tokenRe.test(current))
        return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  const workModeOptions = workModeMetaList();
  const pendingWorkModeMeta = workModeMetaFor(pendingWorkMode);
  const PendingWorkModeIcon = pendingWorkModeMeta.icon;

  function handleComposerKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>) {
    // Match the period via both `code` and `key`: iOS Safari with a hardware
    // keyboard often leaves `code` empty for cmd-period, so relying on it alone
    // lets the event fall through and triggers Safari's default cancel/dismiss
    // (which closes the view). Catching `key === "."` keeps the shortcut working
    // on iOS while preserving desktop behavior.
    const isPeriod = evt.code === "Period" || evt.key === ".";
    if (!(evt.metaKey || evt.ctrlKey) || !isPeriod) return;
    evt.preventDefault();
    setPendingWorkMode((current) => nextWorkMode(current));
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      data-pending-work-mode={pendingWorkMode}
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        pendingWorkModeMeta.classes.container,
        isDragOver &&
          "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onKeyDownCapture={handleComposerKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t("localizationTaskRuntime.ui_Drop_to_upload_1ry58ii")}</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("localizationTaskRuntime.ui_Images_insert_into_the_reply_Other_files_are_added_to_this_task_3zeklq")}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {uncertainSubmission ? (
        <div
          role="alert"
          className="mb-3 space-y-2 rounded-md border border-border bg-muted p-3 text-sm"
        >
          <p>{t("localizationTaskExecution.uncertainDraft")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              setReviewError(false);
              try {
                if (!onReviewConversation)
                  throw new Error(t("localizationTaskExecution.reviewUnavailable"));
                await onReviewConversation();
                if (mountedTaskKey.current !== draftKey) return;
                const reviewed = { ...uncertainSubmission, reviewed: true };
                setUncertainSubmission(reviewed);
                if (
                  draftKey &&
                  loadDraftSubmission(draftKey)?.attemptId ===
                    reviewed.attemptId
                )
                  saveDraftSubmission(draftKey, reviewed);
              } catch {
                setReviewError(true);
              }
            }}
          >{t("localizationTaskExecution.reviewConversation")}</Button>
          {reviewError ? (
            <p>{t("localizationTaskExecution.reviewRefreshFailed")}</p>
          ) : null}
          {uncertainSubmission.reviewed ? (
            <>
              <p>{t("localizationTaskExecution.discardHelp")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (draftKey)
                    clearDraft(draftKey, uncertainSubmission.attemptId);
                  bodyRef.current = "";
                  setBody("");
                  setComposerAttachments([]);
                  setUncertainSubmission(null);
                }}
              >{t("localizationTaskExecution.discardDraft")}</Button>
            </>
          ) : null}
        </div>
      ) : null}
      <MarkdownEditor
        ref={editorRef}
        readOnly={!!uncertainSubmission}
        value={body}
        onChange={setBody}
        placeholder={t("localizationTaskRuntime.ui_Reply_1m7jlqf")}
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={
          canAcceptFiles
            ? async (file) => {
                const url = await attachFile(file, false);
                if (!url) throw new Error(t("localizationTaskRuntime.ui_Upload_did_not_return_a_file_URL_gsrcr4"));
                return url;
              }
            : undefined
        }
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() =>
              setDismissedCoachToken(plainNameCandidate.matchedText)
            }
          />
        </div>
      ) : null}

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-(length:--text-micro) text-muted-foreground">
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
                ? t("localizationTaskRuntime.ui_Uploading_to_task_oz74y6")
                : attachment.status === "error"
                  ? (attachment.error ?? t("localizationIssueDetail.ui_Upload_failed"))
                  : attachment.inline
                    ? t("localizationTaskRuntime.ui_Inserted_inline_c4671e")
                    : t("localizationTaskRuntime.ui_Attached_to_task_1lfao4j");
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
                  <span className="shrink-0 text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel}
                </span>
                {!attachment.inline || attachment.status !== "attached" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={!!uncertainSubmission}
                    onClick={() =>
                      setComposerAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {shouldRenderComposerHandoffPreview(body, handoffPreview) ? (
        <div className="my-2">
          <ComposerHandoffPreviewRow
            preview={handoffPreview}
            resolvers={handoffResolvers}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {canAcceptFiles ? (
            <>
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
                title={t("localizationTaskRuntime.ui_Attach_file_9gvepm")}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canToggleWorkMode ? (
            <Popover open={workModeMenuOpen} onOpenChange={setWorkModeMenuOpen}>
              <PopoverTrigger asChild>
                {/* Single persistent mode chip (PAP-95b mockup rev 5): yellow in
                    planning, neutral in standard, caret opens the switch menu. */}
                <button
                  type="button"
                  data-testid="issue-chat-composer-work-mode-toggle"
                  data-pending-work-mode={pendingWorkMode}
                  aria-haspopup="menu"
                  aria-expanded={workModeMenuOpen}
                  aria-pressed={pendingWorkMode !== "standard"}
                  aria-keyshortcuts="Meta+Period Control+Period"
                  title={titleForPendingWorkMode(pendingWorkMode)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(length:--text-micro) font-semibold transition-colors",
                    pendingWorkModeMeta.classes.chip,
                  )}
                >
                  <PendingWorkModeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{pendingWorkModeMeta.label}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-44 p-1"
                align="start"
                data-testid="issue-chat-composer-work-mode-menu"
              >
                {workModeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = option.value === pendingWorkMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`issue-chat-composer-work-mode-menu-${option.value}`}
                      data-pending-work-mode={pendingWorkMode}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                        active && "bg-accent",
                        option.classes.menuItem,
                      )}
                      onClick={() => {
                        setPendingWorkMode(option.value);
                        setWorkModeMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{option.label}</span>
                      {active ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
                <div className="mt-1 border-t px-2 py-1.5 text-(length:--text-nano) text-muted-foreground">
                  {t("localizationTaskRuntime.ui_Cmd_Ctrl_cycles_modes_j5v7qv")}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            ref={reassignTriggerRef}
            value={reassignTarget}
            options={reassignOptions}
            placeholder={t("localizationTaskRuntime.ui_Responsible_1ndhgwz")}
            noneLabel={t("localizationTaskRuntime.ui_No_responsible_ja20kq")}
            searchPlaceholder={t("localizationTaskRuntime.ui_Search_responsible_1izi5bd")}
            emptyMessage={t("pages.routines.noResponsibleFound")}
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option)
                return (
                  <span className="text-muted-foreground">{t("localizationTaskRuntime.ui_Responsible_1ndhgwz")}</span>
                );
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon
                      icon={agent.icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id)
                return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon
                      icon={agent.icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        {showStop ? (
          <Button
            size="icon-sm"
            disabled={stopControl.stopping}
            onClick={() => void stopControl.stop()}
            aria-label={stopControl.stopping ? t("localizationActivityTail.stopping") : t("localizationActivityTail.stop")}
            title={
              stopScope === "subtree"
                ? t("localizationTaskExecution.stopSubtree")
                : t("localizationTaskExecution.stopTask")
            }
          >
            {stopControl.stopping ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Square className="h-4 w-4 fill-current" aria-hidden />
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? t("localizationTaskRuntime.ui_Posting_61smlx") : t("localizationTaskRuntime.ui_Send_1vatbdb")}
          </Button>
        )}
      </div>

      {stopControl.error ? (
        <p role="alert" className="text-xs text-destructive">
          {stopControl.error}
        </p>
      ) : null}

      {/* No-assignee warning modal (PAP-128 C): replaces the old press-Send-again toast. */}
      <AlertDialog
        open={noAssigneeDialogOpen}
        onOpenChange={setNoAssigneeDialogOpen}
      >
        <AlertDialogContent
          data-testid="issue-chat-no-assignee-dialog"
          onCloseAutoFocus={(event) => {
            if (!focusAssigneeOnDialogCloseRef.current) return;
            event.preventDefault();
            focusAssigneeOnDialogCloseRef.current = false;
            reassignTriggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("localizationTaskRuntime.ui_No_responsible_selected_1xq8qiv")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("localizationTaskRuntime.ui_This_comment_will_be_posted_without_an_assignee_so_no_agent_will__1hsa25s")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="issue-chat-no-assignee-go-back"
              onClick={() => {
                focusAssigneeOnDialogCloseRef.current = true;
              }}
            >{t("common.goBack")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="issue-chat-no-assignee-send-anyway"
              onClick={() => {
                void submitComment();
              }}
            >
              {t("localizationTaskRuntime.ui_Send_anyway_15ji5uc")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  issueId = null,
  blockedBy = [],
  liveIssueIds,
  blockerAttention = null,
  successfulRunHandoff = null,
  scheduledRetry = null,
  recoveryAction = null,
  onResolveRecoveryAction,
  onReissueIsolatedRecoveryAction,
  reissueIsolatedRecoveryActionPending = false,
  onReconcileForwardRecoveryAction,
  onBreakGlassOverrideRecoveryAction,
  onQuarantineRestoreRecoveryAction,
  quarantineRestoreRecoveryActionPending = false,
  canBreakGlassRecoveryAction = false,
  reconcileRecoveryActionPending = false,
  canFalsePositiveRecoveryAction = false,
  legacyRecoverySourceIssue = null,
  companyId,
  projectId,
  issueStatus,
  issueAssigneeAgentId = null,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  onVote,
  onAdd,
  onReviewConversation,
  onCancelRun,
  stopPending,
  stopScope,
  onStopRun,
  stopRunLabel,
  stoppingRunLabel,
  stopRunVariant,
  runFinalizationActions,
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
  autoScrollToLatestOnInitialLoad = false,
  autoScrollToHashOnInitialLoad = false,
  emptyMessage,
  footer,
  variant = "full",
  enableLiveTranscriptPolling = true,
  transcriptsByRunId,
  hasOutputForRun: hasOutputForRunOverride,
  includeSucceededRunsWithoutOutput = false,
  onInterruptQueued,
  onCancelQueued,
  onDeleteComment,
  interruptingQueuedRunId = null,
  stoppingRunId = null,
  onImageClick,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onSubmitInteractionVerdicts,
  composerRef,
  composerAccessory,
  issueWorkMode,
  onWorkModeChange,
  onRefreshLatestComments,
  assigneeUserId = null,
  onResumeFromBacklog,
  resumeFromBacklogPending = false,
  onResumeAssignee,
  resumeAssigneePending = false,
  onTryAgainNoLiveExecutionPath: _onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending: _tryAgainNoLiveExecutionPathPending,
  onRetryFailedRun: _onRetryFailedRun,
  retryFailedRunId: _retryFailedRunId,
  externalReferences,
  linkCaseReferences = false,
}: IssueChatThreadProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const didInitialHashScrollDecisionRef = useRef(false);
  const virtualizedThreadRef =
    useRef<VirtualizedIssueChatThreadListHandle | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportSnapshotRef =
    useRef<ReturnType<typeof captureComposerViewportSnapshot>>(null);
  const preserveComposerViewportRef = useRef(false);
  const pendingSubmitScrollRef = useRef(false);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const didInitialLatestScrollRef = useRef(false);
  const spacerBaselineAnchorRef = useRef<string | null>(null);
  const spacerInitialReserveRef = useRef(0);
  const latestSettleTimeoutsRef = useRef<number[]>([]);
  const latestSettleCleanupRef = useRef<(() => void) | null>(null);
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState(0);
  const displayLiveRuns = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns) {
      if (!isLiveIssueRun(run, issueStatus)) continue;
      deduped.set(run.id, run);
    }
    if (activeRun && isLiveIssueRun(activeRun, issueStatus)) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        contextCommentId: activeRun.contextCommentId,
        contextWakeCommentId: activeRun.contextWakeCommentId,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
        issueId: activeRun.issueId,
        livenessState: activeRun.livenessState,
        livenessReason: activeRun.livenessReason,
        continuationAttempt: activeRun.continuationAttempt,
        lastUsefulActionAt: toIsoString(activeRun.lastUsefulActionAt),
        nextAction: activeRun.nextAction,
        outputSilence: activeRun.outputSilence,
        currentStatusMessage: activeRun.currentStatusMessage ?? null,
        currentStatusUpdatedAt: toIsoString(activeRun.currentStatusUpdatedAt),
        currentToolName: activeRun.currentToolName ?? null,
        lastAssistantSnippet: activeRun.lastAssistantSnippet ?? null,
        lastEventAt: toIsoString(activeRun.lastEventAt),
      });
    }
    return [...deduped.values()].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [i18n.resolvedLanguage, activeRun, issueStatus, liveRuns]);
  const transcriptRuns = useMemo(() => {
    return resolveIssueChatTranscriptRuns({
      linkedRuns,
      liveRuns: displayLiveRuns,
      activeRun,
    });
  }, [i18n.resolvedLanguage, activeRun, displayLiveRuns, linkedRuns]);
  const activeRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of displayLiveRuns) {
      if (run.status === "queued" || run.status === "running") {
        ids.add(run.id);
      }
    }
    return ids;
  }, [i18n.resolvedLanguage, displayLiveRuns]);
  const hasActiveRun = useMemo(
    () => displayLiveRuns.some((run) => run.status === "running"),
    [i18n.resolvedLanguage, displayLiveRuns],
  );
  // Real-time view of the handoff: a run that starts after the issue payload
  // was fetched must quiet the missing-disposition warnings without waiting
  // for a refetch to update `hasLiveContinuation`.
  const successfulRunHandoffWithLiveness = useMemo(() => {
    if (!successfulRunHandoff || successfulRunHandoff.hasLiveContinuation) {
      return successfulRunHandoff ?? null;
    }
    const liveNow =
      activeRunIds.size > 0 || Boolean(issueId && liveIssueIds?.has(issueId));
    return liveNow
      ? { ...successfulRunHandoff, hasLiveContinuation: true }
      : successfulRunHandoff;
  }, [i18n.resolvedLanguage, successfulRunHandoff, activeRunIds, issueId, liveIssueIds]);
  const clearLatestSettleTimeouts = useCallback(() => {
    for (const timeout of latestSettleTimeoutsRef.current) {
      window.clearTimeout(timeout);
    }
    latestSettleTimeoutsRef.current = [];
    latestSettleCleanupRef.current?.();
    latestSettleCleanupRef.current = null;
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
        issueStatus,
      }),
    [
      i18n.resolvedLanguage,
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
      issueStatus,
    ],
  );
  const stableMessagesRef = useRef<readonly ThreadMessage[]>([]);
  const stableMessageCacheRef = useRef<
    Map<string, StableThreadMessageCacheEntry>
  >(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      rawMessages,
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [i18n.resolvedLanguage, rawMessages]);
  const latestMessagesRef = useRef<readonly ThreadMessage[]>(messages);
  latestMessagesRef.current = messages;

  const isRunning = displayLiveRuns.some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const unresolvedBlockers = useMemo(
    () =>
      blockedBy.filter(
        (blocker) =>
          blocker.status !== "done" && blocker.status !== "cancelled",
      ),
    [i18n.resolvedLanguage, blockedBy],
  );
  const assignedAgent = useMemo(() => {
    if (!currentAssigneeValue.startsWith("agent:")) return null;
    const assigneeAgentId = currentAssigneeValue.slice("agent:".length);
    return agentMap?.get(assigneeAgentId) ?? null;
  }, [i18n.resolvedLanguage, agentMap, currentAssigneeValue]);
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [i18n.resolvedLanguage, feedbackVotes]);
  const useVirtualizedThread =
    messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
  const messageAnchorIndex = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => {
      const anchorId = issueChatMessageAnchorId(message);
      if (anchorId) map.set(anchorId, index);
    });
    return map;
  }, [i18n.resolvedLanguage, messages]);

  function scrollToThreadAnchor(
    anchorId: string,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
    messageSnapshot: readonly ThreadMessage[] = messages,
  ) {
    const snapshotUsesVirtualizer =
      messageSnapshot.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
    const virtualIndex =
      messageSnapshot === messages
        ? messageAnchorIndex.get(anchorId)
        : findMessageAnchorIndex(messageSnapshot, anchorId);
    if (
      snapshotUsesVirtualizer &&
      virtualIndex !== undefined &&
      virtualIndex >= 0
    ) {
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
      block:
        options?.align === "start"
          ? "start"
          : options?.align === "end"
            ? "end"
            : "center",
    });
    return true;
  }

  const sendComposerComment = useCallback<IssueChatThreadProps["onAdd"]>(
    (body, reopen, reassignment, attachmentIds) => {
      pendingSubmitScrollRef.current = true;
      return attachmentIds?.length
        ? onAdd(body, reopen, reassignment, attachmentIds)
        : onAdd(body, reopen, reassignment);
    },
    [onAdd],
  );
  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, reopen, reassignment, attachmentIds }) =>
      sendComposerComment(body, reopen, reassignment, attachmentIds),
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastUserId = lastUserMessage?.id ?? null;

    if (
      pendingSubmitScrollRef.current &&
      lastUserId &&
      lastUserId !== lastUserMessageIdRef.current
    ) {
      pendingSubmitScrollRef.current = false;
      const custom = lastUserMessage?.metadata.custom as
        { anchorId?: unknown } | undefined;
      const anchorId =
        typeof custom?.anchorId === "string" ? custom.anchorId : null;
      if (anchorId) {
        const reserve = Math.round(
          window.innerHeight * SUBMIT_SCROLL_RESERVE_VH,
        );
        spacerBaselineAnchorRef.current = anchorId;
        spacerInitialReserveRef.current = reserve;
        setBottomSpacerHeight(reserve);
        requestAnimationFrame(() => {
          scrollToThreadAnchor(anchorId, {
            align: "start",
            behavior: "smooth",
          });
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
      bottomEl.getBoundingClientRect().top -
        userEl.getBoundingClientRect().bottom,
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

    composerViewportSnapshotRef.current =
      captureComposerViewportSnapshot(composerElement);
    preserveComposerViewportRef.current =
      shouldPreserveComposerViewport(composerElement);
  }, [messages]);

  useEffect(() => {
    const hash =
      location.hash ||
      (typeof window !== "undefined" ? window.location.hash : "");
    const isThreadHash =
      hash.startsWith("#comment-") ||
      hash.startsWith("#activity-") ||
      hash.startsWith("#run-") ||
      hash.startsWith("#interaction-");
    if (messages.length === 0) return;
    if (!isThreadHash) {
      if (!didInitialHashScrollDecisionRef.current) {
        didInitialHashScrollDecisionRef.current = true;
      }
      return;
    }
    if (lastScrolledHashRef.current === hash) return;
    const targetId = hash.slice(1);
    if (targetId.startsWith("comment-")) {
      const targetMessage = messages.find(
        (message) => issueChatMessageAnchorId(message) === targetId,
      );
      if (targetMessage && issueChatMessageIsDeleted(targetMessage)) {
        didInitialHashScrollDecisionRef.current = true;
        lastScrolledHashRef.current = hash;
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `${location.pathname}${location.search}`,
          );
        }
        return;
      }
    }
    if (!didInitialHashScrollDecisionRef.current) {
      didInitialHashScrollDecisionRef.current = true;
      if (!autoScrollToHashOnInitialLoad) {
        lastScrolledHashRef.current = hash;
        return;
      }
    }
    let cancelled = false;
    const attemptScroll = (finalAttempt = false) => {
      if (cancelled || lastScrolledHashRef.current === hash) return;
      const didScroll = scrollToThreadAnchor(targetId, {
        align: "center",
        behavior: "smooth",
      });
      if (!didScroll) return;
      if (
        finalAttempt ||
        !useVirtualizedThread ||
        document.getElementById(targetId)
      ) {
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
  }, [
    autoScrollToHashOnInitialLoad,
    location.hash,
    messageAnchorIndex,
    messages,
    useVirtualizedThread,
  ]);

  // Optional legacy behavior: callers may explicitly request landing on the
  // latest comment. The shared default stays off so ordinary page loads keep
  // the user's initial viewport stable.
  useEffect(() => {
    if (didInitialLatestScrollRef.current) return;
    if (!autoScrollToLatestOnInitialLoad) return;
    if (variant !== "full") return;
    if (messages.length === 0) return;
    const hash =
      location.hash ||
      (typeof window !== "undefined" ? window.location.hash : "");
    if (
      hash.startsWith("#comment-") ||
      hash.startsWith("#activity-") ||
      hash.startsWith("#run-") ||
      hash.startsWith("#interaction-")
    ) {
      didInitialLatestScrollRef.current = true;
      return;
    }
    didInitialLatestScrollRef.current = true;
    // Defer a frame so the virtualizer/DOM has mounted its initial rows before
    // we resolve and scroll to the latest comment's anchor.
    const frame = requestAnimationFrame(() =>
      scrollToLatestCommentWithSettle(latestMessagesRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoScrollToLatestOnInitialLoad, messages, variant, location.hash]);

  function jumpToLatestFallback() {
    if (useVirtualizedThread) {
      virtualizedThreadRef.current?.scrollToLatest({ behavior: "smooth" });
      return;
    }
    bottomAnchorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }

  // Lands on the latest `comment-*` row and then drives the scroll the rest
  // of the way home as the virtualizer's per-row measurements arrive.
  //
  // The virtualizer estimates 220px for unmeasured rows. On long threads
  // with tall markdown comments (PAP-2536 et al.), totalSize is hugely
  // underestimated until rows render and get measured. A single scroll
  // lands above the actual bottom; rendered rows then expand, the layout
  // grows, and the user has to keep clicking Jump-to-latest to walk closer
  // to the real bottom. The convergence loop below issues `scrollIntoView`
  // on the latest comment element on every tick until the DOM bottom of
  // that element is at the scroll container's bottom (or scroll position
  // and content height stop changing).
  function scrollToLatestCommentWithSettle(
    messageSnapshot: readonly ThreadMessage[] = latestMessagesRef.current,
  ) {
    const latestCommentIndex = findLatestCommentMessageIndex(messageSnapshot);
    if (latestCommentIndex < 0) {
      jumpToLatestFallback();
      return;
    }
    const latestCommentAnchor = issueChatMessageAnchorId(
      messageSnapshot[latestCommentIndex],
    );
    if (!latestCommentAnchor) {
      jumpToLatestFallback();
      return;
    }

    const initial = scrollToThreadAnchor(
      latestCommentAnchor,
      { align: "end", behavior: "smooth" },
      messageSnapshot,
    );
    if (!initial) {
      jumpToLatestFallback();
      return;
    }

    if (typeof window === "undefined") return;

    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const MAX_DURATION_MS = 4000;
    const TICK_MS = 80;
    const TOLERANCE_PX = 4;

    clearLatestSettleTimeouts();
    const resolveScrollContainer = (): HTMLElement | null =>
      document.getElementById("main-content") as HTMLElement | null;
    const cancelTarget = resolveScrollContainer() ?? window;

    let lastScrollTop = -1;
    let lastScrollHeight = -1;
    let stableTicks = 0;
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
    };

    const cleanup = () => {
      cancelTarget.removeEventListener("wheel", cancel);
      cancelTarget.removeEventListener("touchstart", cancel);
    };

    cancelTarget.addEventListener("wheel", cancel, {
      once: true,
      passive: true,
    });
    cancelTarget.addEventListener("touchstart", cancel, {
      once: true,
      passive: true,
    });
    latestSettleCleanupRef.current = cleanup;

    const finish = () => {
      cleanup();
      latestSettleCleanupRef.current = null;
      for (const timeout of latestSettleTimeoutsRef.current) {
        window.clearTimeout(timeout);
      }
      latestSettleTimeoutsRef.current = [];
    };

    const scheduleTick = (delay: number) => {
      const timeout = window.setTimeout(() => {
        latestSettleTimeoutsRef.current =
          latestSettleTimeoutsRef.current.filter((entry) => entry !== timeout);
        tick();
      }, delay);
      latestSettleTimeoutsRef.current.push(timeout);
    };

    const tick = () => {
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (cancelled || now - startedAt > MAX_DURATION_MS) {
        finish();
        return;
      }

      if (typeof document === "undefined") {
        finish();
        return;
      }

      const el = document.getElementById(latestCommentAnchor);
      if (!el) {
        // Row hasn't been rendered into the virtualizer's buffer yet — nudge
        // the offset (instant) so it gets mounted, then keep settling.
        virtualizedThreadRef.current?.scrollToIndex(latestCommentIndex, {
          align: "end",
          behavior: "auto",
        });
        scheduleTick(TICK_MS);
        return;
      }

      const container = resolveScrollContainer();
      const containerBottom = container
        ? container.getBoundingClientRect().bottom
        : window.innerHeight;
      const elBottom = el.getBoundingClientRect().bottom;
      const offBottom = elBottom - containerBottom;

      if (Math.abs(offBottom) > TOLERANCE_PX) {
        el.scrollIntoView({ behavior: "smooth", block: "end" });
      }

      const currentScrollTop = container?.scrollTop ?? window.scrollY;
      const currentScrollHeight =
        container?.scrollHeight ?? document.documentElement.scrollHeight;
      const scrollStable = Math.abs(currentScrollTop - lastScrollTop) < 1;
      const heightStable = currentScrollHeight === lastScrollHeight;
      const atBottom = Math.abs(offBottom) <= TOLERANCE_PX;
      if (scrollStable && heightStable && atBottom) {
        stableTicks += 1;
        if (stableTicks >= 3) {
          finish();
          return;
        }
      } else {
        stableTicks = 0;
      }
      lastScrollTop = currentScrollTop;
      lastScrollHeight = currentScrollHeight;
      scheduleTick(TICK_MS);
    };

    // Hold the first iteration off for one frame so the initial smooth
    // scroll has begun (and the virtualizer has rendered the buffer around
    // the target) before we start settling.
    scheduleTick(120);
  }

  function handleJumpToLatest() {
    if (onRefreshLatestComments) {
      // Refetching the comments query (page 0 first) brings any comment that
      // arrived after the initial load — including ones live updates may
      // have missed during reconnects — into the loaded set before we
      // resolve the latest target. Otherwise we'd land on the latest
      // *loaded* comment but not the absolute newest. (PAP-2672 follow-up.)
      const refreshed = onRefreshLatestComments();
      if (
        refreshed &&
        typeof (refreshed as Promise<unknown>).then === "function"
      ) {
        (refreshed as Promise<unknown>).then(
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
        );
        return;
      }
    }
    scrollToLatestCommentWithSettle(latestMessagesRef.current);
  }

  const stableOnVote = useStableEvent(onVote);
  const stableOnStopRun = useStableEvent(onStopRun);
  const stableOnInterruptQueued = useStableEvent(onInterruptQueued);
  const stableOnCancelQueued = useStableEvent(onCancelQueued);
  const stableOnDeleteComment = useStableEvent(onDeleteComment);
  const stableOnImageClick = useStableEvent(onImageClick);
  const stableOnAcceptInteraction = useStableEvent(onAcceptInteraction);
  const stableOnRejectInteraction = useStableEvent(onRejectInteraction);
  const stableOnSubmitInteractionAnswers = useStableEvent(
    onSubmitInteractionAnswers,
  );
  const stableOnCancelInteraction = useStableEvent(onCancelInteraction);
  const stableOnSubmitInteractionVerdicts = useStableEvent(
    onSubmitInteractionVerdicts,
  );
  const stableOnUploadImage = useStableEvent(imageUploadHandler);

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
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      onInterruptQueued: stableOnInterruptQueued,
      onCancelQueued: stableOnCancelQueued,
      onDeleteComment: stableOnDeleteComment,
      onImageClick: stableOnImageClick,
      onAcceptInteraction: stableOnAcceptInteraction,
      onRejectInteraction: stableOnRejectInteraction,
      onSubmitInteractionAnswers: stableOnSubmitInteractionAnswers,
      onCancelInteraction: stableOnCancelInteraction,
      onSubmitInteractionVerdicts: stableOnSubmitInteractionVerdicts,
      onUploadImage: stableOnUploadImage,
      issueStatus,
      issueAssigneeAgentId,
      successfulRunHandoff: successfulRunHandoffWithLiveness,
      externalReferences,
      linkCaseReferences,
    }),
    [
      i18n.resolvedLanguage,
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      stableOnVote,
      stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      stableOnInterruptQueued,
      stableOnCancelQueued,
      stableOnDeleteComment,
      stableOnImageClick,
      stableOnAcceptInteraction,
      stableOnRejectInteraction,
      stableOnSubmitInteractionAnswers,
      stableOnCancelInteraction,
      stableOnSubmitInteractionVerdicts,
      stableOnUploadImage,
      issueStatus,
      issueAssigneeAgentId,
      successfulRunHandoffWithLiveness,
      externalReferences,
      linkCaseReferences,
    ],
  );

  const resolvedShowJumpToLatest = showJumpToLatest ?? variant === "full";
  const resolvedEmptyMessage =
    emptyMessage ??
    (variant === "embedded"
      ? t("localizationTaskRuntime.ui_No_run_output_yet_2yw4og")
      : t("localizationTaskRuntime.ui_This_task_conversation_is_empty_Start_with_a_message_below_l5j6pd"));
  const previousErrorBoundaryMessagesRef = useRef<
    readonly ThreadMessage[] | null
  >(null);
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
              {t("localizationTaskRuntime.ui_Jump_to_latest_vvelvx")}
            </button>
            </div>
          ) : null}

          <IssueChatErrorBoundary
            resetKey={errorBoundaryResetKey}
            messages={messages}
            emptyMessage={resolvedEmptyMessage}
            variant={variant}
            externalReferences={externalReferences}
          >
            <div data-testid="thread-root">
              <div
                data-testid="thread-viewport"
                className={variant === "embedded" ? "space-y-3" : "space-y-4"}
              >
                {messages.length === 0 ? (
                  <Card
                    className={cn(
                      "block shadow-none text-center text-sm text-muted-foreground",
                      variant === "embedded"
                        ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
                        : "border-dashed px-6 py-10",
                    )}
                  >
                    {resolvedEmptyMessage}
                  </Card>
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
                  <div
                    data-testid="issue-chat-thread-notices"
                    className="space-y-2"
                  >
                    <IssueAssignedBacklogNotice
                      issueStatus={issueStatus ?? ""}
                      assigneeAgent={assignedAgent}
                      assigneeUserId={assigneeUserId}
                      onResume={onResumeFromBacklog}
                      resuming={resumeFromBacklogPending}
                    />
                    {recoveryAction ? (
                      <IssueRecoveryActionCard
                        action={recoveryAction}
                        agentMap={agentMap}
                        scheduledRetry={scheduledRetry}
                        onResolve={onResolveRecoveryAction}
                        onReissueIsolated={onReissueIsolatedRecoveryAction}
                        reissuePending={reissueIsolatedRecoveryActionPending}
                        onReconcileForward={onReconcileForwardRecoveryAction}
                        onBreakGlassOverride={
                          onBreakGlassOverrideRecoveryAction
                        }
                        onQuarantineRestore={onQuarantineRestoreRecoveryAction}
                        quarantineRestorePending={
                          quarantineRestoreRecoveryActionPending
                        }
                        canBreakGlass={canBreakGlassRecoveryAction}
                        reconcilePending={reconcileRecoveryActionPending}
                        canFalsePositive={canFalsePositiveRecoveryAction}
                      />
                    ) : null}
                    {legacyRecoverySourceIssue ? (
                      <SystemNotice
                        tone="info"
                        label={t("localizationTaskRuntime.ui_Legacy_recovery_task_km5a86")}
                      body={
                        <span>
                          {legacyRecoverySourceIssue.identifier ? (
                            <Trans i18nKey="localizationTaskRuntime.legacyRecoverySourceLinked"
                              values={{ identifier: legacyRecoverySourceIssue.identifier, title: legacyRecoverySourceIssue.title ? ` — ${legacyRecoverySourceIssue.title}` : "" }}
                              components={{ sourceLink: <Link to={legacyRecoverySourceIssue.href} className="underline-offset-2 hover:underline" /> }}
                            />
                          ) : t("localizationTaskRuntime.legacyRecoverySourcePlain"
                            )}
                          </span>
                        }
                      />
                    ) : null}
                    <IssueBlockedNotice
                      issueId={issueId}
                      issueStatus={issueStatus}
                      blockers={unresolvedBlockers}
                      allBlockers={blockedBy}
                      liveIssueIds={liveIssueIds}
                      blockerAttention={blockerAttention}
                      successfulRunHandoff={
                        recoveryAction ? null : successfulRunHandoffWithLiveness
                      }
                      scheduledRetry={scheduledRetry}
                      agentName={
                        successfulRunHandoff?.assigneeAgentId
                          ? (agentMap?.get(successfulRunHandoff.assigneeAgentId)
                              ?.name ?? null)
                          : null
                      }
                    />
                    <IssueAssigneePausedNotice
                      agent={assignedAgent}
                      onResume={onResumeAssignee}
                      resuming={resumeAssigneePending}
                    />
                  </div>
                ) : (
                  // Read-only viewers still need to see why nothing is running.
                  <div
                    data-testid="issue-chat-thread-notices"
                    className="space-y-2"
                  >
                    <IssueAssigneePausedNotice
                      agent={assignedAgent}
                      onResume={onResumeAssignee}
                      resuming={resumeAssigneePending}
                    />
                  </div>
                )}
                {footer ? (
                  <div data-testid="issue-chat-thread-footer">{footer}</div>
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

          {showComposer && composerAccessory ? (
            <div data-testid="issue-chat-composer-accessory" className="mb-2">
              {composerAccessory}
            </div>
          ) : null}

          {showComposer ? (
            <div
              ref={composerViewportAnchorRef}
              data-testid="issue-chat-composer-dock"
              className="sticky bottom-(--sz-calc-8) z-20 space-y-2 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6"
            >
              <IssueChatComposer
                ref={composerRef}
                onSend={sendComposerComment}
                onReviewConversation={onReviewConversation}
                onImageUpload={imageUploadHandler}
                onAttachImage={onAttachImage}
                draftKey={draftKey}
                enableReassign={enableReassign}
                reassignOptions={reassignOptions}
                currentAssigneeValue={currentAssigneeValue}
                suggestedAssigneeValue={suggestedAssigneeValue}
                mentions={mentions}
                agentMap={agentMap}
                hasActiveRun={!!hasActiveRun}
                onStop={hasActiveRun ? onCancelRun : undefined}
                stopPending={stopPending}
                stopScope={stopScope}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                composerDisabledReason={composerDisabledReason}
                composerHint={composerHint}
                issueStatus={issueStatus}
                issueWorkMode={issueWorkMode}
                onWorkModeChange={onWorkModeChange}
              />
            </div>
          ) : null}
        </div>
      </IssueChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}
