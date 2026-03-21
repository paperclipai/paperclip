/**
 * @fileoverview Conversations hub — a chat-first interface for board↔agent
 * communication built on top of Paperclip's issue and comment primitives.
 *
 * Layout: left sidebar with search, active conversations, and collapsible
 * conversation history; right panel showing the selected conversation as a
 * chat timeline with live run streaming and inline run history.
 *
 * Every conversation is backed by a regular issue. No new backend endpoints
 * are needed. Features include:
 * - Agent picker for starting new conversations
 * - Real-time streaming via LiveRunWidget during agent responses
 * - Inline run history cards linked to full transcript pages
 * - Client-side + server-side conversation search (titles, agents, comments)
 * - Unread message indicators (sidebar badge + per-conversation dot)
 * - Editable conversation titles (header + sidebar rename)
 * - Close/archive conversations with collapsible history section
 * - Conversations hidden from Issues page, Inbox, and Dashboard
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import {
  listConversations,
  ensureConversation,
  sendMessage,
  renameConversation,
  conversationAgentLabel,
  isConversationIssue,
  CONVERSATION_PREFIX,
} from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { CommentThread } from "../components/CommentThread";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { Identity } from "../components/Identity";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MessageSquare,
  Plus,
  Archive,
  ArrowLeft,
  Loader2,
  Pencil,
} from "lucide-react";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";

// ─── Conversation list (left sidebar) ──────────────────────────────────────

interface ConversationListProps {
  conversations: Issue[];
  archivedConversations: Issue[];
  agents: Agent[];
  activeIssueId: string | null;
  liveIds: Set<string>;
  unreadIds: Set<string>;
  companyId: string;
  onSelect: (issueId: string) => void;
  onNew: () => void;
  onArchive: (issueId: string) => void;
}

function ConversationList({
  conversations,
  archivedConversations,
  agents,
  activeIssueId,
  unreadIds,
  liveIds,
  companyId,
  onSelect,
  onNew,
  onArchive,
}: ConversationListProps) {
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [serverResults, setServerResults] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  // Server-side search for message content
  useEffect(() => {
    if (!debouncedSearch.trim()) {
      setServerResults(new Set());
      return;
    }
    let cancelled = false;
    const allConvos = [...conversations, ...archivedConversations];
    // Search issues with q parameter — searches titles, descriptions, and comments
    issuesApi.list(companyId, { q: debouncedSearch }).then((results) => {
      if (cancelled) return;
      const convoIds = new Set(allConvos.map(c => c.id));
      const matchIds = new Set(results.filter(r => convoIds.has(r.id)).map(r => r.id));
      setServerResults(matchIds);
    }).catch(() => {
      if (!cancelled) setServerResults(new Set());
    });
    return () => { cancelled = true; };
  }, [debouncedSearch, conversations, archivedConversations]);

  const filteredConversations = useMemo(() => {
    if (!debouncedSearch.trim()) return conversations;
    const q = debouncedSearch.toLowerCase();
    return conversations.filter((issue) => {
      // Client-side match on title/name
      const title = issue.title?.toLowerCase() ?? "";
      const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
      const name = agent?.name?.toLowerCase() ?? "";
      if (title.includes(q) || name.includes(q)) return true;
      // Server-side match on comment content
      return serverResults.has(issue.id);
    });
  }, [conversations, debouncedSearch, agentMap, serverResults]);

  const filteredArchived = useMemo(() => {
    if (!debouncedSearch.trim()) return archivedConversations;
    const q = debouncedSearch.toLowerCase();
    return archivedConversations.filter((issue) => {
      const title = issue.title?.toLowerCase() ?? "";
      const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
      const name = agent?.name?.toLowerCase() ?? "";
      if (title.includes(q) || name.includes(q)) return true;
      return serverResults.has(issue.id);
    });
  }, [archivedConversations, debouncedSearch, agentMap, serverResults]);

  return (
    <div className="flex flex-col h-full border-r border-border bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-12 border-b border-border shrink-0">
        <span className="text-sm font-semibold text-foreground">Conversations</span>
        <Button variant="ghost" size="icon-sm" onClick={onNew} title="New conversation">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations..."
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground/40 focus:border-muted-foreground/50"
        />
      </div>

      {/* List */}
      <ScrollArea className="flex-1 w-full">
        <div className="flex flex-col py-1 min-w-0">
          {filteredConversations.length === 0 && !search.trim() && (
            <div className="px-4 py-8 text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No conversations yet.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={onNew}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Start a conversation
              </Button>
            </div>
          )}
          {filteredConversations.map((issue) => {
            const agent = issue.assigneeAgentId
              ? agentMap.get(issue.assigneeAgentId)
              : null;
            const label = conversationAgentLabel(issue);
            const isActive = issue.id === activeIssueId;

            return (
              <button
                key={issue.id}
                type="button"
                onClick={() => onSelect(issue.id)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors w-full group overflow-hidden",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-foreground/80 hover:bg-accent/50",
                )}
              >
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <div className="shrink-0 h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                      {(agent?.name ?? label).slice(0, 2).toUpperCase()}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="start" className="text-xs">
                    {agent?.name ?? label}
                  </TooltipContent>
                </Tooltip>
                {liveIds.has(issue.id) ? (
                  <span className="relative h-2 w-2 shrink-0">
                    <span className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-75" />
                    <span className="relative rounded-full h-2 w-2 bg-blue-500 block" />
                  </span>
                ) : unreadIds.has(issue.id) ? (
                  <span className="h-2 w-2 rounded-full bg-white/70 shrink-0" />
                ) : null}
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium truncate block">
                    {issue.title?.includes(" — ")
                      ? issue.title.split(" — ").slice(1).join(" — ")
                      : label || "Conversation"}
                  </span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[10px] text-muted-foreground flex-1">
                      {timeAgo(issue.updatedAt)}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              const currentTopic = issue.title?.includes(" — ")
                                ? issue.title.split(" — ").slice(1).join(" — ")
                                : "";
                              const newTitle = prompt("Rename conversation:", currentTopic);
                              if (newTitle !== null && newTitle.trim()) {
                                const agentLabel = agent?.name ?? label;
                                renameConversation(issue.id, agentLabel, newTitle.trim()).then(() => {
                                  onSelect(issue.id);
                                });
                              }
                            }}
                            className="text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            <Pencil className="h-3 w-3" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Rename conversation
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              onArchive(issue.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                onArchive(issue.id);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                const currentTopic = issue.title?.includes(" — ")
                                  ? issue.title.split(" — ").slice(1).join(" — ")
                                  : "";
                                const newTitle = prompt("Rename conversation:", currentTopic);
                                if (newTitle !== null && newTitle.trim()) {
                                  const agentLabel = agent?.name ?? label;
                                  renameConversation(issue.id, agentLabel, newTitle.trim()).then(() => {
                                    onSelect(issue.id);
                                  });
                                }
                              }
                            }}
                            className="text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            <Archive className="h-3 w-3" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Close conversation
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {filteredArchived.length > 0 && (
          <details className="border-t border-border">
            <summary className="px-3 py-2 text-[11px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none">
              Conversation History ({filteredArchived.length})
            </summary>
            <div className="flex flex-col pb-1 opacity-60">
              {filteredArchived.map((issue) => {
                const agent = issue.assigneeAgentId
                  ? agentMap.get(issue.assigneeAgentId)
                  : null;
                const label = conversationAgentLabel(issue);
                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onSelect(issue.id)}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 text-left transition-colors w-full text-[12px] text-muted-foreground hover:bg-accent/30",
                      issue.id === activeIssueId && "bg-accent/40",
                    )}
                  >
                    <Identity name={agent?.name ?? label} size="sm" />
                    <span className="truncate">
                      {issue.title?.includes(" — ")
                        ? issue.title.split(" — ").slice(1).join(" — ")
                        : label || "Conversation"}
                    </span>
                    <span className="ml-auto text-[10px] shrink-0">{timeAgo(issue.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          </details>
        )}
      </ScrollArea>
    </div>
  );
}

