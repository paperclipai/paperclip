import { cn } from "../lib/utils";

interface BizboxBrandMarkProps {
  className?: string;
  compact?: boolean;
}

export function BizboxBrandMark({ className, compact = false }: BizboxBrandMarkProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_30%_30%,rgba(255,201,132,0.96),rgba(244,117,32,0.98)_45%,rgba(82,33,0,0.92)_100%)] shadow-[0_10px_35px_rgba(255,123,32,0.35)]">
        <div className="absolute inset-[1px] rounded-[15px] bg-[linear-gradient(150deg,rgba(255,255,255,0.18),rgba(255,255,255,0.02)_30%,rgba(0,0,0,0.18)_100%)]" />
        <div className="absolute inset-2 rounded-xl border border-white/15 bg-[radial-gradient(circle_at_50%_40%,rgba(255,242,214,0.95),rgba(255,170,78,0.88)_38%,rgba(77,26,0,0.95)_100%)]" />
        <div className="relative z-10 h-[18px] w-[18px] rounded-full border border-white/45 bg-[radial-gradient(circle_at_35%_35%,rgba(255,255,255,0.95),rgba(255,244,224,0.82)_45%,rgba(255,167,70,0.55)_75%,rgba(255,108,24,0.15)_100%)] shadow-[0_0_18px_rgba(255,231,198,0.5)]" />
      </div>
      {!compact ? (
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-[0.02em] text-foreground">Bizbox</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">AI Company Control Plane</div>
        </div>
      ) : null}
    </div>
  );
}
