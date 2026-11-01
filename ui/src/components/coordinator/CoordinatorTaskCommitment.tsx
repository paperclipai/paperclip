import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileCheck2 } from "lucide-react";
import type { ConversationTaskHandoff } from "@paperclipai/shared";
import type { SuggestTasksInteraction } from "@/lib/issue-thread-interactions";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { StatusIcon } from "@/components/StatusIcon";
import { CoordinatorRelativeTime } from "./CoordinatorRelativeTime";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";

// Presentation-only memory. It contains no task text or authority, and prevents
// revisiting a conversation from replaying its task-creation celebration.
const sessionStartedAt = Date.now();
const presentedEvents = new Set<string>();

function milliseconds(value: string) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number * (value.trim().endsWith("ms") ? 1 : 1000) : 0;
}

/** One bounded shape changes while its contained light starts on the same frame.
 * The caller supplies canonical server state; animation never creates a task. */
export function CoordinatorTaskMotion({
  eventId,
  phase,
  createdAt,
  animateCreatedEntry = false,
  className = "",
  onSettled,
  children,
}: {
  eventId: string;
  phase: "suggested" | "created" | "pending" | "resolved" | "closed";
  createdAt: Date | string;
  animateCreatedEntry?: boolean;
  className?: string;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previous = useRef<{ phase: typeof phase; height: number; width: number } | null>(null);
  const incompleteEntrance = useRef(false);
  const clickedSize = useRef<{ height: number; width: number } | null>(null);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const rect = content.getBoundingClientRect();
    const from = previous.current && { ...previous.current, ...clickedSize.current };
    const key = `${eventId}:${phase}`;
    const newSuggestion = !from && phase === "suggested" && new Date(createdAt).getTime() >= sessionStartedAt;
    const accepted = (from?.phase === "suggested" && phase === "created")
      || (from?.phase === "pending" && phase === "resolved");
    previous.current = { phase, height: rect.height, width: rect.width };
    const liveCreation = !from && phase === "created" && animateCreatedEntry;
    const fresh = (newSuggestion || accepted || liveCreation) && !presentedEvents.has(key);
    if (fresh) presentedEvents.add(key);
    if (fresh) incompleteEntrance.current = true;
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const animations: Animation[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      root.removeAttribute("data-motion");
      animations.forEach(animation => animation.cancel());
      if (timeout !== undefined) clearTimeout(timeout);
    };
    const finish = () => {
      incompleteEntrance.current = false; clear();
      if (phase === "resolved" || phase === "closed") settledCallback.current?.();
    };
    const reduceMotion = () => { if (preference?.matches) finish(); };
    preference?.addEventListener("change", reduceMotion);
    if (preference?.matches) finish();
    else if (incompleteEntrance.current) {
      const tokens = getComputedStyle(root);
      const motion = phase === "created" || phase === "resolved" ? "gather" : "arrive";
      const duration = milliseconds(tokens.getPropertyValue(motion === "gather" ? "--coordinator-task-light-duration" : "--coordinator-task-arrive-duration"));
      if (duration > 0) {
        root.dataset.motion = motion;
        if (accepted && from.height > 0 && rect.height > 0 && typeof root.animate === "function") {
          const shapeDuration = milliseconds(tokens.getPropertyValue("--coordinator-task-morph-duration"));
          const easing = tokens.getPropertyValue("--coordinator-task-ease").trim();
          // Measured geometry only; visual dimensions and timing remain tokens.
          animations.push(root.animate([
            { height: `${from.height}px`, width: `${from.width}px` },
            { height: `${rect.height}px`, width: `${rect.width}px` },
          ], { duration: shapeDuration, easing }));
          animations.push(content.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: milliseconds(tokens.getPropertyValue("--coordinator-task-content-duration")), easing,
          }));
        }
        timeout = setTimeout(finish, duration);
      } else finish();
    } else if (phase === "resolved" || phase === "closed") finish();
    return () => {
      clear();
      preference?.removeEventListener("change", reduceMotion);
    };
  }, [eventId, phase, createdAt, animateCreatedEntry]);

  return <div ref={rootRef} className={`coordinator-task-commitment ${className}`} data-phase={phase}
    onClickCapture={() => {
      // Capture the full form before a CTA starts saving. Resolver/history reads
      // may settle on different frames; don't morph from their interim layout.
      if (phase !== "pending" && phase !== "suggested") return;
      const rect = contentRef.current?.getBoundingClientRect();
      if (rect) clickedSize.current = { height: rect.height, width: rect.width };
    }}>
    <div ref={contentRef} className="coordinator-task-commitment-content">{children}</div>
    <span className="coordinator-task-light" aria-hidden="true" />
  </div>;
}


/** A server-confirmed task identity. This is also shared by native create_task
 * handoffs, so both creation paths settle into the same card. */
export function CoordinatorCreatedTaskLink({ task, createdAt }: {
  createdAt?: Date | string | null;
  task: Pick<ConversationTaskHandoff, "issueId" | "identifier" | "title"> & { status?: ConversationTaskHandoff["status"] };
}) {
  return <Link to={`/issues/${task.identifier ?? task.issueId}`} className="coordinator-created-task">
    {task.status ? <StatusIcon status={task.status} size="lg" /> : <FileCheck2 className="size-5 shrink-0 text-muted-foreground" aria-label="Task created" />}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{task.title}</span>
      <span className="block truncate text-xs text-muted-foreground"><span className="font-mono">{task.identifier ?? task.issueId}</span> · Created</span>
    </span>
    {createdAt ? <CoordinatorRelativeTime value={createdAt} className="shrink-0 text-xs text-muted-foreground" /> : null}
    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  </Link>;
}

function CreatedTaskLinks({ interaction }: { interaction: SuggestTasksInteraction }) {
  const { userId } = useCoordinatorWorkspaceEnabled();
  const tasks = interaction.result?.createdTasks ?? [];
  const ids = tasks.map(task => task.issueId).sort();
  const query = useQuery({
    queryKey: queryKeys.issues.summaryBatch(interaction.companyId, userId, ids),
    queryFn: ({ signal }) => issuesApi.summaries(interaction.companyId, ids, { signal }),
    enabled: ids.length > 0,
    retry: false,
  });
  if (tasks.length === 0) return <p className="p-4 text-sm text-muted-foreground">No tasks were created.</p>;
  return <div className="divide-y divide-border">
    {tasks.map(task => {
      const summary = query.data?.find(candidate => candidate.id === task.issueId);
      return <CoordinatorCreatedTaskLink key={task.issueId} createdAt={interaction.resolvedAt} task={{
        issueId: task.issueId,
        identifier: summary?.identifier ?? task.identifier ?? null,
        title: summary?.title ?? task.title ?? "Task created",
        status: summary?.status,
      }} />;
    })}
  </div>;
}

export function CoordinatorTaskCommitment({ interaction, children }: { interaction: SuggestTasksInteraction; children: ReactNode }) {
  const phase = interaction.status === "pending" ? "suggested" : interaction.status === "accepted" ? "created" : "closed";
  return <CoordinatorTaskMotion eventId={`${interaction.companyId}:${interaction.id}`} phase={phase} createdAt={interaction.createdAt}>
    {phase === "created" ? <CreatedTaskLinks interaction={interaction} /> : children}
  </CoordinatorTaskMotion>;
}
