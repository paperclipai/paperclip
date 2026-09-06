import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  IssueAssigneePausedNotice,
  IssueChatThread,
} from "@/components/IssueChatThread";
import {
  useLiveRunTranscripts,
  type RunTranscriptSource,
} from "@/components/transcript/useLiveRunTranscripts";
import { useNativeRunTranscripts } from "@/components/transcript/useNativeRunTranscripts";
import { TaskChatLiveTail } from "@/components/task-chat/TaskChatLiveTail";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import {
  TaskChatTurnStatusIsland,
  taskChatTurnStatusModel,
} from "@/components/task-chat/TaskChatTurnStatusIsland";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import {
  assembleThreadItems,
  attachSettledTurns,
  buildTurnSummary,
  coalesceSettledTurns,
  isTerminalRunStatus,
  embedPlanDocumentAtWriteBoundary,
  omitProgressRepeatedByResponseAcrossSegments,
  paperclipRunnerFinalResponse,
  paperclipRunnerTimelineItems,
  prependIssueBrief,
  settledRunChildren,
  splitTranscriptAtAnchors,
  transcriptToTaskChatItems,
  type SettledTurnMergeMeta,
} from "@/components/task-chat/transcript-adapter";
import { TaskChatDescriptionBubble } from "@/components/task-chat/TaskChatDescriptionBubble";
import {
  TaskChatLiveRunPill,
  toolCountSummaryFromEntries,
} from "@/components/task-chat/TaskChatLiveRunPill";
import type {
  TaskChatInteractionItem,
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatPlanDocumentItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
  TaskChatTurnItem,
} from "@/components/task-chat/task-chat-model";
import {
  latestPendingRuntimeRequest,
  runtimeRequestReplacesComposerSkip,
} from "@/components/task-chat/task-chat-model";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import {
  interactionThreadAnchorMs,
  isSuppressedThreadInteraction,
} from "@/components/task-chat/interaction-thread-order";
import {
  interactionReplacesComposerSkip,
  shouldHideInteractionCard,
} from "@/lib/issue-thread-interactions";
import { TaskChatBubbleActions } from "@/components/task-chat/TaskChatBubbleActions";
import type {
  FeedbackVoteValue,
  IssueDocument,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import {
  TaskChatThreadView,
  taskChatContentKey,
} from "@/components/task-chat/TaskChatThreadView";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatQueuedMessages } from "@/components/task-chat/TaskChatQueuedMessages";
import { useWindowAutoFollow } from "@/components/task-chat/useWindowAutoFollow";
import { useSidebar } from "@/context/SidebarContext";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { latestSameRunHandoffTimestamp } from "@/lib/issue-chat-messages";
import { isLiveIssueRun, isTerminalIssueStatus } from "@/lib/liveIssueIds";
import {
  resolveTaskChatBlockers,
  resolveTaskChatLiveWork,
  TaskChatBlockerLinks,
  TaskChatLiveWorkLinks,
} from "@/components/task-chat/TaskChatBlockerLinks";
import { buildDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import {
  documentDisplayTitle,
  selectAgentArtifactAttachments,
  workProductHref,
} from "@/lib/issue-artifacts";
import { heartbeatsApi, type RuntimeRequestResolution } from "@/api/heartbeats";
import { TaskChatPresentationProvider } from "@/components/task-chat/presentation-mode";

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function normalizedMessageText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function safeResourceHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function formatResourceBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function interactionTargetsPlanRevision(
  interaction: IssueThreadInteraction,
  planDocument: IssueDocument,
): boolean {
  if (interaction.kind !== "request_confirmation") return false;
  const target = interaction.payload.target;
  if (target?.type !== "issue_document" || target.key !== "plan") return false;
  if (target.issueId && target.issueId !== planDocument.issueId) return false;
  if (planDocument.latestRevisionId) {
    return target.revisionId === planDocument.latestRevisionId;
  }
  return target.revisionNumber === planDocument.latestRevisionNumber;
}

function isResolvedPlanConfirmation(interaction: IssueThreadInteraction) {
  return (
    interaction.kind === "request_confirmation" &&
    (interaction.status === "accepted" || interaction.status === "rejected") &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan"
  );
}

// A runner-authored plan review is only the lifecycle receipt. Its full plan
// preview already belongs to the source turn's write_document boundary, so
// resolving or expiring the review must not insert a second large block there.
function runnerTurnOwnsPlanPreview(
  interaction: IssueThreadInteraction,
  renderedRunIds: ReadonlySet<string>,
  tailRunId: string | null,
): boolean {
  if (!interaction.sourceRunId || interaction.kind !== "request_confirmation")
    return false;
  const target = interaction.payload.target;
  return (
    target?.type === "issue_document" &&
    target.key === "plan" &&
    (renderedRunIds.has(interaction.sourceRunId) ||
      tailRunId === interaction.sourceRunId)
  );
}

function threadOwnsPlanPreview(
  interaction: IssueThreadInteraction,
  planDocument: IssueDocument | null | undefined,
  planDocumentSourceRunId: string | null,
  renderedRunIds: ReadonlySet<string>,
  tailRunId: string | null,
): boolean {
  if (
    !planDocument ||
    !interactionTargetsPlanRevision(interaction, planDocument)
  )
    return false;
  // Plans without a native-run owner are canonical chronological thread
  // entries. In particular, legacy adapters write them through shell/API
  // tools rather than a semantic write_document boundary, so the pending
  // confirmation must not replace that durable timeline position.
  if (!planDocumentSourceRunId) return true;
  return runnerTurnOwnsPlanPreview(interaction, renderedRunIds, tailRunId);
}

function isRunnerResponseComment(params: {
  comment: TaskChatThreadProps["comments"][number];
  runId: string;
  runStartedAtMs: number | null;
  finalText: string | null;
}): boolean {
  const { comment, runId, runStartedAtMs, finalText } = params;
  if (comment.deletedAt || comment.authorType === "user") return false;
  if (comment.runId === runId) return true;
  if (comment.runId || !finalText) return false;
  const commentAtMs = toMs(comment.createdAt);
  if (runStartedAtMs != null && commentAtMs < runStartedAtMs - 5_000)
    return false;
  return (
    normalizedMessageText(comment.body) === normalizedMessageText(finalText)
  );
}

// PAP-462 B4: backstop for how long the just-settled run's transcript stays
// mounted when neither a settled turn nor a reply comment ever arrives to hand
// off to (e.g. a stopped run with no tool activity). Normal completions hand off
// well within this as soon as the settled turn/comment lands.
const SETTLING_TAIL_MAX_MS = 15_000;
const EMPTY_LIVE_ISSUE_IDS: ReadonlySet<string> = new Set<string>();
const LONG_THREAD_BLOCKER_REPEAT_COUNT = 4;

export function shouldRepeatTaskChatBlockers(items: TaskChatItem[]): boolean {
  const conversationItems = items.filter(
    (item) =>
      item.kind === "brief" ||
      item.kind === "interaction" ||
      (item.kind === "message" && !item.interstitial),
  );
  return conversationItems.length >= LONG_THREAD_BLOCKER_REPEAT_COUNT;
}

function isNativePaperclipRunnerRun(
  run:
    | {
        adapterType?: string | null;
        runtimeMode?: string | null;
      }
    | null
    | undefined,
): boolean {
  return (
    run?.runtimeMode === "native" && run.adapterType === "paperclip_runner"
  );
}
const LEGACY_WITHHELD_RUN_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

function acceptedSemanticResult(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resultJson = value as Record<string, unknown>;
  const semanticResult = resultJson.semanticResult;
  const candidates = [
    resultJson.nativeResult,
    resultJson.acceptedResult,
    semanticResult &&
    typeof semanticResult === "object" &&
    !Array.isArray(semanticResult)
      ? (semanticResult as Record<string, unknown>).result
      : null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const result = candidate as Record<string, unknown>;
    if (result.schema !== "paperclip.run_result.v1") continue;
    return result;
  }
  return null;
}

function acceptedSemanticResultSummary(value: unknown): string | null {
  const result = acceptedSemanticResult(value);
  return typeof result?.summary === "string" && result.summary.trim()
    ? result.summary
    : null;
}

function acceptedSemanticResultDisposition(value: unknown): string | null {
  const result = acceptedSemanticResult(value);
  return typeof result?.reportedWorkDisposition === "string"
    ? result.reportedWorkDisposition
    : null;
}

function presentationDecisionCommentId(
  value: unknown,
): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const decision = (value as Record<string, unknown>).presentationDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision))
    return undefined;
  const record = decision as Record<string, unknown>;
  if (record.schema !== "paperclip.run_presentation_decision.v1")
    return undefined;
  return typeof record.commentId === "string" && record.commentId.trim()
    ? record.commentId
    : null;
}

function semanticProgressCommentIds(value: unknown): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new Set();
  const receipts = (value as Record<string, unknown>).semanticToolReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts))
    return new Set();
  const ids = new Set<string>();
  for (const receipt of Object.values(receipts)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      continue;
    const record = receipt as Record<string, unknown>;
    if (record.operationId !== "report_progress") continue;
    const result = record.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      continue;
    const commentId = (result as Record<string, unknown>).commentId;
    if (typeof commentId === "string" && commentId) ids.add(commentId);
  }
  return ids;
}

function acceptedSemanticResultVerificationCaveats(value: unknown) {
  const runResult =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const finalizedCaveats = Array.isArray(runResult.verificationCaveats)
    ? runResult.verificationCaveats
    : [];
  if (finalizedCaveats.length > 0) {
    return finalizedCaveats.flatMap((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        return [];
      const caveat = candidate as Record<string, unknown>;
      if (typeof caveat.commandOrCheck !== "string") return [];
      return [
        {
          commandOrCheck: caveat.commandOrCheck,
          reasonCode:
            typeof caveat.reasonCode === "string" ? caveat.reasonCode : null,
          detail: typeof caveat.detail === "string" ? caveat.detail : null,
        },
      ];
    });
  }
  const result = acceptedSemanticResult(value);
  const verification = Array.isArray(result?.verification)
    ? result.verification
    : [];
  return verification.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return [];
    const check = candidate as Record<string, unknown>;
    if (check.status !== "not_run" || typeof check.commandOrCheck !== "string")
      return [];
    return [
      {
        commandOrCheck: check.commandOrCheck,
        reasonCode:
          typeof check.reasonCode === "string" ? check.reasonCode : null,
        detail: typeof check.detail === "string" ? check.detail : null,
      },
    ];
  });
}

function resolvedWithoutUserFacingResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = (value as Record<string, unknown>).presentationDecision;
  return Boolean(
    decision &&
    typeof decision === "object" &&
    !Array.isArray(decision) &&
    (decision as Record<string, unknown>).schema ===
      "paperclip.run_presentation_decision.v1" &&
    (decision as Record<string, unknown>).chosenSource === "none",
  );
}

export type TaskChatThreadProps = ComponentProps<typeof IssueChatThread>;

type PendingComposerInput =
  | {
      key: string;
      kind: "runtime";
      item: TaskChatRuntimeRequestItem;
      label: string;
    }
  | {
      key: string;
      kind: "durable";
      interaction: TaskChatInteractionItem["interaction"];
      label: string;
    };

