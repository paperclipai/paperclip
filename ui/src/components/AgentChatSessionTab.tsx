import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, CreateChatMessageResponse, HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import { Loader2, MessageSquarePlus, Send } from "lucide-react";
import { chatApi, type ChatLogEvent } from "../api/chat";
import { heartbeatsApi } from "../api/heartbeats";
import { getUIAdapter, buildTranscript } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
  return "Agent is thinking…";
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
  adapterType,
  agentName,
}: {
  agentId: string;
  adapterType: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastAttemptedStreamIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { data: sessions = [], isLoading: sessionsLoading, error: sessionsError } = useQuery({
    queryKey: queryKeys.chatSessions(agentId),
    queryFn: () => chatApi.listSessions(agentId),
    enabled: Boolean(agentId),
  });

  useEffect(() => {
    if (selectedSessionId) return;
    if (sessions.length === 0) return;
    setSelectedSessionId(sessions[0]?.id ?? null);
  }, [selectedSessionId, sessions]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    setRenameDraft(selectedSession?.title ?? "");
  }, [selectedSession?.id, selectedSession?.title]);

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: selectedSessionId ? queryKeys.chatMessages(agentId, selectedSessionId) : ["chat", "messages", "none"],
    queryFn: () => chatApi.listMessages(agentId, selectedSessionId!),
    enabled: Boolean(agentId && selectedSessionId),
  });

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
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

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

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
    if (lastAttemptedStreamIdRef.current === pendingMessage.id && streamState && !isTerminalStreamStatus(streamState.status)) {
      return;
    }
    startStream(selectedSessionId, { message: pendingMessage, runId: pendingMessage.runId });
  }, [messages, selectedSessionId, startStream, streamState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamState]);

  const createSession = useMutation({
    mutationFn: () => chatApi.createSession(agentId, {}),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.chatSessions(agentId), (current: typeof sessions | undefined) => [
        result.session,
        ...(current ?? []),
      ]);
      setSelectedSessionId(result.session.id);
      setSendError(null);
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

  const renameSession = useMutation({
    mutationFn: (nextTitle: string) =>
      chatApi.updateSession(agentId, selectedSessionId!, {
        title: nextTitle.trim() || null,
      }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(queryKeys.chatSessions(agentId), (current: typeof sessions | undefined) =>
        (current ?? []).map((item) => (item.id === session.id ? session : item)),
      );
      setIsRenaming(false);
      setSendError(null);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to rename session");
    },
  });

  const archiveSession = useMutation({
    mutationFn: () => chatApi.updateSession(agentId, selectedSessionId!, { archived: true }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(queryKeys.chatSessions(agentId), (current: typeof sessions | undefined) =>
        (current ?? []).filter((item) => item.id !== session.id),
      );
      setSelectedSessionId((currentId) => {
        if (!currentId || currentId !== session.id) return currentId;
        const remaining = sessions.filter((item) => item.id !== session.id);
        return remaining[0]?.id ?? null;
      });
      setSelectedRunId(null);
      setSendError(null);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to archive session");
    },
  });

  const assistantPreview = useMemo(() => deriveAssistantPreview(streamState, adapterType), [adapterType, streamState]);
  const activeRunId = streamState?.runId ?? null;
  const hasPersistedAssistantForActiveRun = Boolean(
    activeRunId && messages.some((message) => message.role === "assistant" && message.runId === activeRunId),
  );
  const canSend = draft.trim().length > 0 && !sendMessage.isPending && !eventSourceRef.current;

  const runIdForDetails = selectedRunId ?? streamState?.runId ?? null;
  const { data: runDetail } = useQuery({
    queryKey: runIdForDetails ? queryKeys.runDetail(runIdForDetails) : ["heartbeat-run", "none"],
    queryFn: () => heartbeatsApi.get(runIdForDetails!),
    enabled: Boolean(runIdForDetails),
    refetchInterval: (query) => {
      const run = query.state.data as HeartbeatRun | undefined;
      if (!run) return false;
      return run.status === "running" || run.status === "queued" ? 2000 : false;
    },
  });

  const { data: runEvents = [] } = useQuery({
    queryKey: runIdForDetails ? ["heartbeat-run-events", runIdForDetails] : ["heartbeat-run-events", "none"],
    queryFn: () => heartbeatsApi.events(runIdForDetails!, 0, 200),
    enabled: Boolean(runIdForDetails),
    refetchInterval: runDetail && (runDetail.status === "running" || runDetail.status === "queued") ? 2000 : false,
  });

  const { data: persistedRunLogs = [] } = useQuery({
    queryKey: runIdForDetails ? ["heartbeat-run-logs", runIdForDetails] : ["heartbeat-run-logs", "none"],
    enabled: Boolean(runIdForDetails),
    queryFn: async () => {
      const runId = runIdForDetails!;
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
      runIdForDetails &&
      streamState?.runId === runIdForDetails &&
      (streamState.status === "pending" || streamState.status === "streaming")
    ) {
      return streamState.logs;
    }
    return persistedRunLogs;
  }, [persistedRunLogs, runIdForDetails, streamState]);

  const runTranscript = useMemo(
    () => buildTranscript(runLogEvents, getUIAdapter(adapterType).parseStdoutLine),
    [adapterType, runLogEvents],
  );

  const renderInlineRunDetails = (runId: string | null) => {
    if (!runId || runId !== runIdForDetails) return null;
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

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-medium text-muted-foreground">Session</div>
          <div className="flex flex-wrap items-center gap-2">
            {sessionsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading...
              </div>
            )}
            {sessions.map((session) => (
              <Button
                key={session.id}
                type="button"
                size="sm"
                variant={session.id === selectedSessionId ? "default" : "outline"}
                onClick={() => {
                  setSelectedSessionId(session.id);
                  setSelectedRunId(null);
                  setStreamState(null);
                  closeStream();
                }}
                className="h-7 px-2 text-xs"
              >
                {session.title?.trim() || "Untitled"}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
          >
            {createSession.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
            )}
            New session
          </Button>
        </div>
        {selectedSession && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isRenaming ? (
              <>
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  placeholder="Session name"
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={renameSession.isPending}
                  onClick={() => renameSession.mutate(renameDraft)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setIsRenaming(false);
                    setRenameDraft(selectedSession.title ?? "");
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setIsRenaming(true)}
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={() => archiveSession.mutate()}
                  disabled={archiveSession.isPending}
                >
                  Archive
                </Button>
              </>
            )}
          </div>
        )}
        {sessionsError && (
          <div className="mt-2 text-xs text-destructive">
            {sessionsError instanceof Error ? sessionsError.message : "Failed to load chat sessions"}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Conversation</h3>
        </div>

        <div className="max-h-[68vh] min-h-[22rem] space-y-3 overflow-y-auto p-4">
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
            const detailsOpen = message.runId && message.runId === runIdForDetails;
            return (
              <div key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-md border px-4 py-3 text-sm ${
                    isUser ? "border-border/60 bg-accent/20" : "border-border/60 bg-card"
                  }`}
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
                  {!isUser && message.runId && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => setSelectedRunId(detailsOpen ? null : message.runId)}
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {detailsOpen ? "Hide run details" : "Show run details"}
                      </button>
                    </div>
                  )}
                  {!isUser ? renderInlineRunDetails(message.runId) : null}
                </div>
              </div>
            );
          })}

          {streamState && !hasPersistedAssistantForActiveRun && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-md border border-border/60 bg-card px-4 py-3 text-sm">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">{agentName}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {streamState.status === "streaming" || streamState.status === "pending" ? "Streaming..." : streamState.status}
                  </span>
                </div>
                <MarkdownBody>{assistantPreview}</MarkdownBody>
                {streamState.runId && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setSelectedRunId(streamState.runId === runIdForDetails ? null : streamState.runId)}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {streamState.runId === runIdForDetails ? "Hide run details" : "Show run details"}
                    </button>
                  </div>
                )}
                {renderInlineRunDetails(streamState.runId)}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 p-4 backdrop-blur-sm">
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message this agent..."
              rows={3}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && canSend) {
                  event.preventDefault();
                  sendMessage.mutate(draft.trim());
                }
              }}
              disabled={!selectedSessionId || sendMessage.isPending || Boolean(eventSourceRef.current)}
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {eventSourceRef.current
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
      </div>
    </div>
  );
}
