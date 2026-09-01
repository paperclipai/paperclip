import { cn } from "@/lib/utils";
import { CircleDot, OctagonX, Flag } from "lucide-react";
import type { TaskChatMarkerItem } from "./task-chat-model";
import { Button } from "@/components/ui/button";

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
  const Icon = VARIANT_ICON[item.variant];
  const interrupted = item.variant === "interrupted";
  const handleTryAgain = () => {
    void Promise.resolve()
      .then(() => onTryAgain?.())
      // The parent mutation owns visible error feedback.
      .catch(() => undefined);
  };
  return (
    <div className="tc-enter-marker flex items-center gap-2 py-1 text-xs text-muted-foreground">
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
