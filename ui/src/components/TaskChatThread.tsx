import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import { IssueChatThread } from "@/components/IssueChatThread";
import { useLiveRunTranscripts, type RunTranscriptSource } from "@/components/transcript/useLiveRunTranscripts";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import {
  assembleThreadItems,
  attachSettledTurns,
  buildTurnSummary,
  coalesceSettledTurns,
  deriveRunStatusLabel,
  isNestableLiveChild,
  isTerminalRunStatus,
  prependIssueBrief,
  settledRunChildren,
  transcriptToTaskChatItems,
  type SettledTurnMergeMeta,
} from "@/components/task-chat/transcript-adapter";
import { TaskChatDescriptionBubble } from "@/components/task-chat/TaskChatDescriptionBubble";
import type {
  TaskChatInteractionItem,
  TaskChatItem,
  TaskChatTurnItem,
} from "@/components/task-chat/task-chat-model";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatThreadView, taskChatContentKey } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { useWindowAutoFollow } from "@/components/task-chat/useWindowAutoFollow";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { latestSameRunHandoffTimestamp, type IssueChatComment } from "@/lib/issue-chat-messages";
import { workModeInEffectAt } from "@/lib/issue-timeline-events";
import { workModeMetaFor } from "@/lib/work-mode-meta";

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export type TaskChatThreadProps = ComponentProps<typeof IssueChatThread>;

