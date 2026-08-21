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
  in_progress: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  completed: { Icon: Check, spin: false, tone: "text-muted-foreground" },
  failed: { Icon: X, spin: false, tone: "text-destructive" },
} as const;

/**
 * Tool invocation as a flat activity row (v7): [glyph] [name] [mono target] …
 * [hover chevron] [status]. No card chrome — activity is metadata, not
 * content. Clicking toggles the mono result/detail block (left-rail inset);
 * diffs render as an inset panel below the row.
 */
export function TaskChatToolCard({ item }: { item: TaskChatToolItem }) {
  const { Icon, spin, tone } = STATUS_ICON[item.status];
  const RowIcon = toolTaxonomy(item.rawName ?? item.name).icon;
  const [showDetail, setShowDetail] = useState(false);
  const expandable = Boolean(item.detail);

  return (
    <div className="tc-enter-tool flex flex-col text-xs">
      <button
        type="button"
        onClick={expandable ? () => setShowDetail((v) => !v) : undefined}
        aria-expanded={expandable ? showDetail : undefined}
        className={cn(
          "group/tool -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-0.5 text-left text-muted-foreground",
          expandable ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground" : "cursor-default",
        )}
      >
        <RowIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{item.name}</span>
        {item.target ? (
          <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{item.target}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {item.decision ? (
            <span
              className={cn(
                "flex items-center gap-1 text-(length:--text-micro)",
                item.decision === "allowed" ? "text-(--status-task-icon-done)" : "text-destructive",
              )}
            >
              {item.decision === "allowed" ? <ShieldCheck className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}
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
          <Icon className={cn("h-3.5 w-3.5", tone, spin && "animate-spin")} aria-hidden />
        </span>
      </button>
      {expandable && showDetail ? (
        <pre className="ml-2.5 mt-0.5 overflow-x-auto whitespace-pre-wrap border-l-2 border-border py-1 pl-2.5 font-mono text-(length:--text-micro) leading-relaxed text-muted-foreground">
          {item.detail}
        </pre>
      ) : null}
      {item.diff ? (
        <div className="tc-reveal-diff ml-2.5 mt-1 border-l-2 border-border pl-2.5">
          <div className="mb-1 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            {item.diff.path ? <span className="truncate font-mono">{item.diff.path}</span> : null}
            <span className="ml-auto shrink-0 font-mono font-semibold">
              +{item.diff.added} −{item.diff.removed}
            </span>
          </div>
          {item.diff.lines?.length ? (
            <pre className="overflow-x-auto rounded-sm bg-muted/50 p-2 text-(length:--text-micro) leading-relaxed">
              {item.diff.lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    l.kind === "add" && "text-(--status-task-icon-done)",
                    l.kind === "remove" && "text-destructive",
                    l.kind === "context" && "text-muted-foreground",
                  )}
                >
                  {l.kind === "add" ? "+" : l.kind === "remove" ? "−" : " "} {l.text}
                </div>
              ))}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
