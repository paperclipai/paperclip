import type { ReactNode } from "react";
import { AlertTriangle, Clock, Pause } from "lucide-react";
import type { AssigneeLiveness, AssigneeLivenessState } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface AssigneeLivenessTone {
  className: string;
  icon: typeof AlertTriangle;
  label: string;
  title: string;
}

const ASSIGNEE_LIVENESS_TONE: Record<Exclude<AssigneeLivenessState, "live">, AssigneeLivenessTone> = {
  error: {
    className:
      "border-red-500/40 bg-red-500/10 text-red-600 dark:border-red-400/35 dark:bg-red-400/10 dark:text-red-400",
    icon: AlertTriangle,
    label: "Assignee in error",
    title: "Assignee agent is in an error state and will not run this work until it recovers.",
  },
  paused: {
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300",
    icon: Pause,
    label: "Assignee paused",
    title: "Assignee agent is paused. Work will queue but will not run until it is resumed.",
  },
  stale_heartbeat: {
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300",
    icon: Clock,
    label: "Assignee stale",
    title: "Assignee agent has not heartbeated recently and may not be live.",
  },
};

/**
 * Renders a non-alarming chip when an issue's assignee agent is not live
 * (LEG-1928). Returns null for live/absent assignees so healthy assignments
 * render exactly as before — no visual noise.
 */
export function AssigneeLivenessBadge({
  liveness,
  className,
}: {
  liveness?: AssigneeLiveness | null;
  className?: string;
}): ReactNode {
  if (!liveness || liveness.state === "live") return null;
  const tone = ASSIGNEE_LIVENESS_TONE[liveness.state];
  if (!tone) return null;
  const Icon = tone.icon;
  const title = liveness.reason ? `${tone.title}\n${liveness.reason}` : tone.title;
  return (
    <Badge
      variant="outline"
      data-testid="assignee-liveness-badge"
      data-liveness-state={liveness.state}
      role="status"
      aria-label={tone.label}
      title={title}
      className={cn("gap-0.5 text-(length:--text-nano)", tone.className, className)}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </Badge>
  );
}
