import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatThinkingItem } from "./task-chat-model";
import { flattenSelfTalk } from "./transcript-adapter";
import { useTaskChatShimmer } from "./TaskChatShimmer";

const REASONING_RULE_LENGTH = 60;

function parseReasoningFrame(body: string) {
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim());
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (first < 0 || last <= first) return null;

  const header = lines[first].trim();
  const footer = lines[last].trim();
  const title = header.match(/[┌┏╭╔╒╓]?\s*[─━═-]*\s*(Reasoning(?:\s+detail)?)\b/i)?.[1];
  const hasTopCorner = /^[┌┏╭╔╒╓]/.test(header);
  const hasBottomCorner = /^[└┗╰╚╘╙]/.test(footer);
  if (!title || !hasTopCorner || !hasBottomCorner) return null;

  const content = lines
    .slice(first + 1, last)
    .map((line) => line.replace(/^\s*[│┃║]\s?/, "").replace(/\s*[│┃║]\s*$/, ""))
    .join("\n")
    .trim();
  return { title, content };
}

function ReasoningRule({ title }: { title?: string }) {
  const label = title ? `── ${title} ` : "";
  const suffix = "─".repeat(Math.max(0, REASONING_RULE_LENGTH - label.length));
  return (
    <div className="inline-flex max-w-full items-center whitespace-pre font-mono" aria-label={title ? `${title} section` : undefined}>
      {title ? <span className="shrink-0 text-muted-foreground/50">── </span> : null}
      {title ? <span className="shrink-0 font-semibold text-sky-400">{title}</span> : null}
      <span className="shrink-0 text-muted-foreground/50">{title ? " " : ""}{suffix}</span>
    </div>
  );
}

export function TaskChatReasoningText({ body }: { body: string }) {
  const frame = parseReasoningFrame(body);
  const singleLine = body.trim();
  const reasoningHeader = singleLine.match(/^[┌┏╭╔╒╓]\s*[─━═-]*\s*(Reasoning(?:\s+detail)?)\b.*[┐┓╮╗╕╖]$/i)?.[1];
  const reasoningFooter = /^[└┗╰╚╘╙]\s*[─━═-]*[┘┛╯╝╛╜]?$/.test(singleLine);
  if (reasoningHeader) return <ReasoningRule title={reasoningHeader} />;
  if (reasoningFooter) return <ReasoningRule />;
  if (!frame) {
    return <MarkdownBody className="task-chat-reasoning-markdown" softBreaks linkIssueReferences>{body}</MarkdownBody>;
  }
  return (
    <div className="min-w-0 overflow-hidden" data-testid="task-chat-reasoning-frame">
      <ReasoningRule title={frame.title} />
      {frame.content ? <MarkdownBody className="task-chat-reasoning-markdown" softBreaks linkIssueReferences>{frame.content}</MarkdownBody> : null}
      <ReasoningRule />
    </div>
  );
}

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
  const shimmer = useTaskChatShimmer(item.id);
  const body = item.lines.join("\n").trim();
  const frame = parseReasoningFrame(body);
  const preview = flattenSelfTalk(frame?.content ?? body);
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
        <div className="min-w-0 flex-1" data-testid="task-chat-thinking-text" data-conversation-text="progress">
          <TaskChatReasoningText body={body} />
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
        <span className={cn(active && shimmer && "shimmer-text shimmer-text-muted")}>{label}</span>
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
          <span className={cn("shrink-0", shimmer && "shimmer-text shimmer-text-muted")}>{label}</span>
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
        <div data-conversation-text="progress" className="task-chat-expanded-line-wrap ml-2.5 mt-1 min-w-0 max-w-full overflow-hidden border-l-2 border-border pl-2.5 text-xs font-normal text-muted-foreground">
          <TaskChatReasoningText body={body} />
        </div>
      ) : null}
    </div>
  );
}
