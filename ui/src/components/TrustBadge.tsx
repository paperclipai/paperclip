import type { TrustLevel } from "@paperclipai/shared";
import { cn } from "../lib/utils";

const trustBadgeColors: Record<TrustLevel, string> = {
  supervised: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  autonomous: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
};

export function TrustBadge({ level }: { level: TrustLevel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        trustBadgeColors[level],
      )}
    >
      {level}
    </span>
  );
}
