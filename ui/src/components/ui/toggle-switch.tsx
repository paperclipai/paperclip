import * as React from "react";
import { cn } from "@/lib/utils";

export interface ToggleSwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "default" | "lg";
}

export const ToggleSwitch = React.forwardRef<
  HTMLButtonElement,
  ToggleSwitchProps
>(
  (
    { checked, onCheckedChange, size = "default", className, disabled, ...props },
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
          "relative inline-flex shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Track: larger on mobile (<640px), standard on desktop
          isLg ? "h-7 w-12 sm:h-6 sm:w-11" : "h-6 w-10 sm:h-5 sm:w-9",
          checked ? "bg-green-600" : "bg-muted",
          className,
        )}
        onClick={() => onCheckedChange(!checked)}
        {...props}
      >
        <span
          className={cn(
            "pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform",
            // Thumb
            isLg ? "size-5.5 sm:size-5" : "size-4.5 sm:size-3.5",
            // Slide position
            checked
              ? isLg
                ? "translate-x-5 sm:translate-x-5"
                : "translate-x-5 sm:translate-x-4.5"
              : "translate-x-0.5",
          )}
        />
      </button>
    );
  },
);

ToggleSwitch.displayName = "ToggleSwitch";
