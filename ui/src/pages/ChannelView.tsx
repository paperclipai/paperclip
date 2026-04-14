import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Crown, Pin, PinOff, ChevronDown, ChevronRight, BarChart2, Brain, GitPullRequest, Users, MessageSquare, CircleDot, CheckCircle2, ShieldAlert, X, Search, CheckCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { channelsApi } from "../api/channels";
import type { Channel, ChannelMessage } from "../api/channels";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { AgentIcon } from "../components/AgentIconPicker";
import { getRoleLevel } from "../lib/role-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// ---- Role badge (same logic as SidebarAgents) ----
function RoleBadge({ role, employmentType }: { role?: string | null; employmentType?: string }) {
  const level = getRoleLevel(role);

  if (employmentType === "contractor") {
    return (
      <span className="text-[10px] font-medium px-1 py-0 rounded-full leading-tight border border-dashed border-amber-500 text-amber-600 dark:text-amber-400 shrink-0">
        CTR
      </span>
    );
  }
  if (level === "executive") {
    return (
      <span className="text-[10px] font-medium px-1 py-0 rounded-full leading-tight bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
        C
      </span>
    );
  }
  if (level === "management") {
    return (
      <span className="text-[10px] font-medium px-1 py-0 rounded-full leading-tight bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">
        M
      </span>
    );
  }
  return (
    <span className="text-[10px] font-medium px-1 py-0 rounded-full leading-tight bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-500 shrink-0">
      FTE
    </span>
  );
}

// ---- Message type badge + colored left border ----
const MESSAGE_TYPE_STYLES: Record<string, string> = {
  status_update: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  question: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  decision: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-500",
  escalation: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  announcement: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  deliberation_start: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400",
  deliberation_summary: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
};

// Colored left border by message type (12.15)
const MESSAGE_TYPE_BORDER: Record<string, string> = {
  status_update: "border-l-blue-400",
  question: "border-l-amber-400",
  decision: "border-l-green-400",
  escalation: "border-l-red-400",
  announcement: "border-l-purple-400",
  deliberation_start: "border-l-indigo-400",
  deliberation_summary: "border-l-teal-400",
};

function MessageTypeBadge({ type }: { type: string }) {
  if (!type || type === "message") return null;
  const cls = MESSAGE_TYPE_STYLES[type] ?? "bg-muted text-muted-foreground";
  const label = type.replace(/_/g, " ");
  return (
    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none", cls)}>
      {label}
    </span>
  );
}

// ---- Format timestamp ----
function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ---- Filters ----
type FilterMode = "all" | "decisions" | "analytics";

function matchesFilter(msg: ChannelMessage, mode: FilterMode): boolean {
  if (mode === "all") return true;
  if (mode === "analytics") return true;
  return msg.messageType === "decision" || msg.messageType === "escalation";
}

// ---- Reasoning collapsible ----
function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3 w-3" />
        {expanded ? "Hide reasoning" : "Show reasoning"}
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="mt-1 ml-3 border-l-2 border-border pl-3 text-[12px] text-muted-foreground whitespace-pre-wrap break-words bg-muted/20 rounded-sm py-1 pr-2">
          {reasoning}
        </div>
      )}
    </div>
  );
}

// ---- Quorum Indicator (Feature 7) ----
function QuorumIndicator({ companyId, channelId, messageId }: { companyId: string; channelId: string; messageId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.channels.quorum(companyId, channelId, messageId),
    queryFn: () => channelsApi.quorum(companyId, channelId, messageId),
    staleTime: 30_000,
  });

  if (!data || data.required.length === 0) return null;

  return (
    <div className={cn(
      "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full shrink-0 mt-0.5",
      data.quorumReached
        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    )}>
      <Users className="h-2.5 w-2.5" />
      {data.responded.length}/{data.required.length}
    </div>
  );
}

// ---- Issue ID chip renderer ----
const ISSUE_ID_REGEX = /\b([A-Z]{2,8}-\d{1,6})\b/g;

