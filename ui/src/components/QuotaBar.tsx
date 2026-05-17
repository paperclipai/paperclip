import { cn } from "@/lib/utils";
import { LedProgress } from "./NothingAesthetic";

interface QuotaBarProps {
  label: string;
  // value between 0 and 100
  percentUsed: number;
  leftLabel: string;
  rightLabel?: string;
  // shows a 2px destructive notch at the fill tip when true
  showDeficitNotch?: boolean;
  className?: string;
}

export function QuotaBar({
  label,
  percentUsed,
  leftLabel,
  rightLabel,
  showDeficitNotch = false,
  className,
}: QuotaBarProps) {
  const clampedPct = Math.min(100, Math.max(0, percentUsed));
  const tone = clampedPct > 90 ? "danger" : clampedPct > 70 ? "warning" : "default";

  return (
    <div className={cn("space-y-1.5", className)}>
      {/* row header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-medium tabular-nums">{leftLabel}</span>
          {rightLabel && (
            <span className="text-xs text-muted-foreground tabular-nums">{rightLabel}</span>
          )}
        </div>
      </div>

      <LedProgress percent={clampedPct} tone={tone} showDeficitNotch={showDeficitNotch} />
    </div>
  );
}
