import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentDetail, IssueComment } from "@ironworksai/shared";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIconPicker";
import { getRoleLevel } from "../lib/role-icons";
import { Send, MessageSquare } from "lucide-react";

const POLL_INTERVAL_MS = 3_000;

interface ChatMessage {
  id: string;
  body: string;
  fromUser: boolean;
  createdAt: Date;
  authorAgentId: string | null;
  authorUserId: string | null;
}

function normalizeComments(comments: IssueComment[]): ChatMessage[] {
  return [...comments]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((c) => ({
      id: c.id,
      body: c.body,
      fromUser: c.authorUserId !== null && c.authorAgentId === null,
      createdAt: new Date(c.createdAt),
      authorAgentId: c.authorAgentId,
      authorUserId: c.authorUserId,
    }));
}

interface AgentChatProps {
  agent: AgentDetail;
  companyId: string;
}

export function AgentChat({ agent, companyId }: AgentChatProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Get or create the chat issue
  const {
    data: chatIssue,
    isLoading: issueLoading,
  } = useQuery({
    queryKey: queryKeys.agentChat.issue(companyId, agent.id),
    queryFn: () => agentsApi.getChatIssue(companyId, agent.id),
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Poll comments when we have an issue
  const issueId = chatIssue?.id ?? null;
  const {
    data: commentsRaw,
    isLoading: commentsLoading,
  } = useQuery({
    queryKey: issueId
      ? queryKeys.agentChat.comments(companyId, agent.id, issueId)
      : ["agent-chat", companyId, agent.id, "comments", "__none__"],
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const messages = commentsRaw ? normalizeComments(commentsRaw) : [];

  // Detect if agent is actively processing (issue in_progress)
  const isTyping =
    !!chatIssue &&
    (chatIssue.status === "in_progress");

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isTyping]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      return agentsApi.sendChat(companyId, agent.id, message);
    },
    onSuccess: ({ issueId: newIssueId }) => {
      // Invalidate chat issue and comments so they refetch immediately
      queryClient.invalidateQueries({ queryKey: queryKeys.agentChat.issue(companyId, agent.id) });
      if (newIssueId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentChat.comments(companyId, agent.id, newIssueId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.comments(newIssueId),
        });
      }
    },
  });

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || sendMutation.isPending) return;
    setInput("");
    sendMutation.mutate(trimmed);
  }, [input, sendMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const agentRoleLevel = getRoleLevel(agent.role);
  const agentColor =
    agentRoleLevel === "executive"
      ? "text-amber-600 dark:text-amber-400"
      : agentRoleLevel === "management"
        ? "text-blue-600 dark:text-blue-400"
        : "text-muted-foreground";

  const isEmpty = !issueLoading && messages.length === 0 && !isTyping;

  return (
    <div className="flex flex-col h-full min-h-[60vh] max-h-[80vh]">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {(issueLoading || commentsLoading) && messages.length === 0 && (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            Loading conversation...
          </div>
        )}

        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <div className={cn(
              "flex items-center justify-center h-12 w-12 rounded-full",
              agentRoleLevel === "executive"
                ? "bg-amber-500/10"
                : agentRoleLevel === "management"
                  ? "bg-blue-500/10"
                  : "bg-accent",
            )}>
              <AgentIcon icon={agent.icon} className={cn("h-7 w-7", agentColor)} />
            </div>
            <div>
              <p className="text-sm font-medium">{agent.name}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Send a message to start a conversation.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex gap-2.5 max-w-[85%]",
              msg.fromUser ? "ml-auto flex-row-reverse" : "mr-auto flex-row",
            )}
          >
            {/* Avatar */}
            {!msg.fromUser && (
              <div className={cn(
                "shrink-0 flex items-center justify-center h-7 w-7 rounded-full",
                agentRoleLevel === "executive"
                  ? "bg-amber-500/10"
                  : agentRoleLevel === "management"
                    ? "bg-blue-500/10"
                    : "bg-accent",
              )}>
                <AgentIcon icon={agent.icon} className={cn("h-4 w-4", agentColor)} />
              </div>
            )}

            <div className="flex flex-col gap-0.5">
              {/* Bubble */}
              <div
                className={cn(
                  "px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words",
                  msg.fromUser
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-accent text-foreground rounded-tl-sm",
                )}
              >
                {msg.body}
              </div>
              {/* Timestamp */}
              <span
                className={cn(
                  "text-[11px] text-muted-foreground",
                  msg.fromUser ? "text-right" : "text-left",
                )}
              >
                {relativeTime(msg.createdAt)}
              </span>
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isTyping && (
          <div className="flex gap-2.5 max-w-[85%] mr-auto">
            <div className={cn(
              "shrink-0 flex items-center justify-center h-7 w-7 rounded-full",
              agentRoleLevel === "executive"
                ? "bg-amber-500/10"
                : agentRoleLevel === "management"
                  ? "bg-blue-500/10"
                  : "bg-accent",
            )}>
              <AgentIcon icon={agent.icon} className={cn("h-4 w-4", agentColor)} />
            </div>
            <div className="bg-accent px-3 py-2.5 rounded-2xl rounded-tl-sm flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Error banner */}
      {sendMutation.isError && (
        <p className="px-4 py-1 text-xs text-destructive">
          Failed to send message. Please try again.
        </p>
      )}

      {/* Input area */}
      <div className="border-t border-border px-4 py-3 flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${agent.name}...`}
          className={cn(
            "flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring",
            "min-h-[40px] max-h-[160px] overflow-y-auto",
          )}
          style={{ height: "auto" }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          disabled={sendMutation.isPending}
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!input.trim() || sendMutation.isPending}
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