// ─── Agent picker for new conversations ────────────────────────────────────

interface AgentPickerProps {
  agents: Agent[];
  loading: boolean;
  onPick: (agentId: string, agentName: string) => void;
  onCancel: () => void;
}

function AgentPicker({ agents, loading, onPick, onCancel }: AgentPickerProps) {
  const active = agents.filter((a) => a.status === "active" || a.status === "idle");

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <MessageSquare className="h-10 w-10 text-muted-foreground/30 mb-4" />
      <h2 className="text-lg font-semibold mb-1">New Conversation</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Pick an agent to chat with.
      </p>

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active agents available.</p>
      ) : (
        <div className="w-full max-w-xs space-y-1">
          {active.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md border border-border hover:bg-accent/50 transition-colors text-left"
              onClick={() => onPick(agent.id, agent.name)}
            >
              <Identity name={agent.name} size="sm" />
              <div className="min-w-0">
                <span className="text-sm font-medium truncate block">{agent.name}</span>
                <span className="text-[11px] text-muted-foreground truncate block">
                  {agent.role ?? "Agent"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Button variant="ghost" size="sm" className="mt-4" onClick={onCancel}>
        <ArrowLeft className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  );
}

// ─── Empty state when no conversation is selected ──────────────────────────

function EmptyConversation({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <MessageSquare className="h-12 w-12 text-muted-foreground/20 mb-4" />
      <h2 className="text-lg font-semibold mb-1">Select a conversation</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Pick an existing conversation or start a new one.
      </p>
      <Button variant="outline" size="sm" onClick={onNew}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        New conversation
      </Button>
    </div>
  );
}

// ─── Active conversation view (right panel) ────────────────────────────────

interface ConversationViewProps {
  issueId: string;
  companyId: string;
  agents: Agent[];
  onClose: () => void;
}

function ConversationView({ issueId, companyId, agents, onClose }: ConversationViewProps) {
  const queryClient = useQueryClient();

  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );

  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");

  // Mark conversation as read when viewing it
  useEffect(() => {
    issuesApi.markRead(issueId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["conversations-unread"] });
    }).catch(() => {});
  }, [issueId, queryClient]);

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: !!issueId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    enabled: !!issueId,
    refetchInterval: 4000,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 5000,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });
  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });
  // Filter out runs shown by LiveRunWidget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const addComment = useMutation({
    mutationFn: async ({ body }: { body: string }) => {
      if (!issue?.assigneeAgentId) {
        await issuesApi.addComment(issueId, body);
        return;
      }
      await sendMessage(issueId, issue.assigneeAgentId, body, companyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: ["conversations", companyId],
      });
    },
  });

  const agentName = issue?.assigneeAgentId
    ? agentMap.get(issue.assigneeAgentId)?.name ?? "Agent"
    : "Agent";

  // Build comment-with-run-meta list matching IssueDetail pattern
  const commentsWithRunMeta = useMemo(
    () =>
      (comments ?? []).map((c: IssueComment) => ({
        ...c,
        runId: (c as unknown as Record<string, unknown>).runId as string | null | undefined,
        runAgentId: (c as unknown as Record<string, unknown>).runAgentId as string | null | undefined,
      })),
    [comments],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header */}
      <div className="flex items-center gap-3 px-4 h-12 border-b border-border shrink-0">
        <Identity name={agentName} size="sm" />
        <div className="flex-1 min-w-0">
          {editingTopic ? (
            <input
              autoFocus
              className="text-sm font-semibold bg-transparent border-b border-muted-foreground/30 outline-none w-full"
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (topicDraft.trim()) {
                    await renameConversation(issueId, agentName, topicDraft.trim());
                    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
                    queryClient.invalidateQueries({ queryKey: ["conversations", companyId] });
                  }
                  setEditingTopic(false);
                }
                if (e.key === "Escape") setEditingTopic(false);
              }}
              onBlur={async () => {
                if (topicDraft.trim()) {
                  await renameConversation(issueId, agentName, topicDraft.trim());
                  queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
                  queryClient.invalidateQueries({ queryKey: ["conversations", companyId] });
                }
                setEditingTopic(false);
              }}
              placeholder="Name this conversation..."
            />
          ) : (
            <div
              className="flex items-center gap-2 cursor-pointer group"
              onClick={() => {
                const currentTopic = issue?.title?.includes(" — ")
                  ? issue.title.split(" — ").slice(1).join(" — ")
                  : "";
                setTopicDraft(currentTopic);
                setEditingTopic(true);
              }}
            >
              <span className="text-sm font-semibold truncate hover:text-foreground transition-colors">
                {issue?.title?.includes(" — ")
                  ? issue.title.split(" — ").slice(1).join(" — ")
                  : agentName}
              </span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  Click to edit title
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <Archive className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Close conversation
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Chat timeline */}
      <ScrollArea className="flex-1 px-4 py-4">
        <CommentThread
          comments={commentsWithRunMeta}
          linkedRuns={timelineRuns}
          companyId={companyId}
          issueStatus={issue?.status}
          agentMap={agentMap}
          draftKey={`paperclip:convo-draft:${issueId}`}
          submitLabel="Send"
          hideReopen
          hideHeader
          onAdd={async (body) => {
            await addComment.mutateAsync({ body });
          }}
          liveRunSlot={
            <LiveRunWidget issueId={issueId} companyId={companyId} />
          }
        />
      </ScrollArea>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

