import { CloudOff } from "lucide-react";
import { useLiveConnectionStatus } from "../context/LiveUpdatesProvider";
import { cn } from "../lib/utils";

interface StaleDataBannerProps {
  className?: string;
}

/**
 * Shows a subtle indicator when the WebSocket connection is dropped,
 * letting the user know that data may be outdated until reconnection.
 */
export function StaleDataBanner({ className }: StaleDataBannerProps) {
  const { connected } = useLiveConnectionStatus();

  if (connected) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <CloudOff className="h-3.5 w-3.5 shrink-0" />
      <span>Data may be outdated - live connection lost. Reconnecting...</span>
    </div>
  );
}
