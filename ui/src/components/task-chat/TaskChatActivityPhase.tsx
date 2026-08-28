import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";

export function TaskChatActivityPhase({
  item,
  renderChild,
}: {
  item: TaskChatActivityPhaseItem;
  renderChild: (child: TaskChatActivityPhaseItem["items"][number]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = item.items.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="task-chat-activity-phase">
      {item.interstitial ? (
        <div className="min-w-0 px-1 text-sm text-foreground/90" data-testid="task-chat-phase-interstitial">
          <MarkdownBody softBreaks linkIssueReferences>{item.interstitial.text}</MarkdownBody>
        </div>
      ) : null}
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} activity: ${item.summary}`}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "group flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.active ? "text-foreground" : "text-muted-foreground",
          )}
          data-testid="task-chat-phase-summary"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
          <span className="min-w-0 break-words">{item.summary}</span>
        </button>
      ) : null}
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 pl-2" data-testid="task-chat-phase-children">
          {item.items.map((child) => <div className="min-w-0" key={child.id}>{renderChild(child)}</div>)}
        </div>
      ) : null}
    </div>
  );
}
