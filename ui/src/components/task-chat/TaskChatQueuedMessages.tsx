import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CornerDownRight,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  IssueQueuedCommentEntry,
  IssueQueuedCommentQueue,
} from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import { extractImageRefs, stripStandaloneImageEmbeds } from "./task-chat-attachments";
import { TaskChatComposerBar } from "./TaskChatComposerBar";
import {
  queuedMessageAutoSteerDeadline,
  queuedMessageAutoSteerEligible,
  queuedMessageAutoSteerKey,
} from "./queued-message-auto-steer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type QueueAction = "steer" | "interrupt" | "discard" | null;

export function reorderQueuedMessageEntries(
  entries: IssueQueuedCommentEntry[],
  activeId: string,
  overId: string,
) {
  if (entries.some((entry) => entry.source?.kind === "interaction")) return null;
  const from = entries.findIndex((entry) => entry.comment.id === activeId);
  const to = entries.findIndex((entry) => entry.comment.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(entries, from, to).map((entry, position) => ({
    ...entry,
    position,
  }));
}

/**
 * People see one readable line. A saved card response also carries a typed
 * JSON receipt for the agent; it never reaches a label or a hover.
 */
export function queuedMessageLabel(entry: IssueQueuedCommentEntry): string {
  if (entry.source?.kind !== "interaction") return entry.comment.body;
  const summary = entry.source.summary?.trim();
  return summary || entry.comment.body.split("\n")[0] || "Saved response";
}

function queueActionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const directCode = (body as { code?: unknown }).code;
  if (typeof directCode === "string") return directCode;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const detailCode = (details as { code?: unknown }).code;
  return typeof detailCode === "string" ? detailCode : null;
}

export interface TaskChatQueuedMessagesProps {
  queue: IssueQueuedCommentQueue;
  onEdit: (commentId: string) => void;
  onReorder: (orderedCommentIds: string[], revision: string) => Promise<void>;
  onSteer: (commentId: string, revision: string) => Promise<void>;
  onInterrupt?: () => Promise<IssueQueuedCommentQueue | void>;
  onDiscard: (commentId: string, revision: string) => Promise<void>;
  /** The queued message open in the editor; its automatic send waits for the save. */
  editingCommentId?: string | null;
  /** Steer eligible queued messages automatically after this delay; null keeps every message queued. */
  autoSteerDelayMs?: number | null;
}

