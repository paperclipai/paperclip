import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { Agent } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { AgentChatInput } from "./AgentChatInput";
import { MarkdownBody } from "./MarkdownBody";
import { quickChatsApi, type AgentChatMessage, type QuickChatResponse } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";

interface QuickChatPanelProps {
  issueId: string;
  commentId: string;
  agent: Agent;
  onClose: () => void;
}

const TOOL_LINE_RE = /^Tool used:/i;

function isToolAnnotation(line: string) {
  return TOOL_LINE_RE.test(line.trim());
}

function ChatBubble({ message, agentIcon }: { message: AgentChatMessage; agentIcon?: string | null }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) return null;

  if (!isUser) {
    const lines = message.body.split("\n");
    const toolLines: string[] = [];
    const contentLines: string[] = [];
    for (const line of lines) {
      if (isToolAnnotation(line)) {
        toolLines.push(line.trim());
      } else {
        contentLines.push(line);
      }
    }
    const content = contentLines.join("\n").trim();

    return (
      <div className="flex gap-3 items-start">
        <div className="shrink-0 mt-0.5">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
            <AgentIcon icon={agentIcon ?? null} className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          {toolLines.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {toolLines.map((tl, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  {tl.replace(/^Tool used:\s*/i, "")}
                </span>
              ))}
            </div>
          )}
          {content && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownBody>{content}</MarkdownBody>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {message.body}
      </div>
    </div>
  );
}

export function QuickChatPanel({ issueId, commentId, agent, onClose }: QuickChatPanelProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const prevMessageCountRef = useRef(0);

  const { data, isLoading } = useQuery<QuickChatResponse>({
    queryKey: queryKeys.quickChat.detail(commentId),
    queryFn: () => quickChatsApi.createOrGet(issueId, commentId, agent.id),
    staleTime: 30000,
  });

  const chatId = data?.chat?.id ?? null;
  const messages = data?.messages ?? [];

  // Detect new agent message and clear thinking
  useEffect(() => {
    const prev = prevMessageCountRef.current;
    const curr = messages.length;
    if (curr > prev) {
      const latest = messages[curr - 1];
      if (latest?.role === "agent") {
        setIsAgentThinking(false);
      }
    }
    prevMessageCountRef.current = curr;
  }, [messages]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isAgentThinking]);

  const sendMessage = useMutation({
    mutationFn: (body: string) => quickChatsApi.sendMessage(issueId, commentId, agent.id, body),
    onMutate: () => {
      setIsAgentThinking(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.quickChat.detail(commentId) });
    },
    onError: () => {
      setIsAgentThinking(false);
    },
  });

  const visibleMessages = messages.filter((m) => m.role !== "system");

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex flex-col w-full max-w-sm border-l border-border bg-background shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
            <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <Link
              to={`/agents/${agent.id}`}
              className="text-sm font-medium hover:underline truncate block"
            >
              {agent.name}
            </Link>
            <p className="text-xs text-muted-foreground">Quick chat · this comment</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isLoading && visibleMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground text-sm gap-2 py-12">
            <AgentIcon icon={agent.icon ?? null} className="h-8 w-8 opacity-30" />
            <p>
              Ask {agent.name} about this comment. The full issue thread up to this point is already loaded as context.
            </p>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} agentIcon={agent.icon} />
        ))}
        {isAgentThinking && (
          <div className="flex gap-3 items-start">
            <div className="shrink-0 mt-0.5">
              <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
                <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Thinking…</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <AgentChatInput
        disabled={isLoading || !chatId}
        isLoading={sendMessage.isPending}
        onSend={(body) => sendMessage.mutate(body)}
      />
    </div>
  );
}
