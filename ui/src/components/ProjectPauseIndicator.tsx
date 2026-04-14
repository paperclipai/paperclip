import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { DollarSign, Pause } from "lucide-react";
import type { PauseReason } from "@paperclipai/shared";

interface ProjectPauseIndicatorProps {
  paused: boolean;
  pauseReason: PauseReason | null;
  variant?: "badge" | "sidebar";
}

export function ProjectPauseIndicator({
  paused,
  pauseReason,
  variant = "badge",
}: ProjectPauseIndicatorProps) {
  if (!paused) return null;

  if (variant === "sidebar") {
    if (pauseReason === "budget") {
      return <BudgetSidebarMarker title="Project paused by budget" />;
    }

    return (
      <span
        title="Project paused"
        aria-label="Project paused"
        className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
      >
        <Pause className="h-3 w-3" />
      </span>
    );
  }

  if (pauseReason === "budget") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-600 dark:text-red-200">
        <DollarSign className="h-3.5 w-3.5" />
        Paused by budget hard stop
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
      <Pause className="h-3.5 w-3.5" />
      Paused
    </span>
  );
}
