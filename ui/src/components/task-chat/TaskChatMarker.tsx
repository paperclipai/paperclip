import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, CircleDot, OctagonX, Flag } from "lucide-react";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";
import type { TaskChatMarkerItem } from "./task-chat-model";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";

const VARIANT_ICON = {
  session_start: CircleDot,
  interrupted: OctagonX,
  turn_boundary: Flag,
} as const;

/**
 * Lifecycle divider — renders a state boundary (session start, interruption,
 * turn boundary) as a recessed rule, never a bubble. Interruptions use a dashed
 * destructive rule to read as a distinct state.
 */
export function TaskChatMarker({
  item,
  onTryAgain,
  tryAgainPending = false,
}: {
  item: TaskChatMarkerItem;
  onTryAgain?: () => Promise<void> | void;
  tryAgainPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const streamlined = useStreamlinedTaskChatPresentation();
  const Icon = VARIANT_ICON[item.variant];
  const interrupted = item.variant === "interrupted";
  const relative = item.createdAtIso ? timeAgo(item.createdAtIso) : undefined;
  const handleTryAgain = () => {
    void Promise.resolve()
      .then(() => onTryAgain?.())
      // The parent mutation owns visible error feedback.
      .catch(() => undefined);
  };

  if (item.collapsible) {
    return (
      <div
        className="tc-enter-marker flex flex-col items-start py-1 text-xs text-muted-foreground"
        data-testid="task-chat-collapsible-marker"
      >
        <div className="flex max-w-(--pct-85) items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={detailsId}
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-destructive",
              "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate font-medium">{item.label}</span>
            {relative ? (
              <span className="shrink-0 text-muted-foreground/70">· {relative}</span>
            ) : null}
            <ChevronDown
              className={cn(
                "tc-notice-chevron h-3.5 w-3.5 shrink-0 transition-transform",
                open && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          {onTryAgain && !open ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleTryAgain}
              disabled={tryAgainPending}
              data-testid="task-chat-run-failed-try-again"
            >
              {tryAgainPending ? "Trying again..." : "Try again"}
            </Button>
          ) : null}
        </div>
        {open ? (
          <div
            id={detailsId}
            data-testid="task-chat-collapsible-marker-details"
            className="mt-1 w-full max-w-(--pct-85) overflow-hidden rounded-lg border border-border bg-muted/25 text-left text-sm dark:bg-muted/15"
          >
            {item.detail ? (
              <div className="px-3 py-2.5 text-foreground/90">{item.detail}</div>
            ) : null}
            {item.runHref || onTryAgain ? (
              <div className="flex items-center justify-end gap-2 border-t border-border/70 bg-background/50 px-3 py-2 dark:bg-background/30">
                {item.runHref ? (
                  <Button asChild variant="ghost" size="xs">
                    <Link to={item.runHref}>View run</Link>
                  </Button>
                ) : null}
                {onTryAgain ? (
                  <Button
                    type="button"
                    size="xs"
                    onClick={handleTryAgain}
                    disabled={tryAgainPending}
                    data-testid="task-chat-run-failed-try-again"
                  >
                    {tryAgainPending ? "Trying again..." : "Try again"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="tc-enter-marker flex items-center gap-2 py-1 text-xs text-muted-foreground"
      role={streamlined ? "separator" : undefined}
      aria-label={streamlined ? item.label : undefined}
    >
      <span className={cn("h-px flex-1", interrupted ? "border-t border-dashed border-destructive/50" : "bg-border")} />
      <span className={cn("flex items-center gap-1.5", interrupted && "text-destructive")}>
        <Icon className="h-3.5 w-3.5" />
        <span className="font-medium">{item.label}</span>
        {item.detail ? <span className="text-muted-foreground">· {item.detail}</span> : null}
        {onTryAgain ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleTryAgain}
            disabled={tryAgainPending}
            data-testid="task-chat-run-failed-try-again"
          >
            {tryAgainPending ? "Trying again..." : "Try again"}
          </Button>
        ) : null}
      </span>
      <span className={cn("h-px flex-1", interrupted ? "border-t border-dashed border-destructive/50" : "bg-border")} />
    </div>
  );
}
