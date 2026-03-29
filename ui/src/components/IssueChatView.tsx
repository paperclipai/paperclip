import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import type { IssueComment, Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Identity } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";
import { AgentIcon } from "./AgentIconPicker";
import { formatDateTime } from "../lib/utils";
import { cn } from "../lib/utils";
import { Send, Loader2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}

interface IssueChatViewProps {
  comments: CommentWithRunMeta[];
  agentMap?: Map<string, Agent>;
  onSend: (body: string) => Promise<void>;
  isAgentRunning?: boolean;
  assigneeAgentId?: string | null;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Single chat bubble                                                */
/* ------------------------------------------------------------------ */

const ChatBubble = memo(function ChatBubble({
  comment,
  agentMap,
  isAgent,
}: {
  comment: CommentWithRunMeta;
  agentMap?: Map<string, Agent>;
  isAgent: boolean;
}) {
  const agent = comment.authorAgentId
    ? agentMap?.get(comment.authorAgentId)
    : null;

  const authorName = comment.authorAgentId
    ? agent?.name ?? comment.authorAgentId.slice(0, 8)
    : "나";

  return (
    <div
      className={cn(
        "flex gap-2 max-w-[85%]",
        isAgent ? "self-start" : "self-end flex-row-reverse",
      )}
    >
      {/* Avatar */}
      <div className="shrink-0 mt-1">
        {isAgent && agent ? (
          <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
            <AgentIcon icon={agent.icon} className="h-4 w-4 text-muted-foreground" />
          </div>
        ) : isAgent ? (
          <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center text-[10px] font-medium text-muted-foreground">
            {authorName.slice(0, 2).toUpperCase()}
          </div>
        ) : (
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium text-primary">
            나
          </div>
        )}
      </div>

      {/* Bubble content */}
      <div className="flex flex-col gap-0.5 min-w-0">
        {/* Author name + time */}
        <div
          className={cn(
            "flex items-center gap-2 text-[11px] text-muted-foreground px-1",
            !isAgent && "flex-row-reverse",
          )}
        >
          <span className="font-medium truncate">{authorName}</span>
          <span className="shrink-0">{formatDateTime(comment.createdAt)}</span>
        </div>

        {/* Bubble */}
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
            isAgent
              ? "bg-accent/60 rounded-tl-sm"
              : "bg-primary text-primary-foreground rounded-tr-sm",
          )}
        >
          {isAgent ? (
            <MarkdownBody className="text-sm [&_*]:!text-inherit [&_.prose]:!max-w-none">
              {comment.body}
            </MarkdownBody>
          ) : (
            <div className="whitespace-pre-wrap break-words">{comment.body}</div>
          )}
        </div>

        {/* Run link */}
        {comment.runId && comment.runAgentId && (
          <Link
            to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
            className={cn(
              "inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors w-fit",
              !isAgent && "self-end",
            )}
          >
            run {comment.runId.slice(0, 8)}
          </Link>
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Typing indicator                                                  */
/* ------------------------------------------------------------------ */

function TypingIndicator({ agentName }: { agentName?: string }) {
  return (
    <div className="flex gap-2 self-start max-w-[85%]">
      <div className="shrink-0 mt-1">
        <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
          <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
          <span className="font-medium">{agentName ?? "에이전트"}</span>
        </div>
        <div className="bg-accent/60 rounded-2xl rounded-tl-sm px-4 py-3">
          <div className="flex gap-1.5 items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Composer                                                          */
/* ------------------------------------------------------------------ */

function ChatComposer({
  onSend,
  disabled,
}: {
  onSend: (body: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !sending && !disabled && body.trim().length > 0;

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setBody("");
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [body, sending, onSend]);

  const handleKeyDown = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        if (canSend) {
          void handleSend();
        }
      }
    },
    [canSend, handleSend],
  );

  return (
    <div className="border-t border-border bg-background px-3 py-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="메시지를 입력하세요..."
          className="min-h-[40px] max-h-[160px] resize-none border-0 bg-accent/30 shadow-none focus-visible:ring-0 focus-visible:border-0 rounded-xl px-3 py-2.5 text-sm"
          rows={1}
          disabled={sending}
        />
        <Button
          size="icon"
          className="shrink-0 h-9 w-9 rounded-full"
          disabled={!canSend}
          onClick={() => void handleSend()}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main chat view                                                    */
/* ------------------------------------------------------------------ */

export function IssueChatView({
  comments,
  agentMap,
  onSend,
  isAgentRunning = false,
  assigneeAgentId,
  className,
}: IssueChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(comments.length);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (comments.length > prevCountRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    }
    prevCountRef.current = comments.length;
  }, [comments.length]);

  // Initial scroll to bottom
  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const runningAgentName = useMemo(() => {
    if (!assigneeAgentId || !agentMap) return undefined;
    return agentMap.get(assigneeAgentId)?.name;
  }, [assigneeAgentId, agentMap]);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-4 space-y-4 flex flex-col"
      >
        {comments.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              아직 대화가 없습니다. 메시지를 보내 대화를 시작하세요.
            </p>
          </div>
        )}

        {comments.map((comment) => (
          <ChatBubble
            key={comment.id}
            comment={comment}
            agentMap={agentMap}
            isAgent={!!comment.authorAgentId}
          />
        ))}

        {isAgentRunning && (
          <TypingIndicator agentName={runningAgentName} />
        )}
      </div>

      {/* Composer */}
      <ChatComposer onSend={onSend} />
    </div>
  );
}
