import { cloneElement, isValidElement, useState } from "react";
import { CalendarRange } from "lucide-react";
import {
  ATTENTION_DATE_RANGE_OPTIONS,
  type AttentionDateRangeId,
} from "../lib/attention";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export interface AttentionCustomRange {
  from: string | null;
  to: string | null;
}

interface DecisionDateChipsProps {
  value: AttentionDateRangeId;
  custom: AttentionCustomRange;
  onChange: (value: AttentionDateRangeId, custom: AttentionCustomRange) => void;
}

/**
 * Date-range chips (PAP-16032 §4.2 / wireframe screen 1, annotation 2). Filter
 * the desk on activity date; the resolved bounds go to the server
 * (`activitySince`/`activityUntil`) so the page never ships the whole feed to
 * filter on the client. "Custom" opens a from/to range picker.
 */
export function DecisionDateChips({ value, custom, onChange }: DecisionDateChipsProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-decision-date-chips>
      {ATTENTION_DATE_RANGE_OPTIONS.map(([id, label]) => (
        <ChipButton key={id} active={value === id} onClick={() => onChange(id, custom)}>
          {label}
        </ChipButton>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <ChipButton active={value === "custom"} asChild>
            <button type="button">
              <CalendarRange className="h-3.5 w-3.5" />
              {value === "custom" && (custom.from || custom.to)
                ? `${custom.from ?? "…"} → ${custom.to ?? "…"}`
                : "Custom"}
            </button>
          </ChipButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto space-y-2 p-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
              From
            </label>
            <input
              type="date"
              value={custom.from ?? ""}
              max={custom.to ?? undefined}
              className="rounded-sm border border-border bg-background px-2 py-1 text-xs"
              onChange={(event) => onChange("custom", { ...custom, from: event.target.value || null })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
              To
            </label>
            <input
              type="date"
              value={custom.to ?? ""}
              min={custom.from ?? undefined}
              className="rounded-sm border border-border bg-background px-2 py-1 text-xs"
              onChange={(event) => onChange("custom", { ...custom, to: event.target.value || null })}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                onChange("all", { from: null, to: null });
                setOpen(false);
              }}
            >
              Clear
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  asChild,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  asChild?: boolean;
  children: React.ReactNode;
}) {
  const className = cn(
    "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
    active
      ? "border-primary bg-primary/10 text-primary"
      : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
  if (asChild) {
    // The child is a real <button>; merge the chip class straight onto it so the
    // flex layout (icon + label inline) lands on the button, not a wrapper span.
    // A bare wrapper span left the button unstyled → its icon stacked above the
    // label and the chip grew taller than its siblings.
    if (isValidElement<{ className?: string }>(children)) {
      return cloneElement(children, {
        className: cn(className, children.props.className),
      });
    }
    return <span className={className}>{children}</span>;
  }
  return (
    <button type="button" className={className} onClick={onClick} aria-pressed={active}>
      {children}
    </button>
  );
}
