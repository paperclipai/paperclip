import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type RadioCardOption = {
  value: string;
  title: string;
  description?: string;
};

/**
 * Selectable card primitive — a labelled `<button aria-pressed>` with a
 * ring-on-selected treatment. Used by the routine Delivery section (§3.5) and
 * reusable for onboarding / adapter pickers. Render several inside a
 * `<RadioCardGroup>` for roving keyboard nav.
 */
export function RadioCard({
  selected,
  title,
  description,
  className,
  ...props
}: {
  selected: boolean;
  title: string;
  description?: string;
} & Omit<React.ComponentProps<"button">, "title">) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-state={selected ? "checked" : "unchecked"}
      className={cn(
        "group relative flex w-full flex-col items-start gap-1 rounded-md border px-4 py-3 text-left transition-colors",
        "motion-safe:transition-(--tp-border-color-background-color) motion-safe:duration-150",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-border hover:bg-accent/40",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </div>
      {description ? (
        <span className="text-xs text-muted-foreground">{description}</span>
      ) : null}
    </button>
  );
}

export function RadioCardGroup({
  value,
  onValueChange,
  options,
  ariaLabel,
  disabled,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: RadioCardOption[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const idx = options.findIndex((option) => option.value === value);
    if (idx === -1) return;
    let nextIdx: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIdx = (idx + 1) % options.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIdx = (idx - 1 + options.length) % options.length;
    }
    if (nextIdx !== null) {
      event.preventDefault();
      onValueChange(options[nextIdx].value);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("grid gap-2", className)}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => (
        <RadioCard
          key={option.value}
          selected={option.value === value}
          title={option.title}
          description={option.description}
          disabled={disabled}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onValueChange(option.value)}
        />
      ))}
    </div>
  );
}
