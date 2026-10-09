import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatThinkingItem } from "./task-chat-model";
import { flattenSelfTalk } from "./transcript-adapter";

/** Provider-authored reasoning summaries and deltas; never reconstructed hidden reasoning. */
export function TaskChatThinking({
  item,
  defaultOpen,
  rowClassName,
  active = Boolean(item.streaming),
}: {
  item: TaskChatThinkingItem;
  /** Activity timelines keep reasoning as one compact row until requested. */
  defaultOpen?: boolean;
  /** Optional alignment override for a containing activity rail. */
  rowClassName?: string;
  /** Whether this reasoning block is the runner's current activity. */
  active?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const body = item.lines.join("\n").trim();
  const preview = flattenSelfTalk(body);
  const baseLabel = item.channel === "detail" ? "Reasoning detail" : "Reasoning";
  const label = active
    ? body ? `${baseLabel}…` : "Thinking…"
    : item.summaryLabel ?? (body ? baseLabel : "Thought");

  if (body && !active) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-start gap-1.5 px-1 py-0.5 text-xs font-normal text-muted-foreground",
          rowClassName,
        )}
        data-testid="task-chat-thinking"
        data-state="settled"
      >
        <span className="flex w-5 shrink-0 items-center justify-center">
          <Brain
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
            aria-hidden
            data-testid="task-chat-thinking-icon"
          />
        </span>
        <div className="min-w-0 flex-1" data-testid="task-chat-thinking-text">
          <MarkdownBody softBreaks linkIssueReferences>{body}</MarkdownBody>
        </div>
      </div>
    );
  }

  if (!body) {
    return (
      <div className={cn("-mx-1.5 flex min-w-0 items-center gap-2 px-1.5 py-0.5 text-xs font-normal text-muted-foreground", rowClassName)} data-testid="task-chat-thinking">
        <span className="flex w-5 shrink-0 items-center justify-center">
          <Brain className={cn("h-3.5 w-3.5 shrink-0", active && "text-(--status-agent-running)")} aria-hidden data-testid="task-chat-thinking-icon" />
        </span>
        <span className={cn(active && "shimmer-text shimmer-text-muted")}>{label}</span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col overflow-hidden text-xs font-normal" data-testid="task-chat-thinking">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${baseLabel.toLowerCase()}: ${preview}`}
        onClick={() => setOpen((value) => !value)}
        className={cn("group/thinking -mx-1.5 flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-0.5 text-left font-normal text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", rowClassName)}
      >
        <span className="flex w-5 shrink-0 items-center justify-center">
          <Brain className={cn("h-3.5 w-3.5 shrink-0", active && "text-(--status-agent-running)")} aria-hidden data-testid="task-chat-thinking-icon" />
        </span>
        {active ? (
          <span className="shimmer-text shimmer-text-muted shrink-0">{label}</span>
        ) : null}
        {!open ? (
          <span
            className="task-chat-collapsed-line-fade min-w-0 flex-1"
            data-testid="task-chat-thinking-preview"
          >
            {preview}
          </span>
        ) : null}
        <ChevronRight className={cn("tc-hover-disclosure-caret h-3 w-3 shrink-0 transition-[opacity,transform] group-hover/thinking:opacity-80 group-focus-visible/thinking:opacity-80", open ? "rotate-90 opacity-80" : "opacity-0")} aria-hidden />
      </button>
      {open ? (
        <div className="task-chat-expanded-line-wrap ml-2.5 mt-1 min-w-0 max-w-full overflow-hidden border-l-2 border-border pl-2.5 text-xs font-normal text-muted-foreground">
          <MarkdownBody className="task-chat-reasoning-markdown" softBreaks linkIssueReferences>{body}</MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
