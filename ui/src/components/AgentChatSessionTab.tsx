import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, ChatSession, CreateChatMessageResponse, HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import { Archive, ChevronRight, Ellipsis, Loader2, MessageSquarePlus, Pencil, RotateCcw, Send, Trash2 } from "lucide-react";
import { chatApi, type ChatLogEvent } from "../api/chat";
import { heartbeatsApi } from "../api/heartbeats";
import { getUIAdapter, buildTranscript } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime, cn } from "../lib/utils";
import { displaySessionTitle, filterChatSessions, groupChatSessions } from "../lib/chat-sessions";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type StreamStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled" | "timed_out";

interface StreamState {
  sourceMessageId: string;
  runId: string | null;
  logs: ChatLogEvent[];
  status: StreamStatus;
  error: string | null;
}

function isTerminalStreamStatus(status: StreamStatus) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function deriveAssistantPreview(streamState: StreamState | null, adapterType: string) {
  if (!streamState) return "";
  const transcript = buildTranscript(streamState.logs, getUIAdapter(adapterType).parseStdoutLine);
  const assistantText = transcript
    .filter((entry): entry is Extract<typeof entry, { kind: "assistant" }> => entry.kind === "assistant")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (assistantText) return assistantText;
  if (streamState.error) return streamState.error;
  if (streamState.status === "failed") return "Run failed before producing a response.";
  if (streamState.status === "timed_out") return "Run timed out before producing a response.";
  if (streamState.status === "cancelled") return "Run was cancelled before producing a response.";
  return "Agent is thinking...";
}

