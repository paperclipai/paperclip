import { useEffect, useState, type ReactNode } from "react";
import { Brain, ChevronRight, CircleEllipsis } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";
import { protocolActivityPresentation } from "./task-chat-activity-presentation";
import { toolTaxonomy, type ToolIcon } from "./tool-taxonomy";

function representativeIcon(item: TaskChatActivityPhaseItem): ToolIcon {
  // Prefer a concrete operation over bookkeeping/reasoning. A phase can own
  // many different rows, but its collapsed summary needs one calm visual cue.
  for (const child of item.items) {
    if (child.kind === "tool") {
      return toolTaxonomy(child.rawName ?? child.name).icon;
    }
    if (child.kind === "protocol") {
      const presentation = protocolActivityPresentation(child);
      if (presentation) return presentation.icon;
    }
  }
  if (item.items.some((child) => child.kind === "thinking")) return Brain;
  return CircleEllipsis;
}

export function TaskChatActivityPhase({
  item,
  renderChild,
  renderChildren,
  autoOpen = true,
  defaultOpen = false,
  childrenClassName,
  showChildRail = false,
  appearance = "classic",
}: {
  item: TaskChatActivityPhaseItem;
  renderChild: (child: TaskChatActivityPhaseItem["items"][number]) => ReactNode;
  renderChildren?: (children: TaskChatActivityPhaseItem["items"]) => ReactNode;
  autoOpen?: boolean;
  /** Keep useful historical content visible in an in-flight transcript. */
  defaultOpen?: boolean;
  childrenClassName?: string;
  /** Draws a nested-activity rail aligned beneath the summary disclosure. */
  showChildRail?: boolean;
  /** Codex-style summary treatment used only by the new Paperclip task UI. */
  appearance?: "classic" | "runner";
}) {
  const shouldAutoOpen =
    defaultOpen ||
    (autoOpen &&
      (item.active ||
      item.items.some(
        (child) =>
          (child.kind === "thinking" && child.streaming) ||
          (child.kind === "tool" && child.status === "in_progress") ||
          (child.kind === "protocol" &&
            child.surface === "provider_activity" &&
            child.status === "running") ||
          (child.kind === "protocol" &&
            child.surface === "workspace_change" &&
            !child.complete) ||
          (child.kind === "protocol" &&
            child.surface === "runtime_request" &&
            child.status === "pending"),
      )));
  const [open, setOpen] = useState(shouldAutoOpen);
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true);
  }, [shouldAutoOpen]);
  const expandable = item.items.length > 0;
  const runnerAppearance = appearance === "runner";
  const SummaryIcon = runnerAppearance ? representativeIcon(item) : null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        runnerAppearance ? "gap-2" : "gap-1",
      )}
      data-testid="task-chat-activity-phase"
    >
      {item.interstitial ? (
        <div
          className="min-w-0 px-1 text-sm text-foreground/90"
          data-testid="task-chat-phase-interstitial"
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {item.interstitial.text}
          </MarkdownBody>
        </div>
      ) : null}
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} activity: ${item.summary}`}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            runnerAppearance
              ? "group/activity-phase flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1.5 text-left text-sm leading-5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : "group flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.active ? "text-foreground/80" : "text-muted-foreground",
          )}
          data-testid="task-chat-phase-summary"
        >
          {SummaryIcon ? (
            <span
              className="flex w-6 shrink-0 items-center justify-center"
              data-testid="task-chat-phase-summary-icon-slot"
            >
              <SummaryIcon
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden
                data-testid="task-chat-phase-summary-icon"
              />
            </span>
          ) : (
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 transition-transform",
                open && "rotate-90",
              )}
              aria-hidden
            />
          )}
          <span className="min-w-0 break-words">{item.summary}</span>
          {runnerAppearance ? (
            <ChevronRight
              className={cn(
                "ml-auto h-3 w-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/activity-phase:opacity-70 group-focus-visible/activity-phase:opacity-70",
                open && "rotate-90",
              )}
              aria-hidden
              data-testid="task-chat-phase-summary-caret"
            />
          ) : null}
        </button>
      ) : null}
      {open ? (
        <div
          className={cn("flex min-w-0 flex-col gap-2 pl-2", childrenClassName)}
          data-testid="task-chat-phase-children"
        >
          {showChildRail ? (
            <span
              className="absolute inset-y-1 left-0 w-px bg-border/70"
              aria-hidden
              data-testid="task-chat-phase-child-rail"
            />
          ) : null}
          {renderChildren
            ? renderChildren(item.items)
            : item.items.map((child) => (
                <div className="min-w-0" key={child.id}>
                  {renderChild(child)}
                </div>
              ))}
        </div>
      ) : null}
    </div>
  );
}
