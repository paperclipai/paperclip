import { cn } from "../lib/utils";

export type InboxUnreadIndicatorState = "hidden" | "visible" | "fading";

export function InboxUnreadIndicator({
  state,
  selected = false,
  className,
}: {
  state: InboxUnreadIndicatorState;
  selected?: boolean;
  className?: string;
}) {
  const showUnreadDot = state === "visible" || state === "fading";

  return (
    <span
      data-inbox-unread-indicator
      title={showUnreadDot ? "Unread" : undefined}
      className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center self-center", className)}
    >
      {showUnreadDot ? (
        <>
          <span className="sr-only">Unread</span>
          <span
            aria-hidden="true"
            className={cn(
              "block h-2 w-2 rounded-full transition-opacity duration-300",
              selected ? "bg-muted-foreground/70" : "bg-blue-500/70 dark:bg-blue-400/70",
              state === "fading" ? "opacity-0" : "opacity-100",
            )}
          />
        </>
      ) : (
        <span className="inline-flex h-4 w-4" aria-hidden="true" />
      )}
    </span>
  );
}
