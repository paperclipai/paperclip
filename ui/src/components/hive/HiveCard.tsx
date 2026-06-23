import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import { Link } from "@/lib/router";
import { CircleStop, Trash2, Ban, RotateCcw } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { PriorityIcon } from "../PriorityIcon";
import { Identity } from "../Identity";
import { issuesApi } from "../../api/issues";
import { heartbeatsApi } from "../../api/heartbeats";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { GateBadgeRow } from "./GateBadgeRow";

interface HiveCardProps {
  issue: Issue;
  companyId: string | null;
  agentName?: (id: string | null) => string | null;
  isLive?: boolean;
  liveRunId?: string | null;
  isOverlay?: boolean;
}

// A task card. Surfaces the runaway controls the old UI buried: Stop (cancel the
// live run), Cancel (move to cancelled), Delete (remove). Blocked tasks get a
// badge; in_review tasks that bounced back show a loopback chip.
export function HiveCard({
  issue,
  companyId,
  agentName,
  isLive,
  liveRunId,
  isOverlay,
}: HiveCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: { issue },
  });

  const invalidate = () => {
    if (companyId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
  };

  const stopRun = useMutation({
    mutationFn: async () => {
      if (!liveRunId) return { ran: false };
      await heartbeatsApi.cancel(liveRunId);
      return { ran: true };
    },
    onSuccess: (r) => {
      pushToast(
        r.ran
          ? { title: "Stopping run", body: "Cancel signal sent to the agent.", tone: "success" }
          : { title: "Nothing running", body: "No active run on this task.", tone: "info" },
      );
      invalidate();
    },
    onError: (e) =>
      pushToast({ title: "Stop failed", body: errMsg(e), tone: "error" }),
  });

  const cancelIssue = useMutation({
    mutationFn: () => issuesApi.update(issue.id, { status: "cancelled" }),
    onSuccess: () => {
      pushToast({ title: "Task cancelled", tone: "success" });
      invalidate();
    },
    onError: (e) => pushToast({ title: "Cancel failed", body: errMsg(e), tone: "error" }),
  });

  const deleteIssue = useMutation({
    mutationFn: () => issuesApi.remove(issue.id),
    onSuccess: () => {
      pushToast({ title: "Task deleted", tone: "success" });
      setConfirmDelete(false);
      invalidate();
    },
    onError: (e) => pushToast({ title: "Delete failed", body: errMsg(e), tone: "error" }),
  });

  const style = { transform: CSS.Transform.toString(transform), transition };
  const assigneeName = agentName?.(issue.assigneeAgentId ?? null) ?? null;
  const isCancelled = issue.status === "cancelled";

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`group rounded-md border bg-card transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"} ${
        isCancelled ? "opacity-60" : ""
      } cursor-grab active:cursor-grabbing p-2.5`}
    >
      <div className="mb-1.5 flex items-start gap-1.5">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>
        {issue.status === "in_review" && issue.executionState?.returnAssignee ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-violet-400/45 bg-violet-50/60 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-300/35 dark:bg-violet-400/10 dark:text-violet-300"
            title="Bounced back from review"
          >
            <RotateCcw className="h-3 w-3" />
            Changes requested
          </span>
        ) : null}
        {isLive && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          </span>
        )}
      </div>

      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          if (isDragging) e.preventDefault();
        }}
      >
        <p className="mb-2 line-clamp-2 text-sm leading-snug">{issue.title}</p>
      </Link>

      {issue.gateSummary ? <GateBadgeRow summary={issue.gateSummary} /> : null}

      <div className="mt-1.5 flex items-center gap-2">
        <PriorityIcon priority={issue.priority} />
        {assigneeName ? (
          <Identity name={assigneeName} size="xs" />
        ) : issue.assigneeAgentId ? (
          <span className="font-mono text-xs text-muted-foreground">
            {issue.assigneeAgentId.slice(0, 8)}
          </span>
        ) : null}

        {/* Controls — always visible, real buttons for a11y. Stop is always
            present; with no live run it shows a "nothing running" toast. */}
        <div className="ml-auto flex items-center gap-0.5">
          {!isCancelled && issue.status !== "done" && (
            <button
              type="button"
              aria-label="Stop the running agent on this task"
              title={isLive ? "Stop run" : "Stop run (nothing running)"}
              className={`rounded p-1 hover:bg-accent hover:text-foreground ${isLive ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => stopRun.mutate()}
              disabled={stopRun.isPending}
            >
              <CircleStop className="h-3.5 w-3.5" />
            </button>
          )}
          {!isCancelled && issue.status !== "done" && (
            <button
              type="button"
              aria-label="Cancel this task"
              title="Cancel task"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => cancelIssue.mutate()}
              disabled={cancelIssue.isPending}
            >
              <Ban className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Delete this task"
            title="Delete task"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete task?"
        description={`"${issue.title}" will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete task"
        destructive
        pending={deleteIssue.isPending}
        onConfirm={() => deleteIssue.mutate()}
      />
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
