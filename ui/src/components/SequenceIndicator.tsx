import { cn } from "@/lib/utils";

interface SequenceIndicatorProps {
  pendingKey: string | null;
}

/**
 * Fixed bottom-right badge showing the current pending key sequence.
 * Appears when the user presses "G" and is waiting for the second key.
 */
export function SequenceIndicator({ pendingKey }: SequenceIndicatorProps) {
  if (!pendingKey) return null;

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-50",
        "flex items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-2 shadow-sm",
        "animate-in fade-in slide-in-from-bottom-2 duration-150",
      )}
    >
      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground">
        {pendingKey.toUpperCase()}
      </kbd>
      <span className="text-xs text-muted-foreground">then...</span>
    </div>
  );
}
