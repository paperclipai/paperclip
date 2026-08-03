import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import type { TaskChatThinkingItem } from "./task-chat-model";

/**
 * Chain-of-thought (ACP agent_thought_chunk) as a flat left-railed block (v7):
 * a chevron header whose label shimmers while streaming ("Thinking…") and
 * settles to "Thought for Ns", over a recessed pre-wrap body. Streams open;
 * settled history arrives collapsed and re-expands on click. No card chrome —
 * thinking is activity metadata, subordinate to real content.
 */
export function TaskChatThinkingBlock({ item }: { item: TaskChatThinkingItem }) {
  const [open, setOpen] = useState(!item.collapsed);
  const settledLabel = item.summaryLabel ?? "Thought process";

  return (
    <div className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 py-0.5 transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-90" : null)} aria-hidden />
        {item.streaming ? (
          <span className="shimmer-text shimmer-text-muted font-medium">Thinking…</span>
        ) : (
          <span className="font-medium">{settledLabel}</span>
        )}
      </button>
      {open ? (
        <div className="space-y-1 pb-1 pt-0.5">
          {item.lines.map((line, i) => (
            <p
              key={i}
              className="tc-enter-cot-line whitespace-pre-wrap"
              style={{ animationDelay: `calc(var(--motion-cot-line-stagger) * ${i})` }}
            >
              {line}
            </p>
          ))}
          {item.streaming ? (
            <span className="tc-cursor inline-block h-3 w-1.5 bg-muted-foreground align-baseline" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
