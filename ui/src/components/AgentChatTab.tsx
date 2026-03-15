export { AgentChatSessionTab as AgentChatTab } from "./AgentChatSessionTab";
/*
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, CreateChatMessageResponse } from "@paperclipai/shared";
import { Loader2, Send } from "lucide-react";
import { chatApi, type ChatLogEvent } from "../api/chat";
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

export function AgentChatTab({
  agentId,
  adapterType,
  agentName,
}: {
  agentId: string;
  adapterType: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastAttemptedStreamIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: queryKeys.chatMessages(agentId),
    queryFn: () => chatApi.list(agentId),
    enabled: Boolean(agentId),
  });

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const appendAssistantMessage = useCallback(
    (message: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chatMessages(agentId), (current) => {
        if (!current) return [message];
        if (current.some((entry) => entry.id === message.id)) return current;
        return [...current, message];
      });
    },
    [agentId, queryClient],
  );

  const startStream = useCallback(
    (result: Pick<CreateChatMessageResponse, "message" | "runId">) => {
      closeStream();
      lastAttemptedStreamIdRef.current = result.message.id;
      setStreamState({
        sourceMessageId: result.message.id,
        runId: result.runId,
        logs: [],
        status: "pending",
        error: null,
      });

      const source = new EventSource(chatApi.streamUrl(agentId, result.message.id));
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
            ? {
                ...current,
                status: "streaming",
                logs: [...current.logs, payload],
              }
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
            ? {
                ...current,
                runId: payload.runId,
                status: payload.status,
              }
            : current,
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.chatMessages(agentId) });
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

    startStream({ message: pendingMessage, runId: pendingMessage.runId });
  }, [messages, startStream, streamState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamState]);

  const sendMessage = useMutation({
    mutationFn: (content: string) => chatApi.send(agentId, { content }),
    onSuccess: (result) => {
      setSendError(null);
      setDraft("");
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chatMessages(agentId), (current) => [
        ...(current ?? []),
        result.message,
      ]);
      startStream(result);
    },
    onError: (mutationError) => {
      setSendError(mutationError instanceof Error ? mutationError.message : "Failed to send message");
    },
  });

  const assistantPreview = useMemo(
    () => deriveAssistantPreview(streamState, adapterType),
    [adapterType, streamState],
  );

  const activeRunId = streamState?.runId ?? null;
  const hasPersistedAssistantForActiveRun = Boolean(
    activeRunId &&
      messages.some((message) => message.role === "assistant" && message.runId === activeRunId),
  );
  const canSend = draft.trim().length > 0 && !sendMessage.isPending && !eventSourceRef.current;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Conversation</h3>
        </div>
        <div className="max-h-[70vh] min-h-[18rem] space-y-3 overflow-y-auto p-4">
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

          {!isLoading && !error && messages.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
              Start the conversation by sending a message to this agent.
            </div>
          )}

          {messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <div
                key={message.id}
                className={`flex ${isUser ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-md border px-4 py-3 text-sm ${
                    isUser
                      ? "border-border/60 bg-accent/20"
                      : "border-border/60 bg-card"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-muted-foreground">
                      {isUser ? "You" : agentName}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {relativeTime(message.createdAt)}
                    </span>
                  </div>
                  {isUser ? (
                    <div className="whitespace-pre-wrap">{message.content}</div>
                  ) : (
                    <MarkdownBody>{message.content}</MarkdownBody>
                  )}
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
                    {streamState.status === "streaming" || streamState.status === "pending"
                      ? "Streaming..."
                      : streamState.status}
                  </span>
                </div>
                <MarkdownBody>{assistantPreview}</MarkdownBody>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-background p-4">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message this agent..."
          rows={4}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && canSend) {
              event.preventDefault();
              sendMessage.mutate(draft.trim());
            }
          }}
          disabled={sendMessage.isPending || Boolean(eventSourceRef.current)}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {eventSourceRef.current ? "Wait for the current response to finish before sending another message." : "Press Enter to send. Use Shift+Enter for a new line."}
          </div>
          <Button size="sm" onClick={() => sendMessage.mutate(draft.trim())} disabled={!canSend}>
            {sendMessage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send
          </Button>
        </div>
        {sendError && <div className="text-sm text-destructive">{sendError}</div>}
      </div>
    </div>
  );
}
*/