function parsePersistedLogContent(content: string): ChatLogEvent[] {
  if (!content.trim()) return [];
  const records: ChatLogEvent[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      if (
        typeof parsed.ts === "string" &&
        (parsed.stream === "stdout" || parsed.stream === "stderr" || parsed.stream === "system") &&
        typeof parsed.chunk === "string"
      ) {
        records.push({ ts: parsed.ts, stream: parsed.stream, chunk: parsed.chunk });
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return records;
}

function summarizeTranscriptEntry(entry: ReturnType<typeof buildTranscript>[number]): string | null {
  switch (entry.kind) {
    case "assistant":
    case "thinking":
    case "stdout":
    case "stderr":
    case "system":
      return entry.text.trim() || null;
    case "tool_call":
      return `tool call: ${entry.name}`;
    case "tool_result":
      return `${entry.isError ? "tool error" : "tool result"}: ${entry.content}`;
    case "result":
      return entry.text.trim() || null;
    default:
      return null;
  }
}

export function AgentChatSessionTab({
  agentId,
  agentRouteId,
  adapterType,
  agentName,
  fillContainer = false,
}: {
  agentId: string;
  agentRouteId: string;
  adapterType: string;
  agentName: string;
  fillContainer?: boolean;
}) {
  const queryClient = useQueryClient();
  const sessionsQueryKey = queryKeys.chatSessions(agentId, true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const autoExpandedRunIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const [completedMessageId, setCompletedMessageId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastAttemptedStreamIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { data: sessions = [], isLoading: sessionsLoading, error: sessionsError } = useQuery({
    queryKey: sessionsQueryKey,
    queryFn: () => chatApi.listSessions(agentId, { includeArchived: true }),
    enabled: Boolean(agentId),
  });

  useEffect(() => {
    if (!sessions.length) {
      setSelectedSessionId(null);
      return;
    }
    if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) return;
    const firstActive = sessions.find((session) => !session.archivedAt);
    setSelectedSessionId(firstActive?.id ?? sessions[0]?.id ?? null);
  }, [selectedSessionId, sessions]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    if (!selectedSession) {
      setRenamingSessionId(null);
      return;
    }
    if (renamingSessionId === selectedSession.id) setRenameDraft(selectedSession.title ?? "");
  }, [renamingSessionId, selectedSession]);

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: selectedSessionId ? queryKeys.chatMessages(agentId, selectedSessionId) : ["chat", "messages", "none"],
    queryFn: () => chatApi.listMessages(agentId, selectedSessionId!),
    enabled: Boolean(agentId && selectedSessionId),
  });

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const scrollToTranscriptBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = transcriptRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const appendAssistantMessage = useCallback(
    (message: ChatMessage) => {
      if (!message.chatSessionId) return;
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chatMessages(agentId, message.chatSessionId), (current) => {
        if (!current) return [message];
        if (current.some((entry) => entry.id === message.id)) return current;
        return [...current, message];
      });
    },
    [agentId, queryClient],
  );

  const startStream = useCallback(
    (sessionId: string, result: Pick<CreateChatMessageResponse, "message" | "runId">) => {
      closeStream();
      lastAttemptedStreamIdRef.current = result.message.id;
      setCompletedMessageId(null);
      autoExpandedRunIdRef.current = result.runId ?? null;
      if (result.runId) setExpandedRunId(result.runId);
      setStreamState({
        sourceMessageId: result.message.id,
        runId: result.runId,
        logs: [],
        status: "pending",
        error: null,
      });

      const source = new EventSource(chatApi.streamUrl(agentId, sessionId, result.message.id));
      eventSourceRef.current = source;
      let finished = false;

      source.addEventListener("ready", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { runId: string };
        const previousAutoRunId = autoExpandedRunIdRef.current;
        autoExpandedRunIdRef.current = payload.runId;
        setExpandedRunId((current) => (current === null || current === previousAutoRunId ? payload.runId : current));
        setStreamState((current) =>
          current && current.sourceMessageId === result.message.id
            ? { ...current, runId: payload.runId, status: "streaming" }
            : current,
        );
      });

      source.addEventListener("log", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as ChatLogEvent;
        setStreamState((current) =>
          current && current.sourceMessageId === result.message.id
            ? { ...current, status: "streaming", logs: [...current.logs, payload] }
            : current,
        );
      });

      source.addEventListener("completed", (event) => {
        finished = true;
        const payload = JSON.parse((event as MessageEvent).data) as {
          runId: string;
          status: StreamStatus;
          message: ChatMessage | null;
        };
        if (payload.message) {
          appendAssistantMessage(payload.message);
          setCompletedMessageId(payload.message.id);
        }
        if (autoExpandedRunIdRef.current === payload.runId) {
          autoExpandedRunIdRef.current = null;
          setExpandedRunId((current) => (current === payload.runId ? null : current));
        }
        setStreamState((current) =>
          current && current.sourceMessageId === result.message.id
            ? { ...current, runId: payload.runId, status: payload.status }
            : current,
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.chatMessages(agentId, sessionId) });
        closeStream();
      });

      source.addEventListener("error", () => {
        if (finished) return;
        setStreamState((current) =>
          current && current.sourceMessageId === result.message.id
            ? {
                ...current,
                status: "failed",
                error: "Live connection lost before the response finished.",
              }
            : current,
        );
        closeStream();
      });
    },
    [agentId, appendAssistantMessage, closeStream, queryClient],
  );

  useEffect(() => () => closeStream(), [closeStream]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const assistantRunIds = new Set(
      messages
        .filter((message) => message.role === "assistant" && typeof message.runId === "string" && message.runId)
        .map((message) => message.runId as string),
    );
    const pendingMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.runId && !assistantRunIds.has(message.runId));
    if (!pendingMessage) return;
    if (eventSourceRef.current) return;
    if (lastAttemptedStreamIdRef.current === pendingMessage.id && streamState && isTerminalStreamStatus(streamState.status)) {
      return;
    }
    startStream(selectedSessionId, { message: pendingMessage, runId: pendingMessage.runId });
  }, [messages, selectedSessionId, startStream, streamState]);

  useEffect(() => {
    scrollToTranscriptBottom("auto");
  }, [selectedSessionId, scrollToTranscriptBottom]);

  useEffect(() => {
    if (!eventSourceRef.current) return;
    scrollToTranscriptBottom("smooth");
  }, [messages.length, scrollToTranscriptBottom, streamState?.logs.length]);

  useEffect(() => {
    if (!completedMessageId) return;
    const node = messageRefs.current[completedMessageId];
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setCompletedMessageId(null);
  }, [completedMessageId, messages.length]);

  const createSession = useMutation({
    mutationFn: () => chatApi.createSession(agentId, {}),
    onSuccess: (result) => {
      queryClient.setQueryData<ChatSession[]>(sessionsQueryKey, (current) => [result.session, ...(current ?? [])]);
      setSelectedSessionId(result.session.id);
      setSendError(null);
      setSearchQuery("");
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to create chat session");
    },
  });

  const sendMessage = useMutation({
    mutationFn: (content: string) => chatApi.sendMessage(agentId, selectedSessionId!, { content }),
    onSuccess: (result) => {
      if (!selectedSessionId) return;
      setSendError(null);
      setDraft("");
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chatMessages(agentId, selectedSessionId), (current) => [
        ...(current ?? []),
        result.message,
      ]);
      startStream(selectedSessionId, result);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to send message");
    },
  });

  const retryChatRun = useMutation({
    mutationFn: async (input: { messageId: string; runId: string }) => {
      if (!selectedSessionId) throw new Error("No chat session selected");
      const run = await heartbeatsApi.get(input.runId);
      if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "cancelled") {
        throw new Error(`Only failed, timed out, or cancelled runs can be retried (current: ${run.status}).`);
      }
      return chatApi.retryMessage(agentId, selectedSessionId, input.messageId);
    },
    onSuccess: (result) => {
      if (!selectedSessionId) return;
      setSendError(null);
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chatMessages(agentId, selectedSessionId), (current) =>
        (current ?? []).map((entry) => (entry.id === result.message.id ? result.message : entry)),
      );
      startStream(selectedSessionId, result);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to retry run");
    },
  });

  const renameSession = useMutation({
    mutationFn: ({ sessionId, nextTitle }: { sessionId: string; nextTitle: string }) =>
      chatApi.updateSession(agentId, sessionId, {
        title: nextTitle.trim() || null,
      }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData<ChatSession[]>(sessionsQueryKey, (current) =>
        (current ?? []).map((item) => (item.id === session.id ? session : item)),
      );
      setRenamingSessionId(null);
      setSendError(null);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to rename session");
    },
  });

  const updateArchivedSession = useMutation({
    mutationFn: ({ sessionId, archived }: { sessionId: string; archived: boolean }) =>
      chatApi.updateSession(agentId, sessionId, { archived }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData<ChatSession[]>(sessionsQueryKey, (current) =>
        (current ?? []).map((item) => (item.id === session.id ? session : item)),
      );
      setSelectedSessionId((currentId) => {
        if (!currentId || currentId !== session.id || !session.archivedAt) return currentId;
        const latest = queryClient.getQueryData<ChatSession[]>(sessionsQueryKey) ?? [];
        const nextActive = latest.find((item) => item.id !== session.id && !item.archivedAt);
        return nextActive?.id ?? latest.find((item) => item.id !== session.id)?.id ?? null;
      });
      setSendError(null);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to update chat session");
    },
  });

  const assistantPreview = useMemo(() => deriveAssistantPreview(streamState, adapterType), [adapterType, streamState]);
  const activeRunId = streamState?.runId ?? null;
  const hasPersistedAssistantForActiveRun = Boolean(
    activeRunId && messages.some((message) => message.role === "assistant" && message.runId === activeRunId),
  );
  const canSend = draft.trim().length > 0 && !sendMessage.isPending && !eventSourceRef.current && !selectedSession?.archivedAt;

  const { data: runDetail } = useQuery({
    queryKey: expandedRunId ? queryKeys.runDetail(expandedRunId) : ["heartbeat-run", "none"],
    queryFn: () => heartbeatsApi.get(expandedRunId!),
    enabled: Boolean(expandedRunId),
    refetchInterval: (query) => {
      const run = query.state.data as HeartbeatRun | undefined;
      if (!run) return false;
      return run.status === "running" || run.status === "queued" ? 2000 : false;
    },
  });

  const { data: runEvents = [] } = useQuery({
    queryKey: expandedRunId ? ["heartbeat-run-events", expandedRunId] : ["heartbeat-run-events", "none"],
    queryFn: () => heartbeatsApi.events(expandedRunId!, 0, 200),
    enabled: Boolean(expandedRunId),
    refetchInterval: runDetail && (runDetail.status === "running" || runDetail.status === "queued") ? 2000 : false,
  });

  const { data: persistedRunLogs = [] } = useQuery({
    queryKey: expandedRunId ? ["heartbeat-run-logs", expandedRunId] : ["heartbeat-run-logs", "none"],
    enabled: Boolean(expandedRunId),
    queryFn: async () => {
      const runId = expandedRunId!;
      const records: ChatLogEvent[] = [];
      let offset = 0;
      while (true) {
        const payload = await heartbeatsApi.log(runId, offset, 256_000);
        records.push(...parsePersistedLogContent(payload.content));
        if (!payload.nextOffset || payload.nextOffset <= offset) break;
        offset = payload.nextOffset;
      }
      return records;
    },
    refetchInterval: runDetail && (runDetail.status === "running" || runDetail.status === "queued") ? 2000 : false,
  });

  const runLogEvents = useMemo(() => {
    if (
      expandedRunId &&
      streamState?.runId === expandedRunId &&
      (streamState.status === "pending" || streamState.status === "streaming")
    ) {
      return streamState.logs;
    }
    return persistedRunLogs;
  }, [expandedRunId, persistedRunLogs, streamState]);

  const runTranscript = useMemo(
    () => buildTranscript(runLogEvents, getUIAdapter(adapterType).parseStdoutLine),
    [adapterType, runLogEvents],
  );

  const filteredSessions = useMemo(() => filterChatSessions(sessions, searchQuery), [searchQuery, sessions]);
  const groupedSessions = useMemo(
    () => groupChatSessions(filteredSessions, { activeSessionId: selectedSessionId }),
    [filteredSessions, selectedSessionId],
  );

  const toggleRunDetails = useCallback((runId: string | null) => {
    if (!runId) return;
    setExpandedRunId((current) => (current === runId ? null : runId));
    if (autoExpandedRunIdRef.current === runId) autoExpandedRunIdRef.current = null;
  }, []);

  const runUrlFor = useCallback(
    (runId: string) => `/agents/${encodeURIComponent(agentRouteId)}/runs/${encodeURIComponent(runId)}`,
    [agentRouteId],
  );

  const renderInlineRunDetails = (runId: string | null) => {
    if (!runId || runId !== expandedRunId) return null;
    return (
      <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/60 p-3 text-xs">
        {runDetail && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Status</span>
              <span>{runDetail.status}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Started</span>
              <span>{runDetail.startedAt ? relativeTime(runDetail.startedAt) : "n/a"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Finished</span>
              <span>{runDetail.finishedAt ? relativeTime(runDetail.finishedAt) : "n/a"}</span>
            </div>
          </div>
        )}
        {runTranscript.length > 0 && (
          <div className="space-y-1">
            <div className="font-medium text-muted-foreground">Transcript</div>
            {runTranscript.slice(-20).map((entry, idx) => {
              const text = summarizeTranscriptEntry(entry);
              if (!text) return null;
              return (
                <div key={`${entry.kind}:${entry.ts}:${idx}`} className="rounded border border-border/50 bg-card px-2 py-1">
                  <span className="mr-1 font-medium text-muted-foreground">{entry.kind}:</span>
                  <span className="whitespace-pre-wrap">{text}</span>
                </div>
              );
            })}
          </div>
        )}
        {runEvents.length > 0 && (
          <div className="space-y-1">
            <div className="font-medium text-muted-foreground">Events</div>
            {runEvents.slice(-12).map((event: HeartbeatRunEvent) => (
              <div key={`${event.runId}:${event.seq}`} className="rounded border border-border/50 bg-card px-2 py-1">
                <span className="mr-1 font-medium text-muted-foreground">{event.eventType}</span>
                <span>{event.message ?? "No message"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSessionItems = (items: ChatSession[]) =>
    items.map((session) => {
      const isSelected = session.id === selectedSessionId;
      const isRenaming = session.id === renamingSessionId;
      const isUpdatingArchive = updateArchivedSession.isPending;
      const isUpdatingName = renameSession.isPending;
      return (
        <div
          key={session.id}
          className={cn(
            "group rounded-md border border-transparent px-2 py-2 text-xs transition-colors",
            isSelected ? "border-border bg-accent/40" : "hover:bg-accent/20",
          )}
        >
          {isRenaming ? (
            <div className="space-y-2">
              <Input
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                className="h-8 text-xs"
                placeholder="Conversation name"
              />
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={isUpdatingName}
                  onClick={() => renameSession.mutate({ sessionId: session.id, nextTitle: renameDraft })}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setRenamingSessionId(null);
                    setRenameDraft(session.title ?? "");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setSelectedSessionId(session.id);
                    setExpandedRunId(null);
                    autoExpandedRunIdRef.current = null;
                    setStreamState(null);
                    closeStream();
                  }}
                >
                  <div className="truncate text-sm font-medium">{displaySessionTitle(session)}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {relativeTime(session.lastMessageAt ?? session.updatedAt)}
                  </div>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
                        isSelected && "opacity-100",
                      )}
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Conversation options"
                    >
                      <Ellipsis className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenamingSessionId(session.id);
                        setRenameDraft(session.title ?? "");
                      }}
                    >
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                    {session.archivedAt ? (
                      <DropdownMenuItem
                        disabled={isUpdatingArchive}
                        onSelect={() => updateArchivedSession.mutate({ sessionId: session.id, archived: false })}
                      >
                        <RotateCcw />
                        Restore
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          disabled={isUpdatingArchive}
                          onSelect={() => updateArchivedSession.mutate({ sessionId: session.id, archived: true })}
                        >
                          <Archive />
                          Archive
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={isUpdatingArchive}
                          onSelect={() => updateArchivedSession.mutate({ sessionId: session.id, archived: true })}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>
      );
    });

  const renderSection = (title: string, items: ChatSession[]) => (
    <div className="space-y-1">
      <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} <span className="ml-1">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">No conversations</div>
      ) : (
        renderSessionItems(items)
      )}
    </div>
  );

  const renderCollapsibleSection = (title: string, items: ChatSession[], defaultOpen = false) => (
    <Collapsible defaultOpen={defaultOpen} className="group/section">
      <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-0.5">
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform group-data-[state=open]/section:rotate-90" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title} <span className="ml-1">{items.length}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          {items.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No conversations</div>
          ) : (
            renderSessionItems(items)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  return (
    <div className={cn("overflow-hidden bg-background", fillContainer ? "h-full" : "rounded-lg border border-border")}>
      <div className={cn("grid grid-cols-[18rem_1fr]", fillContainer ? "h-full" : "h-[74vh] min-h-[34rem]")}>
        <aside className="flex flex-col border-r border-border bg-card/40 overflow-hidden">
          <div className="shrink-0 space-y-2 p-3 pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">Conversations</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-2"
                onClick={() => createSession.mutate()}
                disabled={createSession.isPending}
              >
                {createSession.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-8 text-xs"
              placeholder="Search conversations..."
            />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3 pr-2 scrollbar-auto-hide">
            {sessionsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading conversations...
              </div>
            )}
            {!sessionsLoading && (
              <>
                {renderSection("Open", groupedSessions.open)}
                {renderSection("Previous 7 days", groupedSessions.previous7Days)}
                {renderCollapsibleSection("Older", groupedSessions.older)}
                {renderCollapsibleSection("Archived", groupedSessions.archived)}
              </>
            )}
            {sessionsError && (
              <div className="text-xs text-destructive">
                {sessionsError instanceof Error ? sessionsError.message : "Failed to load chat sessions"}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="border-b border-border px-6 py-3 lg:px-12">
            <div className="text-sm font-semibold">{selectedSession ? displaySessionTitle(selectedSession) : "Conversation"}</div>
            <div className="text-xs text-muted-foreground">
              {selectedSession
                ? selectedSession.archivedAt
                  ? "Archived conversation (read-only)"
                  : "Conversation with detailed run traces"
                : "Select or create a conversation to begin"}
            </div>
          </div>

          <div ref={transcriptRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4 lg:px-12">
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading chat history...
              </div>
            )}
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error instanceof Error ? error.message : "Failed to load chat history"}
              </div>
            )}
            {!selectedSessionId && !sessionsLoading && (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                Create a chat session to begin.
              </div>
            )}
            {!isLoading && !error && selectedSessionId && messages.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                Start the conversation by sending a message to this agent.
              </div>
            )}

            {messages.map((message) => {
              const isUser = message.role === "user";
              const detailsOpen = message.runId && message.runId === expandedRunId;
              const retryPendingForMessage =
                retryChatRun.isPending && retryChatRun.variables?.messageId === message.id;
              return (
                <div
                  key={message.id}
                  ref={(node) => {
                    messageRefs.current[message.id] = node;
                  }}
                  className={cn("flex", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[86%] rounded-md border px-4 py-3 text-sm",
                      isUser ? "border-border/60 bg-accent/20" : "border-border/60 bg-card",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">{isUser ? "You" : agentName}</span>
                      <span className="text-[11px] text-muted-foreground">{relativeTime(message.createdAt)}</span>
                    </div>
                    {isUser ? (
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    ) : (
                      <MarkdownBody>{message.content}</MarkdownBody>
                    )}
                    {message.runId && (
                      <div className="mt-2 flex items-center gap-3 text-[11px]">
                        <button
                          type="button"
                          onClick={() => toggleRunDetails(message.runId)}
                          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {detailsOpen ? "Hide run details" : "Show run details"}
                        </button>
                        <Link
                          to={runUrlFor(message.runId)}
                          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          View Run
                        </Link>
                        {isUser && (
                          <button
                            type="button"
                            onClick={() => retryChatRun.mutate({ messageId: message.id, runId: message.runId! })}
                            disabled={retryPendingForMessage}
                            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
                          >
                            {retryPendingForMessage ? "Retrying..." : "Retry Run"}
                          </button>
                        )}
                      </div>
                    )}
                    {renderInlineRunDetails(message.runId)}
                  </div>
                </div>
              );
            })}

            {streamState && !hasPersistedAssistantForActiveRun && (
              <div className="flex justify-start">
                <div className="max-w-[86%] rounded-md border border-border/60 bg-card px-4 py-3 text-sm">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-muted-foreground">{agentName}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {streamState.status === "streaming" || streamState.status === "pending" ? "Streaming..." : streamState.status}
                    </span>
                  </div>
                  <MarkdownBody>{assistantPreview}</MarkdownBody>
                  {streamState.runId && (
                    <div className="mt-2 flex items-center gap-3 text-[11px]">
                      <button
                        type="button"
                        onClick={() => toggleRunDetails(streamState.runId)}
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {streamState.runId === expandedRunId ? "Hide run details" : "Show run details"}
                      </button>
                      <Link
                        to={runUrlFor(streamState.runId)}
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        View Run
                      </Link>
                    </div>
                  )}
                  {renderInlineRunDetails(streamState.runId)}
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border bg-background/95 px-6 py-4 backdrop-blur-sm lg:px-12">
            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={selectedSession?.archivedAt ? "Archived conversations are read-only." : "Message this agent..."}
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && canSend) {
                    event.preventDefault();
                    sendMessage.mutate(draft.trim());
                  }
                }}
                disabled={!selectedSessionId || sendMessage.isPending || Boolean(eventSourceRef.current) || Boolean(selectedSession?.archivedAt)}
              />
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  {selectedSession?.archivedAt
                    ? "Restore this conversation from the sidebar to continue chatting."
                    : eventSourceRef.current
                      ? "Wait for the current response to finish before sending another message."
                      : "Press Enter to send. Use Shift+Enter for a new line."}
                </div>
                <Button size="sm" onClick={() => sendMessage.mutate(draft.trim())} disabled={!selectedSessionId || !canSend}>
                  {sendMessage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  Send
                </Button>
              </div>
              {sendError && <div className="text-sm text-destructive">{sendError}</div>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