function durableInputLabel(
  interaction: TaskChatInteractionItem["interaction"],
): string {
  if (interaction.kind === "ask_user_questions")
    return interaction.title ?? "Questions";
  if (interaction.kind === "suggest_tasks")
    return interaction.title ?? "Suggested tasks";
  if (interaction.kind === "request_checkbox_confirmation")
    return interaction.title ?? "Choose options";
  if (interaction.kind === "request_item_verdicts")
    return interaction.title ?? "Review items";
  if (interaction.kind === "connection_intent")
    return interaction.title ?? "Connect service";
  if (
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan"
  ) {
    return interaction.title ?? "Review plan";
  }
  if (interaction.payload.toolAction)
    return interaction.title ?? "Approve tool action";
  if (interaction.payload.secretProposal)
    return interaction.title ?? "Review secret proposal";
  return interaction.title ?? "Confirmation";
}

/**
 * Chat-style task thread — the default task detail experience.
 *
 * Renders the Claude-Code-style thread for the live task. It shares
 * IssueChatThread's exact prop type — so the IssueDetail seam ternary
 * (`classic ? IssueChatThread : TaskChatThread`, flag:
 * `enableClassicTaskInterface`) type-checks with no casts.
 *
 * Two data sources feed the render layer, both reused from the existing thread:
 *   - the comment stream (incl. optimistic echoes) → author-typed bubbles, and
 *   - the live run transcript (useLiveRunTranscripts, the same poll+websocket
 *     source the current thread uses) → clean TaskChatLiveTail rows (tool cards,
 *     diffs, streamed reply markdown) while in flight, via the same
 *     transcriptToTaskChatItems converter the settled turns use (PAP-463).
 *
 * Once a run terminates, its settled turn anchors after the run's
 * last comment (comment.runId linkage) and — when it directly follows that
 * reply bubble — attaches to it: the "✓ Worked · …" summary renders appended
 * to the bubble's always-visible timestamp line (round 9), still expandable
 * to the tool history. Turns without a reply bubble keep the standalone
 * folded row. flag-OFF remains byte-for-byte IssueChatThread.
 */
