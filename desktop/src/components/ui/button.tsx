import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "icon";
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
          variant === "primary" && "bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]",
          variant === "secondary" && "border border-[var(--border)] text-[var(--fg-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]",
          variant === "ghost" && "text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]",
          variant === "destructive" && "border border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive-subtle)]",
          size === "default" && "h-9 px-4 py-2",
          size === "sm" && "h-7 px-3 text-xs",
          size === "icon" && "h-8 w-8",
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
