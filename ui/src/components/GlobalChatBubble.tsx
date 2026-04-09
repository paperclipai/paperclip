import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, X, Minus, ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { AgentChatThread } from "./AgentChatThread";
import { chatsApi } from "../api/chats";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";

export function GlobalChatBubble() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 30000,
  });

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  const { data: chats = [] } = useQuery({
    queryKey: queryKeys.chats.list(selectedAgentId ?? ""),
    queryFn: () => chatsApi.list(selectedAgentId!),
    enabled: Boolean(selectedAgentId),
    staleTime: 10000,
  });

  // Auto-select most recent active chat when agent changes
  useEffect(() => {
    setSelectedChatId(null);
  }, [selectedAgentId]);

  useEffect(() => {
    if (!selectedChatId && chats.length > 0) {
      const active = chats.find((c) => c.status === "active");
      if (active) setSelectedChatId(active.id);
    }
  }, [chats, selectedChatId]);

  const createChat = useMutation({
    mutationFn: () => chatsApi.create(selectedAgentId!),
    onSuccess: (newChat) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedAgentId!) });
      setSelectedChatId(newChat.id);
    },
  });

  const handleOpen = () => {
    setIsOpen(true);
    setIsMinimized(false);
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]!.id);
    }
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setAgentPickerOpen(false);
    if (!selectedChatId) {
      const existing = queryClient.getQueryData<typeof chats>(queryKeys.chats.list(agentId));
      const active = existing?.find((c) => c.status === "active");
      if (!active) {
        // Will be auto-created after list loads
      }
    }
  };

  // Close agent picker on outside click
  useEffect(() => {
    if (!agentPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setAgentPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [agentPickerOpen]);

  if (!isOpen) {
    return (
      <button
        title="Open chat"
        onClick={handleOpen}
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105 transition-transform flex items-center justify-center"
      >
        <MessageCircle className="h-5 w-5" />
      </button>
    );
  }

  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-card border border-border rounded-full px-3 py-2 shadow-lg">
        {selectedAgent && (
          <AgentIcon icon={selectedAgent.icon ?? null} className="h-4 w-4" />
        )}
        <span className="text-sm font-medium">{selectedAgent?.name ?? "Chat"}</span>
        <button
          title="Expand"
          onClick={() => setIsMinimized(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4 rotate-180" />
        </button>
        <button
          title="Close"
          onClick={() => setIsOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col w-96 h-[560px] bg-card border border-border rounded-xl shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0 rounded-t-xl">
        {/* Agent selector */}
        <div className="relative flex-1 min-w-0" ref={agentPickerRef}>
          <button
            onClick={() => setAgentPickerOpen((p) => !p)}
            className="flex items-center gap-2 text-sm font-medium hover:opacity-80 w-full min-w-0 truncate"
          >
            {selectedAgent ? (
              <>
                <AgentIcon icon={selectedAgent.icon ?? null} className="h-4 w-4 shrink-0" />
                <span className="truncate">{selectedAgent.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Select agent…</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 ml-auto" />
          </button>
          {agentPickerOpen && (
            <div className="absolute left-0 bottom-full mb-1 w-56 bg-popover border border-border rounded-md shadow-lg z-10 max-h-64 overflow-y-auto">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleSelectAgent(agent.id)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent text-left",
                    selectedAgentId === agent.id && "bg-accent",
                  )}
                >
                  <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{agent.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* New chat */}
        {selectedAgent && (
          <button
            title="New chat"
            onClick={() => createChat.mutate()}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border hover:bg-accent shrink-0"
          >
            + New
          </button>
        )}

        {/* Minimize / close */}
        <button
          title="Minimize"
          onClick={() => setIsMinimized(true)}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          title="Close"
          onClick={() => setIsOpen(false)}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Chat body */}
      <div className="flex-1 min-h-0 overflow-hidden rounded-b-xl">
        {selectedAgent && selectedChatId ? (
          <AgentChatThread
            agentId={selectedAgent.id}
            chatId={selectedChatId}
            agent={selectedAgent}
          />
        ) : selectedAgent ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-muted-foreground">
            <p>No active chat.</p>
            <button
              onClick={() => createChat.mutate()}
              className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-80"
            >
              Start a chat
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an agent to start chatting.
          </div>
        )}
      </div>
    </div>
  );
}
