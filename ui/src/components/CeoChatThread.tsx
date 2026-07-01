import { forwardRef, useMemo, type ReactNode } from "react";
import type { Agent, Company, IssueComment, IssueThreadInteraction } from "@paperclipai/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MarkdownBody } from "./MarkdownBody";
import { AgentIcon } from "./AgentIconPicker";
import { cn } from "../lib/utils";

/** Wrapped markdown in bubbles; pre/table scroll horizontally when needed.
 *  Mirrors BoardChat's contract so the room speaks one bubble language. */
const CEO_CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const ceoBubbleShell =
  "min-w-0 max-w-[85%] break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible";

/** First-letter(s) fallback for an agent with no icon. */
function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()) || "A";
}

/** Icon-adjacent-to-name header above an agent bubble. */
function AgentBubbleHeader({ name, icon }: { name: string; icon: string | null }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-1">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>
          {icon ? <AgentIcon icon={icon} className="h-3.5 w-3.5" /> : agentInitials(name)}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium text-foreground">{name}</span>
    </div>
  );
}

/** Agent-styled bubble carrying the three-dot typing indicator. */
function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          ceoBubbleShell,
          "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
        )}
      >
        <span className="typing-dots" aria-label="typing">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

interface CeoChatThreadProps {
  comments: IssueComment[];
  ceoAgent: Agent | undefined;
  company: Pick<Company, "name"> | null | undefined;
  missionText: string | null;
  optimisticMessage: string | null;
  streamingText: string;
  statusText: string;
  sending: boolean;
  elapsedSec: number;
  errorText: string;
  /** Inline task-suggestion cards keyed off pending `suggest_tasks` interactions. */
  interactionSlot?: ReactNode;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The CEO conversation thread block. Operator bubbles right-aligned and
 * accented; CEO bubbles left with an agent header + MarkdownBody. Empty state
 * is a warm CEO intro inviting a plain-language goal. The `isUser` sentinel
 * rule is preserved EXACTLY from BoardChat:
 *   isUser = !authorAgentId && authorUserId !== "board-concierge".
 */
export const CeoChatThread = forwardRef<HTMLDivElement, CeoChatThreadProps>(
  function CeoChatThread(
    {
      comments,
      ceoAgent,
      company,
      missionText,
      optimisticMessage,
      streamingText,
      statusText,
      sending,
      elapsedSec,
      errorText,
      interactionSlot,
      scrollContainerRef,
      messagesEndRef,
    },
    _ref,
  ) {
    const sortedComments = useMemo(
      () =>
        comments
          .slice()
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          ),
      [comments],
    );

    const hasHistory = sortedComments.length > 0 || !!optimisticMessage;
    const ceoName = ceoAgent?.name ?? "your CEO";

    return (
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={scrollContainerRef}
          className="scrollbar-auto-hide absolute inset-0 overflow-y-auto overflow-x-hidden"
        >
          {/* pb clears the floating glass composer dock so the last bubble can
              scroll fully above it. */}
          <div className="flex flex-col gap-4 px-6 pt-3 pb-32">
            {/* Empty state — a warm CEO intro inviting a plain-language goal. */}
            {!hasHistory && !sending && (
              <div className="flex flex-col items-start">
                {ceoAgent && (
                  <AgentBubbleHeader name={ceoAgent.name} icon={ceoAgent.icon} />
                )}
                <div
                  className={cn(
                    ceoBubbleShell,
                    "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                  )}
                >
                  <MarkdownBody className={CEO_CHAT_MARKDOWN_CLASS}>
                    {`Hi — I'm ${ceoName}${company?.name ? `, leading ${company.name}` : ""}. Tell me what you want to achieve in plain language and I'll turn it into goals and real tasks for the team.\n\nFor example: *"I want 100 paying customers by the end of the quarter."*`}
                  </MarkdownBody>
                </div>
              </div>
            )}

            {sortedComments.map((comment) => {
              const isUser =
                !comment.authorAgentId &&
                comment.authorUserId !== "board-concierge";
              if (isUser) {
                return (
                  <div key={comment.id} className="flex justify-end">
                    <div
                      className={cn(
                        ceoBubbleShell,
                        "bg-primary text-primary-foreground [border-radius:14px_14px_4px_14px]",
                      )}
                    >
                      {comment.body ?? ""}
                    </div>
                  </div>
                );
              }
              return (
                <div key={comment.id} className="flex flex-col items-start">
                  <AgentBubbleHeader
                    name={ceoAgent?.name ?? "CEO"}
                    icon={ceoAgent?.icon ?? null}
                  />
                  <div
                    className={cn(
                      ceoBubbleShell,
                      "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                    )}
                  >
                    <MarkdownBody className={CEO_CHAT_MARKDOWN_CLASS}>
                      {comment.body ?? ""}
                    </MarkdownBody>
                  </div>
                </div>
              );
            })}

            {/* Inline task-suggestion cards (suggest_tasks interactions). */}
            {interactionSlot}

            {/* Optimistic user message — shows instantly before server persists. */}
            {optimisticMessage && (
              <div className="flex justify-end">
                <div
                  className={cn(
                    ceoBubbleShell,
                    "bg-primary text-primary-foreground [border-radius:14px_14px_4px_14px]",
                  )}
                >
                  {optimisticMessage}
                </div>
              </div>
            )}

            {/* Streaming response. */}
            {streamingText && (
              <div className="flex flex-col items-start">
                {ceoAgent && (
                  <AgentBubbleHeader name={ceoAgent.name} icon={ceoAgent.icon} />
                )}
                <div
                  className={cn(
                    ceoBubbleShell,
                    "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                  )}
                >
                  <MarkdownBody className={CEO_CHAT_MARKDOWN_CLASS}>
                    {streamingText}
                  </MarkdownBody>
                </div>
              </div>
            )}

            {/* Typing bubble while preparing a reply with no streamed text yet. */}
            {sending && !streamingText && <TypingBubble />}

            {/* "CEO is working…" status line. */}
            {sending && (
              <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                <img
                  src="/paperclip-thinking.svg"
                  alt=""
                  className="inline-block shrink-0"
                  style={{ width: 14, height: 14 }}
                />
                <span>{statusText || "CEO is working…"}</span>
                {elapsedSec > 0 && (
                  <span className="opacity-50">{elapsedSec.toFixed(1)}s</span>
                )}
              </div>
            )}

            {/* Error / disabled-flag notice. */}
            {errorText && !sending && (
              <div role="alert" className="flex justify-start">
                <div
                  className={cn(
                    ceoBubbleShell,
                    "bg-destructive/10 border border-destructive/30 text-destructive [border-radius:14px_14px_14px_4px]",
                  )}
                >
                  {errorText}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    );
  },
);
