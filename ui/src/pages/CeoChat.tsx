import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue, IssueLabel } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ChatInterface } from "../components/ChatInterface";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  Loader2,
  MessageSquarePlus,
  MessageSquare,
  Circle,
  ChevronLeft,
  Users,
  UserPlus,
  Search,
  X,
} from "lucide-react";

const CEO_CHAT_LABEL_NAME = "ceo-chat";

function useEnsureCeoChatLabel(companyId: string | null) {
  const queryClient = useQueryClient();

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.issues.labels(companyId ?? ""),
    queryFn: () => issuesApi.listLabels(companyId!),
    enabled: !!companyId,
  });

  const ceoChatLabel = labels.find(
    (l) => l.name.toLowerCase() === CEO_CHAT_LABEL_NAME,
  );

  const createLabelMutation = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("No company selected");
      return issuesApi.createLabel(companyId, {
        name: CEO_CHAT_LABEL_NAME,
        color: "#6366f1",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.labels(companyId ?? ""),
      });
    },
  });

  const ensureLabel = useCallback(async (): Promise<IssueLabel> => {
    if (ceoChatLabel) return ceoChatLabel;
    return createLabelMutation.mutateAsync();
  }, [ceoChatLabel, createLabelMutation]);

  return { ceoChatLabel, ensureLabel };
}

type SidebarView = "conversations" | "agents";