export function TaskChatThread(props: TaskChatThreadProps) {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const {
    comments,
    interactions,
    documents = [],
    workProducts = [],
    attachments = [],
    timelineEvents,
    issueId = null,
    agentMap,
    userLabelMap,
    userProfileMap,
    currentUserId,
    onAdd,
    issueWorkMode = "standard",
    onWorkModeChange,
    composerAccessory,
    footer,
    showComposer = true,
    composerDisabledReason,
    emptyMessage = "No messages yet.",
    companyId,
    linkedRuns,
    liveRuns,
    activeRun,
    onAttachImage,
    imageUploadHandler,
    mentions,
    enableReassign,
    reassignOptions,
    currentAssigneeValue,
    issueStatus,
    issueAssigneeAgentId = null,
    onAcceptInteraction,
    onRejectInteraction,
    onSubmitInteractionAnswers,
    onCancelInteraction,
    onSkipInteraction,
    onSubmitInteractionVerdicts,
    externalReferences,
    threadHeader,
    issueBrief,
    feedbackVotes,
    feedbackDataSharingPreference = "prompt",
    feedbackTermsUrl = null,
    onVote,
    draftKey,
    onInterruptQueued,
    onCancelQueued,
    interruptingQueuedRunId,
    onTryAgainNoLiveExecutionPath,
    tryAgainNoLiveExecutionPathPending = false,
    onRetryFailedRun,
    retryFailedRunId = null,
    queuedCommentQueue,
    onEditQueuedComment,
    onReorderQueuedComments,
    onSteerQueuedComment,
    onDiscardQueuedComment,
    blockedBy = [],
    blockerAttention,
    liveIssueIds,
    onResumeAssignee,
    resumeAssigneePending = false,
  } = props;

  const queuedMessageQueue =
    queuedCommentQueue && queuedCommentQueue.entries.length > 0
      ? queuedCommentQueue
      : null;
  const queuedCommentIds = useMemo(
    () =>
      new Set(
        queuedMessageQueue?.entries.map((entry) => entry.comment.id) ?? [],
      ),
    [queuedMessageQueue],
  );
  const [queuedEdit, setQueuedEdit] = useState<{
    commentId: string;
    body: string;
    revision: string;
    stale?: boolean;
  } | null>(null);

  const beginQueuedEdit = useCallback(
    (commentId: string) => {
      const entry = queuedMessageQueue?.entries.find(
        (candidate) => candidate.comment.id === commentId,
      );
      if (!entry?.canEdit || !queuedMessageQueue) return;
      setQueuedEdit({
        commentId,
        body: entry.comment.body,
        revision: queuedMessageQueue.revision,
      });
    },
    [queuedMessageQueue],
  );

  const saveQueuedEdit = useCallback(
    async (commentId: string, body: string) => {
      if (!queuedEdit || queuedEdit.commentId !== commentId) {
        throw new Error("This queued message is no longer editable.");
      }
      if (queuedEdit.stale) {
        await onAdd(body);
        return;
      }
      if (!onEditQueuedComment)
        throw new Error("This queued message is no longer editable.");
      try {
        await onEditQueuedComment(commentId, body, queuedEdit.revision);
      } catch (error) {
        const payload =
          typeof error === "object" && error !== null
            ? (error as { status?: unknown; body?: unknown; message?: unknown })
            : null;
        const responseBody =
          typeof payload?.body === "object" && payload.body !== null
            ? (payload.body as { code?: unknown; details?: unknown })
            : null;
        const details =
          typeof responseBody?.details === "object" &&
          responseBody.details !== null
            ? (responseBody.details as { code?: unknown })
            : null;
        const code =
          typeof details?.code === "string"
            ? details.code
            : typeof responseBody?.code === "string"
              ? responseBody.code
              : null;
        const stale =
          payload?.status === 409 &&
          (code === "queued_comment_stale_target" ||
            code === "queued_comment_not_pending");
        if (stale) {
          setQueuedEdit((current) =>
            current?.commentId === commentId
              ? { ...current, stale: true }
              : current,
          );
        }
        throw error;
      }
    },
    [onAdd, onEditQueuedComment, queuedEdit],
  );

  useEffect(() => {
    if (!queuedEdit || queuedEdit.stale) return;
    const targetStillQueued = queuedMessageQueue?.entries.some(
      (entry) => entry.comment.id === queuedEdit.commentId,
    );
    if (!targetStillQueued) {
      setQueuedEdit((current) =>
        current ? { ...current, stale: true } : current,
      );
    } else if (
      queuedMessageQueue &&
      queuedEdit.revision !== queuedMessageQueue.revision
    ) {
      // A concurrent reorder/edit refreshes the optimistic-lock token without
      // replacing the Markdown currently in the editor.
      setQueuedEdit((current) =>
        current
          ? { ...current, revision: queuedMessageQueue.revision }
          : current,
      );
    }
  }, [queuedEdit, queuedMessageQueue]);

  const liveWorkLinks = useMemo(
    () =>
      issueStatus === "blocked" && blockerAttention?.state === "covered"
        ? resolveTaskChatLiveWork(
            blockedBy,
            liveIssueIds ?? EMPTY_LIVE_ISSUE_IDS,
            blockerAttention.terminalBlocker,
          )
        : null,
    [
      blockedBy,
      blockerAttention?.state,
      blockerAttention?.terminalBlocker,
      issueStatus,
      liveIssueIds,
    ],
  );

  const blockerLinks = useMemo(
    () =>
      issueStatus === "blocked" && !liveWorkLinks
        ? resolveTaskChatBlockers(
            blockedBy,
            blockerAttention?.terminalBlockerIssueId,
            blockerAttention?.directBlockerIssueId,
            blockerAttention?.terminalBlocker,
          )
        : null,
    [
      blockedBy,
      blockerAttention?.directBlockerIssueId,
      blockerAttention?.terminalBlocker,
      blockerAttention?.terminalBlockerIssueId,
      issueStatus,
      liveWorkLinks,
    ],
  );

  const threadHeaderWithBlockers =
    threadHeader || blockerLinks || liveWorkLinks ? (
      <>
        {threadHeader}
        {liveWorkLinks ? (
          <TaskChatLiveWorkLinks liveWork={liveWorkLinks} placement="top" />
        ) : blockerLinks ? (
          <TaskChatBlockerLinks
            directBlocker={blockerLinks.directBlocker}
            ultimateBlocker={blockerLinks.ultimateBlocker}
            placement="top"
          />
        ) : null}
      </>
    ) : undefined;

  const linkedRunMetaById = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<TaskChatThreadProps["linkedRuns"]>[number]
    >();
    for (const run of linkedRuns ?? []) map.set(run.runId, run);
    return map;
  }, [linkedRuns]);

  const verificationCaveatsByRunId = useMemo(() => {
    const map = new Map<
      string,
      ReturnType<typeof acceptedSemanticResultVerificationCaveats>
    >();
    for (const run of linkedRuns ?? []) {
      const caveats = acceptedSemanticResultVerificationCaveats(run.resultJson);
      if (caveats.length > 0) map.set(run.runId, caveats);
    }
    return map;
  }, [linkedRuns]);

  // Historical placeholder comments remain untouched in storage. Projection
  // prefers the accepted semantic result so runs such as DOT-20 recover their
  // real upstream response without a data migration.
  const projectedComments = useMemo(
    () =>
      comments.flatMap((comment) => {
        if (comment.body !== LEGACY_WITHHELD_RUN_COMMENT || !comment.runId)
          return [comment];
        const resultJson = linkedRunMetaById.get(comment.runId)?.resultJson;
        // Historical native runs wrote a placeholder comment even when the
        // accepted result only yielded for interaction. Do not turn that
        // control-plane wait into an ordinary assistant bubble.
        if (acceptedSemanticResultDisposition(resultJson) === "yielded") {
          return [];
        }
        const summary = acceptedSemanticResultSummary(resultJson);
        return [summary ? { ...comment, body: summary } : comment];
      }),
    [comments, linkedRunMetaById],
  );

  const commentItems = useMemo(
    () =>
      commentsToTaskChatItems(projectedComments, {
        agentMap,
        userLabelMap,
        currentUserId,
        issueAssigneeAgentId,
        verificationCaveatsByRunId,
      }),
    [
      projectedComments,
      agentMap,
      userLabelMap,
      currentUserId,
      issueAssigneeAgentId,
      verificationCaveatsByRunId,
    ],
  );

  // Every run we might need a transcript for (history + live), deduped by id.
  const runs = useMemo<RunTranscriptSource[]>(() => {
    const map = new Map<string, RunTranscriptSource>();
    for (const r of linkedRuns ?? []) {
      map.set(r.runId, {
        id: r.runId,
        status: r.status,
        adapterType: r.adapterType ?? "",
        runtimeMode: r.runtimeMode,
        hasStoredOutput: r.hasStoredOutput,
        logBytes: r.logBytes,
      });
    }
    for (const r of liveRuns ?? []) {
      map.set(r.id, {
        id: r.id,
        status: r.status,
        adapterType: r.adapterType,
        runtimeMode: r.runtimeMode,
        hasStoredOutput: map.get(r.id)?.hasStoredOutput,
        logBytes: r.logBytes,
        lastOutputBytes: r.lastOutputBytes,
      });
    }
    if (activeRun) {
      map.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        adapterType: activeRun.adapterType,
        runtimeMode: activeRun.runtimeMode,
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
      });
    }
    return [...map.values()];
  }, [linkedRuns, liveRuns, activeRun]);

  const nativeRuns = useMemo(
    () => runs.filter((run) => run.runtimeMode === "native"),
    [runs],
  );
  const {
    transcriptByRun: logTranscriptByRun,
    isInitialHydrating: logsAreInitiallyHydrating,
  } = useLiveRunTranscripts({
    // Native events are authoritative, but the persisted/live log remains a
    // compatibility source when an upgraded server has no event history or
    // the native event endpoint is temporarily unavailable.
    runs,
    companyId,
  });
  const {
    transcriptByRun: nativeTranscriptByRun,
    errorsByRun: nativeTranscriptErrorsByRun,
  } = useNativeRunTranscripts(nativeRuns);
  const transcriptByRun = useMemo(() => {
    const next = new Map(logTranscriptByRun);
    for (const run of nativeRuns) {
      const logTranscript = logTranscriptByRun.get(run.id) ?? [];
      const nativeTranscript = nativeTranscriptByRun.get(run.id) ?? [];
      const nativeEventsUnavailable = nativeTranscriptErrorsByRun.has(run.id);
      if (
        nativeTranscript.length > 0 &&
        (!nativeEventsUnavailable || logTranscript.length === 0)
      ) {
        next.set(run.id, nativeTranscript);
      }
    }
    return next;
  }, [
    logTranscriptByRun,
    nativeRuns,
    nativeTranscriptByRun,
    nativeTranscriptErrorsByRun,
  ]);

  // The single in-flight run whose turn we stream live (non-terminal).
  const liveRun = useMemo(() => {
    if (isTerminalIssueStatus(issueStatus)) return null;
    if (activeRun && isLiveIssueRun(activeRun, issueStatus)) return activeRun;
    return (liveRuns ?? []).find((r) => isLiveIssueRun(r, issueStatus)) ?? null;
  }, [activeRun, issueStatus, liveRuns]);

  // The live runner turn remains the sole owner of its response until the
  // canonical comment and settled activity are both ready. This state is
  // established in a layout effect so the live lane never disappears for a
  // paint between `liveRun` ending and the persistence handoff beginning.
  const [settlingRun, setSettlingRun] = useState<{
    id: string;
    startedAtMs: number | null;
  } | null>(null);
  const prevLiveRunRef = useRef<typeof liveRun>(null);
  useLayoutEffect(() => {
    if (liveRun) {
      prevLiveRunRef.current = liveRun;
      setSettlingRun((current) =>
        current && current.id !== liveRun.id ? null : current,
      );
      return;
    }
    const prev = prevLiveRunRef.current;
    prevLiveRunRef.current = null;
    if (!prev) return;
    setSettlingRun({
      id: prev.id,
      startedAtMs:
        (prev.startedAt ? toMs(prev.startedAt) : null) ?? toMs(prev.createdAt),
    });
  }, [liveRun]);

  const heldPaperclipRunnerRunId =
    liveRun && isNativePaperclipRunnerRun(liveRun)
      ? liveRun.id
      : settlingRun &&
          isNativePaperclipRunnerRun(
            runs.find((run) => run.id === settlingRun.id),
          )
        ? settlingRun.id
        : null;
  const heldPaperclipRunnerStartedAtMs =
    liveRun && heldPaperclipRunnerRunId === liveRun.id
      ? ((liveRun.startedAt ? toMs(liveRun.startedAt) : null) ??
        toMs(liveRun.createdAt))
      : (settlingRun?.startedAtMs ?? null);
  const heldPaperclipRunnerFinalText = useMemo(() => {
    if (!heldPaperclipRunnerRunId) return null;
    const entries = transcriptByRun.get(heldPaperclipRunnerRunId) ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (
        entry.kind === "assistant" &&
        entry.channel === "final" &&
        entry.text.trim()
      ) {
        return entry.text;
      }
    }
    return null;
  }, [heldPaperclipRunnerRunId, transcriptByRun]);

  // Runs observed non-terminal while mounted: their turns ANIMATE the fold when
  // they settle. Runs already terminal at mount collapse instantly.
  const liveSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (liveRun) liveSeenRef.current.add(liveRun.id);
  }, [liveRun]);

  // Each terminal run's turn anchors immediately after the run's last comment
  // (its reply bubble), via the comment.runId linkage — the summary line lands
  // below the bubble, where the live "Running…" pill sat. A run with no linked
  // comment (stopped run, or reply not yet fetched) instead slots into the
  // backbone chronologically at its start time (PAP-367).
  const lastCommentIdByRun = useMemo(() => {
    const map = new Map<string, string>();
    for (const comment of comments) {
      if (comment.deletedAt || !comment.runId || !comment.id) continue;
      map.set(comment.runId, comment.id);
    }
    // A settled Paperclip turn normally attaches to its durable final reply.
    // Same-turn steering splits that causal interval into timestamped segments,
    // so each segment must stay unanchored and interleave around the injected
    // human bubble through the chronological assembler.
    for (const comment of comments) {
      const runId = comment.steeredIntoRunId;
      if (!comment.deletedAt && runId && comment.conversationAnchorAt) {
        map.delete(runId);
      }
    }
    return map;
  }, [comments]);

  const steeringAnchorsByRun = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const comment of comments) {
      const runId = comment.steeredIntoRunId;
      if (comment.deletedAt || !runId || !comment.conversationAnchorAt)
        continue;
      const anchorMs = toMs(comment.conversationAnchorAt);
      if (!Number.isFinite(anchorMs)) continue;
      const anchors = map.get(runId) ?? [];
      if (!anchors.includes(anchorMs)) anchors.push(anchorMs);
      map.set(runId, anchors);
    }
    for (const anchors of map.values()) anchors.sort((a, b) => a - b);
    return map;
  }, [comments]);

  const { data: planDocument } = useIssuePlanDocument(issueId);

  // A native-runner Plan is part of the turn that wrote its current revision.
  // Legacy adapters do not expose the semantic write_document boundary needed
  // for stable embedding, so their Plans remain chronological thread entries.
  // Prefer a native review request's explicit run binding; while that request
  // is still being created, infer the native owner from the document timestamp.
  const planDocumentSourceRunId = useMemo(() => {
    if (!planDocument) return null;
    const candidates = new Map<
      string,
      {
        id: string;
        adapterType: string;
        runtimeMode?: string | null;
        agentId?: string | null;
        createdAt?: Date | string | null;
        startedAt?: Date | string | null;
        finishedAt?: Date | string | null;
      }
    >();
    for (const run of linkedRuns ?? []) {
      candidates.set(run.runId, {
        ...run,
        id: run.runId,
        adapterType: run.adapterType ?? "",
      });
    }
    for (const run of liveRuns ?? []) candidates.set(run.id, run);
    if (activeRun) candidates.set(activeRun.id, activeRun);

    const linkedReview = (interactions ?? []).find((interaction) => {
      if (!interaction.sourceRunId) return false;
      const sourceRun = candidates.get(interaction.sourceRunId);
      return (
        isNativePaperclipRunnerRun(sourceRun) &&
        interactionTargetsPlanRevision(interaction, planDocument)
      );
    });
    if (linkedReview?.sourceRunId) return linkedReview.sourceRunId;

    const documentAtMs = toMs(planDocument.updatedAt);
    const matchingRuns = [...candidates.values()].filter((run) => {
      if (!isNativePaperclipRunnerRun(run)) return false;
      if (
        planDocument.updatedByAgentId &&
        run.agentId &&
        planDocument.updatedByAgentId !== run.agentId
      ) {
        return false;
      }
      const startedAtMs = toMs(run.startedAt ?? run.createdAt);
      const finishedAtMs = run.finishedAt
        ? toMs(run.finishedAt)
        : Number.POSITIVE_INFINITY;
      return (
        startedAtMs <= documentAtMs + 1_000 &&
        documentAtMs <= finishedAtMs + 1_000
      );
    });
    matchingRuns.sort(
      (a, b) =>
        toMs(b.startedAt ?? b.createdAt) - toMs(a.startedAt ?? a.createdAt),
    );
    return matchingRuns[0]?.id ?? null;
  }, [activeRun, interactions, linkedRuns, liveRuns, planDocument]);

  const planTurnItem = useMemo<TaskChatPlanDocumentItem | null>(() => {
    if (!planDocument || !planDocumentSourceRunId) return null;
    return {
      id: `plan-doc:${planDocument.latestRevisionId ?? planDocument.id}`,
      kind: "plan_document",
      document: planDocument,
    };
  }, [planDocument, planDocumentSourceRunId]);

  // Comments, interactions, and the plan-doc marker merged into one
  // chronological backbone (same sort keys and same-run handoff shift as the
  // legacy buildIssueChatMessages), so plan-mode confirmation/question cards
  // land where they happened in the conversation.
  const orderedEntries = useMemo(() => {
    const entries: {
      ms: number;
      order: number;
      id: string;
      item: TaskChatItem;
    }[] = [];
    // commentsToTaskChatItems skips deleted comments — mirror its filter so the
    // two lists stay index-aligned.
    const visibleComments = projectedComments.filter(
      (comment) => !comment.deletedAt,
    );
    visibleComments.forEach((comment, index) => {
      if (queuedCommentIds.has(comment.id)) return;
      // The live/settling runner lane already renders this run's final answer.
      // Keep a just-persisted duplicate out of the backbone until the complete
      // canonical bubble + Worked header can replace that lane atomically.
      if (
        heldPaperclipRunnerRunId &&
        isRunnerResponseComment({
          comment,
          runId: heldPaperclipRunnerRunId,
          runStartedAtMs: heldPaperclipRunnerStartedAtMs,
          finalText: heldPaperclipRunnerFinalText,
        })
      )
        return;
      const item = commentItems[index];
      if (!item) return;
      entries.push({
        // A held/queued input belongs where the runner actually consumes it,
        // not where the user first submitted it while another turn was live.
        ms: comment.conversationAnchorAt
          ? toMs(comment.conversationAnchorAt)
          : toMs(comment.createdAt),
        order:
          1 + Math.min(comment.conversationAnchorSequence ?? 0, 999) / 1000,
        id: item.id,
        item,
      });
    });
    for (const interaction of interactions ?? []) {
      // Withdrawn/superseded confirmations are retracted calls to action — drop
      // them so a dead card never stacks above the one that replaced it.
      if (isSuppressedThreadInteraction(interaction)) continue;
      // A never-rendered card — a degenerate `ask_user_questions` (e.g. the
      // onboarding `Test / A` placeholder) or a stale sibling superseded by a
      // newer question (PAP-437) — is filtered here so it leaves no empty slot
      // or gap in the ordered backbone (PAP-424, plan from PAP-420).
      const isSupersededQuestionReceipt =
        interaction.kind === "ask_user_questions" &&
        interaction.status !== "pending" &&
        interaction.result?.expirationReason ===
          "superseded_by_newer_interaction";
      if (
        shouldHideInteractionCard(interaction) &&
        !isSupersededQuestionReceipt
      )
        continue;
      // The plan preview is already embedded at this run's write_document
      // boundary. Pending controls live in the composer takeover, so mounting
      // the interaction's second preview here would make the plan jump and
      // duplicate during the live-to-settled handoff.
      if (
        interaction.status === "pending" &&
        planDocument &&
        planDocumentSourceRunId === interaction.sourceRunId &&
        interactionTargetsPlanRevision(interaction, planDocument)
      ) {
        continue;
      }
      const createdAtMs = toMs(interaction.createdAt);
      const handoffAtMs =
        interaction.kind === "request_confirmation" && interaction.sourceRunId
          ? latestSameRunHandoffTimestamp({
              interactionCreatedAtMs: createdAtMs,
              sourceRunId: interaction.sourceRunId,
              comments,
              timelineEvents: timelineEvents ?? [],
              linkedRuns: linkedRuns ?? [],
              liveRuns: liveRuns ?? [],
            })
          : null;
      const id = `interaction:${interaction.id}`;
      entries.push({
        // Question forms and plan previews remain where they were asked. Their
        // separately projected human responses stay at resolvedAt.
        ms: isResolvedPlanConfirmation(interaction)
          ? (handoffAtMs ?? createdAtMs)
          : interactionThreadAnchorMs(interaction, handoffAtMs ?? createdAtMs),
        order: 2,
        id,
        item: { id, kind: "interaction", interaction },
      });
    }
    for (const document of documents) {
      if (document.key === "plan") continue;
      const id = `resource:document:${document.id}`;
      entries.push({
        ms: toMs(document.updatedAt),
        order: 3,
        id,
        item: {
          id,
          kind: "protocol",
          surface: "resource",
          resourceKind: "document",
          title: documentDisplayTitle(document),
          subtitle: `Document · rev ${document.latestRevisionNumber}`,
          href: buildDocumentAnnotationHash({
            documentKey: document.key,
            threadId: null,
            commentId: null,
          }),
          timestamp: new Date(document.updatedAt).toISOString(),
          document,
        },
      });
    }
    for (const workProduct of workProducts) {
      const id = `resource:deliverable:${workProduct.id}`;
      const href = workProductHref(workProduct);
      entries.push({
        ms: toMs(workProduct.createdAt),
        order: 3,
        id,
        item: {
          id,
          kind: "protocol",
          surface: "resource",
          resourceKind: "deliverable",
          title: workProduct.title,
          subtitle: [
            workProduct.type.replaceAll("_", " "),
            workProduct.status,
            workProduct.reviewState !== "none" ? workProduct.reviewState : null,
          ]
            .filter(Boolean)
            .join(" · "),
          href: safeResourceHref(href),
          timestamp: new Date(workProduct.createdAt).toISOString(),
          workProduct,
        },
      });
    }
    for (const attachment of selectAgentArtifactAttachments(
      attachments,
      workProducts,
    )) {
      const id = `resource:attachment:${attachment.id}`;
      entries.push({
        ms: toMs(attachment.createdAt),
        order: 3,
        id,
        item: {
          id,
          kind: "protocol",
          surface: "resource",
          resourceKind: "attachment",
          title: attachment.originalFilename ?? "Agent attachment",
          subtitle: `${attachment.contentType} · ${formatResourceBytes(attachment.byteSize)}`,
          href: safeResourceHref(attachment.openPath ?? attachment.contentPath),
          timestamp: new Date(attachment.createdAt).toISOString(),
          attachment,
        },
      });
    }
    if (planDocument && !planDocumentSourceRunId) {
      const id = `plan-doc:${planDocument.latestRevisionId ?? planDocument.id}`;
      entries.push({
        ms: toMs(planDocument.updatedAt),
        order: 0,
        id,
        item: {
          id,
          kind: "plan_document",
          document: planDocument,
        },
      });
    }
    return entries.sort(
      (a, b) => a.ms - b.ms || a.order - b.order || a.id.localeCompare(b.id),
    );
  }, [
    comments,
    projectedComments,
    commentItems,
    interactions,
    documents,
    workProducts,
    attachments,
    timelineEvents,
    linkedRuns,
    liveRuns,
    planDocument,
    planDocumentSourceRunId,
    heldPaperclipRunnerRunId,
    heldPaperclipRunnerStartedAtMs,
    heldPaperclipRunnerFinalText,
    queuedCommentIds,
  ]);

  const legacyTimelineAnchorsByRun = useMemo(() => {
    const windows = new Map<
      string,
      {
        adapterType: string;
        runtimeMode?: string | null;
        startMs: number;
        endMs: number;
      }
    >();
    for (const run of linkedRuns ?? []) {
      windows.set(run.runId, {
        adapterType: run.adapterType ?? "",
        runtimeMode: run.runtimeMode,
        startMs: toMs(run.startedAt ?? run.createdAt),
        endMs: run.finishedAt ? toMs(run.finishedAt) : Number.POSITIVE_INFINITY,
      });
    }
    for (const run of liveRuns ?? []) {
      windows.set(run.id, {
        adapterType: run.adapterType,
        runtimeMode: run.runtimeMode,
        startMs: toMs(run.startedAt ?? run.createdAt),
        endMs: run.finishedAt ? toMs(run.finishedAt) : Number.POSITIVE_INFINITY,
      });
    }
    if (activeRun) {
      windows.set(activeRun.id, {
        adapterType: activeRun.adapterType,
        runtimeMode: activeRun.runtimeMode,
        startMs: toMs(activeRun.startedAt ?? activeRun.createdAt),
        endMs: activeRun.finishedAt
          ? toMs(activeRun.finishedAt)
          : Number.POSITIVE_INFINITY,
      });
    }

    const anchorsByRun = new Map<string, number[]>();
    for (const [runId, window] of windows) {
      if (
        isNativePaperclipRunnerRun(window) ||
        !Number.isFinite(window.startMs)
      ) {
        continue;
      }
      const anchors = orderedEntries
        .map((entry) => entry.ms)
        .filter(
          (entryMs) =>
            Number.isFinite(entryMs) &&
            entryMs > window.startMs &&
            entryMs <= window.endMs,
        );
      if (anchors.length > 0) {
        anchorsByRun.set(
          runId,
          [...new Set(anchors)].sort((a, b) => a - b),
        );
      }
    }
    return anchorsByRun;
  }, [activeRun, linkedRuns, liveRuns, orderedEntries]);

  // Boolean gate (stable across the host's per-render brief objects) so the
  // heavy assembly memo doesn't recompute on every parent render.
  const hasBrief = Boolean(issueBrief);

  const { items, settledRunIds } = useMemo<{
    items: TaskChatItem[];
    settledRunIds: Set<string>;
  }>(() => {
    // Runs whose settled turn made it into the assembled thread — the live tail
    // hands off to this as its "the settled turn has rendered" signal (PAP-462
    // B4), so the transcript stays mounted through the settle gap without ever
    // double-rendering beside its own settled turn.
    const settledRunIds = new Set<string>();
    const entriesWithFailures = [...orderedEntries];
    // Settled turns for every terminal run whose transcript we have. Provider
    // commentary, grouped activity (including reasoning summaries), and
    // terminal request receipts remain in transcript order. Final text is
    // owned by a posted completion comment when one exists. Yielded interaction
    // runs remain activity/waiting state and never occupy a final-response slot.
    const settledTurns: {
      turn: TaskChatTurnItem;
      anchorCommentId: string | null;
      startMs: number;
    }[] = [];
    // Raw summary inputs per turn id, so back-to-back same-agent runs can
    // coalesce into one "Worked" row in the final pass (PAP-362).
    const turnMergeMetaById = new Map<string, SettledTurnMergeMeta>();
    for (const source of runs) {
      if (!isTerminalRunStatus(source.status)) continue;
      if (liveRun && source.id === liveRun.id) continue;
      const entries = transcriptByRun.get(source.id) ?? [];
      const meta = linkedRunMetaById.get(source.id);
      const acceptedSummary = acceptedSemanticResultSummary(meta?.resultJson);
      const sourceYielded =
        acceptedSemanticResultDisposition(meta?.resultJson) === "yielded";
      const sourceIsPaperclipRunner = isNativePaperclipRunnerRun(source);
      const decidedCommentId = presentationDecisionCommentId(meta?.resultJson);
      const progressCommentIds = semanticProgressCommentIds(meta?.resultJson);
      const sourcePresentationCommentId =
        decidedCommentId === undefined
          ? ([...comments]
              .reverse()
              .find(
                (comment) =>
                  !comment.deletedAt &&
                  comment.runId === source.id &&
                  !progressCommentIds.has(comment.id),
              )?.id ?? null)
          : decidedCommentId !== null &&
              comments.some(
                (comment) =>
                  !comment.deletedAt &&
                  comment.runId === source.id &&
                  comment.id === decidedCommentId,
              )
            ? decidedCommentId
            : null;
      const sourceHasPresentationComment = sourcePresentationCommentId !== null;
      const sourcePresentationText = sourcePresentationCommentId
        ? (comments.find(
            (comment) => comment.id === sourcePresentationCommentId,
          )?.body ?? null)
        : null;
      const sourceHasNativeResponse =
        sourceIsPaperclipRunner &&
        !sourceYielded &&
        (sourceHasPresentationComment ||
          Boolean(acceptedSummary) ||
          entries.some(
            (entry) =>
              (entry.kind === "assistant" &&
                entry.channel !== "progress" &&
                Boolean(entry.text.trim())) ||
              (entry.kind === "run_result" && Boolean(entry.summary.trim())),
          ));
      const sourceHasNativeStop =
        sourceIsPaperclipRunner &&
        (source.status === "failed" ||
          source.status === "timed_out" ||
          source.status === "cancelled" ||
          source.status === "interrupted");
      if (sourceHasNativeStop) {
        settledRunIds.add(source.id);
        const code =
          meta?.errorCode ??
          (source.status === "timed_out"
            ? "native_runner_timed_out"
            : "native_runner_process_exited");
        const label =
          source.status === "cancelled"
            ? "Run cancelled"
            : source.status === "interrupted"
              ? "Run interrupted"
              : source.status === "timed_out"
                ? "Run timed out"
                : "Run failed";
        const responseBoundary = sourceHasNativeResponse
          ? "after returning a final response"
          : "before returning an answer";
        const detail =
          source.status === "cancelled"
            ? `The run was cancelled ${responseBoundary}.`
            : source.status === "interrupted"
              ? `The run was interrupted ${responseBoundary}.`
              : code === "provider_frame_too_large"
                ? "Provider output exceeded the safe limit."
                : source.status === "timed_out"
                  ? `The runner timed out ${responseBoundary} (${code}).`
                  : `The runner stopped ${responseBoundary} (${code}).`;
        const id = `${source.id}:failure`;
        const runAgent = meta?.agentId
          ? agentMap?.get(meta.agentId)
          : undefined;
        const finishedAt =
          meta?.finishedAt ?? meta?.startedAt ?? meta?.createdAt;
        entriesWithFailures.push({
          ms: toMs(finishedAt),
          order: 3,
          id,
          item: {
            id,
            kind: "marker",
            variant: "interrupted",
            label,
            detail,
            collapsible: true,
            runId: source.id,
            createdAtIso: finishedAt
              ? new Date(finishedAt).toISOString()
              : undefined,
            runHref: runAgent
              ? `/agents/${encodeURIComponent(runAgent.urlKey)}/runs/${encodeURIComponent(source.id)}`
              : undefined,
          },
        });
      }
      if (entries.length === 0) {
        if (sourceIsPaperclipRunner && sourceYielded) {
          settledRunIds.add(source.id);
          continue;
        }
        if (
          isNativePaperclipRunnerRun(source) &&
          acceptedSummary &&
          !sourceHasPresentationComment
        ) {
          const startedAtMs = toMs(meta?.startedAt ?? meta?.createdAt);
          const finishedAtMs = toMs(meta?.finishedAt);
          const durationMs =
            startedAtMs > 0 && finishedAtMs > 0
              ? Math.max(0, finishedAtMs - startedAtMs)
              : undefined;
          const failed = source.status !== "succeeded";
          const turnId = `${source.id}:turn`;
          turnMergeMetaById.set(turnId, {
            agentKey: meta?.agentId ?? "",
            agentName: meta?.agentName,
            parts: [{ entries, durationMs, failed }],
          });
          settledTurns.push({
            turn: {
              id: turnId,
              kind: "turn",
              settled: true,
              agentName:
                meta?.agentName ??
                (meta?.agentId ? agentMap?.get(meta.agentId)?.name : undefined),
              agentIcon: meta?.agentId
                ? agentMap?.get(meta.agentId)?.icon
                : undefined,
              standaloneHeader: true,
              animateFold: liveSeenRef.current.has(source.id),
              items: [],
              finalResponse: paperclipRunnerFinalResponse([], {
                runId: source.id,
                agentName: meta?.agentName,
                fallbackSummary: acceptedSummary,
              }),
              summary: buildTurnSummary(entries, { durationMs, failed }),
            },
            anchorCommentId: null,
            startMs: startedAtMs > 0 ? startedAtMs : Number.POSITIVE_INFINITY,
          });
          settledRunIds.add(source.id);
        } else if (
          !sourceIsPaperclipRunner &&
          (source.status === "failed" || source.status === "timed_out")
        ) {
          settledRunIds.add(source.id);
          const code = meta?.errorCode ?? "native_runner_process_exited";
          const retryDetail = meta?.scheduledRetryAt
            ? "Retry scheduled automatically."
            : "You can retry this message now.";
          const detail =
            code === "provider_frame_too_large"
              ? `Provider output exceeded the safe limit. ${retryDetail}`
              : `The runner stopped before returning an answer (${code}). ${retryDetail}`;
          const id = `${source.id}:failure`;
          entriesWithFailures.push({
            ms: toMs(meta?.finishedAt ?? meta?.startedAt ?? meta?.createdAt),
            order: 3,
            id,
            item: {
              id,
              kind: "marker",
              variant: "interrupted",
              label: "Run failed",
              detail,
            },
          });
        } else if (!sourceHasNativeStop && !lastCommentIdByRun.has(source.id)) {
          settledRunIds.add(source.id);
          const id = `${source.id}:terminal-notice`;
          entriesWithFailures.push({
            ms: toMs(meta?.finishedAt ?? meta?.startedAt ?? meta?.createdAt),
            order: 3,
            id,
            item: {
              id,
              kind: "marker",
              variant: "turn_boundary",
              label: "Run completed",
              detail: "The runner returned no user-facing response.",
            },
          });
        }
        continue;
      }
      const started = meta?.startedAt
        ? new Date(meta.startedAt).getTime()
        : NaN;
      const finished = meta?.finishedAt
        ? new Date(meta.finishedAt).getTime()
        : NaN;
      const durationMs =
        Number.isFinite(started) && Number.isFinite(finished)
          ? Math.max(0, finished - started)
          : undefined;
      if (
        source.status === "succeeded" &&
        !sourceHasPresentationComment &&
        resolvedWithoutUserFacingResponse(meta?.resultJson) &&
        !sourceHasNativeResponse
      ) {
        const id = `${source.id}:terminal-notice`;
        entriesWithFailures.push({
          ms: toMs(meta?.finishedAt ?? meta?.startedAt ?? meta?.createdAt),
          order: 3,
          id,
          item: {
            id,
            kind: "marker",
            variant: "turn_boundary",
            label: "Run completed",
            detail: "The runner returned no user-facing response.",
          },
        });
      }
      const failed = source.status !== "succeeded";
      const startSlotRaw = meta?.startedAt ?? meta?.createdAt;
      const startSlotMs = startSlotRaw
        ? toMs(startSlotRaw)
        : Number.POSITIVE_INFINITY;
      const timelineAnchors = sourceIsPaperclipRunner
        ? (steeringAnchorsByRun.get(source.id) ?? [])
        : (legacyTimelineAnchorsByRun.get(source.id) ?? []);
      const segments = splitTranscriptAtAnchors(
        entries,
        startSlotMs,
        timelineAnchors,
      );
      const projectedSegments = segments.map((segment) => {
        const parsedTranscript = transcriptToTaskChatItems(segment.entries, {
          runId: source.id,
          agentName: meta?.agentName,
          running: false,
        });
        const parsed =
          source.id === planDocumentSourceRunId && planTurnItem
            ? embedPlanDocumentAtWriteBoundary(parsedTranscript, planTurnItem)
            : parsedTranscript;
        return {
          segment,
          parsed,
          timelineItems: sourceIsPaperclipRunner
            ? paperclipRunnerTimelineItems(parsed)
            : parsed,
        };
      });
      const sourceResponseText =
        sourceIsPaperclipRunner && !sourceYielded
          ? (sourcePresentationText ??
            paperclipRunnerFinalResponse(
              transcriptToTaskChatItems(entries, {
                runId: source.id,
                agentName: meta?.agentName,
                running: false,
              }),
              {
                runId: source.id,
                agentName: meta?.agentName,
                fallbackSummary: acceptedSummary,
              },
            )?.text)
          : undefined;
      const timelineItemsBySegment = sourceIsPaperclipRunner
        ? omitProgressRepeatedByResponseAcrossSegments(
            projectedSegments.map(({ timelineItems }) => timelineItems),
            sourceResponseText,
          )
        : projectedSegments.map(({ timelineItems }) => timelineItems);
      let lastPopulatedSegmentIndex = -1;
      for (let index = projectedSegments.length - 1; index >= 0; index -= 1) {
        if ((projectedSegments[index]?.segment.entries.length ?? 0) > 0) {
          lastPopulatedSegmentIndex = index;
          break;
        }
      }
      for (const [segmentIndex, projected] of projectedSegments.entries()) {
        const { segment, parsed } = projected;
        if (segment.entries.length === 0) continue;
        const finalResponse =
          sourceIsPaperclipRunner &&
          !sourceYielded &&
          !sourceHasPresentationComment
            ? paperclipRunnerFinalResponse(parsed, {
                runId: source.id,
                agentName: meta?.agentName,
                fallbackSummary:
                  segmentIndex === lastPopulatedSegmentIndex
                    ? acceptedSummary
                    : undefined,
              })
            : undefined;
        const children = settledRunChildren(
          timelineItemsBySegment[segmentIndex] ?? [],
        );
        if (children.length === 0 && !finalResponse && !sourceIsPaperclipRunner)
          continue;
        settledRunIds.add(source.id);
        const segmented = timelineAnchors.length > 0;
        const turnId = segmented
          ? `${source.id}:turn:${segmentIndex}`
          : `${source.id}:turn`;
        const segmentFinishedMs = Number.isFinite(segment.endMs)
          ? segment.endMs
          : finished;
        const segmentDurationMs =
          Number.isFinite(segment.startMs) && Number.isFinite(segmentFinishedMs)
            ? Math.max(0, segmentFinishedMs - segment.startMs)
            : durationMs;
        turnMergeMetaById.set(turnId, {
          agentKey: meta?.agentId ?? "",
          agentName: meta?.agentName,
          parts: [
            { entries: segment.entries, durationMs: segmentDurationMs, failed },
          ],
        });
        settledTurns.push({
          turn: {
            id: turnId,
            kind: "turn",
            settled: true,
            agentName:
              meta?.agentName ??
              (meta?.agentId ? agentMap?.get(meta.agentId)?.name : undefined),
            agentIcon: meta?.agentId
              ? agentMap?.get(meta.agentId)?.icon
              : undefined,
            standaloneHeader: sourceIsPaperclipRunner,
            continuedAfterSteering: sourceIsPaperclipRunner && segmentIndex > 0,
            animateFold: liveSeenRef.current.has(source.id),
            items: children,
            finalResponse,
            summary: buildTurnSummary(segment.entries, {
              durationMs: segmentDurationMs,
              failed,
            }),
          },
          anchorCommentId: segmented
            ? null
            : sourceIsPaperclipRunner
              ? sourceHasPresentationComment
                ? sourcePresentationCommentId
                : null
              : (lastCommentIdByRun.get(source.id) ?? null),
          // A post-steering segment ties the acknowledgement-backed human
          // bubble and is therefore inserted immediately after it. The first
          // segment retains the normal run-start slot.
          startMs: segment.startMs,
        });
      }
    }

    // Same-turn steering is visible before a live run settles. Freeze every
    // completed pre-steer interval into the main chronology immediately, then
    // leave only the last interval to the streaming tail below. Reusing the
    // settled ids and projection makes the terminal handoff structurally
    // identical instead of moving one unsplit live turn around the steer.
    if (liveRun) {
      const timelineAnchors = isNativePaperclipRunnerRun(liveRun)
        ? (steeringAnchorsByRun.get(liveRun.id) ?? [])
        : (legacyTimelineAnchorsByRun.get(liveRun.id) ?? []);
      if (timelineAnchors.length > 0) {
        const entries = transcriptByRun.get(liveRun.id) ?? [];
        const startSlotMs =
          (liveRun.startedAt ? toMs(liveRun.startedAt) : null) ??
          toMs(liveRun.createdAt);
        const segments = splitTranscriptAtAnchors(
          entries,
          startSlotMs,
          timelineAnchors,
        );
        for (const [segmentIndex, segment] of segments.slice(0, -1).entries()) {
          if (segment.entries.length === 0) continue;
          const parsedTranscript = transcriptToTaskChatItems(segment.entries, {
            runId: liveRun.id,
            agentName: liveRun.agentName,
            running: false,
          });
          const parsed =
            liveRun.id === planDocumentSourceRunId && planTurnItem
              ? embedPlanDocumentAtWriteBoundary(parsedTranscript, planTurnItem)
              : parsedTranscript;
          const children = settledRunChildren(
            isNativePaperclipRunnerRun(liveRun)
              ? paperclipRunnerTimelineItems(parsed)
              : parsed,
          );
          if (children.length === 0) continue;
          const turnId = `${liveRun.id}:turn:${segmentIndex}`;
          const segmentDurationMs =
            Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs)
              ? Math.max(0, segment.endMs - segment.startMs)
              : undefined;
          turnMergeMetaById.set(turnId, {
            agentKey: liveRun.agentId ?? "",
            agentName: liveRun.agentName,
            parts: [
              {
                entries: segment.entries,
                durationMs: segmentDurationMs,
                failed: false,
              },
            ],
          });
          settledTurns.push({
            turn: {
              id: turnId,
              kind: "turn",
              settled: true,
              agentName:
                liveRun.agentName ??
                (liveRun.agentId
                  ? agentMap?.get(liveRun.agentId)?.name
                  : undefined),
              agentIcon: liveRun.agentId
                ? agentMap?.get(liveRun.agentId)?.icon
                : undefined,
              standaloneHeader: isNativePaperclipRunnerRun(liveRun),
              continuedAfterSteering:
                isNativePaperclipRunnerRun(liveRun) && segmentIndex > 0,
              items: children,
              summary: buildTurnSummary(segment.entries, {
                durationMs: segmentDurationMs,
              }),
            },
            anchorCommentId: null,
            startMs: segment.startMs,
          });
        }
      }
    }
    settledTurns.sort((a, b) =>
      a.startMs < b.startMs ? -1 : a.startMs > b.startMs ? 1 : 0,
    );

    const turnsByAnchor = new Map<string, TaskChatTurnItem[]>();
    const unanchored: { turn: TaskChatTurnItem; startMs: number }[] = [];
    for (const { turn, anchorCommentId, startMs } of settledTurns) {
      if (anchorCommentId) {
        const list = turnsByAnchor.get(anchorCommentId) ?? [];
        list.push(turn);
        turnsByAnchor.set(anchorCommentId, list);
      } else {
        unanchored.push({ turn, startMs });
      }
    }

    // Anchored turns follow their run's reply comment; comment-less turns
    // (stopped runs, or a reply not yet fetched) interleave chronologically at
    // their run's start time instead of piling up under the newest message
    // (PAP-367).
    entriesWithFailures.sort(
      (a, b) => a.ms - b.ms || a.order - b.order || a.id.localeCompare(b.id),
    );
    const out = assembleThreadItems(
      entriesWithFailures,
      turnsByAnchor,
      unanchored,
    );

    // PAP-362: two runs replying back-to-back (same agent, nothing but the
    // agent's own bubbles between) fold into ONE "Worked" row below the last
    // reply; a user message or interaction keeps them apart.
    // Round 9: a settled turn directly following its own agent's reply bubble
    // then attaches to that bubble — the "Worked · …" summary renders on the
    // bubble's always-visible timestamp line instead of as a standalone row.
    // PAP-375: the description-as-first-bubble placeholder prepends LAST, after
    // every assembly/merge pass, so nothing can ever sort above it.
    return {
      items: prependIssueBrief(
        attachSettledTurns(
          coalesceSettledTurns(out, turnMergeMetaById),
          turnMergeMetaById,
        ),
        hasBrief,
      ),
      settledRunIds,
    };
  }, [
    orderedEntries,
    runs,
    liveRun,
    transcriptByRun,
    linkedRunMetaById,
    lastCommentIdByRun,
    comments,
    steeringAnchorsByRun,
    legacyTimelineAnchorsByRun,
    hasBrief,
    planDocumentSourceRunId,
    planTurnItem,
    agentMap,
  ]);

  // Hand off once the settled turn or its reply comment is in the thread; a
  // stopped run that yields neither is released by the backstop timeout so the
  // tail never lingers indefinitely.
  const settlingIsPaperclipRunner =
    settlingRun != null &&
    isNativePaperclipRunnerRun(runs.find((run) => run.id === settlingRun.id));
  const settlingHasComment =
    settlingRun != null &&
    comments.some((comment) =>
      settlingIsPaperclipRunner
        ? isRunnerResponseComment({
            comment,
            runId: settlingRun.id,
            runStartedAtMs: settlingRun.startedAtMs,
            finalText: heldPaperclipRunnerFinalText,
          })
        : comment.runId === settlingRun.id && !comment.deletedAt,
    );
  const settlingHasDurableInteraction =
    settlingRun != null &&
    (interactions ?? []).some(
      (interaction) =>
        interaction.sourceRunId === settlingRun.id &&
        !isSuppressedThreadInteraction(interaction) &&
        !shouldHideInteractionCard(interaction),
    );
  const settledRunRendered =
    settlingRun != null &&
    (settlingIsPaperclipRunner
      ? settledRunIds.has(settlingRun.id) &&
        (settlingHasComment || settlingHasDurableInteraction)
      : settlingHasComment || settledRunIds.has(settlingRun.id));
  useEffect(() => {
    if (!settlingRun) return;
    if (settledRunRendered) {
      setSettlingRun(null);
      return;
    }
    const timer = window.setTimeout(
      () => setSettlingRun(null),
      SETTLING_TAIL_MAX_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settlingRun, settledRunRendered]);

  // The tail streams the live run, or — through the settle gap — the last run's
  // now-static transcript until its settled form renders (PAP-462 B4).
  const showSettlingTail =
    !liveRun &&
    settlingRun != null &&
    !settledRunRendered &&
    (transcriptByRun.get(settlingRun.id)?.length ?? 0) > 0;
  const tailRunId = liveRun
    ? liveRun.id
    : showSettlingTail
      ? settlingRun!.id
      : null;
  const tailStreaming = Boolean(liveRun);
  const tailRunSource = tailRunId
    ? runs.find((run) => run.id === tailRunId)
    : undefined;
  const paperclipRunnerTail = isNativePaperclipRunnerRun(tailRunSource);
  const suppressPaperclipRunnerTailFinal = Boolean(
    paperclipRunnerTail &&
    (acceptedSemanticResultDisposition(
      tailRunId ? linkedRunMetaById.get(tailRunId)?.resultJson : null,
    ) === "yielded" ||
      (interactions ?? []).some(
        (interaction) =>
          interaction.sourceRunId === tailRunId &&
          interaction.status === "pending",
      )),
  );
  const tailAllEntries = tailRunId
    ? (transcriptByRun.get(tailRunId) ?? [])
    : [];
  const tailActivityUnavailable = Boolean(
    tailRunId &&
    nativeTranscriptErrorsByRun.has(tailRunId) &&
    (logTranscriptByRun.get(tailRunId)?.length ?? 0) === 0 &&
    !logsAreInitiallyHydrating,
  );
  const tailTimelineAnchors = tailRunId
    ? paperclipRunnerTail
      ? (steeringAnchorsByRun.get(tailRunId) ?? [])
      : (legacyTimelineAnchorsByRun.get(tailRunId) ?? [])
    : [];
  const tailSegmentStartMs =
    tailTimelineAnchors.length > 0
      ? tailTimelineAnchors[tailTimelineAnchors.length - 1]
      : null;
  const tailEntries =
    tailSegmentStartMs == null
      ? tailAllEntries
      : tailAllEntries.filter((entry) => toMs(entry.ts) >= tailSegmentStartMs);
  const tailPlanItem =
    tailRunId === planDocumentSourceRunId ? planTurnItem : null;
  // A fresh array is produced on every render. Track every presentation field
  // that can change without changing the entry count or text length so channel,
  // lifecycle, result status, and usage-only updates invalidate the projection.
  const tailEntryContentKey = tailEntries.reduce((key, entry) => {
    const textIdentity = "text" in entry ? entry.text : "";
    const contentIdentity = "content" in entry ? entry.content : "";
    const channelIdentity = "channel" in entry ? (entry.channel ?? "") : "";
    const lifecycleIdentity =
      "lifecycle" in entry ? (entry.lifecycle ?? "") : "";
    const statusIdentity =
      "isError" in entry ? (entry.isError ? "error" : "ok") : "";
    const usageIdentity =
      entry.kind === "result"
        ? `${entry.subtype}:${entry.inputTokens}:${entry.outputTokens}:${entry.cachedTokens}:${entry.costUsd}`
        : "";
    return `${key}|${entry.kind}:${channelIdentity}:${lifecycleIdentity}:${statusIdentity}:${usageIdentity}:${textIdentity}:${contentIdentity}`;
  }, String(tailEntries.length));
  const tailContentKey = `${tailSegmentStartMs ?? "run-start"}:${tailEntryContentKey}`;
  const blockerContentKey = blockerLinks
    ? `${blockerLinks.directBlocker.id}:${blockerLinks.ultimateBlocker?.id ?? ""}`
    : liveWorkLinks
      ? `live:${liveWorkLinks.steps.map((step) => `${step.blocker.id}:${step.status}`).join(",")}:${liveWorkLinks.nowRunning.map((blocker) => blocker.id).join(",")}`
      : "";
  const tailPlanContentKey = tailPlanItem
    ? `${tailPlanItem.id}:${tailPlanItem.document.body.length}`
    : "";
  const threadContentKey = `${taskChatContentKey(items)}:${tailContentKey}:${tailPlanContentKey}:${blockerContentKey}`;
  const repeatBlockersAtBottom =
    !streamlinedUiEnabled || shouldRepeatTaskChatBlockers(items);
  const bottomBlockerLinks = repeatBlockersAtBottom ? (
    liveWorkLinks ? (
      <TaskChatLiveWorkLinks liveWork={liveWorkLinks} placement="bottom" />
    ) : blockerLinks ? (
      <TaskChatBlockerLinks
        directBlocker={blockerLinks.directBlocker}
        ultimateBlocker={blockerLinks.ultimateBlocker}
        placement="bottom"
      />
    ) : null
  ) : null;

  // Status-pill inputs for the tail (PAP-461, A1): the run's start, its finish
  // (once terminal), and the "called N tools" summary. Memoized on the
  // transcript content key so the O(n) tool count is not re-walked every render
  // while the pill's own second-tick keeps the elapsed readout moving. Through
  // the settle gap the run reads terminal, so the pill lands on its "Worked"
  // state instead of flipping back to a spinner.
  const settlingFinishedAt = settlingRun
    ? linkedRunMetaById.get(settlingRun.id)?.finishedAt
    : undefined;
  const tailStatus = liveRun
    ? liveRun.status
    : (runs.find((run) => run.id === settlingRun?.id)?.status ?? "succeeded");
  const tailStartedAtMs =
    tailSegmentStartMs ??
    (liveRun
      ? ((liveRun.startedAt ? toMs(liveRun.startedAt) : null) ??
        toMs(liveRun.createdAt))
      : (settlingRun?.startedAtMs ?? null));
  const tailFinishedAtMs = liveRun
    ? liveRun.finishedAt
      ? toMs(liveRun.finishedAt)
      : null
    : settlingFinishedAt
      ? toMs(settlingFinishedAt)
      : null;
  const tailToolSummary = useMemo(
    () => (tailRunId ? toolCountSummaryFromEntries(tailEntries) : null),
    // tailEntries is a fresh array each render; tailContentKey tracks its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tailRunId, tailContentKey],
  );

  // The tail's clean rows (PAP-463 C1): the streaming transcript parsed through
  // the SAME transcriptToTaskChatItems converter the settled turns use, which
  // drops the debug plumbing (init/stdout/stderr/system) so RunTranscriptView's
  // noise can never reach the thread. Memoized on the content key (tailEntries
  // is a fresh array each render) so the O(n) parse is not re-walked while the
  // pill's own second-tick keeps the elapsed readout moving. `running` follows
  // tailStreaming: true while live, false through the settle gap — so the tail
  // renders identically either side of the run finishing.
  const tailAgentName =
    liveRun?.agentName ?? linkedRunMetaById.get(tailRunId ?? "")?.agentName;
  const tailAgentId =
    liveRun?.agentId ??
    linkedRunMetaById.get(tailRunId ?? "")?.agentId ??
    issueAssigneeAgentId;
  const tailAgent = tailAgentId ? agentMap?.get(tailAgentId) : undefined;
  const visibleTailAgentName = tailAgentName ?? tailAgent?.name ?? null;
  const visibleTailAgentIcon = tailAgent?.icon ?? null;
  const tailItems = useMemo(
    () => {
      if (!tailRunId) return [];
      const parsed = transcriptToTaskChatItems(tailEntries, {
        runId: tailRunId,
        agentName: tailAgentName,
        running: tailStreaming,
      });
      return tailPlanItem
        ? embedPlanDocumentAtWriteBoundary(parsed, tailPlanItem)
        : parsed;
    },
    // tailEntries is a fresh array each render; tailContentKey tracks its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tailRunId,
      tailContentKey,
      tailStreaming,
      tailAgentName,
      tailPlanContentKey,
    ],
  );
  const tailTurnStatus = useMemo(
    () =>
      isTerminalRunStatus(tailStatus)
        ? null
        : taskChatTurnStatusModel(tailItems),
    [tailItems, tailStatus],
  );
  const pendingRuntimeRequest = latestPendingRuntimeRequest(tailItems);
  const handleRuntimeRequestDecision = useCallback(
    async (
      item: TaskChatRuntimeRequestItem,
      decision: TaskChatRuntimeRequestDecision,
    ) => {
      if (!item.turnId || !item.requestKind) {
        throw new Error(
          "This runtime request is missing the provider turn identity needed to resolve it.",
        );
      }
      let resolution: RuntimeRequestResolution;
      if (decision.action !== "submit") {
        resolution = decision;
      } else if ("response" in decision) {
        resolution = { action: "submit", response: decision.response };
      } else if (item.requestKind === "user_input") {
        resolution = {
          action: "submit",
          answers: Object.fromEntries(
            Object.entries(decision.values).map(([field, value]) => [
              field,
              { answers: [value] },
            ]),
          ),
        };
      } else if (item.requestKind === "elicitation") {
        resolution = { action: "submit", content: decision.values };
      } else {
        throw new Error(
          "This runtime permission does not accept submitted form data.",
        );
      }
      await heartbeatsApi.resolveRuntimeRequest({
        runId: item.runId,
        requestId: item.requestId,
        turnId: item.turnId,
        requestKind: item.requestKind,
        resolution,
      });
    },
    [],
  );
  const pendingComposerInputs = useMemo<PendingComposerInput[]>(() => {
    const result: PendingComposerInput[] = [];
    const runtimeKey = pendingRuntimeRequest
      ? `runtime:${pendingRuntimeRequest.runId}:${pendingRuntimeRequest.requestId}`
      : null;
    if (pendingRuntimeRequest && runtimeKey) {
      result.push({
        key: runtimeKey,
        kind: "runtime",
        item: pendingRuntimeRequest,
        label:
          pendingRuntimeRequest.questionSet?.title ??
          (pendingRuntimeRequest.requestType === "permission"
            ? "Runtime permission"
            : "Runtime input"),
      });
    }
    const durable = (interactions ?? [])
      .filter(
        (interaction) =>
          interaction.status === "pending" &&
          !shouldHideInteractionCard(interaction),
      )
      .sort((left, right) => toMs(right.createdAt) - toMs(left.createdAt));
    for (const interaction of durable) {
      const recoveredRuntimeKey =
        interaction.kind === "ask_user_questions" &&
        interaction.sourceRunId &&
        interaction.payload.runtimeRequestId
          ? `runtime:${interaction.sourceRunId}:${interaction.payload.runtimeRequestId}`
          : null;
      const key = recoveredRuntimeKey ?? `interaction:${interaction.id}`;
      if (key === runtimeKey) continue;
      result.push({
        key,
        kind: "durable",
        interaction,
        label: durableInputLabel(interaction),
      });
    }
    return result;
  }, [interactions, pendingRuntimeRequest]);
  const [takeoverMode, setTakeoverMode] = useState<"open" | "normal">("open");
  const [selectedPendingKey, setSelectedPendingKey] = useState<string | null>(
    null,
  );
  const knownPendingKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentKeys = new Set(
      pendingComposerInputs.map((input) => input.key),
    );
    const hasNewInput = pendingComposerInputs.some(
      (input) => !knownPendingKeysRef.current.has(input.key),
    );
    knownPendingKeysRef.current = currentKeys;
    setSelectedPendingKey((current) =>
      current && currentKeys.has(current)
        ? current
        : (pendingComposerInputs[0]?.key ?? null),
    );
    if (hasNewInput) setTakeoverMode("open");
  }, [pendingComposerInputs]);
  const selectedPendingInput =
    pendingComposerInputs.find((input) => input.key === selectedPendingKey) ??
    pendingComposerInputs[0] ??
    null;
  const interactionDraftKey = selectedPendingInput
    ? `paperclip:task-input:${issueId ?? "unknown"}:${selectedPendingInput.key}`
    : undefined;
  const openPendingTakeover = useCallback(() => {
    setTakeoverMode("open");
  }, []);
  const showNextPendingInput = useCallback(() => {
    if (pendingComposerInputs.length < 2) return;
    const currentIndex = pendingComposerInputs.findIndex(
      (input) => input.key === selectedPendingInput?.key,
    );
    setSelectedPendingKey(
      pendingComposerInputs[(currentIndex + 1) % pendingComposerInputs.length]
        ?.key ?? null,
    );
  }, [pendingComposerInputs, selectedPendingInput?.key]);
  const skipPendingInput = useCallback(
    async (input: PendingComposerInput) => {
      if (input.kind === "runtime") {
        await handleRuntimeRequestDecision(input.item, { action: "cancel" });
      } else {
        if (!onSkipInteraction)
          throw new Error("Skipping this interaction is unavailable.");
        await onSkipInteraction(input.interaction);
      }
      setTakeoverMode("normal");
    },
    [handleRuntimeRequestDecision, onSkipInteraction],
  );
  const runtimeComposerDisabledReason = composerDisabledReason ?? undefined;
  const assigneeUsesPaperclipRunner = Boolean(
    issueAssigneeAgentId &&
    agentMap?.get(issueAssigneeAgentId)?.adapterType === "paperclip_runner",
  );
  const [runnerSubmissionPending, setRunnerSubmissionPending] = useState(false);
  useEffect(() => {
    if (tailRunId) setRunnerSubmissionPending(false);
  }, [tailRunId]);
  useEffect(() => {
    if (!runnerSubmissionPending || tailRunId) return;
    const timeout = window.setTimeout(
      () => setRunnerSubmissionPending(false),
      10_000,
    );
    return () => window.clearTimeout(timeout);
  }, [runnerSubmissionPending, tailRunId]);
  const handleThreadAdd = useCallback(
    async (...args: Parameters<typeof onAdd>) => {
      if (assigneeUsesPaperclipRunner) setRunnerSubmissionPending(true);
      try {
        await onAdd(...args);
      } catch (error) {
        setRunnerSubmissionPending(false);
        throw error;
      }
    },
    [assigneeUsesPaperclipRunner, onAdd],
  );
  const optimisticRunnerStartup =
    assigneeUsesPaperclipRunner &&
    !tailRunId &&
    (runnerSubmissionPending ||
      commentItems.some(
        (item) =>
          item.kind === "message" &&
          item.author === "human" &&
          item.optimistic === "pending",
      ));

  // Feedback votes keyed by the comment they target (targetType
  // "issue_comment"), mirroring IssueChatThread — the redesign attaches the
  // 👍/👎 state to each agent bubble by its comment id (PAP-413).
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes ?? []) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);

  // copy · 👍 · 👎 cluster for an agent bubble's footer line (PAP-413). Human
  // and system bubbles get nothing; copy is always available, and the feedback
  // buttons render only when the host wired a vote handler.
  const renderMessageActions = useCallback(
    (item: TaskChatMessageItem) => {
      if (item.author !== "agent" || item.optimistic) return null;
      return (
        <TaskChatBubbleActions
          copyText={item.text}
          feedback={
            onVote
              ? {
                  activeVote: feedbackVoteByTargetId.get(item.id) ?? null,
                  sharingPreference: feedbackDataSharingPreference,
                  termsUrl: feedbackTermsUrl,
                  onVote: (vote, options) => onVote(item.id, vote, options),
                }
              : null
          }
        />
      );
    },
    [
      onVote,
      feedbackVoteByTargetId,
      feedbackDataSharingPreference,
      feedbackTermsUrl,
    ],
  );

  const renderQueuedAction = useCallback(
    (item: TaskChatMessageItem) => {
      const runId = item.queueTargetRunId;
      if (item.optimistic !== "queued" || !runId || !onInterruptQueued)
        return null;

      const isInterrupting = interruptingQueuedRunId === runId;
      return (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-(length:--text-micro)"
          disabled={isInterrupting}
          onClick={() => void onInterruptQueued(runId)}
        >
          {isInterrupting ? "Interrupting…" : "Interrupt"}
        </Button>
      );
    },
    [interruptingQueuedRunId, onInterruptQueued],
  );

  const renderInteraction = useCallback(
    (item: TaskChatInteractionItem) => (
      <TaskChatInteractionCard
        item={item}
        planDocument={planDocument}
        showPlanPreview={
          !threadOwnsPlanPreview(
            item.interaction,
            planDocument,
            planDocumentSourceRunId,
            settledRunIds,
            tailRunId,
          )
        }
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        onAcceptInteraction={onAcceptInteraction}
        onRejectInteraction={onRejectInteraction}
        onSubmitInteractionAnswers={onSubmitInteractionAnswers}
        onCancelInteraction={onCancelInteraction}
        onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
        onUploadImage={imageUploadHandler}
        mentions={mentions}
        externalReferences={externalReferences}
      />
    ),
    [
      agentMap,
      currentUserId,
      userLabelMap,
      onAcceptInteraction,
      onRejectInteraction,
      onSubmitInteractionAnswers,
      onCancelInteraction,
      onSubmitInteractionVerdicts,
      imageUploadHandler,
      mentions,
      externalReferences,
      planDocument,
      planDocumentSourceRunId,
      settledRunIds,
      tailRunId,
    ],
  );

  const assignedAgentForNotice = useMemo(() => {
    if (!currentAssigneeValue?.startsWith("agent:")) return null;
    const assigneeAgentId = currentAssigneeValue.slice("agent:".length);
    return agentMap?.get(assigneeAgentId) ?? null;
  }, [agentMap, currentAssigneeValue]);

  const takeoverContent = selectedPendingInput ? (
    selectedPendingInput.kind === "runtime" ? (
      <TaskChatProtocolCard
        item={selectedPendingInput.item}
        presentation="takeover"
        draftKey={interactionDraftKey}
        imageUploadHandler={imageUploadHandler}
        mentions={mentions}
        onRuntimeRequestDecision={handleRuntimeRequestDecision}
      />
    ) : (
      <TaskChatInteractionCard
        item={{
          id: `interaction:${selectedPendingInput.interaction.id}`,
          kind: "interaction",
          interaction: selectedPendingInput.interaction,
        }}
        presentation="takeover"
        draftKey={interactionDraftKey}
        planDocument={planDocument}
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        onAcceptInteraction={onAcceptInteraction}
        onRejectInteraction={onRejectInteraction}
        onSubmitInteractionAnswers={onSubmitInteractionAnswers}
        onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
        onUploadImage={imageUploadHandler}
        mentions={mentions}
        externalReferences={externalReferences}
      />
    )
  ) : null;
  const composerTakeover =
    takeoverMode === "open" && selectedPendingInput && takeoverContent
      ? {
          id: selectedPendingInput.key,
          label: selectedPendingInput.label,
          pendingCount: pendingComposerInputs.length,
          content: takeoverContent,
          onDismiss: () => setTakeoverMode("normal"),
          onSkip: () => skipPendingInput(selectedPendingInput),
          onShowNext: showNextPendingInput,
          inlineSkip:
            selectedPendingInput.kind === "durable"
              ? selectedPendingInput.interaction.kind ===
                  "ask_user_questions" ||
                selectedPendingInput.interaction.kind ===
                  "request_item_verdicts"
              : selectedPendingInput.item.requestType === "input" &&
                Boolean(selectedPendingInput.item.questionSet),
          hideSkip:
            selectedPendingInput.kind === "durable"
              ? interactionReplacesComposerSkip(
                  selectedPendingInput.interaction,
                )
              : runtimeRequestReplacesComposerSkip(selectedPendingInput.item),
        }
      : null;
  const autoFollowContentKey = `${threadContentKey}:${composerTakeover?.id ?? "composer"}`;

  // Mobile (PAP-360): the app shell scrolls the DOCUMENT (Layout's main is
  // overflow-visible with auto height), so the desktop bounded h-dvh chain
  // collapses the absolute-inset transcript viewport to 0px. Render the thread
  // in document flow instead (the same scroll={false} path the previews use)
  // and track auto-follow against window scroll. Both paths include takeover
  // state so opening or closing composer input preserves bottom pinning.
  const { isMobile } = useSidebar();
  useWindowAutoFollow(isMobile ? autoFollowContentKey : 0, isMobile);

  return (
    <TaskChatPresentationProvider
      mode={streamlinedUiEnabled ? "streamlined" : "production"}
    >
      <div
        className={cn(
          "flex flex-col",
          !isMobile && "min-h-0 flex-1",
        )}
        data-testid="task-chat-thread"
      >
        <div className={cn("flex flex-col", !isMobile && "min-h-0 flex-1")}>
          {items.length === 0 && !tailRunId ? (
            <div
              className={
                isMobile ? undefined : "min-h-0 flex-1 overflow-y-auto"
              }
            >
              {threadHeaderWithBlockers ? (
                <div
                  className={cn(
                    "mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-6 px-4",
                    isMobile ? "pt-4" : "pt-3",
                    streamlinedUiEnabled && "md:px-0",
                  )}
                  data-testid="task-chat-thread-header"
                >
                  {threadHeaderWithBlockers}
                </div>
              ) : null}
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </div>
              {bottomBlockerLinks ? (
                <div
                  className={cn(
                    "mx-auto w-full max-w-(--tc-shell-max-w) px-4 pb-4",
                    streamlinedUiEnabled && "md:px-0",
                  )}
                >
                  {bottomBlockerLinks}
                </div>
              ) : null}
            </div>
          ) : (
            <TaskChatThreadView
              items={items}
              attachments={attachments}
              header={threadHeaderWithBlockers}
              renderInteraction={renderInteraction}
              renderBrief={
                issueBrief
                  ? () => <TaskChatDescriptionBubble brief={issueBrief} />
                  : undefined
              }
              renderMessageActions={renderMessageActions}
              renderQueuedAction={renderQueuedAction}
              onTryAgainNoLiveExecutionPath={
                issueStatus === "blocked"
                  ? onTryAgainNoLiveExecutionPath
                  : undefined
              }
              tryAgainNoLiveExecutionPathPending={
                tryAgainNoLiveExecutionPathPending
              }
              onRetryFailedRun={onRetryFailedRun}
              retryFailedRunId={retryFailedRunId}
              tail={
                tailRunId || optimisticRunnerStartup || bottomBlockerLinks ? (
                  <>
                    {tailRunId || optimisticRunnerStartup ? (
                      <div data-testid="task-chat-live-transcript">
                        {paperclipRunnerTail || optimisticRunnerStartup ? (
                          <TaskChatRunnerTurn
                            runId={tailRunId}
                            agentName={visibleTailAgentName}
                            agentIcon={visibleTailAgentIcon}
                            items={tailItems}
                            status={
                              optimisticRunnerStartup ? "queued" : tailStatus
                            }
                            startedAtMs={tailStartedAtMs}
                            finishedAtMs={tailFinishedAtMs}
                            activityUnavailable={tailActivityUnavailable}
                            suppressFinal={suppressPaperclipRunnerTailFinal}
                            continuedAfterSteering={
                              paperclipRunnerTail &&
                              tailTimelineAnchors.length > 0
                            }
                            onRuntimeRequestDecision={
                              handleRuntimeRequestDecision
                            }
                          />
                        ) : (
                          <>
                            <TaskChatLiveRunPill
                              status={tailStatus}
                              startedAtMs={tailStartedAtMs}
                              finishedAtMs={tailFinishedAtMs}
                              toolSummary={tailToolSummary}
                            />
                            <TaskChatLiveTail
                              items={tailItems}
                              emptyMessage={
                                tailStatus === "queued"
                                  ? "Waiting to start..."
                                  : (liveRun && liveRun.id === tailRunId
                                      ? liveRun.currentStatusMessage
                                      : null) || "Waiting for transcript..."
                              }
                            />
                          </>
                        )}
                      </div>
                    ) : null}
                    {bottomBlockerLinks}
                  </>
                ) : null
              }
              contentKey={autoFollowContentKey}
              className={isMobile ? undefined : "pt-3"}
              scroll={!isMobile}
            />
          )}
        </div>
        {assignedAgentForNotice?.status === "paused" ? (
          <div className="mx-auto w-full max-w-(--tc-shell-max-w) px-4 pt-2">
            <IssueAssigneePausedNotice
              agent={assignedAgentForNotice}
              onResume={onResumeAssignee}
              resuming={resumeAssigneePending}
            />
          </div>
        ) : null}
        {showComposer ? (
          <div
            data-testid="task-chat-composer-dock"
            className={cn(
              "sticky",
              // Mobile mirrors the flag-off thread's dock: lifted above the
              // safe-area inset and clear of the auto-hiding bottom nav, above
              // page content in the document-flow stacking context. The bottom
              // offset (--tc-composer-bottom) tracks the nav: Layout raises it to
              // the nav height while the nav is visible so the composer's action
              // row is never occluded, and drops it back to the safe-area dock
              // when the nav auto-hides (PAP-495). transition-[bottom] rides the
              // nav's own 200ms slide; the offset only changes on nav toggles, so
              // it never animates mid-scroll.
              isMobile
                ? "bottom-(--tc-composer-bottom) z-20 transition-[bottom] duration-200 ease-out"
                : "bottom-0 z-10",
              "mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-2 px-4 pb-2",
              streamlinedUiEnabled && "md:px-0 md:pb-0",
              (!streamlinedUiEnabled || isMobile) &&
                "bg-background/80 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60",
            )}
          >
            {composerAccessory}
            {tailTurnStatus ? (
              <TaskChatTurnStatusIsland model={tailTurnStatus} />
            ) : null}
            <div
              className="relative isolate flex flex-col"
              data-testid="task-chat-composer-stack"
            >
              {queuedMessageQueue ? (
                <TaskChatQueuedMessages
                  queue={queuedMessageQueue}
                  onEdit={beginQueuedEdit}
                  onReorder={async (orderedCommentIds, revision) => {
                    if (!onReorderQueuedComments)
                      throw new Error("Queue reordering is unavailable.");
                    await onReorderQueuedComments(orderedCommentIds, revision);
                  }}
                  onSteer={async (commentId, revision) => {
                    if (!onSteerQueuedComment)
                      throw new Error("Steering is unavailable.");
                    await onSteerQueuedComment(commentId, revision);
                  }}
                  onInterrupt={
                    onInterruptQueued && queuedMessageQueue.targetRunId
                      ? async () => {
                          await onInterruptQueued(
                            queuedMessageQueue.targetRunId!,
                          );
                        }
                      : undefined
                  }
                  onDiscard={async (commentId, revision) => {
                    if (commentId.startsWith("optimistic-")) {
                      if (!onCancelQueued)
                        throw new Error("Discard is unavailable.");
                      onCancelQueued(commentId);
                      return;
                    }
                    if (!onDiscardQueuedComment)
                      throw new Error("Discard is unavailable.");
                    await onDiscardQueuedComment(commentId, revision);
                    if (queuedEdit?.commentId === commentId)
                      setQueuedEdit(null);
                  }}
                />
              ) : null}
              <div className="relative z-10">
                <TaskChatComposer
                  onAdd={handleThreadAdd}
                  workMode={issueWorkMode}
                  onWorkModeChange={onWorkModeChange}
                  disabled={Boolean(runtimeComposerDisabledReason)}
                  disabledReason={runtimeComposerDisabledReason}
                  onAttachImage={onAttachImage}
                  onImageUpload={imageUploadHandler}
                  mentions={mentions}
                  enableReassign={enableReassign}
                  reassignOptions={reassignOptions}
                  agentMap={agentMap}
                  userProfileMap={userProfileMap}
                  currentAssigneeValue={currentAssigneeValue}
                  issueStatus={issueStatus}
                  mobile={isMobile}
                  draftKey={draftKey}
                  queuedEdit={queuedEdit}
                  onSaveQueuedEdit={saveQueuedEdit}
                  onCancelQueuedEdit={() => setQueuedEdit(null)}
                  takeover={composerTakeover}
                  pendingTakeover={
                    pendingComposerInputs.length > 0
                      ? {
                          count: pendingComposerInputs.length,
                          label: `${pendingComposerInputs.length} pending input${pendingComposerInputs.length === 1 ? "" : "s"}`,
                          onOpen: openPendingTakeover,
                        }
                      : null
                  }
                />
              </div>
            </div>
            {footer}
          </div>
        ) : null}
      </div>
    </TaskChatPresentationProvider>
  );
}
