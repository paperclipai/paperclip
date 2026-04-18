import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { cn } from "../lib/utils";

type InboxRowActionButtonProps = {
  label: string;
  icon?: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
};

export function InboxRowActionButton({
  label,
  icon,
  onClick,
  onKeyDown,
  disabled = false,
  selected = false,
  className,
}: InboxRowActionButtonProps) {
  return (
    <button
      type="button"
      data-inbox-row-action
      onClick={onClick}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium shadow-xs",
        "border-border bg-background/80 text-foreground/90 transition-colors",
        selected ? "border-muted-foreground/30 bg-muted/50 hover:bg-muted/80" : "hover:border-foreground/15 hover:bg-accent",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {icon ? (
        <span className="text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label}
    </button>
  );
}