export function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("conversations");
  const [showNewChatPicker, setShowNewChatPicker] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const { ceoChatLabel, ensureLabel } = useEnsureCeoChatLabel(selectedCompanyId);

  // Fetch CEO chat conversations (issues with the ceo-chat label)
  const { data: conversations = [], isLoading: conversationsLoading } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? ""), "ceo-chat"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        labelId: ceoChatLabel?.id,
      }),
    enabled: !!selectedCompanyId && !!ceoChatLabel,
    refetchInterval: 5000,
  });

  // Fetch agents for status display
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map<string, Agent>();
  for (const agent of agents) {
    agentMap.set(agent.id, agent);
  }

  const filteredAgents = agents.filter(
    (a) =>
      !agentSearch ||
      a.name.toLowerCase().includes(agentSearch.toLowerCase()) ||
      (a.title ?? "").toLowerCase().includes(agentSearch.toLowerCase()) ||
      a.role.toLowerCase().includes(agentSearch.toLowerCase()),
  );

  // Start a new conversation, optionally assigned to a specific agent
  const handleNewConversation = useCallback(
    async (assignToAgentId?: string) => {
      if (!selectedCompanyId) return;
      setIsCreating(true);
      try {
        const label = await ensureLabel();
        const assignedAgent = assignToAgentId ? agentMap.get(assignToAgentId) : null;
        const titleSuffix = assignedAgent
          ? `with ${assignedAgent.name}`
          : new Date().toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
        const issue = await issuesApi.create(selectedCompanyId, {
          title: `CEO Chat - ${titleSuffix}`,
          description: assignedAgent
            ? `Direct conversation with ${assignedAgent.name} (${assignedAgent.title ?? assignedAgent.role})`
            : "CEO Chat conversation",
          labelIds: [label.id],
          ...(assignToAgentId ? { assigneeAgentId: assignToAgentId } : {}),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
        setSelectedIssueId(issue.id);
        setShowNewChatPicker(false);
        setSidebarView("conversations");
      } finally {
        setIsCreating(false);
      }
    },
    [selectedCompanyId, ensureLabel, queryClient, agentMap],
  );

  // Assign/reassign an agent to an existing conversation
  const assignAgentMutation = useMutation({
    mutationFn: async ({ issueId, agentId }: { issueId: string; agentId: string }) => {
      return issuesApi.update(issueId, { assigneeAgentId: agentId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(selectedCompanyId ?? ""),
      });
      if (selectedIssueId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.detail(selectedIssueId),
        });
      }
    },
  });

  // Find existing conversation with a specific agent
  const findConversationWithAgent = useCallback(
    (agentId: string) => {
      return conversations.find((c) => c.assigneeAgentId === agentId);
    },
    [conversations],
  );

  // Handle clicking on an agent in the roster
  const handleAgentClick = useCallback(
    (agentId: string) => {
      // Check if there's already a conversation with this agent
      const existing = findConversationWithAgent(agentId);
      if (existing) {
        setSelectedIssueId(existing.id);
        setSidebarView("conversations");
      } else {
        // Start a new conversation with this agent
        handleNewConversation(agentId);
      }
    },
    [findConversationWithAgent, handleNewConversation],
  );

  const selectedConversation = conversations.find((c) => c.id === selectedIssueId);
  const selectedAgent = selectedConversation?.assigneeAgentId
    ? agentMap.get(selectedConversation.assigneeAgentId)
    : null;

  // Mobile-responsive: show either list or chat
  const showChat = !!selectedIssueId;

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      {/* Sidebar - conversations + agents */}
      <div
        className={cn(
          "w-80 border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] flex flex-col shrink-0",
          showChat ? "hidden md:flex" : "flex w-full md:w-80",
        )}
      >
        {/* Sidebar header with tabs */}
        <div className="flex flex-col border-b border-border shrink-0">
          <div className="flex items-center justify-between px-4 py-3">
            <h1 className="text-[12px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">CEO Chat</h1>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setShowNewChatPicker(!showNewChatPicker)}
                disabled={isCreating}
              >
                {isCreating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                )}
                New
              </Button>
            </div>
          </div>

          {/* View toggle tabs */}
          <div className="flex border-t border-border/50">
            <button
              onClick={() => setSidebarView("conversations")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em] transition-colors",
                sidebarView === "conversations"
                  ? "text-[var(--primary)] border-b-2 border-[var(--primary)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Chats
              {conversations.length > 0 && (
                <span className="text-[9px] font-[var(--font-mono)] bg-[var(--primary)]/10 text-[var(--primary)] px-1.5 rounded-[2px]">
                  {conversations.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setSidebarView("agents")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em] transition-colors",
                sidebarView === "agents"
                  ? "text-[var(--primary)] border-b-2 border-[var(--primary)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Users className="h-3.5 w-3.5" />
              Team
              {agents.length > 0 && (
                <span className="text-[9px] font-[var(--font-mono)] bg-[var(--primary)]/10 text-[var(--primary)] px-1.5 rounded-[2px]">
                  {agents.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* New chat picker overlay */}
        {showNewChatPicker && (
          <div className="border-b border-border/50 bg-[var(--sidebar-accent)] px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em] text-foreground">Start chat with...</span>
              <button
                onClick={() => setShowNewChatPicker(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full mb-2 gap-1.5 text-xs"
              onClick={() => handleNewConversation()}
              disabled={isCreating}
            >
              <MessageSquarePlus className="h-3 w-3" />
              General Chat (no specific agent)
            </Button>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleNewConversation(agent.id)}
                  disabled={isCreating}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[2px] text-left hover:bg-[var(--sidebar-accent)] transition-colors"
                >
                  <AgentStatusDot status={agent.status} isRunning={false} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium font-[var(--font-display)] uppercase tracking-[0.04em] truncate">{agent.name}</div>
                    <div className="text-[9px] font-[var(--font-mono)] text-muted-foreground truncate">
                      {agent.title ?? agent.role}
                    </div>
                  </div>
                  <MessageSquarePlus className="h-3 w-3 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Content based on sidebar view */}
        <ScrollArea className="flex-1 min-h-0">
          {sidebarView === "conversations" ? (
            <>
              {conversationsLoading && (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading...
                </div>
              )}

              {!conversationsLoading && conversations.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted-foreground">
                  <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">No conversations yet.</p>
                  <p className="text-xs mt-1">
                    Click "New" or select an agent from the Team tab.
                  </p>
                </div>
              )}

              <div className="flex flex-col">
                {conversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    agentMap={agentMap}
                    isSelected={conv.id === selectedIssueId}
                    onSelect={() => setSelectedIssueId(conv.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            /* Agent roster view */
            <div className="flex flex-col">
              {/* Agent search */}
              <div className="px-3 py-2 border-b border-border/50">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder="Search agents..."
                    className="w-full pl-8 pr-3 py-1.5 text-[11px] font-[var(--font-mono)] rounded-[2px] border border-input bg-secondary placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 focus-visible:shadow-[0_0_8px_oklch(0.72_0.15_220_/_0.3)]"
                  />
                </div>
              </div>

              {filteredAgents.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted-foreground">
                  <Users className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">No agents found.</p>
                </div>
              )}

              {filteredAgents.map((agent) => {
                const existingConv = findConversationWithAgent(agent.id);
                return (
                  <AgentRosterItem
                    key={agent.id}
                    agent={agent}
                    hasConversation={!!existingConv}
                    onClick={() => handleAgentClick(agent.id)}
                  />
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Chat panel */}
      <div
        className={cn(
          "flex-1 flex flex-col min-w-0",
          !showChat ? "hidden md:flex" : "flex",
        )}
      >
        {showChat && selectedCompanyId ? (
          <>
            {/* Chat header with agent info */}
            <div className="md:hidden flex items-center px-2 py-1 border-b border-border">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1"
                onClick={() => setSelectedIssueId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </Button>
            </div>

            {/* Agent assignment bar - shown when no agent assigned */}
            {selectedConversation && !selectedConversation.assigneeAgentId && (
              <div className="flex items-center gap-2 px-4 py-2 bg-[var(--status-warning)]/[0.06] border-b border-[var(--status-warning)]/20">
                <UserPlus className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="text-[11px] font-[var(--font-mono)] text-[var(--status-warning)]">
                  No agent assigned.
                </span>
                <div className="flex items-center gap-1 ml-auto">
                  {agents.slice(0, 5).map((agent) => (
                    <Button
                      key={agent.id}
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] gap-1 px-2"
                      onClick={() =>
                        assignAgentMutation.mutate({
                          issueId: selectedConversation.id,
                          agentId: agent.id,
                        })
                      }
                    >
                      <AgentStatusDot status={agent.status} isRunning={false} />
                      {agent.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <ChatInterface
              issueId={selectedIssueId}
              companyId={selectedCompanyId}
              className="flex-1 min-h-0"
              showCircularOption
            />
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground hud-grid-bg">
            <MessageSquare className="h-12 w-12 mb-3 opacity-30 text-[var(--primary)]" />
            <p className="text-[12px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Select a conversation or start a new one</p>
            <p className="text-[11px] font-[var(--font-mono)] mt-2 max-w-xs text-center">
              Use the "Team" tab to chat with a specific agent, or click "New" to start a general conversation.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationItem({
  conversation,
  agentMap,
  isSelected,
  onSelect,
}: {
  conversation: Issue;
  agentMap: Map<string, Agent>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const assignedAgent = conversation.assigneeAgentId
    ? agentMap.get(conversation.assigneeAgentId)
    : null;
  const isRunning = conversation.status === "in_progress";
  const createdAt =
    typeof conversation.createdAt === "string"
      ? new Date(conversation.createdAt)
      : conversation.createdAt;
  const updatedAt =
    typeof conversation.updatedAt === "string"
      ? new Date(conversation.updatedAt)
      : conversation.updatedAt;
  const displayTime = updatedAt ?? createdAt;

  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 px-4 py-3 text-left border-b border-border/30 transition-colors",
        "hover:bg-[var(--sidebar-accent)]",
        isSelected && "bg-[var(--sidebar-accent)] border-l-2 border-l-[var(--primary)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.04em] truncate flex-1">
          {conversation.title}
        </span>
        {conversation.identifier && (
          <span className="text-[9px] font-[var(--font-mono)] text-muted-foreground shrink-0">
            {conversation.identifier}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] font-[var(--font-mono)] text-muted-foreground">
        {assignedAgent ? (
          <div className="flex items-center gap-1">
            <AgentStatusDot status={assignedAgent.status} isRunning={isRunning} />
            <span className="truncate">{assignedAgent.name}</span>
          </div>
        ) : (
          <span className="italic">Unassigned</span>
        )}
        <span className="ml-auto shrink-0">
          {displayTime ? relativeTime(displayTime) : ""}
        </span>
      </div>
    </button>
  );
}

function AgentRosterItem({
  agent,
  hasConversation,
  onClick,
}: {
  agent: Agent;
  hasConversation: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-3 text-left border-b border-border/30 hover:bg-[var(--sidebar-accent)] transition-colors w-full"
    >
      {/* Agent avatar */}
      <div className="flex items-center justify-center h-9 w-9 rounded-[2px] bg-[var(--sidebar-accent)] shrink-0 relative">
        {agent.icon ? (
          <span className="text-base">{agent.icon}</span>
        ) : (
          <Bot className="h-5 w-5 text-muted-foreground" />
        )}
        {/* Status indicator */}
        <div className="absolute -bottom-0.5 -right-0.5">
          <AgentStatusDot status={agent.status} isRunning={agent.status === "running"} />
        </div>
      </div>

      {/* Agent info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.04em] truncate">{agent.name}</span>
          <span
            className={cn(
              "text-[9px] font-[var(--font-mono)] uppercase px-1.5 py-0.5 rounded-[2px]",
              agent.status === "running" || agent.status === "active"
                ? "bg-[var(--status-active)]/15 text-[var(--status-active)]"
                : agent.status === "error"
                  ? "bg-[var(--status-error)]/15 text-[var(--status-error)]"
                  : agent.status === "paused"
                    ? "bg-[var(--status-warning)]/15 text-[var(--status-warning)]"
                    : "bg-muted text-muted-foreground",
            )}
          >
            {agent.status}
          </span>
        </div>
        <div className="text-[10px] font-[var(--font-mono)] text-muted-foreground truncate">
          {agent.title ?? agent.role}
        </div>
      </div>

      {/* Chat indicator */}
      <div className="shrink-0">
        {hasConversation ? (
          <div className="flex items-center gap-1 text-[9px] font-[var(--font-mono)] uppercase text-[var(--primary)]">
            <MessageSquare className="h-3 w-3" />
            <span>Open</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[9px] font-[var(--font-mono)] uppercase text-muted-foreground">
            <MessageSquarePlus className="h-3 w-3" />
            <span>Chat</span>
          </div>
        )}
      </div>
    </button>
  );
}

function AgentStatusDot({
  status,
  isRunning,
}: {
  status: string;
  isRunning: boolean;
}) {
  if (isRunning) {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--status-active)] hud-glow" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--status-active)]" />
      </span>
    );
  }

  const colorClass =
    status === "running" || status === "active"
      ? "text-[var(--status-active)]"
      : status === "error"
        ? "text-[var(--status-error)]"
        : status === "paused"
          ? "text-[var(--status-warning)]"
          : "text-muted-foreground";

  return <Circle className={cn("h-2.5 w-2.5 fill-current", colorClass)} />;
}
