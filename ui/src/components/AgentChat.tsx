import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentDetail, IssueComment } from "@ironworksai/shared";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIconPicker";
import { getRoleLevel } from "../lib/role-icons";
import {
  Send,
  MessageSquare,
  Search,
  FileText,
  X,
  ClipboardList,
  Share2,
  PlusCircle,
  ChevronRight,
} from "lucide-react";

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

// ---- Chat Templates ----
const CHAT_TEMPLATES = [
  { label: "Review this code", prompt: "Review this code and provide feedback on quality, bugs, and improvements." },
  { label: "Write a report on...", prompt: "Write a report on " },
  { label: "Analyze project status", prompt: "Analyze the current project status and provide a summary of progress, blockers, and next steps." },
  { label: "What are you working on?", prompt: "What are you currently working on? Give me a status update." },
];

// ---- Suggested follow-up actions ----
function getSuggestedActions(lastAgentMessage: string | null): { label: string; icon: React.ElementType }[] {
  if (!lastAgentMessage) return [];
  const actions: { label: string; icon: React.ElementType }[] = [];

  const lower = lastAgentMessage.toLowerCase();

  // Always offer "Create issue from this" if the response is substantive
  if (lastAgentMessage.length > 80) {
    actions.push({ label: "Create issue from this", icon: PlusCircle });
  }

  // If it looks like a report/analysis, offer sharing
  if (lower.includes("summary") || lower.includes("report") || lower.includes("analysis") || lower.includes("findings")) {
    actions.push({ label: "Share to channel", icon: Share2 });
  }

  // If it mentions tasks/issues/items
  if (lower.includes("task") || lower.includes("issue") || lower.includes("todo") || lower.includes("item")) {
    actions.push({ label: "View related issues", icon: ClipboardList });
  }

  // If it mentions code/review
  if (lower.includes("code") || lower.includes("review") || lower.includes("bug") || lower.includes("fix")) {
    actions.push({ label: "Request detailed review", icon: FileText });
  }

  // Cap at 3
  return actions.slice(0, 3);
}

interface AgentChatProps {
  agent: AgentDetail;
  companyId: string;
}

export function AgentChat({ agent, companyId }: AgentChatProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Filter messages by search query
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.body.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  // Find last agent message for suggested actions
  const lastAgentMessage = useMemo(() => {
    const agentMsgs = messages.filter((m) => !m.fromUser);
    return agentMsgs.length > 0 ? agentMsgs[agentMsgs.length - 1].body : null;
  }, [messages]);

  const suggestedActions = useMemo(
    () => getSuggestedActions(lastAgentMessage),
    [lastAgentMessage],
  );

  // Detect if agent is actively processing (issue in_progress)
  const isTyping =
    !!chatIssue &&
    (chatIssue.status === "in_progress");

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (!searchQuery.trim()) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, isTyping, searchQuery]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
    }
  }, [showSearch]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      return agentsApi.sendChat(companyId, agent.id, message);
    },
    onSuccess: ({ issueId: newIssueId }) => {
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
    setShowTemplates(false);
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

  const handleTemplateSelect = useCallback((prompt: string) => {
    setInput(prompt);
    setShowTemplates(false);
    textareaRef.current?.focus();
  }, []);

  const handleSuggestedAction = useCallback((label: string) => {
    // Convert the action label into a follow-up prompt
    const prompts: Record<string, string> = {
      "Create issue from this": "Based on your last response, create a new issue with a clear title and description.",
      "Share to channel": "Format your last response as a brief update that can be shared with the team.",
      "View related issues": "List any related issues or tasks that are connected to what you just described.",
      "Request detailed review": "Provide a more detailed code review with specific line-by-line feedback.",
    };
    const prompt = prompts[label] ?? label;
    setInput(prompt);
    textareaRef.current?.focus();
  }, []);

  const agentRoleLevel = getRoleLevel(agent.role);
  const agentColor =
    agentRoleLevel === "executive"
      ? "text-amber-600 dark:text-amber-400"
      : agentRoleLevel === "management"
        ? "text-blue-600 dark:text-blue-400"
        : "text-muted-foreground";

  const isEmpty = !issueLoading && messages.length === 0 && !isTyping;

  const displayMessages = showSearch ? filteredMessages : messages;

  return (
    <div className="flex flex-col h-full min-h-[60vh] max-h-[80vh]">
      {/* Search bar + Templates toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        {showSearch ? (
          <div className="flex items-center gap-2 flex-1">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {searchQuery && (
              <span className="text-xs text-muted-foreground shrink-0">
                {filteredMessages.length} {filteredMessages.length === 1 ? "result" : "results"}
              </span>
            )}
            <button
              type="button"
              onClick={() => { setShowSearch(false); setSearchQuery(""); }}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowSearch(true)}
            >
              <Search className="h-3.5 w-3.5 mr-1" />
              Search
            </Button>
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setShowTemplates(!showTemplates)}
              >
                <FileText className="h-3.5 w-3.5 mr-1" />
                Templates
              </Button>
              {showTemplates && (
                <div className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-md">
                  {CHAT_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      onClick={() => handleTemplateSelect(tpl.prompt)}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent transition-colors"
                    >
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      {tpl.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

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

        {showSearch && searchQuery.trim() && filteredMessages.length === 0 && (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            No messages match "{searchQuery}"
          </div>
        )}

        {displayMessages.map((msg) => (
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

        {/* Suggested follow-up actions */}
        {!isTyping && suggestedActions.length > 0 && messages.length > 0 && !showSearch && (
          <div className="flex flex-wrap gap-2 pt-1">
            {suggestedActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => handleSuggestedAction(action.label)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Icon className="h-3 w-3" />
                  {action.label}
                </button>
              );
            })}
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
