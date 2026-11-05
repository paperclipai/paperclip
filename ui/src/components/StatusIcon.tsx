import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(status: string): string {
  const labels: Record<string, string> = { backlog: t("deep-ui:status_backlog"), todo: t("deep-ui:status_todo"), in_progress: t("deep-ui:status_in_progress"), in_review: t("deep-ui:status_in_review"), done: t("deep-ui:status_done"), cancelled: t("deep-ui:status_cancelled"), blocked: t("deep-ui:status_blocked"), idle: t("deep-ui:status_idle"), monitoring: t("deep-ui:status_monitoring") };
  return labels[status] ?? status;
}

interface StatusIconProps {
  status: string;
  /** Server-derived presentation; mutations still use the canonical status. */
  displayStatus?: string | null;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
  onChange?: (status: string) => void;
  className?: string;
  /** Optional layout wrapper around the glyph. Does not change glyph dimensions. */
  glyphContainerClassName?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
}

function blockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined) {
  if (!blockerAttention || blockerAttention.state === "none") return t("task-components:blocked_18f2a094");

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("deep-ui:blocked_child_id", { id: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("deep-ui:blocked_waiting_on_1_active_sub_task_5878bb");
    return t("deep-ui:blocked_children", { count });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("deep-ui:blocked_dependency_id", { id: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("deep-ui:blocked_covered_by_1_active_dependency_319c94");
    return t("deep-ui:blocked_dependencies", { count });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return t("deep-ui:blocked_review_id", { id: leaf });
    if (count === 1) return t("deep-ui:blocked_review_stalled_with_no_clear_next_step_4978f3");
    return t("deep-ui:blocked_reviews", { count });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;

    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return t("deep-ui:blocked_attention_covered", { count, coveredCount });
    }
    return t("deep-ui:blocked_attention", { count });
  }

  return t("task-components:blocked_18f2a094");
}

/** Shared accessible/tooltip copy, including waiting and covered-blocker states. */
export function getStatusIconLabel(status: string, externalConversationState?: "active" | "waiting" | null, blockerAttention?: IssueBlockerAttention | null, presentationStatus?: string | null): string {
  const displayStatus = status === "in_review" && externalConversationState === "waiting" ? "idle" : status === "in_progress" && presentationStatus === "monitoring" ? "monitoring" : status;
  return status === "blocked" ? blockedAttentionLabel(blockerAttention) : statusLabel(displayStatus);
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
  const displayStatus = status === "in_review" && externalConversationState === "waiting" ? "idle" : status === "in_progress" && presentationStatus === "monitoring" ? "monitoring" : status;
  const isCoveredBlocked = status === "blocked" && blockerAttention?.state === "covered";
  const ariaLabel = getStatusIconLabel(status, externalConversationState, blockerAttention, presentationStatus);
  const glyphStatus = isCoveredBlocked ? "in_queue" : displayStatus;

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
        <span className="text-sm">{statusLabel(displayStatus)}</span>
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
      <span className="text-sm">{statusLabel(displayStatus)}</span>
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
            <StatusIcon status={s} size="lg" />
            {statusLabel(s)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
