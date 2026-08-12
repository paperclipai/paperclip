import * as React from "react";
import { cn } from "@/lib/utils";

export interface ToggleSwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "default" | "lg";
}

/*
 * Custom API (checked/onCheckedChange button, no Radix dep) with the shadcn
 * radix-luma Switch's capsule form: border-2 track, oval thumb, bg-input
 * off-state. Deliberate deviation from the registry: the on-state is the
 * status-system green (var(--status-task-done)), not bg-primary — user
 * ruling, DECISION-SHEET "toggle form" note. Do not swap for the registry
 * Switch without revisiting that ruling (C7).
 */
export const ToggleSwitch = React.forwardRef<
  HTMLButtonElement,
  ToggleSwitchProps
>(
  (
    { checked, onCheckedChange, size = "default", className, disabled, onClick, ...props },
    ref,
  ) => {
    const isLg = size === "lg";

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        data-slot="toggle"
        disabled={disabled}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border-2 transition-all outline-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          isLg ? "h-6 w-12" : "h-5 w-11",
          checked
            ? "border-(--status-task-done) bg-(--status-task-done)"
            : "border-transparent bg-input/90",
          className,
        )}
        {...props}
        // Run the caller's onClick first (e.g. stopPropagation in a clickable
        // row) but always fire the toggle — spreading `props` must not clobber
        // the state change, so this handler stays after the spread.
        onClick={(event) => {
          onClick?.(event);
          onCheckedChange(!checked);
        }}
      >
        <span
          className={cn(
            "pointer-events-none inline-block rounded-full bg-background shadow-sm transition-transform not-dark:bg-clip-padding dark:bg-foreground",
            isLg ? "h-5 w-7" : "h-4 w-6",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    );
  },
);

ToggleSwitch.displayName = "ToggleSwitch";