/**
 * Task Chat Redesign thread (experimental flag: `enableTaskChatRedesign`).
 *
 * Renders the redesigned, Claude-Code-style thread for the live task. It shares
 * IssueChatThread's exact prop type — so the IssueDetail seam ternary
 * (`redesign ? TaskChatThread : IssueChatThread`) type-checks with no casts.
 *
 * Two data sources feed the render layer, both reused from the existing thread:
 *   - the comment stream (incl. optimistic echoes) → author-typed bubbles, and
 *   - the live run transcript (useLiveRunTranscripts, the same poll+websocket
 *     source the current thread uses) → the in-flight turn streams
 *     thinking → tool → diff → responding, capped by a live "running" status
 *     pill.
 *
 * Run activity is grouped into TaskChatTurnItem: the in-flight run renders as
 * ONE expandable parent row — its status line (whimsy gerund or in-flight
 * tool state + elapsed + tokens) is the turn's single visible line, with the
 * chronological tool activity nested behind an expand (PAP-354). Mid-run
 * agent text (interstitial updates between tool calls) is ephemeral
 * (PAP-361, round 9): while one streams it occupies a dedicated one-line row
 * PERMANENTLY RESERVED above the status line (so the layout above never
 * jumps), and when it finishes the text slides out and the slot sits empty —
 * nothing persists; the run log and the classic transcript remain the
 * archive. When the run terminates, its settled turn anchors after the run's
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
    onAcceptInteraction,
    onRejectInteraction,
    onSubmitInteractionAnswers,
    onCancelInteraction,
    onSubmitInteractionVerdicts,
    externalReferences,
    threadHeader,
    workModeChanges,
    issueBrief,
  } = props;

  const linkedRunMetaById = useMemo(() => {
    const map = new Map<string, NonNullable<TaskChatThreadProps["linkedRuns"]>[number]>();
    for (const run of linkedRuns ?? []) map.set(run.runId, run);
    return map;
  }, [linkedRuns]);

  // Each agent reply is tagged with the mode its request ran under: the
  // issue's work mode at the reply's run start (comment.runId linkage),
  // reconstructed from the activity feed's work-mode switch history — not the
  // issue's current mode, which the user may have changed since.
  const agentModeLabelFor = useCallback(
    (comment: IssueChatComment) => {
      const runMeta = comment.runId ? linkedRunMetaById.get(comment.runId) : undefined;
      const atMs = toMs(runMeta?.startedAt ?? runMeta?.createdAt ?? comment.createdAt);
      return workModeMetaFor(workModeInEffectAt(workModeChanges ?? [], atMs, issueWorkMode)).label;
    },
    [linkedRunMetaById, workModeChanges, issueWorkMode],
  );
  const commentItems = useMemo(
    () => commentsToTaskChatItems(comments, { agentMap, userLabelMap, currentUserId, agentModeLabelFor }),
    [comments, agentMap, userLabelMap, currentUserId, agentModeLabelFor],
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
    if (activeRun && !isTerminalRunStatus(activeRun.status)) return activeRun;
    return (liveRuns ?? []).find((r) => !isTerminalRunStatus(r.status)) ?? null;
  }, [activeRun, liveRuns]);

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
        ms: handoffAtMs ?? createdAtMs,
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

  const items = useMemo<TaskChatItem[]>(() => {
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

    if (liveRun) {
      const entries = transcriptByRun.get(liveRun.id) ?? [];
      const parsed = transcriptToTaskChatItems(entries, {
        runId: liveRun.id,
        agentName: liveRun.agentName,
        running: true,
      });
      // Parent-row model (PAP-354): the run's status line IS the live turn —
      // one expandable row owning the activity. Only tool/usage rows nest
      // inside it; a streaming interstitial update renders in the reserved row
      // above the status line (liveStatus.selfTalk, PAP-361/round 9) and
      // vanishes when it completes. The parent row sits last; on settle its
      // summary attaches to the reply bubble's timestamp line.
      const children = parsed.filter(isNestableLiveChild);
      const startedAt = liveRun.startedAt ? new Date(liveRun.startedAt).getTime() : null;
      const queued = liveRun.status === "queued";
      const status = queued
        ? { label: "Queued", detail: "Waiting to start", toolName: undefined, selfTalk: undefined }
        : deriveRunStatusLabel(entries);
      out.push({
        id: `${liveRun.id}:turn`,
        kind: "turn",
        settled: false,
        items: children,
        summary: buildTurnSummary(entries),
        liveStatus: {
          id: `${liveRun.id}:status`,
          kind: "status",
          status: "running",
          label: status.label,
          detail: status.detail,
          toolName: status.toolName,
          selfTalk: status.selfTalk,
          startedAtMs: startedAt ?? undefined,
        },
      });
    }
    // PAP-362: two runs replying back-to-back (same agent, nothing but the
    // agent's own bubbles between) fold into ONE "Worked" row below the last
    // reply; a user message, interaction, or the live turn keeps them apart.
    // Round 9: a settled turn directly following its own agent's reply bubble
    // then attaches to that bubble — the "Worked · …" summary renders on the
    // bubble's always-visible timestamp line instead of as a standalone row.
    // PAP-375: the description-as-first-bubble placeholder prepends LAST, after
    // every assembly/merge pass, so nothing can ever sort above it.
    return prependIssueBrief(
      attachSettledTurns(coalesceSettledTurns(out, turnMergeMetaById), turnMergeMetaById),
      hasBrief,
    );
  }, [orderedEntries, runs, liveRun, transcriptByRun, linkedRunMetaById, lastCommentIdByRun, hasBrief]);

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
  useWindowAutoFollow(isMobile ? taskChatContentKey(items) : 0, isMobile);

  return (
    <div
      className={cn("flex flex-col", !isMobile && "h-(--tc-thread-max-h) min-h-0 flex-1")}
      data-testid="task-chat-thread"
    >
      <div className={cn("flex flex-col", !isMobile && "min-h-0 flex-1")}>
        {items.length === 0 ? (
          <div className={isMobile ? undefined : "min-h-0 flex-1 overflow-y-auto"}>
            {threadHeader ? (
              <div
                className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-6 px-4 pt-4"
                data-testid="task-chat-thread-header"
              >
                {threadHeader}
              </div>
            ) : null}
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div>
          </div>
        ) : (
          <TaskChatThreadView
            items={items}
            header={threadHeader}
            renderInteraction={renderInteraction}
            renderBrief={issueBrief ? () => <TaskChatDescriptionBubble brief={issueBrief} /> : undefined}
            scroll={!isMobile}
          />
        )}
      </div>
      {showComposer ? (
        <div
          className={cn(
            "sticky",
            // Mobile mirrors the flag-off thread's dock: lifted above the
            // safe-area inset (and clear of the auto-hiding bottom nav), above
            // page content in the document-flow stacking context.
            isMobile ? "bottom-(--sz-calc-8) z-20" : "bottom-0 z-10",
            "mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-2 bg-background/80 px-1 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60",
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
          />
          {footer}
        </div>
      ) : null}
    </div>
  );
}
