import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskChatProviderActivityItem } from "./task-chat-model";
import { statusNoticePresentation, type StatusNoticeTone } from "./status-notice-presentation";
import { DetailList } from "./TaskChatProtocolActivityRow";

/** Payload keys already reflected by the chip itself. */
const HIDDEN_DETAILS = new Set(["Severity", "Category", "Scope", "Recoverable", "User Actionable", "Summary", "Phase"]);

const TONE_CLASS: Record<StatusNoticeTone, string> = {
  neutral: "border-border text-muted-foreground",
  progress: "border-border text-muted-foreground",
  warning: "border-(--tc-status-notice-warning-border) bg-(--tc-status-notice-warning-bg) text-(--tc-status-notice-warning-fg)",
  danger: "border-destructive/35 bg-destructive/5 text-destructive",
};

/**
 * An inline harness status chip between the turn's activity rows: context
 * compaction, retries, model fallback and provider banners. A fatal provider
 * error renders as a red row with the provider's real message instead.
 */
export function TaskChatStatusNotice({
  item,
  resolved = false,
}: {
  item: TaskChatProviderActivityItem;
  /** A retry the turn moved past: the chip fades to a quiet receipt. */
  resolved?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `task-chat-status-notice-${useId().replaceAll(":", "")}`;
  const presentation = statusNoticePresentation(item, { resolved });
  if (!presentation) return null;
  const Icon = presentation.icon;
  const extra = item.details.filter((entry) => !HIDDEN_DETAILS.has(entry.label) && entry.value !== presentation.detail);
  // The chip may show a short reason; keep the provider's full message on expand.
  const fullSummary = item.summary?.trim() || item.details.find((entry) => entry.label === "Summary")?.value;
  const expandedText = fullSummary && fullSummary !== presentation.detail ? fullSummary : presentation.detail;

  if (presentation.fatal) {
    return (
      <div
        role="alert"
        className="flex min-w-0 flex-col gap-1 rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs"
        data-testid="task-chat-status-notice"
        data-status-notice-category={presentation.category}
      >
        <div className="flex items-center gap-2 font-medium text-destructive">
          <Icon className="size-(--sz-protocol-notice-icon) shrink-0" aria-hidden />
          <span>{presentation.label}</span>
        </div>
        <p className="min-w-0 whitespace-pre-wrap break-words text-foreground">{presentation.detail}</p>
        <DetailList details={extra} />
      </div>
    );
  }

  // Any message can be truncated on a narrow screen, so it stays reachable.
  const expandable = extra.length > 0 || Boolean(presentation.detail) || expandedText !== presentation.detail;
  const chip = (
    <>
      <Icon
        className={cn("size-(--sz-protocol-notice-icon) shrink-0", presentation.active && presentation.tone === "progress" && "animate-spin")}
        aria-hidden
      />
      <span className={cn("shrink-0 font-medium", presentation.active && presentation.tone === "progress" && "shimmer-text shimmer-text-muted")}>
        {presentation.label}{presentation.active && presentation.tone === "progress" ? "…" : ""}
      </span>
      {presentation.detail ? (
        <span className="min-w-0 truncate opacity-80">{presentation.detail}</span>
      ) : null}
      {expandable ? (
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
      ) : null}
    </>
  );
  const chipClass = cn(
    "inline-flex min-h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-opacity duration-(--motion-status-notice-fade)",
    TONE_CLASS[presentation.tone],
    resolved && "opacity-60",
  );
  return (
    <div
      className="flex min-w-0 flex-col items-start gap-1"
      role="status"
      data-testid="task-chat-status-notice"
      data-status-notice-category={presentation.category}
      data-status-notice-resolved={resolved ? "true" : undefined}
    >
      {expandable ? (
        <button type="button" className={cn(chipClass, "hover:opacity-100")} aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
          {chip}
        </button>
      ) : (
        <span className={chipClass}>{chip}</span>
      )}
      {expandable && open ? (
        <div id={detailId} className="ml-3 flex min-w-0 flex-col gap-1 border-l border-border pl-3 text-xs text-muted-foreground">
          {expandedText ? <p className="whitespace-pre-wrap break-words text-foreground">{expandedText}</p> : null}
          <DetailList details={extra} />
        </div>
      ) : null}
    </div>
  );
}
