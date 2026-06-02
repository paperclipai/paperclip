import type { AgentRuntimeThrottle } from "@paperclipai/shared";
import { cn } from "../lib/utils";

function formatCooldownEligibleAt(eligibleAt: string) {
  const target = new Date(eligibleAt);
  if (Number.isNaN(target.getTime())) return "soon";
  const deltaMs = target.getTime() - Date.now();
  if (deltaMs <= 0) return "now";
  const totalSec = Math.ceil(deltaMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.ceil(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function AgentCooldownBadge({
  throttle,
  className,
}: {
  throttle?: AgentRuntimeThrottle;
  className?: string;
}) {
  if (!throttle?.active) return null;
  const eligibleLabel = throttle.eligibleAt
    ? formatCooldownEligibleAt(throttle.eligibleAt)
    : "soon";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300",
        className,
      )}
      title={
        throttle.eligibleAt
          ? `Automatic wakeups resume at ${new Date(throttle.eligibleAt).toLocaleString()}`
          : "Automatic wakeups are in cooldown"
      }
    >
      Cooling down · {eligibleLabel}
    </span>
  );
}
