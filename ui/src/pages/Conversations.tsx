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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import {
  listConversations,
  ensureConversation,
  sendMessage,
  renameConversation,
  conversationAgentLabel,
  CONVERSATION_PREFIX,
  type SendMessageResult,
} from "../api/conversations";
import { useToast } from "../context/ToastContext";
import { useConversationUnread } from "../hooks/useConversationUnread";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { CommentThread, type CommentWithRunMeta } from "../components/CommentThread";
import type { MentionOption } from "../components/MarkdownEditor";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { WorkspaceFileBrowser } from "../components/WorkspaceFileEditor";
import { Identity } from "../components/Identity";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  MessageSquare,
  Plus,
  Archive,
  ArrowLeft,
  Loader2,
  Pencil,
  Cpu,
  FolderOpen,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { Agent, Issue } from "@paperclipai/shared";

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
  onRename: (issueId: string, agentLabel: string, topic: string) => Promise<void>;
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
  onRename,
}: ConversationListProps) {
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const renameCommitted = useRef(false);
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
    issuesApi.list(companyId, { q: debouncedSearch, kind: "conversation" }).then((results) => {
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
    // Bypass filter immediately when input is cleared (don't wait for debounce)
    if (!search.trim() || !debouncedSearch.trim()) return conversations;
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
  }, [conversations, search, debouncedSearch, agentMap, serverResults]);

  const filteredArchived = useMemo(() => {
    if (!search.trim() || !debouncedSearch.trim()) return archivedConversations;
    const q = debouncedSearch.toLowerCase();
    return archivedConversations.filter((issue) => {
      const title = issue.title?.toLowerCase() ?? "";
      const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
      const name = agent?.name?.toLowerCase() ?? "";
      if (title.includes(q) || name.includes(q)) return true;
      return serverResults.has(issue.id);
    });
  }, [archivedConversations, search, debouncedSearch, agentMap, serverResults]);

  return (
    <div className="flex flex-col h-full border-r border-border bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-foreground">Conversations</span>
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
          aria-label="Search conversations"
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
                  {editingId === issue.id ? (
                    <input
                      autoFocus
                      className="text-[13px] font-medium bg-transparent border-b border-muted-foreground/30 outline-none w-full"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={async (e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!renameCommitted.current && editDraft.trim()) {
                            renameCommitted.current = true;
                            const agentLabel = agent?.name ?? label;
                            try {
                              await onRename(issue.id, agentLabel, editDraft.trim());
                              onSelect(issue.id);
                            } catch {
                              renameCommitted.current = false;
                            }
                          }
                          setEditingId(null);
                        }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={async () => {
                        if (!renameCommitted.current && editDraft.trim()) {
                          renameCommitted.current = true;
                          const agentLabel = agent?.name ?? label;
                          try {
                            await onRename(issue.id, agentLabel, editDraft.trim());
                            onSelect(issue.id);
                          } catch {
                            renameCommitted.current = false;
                          }
                        }
                        setEditingId(null);
                      }}
                      placeholder="Name this conversation..."
                    />
                  ) : (
                    <span className="text-[13px] font-medium truncate block">
                      {issue.title?.includes(" — ")
                        ? issue.title.split(" — ").slice(1).join(" — ")
                        : label || "Conversation"}
                    </span>
                  )}
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
                              renameCommitted.current = false;
                              const currentTopic = issue.title?.includes(" — ")
                                ? issue.title.split(" — ").slice(1).join(" — ")
                                : "";
                              setEditDraft(currentTopic);
                              setEditingId(issue.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                renameCommitted.current = false;
                                const currentTopic = issue.title?.includes(" — ")
                                  ? issue.title.split(" — ").slice(1).join(" — ")
                                  : "";
                                setEditDraft(currentTopic);
                                setEditingId(issue.id);
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
  const available = agents.filter((a) => {
    if (a.status === "terminated") return false;
    // Only show agents eligible for direct conversations: CEO or managers
    if (a.reportsTo === null) return true;
    return agents.some((other) => other.reportsTo === a.id);
  });

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <MessageSquare className="h-10 w-10 text-muted-foreground/30 mb-4" />
      <h2 className="text-lg font-semibold mb-1">New Conversation</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Pick an agent to chat with.
      </p>

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : available.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents available.</p>
      ) : (
        <div className="w-full max-w-xs space-y-1">
          {available.map((agent) => (
            <button
              key={agent.id}
              type="button"
              disabled={loading}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md border border-border hover:bg-accent/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => onPick(agent.id, agent.name)}
            >
              <Identity name={agent.name} size="sm" />
              <div className="min-w-0">
                <span className="text-sm font-medium truncate block">{agent.name}</span>
                <span className="text-[11px] text-muted-foreground truncate block">
                  {agent.role ?? "Agent"}
                  {agent.status === "paused" && (
                    <span className="ml-1 text-amber-500">(paused)</span>
                  )}
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

// ─── Waiting state for empty conversations ──────────────────────────────────

function ConversationWaitingState({
  agentName,
  conversationCreatedAt,
}: {
  agentName: string;
  conversationCreatedAt: string | Date;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(interval);
  }, []);

  const elapsedSeconds = Math.floor(
    (now - new Date(conversationCreatedAt).getTime()) / 1000,
  );

  let message: string;
  let showSpinner = true;

  if (elapsedSeconds < 60) {
    message = `Waiting for ${agentName} to respond...`;
  } else if (elapsedSeconds < 120) {
    message = `${agentName} is starting up — this may take a moment.`;
  } else if (elapsedSeconds < 240) {
    message = `Still waiting — ${agentName} may be handling a cold start.`;
  } else if (elapsedSeconds < 600) {
    message = `${agentName} is taking longer than expected. Check the agent's status page for details.`;
  } else {
    message = `${agentName} has not responded. There may be an issue — check the agent page for errors.`;
    showSpinner = false;
  }

  return (
    <div className="flex items-center justify-center gap-2 py-4">
      {showSpinner && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
      )}
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

// ─── Active conversation view (right panel) ────────────────────────────────

interface ConversationViewProps {
  issueId: string;
  companyId: string;
  agents: Agent[];
  onClose: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNew?: () => void;
}

function ConversationView({ issueId, companyId, agents, onClose, sidebarCollapsed, onToggleSidebar, onNew }: ConversationViewProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const prevCommentCountRef = useRef(0);

  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );

  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const headerRenameCommitted = useRef(false);

  // ── Model selector state ─────────────────────────────────────────────────
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);

  // ── File editor state ────────────────────────────────────────────────────
  const [browsingFiles, setBrowsingFiles] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);

  // Mark conversation as read when viewing it
  useEffect(() => {
    issuesApi.markRead(issueId).then(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.unread(companyId) });
    }).catch(() => {});
  }, [issueId, companyId, queryClient]);

  const { data: issue, isLoading: issueLoading } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: !!issueId,
  });

  // ── Model selector queries ──────────────────────────────────────────────
  const assignedAgent = issue?.assigneeAgentId
    ? agents.find((a) => a.id === issue.assigneeAgentId)
    : undefined;
  const adapterType = assignedAgent?.adapterType ?? undefined;

  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType ?? ""),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType!),
    enabled: !!adapterType,
  });

  const currentModelOverride = (
    issue?.assigneeAdapterOverrides as
      | { adapterConfig?: { model?: string } }
      | null
      | undefined
  )?.adapterConfig?.model as string | undefined;

  const defaultModel = (
    assignedAgent?.adapterConfig as { model?: string } | null | undefined
  )?.model as string | undefined;

  const modelMutation = useMutation({
    mutationFn: async (selectedModel: string | null) => {
      if (selectedModel === null) {
        // Clear override → revert to default
        return issuesApi.update(issueId, { assigneeAdapterOverrides: null });
      }
      return issuesApi.update(issueId, {
        assigneeAdapterOverrides: { adapterConfig: { model: selectedModel } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      setModelPopoverOpen(false);
    },
    onError: () => {
      pushToast({ title: "Failed to update model", tone: "error" });
    },
  });

  // ── Workspace query for file browser ────────────────────────────────────
  const { data: workspaceId } = useQuery({
    queryKey: queryKeys.projects.workspaces(issue?.projectId ?? ""),
    queryFn: async () => {
      if (!issue?.projectId) return null;
      const workspaces = await projectsApi.listWorkspaces(issue.projectId);
      const primary = workspaces.find((w) => w.isPrimary) ?? workspaces[0];
      return primary?.id ?? null;
    },
    enabled: !!issue?.projectId,
  });

  // ── Mentions (agents + projects) ──────────────────────────────────────
  const { data: companyProjects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    for (const agent of agents.filter((a) => a.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name))) {
      options.push({ id: `agent:${agent.id}`, name: agent.name, kind: "agent", agentId: agent.id, agentIcon: agent.icon });
    }
    for (const project of companyProjects ?? []) {
      options.push({ id: `project:${project.id}`, name: project.name, kind: "project", projectId: project.id });
    }
    return options;
  }, [agents, companyProjects]);

  const { data: comments, isLoading: commentsLoading } = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    enabled: !!issueId,
    refetchInterval: 4000,
  });

  // Auto-scroll to bottom when comments load or new messages arrive
  const commentCount = comments?.length ?? 0;
  useEffect(() => {
    if (commentCount > 0 && commentCount !== prevCommentCountRef.current) {
      const isInitialLoad = prevCommentCountRef.current === 0;
      prevCommentCountRef.current = commentCount;
      setTimeout(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: isInitialLoad ? "auto" : "smooth" });
      }, 50);
    }
  }, [commentCount]);

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
    mutationFn: async ({ body }: { body: string }): Promise<SendMessageResult> => {
      if (!issue?.assigneeAgentId) {
        await issuesApi.addComment(issueId, body);
        return { ok: true };
      }
      return sendMessage(issueId, issue.assigneeAgentId, body, companyId);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.list(companyId),
      });
      if (result && !result.ok) {
        pushToast({
          title: "Message sent, but agent may not respond",
          body: "The agent could not be woken up. It will respond on its next heartbeat.",
          tone: "warn",
        });
      }
    },
    onError: () => {
      pushToast({ title: "Failed to send message", tone: "error" });
    },
  });

  const imageUploadHandler = useCallback(
    async (file: File): Promise<string> => {
      const attachment = await issuesApi.uploadAttachment(companyId, issueId, file);
      return attachment.contentPath;
    },
    [companyId, issueId],
  );

  const handleFilePathClick = useCallback(
    (path: string) => {
      if (!workspaceId) return;
      setEditingFile(path);
    },
    [workspaceId],
  );

  const agentName = issue?.assigneeAgentId
    ? agentMap.get(issue.assigneeAgentId)?.name ?? "Agent"
    : "Agent";

  const commentsWithRunMeta = useMemo(
    () => (comments ?? []) as CommentWithRunMeta[],
    [comments],
  );

  const visibleComments = useMemo(() => {
    const isRunActive =
      activeRun &&
      (activeRun.status === "running" || activeRun.status === "queued");
    if (!isRunActive) return commentsWithRunMeta;

    const runStart = new Date(
      activeRun.startedAt ?? activeRun.createdAt,
    ).getTime();
    return commentsWithRunMeta.filter(
      (c) => !c.authorAgentId || new Date(c.createdAt).getTime() < runStart,
    );
  }, [commentsWithRunMeta, activeRun]);

  if (issueLoading || commentsLoading) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
          <div className="h-6 w-6 rounded-full bg-muted animate-pulse" />
          <div className="h-4 w-32 rounded bg-muted animate-pulse" />
        </div>
        <div className="flex-1 px-4 py-4 space-y-4">
          <div className="h-16 rounded bg-muted animate-pulse" />
          <div className="h-12 rounded bg-muted animate-pulse" />
          <div className="h-20 rounded bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Conversation header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        {onToggleSidebar && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground hidden md:flex"
                onClick={onToggleSidebar}
              >
                {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            </TooltipContent>
          </Tooltip>
        )}
        {sidebarCollapsed && onNew && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={onNew}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              New conversation
            </TooltipContent>
          </Tooltip>
        )}
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
                  if (!headerRenameCommitted.current && topicDraft.trim()) {
                    headerRenameCommitted.current = true;
                    try {
                      await renameConversation(issueId, agentName, topicDraft.trim());
                      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
                      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(companyId) });
                    } catch {
                      headerRenameCommitted.current = false;
                      pushToast({ title: "Failed to rename conversation", tone: "error" });
                    }
                  }
                  setEditingTopic(false);
                }
                if (e.key === "Escape") setEditingTopic(false);
              }}
              onBlur={async () => {
                if (!headerRenameCommitted.current && topicDraft.trim()) {
                  headerRenameCommitted.current = true;
                  try {
                    await renameConversation(issueId, agentName, topicDraft.trim());
                    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
                    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(companyId) });
                  } catch {
                    headerRenameCommitted.current = false;
                    pushToast({ title: "Failed to rename conversation", tone: "error" });
                  }
                }
                setEditingTopic(false);
              }}
              placeholder="Name this conversation..."
            />
          ) : (
            <div
              className="flex items-center gap-2 cursor-pointer group"
              onClick={() => {
                headerRenameCommitted.current = false;
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

        {/* ── Model selector ──────────────────────────────────────────── */}
        {adapterType && (
          <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-foreground gap-1.5 text-xs font-normal h-7 px-2"
                  >
                    <Cpu className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline max-w-30 truncate">
                      {currentModelOverride
                        ? currentModelOverride.split("/").pop()
                        : "Default"}
                    </span>
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {currentModelOverride
                  ? `Model: ${currentModelOverride}`
                  : `Model: Default (${defaultModel ?? "agent config"})`}
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              align="end"
              className="w-72 p-0 max-h-80 flex flex-col"
            >
              <div className="px-3 py-2 border-b border-border">
                <p className="text-xs font-medium">Select Model</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Override which model this agent uses for this conversation.
                </p>
              </div>
              <ScrollArea className="flex-1 max-h-65">
                <div className="p-1">
                  {/* Default option — clears override */}
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-left text-xs hover:bg-accent/50 transition-colors",
                      !currentModelOverride && "bg-accent",
                    )}
                    onClick={() => modelMutation.mutate(null)}
                    disabled={modelMutation.isPending}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        currentModelOverride
                          ? "text-transparent"
                          : "text-foreground",
                      )}
                    />
                    <span className="truncate">
                      Default{defaultModel ? ` (${defaultModel})` : ""}
                    </span>
                  </button>

                  {/* Available models */}
                  {(adapterModels ?? []).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-left text-xs hover:bg-accent/50 transition-colors",
                        currentModelOverride === m.id && "bg-accent",
                      )}
                      onClick={() => modelMutation.mutate(m.id)}
                      disabled={modelMutation.isPending}
                    >
                      <Check
                        className={cn(
                          "h-3 w-3 shrink-0",
                          currentModelOverride === m.id
                            ? "text-foreground"
                            : "text-transparent",
                        )}
                      />
                      <span className="truncate">{m.label || m.id}</span>
                    </button>
                  ))}

                  {adapterModels && adapterModels.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                      No models available for this adapter.
                    </p>
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
        )}

        {/* ── Browse Files button ─────────────────────────────────────── */}
        {workspaceId && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setBrowsingFiles(true)}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Browse workspace files
            </TooltipContent>
          </Tooltip>
        )}

        {/* ── Close conversation button ───────────────────────────────── */}
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
      <ScrollArea className="flex-1 px-4 py-4 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!w-full [&>[data-slot=scroll-area-viewport]>div]:!min-w-0">
        <CommentThread
          comments={visibleComments}
          linkedRuns={timelineRuns}
          companyId={companyId}
          issueStatus={issue?.status}
          agentMap={agentMap}
          draftKey={`paperclip:convo-draft:${issueId}`}
          submitLabel="Send"
          placeholder="Type your message here..."
          imageUploadHandler={imageUploadHandler}
          mentions={mentionOptions}
          stickyInput
          hideReopen
          hideHeader
          emptyState={
            issue?.createdAt ? (
              <ConversationWaitingState
                agentName={agentName}
                conversationCreatedAt={issue.createdAt}
              />
            ) : null
          }
          onAdd={async (body) => {
            await addComment.mutateAsync({ body });
          }}
          onFilePathClick={workspaceId ? handleFilePathClick : undefined}
          liveRunSlot={
            <LiveRunWidget issueId={issueId} companyId={companyId} />
          }
        />
        <div ref={scrollEndRef} />
      </ScrollArea>

      {/* ── File browser modal ──────────────────────────────────────────── */}
      {browsingFiles && workspaceId && (
        <WorkspaceFileBrowser
          companyId={companyId}
          workspaceId={workspaceId}
          onClose={() => setBrowsingFiles(false)}
          onSaved={() => {
            pushToast({ title: "File saved", tone: "success" });
          }}
        />
      )}

      {/* ── Direct file editor (from clicking a file path in a comment) ── */}
      {editingFile && workspaceId && (
        <WorkspaceFileBrowser
          companyId={companyId}
          workspaceId={workspaceId}
          initialFile={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={() => {
            pushToast({ title: "File saved", tone: "success" });
          }}
        />
      )}
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
  const { pushToast } = useToast();

  const [viewMode, setViewMode] = useState<ViewMode>(
    routeIssueId ? "chat" : "list",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(
    routeIssueId ?? null,
  );
  const [creating, setCreating] = useState(false);

  // Sync route param → local state (one-way: route drives state)
  useEffect(() => {
    if (routeIssueId) {
      setActiveIssueId(routeIssueId);
      setViewMode("chat");
    }
  }, [routeIssueId]);

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
    queryKey: queryKeys.conversations.list(selectedCompanyId!),
    queryFn: () => listConversations(selectedCompanyId!, { includeClosed: true }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8000,
  });

  const { unreadConvoIds } = useConversationUnread(selectedCompanyId);

  const { data: companyLiveRuns } = useQuery({
    queryKey: queryKeys.conversations.liveRuns(selectedCompanyId!),
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
          queryKey: queryKeys.conversations.list(selectedCompanyId!),
        });
        handleSelect(issue.id);
      } catch {
        pushToast({ title: "Failed to start conversation", tone: "error" });
      } finally {
        setCreating(false);
      }
    },
    [selectedCompanyId, queryClient, handleSelect],
  );

  const handleArchive = useCallback(
    async (issueId: string) => {
      try {
        await issuesApi.update(issueId, { status: "done" });
      } catch {
        pushToast({ title: "Failed to close conversation", tone: "error" });
        return;
      }
      if (activeIssueId === issueId) {
        setActiveIssueId(null);
        setViewMode("list");
        navigate("/conversations", { replace: true });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.list(selectedCompanyId!),
      });
    },
    [activeIssueId, selectedCompanyId, queryClient, navigate, pushToast],
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
    <div className="flex h-[calc(100dvh-3rem)] -m-4 md:-m-6 overflow-hidden">
      {/* Left panel — conversation list (collapsible, hidden on mobile when chatting) */}
      {!sidebarCollapsed && (
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
            onRename={async (issueId, agentLabel, topic) => {
              try {
                await renameConversation(issueId, agentLabel, topic);
                queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
                queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(selectedCompanyId!) });
              } catch {
                pushToast({ title: "Failed to rename conversation", tone: "error" });
                throw new Error("rename failed");
              }
            }}
          />
        </div>
      )}

      {/* Right panel — conversation view or picker */}
      <div className="w-0 flex-1 min-w-0">
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
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
            onNew={handleNew}
          />
        ) : (
          <EmptyConversation onNew={handleNew} />
        )}
      </div>
    </div>
  );
}
