import { useState } from "react";
import type { TFunction } from "i18next";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(t: TFunction, status: string): string {
  return t(`charts.status.${status}`, {
    defaultValue: status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  });
}

interface StatusIconProps {
  status: string;
  blockerAttention?: IssueBlockerAttention | null;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
}

function blockedAttentionLabel(t: TFunction, blockerAttention: IssueBlockerAttention | null | undefined) {
  if (!blockerAttention || blockerAttention.state === "none") return t("statusIcon.blocked");

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("statusIcon.waitingActiveSubTask", { identifier: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("statusIcon.waitingOneActiveSubTask");
    return t("statusIcon.waitingActiveSubTasks", { count });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("statusIcon.coveredByActiveDependency", { identifier: blockerAttention.sampleBlockerIdentifier });
    }
    if (count === 1) return t("statusIcon.coveredByOneActiveDependency");
    return t("statusIcon.coveredByActiveDependencies", { count });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return t("statusIcon.reviewStalledOn", { identifier: leaf });
    if (count === 1) return t("statusIcon.reviewStalledOne");
    return t("statusIcon.reviewsStalled", { count });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return t(count === 1 ? "statusIcon.oneBlockerNeedsAttentionCovered" : "statusIcon.blockersNeedAttentionCovered", {
        count,
        coveredCount,
      });
    }
    return t(count === 1 ? "statusIcon.oneBlockerNeedsAttention" : "statusIcon.blockersNeedAttention", { count });
  }

  return t("statusIcon.blocked");
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
export function StatusIcon({ status, blockerAttention, onChange, className, showLabel, size = "md" }: StatusIconProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isCoveredBlocked = status === "blocked" && blockerAttention?.state === "covered";
  const ariaLabel = status === "blocked" ? blockedAttentionLabel(t, blockerAttention) : statusLabel(t, status);
  const glyphStatus = isCoveredBlocked ? "in_queue" : status;

  const glyph = (
    <StatusGlyph
      status={glyphStatus}
      size={size}
      className={cn(onChange && !showLabel && "cursor-pointer", className)}
      title={ariaLabel}
    />
  );

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{statusLabel(t, status)}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {glyph}
      <span className="text-sm">{statusLabel(t, status)}</span>
    </button>
  ) : (
    glyph
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
            {statusLabel(t, s)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
