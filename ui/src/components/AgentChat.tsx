import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { EmptyState } from "./EmptyState";

interface AgentChatProps {
  agentId: string;
}

interface ChatMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export function AgentChat({ agentId }: AgentChatProps) {
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch chat messages with polling
  const messagesQuery = useQuery({
    queryKey: queryKeys.agents.chat(agentId),
    queryFn: () => agentsApi.getChatMessages(agentId),
    refetchInterval: 2000,
    enabled: !!agentId,
  });

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (msg: string) => agentsApi.sendChatMessage(agentId, msg),
    onSuccess: () => {
      setMessage("");
      // Refetch messages after sending
      messagesQuery.refetch();
    },
  });

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesQuery.data]);

  const handleSend = () => {
    if (!message.trim()) return;
    sendMutation.mutate(message);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (messagesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (messagesQuery.isError) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-4">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load chat messages</p>
        </div>
      </div>
    );
  }

  const messages = messagesQuery.data || [];

  return (
    <div className="flex flex-col h-96 gap-4 border rounded-lg p-4 bg-background">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {messages.length === 0 ? (
          <EmptyState
            icon={Send}
            message="No messages yet. Start a conversation with your agent!"
          />
        ) : (
          <>
            {messages.map((msg: ChatMessage) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-3 py-2 rounded-lg text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <p className="break-words whitespace-pre-wrap">{msg.content}</p>
                  <p
                    className={`text-xs mt-1 opacity-70 ${
                      msg.role === "user" ? "text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Message input */}
      <div className="flex gap-2 border-t pt-4">
        <Input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={sendMutation.isPending}
          className="flex-1"
        />
        <Button
          onClick={handleSend}
          disabled={!message.trim() || sendMutation.isPending}
          size="icon"
        >
          {sendMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
