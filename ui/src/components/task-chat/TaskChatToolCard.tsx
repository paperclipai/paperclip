import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronRight,
  Loader2,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import type { TaskChatToolItem } from "./task-chat-model";
import { toolTaxonomy } from "./tool-taxonomy";

const STATUS_ICON = {
  pending: { Icon: Loader2, spin: false, tone: "text-muted-foreground" },
  in_progress: {
    Icon: Loader2,
    spin: true,
    tone: "text-(--status-agent-running)",
  },
  completed: { Icon: Check, spin: false, tone: "text-muted-foreground" },
  failed: { Icon: X, spin: false, tone: "text-destructive" },
  interrupted: { Icon: X, spin: false, tone: "text-muted-foreground" },
} as const;

/**
 * Tool invocation as a flat activity row (v7): [glyph] [name] [mono target] …
 * [hover chevron] [status]. No card chrome — activity is metadata, not
 * content. Clicking toggles a compact result/change summary (left-rail
 * inset). Full diff bodies stay out of the activity feed.
 */
export function TaskChatToolCard({ item }: { item: TaskChatToolItem }) {
  const { Icon, spin, tone } = STATUS_ICON[item.status];
  const RowIcon = toolTaxonomy(item.rawName ?? item.name).icon;
  const [showDetail, setShowDetail] = useState(false);
  const expandable = Boolean(item.target || item.detail || item.diff);

  return (
    <div className="tc-enter-tool flex min-w-0 max-w-full flex-col text-xs">
      <button
        type="button"
        onClick={expandable ? () => setShowDetail((v) => !v) : undefined}
        aria-expanded={expandable ? showDetail : undefined}
        className={cn(
          "group/tool -mx-1.5 flex min-h-6 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-1 text-left leading-none text-muted-foreground",
          expandable
            ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground"
            : "cursor-default",
        )}
      >
        <span className="flex w-5 shrink-0 items-center justify-center">
          <RowIcon
            className="h-3.5 w-3.5 shrink-0"
            aria-hidden
            data-testid="task-chat-tool-icon"
          />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
          <span className="shrink-0 font-medium leading-4">{item.name}</span>
          {item.target ? (
            <span className="task-chat-collapsed-line-fade min-w-0 flex-1 font-mono text-(length:--text-micro) leading-4">
              {item.target}
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {item.decision ? (
            <span
              className={cn(
                "flex items-center gap-1 text-(length:--text-micro)",
                item.decision === "allowed"
                  ? "text-(--status-task-icon-done)"
                  : "text-destructive",
              )}
            >
              {item.decision === "allowed" ? (
                <ShieldCheck className="h-3 w-3" />
              ) : (
                <ShieldX className="h-3 w-3" />
              )}
              {item.decision}
            </span>
          ) : null}
          {expandable ? (
            <ChevronRight
              className={cn(
                "h-3 w-3 opacity-0 transition-[opacity,transform] group-hover/tool:opacity-80",
                showDetail ? "rotate-90" : null,
              )}
              aria-hidden
            />
          ) : null}
          <Icon
            className={cn("h-3.5 w-3.5", tone, spin && "animate-spin")}
            aria-hidden
          />
          {item.status === "interrupted" ? (
            <span className="text-(length:--text-micro) text-muted-foreground">
              Interrupted
            </span>
          ) : null}
        </span>
      </button>
      {item.target && showDetail ? (
        <div
          className="task-chat-expanded-line-wrap ml-1.5 mt-0.5 min-w-0 max-w-full overflow-hidden border-l-2 border-border py-1 pl-2.5 font-mono text-(length:--text-micro) leading-relaxed text-muted-foreground"
          data-testid="task-chat-tool-target-detail"
        >
          {item.target}
        </div>
      ) : null}
      {item.detail && showDetail ? (
        <pre className="task-chat-expanded-line-wrap ml-1.5 mt-0.5 min-w-0 max-w-full overflow-hidden whitespace-pre-wrap border-l-2 border-border py-1 pl-2.5 font-mono text-(length:--text-micro) leading-relaxed text-muted-foreground">
          {item.detail}
        </pre>
      ) : null}
      {item.diff && showDetail ? (
        <div
          className="ml-1.5 mt-0.5 border-l-2 border-border py-1 pl-2.5"
          data-testid="task-chat-tool-change-summary"
        >
          <div className="flex min-w-0 items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <span className="shrink-0">Changed</span>
            {item.diff.path ? (
              <span className="min-w-0 truncate font-mono text-foreground">
                {item.diff.path}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 font-mono">
              +{item.diff.added} −{item.diff.removed}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
