import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SourceResolvedFoldBadgeProps {
  className?: string;
  title?: string;
  /** When true (default) the leading sparkles icon is rendered. */
  showIcon?: boolean;
}

export function SourceResolvedFoldBadge({
  className,
  title = "System folded this run as a source-resolved false positive.",
  showIcon = true,
}: SourceResolvedFoldBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        "border-status-success/30 bg-status-success/12 text-status-success",
        className,
      )}
      title={title}
      aria-label="Source-resolved watchdog fold"
    >
      {showIcon ? <Sparkles className="h-3 w-3 text-status-success" aria-hidden /> : null}
      Source-resolved
    </span>
  );
}

export default SourceResolvedFoldBadge;
