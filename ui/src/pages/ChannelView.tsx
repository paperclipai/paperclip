import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Crown, Pin, PinOff, ChevronDown, ChevronRight, BarChart2 } from "lucide-react";
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
      <span className="text-[9px] font-medium px-1 py-0 rounded-full leading-tight border border-dashed border-amber-500 text-amber-600 dark:text-amber-400 shrink-0">
        CTR
      </span>
    );
  }
  if (level === "executive") {
    return (
      <span className="text-[9px] font-medium px-1 py-0 rounded-full leading-tight bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
        C
      </span>
    );
  }
  if (level === "management") {
    return (
      <span className="text-[9px] font-medium px-1 py-0 rounded-full leading-tight bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">
        M
      </span>
    );
  }
  return (
    <span className="text-[9px] font-medium px-1 py-0 rounded-full leading-tight bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-500 shrink-0">
      FTE
    </span>
  );
}

// ---- Message type badge ----
const MESSAGE_TYPE_STYLES: Record<string, string> = {
  status_update: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  question: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  decision: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-500",
  escalation: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  announcement: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
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

// ---- Single message row ----
interface MessageRowProps {
  msg: ChannelMessage;
  agentMap: Map<string, { name: string; icon: string | null; role: string | null; employmentType?: string }>;
  issueMap: Map<string, { identifier: string; title: string }>;
  replyMap: Map<string, ChannelMessage>;
  onPin?: (messageId: string) => void;
  onUnpin?: (messageId: string) => void;
  isPinned?: boolean;
}

function MessageRow({ msg, agentMap, issueMap, replyMap, onPin, onUnpin, isPinned }: MessageRowProps) {
  const isBoard = !msg.authorAgentId && !msg.authorUserId;
  const agent = msg.authorAgentId ? agentMap.get(msg.authorAgentId) : null;
  const authorName = isBoard ? "Board" : (agent?.name ?? "User");
  const replyTo = msg.replyToId ? replyMap.get(msg.replyToId) : null;
  const linkedIssue = msg.linkedIssueId ? issueMap.get(msg.linkedIssueId) : null;

  return (
    <div
      className={cn(
        "group relative flex gap-3 px-4 py-2 hover:bg-accent/30 transition-colors",
        isBoard && "border-l-2 border-amber-400 bg-amber-50/30 dark:bg-amber-900/10",
        isPinned && "bg-amber-50/20 dark:bg-amber-900/5",
      )}
    >
      {/* Pin / unpin button shown on hover */}
      {(onPin || onUnpin) && (
        <button
          onClick={() => isPinned ? onUnpin?.(msg.id) : onPin?.(msg.id)}
          className="absolute right-3 top-2 hidden group-hover:flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title={isPinned ? "Unpin message" : "Pin message"}
        >
          {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      {/* Author icon */}
      <div className="shrink-0 mt-0.5">
        {isBoard ? (
          <div className="h-7 w-7 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <Crown className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
        ) : (
          <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
            <AgentIcon
              icon={agent?.icon ?? null}
              className={cn(
                "h-4 w-4",
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
            <span className="text-[9px] font-medium px-1 py-0 rounded-full leading-tight bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-300 dark:border-amber-700 shrink-0">
              BOARD
            </span>
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

        {/* Body */}
        <p className="text-[13px] text-foreground/90 whitespace-pre-wrap break-words">
          {msg.body}
        </p>

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
      </div>
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
  // We use a simple approach: collect unique ids and show identifier from message data
  // (The API may not expose issue detail here, so we surface what we have)
  const issueMap = new Map<string, { identifier: string; title: string }>();

  // Breadcrumbs
  useEffect(() => {
    const channelName = channel?.name ?? channelId ?? "";
    setBreadcrumbs([
      { label: "Channels" },
      { label: `#${channelName}` },
    ]);
  }, [setBreadcrumbs, channel, channelId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Post message mutation
  const postMutation = useMutation({
    mutationFn: (body: string) =>
      channelsApi.postMessage(selectedCompanyId!, channelId!, {
        body,
        messageType: "message",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.messages(selectedCompanyId!, channelId!),
      });
      setDraftBody("");
    },
  });

  const handleSend = useCallback(() => {
    const trimmed = draftBody.trim();
    if (!trimmed || postMutation.isPending) return;
    postMutation.mutate(trimmed);
  }, [draftBody, postMutation]);

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

  const filteredMessages = messages.filter((m) => matchesFilter(m, filter));

  const channelName = channel?.name ?? channelId ?? "";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <h1 className="text-[15px] font-semibold text-foreground">
          <span className="text-muted-foreground">#</span>
          {channelName}
        </h1>
        <div className="flex items-center gap-1">
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
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {filteredMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {filter === "decisions"
              ? "No decisions or escalations yet."
              : "No messages yet. Start the conversation."}
          </div>
        ) : (
          <>
            {filteredMessages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                agentMap={agentMap}
                issueMap={issueMap}
                replyMap={replyMap}
              />
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border px-4 py-3">
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
