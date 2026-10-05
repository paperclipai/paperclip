import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { TaskChatTranscriptPlaceholderItem } from "./task-chat-model";

/**
 * One run's transcript slot inside the thread list (REK-311).
 *
 * Two states, both quiet by design: a skeleton while the log is still in
 * flight, and a one-line notice with a per-run Retry when that log could not
 * be read. Neither is a thread-level overlay — the conversation above them is
 * already readable, which is the whole point of the split gate.
 */
export function TaskChatTranscriptSlot({
  item,
  onRetry,
  className,
}: {
  item: TaskChatTranscriptPlaceholderItem;
  onRetry?: (runId: string) => void;
  className?: string;
}) {
  if (item.state === "error") {
    return (
      <div
        role="status"
        data-testid={`transcript-slot-error-${item.runId}`}
        className={cn(
          "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <span>This run&rsquo;s transcript could not be loaded.</span>
        {onRetry ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRetry(item.runId)}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="Loading run transcript"
      data-testid={`transcript-slot-${item.runId}`}
      className={cn("flex flex-col gap-2 py-1", className)}
    >
      <Skeleton className="h-4 w-3/5 animate-none" />
      <Skeleton className="h-4 w-2/5 self-end animate-none" />
    </div>
  );
}
