import { t, useTranslation } from "@/i18n";
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
import { TaskChatComposerBar } from "./TaskChatComposerBar";
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
}

function SortableQueuedMessage({
  entry,
  queue,
  busy,
  queueMutationDisabled,
  action,
  onEdit,
  onSteer,
  onInterrupt,
  onDiscard,
}: {
  entry: IssueQueuedCommentEntry;
  queue: IssueQueuedCommentQueue;
  busy: boolean;
  queueMutationDisabled: boolean;
  action: QueueAction;
  onEdit: () => void;
  onSteer: () => void;
  onInterrupt?: () => void;
  onDiscard: () => void;
}) {
  useTranslation("task-components");
  const immutableResponse = entry.source?.kind === "interaction";
  const label = immutableResponse ? entry.comment.body.split("\n")[0] : entry.comment.body;
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
      ? t("task-chat-ui:steeringUnsupported")
      : queue.steeringDisposition === "temporarily_unavailable"
        ? t("task-chat-ui:steeringUnavailable")
        : t("task-chat-ui:steerMessage");

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex h-11 min-w-0 items-center gap-1 border-b border-border/55 bg-card/95 px-2.5 text-sm last:border-b-0",
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
        aria-label={t("task-components:reorderQueuedMessage_7545abd2", { value1: entry.comment.body })}
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      <CornerDownRight
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate px-1" title={entry.comment.body}>
        {label}
      </span>

      {(queue.targetRunId || queue.state === "deferred") && (!queue.targetRunId || queue.protocol === "legacy" || entry.source?.requiresFreshSession ? (
        <button
          type="button"
          onClick={onInterrupt}
          aria-label={!queue.targetRunId ? t("task-chat-ui:sendQueued") : undefined}
          disabled={busy || !queue.queueId || !onInterrupt}
          title={queue.targetRunId ? t("task-components:interruptTheActiveTurnAndSendQueued_1f9a3486") : t("task-components:sendQueuedMessagesNow_2c78b046")}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          data-testid={`task-chat-queued-interrupt-${entry.comment.id}`}
        >
          {action === "interrupt" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {queue.targetRunId ? t("task-components:interrupt_b6252314") : t("task-components:send_f6f4688f")}
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
          )}{t("task-components:steer_1cf39ed4")}</button>
      ))}

      <button
        type="button"
        onClick={onDiscard}
        disabled={
          busy ||
          (!queue.queueId && !entry.comment.id.startsWith("optimistic-")) ||
          !entry.canDiscard
        }
        title={t("task-components:discardQueuedMessage_eb289c4f")}
        aria-label={t("task-components:discardQueuedMessage_cc541e13", { value1: entry.comment.body })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        data-testid={`task-chat-queued-discard-${entry.comment.id}`}
      >
        {action === "discard" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={queueMutationDisabled || immutableResponse}
            title={t("task-components:queuedMessageActions_85ac386e")}
            aria-label={t("task-components:queuedMessageActions_cec6b5af", { value1: entry.comment.body })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={!entry.canEdit} onSelect={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden />{t("task-components:editMessage_9757ccd5")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
}: TaskChatQueuedMessagesProps) {
  useTranslation("task-components");
  const [entries, setEntries] = useState(queue.entries);
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
  const [deferredStatus, setDeferredStatus] = useState<{ queueId: string | null; message: string | null } | null>(null);
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
      const message = queue.executionWait?.message ?? null;
      return current.message === message ? current : { ...current, message };
    });
  }, [queue.state, queue.queueId, queue.entries.length, queue.executionWait?.message]);

  const ids = useMemo(
    () => entries.map((entry) => entry.comment.id),
    [entries],
  );

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
      t("task-chat-ui:queueMoved", { position: to + 1, total: next.length }),
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
        ? t("task-chat-ui:steeringQueue")
        : action === "interrupt"
          ? t("task-chat-ui:sendingQueue")
          : t("task-chat-ui:discardingQueue"),
    );
    try {
      if (action === "steer") await onSteer(commentId, queue.revision);
      else if (action === "interrupt") {
        const updatedQueue = await onInterrupt?.();
        if (updatedQueue?.state === "deferred") {
          for (const entry of updatedQueue.entries) optimisticDeliveryIds.current.delete(entry.comment.id);
          setEntries(updatedQueue.entries.filter(entry => !optimisticDeliveryIds.current.has(entry.comment.id)));
          setDeferredStatus({ queueId: updatedQueue.queueId, message: updatedQueue.executionWait?.message ?? null });
          setAnnouncement(t("task-chat-ui:stillQueued"));
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
          ? t("task-chat-ui:messageSteered")
          : action === "interrupt"
            ? queue.targetRunId
              ? t("task-chat-ui:queueAfterStop")
              : "Queued messages submitted. Waiting for the agent."
            : t("task-chat-ui:messageDiscarded"),
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

  if (entries.length === 0 && !visibleError && !deferredStatus) return null;

  return (
    <TaskChatComposerBar
      data-testid="task-chat-queued-messages"
      aria-label={t("task-components:queuedMessages_f8e64a37")}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
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
        </SortableContext>
      </DndContext>
      {deferredStatus ? <p role="status" className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{deferredStatus.message ?? t("final-components-b:Messages_are_still_queued_They_will_send_when_the_task_is_ready_470af6")}</p> : null}
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