function SortableQueuedMessage({
  entry,
  queue,
  busy,
  queueMutationDisabled,
  action,
  autoSteerSecondsLeft,
  onEdit,
  onSteer,
  onInterrupt,
  onDiscard,
  onCancelAutoSteer,
}: {
  entry: IssueQueuedCommentEntry;
  queue: IssueQueuedCommentQueue;
  busy: boolean;
  queueMutationDisabled: boolean;
  action: QueueAction;
  /** Seconds until this message is steered automatically, or null when it waits in the queue. */
  autoSteerSecondsLeft: number | null;
  onEdit: () => void;
  onSteer: () => void;
  onInterrupt?: () => void;
  onDiscard: () => void;
  onCancelAutoSteer: () => void;
}) {
  const immutableResponse = entry.source?.kind === "interaction";
  const body = queuedMessageLabel(entry);
  const images = extractImageRefs(body).filter(image =>
    /^\/api\/(?:attachments|assets)\/[^/?#\\]+\/content(?:\?[^#\\]*)?$/.test(image.url));
  const label = stripStandaloneImageEmbeds(body);
  const sortable = useSortable({
    id: entry.comment.id,
    disabled: queueMutationDisabled || immutableResponse,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const steerDisabled =
    queueMutationDisabled || queue.steeringDisposition !== "available";
  const steerTitle =
    queue.steeringDisposition === "unsupported"
      ? "This runner does not support steering"
      : queue.steeringDisposition === "temporarily_unavailable"
        ? "Steering is temporarily unavailable"
        : "Steer this message into the active turn";

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex min-h-11 min-w-0 flex-wrap items-center gap-1 border-b border-border/55 bg-card/95 px-2.5 py-1 text-sm last:border-b-0",
        sortable.isDragging &&
          "relative z-20 rounded-lg border border-border shadow-lg",
      )}
      data-testid={`task-chat-queued-message-${entry.comment.id}`}
    >
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={queueMutationDisabled || immutableResponse}
        aria-label={`Reorder queued message: ${label || "Images"}`}
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      <CornerDownRight
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="flex min-w-24 max-w-full flex-1 flex-col items-start gap-1 overflow-hidden px-1 sm:flex-row sm:items-center sm:gap-2" title={label || undefined}>
        {label ? <MarkdownBody
          className="w-full min-w-0 line-clamp-2 sm:w-auto sm:flex-1 sm:line-clamp-1 [&_p]:m-0!"
          linkIssueReferences={false}
          mediaMode="omit"
        >{label}</MarkdownBody> : null}
        {images.length ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" role="group" aria-label="Queued images">
          {images.slice(0, 3).map(image => <img
            key={image.url} src={image.url} alt={image.name} loading="lazy"
            className="size-8 shrink-0 rounded-md border border-border object-cover"
          />)}
          {images.length > 3 ? <span className="text-xs text-muted-foreground">+{images.length - 3}</span> : null}
        </div> : null}
      </div>

      {autoSteerSecondsLeft !== null ? (
        <span className="flex shrink-0 items-center gap-1" data-testid={`task-chat-queued-auto-steer-${entry.comment.id}`}>
          <span className="px-1 text-xs text-muted-foreground tabular-nums">
            Sending in {autoSteerSecondsLeft}s
          </span>
          <button
            type="button"
            onClick={onEdit}
            disabled={!entry.canEdit}
            title="Edit before it is sent"
            className="flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            data-testid={`task-chat-queued-auto-steer-edit-${entry.comment.id}`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onCancelAutoSteer}
            title="Keep this message in the queue"
            className="flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            data-testid={`task-chat-queued-auto-steer-cancel-${entry.comment.id}`}
          >
            Cancel
          </button>
        </span>
      ) : (queue.targetRunId || queue.state === "deferred") && (!queue.targetRunId || queue.protocol === "legacy" || entry.source?.requiresFreshSession ||
        (queue.steeringDisposition !== "available" && onInterrupt) ? (
        <button
          type="button"
          onClick={onInterrupt}
          aria-label={!queue.targetRunId ? "Send queued messages" : undefined}
          disabled={busy || !queue.queueId || !onInterrupt}
          title={queue.targetRunId ? "Interrupt the active turn and send queued messages" : "Send queued messages now"}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          data-testid={`task-chat-queued-interrupt-${entry.comment.id}`}
        >
          {action === "interrupt" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {queue.targetRunId ? "Interrupt" : "Send"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onSteer}
          disabled={steerDisabled}
          title={steerTitle}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          data-testid={`task-chat-queued-steer-${entry.comment.id}`}
        >
          {action === "steer" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          Steer
        </button>
      ))}

      <button
        type="button"
        onClick={onDiscard}
        disabled={
          busy ||
          (!queue.queueId && !entry.comment.id.startsWith("optimistic-")) ||
          !entry.canDiscard
        }
        title="Discard queued message"
        aria-label={`Discard queued message: ${label}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        data-testid={`task-chat-queued-discard-${entry.comment.id}`}
      >
        {action === "discard" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      {autoSteerSecondsLeft === null ? <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={queueMutationDisabled || immutableResponse}
            title="Queued message actions"
            aria-label={`Queued message actions: ${label}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={!entry.canEdit} onSelect={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden />
            Edit message
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu> : null}
    </div>
  );
}

/** Compact production queue shown immediately above the default task composer. */
export function TaskChatQueuedMessages({
  queue,
  onEdit,
  onReorder,
  onSteer,
  onInterrupt,
  onDiscard,
  editingCommentId = null,
  autoSteerDelayMs = null,
}: TaskChatQueuedMessagesProps) {
  const [entries, setEntries] = useState(queue.entries);
  // Automatic steering: Cancel keeps a message queued for this view; each
  // message revision gets at most one automatic attempt, so a failure falls
  // back to the ordinary queue instead of retrying in a loop.
  const [cancelledAutoSteer, setCancelledAutoSteer] = useState<ReadonlySet<string>>(() => new Set());
  const attemptedAutoSteer = useRef(new Set<string>());
  // Recomputes the deadlines after an attempt; the set itself is a ref.
  const [autoSteerAttempts, setAutoSteerAttempts] = useState(0);
  // First time this view offered each message revision for automatic steering.
  const firstEligibleAt = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const latestQueue = useRef(queue);
  latestQueue.current = queue;
  const optimisticDeliveryIds = useRef(new Set<string>());
  const [pending, setPending] = useState<{
    commentId: string;
    action: Exclude<QueueAction, null>;
  } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const [deferredStatus, setDeferredStatus] = useState<{ queueId: string | null; message: string } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    // Polling can return the old queue while delivery is still in flight.
    setEntries(queue.entries.filter(
      (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
    ));
  }, [queue.entries, queue.revision]);

  useEffect(() => {
    setDeferredStatus(current => {
      if (!current) return null;
      if (queue.state !== "deferred" || queue.queueId !== current.queueId || !queue.entries.length) return null;
      const message = queue.executionWait?.message ?? "Messages are still queued. They will send when the task is ready.";
      return current.message === message ? current : { ...current, message };
    });
  }, [queue.state, queue.queueId, queue.entries.length, queue.executionWait?.message]);

  const ids = useMemo(
    () => entries.map((entry) => entry.comment.id),
    [entries],
  );

  // Send decisions read the current queue snapshot, not the local copy that a
  // sync effect updates one render later: a saved edit must get its new
  // revision's full window, not the old revision's deadline.
  const autoSteerEntries = useMemo(
    () => queue.entries.filter((entry) => !optimisticDeliveryIds.current.has(entry.comment.id)),
    [queue.entries],
  );
  const autoSteerDeadlines = useMemo(() => {
    const deadlines = new Map<string, number>();
    if (autoSteerDelayMs === null) return deadlines;
    for (const entry of autoSteerEntries) {
      if (queuedMessageAutoSteerEligible({ queue, entry, cancelledIds: cancelledAutoSteer,
        attemptedKeys: attemptedAutoSteer.current, editingCommentId })) {
        const key = queuedMessageAutoSteerKey(entry);
        if (!firstEligibleAt.current.has(key)) firstEligibleAt.current.set(key, Date.now());
        deadlines.set(entry.comment.id, queuedMessageAutoSteerDeadline(entry, firstEligibleAt.current.get(key)!, autoSteerDelayMs));
      }
    }
    return deadlines;
  }, [autoSteerEntries, queue, cancelledAutoSteer, editingCommentId, autoSteerDelayMs, autoSteerAttempts]);

  // Announce a new countdown once; the ticking text itself is not a live region.
  const announcedCountdowns = useRef(new Set<string>());
  useEffect(() => {
    const fresh = [...autoSteerDeadlines.keys()].filter(id => !announcedCountdowns.current.has(id));
    for (const id of fresh) announcedCountdowns.current.add(id);
    if (fresh.length) setAnnouncement("Queued message will be sent into the active turn in a few seconds. Edit or Cancel to keep it.");
  }, [autoSteerDeadlines]);

  // Tick only while a countdown is visible.
  useEffect(() => {
    if (autoSteerDeadlines.size === 0) return;
    // A countdown that restarts after an edit must not read a clock that stopped while it paused.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [autoSteerDeadlines.size]);

  useEffect(() => {
    if (pending || reordering) return;
    const due = autoSteerEntries.find(entry => {
      const deadline = autoSteerDeadlines.get(entry.comment.id);
      // The deadlines memo does not see these refs change; check them here.
      return deadline !== undefined && deadline <= now
        && !attemptedAutoSteer.current.has(queuedMessageAutoSteerKey(entry))
        && !optimisticDeliveryIds.current.has(entry.comment.id);
    });
    if (!due) return;
    attemptedAutoSteer.current.add(queuedMessageAutoSteerKey(due));
    setAutoSteerAttempts((count) => count + 1);
    void runRowAction(due.comment.id, "steer");
  });

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (
      !queue.queueId ||
      !over ||
      active.id === over.id ||
      reordering ||
      pending
    )
      return;
    const previous = entries;
    const next = reorderQueuedMessageEntries(
      entries,
      String(active.id),
      String(over.id),
    );
    if (!next) return;
    const orderedIds = next.map((entry) => entry.comment.id);
    const activeCommentId = String(active.id);
    const to = next.findIndex((entry) => entry.comment.id === activeCommentId);
    setEntries(next);
    setReordering(true);
    setVisibleError(null);
    setAnnouncement(
      `Moved queued message to position ${to + 1} of ${next.length}.`,
    );
    try {
      await onReorder(orderedIds, queue.revision);
    } catch (error) {
      setEntries(previous);
      setAnnouncement("");
      setVisibleError(
        queueActionErrorCode(error) === "queued_comment_revision_conflict"
          ? "The queue changed in another session. Its latest order has been restored."
          : "Couldn’t reorder. Previous order restored.",
      );
    } finally {
      setReordering(false);
    }
  }

  async function runRowAction(
    commentId: string,
    action: Exclude<QueueAction, null>,
  ) {
    const locallyDiscardable =
      action === "discard" && commentId.startsWith("optimistic-");
    if (
      pending ||
      reordering ||
      (!queue.queueId && action !== "interrupt" && !locallyDiscardable)
    ) {
      return;
    }
    const deliveredIds = action === "interrupt"
      ? entries.map((entry) => entry.comment.id)
      : action === "steer" ? [commentId] : [];
    for (const id of deliveredIds) optimisticDeliveryIds.current.add(id);
    if (deliveredIds.length) {
      setEntries((current) => current.filter(
        (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
      ));
    }
    setPending({ commentId, action });
    setVisibleError(null); setDeferredStatus(null);
    setAnnouncement(
      action === "steer"
        ? "Steering queued message."
        : action === "interrupt"
          ? "Sending queued messages."
          : "Discarding queued message.",
    );
    try {
      if (action === "steer") await onSteer(commentId, queue.revision);
      else if (action === "interrupt") {
        const updatedQueue = await onInterrupt?.();
        if (updatedQueue?.state === "deferred") {
          for (const entry of updatedQueue.entries) optimisticDeliveryIds.current.delete(entry.comment.id);
          setEntries(updatedQueue.entries.filter(entry => !optimisticDeliveryIds.current.has(entry.comment.id)));
          setDeferredStatus({ queueId: updatedQueue.queueId, message: updatedQueue.executionWait?.message ?? "Messages are still queued. They will send when the task is ready." });
          setAnnouncement("Messages are still queued.");
          return;
        }
      }
      else await onDiscard(commentId, queue.revision);
      if (action === "discard") {
        setEntries((current) =>
          current.filter((entry) => entry.comment.id !== commentId),
        );
      }
      setAnnouncement(
        action === "steer"
          ? "Message steered into the active turn."
          : action === "interrupt"
            ? queue.targetRunId
              ? "Queued messages will be sent when the previous run has stopped."
              : "Queued messages submitted. Waiting for the agent."
            : "Queued message discarded.",
      );
    } catch (error) {
      for (const id of deliveredIds) optimisticDeliveryIds.current.delete(id);
      if (deliveredIds.length) {
        setEntries(latestQueue.current.entries.filter(
          (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
        ));
      }
      setAnnouncement("");
      const code = queueActionErrorCode(error);
      setVisibleError(
        code === "queued_comment_already_dispatching"
          ? "Too late to discard: this message is already being sent."
          : action === "steer"
            ? "Couldn’t steer. Message is still queued."
            : action === "interrupt"
              ? queue.targetRunId ? "Couldn’t interrupt. Message is still queued." : "Couldn’t send. Message is still queued."
              : code === "queued_comment_revision_conflict"
                ? "The queue changed in another session. Review it and try again."
                : "Couldn’t discard. Message is still queued.",
      );
    } finally {
      setPending(null);
    }
  }

  // A chat message held in the outbox (for example by the agent's daily
  // limit) has no receipt or run whose task status could explain the wait,
  // so the queue says why it waits. Receipt-backed waits keep the task status.
  const statusMessage = deferredStatus?.message
    ?? (queue.state === "deferred" && !queue.queueId && !queue.targetRunId && entries.length > 0
      ? queue.executionWait?.message ?? null : null);

  if (entries.length === 0 && !visibleError && !statusMessage) return null;

  return (
    <TaskChatComposerBar
      data-testid="task-chat-queued-messages"
      aria-label="Queued messages"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {/* Bounded so a long queue scrolls here instead of covering the conversation. */}
          <div
            className="max-h-(--tc-queued-list-max-h) overflow-y-auto overscroll-contain"
            data-testid="task-chat-queued-messages-list"
          >
          {entries.map((entry) => {
            const action =
              pending?.commentId === entry.comment.id ? pending.action : null;
            const busy = Boolean(pending || reordering);
            const queueMutationDisabled = Boolean(
              !queue.queueId || pending || reordering,
            );
            return (
              <SortableQueuedMessage
                key={entry.comment.id}
                entry={entry}
                queue={queue}
                busy={busy}
                queueMutationDisabled={queueMutationDisabled}
                action={action}
                autoSteerSecondsLeft={(() => {
                  const deadline = autoSteerDeadlines.get(entry.comment.id);
                  return deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
                })()}
                onCancelAutoSteer={() => setCancelledAutoSteer(current => new Set(current).add(entry.comment.id))}
                onEdit={() => onEdit(entry.comment.id)}
                onSteer={() => void runRowAction(entry.comment.id, "steer")}
                onInterrupt={
                  onInterrupt
                    ? () => void runRowAction(entry.comment.id, "interrupt")
                    : undefined
                }
                onDiscard={() => void runRowAction(entry.comment.id, "discard")}
              />
            );
          })}
          </div>
        </SortableContext>
      </DndContext>
      {statusMessage ? <p role="status" className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{statusMessage}</p> : null}
      {visibleError ? (
        <div
          role="status"
          aria-live="polite"
          className="border-t border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </TaskChatComposerBar>
  );
}
