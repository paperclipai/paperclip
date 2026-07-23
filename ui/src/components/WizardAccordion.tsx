import { Check } from "lucide-react";
import type { ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type WizardStepState = "complete" | "active" | "upcoming";

export interface WizardStepProps {
  /** 1-based step index shown in the number badge. */
  index: number;
  title: ReactNode;
  state: WizardStepState;
  /** Summary chip shown on a completed, collapsed step (e.g. the chosen method). */
  summary?: ReactNode;
  /** Called when a completed step's header is clicked to reopen it. */
  onReopen?: () => void;
  children?: ReactNode;
}

/**
 * One numbered step in the Add-Connection wizard accordion (plan-wizard-ux §2):
 * completed steps collapse to ✓ + summary chip and can be reopened; the active
 * step is expanded; upcoming steps are visible but disabled.
 */
export function WizardStep({ index, title, state, summary, onReopen, children }: WizardStepProps) {
  const isActive = state === "active";
  const isComplete = state === "complete";
  const isUpcoming = state === "upcoming";

  return (
    <Collapsible
      open={isActive}
      data-step-state={state}
      className={cn(
        "rounded-lg border transition-colors",
        isActive ? "border-border bg-card" : "border-border/60 bg-card/40",
        isUpcoming && "opacity-60",
      )}
    >
      <CollapsibleTrigger
        type="button"
        disabled={isUpcoming || isActive}
        onClick={() => {
          if (isComplete) onReopen?.();
        }}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isComplete && "cursor-pointer hover:bg-accent/40",
          isUpcoming && "cursor-not-allowed",
        )}
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            isComplete && "bg-emerald-600 text-white",
            isActive && "bg-primary text-primary-foreground",
            isUpcoming && "border border-border text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {isComplete ? <Check className="h-3.5 w-3.5" /> : index}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "text-sm font-medium",
              isUpcoming ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          {isComplete && summary != null && (
            <span className="ml-auto truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-4 py-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export interface WizardAccordionProps {
  children: ReactNode;
  className?: string;
}

/** Vertical stack container for {@link WizardStep}s. */
export function WizardAccordion({ children, className }: WizardAccordionProps) {
  return <div className={cn("flex flex-col gap-3", className)}>{children}</div>;
}
