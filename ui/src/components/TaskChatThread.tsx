import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { IssueChatThread } from "@/components/IssueChatThread";
import {
  useLiveRunTranscripts,
  type RunTranscriptSource,
} from "@/components/transcript/useLiveRunTranscripts";
import { TaskChatLiveTail } from "@/components/task-chat/TaskChatLiveTail";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import {
  assembleThreadItems,
  attachSettledTurns,
  buildTurnSummary,
  coalesceSettledTurns,
  isTerminalRunStatus,
  prependIssueBrief,
  settledRunChildren,
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
  TaskChatTurnItem,
} from "@/components/task-chat/task-chat-model";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import {
  interactionThreadAnchorMs,
  isSuppressedThreadInteraction,
} from "@/components/task-chat/interaction-thread-order";
import { shouldHideInteractionCard } from "@/lib/issue-thread-interactions";
import { TaskChatBubbleActions } from "@/components/task-chat/TaskChatBubbleActions";
import type { FeedbackVoteValue } from "@paperclipai/shared";
import { TaskChatThreadView, taskChatContentKey } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { useWindowAutoFollow } from "@/components/task-chat/useWindowAutoFollow";
import { useSidebar } from "@/context/SidebarContext";
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

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

// PAP-462 B4: backstop for how long the just-settled run's transcript stays
// mounted when neither a settled turn nor a reply comment ever arrives to hand
// off to (e.g. a stopped run with no tool activity). Normal completions hand off
// well within this as soon as the settled turn/comment lands.
const SETTLING_TAIL_MAX_MS = 15_000;
const EMPTY_LIVE_ISSUE_IDS: ReadonlySet<string> = new Set<string>();