function IssueStatusIcon({ status }: { status?: string }) {
  if (status === "done") return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
  if (status === "in_progress") return <CircleDot className="h-3 w-3 text-blue-500" />;
  if (status === "blocked") return <ShieldAlert className="h-3 w-3 text-red-500" />;
  return <CircleDot className="h-3 w-3 text-muted-foreground" />;
}

function renderBodyWithEmbeds(
  body: string,
  issueMap: Map<string, { identifier: string; title: string; status?: string }>,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(ISSUE_ID_REGEX.source, "g");

  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    const issueId = match[1];
    const issue = [...issueMap.values()].find((i) => i.identifier === issueId);
    if (issue) {
      parts.push(
        <Link
          key={`${issueId}-${match.index}`}
          to={`/issues/${issueId}`}
          className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 text-[11px] font-medium border border-border rounded-md bg-muted/30 hover:bg-accent/50 transition-colors no-underline text-inherit"
          onClick={(e) => e.stopPropagation()}
        >
          <IssueStatusIcon status={issue.status} />
          {issueId}
        </Link>,
      );
    } else {
      parts.push(
        <span key={`${issueId}-${match.index}`} className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 text-[11px] font-mono border border-border rounded-md bg-muted/20">
          {issueId}
        </span>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [body];
}

// ---- Single message row ----
interface MessageRowProps {
  msg: ChannelMessage;
  agentMap: Map<string, { name: string; icon: string | null; role: string | null; employmentType?: string }>;
  issueMap: Map<string, { identifier: string; title: string; status?: string }>;
  replyMap: Map<string, ChannelMessage>;
  onPin?: (messageId: string) => void;
  onUnpin?: (messageId: string) => void;
  isPinned?: boolean;
  onCreateIssue?: (messageId: string) => void;
  onReply?: (messageId: string) => void;
  threadReplies?: ChannelMessage[];
  companyId?: string;
  channelId?: string;
}

function MessageRow({ msg, agentMap, issueMap, replyMap, onPin, onUnpin, isPinned, onCreateIssue, onReply, threadReplies, companyId, channelId }: MessageRowProps) {
  const isHumanUser = Boolean(msg.authorUserId);
  const isBoard = !msg.authorAgentId && !msg.authorUserId;
  const isHumanOrBoard = isHumanUser || isBoard;
  const agent = msg.authorAgentId ? agentMap.get(msg.authorAgentId) : null;
  const authorUserName = (msg as unknown as Record<string, unknown>).authorUserName as string | null | undefined;
  const authorName = isHumanOrBoard
    ? (authorUserName ?? "Board")
    : agent?.name ?? "Agent";
  const replyTo = msg.replyToId ? replyMap.get(msg.replyToId) : null;
  const linkedIssue = msg.linkedIssueId ? issueMap.get(msg.linkedIssueId) : null;

  // Determine left border color by message type (12.15)
  const borderClass = msg.messageType && msg.messageType !== "message"
    ? MESSAGE_TYPE_BORDER[msg.messageType] ?? ""
    : "";

  return (
    <div
      className={cn(
        "group relative flex gap-3 px-4 py-2 hover:bg-accent/30 transition-colors",
        // Colored left border for message types (12.15)
        borderClass && `border-l-[3px] ${borderClass}`,
        isBoard && !borderClass && "border-l-[3px] border-l-amber-400 bg-amber-50/30 dark:bg-amber-900/10",
        isPinned && "bg-amber-50/20 dark:bg-amber-900/5",
      )}
    >
      {/* Action buttons shown on hover */}
      <div className="absolute right-3 top-2 hidden group-hover:flex items-center gap-1.5">
        {/* Reply button */}
        {onReply && (
          <button
            onClick={() => onReply(msg.id)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title="Reply to message"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
        )}
        {/* Create Issue button */}
        {onCreateIssue && !msg.linkedIssueId && msg.messageType === "message" && (
          <button
            onClick={() => onCreateIssue(msg.id)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title="Create mission from message"
          >
            <GitPullRequest className="h-3 w-3" />
          </button>
        )}
        {/* Pin / unpin button */}
        {(onPin || onUnpin) && (
          <button
            onClick={() => isPinned ? onUnpin?.(msg.id) : onPin?.(msg.id)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title={isPinned ? "Unpin message" : "Pin message"}
          >
            {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          </button>
        )}
      </div>

      {/* Author icon - larger avatars (12.15) */}
      <div className="shrink-0 mt-0.5">
        {isHumanOrBoard ? (
          <div className="h-9 w-9 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <Crown className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
        ) : (
          <div className="h-9 w-9 rounded-full bg-accent flex items-center justify-center">
            <AgentIcon
              icon={agent?.icon ?? null}
              className={cn(
                "h-5 w-5",
                getRoleLevel(agent?.role) === "executive"
                  ? "text-amber-500 dark:text-amber-400"
                  : getRoleLevel(agent?.role) === "management"
                    ? "text-blue-500 dark:text-blue-400"
                    : "text-muted-foreground",
              )}
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header row: name + badge + timestamp */}
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className={cn(
              "text-[13px] font-semibold leading-tight",
              isBoard ? "text-amber-700 dark:text-amber-400" : "text-foreground",
            )}
          >
            {authorName}
          </span>
          {!isBoard && agent && (
            <RoleBadge role={agent.role} employmentType={agent.employmentType} />
          )}
          {isBoard && (
            <span className="text-[10px] font-medium px-1 py-0 rounded-full leading-tight bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-300 dark:border-amber-700 shrink-0">
              BOARD
            </span>
          )}
          {/* Quorum indicator for decision messages */}
          {msg.messageType === "decision" && companyId && channelId && (
            <QuorumIndicator companyId={companyId} channelId={channelId} messageId={msg.id} />
          )}
          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
            {formatTime(msg.createdAt)}
          </span>
        </div>

        {/* Message type badge (non-message types only) */}
        {msg.messageType && msg.messageType !== "message" && (
          <div className="mb-1">
            <MessageTypeBadge type={msg.messageType} />
          </div>
        )}

        {/* Reply indicator */}
        {replyTo && (
          <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground border-l-2 border-border pl-2">
            <span>Replying to</span>
            <span className="font-medium truncate max-w-[200px]">{replyTo.body}</span>
          </div>
        )}

        {/* Body with rich embeds for issue IDs */}
        <p className="text-[13px] text-foreground/90 whitespace-pre-wrap break-words">
          {renderBodyWithEmbeds(msg.body, issueMap)}
        </p>

        {/* Transparent reasoning collapsible */}
        {msg.reasoning && <ReasoningBlock reasoning={msg.reasoning} />}

        {/* Linked issue chip */}
        {linkedIssue && (
          <div className="mt-1.5">
            <Link
              to={`/issues/${msg.linkedIssueId}`}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground border border-border rounded-md px-2 py-0.5 bg-muted/30 hover:bg-accent/50 transition-colors"
            >
              <span className="text-muted-foreground">{"->"}</span>
              <span className="font-medium">{linkedIssue.identifier}:</span>
              <span className="truncate max-w-[200px]">{linkedIssue.title}</span>
            </Link>
          </div>
        )}

        {/* Threaded replies */}
        {threadReplies && threadReplies.length > 0 && (
          <div className="mt-2 ml-2 border-l-2 border-border/50 pl-3 space-y-1">
            {threadReplies.map((reply) => {
              const replyAgent = reply.authorAgentId ? agentMap.get(reply.authorAgentId) : null;
              const replyIsHuman = Boolean(reply.authorUserId) || (!reply.authorAgentId && !reply.authorUserId);
              const replyUserName = (reply as unknown as Record<string, unknown>).authorUserName as string | null | undefined;
              const replyAuthor = replyIsHuman ? (replyUserName ?? "Board") : (replyAgent?.name ?? "Agent");
              return (
                <div key={reply.id} className="flex items-start gap-2 py-1">
                  <div className="h-5 w-5 rounded-full bg-accent flex items-center justify-center shrink-0 mt-0.5">
                    <AgentIcon icon={replyAgent?.icon ?? null} className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold">{replyAuthor}</span>
                      <span className="text-[10px] text-muted-foreground">{formatTime(reply.createdAt)}</span>
                    </div>
                    <p className="text-[12px] text-foreground/80 whitespace-pre-wrap break-words">
                      {renderBodyWithEmbeds(reply.body, issueMap)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Analytics panel ----
interface ChannelAnalyticsPanelProps {
  companyId: string;
  channelId: string;
}

function ChannelAnalyticsPanel({ companyId, channelId }: ChannelAnalyticsPanelProps) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.channels.analytics(companyId, channelId),
    queryFn: () => channelsApi.analytics(companyId, channelId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading analytics...
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Total Messages" value={data.totalMessages} />
        <StatCard label="Decisions" value={data.decisionsCount} />
        <StatCard label="Escalations" value={data.escalationsCount} />
        <StatCard label="Avg / Day" value={data.avgMessagesPerDay} />
        {Object.entries(data.messagesByType).map(([type, count]) => (
          <StatCard key={type} label={type.replace(/_/g, " ")} value={count} />
        ))}
      </div>
      {data.topContributors.length > 0 && (
        <div>
          <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Top Contributors (last 30 days)
          </p>
          <div className="space-y-1">
            {data.topContributors.map((c) => (
              <div key={c.agentId} className="flex items-center justify-between text-[13px]">
                <span className="text-foreground">{c.name}</span>
                <span className="text-muted-foreground">{c.messageCount} messages</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground capitalize">{label}</p>
      <p className="text-[18px] font-semibold text-foreground">{value}</p>
    </div>
  );
}

// ---- Main ChannelView ----
export function ChannelView() {
  const { channelId } = useParams<{ channelId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draftBody, setDraftBody] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const prevMessageCount = useRef(0);
  const [newMessageDividerIndex, setNewMessageDividerIndex] = useState<number | null>(null);
  // Message search within channel (12.15)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  // Unread tracking state (12.15) - computed after messages query below
  const [lastReadTimestamp, setLastReadTimestamp] = useState<string | null>(() => {
    if (!channelId) return null;
    return localStorage.getItem(`ironworks:channel-last-read:${channelId}`);
  });

  // Fetch channels list to find the current channel name
  const { data: channels } = useQuery({
    queryKey: queryKeys.channels.list(selectedCompanyId!),
    queryFn: () => channelsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const channel: Channel | undefined = channels?.find((c) => c.id === channelId);

  // Fetch messages with polling
  const { data: messages = [] } = useQuery({
    queryKey: queryKeys.channels.messages(selectedCompanyId!, channelId!),
    queryFn: () => channelsApi.messages(selectedCompanyId!, channelId!),
    enabled: !!selectedCompanyId && !!channelId,
    refetchInterval: 5_000,
  });

  // Unread tracking computed values (12.15)
  const unreadCount = useMemo(() => {
    if (!lastReadTimestamp) return 0;
    return messages.filter((m) => m.createdAt > lastReadTimestamp).length;
  }, [messages, lastReadTimestamp]);
  function markAllRead() {
    if (messages.length === 0) return;
    const latest = messages[messages.length - 1].createdAt;
    setLastReadTimestamp(latest);
    if (channelId) localStorage.setItem(`ironworks:channel-last-read:${channelId}`, latest);
    setNewMessageDividerIndex(null);
  }

  // Fetch agents slim for name/icon resolution
  const { data: agentSlims = [] } = useQuery({
    queryKey: queryKeys.agents.slim(selectedCompanyId!),
    queryFn: () => agentsApi.slim(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch session for authorUserId
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  // Fetch pinned messages
  const { data: pinnedMessages = [] } = useQuery({
    queryKey: queryKeys.channels.pinned(selectedCompanyId!, channelId!),
    queryFn: () => channelsApi.pinned(selectedCompanyId!, channelId!),
    enabled: !!selectedCompanyId && !!channelId,
  });

  // Pin / unpin mutations
  const pinMutation = useMutation({
    mutationFn: (messageId: string) =>
      channelsApi.pinMessage(selectedCompanyId!, channelId!, messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.pinned(selectedCompanyId!, channelId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.list(selectedCompanyId!),
      });
    },
  });

  const unpinMutation = useMutation({
    mutationFn: (messageId: string) =>
      channelsApi.unpinMessage(selectedCompanyId!, channelId!, messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.pinned(selectedCompanyId!, channelId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.list(selectedCompanyId!),
      });
    },
  });

  // Build agent map
  const agentMap = new Map(
    agentSlims.map((a) => [
      a.id,
      {
        name: a.name,
        icon: a.icon,
        role: a.role,
        employmentType: undefined as string | undefined,
      },
    ]),
  );

  // Build reply map
  const replyMap = new Map(messages.map((m) => [m.id, m]));

  // Issue map - derive unique linkedIssueIds and fetch titles
  const issueMap = new Map<string, { identifier: string; title: string; status?: string }>();

  // Build thread map: parentId -> replies
  const threadMap = useMemo(() => {
    const map = new Map<string, ChannelMessage[]>();
    for (const m of messages) {
      if (m.replyToId) {
        const arr = map.get(m.replyToId) ?? [];
        arr.push(m);
        map.set(m.replyToId, arr);
      }
    }
    return map;
  }, [messages]);

  // Top-level messages (not replies), chronological order (oldest first)
  const topLevelMessages = useMemo(
    () => [...messages.filter((m) => !m.replyToId)].reverse(),
    [messages],
  );

  // Breadcrumbs
  useEffect(() => {
    const channelName = channel?.name ?? channelId ?? "";
    setBreadcrumbs([
      { label: "Channels" },
      { label: `#${channelName}` },
    ]);
  }, [setBreadcrumbs, channel, channelId]);

  // Track new messages arriving and set divider
  useEffect(() => {
    const currentCount = topLevelMessages.length;
    if (prevMessageCount.current > 0 && currentCount > prevMessageCount.current) {
      setNewMessageDividerIndex(prevMessageCount.current);
    }
    prevMessageCount.current = currentCount;
  }, [topLevelMessages.length]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Post message mutation
  const postMutation = useMutation({
    mutationFn: ({ body, replyTo }: { body: string; replyTo?: string | null }) =>
      channelsApi.postMessage(selectedCompanyId!, channelId!, {
        body,
        messageType: "message",
        ...(replyTo ? { replyToId: replyTo } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.messages(selectedCompanyId!, channelId!),
      });
      setDraftBody("");
      setReplyToId(null);
    },
  });

  const handleSend = useCallback(() => {
    const trimmed = draftBody.trim();
    if (!trimmed || postMutation.isPending) return;
    postMutation.mutate({ body: trimmed, replyTo: replyToId });
  }, [draftBody, postMutation, replyToId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftBody(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // Create issue from message mutation (Feature 2)
  const createIssueMutation = useMutation({
    mutationFn: (messageId: string) =>
      channelsApi.createIssueFromMessage(selectedCompanyId!, channelId!, messageId, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.messages(selectedCompanyId!, channelId!),
      });
    },
  });

  const filteredMessages = useMemo(() => {
    let msgs = topLevelMessages.filter((m) => matchesFilter(m, filter));
    // Apply search filter (12.15)
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      msgs = msgs.filter((m) => m.body.toLowerCase().includes(q));
    }
    return msgs;
  }, [topLevelMessages, filter, searchTerm]);

  const channelName = channel?.name ?? channelId ?? "";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-semibold text-foreground">
            <span className="text-muted-foreground">#</span>
            {channelName}
          </h1>
          {/* Unread badge (12.15) */}
          {unreadCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500 text-white">
              {unreadCount} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Mark all read button (12.15) */}
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="px-2 py-1 text-[11px] font-medium rounded-full text-blue-400 hover:bg-blue-500/10 transition-colors flex items-center gap-1"
            >
              <CheckCheck className="h-3 w-3" />
              Mark read
            </button>
          )}
          {/* Search toggle (12.15) */}
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className={cn(
              "p-1.5 rounded-full transition-colors",
              searchOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setFilter("all")}
            className={cn(
              "px-3 py-1 text-[12px] font-medium rounded-full transition-colors",
              filter === "all"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            All
          </button>
          <button
            onClick={() => setFilter("decisions")}
            className={cn(
              "px-3 py-1 text-[12px] font-medium rounded-full transition-colors",
              filter === "decisions"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            Decisions &amp; Escalations
          </button>
          <button
            onClick={() => setFilter("analytics")}
            className={cn(
              "px-3 py-1 text-[12px] font-medium rounded-full transition-colors flex items-center gap-1",
              filter === "analytics"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            <BarChart2 className="h-3 w-3" />
            Analytics
          </button>
        </div>
      </div>

      {/* Message search bar (12.15) */}
      {searchOpen && (
        <div className="px-4 py-2 border-b border-border bg-muted/10 flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search messages..."
            className="h-7 text-xs border-0 bg-transparent shadow-none focus-visible:ring-0"
            autoFocus
          />
          {searchTerm && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {filteredMessages.length} result{filteredMessages.length !== 1 ? "s" : ""}
            </span>
          )}
          <button onClick={() => { setSearchOpen(false); setSearchTerm(""); }} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Messages / Analytics */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {filter === "analytics" ? (
          <ChannelAnalyticsPanel
            companyId={selectedCompanyId!}
            channelId={channelId!}
          />
        ) : (
          <>
            {/* Pinned Messages collapsible section */}
            {pinnedMessages.length > 0 && filter === "all" && (
              <div className="mb-2 border-b border-border">
                <button
                  onClick={() => setPinnedExpanded((v) => !v)}
                  className="flex items-center gap-1.5 w-full px-4 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                >
                  {pinnedExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Pin className="h-3 w-3" />
                  Pinned ({pinnedMessages.length})
                </button>
                {pinnedExpanded && (
                  <div className="bg-muted/20">
                    {pinnedMessages.map((msg) => (
                      <MessageRow
                        key={`pinned-${msg.id}`}
                        msg={msg}
                        agentMap={agentMap}
                        issueMap={issueMap}
                        replyMap={replyMap}
                        isPinned
                        onUnpin={(id) => unpinMutation.mutate(id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {filteredMessages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                {filter === "decisions"
                  ? "No decisions or escalations yet."
                  : "No messages yet. Start the conversation."}
              </div>
            ) : (
              <>
                {filteredMessages.map((msg, idx) => (
                  <div key={msg.id}>
                    {/* New messages divider */}
                    {newMessageDividerIndex !== null && idx === newMessageDividerIndex && (
                      <div className="flex items-center gap-3 px-4 py-1.5">
                        <div className="flex-1 h-px bg-red-400/50" />
                        <span className="text-[11px] font-medium text-red-500 shrink-0">New messages</span>
                        <div className="flex-1 h-px bg-red-400/50" />
                      </div>
                    )}
                    <MessageRow
                      msg={msg}
                      agentMap={agentMap}
                      issueMap={issueMap}
                      replyMap={replyMap}
                      isPinned={pinnedMessages.some((p) => p.id === msg.id)}
                      onPin={(id) => pinMutation.mutate(id)}
                      onUnpin={(id) => unpinMutation.mutate(id)}
                      onCreateIssue={(id) => createIssueMutation.mutate(id)}
                      onReply={(id) => { setReplyToId(id); textareaRef.current?.focus(); }}
                      threadReplies={threadMap.get(msg.id)}
                      companyId={selectedCompanyId!}
                      channelId={channelId!}
                    />
                  </div>
                ))}
              </>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input - hidden when viewing analytics */}
      <div className={cn("shrink-0 border-t border-border px-4 py-3", filter === "analytics" && "hidden")}>
        {/* Reply indicator */}
        {replyToId && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-muted/30 rounded-md text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Replying to: {replyMap.get(replyToId)?.body?.slice(0, 80) ?? "message"}
              {(replyMap.get(replyToId)?.body?.length ?? 0) > 80 ? "..." : ""}
            </span>
            <button
              onClick={() => setReplyToId(null)}
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={draftBody}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 min-h-[36px] max-h-[160px] resize-none text-[13px] leading-snug py-2"
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!draftBody.trim() || postMutation.isPending}
            className="shrink-0 h-9 px-3"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Tip: Discussions happen here. Create issues for trackable work.
        </p>
      </div>
    </div>
  );
}
