import { cn } from "@/lib/utils";

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

function fillColor(pct: number): string {
  if (pct > 90) return "bg-red-400";
  if (pct > 70) return "bg-yellow-400";
  return "bg-green-400";
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
  // keep the notch visible even near the edges
  const notchLeft = Math.min(clampedPct, 97);

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

      {/* track — boxed border, square corners to match the theme */}
      <div className="relative h-2 w-full border border-border overflow-hidden">
        {/* fill */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-[width,background-color] duration-150",
            fillColor(clampedPct),
          )}
          style={{ width: `${clampedPct}%` }}
        />
        {/* deficit notch — 2px wide, sits at the fill tip */}
        {showDeficitNotch && clampedPct > 0 && (
          <div
            className="absolute inset-y-0 w-[2px] bg-destructive z-10"
            style={{ left: `${notchLeft}%` }}
          />
        )}
      </div>
    </div>
  );
}
