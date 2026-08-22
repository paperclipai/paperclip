import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IssueComment, Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownBody } from "./MarkdownBody";

// ─── Types ──────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date | string;
  authorName?: string;
  authorAvatar?: string;
  isStreaming?: boolean;
  runId?: string;
}

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  agentName?: string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
}

interface ChatModeProps {
  issueId?: string;
  companyId?: string | null;
  comments: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  activeRun?: LinkedRunItem | null;
  agentMap?: Map<string, Agent>;
  onSendMessage: (body: string) => Promise<void>;
  liveRunSlot?: React.ReactNode;
  transcriptEntries?: Array<{ content: string; role: string; timestamp: Date }>;
  isStreaming?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────

function getAgentName(agentId: string | null | undefined, agentMap?: Map<string, Agent>): string {
  if (!agentId) return "Agent";
  const agent = agentMap?.get(agentId);
  if (agent?.name) return agent.name;
  return `Agent ${agentId.slice(0, 8)}`;
}

function commentsToChatMessages(
  comments: CommentWithRunMeta[],
  linkedRuns?: LinkedRunItem[],
  agentMap?: Map<string, Agent>,
): ChatMessage[] {
  const runMap = new Map(linkedRuns?.map((r) => [r.runId, r]));

  return comments.map((comment) => {
    // Check if this comment was created by an agent run
    const linkedRun = comment.runId ? runMap.get(comment.runId) : undefined;
    const isAgentComment = !!linkedRun || !!comment.authorAgentId;

    return {
      id: comment.id,
      role: isAgentComment ? "assistant" : "user",
      content: comment.body ?? "",
      createdAt: comment.createdAt,
      authorName: isAgentComment
        ? getAgentName(linkedRun?.agentId ?? comment.authorAgentId, agentMap)
        : "Board",
      runId: comment.runId ?? undefined,
    };
  });
}

// ─── Component ─────────────────────────────────────────────

export function ChatMode({
  comments,
  linkedRuns,
  activeRun,
  agentMap,
  onSendMessage,
  liveRunSlot,
  transcriptEntries,
  isStreaming,
}: ChatModeProps) {
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Convert comments + runs to chat messages
  const messages = useMemo(
    () => commentsToChatMessages(comments, linkedRuns, agentMap),
    [comments, linkedRuns, agentMap],
  );

  // Add streaming message placeholder when active
  const displayMessages = useMemo(() => {
    const msgs = [...messages];

    // Add streaming indicator for active run
    if ((isStreaming || activeRun) && !msgs.some((m) => m.isStreaming)) {
      msgs.push({
        id: "streaming",
        role: "assistant",
        content: "",
        createdAt: new Date(),
        authorName: getAgentName(activeRun?.agentId, agentMap),
        isStreaming: true,
        runId: activeRun?.runId,
      });
    }

    // Append transcript entries as assistant messages if available
    if (transcriptEntries && transcriptEntries.length > 0) {
      const baseIdx = msgs.length;
      for (const entry of transcriptEntries.slice(-3)) {
        // Only add non-empty entries that aren't already represented
        if (entry.content && !msgs.find((m) => m.content === entry.content && m.role === entry.role)) {
          // Stable key derived from content hash rather than timestamps
          const contentHash = entry.content.slice(0, 20).replace(/\s+/g, "-");
          msgs.push({
            id: `transcript-${contentHash}-${entry.role}-${baseIdx}`,
            role: entry.role === "tool" ? "system" : "assistant",
            content: entry.content,
            createdAt: entry.timestamp ?? new Date(),
            authorName: entry.role === "tool" ? "Tool" : getAgentName(activeRun?.agentId, agentMap),
          });
        }
      }
    }

    return msgs;
  }, [messages, isStreaming, activeRun, transcriptEntries, agentMap]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current && displayMessages.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages.length, isStreaming]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    try {
      await onSendMessage(trimmed);
      setInput("");
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-sm font-medium text-foreground">
            {activeRun ? "Agent is thinking..." : "Chat"}
          </span>
        </div>

        {(agentMap && agentMap.size > 0) && (
          <div className="text-xs text-muted-foreground">
            {Array.from(agentMap.values()).map((a) => a.name ?? a.id).join(", ")}
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea ref={scrollRef} className="flex-1 px-4 py-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {displayMessages.length === 0 && (
            <div className="text-center py-12 text-sm text-muted-foreground">
              <p className="font-medium">Start a conversation</p>
              <p className="mt-1 text-xs">Your message will be sent as a comment and wake the assigned agent.</p>
            </div>
          )}

          {displayMessages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
              {/* Avatar */}
              <div
                className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : msg.role === "system"
                      ? "bg-muted text-muted-foreground"
                      : "bg-secondary text-secondary-foreground"
                }`}
              >
                {msg.authorName?.[0]?.toUpperCase() ?? (msg.role === "user" ? "U" : "A")}
              </div>

              {/* Message bubble */}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : msg.role === "system"
                      ? "bg-muted border border-border text-muted-foreground font-mono text-xs"
                      : "bg-secondary text-secondary-foreground border border-border/50"
                }`}
              >
                {msg.isStreaming ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="h-1.5 w-1.5 rounded-full bg-current animate-pulse opacity-60" />
                    <span className="text-xs">Thinking...</span>
                  </div>
                ) : (
                  <MarkdownBody>{msg.content}</MarkdownBody>
                )}
              </div>
            </div>
          ))}

          {/* Live run widget slot */}
          {liveRunSlot}
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t border-border p-4">
        <div className="max-w-3xl mx-auto space-y-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeRun ? "Agent is running — please wait..." : "Type a message and press Enter..."}
            disabled={!!activeRun || isSending}
            rows={3}
            className="resize-none bg-background text-sm"
          />

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Shift+Enter for new line · Comments create issues and wake agents
            </span>

            <Button
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || !!activeRun || isSending}
            >
              {isSending ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
