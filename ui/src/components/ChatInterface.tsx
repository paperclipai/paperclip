import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, IssueComment } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Identity } from "./Identity";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Paperclip, Send, Loader2, Bot, User, Megaphone } from "lucide-react";

interface ChatInterfaceProps {
  issueId: string;
  companyId: string;
  className?: string;
  /** When true, shows circular broadcast option in the composer */
  showCircularOption?: boolean;
}

interface ChatMessage extends IssueComment {
  isAgent: boolean;
  agentName?: string;
}

export function ChatInterface({ issueId, companyId, className, showCircularOption }: ChatInterfaceProps) {
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [messageText, setMessageText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [isCircular, setIsCircular] = useState(false);

  const { data: comments = [], isLoading: commentsLoading } = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    refetchInterval: 3000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
  });

  const agentMap = new Map<string, Agent>();
  for (const agent of agents) {
    agentMap.set(agent.id, agent);
  }

  const chatMessages: ChatMessage[] = comments.map((comment) => {
    const isAgent = !!comment.authorAgentId;
    const agent = comment.authorAgentId ? agentMap.get(comment.authorAgentId) : undefined;
    return {
      ...comment,
      isAgent,
      agentName: agent?.name ?? (isAgent ? "Agent" : undefined),
    };
  });

  const addCommentMutation = useMutation({
    mutationFn: async ({ body, circular }: { body: string; circular?: boolean }) => {
      return issuesApi.addComment(issueId, body, undefined, undefined, circular || undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
    },
  });

  const uploadAttachmentMutation = useMutation({
    mutationFn: async (file: File) => {
      return issuesApi.uploadAttachment(companyId, issueId, file);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
    },
  });

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages.length]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [messageText]);

  const handleSend = useCallback(async () => {
    const trimmed = messageText.trim();
    if (!trimmed && !attachedFile) return;

    setIsSending(true);
    try {
      if (attachedFile) {
        await uploadAttachmentMutation.mutateAsync(attachedFile);
        setAttachedFile(null);
      }
      if (trimmed) {
        await addCommentMutation.mutateAsync({ body: trimmed, circular: isCircular || undefined });
        setMessageText("");
        setIsCircular(false);
      }
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [messageText, attachedFile, addCommentMutation, uploadAttachmentMutation, isCircular]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAttachedFile(file);
    }
    // Reset the input so same file can be selected again
    e.target.value = "";
  }, []);

  const isAgentRunning = issue?.status === "in_progress";

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Chat header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-[12px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em] truncate">{issue?.title ?? "Chat"}</h2>
          {issue?.identifier && (
            <span className="text-[10px] font-[var(--font-mono)] text-muted-foreground">{issue.identifier}</span>
          )}
        </div>
        {isAgentRunning && (
          <div className="flex items-center gap-1.5 text-[10px] font-[var(--font-mono)] text-[var(--status-warning)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Agent working...</span>
          </div>
        )}
      </div>

      {/* Messages area */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-1 p-4">
          {commentsLoading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading messages...
            </div>
          )}

          {!commentsLoading && chatMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Bot className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No messages yet. Start the conversation.</p>
            </div>
          )}

          {chatMessages.map((msg) => (
            <ChatBubble
              key={msg.id}
              message={msg}
              agentMap={agentMap}
            />
          ))}

          {/* Streaming/thinking indicator */}
          {isAgentRunning && chatMessages.length > 0 && (
            <div className="flex items-start gap-3 py-2 pr-12">
              <div className="flex items-center justify-center h-8 w-8 rounded-[2px] bg-[var(--status-violet)]/10 ring-2 ring-[var(--status-violet)]/30 shrink-0">
                <Bot className="h-4 w-4 text-[var(--status-violet)]" />
              </div>
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-[2px] bg-card border border-border shadow-sm text-[11px] font-[var(--font-mono)] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin text-[var(--status-violet)]" />
                <span>Agent is thinking...</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Composer */}
      <div className="border-t border-border p-3 shrink-0">
        {attachedFile && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-[2px] bg-[var(--sidebar-accent)] text-[11px] font-[var(--font-mono)]">
            <Paperclip className="h-3 w-3 text-muted-foreground" />
            <span className="truncate flex-1">{attachedFile.name}</span>
            <button
              onClick={() => setAttachedFile(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              &times;
            </button>
          </div>
        )}
        {/* Circular broadcast indicator */}
        {isCircular && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-[2px] bg-[var(--status-warning)]/[0.06] border border-[var(--status-warning)]/20 text-[11px] font-[var(--font-mono)] text-[var(--status-warning)]">
            <Megaphone className="h-3.5 w-3.5" />
            <span className="font-semibold font-[var(--font-display)] uppercase tracking-[0.04em]">Circular Message</span>
            <span className="text-[var(--status-warning)]/80">— This will be broadcast to all agents with highest priority</span>
            <button
              onClick={() => setIsCircular(false)}
              className="ml-auto text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
            >
              &times;
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          {showCircularOption && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "shrink-0",
                isCircular
                  ? "text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setIsCircular(!isCircular)}
              disabled={isSending}
              title={isCircular ? "Cancel circular broadcast" : "Send as circular (broadcast to all agents)"}
            >
              <Megaphone className="h-4 w-4" />
            </Button>
          )}
          <textarea
            ref={textareaRef}
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            rows={1}
            disabled={isSending}
            className={cn(
              "flex-1 resize-none rounded-[2px] border border-input bg-secondary px-3 py-2 text-sm font-[var(--font-mono)]",
              "placeholder:text-muted-foreground placeholder:font-[var(--font-mono)] placeholder:text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 focus-visible:shadow-[0_0_8px_oklch(0.72_0.15_220_/_0.3)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "min-h-[36px] max-h-[160px]",
            )}
          />
          <Button
            size="icon-sm"
            className={cn("shrink-0", isCircular && "bg-amber-600 hover:bg-amber-700")}
            onClick={handleSend}
            disabled={isSending || (!messageText.trim() && !attachedFile)}
            title={isCircular ? "Send circular to all agents" : "Send message"}
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isCircular ? (
              <Megaphone className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  agentMap,
}: {
  message: ChatMessage;
  agentMap: Map<string, Agent>;
}) {
  const isAgent = message.isAgent;
  const agent = message.authorAgentId ? agentMap.get(message.authorAgentId) : undefined;
  const createdAt = typeof message.createdAt === "string" ? new Date(message.createdAt) : message.createdAt;

  return (
    <div
      className={cn(
        "flex items-start gap-3 py-2",
        isAgent ? "flex-row pr-12" : "flex-row-reverse pl-12",
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex items-center justify-center h-8 w-8 rounded-[2px] shrink-0 text-sm font-bold",
          isAgent
            ? "bg-[var(--status-violet)]/10 ring-2 ring-[var(--status-violet)]/30"
            : "bg-[var(--primary)]/10 ring-2 ring-[var(--primary)]/30",
        )}
      >
        {isAgent ? (
          agent?.icon ? (
            <span className="text-base">{agent.icon}</span>
          ) : (
            <Bot className="h-4 w-4 text-[var(--status-violet)]" />
          )
        ) : (
          <User className="h-4 w-4 text-[var(--primary)]" />
        )}
      </div>

      {/* Message content */}
      <div
        className={cn(
          "flex flex-col max-w-[80%] min-w-0",
          isAgent ? "items-start" : "items-end",
        )}
      >
        <div className={cn(
          "flex items-center gap-2 mb-1",
          isAgent ? "flex-row" : "flex-row-reverse",
        )}>
          <span className={cn(
            "text-[10px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]",
            isAgent
              ? "text-[var(--status-violet)]"
              : "text-[var(--primary)]",
          )}>
            {isAgent
              ? (message.agentName ?? "Agent")
              : "You"}
          </span>
          {isAgent && agent?.title && (
            <span className="text-[9px] font-[var(--font-mono)] text-muted-foreground bg-[var(--sidebar-accent)] px-1.5 py-0.5 rounded-[2px]">
              {agent.title}
            </span>
          )}
          <span className="text-[9px] font-[var(--font-mono)] text-muted-foreground">
            {relativeTime(createdAt)}
          </span>
        </div>
        <div
          className={cn(
            "rounded-[2px] px-4 py-2.5 text-sm shadow-sm",
            isAgent
              ? "bg-card border border-border text-foreground hud-panel"
              : "bg-[var(--primary)] rounded-tr-[2px] text-white",
          )}
        >
          {isAgent ? (
            <MarkdownBody className="prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {message.body}
            </MarkdownBody>
          ) : (
            <MarkdownBody className="prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-invert">
              {message.body}
            </MarkdownBody>
          )}
        </div>
      </div>
    </div>
  );
}
