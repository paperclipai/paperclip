import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[2px] px-2.5 py-0.5 text-[9px] font-[var(--font-mono)] font-medium uppercase whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