export type TaskChatThreadProps = ComponentProps<typeof IssueChatThread>;

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
  const {
    comments,
    interactions,
    timelineEvents,
    issueId = null,
    agentMap,
    userLabelMap,
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
    interruptingQueuedRunId,
    blockedBy = [],
    blockerAttention,
    liveIssueIds,
  } = props;

  const liveWorkLinks = useMemo(
    () => issueStatus === "blocked" && blockerAttention?.state === "covered"
      ? resolveTaskChatLiveWork(blockedBy, liveIssueIds ?? EMPTY_LIVE_ISSUE_IDS, blockerAttention.terminalBlocker)
      : null,
    [blockedBy, blockerAttention?.state, blockerAttention?.terminalBlocker, issueStatus, liveIssueIds],
  );

  const blockerLinks = useMemo(
    () => issueStatus === "blocked" && !liveWorkLinks
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

  const threadHeaderWithBlockers = threadHeader || blockerLinks || liveWorkLinks ? (
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

  const bottomBlockerLinks = liveWorkLinks ? (
    <TaskChatLiveWorkLinks liveWork={liveWorkLinks} placement="bottom" />
  ) : blockerLinks ? (
    <TaskChatBlockerLinks
      directBlocker={blockerLinks.directBlocker}
      ultimateBlocker={blockerLinks.ultimateBlocker}
      placement="bottom"
    />
  ) : null;

  const linkedRunMetaById = useMemo(() => {
    const map = new Map<string, NonNullable<TaskChatThreadProps["linkedRuns"]>[number]>();
    for (const run of linkedRuns ?? []) map.set(run.runId, run);
    return map;
  }, [linkedRuns]);

  const commentItems = useMemo(
    () => commentsToTaskChatItems(comments, {
      agentMap,
      userLabelMap,
      currentUserId,
      issueAssigneeAgentId,
    }),
    [comments, agentMap, userLabelMap, currentUserId, issueAssigneeAgentId],
  );

  // Every run we might need a transcript for (history + live), deduped by id.
  const runs = useMemo<RunTranscriptSource[]>(() => {
    const map = new Map<string, RunTranscriptSource>();
    for (const r of linkedRuns ?? []) {
      map.set(r.runId, {
        id: r.runId,
        status: r.status,
        adapterType: r.adapterType ?? "",
        hasStoredOutput: r.hasStoredOutput,
        logBytes: r.logBytes,
      });
    }
    for (const r of liveRuns ?? []) {
      map.set(r.id, {
        id: r.id,
        status: r.status,
        adapterType: r.adapterType,
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
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
      });
    }
    return [...map.values()];
  }, [linkedRuns, liveRuns, activeRun]);

  const { transcriptByRun } = useLiveRunTranscripts({ runs, companyId });

  // The single in-flight run whose turn we stream live (non-terminal).
  const liveRun = useMemo(() => {
    if (isTerminalIssueStatus(issueStatus)) return null;
    if (activeRun && isLiveIssueRun(activeRun, issueStatus)) return activeRun;
    return (liveRuns ?? []).find((r) => isLiveIssueRun(r, issueStatus)) ?? null;
  }, [activeRun, issueStatus, liveRuns]);

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
    return map;
  }, [comments]);

  const { data: planDocument } = useIssuePlanDocument(issueId);

  // Comments, interactions, and the plan-doc marker merged into one
  // chronological backbone (same sort keys and same-run handoff shift as the
  // legacy buildIssueChatMessages), so plan-mode confirmation/question cards
  // land where they happened in the conversation.
  const orderedEntries = useMemo(() => {
    const entries: { ms: number; order: number; id: string; item: TaskChatItem }[] = [];
    // commentsToTaskChatItems skips deleted comments — mirror its filter so the
    // two lists stay index-aligned.
    const visibleComments = comments.filter((comment) => !comment.deletedAt);
    visibleComments.forEach((comment, index) => {
      const item = commentItems[index];
      if (!item) return;
      entries.push({ ms: toMs(comment.createdAt), order: 1, id: item.id, item });
    });
    for (const interaction of interactions ?? []) {
      // Withdrawn/superseded confirmations are retracted calls to action — drop
      // them so a dead card never stacks above the one that replaced it
      // (PAP-416).
      if (isSuppressedThreadInteraction(interaction)) continue;
      // A never-rendered card — a degenerate `ask_user_questions` (e.g. the
      // onboarding `Test / A` placeholder) or a stale sibling superseded by a
      // newer question (PAP-437) — is filtered here so it leaves no empty slot
      // or gap in the ordered backbone (PAP-424, plan from PAP-420).
      if (shouldHideInteractionCard(interaction)) continue;
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
        // A resolved card settles at its resolution time so it never reads
        // above a message written before the user answered (PAP-416); pending
        // cards keep the request-time (handoff/createdAt) slot.
        ms: interactionThreadAnchorMs(interaction, handoffAtMs ?? createdAtMs),
        order: 2,
        id,
        item: { id, kind: "interaction", interaction },
      });
    }
    if (planDocument) {
      const revision = planDocument.latestRevisionNumber ?? 1;
      const id = `plan-doc:${planDocument.latestRevisionId ?? planDocument.id}`;
      entries.push({
        ms: toMs(planDocument.updatedAt),
        order: 0,
        id,
        item: {
          id,
          kind: "marker",
          variant: "turn_boundary",
          label: revision > 1 ? "Plan updated" : "Plan created",
          detail: `rev ${revision} — see the Plan tab`,
        },
      });
    }
    return entries.sort(
      (a, b) => a.ms - b.ms || a.order - b.order || a.id.localeCompare(b.id),
    );
  }, [comments, commentItems, interactions, timelineEvents, linkedRuns, liveRuns, planDocument]);

  // Boolean gate (stable across the host's per-render brief objects) so the
  // heavy assembly memo doesn't recompute on every parent render.
  const hasBrief = Boolean(issueBrief);

  const { items, settledRunIds } = useMemo<{ items: TaskChatItem[]; settledRunIds: Set<string> }>(() => {
    // Runs whose settled turn made it into the assembled thread — the live tail
    // hands off to this as its "the settled turn has rendered" signal (PAP-462
    // B4), so the transcript stays mounted through the settle gap without ever
    // double-rendering beside its own settled turn.
    const settledRunIds = new Set<string>();
    // Settled turns for every terminal run whose transcript we have. Messages
    // and thinking are excluded entirely (PAP-361): the final reply already
    // landed as the run's comment bubble, interstitial updates are ephemeral
    // (live-line only), and thinking stays in the run log / classic
    // transcript — "Worked · N tools" expands to exactly the tool rows.
    const settledTurns: { turn: TaskChatTurnItem; anchorCommentId: string | null; startMs: number }[] = [];
    // Raw summary inputs per turn id, so back-to-back same-agent runs can
    // coalesce into one "Worked" row in the final pass (PAP-362).
    const turnMergeMetaById = new Map<string, SettledTurnMergeMeta>();
    for (const source of runs) {
      if (!isTerminalRunStatus(source.status)) continue;
      if (liveRun && source.id === liveRun.id) continue;
      const entries = transcriptByRun.get(source.id) ?? [];
      if (entries.length === 0) continue;
      const meta = linkedRunMetaById.get(source.id);
      const started = meta?.startedAt ? new Date(meta.startedAt).getTime() : NaN;
      const finished = meta?.finishedAt ? new Date(meta.finishedAt).getTime() : NaN;
      const durationMs =
        Number.isFinite(started) && Number.isFinite(finished)
          ? Math.max(0, finished - started)
          : undefined;
      const parsed = transcriptToTaskChatItems(entries, {
        runId: source.id,
        agentName: meta?.agentName,
        running: false,
      });
      const children = settledRunChildren(parsed);
      if (children.length === 0) continue;
      settledRunIds.add(source.id);
      const failed = source.status !== "succeeded";
      const startSlotRaw = meta?.startedAt ?? meta?.createdAt;
      turnMergeMetaById.set(`${source.id}:turn`, {
        agentKey: meta?.agentId ?? "",
        agentName: meta?.agentName,
        parts: [{ entries, durationMs, failed }],
      });
      settledTurns.push({
        turn: {
          id: `${source.id}:turn`,
          kind: "turn",
          settled: true,
          animateFold: liveSeenRef.current.has(source.id),
          items: children,
          summary: buildTurnSummary(entries, { durationMs, failed }),
        },
        anchorCommentId: lastCommentIdByRun.get(source.id) ?? null,
        // Chronological slot for a turn with no reply comment to anchor to
        // (PAP-367): the run's start time. A run with no linked meta yet
        // (just-settled, list not refetched) sits at the thread tail —
        // where it last rendered as the live turn — until meta arrives.
        startMs: startSlotRaw ? toMs(startSlotRaw) : Number.POSITIVE_INFINITY,
      });
    }
    settledTurns.sort((a, b) => (a.startMs < b.startMs ? -1 : a.startMs > b.startMs ? 1 : 0));

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
    const out = assembleThreadItems(orderedEntries, turnsByAnchor, unanchored);

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
        attachSettledTurns(coalesceSettledTurns(out, turnMergeMetaById), turnMergeMetaById),
        hasBrief,
      ),
      settledRunIds,
    };
  }, [orderedEntries, runs, liveRun, transcriptByRun, linkedRunMetaById, lastCommentIdByRun, hasBrief]);

  // PAP-462 B4: the moment a run settles, `liveRun` flips to null — but its
  // settled turn (or reply comment) can take seconds to arrive on the next
  // comment refetch. Without a handoff the whole transcript unmounts that frame,
  // blinking out already-streamed output before its settled form renders. Snapshot
  // the just-settled run so its now-static transcript stays mounted through the gap.
  const [settlingRun, setSettlingRun] = useState<{ id: string; startedAtMs: number | null } | null>(null);
  const prevLiveRunRef = useRef<typeof liveRun>(null);
  // Layout effect (not passive): snapshot the settled run before the browser
  // paints the `liveRun === null` frame, so the tail never blinks empty for a
  // frame between the run stopping and this snapshot committing.
  useLayoutEffect(() => {
    if (liveRun) {
      prevLiveRunRef.current = liveRun;
      // A fresh live run supersedes any lingering settled remnant.
      setSettlingRun((current) => (current && current.id !== liveRun.id ? null : current));
      return;
    }
    const prev = prevLiveRunRef.current;
    prevLiveRunRef.current = null;
    if (!prev) return;
    setSettlingRun({
      id: prev.id,
      startedAtMs: (prev.startedAt ? toMs(prev.startedAt) : null) ?? toMs(prev.createdAt),
    });
  }, [liveRun]);

  // Hand off once the settled turn or its reply comment is in the thread; a
  // stopped run that yields neither is released by the backstop timeout so the
  // tail never lingers indefinitely.
  const settledRunRendered =
    settlingRun != null &&
    (settledRunIds.has(settlingRun.id) ||
      comments.some((comment) => comment.runId === settlingRun.id && !comment.deletedAt));
  useEffect(() => {
    if (!settlingRun) return;
    if (settledRunRendered) {
      setSettlingRun(null);
      return;
    }
    const timer = window.setTimeout(() => setSettlingRun(null), SETTLING_TAIL_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [settlingRun, settledRunRendered]);

  // The tail streams the live run, or — through the settle gap — the last run's
  // now-static transcript until its settled form renders (PAP-462 B4).
  const showSettlingTail =
    !liveRun &&
    settlingRun != null &&
    !settledRunRendered &&
    (transcriptByRun.get(settlingRun.id)?.length ?? 0) > 0;
  const tailRunId = liveRun ? liveRun.id : showSettlingTail ? settlingRun!.id : null;
  const tailStreaming = Boolean(liveRun);
  const tailEntries = tailRunId ? (transcriptByRun.get(tailRunId) ?? []) : [];
  const tailContentKey = tailEntries.reduce((total, entry) => {
    if ("text" in entry) return total + entry.text.length;
    if ("content" in entry) return total + entry.content.length;
    return total + entry.kind.length;
  }, tailEntries.length);
  const blockerContentKey = blockerLinks
    ? `${blockerLinks.directBlocker.id}:${blockerLinks.ultimateBlocker?.id ?? ""}`
    : liveWorkLinks
      ? `live:${liveWorkLinks.steps.map((step) => `${step.blocker.id}:${step.status}`).join(",")}:${liveWorkLinks.nowRunning.map((blocker) => blocker.id).join(",")}`
      : "";
  const threadContentKey = `${taskChatContentKey(items)}:${tailContentKey}:${blockerContentKey}`;

  // Status-pill inputs for the tail (PAP-461, A1): the run's start, its finish
  // (once terminal), and the "called N tools" summary. Memoized on the
  // transcript content key so the O(n) tool count is not re-walked every render
  // while the pill's own second-tick keeps the elapsed readout moving. Through
  // the settle gap the run reads terminal, so the pill lands on its "Worked"
  // state instead of flipping back to a spinner.
  const settlingFinishedAt = settlingRun ? linkedRunMetaById.get(settlingRun.id)?.finishedAt : undefined;
  const tailStatus = liveRun
    ? liveRun.status
    : runs.find((run) => run.id === settlingRun?.id)?.status ?? "succeeded";
  const tailStartedAtMs = liveRun
    ? (liveRun.startedAt ? toMs(liveRun.startedAt) : null) ?? toMs(liveRun.createdAt)
    : settlingRun?.startedAtMs ?? null;
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
  const tailAgentName = liveRun?.agentName ?? linkedRunMetaById.get(tailRunId ?? "")?.agentName;
  const tailItems = useMemo(
    () =>
      tailRunId
        ? transcriptToTaskChatItems(tailEntries, {
            runId: tailRunId,
            agentName: tailAgentName,
            running: tailStreaming,
          })
        : [],
    // tailEntries is a fresh array each render; tailContentKey tracks its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tailRunId, tailContentKey, tailStreaming, tailAgentName],
  );

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
    [onVote, feedbackVoteByTargetId, feedbackDataSharingPreference, feedbackTermsUrl],
  );

  const renderQueuedAction = useCallback(
    (item: TaskChatMessageItem) => {
      const runId = item.queueTargetRunId;
      if (item.optimistic !== "queued" || !runId || !onInterruptQueued) return null;

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
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        onAcceptInteraction={onAcceptInteraction}
        onRejectInteraction={onRejectInteraction}
        onSubmitInteractionAnswers={onSubmitInteractionAnswers}
        onCancelInteraction={onCancelInteraction}
        onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
        onUploadImage={imageUploadHandler}
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
      externalReferences,
    ],
  );

  // Mobile (PAP-360): the app shell scrolls the DOCUMENT (Layout's main is
  // overflow-visible with auto height), so the desktop bounded h-dvh chain
  // collapses the absolute-inset transcript viewport to 0px. Render the thread
  // in document flow instead (the same scroll={false} path the previews use)
  // and track auto-follow against window scroll. Desktop stays byte-identical.
  const { isMobile } = useSidebar();
  useWindowAutoFollow(isMobile ? threadContentKey : 0, isMobile);

  return (
    <div
      className={cn("flex flex-col", !isMobile && "h-(--tc-thread-max-h) min-h-0 flex-1")}
      data-testid="task-chat-thread"
    >
      <div className={cn("flex flex-col", !isMobile && "min-h-0 flex-1")}>
        {items.length === 0 && !tailRunId ? (
          <div className={isMobile ? undefined : "min-h-0 flex-1 overflow-y-auto"}>
            {threadHeaderWithBlockers ? (
              <div
                className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-6 px-4 pt-4"
                data-testid="task-chat-thread-header"
              >
                {threadHeaderWithBlockers}
              </div>
            ) : null}
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div>
            {bottomBlockerLinks ? (
              <div className="mx-auto w-full max-w-(--tc-shell-max-w) px-4 pb-4">
                {bottomBlockerLinks}
              </div>
            ) : null}
          </div>
        ) : (
          <TaskChatThreadView
            items={items}
            header={threadHeaderWithBlockers}
            renderInteraction={renderInteraction}
            renderBrief={issueBrief ? () => <TaskChatDescriptionBubble brief={issueBrief} /> : undefined}
            renderMessageActions={renderMessageActions}
            renderQueuedAction={renderQueuedAction}
            tail={tailRunId || bottomBlockerLinks ? (
              <>
                {tailRunId ? (
                  <div data-testid="task-chat-live-transcript">
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
                          : "Waiting for transcript..."
                      }
                    />
                  </div>
                ) : null}
                {bottomBlockerLinks}
              </>
            ) : null}
            contentKey={threadContentKey}
            scroll={!isMobile}
          />
        )}
      </div>
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
            "mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-2 bg-background/80 px-4 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60",
          )}
        >
          {composerAccessory}
          <TaskChatComposer
            onAdd={onAdd}
            workMode={issueWorkMode}
            onWorkModeChange={onWorkModeChange}
            disabled={Boolean(composerDisabledReason)}
            disabledReason={composerDisabledReason}
            onAttachImage={onAttachImage}
            onImageUpload={imageUploadHandler}
            mentions={mentions}
            enableReassign={enableReassign}
            reassignOptions={reassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            issueStatus={issueStatus}
            mobile={isMobile}
            draftKey={draftKey}
          />
          {footer}
        </div>
      ) : null}
    </div>
  );
}
