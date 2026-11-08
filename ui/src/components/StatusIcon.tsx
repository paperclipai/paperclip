import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { resolveTaskStatusPresentation, taskStatusLabel, type TaskStatusPresentationInput } from "../lib/task-status-presentation";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

interface StatusIconProps extends TaskStatusPresentationInput {
  onChange?: (status: string) => void;
  className?: string;
  /** Optional layout wrapper around the glyph. Does not change glyph dimensions. */
  glyphContainerClassName?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
}

/** Shared accessible/tooltip copy, including waiting and covered-blocker states. */
export function getStatusIconLabel(status: string, externalConversationState?: "active" | "waiting" | null, blockerAttention?: IssueBlockerAttention | null, presentationStatus?: string | null): string {
  return resolveTaskStatusPresentation({ status, displayStatus: presentationStatus, externalConversationState, blockerAttention }).ariaLabel;
}

/**
 * Task/issue status indicator — renders the unified, color-blind-safe
 * {@link StatusGlyph} (one distinct shape per status). With `onChange` it also
 * acts as a status picker (popover). This one component drives every standalone
 * status surface: list, kanban, detail header, properties row + picker flyout,
 * sub-task / blocked-by pills, blocked inbox, quicklook, sibling nav, filters,
 * search, columns, dashboard.
 *
 * A "covered" blocked task (waiting on active work) maps to the `in_queue`
 * glyph — the blocked shape recoloured blue — while the full blocked reason
 * still rides on the accessible label.
 */
export function StatusIcon({ status, displayStatus: presentationStatus, externalConversationState, blockerAttention, onChange, className, glyphContainerClassName, showLabel, size = "md" }: StatusIconProps) {
  useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const presentation = { status, displayStatus: presentationStatus, externalConversationState, blockerAttention };
  const { glyphStatus, label, ariaLabel } = resolveTaskStatusPresentation(presentation);

  const glyphIcon = (
    <StatusGlyph
      status={glyphStatus}
      size={size}
      className={cn(onChange && !showLabel && "cursor-pointer", className)}
      title={ariaLabel}
    />
  );
  const glyph = glyphContainerClassName ? (
    <span className={glyphContainerClassName} data-status-glyph-container="true">
      {glyphIcon}
    </span>
  ) : glyphIcon;

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{label}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button
      type="button"
      aria-label={t("task-components:changeStatusCurrent_e7c495b8", { value1: ariaLabel })}
      className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
    >
      {glyph}
      <span className="text-sm">{label}</span>
    </button>
  ) : (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={t("task-components:changeStatusCurrent_e7c495b8", { value1: ariaLabel })}
      className="inline-flex cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
    >
      {glyph}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {allStatuses.map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
            onClick={() => {
              onChange(s);
              setOpen(false);
            }}
          >
            {/* The current row is the task's state: draw it exactly like the trigger. */}
            <StatusIcon {...(s === status ? presentation : { status: s })} size="lg" />
            {taskStatusLabel(s)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
