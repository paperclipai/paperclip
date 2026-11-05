import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import { hasReasoningHeadlines, reasoningSummarySections } from "./reasoning-summary";

/**
 * Provider reasoning summary as one bullet per summary part. Headlines lead
 * each bullet; any prose the provider wrote under a headline follows it in
 * muted text. Prose-only summaries (Claude) render as plain paragraphs.
 */
export function TaskChatReasoningSummary({
  text,
  streaming = false,
  className,
}: {
  text: string;
  /** The last section is still being written. */
  streaming?: boolean;
  className?: string;
}) {
  const sections = reasoningSummarySections(text);
  if (!hasReasoningHeadlines(sections)) {
    return (
      <div className={className} data-conversation-text="progress" data-testid="task-chat-reasoning-prose">
        <MarkdownBody className="task-chat-reasoning-markdown" softBreaks linkIssueReferences>{text.trim()}</MarkdownBody>
      </div>
    );
  }
  return (
    <ul className={cn("flex min-w-0 flex-col gap-1.5", className)} data-conversation-text="progress" data-testid="task-chat-reasoning-sections">
      {sections.map((section, index) => {
        const current = streaming && index === sections.length - 1;
        return (
          <li key={index} className="flex min-w-0 gap-2" data-reasoning-section={index} data-current={current ? "true" : undefined}>
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50",
                current && "bg-(--status-agent-running)",
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {section.headline ? (
                <span className="text-xs text-foreground" data-reasoning-headline>{section.headline}</span>
              ) : null}
              {section.body ? (
                <div className="text-xs text-muted-foreground">
                  <MarkdownBody className="task-chat-reasoning-markdown task-chat-reasoning-section-body" softBreaks linkIssueReferences>
                    {section.body}
                  </MarkdownBody>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