type ViewMode = "list" | "picking" | "chat";

export function Conversations() {
  const { issueId: routeIssueId } = useParams<{ issueId?: string }>();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<ViewMode>(
    routeIssueId ? "chat" : "list",
  );
  const [activeIssueId, setActiveIssueId] = useState<string | null>(
    routeIssueId ?? null,
  );
  const [creating, setCreating] = useState(false);

  // Sync route param → local state
  useEffect(() => {
    if (routeIssueId && routeIssueId !== activeIssueId) {
      setActiveIssueId(routeIssueId);
      setViewMode("chat");
    }
  }, [routeIssueId, activeIssueId]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Conversations" }]);
  }, [setBreadcrumbs]);

  // Data queries
  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations", selectedCompanyId],
    queryFn: () => listConversations(selectedCompanyId!, { includeClosed: true }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8000,
  });

  const { data: unreadConvos = [] } = useQuery({
    queryKey: ["conversations-unread", selectedCompanyId],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        unreadForUserId: "me",
        status: "backlog,todo,in_progress,in_review,blocked",
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8_000,
  });
  const unreadConvoIds = useMemo(
    () => new Set(unreadConvos.filter(i => i.title?.startsWith("Conversation: ")).map(i => i.id)),
    [unreadConvos],
  );

  const { data: companyLiveRuns } = useQuery({
    queryKey: ["conversations-live-runs", selectedCompanyId],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 3_000,
  });
  const liveConvoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of companyLiveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [companyLiveRuns]);

  const activeConversations = conversations.filter(
    (i) => !["done", "cancelled"].includes(i.status?.toLowerCase() ?? ""),
  );
  const archivedConversations = conversations.filter(
    (i) => ["done", "cancelled"].includes(i.status?.toLowerCase() ?? ""),
  );

  // Handlers
  const handleSelect = useCallback(
    (issueId: string) => {
      setActiveIssueId(issueId);
      setViewMode("chat");
      navigate(`/conversations/${issueId}`, { replace: true });
    },
    [navigate],
  );

  const handleNew = useCallback(() => {
    setViewMode("picking");
  }, []);

  const handleCancelPick = useCallback(() => {
    setViewMode(activeIssueId ? "chat" : "list");
  }, [activeIssueId]);

  const handlePick = useCallback(
    async (agentId: string, agentName: string) => {
      if (!selectedCompanyId) return;
      setCreating(true);
      try {
        const issue = await ensureConversation(
          selectedCompanyId,
          agentId,
          agentName,
        );
        queryClient.invalidateQueries({
          queryKey: ["conversations", selectedCompanyId],
        });
        handleSelect(issue.id);
      } finally {
        setCreating(false);
      }
    },
    [selectedCompanyId, queryClient, handleSelect],
  );

  const handleArchive = useCallback(
    async (issueId: string) => {
      await issuesApi.update(issueId, { status: "done" });
      queryClient.invalidateQueries({
        queryKey: ["conversations", selectedCompanyId],
      });
      if (activeIssueId === issueId) {
        setActiveIssueId(null);
        setViewMode("list");
        navigate("/conversations", { replace: true });
      }
    },
    [activeIssueId, selectedCompanyId, queryClient, navigate],
  );

  // Loading state
  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a company first.
      </div>
    );
  }

  // Render
  return (
    <div className="flex h-[calc(100vh-3rem)] -m-4 md:-m-6">
      {/* Left panel — conversation list (fixed 260px, hidden on mobile when chatting) */}
      <div
        className={cn(
          "w-[260px] max-w-[260px] shrink-0 hidden md:flex flex-col overflow-hidden",
          viewMode !== "chat" && "flex",
        )}
      >
        <ConversationList
          conversations={activeConversations}
          archivedConversations={archivedConversations}
          agents={agents}
          activeIssueId={activeIssueId}
          unreadIds={unreadConvoIds}
          liveIds={liveConvoIds}
          companyId={selectedCompanyId}
          onSelect={handleSelect}
          onNew={handleNew}
          onArchive={handleArchive}
        />
      </div>

      {/* Right panel — conversation view or picker */}
      <div className="flex-1 min-w-0">
        {viewMode === "picking" || creating ? (
          <AgentPicker
            agents={agents}
            loading={agentsLoading || creating}
            onPick={handlePick}
            onCancel={handleCancelPick}
          />
        ) : activeIssueId ? (
          <ConversationView
            issueId={activeIssueId}
            companyId={selectedCompanyId}
            agents={agents}
            onClose={() => handleArchive(activeIssueId)}
          />
        ) : (
          <EmptyConversation onNew={handleNew} />
        )}
      </div>
    </div>
  );
}
